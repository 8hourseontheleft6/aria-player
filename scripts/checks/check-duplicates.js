'use strict'

/*
 * 重复曲目检测检查：
 *  · 同一份文件（大小/时长/首尾指纹都一样）→ 报「完全重复」；
 *  · 同一首歌的不同码率（大小不同、标题艺人时长接近）→ **只**报「可能重复」，
 *    绝不混进 completely-identical 那组（这是需求里点名的一条）；
 *  · 只报告，不改动任何文件（扫描前后目录逐字节不变）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

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

const duplicates = require(path.join(ROOT, 'src/main/services/duplicates'))

/* ---------------- ① 纯函数：初筛分组 ---------------- */

const tracks = [
  { id: 'a1', path: '/m/a1.flac', size: 1000, duration: 180.1, title: 'Song', artist: 'Band' },
  { id: 'a2', path: '/m/a2.flac', size: 1000, duration: 179.9, title: 'Song', artist: 'Band' },
  { id: 'b1', path: '/m/b1.flac', size: 500, duration: 180, title: 'Other', artist: 'Band' }
]
const groups = duplicates.groupBySizeAndDuration(tracks)
check('同大小同时长（±1s）归到一组', groups.length === 1 && groups[0].tracks.length === 2,
  JSON.stringify(groups.map((group) => group.key)))
check('不同大小不同组', !groups.some((group) => group.tracks.some((track) => track.id === 'b1')))
check('没大小的曲目被跳过',
  duplicates.groupBySizeAndDuration([{ path: '/x', size: 0 }]).length === 0)

/* ---------------- ② 内容指纹：同文件同指纹、改一个字节就变 ---------------- */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-dupe-'))
const fileA = path.join(dir, 'a.flac')
const fileB = path.join(dir, 'b.flac')
const fileC = path.join(dir, 'c.flac')
const body = Buffer.alloc(200 * 1024, 7)
fs.writeFileSync(fileA, body)
fs.writeFileSync(fileB, Buffer.from(body))
/* 改**开头**的字节：指纹采的就是首/尾 64KB（中间改动不在采样范围内，这是有意的取舍） */
const changed = Buffer.from(body)
changed[1024] = 8
fs.writeFileSync(fileC, changed)

;(async () => {
  const [digestA, digestB, digestC] = await Promise.all([
    duplicates.contentFingerprint(fileA),
    duplicates.contentFingerprint(fileB),
    duplicates.contentFingerprint(fileC)
  ])
  check('两份相同文件指纹一致', digestA === digestB && digestA.length === 40)
  check('开头改一个字节指纹就不同（首尾采样，够区分同一首的两次拷贝）', digestA !== digestC)
  check('读不到的文件返回空串', (await duplicates.contentFingerprint(path.join(dir, 'nope.flac'))) === '')

  /* ---------------- ③ 完整扫描：完全重复 vs 可能重复 ---------------- */

  const sameBoth = [
    { id: 'x1', path: fileA, size: 204800, duration: 200, title: 'Same', artist: 'Band', bitrate: 1000 },
    { id: 'x2', path: fileB, size: 204800, duration: 200, title: 'Same', artist: 'Band', bitrate: 1000 },
    /* 同一首歌不同码率：大小不同，标题艺人时长一样 */
    { id: 'y1', path: path.join(dir, 'y1.flac'), size: 400000, duration: 200, title: 'Same', artist: 'Band', bitrate: 2000 },
    { id: 'y2', path: path.join(dir, 'y2.flac'), size: 300000, duration: 200, title: 'Same', artist: 'Band', bitrate: 1500 }
  ]
  fs.writeFileSync(path.join(dir, 'y1.flac'), Buffer.alloc(1000, 1))
  fs.writeFileSync(path.join(dir, 'y2.flac'), Buffer.alloc(1000, 2))

  const report = await duplicates.scan(sameBoth)
  check('完全重复只报那一对', report.exact.length === 1 && report.exact[0].tracks.length === 2,
    JSON.stringify(report.exact.map((group) => group.tracks.map((track) => track.id))))
  check('完全重复组的 id 正确',
    report.exact[0].tracks.map((track) => track.id).sort().join() === 'x1,x2')
  check('不同码率的不进"完全重复"',
    !report.exact.some((group) => group.tracks.some((track) => track.id === 'y1' || track.id === 'y2')))
  check('不同码率的被标成"可能重复"',
    report.likely.some((group) => group.tracks.some((track) => track.id === 'y1')))
  check('只报告、不动文件',
    fs.readFileSync(fileA).equals(body) &&
    fs.readFileSync(fileB).equals(body) &&
    fs.statSync(path.join(dir, 'y1.flac')).size === 1000)

  /* 假指纹注入（自检接口）：能指定谁和谁一样 */
  const fake = await duplicates.scan([
    { id: 'z1', path: '/z1', size: 10, duration: 10, title: 'Z', artist: 'B' },
    { id: 'z2', path: '/z2', size: 10, duration: 10, title: 'Z', artist: 'B' }
  ], { fingerprint: async () => 'same-digest' })
  check('可以注入假指纹做确定性测试', fake.exact.length === 1 && fake.exact[0].tracks.length === 2)

  /* 没有重复时返回空数组 */
  const clean = await duplicates.scan([
    { id: 'q1', path: fileA, size: 204800, duration: 200, title: 'A', artist: 'X' }
  ])
  check('没有重复时两个列表都是空', clean.exact.length === 0 && clean.likely.length === 0)

  fs.rmSync(dir, { recursive: true, force: true })

  console.log('')
  if (problems.length) {
    console.log(`重复曲目检查：${problems.length} 个问题`)
    for (const item of problems) console.log('  · ' + item)
    process.exit(1)
  }
  console.log('重复曲目检查：0 问题')
})().catch((error) => {
  console.error('重复曲目检查崩了：', error)
  process.exit(1)
})
