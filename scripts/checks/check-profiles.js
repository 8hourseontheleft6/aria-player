'use strict'

/**
 * 产品档位结构守卫：**每个档位允许挂哪些服务与插件**。
 *
 *   node scripts/checks/check-profiles.js
 *
 * 为什么要有它：拆成两个产品之后，"某个档位多挂了一个服务"这种错误**运行时看不出来** ——
 * player 里悄悄挂上 online，界面一切正常，只是它开始联网查封面了；等到用户发现
 * 「轻量播放器为什么在联网」时，已经过了好几个版本。所以规则必须写死在检查里。
 *
 * 判据来自唯一事实来源 src/main/profile.js（纯数据，不牵扯 Electron，可以直接 require），
 * 再和实现对照：
 *   ① full 的服务/插件清单等于棘轮值（掉一个、多一个都红 —— 要改就得动这个文件）；
 *   ② player 的服务只能落在白名单里（settings + openedFiles），插件必须为空；
 *   ③ 表里每个服务名在 main.js 的 SERVICE_FACTORIES 里都有工厂，反之也不能有孤儿工厂；
 *   ④ main.js 里除挂载循环外**不许出现 ctx.define**（防止"顺手多挂一个"绕过档位表）；
 *   ⑤ 渲染层只能用 pluginsForProfile 注册插件（不许再出现 loadAll(BUILTIN_PLUGINS) 那种全量注册）；
 *   ⑥ 表里的插件 id 必须真的存在于渲染层的 PLUGIN_REGISTRY；
 *   ⑦ 侧栏清单里的 id 必须是渲染层已知的视图键；
 *   ⑧ 档位不能是设置项（README/设置默认值里出现 profile 就算违规）。
 *
 * 反向验证（第 1 步验收要求）：把 'online' 加进 player.services → ① 之外的 ② 立刻变红。
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const { PROFILES } = require(path.join(root, 'src', 'main', 'profile.js'))

/** 棘轮：改这里必须是有意的review，不是顺手 */
const FULL_SERVICES = [
  'settings', 'library', 'lyrics', 'online', 'ai', 'musicSources', 'tray', 'watcher', 'background'
]
const FULL_PLUGINS = ['trackInfoPanel', 'quickActions', 'onlineMedia']
/** player 档位只允许这两样：设置 + 「打开的文件」 */
const PLAYER_SERVICES_ALLOWED = ['settings', 'openedFiles']

const problems = []

/* ---------- ② 档位本身的规则 ---------- */
const full = PROFILES.full
const player = PROFILES.player
if (!full || !player) {
  problems.push('profile.js 里必须同时定义 full 与 player 两个档位')
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

if (full && !sameSet(full.services, FULL_SERVICES)) {
  problems.push(`full.services 与棘轮不一致：现在是 [${full.services}]，棘轮是 [${FULL_SERVICES}]` +
    '（少一个=本体丢功能；多一个=要先在这里登记再挂）')
}
if (full && !sameSet(full.plugins, FULL_PLUGINS)) {
  problems.push(`full.plugins 与棘轮不一致：现在是 [${full.plugins}]，棘轮是 [${FULL_PLUGINS}]`)
}
if (player) {
  const stray = player.services.filter((name) => !PLAYER_SERVICES_ALLOWED.includes(name))
  if (stray.length) {
    problems.push(`player 档位挂了不该有的服务：${stray.join('、')} —— player 只能是 [${PLAYER_SERVICES_ALLOWED}]` +
      '（在线歌词/封面、资料库扫描、目录监听都不该存在）')
  }
  if (player.plugins.length) {
    problems.push(`player.plugins 必须为空，现在有 [${player.plugins}] —— 插件是能力开关，注册了就等于有了`)
  }
}

/* ---------- ③ 服务名 ↔ main.js 的工厂表 ---------- */
const mainSource = read('src/main/main.js')
const factories = new Set(
  [...mainSource.matchAll(/^\s{2}([a-zA-Z][\w]*)\s*:\s*create[A-Za-z]+Service,?\s*$/gm)].map((m) => m[1])
)
const declared = new Set([...(full ? full.services : []), ...(player ? player.services : [])])
for (const name of declared) {
  if (!factories.has(name)) problems.push(`档位表里有服务「${name}」，但 main.js 的 SERVICE_FACTORIES 里没有对应工厂`)
}
for (const name of factories) {
  if (!declared.has(name)) problems.push(`main.js 的 SERVICE_FACTORIES 里有「${name}」，但没有任何档位在用它（孤儿工厂）`)
}

/* ---------- ④ ctx.define 只能出现在挂载循环里 ---------- */
/* 去掉注释再数：注释里解释"想扩展能力就在 ctx.define 加一行"是正常的，
 * 拿注释判红会逼着人把说明改得别扭 —— 判据必须只看真正的代码。 */
const mainCode = mainSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const defineLines = [...mainCode.matchAll(/ctx\.define\(/g)].length
const loopDefine = /for \(const name of profile\.services\)[\s\S]{0,400}?ctx\.define\(name, factory\)/.test(mainCode)
if (!loopDefine) problems.push('main.js 里找不到"按 profile.services 挂载"的循环（ctx.define(name, factory)）')
if (defineLines !== 1) {
  problems.push(`main.js 里 ctx.define 出现 ${defineLines} 次（应当只有挂载循环里那 1 次）—— ` +
    '多出来的 define 会绕过档位表，等于某个档位凭空多出一个服务')
}

/* ---------- ⑤ 渲染层只能用 pluginsForProfile 注册 ---------- */
const appSource = read('src/renderer/js/app.js')
if (!/host\.loadAll\(pluginsForProfile\(/.test(appSource)) {
  problems.push('app.js 里没有用 pluginsForProfile(...) 注册插件 —— 档位就管不到插件了')
}
if (/host\.loadAll\(\s*BUILTIN_PLUGINS\s*\)/.test(appSource)) {
  problems.push('app.js 里仍然全量注册 BUILTIN_PLUGINS（loadAll(BUILTIN_PLUGINS)）—— 那会让 player 也拿到在线能力')
}

/* ---------- ⑥ 插件 id 必须存在于渲染层的注册表 ---------- */
const pluginSource = read('src/renderer/js/plugins/index.js')
const registryBlock = /PLUGIN_REGISTRY\s*=\s*\{([\s\S]*?)\n\}/.exec(pluginSource)
/* 逐行取行首标识符：注册表里用简写（`trackInfoPanel,`），最后一项**没有逗号**，
 * 所以不能要求行尾有 , 或 : —— 第一版就是这么漏掉 onlineMedia 的。 */
const registryIds = registryBlock
  ? registryBlock[1].split('\n')
    .map((line) => (/^\s*([a-zA-Z][\w]*)/.exec(line) || [])[1])
    .filter(Boolean)
  : []
if (!registryIds.length) problems.push('读不出渲染层的 PLUGIN_REGISTRY')
for (const id of full ? full.plugins : []) {
  if (!registryIds.includes(id)) problems.push(`档位表里的插件「${id}」在 src/renderer/js/plugins/index.js 的 PLUGIN_REGISTRY 里不存在`)
}
for (const id of registryIds) {
  if (!(full ? full.plugins : []).includes(id)) {
    problems.push(`渲染层注册表里有插件「${id}」，但没有任何档位在用它 —— 要么加进档位表，要么删掉`)
  }
}

/* ---------- ⑦ 侧栏 id 必须是已知视图 ---------- */
const sidebarSource = read('src/renderer/js/ui/panels/sidebar.js')
const viewBlock = /export const VIEW_ITEMS\s*=\s*\{([\s\S]*?)\n\}/.exec(sidebarSource)
const viewKeys = viewBlock ? [...viewBlock[1].matchAll(/^\s{2}([a-zA-Z][\w]*)\s*:\s*\{/gm)].map((m) => m[1]) : []
if (!viewKeys.length) problems.push('读不出 sidebar.js 的 VIEW_ITEMS')
for (const [id, def] of Object.entries(PROFILES)) {
  for (const key of def.sidebar || []) {
    if (!viewKeys.includes(key)) problems.push(`档位 ${id} 的侧栏里有未知视图「${key}」（已知：${viewKeys.join('、')}）`)
  }
  if (!(def.sidebar || []).length) problems.push(`档位 ${id} 的侧栏清单是空的`)
}

/* ---------- ⑧ 档位不许做成设置项 ---------- */
const settingsSource = read('src/main/services/settings.js')
const storeSource = read('src/renderer/js/core/store.js')
for (const [label, source] of [['settings.js', settingsSource], ['store.js', storeSource]]) {
  if (/^\s*profile\s*[:=]/m.test(source) && !/app:\s*\{[^}]*profile/.test(source)) {
    problems.push(`${label} 里出现了 profile 设置项 —— 档位是"我是哪个产品"，不是用户偏好，不能进设置`)
  }
}

/* ---------- 报告 ---------- */
console.log(`档位检查：full 服务 ${full ? full.services.length : 0} 个 / 插件 ${full ? full.plugins.length : 0} 个；` +
  `player 服务 ${player ? player.services.length : 0} 个（${player ? player.services.join('、') : '—'}）/ 插件 ${player ? player.plugins.length : 0} 个；` +
  `视图键 ${viewKeys.length} 个；工厂 ${factories.size} 个`)
for (const problem of problems) console.log('  ✗ ' + problem)
if (!problems.length) console.log('  档位检查：0 问题')
process.exit(problems.length ? 1 : 0)
