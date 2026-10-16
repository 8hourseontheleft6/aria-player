'use strict'

/**
 * 守住 macOS 菜单：角色名必须真的存在，快捷键不许占用系统保留键。
 *
 *   node scripts/checks/check-menu-roles.js
 *
 * 为什么要有这条检查：菜单是在**启动路径**上安装的（src/main/menu.js），
 * 而 role 拼错会让 Menu.buildFromTemplate 抛错 —— 真出错就是「朋友一打开应用就崩」。
 * 我们手上没有 Mac，所以把「角色名对不对」交给机器核对：
 * 合法角色直接从本机 electron 的类型定义 electron.d.ts 里读出来，
 * 而不是我在检查里再抄一遍（抄一遍就又多了一个会过期的真相来源）。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const problems = []

/* ---------- 1. 从 electron.d.ts 读合法 role ---------- */
const dtsPath = path.join(ROOT, 'node_modules', 'electron', 'electron.d.ts')
if (!fs.existsSync(dtsPath)) {
  console.log('找不到 node_modules/electron/electron.d.ts —— 先 npm install 再跑这条检查')
  process.exit(1)
}
const dts = fs.readFileSync(dtsPath, 'utf8')
const roleUnion = /role\?:\s*([^;]+);/.exec(dts)
if (!roleUnion) {
  console.log('在 electron.d.ts 里找不到 role 联合类型 —— 检查本身失效了，不能静默通过')
  process.exit(1)
}
const allowedRoles = new Set([...roleUnion[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]))
if (allowedRoles.size < 30) {
  problems.push(`解析出的合法 role 只有 ${allowedRoles.size} 个，明显不对（应该 40+）—— 检查本身失效了`)
}

/* ---------- 2. 把模板里用到的 role / accelerator 收集出来 ---------- */
const { buildMacMenuTemplate, PLAY_COMMANDS } = require(path.join(ROOT, 'src', 'main', 'menu.js'))
const template = buildMacMenuTemplate({ appName: 'Aria', send: () => {} })

const usedRoles = []
const accelerators = []
const clickedCommands = []
let itemCount = 0

function walk (items, trail) {
  for (const item of items) {
    itemCount++
    const where = `${trail} › ${item.label || item.role || item.type || '(无标题)'}`
    if (item.role) usedRoles.push({ role: item.role, where })
    if (item.accelerator) accelerators.push({ accelerator: item.accelerator, label: item.label || item.role, where })
    if (item.submenu) walk(item.submenu, where)
  }
}
walk(template, '菜单')

/* ---------- 3. 断言 ---------- */
for (const { role, where } of usedRoles) {
  if (!allowedRoles.has(role)) problems.push(`菜单里用了 Electron 不认识的 role「${role}」：${where}`)
}

/*
 * macOS 系统保留键：⌘Q 是退出、⌘M 是最小化。
 * 应用功能（队列 / 静音）必须走 ⌥⌘ 变体 —— 与渲染层 app.js 里的按键分支保持一致。
 * 这里只拦「Cmd+Q / Cmd+M」这两种写法，role 自带的 quit / minimize 不受影响（它们本来就该是 ⌘Q/⌘M）。
 */
for (const { accelerator, label, where } of accelerators) {
  const normalized = String(accelerator).replace(/\s+/g, '')
  if (/^(Cmd|Command|Super)\+(Q|M)$/i.test(normalized)) {
    problems.push(`「${label}」占用了 macOS 系统保留键 ${accelerator}（退出 / 最小化）—— 应用功能请用 Alt+Cmd+…：${where}`)
  }
}

/* 播放指令必须都是应用真的会处理的那几种（渲染层的 media:command 分支） */
const rendererCommands = new Set([
  'play-pause', 'next', 'previous', 'stop', 'volume-up', 'volume-down', 'mute', 'queue', 'now-playing'
])
for (const name of PLAY_COMMANDS) {
  if (!rendererCommands.has(name)) problems.push(`PLAY_COMMANDS 里的「${name}」不在渲染层认识的指令清单里`)
}

/* 菜单至少要覆盖这几件 mac 应用该有的事，避免以后被人删空 */
const labels = []
const collectLabels = (items) => {
  for (const item of items) {
    if (item.label) labels.push(item.label)
    if (item.submenu) collectLabels(item.submenu)
  }
}
collectLabels(template)
for (const required of ['播放 / 暂停', '上一首', '下一首', '退出', '拷贝', '粘贴', '最小化']) {
  if (!labels.some((label) => label.includes(required))) problems.push(`菜单里缺了「${required}」这一项`)
}

/* ---------- 4. 报告 ---------- */
console.log(`菜单检查：合法 role ${allowedRoles.size} 个（来自 electron.d.ts）；` +
  `模板用了 ${usedRoles.length} 个 role、${accelerators.length} 个快捷键、共 ${itemCount} 项`)
for (const problem of problems) console.log('  ✗ ' + problem)
if (problems.length === 0) console.log('  菜单角色与快捷键检查：0 问题')
process.exit(problems.length ? 1 : 0)
