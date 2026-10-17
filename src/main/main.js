'use strict'

const path = require('node:path')
const { app, BrowserWindow, session } = require('electron')

const { createContext } = require('./registry')
const { registerSchemes, registerProtocols } = require('./protocols')
const { PROFILES, resolveProfile, profileUserDataDir } = require('./profile')
const { createSettingsService } = require('./services/settings')
const { createLibraryService } = require('./services/library')
const { createLyricsService } = require('./services/lyrics')
const { createOnlineService } = require('./services/online')
const { createAiService } = require('./services/ai')
const { createMusicSourcesService } = require('./services/music-sources')
const { createTrayService } = require('./services/tray')
const { createWatcherService } = require('./services/watcher')
const { createBackgroundService } = require('./services/background')
const { createOpenedFilesService } = require('./services/opened-files')
const { registerIpc } = require('./ipc')
const { createMainWindow, applyTheme, applyTaskbarState, markQuitting } = require('./window')
const { createOpenFilesBridge } = require('./open-files')

/*
 * 产品档位（--profile=player，默认 full）。
 *
 * 这一行必须在最前面：它决定挂哪些服务、窗口给渲染层的档位，第 2 步起还决定 userData 目录。
 * 解析失败（认不出的档位名）不静默退回 —— 那会打出一个"名字叫 Player、其实是完整版"的包，
 * 而且永远没人发现。这里直接报错退出，让打包的人当场看见。
 */
const profileResult = resolveProfile(process.argv)
if (profileResult.error) {
  console.error(`[main] ${profileResult.error}\n       用法：--profile=full 或 --profile=player`)
  app.exit(2)
}
const profile = profileResult.profile
console.log(`[main] 产品档位：${profile.id}（${profile.productName}），服务 ${profile.services.join(' / ')}，插件 ${profile.plugins.join(' / ') || '（无）'}`)

/**
 * 服务名 → 工厂。表在 profile.js，工厂在这里 —— 分开是因为 profile.js 要能被
 * 静态检查（scripts/checks/check-profiles.js）直接 require，不能牵扯 Electron。
 */
const SERVICE_FACTORIES = {
  settings: createSettingsService,
  library: createLibraryService,
  lyrics: createLyricsService,
  online: createOnlineService,
  ai: createAiService,
  musicSources: createMusicSourcesService,
  tray: createTrayService,
  watcher: createWatcherService,
  background: createBackgroundService,
  openedFiles: createOpenedFilesService
}


/*
 * macOS：把文件拖到 Dock 图标 / 在 Finder 里双击音频 → 走「拖进窗口」那条完全相同的导入链路。
 * 监听必须**尽早**注册（双击文件冷启动时事件在 ready 之前就到达），所以放在文件顶部；
 * 只在 darwin 上挂 —— Windows / Linux 没有这个事件，行为一个字都不变。
 * 冷启动期间到达的路径由桥先攒着（见 open-files.js），等 bootstrap 里交出处理函数后再一次送进来。
 */
let deliverOpenedPaths = null
const openFiles = createOpenFilesBridge({
  onPaths: (paths) => {
    if (!deliverOpenedPaths) {
      // 理论上到不了这里（bootstrap 里是「先设处理函数、再 ready」），留个日志以防万一
      console.warn('[open-file] 还没有接收方，忽略', paths)
      return
    }
    deliverOpenedPaths(paths)
  }
})
if (process.platform === 'darwin') openFiles.attach(app)

// 播放器需要程序化播放（自动下一曲），不要求用户手势
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/*
 * 暴露 V8 的 gc()，给「最小化后释放后台占用」用。
 *
 * 释放掉媒体墙 DOM、封面 blob 缓存之后，内存并不会立刻还回去 —— 得让 V8
 * 真的回收一轮。没有这个开关时 global.gc / window.gc 都是 undefined，代码里
 * 做了存在性判断，所以去掉这一行不会报错，只是显存回收变被动。
 */
app.commandLine.appendSwitch('js-flags', '--expose-gc')

/*
 * 硬件加速降级开关：ARIA_DISABLE_GPU=1（等价于命令行 --disable-gpu）。
 *
 * 为什么要有它：GPU 进程启动失败时（实测 error_code=18 →
 * "FATAL: GPU process isn't usable. Goodbye."）Electron 会**直接退出** ——
 * 没有窗口、控制台零输出、所有版本表现一致，用户完全无从下手（这次排查花了几小时）。
 * 有显卡驱动问题 / 远程桌面 / 虚拟化环境时，带上这个开关即可正常使用。
 * 必须在 app ready 之前调用，所以才放在文件顶部这一带。
 */
/*
 * 兼容模式：ARIA_SAFE_MODE=1
 *
 * 适用场景（实测）：Chromium 的沙箱子进程与 GPU 进程都起不来时，Electron 会直接退出，
 * 表现为「双击没反应、控制台零输出、所有版本一致」，用户完全无从下手。
 * 打开后等价于：--no-sandbox --disable-gpu --disable-software-rasterizer。
 * 代价：渲染走软件实现（会卡），且关闭了 Chromium 沙箱（安全性降低）——
 * 仅作为用户机器异常时的兜底，修好显卡驱动/内存完整性后建议关掉。
 */
if (process.env.ARIA_SAFE_MODE === '1') {
  app.commandLine.appendSwitch('no-sandbox')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.disableHardwareAcceleration()
  console.log('[main] 兼容模式：已禁用沙箱与硬件加速（软件渲染）')
}

if (process.env.ARIA_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration()
  console.log('[main] 已按 ARIA_DISABLE_GPU=1 禁用硬件加速（软件渲染）')
}

/*
 * 自动化模式（自检 / 截图 / 帧率诊断 / 视觉审计）使用独立的用户数据目录。
 *
 * 两个原因，都是踩过的坑：
 *  1) 单实例锁是按 userData 目录算的 —— 用户正开着播放器时，
 *     `npm run smoke` 会因为拿不到锁直接退出，一行输出都没有（看起来像「脚本坏了」）；
 *  2) 这些模式会读写真设置、灌封面缓存、退出时保存窗口尺寸 ——
 *     隔离之后它们再也动不到用户自己那份。
 * 顺带还有一个好处：每次都是全新的设置，测试结果更可复现。
 */
const AUTOMATION_FLAGS = ['--smoke', '--shots', '--perf', '--audit']
const automationFlag = AUTOMATION_FLAGS.find((flag) => process.argv.includes(flag))
if (automationFlag) {
  // 四个模式共用同一份自动化目录：第一次跑要做一次全量扫描，
  // 之后（含换了模式）都能直接复用扫描结果与封面缓存，跑起来快得多
  /*
   * 想换一份干净的档案时，不必去删系统的临时目录 —— 设 ARIA_USER_DATA 指到别处即可：
   *   ARIA_USER_DATA=<某个目录> npm run smoke
   * 两个用处：① 档案被写坏（自检中途被杀）时换一个，而不是删除目录外的东西；
   *          ② 需要并行/隔离跑两轮时互不干扰。
   */
  const automationProfile = process.env.ARIA_USER_DATA || path.join(app.getPath('temp'), 'aria-dev-profile')
  app.setPath('userData', automationProfile)
  console.log(`[main] 自动化模式 ${automationFlag}：使用独立用户数据目录 ${automationProfile}，不影响你自己的设置与缓存`)
}

/*
 * ARIA_USER_DATA 覆盖：**任何模式**都生效（原来只在自动化模式里读）。
 *
 * 用途是调试与测试：想在隔离档案里启动一次（例如同时开两个产品验证互不干扰），
 * 又不想让它们跑到 %APPDATA% 里建目录。设了它就以它为准，两个档位都用这一份。
 */
if (process.env.ARIA_USER_DATA && !automationFlag) {
  app.setPath('userData', process.env.ARIA_USER_DATA)
  console.log(`[main] 按 ARIA_USER_DATA 使用指定用户数据目录 ${process.env.ARIA_USER_DATA}`)
}

/*
 * 两个产品各自的 userData（设置与缓存不共享）。
 *
 * **必须在 requestSingleInstanceLock() 之前**：Electron 的单实例锁是按 userData 目录算的，
 * 放在后面就会出现"本体开着时 Player 起不来"（或反过来）—— 而需求恰恰是两者能同时开着。
 *
 * 两个刻意的设计：
 *   · full 档位**一个字都不改**（继续用 Electron 的默认目录）：现有用户的设置、播放列表、
 *     封面缓存全在原处，升级后不会有"我的资料库不见了"这种惊吓；
 *   · 自动化模式（上面那段）设过的路径优先 —— 自检/截图要能指定自己的档案目录，
 *     不能因为档位而跑到用户真实的目录里去。
 */
if (!automationFlag && !process.env.ARIA_USER_DATA && profile.id !== 'full') {
  const profileData = profileUserDataDir(app.getPath('appData'), profile)
  app.setPath('userData', profileData)
  console.log(`[main] ${profile.productName} 档位：独立用户数据目录 ${profileData}`)
}

// 自定义协议必须在 app ready 之前声明
registerSchemes()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  bootstrap()
}

/**
 * 组装应用：注册服务 -> 注册协议 -> 注册 IPC -> 开窗 -> 增量扫描。
 * 想扩展主进程能力，就在下面 ctx.define(...) 加一行，然后在 ipc 里暴露。
 */
async function bootstrap () {
  await app.whenReady()

  /*
   * 只在 Windows 上调：`app.setAppUserModelId` 是 Windows 专属 API
   * （Electron 的类型定义里标着 @platform win32），用来让任务栏/通知认得这个应用。
   * 之前是不加判断直接调的 —— 在 macOS 上这是「未实现的方法」，轻则抛错、重则应用起不来，
   * 而我们正要把它搬到别人的 Mac 上测，所以这里明确收进平台判断里。
   */
  if (process.platform === 'win32') app.setAppUserModelId('com.aria.player')

  const ctx = createContext()
  /*
   * 按档位挂载：表里没有的服务这里根本不会 define，于是 `ctx.get('library')`
   * 在 player 里会直接抛「服务未注册」—— 想要的能力不存在，而不是存在但关着。
   */
  for (const name of profile.services) {
    const factory = SERVICE_FACTORIES[name]
    if (!factory) throw new Error(`档位 ${profile.id} 要求挂载未知服务：${name}`)
    ctx.define(name, factory)
  }
  /** 取一个"这个档位可能有、也可能没有"的服务（问能力，不问档位） */
  const optional = (name) => (ctx.has(name) ? ctx.get(name) : null)

  const settings = ctx.get('settings')
  await settings.init()
  applyTheme(ctx, settings.get().theme)

  // 音源脚本在启动时装一次（目录不存在就建好，方便用户直接往里丢脚本）
  const musicSources = optional('musicSources')
  if (musicSources) {
    try {
      await musicSources.init()
    } catch (err) {
      console.warn('[sources] 初始化失败', err)
    }
  }

  const openedFiles = optional('openedFiles')
  if (openedFiles) await openedFiles.init()


  registerProtocols(ctx)
  registerIpc(ctx)

  const win = createMainWindow(ctx, profile)
  const tray = optional('tray')
  if (tray) tray.sync()

  // 最小化 / 收进托盘后释放后台占用，回来时恢复（媒体墙、封面缓存、目录监听）
  const background = optional('background')
  if (background) background.attach(win)

  /* ---------------- 系统集成：托盘 / 任务栏 / 主进程指令 ---------------- */

  const showWindow = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  ctx.on('window:show', showWindow)
  ctx.on('window:toggle', () => {
    if (win.isDestroyed()) return
    if (win.isVisible() && !win.isMinimized()) win.hide()
    else showWindow()
  })
  ctx.on('app:quit', () => {
    markQuitting()
    app.quit()
  })

  // 渲染层上报的播放状态 -> 托盘提示/菜单 + 任务栏进度与缩略图按钮
  ctx.on('player:state', (state) => {
    if (tray) tray.update(state)
    applyTaskbarState(win, state, { progressEnabled: settings.get().taskbarProgress !== false })
  })

  // 托盘菜单、系统媒体键、任务栏缩略图按钮发出的播放指令，统一转给渲染层
  ctx.on('player:command', (command) => {
    if (!win.isDestroyed()) win.webContents.send('media:command', command)
  })

  /*
   * macOS 的菜单栏：不装的话 Electron 会挂一份默认英文菜单（Electron / Edit / View…），
   * 既没有中文也没有播放控制。非 mac 什么都不做 —— Windows / Linux 走
   * Menu.setApplicationMenu(null)（见 window.js），自绘标题栏才是它们的菜单。
   * menu.js 内部整段 try/catch：装菜单失败只退默认菜单，绝不挡启动。
   */
  require('./menu').applyMacMenu(ctx)

  const library = optional('library')
  const watcher = optional('watcher')
  if (library) await library.init()

  /*
   * macOS 的 open-file：双击 / 拖到 Dock 的路径交给**本档位的"打开文件"链路**。
   *   · full：library.resolveDrop（与「拖进窗口」完全同一条链路 —— 文件夹会弹确认、
   *           库内的歌直接播、库外的问要不要把所在文件夹加进来）
   *   · player：openedFiles.add（只记进"最近打开"，不建索引、不扫目录、不查在线）
   * 先设处理函数再 ready()，冷启动攒下的路径会在 ready() 那一刻一次性送进来。
   */
  if (process.platform === 'darwin') {
    deliverOpenedPaths = (paths) => {
      const handled = library
        ? library.resolveDrop(paths)
        : openedFiles.add(paths)
      Promise.resolve(handled).catch((err) => console.warn('[open-file] 导入失败:', err && err.message))
    }
    openFiles.ready()
  }

  /** 监听目录 / 开关的指纹，只有它变了才需要重建 watcher（player 档位没有 watcher） */
  const watchSignatureOf = () =>
    `${settings.get().watchFolders !== false}|${library ? library.getFolders().join('\u0000') : ''}`
  let watchSignature = watchSignatureOf()
  const watchResult = watcher ? watcher.start() : { folders: 0, skipped: true }

  ctx.on('settings:changed', () => {
    if (tray) tray.sync()
    if (watcher) {
      const signature = watchSignatureOf()
      if (signature !== watchSignature) {
        watchSignature = signature
        watcher.start()
      }
    }
    void applyProxySettings()
  })

  /*
   * 网络代理。
   *
   * 在线歌词 / 封面 / 艺人头像都是主进程用 net.fetch 发出的，走的是**默认会话** ——
   * 所以 setProxy 一次，它们全都跟着走（渲染层本来就不能联网，不需要额外处理）。
   * 起因：用户反馈「开了加速器还是取不到封面/头像」，而不少加速器并不设置系统代理，
   * 这时「跟随系统」就等于没有代理。默认值 'system' 与改动前行为一致，不影响任何人。
   */
  let appliedProxySignature = ''
  async function applyProxySettings () {
    const { proxyMode, proxyUrl } = settings.get()
    const mode = proxyMode || 'system'
    const url = String(proxyUrl || '').trim()
    const signature = `${mode}|${url}`
    // settings:changed 会为任何设置触发，只有代理这一项真的变了才重新应用
    if (signature === appliedProxySignature) return
    appliedProxySignature = signature
    const config = mode === 'manual' && url
      ? { proxyRules: url, proxyBypassRules: '<local>' }
      : { mode: mode === 'direct' ? 'direct' : 'system' }
    try {
      await session.defaultSession.setProxy(config)
      console.log(`[main] 网络代理：${config.proxyRules || config.mode}`)
    } catch (err) {
      // 填错地址不该让应用起不来，也不该静默：日志里留一行
      console.warn('[main] 设置网络代理失败：', err && err.message)
      appliedProxySignature = ''
    }
  }
  await applyProxySettings()

  win.webContents.once('did-finish-load', () => {
    // 启动后台增量刷新：文件没变的话只做 stat，很快（player 档位没有资料库，整段跳过）
    if (!library) return
    const stats = library.getStats()
    if (stats.folders > 0) {
      library.scan({ reason: stats.count ? 'startup-refresh' : 'startup' }).catch((err) => {
        console.error('[main] 启动扫描失败:', err)
      })
    }
  })

  // 自检模式：跑完完整链路后自动退出（npm run smoke）
  if (process.argv.includes('--smoke')) {
    const { runSmoke } = require('./smoke')
    win.webContents.once('did-finish-load', () => {
      runSmoke({ win, ctx, profile })
        .then((ok) => app.exit(ok ? 0 : 1))
        .catch((err) => {
          console.error('[smoke] 执行异常:', err)
          app.exit(1)
        })
    })
  }

  // 截图模式：输出各界面 PNG（npm run shots）
  if (process.argv.includes('--shots')) {
    const { runScreenshots } = require('./screenshot')
    win.webContents.once('did-finish-load', () => {
      runScreenshots({ win, ctx })
        .then(() => app.exit(0))
        .catch((err) => {
          console.error('[shots] 执行异常:', err)
          app.exit(1)
        })
    })
  }

  // 帧率诊断模式：分档测量 rAF 间隔（npm run perf）
  if (process.argv.includes('--perf')) {
    const { runPerf } = require('./perf')
    win.webContents.once('did-finish-load', () => {
      runPerf({ win, ctx })
        .then(() => app.exit(0))
        .catch((err) => {
          console.error('[perf] 执行异常:', err)
          app.exit(1)
        })
    })
  }

  // 视觉审计模式：计算样式 + 几何 + 位图统计（npm run audit）
  if (process.argv.includes('--audit')) {
    const { runVisualAudit } = require('./visual-audit')
    win.webContents.once('did-finish-load', () => {
      runVisualAudit({ win, ctx })
        .then(() => app.exit(0))
        .catch((err) => {
          console.error('[audit] 执行异常:', err)
          app.exit(1)
        })
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(ctx)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  /*
   * 退出前必须**等**设置落盘。
   *
   * 踩过的坑（用户在别人电脑上测试时反馈「关掉程序后曲库文件夹又要重新指定、
   * 数据像被清空了」）：`app.on('before-quit', async () => { await flush() })`
   * 这种写法 Electron 是**不等**的 —— 它不会等一个 async 监听器返回的 Promise，
   * 于是 `flush()` 里的 fsp.writeFile 还没写完，进程就已经退出了。
   *
   * 正确做法：拦一次退出（preventDefault），flush 完成后再真正退出；
   * `quitting` 标志保证第二次 before-quit 直接放行，不会自己拦自己成死循环。
   */
  let quitting = false
  app.on('before-quit', (event) => {
    markQuitting()
    if (quitting) return
    quitting = true
    event.preventDefault()
    Promise.resolve(settings.flush())
      .catch((error) => console.error('[main] 退出前保存设置失败：', error))
      .finally(() => app.quit())
  })

  app.on('will-quit', async () => {
    await ctx.disposeAll()
  })

  console.log(`[main] ${profile.productName} 已启动 (Electron ${process.versions.electron}, 档位: ${profile.id}, 用户数据目录: ${app.getPath('userData')})`)
  if (watchResult.watching) {
    console.log(`[main] 目录监听已开启（${watchResult.watching} 个根目录）`)
  }
}
