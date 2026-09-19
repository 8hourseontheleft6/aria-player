'use strict'

/**
 * 在线音源（音源脚本）宿主。
 *
 * 设计取向，先说清楚：
 *
 *  · 这里只提供「机制」—— 加载、管理、运行**用户自己放进来的**音源脚本。
 *    本仓库不内置任何指向具体商业音乐服务的音源；没有音源时搜索结果就是空的，
 *    这正是「不添加音源就什么也搜不到」的行为。
 *  · 脚本在 vm 沙箱里执行，只能拿到显式提供的几个能力（request / crypto / zlib /
 *    buffer / URL / 定时器），拿不到 require、fs、process、Electron。
 *  · 音源脚本访问什么服务、是否合规，由使用者自己负责。
 *
 * 脚本目录：<userData>/music-sources/*.js
 *
 * 脚本接口（CommonJS）：
 *
 *   module.exports = {
 *     name: '示例音源',            // 显示名（缺省用文件名）
 *     version: '1.0.0',           // 可选
 *     description: '…',           // 可选
 *
 *     // 搜索。返回数组，字段能做多少填多少。
 *     async search (query, { limit, request, signal }) {
 *       return [{
 *         id: '…',                  // 音源内的唯一 id（用于解析播放地址）
 *         title: '歌名',
 *         artist: '艺人',
 *         album: '专辑',            // 可选
 *         duration: 245,            // 秒，可选
 *         quality: '320k',          // 可选
 *         payload: { … }            // 可选：原样存下来，resolveUrl 时还给你
 *       }]
 *     },
 *
 *     // 解析可播放地址（点「播放」时才调用）
 *     async resolveUrl (track, { quality, request, signal }) {
 *       return 'https://…'
 *     },
 *
 *     // 可选：歌词与封面
 *     async resolveLyrics? (track, api) { return { text: '[00:01.00]…' } },
 *     async resolveCover? (track, api) { return 'https://…' }
 *   }
 *
 * 沙箱里提供的 request：axios 风格的极简封装
 *   const res = await request('https://…', { method, headers, body/params, timeout, responseType })
 *   → { status, headers, body, raw }
 *   responseType: 'json'（默认，自动解析）/ 'text' / 'buffer'
 */

const { app, net } = require('electron')
const fsp = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { Buffer } = require('node:buffer')
const nodeStream = require('node:stream')

const USER_AGENT = 'Aria/0.0.0-dev (local music player)'
const SEARCH_TIMEOUT = 15000
const RESOLVE_TIMEOUT = 20000
const SOURCE_LOAD_TIMEOUT = 4000
const MAX_RESULTS_PER_SOURCE = 40

/** 文件名 → 稳定的音源 id */
function toId (file) {
  return path.basename(file, '.js')
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 60)
}

function createRequest (getSignal, defaultTimeout = 12000) {
  return async function request (url, options = {}) {
    const {
      method = 'GET',
      headers = {},
      body,
      params,
      timeout = defaultTimeout,
      responseType = 'json'
    } = options
    let target = String(url)
    if (params && typeof params === 'object') {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) search.append(key, String(value))
      }
      target += (target.includes('?') ? '&' : '?') + search.toString()
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const external = getSignal()
    const onAbort = () => controller.abort()
    if (external) external.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await net.fetch(target, {
        method,
        headers: { 'User-Agent': USER_AGENT, ...headers },
        body: body === undefined
          ? undefined
          : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: controller.signal
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      const type = response.headers.get('content-type') || ''
      let parsed = null
      if (responseType === 'json' || (responseType === 'auto' && type.includes('json'))) {
        try {
          parsed = JSON.parse(buffer.toString('utf8'))
        } catch {
          parsed = null
        }
      } else if (responseType === 'text') {
        parsed = buffer.toString('utf8')
      }
      return {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsed,
        raw: buffer
      }
    } finally {
      clearTimeout(timer)
      if (external) external.removeEventListener('abort', onAbort)
    }
  }
}

function createMusicSourcesService (ctx) {
  const settings = ctx.get('settings')
  const dir = path.join(app.getPath('userData'), 'music-sources')

  /** @type {Map<string, { id, file, name, description, version, module, error, mtimeMs }>} */
  const loaded = new Map()
  let loadedOnce = false
  /** 每个音源的调用统计（本次会话内；用来在设置里看哪个音源好用） */
  const stats = { calls: {}, downloads: 0 }

  function bump (id, field, extra = {}) {
    const key = String(id || '?')
    const entry = stats.calls[key] || { search: 0, ok: 0, failed: 0, lastMs: 0, lastError: null }
    entry[field] = (entry[field] || 0) + 1
    Object.assign(entry, extra)
    stats.calls[key] = entry
  }

  const enabledMap = () => {
    const value = settings.get().musicSources
    return value && typeof value === 'object' ? value : {}
  }
  const isEnabled = (id) => enabledMap()[id]?.enabled !== false

  async function ensureDir () {
    await fsp.mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * 把脚本代码装进沙箱并执行，拿到它的 module.exports。
   *
   * 同时提供一套 **LX Music 自定义源兼容宿主**：LX 的音源脚本不导出对象，
   * 而是通过全局 `lx` 用事件协议跟宿主通信（文档：
   * https://lxmusic.toside.cn/desktop/custom-source）。它们第一句通常就是
   * `const { EVENT_NAMES, request, on, send } = globalThis.lx` ——
   * 没有这个全局就会直接抛 "Cannot destructure property 'EVENT_NAMES'"。
   *
   * 注意（很重要）：按官方规范，LX 音源只负责 `musicUrl` / `lyric` / `pic`，
   * **不负责搜索**（搜索是 LX 客户端自己用内置源做的）。所以这类脚本在我们这里
   * 只能当解析器，不会产生搜索结果，界面上会明确标出来。
   */
  function evaluate (code, file) {
    const lxState = {
      inited: null,
      handlers: new Map(),
      errors: []
    }

    const lxEvents = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

    const emitToScript = (event, payload) => {
      const list = lxState.handlers.get(event) || []
      return list.map((handler) => handler(payload))
    }

    const lxHost = {
      EVENT_NAMES: lxEvents,
      version: '2.0.0',
      env: 'desktop',
      currentScriptInfo: {
        name: path.basename(file, '.js'),
        description: '',
        version: ''
      },
      on (event, handler) {
        if (typeof handler !== 'function') return
        const list = lxState.handlers.get(event) || []
        list.push(handler)
        lxState.handlers.set(event, list)
      },
      off (event, handler) {
        const list = lxState.handlers.get(event) || []
        lxState.handlers.set(event, list.filter((item) => item !== handler))
      },
      send (event, payload) {
        if (event === lxEvents.inited) lxState.inited = payload || {}
        return true
      },
      // 旧版回调风格：lx.request(url, options, (err, response, body) => {})
      request (url, options, callback) {
        const promise = createRequest(() => null)(url, options || {})
        if (typeof callback === 'function') {
          promise.then(
            (response) => callback(null, response, response.body),
            (err) => callback(err)
          )
          return undefined
        }
        return promise
      },
      utils: {
        crypto: {
          createHash: (...args) => crypto.createHash(...args),
          createHmac: (...args) => crypto.createHmac(...args),
          randomBytes: (...args) => crypto.randomBytes(...args),
          md5: (data) => crypto.createHash('md5').update(data).digest('hex'),
          aesEncrypt: (buffer, mode, key, iv) => {
            const cipher = crypto.createCipheriv(mode, key, iv)
            return Buffer.concat([cipher.update(buffer), cipher.final()])
          },
          rsaEncrypt: (buffer, key) => crypto.publicEncrypt(key, buffer),
          randomBytes: (size) => crypto.randomBytes(size)
        },
        buffer: {
          from: (...args) => Buffer.from(...args),
          bufToString: (buffer, format) => Buffer.from(buffer).toString(format)
        }
      }
    }

    const sandbox = {
      module: { exports: {} },
      exports: {},
      lx: lxHost,
      console: {
        log: (...args) => console.log(`[source:${path.basename(file)}]`, ...args),
        warn: (...args) => console.warn(`[source:${path.basename(file)}]`, ...args),
        error: (...args) => console.error(`[source:${path.basename(file)}]`, ...args)
      },
      Buffer,
      URL,
      URLSearchParams,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      crypto: {
        createHash: (...args) => crypto.createHash(...args),
        createHmac: (...args) => crypto.createHmac(...args),
        randomBytes: (...args) => crypto.randomBytes(...args),
        randomUUID: () => crypto.randomUUID()
      },
      zlib: {
        gzipSync: (...args) => zlib.gzipSync(...args),
        gunzipSync: (...args) => zlib.gunzipSync(...args),
        inflateSync: (...args) => zlib.inflateSync(...args),
        deflateSync: (...args) => zlib.deflateSync(...args)
      },
      request: createRequest(() => null)
    }
    sandbox.global = sandbox
    sandbox.globalThis = sandbox
    const context = vm.createContext(sandbox)
    const script = new vm.Script(code, { filename: file })
    // timeout 只管同步执行；异步部分由调用方的墙钟超时兜住
    script.runInContext(context, { timeout: SOURCE_LOAD_TIMEOUT })
    const exported = sandbox.module.exports
    const fromModule = exported && typeof exported === 'object' && Object.keys(exported).length > 0
      ? exported
      : (sandbox.exports && Object.keys(sandbox.exports).length > 0 ? sandbox.exports : null)

    return { exported: fromModule, lx: lxState }
  }

  /** LX 音源声明的子音源（{ key: { name, type, actions, qualitys } }） */
  function lxSourcesOf (entry) {
    const declared = entry.lx?.inited?.sources
    if (!declared || typeof declared !== 'object') return []
    return Object.entries(declared).map(([key, value]) => ({
      key,
      name: String(value?.name || key),
      type: String(value?.type || 'music'),
      actions: Array.isArray(value?.actions) ? value.actions.map(String) : [],
      qualitys: Array.isArray(value?.qualitys) ? value.qualitys.map(String) : []
    }))
  }

  /** 往 LX 音源派发一次 request（官方协议：{ source, action, info }） */
  async function lxRequest (entry, { source, action, info }) {
    const handlers = entry.lx?.handlers?.get('request') || []
    if (!handlers.length) throw new Error('该脚本没有注册 request 处理器')
    const payload = { source, action, info }
    let lastError = null
    for (const handler of handlers) {
      try {
        const result = await handler(payload)
        if (result !== undefined && result !== null) return result
      } catch (err) {
        lastError = err
      }
    }
    if (lastError) throw lastError
    throw new Error(`音源没有对 ${action} 返回结果`)
  }

  function describe (entry) {
    const mod = entry.module || {}
    const lxSources = entry.lx ? lxSourcesOf(entry) : []
    return {
      id: entry.id,
      file: path.basename(entry.file),
      name: String(mod.name || entry.lx?.inited?.name || entry.id),
      description: String(mod.description || (lxSources.length
        ? `LX 音乐音源：声明了 ${lxSources.map((item) => item.name).join('、')}；按官方规范它只提供解析，不含搜索`
        : '')),
      version: String(mod.version || ''),
      enabled: isEnabled(entry.id),
      error: entry.error || null,
      // 'module' = 本项目接口；'lx' = LX 音乐自定义源（只解析，不搜索）
      kind: mod.search || mod.resolveUrl ? 'module' : 'lx',
      lxSources: lxSources.map((item) => ({
        key: item.key,
        name: item.name,
        type: item.type,
        actions: item.actions,
        qualitys: item.qualitys
      })),
      capabilities: {
        search: typeof mod.search === 'function',
        resolveUrl: typeof mod.resolveUrl === 'function' || Boolean(entry.lx?.inited),
        lyrics: typeof mod.resolveLyrics === 'function' || Boolean(entry.lx?.inited),
        cover: typeof mod.resolveCover === 'function'
      }
    }
  }

  /** 扫描目录并装载全部音源（可重复调用，按 mtime 判断是否需要重载） */
  async function load () {
    await ensureDir()
    let files = []
    try {
      files = (await fsp.readdir(dir)).filter((name) => name.toLowerCase().endsWith('.js'))
    } catch {
      files = []
    }
    const seen = new Set()
    for (const name of files) {
      const file = path.join(dir, name)
      const id = toId(name)
      seen.add(id)
      let stat = null
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      const existing = loaded.get(id)
      if (existing && existing.mtimeMs === Math.round(stat.mtimeMs)) continue

      const entry = {
        id,
        file,
        name: id,
        description: '',
        version: '',
        module: null,
        lx: null,
        error: null,
        mtimeMs: Math.round(stat.mtimeMs)
      }
      try {
        const code = await fsp.readFile(file, 'utf8')
        const result = evaluate(code, file)
        const isModuleStyle = result.exported &&
          (typeof result.exported.search === 'function' || typeof result.exported.resolveUrl === 'function')
        // LX 风格：脚本通过 send(inited, …) 声明自己支持的源
        const isLxStyle = Boolean(result.lx?.inited)
        if (!isModuleStyle && !isLxStyle) {
          if (result.lx?.inited === null && (result.lx?.handlers?.get('request')?.length || 0) > 0) {
            throw new Error('脚本注册了 request 处理器，但没有发送 inited 事件（LX 音源需要在初始化后 send(EVENT_NAMES.inited, …)）')
          }
          throw new Error('无法识别的音源脚本：既没有导出 { search, resolveUrl }，也不是 LX 音乐的自定义源')
        }
        if (isLxStyle && result.lx.inited.status === false) {
          throw new Error(`脚本自报初始化失败${result.lx.inited.message ? `：${result.lx.inited.message}` : ''}`)
        }
        entry.module = isModuleStyle ? result.exported : null
        entry.lx = result.lx
      } catch (err) {
        entry.error = String(err?.message || err)
        console.warn(`[sources] ${name} 装载失败：${entry.error}`)
      }
      loaded.set(id, entry)
    }
    // 目录里已经没有的，清掉
    for (const id of [...loaded.keys()]) {
      if (!seen.has(id)) loaded.delete(id)
    }
    loadedOnce = true
    return list()
  }

  function list () {
    return [...loaded.values()].map(describe)
  }

  function setEnabled (id, enabled) {
    const next = { ...enabledMap() }
    next[id] = { ...(next[id] || {}), enabled: Boolean(enabled) }
    settings.set({ musicSources: next })
    return list()
  }

  /** 一次开关所有音源（多音源管理里最常用的操作） */
  function setAllEnabled (enabled) {
    const next = { ...enabledMap() }
    for (const entry of loaded.values()) {
      next[entry.id] = { ...(next[entry.id] || {}), enabled: Boolean(enabled) }
    }
    settings.set({ musicSources: next })
    return list()
  }

  async function install (scriptText, suggestedName = '') {
    const code = String(scriptText || '')
    if (!code.trim()) throw new Error('脚本内容是空的')
    const base = (suggestedName || `source-${Date.now()}`)
      .replace(/\.js$/i, '')
      .replace(/[^\w.-]+/g, '-')
      .slice(0, 60) || `source-${Date.now()}`
    await ensureDir()
    const file = path.join(dir, `${base}.js`)
    // 先验证能装载再落盘，避免把坏脚本留在目录里
    const result = evaluate(code, file)
    const isModuleStyle = result.exported &&
      (typeof result.exported.search === 'function' || typeof result.exported.resolveUrl === 'function')
    const isLxStyle = Boolean(result.lx?.inited)
    if (!isModuleStyle && !isLxStyle) {
      throw new Error(
        '无法识别的音源脚本：既没有导出 { search, resolveUrl }，也没有按 LX 音乐的规范 ' +
        '发送 inited 事件（LX 音源需要在初始化后 send(EVENT_NAMES.inited, …)）'
      )
    }
    await fsp.writeFile(file, code, 'utf8')
    await load()
    return {
      id: toId(`${base}.js`),
      kind: isLxStyle && !isModuleStyle ? 'lx' : 'module',
      name: String(result.exported?.name || result.lx?.inited?.name || base)
    }
  }

  async function remove (id) {
    const entry = loaded.get(id)
    if (entry) {
      try {
        await fsp.rm(entry.file, { force: true })
      } catch {
        // 文件可能已经被手动删了
      }
      loaded.delete(id)
    }
    const next = { ...enabledMap() }
    delete next[id]
    settings.set({ musicSources: next })
    return list()
  }

  function withTimeout (promise, ms, label) {
    let timer = null
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
      })
    ]).finally(() => { if (timer) clearTimeout(timer) })
  }

  /**
   * 在所有启用的音源里搜索。
   * 单个音源失败/超时只影响它自己，结果里通过 perSource 报出来。
   */
  async function search (query, options = {}) {
    const text = String(query || '').trim()
    if (!text) return { results: [], perSource: [], elapsedMs: 0 }
    if (!loadedOnce) await load()
    const limit = Math.max(1, Math.min(100, Number(options.limit) || MAX_RESULTS_PER_SOURCE))
    const only = Array.isArray(options.sources) && options.sources.length ? new Set(options.sources) : null

    const targets = [...loaded.values()].filter((entry) => {
      if (only && !only.has(entry.id)) return false
      if (!isEnabled(entry.id)) return false
      return typeof entry.module?.search === 'function'
    })

    // LX 音源按官方规范不提供搜索：这里把它们单独列出来，让界面能说清「为什么没结果」
    const resolverOnly = [...loaded.values()]
      .filter((entry) => !only || only.has(entry.id))
      .filter((entry) => isEnabled(entry.id) && typeof entry.module?.search !== 'function' && entry.lx?.inited)
      .map((entry) => ({
        id: entry.id,
        name: describe(entry).name,
        count: 0,
        elapsedMs: 0,
        error: null,
        skipped: 'lx-resolver-only',
        note: 'LX 音乐音源：按官方规范只提供解析（musicUrl / lyric / pic），搜索由客户端自己完成，所以这里不会出结果'
      }))

    const started = performance.now()
    const controller = new AbortController()
    const perSource = await Promise.all(targets.map(async (entry) => {
      const began = performance.now()
      bump(entry.id, 'search')
      try {
        const raw = await withTimeout(
          Promise.resolve(entry.module.search(text, {
            limit,
            request: createRequest(() => controller.signal),
            signal: controller.signal
          })),
          SEARCH_TIMEOUT,
          `${describe(entry).name} 搜索`
        )
        const list = Array.isArray(raw) ? raw : []
        const elapsed = Math.round((performance.now() - began) * 100) / 100
        bump(entry.id, 'ok', { lastMs: elapsed, lastError: null })
        return {
          id: entry.id,
          name: describe(entry).name,
          count: list.length,
          elapsedMs: elapsed,
          error: null,
          results: list.slice(0, limit)
        }
      } catch (err) {
        const message = String(err?.message || err)
        bump(entry.id, 'failed', { lastError: message })
        return {
          id: entry.id,
          name: describe(entry).name,
          count: 0,
          elapsedMs: Math.round((performance.now() - began) * 100) / 100,
          error: message,
          results: []
        }
      }
    }))


    // 汇总：给每条结果标上来源，并生成一个全局 id（列表渲染 / 解析时用）
    const results = []
    for (const source of perSource) {
      for (const item of source.results) {
        if (!item || typeof item !== 'object') continue
        const title = String(item.title || item.name || '').trim()
        if (!title) continue
        results.push({
          uid: `${source.id}:${String(item.id ?? results.length)}`,
          sourceId: source.id,
          sourceName: source.name,
          sourceTrackId: item.id ?? null,
          title,
          artist: String(item.artist || item.singer || ''),
          album: String(item.album || ''),
          duration: Number(item.duration) || 0,
          quality: String(item.quality || item.rate || ''),
          payload: item.payload ?? null
        })
      }
    }

    return {
      results,
      perSource: [
        ...perSource.map(({ results: _dropped, ...rest }) => rest),
        ...resolverOnly
      ],
      elapsedMs: Math.round((performance.now() - started) * 100) / 100
    }
  }

  /**
   * 解析某条结果的播放地址。
   *
   * 支持两种脚本：
   *   · 本项目接口：module.exports.resolveUrl(track, api)
   *   · LX 音乐自定义源：把 track.payload.lx（{ source, musicInfo }）按官方协议
   *     派发成 request({ source, action: 'musicUrl', info: { type, musicInfo } })
   */
  async function resolveUrl (input = {}) {
    if (!loadedOnce) await load()
    const entry = loaded.get(String(input.sourceId || ''))
    if (!entry?.module && !entry?.lx?.inited) throw new Error('音源不存在或未成功装载')
    const controller = new AbortController()
    const track = {
      id: input.sourceTrackId ?? null,
      title: input.title || '',
      artist: input.artist || '',
      album: input.album || '',
      duration: input.duration || 0,
      quality: input.quality || '',
      payload: input.payload ?? null
    }

    if (typeof entry.module?.resolveUrl !== 'function' && entry.lx?.inited) {
      const lxInfo = track.payload?.lx
      if (!lxInfo?.musicInfo) {
        throw new Error(
          '这是 LX 音乐音源：它只能解析「LX 搜索结果里的歌曲信息」，' +
          '而本项目没有 LX 内置搜索，所以拿不到可解析的对象'
        )
      }
      const output = await withTimeout(
        lxRequest(entry, {
          source: lxInfo.source || track.payload?.source,
          action: 'musicUrl',
          info: { type: input.quality || '320k', musicInfo: lxInfo.musicInfo }
        }),
        RESOLVE_TIMEOUT,
        `${describe(entry).name} 解析地址`
      )
      const url = typeof output === 'string' ? output : String(output?.url || '')
      if (!/^https?:/i.test(url)) throw new Error('音源没有返回可用的 http(s) 地址')
      return { url, headers: null, sourceId: entry.id, sourceName: describe(entry).name, title: track.title, artist: track.artist }
    }

    const output = await withTimeout(
      Promise.resolve(entry.module.resolveUrl(track, {
        quality: input.quality || '320k',
        request: createRequest(() => controller.signal),
        signal: controller.signal
      })),
      RESOLVE_TIMEOUT,
      `${describe(entry).name} 解析地址`
    )
    // 音源既可以只返回字符串，也可以返回 { url, headers } 用来带上 Referer 之类的请求头
    const url = typeof output === 'string' ? output : String(output?.url || '')
    if (!/^https?:/i.test(url)) {
      throw new Error('音源没有返回可用的 http(s) 地址')
    }
    const headers = (output && typeof output === 'object' && output.headers) || null
    return {
      url,
      headers,
      sourceId: entry.id,
      sourceName: describe(entry).name,
      title: track.title,
      artist: track.artist
    }
  }

  /** 音源提供的歌词（可选接口；LX 音源走官方协议的 lyric 动作） */
  async function resolveLyrics (input = {}) {
    if (!loadedOnce) await load()
    const entry = loaded.get(String(input.sourceId || ''))
    const controller = new AbortController()

    if (typeof entry?.module?.resolveLyrics !== 'function' && entry?.lx?.inited) {
      const lxInfo = input.payload?.lx
      if (!lxInfo?.musicInfo) return null
      const output = await withTimeout(
        lxRequest(entry, {
          source: lxInfo.source || input.payload?.source,
          action: 'lyric',
          info: { musicInfo: lxInfo.musicInfo }
        }),
        RESOLVE_TIMEOUT,
        `${describe(entry).name} 取歌词`
      )
      const text = typeof output === 'string'
        ? output
        : String(output?.lyric || output?.tlyric || output?.lxlyric || '')
      if (!text.trim()) return null
      return { text, sourceId: entry.id, sourceName: describe(entry).name }
    }

    if (!entry?.module || typeof entry.module.resolveLyrics !== 'function') return null
    const text = await withTimeout(
      Promise.resolve(entry.module.resolveLyrics({
        id: input.sourceTrackId ?? null,
        title: input.title || '',
        artist: input.artist || '',
        album: input.album || '',
        duration: input.duration || 0,
        payload: input.payload ?? null
      }, { request: createRequest(() => controller.signal), signal: controller.signal })),
      RESOLVE_TIMEOUT,
      `${describe(entry).name} 取歌词`
    )
    const raw = typeof text === 'string' ? text : String(text?.text || '')
    if (!raw.trim()) return null
    return { text: raw, sourceId: entry.id, sourceName: describe(entry).name }
  }

  /* ================================================================ */
  /* 链接导入 / 下载                                                     */
  /* ================================================================ */

  /** 从链接把音源脚本抓下来并安装（脚本内容直接落盘，不经过渲染层） */
  async function installFromUrl (url) {
    const target = String(url || '').trim()
    if (!/^https?:\/\//i.test(target)) throw new Error('请填写 http(s) 开头的脚本地址')
    const response = await net.fetch(target, { headers: { 'User-Agent': USER_AGENT } })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const text = await response.text()
    if (!text.trim()) throw new Error('链接返回的内容是空的')
    const guessed = decodeURIComponent(target.split('/').pop() || '').split('?')[0] || 'source'
    return install(text, guessed.replace(/\.js$/i, ''))
  }

  function sanitizeName (value, fallback) {
    const cleaned = String(value || '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
    return (cleaned || fallback).slice(0, 120)
  }

  /** 默认下载目录：设置里指定的，否则第一个音乐文件夹 */
  function defaultDownloadDir () {
    const configured = String(settings.get().downloadDir || '').trim()
    if (configured) return configured
    const folders = settings.get().folders || []
    if (folders.length) return folders[0]
    return path.join(app.getPath('music'), 'Aria 下载')
  }

  /**
   * 把一条在线结果下载到目录。
   * 下载进资料库目录的话，目录监听会自动把它收进资料库（不用再手动扫描）。
   */
  async function download (input = {}, onProgress) {
    const dir = String(input.dir || '').trim() || defaultDownloadDir()
    await fsp.mkdir(dir, { recursive: true })
    const resolved = await resolveUrl(input)
    const response = await net.fetch(resolved.url, {
      headers: { 'User-Agent': USER_AGENT, ...(resolved.headers || {}) }
    })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)

    const total = Number(response.headers.get('content-length')) || 0
    const ext = (() => {
      const fromUrl = (resolved.url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [])[1]
      if (fromUrl && /^(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i.test(fromUrl)) return fromUrl.toLowerCase()
      const mime = response.headers.get('content-type') || ''
      if (/mpeg/i.test(mime)) return 'mp3'
      if (/flac/i.test(mime)) return 'flac'
      if (/mp4|aac/i.test(mime)) return 'm4a'
      if (/ogg/i.test(mime)) return 'ogg'
      return 'mp3'
    })()

    const base = sanitizeName(
      [resolved.artist, resolved.title].filter(Boolean).join(' - '),
      `在线音乐-${Date.now()}`
    )
    let file = path.join(dir, `${base}.${ext}`)
    let index = 1
    while (await fsp.stat(file).then(() => true).catch(() => false)) {
      file = path.join(dir, `${base} (${index++}).${ext}`)
    }

    const { Readable } = nodeStream
    const writeStream = (await fsp.open(file, 'w')).createWriteStream()
    let received = 0
    let lastReport = 0
    try {
      const readable = Readable.fromWeb(response.body)
      readable.on('data', (chunk) => {
        received += chunk.length
        const now = Date.now()
        if (typeof onProgress === 'function' && now - lastReport > 120) {
          lastReport = now
          onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null })
        }
      })
      await nodeStream.promises.pipeline(readable, writeStream)
    } catch (err) {
      await fsp.rm(file, { force: true }).catch(() => {})
      throw err
    }
    if (typeof onProgress === 'function') {
      onProgress({ received, total, percent: 100, done: true })
    }
    return {
      path: file,
      dir,
      bytes: received,
      sourceName: resolved.sourceName,
      title: resolved.title,
      artist: resolved.artist,
      inLibrary: (settings.get().folders || []).some((folder) => file.startsWith(folder))
    }
  }

  return {
    async init () {
      await load()
      return list()
    },
    load,
    list,
    setEnabled,
    setAllEnabled,
    install,
    installFromUrl,
    remove,
    search,
    resolveUrl,
    resolveLyrics,
    download,
    defaultDownloadDir,
    getDir: () => dir,
    getStats: () => ({
      dir,
      total: loaded.size,
      enabled: list().filter((item) => item.enabled).length,
      failed: list().filter((item) => item.error).length,
      calls: { ...stats.calls },
      downloads: stats.downloads
    })
  }
}

module.exports = { createMusicSourcesService }
