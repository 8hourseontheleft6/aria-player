'use strict'

/**
 * 开发用探针：找一个双语（带翻译）的 .lrc，对比
 *   - 解析后的每行（主歌词 / 翻译）
 *   - 全屏歌词会渲染的内容
 *   - 媒体墙迷你歌词会渲染的内容（目前只取 line.text）
 *
 *   node scripts/probe-lyrics.js [音乐目录] [数量]
 */

const path = require('node:path')
const fsp = require('node:fs/promises')

const { walkFiles } = require('../src/main/util/files')
const { decodeTextBuffer } = require('../src/main/util/text')

async function main () {
  const root = path.resolve(process.argv[2] || path.join(process.env.USERPROFILE || '.', 'Music'))
  const wanted = Number(process.argv[3] || 3)

  const { parseLrc } = await import('../src/renderer/js/core/lrc.js')
  const lrcFiles = await walkFiles(root, (file) => file.toLowerCase().endsWith('.lrc'))

  let found = 0
  for (const file of lrcFiles) {
    const raw = decodeTextBuffer(await fsp.readFile(file)).text
    const { lines } = parseLrc(raw)
    const withTranslation = lines.filter((line) => line.translation)
    // 只关心「有翻译」的歌词
    if (withTranslation.length < 3) continue

    found++
    console.log(`\n=== ${path.basename(file)} ===`)
    console.log(`共 ${lines.length} 行，其中 ${withTranslation.length} 行带翻译\n`)
    console.log('行号 | 时间     | 全屏歌词（主）                | 全屏歌词（翻译）        | 媒体墙迷你歌词')
    console.log('-'.repeat(110))
    for (const line of lines.slice(0, 12)) {
      const cell = (text, width) => {
        const value = String(text || '')
        return (value.length > width ? value.slice(0, width - 1) + '…' : value).padEnd(width)
      }
      console.log(
        `${String(line.index).padStart(4)} | ${line.time.toFixed(2).padStart(8)} | ` +
        `${cell(line.text, 28)} | ${cell(line.translation, 22)} | ${cell(line.text, 20)}`
      )
    }
    if (found >= wanted) break
  }

  console.log(`\n共检查了 ${lrcFiles.length} 个 .lrc，打印了 ${found} 个双语歌词`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
