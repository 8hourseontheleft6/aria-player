'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { harness } = require('./helpers')

test('音源开关与拖放选项经过真实 preload → IPC → 服务仍完整', async (t) => {
  const h = await harness(t)
  h.ctx.define('musicSources', (ctx) => h.load('src/main/services/music-sources.js').createMusicSourcesService(ctx))
  let drop
  h.ctx.define('library', () => ({ resolveDrop: (...args) => { drop = args; return { ok: true } } }))
  const bridge = h.connect()
  await bridge.sources.setEnabled('fixture', true)
  assert.equal(h.ctx.get('settings').get().musicSources.fixture.enabled, true)
  await bridge.sources.setEnabled('fixture', false)
  assert.equal(h.ctx.get('settings').get().musicSources.fixture.enabled, false)
  await bridge.library.handleDrop(['fixture.wav'], { confirm: false })
  assert.deepEqual(drop, [['fixture.wav'], { confirm: false }])
})

test('异步服务缺失与真实错误分别处理', async (t) => {
  const h = await harness(t)
  const bridge = h.connect()
  assert.equal(await bridge.library.scan(), null)
  h.ctx.define('library', () => ({ scan: async () => { throw new Error('fixture IO failure') } }))
  await assert.rejects(bridge.library.scan(), /fixture IO failure/)
})
