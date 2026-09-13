'use strict'

/**
 * 上下文隔离 + 沙箱下的渲染层 API 桥。
 * 只暴露白名单方法，渲染层拿不到 Node 能力。
 */

const { contextBridge, ipcRenderer } = require('electron')

/** 主 -> 渲染 的频道白名单，必须与 src/main/ipc.js 保持一致 */
const EVENT_CHANNELS = new Set([
  'settings:changed',
  'library:scan-progress',
  'window:maximized',
  'media:command',
  'theme:changed'
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
    info: () => ipcRenderer.invoke('app:info')
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
    reveal: (filePath) => ipcRenderer.invoke('library:reveal', filePath),
    onScanProgress: (handler) => on('library:scan-progress', handler)
  },

  lyrics: {
    load: (input) => ipcRenderer.invoke('lyrics:load', input)
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
  }
})
