#!/usr/bin/env node
/**
 * 清理 release 目录：只保留 package.json 当前版本的安装包。
 *
 * 背景：electron-builder 每打一次包就新增一对 Setup / portable，几十个 beta 版本之后
 * 三个目录加起来能到 20 GB，找安装包全靠翻。
 *
 * 默认行为是**归档**（移到 <目录>/_archive/<版本>/），不是删除 —— 旧安装包还可能有用，
 * 手一抖删了就找不回来了（0.1.1 发布时已经踩过一次）。
 *
 *   npm run clean:dist                  # 旧版本 → _archive/<版本>/，并清掉 win-unpacked
 *   npm run clean:dist -- --purge       # 直接删掉（不再归档）
 *   npm run clean:dist -- --keep-unpacked   # 保留 win-unpacked（要直接跑打包产物时用）
 *
 * 只动这三类可重建的东西：旧版本的发行文件、win-unpacked/、.icon-ico/。
 * 不碰源码、不碰 .tmp/、也不碰当前版本的任何文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = pkg.version
const DIRS = ['release', 'release-player', 'release-unified']
const purge = process.argv.includes('--purge')
const keepUnpacked = process.argv.includes('--keep-unpacked')

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1)

/** 从文件名里认出它属于哪个版本；认不出就归到 unknown。 */
function versionOf (name) {
  const match = /(\d+\.\d+\.\d+(?:-beta\.\d+)?)/.exec(name)
  return match ? match[1] : 'unknown'
}

let freed = 0
let moved = 0
let removed = 0

for (const dir of DIRS) {
  const full = path.join(ROOT, dir)
  if (!fs.existsSync(full)) continue
  const files = fs.readdirSync(full, { withFileTypes: true }).filter((entry) => entry.isFile())
  const keep = files.filter((entry) => entry.name.includes(version))
  const old = files.filter((entry) => !entry.name.includes(version))

  for (const entry of old) {
    const source = path.join(full, entry.name)
    const bytes = fs.statSync(source).size
    if (purge) {
      fs.rmSync(source, { force: true })
      freed += bytes
      removed++
      continue
    }
    const archive = path.join(full, '_archive', versionOf(entry.name))
    fs.mkdirSync(archive, { recursive: true })
    fs.renameSync(source, path.join(archive, entry.name))
    moved++
  }

  console.log(`  ${dir.padEnd(16)} 保留 ${String(keep.length).padStart(2)} 个、` +
    `归档 ${String(old.length).padStart(3)} 个` + (purge ? '（已删除）' : ''))
}

if (!keepUnpacked) {
  for (const dir of DIRS) {
    for (const sub of ['win-unpacked', '.icon-ico']) {
      const target = path.join(ROOT, dir, sub)
      if (!fs.existsSync(target)) continue
      let bytes = 0
      const walk = (p) => {
        for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
          const child = path.join(p, entry.name)
          if (entry.isDirectory()) walk(child)
          else bytes += fs.statSync(child).size
        }
      }
      walk(target)
      fs.rmSync(target, { recursive: true, force: true })
      freed += bytes
      console.log(`  ${dir.padEnd(16)} ${sub.padEnd(14)} 回收 ${mb(bytes)} MB`)
    }
  }
}

console.log('')
if (purge) {
  console.log(`  删除 ${removed} 个旧发行文件、回收 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB。当前版本 ${version} 原样保留。`)
} else {
  console.log(`  归档 ${moved} 个旧发行文件到各自的 _archive/<版本>/，回收 ${(freed / 1024 / 1024 / 1024).toFixed(2)} GB（win-unpacked 等构建缓存）。`)
}
console.log('  想看还剩哪些安装包：npm run artifacts')
