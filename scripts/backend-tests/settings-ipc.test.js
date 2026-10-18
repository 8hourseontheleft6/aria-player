'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { harness } = require('./helpers')

test('设置读取、修改、广播与重置都不返回密钥，修改其他字段保留密钥', async (t) => {
  const h = await harness(t)
  const bridge = h.connect()
  const secret = 'test-only-secret'
  const saved = await bridge.settings.set({ ai: { key: secret, model: 'fixture' } })
  assert.equal(saved.ai.hasKey, true)
  assert.equal(Object.hasOwn(saved.ai, 'key'), false)
  assert.equal(h.ctx.get('settings').get().ai.key, secret)
  const next = await bridge.settings.set({ ai: { model: 'changed', hasKey: false } })
  assert.equal(next.ai.hasKey, true)
  assert.equal(h.ctx.get('settings').get().ai.key, secret)
  assert.equal(JSON.stringify(await bridge.settings.get()).includes(secret), false)
  assert.equal(JSON.stringify(h.events).includes(secret), false)
  assert.equal(Object.hasOwn(h.ctx.get('settings').get().ai, 'hasKey'), false)
  const cleared = await bridge.settings.set({ ai: { key: '' } })
  assert.equal(cleared.ai.hasKey, false)
  assert.equal(Object.hasOwn((await bridge.settings.reset()).ai, 'key'), false)
})
