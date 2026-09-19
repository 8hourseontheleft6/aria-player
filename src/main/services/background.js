'use strict'

/**
 * 最小化 / 收进托盘时的后台释放。
 *
 * 先说清楚能做什么、不能做什么，免得期待错位：
 *
 *   ✔ 渲染层的大头：媒体墙那 474 个格子（约 4000 个 DOM 节点）、封面 blob
 *     缓存（最多 120 张，解码后每张接近 1MB）、在线搜索/歌词结果、后台
 *     预热定时器 —— 这些是真正「用了就丢、回来再建」的东西；
 *   ✔ 主进程与渲染层的显式 GC（启动时加了 --js-flags=--expose-gc）；
 *   ✔ 长时间最小化后把目录监听的句柄关掉 —— Windows 上每个 fs.watch
 *     都占一个线程，回来时重新监听并做一次增量扫描补上；
 *   ✘ Chromium 自己的进程（GPU / 网络 / 音频 utility）不能单独杀：它们由
 *     Chromium 管理，杀掉要么直接崩、要么立刻重启，起不到减压作用；
 *     渲染进程更不可能杀 —— 它就是界面本身。所以「只保留必要线程」这件事，
 *     这里落实为「停掉不必要的**工作**」，而不是真的去 kill 进程。
 */

const { app, BrowserWindow } = require('electron')

/** 最小化后多久释放（避开快速最小化/还原来回抖） */
const RELEASE_DELAY = 4000
/** 一直不在前台超过这么久，连目录监听也停掉 */
const QUIET_DELAY = 45000
/** 等渲染层释放完再量内存，数字才有意义 */
const MEASURE_DELAY = 1500

/**
 * @param {object} ctx 主进程服务容器
 */
function createBackgroundService (ctx) {
  const settings = ctx.get('settings')
  const watcher = ctx.get('watcher')
  const library = ctx.get('library')

  /** @type {import('electron').BrowserWindow | null} */
  let win = null
  let releaseTimer = null
  let quietTimer = null
  let released = false
  let watcherPaused = false
  const stats = { releases: 0, resumes: 0, pausedWatcher: 0, lastRelease: null, lastResume: null }

  function enabled () {
    return settings.get().backgroundRelease !== false
  }

  /** 全部进程的内存合计（KB）。app.getAppMetrics 是 Electron 官方口径 */
  function memorySnapshot () {
    const metrics = app.getAppMetrics()
    let workingSetKB = 0
    let peakKB = 0
    const perProcess = []
    for (const metric of metrics) {
      const memory = metric.memory || {}
      workingSetKB += memory.workingSetSize || 0
      peakKB += memory.peakWorkingSetSize || 0
      perProcess.push({
        type: metric.type,
        pid: metric.pid,
        workingSetKB: memory.workingSetSize || 0
      })
    }
    return { processes: metrics.length, workingSetKB, peakKB, perProcess }
  }

  /** 不在前台（最小化，或收进了托盘） */
  function isAway () {
    return Boolean(win) && !win.isDestroyed() && (win.isMinimized() || !win.isVisible())
  }

  function clearTimers () {
    if (releaseTimer) {
      clearTimeout(releaseTimer)
      releaseTimer = null
    }
    if (quietTimer) {
      clearTimeout(quietTimer)
      quietTimer = null
    }
  }

  function release ({ force = false } = {}) {
    if (released || (!force && !isAway())) return
    released = true

    const before = memorySnapshot()
    // 主进程自己先回收一轮，再把渲染层叫醒去释放
    if (typeof global.gc === 'function') global.gc()
    if (!win.isDestroyed()) win.webContents.send('app:background', { phase: 'release' })

    setTimeout(() => {
      const after = memorySnapshot()
      stats.releases++
      stats.lastRelease = {
        at: Date.now(),
        beforeKB: before.workingSetKB,
        afterKB: after.workingSetKB,
        savedKB: before.workingSetKB - after.workingSetKB,
        processes: after.processes
      }
      console.log(
        `[background] 已释放后台占用：${Math.round(before.workingSetKB / 1024)}MB → ${Math.round(after.workingSetKB / 1024)}MB` +
        `（${after.processes} 个进程，省下 ${Math.round((before.workingSetKB - after.workingSetKB) / 1024)}MB）`
      )
      ctx.emit('background:released', stats.lastRelease)
    }, MEASURE_DELAY)
  }

  function pauseWatcher ({ force = false } = {}) {
    if (watcherPaused || (!force && !isAway())) return
    watcherPaused = true
    stats.pausedWatcher++
    watcher.stop()
    console.log('[background] 长时间不在前台：已停止目录监听（回来时会重新监听并做一次增量扫描）')
  }

  function resume () {
    if (!released && !watcherPaused) return
    clearTimers()
    const wasReleased = released
    const wasPaused = watcherPaused
    released = false
    watcherPaused = false

    if (wasReleased) {
      const before = memorySnapshot()
      if (!win.isDestroyed()) win.webContents.send('app:background', { phase: 'resume' })
      if (typeof global.gc === 'function') global.gc()
      stats.resumes++
      stats.lastResume = { at: Date.now(), beforeKB: before.workingSetKB, pausedWatcher: wasPaused }
    }

    if (wasPaused) {
      // 监听停了这么久，中间的变化没人记录，回来补一次增量扫描（文件没变时只做 stat）
      const result = watcher.start()
      library.scan({ reason: 'resume-refresh' }).catch((err) => {
        console.warn('[background] 恢复后的增量扫描失败:', err.message)
      })
      console.log(`[background] 已恢复目录监听（${result.watching} 个根目录）`)
    }
  }

  function schedule () {
    if (!enabled()) return
    clearTimers()
    releaseTimer = setTimeout(release, RELEASE_DELAY)
    quietTimer = setTimeout(pauseWatcher, QUIET_DELAY)
  }

  /** 把窗口接上；必须在 createMainWindow 之后调用 */
  function attach (browserWindow) {
    win = browserWindow
    for (const event of ['minimize', 'hide']) win.on(event, schedule)
    for (const event of ['restore', 'show', 'focus']) win.on(event, resume)
    win.on('closed', () => {
      clearTimers()
      win = null
    })
    return api
  }

  const api = {
    attach,
    release,
    resume,
    pauseWatcher,
    isReleased: () => released,
    isWatcherPaused: () => watcherPaused,
    /** 自检 / 调试用：最近一次释放与恢复的账 */
    get state () {
      return {
        enabled: enabled(),
        released,
        watcherPaused,
        away: isAway(),
        ...stats,
        memory: memorySnapshot(),
        watcher: watcher.getStats ? watcher.getStats() : null,
        windows: BrowserWindow.getAllWindows().length
      }
    }
  }

  return api
}

module.exports = { createBackgroundService }
