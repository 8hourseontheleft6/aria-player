/**
 * 渲染层的「AI 字幕（本地）」入口。
 *
 * 分工：
 *   · 这里负责**解码**（decodeAudioData，不依赖 ffmpeg）与**分块上传**；
 *   · 识别在主进程的 utilityProcess 里（services/ai-subtitles.js + workers/asr-worker.js）；
 *   · 缓存、VAD、LRC 全在主进程 —— 渲染层只拿结果。
 *
 * 硬要求：任何一步失败都只返回一个可读的错误，**绝不影响播放**（不抛到顶层、不阻塞 audio 元素）。
 */

import { trackMediaUrl } from './media-url.js'

/** 这个产品有没有本机 AI 字幕（只有播放器档有） */
export function aiSubtitlesAvailable () {
  return Boolean(typeof window !== 'undefined' && window.aria && window.aria.aiSubtitles)
}

function humanDecodeError (error) {
  const name = error && error.name
  if (name === 'EncodingError' || name === 'NotSupportedError') {
    return '这个格式解不开（wma / aiff 这类需要先转成 mp3 / m4a / flac / wav / ogg / opus）'
  }
  if (name === 'InvalidStateError') return '解码器状态异常，重开应用再试'
  return `解码失败：${(error && error.message) || error}`
}

/** 单声道 + 重采样到 16k，返回 Int16 的整数采样 */
function toMono16k (audio) {
  const channels = audio.numberOfChannels
  const length = audio.length
  const mono = new Float32Array(length)
  for (let channel = 0; channel < channels; channel++) {
    const data = audio.getChannelData(channel)
    for (let i = 0; i < length; i++) mono[i] += data[i] / channels
  }
  const ratio = audio.sampleRate / 16000
  if (Math.abs(ratio - 1) < 0.001) {
    const straight = new Int16Array(length)
    for (let i = 0; i < length; i++) {
      const value = Math.max(-1, Math.min(1, mono[i]))
      straight[i] = value < 0 ? value * 0x8000 : value * 0x7fff
    }
    return straight
  }
  const outLength = Math.floor(length / ratio)
  const out = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio
    const i0 = Math.floor(position)
    const i1 = Math.min(length - 1, i0 + 1)
    const frac = position - i0
    const value = Math.max(-1, Math.min(1, mono[i0] * (1 - frac) + mono[i1] * frac))
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff
  }
  return out
}

function base64OfInt16 (int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/**
 * 生成一首歌的 AI 字幕。
 * @param {object} track 需要 path + mtimeMs
 * @param {{ onStage?: (stage: string, detail?: object) => void, signal?: AbortSignal }} [options]
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, lrc?: string, segments?: Array<{start:number,end:number,text:string}>, fromCache?: boolean, estimatedTimeline?: boolean, usedVad?: boolean }>}
 */
export async function generateAiSubtitles (track, options = {}) {
  const api = window.aria && window.aria.aiSubtitles
  if (!api) return { ok: false, code: 'unsupported', message: '这个产品没有本机 AI 字幕' }
  if (!track || !track.path) return { ok: false, code: 'no-track', message: '没有可取样的曲目' }
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {}

  let audioContext = null
  try {
    onStage('decoding')
    const response = await fetch(trackMediaUrl(track))
    if (!response.ok) return { ok: false, code: 'fetch-failed', message: `读不到音频文件（HTTP ${response.status}）` }
    const raw = await response.arrayBuffer()
    audioContext = new (window.AudioContext || window.webkitAudioContext)()
    let audio
    try {
      audio = await audioContext.decodeAudioData(raw)
    } catch (error) {
      return { ok: false, code: 'decode-failed', message: humanDecodeError(error) }
    }

    const int16 = toMono16k(audio)
    const seconds = int16.length / 16000
    onStage('encoding', { seconds })

    /* 每块 5 秒：单块 ~160KB base64，几百块的歌也不会把一条 IPC 消息撑爆 */
    const chunkSamples = 16000 * 5
    const total = Math.max(1, Math.ceil(int16.length / chunkSamples))
    for (let index = 0; index < total; index++) {
      if (options.signal && options.signal.aborted) return { ok: false, code: 'cancelled', message: '已取消' }
      const slice = int16.subarray(index * chunkSamples, (index + 1) * chunkSamples)
      await api.pushAudio({ index, total, sampleRate: 16000, data: base64OfInt16(slice) })
      onStage('uploading', { done: index + 1, total })
    }

    onStage('recognizing')
    const result = await api.transcribe({ path: track.path, mtime: track.mtimeMs })
    onStage('done', result)
    return result
  } catch (error) {
    return { ok: false, code: 'failed', message: String((error && error.message) || error) }
  } finally {
    if (audioContext) {
      try { await audioContext.close() } catch { /* 已经关了 */ }
    }
  }
}
