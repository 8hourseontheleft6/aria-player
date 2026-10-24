'use strict'

/**
 * 自动更新（electron-updater + GitHub Releases）。
 *
 * 约定：
 *  · 只有打好的包才会检查（开发态 app.isPackaged=false，直接跳过；自检可以强制打开）；
 *  · 启动后**延迟**查一次，谁也不能阻塞启动；
 *  · 自动检查失败一律静默（只写日志）；手动检查失败才把原因告诉界面，且不轰炸；
 *  · 状态只有这几种，界面按它渲染文案：
 *      idle / checking / not-available / available / downloading / downloaded / error
 *  · 未签名包也能下载、也能重启安装 —— Windows 的 NSIS 不做签名校验，但 SmartScreen 仍会拦一下
 *    （这一点写在 README 里，不要承诺"没有提示"）。
 */

const { app, shell } = require('electron')

const STATES = ['idle', 'checking', 'not-available', 'available', 'downloading', 'downloaded', 'error']

/**
 * 这个产品该用哪个更新通道。
 *
 * 三个产品共用一个 GitHub 仓库：本体 latest.yml、player latest-player.yml、
 * unified latest-unified.yml。认 productName（打包后的 app.getName()），
 * 自动化里允许用 ARIA_PRODUCT 覆盖。
 */
function channelOf () {
  const forced = process.env.ARIA_PRODUCT
  if (forced === 'player' || forced === 'unified') return forced
  const name = String(app.getName() || '')
  if (/player/i.test(name) && !/unified/i.test(name)) return 'player'
  if (/unified/i.test(name)) return 'unified'
  return 'latest'
}

/** 纯函数：状态 → 给人看的一句话（自检直接测它） */
function describeState (state) {
  const value = state || {}
  switch (value.status) {
    case 'checking':
      return { title: '检查更新', text: '正在检查更新…', action: null }
    case 'not-available':
      return { title: '检查更新', text: `已是最新版本（${value.version || ''}）`.replace('（）', ''), action: null }
    case 'available':
      return { title: '发现新版本', text: `发现新版本 ${value.version || ''}，开始下载…`, action: null }
    case 'downloading': {
      const percent = Number(value.percent || 0)
      return {
        title: '正在下载更新',
        text: `正在下载 ${value.version || ''}：${percent.toFixed(0)}%`,
        action: null
      }
    }
    case 'downloaded':
      return {
        title: '更新已就绪',
        text: `${value.version || ''} 已下载完成，重启后安装。`,
        action: 'restart'
      }
    case 'error':
      return { title: '检查更新失败', text: value.message || '网络不可用，稍后再试', action: 'retry' }
    default:
      return { title: '检查更新', text: '还没检查过', action: null }
  }
}

/** 纯函数：把 electron-updater 的原始事件折成我们的状态（自检直接测它） */
function reduceEvent (current, event) {
  const base = current && typeof current === 'object' ? current : { status: 'idle' }
  switch (event.type) {
    case 'checking':
      return { ...base, status: 'checking', message: '' }
    case 'not-available':
      return { ...base, status: 'not-available', version: event.version || base.version || app.getVersion(), percent: 0 }
    case 'available':
      return { ...base, status: 'available', version: event.version || base.version, percent: 0 }
    case 'progress':
      return { ...base, status: 'downloading', percent: Number(event.percent) || 0 }
    case 'downloaded':
      return { ...base, status: 'downloaded', version: event.version || base.version, percent: 100 }
    case 'error':
      return { ...base, status: 'error', message: event.message || '检查更新失败' }
    default:
      return base
  }
}

function createUpdaterService (ctx) {
  const log = require('../util/log')

  let updater = null
  let unavailableReason = ''
  let state = { status: 'idle', version: app.getVersion(), percent: 0, message: '' }
  let timer = null
  let forced = false
  let feedOverride = ''

  function broadcast () {
    ctx.emit('updater:progress', { ...state })
  }

  function setState (next) {
    state = next
    broadcast()
    return { ...state }
  }

  /** 懒加载 electron-updater：开发态不加载（它自己会打一堆警告） */
  function lib () {
    if (updater) return updater
    try {
      updater = require('electron-updater')
      const { autoUpdater } = updater
      autoUpdater.autoDownload = false
      /* 自检要在开发态验证整条链路 —— electron-updater 默认在 dev 下不工作 */
      if (forced) autoUpdater.forceDevUpdateConfig = true
      /*
       * 三个产品共用一个 GitHub 仓库：本体用 latest.yml，
       * player / unified 用 latest-player.yml / latest-unified.yml（electron-builder 的 channel）。
       * 不设 channel 的话，player 会把本体的安装包当成自己的更新。
       */
      autoUpdater.channel = channelOf()
      log.info('更新通道', { channel: autoUpdater.channel })
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.logger = {
        info: (message) => log.info('[updater] ' + message),
        warn: (message) => log.warn('[updater] ' + message),
        error: (message) => log.error('[updater] ' + message),
        debug: () => {}
      }
      autoUpdater.on('checking-for-update', () => setState(reduceEvent(state, { type: 'checking' })))
      autoUpdater.on('update-available', (info) => {
        setState(reduceEvent(state, { type: 'available', version: info && info.version }))
        // 发现就下：界面显示进度，下完给「重启安装」
        autoUpdater.downloadUpdate().catch((error) => {
          log.warn('下载更新失败', { message: String(error && error.message) })
          setState(reduceEvent(state, { type: 'error', message: '下载失败，稍后再试' }))
        })
      })
      autoUpdater.on('update-not-available', (info) => {
        setState(reduceEvent(state, { type: 'not-available', version: (info && info.version) || app.getVersion() }))
      })
      autoUpdater.on('download-progress', (progress) => {
        setState(reduceEvent(state, { type: 'progress', percent: progress && progress.percent }))
      })
      autoUpdater.on('update-downloaded', (info) => {
        setState(reduceEvent(state, { type: 'downloaded', version: info && info.version }))
      })
      autoUpdater.on('error', (error) => {
        log.warn('更新检查出错', { message: String(error && error.message) })
        setState(reduceEvent(state, { type: 'error', message: '网络不可用，稍后再试' }))
      })
      return updater
    } catch (error) {
      unavailableReason = String((error && error.message) || error)
      log.warn('electron-updater 不可用', { message: unavailableReason })
      return null
    }
  }

  /** 能不能真的更新：打好的包，或显式打开了强制模式（自检用） */
  function isActive () {
    if (app.isPackaged || forced) return true
    unavailableReason = '开发态不检查更新（用 --force-update 或自检模式打开）'
    return false
  }

  async function check ({ manual = false } = {}) {
    if (!isActive()) {
      return { ok: false, code: 'inactive', message: unavailableReason, state: { ...state } }
    }
    const module = lib()
    if (!module) {
      return { ok: false, code: 'unavailable', message: unavailableReason, state: { ...state } }
    }
    if (feedOverride) {
      try {
        module.autoUpdater.setFeedURL({ provider: 'generic', url: feedOverride })
        log.info('更新源改为本地 feed', { url: feedOverride })
      } catch (error) {
        return { ok: false, code: 'feed-failed', message: String(error && error.message), state: { ...state } }
      }
    }
    try {
      setState(reduceEvent(state, { type: 'checking' }))
      const result = await module.autoUpdater.checkForUpdates()
      return { ok: true, state: { ...state }, version: result && result.updateInfo && result.updateInfo.version }
    } catch (error) {
      const message = String((error && error.message) || error)
      log.warn('检查更新失败', { manual, message })
      /* 自动检查失败：静默（只留日志）。手动检查才回错误文案 —— 不弹窗轰炸。 */
      if (manual) setState(reduceEvent(state, { type: 'error', message: '网络不可用，稍后再试' }))
      return { ok: false, code: 'check-failed', message, state: { ...state } }
    }
  }

  return {
    /** 当前状态 + 能不能用（设置页渲染用） */
    state () {
      return {
        ...state,
        current: app.getVersion(),
        active: isActive(),
        reason: isActive() ? '' : unavailableReason,
        describe: describeState(state)
      }
    },

    async check ({ manual = true } = {}) {
      const result = await check({ manual })
      return { ...result, describe: describeState(state) }
    },

    async download () {
      const module = lib()
      if (!module) return { ok: false, code: 'unavailable', message: unavailableReason }
      try {
        await module.autoUpdater.downloadUpdate()
        return { ok: true, state: { ...state } }
      } catch (error) {
        return { ok: false, code: 'download-failed', message: String((error && error.message) || error) }
      }
    },

    /** 重启并安装；beforeQuit 已经做了 flush（settings/queue），这里只管交棒 */
    install () {
      const module = lib()
      if (!module) return { ok: false, code: 'unavailable', message: unavailableReason }
      if (state.status !== 'downloaded') {
        return { ok: false, code: 'not-ready', message: '更新还没下载完' }
      }
      setImmediate(() => module.autoUpdater.quitAndInstall(false, true))
      return { ok: true }
    },

    /** 启动后延迟检查（不阻塞启动）；同一个进程只挂一次 */
    schedule (delayMs = 20000) {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        if (!isActive()) return
        check({ manual: false }).catch(() => {})
      }, Math.max(1000, Number(delayMs) || 20000))
      if (timer.unref) timer.unref()
    },

    /* ---- 下面两个只给自检用 ---- */
    forceForTests (value) { forced = value === true },
    useFeed (url) { feedOverride = String(url || '') }
  }
}

module.exports = { createUpdaterService, describeState, reduceEvent, channelOf, STATES }
