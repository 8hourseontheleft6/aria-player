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

/*
 * 打包配置的位置变了：从 package.json 的 build 段搬到 electron-builder*.yml
 * （两个产品共用一份基座，避免两处配置各自漂移）。这条检查于是"读不到配置"报了一串红 ——
 * 它没错，是位置变了，所以这里跟着改。
 *
 * 用**文本判定**而不是 yaml 解析：本项目没有 yaml 依赖，而这里的每一条判据
 * （identity / hardenedRuntime / gatekeeperAssess / afterPack / mac 的 target 与 arch /
 * dmg 里的 /Applications 链接 / files 的排除项）都是"配置里有没有这样一行"。
 * 三个文件拼在一起看 —— 谁覆盖谁对这几条没有影响（这些只写在基座里）。
 */
const builderYml = ['electron-builder.base.yml', 'electron-builder.yml', 'electron-builder.player.yml']
  .map((name) => {
    const full = path.join(ROOT, name)
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : ''
  })
  .join('\n')
const build = {
  afterPack: (/^\s*afterPack:\s*(\S+)\s*$/m.exec(builderYml) || [])[1],
  hasIdentityNull: /^\s*identity:\s*null\s*$/m.test(builderYml),
  hasHardenedRuntimeFalse: /^\s*hardenedRuntime:\s*false\s*$/m.test(builderYml),
  hasGatekeeperAssessFalse: /^\s*gatekeeperAssess:\s*false\s*$/m.test(builderYml)
}

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
if (!build.hasIdentityNull) problems.push('mac.identity 不是 null —— 没有证书时会让签名阶段报错（我们要的是「不签名」）')
if (!build.hasHardenedRuntimeFalse) problems.push('mac.hardenedRuntime 不是 false —— 加固运行时要求签名与 entitlements')
if (!build.hasGatekeeperAssessFalse) problems.push('mac.gatekeeperAssess 不是 false —— 不签名的包不需要 Gatekeeper 评估')

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
/* yml 里 mac.target 是嵌套列表：`- target: dmg` + 下一行 `arch: [arm64, x64]`。
 * 只取"出现过的 target 名"与"出现过的架构"，判据与原来一致（dmg 与 zip 都要有、两个架构都要有）。 */
const kinds = new Set([...builderYml.matchAll(/-\s*target:\s*([a-zA-Z]+)/g)].map((m) => m[1]))
const arches = new Set()
for (const match of builderYml.matchAll(/arch:\s*\[([^\]]+)\]/g)) {
  for (const arch of match[1].split(',')) arches.add(arch.trim())
}
for (const kind of ['dmg', 'zip']) {
  if (!kinds.has(kind)) problems.push(`mac.target 里没有 ${kind}（dmg 给朋友装，zip 是 dmg 打不开时的备选）`)
}
for (const arch of ['arm64', 'x64']) {
  if (!arches.has(arch)) problems.push(`mac.target 里没有 ${arch} 架构（Apple Silicon 与 Intel 都要能跑）`)
}

/* ---------- 5. dmg 里的 Applications 快捷方式 ---------- */
const hasApplicationsLink = /^\s*path:\s*\/Applications\s*$/m.test(builderYml)
if (!hasApplicationsLink) problems.push('dmg.contents 里没有指向 /Applications 的快捷方式 —— 朋友拖不进应用程序')

/* ---------- 6. 成品不该带开发脚本 ---------- */
for (const devOnly of ['smoke.js', 'screenshot.js', 'perf.js', 'visual-audit.js']) {
  // 基座里以 `- '!src/main/smoke.js'` 这种排除项出现
  if (!builderYml.includes(devOnly)) {
    problems.push(`files 没有排除 src/main/${devOnly} —— 开发自检脚本会进成品`)
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

/* ---------- 8. 出包脚本本身 ---------- */
/*
 * 朋友（或 CI）按下的是这两条命令，写错一个字就会白等一场。
 * 文档里提到 `npm run dist:mac:arm64` 时，check-docs 也会核对它存在（两条检查互为呼应）。
 */
const scripts = pkg.scripts || {}
const distMac = scripts['dist:mac'] || ''
const distMacArm = scripts['dist:mac:arm64'] || ''
if (!distMac.includes('--mac')) problems.push('npm run dist:mac 没有 `--mac`（会去打 Windows 包）')
if (!distMacArm.includes('--mac') || !distMacArm.includes('--arm64')) {
  problems.push('npm run dist:mac:arm64 应该同时带 `--mac` 与 `--arm64`（给 Apple Silicon 的快速出包路径）')
}

/* ---------- 报告 ---------- */
console.log(`macOS 打包配置检查（读 electron-builder*.yml）：图标 ${fs.existsSync(iconPath) ? '有' : '缺'}、` +
  `目标 ${[...kinds].join('+') || '（无）'}、架构 ${[...arches].join('+') || '（无）'}、` +
  `不签名=${build.hasIdentityNull && build.hasHardenedRuntimeFalse}`)
for (const problem of problems) console.log('  ✗ ' + problem)
if (problems.length === 0) console.log('  配置检查：0 问题')
process.exit(problems.length ? 1 : 0)
