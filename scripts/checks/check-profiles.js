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

/* ---------- ⑨ 能力标记必须与"挂了哪些服务/插件"一致 ---------- */
/*
 * 渲染层靠 profile.capabilities 判断"这个产品有没有资料库/在线能力"，
 * 而主进程靠 services / plugins 决定"到底挂不挂"。两者是同一个事实的两种表述，
 * 一旦不一致就是典型的"界面说有、实际没有"（第 2 步就是在这里抓到
 * "tracks is not iterable" 的：渲染层以为有资料库，主进程根本没挂 library）。
 */
for (const [id, def] of Object.entries(PROFILES)) {
  const caps = def.capabilities || {}
  const expect = {
    library: (def.services || []).includes('library'),
    lyrics: (def.services || []).includes('lyrics'),
    // 在线音源是主进程的 musicSources 服务
    sources: (def.services || []).includes('musicSources'),
    /*
     * visualizer 是**纯展示**能力：它不挂在任何服务/插件上（元素、WebAudio、设置项都在渲染层）。
     * 单独列出来，是为了让"player 不做示波器"这条决定有个明确的落点，而不是散在渲染层的 if 里。
     */
    visualizer: (def.capabilities && def.capabilities.visualizer === true),
    // 在线能力由插件提供（online-media 注册了才有歌词/封面提供者）
    online: (def.plugins || []).includes('onlineMedia')
  }
  for (const [name, value] of Object.entries(expect)) {
    if (caps[name] !== value) {
      problems.push(`档位 ${id} 的能力标记 capabilities.${name}=${caps[name]}，但按服务/插件算应当是 ${value} —— ` +
        '两者必须同源，否则界面会说有、实际没有（或反过来）')
    }
  }
}

/* ---------- ⑩ 第三个产品：Aria Unified（一个安装包两种模式） ---------- */
/*
 * 这一段的判据分两类，都必须是"能机械判定"的：
 *   a) 身份字段（appId / productName / 入口 / 输出目录 / 产物名）与启动规则；
 *   b) **前两个产品的身份不许变** —— 用棘轮值盯着，改动必须是有意的。
 */
const { PRODUCTS, resolveProfile: resolveProfileForCheck } = require(path.join(root, 'src', 'main', 'profile.js'))

const unifiedYmlPath = path.join(root, 'electron-builder.unified.yml')
if (!fs.existsSync(unifiedYmlPath)) {
  problems.push('没有 electron-builder.unified.yml —— 第三个产品出不了包')
} else {
  const unifiedYml = fs.readFileSync(unifiedYmlPath, 'utf8')
  const expect = [
    ['appId: com.aria.player.unified', 'appId 应当是 com.aria.player.unified'],
    ['productName: Aria Unified', 'productName 应当是 Aria Unified'],
    ['main: src/main/main-unified.js', '入口应当是 src/main/main-unified.js'],
    ['output: release-unified', '输出目录应当是 release-unified'],
    ['Aria-Unified-Setup-${version}', '安装包产物名应当是 Aria-Unified-Setup-*'],
    ['Aria-Unified-${version}-portable', 'portable 产物名应当是 Aria-Unified-*-portable'],
    ['extends: ./electron-builder.base.yml', '应当 extends 共用基座']
  ]
  for (const [needle, message] of expect) {
    if (!unifiedYml.includes(needle)) problems.push(`electron-builder.unified.yml：${message}`)
  }
  /* fileAssociations 必须指向**自己**（第三产品），且覆盖需求点名的 5 种格式 */
  for (const ext of ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus']) {
    if (!new RegExp(`ext:\\s*${ext}\\b`).test(unifiedYml)) {
      problems.push(`electron-builder.unified.yml 的 fileAssociations 里没有 ${ext}`)
    }
  }
  /*
   * 关联必须指向**自己**（第三产品）。判据从"名字里出现 Aria Unified"换成了
   * "ProgId 前缀就是 Aria.Unified" —— 更严也更具体：旧判据在 ASCII ProgId 下会误报，
   * 而这一条同时保证了"不与 Aria Player 的 Aria.Player.* 互相覆盖"。
   */
  if (!/name:\s*Aria\.Unified\./.test(unifiedYml)) {
    problems.push('electron-builder.unified.yml 的关联 ProgId 前缀应当是 Aria.Unified（关联要指向自己，不是 Aria Player）')
  }
}

/* 前两个产品的身份：棘轮。改它必须是显式决定，不能顺手漂移。 */
const identityRatchet = [
  ['electron-builder.yml', [
    ['appId: com.aria.player', 'appId'],
    ['productName: Aria', 'productName'],
    ['Aria-Setup-${version}', '安装包产物名']
  ]],
  ['electron-builder.player.yml', [
    ['appId: com.aria.player.lite', 'appId'],
    ['productName: Aria Player', 'productName'],
    ['main: src/main/main-player.js', '入口'],
    ['output: release-player', '输出目录'],
    ['Aria-Player-Setup-${version}', '安装包产物名']
  ]]
]
for (const [file, needles] of identityRatchet) {
  const full = path.join(root, file)
  if (!fs.existsSync(full)) { problems.push(`${file} 不见了 —— 前两个产品的身份配置不能丢`); continue }
  const text = fs.readFileSync(full, 'utf8')
  for (const [needle, what] of needles) {
    if (!text.includes(needle)) problems.push(`${file} 的${what}不再是「${needle}」—— 前两个产品的身份不许改`)
  }
}

/* 入口文件：只声明产品，**不预设档位**（否则 Unified 就永远是同一种模式了） */
const unifiedEntryPath = path.join(root, 'src', 'main', 'main-unified.js')
if (!fs.existsSync(unifiedEntryPath)) {
  problems.push('没有 src/main/main-unified.js')
} else {
  const entry = fs.readFileSync(unifiedEntryPath, 'utf8')
  if (!/ARIA_PRODUCT\s*=\s*'unified'/.test(entry)) problems.push("main-unified.js 必须设 ARIA_PRODUCT = 'unified'")
  if (/ARIA_PROFILE\s*=/.test(entry.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    problems.push('main-unified.js 不许预设 ARIA_PROFILE —— 档位必须由启动方式决定（点图标=full，带文件=player）')
  }
  if (!/require\('\.\/main'\)/.test(entry)) problems.push("main-unified.js 应当 require('./main')（共用实现，不 fork）")
}

/* 产品表与启动规则：Unified 必须有"产品×档位"目录模式，且档位不预设 */
const unifiedProduct = PRODUCTS.unified
if (!unifiedProduct) {
  problems.push('profile.js 的 PRODUCTS 里没有 unified')
} else {
  if (unifiedProduct.productName !== 'Aria Unified') problems.push('PRODUCTS.unified.productName 应当是 Aria Unified')
  if (unifiedProduct.appId !== 'com.aria.player.unified') problems.push('PRODUCTS.unified.appId 应当是 com.aria.player.unified')
  if (unifiedProduct.userDataMode !== 'product-profile') {
    problems.push('PRODUCTS.unified.userDataMode 必须是 product-profile —— 两种模式各有自己的 userData')
  }
  if (unifiedProduct.presetProfile) problems.push('PRODUCTS.unified 不许有 presetProfile（档位要靠启动方式决定）')
}
if (PRODUCTS.aria && PRODUCTS.aria.userDataMode !== 'default') {
  problems.push('PRODUCTS.aria.userDataMode 必须是 default —— 本体的资料库与缓存在原处，不许搬家')
}
if (PRODUCTS.player && PRODUCTS.player.presetProfile !== 'player') {
  problems.push('PRODUCTS.player.presetProfile 必须是 player —— Aria Player 只有一种模式')
}

/* 启动规则本身：喂几组 argv，看推出什么档位 */
{
  const unified = PRODUCTS.unified
  const rules = [
    [['app.exe'], 'full'],
    [['app.exe', '--profile=player'], 'player'],
    [['app.exe', '--profile=full'], 'full']
  ]
  for (const [argv, want] of rules) {
    const got = resolveProfileForCheck(argv, unified)
    if (got.id !== want) problems.push(`启动规则：argv [${argv.join(' ')}] 推出 ${got.id}，应为 ${want}`)
  }
  /* 带真实文件 → player；这里用一个仓库内一定存在的文件（profile.js 自己）改名成 .mp3 不现实，
   * 所以拿 package.json 之外的真实音频不保证存在 —— 交给自检在运行时用真文件验。
   * 纯静态能验的是"判定依据"字段存在：带文件时 reason 应当变成 argv-audio。 */
  const synthetic = resolveProfileForCheck(['app.exe', 'C:\\definitely-not-here\\x.mp3'], unified)
  if (synthetic.id !== 'full') problems.push('启动规则：不存在的文件不该把档位推成 player')
}

/* ---------- ⑪ 三个产品的身份必须两两不同（安装目录 / 开始菜单 / 卸载项不许撞） ---------- */
/*
 * 三套安装包共存的前提：appId、productName、开始菜单名、产物名前缀两两不同。
 * electron-builder 的 NSIS 用 productName 决定默认安装目录与开始菜单项、用 appId 决定卸载项，
 * 撞了就会出现"装第二个覆盖第一个"或"卸载项只剩一个"。这条纯静态就能验。
 */
{
  const identities = [
    ['electron-builder.yml', 'Aria 本体'],
    ['electron-builder.player.yml', 'Aria Player'],
    ['electron-builder.unified.yml', 'Aria Unified']
  ]
  .map(([file, label]) => {
    const full = path.join(root, file)
    if (!fs.existsSync(full)) return null
    const text = fs.readFileSync(full, 'utf8')
    return {
      label,
      appId: (/^appId:\s*(\S+)\s*$/m.exec(text) || [])[1] || '',
      productName: (/^productName:\s*(.+?)\s*$/m.exec(text) || [])[1] || '',
      shortcut: (/^\s{2}shortcutName:\s*(.+?)\s*$/m.exec(text) || [])[1] || '',
      output: (/^\s{2}output:\s*(\S+)\s*$/m.exec(text) || [])[1] || ''
    }
  })
  .filter(Boolean)

  if (identities.length !== 3) problems.push(`应当有 3 份产品打包配置，只找到 ${identities.length} 份`)
  for (const field of ['appId', 'productName', 'shortcut', 'output']) {
    const seen = new Map()
    for (const item of identities) {
      const value = item[field]
      if (!value) { problems.push(`${item.label} 的 ${field} 没读到`); continue }
      if (seen.has(value)) problems.push(`${item.label} 与 ${seen.get(value)} 的 ${field} 相同（「${value}」）—— 三个产品的安装身份不许撞`)
      else seen.set(value, item.label)
    }
  }
}

/*
 * 文件关联的 ProgId 必须是 **ASCII** 且形如 `<产品>.<扩展名>`。
 *
 * 为什么这条值得单列：`name:` 直接变成注册表键名（HKCU\Software\Classes\<ProgId>，
 * 以及 .<ext>\OpenWithProgids 下的值名）。写成「MP3 音频」这种中文时，键名会变得不可预测，
 * 资源管理器里的关联就不稳定 —— 这是真装一次才看出来的那类问题。
 * 顺带把 description（= 菜单里显示的名字）也钉住：Aria Player 的六项都必须是「Aria Player」。
 */
{
  const associationRules = [
    { file: 'electron-builder.player.yml', prefix: 'Aria.Player', description: 'Aria Player' },
    { file: 'electron-builder.unified.yml', prefix: 'Aria.Unified', description: null }
  ]
  for (const rule of associationRules) {
    const full = path.join(root, rule.file)
    if (!fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    const block = /fileAssociations:([\s\S]*?)(?:\r?\n[A-Za-z]|\r?\n# |$)/.exec(text)
    if (!block) { problems.push(`${rule.file} 里没有 fileAssociations 段`); continue }
    const pairs = [...block[1].matchAll(/- ext:\s*(\w+)\s*\r?\n\s*name:\s*(.+?)\s*\r?\n\s*description:\s*(.+?)\s*(?:\r?\n|$)/g)]
    if (pairs.length < 5) problems.push(`${rule.file} 的 fileAssociations 条目只解析出 ${pairs.length} 个`)
    for (const [, ext, name, description] of pairs) {
      if (!/^[\x20-\x7E]+$/.test(name)) {
        problems.push(`${rule.file}：${ext} 的 ProgId「${name}」不是 ASCII —— 注册表键名会不可预测`)
      }
      if (name !== `${rule.prefix}.${ext}`) {
        problems.push(`${rule.file}：${ext} 的 ProgId 应当是 ${rule.prefix}.${ext}，现在是「${name}」`)
      }
      if (!description) problems.push(`${rule.file}：${ext} 的 description（菜单显示名）不能为空`)
      if (rule.description && description !== rule.description) {
        problems.push(`${rule.file}：${ext} 的菜单显示名应当是「${rule.description}」，现在是「${description}」`)
      }
    }
  }
}

/* ---------- 报告 ---------- */
console.log(`档位检查：full 服务 ${full ? full.services.length : 0} 个 / 插件 ${full ? full.plugins.length : 0} 个；` +
  `player 服务 ${player ? player.services.length : 0} 个（${player ? player.services.join('、') : '—'}）/ 插件 ${player ? player.plugins.length : 0} 个；` +
  `视图键 ${viewKeys.length} 个；工厂 ${factories.size} 个`)
for (const problem of problems) console.log('  ✗ ' + problem)
if (!problems.length) console.log('  档位检查：0 问题')
process.exit(problems.length ? 1 : 0)
