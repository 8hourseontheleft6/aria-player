'use strict'

/**
 * 开发用：文档里的本地链接必须能解析（防文档腐烂）。
 *
 * 为什么可以零容忍：实测起点是 25 条本地链接、0 条失效。
 * 文档被移动/改名后，链接会静默变成死链 —— 这类错误没人会主动去点，所以交给脚本。
 * 只查仓库内的相对路径；http(s) 外链不查（离线无法验证）。
 * 文档自动发现：README.md + docs 下的所有 .md。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const DOC_DIR = path.join(ROOT, 'docs')

const docs = [
  path.join(ROOT, 'README.md'),
  ...fs.readdirSync(DOC_DIR).filter((name) => name.endsWith('.md')).map((name) => path.join(DOC_DIR, name))
].filter((file) => fs.existsSync(file))

const problems = []
let checked = 0

for (const file of docs) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/\]\(([^)#][^)]*)\)/g)) {
    const target = match[1].trim()
    if (/^https?:|^mailto:/i.test(target)) continue
    checked++
    const resolved = path.resolve(path.dirname(file), target.split('#')[0])
    if (!fs.existsSync(resolved)) problems.push(`${rel}  链接指向不存在的文件：${target}`)
  }
}

/* ---- 文档里提到的 npm run 脚本必须真的存在 ---- */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const scriptNames = new Set(Object.keys(pkg.scripts || {}))
let scriptRefs = 0
for (const file of docs) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    scriptRefs++
    if (!scriptNames.has(match[1])) {
      problems.push(`${rel}  文档里写的脚本不存在：npm run ${match[1]}`)
    }
  }
}

/* ---- 文档里"当前版本是 X"这类声明必须和 package.json 一致 ---- *
 *
 * 起因：README 第 7 行写着「版本见 `package.json`（当前 `0.1.0-beta.32`）」——
 * 而 package.json 已经是 0.1.0-beta.46，**落后 14 个版本**。
 * 这和"截图停在旧版本"是同一类问题：文档里的数字没人会主动去核对，只能交给脚本。
 *
 * 判据刻意收窄到**带"当前"字样的版本声明**：
 * 规范里引用历史提交信息（例如"反例：`chore(打包): 0.1.0-beta.42`"）是合法的，
 * 一刀切去比 package.json 会把那些真实的历史记录也判红。
 */
let versionClaims = 0
const currentVersion = pkg.version
for (const file of docs) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/当前[^`\n]{0,12}`(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)`/g)) {
    versionClaims++
    if (match[1] !== currentVersion) {
      problems.push(`${rel}  写着「当前 \`${match[1]}\`」，但 package.json 是 ${currentVersion} —— 版本声明已经脱节`)
    }
  }
}

/* ---- 文档里"还没有 X"这类**绝对式否定**，必须与现实一致 ---- *
 *
 * 起因：docs/PLATFORMS.md 的 macOS 一节把四件事记成"待验证 / 已知缺口"，
 * 实测**四条全都做完了**：electron-builder 配置在（dmg+zip、appId、hardenedRuntime、
 * afterPack 签名）、mediaSession 在写、系统媒体键已注册、省电两套逻辑都在。
 * 也就是说文档在告诉读者"Mac 构建路径还不存在"，而它已经完整就位。
 *
 * "还没有 X"是文档里最容易腐烂的一类句子：写完那一刻是真的，之后就没人回头看。
 * 所以这里把**能机械判定**的几条钉住：条件成立时，文档里就不许再出现那句否定。
 * 只收能明确判定的，不做模糊匹配 —— 满是误报的检查很快就会没人看。
 */
const srcText = (() => {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push(fs.readFileSync(full, 'utf8'))
    }
  }
  walk(path.join(ROOT, 'src'))
  return out.join('\n')
})()

const absenceClaims = [
  {
    phrase: '没有 electron-builder 配置',
    holds: Boolean(pkg.build && pkg.build.mac && pkg.build.mac.target),
    reality: 'package.json 里有 build.mac.target（dmg + zip）'
  },
  {
    phrase: '下一步在 `player-controller` 里随 `TRACK_CHANGED` 写 `mediaSession.metadata` 即可',
    holds: srcText.includes('mediaSession.setPositionState') || srcText.includes('mediaSession.metadata'),
    reality: 'player-controller.js 已经在写 navigator.mediaSession'
  }
]

let absenceChecked = 0
for (const file of docs) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const source = fs.readFileSync(file, 'utf8')
  for (const claim of absenceClaims) {
    if (!claim.holds) continue
    absenceChecked++
    if (source.includes(claim.phrase)) {
      problems.push(`${rel}  还写着「${claim.phrase}」，但现实是：${claim.reality} —— 绝对式否定已经过期`)
    }
  }
}

for (const problem of problems) console.log(problem)
console.log(
  `\n检查了 ${docs.length} 份文档：本地链接 ${checked} 条、脚本引用 ${scriptRefs} 处、` +
  `版本声明 ${versionClaims} 处、缺失声明 ${absenceChecked} 处，问题 ${problems.length} 处`
)
if (problems.length > 0) process.exit(1)
