'use strict'

/**
 * 开发用：守住设计语言的底线（详见 docs/DESIGN.md）。
 *
 * 检查四件事：
 *   1. border-radius 必须用 --radius-* 变量（0 和 50% 例外）；
 *   2. box-shadow 必须引用变量，或者是「细环 / 取色发光」这类刻意写法；
 *   3. var(--x) 引用的变量必须真的定义过 —— 令牌名字写错时静默失效是
 *      CSS 最坑的失败模式，这里直接报出来。
 *   4. 各视图的左右内边距必须是同一条基准（24px）—— 标题与内容差 4px 时
 *      说不出哪里不对，但整排看着就是歪的（见 DESIGN.md「左右基准线」）。
 *
 * 变量定义既可能来自 CSS（tokens.css 等），也可能来自 JS（运行期
 * setProperty 写入的动态色），两边都算。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
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

/* ---------------- 4. 左右基准线 ---------------- */
/*
 * 各视图的左边线要落在同一条竖线上：工具栏标题、封面网格、设置页内容、详情页头部。
 * 这条是踩出来的 —— 工具栏曾经 20px 而内容是 24px，标题比内容少缩进 4px，
 * 整排看着是歪的却说不出哪里不对（用户先察觉，代码里看不出来）。新增视图也应加进这张表。
 */
const BASELINE = [
  ['shell.css', '.view-toolbar'],
  ['browse.css', '.cover-grid'],
  ['browse.css', '.browse-detail'],
  ['settings.css', '.settings']
]

/**
 * 取某个选择器对应的所有声明体。
 * 故意不用正则匹配整块：选择器可能带缩进，而且 .settings__group / .browse-detail.is-collapsed
 * 这类「以它开头但不是它」的写法必须先排除，否则会取到别的规则、把正常写法误判成违规。
 */
function ruleBodies (source, selector) {
  const out = []
  let from = 0
  for (;;) {
    const at = source.indexOf(selector, from)
    if (at < 0) break
    from = at + selector.length
    const open = source.indexOf('{', from)
    if (open < 0) break
    if (!/^[\s,]*$/.test(source.slice(from, open))) continue
    const close = source.indexOf('}', open)
    if (close < 0) break
    out.push(source.slice(open + 1, close))
  }
  return out
}

/** 取声明体里的左右内边距（支持 padding: a / a b / a b c / a b c d） */
function horizontalPadding (body) {
  const short = /padding:\s*([^;]+);/.exec(body)
  if (!short) return null
  const parts = short[1].trim().split(/\s+/)
  const px = (token) => {
    const match = /^(\d+)px$/.exec(token || '')
    return match ? Number(match[1]) : null
  }
  if (parts.length <= 2) {
    const value = px(parts[parts.length - 1])
    return value === null ? null : { left: value, right: value }
  }
  const left = px(parts[1])
  const right = px(parts[3] === undefined ? parts[1] : parts[3])
  return left === null || right === null ? null : { left, right }
}

let checkedBaseline = 0
for (const [file, selector] of BASELINE) {
  const full = path.join(STYLES, file)
  if (!fs.existsSync(full)) {
    problems.push(`基准线检查：找不到 ${file}`)
    continue
  }
  const bodies = ruleBodies(fs.readFileSync(full, 'utf8'), selector)
  if (bodies.length === 0) {
    problems.push(`基准线检查：${file} 里找不到 ${selector} 规则`)
    continue
  }
  // 同一个选择器写多次时，只有最后一条带 padding 的生效
  let effective = null
  for (const body of bodies) {
    const pad = horizontalPadding(body)
    if (pad) effective = pad
  }
  if (!effective) {
    problems.push(`基准线检查：${file} 的 ${selector} 没写左右内边距，无法判断是否对齐`)
    continue
  }
  checkedBaseline++
  if (effective.left !== 24 || effective.right !== 24) {
    problems.push(
      `src/renderer/styles/${file}  ${selector} 的左右内边距应为 24px（与其他视图同一条左边线），` +
      `当前 左 ${effective.left}px / 右 ${effective.right}px`
    )
  }
}

/* ---------------- 5. 裸值守卫（棘轮：只减不增） ---------------- */
/*
 * 颜色 / 时长 / 字号本该全部来自 tokens.css —— 写裸值等于只把当前主题调好，
 * 另一个主题必然失配。但代码里确实存在一批**刻意**的裸值：画在封面/渐变上的白字、
 * 拖拽指示器的 `90ms linear`、9~10px 的小徽章。
 *
 * 一刀切会立刻产生几十处误报，然后这条规则就会被绕过 —— 那还不如没有。
 * 所以做成「棘轮」：只统计总量，**不增加**就通过。
 *   · 想减少：直接减，然后同步下面的基准；
 *   · 想新增：先想清楚是不是真没有对应令牌；确认必须新增时，
 *     同步基准并在提交信息里说明原因（例如「新的画在图片上的文字」）。
 * 这样它挡得住「悄悄多出第二种写法」，又不会因为历史存量而报假警。
 */
const NAKED_BASELINE = { color: 44, duration: 9, fontSize: 5 }

const naked = { color: 0, duration: 0, fontSize: 0 }
for (const file of cssFiles) {
  if (path.basename(file) === 'tokens.css') continue
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    if (line.trim().startsWith('/*') || line.trim().startsWith('*')) continue
    const hasVar = line.includes('var(--')
    if (!hasVar && (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\(/.test(line) || /\bhsla?\(/.test(line))) {
      naked.color++
    }
    if (/(transition|animation|duration)[^;]*\b\d+(\.\d+)?(ms|s)\b/.test(line)) naked.duration++
    if (/font-size:\s*\d+(\.\d+)?px/.test(line)) naked.fontSize++
  }
}

for (const kind of ['color', 'duration', 'fontSize']) {
  const now = naked[kind]
  const base = NAKED_BASELINE[kind]
  if (now > base) {
    problems.push(
      `裸值守卫：${kind} 从 ${base} 涨到 ${now} —— 新增的裸值应改用令牌` +
      `（颜色用 --label/--fill/--bg/--separator 等，时长用 --dur-*，字号用 --text-*）；` +
      '确属刻意（画在图片上的文字等）才同步 NAKED_BASELINE 并在提交信息里说明'
    )
  }
}

/* ---------------- 6. 缓动只走令牌 ---------------- */
/*
 * 缓动只用 --ease-ios（常规手感）与 --ease-out（弹出感）。唯一的例外是 linear：
 * 进度条、宽度指示器这类「匀速推进」的动画本来就该线性，写 ease 反而怪
 * （历史上那 4 处 linear 都在 width 过渡上，是刻意的）。
 * 所以这条允许 linear，但裸的 ease / ease-in / ease-out / ease-in-out /
 * cubic-bezier(...) 一律报出来 —— 目前 0 处，可以零容忍。
 */
let checkedEasing = 0
for (const file of cssFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    const text = line.trim()
    if (text.startsWith('*') || text.startsWith('/*')) return
    if (!/(transition|animation)\s*:/.test(line)) return
    // 先去掉 var(--ease-*) 这类合法引用再找裸值
    const rest = line.replace(/var\(--ease-[a-z-]+\)/g, '')
    const hit = /\b(ease|ease-in|ease-out|ease-in-out|cubic-bezier)\b/.exec(rest)
    if (!hit) return
    checkedEasing++
    problems.push(
      `${rel(file)}:${index + 1}  缓动应使用 --ease-ios / --ease-out（只有匀速动画才用 linear）：裸值 ${hit[1]}`
    )
  })
}

/* ---------------- 7. 内联样式里不许写颜色 ---------------- */
/*
 * JS 里给元素写 style 时若带颜色，就绕过了令牌和「亮暗成对」检查 ——
 * 另一个主题下必然失配，而且是这份检查看不见的地方。
 * 目前一处都没有，所以零容忍。
 */
for (const file of jsFiles) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, index) => {
    if (!/style:\s*\{/.test(line)) return
    if (!/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line)) return
    problems.push(
      `${rel(file)}:${index + 1}  内联样式里不要写颜色，改用令牌（--label / --fill / --bg / --separator 等）`
    )
  })
}

/* ---------------- 8. 卡片语言 ---------------- */
/*
 * 「卡片」是全应用同一种材料：设置页卡片与专辑/艺人详情头部必须引用同一组令牌。
 * 只要求**引用到令牌**，不限制具体数值 —— 半透明度按场景微调是允许的
 * （现在一处 86%、一处 52%）。规则见 DESIGN.md「材料与层次 → 卡片语言」。
 */
const CARDS = [
  ['settings.css', '.settings__card'],
  ['browse.css', '.browse-detail']
]
const CARD_TOKENS = ['var(--radius-xl)', 'var(--elev-1)', '--bg-window', 'var(--blur)']
let checkedCards = 0
for (const [file, selector] of CARDS) {
  const full = path.join(STYLES, file)
  if (!fs.existsSync(full)) {
    problems.push(`卡片语言检查：找不到 ${file}`)
    continue
  }
  const bodies = ruleBodies(fs.readFileSync(full, 'utf8'), selector)
  if (bodies.length === 0) {
    problems.push(`卡片语言检查：${file} 里找不到 ${selector} 规则`)
    continue
  }
  const effective = bodies[bodies.length - 1]
  checkedCards++
  for (const token of CARD_TOKENS) {
    if (!effective.includes(token)) {
      problems.push(
        `src/renderer/styles/${file}  ${selector} 作为卡片应引用 ${token}（见 DESIGN.md「卡片语言」）`
      )
    }
  }
}

/* ---------------- 9. 报告 ---------------- */
for (const problem of problems) console.log(problem)

console.log(
  `\n检查了 ${cssFiles.length} 个样式表：圆角 ${checkedRadius} 处、阴影 ${checkedShadow} 处，` +
  `基准线 ${checkedBaseline} 处、裸值 色${naked.color}/时${naked.duration}/字${naked.fontSize}` +
  `（上限 ${NAKED_BASELINE.color}/${NAKED_BASELINE.duration}/${NAKED_BASELINE.fontSize}）、` +
  `已定义令牌 ${defined.size} 个，问题 ${problems.length} 处`
)

if (problems.length > 0) process.exit(1)
