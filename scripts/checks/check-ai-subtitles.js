'use strict'

/**
 * 「AI 字幕」的纯函数守卫（不需要窗口、不需要模型、不需要网络）。
 *
 * 这些规则最容易悄悄错，而且一错就是"用户看到的字幕不对"：
 *   · 控制标签没清干净（`<|zh|>` 出现在歌词里）；
 *   · LRC 时间码四舍五入到 100 分（`[00:59.100]`）；
 *   · 短段没合并，一个 0.5s 的气口自己站一行；
 *   · 缓存键漏了 mtime 或模型指纹，换了文件/换了模型还在用旧缓存；
 *   · URL 拼错一个字符就下载 404。
 *
 * 加进 `npm run check`（第 14 步），这样每次改动都会跑。
 */

const assert = require('node:assert/strict')

const format = require('../../src/main/services/subtitles-format')
const constants = require('../../src/main/services/ai-subtitles-constants')

const problems = []

function check (name, fn) {
  try {
    fn()
    console.log('  ✓ ' + name)
  } catch (error) {
    problems.push(name + '：' + (error && error.message))
    console.log('  ✗ ' + name + '  ' + (error && error.message))
  }
}

console.log('AI 字幕：纯函数与常量表')

/* ---------- 控制标签 ---------- */
check('清掉 SenseVoice 的控制标签', () => {
  assert.equal(format.cleanText('<|zh|><|HAPPY|>你好<|Speech|>世界<|woitn|>'), '你好世界')
  assert.equal(format.cleanText('<|EN|>  hello   world '), 'hello world')
  assert.equal(format.cleanText('<|zh|>'), '')
})

check('纯标点判定', () => {
  assert.equal(format.isPunctuationOnly('。。。'), true)
  assert.equal(format.isPunctuationOnly('好'), false)
  assert.equal(format.isPunctuationOnly(''), true)
})

/* ---------- token → 行 ---------- */
check('按句末标点切行', () => {
  const lines = format.linesFromTokens({
    tokens: ['<|zh|>', '今天', '天气', '不错', '。', '我们', '去', '公园', '吧', '！'],
    timestamps: [0, 0.1, 0.5, 0.9, 1.4, 2.4, 2.7, 3.1, 3.5, 3.9],
    durations: [0.1, 0.4, 0.4, 0.5, 0.3, 0.3, 0.4, 0.4, 0.4, 0.3],
    audioSeconds: 10
  })
  assert.equal(lines.length, 2)
  assert.equal(lines[0].text, '今天天气不错。')
  assert.ok(Math.abs(lines[1].start - 2.4) < 1e-6)
})

check('间隔 ≥1.2s 切行（换气）', () => {
  const lines = format.linesFromTokens({
    tokens: ['a', 'b', 'c'],
    timestamps: [0, 0.3, 5.0],
    durations: [0.2, 0.2, 0.2],
    audioSeconds: 6
  })
  assert.equal(lines.length, 2)
})

check('行时间单调、不重叠', () => {
  const lines = format.linesFromTokens({
    tokens: ['x', '。', 'y', '。'],
    timestamps: [2, 2.1, 2.2, 2.3],
    durations: [0.1, 0.1, 0.1, 0.1],
    audioSeconds: 4
  })
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start >= lines[i - 1].end - 1e-6)
})

/* ---------- 合并 ---------- */
check('短段并进前一行（不看间隔）、纯标点丢掉', () => {
  const merged = format.mergeSegments([
    { start: 0, end: 0.5, text: '啊' },
    { start: 0.6, end: 1.0, text: '。' },
    { start: 1.2, end: 4.0, text: '完整的一句歌词' },
    { start: 8.0, end: 12.0, text: '另一句' }
  ])
  assert.equal(merged.length, 2)
  assert.ok(merged[0].text.startsWith('啊'))
  assert.equal(merged[1].text, '另一句')
})

check('开头的短段往下一行并', () => {
  const merged = format.mergeSegments([
    { start: 0, end: 0.4, text: '嗯' },
    { start: 5, end: 9, text: '正题' }
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].text, '嗯正题')
  assert.equal(merged[0].start, 0)
})

/* ---------- LRC ---------- */
check('LRC 时间码（含 99.6 进位）', () => {
  assert.equal(format.lrcTime(0), '[00:00.00]')
  assert.equal(format.lrcTime(65.4), '[01:05.40]')
  assert.equal(format.lrcTime(59.996), '[01:00.00]')
  assert.equal(format.lrcTime(-5), '[00:00.00]')
})

check('LRC 生成与回读一致', () => {
  const lrc = format.toLrc([
    { start: 1.5, end: 3, text: '<|zh|>第一句' },
    { start: 70.25, end: 72, text: '第二句' }
  ])
  assert.equal(lrc.split('\n')[0], '[ai]')
  assert.ok(lrc.includes('[00:01.50]第一句'))
  assert.ok(lrc.includes('[01:10.25]第二句'))
  const back = format.parseLrc(lrc)
  assert.equal(back.length, 2)
  assert.ok(Math.abs(back[1].start - 70.25) < 0.01)
})

/* ---------- 常量表 ---------- */
check('常量表：大小与 SHA256 是本次核对的真值', () => {
  const byName = Object.fromEntries(constants.MODEL_FILES.map((file) => [file.name, file]))
  assert.equal(byName['model.int8.onnx'].bytes, 239233841)
  assert.equal(byName['tokens.txt'].bytes, 315894)
  assert.equal(byName['silero_vad.onnx'].bytes, 643854)
  assert.match(byName['model.int8.onnx'].sha256, /^[0-9a-f]{64}$/)
  assert.equal(constants.totalModelBytes(), 240193589)
})

check('常量表：两个下载源的 URL 都拼得出来', () => {
  const model = constants.MODEL_FILES[0]
  const vad = constants.MODEL_FILES[2]
  for (const sourceId of ['huggingface', 'hf-mirror']) {
    const modelUrl = constants.fileUrl(sourceId, model)
    const vadUrl = constants.fileUrl(sourceId, vad)
    assert.match(modelUrl, /^https:\/\/[^/]+\/.+model\.int8\.onnx$/)
    assert.match(vadUrl, /^https:\/\/[^/]+\/.+silero_vad\.onnx$/)
  }
  assert.ok(constants.fileUrl('huggingface', model).startsWith('https://huggingface.co/'))
  assert.ok(constants.fileUrl('hf-mirror', model).startsWith('https://hf-mirror.com/'))
})

check('缓存键：路径/修改时间/模型任一变化都要变', () => {
  const base = constants.cacheKeyOf({ path: '/a.mp3', mtime: 1, model: 'm1' })
  assert.match(base, /^[0-9a-f]{40}$/)
  assert.notEqual(base, constants.cacheKeyOf({ path: '/b.mp3', mtime: 1, model: 'm1' }))
  assert.notEqual(base, constants.cacheKeyOf({ path: '/a.mp3', mtime: 2, model: 'm1' }))
  assert.notEqual(base, constants.cacheKeyOf({ path: '/a.mp3', mtime: 1, model: 'm2' }))
  assert.equal(base, constants.cacheKeyOf({ path: '/a.mp3', mtime: 1, model: 'm1' }))
})

check('体积文案', () => {
  assert.equal(constants.formatBytes(0), '0 B')
  assert.equal(constants.formatBytes(1024), '1.0 KB')
  assert.equal(constants.formatBytes(240193589), '229 MB')
})

if (problems.length) {
  console.log('\nAI 字幕纯函数检查：' + problems.length + ' 个问题')
  for (const problem of problems) console.log('  · ' + problem)
  process.exit(1)
}
console.log('AI 字幕纯函数检查：0 问题')
