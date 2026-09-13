'use strict'

/**
 * 文本解码：歌词文件在中文环境里大量存在 GBK/GB18030 编码，
 * 直接按 UTF-8 读会出现 。策略：
 *   BOM > UTF-8 严格校验 > GB18030 > Big5 > Shift_JIS > 兜底 UTF-8
 */

const BOM_UTF8 = [0xef, 0xbb, 0xbf]

function hasPrefix (buf, bytes) {
  if (buf.length < bytes.length) return false
  return bytes.every((b, i) => buf[i] === b)
}

function tryDecode (buffer, encoding) {
  try {
    return { text: new TextDecoder(encoding, { fatal: true }).decode(buffer), encoding }
  } catch {
    return null
  }
}

/**
 * @param {Buffer|Uint8Array} input
 * @returns {{ text: string, encoding: string }}
 */
function decodeTextBuffer (input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)

  if (hasPrefix(buffer, BOM_UTF8)) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' }
  }

  for (const encoding of ['utf-8', 'gb18030', 'big5', 'shift_jis']) {
    const result = tryDecode(buffer, encoding)
    if (result) return result
  }

  // 极少数情况下 GB18030 解码器也会失败，退回宽容模式并标记
  return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8(lossy)' }
}

/** 去掉可能存在的 BOM 与首尾空白 */
function stripBom (text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

module.exports = { decodeTextBuffer, stripBom }
