'use strict'

const { BrowserWindow, nativeTheme, shell, Menu } = require('electron')
const path = require('node:path')

const IS_MAC = process.platform === 'darwin'

const THEME_BACKGROUND = {
  dark: '#0b0b0f',
  light: '#f2f2f7'
}

/**
 * 创建主窗口。iOS 风格需要自绘标题栏：
 *  - macOS 保留原生红绿灯（hiddenInset），窗口其余部分自绘
 *  - Windows / Linux 无边框 + 自绘窗口按钮（由渲染层通过 IPC 控制）
 */
function createMainWindow (ctx) {
  const settings = ctx.get('settings')
  const state = settings.get()
  const saved = state.window || {}
  const dark = state.theme === 'dark' || (state.theme === 'system' && nativeTheme.shouldUseDarkColors)

  const options = {
    width: saved.width || 1180,
    height: saved.height || 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: dark ? THEME_BACKGROUND.dark : THEME_BACKGROUND.light,
    title: 'Aria',
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
      backgroundThrottling: false
    }
  }

  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    options.x = saved.x
    options.y = saved.y
  }

  const win = new BrowserWindow(options)

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
  let saveTimer = null
  const persistGeometry = () => {
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
  win.on('close', () => {
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

module.exports = { createMainWindow, applyTheme, IS_MAC }
