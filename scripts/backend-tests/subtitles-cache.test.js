'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { harness } = require('./helpers')

test('翻译按语言、上下文、模型和接口地址分开缓存，相同请求复用', async (t) => {
  const h = await harness(t)
  const settings = h.ctx.get('settings')
  settings.set({ ai: { model: 'fixture', baseUrl: 'https://first.test/v1' } })
  let calls = 0
  h.ctx.define('ai', () => ({ chat: async ({ messages }) => {
    calls++
    return { ok: true, content: JSON.stringify([{ i: 0, translation: messages[0].content.includes('日语') ? 'こんにちは' : '你好' }]) }
  } }))
  const service = h.load('src/main/services/ai-subtitles.js').createAiSubtitlesService(h.ctx)
  const input = { mode: 'translate', lines: ['hello'], language: '简体中文', meta: { title: 'Song' } }
  assert.equal((await service.postProcess(input)).values[0].value, '你好')
  assert.equal((await service.postProcess({ ...input, language: '日语' })).values[0].value, 'こんにちは')
  assert.equal((await service.postProcess(input)).cached, 1)
  assert.equal(calls, 2)
  await service.postProcess({ ...input, meta: { title: 'Another song' } })
  settings.set({ ai: { baseUrl: 'https://second.test/v1' } })
  await service.postProcess(input)
  settings.set({ ai: { model: 'another-model' } })
  await service.postProcess(input)
  assert.equal(calls, 5)
})
