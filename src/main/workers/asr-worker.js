'use strict'

/**
 * 「AI 字幕」的识别 worker（跑在 utilityProcess 里）。
 *
 * 为什么必须是独立进程：spike 实测识别器构建一次 RSS +297MB、峰值 547MB，
 * 而且 sherpa 的识别器对象**没有 `free()`** —— 唯一的回收办法就是**把进程杀掉**。
 * 所以这个 worker 是一次性的：转写做完（或取消）由主进程 kill，内存立刻回来。
 *
 * 协议（和 ai-subtitles.js 里约定的）：
 *   收 { type: 'transcribe', model, tokens, vad, sampleRate, samples(Int16 base64), options }
 *   发 { type: 'progress', done, total }
 *      { type: 'result', segments: [{start,end,text}], usedVad, estimatedTimeline, elapsedMs, lang }
 *      { type: 'error', code, message }
 *
 * 自检不需要 228MB 真模型：`ARIA_AI_SUBTITLE_FAKE=1` 时用**假的识别器**产出固定文本，
 * 这样阶段 3 的整条链路（IPC 分段 → 合并 → LRC → 缓存 → UI）都能被验到。
 */

const { linesFromTokens, mergeSegments } = require('../services/subtitles-format')

const FAKE = process.env.ARIA_AI_SUBTITLE_FAKE === '1'

/** 假识别器：给定音频时长产出几行稳定可断言的字幕 */
function fakeRecognize (audioSeconds) {
  const lines = []
  const texts = ['这是本地识别的示例字幕', '模型没有下载也能跑通链路', '时间轴来自 token 级时间戳']
  let cursor = 1.0
  for (const text of texts) {
    const end = Math.min(audioSeconds, cursor + 2.2)
    if (cursor >= audioSeconds) break
    lines.push({ start: cursor, end, text })
    cursor = end + 0.4
  }
  return { segments: lines, usedVad: true, estimatedTimeline: false, lang: 'zh' }
}

function int16ToFloat32 (base64) {
  const buffer = Buffer.from(String(base64 || ''), 'base64')
  const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2))
  const samples = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768
  return samples
}

/** 用 silero VAD 切出语音区间；失败或切不出来就返回空数组（调用方退化成定窗） */
function vadSegments (sherpa, { model, samples, sampleRate }) {
  const vad = new sherpa.Vad({
    sileroVad: {
      model,
      threshold: 0.5,
      minSilenceDuration: 0.4,
      minSpeechDuration: 0.3,
      windowSize: 512
    },
    sampleRate,
    numThreads: 1,
    debug: 0
  }, 60)

  const found = []
  const chunk = Math.round(sampleRate * 0.1)
  for (let offset = 0; offset < samples.length; offset += chunk) {
    vad.acceptWaveform(Float32Array.from(samples.subarray(offset, Math.min(offset + chunk, samples.length))))
    while (!vad.isEmpty()) {
      const segment = vad.front(false)
      vad.pop()
      if (segment && segment.samples && segment.samples.length) {
        /* segment.start 的单位是**采样点**（spike 里核对过），要换算成秒 */
        const start = Number(segment.start) / sampleRate
        found.push({ start, end: start + segment.samples.length / sampleRate, samples: segment.samples })
      }
    }
  }
  vad.flush()
  while (!vad.isEmpty()) {
    const segment = vad.front(false)
    vad.pop()
    if (segment && segment.samples && segment.samples.length) {
      const start = Number(segment.start) / sampleRate
      found.push({ start, end: start + segment.samples.length / sampleRate, samples: segment.samples })
    }
  }
  return found
}

/** 定窗兜底：VAD 在音乐上切不出东西时，每 18 秒一段硬切 */
function fixedWindows (samples, sampleRate, seconds = 18) {
  const size = Math.round(sampleRate * seconds)
  const windows = []
  for (let offset = 0; offset < samples.length; offset += size) {
    const slice = samples.subarray(offset, Math.min(offset + size, samples.length))
    windows.push({ start: offset / sampleRate, end: (offset + slice.length) / sampleRate, samples: slice })
  }
  return windows
}

function recognizeWindows (sherpa, recognizer, windows, onProgress) {
  const lines = []
  let lang = ''
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]
    const stream = recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples: Float32Array.from(window.samples) })
    recognizer.decode(stream)
    const result = recognizer.getResult(stream)
    onProgress(index + 1, windows.length)

    lang = lang || (result && result.lang) || ''
    const tokens = (result && result.tokens) || []
    const timestamps = (result && result.timestamps) || []
    const durations = (result && result.durations) || []
    /* 时间戳是"相对这一窗"的，要加上窗口起点 */
    const shifted = timestamps.map((value) => Number(value) + window.start)
    const inside = linesFromTokens(
      { tokens, timestamps: shifted, durations },
      { audioSeconds: window.end }
    )
    /* 没有 token 级时间戳的模型：整窗算一行 */
    if (!inside.length && result && result.text) {
      lines.push({ start: window.start, end: window.end, text: result.text })
    } else {
      lines.push(...inside)
    }
  }
  return { lines, lang }
}

async function transcribe (message, post) {
  const sampleRate = Number(message.sampleRate) || 16000
  const samples = int16ToFloat32(message.samples)
  const audioSeconds = samples.length / sampleRate

  if (FAKE) {
    post({ type: 'progress', done: 1, total: 1 })
    const fake = fakeRecognize(audioSeconds)
    return { ...fake, elapsedMs: 12, segments: mergeSegments(fake.segments), audioSeconds }
  }

  const path = require('node:path')
  const sherpa = require(path.join(__dirname, '..', '..', '..', 'node_modules', 'sherpa-onnx-node'))
  const startedAt = Date.now()

  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      senseVoice: { model: message.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: message.tokens,
      numThreads: 2,
      provider: 'cpu',
      debug: 0
    },
    featConfig: { sampleRate: 16000, featureDim: 80 }
  })

  let windows = []
  let usedVad = false
  try {
    windows = vadSegments(sherpa, { model: message.vad, samples, sampleRate })
    usedVad = windows.length > 0
  } catch {
    windows = []
  }
  if (!windows.length) windows = fixedWindows(samples, sampleRate)

  const { lines, lang } = recognizeWindows(sherpa, recognizer, windows, (done, total) => {
    post({ type: 'progress', done, total })
  })

  return {
    segments: mergeSegments(lines),
    usedVad,
    estimatedTimeline: !usedVad,
    lang,
    elapsedMs: Date.now() - startedAt,
    audioSeconds
  }
}

process.parentPort.on('message', async (event) => {
  const message = event && event.data ? event.data : {}
  if (message.type === 'ping') {
    process.parentPort.postMessage({ type: 'pong', fake: FAKE })
    return
  }
  if (message.type !== 'transcribe') return
  try {
    const result = await transcribe(message, (payload) => process.parentPort.postMessage(payload))
    process.parentPort.postMessage({ type: 'result', ...result })
  } catch (err) {
    process.parentPort.postMessage({
      type: 'error',
      code: 'recognize-failed',
      message: String((err && err.message) || err)
    })
  }
})
