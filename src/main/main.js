'use strict'

const { app, BrowserWindow } = require('electron')

const { createContext } = require('./registry')
const { registerSchemes, registerProtocols } = require('./protocols')
const { createSettingsService } = require('./services/settings')
const { createLibraryService } = require('./services/library')
const { createLyricsService } = require('./services/lyrics')
const { createTrayService } = require('./services/tray')
const { createWatcherService } = require('./services/watcher')
const { registerIpc } = require('./ipc')
const { createMainWindow, applyTheme, applyTaskbarState, markQuitting } = require('./window')

// 播放器需要程序化播放（自动下一曲），不要求用户手势
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

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
  ctx.define('tray', createTrayService)
  ctx.define('watcher', createWatcherService)

  const settings = ctx.get('settings')
  await settings.init()
  applyTheme(ctx, settings.get().theme)

  registerProtocols(ctx)
  registerIpc(ctx)

  const win = createMainWindow(ctx)
  const tray = ctx.get('tray')
  tray.sync()

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
