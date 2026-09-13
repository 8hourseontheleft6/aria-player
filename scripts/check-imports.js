'use strict'

/** 开发用：找出渲染层里未使用的 import，保持代码干净。 */

const fs = require('node:fs')
const path = require('node:path')

function walk (dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (full.endsWith('.js')) out.push(full)
  }
  return out
}

let total = 0
for (const file of walk(path.join(__dirname, '..', 'src', 'renderer'))) {
  const source = fs.readFileSync(file, 'utf8')
  const pattern = /import\s*\{([^}]+)\}\s*from/g
  let match
  while ((match = pattern.exec(source))) {
    const rest = source.slice(0, match.index) + source.slice(match.index + match[0].length)
    for (const raw of match[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim()
      if (!name) continue
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const uses = (rest.match(new RegExp(`\\b${escaped}\\b`, 'g')) || []).length
      if (uses === 0) {
        console.log(`${path.relative(process.cwd(), file)}  → 未使用: ${name}`)
        total++
      }
    }
  }
}
console.log(`\n共 ${total} 处未使用的导入`)
