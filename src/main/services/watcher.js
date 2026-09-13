'use strict'

/**
 * 目录监听：音乐文件夹里的增删改自动刷新资料库。
 *
 * 设计要点：
 *  - 一个根目录一个递归 watcher（Windows / macOS / Linux 都支持 recursive）
 *  - 事件按扩展名过滤：只管音频与歌词/封面文件，忽略 .tmp/.part/desktop.ini 之类
 *  - 防抖：复制一张专辑会产生几十个事件，等安静下来再扫一次
 *  - 扫描进行中则顺延，避免两次扫描打架
 */

const fs = require('node:fs')
const path = require('node:path')

const AUDIO_PATTERN = /\.(mp3|m4a|m4b|aac|flac|wav|wave|ogg|oga|opus|weba|webm|aiff|aif)$/i
const SIDECAR_PATTERN = /\.(lrc|txt|jpg|jpeg|png|webp)$/i
const IGNORED_PATTERN = /(^|[\\/])(\.|~\$)|\.(tmp|part|crdownload|download|bak)$/i

const DEFAULT_DEBOUNCE = 4000

function createWatcherService (ctx) {
  const settings = ctx.get('settings')
  const library = ctx.get('library')

  /** @type {Array<{root: string, watcher: fs.FSWatcher}>} */
  let active = []
  let debounceMs = DEFAULT_DEBOUNCE
  let timer = null
  let pendingPaths = new Set()
  let stats = { changes: 0, lastChangeAt: 0, lastPaths: [], rescans: 0, restarts: 0 }
  let lastRoots = []

  function relevant (filename) {
    if (!filename) return true // 有些平台不给文件名，只能当作可能相关
    if (IGNORED_PATTERN.test(filename)) return false
    return AUDIO_PATTERN.test(filename) || SIDECAR_PATTERN.test(filename)
  }

  function schedule () {
    if (timer) clearTimeout(timer)
    timer = setTimeout(runScan, debounceMs)
  }

  async function runScan () {
    timer = null
    const paths = [...pendingPaths]
    pendingPaths.clear()

    // 扫描还没结束就先等着，别让两次扫描互相覆盖
    if (library.getStats().scanning) {
      for (const item of paths) pendingPaths.add(item)
      schedule()
      return
    }

    const before = library.getTracks().length
    try {
      const summary = await library.scan({ reason: 'watch' })
      stats.rescans++
      // 记录到终端：出问题时能看出到底是哪个文件在动
      console.log(`[watcher] 重扫完成：${paths.length} 个路径变化，实际新增 ${summary.added} / 移除 ${summary.removed}` +
        (paths.length ? `（例：${paths[0]}）` : ''))
      ctx.emit('library:watch-update', {
        paths,
        before,
        after: summary.count,
        delta: summary.count - before,
        added: summary.added,
        removed: summary.removed,
        scannedAt: summary.scannedAt
      })
    } catch (err) {
      console.error('[watcher] 触发扫描失败:', err)
      ctx.emit('library:watch-error', { message: err.message })
    }
  }

  function stop () {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    for (const entry of active) {
      try {
        entry.watcher.close()
      } catch {
        // 已经关掉了
      }
    }
    active = []
    pendingPaths.clear()
  }

  /**
   * 开始监听。不传参数时监听资料库里的所有文件夹（测试可以显式传入目录）。
   * @param {string[]} [roots]
   */
  function start (roots) {
    stop()
    if (!Array.isArray(roots)) {
      if (settings.get().watchFolders === false) {
        lastRoots = []
        return { watching: 0, skipped: 'disabled' }
      }
      roots = library.getFolders()
    }
    lastRoots = roots.slice()
    stats.restarts++

    let failed = 0
    for (const root of roots) {
      try {
        const watcher = fs.watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
          if (!relevant(filename)) return
          const full = filename ? path.join(root, filename) : root
          pendingPaths.add(full)
          stats.changes++
          stats.lastChangeAt = Date.now()
          stats.lastPaths = [...pendingPaths].slice(-20)
          schedule()
        })
        watcher.on('error', (err) => {
          console.warn(`[watcher] ${root} 监听异常: ${err.message}`)
          ctx.emit('library:watch-error', { message: err.message, root })
        })
        active.push({ root, watcher })
      } catch (err) {
        failed++
        console.warn(`[watcher] 无法监听 ${root}: ${err.message}`)
      }
    }
    return { watching: active.length, failed, roots: lastRoots }
  }

  /** 供设置页/自检使用：调整防抖窗口 */
  function configure (options = {}) {
    if (Number.isFinite(options.debounceMs)) debounceMs = Math.max(50, options.debounceMs)
    return { debounceMs }
  }

  ctx.onCleanup(stop)

  return {
    start,
    stop,
    configure,
    getStats: () => ({
      ...stats,
      debounceMs,
      roots: lastRoots,
      watching: active.length,
      pending: [...pendingPaths]
    })
  }
}

module.exports = { createWatcherService }
