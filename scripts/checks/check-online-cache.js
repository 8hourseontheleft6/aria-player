'use strict'

/**
 * 在线缓存（封面 / 艺人头像）的容量上限、原子写与清理规划检查。
 *
 * 需求里的硬约束：**不删音频、歌词或用户文件**。所以这里除了测规划本身，
 * 还要证明：lyrics 目录、音频、用户文件即使出现在同一个根目录里也不会被删；
 * 计划里混入带路径分隔符的名字会被拒。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fsp = require('node:fs/promises')
const {
  planPrune, applyPlan, writeFileAtomic, isCoverFolder, isCoverFile
} = require(path.join(__dirname, '..', '..', 'src', 'main', 'services', 'online-cache'))

const root = path.join(__dirname, '..', '..')
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
const key = (n) => n.toString(16).padStart(24, '0')
const entry = (folder, name, size, ageMs = 0) => ({ folder, name, size, at: now - ageMs })

/* ① 白名单：只认封面 / 头像目录与缓存文件名 */
{
  check('covers 是封面目录', isCoverFolder('covers'))
  check('版本化的 artists2 是头像目录', isCoverFolder('artists2') && isCoverFolder('artists'))
  check('lyrics 不是封面目录', !isCoverFolder('lyrics'))
  check('缓存文件名只认 .bin/.json', isCoverFile(`${key(1)}.bin`) && isCoverFile(`${key(1)}.json`))
  check('音频 / 歌词 / 文本不算缓存文件', !isCoverFile('song.mp3') && !isCoverFile('x.lrc') && !isCoverFile('note.txt'))
}

/* ② 歌词目录与用户文件即使出现在输入里也不会被删 */
{
  const out = planPrune({
    entries: [
      entry('covers', `${key(1)}.bin`, 400),
      entry('covers', `${key(1)}.json`, 100),
      entry('lyrics', `${key(2)}.json`, 9999),
      entry('covers', 'song.mp3', 5000),
      entry('.', 'notes.txt', 10)
    ],
    maxBytes: 10
  })
  const names = out.remove.map((item) => `${item.folder}/${item.name}`)
  check('超容量时只清封面缓存', names.length === 2 && names.every((name) => name.startsWith('covers/') && name.includes(key(1))),
    names.join(','))
  check('歌词缓存不参与清理', out.untouched.some((item) => item.folder === 'lyrics'))
  check('音频 / 用户文件不参与清理', out.untouched.some((item) => item.name === 'song.mp3') && out.untouched.some((item) => item.name === 'notes.txt'))
  check('同一张封面的 .bin 与 .json 成组删除', names.filter((name) => name.endsWith('.bin') || name.endsWith('.json')).length === 2)
}

/* ③ 容量上限：按最近访问时间从旧到新淘汰，回到上限以内 */
{
  const out = planPrune({
    entries: [
      entry('covers', `${key(1)}.bin`, 400, 5000),
      entry('covers', `${key(2)}.bin`, 400, 3000),
      entry('covers', `${key(3)}.bin`, 400, 1000)
    ],
    maxBytes: 500
  })
  check('超容量时淘汰到上限内', out.bytesAfter <= 500, `bytesAfter=${out.bytesAfter}`)
  check('先淘汰最久未访问的那张', out.remove.length === 2 && out.remove.some((item) => item.name.includes(key(1))),
    out.remove.map((item) => `${item.name}:${item.reason}`).join(','))
  check('释放字节账目可对表', out.bytesBefore - out.bytesAfter === 800, `${out.bytesBefore} -> ${out.bytesAfter}`)
}

/* ④ dry-run 语义：不碰磁盘、不改入参、可复现 */
{
  const input = {
    entries: [entry('covers', `${key(1)}.bin`, 100), entry('covers', `${key(9)}.bin`, 100)],
    maxBytes: 100
  }
  const snapshot = JSON.stringify(input.entries)
  const first = planPrune(input)
  check('planPrune 是 dry-run', first.dryRun === true)
  check('不修改传入数组', JSON.stringify(input.entries) === snapshot)
  check('两次调用结果一致（可复现）', JSON.stringify(planPrune(input)) === JSON.stringify(first))
  check('上限写进计划', first.limit === 100)
}

/* ⑤ applyPlan：临时目录里真跑一次（lyrics 与音频必须原样留着） */
async function checkApply () {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aria-online-cache-'))
  try {
    for (const folder of ['covers', 'artists2', 'lyrics']) await fsp.mkdir(path.join(dir, folder), { recursive: true })
    const dropBin = `${key(1)}.bin`
    const dropMeta = `${key(1)}.json`
    const keepBin = `${key(2)}.bin`
    const lyric = `${key(3)}.json`
    await fsp.writeFile(path.join(dir, 'covers', dropBin), Buffer.alloc(10))
    await fsp.writeFile(path.join(dir, 'covers', dropMeta), Buffer.alloc(5))
    await fsp.writeFile(path.join(dir, 'covers', keepBin), Buffer.alloc(10))
    await fsp.writeFile(path.join(dir, 'lyrics', lyric), Buffer.alloc(10))
    await fsp.writeFile(path.join(dir, 'song.mp3'), Buffer.alloc(10))

    const plan = planPrune({
      entries: [
        entry('covers', dropBin, 10),
        entry('covers', dropMeta, 5),
        entry('covers', keepBin, 10),
        { folder: 'lyrics', name: lyric, size: 10, at: now },
        { folder: '', name: 'song.mp3', size: 10, at: now }
      ],
      maxBytes: 10
    })

    const dry = await applyPlan(dir, plan, { fs: fsp, dryRun: true })
    const afterDry = (await fsp.readdir(path.join(dir, 'covers'))).sort()
    check('applyPlan dry-run 不删文件', dry.dryRun === true && afterDry.length === 3 && dry.failed.length === 0,
      `covers=${afterDry.join(',')}`)

    const real = await applyPlan(dir, plan, { fs: fsp, dryRun: false })
    const afterReal = (await fsp.readdir(path.join(dir, 'covers'))).sort()
    const lyricsAfter = (await fsp.readdir(path.join(dir, 'lyrics'))).sort()
    const rootAfter = (await fsp.readdir(dir)).sort()
    check('applyPlan 真删只删计划里的封面缓存',
      real.deleted.length === 2 && afterReal.length === 1 && afterReal[0] === keepBin,
      `covers=${afterReal.join(',')}`)
    check('歌词缓存一个都没少', lyricsAfter.length === 1 && lyricsAfter[0] === lyric)
    check('音频 / 用户文件没被删', rootAfter.includes('song.mp3'))

    /* 路径穿越 / 伪装成封面目录的计划必须被拒 */
    const evil = await applyPlan(dir, {
      remove: [
        { folder: 'covers', name: '../evil.jpg', size: 1 },
        { folder: 'lyrics', name: `${key(4)}.json`, size: 1 },
        { folder: 'covers', name: 'song.mp3', size: 1 }
      ]
    }, { fs: fsp, dryRun: false })
    check('拒绝带路径分隔符的文件名', evil.failed.some((item) => item.name === '../evil.jpg'))
    check('拒绝歌词目录', evil.failed.some((item) => item.folder === 'lyrics'))
    check('拒绝非缓存文件名', evil.failed.some((item) => item.name === 'song.mp3'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

/* ⑥ 原子写：内容落地、不留临时文件 */
async function checkAtomic () {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aria-online-atomic-'))
  try {
    const target = path.join(dir, `${key(7)}.bin`)
    await writeFileAtomic(target, Buffer.from('cover-bytes'), { fs: fsp })
    const content = await fsp.readFile(target, 'utf8')
    const names = (await fsp.readdir(dir)).sort()
    check('原子写写出正确内容', content === 'cover-bytes')
    check('原子写不留临时文件', names.length === 1 && names[0] === path.basename(target), names.join(','))
    const meta = path.join(dir, `${key(7)}.json`)
    await writeFileAtomic(meta, JSON.stringify({ at: now }), { fs: fsp })
    check('元数据也能原子写', JSON.parse(await fsp.readFile(meta, 'utf8')).at === now)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

/* ⑦ 接线检查：IPC / preload / 设置页都真的存在 */
{
  const ipc = fs.readFileSync(path.join(root, 'src', 'main', 'ipc.js'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'src', 'preload', 'preload.js'), 'utf8')
  const settings = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'ui', 'views', 'settings-view.js'), 'utf8')
  check('IPC 暴露 online:prune-cache', ipc.includes("'online:prune-cache'"))
  check('IPC 暴露 library:artwork-prune', ipc.includes("'library:artwork-prune'"))
  check('preload 暴露 online.pruneCache', /pruneCache:\s*\(options\)/.test(preload))
  check('preload 暴露 library.pruneArtwork', /pruneArtwork:\s*\(options\)/.test(preload))
  check('设置页有"检查可清理"与"确认清理"', settings.includes('检查可清理') && settings.includes('确认清理'))
  check('设置页显示上限与最近清理结果', settings.includes('上限 ') && settings.includes('最近清理'))
  check('检查脚本在 npm run check 里', fs.readFileSync(path.join(root, 'package.json'), 'utf8').includes('check-online-cache.js'))
}

checkApply()
  .then(checkAtomic)
  .then(() => {
    console.log('')
    if (problems.length) {
      console.log(`在线缓存检查：${problems.length} 个问题`)
      for (const item of problems) console.log('  · ' + item)
      process.exit(1)
    }
    console.log('在线缓存检查：0 问题')
  })
