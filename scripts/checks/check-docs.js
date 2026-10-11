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

for (const problem of problems) console.log(problem)
console.log(`\n检查了 ${docs.length} 份文档：本地链接 ${checked} 条、脚本引用 ${scriptRefs} 处，问题 ${problems.length} 处`)
if (problems.length > 0) process.exit(1)
