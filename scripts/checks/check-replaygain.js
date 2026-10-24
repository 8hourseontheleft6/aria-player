'use strict'

/*
 * ReplayGain 检查：标签读取（真 MP3 夹具）+ 纯逻辑（dB → 线性增益、按设置挑标签）。
 *
 * 为什么自己造夹具：仓库里 tests/ 是 gitignore 的，检查脚本不能依赖它。
 * 这里现场拼一个只有 ID3v2 头 + 三个静音 MP3 帧的文件 —— music-metadata 能正常读出
 * REPLAYGAIN_TRACK_GAIN / REPLAYGAIN_ALBUM_GAIN / REPLAYGAIN_TRACK_PEAK。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

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

/* ---------------- 夹具：手搓带 ReplayGain 标签的 MP3 ---------------- */

function txxxFrame (key, value) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')])
  const frame = Buffer.alloc(10)
  frame.write('TXXX', 0, 'latin1')
  frame.writeUInt32BE(body.length, 4)
  frame.writeUInt16BE(0, 8)
  return Buffer.concat([frame, body])
}

function taggedMp3 (frames) {
  const tag = Buffer.concat(frames)
  const size = tag.length
  const id3 = Buffer.concat([
    Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]),
    Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]),
    tag
  ])
  // MPEG-1 Layer III / 128kbps / 44.1kHz：帧长 417 字节，0x00 数据在 L3 里就是静音
  const frame = Buffer.alloc(417)
  frame.writeUInt32BE(0xfffb9064, 0)
  return Buffer.concat([id3, frame, frame, frame])
}

function silentWav () {
  const sampleRate = 8000
  const data = Buffer.alloc(1600)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-rg-'))
  const minus = path.join(dir, 'rg-minus6.mp3')
  const plus = path.join(dir, 'rg-plus6.mp3')
  const plain = path.join(dir, 'rg-none.wav')
  fs.writeFileSync(minus, taggedMp3([
    txxxFrame('REPLAYGAIN_TRACK_GAIN', '-6.00 dB'),
    txxxFrame('REPLAYGAIN_ALBUM_GAIN', '+3.00 dB'),
    txxxFrame('REPLAYGAIN_TRACK_PEAK', '0.988553')
  ]))
  fs.writeFileSync(plus, taggedMp3([txxxFrame('REPLAYGAIN_TRACK_GAIN', '+6.00 dB')]))
  fs.writeFileSync(plain, silentWav())

  const { readMetadata } = require(path.join(ROOT, 'src/main/services/metadata'))
  const negative = await readMetadata(minus)
  const positive = await readMetadata(plus)
  const untagged = await readMetadata(plain)

  check('读得出 -6dB 的单曲增益', negative.gainTrack === -6, `实际 ${negative.gainTrack}`)
  check('读得出 +3dB 的专辑增益', negative.gainAlbum === 3, `实际 ${negative.gainAlbum}`)
  check('读得出 peak', Math.abs((negative.gainPeak || 0) - 0.988553) < 1e-6, `实际 ${negative.gainPeak}`)
  check('读得出 +6dB', positive.gainTrack === 6, `实际 ${positive.gainTrack}`)
  check('没有专辑标签时为 null', positive.gainAlbum === null, `实际 ${positive.gainAlbum}`)
  check('完全没有标签时三个都是 null',
    untagged.gainTrack === null && untagged.gainAlbum === null && untagged.gainPeak === null,
    JSON.stringify({ t: untagged.gainTrack, a: untagged.gainAlbum, p: untagged.gainPeak }))

  /* ---------------- 纯逻辑 ---------------- */
  const rg = await import(pathToFileURL(path.join(ROOT, 'src/renderer/js/core/replaygain.js')).href)

  check('0dB → 线性增益 1', rg.dbToLinearGain(0) === 1)
  check('+6dB → ≈1.995', Math.abs(rg.dbToLinearGain(6) - 1.9952623) < 1e-4, `实际 ${rg.dbToLinearGain(6)}`)
  check('-6dB → ≈0.501', Math.abs(rg.dbToLinearGain(-6) - 0.5011872) < 1e-4, `实际 ${rg.dbToLinearGain(-6)}`)
  check('非数值 → 1', rg.dbToLinearGain(Number.NaN) === 1)
  check('离谱值（>24dB）→ 1', rg.dbToLinearGain(99) === 1, `实际 ${rg.dbToLinearGain(99)}`)

  const track = { gainTrack: -6, gainAlbum: 3 }
  check("模式 off → 0dB", rg.resolveReplayGainDb('off', track) === 0)
  check("模式 track → 用单曲标签", rg.resolveReplayGainDb('track', track) === -6)
  check("模式 album → 用专辑标签", rg.resolveReplayGainDb('album', track) === 3)
  check("模式 album 但只有单曲标签 → 退回单曲", rg.resolveReplayGainDb('album', { gainTrack: -4, gainAlbum: null }) === -4)
  check('无标签 → 0dB', rg.resolveReplayGainDb('track', {}) === 0)
  check('没有曲目 → 0dB', rg.resolveReplayGainDb('album', null) === 0)
  check('describe：off 的 label 是「关」', rg.describeReplayGain('off', track).label === '关')
  check('describe：album 缺专辑标签时 source 标成 track-fallback',
    rg.describeReplayGain('album', { gainTrack: -4, gainAlbum: null }).source === 'track-fallback')
  check('模式列表与标注齐全',
    rg.REPLAY_GAIN_MODES.join(',') === 'off,track,album' &&
    Object.keys(rg.REPLAY_GAIN_LABELS).join(',') === 'off,track,album')

  fs.rmSync(dir, { recursive: true, force: true })

  console.log('')
  if (problems.length) {
    console.log(`ReplayGain 检查：${problems.length} 个问题`)
    for (const item of problems) console.log('  · ' + item)
    process.exit(1)
  }
  console.log('ReplayGain 检查：0 问题')
}

main().catch((err) => {
  console.error('ReplayGain 检查崩了：', err)
  process.exit(1)
})
