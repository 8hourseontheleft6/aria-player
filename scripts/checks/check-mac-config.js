'use strict'

/**
 * 守住 macOS 打包配置。
 *
 *   node scripts/checks/check-mac-config.js
 *
 * 为什么值得单独一条：macOS 的包我们**没法在本机产出**（electron-builder 明确拒绝在非 macOS 上打 mac 目标），
 * 所以每一次「配置写错」的代价都是：推一次 CI 白等十几分钟，或者让朋友在她机器上白折腾半小时。
 * 这些都是纯静态就能查出来的东西 —— 那就让机器查。
 *
 * 查什么：
 *   1. 图标存在、是 PNG、且**至少 512×512**（electron-builder 生成 icns 的硬性要求）
 *   2. 不签名三件套：identity null / hardenedRuntime false / gatekeeperAssess false
 *   3. afterPack 指向的钩子文件真的存在，而且**在非 darwin 平台什么都不做**（直接调用验证）
 *   4. mac 目标同时给 dmg 与 zip，且两个架构（arm64 / x64）都在
 *   5. dmg 里有 /Applications 快捷方式（朋友拖进去才能装）
 *   6. 成品里不该带开发脚本（smoke / screenshot / perf / visual-audit）
 *   7. CI 工作流与本机配置一致：都在打 mac、都上传 dmg + zip
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const problems = []
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const build = pkg.build || {}

/* ---------- 1. 图标 ---------- */
const iconPath = path.join(ROOT, 'build', 'icon.png')
if (!fs.existsSync(iconPath)) {
  problems.push('找不到 build/icon.png —— mac 包会用 Electron 默认图标（而且 electron-builder 可能直接报错）')
} else {
  const buf = fs.readFileSync(iconPath)
  const isPng = buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  if (!isPng) {
    problems.push('build/icon.png 不是 PNG（electron-builder 需要 PNG 来生成 icns/ico）')
  } else {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width < 512 || height < 512) {
      problems.push(`build/icon.png 只有 ${width}×${height} —— macOS 的 icns 要求至少 512×512`)
    }
  }
}

/* ---------- 2. 不签名三件套 ---------- */
const mac = build.mac || {}
if (mac.identity !== null) problems.push('build.mac.identity 不是 null —— 没有证书时会让签名阶段报错（我们要的是「不签名」）')
if (mac.hardenedRuntime !== false) problems.push('build.mac.hardenedRuntime 不是 false —— 加固运行时要求签名与 entitlements')
if (mac.gatekeeperAssess !== false) problems.push('build.mac.gatekeeperAssess 不是 false —— 不签名的包不需要 Gatekeeper 评估')

/* ---------- 3. afterPack 钩子存在，且非 darwin 空转 ---------- */
if (!build.afterPack) {
  problems.push('build.afterPack 没配 —— Apple Silicon 上没签名的 .app 打开会报「已损坏」')
} else {
  const hookPath = path.join(ROOT, build.afterPack)
  if (!fs.existsSync(hookPath)) {
    problems.push(`build.afterPack 指向的 ${build.afterPack} 不存在`)
  } else {
    try {
      const hook = require(hookPath)
      const result = hook({ electronPlatformName: 'win32', appOutDir: ROOT, packager: { appInfo: { productFilename: 'Aria' } } })
      // 非 darwin 必须是同步返回（不 await、不调 codesign）
      if (result && typeof result.then === 'function') {
        problems.push('afterPack 钩子在非 darwin 平台返回了 Promise —— 应该在打包前就早退（不碰 codesign）')
      }
    } catch (err) {
      problems.push(`afterPack 钩子在非 darwin 平台抛错了：${err.message}`)
    }
  }
}

/* ---------- 4. 目标与架构 ---------- */
const targets = Array.isArray(mac.target) ? mac.target : []
const kinds = new Set(targets.map((t) => (typeof t === 'string' ? t : t && t.target)))
const arches = new Set()
for (const t of targets) for (const arch of (t && t.arch) || []) arches.add(arch)
for (const kind of ['dmg', 'zip']) {
  if (!kinds.has(kind)) problems.push(`build.mac.target 里没有 ${kind}（dmg 给朋友装，zip 是 dmg 打不开时的备选）`)
}
for (const arch of ['arm64', 'x64']) {
  if (!arches.has(arch)) problems.push(`build.mac.target 里没有 ${arch} 架构（Apple Silicon 与 Intel 都要能跑）`)
}

/* ---------- 5. dmg 里的 Applications 快捷方式 ---------- */
const contents = (build.dmg && build.dmg.contents) || []
const hasApplicationsLink = contents.some((item) => item && item.type === 'link' && item.path === '/Applications')
if (!hasApplicationsLink) problems.push('build.dmg.contents 里没有指向 /Applications 的快捷方式 —— 朋友拖不进应用程序')

/* ---------- 6. 成品不该带开发脚本 ---------- */
const files = build.files || []
for (const devOnly of ['smoke.js', 'screenshot.js', 'perf.js', 'visual-audit.js']) {
  if (!files.some((rule) => rule.includes(devOnly))) {
    problems.push(`build.files 没有排除 src/main/${devOnly} —— 开发自检脚本会进成品`)
  }
}

/* ---------- 7. CI 与本机配置一致 ---------- */
const workflowPath = path.join(ROOT, '.github', 'workflows', 'build-mac.yml')
if (!fs.existsSync(workflowPath)) {
  problems.push('没有 .github/workflows/build-mac.yml —— 没有 Mac 时唯一的出包路径就断了')
} else {
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  if (!/electron-builder\s+--mac/.test(workflow)) problems.push('CI 工作流里没有 `electron-builder --mac`')
  if (!/release\/\*\.dmg/.test(workflow)) problems.push('CI 工作流没有上传 dmg 产物')
  if (!/release\/\*\.zip/.test(workflow)) problems.push('CI 工作流没有上传 zip 产物')
  if (!/CSC_IDENTITY_AUTO_DISCOVERY/.test(workflow)) problems.push('CI 工作流没设 CSC_IDENTITY_AUTO_DISCOVERY —— 没有证书时会尝试自动找证书')
}

/* ---------- 报告 ---------- */
console.log(`macOS 打包配置检查：图标 ${fs.existsSync(iconPath) ? '有' : '缺'}、` +
  `目标 ${[...kinds].join('+') || '（无）'}、架构 ${[...arches].join('+') || '（无）'}、` +
  `不签名=${mac.identity === null && mac.hardenedRuntime === false}`)
for (const problem of problems) console.log('  ✗ ' + problem)
if (problems.length === 0) console.log('  配置检查：0 问题')
process.exit(problems.length ? 1 : 0)
