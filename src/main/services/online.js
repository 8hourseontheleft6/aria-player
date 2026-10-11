'use strict'

/**
 * 在线补全服务：歌词（LRCLIB）与封面（Deezer / iTunes）。
 *
 * 设计要点：
 *  - 全部请求在主进程发出，渲染层只拿到文本或图片字节，
 *    因此渲染层的 CSP 不需要放开 connect-src，仍保持「不能联网」
 *  - 磁盘缓存放在 userData/online-cache，命中就不再请求
 *  - 未命中（404）也缓存，24 小时内不重复问同一首
 *  - 串行 + 最小间隔，避免对公共 API 造成压力
 *  - 默认整体关闭，由设置里的总开关控制
 */

const { app, net } = require('electron')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const USER_AGENT = 'Aria/0.0.0-dev (local music player; https://github.com/)'
const NEGATIVE_TTL = 24 * 60 * 60 * 1000
const MIN_INTERVAL = 350

function hashKey (...parts) {
  return crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 24)
}

function createOnlineService (ctx) {
  const settings = ctx.get('settings')
  const cacheRoot = path.join(app.getPath('userData'), 'online-cache')

  let queue = Promise.resolve()
  let lastRequestAt = 0
  /*
   * 艺人头像的缓存目录特意带版本号。
   *
   * 原因：beta.5 那版维基解析写错（漏了 requestJson 的 { data: ... } 包装层），
   * 于是每个艺人都被写进一条 notFound，而 notFound 在 TTL 内会被原样返回 ——
   * 升级到修好的版本后头像依然取不到（用户反馈过「还是没有照片」）。
   * 换目录名就能让这些被污染的负缓存彻底失效；这个接口以后再改语义，同样换个后缀。
   */
  const ARTIST_CACHE = 'artists2'
  /** 维基在部分网络下会被中间设备劫持成 HTML / 直接挂住：首次连接失败就整场会话不再尝试 */
  let wikiDisabled = false
  /** Deezer 在部分网络下完全不可达：首次连接失败就整场会话不再尝试 */
  let deezerDisabled = false
  const stats = { lyrics: { hit: 0, miss: 0, error: 0 }, covers: { hit: 0, miss: 0, error: 0 }, artists: { hit: 0, miss: 0, error: 0 } }

  function enabled (kind) {
    const current = settings.get()
    /*
     * 总开关是**真正的总闸**（默认开着）：关掉它，歌词与封面一起停 ——
     * 用户关它就是明确表示「不要联网」，不该有例外。
     * 分项开关用来只关其中一样。
     */
    if (!current.onlineFeatures) return false
    if (kind === 'lyrics') return current.onlineLyrics !== false
    if (kind === 'covers') return current.onlineCovers !== false
    if (kind === 'artists') return current.onlineArtists !== false
    return true
  }

  /** 串行执行 + 最小间隔，避免并发轰炸公共 API */
  function schedule (task) {
    const run = queue.then(async () => {
      const wait = MIN_INTERVAL - (Date.now() - lastRequestAt)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastRequestAt = Date.now()
      return task()
    })
    // 让链条不因单个失败而中断
    queue = run.catch(() => {})
    return run
  }

  /**
   * 带**一次重试**的请求。
   *
   * 为什么要有：冷启动（DNS + TLS 握手）或网络抖动时，第一次请求可能整段卡住、
   * 被我们自己的超时定时器 abort —— 报错就是 `This operation was aborted`。
   * 没有重试的代价不只是「少一次歌词」：
   *   · 用户第一次点开一首歌的歌词就静默失败（要等下次刷新才有）；
   *   · 更狠的是 Deezer —— coverFromDeezer / artistFromDeezer 一旦失败就把
   *     整个会话的 Deezer 停用（`deezerDisabled`），一次抖动会让封面与头像
   *     退到备选源或直接没有。
   *
   * 只重试「连接层 / 超时 / 响应解析」这类失败；**HTTP 状态码错误不重试**
   * —— 对方已经明确答复了，重试只是白等一轮。
   */
  async function request (url, { timeout = 9000, binary = false, retry = 1 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await net.fetch(url, {
          signal: controller.signal,
          headers: binary
            ? { 'User-Agent': USER_AGENT }
            : { 'User-Agent': USER_AGENT, Accept: 'application/json' }
        })
        // 404 只对 JSON 有意义（「这首歌没收录」也会缓存）；二进制 404 当错误处理
        if (response.status === 404 && !binary) return { notFound: true }
        if (!response.ok) throw httpError(response.status)
        if (binary) {
          return {
            buffer: Buffer.from(await response.arrayBuffer()),
            mime: response.headers.get('content-type') || 'image/jpeg'
          }
        }
        return { data: await response.json() }
      } catch (err) {
        if (err && err.http === true && err.retryable !== true) throw err
        if (attempt >= retry) throw err
        console.warn(`[online] 第 ${attempt + 1} 次请求失败（${err && err.message ? err.message : err}），` +
          `400ms 后重试一次：${url}`)
        await new Promise((resolve) => setTimeout(resolve, 400))
      } finally {
        clearTimeout(timer)
      }
    }
  }

  /**
   * HTTP 状态码错误。
   * 429（限流）与 5xx（服务端暂时不可用）属于「过一会儿再试」那一类，允许重试；
   * 其它 4xx 是对方明确拒绝（参数错、没权限），重试只是白等一轮。
   */
  function httpError (status) {
    const retryable = status === 429 || status >= 500
    return Object.assign(new Error(`HTTP ${status}`), { http: true, retryable })
  }

  const requestJson = (url, options) => request(url, options)
  const requestBinary = (url, options) => request(url, { timeout: 12000, ...options, binary: true })

  /* ---------------- 缓存 ---------------- */

  async function readJson (folder, key) {
    try {
      const raw = await fsp.readFile(path.join(cacheRoot, folder, `${key}.json`), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed.notFound && Date.now() - parsed.at > NEGATIVE_TTL) return null
      return parsed
    } catch {
      return null
    }
  }

  async function readBinary (folder, key) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(cacheRoot, folder, `${key}.json`), 'utf8'))
      if (meta.notFound) return null
      const data = await fsp.readFile(path.join(cacheRoot, folder, meta.file))
      return { buffer: data, mime: meta.mime }
    } catch {
      return null
    }
  }

  async function writeJson (folder, key, value) {
    try {
      const dir = path.join(cacheRoot, folder)
      await fsp.mkdir(dir, { recursive: true })
      await fsp.writeFile(path.join(dir, `${key}.json`), JSON.stringify(value), 'utf8')
    } catch (err) {
      console.warn('[online] 缓存写入失败:', err.message)
    }
  }

  async function writeBinary (folder, key, buffer, mime) {
    try {
      const dir = path.join(cacheRoot, folder)
      await fsp.mkdir(dir, { recursive: true })
      const file = `${key}.bin`
      await fsp.writeFile(path.join(dir, file), buffer)
      await fsp.writeFile(path.join(dir, `${key}.json`),
        JSON.stringify({ file, mime, at: Date.now() }), 'utf8')
    } catch (err) {
      console.warn('[online] 封面缓存写入失败:', err.message)
    }
  }

  /* ---------------- 歌词：LRCLIB ---------------- */

  function pickBestLyric (list, track) {
    if (!Array.isArray(list) || !list.length) return null
    const target = Number(track.duration) || 0
    const scored = list.map((item) => {
      let score = 0
      if (item.syncedLyrics) score += 10
      else if (item.plainLyrics) score += 4
      if (item.instrumental) score += 1
      if (target && item.duration) {
        const diff = Math.abs(item.duration - target)
        score += diff < 2 ? 6 : diff < 6 ? 3 : diff < 15 ? 1 : 0
      }
      const itemTitle = String(item.trackName || '').toLowerCase()
      if (itemTitle === String(track.title || '').toLowerCase()) score += 3
      return { item, score }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored[0].item
  }

  async function fetchLyrics (track) {
    if (!enabled('lyrics')) return { skipped: true }
    const key = hashKey('lrc', track.artist, track.title, Math.round(track.duration) || 0)

    const cached = await readJson('lyrics', key)
    if (cached) {
      stats.lyrics.hit++
      return cached.notFound ? { text: null, cached: true } : { ...cached, cached: true }
    }

    stats.lyrics.miss++
    try {
      const query = new URLSearchParams()
      if (track.title) query.set('track_name', track.title)
      if (track.artist) query.set('artist_name', track.artist)
      const search = await schedule(() => requestJson(`https://lrclib.net/api/search?${query}`))
      const best = search.notFound ? null : pickBestLyric(search.data, track)
      const text = best?.syncedLyrics || best?.plainLyrics || null

      const result = text
        ? {
            text,
            source: 'lrclib',
            provider: 'LRCLIB',
            synced: Boolean(best.syncedLyrics),
            instrumental: Boolean(best.instrumental),
            meta: { artist: best.artistName, title: best.trackName, album: best.albumName }
          }
        : { notFound: true, at: Date.now() }

      await writeJson('lyrics', key, result.notFound ? result : { ...result, at: Date.now() })
      return result.notFound ? { text: null } : result
    } catch (err) {
      stats.lyrics.error++
      console.warn('[online] 歌词请求失败:', err.message)
      return { error: err.message }
    }
  }

  /* ---------------- 封面：Deezer -> iTunes ---------------- */

  function normalize (value) {
    return String(value || '').toLowerCase().replace(/[\s\-_·.,()[\]{}（）【】]/g, '')
  }

  async function coverFromDeezer (track) {
    if (deezerDisabled) return null
    const term = [track.artist, track.album].filter(Boolean).join(' ')
    if (!term) return null
    let result
    try {
      result = await schedule(() => requestJson(
        `https://api.deezer.com/search/album?q=${encodeURIComponent(term)}&limit=8`, { timeout: 5000 }))
    } catch (err) {
      // 连接层失败（超时/被墙）通常不是偶发，直接停用，避免每次补封面都白等 5 秒
      deezerDisabled = true
      console.warn('[online] Deezer 不可达，本次会话不再尝试:', err.message)
      return null
    }
    const list = result.data?.data
    if (!Array.isArray(list) || !list.length) return null

    const albumKey = normalize(track.album)
    const artistKey = normalize(track.albumArtist || track.artist)
    const scored = list.map((item) => {
      let score = 0
      if (albumKey && normalize(item.title) === albumKey) score += 8
      if (artistKey && normalize(item.artist?.name) === artistKey) score += 6
      if (albumKey && normalize(item.title).includes(albumKey)) score += 3
      return { item, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]
    if (best.score < 6) return null
    const url = best.item.cover_xl || best.item.cover_big
    if (!url) return null
    return { url, provider: 'Deezer', matched: best.item.title }
  }

  async function coverFromItunes (track) {
    const term = [track.artist, track.album].filter(Boolean).join(' ')
    if (!term) return null
    const result = await schedule(() => requestJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=8`))
    const list = result.data?.results
    if (!Array.isArray(list) || !list.length) return null

    const albumKey = normalize(track.album)
    const artistKey = normalize(track.albumArtist || track.artist)
    const scored = list.map((item) => {
      const title = normalize(item.collectionName)
      let score = 0
      if (albumKey && title === albumKey) score += 8
      if (artistKey && normalize(item.artistName) === artistKey) score += 6
      // 双向包含：iTunes 常给「专辑名 (Deluxe Edition)」这类变体
      if (albumKey && (title.includes(albumKey) || albumKey.includes(title))) score += 3
      return { item, score }
    })
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]
    if (best.score < 6) return null
    const url = String(best.item.artworkUrl100 || '').replace(/\/\d+x\d+bb\./, '/600x600bb.')
    if (!url) return null
    return { url, provider: 'iTunes', matched: best.item.collectionName }
  }

  async function fetchCover (track) {
    if (!enabled('covers')) return { skipped: true }
    const key = hashKey('cover', track.albumArtist || track.artist, track.album)

    const cached = await readBinary('covers', key)
    if (cached) {
      stats.covers.hit++
      return { mime: cached.mime, data: cached.buffer, cached: true }
    }

    stats.covers.miss++
    try {
      // iTunes 更快也更稳定，作为首选；Deezer 作为补充
      let source = null
      try {
        source = await coverFromItunes(track)
      } catch (err) {
        console.warn('[online] iTunes 封面失败:', err.message)
      }
      if (!source) {
        try {
          source = await coverFromDeezer(track)
        } catch (err) {
          console.warn('[online] Deezer 封面失败:', err.message)
        }
      }

      if (!source) {
        await writeJson('covers', key, { notFound: true, at: Date.now() })
        return { data: null }
      }

      const image = await schedule(() => requestBinary(source.url))
      await writeBinary('covers', key, image.buffer, image.mime)
      return { mime: image.mime, data: image.buffer, provider: source.provider, url: source.url }
    } catch (err) {
      stats.covers.error++
      console.warn('[online] 封面请求失败:', err.message)
      return { error: err.message }
    }
  }


  /**
   * 在线艺人头像（Deezer 艺人搜索）。
   *
   * 为什么要单独查：艺人头像以前是拿「该艺人的某一首歌的专辑封面」顶替的，
   * 遇到合作曲目就会把 A 的脸挂到 B 身上（用户举例：Ed Sheeran 与 Taylor Swift 合作，
   * 于是 Ed Sheeran 显示成 Taylor 的封面）。所以这里按**艺人名**直接查，
   * 并且要求返回的名字能和查询名对上，对不上就当作没找到（宁可不显示，也不挂错人）。
   */
  async function artistFromDeezer (name) {
    if (deezerDisabled) return null
    let result
    try {
      result = await schedule(() => requestJson(
        `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=5`, { timeout: 6000 }))
    } catch (err) {
      deezerDisabled = true
      console.warn('[online] Deezer 不可达，本次会话不再尝试:', err.message)
      return null
    }
    const list = result.data?.data
    if (!Array.isArray(list) || !list.length) return null
    const want = normalize(name)
    if (!want) return null
    // 完全同名优先，其次互相包含（例如 "Ed Sheeran" vs "Ed Sheeran "）
    const best = list.find((item) => normalize(item.name) === want) ||
      list.find((item) => normalize(item.name).includes(want) || want.includes(normalize(item.name)))
    if (!best) return null
    const url = best.picture_xl || best.picture_big
    if (!url) return null
    return { url, provider: 'Deezer', matched: best.name }
  }

  /**
   * 维基百科的页面主图当艺人头像：免密钥，返回的一般就是本人照片。
   * 为什么是主图源：Deezer 在部分网络下完全不可达（见文件头说明），
   * 而 iTunes 的艺人接口不提供头像 —— 实测那条路取不到图时这里能兜住。
   * 名字对不上就不用（搜到的页面标题必须能和艺人名互相包含），宁缺勿错。
   */
  async function artistFromWikipedia (name) {
    if (wikiDisabled) return null
    /*
     * requestJson 的返回是 { data: <解析后的 JSON> }，外面包了一层 ——
     * 这里曾经直接把它当 JSON 用（payload.query.pages），于是**请求 200 成功、
     * 响应里就有照片地址，却永远解析不到图**，表现就是「艺人一个头像都没有」。
     * 现在 raw() 两种形状都兼容，免得以后再踩。
     */
    const raw = (payload) => (payload && payload.data !== undefined ? payload.data : payload)
    const pick = (payload) => {
      const pages = raw(payload)?.query?.pages
      if (!pages) return null
      const first = Object.values(pages)[0]
      return first?.original?.source || first?.thumbnail?.source || null
    }
    const ask = (params) => schedule(() => requestJson(
      `https://en.wikipedia.org/w/api.php?format=json&redirects=1&${params}`, { timeout: 8000 }))
    try {
      const direct = await ask(`action=query&prop=pageimages&piprop=original|thumbnail&pithumbsize=600&titles=${encodeURIComponent(name)}`)
      let url = pick(direct)
      if (!url) {
        const search = await ask(`list=search&srsearch=${encodeURIComponent(name)}&srlimit=1`)
        const title = raw(search)?.query?.search?.[0]?.title
        if (!title) return null
        const want = normalize(name)
        const got = normalize(title)
        if (!want || !got || !(got.includes(want) || want.includes(got))) return null
        url = pick(await ask(`action=query&prop=pageimages&piprop=original|thumbnail&pithumbsize=600&titles=${encodeURIComponent(title)}`))
      }
      if (!url) return null
      return { url, provider: 'Wikipedia', matched: name }
    } catch (err) {
      /*
       * 连接层失败（超时 / 响应被中间设备换成了 HTML）通常不是偶发：本次会话就别再试了。
       * 与 Deezer 那条 `deezerDisabled` 对称。
       *
       * 实测代价：本机维基请求是**挂住**到 8s 超时才失败的，而每次都要先试维基、
       * 再回落 Deezer —— 于是每打开一位艺人的详情都要等 ~9s 才出照片。
       * 第一次失败后打上这个标记，后面的人直接走 Deezer（~1s）。
       */
      wikiDisabled = true
      console.warn('[online] 维基百科艺人头像失败，本次会话不再尝试:', err.message)
      return null
    }
  }
  /** 取艺人头像字节（带磁盘缓存；未命中缓存 24 小时） */
  async function fetchArtist (payload) {
    const name = String(payload?.name || '').trim()
    if (!name) return { error: 'missing name' }
    if (!enabled('artists')) return { skipped: true }
    const key = normalize(name)
    if (!key) return { error: 'empty key' }
    try {
      const cached = await readBinary(ARTIST_CACHE, key)
      if (cached) {
        stats.artists.hit++
        return cached
      }
      stats.artists.miss++
      // 先用维基百科（免密钥、有本人照片），取不到再试 Deezer
      const source = (await artistFromWikipedia(name)) || (await artistFromDeezer(name))
      if (!source) {
        await writeJson(ARTIST_CACHE, key, { notFound: true, at: Date.now() })
        return { data: null }
      }
      const image = await schedule(() => requestBinary(source.url))
      await writeBinary(ARTIST_CACHE, key, image.buffer, image.mime)
      return { mime: image.mime, data: image.buffer, provider: source.provider, matched: source.matched }
    } catch (err) {
      stats.artists.error++
      console.warn('[online] 艺人头像请求失败:', err.message)
      return { error: err.message }
    }
  }

  /* ---------------- 维护接口 ---------------- */

  async function clearCache () {
    try {
      await fsp.rm(cacheRoot, { recursive: true, force: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  }

  async function getStats () {
    const result = { cacheRoot, ...stats, size: 0, files: 0, enabled: enabled('lyrics') || enabled('covers') }
    try {
      const walk = async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) await walk(full)
          else {
            const stat = await fsp.stat(full)
            result.size += stat.size
            result.files++
          }
        }
      }
      await walk(cacheRoot)
    } catch {
      // 缓存目录还没建
    }
    return result
  }

  return { fetchLyrics, fetchArtist, fetchCover, clearCache, getStats }
}

module.exports = { createOnlineService }
