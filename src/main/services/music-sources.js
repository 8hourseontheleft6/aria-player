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

  /** 把脚本代码装进沙箱并执行，拿到它的 module.exports */
  function evaluate (code, file) {
    const sandbox = {
      module: { exports: {} },
      exports: {},
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
    if (exported && typeof exported === 'object' && Object.keys(exported).length === 0) {
      return sandbox.exports
    }
    return exported
  }

  function describe (entry) {
    const mod = entry.module || {}
    return {
      id: entry.id,
      file: path.basename(entry.file),
      name: String(mod.name || entry.id),
      description: String(mod.description || ''),
      version: String(mod.version || ''),
      enabled: isEnabled(entry.id),
      error: entry.error || null,
      capabilities: {
        search: typeof mod.search === 'function',
        resolveUrl: typeof mod.resolveUrl === 'function',
        lyrics: typeof mod.resolveLyrics === 'function',
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

      const entry = { id, file, name: id, description: '', version: '', module: null, error: null, mtimeMs: Math.round(stat.mtimeMs) }
      try {
        const code = await fsp.readFile(file, 'utf8')
        const exported = evaluate(code, file)
        if (!exported || typeof exported !== 'object') {
          throw new Error('脚本没有导出对象（应当 module.exports = { search, resolveUrl }）')
        }
        if (typeof exported.search !== 'function' && typeof exported.resolveUrl !== 'function') {
          throw new Error('脚本既没有 search 也没有 resolveUrl')
        }
        entry.module = exported
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
    const exported = evaluate(code, file)
    if (!exported || typeof exported !== 'object') throw new Error('脚本没有导出对象')
    if (typeof exported.search !== 'function' && typeof exported.resolveUrl !== 'function') {
      throw new Error('脚本既没有 search 也没有 resolveUrl')
    }
    await fsp.writeFile(file, code, 'utf8')
    await load()
    return { id: toId(`${base}.js`), name: String(exported.name || base) }
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
      perSource: perSource.map(({ results: _dropped, ...rest }) => rest),
      elapsedMs: Math.round((performance.now() - started) * 100) / 100
    }
  }

  /** 解析某条结果的播放地址 */
  async function resolveUrl (input = {}) {
    if (!loadedOnce) await load()
    const entry = loaded.get(String(input.sourceId || ''))
    if (!entry?.module) throw new Error('音源不存在或未成功装载')
    if (typeof entry.module.resolveUrl !== 'function') throw new Error('该音源没有提供 resolveUrl')
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

  /** 音源提供的歌词（可选接口） */
  async function resolveLyrics (input = {}) {
    if (!loadedOnce) await load()
    const entry = loaded.get(String(input.sourceId || ''))
    if (!entry?.module || typeof entry.module.resolveLyrics !== 'function') return null
    const controller = new AbortController()
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
