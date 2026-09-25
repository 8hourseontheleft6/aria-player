'use strict'

/**
 * 开发用探针：脱离 Electron 直接跑一遍「扫描 + 元数据 + 歌词解析」，
 * 用来快速验证解析器在真实文件上的表现。
 *
 *   node scripts/probe-library.js "C:\Users\me\Music" [数量]
 */

const path = require('node:path')
const fsp = require('node:fs/promises')

const { walkFiles } = require('../src/main/util/files')
const { isAudioFile } = require('../src/main/util/mime')
const { readMetadata } = require('../src/main/services/metadata')
const { decodeTextBuffer } = require('../src/main/util/text')
const { findLyricsFile } = require('../src/main/services/lyrics')

async function main () {
  const root = path.resolve(process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME || '.', 'Music'))
  const limit = Number(process.argv[3] || 20)

  console.log(`扫描根目录: ${root}`)
  const startedWalk = Date.now()
  const files = await walkFiles(root, isAudioFile)
  console.log(`发现音频文件 ${files.length} 个（耗时 ${Date.now() - startedWalk} ms）\n`)

  for (const file of files.slice(0, limit)) {
    const t0 = Date.now()
    const track = await readMetadata(file)
    const lrc = await findLyricsFile(track.dir, {
      title: track.title,
      artist: track.artist,
      file: track.file
    })
    const ms = Date.now() - t0
    console.log(`· ${track.file}`)
    console.log(`  ${track.artist} — ${track.title}  《${track.album}》`)
    console.log(`  时长 ${track.duration.toFixed(1)}s | 码率 ${Math.round(track.bitrate / 1000)}kbps | 内嵌封面 ${track.artworkEmbedded} | 同名封面 ${track.artworkFile ? path.basename(track.artworkFile) : '无'} | ${ms}ms`)
    console.log(`  歌词: ${lrc ? path.basename(lrc) : '未找到'}`)
    if (lrc) {
      const raw = await fsp.readFile(lrc)
      const { text, encoding } = decodeTextBuffer(raw)
      const firstLine = text.split(/\r?\n/).find((line) => /\[\d{1,3}:\d{1,2}/.test(line)) || ''
      console.log(`  编码 ${encoding} | 首行: ${firstLine.slice(0, 60)}`)
    }
    console.log()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
