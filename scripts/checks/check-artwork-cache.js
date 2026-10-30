'use strict'

/**
 * 封面磁盘缓存清理规划的检查（纯逻辑，不碰磁盘）。
 * 对应任务 3 里"容量 / 访问时间 / 孤儿清理 + dry-run"的部分。
 */

const path = require('node:path')
const { planPrune } = require(path.join(__dirname, '..', '..', 'src', 'main', 'services', 'artwork-cache'))

const problems = []
function check (name, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${name}`)
    return
  }
  problems.push(`${name}${detail ? '：' + detail : ''}`)
  console.log(`  ✗ ${name}${detail ? '：' + detail : ''}`)
}

const now = 1_700_000_000_000
const file = (name, size, ageMs = 0) => ({ name, size, at: now - ageMs })
const id = (n) => n.toString(16).padStart(16, '0')

/* ① 只碰可重建的封面缓存 */
{
  const out = planPrune({
    files: [file(`${id(1)}.jpg`, 100), file('song.mp3', 999), file('lyrics.lrc', 50), file('notes.txt', 10)],
    maxBytes: 10_000,
    keepIds: [id(1)],
    now
  })
  check('非封面缓存文件一律不动', out.untouched.length === 3 && out.remove.length === 0,
    `untouched=${out.untouched.length} remove=${out.remove.length}`)
  check('缩略图与全尺寸都算封面缓存', out.keep.includes(`${id(1)}.jpg`))
}

/* ② 孤儿清理：不在 keepIds 里的都清 */
{
  const out = planPrune({
    files: [file(`${id(1)}.jpg`, 100), file(`${id(2)}.jpg`, 100), file(`thumb-${id(3)}.jpg`, 100)],
    maxBytes: 10_000,
    keepIds: [id(1)],
    now
  })
  const removed = out.remove.map((item) => item.name).sort()
  check('孤儿缓存被列入删除', removed.length === 2 && removed.every((name) => name.includes(id(2)) || name.includes(id(3))),
    removed.join(','))
  check('孤儿原因标注为 orphan', out.remove.every((item) => item.reason === 'orphan'))
  check('仍在库里的保留', out.keep.length === 1 && out.keep[0] === `${id(1)}.jpg`)
}

/* ③ 容量上限：按访问时间 LRU 淘汰，直到回到上限内 */
{
  const out = planPrune({
    files: [
      file(`${id(1)}.jpg`, 400, 5000),
      file(`${id(2)}.jpg`, 400, 3000),
      file(`${id(3)}.jpg`, 400, 1000)
    ],
    maxBytes: 500,
    keepIds: [id(1), id(2), id(3)],
    now
  })
  check('超容量时淘汰到上限内', out.bytesAfter <= 500, `bytesAfter=${out.bytesAfter}`)
  check('先淘汰最久未访问的', out.remove.length === 2 && out.remove.some((item) => item.name === `${id(1)}.jpg`),
    out.remove.map((item) => `${item.name}:${item.reason}`).join(','))
  check('淘汰原因标注为 over-capacity', out.remove.every((item) => item.reason === 'over-capacity'))
}

/* ④ 年龄清理（可选） */
{
  const out = planPrune({
    files: [file(`${id(1)}.jpg`, 100, 10 * 24 * 3600 * 1000), file(`${id(2)}.jpg`, 100, 0)],
    maxBytes: 10_000,
    maxAgeMs: 7 * 24 * 3600 * 1000,
    keepIds: [id(1), id(2)],
    now
  })
  check('超过 maxAge 的缓存被清', out.remove.length === 1 && out.remove[0].name === `${id(1)}.jpg`)
  check('新鲜缓存保留', out.keep.length === 1 && out.keep[0] === `${id(2)}.jpg`)
}

/* ⑤ dry-run 语义：只返回计划，不删任何东西；输入不被修改 */
{
  const input = { files: [file(`${id(1)}.jpg`, 100), file(`${id(9)}.jpg`, 100)], maxBytes: 100, keepIds: [id(1)], now }
  const snapshot = JSON.stringify(input.files)
  const out = planPrune(input)
  check('planPrune 是 dry-run', out.dryRun === true)
  check('不修改传入数组', JSON.stringify(input.files) === snapshot)
  check('两次调用结果一致（可复现）', JSON.stringify(planPrune(input)) === JSON.stringify(out))
  check('说明字节账目', out.bytesBefore >= out.bytesAfter && out.limit === 100,
    `${out.bytesBefore} -> ${out.bytesAfter} / ${out.limit}`)
}

console.log('')
if (problems.length) {
  console.log(`封面缓存清理规划检查：${problems.length} 个问题`)
  for (const item of problems) console.log('  · ' + item)
  process.exit(1)
}
console.log('封面缓存清理规划检查：0 问题')
