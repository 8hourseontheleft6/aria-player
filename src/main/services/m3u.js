'use strict'

/**
 * m3u / m3u8 播放列表的解析与序列化（纯函数，不碰 dialog、不碰 fs）。
 *
 * 为什么单独成文件：解析规则最容易出错（相对路径、BOM、注释、坏行），
 * 放在纯函数里就能被自检直接对着字符串验，不用起窗口。
 *
 * 约定（按 m3u 的通行做法）：
 *   · 首行写 `#EXTM3U`；每首前一行 `#EXTINF:<秒数>,<艺人> - <标题>`；
 *   · 路径**优先写相对 m3u 所在目录的路径**（换台机器、换个盘符也能用）；
 *     跨盘 / 不在同一棵树里取不到相对路径时，退回绝对路径；
 *   · 解析时相对路径按 m3u 所在目录解析；BOM、CRLF、空行、非 `#EXTINF` 的注释都要容忍。
 */

const path = require('node:path')

/** 能不能被这个应用播放（与 library 的扩展名白名单保持一致） */
const PLAYABLE = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus', '.webm'
])

function isPlayablePath (filePath) {
  return PLAYABLE.has(path.extname(String(filePath || '')).toLowerCase())
}

/** 秒数 → `#EXTINF` 里的整数秒；未知就用 -1（m3u 里表示"时长未知"） */
function durationSeconds (duration) {
  const value = Number(duration)
  if (!Number.isFinite(value) || value <= 0) return -1
  return Math.round(value)
}

/** 把曲目文件名里的换行清掉 —— 一行一条记录，混进换行会把文件写坏 */
function oneLine (text) {
  return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim()
}

/**
 * 生成 m3u 文本。
 * @param {{ file: string, tracks: Array<{ path: string, title?: string, artist?: string, duration?: number }> }} input
 * @returns {{ text: string, relative: number, absolute: number }}
 */
function serialize ({ file, tracks }) {
  const baseDir = path.dirname(path.resolve(file))
  const lines = ['#EXTM3U']
  let relative = 0
  let absolute = 0

  for (const track of Array.isArray(tracks) ? tracks : []) {
    const filePath = path.resolve(String(track.path || ''))
    if (!filePath) continue
    const label = oneLine(`${track.artist || ''} - ${track.title || path.basename(filePath)}`)
    lines.push(`#EXTINF:${durationSeconds(track.duration)},${label}`)

    const relativePath = path.relative(baseDir, filePath)
    /* 跨盘符时 path.relative 会给出 `D:\...` 这种绝对路径 —— 那就是"取不到相对路径" */
    const usableRelative = relativePath && !path.isAbsolute(relativePath)
    if (usableRelative) {
      relative++
      lines.push(relativePath.split(path.sep).join('/'))
    } else {
      absolute++
      lines.push(filePath)
    }
  }

  return { text: lines.join('\n') + '\n', relative, absolute }
}

/**
 * 解析 m3u 文本。
 * @param {{ file: string, text: string, exists?: (p: string) => boolean }} input
 * @returns {{ entries: Array<{ path: string, title: string, artist: string, duration: number }>, missing: number, skipped: number }}
 */
function parse ({ file, text, exists = null }) {
  const baseDir = path.dirname(path.resolve(file))
  const raw = String(text || '').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/)

  const entries = []
  let missing = 0
  let skipped = 0
  let pending = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('#EXTINF:')) {
      /* `#EXTINF:123,Artist - Title`；逗号之后的都可能出现，只取第一个逗号 */
      const body = trimmed.slice('#EXTINF:'.length)
      const comma = body.indexOf(',')
      const seconds = Number.parseInt(comma >= 0 ? body.slice(0, comma) : body, 10)
      const label = comma >= 0 ? body.slice(comma + 1).trim() : ''
      const dash = label.indexOf(' - ')
      pending = {
        duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
        artist: dash >= 0 ? label.slice(0, dash).trim() : '',
        title: dash >= 0 ? label.slice(dash + 3).trim() : label
      }
      continue
    }

    /* 注释（#EXTM3U 与其它扩展标签）一律跳过 */
    if (trimmed.startsWith('#')) continue

    const resolved = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(baseDir, trimmed)
    const entry = {
      path: resolved,
      title: pending ? pending.title : path.basename(resolved, path.extname(resolved)),
      artist: pending ? pending.artist : '',
      duration: pending ? pending.duration : 0
    }
    pending = null

    if (!isPlayablePath(resolved)) { skipped++; continue }
    if (exists && !exists(resolved)) { missing++; continue }
    entries.push(entry)
  }

  return { entries, missing, skipped }
}

module.exports = { serialize, parse, isPlayablePath }
