/** 自绘标题栏：拖拽区 + 侧栏开关 + 扫描进度 + 窗口按钮 */

import { h, on } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { remote } from '../core/remote.js'
import { EVENTS } from '../core/bus.js'

export function createTitlebar ({ store, bus, actions }) {
  const sidebarToggle = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '显示/隐藏边栏 (Ctrl+B)',
    onClick: () => actions.toggleSidebar()
  }, icon('sidebar', { className: 'icon icon--stroke' }))

  const appName = h('div', { class: 'titlebar__app', text: 'Aria' })

  const scanLabel = h('span', { text: '' })
  const scanFill = h('i')
  const scanBar = h('div', { class: 'titlebar__scan-bar' }, scanFill)
  const scanStatus = h('div', { class: 'titlebar__scan hidden' }, scanBar, scanLabel)

  const right = h('div', { class: 'titlebar__right' }, scanStatus)

  // Windows / Linux 自绘窗口按钮；macOS 用系统红绿灯
  if (!store.get().app.isMac) {
    right.appendChild(h('div', { class: 'win-controls' },
      h('button', {
        class: 'win-controls__btn',
        type: 'button',
        title: '最小化',
        onClick: () => remote.window.minimize()
      }, icon('minus', { className: 'icon icon--stroke' })),
      h('button', {
        class: 'win-controls__btn',
        type: 'button',
        title: '最大化',
        onClick: () => remote.window.toggleMaximize()
      }, icon('maximize', { className: 'icon icon--stroke' })),
      h('button', {
        class: 'win-controls__btn win-controls__btn--close',
        type: 'button',
        title: '关闭',
        onClick: () => remote.window.close()
      }, icon('close', { className: 'icon icon--stroke' }))
    ))
  }

  const element = h('header', { class: 'titlebar' },
    h('div', { class: 'titlebar__left' }, sidebarToggle, appName),
    h('div', { class: 'titlebar__spacer' }),
    right
  )

  // 双击标题栏空白处切换最大化（Windows 习惯）
  on(element, 'dblclick', (event) => {
    if (event.target.closest('button')) return
    remote.window.toggleMaximize()
  })

  bus.on(EVENTS.TRACK_CHANGED, ({ track }) => {
    document.title = track ? `${track.title} — ${track.artist}` : 'Aria'
  })

  store.select((state) => state.ui.scanProgress, (progress) => {
    if (!progress || progress.phase === 'done') {
      scanStatus.classList.add('hidden')
      return
    }
    scanStatus.classList.remove('hidden')
    const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
    scanFill.style.width = `${percent}%`
    scanLabel.textContent = progress.total
      ? `正在扫描 ${progress.done}/${progress.total}`
      : '正在查找音乐…'
  })

  store.select((state) => state.ui.scanning, (scanning) => {
    if (scanning) scanStatus.classList.remove('hidden')
  })

  return { element }
}
