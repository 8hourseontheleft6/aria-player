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

/* ---------- 文本后处理（阶段 A/B）========== */
const llm = require('../../src/main/services/subtitles-llm')

check('分批：每批 ≤40 行、行号是全局下标', () => {
  const lines = Array.from({ length: 95 }, (_, i) => 'line' + i)
  const batches = llm.batchLines(lines)
  assert.equal(batches.length, 3)
  assert.equal(batches[0].length, 40)
  assert.equal(batches[2].length, 15)
  assert.equal(batches[0][0].i, 0)
  assert.equal(batches[1][0].i, 40)
  assert.equal(batches[2][14].i, 94)
  assert.equal(batches[1][3].text, 'line43')
})

check('JSON 解析：容忍围栏与前后废话，解析失败返回 null', () => {
  assert.deepEqual(llm.extractJsonArray('[{ "i": 0, "text": "好" }]'), [{ i: 0, text: '好' }])
  assert.deepEqual(llm.extractJsonArray('```json\n[{"i":0,"text":"好"}]\n```'), [{ i: 0, text: '好' }])
  assert.deepEqual(llm.extractJsonArray('好的，结果如下：[{"i":1,"text":"a"}] 希望有帮助'), [{ i: 1, text: 'a' }])
  assert.equal(llm.extractJsonArray('没有数组'), null)
  assert.equal(llm.extractJsonArray('[{"i":0,'), null)
  assert.equal(llm.extractJsonArray('{"i":0}'), null)
})

check('索引校验：多一个/少一个/重复/空值全都整批丢弃', () => {
  assert.equal(llm.validateIndexed([{ i: 0, text: 'a' }, { i: 1, text: 'b' }], [0, 1], 'text').ok, true)
  assert.equal(llm.validateIndexed([{ i: 0, text: 'a' }], [0, 1], 'text').reason, 'missing-index')
  assert.equal(llm.validateIndexed([{ i: 0, text: 'a' }, { i: 1, text: 'b' }, { i: 2, text: 'c' }], [0, 1], 'text').reason, 'extra-index')
  assert.equal(llm.validateIndexed([{ i: 0, text: 'a' }, { i: 0, text: 'b' }], [0, 1], 'text').reason, 'duplicate-index')
  assert.equal(llm.validateIndexed([{ i: 0, text: '' }], [0], 'text').reason, 'empty-text')
  assert.equal(llm.validateIndexed([{ i: 0, text: 'x' }], [0], 'translation').reason, 'empty-translation')
  assert.equal(llm.validateIndexed([{ i: 'x', text: 'a' }], [0], 'text').reason, 'bad-index')
  assert.equal(llm.validateIndexed(null, [0], 'text').reason, 'not-array')
  assert.equal(llm.validateIndexed([{ i: 0, translation: 'x' }], [0], 'translation').ok, true)
})

check('缓存键：原文/模型/prompt 版本任一变化都要失效', () => {
  const base = llm.cacheKeyOf({ text: '原歌词', model: 'm1' })
  assert.match(base, /^[0-9a-f]{40}$/)
  assert.notEqual(base, llm.cacheKeyOf({ text: '原歌词2', model: 'm1' }))
  assert.notEqual(base, llm.cacheKeyOf({ text: '原歌词', model: 'm2' }))
  assert.notEqual(base, llm.cacheKeyOf({ text: '原歌词', model: 'm1', promptVersion: 'llm-v2' }))
  assert.equal(base, llm.cacheKeyOf({ text: '原歌词', model: 'm1' }))
})

check('prompt：带上下文、约束里明确"不得增删行/不得润色"', () => {
  const [first] = llm.buildMessages({ mode: 'correct', lines: ['甲', '乙'], meta: { title: '歌', artist: '人', album: '辑' } })
  assert.ok(first.system.includes('不允许：增删行'))
  assert.ok(first.system.includes('拿不准就原样保留'))
  assert.ok(first.user.includes('歌名：歌'))
  assert.ok(first.user.includes('艺人：人'))
  assert.ok(first.user.includes('专辑：辑'))
  assert.ok(first.user.includes('[{"i":0,"text":"甲"}'))
  const [translated] = llm.buildMessages({ mode: 'translate', lines: ['甲'], language: 'English' })
  assert.ok(translated.system.includes('English'))
  assert.ok(translated.system.includes('translation'))
})

check('回填：校正只改 text、翻译只写 translation，行数不变', () => {
  const lines = [{ time: 1, text: '错字' }, { time: 2, text: '第二行' }]
  const fixed = llm.applyCorrections(lines, [{ i: 0, value: '正字' }])
  assert.equal(fixed.length, 2)
  assert.equal(fixed[0].text, '正字')
  assert.equal(fixed[1].text, '第二行')
  assert.equal(fixed[0].time, 1)
  const translated = llm.applyTranslations(fixed, [{ i: 0, value: 'The word' }])
  assert.equal(translated[0].translation, 'The word')
  assert.equal(translated[0].text, '正字')
  /* 原数组不被改 */
  assert.equal(lines[0].text, '错字')
})

check('徽章：校正/翻译成功与降级', () => {
  assert.equal(llm.badgeOf({ corrected: false, translated: false }), 'AI · 本地')
  assert.equal(llm.badgeOf({ corrected: true, translated: false }), 'AI · 校正')
  assert.equal(llm.badgeOf({ corrected: true, translated: true }), 'AI · 本地 · 翻译')
})

if (problems.length) {
  console.log('\nAI 字幕纯函数检查：' + problems.length + ' 个问题')
  for (const problem of problems) console.log('  · ' + problem)
  process.exit(1)
}
console.log('AI 字幕纯函数检查：0 问题')
