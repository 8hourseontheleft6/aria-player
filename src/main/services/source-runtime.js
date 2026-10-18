'use strict'

const { Worker } = require('node:worker_threads')
const path = require('node:path')
const fs = require('node:fs')

const MAX_MESSAGE = 8 * 1024 * 1024
const CALL_TIMEOUT = 20000

/** 每个音源一个线程/QuickJS 堆；跨边界只传 JSON，不传宿主对象或回调。 */
async function createSourceRuntime (code, filename, request, { timeout = 4000, callTimeout = CALL_TIMEOUT } = {}) {
  if (Buffer.byteLength(code) > 2 * 1024 * 1024) throw new Error('音源脚本超过 2 MiB')
  const unpacked = path.join(process.resourcesPath || '', 'app.asar.unpacked', 'src', 'main', 'workers', 'music-source-worker.js')
  const workerFile = fs.existsSync(unpacked) ? unpacked : path.join(__dirname, '..', 'workers', 'music-source-worker.js')
  const worker = new Worker(workerFile, {
    workerData: {
      code, filename: path.basename(filename), maxMessage: MAX_MESSAGE,
      quickJsModule: require.resolve('quickjs-emscripten'),
      wasm: fs.readFileSync(require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm')),
      bufferModules: Object.fromEntries(Object.entries({ buffer: 'buffer/', 'base64-js': 'base64-js', ieee754: 'ieee754' })
        .map(([id, name]) => [id, fs.readFileSync(require.resolve(name), 'utf8')]))
    },
    resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 }
  })
  const pending = new Map()
  const requests = new Set()
  const lifetime = new AbortController()
  const lx = { inited: null, handlers: new Map(), errors: [] }
  let sequence = 0
  let closed = false

  function close (error = new Error('音源运行器已关闭')) {
    if (closed) return
    closed = true
    lifetime.abort()
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
    worker.terminate().catch(() => {})
  }

  function call (method, args, limit = method === 'search' ? Math.min(15000, callTimeout) : callTimeout) {
    if (closed) return Promise.reject(new Error('音源运行器已关闭，请重新加载音源'))
    if (pending.size >= 32) return Promise.reject(new Error('音源并发调用过多'))
    const json = JSON.stringify(args)
    if (Buffer.byteLength(json || '') > MAX_MESSAGE) return Promise.reject(new Error('音源参数过大'))
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => close(new Error(`音源执行超时（${limit}ms）`)), limit)
      pending.set(id, { resolve, reject, timer })
      worker.postMessage({ type: 'call', id, method, json })
    })
  }

  worker.on('error', close)
  worker.on('exit', () => close(new Error('音源工作线程已退出')))
  worker.on('message', async (message) => {
    if (closed) return
    if (!message || typeof message !== 'object') return close(new Error('音源消息格式无效'))
    if (message.type === 'fatal') return close(new Error(message.error))
    if (message.type === 'state') {
      if (!Array.isArray(message.events) || message.events.length > 128 ||
        message.events.some((event) => typeof event !== 'string' || event.length > 128)) {
        return close(new Error('音源状态格式无效'))
      }
      lx.inited = message.inited
      lx.handlers.clear()
      for (const event of message.events) lx.handlers.set(event, [(payload) => call('lx', [event, payload])])
      return
    }
    if (message.type === 'request') {
      if (requests.size >= 16) {
        worker.postMessage({ type: 'response', id: message.id, error: '音源并发网络请求过多' })
        return
      }
      requests.add(message.id)
      try {
        if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > MAX_MESSAGE) throw new Error('音源请求过大')
        const [url, options] = JSON.parse(message.json)
        const response = await request(url, options, lifetime.signal)
        const json = JSON.stringify({ ...response, raw: { __ariaBytes: response.raw.toString('base64') } })
        if (Buffer.byteLength(json) > MAX_MESSAGE) throw new Error('音源响应过大')
        if (!closed) worker.postMessage({ type: 'response', id: message.id, json })
      } catch (error) {
        if (!closed) worker.postMessage({ type: 'response', id: message.id, error: String(error.message || error) })
      } finally {
        requests.delete(message.id)
      }
      return
    }
    if (message.type === 'result') {
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) return item.reject(new Error(message.error))
      try {
        if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > MAX_MESSAGE) throw new Error('音源结果过大')
        item.resolve(JSON.parse(message.json))
      } catch (error) { item.reject(error) }
    }
  })
  worker.unref()

  try {
    const description = await call('init', [], timeout)
    const exported = description.module ? { ...description.metadata } : null
    if (exported) {
      for (const method of description.methods) {
        exported[method] = (input, options = {}) => call(method, [input, { limit: options.limit, quality: options.quality }])
      }
    }
    return { exported, lx, close, isClosed: () => closed }
  } catch (error) {
    close(error)
    throw error
  }
}

module.exports = { createSourceRuntime }
