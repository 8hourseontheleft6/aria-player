'use strict'

/**
 * 开发用探针：找出 CSS 里定义了、但 JS/HTML 里从没出现过的类名（只打印，不判定）。
 *
 *   node scripts/probes/probe-dead-css.js
 *
 * 为什么是探针而不是检查：**误报率天然偏高**，至少两种形态会假报：
 *   ① 类名是拼出来的 —— 例如 overlay.js 写 `toast toast--${type}`，
 *      于是 toast--error / toast--success 全都"找不到"（其实是动态使用）；
 *   ② 解析假象 —— 内联 SVG 的 data-URL 里有 `w3.org`，于是 `.w3` 被当成类名。
 * 一个会把正常用法判红的检查很快就会没人看，所以这里只打印候选，由人过一眼。
 *
 * 实测（2026-10-17）：CSS 定义 411 个类，其中 21 个在 JS/HTML 里找不到 ——
 * 逐条看下来多数是**改名留下的旧样式**（wheel__box / track-row__bars / settings__folder…），
 * 也有本文件的两种误报。用途：清理前先跑一次，别凭记忆删。
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const stylesDir = path.join(root, 'src', 'renderer', 'styles')

const classes = new Set()
for (const file of fs.readdirSync(stylesDir).filter((name) => name.endsWith('.css'))) {
  const text = fs.readFileSync(path.join(stylesDir, file), 'utf8')
  for (const match of text.matchAll(/\.([a-zA-Z][\w-]*)/g)) classes.add(match[1])
}

let haystack = ''
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (/\.(js|html)$/.test(entry.name)) haystack += fs.readFileSync(full, 'utf8') + '\n'
  }
}
walk(path.join(root, 'src'))

const dead = [...classes]
  .filter((name) => !new RegExp(`\\b${name.replace(/-/g, '\\-')}\\b`).test(haystack))
  .sort()

console.log(`CSS 里定义的类：${classes.size} 个；在 JS/HTML 里找不到的候选：${dead.length} 个`)
for (const name of dead) console.log('  · ' + name)
console.log('\n注意：模板拼出来的类名（如 toast--${type}）与 data-URL 里的字样都会假报，逐条过一眼再删。')
