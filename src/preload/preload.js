'use strict'

/**
 * 上下文隔离 + 沙箱下的渲染层 API 桥。
 * 只暴露白名单方法，渲染层拿不到 Node 能力。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

/** 主 -> 渲染 的频道白名单，必须与 src/main/ipc.js 保持一致 */
const EVENT_CHANNELS = new Set([
  'settings:changed',
  'library:scan-progress',
  'library:watch-update',
  'library:watch-error',
  'window:maximized',
  'media:command',
  'theme:changed',
  /* player 档位：双击文件 / 拖到 Dock / 第二个实例带来的曲目（主进程解析好后推过来） */
  'opened:incoming',
  // 在线音源下载进度（主进程按 uid 推送）
  'sources:download-progress',
  // 最小化 / 收进托盘时通知渲染层释放后台占用，回来时通知恢复
  'app:background'
])

function on (channel, handler) {
  if (!EVENT_CHANNELS.has(channel)) {
    throw new Error(`未允许的事件频道: ${channel}`)
  }
  const listener = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload)

/*
 * 产品档位：主进程通过 additionalArguments 把整份档位 JSON 塞进命令行。
 * 沙箱里的 preload 仍能读 process.argv，所以渲染层在建 store / 注册插件之前就能**同步**拿到 ——
 * 不经过 IPC，就没有"先按 full 建好、再删掉"的时序问题。
 * 解析失败一律退回 full：渲染层拿不到档位时，宁可按本体渲染（能力齐全），
 * 也不该渲染出一个缺胳膊少腿的界面。
 */
const PROFILE_ARG = '--aria-profile-json='
const profileArg = (process.argv || []).find((arg) => String(arg).startsWith(PROFILE_ARG))
const fallbackProfile = { id: 'full', productName: 'Aria', plugins: [], capabilities: { library: true, online: true, lyrics: true }, sidebar: ['songs', 'albums', 'artists', 'wall'] }
let profile = fallbackProfile
if (profileArg) {
  try {
    const parsed = JSON.parse(String(profileArg).slice(PROFILE_ARG.length))
    if (parsed && typeof parsed.id === 'string') {
      profile = {
        id: parsed.id,
        productName: typeof parsed.productName === 'string' ? parsed.productName : 'Aria',
        plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
        capabilities: parsed.capabilities && typeof parsed.capabilities === 'object' ? parsed.capabilities : {},
        sidebar: Array.isArray(parsed.sidebar) && parsed.sidebar.length ? parsed.sidebar : fallbackProfile.sidebar
      }
    }
  } catch (err) {
    console.warn('[preload] 档位 JSON 解析失败，按 full 处理：', err && err.message)
  }
}

contextBridge.exposeInMainWorld('aria', {
  platform: process.platform,
  isMac: process.platform === 'darwin',
  // 档位只读：渲染层据此决定注册哪些插件、侧栏放哪几项
  profile,

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    /** 最小化 / 收进托盘的释放与恢复通知（payload: { phase: 'release' | 'resume' }） */
    onBackgroundChange: (handler) => on('app:background', handler)
  },

  /*
   * player 档位专属：打开文件 / 打开文件夹 / 最近打开。
   *
   * 只在**真的没有资料库能力的档位**里出现 —— 主进程那边这些频道同样只在这种档位注册。
   * 渲染层用 `if (window.aria.opened)` 判断入口显不显示（问能力，不问身份）。
   */
  opened: profile.capabilities && profile.capabilities.library === false
    ? {
        recent: () => ipcRenderer.invoke('opened:recent'),
        pick: (mode) => ipcRenderer.invoke('opened:pick', mode),
        resolve: (paths) => ipcRenderer.invoke('opened:resolve', paths),
        /* 双击文件 / 拖到 Dock / 第二个实例带来的路径：主进程解析好后推过来 */
        onIncoming: (handler) => on('opened:incoming', handler)
      }
    : undefined,

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
    onChanged: (handler) => on('settings:changed', handler)
  },

  library: {
    state: () => ipcRenderer.invoke('library:state'),
    tracks: () => ipcRenderer.invoke('library:tracks'),
    scan: (options) => ipcRenderer.invoke('library:scan', options),
    addFolder: (dir) => ipcRenderer.invoke('library:add-folder', dir),
    removeFolder: (dir) => ipcRenderer.invoke('library:remove-folder', dir),
    pickFolders: () => ipcRenderer.invoke('library:pick-folders'),
    artwork: (trackId) => ipcRenderer.invoke('library:artwork', trackId),
    artworkStats: () => ipcRenderer.invoke('library:artwork-stats'),
    clearArtworkCache: () => ipcRenderer.invoke('library:clear-artwork-cache'),
    reveal: (filePath) => ipcRenderer.invoke('library:reveal', filePath),
    handleDrop: (paths, options) => ipcRenderer.invoke('library:handle-drop', paths, options),
    searchLyrics: (input) => ipcRenderer.invoke('library:search-lyrics', input),
    lyricsIndex: () => ipcRenderer.invoke('library:lyrics-index'),
    onScanProgress: (handler) => on('library:scan-progress', handler),
    onWatchUpdate: (handler) => on('library:watch-update', handler),
    onWatchError: (handler) => on('library:watch-error', handler)
  },

  /*
   * 外部模型：请求由主进程发出（渲染层的 CSP 不允许外部 HTTP），
   * 已保存的密钥也不会被读回渲染层 —— 这里只有「发内容」和「测连接」两件事。
   */
  ai: {
    chat: (payload) => ipcRenderer.invoke('ai:chat', payload),
    test: () => ipcRenderer.invoke('ai:test'),
    status: () => ipcRenderer.invoke('ai:status')
  },

  lyrics: {
    load: (input) => ipcRenderer.invoke('lyrics:load', input)  },

  online: {
    lyrics: (track) => ipcRenderer.invoke('online:lyrics', track),
    cover: (track) => ipcRenderer.invoke('online:cover', track),
    artist: (payload) => ipcRenderer.invoke('online:artist', payload),
    clearCache: () => ipcRenderer.invoke('online:clear-cache'),
    stats: () => ipcRenderer.invoke('online:stats')
  },

  /* 在线音源：脚本由用户自己放进 <userData>/music-sources，这里只做管理 / 搜索 / 解析 */
  sources: {
    list: () => ipcRenderer.invoke('sources:list'),
    reload: () => ipcRenderer.invoke('sources:reload'),
    stats: () => ipcRenderer.invoke('sources:stats'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('sources:set-enabled', id, enabled),
    setAllEnabled: (enabled) => ipcRenderer.invoke('sources:set-all-enabled', enabled),
    install: (input) => ipcRenderer.invoke('sources:install', input),
    installFromUrl: (url) => ipcRenderer.invoke('sources:install-from-url', url),
    remove: (id) => ipcRenderer.invoke('sources:remove', id),
    search: (input) => ipcRenderer.invoke('sources:search', input),
    resolve: (input) => ipcRenderer.invoke('sources:resolve', input),
    lyrics: (input) => ipcRenderer.invoke('sources:lyrics', input),
    defaultDownloadDir: () => ipcRenderer.invoke('sources:download-dir'),
    pickDownloadDir: () => ipcRenderer.invoke('sources:pick-download-dir'),
    download: (input) => ipcRenderer.invoke('sources:download', input),
    onDownloadProgress: (handler) => on('sources:download-progress', handler),
    openDir: () => ipcRenderer.invoke('sources:open-dir'),
    pickFile: () => ipcRenderer.invoke('sources:pick-file')
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    state: () => ipcRenderer.invoke('window:state'),
    onMaximizedChange: (handler) => on('window:maximized', handler)
  },

  media: {
    onCommand: (handler) => on('media:command', handler)
  },

  /** 单向把播放状态上报给主进程（托盘提示、任务栏进度、缩略图按钮用） */
  player: {
    reportState: (state) => {
      try {
        ipcRenderer.send('player:state', state)
      } catch {
        // 主进程已退出时忽略
      }
    }
  },

  theme: {
    onChanged: (handler) => on('theme:changed', handler)
  },

  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
  },

  /**
   * 把拖进窗口的 File 对象解析成本地路径。
   * Electron 32 起 File.path 被移除，必须经由 webUtils。
   */
  paths: {
    fromFiles: (files) => {
      const out = []
      // 传进来的必须是数组（FileList 无法跨 contextBridge 传递）
      for (const file of Array.from(files || [])) {
        try {
          const path = webUtils.getPathForFile(file)
          if (path) out.push(path)
        } catch {
          // 非真实文件（例如从网页拖来的内存 Blob）拿不到路径，跳过
        }
      }
      return out
    }
  }
})
