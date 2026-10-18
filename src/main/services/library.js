'use strict'

const { app, dialog, shell, BrowserWindow, nativeImage } = require('electron')
const fsp = require('node:fs/promises')
const path = require('node:path')

const { isAudioFile } = require('../util/mime')
const { walkFiles, findNamedImage, listDirIndex, invalidateDirIndex } = require('../util/files')
const { readMetadata, readEmbeddedArtwork } = require('./metadata')
const { decodeTextBuffer } = require('../util/text')
const { writeJsonAtomic } = require('../util/atomic-json')

const CACHE_VERSION = 3
const SCAN_CONCURRENCY = 6
const ARTWORK_CACHE_LIMIT = 64
/** 封面落盘缓存的边长：媒体墙最大格子 2×220px，480 足够且文件小得多 */
const ARTWORK_MAX_SIZE = 480
const ARTWORK_JPEG_QUALITY = 82

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
      await writeJsonAtomic(cacheFile, {
        version: CACHE_VERSION,
        scannedAt,
        tracks
      })
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
      /*
       * 读不进去的目录要收集起来（macOS 的 TCC 权限会让「文稿/桌面/下载」直接 EACCES）。
       * 以前 walkFiles 静默吞掉这类错误，扫描就"成功返回 0 首"——
       * 用户看到的是「扫不到歌」，而真正的原因（没权限）在界面上完全看不到。
       */
      const unreadable = []
      for (const root of roots) {
        const found = await walkFiles(root, isAudioFile, {
          onError: (info) => {
            unreadable.push(info)
            console.warn(`[library] 读不了目录 ${info.dir}（${info.code}）：${info.message}`)
          }
        })
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

      // 与上一次的结果比对，得出「这次真的变了什么」——
      // 只有真的增减了曲目才值得提示用户，否则每次重扫都弹会显得莫名其妙
      const previousPaths = new Set(byPath.keys())
      const nextPaths = new Set(next.map((track) => track.path))
      let added = 0
      let removed = 0
      for (const file of nextPaths) if (!previousPaths.has(file)) added++
      for (const file of previousPaths) if (!nextPaths.has(file)) removed++

      setTracks(next)
      scannedAt = Date.now()
      artworkCache.clear()
      await saveCache()

      const summary = {
        phase: 'done',
        reason: options.reason || 'manual',
        done: next.length,
        total,
        reused,
        failed,
        added,
        removed,
        changed: added + removed,
        scannedAt,
        elapsedMs: Date.now() - started,
        count: next.length,
        /* 读不进去的目录：界面据此提示用户去授权 / 检查路径（最多带 5 条，免得 payload 无限大） */
        unreadable: unreadable.slice(0, 5),
        unreadableCount: unreadable.length
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

  /**
   * 封面落盘缓存。
   *
   * 媒体墙一屏就有上百张封面，如果每次都从音频文件里重新解析内嵌图，
   * 主进程会被解析任务压满（首次打开媒体墙的卡顿就来自这里）。
   * 所以第一次提取后顺手缩到 480px、转成 JPEG 存到 userData/artwork-cache，
   * 之后只读一个小文件即可。缓存按源文件 mtime 判断是否过期。
   */
  const artworkCacheDir = path.join(app.getPath('userData'), 'artwork-cache')

  function artworkCacheFile (track) {
    return path.join(artworkCacheDir, `${track.id}.jpg`)
  }

  /** 缩放 + 转 JPEG；失败或没变小就返回原图 */
  function optimizeArtwork (source) {
    try {
      const image = nativeImage.createFromBuffer(source.data)
      if (image.isEmpty()) return source
      const size = image.getSize()
      const longest = Math.max(size.width, size.height)
      const alreadySmall = longest <= ARTWORK_MAX_SIZE && source.data.length < 150 * 1024
      if (alreadySmall) return source

      const scale = Math.min(1, ARTWORK_MAX_SIZE / longest)
      const resized = image.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good'
      })
      const jpeg = resized.toJPEG(ARTWORK_JPEG_QUALITY)
      if (!jpeg || !jpeg.length || jpeg.length >= source.data.length) return source
      return { mime: 'image/jpeg', data: jpeg }
    } catch (err) {
      console.warn('[library] 封面缩放失败，使用原图:', err.message)
      return source
    }
  }

  async function readArtworkFromDisk (track) {
    const file = artworkCacheFile(track)
    try {
      const stat = await fsp.stat(file)
      // 源文件更新过就作废缓存
      if (stat.mtimeMs < track.mtimeMs) return null
      const data = await fsp.readFile(file)
      if (!data.length) return null
      return { mime: 'image/jpeg', data, source: 'disk' }
    } catch {
      return null
    }
  }

  async function writeArtworkToDisk (track, result) {
    if (result.mime !== 'image/jpeg') return
    try {
      await fsp.mkdir(artworkCacheDir, { recursive: true })
      await fsp.writeFile(artworkCacheFile(track), result.data)
    } catch (err) {
      console.warn('[library] 封面缓存写入失败:', err.message)
    }
  }

  async function getArtwork (trackId) {
    const memory = artworkCache.get(trackId)
    if (memory) return memory

    const track = byId.get(trackId)
    if (!track) return null

    // 1) 磁盘缓存
    let result = await readArtworkFromDisk(track)

    // 2) 回源：同名图片直接读，内嵌图交给 metadata 解析
    if (!result) {
      try {
        let source = null
        if (track.artworkFile) {
          const data = await fsp.readFile(track.artworkFile)
          const ext = path.extname(track.artworkFile).slice(1).toLowerCase()
          source = { mime: `image/${ext === 'jpg' ? 'jpeg' : ext}`, data }
        } else if (track.artworkEmbedded) {
          source = await readEmbeddedArtwork(track.path)
        }
        if (source) {
          result = { ...optimizeArtwork(source), source: 'extracted' }
          await writeArtworkToDisk(track, result)
        }
      } catch (err) {
        console.warn(`[library] 封面读取失败 ${track.file}: ${err.message}`)
        result = null
      }
    }

    if (result) {
      artworkCache.set(trackId, result)
      if (artworkCache.size > ARTWORK_CACHE_LIMIT) {
        artworkCache.delete(artworkCache.keys().next().value)
      }
    }
    return result
  }

  async function getArtworkStats () {
    const stats = { dir: artworkCacheDir, files: 0, bytes: 0, memory: artworkCache.size }
    try {
      const entries = await fsp.readdir(artworkCacheDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const stat = await fsp.stat(path.join(artworkCacheDir, entry.name))
        stats.files++
        stats.bytes += stat.size
      }
    } catch {
      // 目录还不存在
    }
    return stats
  }

  /**
   * @param {{ memory?: boolean, disk?: boolean }} [options]
   * memory 只清内存里已解码的封面；disk 连落盘缓存一起删
   */
  async function clearArtworkCache (options = {}) {
    const memory = options.memory !== false
    const disk = options.disk !== false
    if (memory) artworkCache.clear()
    if (!disk) return { ok: true, memory, disk }
    try {
      await fsp.rm(artworkCacheDir, { recursive: true, force: true })
      return { ok: true, memory, disk }
    } catch (err) {
      return { ok: false, message: err.message }
    }
  }

  async function init () {
    const loaded = await loadCache()
    return { loaded, count: tracks.length, scannedAt }
  }

  /* ---------------- 拖拽导入 ---------------- */

  function isInsideRoots (filePath, roots) {
    const resolved = path.resolve(filePath)
    return roots.some((root) => {
      const rel = path.relative(root, resolved)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
  }

  async function confirm (message, detail) {
    const parent = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null
    const result = await dialog.showMessageBox(parent, {
      type: 'question',
      buttons: ['加入资料库', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message,
      detail
    })
    return result.response === 0
  }

  /**
   * 处理拖进窗口的路径。
   *
   * 目录 -> 询问后加入资料库；资料库内的音频 -> 直接播放；
   * 资料库外的音频 -> 询问后把所在文件夹加入资料库，再播放。
   *
   * @param {string[]} paths
   * @param {{ assumeYes?: boolean }} [options] assumeYes 跳过确认弹窗（自检用）
   */
  async function resolveDrop (paths, options = {}) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter((item) => typeof item === 'string' && item)
    if (!list.length) return { action: 'none', reason: 'empty' }

    const roots = getAllowedRoots()
    const folders = []
    const insideFiles = []
    const outsideFiles = []
    const rejected = []

    for (const item of list) {
      let stat
      try {
        stat = await fsp.stat(item)
      } catch {
        rejected.push({ path: item, reason: 'missing' })
        continue
      }
      if (stat.isDirectory()) {
        folders.push(path.resolve(item))
      } else if (!isAudioFile(item)) {
        rejected.push({ path: item, reason: 'not-audio' })
      } else if (isInsideRoots(item, roots)) {
        insideFiles.push(path.resolve(item))
      } else {
        outsideFiles.push(path.resolve(item))
      }
    }

    const added = []

    // 1) 拖进来的文件夹
    for (const dir of folders) {
      const ok = options.assumeYes || await confirm(
        `把「${path.basename(dir)}」加入资料库？`,
        `Aria 会递归扫描其中的音乐文件。\n${dir}`
      )
      if (!ok) continue
      const result = await addFolder(dir)
      if (result.ok) added.push(dir)
    }

    // 2) 资料库外的音频：把所在文件夹加入资料库
    if (outsideFiles.length) {
      const dirs = [...new Set(outsideFiles.map((file) => path.dirname(file)))]
        .filter((dir) => !isInsideRoots(dir, getAllowedRoots()))
      if (dirs.length) {
        const detail = dirs.length === 1
          ? `这些歌曲不在资料库目录中，需要先把所在文件夹加入资料库：\n${dirs[0]}`
          : `这些歌曲不在资料库目录中，需要先把 ${dirs.length} 个文件夹加入资料库：\n${dirs.slice(0, 5).join('\n')}${dirs.length > 5 ? '\n…' : ''}`
        const ok = options.assumeYes || await confirm('把拖入歌曲所在的文件夹加入资料库？', detail)
        if (ok) {
          for (const dir of dirs) {
            const result = await addFolder(dir)
            if (result.ok) added.push(dir)
          }
        }
      }
    }

    if (added.length) {
      await scan({ reason: 'drop' })
      settings.set({ folders: getFolders() }, { immediate: true })
    }

    // 3) 找出可以播放的曲目
    const candidates = [...insideFiles, ...outsideFiles]
    const trackIds = []
    for (const file of candidates) {
      const track = byPath.get(file)
      if (track) trackIds.push(track.id)
    }

    return {
      action: trackIds.length ? 'play' : (added.length ? 'added' : 'none'),
      trackIds,
      added,
      rejected,
      folders: getFolders()
    }
  }

  /* ================================================================ */
  /* 歌词搜索：只在「深度搜索」档使用                                    */
  /* ================================================================ */

  /**
   * .lrc 文本缓存。
   *
   * 全库几百个歌词文件、每个几 KB，读一遍是几百毫秒级；缓存在内存里之后
   * 后续每次输入都是纯字符串匹配（毫秒级）。用 mtime 判断是否失效，
   * 所以外部改了歌词文件也能立刻反映出来。
   */
  const lyricsIndex = new Map()   // path -> { mtimeMs, size, text }
  let lyricsIndexHits = 0

  const LYRICS_READ_CONCURRENCY = 8
  /** 一次搜索最多带回来这么多条「命中详情」（给界面悬停显示、点击跳转用） */
  const LYRICS_MATCH_LIMIT = 300
  /** 单行歌词回传时的截断长度 */
  const LYRICS_LINE_MAX = 160

  /**
   * 找出「第一行同时包含全部关键词」的歌词行，并把时间轴一起取出来。
   * 时间用于「点开歌曲时跳到这一句」；只解析命中的那一行，不做整首解析。
   *
   * LRC 行形如 [mm:ss.xx]歌词，也可能混有 [ar:...] 这类元信息行或纯文本行。
   */
  function findMatchedLine (text, parts) {
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const raw = lines[index]
      if (!raw) continue
      let time = null
      let body = raw
      const stamps = raw.match(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)
      if (stamps) {
        const first = stamps[0].slice(1, -1)
        const [minute, second] = first.split(':')
        const seconds = Number(String(second).replace(':', '.'))
        if (Number.isFinite(seconds)) time = Number(minute) * 60 + seconds
        body = raw.replace(/\[[^\]]*\]/g, '')
      }
      const trimmed = body.trim()
      if (!trimmed) continue
      const haystack = trimmed.toLowerCase()
      if (parts.every((part) => haystack.includes(part))) {
        return {
          lineIndex: index,
          line: trimmed.length > LYRICS_LINE_MAX ? `${trimmed.slice(0, LYRICS_LINE_MAX)}…` : trimmed,
          time
        }
      }
    }
    return null
  }

  async function readLyricsText (filePath, stat) {
    const cached = lyricsIndex.get(filePath)
    if (cached && cached.mtimeMs === Math.round(stat.mtimeMs) && cached.size === stat.size) {
      lyricsIndexHits++
      return cached.text
    }
    const raw = await fsp.readFile(filePath)
    const { text } = decodeTextBuffer(raw)
    lyricsIndex.set(filePath, { mtimeMs: Math.round(stat.mtimeMs), size: stat.size, text })
    return text
  }

  /**
   * 在歌词里搜索关键词。
   *
   * 语义与普通搜索保持一致：多个关键词之间是「与」，全都出现在同一份歌词里才算命中。
   * 返回命中的曲目 id（有上限，避免一次把整库都算上），
   * 以及前若干条的「命中详情」（哪一行、那一行的文本与时间轴），
   * 界面用它在悬停时高亮、在点开歌曲时跳到对应的那一句。
   *
   * @param {{ query?: string, limit?: number }} [options]
   */
  async function searchLyrics (options = {}) {
    const started = performance.now()
    const query = String(options.query || '').trim().toLowerCase()
    const limit = Math.max(1, Math.min(2000, Number(options.limit) || 500))
    if (!query) {
      return { ids: [], matches: [], scanned: 0, matched: 0, elapsedMs: 0, cached: 0, truncated: false }
    }
    const parts = query.split(/\s+/).filter(Boolean)

    // 只考虑真的有歌词的曲目
    const candidates = []
    for (const track of tracks) {
      if (track.lyricsPath) candidates.push(track)
    }

    const ids = []
    const matches = []
    let scanned = 0
    let matched = 0
    let failed = 0
    let truncated = false
    let cursor = 0

    const worker = async () => {
      while (cursor < candidates.length) {
        const track = candidates[cursor++]
        scanned++
        try {
          const stat = await fsp.stat(track.lyricsPath)
          const text = await readLyricsText(track.lyricsPath, stat)
          const haystack = text.toLowerCase()
          if (parts.every((part) => haystack.includes(part))) {
            matched++
            if (ids.length < limit) {
              ids.push(track.id)
              if (matches.length < LYRICS_MATCH_LIMIT) {
                const hit = findMatchedLine(text, parts)
                matches.push({ id: track.id, ...(hit || { lineIndex: -1, line: '', time: null }) })
              }
            } else {
              truncated = true
            }
          }
        } catch {
          // 文件被删或读不了：跳过它，不要让整次搜索失败
          failed++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(LYRICS_READ_CONCURRENCY, candidates.length) }, worker))

    return {
      ids,
      matches,
      scanned,
      matched,
      failed,
      truncated,
      cached: lyricsIndex.size,
      hits: lyricsIndexHits,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100
    }
  }

  function getLyricsIndexStats () {
    return { files: lyricsIndex.size, hits: lyricsIndexHits }
  }

  function resetLyricsIndex () {
    lyricsIndex.clear()
    lyricsIndexHits = 0
    return true
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
    getArtworkStats,
    clearArtworkCache,
    resolveDrop,
    searchLyrics,
    getLyricsIndexStats,
    resetLyricsIndex,
    getStats: () => ({ count: tracks.length, scannedAt, folders: getFolders().length, scanning: Boolean(scanningPromise) }),
    revealInFolder: (filePath) => shell.showItemInFolder(filePath),
    invalidateDirIndex
  }
}

module.exports = { createLibraryService }
