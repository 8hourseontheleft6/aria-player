'use strict'

const { app, dialog, shell } = require('electron')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { isAudioFile } = require('../util/mime')
const { walkFiles, findNamedImage, listDirIndex, invalidateDirIndex } = require('../util/files')
const { readMetadata, readEmbeddedArtwork } = require('./metadata')

const CACHE_VERSION = 3
const SCAN_CONCURRENCY = 6
const ARTWORK_CACHE_LIMIT = 64

/**
 * 资料库服务：目录管理、递归扫描、元数据缓存、封面读取。
 * 元数据解析走 metadata 服务（music-metadata 优先，内置解析器兜底），
 * 因此想换/加解析器只需要改那一个模块。
 */
function createLibraryService (ctx) {
  const settings = ctx.get('settings')
  const cacheFile = path.join(app.getPath('userData'), 'library-cache.json')

  /** @type {Array<object>} */
  let tracks = []
  let byId = new Map()
  let byPath = new Map()
  let scannedAt = 0
  let scanningPromise = null

  /** @type {Map<string, {mime: string, data: Buffer}>} */
  const artworkCache = new Map()

  /* ---------------- 缓存读写 ---------------- */

  async function loadCache () {
    try {
      const raw = await fsp.readFile(cacheFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.tracks)) return false
      setTracks(parsed.tracks)
      scannedAt = parsed.scannedAt || 0
      return true
    } catch {
      return false
    }
  }

  async function saveCache () {
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true })
      await fsp.writeFile(cacheFile, JSON.stringify({
        version: CACHE_VERSION,
        scannedAt,
        tracks
      }), 'utf8')
    } catch (err) {
      console.error('[library] 缓存写入失败:', err)
    }
  }

  function setTracks (list) {
    tracks = list
    byId = new Map(list.map((track) => [track.id, track]))
    byPath = new Map(list.map((track) => [track.path, track]))
  }

  function emitProgress (payload) {
    ctx.emit('library:scan-progress', payload)
  }

  /* ---------------- 目录管理 ---------------- */

  function getFolders () {
    return settings.get().folders.slice()
  }

  function getAllowedRoots () {
    return getFolders().map((dir) => path.resolve(dir))
  }

  async function addFolder (dir) {
    if (!dir) return { ok: false, reason: 'empty' }
    const resolved = path.resolve(dir)
    try {
      const stat = await fsp.stat(resolved)
      if (!stat.isDirectory()) return { ok: false, reason: 'not-a-directory' }
    } catch {
      return { ok: false, reason: 'missing' }
    }

    const folders = getFolders()
    const insideExisting = folders.some((existing) => {
      const rel = path.relative(path.resolve(existing), resolved)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
    if (insideExisting) return { ok: false, reason: 'already-covered' }

    // 新目录若覆盖了已有目录，则替换掉旧的
    const pruned = folders.filter((existing) => {
      const rel = path.relative(resolved, path.resolve(existing))
      return !(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)))
    })

    settings.set({ folders: [...pruned, resolved] }, { immediate: true })
    return { ok: true, folders: pruned.concat(resolved) }
  }

  async function removeFolder (dir) {
    const resolved = path.resolve(dir)
    const folders = getFolders().filter((item) => path.resolve(item) !== resolved)
    settings.set({ folders }, { immediate: true })
    await pruneTracksOutsideRoots()
    return { ok: true, folders }
  }

  async function pickFolders () {
    const result = await dialog.showOpenDialog({
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
    })
    if (result.canceled) return { ok: false, folders: getFolders() }
    const added = []
    for (const dir of result.filePaths) {
      const res = await addFolder(dir)
      if (res.ok) added.push(dir)
    }
    if (added.length) await scan({ reason: 'add-folder' })
    return { ok: added.length > 0, added, folders: getFolders() }
  }

  async function pruneTracksOutsideRoots () {
    const roots = getAllowedRoots()
    const keep = tracks.filter((track) => roots.some((root) => {
      const rel = path.relative(root, track.path)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    }))
    if (keep.length !== tracks.length) {
      setTracks(keep)
      await saveCache()
    }
  }

  /** 解析曲目对应的歌词文件（同名或「歌名-歌手」组合），扫描时顺手做掉 */
  async function resolveLyricsPath (track) {
    const index = await listDirIndex(track.dir)
    if (!index.size) return null

    const normalize = (value) => String(value || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, '')
      .replace(/[\s_\-–—·.,()[\]{}（）【】「」]/g, '')

    const titleKey = normalize(track.title)
    const artistKey = normalize(track.artist)
    const fileKey = normalize(track.file)

    let best = null
    let bestScore = 0
    for (const [lower, actual] of index) {
      if (!lower.endsWith('.lrc')) continue
      const stemKey = normalize(lower)
      let score = 0
      if (stemKey === fileKey || stemKey === titleKey) score = 100
      else if (titleKey && stemKey.includes(titleKey) && (!artistKey || stemKey.includes(artistKey))) score = 88
      else if (artistKey && titleKey && stemKey.includes(artistKey) && stemKey.includes(titleKey)) score = 85
      else if (titleKey && stemKey.includes(titleKey)) score = 70
      if (score > bestScore) {
        bestScore = score
        best = actual
      }
    }
    return bestScore >= 70 ? path.join(track.dir, best) : null
  }

  /* ---------------- 扫描 ---------------- */

  async function scan (options = {}) {
    if (scanningPromise) return scanningPromise

    scanningPromise = (async () => {
      const force = Boolean(options.force)
      const roots = getFolders()
      const started = Date.now()
      emitProgress({ phase: 'walking', done: 0, total: 0, current: '' })

      const files = []
      for (const root of roots) {
        const found = await walkFiles(root, isAudioFile)
        files.push(...found)
      }
      files.sort()

      const previous = byPath
      const total = files.length
      const next = []
      let done = 0
      let reused = 0
      let failed = 0
      let lastEmit = 0

      const queue = files.slice()
      const workerCount = Math.max(1, Math.min(SCAN_CONCURRENCY, queue.length))

      const workers = Array.from({ length: workerCount }, async () => {
        for (;;) {
          const file = queue.shift()
          if (!file) return
          try {
            const stat = await fsp.stat(file)
            const cached = previous.get(file)
            let track

            if (cached && !force && cached.size === stat.size && cached.mtimeMs === Math.round(stat.mtimeMs)) {
              track = { ...cached, size: stat.size }
              reused++
            } else {
              track = await readMetadata(file, {
                stat,
                covers: true,
                sidecarCover: await findNamedImage(path.dirname(file), path.basename(file, path.extname(file)))
              })
            }

            track.lyricsPath = await resolveLyricsPath(track)
            next.push(track)
          } catch (err) {
            failed++
            console.warn(`[library] 跳过 ${file}: ${err.message}`)
          }

          done++
          const now = Date.now()
          if (now - lastEmit > 120 || done === total) {
            lastEmit = now
            emitProgress({
              phase: 'parsing',
              done,
              total,
              current: path.basename(file),
              reused,
              failed
            })
          }
        }
      })

      await Promise.all(workers)

      next.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'))
      setTracks(next)
      scannedAt = Date.now()
      artworkCache.clear()
      await saveCache()

      const summary = {
        phase: 'done',
        done: next.length,
        total,
        reused,
        failed,
        scannedAt,
        elapsedMs: Date.now() - started,
        count: next.length
      }
      emitProgress(summary)
      return summary
    })()

    try {
      return await scanningPromise
    } finally {
      scanningPromise = null
    }
  }

  /* ---------------- 对外读取 ---------------- */

  async function getArtwork (trackId) {
    if (artworkCache.has(trackId)) return artworkCache.get(trackId)
    const track = byId.get(trackId)
    if (!track) return null

    let result = null
    try {
      if (track.artworkFile) {
        const data = await fsp.readFile(track.artworkFile)
        result = { mime: `image/${path.extname(track.artworkFile).slice(1).replace('jpg', 'jpeg')}`, data }
      } else if (track.artworkEmbedded) {
        result = await readEmbeddedArtwork(track.path)
      }
    } catch (err) {
      console.warn(`[library] 封面读取失败 ${track.file}: ${err.message}`)
      result = null
    }

    if (result) {
      artworkCache.set(trackId, result)
      if (artworkCache.size > ARTWORK_CACHE_LIMIT) {
        artworkCache.delete(artworkCache.keys().next().value)
      }
    }
    return result
  }

  async function init () {
    const loaded = await loadCache()
    return { loaded, count: tracks.length, scannedAt }
  }

  return {
    init,
    scan,
    getFolders,
    addFolder,
    removeFolder,
    pickFolders,
    getAllowedRoots,
    getTracks: () => tracks,
    getTrackById: (id) => byId.get(id) || null,
    getTrackByPath: (p) => byPath.get(p) || null,
    getArtwork,
    getStats: () => ({ count: tracks.length, scannedAt, folders: getFolders().length, scanning: Boolean(scanningPromise) }),
    revealInFolder: (filePath) => shell.showItemInFolder(filePath),
    invalidateDirIndex
  }
}

module.exports = { createLibraryService }
