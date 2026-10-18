'use strict'

const { app } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 默认设置。新增字段只需在这里补一行，旧配置文件会自动合并。 */
const DEFAULTS = {
  // 睡眠定时器：选中的时长（分钟），0 = 关闭。定时器本身只在会话内有效，
  // 这个值只是"上次选的时长"，重启后不会自动开始倒计时。
  sleepTimerMinutes: 0,
  version: 1,
  folders: [],
  theme: 'system',
  /*
   * 主题色来源（--tint）：
   *   cover   —— 从当前封面取样（默认）。背景模糊图、底部光晕、示波器、选项框选中态，
   *              全都读 --tint，所以它们自动同一色系。
   *   palette —— 由「艺人|专辑」哈希出的稳定配色（不联网、不看封面，颜色一定整齐）。
   */
  tintSource: 'cover',
  /*
   * 本机 AI 字幕：默认**关**。开了它才会去下载模型（228MB）、才会在歌词页
   * 出现「生成」入口 —— 不点头就不下、不联网、不占空间。
   */
  aiSubtitles: false,
  /*
   * AI 字幕的两段**可选**文本后处理（默认都关）：
   * 开了才把**歌词文本**（不含音频）发到用户自己填的模型接口。
   */
  aiCorrect: false,
  aiTranslate: false,
  /* 空字符串 = 跟随界面语言 */
  aiTranslateLanguage: '',
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
  /*
   * 设置页自己的搜索历史。刻意与上面的 searchHistory 分开 ——
   * 那个是资料库搜索（歌名 / 专辑 / 艺人 / 歌词）的历史，两边词义完全不同，
   * 混在一起会让「搜过的设置词」把歌曲页的历史挤掉。
   */
  settingsSearchHistory: [],
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
   * 网络代理：'system' 跟随系统（默认）、'direct' 直连、'manual' 用下面的地址。
   * 起因是用户反馈「开了加速器还是取不到封面/头像」—— 不少加速器不设系统代理，
   * 这时要么切成「手动」填它的地址，要么切「直连」。默认值等于原来的行为，不影响任何人。
   * 在线歌词 / 封面 / 艺人头像都由主进程用 net.fetch 发出（走默认会话），所以一处生效全都走。
   */
  proxyMode: 'system',
  proxyUrl: '',
  /*
   * 音频可视化样式：bars（频谱+波形）| wave（示波器）| ring（环形）| off。
   * 顶栏那颗小按钮循环切换。选 off 时**不建 WebAudio 接入点**，播放路径保持原生。
   */
  visualizerStyle: 'bars',
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
  /*
   * 联网总开关：**默认关闭**。
   *
   * 为什么是关：这是一个本地播放器，开源发布的默认姿态应当是"不联网也能完整使用"。
   * 想用在线补全（歌词 / 封面 / 艺人头像）就在设置里自己打开总开关 —— 打开的瞬间会明确
   * 告诉用户它要访问哪些服务（LRCLIB / Deezer / iTunes），请求由用户机器直接发出。
   * 分项开关仍是"总闸之下"的细化：onlineLyrics / onlineCovers / onlineArtists。
   */
  onlineFeatures: false,
  onlineLyrics: false,
  onlineCovers: false,
  /*
   * 艺人头像：**默认关**（和总开关保持一致）。打开总开关后可以单独把它打开 ——
   * 在线查头像比拿专辑封面顶替更准（合作曲目不会挂错人），但那要联网，得用户自己选。
   */
  onlineArtists: false,
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
