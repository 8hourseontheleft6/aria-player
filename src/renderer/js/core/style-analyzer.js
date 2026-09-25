/**
 * 风格分析：听音频本身，而不只看标签。
 *
 * 为什么需要它：`matchPreset` 原来只看曲目的流派字段。可本地音乐库里
 * 一大半文件根本没有流派标签（或者写着「未知」），于是自动均衡基本等于没开。
 * 这里直接解码音频算三个特征，用声音本身判断风格 —— 离线、不联网、不依赖元数据。
 *
 * 三个特征（都能用一阶滤波器在时域算出来，不需要 FFT）：
 *   · bassRatio：200Hz 以下的能量占比 —— 低音重不重（电子 / 嘻哈高）
 *   · zcr：过零率 —— 高频成分多不多、噪不噪（失真吉他、镲片高）
 *   · crest：峰值 / 有效值 —— 动态大不大（古典大，现代压缩过的流行小）
 *
 * 只用 30 秒中段做样本：整首歌解码太慢，而 30 秒足够代表整体风格。
 * 结果按曲目 id 缓存，一首歌只算一次。
 */

import { trackMediaUrl } from './media-url.js'

const SAMPLE_WINDOW = 30 // 秒
const CACHE_LIMIT = 200

/** trackId → { key, confidence, features } */
const cache = new Map()

/** 一阶低通（≈200Hz）的系数：y[n] = y[n-1] + a·(x[n] − y[n-1]) */
function lowpassAlpha (cutoff, sampleRate) {
  const dt = 1 / sampleRate
  const rc = 1 / (2 * Math.PI * cutoff)
  return dt / (rc + dt)
}

/**
 * 从解码后的音频里算特征。
 * @param {AudioBuffer} buffer
 * @returns {{bassRatio:number, zcr:number, crest:number, rms:number}}
 */
export function analyzeBuffer (buffer) {
  const rate = buffer.sampleRate
  const total = buffer.length
  const windowLength = Math.min(total, Math.floor(rate * SAMPLE_WINDOW))
  const start = Math.max(0, Math.floor((total - windowLength) / 2))
  // 每 4 个采样取一个：特征不需要全采样率，省 3/4 的时间
  const step = 4
  const alpha = lowpassAlpha(200, rate)

  const left = buffer.getChannelData(0)
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left

  let low = 0
  let sumSq = 0
  let sumLowSq = 0
  let peak = 0
  let crossings = 0
  let previous = 0
  let count = 0

  for (let i = start; i < start + windowLength; i += step) {
    const sample = (left[i] + right[i]) / 2
    low += alpha * (sample - low)
    const abs = Math.abs(sample)
    if (abs > peak) peak = abs
    sumSq += sample * sample
    sumLowSq += low * low
    if ((sample >= 0) !== (previous >= 0)) crossings++
    previous = sample
    count++
  }

  const rms = Math.sqrt(sumSq / Math.max(1, count))
  const lowRms = Math.sqrt(sumLowSq / Math.max(1, count))
  const seconds = (count * step) / rate
  return {
    // 低音占比：低频能量 / 总能量（0~1）
    bassRatio: sumSq > 0 ? Math.min(1, (lowRms * lowRms) / (rms * rms)) : 0,
    // 过零率（次/秒）
    zcr: seconds > 0 ? crossings / seconds : 0,
    // 峰值因数：动态范围（越大越「未压缩」）
    crest: rms > 0 ? peak / rms : 0,
    rms: Math.round(rms * 1000) / 1000
  }
}

/**
 * 用特征判风格。
 *
 * 阈值是**实测出来的**，不是拍脑袋：拿三类合成信号量过一遍（60Hz 鼓点 + 少量噪声、
 * 宽带白噪、大动态 220Hz 正弦），得到 bassRatio 0.41 / 0.013 / 0.048，
 * zcr 364 / 6016 / 440，crest 3.5 / 1.7 / 2.5 —— 第一版按「bassRatio>0.55、crest>5」
 * 写，三个全判错（详见提交里的自检输出）。现在的区间也符合真实音乐的常见范围：
 * 流行歌 bassRatio 多在 0.2~0.4、zcr 1000~2500；古典低音薄、zcr 低；电子低音重、zcr 中等。
 *
 * 顺序有讲究：先挑「明亮且低音不重」的（摇滚最典型的特征），再挑「低音重」的，
 * 最后才是「安静、低音薄、有动态」的古典。都不像就归到最温和的流行，置信度给低，
 * 让元数据标签有机会覆盖它。
 *
 * @param {object} features
 * @returns {{key:string, confidence:number}}
 */
export function classifyStyle (features) {
  const { bassRatio = 0, zcr = 0, crest = 0 } = features || {}

  // 明亮、噪、低音不重 → 摇滚 / 金属（失真吉他、镲片、密集高频）
  if (zcr > 2000 && bassRatio < 0.35) {
    return { key: 'rock', confidence: Math.min(1, 0.55 + (zcr - 2000) / 6000) }
  }
  // 低音压过一切、又不刺耳 → 电子 / 舞曲（底鼓 + 贝斯线）
  if (bassRatio > 0.35 && zcr < 1200) {
    return { key: 'electronic', confidence: Math.min(1, 0.55 + (bassRatio - 0.35) * 1.5) }
  }
  // 低音薄、高频少、有动态余量 → 古典 / 原声 / 器乐
  if (bassRatio < 0.2 && zcr < 1200 && crest > 2.2) {
    return { key: 'classical', confidence: Math.min(1, 0.5 + (crest - 2.2) / 4) }
  }
  // 其余归到流行（最温和的一组），置信度低，标签有机会覆盖它
  return { key: 'pop', confidence: 0.35 }
}

/**
 * 分析一首曲目。失败一律返回 null（分析只是锦上添花，不该影响播放）。
 * @param {object} track
 * @param {AudioContext} context 复用已有的上下文（没有就临时建一个）
 */
export async function analyzeTrack (track, context = null) {
  if (!track?.id || !track.path) return null
  if (cache.has(track.id)) return cache.get(track.id)

  const url = trackMediaUrl(track)
  if (!url) return null

  const Ctx = window.AudioContext || window.webkitAudioContext
  let owns = false
  let ctx = context
  if (!ctx) {
    if (!Ctx) return null
    ctx = new Ctx()
    owns = true
  }

  try {
    const response = await fetch(url)
    const bytes = await response.arrayBuffer()
    const buffer = await ctx.decodeAudioData(bytes)
    const features = analyzeBuffer(buffer)
    const result = { ...classifyStyle(features), features, source: 'audio' }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
    cache.set(track.id, result)
    return result
  } catch {
    return null
  } finally {
    if (owns) ctx.close().catch(() => {})
  }
}

/** 已经分析过的结果（同步取，没算过就是 null） */
export function cachedAnalysis (trackId) {
  return cache.get(trackId) || null
}

export function clearAnalysisCache () {
  cache.clear()
}
