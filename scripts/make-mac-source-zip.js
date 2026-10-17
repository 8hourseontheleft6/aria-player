'use strict'

/**
 * 打一个「源码包」zip：给没有 GitHub、也不想等 CI 的人用（例如朋友自己那台 Mac）。
 * 她解压后跑两条命令就能出自己的 dmg：`npm install` + `npm run dist:mac`。
 *
 *   node scripts/make-mac-source-zip.js
 *
 * 为什么是 Node 而不是 PowerShell：
 *   源码包解压后最外层会多一份「先读我.md」（内容是 docs/BUILDING-macOS.md 的副本），
 *   而 PowerShell 5.1 会把不带 BOM 的 .ps1 当 ANSI 读，脚本里一出现中文就解析失败
 *   （这个坑已经踩过三次）。Node 一律按 UTF-8 读源码，没这个问题。
 *   zip 本身交给系统自带的 bsdtar（Windows 10+ 的 tar.exe 支持 `-a` 按扩展名选格式）。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version

const stage = path.join(os.tmpdir(), `aria-mac-source-${version}`)
const outDir = path.join(root, 'release')
const zip = path.join(outDir, `aria-${version}-mac-source.zip`)

/* 只带「能在 Mac 上构建 + 能自己跑检查」所必需的东西；node_modules / release / 截图 / .git 一律不带 */
const ITEMS = [
  'src',
  'build/icon.png',
  /*
   * scripts 整个带上，而不是只挑两个文件：
   * package.json 里的 `npm run check` 会引用 scripts/checks/*.js，
   * 少一个文件对方那边一跑检查就报「找不到模块」——包里自带检查却缺文件，很怪。
   * 整个目录也就几百 KB。
   */
  'scripts',
  'package.json',
  'README.md',
  'docs/MACOS.md',
  'docs/BUILDING-macOS.md',
  '.github/workflows/build-mac.yml',
  '.gitattributes'
]

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
fs.mkdirSync(outDir, { recursive: true })

for (const item of ITEMS) {
  const from = path.join(root, item)
  if (!fs.existsSync(from)) {
    console.log(`  - 跳过（不存在）: ${item}`)
    continue
  }
  const to = path.join(stage, item)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
}

/* 说明放到压缩包最外层：解压第一眼就能看到 */
fs.copyFileSync(path.join(stage, 'docs/BUILDING-macOS.md'), path.join(stage, '先读我.md'))
fs.writeFileSync(path.join(stage, 'VERSION.txt'), [
  `Aria ${version} - macOS source package`,
  '',
  '先看「先读我.md」（中文）。快速开始（在一台 Mac 上）：',
  '    npm install',
  '    npm run dist:mac',
  `然后打开 release/Aria-${version}-arm64.dmg（Apple Silicon）或 -x64.dmg（Intel）。`
].join('\n'), 'utf8')

fs.rmSync(zip, { force: true })
execFileSync('tar', ['-a', '-c', '-f', zip, '-C', stage, '.'], { stdio: 'inherit' })
fs.rmSync(stage, { recursive: true, force: true })

const size = Math.round(fs.statSync(zip).size / 1024)
const crypto = require('node:crypto')
const hash = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
console.log(`已写出 ${path.relative(root, zip)}（${size} KB）`)
console.log(`sha256 ${hash}`)

/*
 * 旁车清单：记下"这个包是用哪一版源码打的"。
 *
 * 为什么需要：这个 zip 是**手动**生成的（每次改完代码要记得重打），
 * 于是它天生会过期 —— 而它正是要发给朋友的那个文件，过期的后果是
 * "她测的是几天前的代码"。这和那张停在六天前的截图是同一类问题：
 * 产物看起来没问题，但它与当前源码已经脱节。
 *
 * 树指纹只覆盖**输入项**（ITEMS 里的那些），不含生成物（先读我.md / VERSION.txt），
 * 这样检查脚本能一模一样地重算出来。另记 zip 自身的 sha256，替换/损坏也能发现。
 */
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

const manifest = {
  version,
  zip: path.basename(zip),
  zipSha256: hash,
  treeSha256: fingerprint(ITEMS),
  items: ITEMS,
  builtAt: new Date().toISOString()
}
const manifestPath = path.join(outDir, `aria-${version}-mac-source.manifest.json`)
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log(`已写出 ${path.relative(root, manifestPath)}（源码指纹 ${manifest.treeSha256.slice(0, 12)}…）`)
