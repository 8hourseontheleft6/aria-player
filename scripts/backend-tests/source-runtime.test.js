'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { createSourceRuntime } = require('../../src/main/services/source-runtime')
const { harness } = require('./helpers')

async function source (t, code, request = async () => ({ body: {}, raw: Buffer.alloc(0) }), options) {
  const runtime = await createSourceRuntime(code, 'fixture.js', request, options)
  t.after(() => runtime.close())
  return runtime
}

test('原有构造器绕过样例及传入参数均无法取得 Node 能力', async (t) => {
  const runtime = await source(t, `module.exports = { async search(query, api) {
    const response = await request('https://fixture.test');
    const values = [console.log, Buffer, setTimeout, crypto.createHash, request, api.request];
    return {
      process: typeof process, require: typeof require,
      escapes: await Promise.all(values.map(fn => fn.constructor('return typeof process')())),
      argument: api.constructor.constructor('return typeof process')(),
      response: response.constructor.constructor('return typeof process')(),
      raw: response.raw.constructor.constructor('return typeof process')()
    };
  }};`)
  const result = await runtime.exported.search('test')
  assert.equal(result.process, 'undefined')
  assert.equal(result.require, 'undefined')
  assert.deepEqual(result.escapes, Array(6).fill('undefined'))
  assert.equal(result.argument, 'undefined')
  assert.equal(result.response, 'undefined')
  assert.equal(result.raw, 'undefined')
})

test('Buffer、哈希、压缩、URL、异步请求和定时器保持可用', async (t) => {
  const runtime = await source(t, `module.exports = { name: '兼容性', async search() {
    await new Promise(resolve => setTimeout(resolve, 5));
    const url = new URL('/music', 'https://fixture.test');
    url.searchParams.set('q', '你好 world');
    const response = await request(url, { responseType: 'json' });
    return {
      hash: crypto.createHash('sha256').update('hello').digest('hex'),
      hmac: crypto.createHmac('sha256', 'key').update('hello').digest('hex'),
      random: crypto.randomBytes(12).length,
      roundtrip: zlib.gunzipSync(zlib.gzipSync(Buffer.from('你好'))).toString('utf8'),
      decoded: new TextDecoder().decode(Buffer.from('hello')),
      body: response.body, raw: response.raw.toString('utf8'), url: url.href
    };
  }};`, async (url) => {
    assert.equal(new URL(url).searchParams.get('q'), '你好 world')
    return { body: { ok: true }, raw: Buffer.from('fixture') }
  })
  const result = await runtime.exported.search('test')
  assert.equal(result.hash, crypto.createHash('sha256').update('hello').digest('hex'))
  assert.equal(result.hmac, crypto.createHmac('sha256', 'key').update('hello').digest('hex'))
  assert.equal(result.random, 12)
  assert.equal(result.roundtrip, '你好')
  assert.equal(result.decoded, 'hello')
  assert.deepEqual(result.body, { ok: true })
  assert.equal(result.raw, 'fixture')
})

test('LX 异步初始化、回调 request 与事件解析保持可用', async (t) => {
  const runtime = await source(t, `
    lx.on(lx.EVENT_NAMES.request, async ({action}) => {
      const response = await new Promise((resolve, reject) => lx.request('https://fixture.test', {},
        (err, res, body) => err ? reject(err) : resolve(body)));
      return action + ':' + response.url;
    });
    setTimeout(() => lx.send(lx.EVENT_NAMES.inited, { name: 'LX fixture', sources: { test: { actions: ['musicUrl'] } } }), 5);
  `, async () => ({ body: { url: 'https://fixture.test/audio.mp3' }, raw: Buffer.alloc(0) }))
  const until = Date.now() + 1000
  while (!runtime.lx.inited && Date.now() < until) await delay(5)
  assert.equal(runtime.lx.inited.name, 'LX fixture')
  assert.equal(await runtime.lx.handlers.get('request')[0]({ action: 'musicUrl' }), 'musicUrl:https://fixture.test/audio.mp3')
})

for (const [label, body] of [
  ['同步死循环', 'while (true) {}'],
  ['异步死循环', 'await Promise.resolve(); while (true) {}'],
  ['永不结束的 Promise', 'await new Promise(() => {})'],
  ['微任务死循环', 'await Promise.resolve(); const again = () => Promise.resolve().then(again); await again()']
]) {
  test(`${label}超时只终止对应音源，主进程仍响应`, async (t) => {
    const runtime = await source(t, `module.exports = { async search() { ${body} } }`, undefined, { callTimeout: 200 })
    let responsive = false
    const tick = delay(30).then(() => { responsive = true })
    await assert.rejects(runtime.exported.search('test'), /超时|interrupted/)
    await tick
    assert.equal(responsive, true)
    assert.equal(runtime.isClosed(), true)
  })
}

test('失控内存请求被拒绝，其他音源继续工作', async (t) => {
  const bad = await source(t, `module.exports = { search() { return Buffer.alloc(128 * 1024 * 1024) } }`)
  await assert.rejects(bad.exported.search('test'), /memory|allocation|length|内存/i)
  const good = await source(t, `module.exports = { search() { return [{ title: 'ok' }] } }`)
  assert.deepEqual(await good.exported.search('test'), [{ title: 'ok' }])
})

test('脚本篡改消息格式或连续发送消息时只终止对应音源', async (t) => {
  for (const body of [
    `JSON.stringify = () => '{"type":"state","events":null}'; lx.send('inited', {});`,
    `JSON.stringify = () => 'null'; lx.send('inited', {});`,
    `for (let i = 0; i < 200; i++) lx.send('inited', {});`
  ]) {
    const bad = await source(t, `module.exports = { search() { ${body} return []; } }`, undefined, { callTimeout: 1000 })
    await assert.rejects(bad.exported.search('test'), /格式无效|速率超过限制/)
    assert.equal(bad.isClosed(), true)
  }
  const good = await source(t, `module.exports = { search() { return ['ok'] } }`)
  assert.deepEqual(await good.exported.search('test'), ['ok'])
})

test('关闭音源会取消它发出的网络请求', async (t) => {
  let signal
  const runtime = await source(t, `module.exports = { async search() { return await request('https://fixture.test') } }`,
    (_url, _options, incoming) => {
      signal = incoming
      return new Promise((_resolve, reject) => incoming.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
  const result = runtime.exported.search('test')
  const assertion = assert.rejects(result, /关闭/)
  const until = Date.now() + 1000
  while (!signal && Date.now() < until) await delay(5)
  assert.ok(signal)
  runtime.close()
  await assertion
  assert.equal(signal.aborted, true)
})

test('服务真实装载、搜索、解析、重载、删除链路与网络协议限制', async (t) => {
  const h = await harness(t)
  const service = h.load('src/main/services/music-sources.js').createMusicSourcesService(h.ctx)
  const installed = await service.install(`module.exports = {
    name: 'fixture', async search(query) { return [{id: '1', title: query}] },
    resolveUrl() { return 'https://fixture.test/audio.mp3' }
  }`, 'fixture.js')
  const result = await service.search('test', { sources: [installed.id] })
  assert.equal(result.results[0].title, 'test')
  const resolved = await service.resolveUrl(result.results[0])
  assert.match(resolved.url, /^remote:\/\/stream\//)
  assert.equal(service.getStreamTarget(resolved.streamToken).url, 'https://fixture.test/audio.mp3')
  await service.load()
  await service.remove(installed.id)
  assert.equal(service.list().some((entry) => entry.id === installed.id), false)
  await assert.rejects(service.remove('builtin-internet-archive'), /不能/)
  const denied = await service.install(`module.exports = { async search() { await request('file:///etc/hosts'); return [] } }`, 'denied.js')
  const failure = await service.search('test', { sources: [denied.id] })
  assert.match(failure.perSource[0].error, /http\(s\)/)
})

test('链接导入可用，过大的声明响应与流式响应均中止', async (t) => {
  const h = await harness(t)
  const service = h.load('src/main/services/music-sources.js').createMusicSourcesService(h.ctx)
  h.electron.net.fetch = async () => new Response('module.exports = {search(){return [{title:"from link"}]}}')
  const installed = await service.installFromUrl('https://fixture.test/link.js')
  assert.equal((await service.search('test', { sources: [installed.id] })).results[0].title, 'from link')
  let signal
  h.electron.net.fetch = async (_url, options) => {
    signal = options.signal
    return new Response('', { headers: { 'Content-Length': String(5 * 1024 * 1024) } })
  }
  await assert.rejects(service.installFromUrl('https://fixture.test/large.js'), /超过 4 MiB/)
  assert.equal(signal.aborted, true)
  h.electron.net.fetch = async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ start (controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(1024 * 1024))
      controller.close()
    } }))
  }
  await assert.rejects(service.installFromUrl('https://fixture.test/stream.js'), /超过 4 MiB/)
  assert.equal(signal.aborted, true)
})
