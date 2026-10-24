'use strict'

/*
 * 续播（每首歌记住位置）的纯逻辑检查：上限裁剪 + 值不值得记。
 *
 * 服务本身要 electron 的 app（拿 userData 路径），所以这里只测导出出来的纯函数；
 * 端到端的"听了 30 秒 → 切走 → 切回来接着放"放在 smoke 里。
 */

const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const problems = []

function check (name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`)
    return
  }
  problems.push(`${name}${detail ? '：' + detail : ''}`)
  console.log(`  ✗ ${name}${detail ? '：' + detail : ''}`)
}

const { trimEntries, isRestorable, LIMIT, MIN_SECONDS, TAIL_SECONDS } =
  require(path.join(ROOT, 'src/main/services/resume'))

/* ---------------- ① 上限 ---------------- */

check('上限是 500 条', LIMIT === 500)
check('少于 5 秒不记', MIN_SECONDS === 5)
check('离结束 10 秒内不记（多半是听完了）', TAIL_SECONDS === 10)

const small = { '/a.mp3': { seconds: 12, updatedAt: 2 }, '/b.mp3': { seconds: 9, updatedAt: 1 } }
const keptSmall = trimEntries(small, 10)
check('没超上限时原样保留', Object.keys(keptSmall.entries).length === 2 && keptSmall.dropped === 0)

/* 造 520 条，时间戳递增；裁到 500 后应该留下最新的 500 条 */
const many = {}
for (let i = 0; i < 520; i++) many[`/t${i}.mp3`] = { seconds: 30, updatedAt: 1000 + i }
const keptMany = trimEntries(many, LIMIT)
check('超上限时裁到 500 条', Object.keys(keptMany.entries).length === 500, String(Object.keys(keptMany.entries).length))
check('算出丢掉多少条', keptMany.dropped === 20, String(keptMany.dropped))
check('留下的是最新的（丢最旧的）',
  !keptMany.entries['/t0.mp3'] && !keptMany.entries['/t19.mp3'] && Boolean(keptMany.entries['/t519.mp3']))

const edge = { '/only.mp3': { seconds: 30, updatedAt: 1 } }
check('正好等于上限时不裁', Object.keys(trimEntries(edge, 1).entries).length === 1)
check('空表也能处理', Object.keys(trimEntries(null, 500).entries).length === 0)

/* ---------------- ② 值不值得记 ---------------- */

check('4 秒不记', isRestorable(4, 200) === false)
check('5 秒记', isRestorable(5, 200) === true)
check('中间位置记', isRestorable(60, 200) === true)
check('离结束 11 秒记', isRestorable(189, 200) === true)
check('离结束 10 秒不记', isRestorable(190, 200) === false)
check('离结束 3 秒不记', isRestorable(197, 200) === false)
check('时长未知时只看下限', isRestorable(30, 0) === true && isRestorable(3, 0) === false)
check('负数/NaN 不记', isRestorable(-5, 200) === false && isRestorable(Number.NaN, 200) === false)
check('字符串数字按数字处理', isRestorable('42', 200) === true)

/* ---------------- ③ 设置默认开、开关存在 ---------------- */

const settings = require('fs').readFileSync(path.join(ROOT, 'src/main/services/settings.js'), 'utf8')
check('设置项 resumePlayback 默认 true', /resumePlayback:\s*true/.test(settings))
check('关掉后服务直接不写（代码里有 enabled 判断）',
  /function enabled \(\) \{[\s\S]*?resumePlayback !== false/.test(
    require('fs').readFileSync(path.join(ROOT, 'src/main/services/resume.js'), 'utf8')))

console.log('')
if (problems.length) {
  console.log(`续播检查：${problems.length} 个问题`)
  for (const item of problems) console.log('  · ' + item)
  process.exit(1)
}
console.log('续播检查：0 问题')
