'use strict'

const fsp = require('node:fs/promises')
const path = require('node:path')

const { readId3 } = require('./id3-lite')

/** music-metadata 是 ESM 包，从 CJS 里惰性动态导入，并允许整体缺失 */
let mmPromise = null

function loadMusicMetadata () {
  if (!mmPromise) {
    mmPromise = import('music-metadata')
      .then((mod) => {
        if (!mod || typeof mod.parseFile !== 'function') throw new Error('parseFile 缺失')
        return mod
      })
      .catch((err) => {
        console.warn('[metadata] music-metadata 不可用，使用内置 ID3 兜底解析器:', err.message)
        return null
      })
  }
  return mmPromise
}

function firstString (value) {
  if (Array.isArray(value)) return value.find((item) => typeof item === 'string' && item.trim()) || ''
  return typeof value === 'string' ? value : ''
}

/** 文件名回退解析：`艺人 - 歌名.mp3` 是很常见的命名 */
function fromFileName (filePath) {
  const base = path.basename(filePath, path.extname(filePath))
  const parts = base.split(' - ')
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() }
  }
  return { artist: '', title: base }
}

/**
 * 归一化后的曲目记录结构（渲染层直接消费）：
 * {
 *   id, path, dir, file, ext, size, mtimeMs,
 *   title, artist, albumArtist, album, genre,
 *   trackNo, discNo, year, duration,
 *   artworkEmbedded, artworkFile
 * }
 */
function normalizeTrack (filePath, stat, parsed) {
  const id = require('node:crypto').createHash('sha1').update(filePath).digest('hex').slice(0, 16)
  const fallback = fromFileName(filePath)
  const common = parsed.common || {}
  const format = parsed.format || {}

  const title = (common.title || '').trim() || fallback.title
  const artist = firstString(common.artist) || firstString(common.artists) || fallback.artist || '未知艺人'
  const albumArtist = firstString(common.albumartist) || artist

  const trackNo = Number(common.track?.no) || 0
  const discNo = Number(common.disk?.no) || 0
  const year = Number(common.year) || 0
  const genre = firstString(common.genre)

  /*
   * ReplayGain：music-metadata 把 TXXX / Vorbis 的 REPLAYGAIN_* 统一解析成
   * { dB, ratio }。这里只留需要的三个数，缺失就是 null（渲染层按 0dB 处理）。
   */
  const gainDb = (value) => {
    const db = Number(value && value.dB)
    return Number.isFinite(db) ? Math.round(db * 100) / 100 : null
  }
  const peakOf = (value) => {
    const ratio = Number(value && value.ratio)
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null
  }
  const gainTrack = gainDb(common.replaygain_track_gain)
  const gainAlbum = gainDb(common.replaygain_album_gain)
  const gainPeak = peakOf(common.replaygain_track_peak) || peakOf(common.replaygain_album_peak)

  return {
    id,
    path: filePath,
    dir: path.dirname(filePath),
    file: path.basename(filePath),
    ext: path.extname(filePath).toLowerCase(),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    title,
    artist,
    albumArtist,
    album: (common.album || '').trim() || '未知专辑',
    genre,
    trackNo,
    discNo,
    year,
    duration: Number(format.duration) || 0,
    codec: format.codec || '',
    bitrate: Math.round(Number(format.bitrate) || 0),
    sampleRate: Number(format.sampleRate) || 0,
    lossless: Boolean(format.lossless),
    // ReplayGain（dB；album 是整张专辑的增益，peak 只在有标签时才有）
    gainTrack,
    gainAlbum,
    gainPeak,
    artworkEmbedded: false,
    artworkFile: null
  }
}

/**
 * 读取单个文件的元数据。
 * @param {string} filePath
 * @param {{ stat?: import('node:fs').Stats, covers?: boolean, sidecarCover?: string|null }} options
 */
async function readMetadata (filePath, options = {}) {
  const stat = options.stat || await fsp.stat(filePath)
  const sidecarCover = options.sidecarCover === undefined
    ? await require('../util/files').findNamedImage(path.dirname(filePath), path.basename(filePath, path.extname(filePath)))
    : options.sidecarCover

  // 已有同名封面文件时就不必再读内嵌封面，扫描会快很多
  const wantCovers = options.covers !== false && !sidecarCover

  const mm = await loadMusicMetadata()
  let track = null

  if (mm) {
    try {
      const parsed = await mm.parseFile(filePath, {
        duration: true,
        skipCovers: !wantCovers,
        skipPostHeaders: false
      })
      track = normalizeTrack(filePath, stat, parsed)
      track.artworkEmbedded = Boolean(parsed.common?.picture?.length)
    } catch (err) {
      console.warn(`[metadata] 解析失败 ${path.basename(filePath)}: ${err.message}`)
    }
  }

  if (!track) {
    // 兜底：只读文件头 1.5MB 交给 ID3 解析器
    const handle = await fsp.open(filePath, 'r')
    try {
      const length = Math.min(stat.size, 1_500_000)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      const result = readId3(filePath, buffer, stat.size)
      track = normalizeTrack(filePath, stat, {
        common: {
          title: result.tags.title,
          artist: result.tags.artist,
          albumArtist: result.tags.albumArtist,
          album: result.tags.album,
          track: { no: Number(result.tags.track) || 0 },
          disk: { no: Number(result.tags.disc) || 0 },
          year: Number(result.tags.year) || 0,
          genre: result.tags.genre
        },
        format: { duration: result.duration }
      })
      track.artworkEmbedded = Boolean(result.picture)
    } finally {
      await handle.close()
    }
  }

  track.artworkFile = sidecarCover
  return track
}

/** 读取内嵌封面（按需调用，结果由 library 服务缓存） */
async function readEmbeddedArtwork (filePath) {
  const mm = await loadMusicMetadata()
  if (!mm) {
    const fspLocal = fsp
    const stat = await fspLocal.stat(filePath)
    const handle = await fspLocal.open(filePath, 'r')
    try {
      const length = Math.min(stat.size, 1_500_000)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, 0)
      const result = readId3(filePath, buffer, stat.size)
      if (!result.picture) return null
      return { mime: result.picture.mime, data: result.picture.data }
    } finally {
      await handle.close()
    }
  }

  const parsed = await mm.parseFile(filePath, { duration: false, skipCovers: false })
  const picture = parsed.common?.picture?.[0]
  if (!picture) return null
  return { mime: picture.format || 'image/jpeg', data: Buffer.from(picture.data) }
}

/** 读取内嵌歌词（ID3 USLT / ©lyr 等），作为没有 .lrc 时的补充来源 */
async function readEmbeddedLyrics (filePath) {
  const mm = await loadMusicMetadata()
  if (!mm) return null
  try {
    const parsed = await mm.parseFile(filePath, { duration: false, skipCovers: true })
    const lyrics = parsed.common?.lyrics
    if (Array.isArray(lyrics) && lyrics.length) {
      const entry = lyrics[0]
      const text = typeof entry === 'string' ? entry : entry?.text
      if (text && text.trim()) return text
    }
  } catch {
    // 内嵌歌词是锦上添花，失败就当作没有
  }
  return null
}

module.exports = { readMetadata, readEmbeddedArtwork, readEmbeddedLyrics, loadMusicMetadata }
