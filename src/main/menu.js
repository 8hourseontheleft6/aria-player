'use strict'

/**
 * macOS 的应用菜单栏。
 *
 * 为什么需要：不在 mac 上设菜单时，Electron 会挂一份**默认的英文菜单**
 * （Electron / Edit / View / Window…）—— 对一个中文应用来说既难看又少东西：
 * 没有播放控制，也没有「关于」。
 *
 * 两条硬约束（都是「没有 Mac 也能保证不出事」的做法）：
 *  1. **角色名必须是 Electron 认识的**。role 写错会在建菜单时抛错，而这段代码跑在启动路径上 ——
 *     真的写错就是「朋友一打开就崩」。所以角色白名单由 scripts/checks/check-menu-roles.js
 *     从本机 node_modules/electron/electron.d.ts 里读出来逐个核对，进 `npm run check`。
 *  2. 设菜单整段包在 try/catch 里：万一还有没料到的差异，最坏情况是退回默认菜单，**不影响启动**。
 *
 * 另外两个刻意的选择：
 *  · 「播放 / 暂停」**不给快捷键** —— 空格在 mac 上首先得能在搜索框里打出来；
 *    应用内的空格由渲染层的键盘处理，菜单项点一下就够用。
 *  · 「队列 / 静音」用 ⌥⌘Q / ⌥⌘M，与渲染层保持一致（⌘Q 是退出、⌘M 是最小化，属于系统）。
 *    check-menu-roles.js 会把这一条也一起核对。
 */

const { isMac } = require('./window')

/** 菜单里用到的播放指令，走的是与托盘 / 媒体键完全相同的那条链路 */
const PLAY_COMMANDS = ['play-pause', 'previous', 'next', 'volume-up', 'volume-down', 'mute', 'queue', 'now-playing']

/**
 * 纯数据：macOS 的菜单模板。
 *
 * 故意不 require('electron')：这样普通 Node 也能 require 它做校验（见 check-menu-roles.js）。
 * @param {{ appName?: string, send?: (command: string) => void }} options
 */
function buildMacMenuTemplate ({ appName = 'Aria', send = () => {} } = {}) {
  const command = (name) => () => send(name)
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `关于 ${appName}` },
        { type: 'separator' },
        { role: 'services', label: '服务', submenu: [] },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${appName}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${appName}` }
      ]
    },
    {
      label: '播放',
      submenu: [
        { label: '播放 / 暂停', click: command('play-pause') },
        { label: '上一首', accelerator: 'Cmd+Left', click: command('previous') },
        { label: '下一首', accelerator: 'Cmd+Right', click: command('next') },
        { type: 'separator' },
        { label: '音量增大', accelerator: 'Cmd+Up', click: command('volume-up') },
        { label: '音量减小', accelerator: 'Cmd+Down', click: command('volume-down') },
        { label: '静音', accelerator: 'Alt+Cmd+M', click: command('mute') },
        { type: 'separator' },
        { label: '播放队列', accelerator: 'Alt+Cmd+Q', click: command('queue') },
        { label: '打开正在播放与歌词', accelerator: 'Cmd+L', click: command('now-playing') }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'togglefullscreen', label: '进入 / 退出全屏' },
        { type: 'separator' },
        // 留一个开发者工具入口：朋友那边遇到问题，让他打开控制台截图，比让他跑命令行容易
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' }
      ]
    }
  ]
}

/**
 * 在 macOS 上装上菜单。非 mac 什么都不做（Windows / Linux 走 Menu.setApplicationMenu(null)）。
 * @param {{ emit: (event: string, payload?: any) => void }} ctx
 */
function applyMacMenu (ctx) {
  if (!isMac) return false
  try {
    const { Menu, app } = require('electron')
    const template = buildMacMenuTemplate({
      appName: app.name || 'Aria',
      send: (name) => ctx.emit('player:command', name)
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    return true
  } catch (err) {
    /*
     * 设菜单失败不能影响应用启动：退回 Electron 的默认菜单即可（英文，但能用）。
     * 真出问题会在启动日志里看到这一行。
     */
    console.warn('[menu] 安装 macOS 菜单失败，退回默认菜单：', err.message)
    return false
  }
}

module.exports = { buildMacMenuTemplate, applyMacMenu, PLAY_COMMANDS }
