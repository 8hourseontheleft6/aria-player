'use strict'

/**
 * 检查「毛玻璃是不是白烧的」。
 *
 *   node scripts/checks/check-frosted.js
 *
 * 依据是 DESIGN.md 里那条规则的本意：**玻璃后面必须有内容**，
 * 否则（背景完全不透明时）挂 backdrop-filter 只是让合成器白干一次，看不出任何差别。
 * 原文写成"毛玻璃只给三类表面：侧边栏、播放条、标题栏" —— 那句话是**过头**的：
 * 实测有 19 处用了毛玻璃（拖放浮层、帧率浮层、媒体墙上悬停出现的控件、正在播放页的背板…），
 * 全都是"玻璃盖在有内容的背景上"，都合理。规则的可判定形式是：
 *
 *   **同一规则块里出现 backdrop-filter 时，背景不许是完全不透明的颜色。**
 *
 * 为什么不并进 check-styles：那个检查是**逐行**看的，而"判断同一个块里的另一条声明"
 * 需要块级视角。这里用一个足够用的朴素分块器（本项目 CSS 一条声明一行）。
 * 判定"不透明"只认最保守的情形：裸十六进制/命名色，且不含 rgba / color-mix / var / 渐变。
 * 拿不准就算"不算不透明"—— 宁可漏报也不误报（满是误报的检查很快就会没人看）。
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const stylesDir = path.join(root, 'src', 'renderer', 'styles')

const problems = []
let frosted = 0
const surfaces = []

for (const file of fs.readdirSync(stylesDir).filter((name) => name.endsWith('.css'))) {
  const text = fs.readFileSync(path.join(stylesDir, file), 'utf8')
  // 朴素分块：选择器行（非空白开头）到下一个选择器行
  for (const block of text.split(/\n(?=\S[^\n]*\{)/)) {
    if (!block.includes('backdrop-filter')) continue
    const selector = block.split('{')[0].replace(/\s+/g, ' ').trim().slice(0, 64)
    const background = /background(?:-color)?\s*:\s*([^;]+);/.exec(block)
    const value = background ? background[1].trim() : ''
    frosted++
    surfaces.push(`${file} → ${selector}`)
    if (!value) continue // 没有背景 = 靠下面的内容透上来，正是毛玻璃该用的地方
    const translucent = /rgba\(|color-mix|transparent|gradient|var\(|hsla?\(/.test(value)
    if (translucent) continue
    problems.push(`${file} 的「${selector}」挂了 backdrop-filter，但背景是 ${value}（完全不透明）—— 这层毛玻璃看不出效果，只是白烧一次合成`)
  }
}

console.log(`毛玻璃检查：${frosted} 处用了 backdrop-filter`)
for (const surface of surfaces) console.log('  · ' + surface)
for (const problem of problems) console.log('  ✗ ' + problem)
if (!problems.length) console.log('  毛玻璃检查：0 问题（没有一处的背景是完全不透明的）')
process.exit(problems.length ? 1 : 0)
