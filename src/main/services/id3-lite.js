'use strict'

/**
 * 轻量 ID3 解析器：仅在 music-metadata 不可用时作为兜底，
 * 保证「没有 node_modules 也能把 mp3 播起来、歌名别是文件名」。
 * 支持 ID3v2.2 / v2.3 / v2.4 文本帧 + 内嵌封面，以及 ID3v1。
 */

const path = require('node:path')

const TEXT_FRAMES = {
  TIT2: 'title', TT2: 'title',
  TPE1: 'artist', TP1: 'artist',
  TPE2: 'albumArtist', TP2: 'albumArtist',
  TALB: 'album', TAL: 'album',
  TRCK: 'track', TRK: 'track',
  TPOS: 'disc', TPA: 'disc',
  TYER: 'year', TDRC: 'year', TYE: 'year',
  TCON: 'genre', TCO: 'genre'
}

function syncSafeToInt (buf, offset) {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f)
}

function decodeFrameText (buf) {
  if (!buf.length) return ''
  const encoding = buf[0]
  const body = buf.subarray(1)
  let text = ''
  if (encoding === 0) text = body.toString('latin1')
  else if (encoding === 1) text = decodeUtf16(body)
  else if (encoding === 2) text = decodeUtf16(body, false)
  else text = body.toString('utf8')
  return text.replace(/\u0000+$/g, '').trim()
}

function decodeUtf16 (buf, detectBom = true) {
  try {
    if (detectBom && buf.length >= 2) {
      if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
      if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
    }
    return new TextDecoder('utf-16le').decode(buf)
  } catch {
    return ''
  }
}

/** 找到文本字段的结束位置（按当前编码的终止符宽度） */
function textEnd (buf, start, encoding) {
  if (encoding === 0 || encoding === 3) {
    const i = buf.indexOf(0x00, start)
    return i < 0 ? buf.length : i
  }
  for (let i = start; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0x00 && buf[i + 1] === 0x00) return i
  }
  return buf.length
}

/**
 * 解析 ID3v2 标签头。
 * @param {Buffer} buf
 * @returns {{ tags: object, picture: {mime: string, data: Buffer}|null, size: number }}
 */
function parseId3v2 (buf) {
  const result = { tags: {}, picture: null, size: 0 }
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return result

  const major = buf[3]
  const flags = buf[5]
  const tagSize = syncSafeToInt(buf, 6)
  result.size = tagSize + 10

  let offset = 10
  if (flags & 0x40) {
    // 扩展头：v2.4 为 syncsafe(4)，v2.3 为普通 uint32(4)+2
    if (major >= 4) offset += syncSafeToInt(buf, offset)
    else offset += 4 + buf.readUInt32BE(offset)
  }

  const end = Math.min(buf.length, 10 + tagSize)
  const idLength = major === 2 ? 3 : 4
  const headerLength = major === 2 ? 6 : 10

  while (offset + headerLength <= end) {
    const id = buf.toString('latin1', offset, offset + idLength)
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break

    let frameSize
    if (major === 2) {
      frameSize = (buf[offset + 3] << 16) | (buf[offset + 4] << 8) | buf[offset + 5]
    } else if (major >= 4) {
      frameSize = syncSafeToInt(buf, offset + 4)
    } else {
      frameSize = buf.readUInt32BE(offset + 4)
    }
    if (frameSize <= 0 || frameSize > 64 * 1024 * 1024) break

    const bodyStart = offset + headerLength
    const bodyEnd = bodyStart + frameSize
    if (bodyEnd > buf.length) break
    const body = buf.subarray(bodyStart, bodyEnd)

    const field = TEXT_FRAMES[id]
    if (field && !result.tags[field]) {
      result.tags[field] = decodeFrameText(body)
    } else if (id === 'APIC' || id === 'PIC') {
      const picture = parsePicture(body, major === 2)
      if (picture && !result.picture) result.picture = picture
    }

    offset = bodyEnd
  }

  return result
}

function parsePicture (body, isV22) {
  if (body.length < 6) return null
  const encoding = body[0]
  let cursor = 1
  let mime = 'image/jpeg'
  if (isV22) {
    mime = 'image/' + body.toString('latin1', cursor, cursor + 3).toLowerCase().replace('jpg', 'jpeg')
    cursor += 3
  } else {
    const mimeEnd = textEnd(body, cursor, 0)
    mime = body.toString('latin1', cursor, mimeEnd) || 'image/jpeg'
    cursor = mimeEnd + 1
  }
  cursor += 1 // picture type
  cursor = textEnd(body, cursor, encoding) + (encoding === 0 || encoding === 3 ? 1 : 2)
  if (cursor >= body.length) return null
  return { mime, data: Buffer.from(body.subarray(cursor)) }
}

/** 解析文件末尾 128 字节的 ID3v1 */
function parseId3v1 (buf) {
  const tags = {}
  if (buf.length < 128) return tags
  const tail = buf.subarray(buf.length - 128)
  if (tail.toString('latin1', 0, 3) !== 'TAG') return tags
  const read = (start, len) => tail.toString('latin1', start, start + len).replace(/\u0000+/g, '').trim()
  if (read(3, 30)) tags.title = read(3, 30)
  if (read(33, 30)) tags.artist = read(33, 30)
  if (read(63, 30)) tags.album = read(63, 30)
  const year = read(93, 4)
  if (year) tags.year = year
  const comment = read(97, 30)
  if (comment) tags.comment = comment
  const track = tail[126]
  if (track > 0) tags.track = String(track)
  if (tail[127]) tags.genre = String(tail[127])
  return tags
}

/** CBR mp3 时长估算（兜底用，VBR 会有偏差） */
const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const SAMPLE_RATES_V1 = [44100, 48000, 32000, 0]

function estimateMp3Duration (buf, audioStart, fileSize) {
  for (let i = audioStart; i + 4 < Math.min(buf.length, audioStart + 65536); i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue
    const versionBits = (buf[i + 1] >> 3) & 0x03
    const layerBits = (buf[i + 1] >> 1) & 0x03
    const bitrateIndex = (buf[i + 2] >> 4) & 0x0f
    const sampleRateIndex = (buf[i + 2] >> 2) & 0x03
    if (versionBits !== 3 || layerBits !== 1) continue // 仅 MPEG1 Layer3
    if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) continue
    const bitrate = BITRATES_V1L3[bitrateIndex] * 1000
    const sampleRate = SAMPLE_RATES_V1[sampleRateIndex]
    if (!bitrate || !sampleRate) continue
    const padding = (buf[i + 2] >> 1) & 0x01
    const frameLength = Math.floor(144 * bitrate / sampleRate) + padding
    const frames = Math.floor((fileSize - audioStart) / frameLength)
    return (frames * 1152) / sampleRate
  }
  return 0
}

/**
 * @param {string} filePath
 * @param {Buffer} buf 文件头部（至少 512KB 以内足够）
 * @param {number} fileSize
 */
function readId3 (filePath, buf, fileSize) {
  const v2 = parseId3v2(buf).size ? parseId3v2(buf) : { tags: {}, picture: null, size: 0 }
  const v1 = parseId3v1(buf)
  const tags = { ...v1, ...v2.tags }

  const base = path.basename(filePath, path.extname(filePath))
  if (!tags.title) {
    const split = base.split(' - ')
    if (split.length >= 2) {
      tags.artist = tags.artist || split[0].trim()
      tags.title = split.slice(1).join(' - ').trim()
    } else {
      tags.title = base
    }
  }

  let duration = 0
  if (path.extname(filePath).toLowerCase() === '.mp3') {
    duration = estimateMp3Duration(buf, v2.size, fileSize)
  }

  return { tags, picture: v2.picture, duration }
}

module.exports = { readId3 }
