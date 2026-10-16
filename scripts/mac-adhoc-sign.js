'use strict'

/**
 * electron-builder 的 afterPack 钩子：给 macOS 的 .app 打**ad-hoc 签名**（`codesign -s -`）。
 *
 * 为什么必须有这一步：
 *   Apple Silicon（arm64）上，**任何**可执行文件都至少要有一个（哪怕是 ad-hoc 的）签名才会被执行；
 *   完全没签名的 .app 打开时会报「已损坏，无法打开」，用户只能自己去终端 `xattr -cr` 才能跑起来。
 *   我们不做公证、也没有开发者证书，所以唯一能做的就是 ad-hoc 签名 —— 它不需要任何证书，
 *   只说明「这个 bundle 自打包之后没有被改过」，足以让 Gatekeeper 之外的 arm64 校验通过。
 *
 * 为什么放在 afterPack 而不是 afterSign：
 *   没有证书时 electron-builder 会跳过整个签名阶段，`afterSign` 根本不会触发；
 *   `afterPack` 在「拷完 .app」之后、**打进 dmg 之前**执行，正好是签名该在的位置。
 *
 * Windows / Linux 上直接跳过（codeSign 只在 macOS 上有意义）。
 */

const { execFileSync } = require('node:child_process')
const path = require('node:path')

module.exports = function afterPack (context) {
  /*
   * 非 darwin：**同步早退**，不返回 Promise。
   * 这样「在别的平台什么都不做」是可以被验证的性质（check-mac-config.js 会直接调用它看返回值），
   * 而不是只能靠读代码相信。真正要签名时才把 Promise 交出去。
   */
  if (context.electronPlatformName !== 'darwin') return undefined
  if (process.platform !== 'darwin') return undefined
  return signApp(context)
}

/** 只有 macOS 上才会走到这里 */
async function signApp (context) {
  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)

  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
    console.log(`  • ad-hoc 签名完成（arm64 上没这一步会报「已损坏」）：${appName}`)
  } catch (err) {
    /*
     * 签名失败不阻断出包：dmg 仍然可用，只是朋友那边可能需要先执行一次
     * `xattr -cr /Applications/Aria.app`（docs/MACOS.md 的第四节写了这条兜底）。
     */
    console.warn(`  • ad-hoc 签名失败（不阻断出包，改用 xattr -cr 兜底）：${err.message}`)
  }
}
