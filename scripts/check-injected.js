'use strict'

/** 开发用：把 smoke.js 里 executeJavaScript 的注入代码抽出来做语法检查。 */

const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'smoke.js'), 'utf8')
const marker = 'await evaluate(win, `'
let index = 0
let count = 0
let failed = 0
let skipped = 0

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
    console.log(`✗ 第 ${line} 行的注入代码有语法错误：${err.message}`)
    const lines = code.split('\n')
    lines.forEach((text, i) => console.log(`   ${String(i + 1).padStart(3)}| ${text}`))
  }
  index = end + 2
}

console.log(`\n共 ${count} 段注入代码，${failed} 段有语法错误，${skipped} 段含运行期插值已跳过`)
