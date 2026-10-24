#!/usr/bin/env node
/**
 * 列出**当前版本**的安装包（路径 / 体积 / SHA256），找不到就明确说缺哪个。
 *
 * 为什么需要：release 目录里每打一次包就多一对 exe，几十个 beta 版本之后
 * "到底哪个是要发的"就全靠猜。这个脚本只认 `package.json` 里的版本。
 *
 *   npm run artifacts            # 六行清单 + SHA256
 *   npm run artifacts -- --json  # 给脚本用
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

const EXPECTED = [
  ['release', `Aria-Setup-${version}.exe`],
  ['release', `Aria-${version}-portable.exe`],
  ['release-player', `Aria-Player-Setup-${version}.exe`],
  ['release-player', `Aria-Player-${version}-portable.exe`],
  ['release-unified', `Aria-Unified-Setup-${version}.exe`],
  ['release-unified', `Aria-Unified-${version}-portable.exe`]
]

const asJson = process.argv.includes('--json')
const rows = []
let missing = 0

for (const [dir, name] of EXPECTED) {
  const full = path.join(ROOT, dir, name)
  if (!fs.existsSync(full)) {
    missing++
    rows.push({ dir, name, exists: false })
    continue
  }
  const stat = fs.statSync(full)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
  rows.push({
    dir,
    name,
    exists: true,
    path: path.join(dir, name),
    bytes: stat.size,
    mb: Number((stat.size / 1024 / 1024).toFixed(2)),
    sha256: hash,
    mtime: stat.mtime.toISOString()
  })
}

if (asJson) {
  console.log(JSON.stringify({ version, missing, rows }, null, 2))
} else {
  console.log(`版本 ${version} 的安装包：`)
  for (const row of rows) {
    if (!row.exists) {
      console.log(`  ✗ 缺 ${row.dir}/${row.name}`)
      continue
    }
    console.log(`  ${row.path.padEnd(46)} ${String(row.mb).padStart(7)} MB  ${row.sha256}`)
  }
  console.log('')
  console.log(missing
    ? `缺 ${missing} 个 —— 先 npm run dist / dist:player / dist:unified 打包。`
    : '六个都在。发布前对照一遍 SHA256 就行。')
}

process.exit(missing ? 1 : 0)
