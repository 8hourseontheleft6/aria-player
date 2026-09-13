'use strict'

/**
 * 托盘服务：托盘图标、菜单、提示，并随播放状态更新。
 *
 * 播放状态由渲染层通过 IPC（player:state）上报，托盘与任务栏都订阅它，
 * 因此这里不依赖任何界面实现细节。
 */

const { Tray, Menu, nativeImage } = require('electron')

const { createNoteIcon, WHITE, BLACK } = require('../util/raster')

const IS_MAC = process.platform === 'darwin'

function createTrayService (ctx) {
  const settings = ctx.get('settings')
  let tray = null
  let lastState = {
    status: 'idle',
    title: '',
    artist: '',
    hasPrev: false,
    hasNext: false
  }

  function icon () {
    // macOS 用模板图（纯黑 + alpha，系统会自动适配深浅色菜单栏）
    return IS_MAC ? createNoteIcon(BLACK, 32, 2) : createNoteIcon(WHITE, 32, 2)
  }

  function send (command) {
    ctx.emit('player:command', command)
  }

  function buildMenu () {
    const playing = lastState.status === 'playing'
    const idle = !lastState.title
    const nowPlaying = idle
      ? '未在播放'
      : `${lastState.title}${lastState.artist ? ` — ${lastState.artist}` : ''}`
    const label = nowPlaying.length > 48 ? `${nowPlaying.slice(0, 47)}…` : nowPlaying

    return Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      {
        label: playing ? '暂停' : '播放',
        click: () => send('play-pause')
      },
      {
        label: '上一首',
        enabled: Boolean(lastState.hasPrev || lastState.title),
        click: () => send('previous')
      },
      {
        label: '下一首',
        enabled: Boolean(lastState.hasNext || lastState.title),
        click: () => send('next')
      },
      { type: 'separator' },
      {
        label: '显示主窗口',
        click: () => ctx.emit('window:show')
      },
      { type: 'separator' },
      {
        label: '退出 Aria',
        click: () => ctx.emit('app:quit')
      }
    ])
  }

  function refresh () {
    if (!tray) return
    const playing = lastState.status === 'playing'
    tray.setToolTip(lastState.title
      ? `${playing ? '正在播放' : '已暂停'}：${lastState.title}${lastState.artist ? ` — ${lastState.artist}` : ''}`
      : 'Aria')
    tray.setContextMenu(buildMenu())
    if (IS_MAC) tray.setTitle('')
  }

  function destroy () {
    if (!tray) return
    tray.destroy()
    tray = null
  }

  ctx.onCleanup(destroy)

  return {
    /** 按设置创建/销毁托盘 */
    sync () {
      const enabled = settings.get().trayEnabled !== false
      if (!enabled) {
        destroy()
        return
      }
      if (tray) return
      const image = icon()
      if (IS_MAC) image.setTemplateImage(true)
      tray = new Tray(image)
      tray.setToolTip('Aria')
      refresh()
      // Windows 左键单击直接唤起主窗口；macOS 交给系统菜单
      if (!IS_MAC) {
        tray.on('click', () => ctx.emit('window:toggle'))
        tray.on('double-click', () => ctx.emit('window:show'))
      }
    },

    /** 渲染层上报的播放状态 */
    update (state) {
      lastState = { ...lastState, ...state }
      refresh()
    },

    get exists () {
      return Boolean(tray)
    },

    /** 供自检与调试读取当前状态 */
    getState: () => ({ ...lastState }),

    destroy
  }
}

module.exports = { createTrayService, createNoteIcon, nativeImage }
