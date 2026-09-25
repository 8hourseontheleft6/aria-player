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
  showFps: false,
  // 搜索：basic = 只搜歌曲信息（歌名/专辑/艺人），deep = 连歌词、年份、流派、文件名等一起搜
  searchScope: 'basic',
  searchHistory: [],
  // 从歌词搜索结果里点开歌曲时，是否自动跳到命中的那一句
  jumpToMatchedLyric: true,
  // 列表里单击歌曲就直接播放（默认关闭：单击只选中，双击才播放）
  playOnSingleClick: false,
  // 输出设备 id（空 = 跟随系统）。通话 / 游戏语音时把音乐单独送到耳机，
  // 麦克风就拾不到音乐，通话对方也就听不到
  audioOutputDevice: '',
  // 声音均衡器：enabled 总开关；auto 按流派自动挑预设；preset 关掉自动后用手动选的
  equalizer: { enabled: false, auto: true, preset: 'flat' },
  // 自动均衡时是否用「声音特征分析」辅助判断风格（本地解码，不联网）
  styleAnalysis: true,
  /*
   * 外部模型（用户自填 API，OpenAI 兼容的 /chat/completions）。
   * 目前只用于「判断风格挑均衡器预设」：只发文本（曲目信息 + 本地特征），
   * 音频文件不上传。密钥存在本机的 settings.json 里，且不会被读回渲染层。
   */
  ai: {
    enabled: false,
    useForStyle: true,
    baseUrl: '',
    key: '',
    model: '',
    timeout: 30000
  },
  // 侧边栏 / 灵动岛里视图项的顺序（可拖动自定义）
  sidebarOrder: ['songs', 'albums', 'artists', 'wall'],
  // 默认侧栏与灵动岛不同时出现；打开后侧栏开着也显示灵动岛
  islandWithSidebar: false,
  // 用户自建播放列表：[{ id, name, trackIds, createdAt }]
  playlists: [],
  // 在线音源（用户自己放进来的音源脚本）：总开关默认关闭，与在线补全保持一致
  onlineSources: false,
  // 音源开关状态（id -> { enabled }）；脚本本身放在 <userData>/music-sources
  musicSources: {},
  // 在线音源的下载目录；留空表示「第一个音乐文件夹」
  downloadDir: '',
  wallLayout: 'canvas',
  // 最小化 / 收进托盘后释放后台占用（媒体墙 DOM、封面缓存、目录监听），回来再建
  backgroundRelease: true,
  prewarmArtwork: true,
  trayEnabled: true,
  closeToTray: false,
  taskbarProgress: true,
  watchFolders: true,
  // 在线补全默认关闭：这是本项目唯一的联网功能
  onlineFeatures: false,
  onlineLyrics: true,
  onlineCovers: true,
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
