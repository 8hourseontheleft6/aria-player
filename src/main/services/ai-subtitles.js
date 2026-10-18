'use strict'

/**
 * 「AI 字幕（本地）」的模型管理服务（阶段 2）。
 *
 * 只做一件事：把三个模型文件可靠地放进 `userData/ai-subtitles/models/sense-voice/`，
 * 并能干净地删掉。识别本身在阶段 3（utilityProcess）里做，这里不碰 sherpa。
 *
 * 设计要点（都是为了"下载失败不能影响播放"这条硬边界）：
 *   · 全程异步、流式，不把 228MB 读进内存；进度事件节流，不刷爆 IPC；
 *   · 写 `.part`，校验通过才原子改名 —— 半个文件永远不会被当成"已下载"；
 *   · 支持 Range 续传：断网/取消后 `.part` 留着，下次接着下，不重下 228MB；
 *   · 3 次重试（指数退避），可随时取消；取消**不删** `.part`（那是续传的本钱），
 *     「删除模型」才清干净；
 *   · 磁盘不足、SHA256 不符、HTTP 非 200 都有各自明确的错误码，UI 才好给出可操作提示。
 */

const fsp = require('node:fs/promises')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, net } = require('electron')

const {
  MODEL_FILES,
  DISK_SLACK_BYTES,
  CACHE_LIMIT_ENTRIES,
  CACHE_LIMIT_BYTES,
  sourceById,
  fileUrl,
  formatBytes,
  totalModelBytes,
  modelFingerprint
} = require('./ai-subtitles-constants')

const RETRY_LIMIT = 3
const PROGRESS_INTERVAL_MS = 250
const SPEED_WINDOW_MS = 1500

/** 错误码 → 人话（UI 直接展示后半句，前面给代码便于排查） */
const ERROR_TEXT = {
  'disk-full': '磁盘空间不足',
  'http-error': '下载失败（服务器返回错误）',
  'network': '网络中断',
  'sha256-mismatch': '模型文件校验失败（可能下载不完整，已删除）',
  'cancelled': '已取消下载',
  'no-source': '下载源不可用'
}

function createAiSubtitlesService (ctx) {
  const root = () => path.join(app.getPath('userData'), 'ai-subtitles')
  const modelsRoot = () => path.join(root(), 'models')
  const modelDir = () => path.join(modelsRoot(), 'sense-voice')
  const cacheDir = () => path.join(root(), 'cache')

  /** @type {{ state: string, error: null | { code: string, message: string, detail?: string }, received: number, total: number, source: string, startedAt: number, bytesAtLastTick: number, lastTickAt: number, speed: number }} */
  let job = null
  /** 正在进行的 HTTP 请求，用于取消 */
  let activeRequest = null
  let cancelRequested = false

  function modelPath (file) {
    return path.join(modelDir(), file.name)
  }

  function partPath (file) {
    return modelPath(file) + '.part'
  }

  async function sizeOf (file) {
    try {
      return (await fsp.stat(file)).size
    } catch {
      return 0
    }
  }

  /** 单个文件是否已经"完好"（大小对得上；SHA256 只在下载完成后校验） */
  async function fileReady (file) {
    return (await sizeOf(modelPath(file))) === file.bytes
  }

  async function allReady () {
    for (const file of MODEL_FILES) {
      if (!(await fileReady(file))) return false
    }
    return true
  }

  async function sha256File (file) {
    return await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(file)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  function emit (channel, payload) {
    try {
      ctx.emit(channel, payload)
    } catch (err) {
      console.error('[ai-subtitles] 事件发送失败:', err)
    }
  }

  function progressPayload () {
    const received = job ? job.received : 0
    const total = job ? job.total : totalModelBytes()
    return {
      state: job ? job.state : 'not-downloaded',
      received,
      total,
      speed: job ? job.speed : 0,
      percent: total > 0 ? Math.min(100, (received / total) * 100) : 0,
      source: job ? job.source : 'huggingface',
      error: job ? job.error : null
    }
  }

  function tickProgress (force = false) {
    if (!job) return
    const now = Date.now()
    const elapsed = now - job.lastTickAt
    if (elapsed >= SPEED_WINDOW_MS) {
      job.speed = Math.max(0, (job.received - job.bytesAtLastTick) / (elapsed / 1000))
      job.bytesAtLastTick = job.received
      job.lastTickAt = now
    }
    if (!force && now - job.lastEmitAt < PROGRESS_INTERVAL_MS) return
    job.lastEmitAt = now
    emit('ai-subtitles:progress', progressPayload())
  }

  /** 下载前的磁盘检查：还要下的字节 + 余量，不能超过可用空间 */
  async function ensureDiskSpace (neededBytes) {
    const dir = modelsRoot()
    await fsp.mkdir(dir, { recursive: true })
    let stats = null
    try {
      stats = await fsp.statfs(dir)
    } catch {
      return /* 拿不到就放行：不能因为探测失败就不让人下载 */
    }
    const free = Number(stats.bavail) * Number(stats.bsize)
    if (Number.isFinite(free) && free < neededBytes + DISK_SLACK_BYTES) {
      throw Object.assign(new Error(ERROR_TEXT['disk-full']), {
        code: 'disk-full',
        detail: `需要约 ${formatBytes(neededBytes + DISK_SLACK_BYTES)}，磁盘只剩 ${formatBytes(free)}`
      })
    }
  }

  /**
   * 下载一个文件（可续传）。
   * @param {object} file MODEL_FILES 里的一项
   * @param {string} sourceId
   */
  async function downloadFile (file, sourceId) {
    const target = modelPath(file)
    const part = partPath(file)
    await fsp.mkdir(path.dirname(target), { recursive: true })

    let have = await sizeOf(part)
    if (have > file.bytes) { /* .part 比目标还大：肯定坏了，重来 */
      await fsp.rm(part, { force: true })
      have = 0
    }
    /* 续传：.part 里已有的字节也要算进总进度 */
    job.received += have

    const url = fileUrl(sourceId, file)
    const response = await requestWithRetry({ url, from: have, file, hasPartial: have > 0 })

    /* 服务器不理 Range（返回 200 而不是 206）：只能从头写 */
    if (response.statusCode === 200 && have > 0) {
      have = 0
      job.received -= (await sizeOf(part))
    }

    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
      let settled = false
      const finish = (err) => {
        if (settled) return
        settled = true
        stream.close(() => (err ? reject(err) : resolve()))
      }
      response.on('data', (chunk) => {
        if (cancelRequested) { response.destroy(new Error('cancelled')); return }
        job.received += chunk.length
        tickProgress()
        if (!stream.write(chunk)) stream.once('drain', () => {})
      })
      response.on('end', () => finish(null))
      response.on('error', (err) => finish(err))
      stream.on('error', (err) => finish(err))
    })

    /* 大小对不上就是没下完（连接被掐断）：留着 .part，交给重试/续传 */
    const finalSize = await sizeOf(part)
    if (finalSize !== file.bytes) {
      throw Object.assign(new Error(ERROR_TEXT.network), {
        code: 'network',
        detail: `${file.name} 只收到 ${finalSize} / ${file.bytes} B`
      })
    }

    const digest = await sha256File(part)
    if (digest !== file.sha256) {
      await fsp.rm(part, { force: true })
      throw Object.assign(new Error(ERROR_TEXT['sha256-mismatch']), {
        code: 'sha256-mismatch',
        detail: `${file.name} 的 SHA256 是 ${digest.slice(0, 16)}…，期望 ${file.sha256.slice(0, 16)}…`
      })
    }

    await fsp.rename(part, target)
    return target
  }

  /** 一次 HTTP 请求（不重试）；只在 2xx 时返回响应流 */
  function requestOnce ({ url, from }) {
    return new Promise((resolve, reject) => {
      let request
      try {
        request = net.request({ method: 'GET', url, redirect: 'follow' })
      } catch (err) {
        reject(Object.assign(err, { code: 'network' }))
        return
      }
      activeRequest = request
      if (from > 0) request.setHeader('Range', `bytes=${from}-`)
      request.on('response', (response) => {
        if (cancelRequested) {
          response.destroy(new Error('cancelled'))
          return
        }
        const status = response.statusCode
        if (status !== 200 && status !== 206) {
          response.destroy()
          reject(Object.assign(new Error(ERROR_TEXT['http-error']), {
            code: 'http-error',
            detail: `HTTP ${status}`
          }))
          return
        }
        resolve(response)
      })
      request.on('error', (err) => reject(Object.assign(err, { code: 'network' })))
      request.end()
    })
  }

  async function requestWithRetry ({ url, from, file }) {
    let lastError = null
    for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
      if (cancelRequested) {
        throw Object.assign(new Error(ERROR_TEXT.cancelled), { code: 'cancelled' })
      }
      try {
        return await requestOnce({ url, from })
      } catch (err) {
        lastError = err
        if (err.code === 'cancelled') throw err
        if (attempt < RETRY_LIMIT) {
          /* 指数退避，但别让用户等到以为卡死 */
          await new Promise((resolve) => setTimeout(resolve, attempt * 800))
        }
      }
    }
    throw Object.assign(new Error(ERROR_TEXT.network), {
      code: 'network',
      detail: `${file.name}：${lastError && lastError.message}`
    })
  }

  /** 对外：状态快照（UI 一次拿全） */
  async function status () {
    const ready = await allReady()
    const partBytes = await Promise.all(MODEL_FILES.map(async (file) => sizeOf(partPath(file))))
    /*
     * 状态优先级：正在下 > 上一次失败 > 文件齐了 > 其余（未下载）。
     * 写成显式分支而不是嵌套三元 —— 后者在 code review 里永远是"要盯着看三遍"的那种。
     */
    let state = 'not-downloaded'
    if (job && job.state === 'downloading') state = 'downloading'
    else if (job && job.state === 'error') state = 'error'
    else if (ready) state = 'ready'
    return {
      state,
      ready,
      modelBytes: totalModelBytes(),
      modelBytesText: formatBytes(totalModelBytes()),
      partialBytes: partBytes.reduce((sum, value) => sum + value, 0),
      partialBytesText: formatBytes(partBytes.reduce((sum, value) => sum + value, 0)),
      fingerprint: modelFingerprint(),
      source: job ? job.source : 'huggingface',
      progress: job ? progressPayload() : null,
      error: job ? job.error : null,
      modelsDir: modelDir(),
      cache: await cacheInfo()
    }
  }

  /** 对外：开始下载（幂等：正在下就返回当前进度） */
  async function download ({ source } = {}) {
    if (job && job.state === 'downloading') return progressPayload()
    if (await allReady()) {
      job = { state: 'ready', error: null, received: totalModelBytes(), total: totalModelBytes(), speed: 0, source: job ? job.source : 'huggingface' }
      return progressPayload()
    }

    const sourceId = source && sourceById(source).id === source ? source : (job ? job.source : 'huggingface')
    cancelRequested = false
    job = {
      state: 'downloading',
      error: null,
      received: 0,
      total: totalModelBytes(),
      speed: 0,
      source: sourceId,
      startedAt: Date.now(),
      bytesAtLastTick: 0,
      lastTickAt: Date.now(),
      lastEmitAt: 0
    }
    /* 已经在的 .part 先算进总进度，别让进度条从 0 开始 */
    for (const file of MODEL_FILES) job.received += await sizeOf(partPath(file))
    emit('ai-subtitles:progress', progressPayload())

    ;(async () => {
      try {
        const remaining = Math.max(0, totalModelBytes() - job.received)
        await ensureDiskSpace(remaining)
        for (const file of MODEL_FILES) {
          if (await fileReady(file)) continue
          await downloadFile(file, sourceId)
          emit('ai-subtitles:progress', progressPayload())
        }
        job.state = 'ready'
        job.error = null
        tickProgress(true)
        emit('ai-subtitles:done', { ok: true })
      } catch (err) {
        const code = err && err.code ? err.code : 'network'
        job.state = 'error'
        job.error = { code, message: ERROR_TEXT[code] || '下载失败', detail: err && err.detail ? err.detail : String(err && err.message) }
        cancelRequested = false
        tickProgress(true)
        emit('ai-subtitles:done', { ok: false, error: job.error })
      } finally {
        activeRequest = null
      }
    })()

    return progressPayload()
  }

  /** 对外：取消（保留 .part 供续传） */
  function cancel () {
    if (!job || job.state !== 'downloading') return { cancelled: false }
    cancelRequested = true
    if (activeRequest) {
      try { activeRequest.abort() } catch { /* 已经结束 */ }
    }
    job.state = 'error'
    job.error = { code: 'cancelled', message: ERROR_TEXT.cancelled }
    tickProgress(true)
    emit('ai-subtitles:done', { ok: false, error: job.error })
    return { cancelled: true }
  }

  /** 对外：删除模型（连同 .part；状态回到未下载） */
  async function removeModel () {
    cancel()
    activeRequest = null
    cancelRequested = false
    await fsp.rm(modelsRoot(), { recursive: true, force: true })
    job = null
    const stillThere = fs.existsSync(modelDir()) || fs.existsSync(modelsRoot())
    emit('ai-subtitles:progress', progressPayload())
    return { removed: !stillThere }
  }

  /** 缓存信息（阶段 3 写、这里只统计与清理） */
  async function cacheInfo () {
    let entries = 0
    let bytes = 0
    try {
      const names = await fsp.readdir(cacheDir())
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        entries++
        bytes += await sizeOf(path.join(cacheDir(), name))
      }
    } catch { /* 目录不存在 = 0 条 */ }
    return {
      entries,
      bytes,
      bytesText: formatBytes(bytes),
      limitEntries: CACHE_LIMIT_ENTRIES,
      limitBytes: CACHE_LIMIT_BYTES
    }
  }

  async function clearCache () {
    await fsp.mkdir(cacheDir(), { recursive: true })
    const names = await fsp.readdir(cacheDir()).catch(() => [])
    for (const name of names) {
      await fsp.rm(path.join(cacheDir(), name), { force: true, recursive: true }).catch(() => {})
    }
    return await cacheInfo()
  }

  /** 阶段 3 用：三个文件的实际路径 */
  function paths () {
    return {
      model: modelPath(MODEL_FILES[0]),
      tokens: modelPath(MODEL_FILES[1]),
      vad: modelPath(MODEL_FILES[2]),
      cacheDir: cacheDir()
    }
  }

  return {
    status,
    download,
    cancel,
    removeModel,
    cacheInfo,
    clearCache,
    paths,
    /** 只给自检/调试用：直接看内存里的任务状态 */
    snapshot: () => (job ? { state: job.state, received: job.received, total: job.total, error: job.error } : null)
  }
}

module.exports = { createAiSubtitlesService }
