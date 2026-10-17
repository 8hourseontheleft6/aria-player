'use strict'

const { BrowserWindow, nativeTheme, shell, Menu, app, screen } = require('electron')
const path = require('node:path')

const { createTransportIcon, WHITE } = require('./util/raster')
const { appIdFor } = require('./profile')

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
function createMainWindow (ctx, profile, product) {
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
    /*
     * 无边框窗口也必须能缩放、能移动。
     * thickFrame 是 Windows 上的"厚边框"开关（默认 true）：关掉就彻底没有系统缩放边框了 ——
     * 用户反馈"拖不动窗口边缘"，所以这里显式打开它，同时渲染层还画了自绘把手
     * （resize-handles.js）：系统边框 + 自绘把手两条路都留着，哪条能走通都行。
     */
    resizable: true,
    movable: true,
    ...(IS_MAC ? {} : { thickFrame: true }),
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
    /* 恢复时也夹一次：老旧档案里可能存着超出工作区的尺寸（实测 player 存过 1298x871 / 工作区高 866） */
    const clamped = clampToWorkArea({
      x: saved.x,
      y: saved.y,
      width: options.width,
      height: options.height
    })
    options.x = clamped.x
    options.y = clamped.y
    options.width = clamped.width
    options.height = clamped.height
  } else if (profile && profile.id === 'player') {
    /*
     * player 的**首次**出现要与完整版错开。
     *
     * 两种模式各有自己的 userData（各自记住窗口位置），所以第二次以后就不会重叠；
     * 但第一次两边都用"居中"的默认值 —— 实测两边都落在 141,43，尺寸也接近，
     * 于是"完整版开着、又起了 player"在屏幕上看起来只有一个窗口。
     * 这里只给首次加一点偏移；用户挪过之后各自记住自己的位置。
     */
    const { workAreaSize } = screen.getPrimaryDisplay()
    const offset = 56
    if (Number.isFinite(workAreaSize.width) && Number.isFinite(workAreaSize.height)) {
      options.x = Math.max(0, Math.round((workAreaSize.width - options.width) / 2) + offset)
      options.y = Math.max(0, Math.round((workAreaSize.height - options.height) / 2) + offset)
    }
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

  /*
   * 任务栏身份按**产品 × 档位**给。
   *
   * app.setAppUserModelId 只影响进程默认值；窗口级的 setAppDetails 才是让同一个 exe 的
   * 两个模式在任务栏上分开的关键（否则 Windows 按 exe 路径合并成一个按钮，
   * 用户点任务栏只会看到完整版）。
   */
  if (IS_WINDOWS) {
    try {
      win.setAppDetails({ appId: appIdFor(product, profile.id) })
    } catch (err) {
      // 旧系统上 setAppDetails 可能不可用；失败只影响任务栏分组，不该挡住开窗
      console.warn('[window] setAppDetails 失败：', err && err.message)
    }
  }

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
  /*
   * 保存前**按工作区夹紧**。
   *
   * 为什么不夹会出问题：窗口被拖到屏幕外、或者显示器换了/任务栏变了，
   * 记下来的 bounds 可能比工作区还大（实测 player 存成 1298x871，而工作区只有 866 高），
   * 下次启动就会开出一个超出屏幕的窗口，底部（播放条）永远够不到。
   * 多显示器用 getDisplayMatching：按窗口所在那块屏的工作区算，而不是主屏。
   */
  const persistGeometry = () => {
    if (automated) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (win.isDestroyed()) return
      const maximized = win.isMaximized()
      const raw = win.getNormalBounds ? win.getNormalBounds() : win.getBounds()
      const bounds = clampToWorkArea(raw)
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

/**
 * 恢复/保存窗口大小时按**工作区**夹紧。
 *
 * 多显示器用 getDisplayMatching：按窗口所在那块屏的工作区算，而不是主屏。
 * 以前不夹的后果：player 存成 1298x871，而工作区只有 866 高 —— 下次启动窗口超出屏幕，
 * 底部播放条永远够不到。
 */
function clampToWorkArea (bounds) {
  const display = screen.getDisplayMatching({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height))
  })
  const area = display && display.workArea ? display.workArea : null
  if (!area) return bounds
  const width = Math.min(Math.round(bounds.width), area.width)
  const height = Math.min(Math.round(bounds.height), area.height)
  const x = Math.min(Math.max(Math.round(bounds.x), area.x), area.x + area.width - width)
  const y = Math.min(Math.max(Math.round(bounds.y), area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/**
 * 把窗口提到最前面，并返回"到底做了什么"（自检会读它）。
 *
 * 为什么要这么多步：Windows 不给**后台进程**前台权限。用户双击音频时，
 * 我们的进程不是前台进程，`focus()` 之后窗口仍可能压在别的窗口下面 ——
 * 现象就是"player 已经在播了、标题也换了，但看到的是完整版的界面"。
 *
 * 顺序：show（可能刚从隐藏状态回来）→ moveTop（把窗口移到 z 序顶部）
 * → focus → **仍然没拿到焦点**时短暂置顶 800ms 再撤掉。
 * 刻意不长期置顶：那会让它永远压在别人上面，是个更糟的体验。
 */
function raiseWindow (win) {
  const result = { at: Date.now(), show: false, moveTop: false, focus: false, focused: false, burst: false }
  if (!win || win.isDestroyed()) return result
  if (win.isMinimized()) win.restore()
  win.show()
  result.show = true
  win.moveTop()
  result.moveTop = true
  win.focus()
  result.focus = true
  result.focused = win.isFocused()
  if (!result.focused) {
    win.setAlwaysOnTop(true)
    result.burst = true
    setTimeout(() => {
      if (!win.isDestroyed()) win.setAlwaysOnTop(false)
    }, 800)
  }
  return result
}

/**
 * 「最大化后拖不动」的兜底：把窗口从最大化状态拖出来。
 *
 * 为什么需要它：无边框窗口最大化之后，Windows 会吃掉标题栏的拖拽区（`-webkit-app-region: drag`
 * 在最大化状态下不再触发原生拖动），于是用户按着标题栏拖没有任何反应 —— 只能双击还原或点还原按钮。
 *
 * 做法：最大化时把标题栏的拖拽区改成 no-drag（见 shell.css 的 .is-maximized），
 * 渲染层在 pointerdown 里调这里 —— 先 unmaximize，再**用光标位置**驱动 setPosition，
 * 直到渲染层说松手（pointerup）。光标位置从 screen.getCursorScreenPoint() 读，
 * 不依赖渲染层收到 mousemove（指针移出窗口后就收不到了）。
 */
let dragLoop = null
function endWindowDrag () {
  if (dragLoop && dragLoop.timer) clearInterval(dragLoop.timer)
  dragLoop = null
}

function beginWindowDrag (win, offset = {}) {
  if (!win || win.isDestroyed()) return { ok: false }
  endWindowDrag()
  const wasMaximized = win.isMaximized()
  if (wasMaximized) win.unmaximize()
  const bounds = win.getBounds()
  /*
   * 光标在窗口里的相对位置（0~1）。还原之后窗口小了一圈，
   * 用比例换算能让"光标下面那一点"继续跟着光标，手感接近原生。
   */
  const ratioX = Number.isFinite(offset.ratioX) ? Math.min(1, Math.max(0, offset.ratioX)) : 0.5
  const ratioY = Number.isFinite(offset.ratioY) ? Math.min(1, Math.max(0, offset.ratioY)) : 0.05
  const grabX = Math.round(bounds.width * ratioX)
  const grabY = Math.round(bounds.height * ratioY)
  const started = Date.now()
  const timer = setInterval(() => {
    if (!dragLoop || win.isDestroyed()) { endWindowDrag(); return }
    /* 安全阀：松手事件丢了也不能永远跟着光标跑 */
    if (Date.now() - started > 20000) { endWindowDrag(); return }
    const point = screen.getCursorScreenPoint()
    win.setPosition(Math.round(point.x - grabX), Math.round(point.y - grabY))
  }, 16)
  dragLoop = { timer, win, wasMaximized }
  return { ok: true, wasMaximized }
}


/**
 * 拖窗口边缘缩放。
 *
 * 无边框窗口在 Windows 上的"系统缩放边框"不可靠 —— 用户那边**完全拖不动边缘**。
 * 所以渲染层画了八块透明把手（resize-handles.js），按下时把"哪条边 + 光标比例"交给这里：
 * 按 screen.getCursorScreenPoint() 每 16ms 算一次新的 bounds 并 setBounds。
 *
 * 四条边分方向处理：拖左/上边时 **x/y 一起变**，拖右/下边只变宽高，角上两边都变。
 */
const MIN_SIZE = { width: 940, height: 620 }
let resizeLoop = null

function endWindowResize () {
  if (resizeLoop && resizeLoop.timer) clearInterval(resizeLoop.timer)
  resizeLoop = null
}

function beginWindowResize (win, { edge = 'se', ratioX = 1, ratioY = 1 } = {}) {
  if (!win || win.isDestroyed()) return { ok: false }
  endWindowResize()
  if (win.isMaximized()) win.unmaximize()
  const start = win.getBounds()
  const hasN = edge.includes('n')
  const hasS = edge.includes('s')
  const hasW = edge.includes('w')
  const hasE = edge.includes('e')
  const startedAt = Date.now()
  const timer = setInterval(() => {
    if (!resizeLoop || win.isDestroyed()) { endWindowResize(); return }
    if (Date.now() - startedAt > 20000) { endWindowResize(); return }
    const point = screen.getCursorScreenPoint()
    let { x, y, width, height } = start
    if (hasE) width = Math.max(MIN_SIZE.width, point.x - start.x)
    if (hasS) height = Math.max(MIN_SIZE.height, point.y - start.y)
    if (hasW) {
      const right = start.x + start.width
      x = Math.min(point.x, right - MIN_SIZE.width)
      width = right - x
    }
    if (hasN) {
      const bottom = start.y + start.height
      y = Math.min(point.y, bottom - MIN_SIZE.height)
      height = bottom - y
    }
    win.setBounds({ x, y, width, height })
  }, 16)
  resizeLoop = { timer, win, edge, ratioX, ratioY }
  return { ok: true, edge }
}

module.exports = {
  createMainWindow,
  applyTheme,
  applyTaskbarState,
  markQuitting,
  beginWindowResize,
  endWindowResize,
  raiseWindow,
  beginWindowDrag,
  endWindowDrag,
  clampToWorkArea,
  IS_MAC
}
