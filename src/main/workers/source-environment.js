/* 在 QuickJS 内部执行。这里没有 Node、Electron、宿主 Function 或宿主对象。 */
'use strict';

(() => {
  const syncBridge = globalThis.__ariaSync
  const sendBridge = globalThis.__ariaSend
  const requestBridge = globalThis.__ariaRequest
  const timerBridge = globalThis.__ariaTimer
  delete globalThis.__ariaSync
  delete globalThis.__ariaSend
  delete globalThis.__ariaRequest
  delete globalThis.__ariaTimer

  const encode = (value) => {
    if (value instanceof Uint8Array) return { __ariaBytes: Buffer.from(value).toString('base64') }
    if (Array.isArray(value)) return value.map(encode)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]))
    return value
  }
  const decode = (value) => {
    if (value && typeof value.__ariaBytes === 'string') return Buffer.from(value.__ariaBytes, 'base64')
    if (Array.isArray(value)) return value.map(decode)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]))
    return value
  }
  const sync = (name, args) => {
    const response = JSON.parse(syncBridge(name, JSON.stringify(encode(args))))
    if (!response.ok) throw new Error(response.error)
    return decode(response.value)
  }
  const send = (message) => sendBridge(JSON.stringify(message))
  const request = async (url, options = {}) => {
    const response = decode(JSON.parse(await requestBridge(JSON.stringify([String(url), encode(options)]))))
    if (response.error) throw new Error(response.error)
    return response
  }

  const handlers = new Map()
  let inited = null
  const state = () => send({ type: 'state', inited, events: [...handlers.keys()] })
  const hash = (algorithm, key = null) => {
    const chunks = []
    return {
      update (data, encoding) { chunks.push(Buffer.from(data, encoding)); return this },
      digest (encoding) { return sync('hash', [algorithm, key, chunks, encoding]) }
    }
  }
  const crypto = {
    createHash: (name) => hash(name),
    createHmac: (name, key) => hash(name, key),
    randomBytes: (size) => sync('random', [size]),
    randomUUID: () => sync('uuid', [])
  }
  globalThis.crypto = crypto
  globalThis.zlib = Object.fromEntries(['gzipSync', 'gunzipSync', 'inflateSync', 'deflateSync'].map((name) =>
    [name, (data) => sync('zlib', [name, data])]))
  globalThis.request = request
  globalThis.module = { exports: {} }
  globalThis.exports = globalThis.module.exports
  globalThis.global = globalThis
  // 不把脚本日志写入主进程，避免第三方脚本污染应用日志。
  globalThis.console = { log () {}, warn () {}, error () {} }
  globalThis.lx = {
    EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
    version: '2.0.0', env: 'desktop', currentScriptInfo: { name: '', description: '', version: '' },
    on (event, handler) {
      if (typeof handler !== 'function') return
      const list = handlers.get(event) || []
      list.push(handler); handlers.set(event, list); state()
    },
    off (event, handler) {
      handlers.set(event, (handlers.get(event) || []).filter((item) => item !== handler)); state()
    },
    send (event, payload) { if (event === 'inited') { inited = payload || {}; state() }; return true },
    request (url, options, callback) {
      const promise = request(url, options)
      if (typeof callback !== 'function') return promise
      promise.then((response) => callback(null, response, response.body), (error) => callback(error))
    },
    utils: {
      crypto: {
        ...crypto,
        md5: (data) => hash('md5').update(data).digest('hex'),
        aesEncrypt: (data, mode, key, iv) => sync('aes', [data, mode, key, iv]),
        rsaEncrypt: (data, key) => sync('rsa', [data, key])
      },
      buffer: { from: (...args) => Buffer.from(...args), bufToString: (data, format) => Buffer.from(data).toString(format) }
    }
  }

  let timerId = 0
  const timers = new Map()
  const schedule = (fn, delay, repeat, args) => {
    if (typeof fn !== 'function') throw new TypeError('定时器需要函数')
    const id = ++timerId
    timers.set(id, { fn, delay, repeat, args })
    timerBridge(id, Number(delay) || 1, 0)
    return id
  }
  globalThis.setTimeout = (fn, delay, ...args) => schedule(fn, delay, false, args)
  globalThis.setInterval = (fn, delay, ...args) => schedule(fn, delay, true, args)
  globalThis.clearTimeout = globalThis.clearInterval = (id) => { timers.delete(id); timerBridge(id, 0, 1) }
  globalThis.__ariaFireTimer = (id) => {
    const timer = timers.get(id)
    if (!timer) return
    if (!timer.repeat) timers.delete(id)
    timer.fn(...timer.args)
    if (timer.repeat && timers.has(id)) timerBridge(id, Number(timer.delay) || 1, 0)
  }

  class SourceSearchParams {
    constructor (input = '', change = () => {}) {
      this.items = sync('params', [input instanceof SourceSearchParams ? input.toString() : input])
      this.change = change
    }
    append (key, value) { this.items.push([String(key), String(value)]); this.change(this.toString()) }
    set (key, value) {
      key = String(key); value = String(value)
      const at = this.items.findIndex((item) => item[0] === key)
      this.items = this.items.filter((item, i) => item[0] !== key || i === at)
      if (at < 0) this.items.push([key, value]); else this.items[at][1] = value
      this.change(this.toString())
    }
    get (key) { return this.items.find((item) => item[0] === String(key))?.[1] ?? null }
    getAll (key) { return this.items.filter((item) => item[0] === String(key)).map((item) => item[1]) }
    has (key) { return this.get(key) !== null }
    delete (key) { this.items = this.items.filter((item) => item[0] !== String(key)); this.change(this.toString()) }
    sort () { this.items.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0); this.change(this.toString()) }
    entries () { return this.items[Symbol.iterator]() }
    keys () { return this.items.map((item) => item[0])[Symbol.iterator]() }
    values () { return this.items.map((item) => item[1])[Symbol.iterator]() }
    forEach (fn, self) { for (const [key, value] of this.items) fn.call(self, value, key, this) }
    get size () { return this.items.length }
    [Symbol.iterator] () { return this.entries() }
    toString () {
      const escape = (value) => encodeURIComponent(value).replace(/%20/g, '+').replace(/[!'()~]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase())
      return this.items.map(([key, value]) => escape(key) + '=' + escape(value)).join('&')
    }
  }
  class SourceURL {
    constructor (input, base) {
      this.data = sync('url', [String(input), base === undefined ? null : String(base)])
      this.searchParams = new SourceSearchParams(this.data.search, (value) => { this.search = value })
    }
    toString () { return this.href }
    toJSON () { return this.href }
  }
  for (const key of ['href', 'origin', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
    Object.defineProperty(SourceURL.prototype, key, {
      get () { return this.data[key] },
      set (value) {
        this.data = sync('url', [this.href, null, key, value])
        this.searchParams.items = sync('params', [this.data.search])
      }
    })
  }
  globalThis.URL = SourceURL
  globalThis.URLSearchParams = SourceSearchParams
  globalThis.TextDecoder = class {
    constructor (label = 'utf-8', options = {}) { this.label = label; this.options = options }
    decode (data = new Uint8Array()) { return sync('decode', [this.label, this.options, data]) }
  }
  globalThis.TextEncoder = class { encode (text = '') { return new Uint8Array(Buffer.from(String(text), 'utf8')) } }

  const methods = ['search', 'resolveUrl', 'resolveLyrics', 'resolveCover']
  const exported = () => Object.keys(module.exports || {}).length ? module.exports : exports
  globalThis.__ariaSetName = (name) => { lx.currentScriptInfo.name = name }
  globalThis.__ariaCall = async (id, method, json) => {
    try {
      const args = JSON.parse(json)
      const mod = exported()
      let value
      if (method === 'init') {
        const names = methods.filter((key) => typeof mod?.[key] === 'function')
        value = { module: names.length > 0, methods: names, metadata: {
          name: String(mod?.name || ''), version: String(mod?.version || ''), description: String(mod?.description || '')
        } }
        state()
      } else if (method === 'lx') {
        let error
        for (const fn of handlers.get(args[0]) || []) {
          try { value = await fn(args[1]); if (value !== undefined && value !== null) break } catch (caught) { error = caught }
        }
        if (value === undefined && error) throw error
      } else if (methods.includes(method) && typeof mod?.[method] === 'function') {
        value = await mod[method](args[0], { ...args[1], request, signal: { aborted: false, addEventListener () {}, removeEventListener () {} } })
      } else throw new Error('不支持的音源调用')
      send({ type: 'result', id, json: JSON.stringify(value ?? null) })
    } catch (error) {
      send({ type: 'result', id, error: String(error.message || error) })
    }
  }
})()
