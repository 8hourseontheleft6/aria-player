'use strict'

const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const { createContext } = require('./registry')
const { registerSchemes, registerProtocols } = require('./protocols')
const { createSettingsService } = require('./services/settings')
const { createLibraryService } = require('./services/library')
const { createLyricsService } = require('./services/lyrics')
const { createOnlineService } = require('./services/online')
const { createMusicSourcesService } = require('./services/music-sources')
const { createTrayService } = require('./services/tray')
const { createWatcherService } = require('./services/watcher')
const { createBackgroundService } = require('./services/background')
const { registerIpc } = require('./ipc')
const { createMainWindow, applyTheme, applyTaskbarState, markQuitting } = require('./window')

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
  app.setPath('userData', path.join(app.getPath('temp'), 'aria-dev-profile'))
  console.log(`[main] 自动化模式 ${automationFlag}：使用独立用户数据目录，不影响你自己的设置与缓存`)
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

  app.setAppUserModelId('com.aria.player')

  const ctx = createContext()
  ctx.define('settings', createSettingsService)
  ctx.define('library', createLibraryService)
  ctx.define('lyrics', createLyricsService)
  ctx.define('online', createOnlineService)
  ctx.define('musicSources', createMusicSourcesService)
  ctx.define('tray', createTrayService)
  ctx.define('watcher', createWatcherService)
  ctx.define('background', createBackgroundService)

  const settings = ctx.get('settings')
  await settings.init()
  applyTheme(ctx, settings.get().theme)

  // 音源脚本在启动时装一次（目录不存在就建好，方便用户直接往里丢脚本）
  try {
    await ctx.get('musicSources').init()
  } catch (err) {
    console.warn('[sources] 初始化失败', err)
  }


  registerProtocols(ctx)
  registerIpc(ctx)

  const win = createMainWindow(ctx)
  const tray = ctx.get('tray')
  tray.sync()

  // 最小化 / 收进托盘后释放后台占用，回来时恢复（媒体墙、封面缓存、目录监听）
  ctx.get('background').attach(win)

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
    tray.update(state)
    applyTaskbarState(win, state, { progressEnabled: settings.get().taskbarProgress !== false })
  })

  // 托盘菜单、系统媒体键、任务栏缩略图按钮发出的播放指令，统一转给渲染层
  ctx.on('player:command', (command) => {
    if (!win.isDestroyed()) win.webContents.send('media:command', command)
  })

  const library = ctx.get('library')
  const watcher = ctx.get('watcher')
  await library.init()

  /** 监听目录 / 开关的指纹，只有它变了才需要重建 watcher */
  let watchSignature = `${settings.get().watchFolders !== false}|${library.getFolders().join('\u0000')}`
  const watchResult = watcher.start()

  ctx.on('settings:changed', () => {
    tray.sync()
    const signature = `${settings.get().watchFolders !== false}|${library.getFolders().join('\u0000')}`
    if (signature !== watchSignature) {
      watchSignature = signature
      watcher.start()
    }
  })

  win.webContents.once('did-finish-load', () => {
    // 启动后台增量刷新：文件没变的话只做 stat，很快
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
      runSmoke({ win, ctx })
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

  app.on('before-quit', async () => {
    markQuitting()
    await settings.flush()
  })

  app.on('will-quit', async () => {
    await ctx.disposeAll()
  })

  console.log(`[main] Aria 已启动 (Electron ${process.versions.electron}, 用户数据目录: ${app.getPath('userData')})`)
  if (watchResult.watching) {
    console.log(`[main] 目录监听已开启（${watchResult.watching} 个根目录）`)
  }
}
