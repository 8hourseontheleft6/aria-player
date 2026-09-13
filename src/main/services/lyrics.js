'use strict'

const fsp = require('node:fs/promises')
const path = require('node:path')

const { decodeTextBuffer } = require('../util/text')
const { listDirIndex, findSidecar } = require('../util/files')
const { readEmbeddedLyrics } = require('./metadata')

const LRC_EXTENSIONS = new Set(['.lrc', '.LRC'])
const TEXT_EXTENSIONS = ['.lrc', '.txt']

function normalizeKey (value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[\s_\-–—·.,()[\]{}（）【】「」]/g, '')
}

/**
 * 在目录里找最匹配的歌词文件。
 * 常见命名：同名 .lrc、「歌名 - 歌手.lrc」、「歌名-歌手.lrc」、「歌手 - 歌名.lrc」，
 * 因此用「归一化后包含匹配 + 打分」而不是死板的字符串拼接。
 */
async function findLyricsFile (dir, { title, artist, file }) {
  const index = await listDirIndex(dir)
  if (!index.size) return null

  const titleKey = normalizeKey(title)
  const artistKey = normalizeKey(artist)
  const fileKey = normalizeKey(file)

  let best = null
  let bestScore = 0

  for (const [lower, actual] of index) {
    if (!LRC_EXTENSIONS.has(path.extname(lower))) continue
    const stemKey = normalizeKey(lower)
    let score = 0

    if (fileKey && stemKey === fileKey) score = 100
    else if (titleKey && stemKey === titleKey) score = 98
    else if (titleKey && artistKey && stemKey.includes(titleKey) && stemKey.includes(artistKey)) score = 90
    else if (titleKey && stemKey.includes(titleKey)) score = 72
    else if (artistKey && titleKey && normalizeKey(title).startsWith(stemKey) && stemKey.length > 3) score = 60

    if (score > bestScore) {
      bestScore = score
      best = actual
    }
  }

  if (bestScore < 60) return null
  return path.join(dir, best)
}

/**
 * 歌词服务：只负责「找到并解码文本」，解析成时间轴交给渲染层
 * （这样歌词来源与解析格式都可以作为渲染层的扩展点替换）。
 */
function createLyricsService (ctx) {
  async function load (input = {}) {
    const trackPath = input.path
    if (!trackPath) return null
    const dir = path.dirname(trackPath)
    const base = path.basename(trackPath, path.extname(trackPath))
    const hint = {
      title: input.title || base,
      artist: input.artist || '',
      file: path.basename(trackPath)
    }

    // 1) .lrc 时间轴歌词
    const lrcPath = await findLyricsFile(dir, hint)
    if (lrcPath) {
      const raw = await fsp.readFile(lrcPath)
      const { text, encoding } = decodeTextBuffer(raw)
      return { source: 'lrc', path: lrcPath, file: path.basename(lrcPath), text, encoding }
    }

    // 2) 纯文本歌词（无时间轴）
    const txtPath = await findSidecar(dir, base, TEXT_EXTENSIONS)
    if (txtPath && path.extname(txtPath).toLowerCase() === '.txt') {
      const raw = await fsp.readFile(txtPath)
      const { text, encoding } = decodeTextBuffer(raw)
      return { source: 'txt', path: txtPath, file: path.basename(txtPath), text, encoding }
    }

    // 3) 音频文件内嵌歌词
    const embedded = await readEmbeddedLyrics(trackPath)
    if (embedded) {
      return { source: 'tag', path: null, file: null, text: embedded, encoding: 'utf-8' }
    }

    return null
  }

  return { load, findLyricsFile }
}

module.exports = { createLyricsService, findLyricsFile }
