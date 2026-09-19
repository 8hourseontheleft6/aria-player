'use strict'

/**
 * 开发用：守住设计语言的底线（详见 docs/DESIGN.md）。
 *
 * 检查三件事：
 *   1. border-radius 必须用 --radius-* 变量（0 和 50% 例外）；
 *   2. box-shadow 必须引用变量，或者是「细环 / 取色发光」这类刻意写法；
 *   3. var(--x) 引用的变量必须真的定义过 —— 令牌名字写错时静默失效是
 *      CSS 最坑的失败模式，这里直接报出来。
 *
 * 变量定义既可能来自 CSS（tokens.css 等），也可能来自 JS（运行期
 * setProperty 写入的动态色），两边都算。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const STYLES = path.join(ROOT, 'src', 'renderer', 'styles')

function walk (dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, ext, out)
    else if (full.endsWith(ext)) out.push(full)
  }
  return out
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/')

const cssFiles = walk(STYLES, '.css')
const jsFiles = walk(path.join(ROOT, 'src', 'renderer'), '.js')
const otherFiles = [path.join(ROOT, 'src', 'renderer', 'index.html')]

const problems = []

/* ---------------- 1. 收集已定义的变量 ---------------- */
const defined = new Set()
for (const file of [...cssFiles, ...jsFiles, ...otherFiles]) {
  if (!fs.existsSync(file)) continue
  const source = fs.readFileSync(file, 'utf8')
  for (const match of source.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(match[1])
  // 运行期写入：element.style.setProperty('--x', ...)
  for (const match of source.matchAll(/['"](--[a-zA-Z0-9-]+)['"]/g)) defined.add(match[1])
}

/* ---------------- 2. 逐文件检查规则 ---------------- */
// 刻意保留的写法：细环（0 0 0 …）与取色发光（color-mix / 变量拼出来的阴影）
const ringOrGlow = (value) => /^0 0 0\b/.test(value) || value.includes('color-mix(')

let checkedRadius = 0
let checkedShadow = 0

for (const file of cssFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    const at = `${rel(file)}:${index + 1}`

    const radius = line.match(/border-radius:\s*([^;]+);/)
    if (radius) {
      checkedRadius++
      const value = radius[1].trim()
      const ok = value === '0' || value === '50%' || value === 'inherit' || /^var\(--radius-/.test(value)
      if (!ok) problems.push(`${at}  border-radius 应该用 --radius-*：${value}`)
    }

    const shadow = line.match(/box-shadow:\s*([^;]+);/)
    if (shadow) {
      checkedShadow++
      const value = shadow[1].trim()
      const ok = value === 'none' ||
        value.startsWith('var(') ||
        value.includes('var(') ||
        ringOrGlow(value)
      if (!ok) problems.push(`${at}  box-shadow 应该引用令牌（或写成细环/发光）：${value}`)
    }

    for (const use of line.matchAll(/var\((--[a-zA-Z0-9-]+)/g)) {
      if (!defined.has(use[1])) problems.push(`${at}  变量未定义：${use[1]}`)
    }
  })
}

/* ---------------- 3. 亮暗两套必须成对 ---------------- */
// 令牌只在其中一个主题块里定义，是 CSS 最阴的一类 bug：另一个主题下
// var() 静默失效（transform: translateY(var(--x)) 直接变 none），
// 界面看起来"只是没动画"，查起来要命。
const tokensFile = path.join(STYLES, 'tokens.css')
if (fs.existsSync(tokensFile)) {
  const source = fs.readFileSync(tokensFile, 'utf8')
  const blockOf = (selector) => {
    const match = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(source)
    if (!match) return null
    return new Set([...match[1].matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]))
  }
  const rootBlock = blockOf(':root')
  const darkBlock = blockOf('html\\[data-theme="dark"\\]')
  const lightBlock = blockOf('html\\[data-theme="light"\\]')
  if (rootBlock && darkBlock && lightBlock) {
    for (const [name, block, other, otherName] of [
      ['深色', darkBlock, lightBlock, '浅色'],
      ['浅色', lightBlock, darkBlock, '深色']
    ]) {
      for (const property of block) {
        if (other.has(property) || rootBlock.has(property)) continue
        problems.push(`src/renderer/styles/tokens.css  ${property} 只在${name}主题里定义 —— ${otherName}主题下会静默失效（与主题无关的请放 :root）`)
      }
    }
    console.log(`主题成对检查：:root ${rootBlock.size} 个，深色 ${darkBlock.size} 个，浅色 ${lightBlock.size} 个`)
  } else {
    // 解析不到主题块说明规则本身失效了，必须报出来，不能静默跳过
    problems.push('src/renderer/styles/tokens.css  解析不到 :root / dark / light 主题块，主题成对检查未生效')
  }
}

/* ---------------- 4. 报告 ---------------- */
for (const problem of problems) console.log(problem)

console.log(
  `\n检查了 ${cssFiles.length} 个样式表：圆角 ${checkedRadius} 处、阴影 ${checkedShadow} 处，` +
  `已定义令牌 ${defined.size} 个，问题 ${problems.length} 处`
)

if (problems.length > 0) process.exit(1)
