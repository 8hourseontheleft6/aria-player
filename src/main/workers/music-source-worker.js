'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { newQuickJSWASMModule, newVariant, RELEASE_SYNC } = require(workerData.quickJsModule)

const MAX_BYTES = 2 * 1024 * 1024
const MAX_MESSAGE = workerData.maxMessage
const timers = new Map()
const requests = new Map()
let context
let runtime
let deadline = 0
let sequence = 0
let messageWindow = Date.now()
let messageCount = 0
let messageBytes = 0

function relay (message, bytes) {
  if (Date.now() - messageWindow >= 1000) {
    messageWindow = Date.now()
    messageCount = 0
    messageBytes = 0
  }
  messageCount++
  messageBytes += bytes
  if (messageCount > 128 || messageBytes > 16 * 1024 * 1024) throw new Error('音源消息速率超过限制')
  parentPort.postMessage(message)
}

function limited (value) {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json || '') > MAX_MESSAGE) throw new Error('音源消息超过限制')
  return json
}

function unpack (value) {
  if (!value || typeof value !== 'object') return value
  if (typeof value.__ariaBytes === 'string') return Buffer.from(value.__ariaBytes, 'base64')
  if (Array.isArray(value)) return value.map(unpack)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]))
}

function pack (value) {
  return Buffer.isBuffer(value) ? { __ariaBytes: value.toString('base64') } : value
}

/** 所有宿主同步能力都在白名单里，参数和返回值都是解释器中的字符串。 */
function hostOperation (operation, input) {
  const args = unpack(input)
  switch (operation) {
    case 'hash': {
      const [algorithm, key, chunks, encoding] = args
      const hash = key === null ? crypto.createHash(algorithm) : crypto.createHmac(algorithm, key)
      for (const chunk of chunks) hash.update(chunk)
      return pack(hash.digest(encoding || undefined))
    }
    case 'random': {
      const size = Number(args[0])
      if (!Number.isInteger(size) || size < 0 || size > MAX_BYTES) throw new Error('随机字节长度超过限制')
      return pack(crypto.randomBytes(size))
    }
    case 'uuid': return crypto.randomUUID()
    case 'aes': {
      const [data, mode, key, iv] = args
      const cipher = crypto.createCipheriv(mode, key, iv)
      return pack(Buffer.concat([cipher.update(data), cipher.final()]))
    }
    case 'rsa': return pack(crypto.publicEncrypt(args[1], args[0]))
    case 'zlib': {
      const [name, data] = args
      if (!['gzipSync', 'gunzipSync', 'inflateSync', 'deflateSync'].includes(name)) throw new Error('不支持的压缩方法')
      return pack(zlib[name](data, { maxOutputLength: MAX_BYTES }))
    }
    case 'decode': return new TextDecoder(args[0], args[1]).decode(args[2])
    case 'params': return [...new URLSearchParams(args[0])]
    case 'url': {
      const url = new URL(args[0], args[1] || undefined)
      const properties = ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']
      if (args[2]) {
        if (!properties.includes(args[2]) || args[2] === 'origin') throw new Error('不可写的 URL 属性')
        url[args[2]] = String(args[3])
      }
      return Object.fromEntries(properties.map((key) => [key, url[key]]))
    }
    default: throw new Error('未允许的音源能力')
  }
}

function run (code, filename = 'aria-source-host.js') {
  deadline = Date.now() + 1000
  const result = context.evalCode(code, filename, { type: 'global' })
  const handle = context.unwrapResult(result)
  handle.dispose()
  pump()
}

function pump () {
  // 一次只消化有限的微任务，Promise 自循环也会被墙钟截止时间中断。
  while (runtime.hasPendingJob()) {
    if (Date.now() > deadline) throw new Error('音源微任务执行超时')
    const result = runtime.executePendingJobs(100)
    if (result.error) {
      const error = context.dump(result.error)
      result.error.dispose()
      throw new Error(error.message || '音源微任务失败')
    }
  }
}

function fail (error) {
  parentPort.postMessage({ type: 'fatal', error: String(error.message || error) })
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

function expose (name, fn, fatal = false) {
  const handle = context.newFunction(name, (...args) => {
    try { return fn(...args) } catch (error) {
      if (fatal) fail(error)
      throw error
    }
  })
  context.setProp(context.global, name, handle)
  handle.dispose()
}

async function initialize () {
  const QuickJS = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmBinary: workerData.wasm }))
  runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(32 * 1024 * 1024)
  runtime.setMaxStackSize(512 * 1024)
  runtime.setInterruptHandler(() => Date.now() > deadline)
  context = runtime.newContext()

  expose('__ariaSync', (operation, data) => {
    try {
      const json = context.getString(data)
      if (Buffer.byteLength(json) > MAX_MESSAGE) throw new Error('音源参数过大')
      return context.newString(limited({ ok: true, value: hostOperation(context.getString(operation), JSON.parse(json)) }))
    } catch (error) {
      return context.newString(JSON.stringify({ ok: false, error: String(error.message || error) }))
    }
  })
  expose('__ariaSend', (data) => {
    const json = context.getString(data)
    if (Buffer.byteLength(json) > MAX_MESSAGE) throw new Error('音源消息过大')
    const message = JSON.parse(json)
    // 脚本能改写自己的 JSON 等全局对象，因此桥接输出也必须按不可信数据校验。
    if (!message || typeof message !== 'object') throw new Error('音源消息格式无效')
    if (message.type === 'state') {
      if (!Array.isArray(message.events) || message.events.length > 128 ||
        message.events.some((event) => typeof event !== 'string' || event.length > 128) ||
        (message.inited !== null && (typeof message.inited !== 'object' || Array.isArray(message.inited)))) {
        throw new Error('音源状态格式无效')
      }
    } else if (message.type === 'result') {
      if (!Number.isSafeInteger(message.id) || message.id <= 0 ||
        (typeof message.json !== 'string' && typeof message.error !== 'string')) throw new Error('音源结果格式无效')
    } else throw new Error('音源消息类型无效')
    relay(message, Buffer.byteLength(json))
  }, true)
  expose('__ariaRequest', (data) => {
    if (requests.size >= 16) throw new Error('音源并发请求过多')
    const json = context.getString(data)
    if (Buffer.byteLength(json) > MAX_MESSAGE) throw new Error('音源请求过大')
    const id = ++sequence
    const promise = context.newPromise()
    requests.set(id, promise)
    relay({ type: 'request', id, json }, Buffer.byteLength(json))
    return promise.handle
  }, true)
  expose('__ariaTimer', (idHandle, delayHandle, clearHandle) => {
    const id = context.getNumber(idHandle)
    if (context.getNumber(clearHandle)) {
      clearTimeout(timers.get(id))
      timers.delete(id)
      return
    }
    if (timers.size >= 128) throw new Error('音源定时器过多')
    const delay = Math.max(1, Math.min(60000, context.getNumber(delayHandle) || 1))
    const timer = setTimeout(() => {
      timers.delete(id)
      try { run(`__ariaFireTimer(${JSON.stringify(id)})`) } catch (error) { fail(error) }
    }, delay)
    timers.set(id, timer)
  })

  // 在解释器内部加载纯 JS Buffer；这里的 require 只访问三份固定依赖且不对音源暴露。
  const factories = Object.entries(workerData.bufferModules).map(([id, source]) =>
    `${JSON.stringify(id)}: function(module, exports, require) {\n${source}\n}`)
  run(`(function() { const factories = {${factories.join(',')}}; const cache = {};
    function require(id) { if (!Object.prototype.hasOwnProperty.call(factories, id)) throw new Error('Module denied');
      if (!cache[id]) { const module = cache[id] = { exports: {} }; factories[id](module, module.exports, require); }
      return cache[id].exports; }
    globalThis.Buffer = require('buffer').Buffer;
  })()`)
  run(fs.readFileSync(path.join(__dirname, 'source-environment.js'), 'utf8'))
  run(`__ariaSetName(${JSON.stringify(workerData.filename.replace(/\.js$/, ''))})`)
  run(workerData.code, workerData.filename)
}

const ready = initialize()
ready.catch(fail)
parentPort.on('message', async (message) => {
  try {
    await ready
    if (message.type === 'response') {
      const promise = requests.get(message.id)
      if (!promise) return
      requests.delete(message.id)
      deadline = Date.now() + 1000
      const value = context.newString(message.error ? JSON.stringify({ error: message.error }) : message.json)
      promise.resolve(value)
      value.dispose()
      pump()
      promise.dispose()
    } else if (message.type === 'call') {
      run(`__ariaCall(${JSON.stringify(message.id)}, ${JSON.stringify(message.method)}, ${JSON.stringify(message.json)})`)
    }
  } catch (error) { fail(error) }
})
