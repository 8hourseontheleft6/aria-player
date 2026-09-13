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
  /** Deezer 在部分网络下完全不可达：首次连接失败就整场会话不再尝试 */
  let deezerDisabled = false
  const stats = { lyrics: { hit: 0, miss: 0, error: 0 }, covers: { hit: 0, miss: 0, error: 0 } }

  function enabled (kind) {
    const current = settings.get()
    if (!current.onlineFeatures) return false
    if (kind === 'lyrics' && current.onlineLyrics === false) return false
    if (kind === 'covers' && current.onlineCovers === false) return false
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

  async function requestJson (url, { timeout = 9000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await net.fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
      })
      if (response.status === 404) return { notFound: true }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { data: await response.json() }
    } finally {
      clearTimeout(timer)
    }
  }

  async function requestBinary (url, { timeout = 12000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await net.fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      return { buffer, mime: response.headers.get('content-type') || 'image/jpeg' }
    } finally {
      clearTimeout(timer)
    }
  }

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

  return { fetchLyrics, fetchCover, clearCache, getStats }
}

module.exports = { createOnlineService }
