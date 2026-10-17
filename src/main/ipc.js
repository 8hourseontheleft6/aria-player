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
  'theme:changed',
  /* player 档位：双击文件 / 拖到 Dock / 第二个实例带来的曲目 */
  'opened:incoming'
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
  /*
   * 档位差异：某些服务在这个档位里根本没挂（例如 player 没有 library / online）。
   *
   * 以前这里在**顶层**直接 `ctx.get('library')` —— 于是 player 档位一启动就
   * `服务未注册: library` 抛在 registerIpc 里，整个应用起不来。
   * 现在改成**懒解析**：注册频道时不碰服务，等到渲染层真的调那个频道才去取；
   * 取不到就由下面的包装器返回一个明确的"本档位没有这个能力"。
   * 这样"能力不存在"只在**用它的时候**显形，而不是把启动也一起挡掉 ——
   * 也顺带说明该能力在这个产品里本就不该被调用（渲染层那边也不该展示入口）。
   */
  const lazy = (name) => new Proxy({}, {
    get (_target, prop) {
      const service = ctx.get(name)
      const value = service[prop]
      return typeof value === 'function' ? value.bind(service) : value
    }
  })
  const library = lazy('library')
  const lyrics = lazy('lyrics')
  const online = lazy('online')
  const ai = lazy('ai')
  const sources = lazy('musicSources')

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
    'library:handle-drop': (_event, paths, options) => {
      /*
       * 拖放/双击的统一入口，按**能力**分流：
       *   · 本体：library.resolveDrop（库内的歌直接播、库外的问要不要把文件夹加进资料库）
       *   · player：openedFiles.resolve（只解析这次打开的文件，进临时队列 ——
       *     不建索引、不扫目录、不读封面、不联网；**也不弹确认框**）
       * 两条路都返回同一个形状（action / trackIds / rejected），所以渲染层的拖放处理不用分叉。
       * 多出来的 `tracks` 只在 player 路径上有 —— 渲染层看到它就先把曲目收进列表再播。
       */
      if (ctx.has('library')) return library.resolveDrop(paths, options || {})
      return ctx.get('openedFiles').resolve(paths)
    },
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
      'online:artist': (_event, payload) => online.fetchArtist(payload || {}),
    'online:clear-cache': () => online.clearCache(),
    'online:stats': () => online.getStats(),

    /* ---------- 外部模型（用户自填 API，走主进程发请求） ---------- */
    'ai:chat': (_event, payload) => ai.chat(payload || {}),
    'ai:test': () => ai.test(),
    'ai:status': () => ({ configured: ai.configured() }),

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
    /*
     * player 档位专属频道：打开文件 / 打开文件夹 / 最近打开。
     *
     * 只在真的挂了 openedFiles 的档位里注册 —— 本体没有这个服务，这些频道就不存在
     * （渲染层问一句 window.aria.opened 有没有就知道该不该显示入口）。
     * 用条件展开而不是在回调里判断：没注册的频道调不到，比"能调到但内部什么都不做"更干净。
     */
    ...(ctx.has('openedFiles')
      ? {
          'opened:recent': async () => {
            const opened = ctx.get('openedFiles')
            const [recent, resolved] = [opened.getRecent(), await opened.resolveRecent()]
            return { recent, tracks: resolved.tracks, missing: resolved.missing, total: resolved.total }
          },
          'opened:pick': async (_event, mode) => {
            /*
             * mode='folder' 时选目录，否则选文件。
             * 多选与"不建索引"都在 openedFiles.resolve 里统一处理；
             * 这里只负责把系统对话框的结果变成路径 —— 不做确认框（需求：拖 10 个也不要弹确认）。
             */
            const folder = mode === 'folder'
            const result = await dialog.showOpenDialog({
              title: folder ? '打开文件夹' : '打开文件',
              properties: folder ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
              filters: folder ? undefined : [{ name: '音频文件', extensions: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'oga', 'opus', 'aac', 'wma', 'aiff', 'aif'] }]
            })
            if (result.canceled || !result.filePaths.length) return { action: 'cancelled' }
            return ctx.get('openedFiles').resolve(result.filePaths)
          },
          /* 供自检使用：直接给一批路径，走与拖放/双击完全相同的解析链路 */
          'opened:resolve': (_event, paths) => ctx.get('openedFiles').resolve(paths)
        }
      : {}),
    'shell:open-external': (_event, url) => {
      if (typeof url === 'string' && /^https?:/i.test(url)) shell.openExternal(url)
      return true
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    /*
     * 包装一层：本档位没有的能力（懒解析时才抛"服务未注册"）返回 null 并留一行日志，
     * 其它异常照旧抛出去 —— 不要用一个大 try/catch 把所有错误都吞成"没有这个能力"，
     * 那会把真正的 bug 藏起来。
     */
    ipcMain.handle(channel, (event, payload) => {
      try {
        return handler(event, payload)
      } catch (error) {
        if (/服务未注册/.test(String(error && error.message))) {
          console.warn(`[ipc] ${channel}：本档位没有这个能力（${error.message}）`)
          return null
        }
        throw error
      }
    })
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
