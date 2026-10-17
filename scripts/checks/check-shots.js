'use strict'

/**
 * 出图清单一致性检查。
 *
 * 起因（真丢了一小时）：README 的深色表格引用的 `08-library-dark.png` 曾经从出图清单里
 * 被删掉，但**文件还在**、README 也还引用着它 —— 于是那张图永远停在旧版本，
 * 而它看起来和新生成的一样可信。我拿它当"当前深色渲染"排查了很久，方向全错。
 *
 * 所以立两条规矩（都不需要跑 Electron，纯静态）：
 *   ① 文档里引用的每一张图，都必须在出图清单里（否则它永远不会被重新生成）；
 *   ② `docs/screenshots/` 里的每一张图，都必须要么在清单里、要么在白名单里
 *      （清单删了条目、文件却留着 —— 正是上面那个坑）。
 *
 * 白名单只有一个：用户自己放进去的批注截图（不是产物，不能被工具覆盖）。
 */

const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..', '..')
const shotsSource = fs.readFileSync(path.join(root, 'src', 'main', 'screenshot.js'), 'utf8')

/* 白名单：不是出图产物、但允许留在目录里的文件（逐条写清为什么） */
const WHITELIST = new Set([
  /*
   * 目前为空。
   *
   * 曾经有一条：用户随手留下的批注截图，文件名本身就是批注内容
   * （「…中间有一个很明显的条，改一下.png」）。开源前把那张图删掉了 ——
   * 它是当时的临时反馈，图里的问题（内容区顶部那条横条）早已修掉，
   * 根因与修法留在 docs/CONVENTIONS.md。
   * 以后若又收到同类批注图，按这个格式加回白名单并在旁边写清来由。
   */
])

/* ① 字面定义的截图名：[ '01-library.png', '说明', ... ] */
const literals = [...shotsSource.matchAll(/\['(\d\d[^']*\.png)'/g)].map((match) => match[1])

/*
 * ② 模板生成的截图名。
 *
 * 一个模板字符串会**展开成多张图**（`${24 + index}-visualizer-${style}.png` 展开成 3 张），
 * 所以不能拿"模式个数"跟"名字个数"比 —— 那是错的（第一版就这么错了一次）。
 * 这里维护一张「模式 → 展开出的名字」对照表，然后双向校验：
 *   · 源码里出现的每个模板模式都必须在表里（新增模板截图时会红，提醒补表）；
 *   · 表里的每个模式都必须在源码里还找得到（模板被删/改了要同步，别留下过期的名字）。
 */
const TEMPLATE_TABLE = [
  {
    pattern: '`${24 + index}-visualizer-${style}.png`',
    names: ['24-visualizer-bars.png', '25-visualizer-wave.png', '26-visualizer-ring.png']
  }
]
const templatePatterns = [...shotsSource.matchAll(/`\$\{[^`\n]*\}[^`\n]*\.png`/g)].map((match) => match[0])

const produced = new Map()
for (const name of literals) produced.set(name, '字面定义')
for (const entry of TEMPLATE_TABLE) for (const name of entry.names) produced.set(name, '模板生成')

const problems = []

for (const found of templatePatterns) {
  if (!TEMPLATE_TABLE.some((entry) => entry.pattern === found)) {
    problems.push(
      `源码里有模板截图名 ${found} 没登记在 check-shots.js 的 TEMPLATE_TABLE 里 —— ` +
      '补上它展开出的文件名，否则"文档引用的图在不在清单里"判不准'
    )
  }
}
for (const entry of TEMPLATE_TABLE) {
  if (!templatePatterns.includes(entry.pattern)) {
    problems.push(`TEMPLATE_TABLE 里的 ${entry.pattern} 在源码里已经找不到了 —— 模板改了或删了，请同步这张表`)
  }
}

/* ③ 文档引用的图都必须在清单里 */
const docFiles = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (entry.name.endsWith('.md')) docFiles.push(full)
  }
}
walk(root)
for (const doc of docFiles) {
  const text = fs.readFileSync(doc, 'utf8')
  for (const match of text.matchAll(/(?:docs\/screenshots\/|screenshots\/)([^)"'\s]+?\.png)/g)) {
    const name = decodeURIComponent(match[1])
    if (produced.has(name)) continue
    if (WHITELIST.has(name)) continue
    problems.push(`${path.relative(root, doc)} 引用了 ${name}，但它不在出图清单里 —— 这张图永远不会被重新生成，会停在旧版本`)
  }
}

/* ④ 目录里的图都必须有出处 */
const shotsDir = path.join(root, 'docs', 'screenshots')
for (const entry of fs.readdirSync(shotsDir)) {
  if (!entry.endsWith('.png')) continue
  if (produced.has(entry) || WHITELIST.has(entry)) continue
  problems.push(`docs/screenshots/${entry} 既不在出图清单里、也不在白名单里 —— 多半是清单删了条目但文件留下了（旧产物会被当成当前版本，踩过）`)
}

const missing = [...produced.keys()].filter((name) => !fs.existsSync(path.join(shotsDir, name)))
for (const name of missing) problems.push(`出图清单里的 ${name} 还从没生成过（清单有点错字，或者出图没跑成功）`)

console.log(
  `出图清单检查：清单 ${produced.size} 张（字面 ${literals.length} + 模板 ${TEMPLATE_TABLE.reduce((sum, entry) => sum + entry.names.length, 0)}）、` +
  `目录里 ${fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png')).length} 张、` +
  `文档 ${docFiles.length} 份、白名单 ${WHITELIST.size} 条`
)
for (const problem of problems) console.log('  ✗ ' + problem)
if (!problems.length) console.log('  出图清单检查：0 问题')
process.exit(problems.length ? 1 : 0)
