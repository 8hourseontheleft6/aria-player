'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { app, BrowserWindow, session } = require('electron')

const log = require('./util/log')
const { createContext } = require('./registry')
const { registerSchemes, registerProtocols } = require('./protocols')
const {
  PROFILES, PRODUCTS, resolveProduct, resolveProfile, appIdFor,
  audioPathsFrom: audioPathsFromProfile, userDataDirFor
} = require('./profile')
const { createSettingsService } = require('./services/settings')
const { createAiSubtitlesService } = require('./services/ai-subtitles')
const { createLibraryService } = require('./services/library')
const { createLyricsService } = require('./services/lyrics')
const { createOnlineService } = require('./services/online')
const { createAiService } = require('./services/ai')
const { createMusicSourcesService } = require('./services/music-sources')
const { createTrayService } = require('./services/tray')
const { createDiagnosticsService } = require('./services/diagnostics')
const { createUpdaterService } = require('./services/updater')
const { createResumeService } = require('./services/resume')
const { createWatcherService } = require('./services/watcher')
const { createBackgroundService } = require('./services/background')
const { createOpenedFilesService } = require('./services/opened-files')
const { registerIpc } = require('./ipc')
const { createMainWindow, applyTheme, applyTaskbarState, markQuitting, raiseWindow } = require('./window')
const { createOpenFilesBridge } = require('./open-files')

/*
 * 产品 × 档位（两层身份，见 src/main/profile.js）。
 *
 * 产品由入口文件声明（ARIA_PRODUCT）：aria / player / unified。
 * 档位由启动方式决定：
 *   · Aria Player 固定 player
 *   · Aria Unified —— **带音频文件启动 = player，否则 full**（"一个安装包两种模式"）
 *   · 显式 `--profile=…` 覆盖上面两条（调试用）
 *
 * 这两行必须在最前面：它们决定挂哪些服务、窗口给渲染层的档位、以及 userData 目录
 * （Unified 的两种模式必须各有目录，否则"完整模式开着时双击音频"会撞单实例锁）。
 * 解析失败（认不出的产品/档位名）不静默退回 —— 那会打出一个名不副实的包，而且永远没人发现。
 */
const productResult = resolveProduct(process.env)
if (productResult.error) {
  console.error(`[main] ${productResult.error}\n       可选：ARIA_PRODUCT=${Object.keys(PRODUCTS).join(' / ')}`)
  app.exit(2)
}
const product = productResult.product
const profileResult = resolveProfile(process.argv, product)
if (profileResult.error) {
  console.error(`[main] ${profileResult.error}\n       用法：--profile=full 或 --profile=player`)
  app.exit(2)
}
const profile = profileResult.profile
console.log(`[main] 产品 ${product.id}（${product.productName}）× 档位 ${profile.id}（判定依据 ${profileResult.reason}），` +
  `服务 ${profile.services.join(' / ')}，插件 ${profile.plugins.join(' / ') || '（无）'}`)

/**
 * 服务名 → 工厂。表在 profile.js，工厂在这里 —— 分开是因为 profile.js 要能被
 * 静态检查（scripts/checks/check-profiles.js）直接 require，不能牵扯 Electron。
 */
const SERVICE_FACTORIES = {
  settings: createSettingsService,
  aiSubtitles: createAiSubtitlesService,
  library: createLibraryService,
  lyrics: createLyricsService,
  online: createOnlineService,
  ai: createAiService,
  musicSources: createMusicSourcesService,
  tray: createTrayService,
  // 诊断包（只依赖 settings，用来出脱敏后的设置）
  diagnostics: createDiagnosticsService,
  // 自动更新（electron-updater + GitHub Releases）
  updater: createUpdaterService,
  // 每首歌的播放位置（续播）
  resume: createResumeService,
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
/*
 * player 档位的「打开文件」投递器：把路径解析成曲目后交给渲染层去播放。
 * bootstrap 里赋值（那时窗口与 openedFiles 服务都就绪了）；在此之前到达的路径
 * 由 openFiles 桥攒着，或在 bootstrap 里从 process.argv 里补取一次。
 */
let deliverPlayerPaths = null
/*
 * second-instance 要用它判断该走哪条链路。不能看"deliverPlayerPaths 是不是函数" ——
 * 那个函数两个档位都会被赋值；full 档位走进去会碰到 openedFiles 为 null。
 */
let hasOpenedFiles = false
/*
 * 最近一次"把窗口提到前面"做了什么（show / moveTop / focus / 是否用了置顶兜底）。
 * 自检读它来证明"再双击一次时窗口真的被提起来了"——z 序本身 Electron 没有 API 可读。
 */
const raiseInfo = { last: null, count: 0 }
const openFiles = createOpenFilesBridge({
  onPaths: (paths) => {
    if (deliverPlayerPaths) {
      deliverPlayerPaths(paths)
      return
    }
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
if (!automationFlag && !process.env.ARIA_USER_DATA) {
  /*
   * 目录按 **产品 × 档位** 分（userDataDirFor）：
   *   aria    → null（Electron 默认目录，行为一个字不改）
   *   player  → Aria Player (player)
   *   unified → Aria Unified (full) / Aria Unified (player)
   * 所以"完整模式开着时再双击音频"能起一个**真正的 player 进程**（不同 userData = 不同单实例锁），
   * 而不是把文件塞给完整版去导入。
   */
  const productData = userDataDirFor(app.getPath('appData'), product, profile.id)
  if (productData) {
    app.setPath('userData', productData)
    console.log(`[main] ${product.productName} × ${profile.id}：独立用户数据目录 ${productData}`)
  }
}

// 自定义协议必须在 app ready 之前声明
registerSchemes()

/*
 * 日志 + 崩溃转储。
 *
 * 必须放在 userData 定下来之后（日志落到各自目录），但在 requestSingleInstanceLock 之前 ——
 * 连"起不来"这件事也要有日志可看。crashReporter 只把 dump 写进 userData/crashes，
 * 不传任何远端（我们没有崩溃收集服务）。
 */
log.init(app.getPath("userData"))
app.setPath("crashDumps", path.join(app.getPath("userData"), "crashes"))
try {
  require("electron").crashReporter.start({
    productName: product.productName,
    companyName: "Aria",
    submitURL: "",
    uploadToServer: false,
    compress: true
  })
} catch (error) {
  log.warn("crashReporter 启动失败", { message: String(error && error.message) })
}

/* 未捕获异常 / 未处理的 Promise：写日志，不弹窗轰炸，也不让进程静默消失 */
process.on("uncaughtException", (error) => {
  log.error("未捕获异常", { message: String(error && error.message), stack: String(error && error.stack).slice(0, 4000) })
})
process.on("unhandledRejection", (reason) => {
  log.error("未处理的 Promise 拒绝", { message: String(reason && reason.message ? reason.message : reason), stack: String(reason && reason.stack).slice(0, 4000) })
})

/* 启动就落一行：日志文件不该等到第一个事件才出现 */
log.info("启动", { product: product.id, profile: profile.id, version: app.getVersion(), packaged: app.isPackaged })

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (event, argv) => {
    const [win] = BrowserWindow.getAllWindows()
    /*
     * 先把窗口提到最前面。
     *
     * 只用 focus() 不够：Windows 不给**后台进程**前台权限 —— 双击音频时我们的进程
     * 不是前台进程，focus() 之后窗口仍然可能压在完整版下面。现象就是
     * "player 已经在播、标题也换了，用户看到的却是完整版的界面和它原来的歌"。
     * raiseWindow 里是 show → moveTop → focus，仍拿不到焦点时短暂置顶 800ms 再撤掉。
     */
    const raised = raiseWindow(win)
    raiseInfo.last = raised
    raiseInfo.count += 1

    /*
     * 再处理"要不要打开这个文件"。
     *
     * 三个关键点，缺一个就是"双击没反应"：
     *   ① **先过滤 argv**：新进程的 argv 里混着 exe 路径、`--profile=…`、`--smoke` 之类，
     *      原样丢给解析器会当场抛错；
     *   ② 按**能力**分流：player 档位（挂了 openedFiles）解析后直接播；full 档位交给
     *      library 的拖放链路（与拖进窗口完全一致）；
     *   ③ 不能按"deliverPlayerPaths 是不是函数"判断 —— 它在两个档位都被赋值了，
     *      full 档位走进去会碰到 openedFiles 为 null，抛 TypeError 被 promise 吞掉，
     *      表现同样是"双击没反应"，而且日志里只剩一条没人看的 rejection。
     */
    const audio = audioPathsFrom(argv)
    if (!audio.length) return
    if (hasOpenedFiles && typeof deliverPlayerPaths === 'function') deliverPlayerPaths(audio)
    else if (typeof deliverOpenedPaths === 'function') deliverOpenedPaths(audio)
  })
  bootstrap()
}

/**
 * 从命令行里挑出音频文件路径。
 * 判据只有一份（profile.js 的 audioPathsFrom）—— 启动规则、文件关联、second-instance
 * 三处必须完全一致，各写一份迟早会有一处漏掉某种扩展名。
 */
const audioPathsFrom = audioPathsFromProfile

/**
 * 组装应用：注册服务 -> 注册协议 -> 注册 IPC -> 开窗 -> 增量扫描。
 * 想扩展主进程能力，就在下面 ctx.define(...) 加一行，然后在 ipc 里暴露。
 */
async function bootstrap () {
  globalThis.__ariaBoot = { readyAt: 0, readyToShowAt: 0 }
await app.whenReady()
globalThis.__ariaBoot.readyAt = Date.now()

  /*
   * 只在 Windows 上调：`app.setAppUserModelId` 是 Windows 专属 API
   * （Electron 的类型定义里标着 @platform win32），用来让任务栏/通知认得这个应用。
   * 之前是不加判断直接调的 —— 在 macOS 上这是「未实现的方法」，轻则抛错、重则应用起不来，
   * 而我们正要把它搬到别人的 Mac 上测，所以这里明确收进平台判断里。
   */
  /*
   * 任务栏身份按**产品**给：三个产品各有 appId，否则 Windows 会把它们并成同一个任务栏按钮
   * （同时开着时会互相覆盖图标与跳转列表）。前两个产品沿用原值，行为不变。
   */
  if (process.platform === 'win32') app.setAppUserModelId(appIdFor(product, profile.id))

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
  hasOpenedFiles = Boolean(openedFiles)
  if (openedFiles) await openedFiles.init()


  registerProtocols(ctx)
  registerIpc(ctx)

  const win = createMainWindow(ctx, profile, product)
  const tray = optional('tray')
  if (tray) tray.sync()
  /*
   * 启动后 20 秒查一次更新 —— 延迟是为了不和首屏抢 IO，且开发态/未打包时自己会跳过。
   * 失败静默（只写日志），绝不弹窗。
   */
  const updater = ctx.has('updater') ? ctx.get('updater') : null
  if (updater) {
    if (process.argv.includes('--force-update')) updater.forceForTests(true)
    updater.schedule(20000)
  }

  // 最小化 / 收进托盘后释放后台占用，回来时恢复（媒体墙、封面缓存、目录监听）
  const background = optional('background')
  if (background) background.attach(win)

  /* ---------------- 系统集成：托盘 / 任务栏 / 主进程指令 ---------------- */

  const showWindow = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    globalThis.__ariaBoot.readyToShowAt = Date.now()
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
   * 「打开文件」链路的两端：把路径解析成曲目，然后交给渲染层去播放/入列表。
   *
   *   · player：openedFiles.resolve（只解析这次打开的文件，进临时队列 ——
   *     不建索引、不扫目录、不读封面、不联网、也不弹确认框），
   *     解析结果通过 opened:incoming 推给渲染层（渲染层那边收进列表并直接播）
   *   · full：library.resolveDrop（与「拖进窗口」完全同一条链路 —— 文件夹会弹确认、
   *     库内的歌直接播、库外的问要不要把所在文件夹加进来）
   *
   * 三个入口都要能走这条链路，缺一个就是"双击没反应"：
   *   ① macOS 的 open-file（双击 / 拖到 Dock）—— 由 open-files 桥转发到 deliverOpenedPaths / deliverPlayerPaths
   *   ② Windows 的文件关联（双击 .mp3）—— 路径在 process.argv 里（冷启动）
   *   ③ 程序已经在跑时再次双击 —— 新进程被单实例锁挡掉，路径在 second-instance 的 argv 里
   */
  const sendOpened = (payload) => {
    if (!win.isDestroyed() && payload && (payload.tracks || []).length) {
      win.webContents.send('opened:incoming', payload)
    }
  }
  deliverPlayerPaths = async (paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean)
    if (!list.length) return
    /*
     * 防御：没有 openedFiles 的档位（full）走到这里说明分流写错了。
     * 早退比抛 TypeError 好 —— 那个异常会被 promise 吞掉，只剩"双击没反应"这一个现象。
     */
    if (!openedFiles) {
      console.warn('[open-file] 本档位没有 openedFiles，忽略（应当走 library 的拖放链路）')
      return
    }
    try {
      const result = await openedFiles.resolve(list)
      sendOpened(result)
    } catch (err) {
      console.warn('[open-file] 解析失败:', err && err.message)
    }
  }
  deliverOpenedPaths = (paths) => {
    if (openedFiles) {
      deliverPlayerPaths(paths)
      return
    }
    const handled = library ? library.resolveDrop(paths) : null
    Promise.resolve(handled).catch((err) => console.warn('[open-file] 导入失败:', err && err.message))
  }
  if (process.platform === 'darwin') openFiles.ready()

  /* ② Windows 文件关联：冷启动时命令行里带着要打开的文件（mac 走上面的 open-file，不重复取） */
  if (process.platform !== 'darwin') {
    const fromArgv = audioPathsFrom(process.argv)
    if (fromArgv.length) {
      /*
       * 冷启动也要**把窗口提到前面**：这个进程不是前台进程，Windows 不会因为
       * "用户双击了文件"就给它前台权限 —— 先 show→moveTop→focus（必要时短暂置顶）。
       */
      win.webContents.once('did-finish-load', () => {
        const raised = raiseWindow(win)
        raiseInfo.last = raised
        raiseInfo.count += 1
        deliverPlayerPaths(fromArgv)
      })
    }
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
      runSmoke({ win, ctx, profile, product, raiseInfo })
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
  if (process.argv.includes('--perf-baseline')) {
    const { runPerfBaseline } = require('./perf-baseline')
    runPerfBaseline({ win, ctx }).then(() => {
      console.log('\n=== 基线测量结束 ===')
      require('electron').app.exit(0)
    }).catch((error) => {
      console.error('基线测量失败：', error)
      require('electron').app.exit(1)
    })
    return
  }
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
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow(ctx, profile, product)
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
