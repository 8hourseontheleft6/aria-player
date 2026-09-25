'use strict'

const { ipcMain, BrowserWindow, app, globalShortcut, nativeTheme, shell, dialog } = require('electron')
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 主 -> 渲染的频道白名单（preload 也依赖这份清单，保持同步） */
const EVENT_CHANNELS = [
  'settings:changed',
  'library:scan-progress',
  'library:watch-update',
  'library:watch-error',
  'window:maximized',
  'media:command',
  'theme:changed'
]

const MEDIA_KEYS = [
  ['MediaPlayPause', 'play-pause'],
  ['MediaNextTrack', 'next'],
  ['MediaPreviousTrack', 'previous'],
  ['MediaStop', 'stop']
]

function broadcast (channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 系统级媒体键（需要设置里开启，默认开启） */
function registerMediaKeys (ctx) {
  const settings = ctx.get('settings')
  globalShortcut.unregisterAll()
  if (!settings.get().globalMediaKeys) return
  for (const [accelerator, command] of MEDIA_KEYS) {
    try {
      globalShortcut.register(accelerator, () => {
        // 统一走 player:command，托盘 / 缩略图按钮用的也是同一条链路
        ctx.emit('player:command', command)
      })
    } catch {
      // 某些环境（如被其他播放器占用）注册失败是可接受的
    }
  }
}

function registerIpc (ctx) {
  const settings = ctx.get('settings')
  const library = ctx.get('library')
  const lyrics = ctx.get('lyrics')
  const online = ctx.get('online')
  const sources = ctx.get('musicSources')

  /** @type {Map<string, Function>} */
  const handlers = {
    /* ---------- 设置 ---------- */
    'settings:get': () => settings.get(),
    'settings:set': (_event, patch) => {
      const next = settings.set(patch || {})
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'theme')) {
        require('./window').applyTheme(ctx, patch.theme)
      }
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'globalMediaKeys')) {
        registerMediaKeys(ctx)
      }
      return next
    },
    'settings:reset': () => {
      const { DEFAULTS } = require('./services/settings')
      return settings.set({ ...DEFAULTS, window: settings.get().window, folders: settings.get().folders })
    },

    /* ---------- 资料库 ---------- */
    'library:state': () => ({
      folders: library.getFolders(),
      stats: library.getStats()
    }),
    'library:tracks': () => library.getTracks(),
    'library:scan': (_event, options) => library.scan(options || {}),
    'library:add-folder': (_event, dir) => library.addFolder(dir),
    'library:remove-folder': (_event, dir) => library.removeFolder(dir),
    'library:pick-folders': () => library.pickFolders(),
    'library:artwork': (_event, trackId) => library.getArtwork(trackId),
    'library:artwork-stats': () => library.getArtworkStats(),
    'library:clear-artwork-cache': (_event, options) => library.clearArtworkCache(options || {}),
    'library:handle-drop': (_event, paths, options) => library.resolveDrop(paths, options || {}),
    // 深度搜索的歌词部分：只在用户选中「含歌词等」时才调用
    'library:search-lyrics': (_event, input) => library.searchLyrics(input || {}),
    'library:lyrics-index': () => library.getLyricsIndexStats(),
    'library:reveal': (_event, filePath) => {
      if (typeof filePath === 'string' && filePath) library.revealInFolder(filePath)
      return true
    },

    /* ---------- 歌词 ---------- */
    'lyrics:load': (_event, input) => lyrics.load(input || {}),

    /* ---------- 在线补全 ---------- */
    'online:lyrics': (_event, track) => online.fetchLyrics(track || {}),
    'online:cover': (_event, track) => online.fetchCover(track || {}),
    'online:clear-cache': () => online.clearCache(),
    'online:stats': () => online.getStats(),

    /* ---------- 在线音源（用户自己放进来的音源脚本） ---------- */
    'sources:list': () => sources.list(),
    'sources:reload': () => sources.load(),
    'sources:stats': () => sources.getStats(),
    'sources:set-enabled': (_event, id, enabled) => sources.setEnabled(String(id || ''), enabled),
    'sources:set-all-enabled': (_event, enabled) => sources.setAllEnabled(Boolean(enabled)),
    'sources:install': (_event, input) => sources.install(
      (input && input.text) || '',
      (input && input.name) || ''
    ),
    'sources:install-from-url': (_event, url) => sources.installFromUrl(url),
    'sources:remove': (_event, id) => sources.remove(String(id || '')),
    'sources:search': (_event, input) => sources.search((input && input.query) || '', input || {}),
    'sources:resolve': (_event, input) => sources.resolveUrl(input || {}),
    'sources:lyrics': (_event, input) => sources.resolveLyrics(input || {}),
    'sources:download-dir': () => sources.defaultDownloadDir(),
    'sources:pick-download-dir': async () => {
      const result = await dialog.showOpenDialog({
        title: '选择下载目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || !result.filePaths?.length) return null
      return result.filePaths[0]
    },
    'sources:download': async (event, input) => {
      const sender = event.sender
      const report = (progress) => {
        if (!sender.isDestroyed()) sender.send('sources:download-progress', progress)
      }
      const result = await sources.download(input || {}, (progress) => {
        report({ uid: (input && input.uid) || null, ...progress })
      })
      report({ uid: (input && input.uid) || null, done: true, percent: 100, path: result.path })
      return result
    },
    'sources:open-dir': async () => {
      const dir = sources.getDir()
      await shell.openPath(dir)
      return dir
    },
    'sources:pick-file': async () => {
      const result = await dialog.showOpenDialog({
        title: '选择音源脚本（.js）',
        properties: ['openFile'],
        filters: [{ name: '音源脚本', extensions: ['js'] }]
      })
      if (result.canceled || !result.filePaths?.length) return { canceled: true }
      const filePath = result.filePaths[0]
      const text = await fsp.readFile(filePath, 'utf8')
      return { canceled: false, text, name: path.basename(filePath) }
    },

    /* ---------- 窗口控制（自绘标题栏） ---------- */
    'window:minimize': (event) => BrowserWindow.fromWebContents(event.sender)?.minimize(),
    'window:toggle-maximize': (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      return win.isMaximized()
    },
    'window:close': (event) => BrowserWindow.fromWebContents(event.sender)?.close(),
    'window:state': (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return { maximized: Boolean(win?.isMaximized()), fullScreen: Boolean(win?.isFullScreen()) }
    },

    /* ---------- 其它 ---------- */
    'app:info': () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      userData: app.getPath('userData'),
      isMac: process.platform === 'darwin',
      /*
       * 系统媒体键清单（注册用的就是上面那张 MEDIA_KEYS 表）。
       * 设置页的快捷键列表直接渲染它 —— 之前那份是手写的，删掉一次就再也没人发现，
       * 于是「什么键对应什么操作」的说明凭空消失了。
       */
      mediaKeys: MEDIA_KEYS.map(([accelerator, command]) => ({ accelerator, command }))
    }),
    'shell:open-external': (_event, url) => {
      if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url)
      return true
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, handler)
  }

  /* ---------- 主进程事件 -> 渲染层 ---------- */
  const forwarders = [
    ['settings:changed', (payload) => broadcast('settings:changed', payload)],
    ['library:scan-progress', (payload) => broadcast('library:scan-progress', payload)],
    ['library:watch-update', (payload) => broadcast('library:watch-update', payload)],
    ['library:watch-error', (payload) => broadcast('library:watch-error', payload)]
  ]
  for (const [event, forward] of forwarders) ctx.on(event, forward)

  /* ---------- 渲染层 -> 主进程的单向上报（播放状态） ---------- */
  const onPlayerState = (event, state) => {
    if (!state || typeof state !== 'object') return
    ctx.emit('player:state', state)
  }
  ipcMain.on('player:state', onPlayerState)

  nativeTheme.on('updated', () => {
    broadcast('theme:changed', {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      themeSource: nativeTheme.themeSource
    })
  })

  registerMediaKeys(ctx)

  ctx.onCleanup(() => {
    globalShortcut.unregisterAll()
    ipcMain.removeListener('player:state', onPlayerState)
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  })

  return { EVENT_CHANNELS }
}

module.exports = { registerIpc, EVENT_CHANNELS, broadcast }
