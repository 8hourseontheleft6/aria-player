'use strict'

/**
 * 检查 docs/ARCHITECTURE.md 里的目录树与真实的 src/ 是否一致（双向）。
 *
 *   node scripts/checks/check-architecture.js
 *
 * 为什么需要：这张树是"东西在哪"的地图，而地图最容易与现实脱节 ——
 * 写完之后没人会再对着它一条条核。实测到的两处：
 *   · 树里写着 `services/online.js`（默认关闭），实际文件早已改名 `online-media.js`，而且默认是**开启**的；
 *   · `smoke.js 自检（145 项）` —— 现在已经是 195 项。
 * 前者尤其坏：照着地图去找那个文件的人会找不到。
 *
 * 两个方向都查：
 *   ① 树里画出来的路径必须真的存在（按缩进还原父子关系）；
 *      描述里写了"运行时生成 / 不入库"的允许不存在（例如 tests/）。
 *   ② `src/` 下的每个文件都必须在地图上出现（支持 `a.js / b.js` 这种合并写法）——
 *      这一条才抓得住"文件改名、地图没改"。
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const docPath = path.join(root, 'docs', 'ARCHITECTURE.md')
const lines = fs.readFileSync(docPath, 'utf8').split('\n')

/* ---------- 1. 解析目录树 ---------- */
const entries = []
let inFence = false
for (let index = 0; index < lines.length; index++) {
  const line = lines[index]
  if (line.trim().startsWith('```')) { inFence = !inFence; continue }
  if (!inFence) continue
  // 树行长这样：│   ├── services/        主进程能力…
  const match = /^([│\s]*)(?:├── |└── )(.+)$/.exec(line)
  if (!match) continue
  const indent = match[1].replace(/│/g, ' ').length
  const depth = Math.floor(indent / 4) // 每层 4 个字符
  /*
   * 名字与描述之间：文档里有时是两个以上空格、有时**只有一个空格**（实测两种混用）。
   * 所以先把"合并写法"里的 ` / ` 归一成 `/`，再按**第一个空格**切开 ——
   * 否则描述会被并进名字（第一版就是这么错的），而名字里的 `/` 是真实路径分隔符、
   * 不能当合并写法拆（`preload/preload.js` 被拆成两个名字就是这么来的）。
   */
  const body = match[2].replace(/\s+\/\s+/g, '/')
  const namePart = body.split(' ')[0]
  const rest = body.slice(namePart.length).trim()
  const names = namePart.split('/').map((n) => n.trim()).filter(Boolean)
  entries.push({ line: index + 1, depth, names, desc: rest })
}

/* ---------- 2. 复原每个条目在仓库里的相对路径 ---------- */
const stack = []
const resolved = []
for (const entry of entries) {
  stack.length = entry.depth
  stack[entry.depth] = entry.names
  const parents = stack.slice(0, entry.depth).flat().filter(Boolean)
  const parentPath = parents.join('/')
  /*
   * 名字里的 `/` 有两种含义，**先按"真实路径"整体试一次**：
   *   · `preload/preload.js` → 整体存在 → 就是一个文件（不拆）；
   *   · `media-url.js/format.js/dom.js/icons.js` → 整体不存在 → 才按合并写法拆成多个文件。
   * 第一版无条件拆，于是凭空造出 `src/preload.js` 这个不存在的路径并报错 ——
   * 检查自己造出来的错误比漏报更糟。
   */
  const joined = [...parents, ...entry.names].join('/')
  if (entry.names.length > 1 && fs.existsSync(path.join(root, joined))) {
    resolved.push({ line: entry.line, rel: joined, desc: entry.desc })
    continue
  }
  for (const name of entry.names) {
    resolved.push({ line: entry.line, rel: [parentPath, name].filter(Boolean).join('/'), desc: entry.desc })
  }
}

const runtime = /运行时生成|不入库/
const problems = []
const known = new Set()

for (const item of resolved) {
  // 树的第一层是 aria-player/ 本身，跳过
  if (item.rel === 'aria-player/') continue
  const rel = item.rel.replace(/^aria-player\//, '')
  known.add(rel.replace(/\/$/, ''))
  /*
   * 一个名字里带 `/` 有两种可能，两种都试：
   *   · `preload/preload.js` —— 真实路径分隔符（一个文件）；
   *   · `media-url.js/format.js/dom.js/icons.js` —— 合并写法（同一目录下的多个文件）。
   * 归一化之后两者长得一样，所以不猜，**任一解释成立就算通过**。
   */
  const candidates = [rel, [...rel.split('/').slice(0, -1), rel.split('/').pop()].join('/')]
  const parts = rel.split('/')
  const merged = parts.length > 1
    ? [parts.slice(0, -1).concat(parts[parts.length - 1]).join('/')]
    : []
  const all = new Set([...candidates, ...merged])
  if (item.names && item.names.length > 1) {
    const parent = parts.slice(0, parts.length - item.names.length).join('/')
    for (const name of item.names) all.add([parent, name].filter(Boolean).join('/'))
  }
  if ([...all].some((candidate) => fs.existsSync(path.join(root, candidate)))) continue
  if (runtime.test(item.desc)) continue
  problems.push(`第 ${item.line} 行画着 ${item.rel}，但仓库里没有这个路径 —— 地图与现实不符`)
}

/* ---------- 3. 反方向：src/ 下的文件是否都出现在地图上（**只提示，不判定**） ----------
 *
 * 为什么不判定：这张地图是**刻意按目录概括**的 —— 例如
 * `widgets/  可复用件：列表、歌词、封面格子、浮层、滑块…`，
 * 底下的 track-list.js / lyrics-view.js 等就不逐个列。第一版把"每个文件都要单独出现"
 * 当判据，于是产生 35 条误报 —— 一个满是误报的检查很快就会没人看。
 * 所以这里只打印一行提示（帮人发现"新加的目录整个忘了画"），成败由方向 ① 决定。
 */
const mapText = lines.join('\n')
const unlisted = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) { walk(full); continue }
    if (!mapText.includes(entry.name)) unlisted.push(path.relative(root, full).replace(/\\/g, '/'))
  }
}
walk(path.join(root, 'src'))

console.log(`结构树检查：从 ARCHITECTURE.md 解析出 ${resolved.length} 个路径，src/ 下 ${countSrc()} 个文件`)
if (unlisted.length) {
  console.log(`  · 提示（不算问题）：有 ${unlisted.length} 个文件没在地图上逐个列出 —— 地图按目录概括是允许的；` +
    `若整块新目录忘了画，这里会体现：${unlisted.slice(0, 6).join('、')}${unlisted.length > 6 ? ' 等' : ''}`)
}
for (const problem of problems) console.log('  ✗ ' + problem)
if (!problems.length) console.log('  结构树检查：0 问题')
process.exit(problems.length ? 1 : 0)

function countSrc () {
  let total = 0
  const step = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) step(full)
      else total++
    }
  }
  step(path.join(root, 'src'))
  return total
}
