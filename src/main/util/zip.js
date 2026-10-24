'use strict'

/**
 * 极简 ZIP 写入器（**只存不压**，method=0）。
 *
 * 为什么自己写：诊断包里全是几十 KB 的文本，压缩收益可以忽略；为了这点收益
 * 加一个 archiver 依赖不值得（也少一个供应链面）。单个 zip 里的条目数很少，
 * 直接按 ZIP 规范拼本地头 + 中央目录即可。
 *
 * 只支持 UTF-8 文本 / Buffer，不支持 >4GiB（用 ZIP64 的场合我们不涉及）。
 */

const fs = require('node:fs')
const zlib = require('node:zlib')

/* CRC32（ZIP 规范用的是这个多项式） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32 (buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function dosTime (date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f)
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

/**
 * @param {string} file 目标 zip
 * @param {Array<{ name: string, data: string|Buffer, compress?: boolean }>} entries
 */
function writeZip (file, entries) {
  const locals = []
  const centrals = []
  let offset = 0
  const { time, day } = dosTime()

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8')
    /* 文本条目顺手 deflate 一下（几十 KB 能小一半），二进制的照原样存 */
    const compress = entry.compress !== false
    const body = compress && raw.length > 256 ? zlib.deflateRawSync(raw) : raw
    const method = body === raw ? 0 : 8
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0x0800, 6)      // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)       // extra
    central.writeUInt16LE(0, 32)       // comment
    central.writeUInt16LE(0, 34)       // disk
    central.writeUInt16LE(0, 36)       // internal attrs
    central.writeUInt32LE(0, 38)       // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  fs.writeFileSync(file, Buffer.concat([...locals, ...centrals, end]))
  return file
}

/**
 * 读回来（自检用）：返回 { name: string } 列表与各条目内容。
 * 只处理本文件写出来的形式（stored 或 deflate、无 ZIP64、无加密）。
 */
function readZip (file) {
  const buffer = fs.readFileSync(file)
  let endOffset = -1
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { endOffset = i; break }
  }
  if (endOffset < 0) throw new Error('不是 zip（找不到中央目录结束标记）')
  const count = buffer.readUInt16LE(endOffset + 10)
  let pointer = buffer.readUInt32LE(endOffset + 16)
  const out = {}
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error('中央目录损坏')
    const method = buffer.readUInt16LE(pointer + 10)
    const compressedSize = buffer.readUInt32LE(pointer + 20)
    const nameLength = buffer.readUInt16LE(pointer + 28)
    const extraLength = buffer.readUInt16LE(pointer + 30)
    const commentLength = buffer.readUInt16LE(pointer + 32)
    const localOffset = buffer.readUInt32LE(pointer + 42)
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    const body = buffer.subarray(start, start + compressedSize)
    out[name] = method === 8 ? zlib.inflateRawSync(body) : body
    pointer += 46 + nameLength + extraLength + commentLength
  }
  return out
}

module.exports = { writeZip, readZip, crc32 }
