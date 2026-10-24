#!/usr/bin/env node
/**
 * 列出安装包：默认只列 `package.json` 里**当前版本**那六个（体积 + SHA256），
 * 加 `--all` 再把 `_archive/` 里归档的旧版本也列出来。
 *
 * 为什么需要：每打一次包就多一对 exe，几十个版本之后"到底哪个是要发的"全靠猜。
 * 这个脚本只认版本号，其他一律不算。
 *
 *   npm run artifacts            # 当前版本六个
 *   npm run artifacts -- --all   # 再加上历史归档（release*\/_archive/<版本>/）
 *   npm run artifacts -- --json
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version

const DIRS = ['release', 'release-player', 'release-unified']
const EXPECTED = [
  ['release', `Aria-Setup-${version}.exe`],
  ['release', `Aria-${version}-portable.exe`],
  ['release-player', `Aria-Player-Setup-${version}.exe`],
  ['release-player', `Aria-Player-${version}-portable.exe`],
  ['release-unified', `Aria-Unified-Setup-${version}.exe`],
  ['release-unified', `Aria-Unified-${version}-portable.exe`]
]

const asJson = process.argv.includes('--json')
const withArchive = process.argv.includes('--all')
const mb = (bytes) => Number((bytes / 1024 / 1024).toFixed(2))

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
  rows.push({
    dir,
    name,
    exists: true,
    path: path.join(dir, name),
    bytes: stat.size,
    mb: mb(stat.size),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
    mtime: stat.mtime.toISOString()
  })
}

/* 归档：release*\/_archive/<版本>/ 下的旧发行文件（按版本合并，三个目录归到一组） */
const archived = new Map()
if (withArchive) {
  for (const dir of DIRS) {
    const base = path.join(ROOT, dir, '_archive')
    if (!fs.existsSync(base)) continue
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const files = fs.readdirSync(path.join(base, entry.name))
        .filter((name) => /\.(exe|zip)$/i.test(name))
        .map((name) => {
          const stat = fs.statSync(path.join(base, entry.name, name))
          return { name, dir, mb: mb(stat.size) }
        })
      if (!files.length) continue
      if (!archived.has(entry.name)) archived.set(entry.name, [])
      archived.get(entry.name).push(...files)
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ version, missing, rows, archived: Object.fromEntries(archived) }, null, 2))
} else {
  console.log(`版本 ${version} 的安装包：`)
  for (const row of rows) {
    if (!row.exists) { console.log(`  ✗ 缺 ${row.dir}/${row.name}`); continue }
    console.log(`  ${row.path.padEnd(46)} ${String(row.mb).padStart(7)} MB  ${row.sha256}`)
  }
  console.log('')
  console.log(missing ? `缺 ${missing} 个 —— 先 npm run dist / dist:player / dist:unified。`
    : '六个都在。发布前对照一遍 SHA256 就行。')

  if (withArchive) {
    console.log('')
    if (!archived.size) {
      console.log('历史归档：空（`npm run clean:dist` 会把旧版本挪进 release*/_archive/<版本>/）')
    } else {
      console.log('历史归档（release*/_archive/<版本>/）：')
      for (const [ver, files] of [...archived.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const total = files.reduce((sum, file) => sum + file.mb, 0).toFixed(1)
        console.log(`  ${ver}（${files.length} 个、${total} MB）`)
        for (const file of files) {
          const label = `    ${file.dir}/_archive/${ver}/${file.name}`
          console.log(label.padEnd(64) + `${String(file.mb).padStart(7)} MB`)
        }
      }
    }
  }
}

process.exit(missing ? 1 : 0)
