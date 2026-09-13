/**
 * LRC 歌词解析与时间轴。
 *
 * 支持：
 *  - 标准 `[mm:ss.xx]` 时间标签，一行多标签
 *  - 元信息 `[ti:] [ar:] [al:] [offset:]` 等
 *  - 逐字 `<mm:ss.xx>`（卡拉OK）标签
 *  - 双语歌词：同一时间戳的第二行自动合并为翻译
 *
 * 偏移约定：`[offset:500]` 表示歌词整体提前 500ms（与常见播放器一致），
 * 因此最终时间 = 标签时间 - offset。用户调节的偏移叠加在同一方向上。
 */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g
const META_TAG = /^\[(ti|ar|al|au|by|offset|re|ve|length|ml|kana):([^\]]*)\]$/i

function toSeconds (match) {
  const minutes = Number(match[1]) || 0
  const seconds = Number(match[2]) || 0
  let fraction = 0
  if (match[3] !== undefined) {
    const raw = match[3]
    fraction = Number(raw) / (raw.length === 3 ? 1000 : raw.length === 2 ? 100 : 10)
  }
  return minutes * 60 + seconds + fraction
}

function parseWordTags (text) {
  WORD_TAG.lastIndex = 0
  const matches = [...text.matchAll(WORD_TAG)]
  if (!matches.length) return null
  const words = []
  matches.forEach((match, index) => {
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length
    const content = text.slice(start, end)
    if (!content) return
    words.push({ time: toSeconds(match), text: content })
  })
  return words.length ? words : null
}

/**
 * @param {string} raw
 * @param {{ offsetMs?: number }} [options]
 * @returns {{ meta: object, lines: Array<object> }}
 */
export function parseLrc (raw, options = {}) {
  const userOffset = Number(options.offsetMs) || 0
  const meta = {}
  /** @type {Array<{time:number, text:string, words:Array|null, order:number}>} */
  const entries = []
  let order = 0

  for (const rawLine of String(raw ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const metaMatch = META_TAG.exec(line)
    if (metaMatch) {
      meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim()
      continue
    }

    TIME_TAG.lastIndex = 0
    const stamps = [...line.matchAll(TIME_TAG)]
    if (!stamps.length) continue

    let body = line.replace(TIME_TAG, '')
    const words = parseWordTags(body)
    if (words) body = body.replace(WORD_TAG, '')
    body = body.trim()

    for (const stamp of stamps) {
      entries.push({ time: toSeconds(stamp), text: body, words, order: order++ })
    }
  }

  const tagOffset = Number(meta.offset) || 0
  const totalOffset = (tagOffset + userOffset) / 1000

  entries.sort((a, b) => (a.time - b.time) || (a.order - b.order))

  /** @type {Array<object>} */
  const lines = []
  for (const entry of entries) {
    const time = Math.max(0, entry.time - totalOffset)
    const previous = lines[lines.length - 1]

    if (previous && Math.abs(previous.time - time) < 0.02) {
      // 同一时间戳：视作主歌词 + 翻译
      if (entry.text && entry.text !== previous.text && !previous.translation) {
        previous.translation = entry.text
        continue
      }
      if (!entry.text) continue
      if (entry.text === previous.text) continue
    }

    if (!entry.text) continue
    lines.push({
      index: lines.length,
      time,
      end: Number.POSITIVE_INFINITY,
      text: entry.text,
      translation: '',
      words: entry.words
    })
  }

  for (let i = 0; i < lines.length; i++) {
    lines[i].index = i
    lines[i].end = i + 1 < lines.length ? lines[i + 1].time : Number.POSITIVE_INFINITY
  }

  return { meta, lines }
}

/** 纯文本歌词（无时间轴）：按行拆分，过滤多余空行 */
export function parsePlainLyrics (raw) {
  return String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index, list) => line !== '' || (index > 0 && list[index - 1] !== ''))
}

/**
 * 二分查找当前时间对应的行号（没有则返回 -1）。
 * @param {Array<{time:number}>} lines
 * @param {number} time
 */
export function findLineIndex (lines, time) {
  if (!lines?.length) return -1
  if (time < lines[0].time) return -1
  let low = 0
  let high = lines.length - 1
  let result = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].time <= time) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return result
}

/**
 * 逐字高亮进度（0~1）。没有逐字标签时按整行时间线性推进。
 */
export function karaokeProgress (line, time) {
  if (!line) return 0
  if (!line.words?.length) {
    if (!Number.isFinite(line.end)) return 0
    const span = line.end - line.time
    if (span <= 0) return 0
    return Math.min(1, Math.max(0, (time - line.time) / span))
  }
  const words = line.words
  if (time <= words[0].time) return 0
  const total = words.reduce((sum, word) => sum + word.text.length, 0) || 1
  let consumed = 0
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    const nextTime = i + 1 < words.length ? words[i + 1].time : (Number.isFinite(line.end) ? line.end : word.time + 3)
    if (time < nextTime) {
      const span = Math.max(0.001, nextTime - word.time)
      const ratio = Math.min(1, Math.max(0, (time - word.time) / span))
      consumed += word.text.length * ratio
      break
    }
    consumed += word.text.length
  }
  return Math.min(1, Math.max(0, consumed / total))
}

export function hasTimeline (lines) {
  return Array.isArray(lines) && lines.length > 0
}
