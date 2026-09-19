'use strict'

/**
 * 一次性侦察脚本：把资料库里「一个字段里塞了多个艺人」的写法全列出来，
 * 用来决定拆分规则（哪些分隔符真的出现、出现多少次），而不是凭想象写正则。
 *
 *   node scripts/probe-artists.js "D:\Music"
 */

const path = require('node:path')
const fs = require('node:fs')
const { parseFile } = require('music-metadata')

const AUDIO = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.wma'])

function walk (dir, out = [], depth = 0) {
  if (depth > 6) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out, depth + 1)
    else if (AUDIO.has(path.extname(entry.name).toLowerCase())) out.push(full)
  }
  return out
}

// 候选分隔符：先是明确的分隔符，再是有歧义的（& + x with feat）
const SEPARATORS = [
  { name: '分号 ;', test: /\s*[;；]\s*/ },
  { name: '斜杠 /', test: /\s*\/\s*/ },
  { name: '顿号 、', test: /\s*、\s*/ },
  { name: '逗号 ,', test: /\s*,\s*/ },
  { name: '＆(全角)', test: /\s*＆\s*/ },
  { name: '&', test: /\s*&\s*/ },
  { name: 'and', test: /\s+and\s+/i },
  { name: 'with', test: /\s+with\s+/i },
  { name: 'feat', test: /\s+(feat|ft)\.?\s+/i },
  { name: '加号 +', test: /\s*\+\s*/ },
  { name: '乘号 x/×', test: /\s*[x×]\s+/i },
  { name: 'vs', test: /\s+vs\.?\s+/i }
]

async function main () {
  const root = process.argv[2] || path.join(process.env.USERPROFILE || '', 'Music')
  const files = walk(root)
  console.log(`扫描 ${files.length} 个音频文件：${root}\n`)

  const artistStrings = new Map()
  const albumArtistStrings = new Map()
  let failed = 0

  for (const file of files) {
    let meta
    try {
      meta = await parseFile(file, { duration: true, skipCovers: true })
    } catch {
      failed++
      continue
    }
    const artist = meta.common.artist
    const albumArtist = meta.common.albumartist
    if (artist) {
      for (const part of String(artist).split(/\u0000/)) {
        const key = part.trim()
        if (key) artistStrings.set(key, (artistStrings.get(key) || 0) + 1)
      }
    }
    if (albumArtist) {
      const key = String(albumArtist).trim()
      if (key) albumArtistStrings.set(key, (albumArtistStrings.get(key) || 0) + 1)
    }
  }

  console.log(`解析失败 ${failed} 个\n`)

  for (const [label, table] of [['artist', artistStrings], ['albumartist', albumArtistStrings]]) {
    console.log(`=== ${label}：共 ${table.size} 种写法 ===`)
    const hits = new Map(SEPARATORS.map((s) => [s.name, []]))
    for (const [value, count] of table) {
      for (const separator of SEPARATORS) {
        if (separator.test.test(value)) hits.get(separator.name).push(`${value} (${count})`)
      }
    }
    for (const [name, list] of hits) {
      console.log(`\n--- 含「${name}」：${list.length} 种 ---`)
      for (const item of list.slice(0, 40)) console.log(`    ${item}`)
      if (list.length > 40) console.log(`    …另有 ${list.length - 40} 种`)
    }
    console.log('')
  }

  console.log('=== 最长的 30 个 artist 写法（通常是合作） ===')
  const longest = [...artistStrings.entries()].sort((a, b) => b[0].length - a[0].length).slice(0, 30)
  for (const [value, count] of longest) console.log(`    ${count}\t${value}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
