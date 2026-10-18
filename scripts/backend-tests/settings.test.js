'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { harness } = require('./helpers')

test('连续写入按顺序完成，配置有效且保留上一版备份', async (t) => {
  const h = await harness(t)
  const settings = h.ctx.get('settings')
  const writes = []
  for (let i = 0; i < 20; i++) {
    settings.set({ volume: i / 20 })
    writes.push(settings.flush())
  }
  await Promise.all(writes)
  assert.equal(JSON.parse(await fs.readFile(settings.filePath, 'utf8')).volume, 19 / 20)
  assert.equal(JSON.parse(await fs.readFile(settings.filePath + '.bak', 'utf8')).volume, 18 / 20)
  assert.deepEqual((await fs.readdir(h.dir)).filter((name) => name.endsWith('.tmp')), [])
})

test('替换失败保留原配置、清理临时文件并向 IPC 调用者报错，之后可重试', async (t) => {
  let broken = false
  const h = await harness(t, { 'node:fs/promises': {
    ...fs, rename: async (from, to) => {
      if (broken && to.endsWith('settings.json')) throw Object.assign(new Error('fixture disk failure'), { code: 'ENOSPC' })
      return fs.rename(from, to)
    }
  } })
  const bridge = h.connect()
  await bridge.settings.set({ volume: 0.25 })
  broken = true
  await assert.rejects(bridge.settings.set({ volume: 0.75 }), /fixture disk failure/)
  assert.equal(h.events.some((event) => event.name === 'settings:save-error' && event.value.code === 'ENOSPC'), true)
  assert.equal(JSON.parse(await fs.readFile(path.join(h.dir, 'settings.json'), 'utf8')).volume, 0.25)
  assert.deepEqual((await fs.readdir(h.dir)).filter((name) => name.endsWith('.tmp')), [])
  broken = false
  await h.ctx.get('settings').flush()
  assert.equal(JSON.parse(await fs.readFile(path.join(h.dir, 'settings.json'), 'utf8')).volume, 0.75)
})

test('损坏配置恢复备份并保留损坏原件', async (t) => {
  const h = await harness(t)
  const settings = h.ctx.get('settings')
  settings.set({ volume: 0.25 }); await settings.flush()
  settings.set({ volume: 0.75 }); await settings.flush()
  await fs.writeFile(settings.filePath, '{broken', 'utf8')
  await settings.init()
  assert.equal(settings.get().volume, 0.25)
  assert.equal(JSON.parse(await fs.readFile(settings.filePath, 'utf8')).volume, 0.25)
  const preserved = (await fs.readdir(h.dir)).find((name) => name.includes('.corrupt-'))
  assert.equal(await fs.readFile(path.join(h.dir, preserved), 'utf8'), '{broken')
})

test('读取权限错误不能被当作首次启动，危险对象键不污染默认值', async (t) => {
  let deny = false
  const h = await harness(t, { 'node:fs/promises': {
    ...fs, readFile: async (...args) => {
      if (deny && String(args[0]).endsWith('settings.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return fs.readFile(...args)
    }
  } })
  const settings = h.ctx.get('settings')
  settings.set(JSON.parse('{"__proto__":{"polluted":true},"ai":{"constructor":{"polluted":true}}}'))
  assert.equal({}.polluted, undefined)
  assert.equal(settings.get().polluted, undefined)
  deny = true
  await assert.rejects(settings.init(), { code: 'EACCES' })
  deny = false
})
