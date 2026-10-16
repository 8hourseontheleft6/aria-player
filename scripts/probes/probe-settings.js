'use strict'

/**
 * 开发用探针：设置项 × 读写来源（只打印，不判定）。
 *
 *   node scripts/probes/probe-settings.js
 *
 * 想回答两个问题：
 *   ① 有哪些设置**没有任何界面控件能改**（= 用户够不着的功能，或者只是内部状态）；
 *   ② 有哪些设置**没人读**（= 改了也没用的死设置）。
 *
 * ⚠️ 它的结论只能当线索，不能当结论 —— **第一版就是错的**，两处盲区：
 *   · 写入侧只认 `setSetting({ key: … })`，漏了 `remote.settings.set({ … })`
 *     （于是 volume / muted / playbackRate / playbackMode 全被误判成"没界面"）；
 *   · 读取侧只认 `settings.key` 与裸 `key`，漏了 `settings.get().key`
 *     （于是 backgroundRelease 被误报成死键 —— 它其实由 src/main/background.js 读取）。
 * 这两条都补上了，但**正则永远可能漏**：任何一条发现都要再去 grep 一次确认。
 * 统计写入方时特意排除开发文件（smoke / screenshot / visual-audit / perf）：
 * 只有自检会写的设置，对用户来说等于没有界面。
 *
 * 它带来的一个真实结果：`onlineArtists` 一直被 main/services/online-media.js 读取，
 * 界面上却从来没有开关 —— 遂补上「在线艺人头像」一行。
 *
 * 补完之后跑一遍的结论（当作快照，将来对照）：
 *   · 没有任何界面控件能改的：只剩 `backgroundRelease`；
 *   · 没有任何人读的死设置：0 项。
 * `backgroundRelease` 是**主进程内存释放优化**的总开关（main/services/background.js 的 enabled()），
 * 只在主进程读、默认开、界面上没有入口 —— 更像一个调试用的 kill switch，而不是给用户的选项。
 * 所以**没有擅自给它加界面**（那属于产品决定）；要加的话说一声。
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const readTree = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) readTree(full, out)
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

const appFiles = readTree(path.join(root, 'src'))
const devFiles = new Set(['smoke.js', 'screenshot.js', 'visual-audit.js', 'perf.js', 'probe-settings.js'])
const isDev = (file) => devFiles.has(path.basename(file))
/*
 * 默认值文件要从**写入扫描**里排除：它们里面的 `key: 默认值` 正是键的定义，
 * 不是"有人写这个设置"。第一版补上裸 `key:` 模式之后就是这么被骗的 ——
 * 48 项全部被判成"有界面"，等于什么也没查出来（同一个教训的第三次显现：
 * 判据宽一格、结论就从"全都有问题"翻成"全都没问题"）。
 */
const defaultFiles = new Set(['settings.js', 'store.js'])

const settingsSource = fs.readFileSync(path.join(root, 'src', 'main', 'services', 'settings.js'), 'utf8')
const keys = [...settingsSource.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1])
/* 这些是窗口/会话一类的内部状态，本来就不该有界面 */
const internal = new Set(['version', 'window', 'lastTrackPath', 'folders', 'playlists', 'musicSources', 'ai', 'lastView'])

const rows = []
for (const key of keys) {
  const escape = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 读取：settings.key / settings.get().key / 裸 key
  const readPattern = new RegExp(`settings\\??\\.${escape}\\b|settings\\.get\\(\\)\\.${escape}\\b|\\b${escape}\\b`)
  // 写入：setSetting({ key / remote.settings.set({ key / 行内的 key:（粗略）
  const writePattern = new RegExp(`(setSetting|settings\\.set)\\(\\s*\\{[^}]*\\b${escape}\\b|\\b${escape}:`)
  let readers = 0
  let writers = 0
  const writerFiles = new Set()
  for (const file of appFiles) {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue
      if (readPattern.test(trimmed)) readers++
      if (writePattern.test(trimmed) && !isDev(file) && !defaultFiles.has(path.basename(file))) {
        writers++
        writerFiles.add(path.relative(root, file))
      }
    }
  }
  rows.push({ key, readers, writers, writerFiles: [...writerFiles].slice(0, 2), internal: internal.has(key) })
}

console.log('设置项'.padEnd(24) + '读'.padStart(4) + '界面写'.padStart(7) + '   写入方（前两处）')
for (const row of rows.sort((a, b) => a.writers - b.writers || a.key.localeCompare(b.key))) {
  const flag = row.internal ? '·内部' : (row.writers === 0 ? '✗无界面' : '')
  console.log(row.key.padEnd(24) + String(row.readers).padStart(4) + String(row.writers).padStart(7) +
    '   ' + row.writerFiles.join('、') + (flag ? '   ' + flag : ''))
}
const noUi = rows.filter((r) => r.writers === 0 && !r.internal)
console.log(`\n共 ${rows.length} 项；没有任何界面控件能改的：${noUi.length} 项 —— ${noUi.map((r) => r.key).join('、') || '（无）'}`)
console.log('（正则可能漏，任何一条都要再 grep 确认一次；见本文件开头的两处盲区）')
