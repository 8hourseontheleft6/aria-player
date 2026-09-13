'use strict'

const { app } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 默认设置。新增字段只需在这里补一行，旧配置文件会自动合并。 */
const DEFAULTS = {
  version: 1,
  folders: [],
  theme: 'system',
  volume: 0.85,
  muted: false,
  playbackRate: 1,
  preservesPitch: true,
  playbackMode: 'loop-list',
  lyricOffsetMs: 0,
  lyricFontScale: 1,
  showRowArtwork: true,
  globalMediaKeys: true,
  showRemainingTime: false,
  reduceMotion: false,
  window: { width: 1180, height: 780, x: null, y: null, maximized: false },
  lastTrackPath: null,
  lastView: 'songs'
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeDeep (base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) out[key] = mergeDeep(base[key], value)
    else out[key] = value
  }
  return out
}

/**
 * 设置服务：JSON 持久化 + 变更广播。
 */
function createSettingsService (ctx) {
  const filePath = path.join(app.getPath('userData'), 'settings.json')
  let state = { ...DEFAULTS }
  let writeTimer = null
  let writing = null

  async function load () {
    try {
      const raw = await fsp.readFile(filePath, 'utf8')
      state = mergeDeep(DEFAULTS, JSON.parse(raw))
    } catch {
      state = { ...DEFAULTS }
      // 首次启动：默认把系统音乐目录加入资料库
      const musicDir = app.getPath('music')
      if (musicDir && fs.existsSync(musicDir)) state.folders = [musicDir]
    }
    return state
  }

  function snapshot () {
    return JSON.parse(JSON.stringify(state))
  }

  function scheduleWrite () {
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      writeTimer = null
      writing = persist()
    }, 250)
  }

  async function persist () {
    try {
      await fsp.mkdir(path.dirname(filePath), { recursive: true })
      await fsp.writeFile(filePath, JSON.stringify(state, null, 2), 'utf8')
    } catch (err) {
      console.error('[settings] 写入失败:', err)
    }
  }

  ctx.onCleanup(async () => {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    if (writing) await writing.catch(() => {})
    await persist()
  })

  return {
    DEFAULTS,
    filePath,

    /** 启动时读取配置文件 */
    init: load,

    /** @returns {object} 只读快照 */
    get: snapshot,

    /**
     * 合并写入设置并广播。
     * @param {object} patch
     * @param {{ silent?: boolean, immediate?: boolean }} [options]
     */
    set (patch, options = {}) {
      state = mergeDeep(state, patch)
      if (options.immediate) {
        if (writeTimer) {
          clearTimeout(writeTimer)
          writeTimer = null
        }
        writing = persist()
      } else {
        scheduleWrite()
      }
      if (!options.silent) ctx.emit('settings:changed', snapshot())
      return snapshot()
    },

    /** 把窗口几何信息写回（不广播，避免无谓的渲染层刷新） */
    setWindowState (partial) {
      state.window = { ...state.window, ...partial }
      scheduleWrite()
    },

    /** 立即落盘（退出前调用） */
    flush: persist
  }
}

module.exports = { createSettingsService, DEFAULTS }
