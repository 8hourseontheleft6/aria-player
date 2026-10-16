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

for (const problem of problems) console.log(problem)
console.log(
  `\n检查了 ${docs.length} 份文档：本地链接 ${checked} 条、脚本引用 ${scriptRefs} 处、` +
  `版本声明 ${versionClaims} 处，问题 ${problems.length} 处`
)
if (problems.length > 0) process.exit(1)
