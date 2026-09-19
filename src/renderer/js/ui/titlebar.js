/** 自绘标题栏：拖拽区 + 侧栏开关 + 视图切换（灵动岛）+ 扫描进度 + 窗口按钮 */

import { h, on } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { remote } from '../core/remote.js'
import { EVENTS } from '../core/bus.js'

/**
 * 顶部悬浮的视图切换器（「灵动岛」）。
 *
 * 交互设计：
 *   · 平时只显示当前视图的文字，其余项只留图标 —— 整条很窄，像一颗悬浮胶囊；
 *   · 鼠标移上去展开全部文字（宽度动画），移开收回；滑块始终跟着当前项；
 *   · 图标与文字都跟随 store 里的 ui.view，所以从别处切视图（快捷键、侧边栏、
 *     专辑详情）它也会同步。
 * 尺寸全部靠实测（offsetLeft/offsetWidth），不写死，因为各项宽度不一样。
 */
const VIEWS = [
  { key: 'songs', label: '歌曲', icon: 'list' },
  { key: 'albums', label: '专辑', icon: 'disc' },
  { key: 'artists', label: '艺人', icon: 'artist' },
  { key: 'wall', label: '媒体墙', icon: 'wall' }
]

export function createTitlebar ({ store, bus, actions }) {
  const sidebarToggle = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '显示/隐藏边栏 (Ctrl+B)',
    onClick: () => actions.toggleSidebar()
  }, icon('sidebar', { className: 'icon icon--stroke' }))

  const appName = h('div', { class: 'titlebar__app', text: 'Aria' })

  /* ---------------- 灵动岛 ---------------- */
  const thumb = h('span', { class: 'island__thumb', 'aria-hidden': 'true' })
  const islandButtons = VIEWS.map((view) => h('button', {
    class: 'island__item',
    type: 'button',
    dataset: { view: view.key },
    title: view.label,
    onClick: () => actions.setView(view.key)
  },
  icon(view.icon, { className: 'icon icon--stroke' }),
  h('span', { class: 'island__label', text: view.label })
  ))
  const island = h('div', { class: 'island' }, thumb, ...islandButtons)

  let activeKey = null

  /**
   * 滑块位置全部实测，不写死宽度。
   *
   * 触发时机：
   *   · 切视图时同步画一次（此时类名已换好，量到的是正确宽度）；
   *   · ResizeObserver 兜住其余情况 —— 首次挂载、窗口缩放、悬停展开时
   *     各段宽度都在变。不用 rAF：这个环境里 rAF 会被节流到 ~7fps，
   *     靠它更新滑块看起来就是「卡一下才跟上」。
   */
  function paintThumb () {
    const active = islandButtons.find((node) => node.dataset.view === activeKey)
    island.classList.toggle('has-active', Boolean(active))
    if (!active) return
    thumb.style.width = `${active.offsetWidth}px`
    thumb.style.transform = `translateX(${active.offsetLeft - islandButtons[0].offsetLeft}px)`
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(paintThumb).observe(island)
  }

  store.select((state) => state.ui.view, (view) => {
    activeKey = view
    for (const node of islandButtons) {
      const active = node.dataset.view === view
      node.classList.toggle('is-active', active)
      // 屏幕阅读器靠这个知道当前在哪一页
      if (active) node.setAttribute('aria-current', 'page')
      else node.removeAttribute('aria-current')
    }
    paintThumb()
  })

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
    island,
    right
  )

  // 挂载后各段才有真实宽度（此时可能还没进 DOM，量到 0 也没关系，
  // ResizeObserver 会在真正布局完成后补一次）
  paintThumb()

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
