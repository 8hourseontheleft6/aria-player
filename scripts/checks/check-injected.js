'use strict'

/**
 * 开发用：把注入到渲染层的代码抽出来做语法检查。
 *
 * 扫两份文件：smoke.js（自检）与 screenshot.js（出图）—— 两者都往页面里注入大段代码。
 *
 * ⚠️ 先做**整份文件的**语法检查，再抽取。
 * 原因（真踩过三次）：注入代码住在模板字符串里，注释或字符串里多一个反引号就会
 * 提前终止这个模板 —— 于是下面的"按反引号抽取"从错位处开始切，切出来的片段**反而是合法 JS**，
 * 工具照样报「0 段有语法错误」，看着一切正常，直到真正跑自检时 Electron 才抛
 * `missing ) after argument list`。所以文件解析不过就直接失败，不给任何"结论"。
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..', '..')
const files = ['src/main/smoke.js', 'src/main/screenshot.js']
const marker = 'await evaluate(win, `'

let parseFailed = 0
for (const rel of files) {
  const file = path.join(root, rel)
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    parseFailed++
    console.log(`✗ ${rel} 整份文件无法解析（注入代码里多半有游离的反引号或没配平的括号）：`)
    const detail = String(err.stderr || err.stdout || '').split('\n').filter(Boolean).slice(0, 8)
    for (const line of detail) console.log('   ' + line.trim())
  }
}

if (parseFailed) {
  console.log('\n文件本身解析不过，注入片段的检查给不出可信结论 —— 先修语法。')
  process.exit(1)
}

let count = 0
let failed = 0
let skipped = 0

for (const rel of files) {
  const source = fs.readFileSync(path.join(root, rel), 'utf8')
  let index = 0
  // eslint-disable-next-line no-cond-assign
  while ((index = source.indexOf(marker, index)) !== -1) {
    const start = index + marker.length
    // 找到匹配的反引号（注入代码里不应该出现未转义的反引号）
    const end = source.indexOf('`)', start)
    if (end === -1) break
    const code = source.slice(start, end)
    count++
    const line = source.slice(0, index).split('\n').length
    if (code.includes('${')) {
      // 这一段的模板是要在运行期插值的（例如 waitFor 拼接条件），跳过
      skipped++
      index = end + 2
      continue
    }
    try {
      // 与运行期一致：包成 async IIFE
      // eslint-disable-next-line no-new-func
      new Function(`return (async () => {${code}})`)
    } catch (err) {
      failed++
      console.log(`✗ ${rel} 第 ${line} 行的注入代码有语法错误：${err.message}`)
      const lines = code.split('\n')
      lines.forEach((text, i) => console.log(`   ${String(i + 1).padStart(3)}| ${text}`))
    }
    index = end + 2
  }
}

console.log(`\n共 ${count} 段注入代码，${failed} 段有语法错误，${skipped} 段含运行期插值已跳过`)
process.exit(failed ? 1 : 0)
