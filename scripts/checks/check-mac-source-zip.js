'use strict'

/**
 * 检查「mac 源码包」是不是**用当前源码**打的。
 *
 *   node scripts/checks/check-mac-source-zip.js
 *
 * 为什么需要：这个 zip 是手动生成的（改完代码要记得重打），而它正是要发给朋友的文件 ——
 * 过期的后果是"她测的是几天前的代码"。这和那张停在六天前的深色截图是同一类问题：
 * 产物看起来完全正常，但与当前源码已经脱节，而且没有任何检查会发现。
 *
 * 依据是打包时写下的旁车清单（release/aria-<版本>-mac-source.manifest.json）：
 *   · zip 名字里的版本必须等于 package.json 的版本；
 *   · zip 自身的 sha256 必须与清单一致（替换/损坏也能发现）；
 *   · 当前源码重算出的树指纹必须与清单一致 —— 这条就是"有没有过期"。
 * 没打过包（没有清单）时**跳过并说明**，不让新克隆的仓库因此变红。
 *
 * `release/` 在 .gitignore 里，所以这条只在本机有意义 —— 而 zip 也只在本机存在。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const root = path.join(__dirname, '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const manifestPath = path.join(root, 'release', `aria-${version}-mac-source.manifest.json`)

const problems = []

if (!fs.existsSync(manifestPath)) {
  console.log(`mac 源码包检查：本机还没有 ${version} 的包（release/ 里没有清单），跳过`)
  console.log('  打完包就会在这里校验"包与当前源码是否一致"：node scripts/make-mac-source-zip.js')
  process.exit(0)
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const zipPath = path.join(root, 'release', manifest.zip || '')

/* ① 名字里的版本对不对 */
if (manifest.version !== version) {
  problems.push(`清单记的版本是 ${manifest.version}，package.json 已经是 ${version} —— 包与代码不同版`)
}
if (!String(manifest.zip || '').includes(version)) {
  problems.push(`zip 名字「${manifest.zip}」里没有当前版本 ${version}`)
}

/* ② zip 还在、且内容没被动过 */
if (!fs.existsSync(zipPath)) {
  problems.push(`清单在，但 zip 不在了：release/${manifest.zip}`)
} else {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
  if (digest !== manifest.zipSha256) {
    problems.push(`zip 的 sha256 与清单不一致（被替换或损坏？）清单 ${manifest.zipSha256.slice(0, 12)}… 实际 ${digest.slice(0, 12)}…`)
  }
}

/* ③ 关键的一条：当前源码重算指纹，和打包时是否一致 */
const fingerprint = (items) => {
  const lines = []
  const walk = (rel) => {
    const full = path.join(root, rel)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) walk(path.join(rel, name))
      return
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    lines.push(`${rel.replace(/\\/g, '/')}  ${digest}`)
  }
  for (const item of items.slice().sort()) if (fs.existsSync(path.join(root, item))) walk(item)
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex')
}

const now = fingerprint(manifest.items || [])
if (now !== manifest.treeSha256) {
  problems.push(
    `源码已经变了，但包还是打包时那份（指纹 ${manifest.treeSha256.slice(0, 12)}… → 现在 ${now.slice(0, 12)}…）` +
    ' —— 重打一次：node scripts/make-mac-source-zip.js'
  )
}

console.log(
  `mac 源码包检查：${manifest.zip}（版本 ${manifest.version}，源码指纹 ${manifest.treeSha256.slice(0, 12)}…，` +
  // 清单里存的是 UTC（toISOString），这里按**本地时间**显示 —— 否则会差 8 小时，看着像"半夜打的包"
  `打包于 ${String(manifest.builtAt || '').slice(0, 16).replace('T', ' ')} UTC）`
)
for (const problem of problems) console.log('  ✗ ' + problem)
if (!problems.length) console.log('  包与当前源码一致')
process.exit(problems.length ? 1 : 0)
