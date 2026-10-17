'use strict'

const { BrowserWindow, nativeTheme, shell, Menu, app } = require('electron')
const path = require('node:path')

const { createTransportIcon, WHITE } = require('./util/raster')

const IS_MAC = process.platform === 'darwin'
const IS_WINDOWS = process.platform === 'win32'

const THEME_BACKGROUND = {
  dark: '#0b0b0f',
  light: '#f2f2f7'
}

/** 由 main 在退出流程里置位，避免「关闭到托盘」把退出也拦下来 */
let quitting = false
function markQuitting () {
  quitting = true
}

/** 任务栏缩略图按钮的图标只生成一次 */
let transportIcons = null
function getTransportIcons () {
  if (!transportIcons) {
    transportIcons = {
      prev: createTransportIcon('prev', WHITE),
      play: createTransportIcon('play', WHITE),
      pause: createTransportIcon('pause', WHITE),
      next: createTransportIcon('next', WHITE)
    }
  }
  return transportIcons
}

/**
 * 任务栏进度 + 缩略图按钮（Windows）。
 * @param {BrowserWindow} win
 * @param {{ status: string, progress: number, hasPrev?: boolean, hasNext?: boolean }} state
 * @param {{ progressEnabled?: boolean }} options
 */
function applyTaskbarState (win, state, options = {}) {
  if (!win || win.isDestroyed()) return

  const playing = state.status === 'playing' || state.status === 'loading' || state.status === 'buffering'
  const showProgress = options.progressEnabled !== false && playing && Number.isFinite(state.progress)

  if (IS_WINDOWS || process.platform === 'darwin') {
    try {
      win.setProgressBar(showProgress ? Math.min(1, Math.max(0, state.progress)) : -1)
    } catch {
      // 个别环境不支持，忽略
    }
  }

  if (!IS_WINDOWS) return
  const icons = getTransportIcons()
  const send = (command) => {
    if (!win.isDestroyed()) win.webContents.send('media:command', command)
  }
  try {
    win.setThumbarButtons([
      { tooltip: '上一首', icon: icons.prev, click: () => send('previous') },
      { tooltip: playing ? '暂停' : '播放', icon: playing ? icons.pause : icons.play, click: () => send('play-pause') },
      { tooltip: '下一首', icon: icons.next, click: () => send('next') }
    ])
  } catch {
    // 缩略图按钮在部分 Windows 环境下不可用
  }
}

/**
 * 创建主窗口。iOS 风格需要自绘标题栏：
 *  - macOS 保留原生红绿灯（hiddenInset），窗口其余部分自绘
 *  - Windows / Linux 无边框 + 自绘窗口按钮（由渲染层通过 IPC 控制）
 */
function createMainWindow (ctx, profile) {
  const settings = ctx.get('settings')
  const state = settings.get()
  const saved = state.window || {}
  const dark = state.theme === 'dark' || (state.theme === 'system' && nativeTheme.shouldUseDarkColors)
  /*
   * 档位由 main.js 显式传进来（不放进服务表：服务表是"能力清单"，
   * 档位是"我是谁"，混在一起会让 check-profiles 的规则变浑）。
   */

  const options = {
    width: saved.width || 1180,
    height: saved.height || 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: dark ? THEME_BACKGROUND.dark : THEME_BACKGROUND.light,
    title: profile.productName,
    autoHideMenuBar: true,
    // 自绘顶栏，避免系统标题栏破坏 iOS 观感
    frame: IS_MAC,
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // 后台播放时不要被节流，否则进度条与歌词会卡
      backgroundThrottling: false,
      /*
       * 档位随命令行交给渲染层：preload（沙箱内仍能读 process.argv）解析这一项，
       * 渲染层在**建 store、注册插件之前**就能同步拿到，避免异步时序问题。
       * 传整份 JSON（含 plugins / sidebar 清单）是为了让 profile.js 保持**唯一事实来源** ——
       * 渲染层不抄一份清单，否则两边迟早不一致。
       */
      additionalArguments: [`--aria-profile-json=${JSON.stringify({
        id: profile.id,
        productName: profile.productName,
        plugins: profile.plugins,
        capabilities: profile.capabilities,
        sidebar: profile.sidebar
      })}`]
    }
  }

  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    options.x = saved.x
    options.y = saved.y
  }

  const win = new BrowserWindow(options)

  /*
   * 放行 media 权限：没有它时 enumerateDevices() 返回的设备**名字是空的**，
   * 用户就没法在设置里认出「哪个是我的耳机」（输出设备那条设置要用）。
   * 只放行 media，其它权限一律拒绝。
   */
  win.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media')
  })
  win.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === 'media')

  if (!IS_MAC) Menu.setApplicationMenu(null)

  if (saved.maximized) win.maximize()

  win.loadURL('app://bundle/index.html')

  win.once('ready-to-show', () => {
    win.show()
    if (!IS_MAC && process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' })
  })

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://')) {
      event.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  // 把渲染层控制台输出转发到终端，方便排查（打包后也会保留 warning/error）
  win.webContents.on('console-message', (...args) => {
    const first = args[0]
    const details = first && typeof first === 'object' && 'message' in first
      ? { level: first.level, message: first.message, line: first.lineNumber, source: first.sourceId }
      : { level: args[1], message: args[2], line: args[3], source: args[4] }
    const levels = ['verbose', 'info', 'warning', 'error']
    const level = typeof details.level === 'number' ? levels[details.level] || 'log' : String(details.level)
    if (level === 'verbose') return
    const source = details.source ? ` (${String(details.source).replace(/^app:\/\/[^/]+/, '')}:${details.line})` : ''
    const stream = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log
    stream(`[renderer:${level}] ${details.message}${source}`)
  })

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[main] 页面加载失败 ${code} ${description} ${url}`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] 渲染进程异常退出:', details.reason)
  })

  // 开发期快捷键
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
    if (input.control && key === 'r') {
      win.webContents.reload()
      event.preventDefault()
    }
  })

  /* ---------------- 窗口尺寸持久化 ---------------- */
  /*
   * 自动化模式（自检 / 截图 / 帧率诊断 / 视觉审计）不写回窗口尺寸：
   * 它们会按自己的需要开窗，退出时如果照常保存，就会把用户上次的窗口大小覆盖掉
   * —— 跑一次 npm run smoke 就把用户的窗口改成开发环境的尺寸，很难受。
   */
  const automated = ['--smoke', '--shots', '--perf', '--audit'].some((flag) => process.argv.includes(flag))
  let saveTimer = null
  const persistGeometry = () => {
    if (automated) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (win.isDestroyed()) return
      const maximized = win.isMaximized()
      const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
      settings.setWindowState({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized
      })
    }, 400)
  }

  win.on('resize', persistGeometry)
  win.on('move', persistGeometry)
  win.on('maximize', () => {
    persistGeometry()
    win.webContents.send('window:maximized', true)
  })
  win.on('unmaximize', () => {
    persistGeometry()
    win.webContents.send('window:maximized', false)
  })
  win.on('close', (event) => {
    // 「关闭到托盘」：隐藏窗口而不是退出。托盘被关掉时这个设置无效，
    // 否则用户会失去把窗口找回来的入口。
    const trayAlive = ctx.has('tray') && ctx.get('tray').exists
    if (!quitting && settings.get().closeToTray && trayAlive) {
      event.preventDefault()
      if (saveTimer) clearTimeout(saveTimer)
      persistGeometry()
      settings.flush()
      win.hide()
      return
    }
    if (saveTimer) clearTimeout(saveTimer)
    persistGeometry()
    settings.flush()
  })

  return win
}

/** 主题切换：把 Electron 的 themeSource 与窗口底色一起更新 */
function applyTheme (ctx, theme) {
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors)
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(dark ? THEME_BACKGROUND.dark : THEME_BACKGROUND.light)
  }
}

module.exports = { createMainWindow, applyTheme, applyTaskbarState, markQuitting, IS_MAC }
