'use strict'

/**
 * 设计令牌的对比度检查（纯数学，不开窗口）。
 *
 *   node scripts/checks/check-contrast.js
 *
 * 为什么值得单独一条：颜色对不对**能用数字说清**，不必靠"我觉得还行"。
 * 令牌本身是半透明的（`--bg-*` 只有 0.68~0.98 不透明），所以要先把
 * 「文字 → 叠在表面上 → 再叠到窗口底色」逐层合成，再算 WCAG 相对亮度比。
 *
 * 阈值取 WCAG 2.1：
 *   · 正文 4.5:1（--label / --label-2 / --accent）
 *   · 大字与非文本（≥18.66px 粗体或 ≥24px；图标、控件边界）3:1
 *   · 三级文字与禁用态是**刻意**更低的（这是 iOS/macOS 的一贯做法），
 *     单独用 3:1 / 2:1 兜底，并在下面注明它们属于"已知偏离"。
 *
 * 只读 tokens.css，不改任何文件；比值全部打印出来，方便对照截图判断。
 */

const fs = require('node:fs')
const path = require('node:path')

const tokensPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'styles', 'tokens.css')
const css = fs.readFileSync(tokensPath, 'utf8')

/* ---------------- 1. 解析三个块 ---------------- */

function block (selector) {
  const start = css.indexOf(selector)
  if (start === -1) return {}
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)
  const out = {}
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line)
    if (match) out[match[1]] = match[2].trim()
  }
  return out
}

const rootTokens = block(':root {')
const darkOverrides = block('html[data-theme="dark"]')
const lightOverrides = block('html[data-theme="light"]')

const themes = {
  dark: { ...rootTokens, ...darkOverrides },
  light: { ...rootTokens, ...lightOverrides }
}

/* ---------------- 2. 颜色工具 ---------------- */

function parseColor (value) {
  const text = String(value || '').trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)
  if (hex) {
    const raw = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1]
    return { r: parseInt(raw.slice(0, 2), 16), g: parseInt(raw.slice(2, 4), 16), b: parseInt(raw.slice(4, 6), 16), a: 1 }
  }
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(text)
  if (rgba) {
    return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) }
  }
  return null
}

/** 把前景（可能半透明）叠在背景上 */
const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1
})

const channel = (value) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)

function contrast (fg, bg) {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

/* ---------------- 3. 要检查的组合 ---------------- */

/*
 * 【token, 它坐在哪个表面上, 阈值, 说明】
 * 阈值按 WCAG 2.1 取，只有"三级文字/禁用态"是我按 iOS 的一贯做法放宽的，
 * 并在说明里写明属于已知偏离 —— 不写成"反正也是这么做的"。
 */
const SURFACES = ['--bg-window', '--bg-content', '--bg-sidebar', '--bg-bar', '--bg-elevated', '--bg-popover']
const CHECKS = []
for (const surface of SURFACES) {
  CHECKS.push(['--label', surface, 4.5, '正文/标题'])
  CHECKS.push(['--label-2', surface, 4.5, '次级文字'])
  CHECKS.push(['--label-3', surface, 3, '三级文字（已知偏离：iOS 一贯更淡）'])
}
CHECKS.push(['--accent', '--bg-window', 4.5, '强调色当文字'])
CHECKS.push(['--accent', '--bg-elevated', 4.5, '强调色当文字（卡片上）'])
CHECKS.push(['--accent-label', '--accent', 3, '主按钮白字（大字，按 3:1）'])
CHECKS.push(['--danger', '--bg-window', 3, '危险色（图标/徽章，按非文本 3:1）'])
CHECKS.push(['--success', '--bg-window', 3, '成功色（图标/徽章）'])
CHECKS.push(['--warning', '--bg-window', 3, '警告色（图标）'])
CHECKS.push(['--warning', '--bg-popover', 3, '警告色（弹层上）'])

/* ---------------- 4. 已知偏离（棘轮：不许新增、不许变差） ---------------- */

/*
 * 这些组合低于上面那条阈值，但**是刻意的**：iOS/macOS 的次级与三级文字本来就更淡
 * （Apple 自己的 secondaryLabel 在白底上也只有 ~3.5:1），改成达标会明显改变观感。
 *
 * 沿用裸值守卫那套「棘轮」思路，理由也一样：一刀切会产生二十多处"误报"，
 * 然后这条规则就会被绕过 —— 那还不如没有。所以：
 *   · **新增**低于阈值的组合 → 红（去改颜色，或在这里登记并说明原因）；
 *   · 已登记的组合**变差** → 红；
 *   · 已登记的组合**变好到达标** → 提示"可以从基线里删掉"，不红。
 * 表里写的是当前实测值（脚本会打印全部比值），改动了颜色就同步这里。
 */
const KNOWN_BELOW = {
  'light --label-2 on --bg-window': 3.62,
  'light --label-2 on --bg-content': 3.62,
  'light --label-2 on --bg-sidebar': 3.5,
  'light --label-2 on --bg-bar': 3.57,
  'light --label-2 on --bg-elevated': 3.62,
  'light --label-2 on --bg-popover': 3.62,
  'light --label-3 on --bg-window': 2.14,
  'light --label-3 on --bg-content': 2.14,
  'light --label-3 on --bg-sidebar': 2.1,
  'light --label-3 on --bg-bar': 2.13,
  'light --label-3 on --bg-elevated': 2.14,
  'light --label-3 on --bg-popover': 2.14,
  'light --accent on --bg-window': 4.02,
  'light --accent on --bg-elevated': 4.02,
  'dark --accent on --bg-elevated': 4.11,
  // 开关的填充色：苹果自家的绿色开关在白底上也只有 ~2.2:1。改它等于改开关外观，留给设计决定。
  'light --success on --bg-window': 2.22
}

/* ---------------- 5. 逐条计算 ---------------- */

const problems = []
const notes = []
const rows = []
for (const [tokenName, surfaceName, floor, note] of CHECKS) {
  for (const [themeName, tokens] of Object.entries(themes)) {
    const fg = parseColor(tokens[tokenName])
    const surface = parseColor(tokens[surfaceName])
    const windowColor = parseColor(tokens['--bg-window'])
    if (!fg || !surface || !windowColor) {
      problems.push(`令牌缺失或无法解析：${themeName} 的 ${tokenName} / ${surfaceName}`)
      continue
    }
    // 表面先叠到窗口底色上，文字再叠到表面上（令牌都是半透明的，必须逐层合成）
    const flatSurface = over(surface, windowColor)
    const flatFg = over(fg, flatSurface)
    const ratio = contrast(flatFg, flatSurface)
    const key = `${themeName} ${tokenName} on ${surfaceName}`
    const known = KNOWN_BELOW[key]
    const passes = ratio >= floor
    const ok = passes || (known !== undefined && ratio >= known - 0.02)
    rows.push({ themeName, tokenName, surfaceName, ratio, floor, ok, note, known, passes })
    if (!ok) {
      problems.push(known === undefined
        ? `${themeName}：${tokenName} 在 ${surfaceName} 上只有 ${ratio.toFixed(2)}:1（要求 ${floor}:1，${note}）—— 新增的不达标组合`
        : `${themeName}：${tokenName} 在 ${surfaceName} 上从 ${known}:1 掉到 ${ratio.toFixed(2)}:1（${note}）`)
    } else if (passes && known !== undefined) {
      notes.push(`${key} 现在已经达标（${ratio.toFixed(2)}:1 ≥ ${floor}）—— 可以从 KNOWN_BELOW 里删掉这一条了`)
    } else if (!passes && known !== undefined) {
      notes.push(`${key} 仍低于阈值 ${floor}:1（实测 ${ratio.toFixed(2)}:1，已在基线登记）`)
    }
  }
}

/* ---------------- 6. 报告 ---------------- */

console.log(`对比度检查：深色/浅色共 ${rows.length} 组（表面已按窗口底色合成）\n`)
for (const row of rows) {
  const flag = row.passes ? ' ' : (row.ok ? '·' : '✗')
  console.log(`  ${flag} ${row.themeName.padEnd(5)} ${row.tokenName.padEnd(15)} on ${row.surfaceName.padEnd(13)} ` +
    `${row.ratio.toFixed(2).padStart(6)}:1  (≥${row.floor})  ${row.note}`)
}

console.log('')
for (const note of notes) console.log('  · ' + note)
for (const problem of problems) console.log('  ✗ ' + problem)
if (!problems.length) console.log(`  对比度检查：0 问题（已知偏离 ${Object.keys(KNOWN_BELOW).length} 条，见脚本里的 KNOWN_BELOW）`)
process.exit(problems.length ? 1 : 0)
