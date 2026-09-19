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

contextBridge.exposeInMainWorld('aria', {
  platform: process.platform,
  isMac: process.platform === 'darwin',

  app: {
    info: () => ipcRenderer.invoke('app:info'),
    /** 最小化 / 收进托盘的释放与恢复通知（payload: { phase: 'release' | 'resume' }） */
    onBackgroundChange: (handler) => on('app:background', handler)
  },

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

  lyrics: {
    load: (input) => ipcRenderer.invoke('lyrics:load', input)
  },

  online: {
    lyrics: (track) => ipcRenderer.invoke('online:lyrics', track),
    cover: (track) => ipcRenderer.invoke('online:cover', track),
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
