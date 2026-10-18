'use strict'

/**
 * 「AI 字幕」的纯函数核心：特殊 token 清理、token→行、段合并、LRC 生成。
 *
 * 为什么单独一个文件：这些规则**最容易悄悄错**（合并阈值差 0.1s、LRC 时间码四舍五入、
 * SenseVoice 的 `<|zh|><|HAPPY|>` 没清干净），而且它们不需要模型、不需要窗口就能验。
 * 阶段 5 的单测和 smoke 都直接对着这里打。
 *
 * SenseVoice 的输出形状（spike 里确认过）：
 *   { text, tokens: [], timestamps: [], durations: [], lang, emotion, event }
 * timestamps 是**每个 token 的起始秒**（真实时间，不是估算）。
 */

/** SenseVoice 会吐出 `<|zh|> <|EN|> <|HAPPY|> <|Speech|> <|woitn|>` 这类控制标签 */
const CONTROL_TAG = /<\|[^|<>]*\|>/g

/** 句末标点：中文全角、英文半角、省略号 */
const SENTENCE_END = /[。！？!?；;…]$/
/** 纯标点/空白（这种"行"要丢掉） */
const PUNCT_ONLY = /^[\s。．，,！!？?；;：:、…·\-—~～"'“”‘’()（）[\]【】]+$/

/** 清掉控制标签，压平空白 */
function cleanText (raw) {
  return String(raw == null ? '' : raw)
    .replace(CONTROL_TAG, '')
    .replace(/[\u200b-\u200f\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isPunctuationOnly (text) {
  const value = cleanText(text)
  return value === '' || PUNCT_ONLY.test(value)
}

/**
 * token → 行。
 *
 * 切行规则（按优先级）：
 *   ① token 文本以句末标点结尾（。！？!?；;…）
 *   ② 与上一个 token 的时间间隔 ≥ maxGap（默认 1.2s）—— 换气/停顿
 *   ③ 当前行已经长到 maxChars（默认 48）—— 防止音乐里"一口气 30 秒"变成一行
 * 每行的 start 取第一个 token 的时间，end 取下一个 token 的开始（最后一行到音频末尾）。
 *
 * @param {{ tokens: string[], timestamps: number[], durations?: number[] }} input
 * @param {{ maxGap?: number, maxChars?: number, audioSeconds?: number }} [options]
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
function linesFromTokens ({ tokens, timestamps, durations }, options = {}) {
  const maxGap = Number.isFinite(options.maxGap) ? options.maxGap : 1.2
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 48
  const audioSeconds = Number.isFinite(options.audioSeconds) ? options.audioSeconds : null

  const list = Array.isArray(tokens) ? tokens : []
  const times = Array.isArray(timestamps) ? timestamps : []
  const lengths = Array.isArray(durations) ? durations : []

  const lines = []
  let current = null

  const flush = (endAt) => {
    if (!current) return
    const text = cleanText(current.tokens.join(''))
    if (text && !isPunctuationOnly(text)) {
      lines.push({ start: current.start, end: Math.max(current.start + 0.2, endAt), text })
    }
    current = null
  }

  for (let index = 0; index < list.length; index++) {
    const tokenText = String(list[index] == null ? '' : list[index])
    const start = Number(times[index])
    if (!Number.isFinite(start)) continue
    const cleaned = cleanText(tokenText)
    /* 纯控制 token（清完是空的）不参与切行，也不该触发时间推进 */
    if (!cleaned) continue

    if (!current) current = { start, tokens: [tokenText] }
    else {
      const gap = start - (current.lastStart || current.start)
      const tooLong = cleanText(current.tokens.join('')).length + cleaned.length > maxChars
      if (gap >= maxGap || tooLong) {
        flush(start)
        current = { start, tokens: [tokenText] }
      } else {
        current.tokens.push(tokenText)
      }
    }
    current.lastStart = start

    const soFar = cleanText(current.tokens.join(''))
    if (SENTENCE_END.test(soFar)) {
      const nextStart = Number(times[index + 1])
      const tokenEnd = Number(lengths[index])
      const endAt = Number.isFinite(nextStart) ? nextStart
        : (Number.isFinite(tokenEnd) && tokenEnd > 0 ? start + tokenEnd : start + 0.6)
      flush(endAt)
    }
  }

  if (current) {
    const lastStart = current.lastStart || current.start
    flush(audioSeconds != null && audioSeconds > lastStart ? audioSeconds : lastStart + 1.2)
  }

  /* 时间必须单调，且不能为负 */
  let previousEnd = 0
  for (const line of lines) {
    if (line.start < previousEnd) line.start = previousEnd
    if (line.end <= line.start) line.end = line.start + 0.3
    previousEnd = line.end
  }
  return lines
}

/**
 * 段合并：太短的并进邻居，纯标点的丢掉。
 *
 * @param {Array<{ start: number, end: number, text: string }>} segments
 * @param {{ minDuration?: number }} [options]
 */
function mergeSegments (segments, options = {}) {
  const minDuration = Number.isFinite(options.minDuration) ? options.minDuration : 1.2
  const input = (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      start: Math.max(0, Number(segment.start) || 0),
      end: Math.max(0, Number(segment.end) || 0),
      text: cleanText(segment.text)
    }))
    .filter((segment) => segment.text && !isPunctuationOnly(segment.text))
    .sort((a, b) => a.start - b.start)

  /*
   * 第一轮：短段（< minDuration）**不看间隔**，直接并进前一行 ——
   * 这是需求里明说的"合并 <1.2s 的段"；如果还要求"间隔也小"，
   * 一个 0.5s 的气口就会自己站成一行（实测会这样，读起来很碎）。
   * 纯标点段在上一步已经被丢掉了。
   */
  const merged = []
  for (const segment of input) {
    const duration = segment.end - segment.start
    const last = merged[merged.length - 1]
    if (last && duration < minDuration) {
      last.end = Math.max(last.end, segment.end)
      last.text = cleanText(last.text + segment.text)
      continue
    }
    merged.push({ ...segment })
  }

  /* 开头那个短段没有"前一行"可并，往下一行并（否则它会孤零零一行） */
  if (merged.length >= 2 && merged[0].end - merged[0].start < minDuration) {
    merged[1].start = Math.min(merged[0].start, merged[1].start)
    merged[1].text = cleanText(merged[0].text + merged[1].text)
    merged.shift()
  }

  /* 第二轮：合并之后仍很短、而且紧挨着的，再收一次（三行 0.4s 并成一行 1.2s 这种） */
  const again = []
  for (const segment of merged) {
    const last = again[again.length - 1]
    if (last && segment.end - last.start < minDuration * 2 && segment.start - last.end < 0.35) {
      last.end = Math.max(last.end, segment.end)
      last.text = cleanText(last.text + segment.text)
      continue
    }
    again.push({ ...segment })
  }
  return again
}

/** 秒 → `[mm:ss.xx]` */
function lrcTime (seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  const whole = Math.floor(rest)
  const hundredths = Math.round((rest - whole) * 100)
  /* 99.6 会四舍五入成 100：进位到下一秒 */
  if (hundredths >= 100) return lrcTime(minutes * 60 + whole + 1)
  return `[${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`
}

/**
 * 生成 LRC。行首标签写 `[ai]`，让"这是 AI 生成的"在歌词文件里也留痕。
 * @param {Array<{ start: number, end: number, text: string }>} segments
 */
function toLrc (segments) {
  const lines = ['[ai]']
  for (const segment of Array.isArray(segments) ? segments : []) {
    const text = cleanText(segment.text)
    if (!text || isPunctuationOnly(text)) continue
    lines.push(lrcTime(segment.start) + text)
  }
  return lines.join('\n')
}

/** LRC 里能读出来的行（自检用：验证写进去的东西读得回来） */
function parseLrc (lrc) {
  const result = []
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const match = /^\[(\d{2}):(\d{2})\.(\d{2})\](.*)$/.exec(raw.trim())
    if (!match) continue
    result.push({
      start: Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 100,
      text: match[4].trim()
    })
  }
  return result
}

module.exports = {
  cleanText,
  isPunctuationOnly,
  linesFromTokens,
  mergeSegments,
  lrcTime,
  toLrc,
  parseLrc
}
