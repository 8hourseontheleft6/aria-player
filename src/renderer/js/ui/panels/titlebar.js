/** 自绘标题栏：拖拽区 + 侧栏开关 + 视图切换（灵动岛）+ 扫描进度 + 窗口按钮 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { remote } from '../../core/remote.js'
import { flipReorder } from '../../core/reorder.js'
import { EVENTS } from '../../core/bus.js'
import { keyHint } from '../../core/format.js'
import { VIEW_ITEMS, normalizeOrder } from './sidebar.js'

/**
 * 顶部悬浮的视图切换器（「灵动岛」）。
 *
 * 交互设计：
 *   · 只在侧边栏收起时出现 —— 侧栏已经有一份导航了，两个同时出现是重复；
 *   · 平时只显示当前视图的文字，其余项只留图标 —— 整条很窄，像一颗悬浮胶囊；
 *   · 鼠标移上去展开全部文字（宽度动画），移开收回；滑块始终跟着当前项；
 *   · 顺序跟侧边栏共用 settings.sidebarOrder，在侧栏里拖动排序，这里跟着变。
 * 尺寸全部靠实测（offsetLeft/offsetWidth），不写死，因为各项宽度不一样。
 */
export function createTitlebar ({ store, bus, actions }) {
  const sidebarToggle = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: `显示/隐藏边栏 (${keyHint('B')})`,
    onClick: () => actions.toggleSidebar()
  }, icon('sidebar', { className: 'icon icon--stroke' }))

  const appName = h('div', { class: 'titlebar__app', text: 'Aria' })

  /* ---------------- 灵动岛 ---------------- */
  const thumb = h('span', { class: 'island__thumb', 'aria-hidden': 'true' })
  const island = h('div', { class: 'island' }, thumb)

  /** @type {HTMLElement[]} */
  let islandButtons = []
  let activeKey = null

  /**
   * 滑块位置全部实测，不写死宽度。
   *
   * 触发时机：
   *   · 切视图 / 换顺序时同步画一次（此时类名已换好，量到的是正确宽度）；
   *   · ResizeObserver 兜住其余情况 —— 首次挂载、窗口缩放、悬停展开时
   *     各段宽度都在变。不用 rAF：这个环境里 rAF 会被节流到 ~7fps，
   *     靠它更新滑块看起来就是「卡一下才跟上」。
   */
  function paintThumb () {
    const active = islandButtons.find((node) => node.dataset.view === activeKey)
    // 三种情况下整条隐身：当前视图不在这四项里（如设置页）、侧边栏正开着
    // （默认两者不同时出现），或者用户把「一直显示」打开了
    const showWithSidebar = store.get().settings.islandWithSidebar === true
    const visible = Boolean(active) && (showWithSidebar || !store.get().ui.sidebarVisible)
    island.classList.toggle('is-visible', visible)
    if (!visible) return
    thumb.style.width = `${active.offsetWidth}px`
    thumb.style.transform = `translateX(${active.offsetLeft - islandButtons[0].offsetLeft}px)`
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(paintThumb).observe(island)
  }

  function createItem (key) {
    const item = VIEW_ITEMS[key]
    return h('button', {
      class: 'island__item',
      type: 'button',
      dataset: { view: key },
      title: item.label,
      onClick: () => actions.setView(key)
    },
    icon(item.iconName, { className: 'icon icon--stroke' }),
    h('span', { class: 'island__label', text: item.label })
    )
  }

  /**
   * 按设置里的顺序重建这几段。
   * 顺序变了就搬动已有的节点，并用 FLIP 让它滑过去 —— 所以这里必须复用
   * 现有节点（新建节点的话，FLIP 量到的是旧节点，而它们已经被移出文档，
   * 位移全是 0，动画会变成「啪」地跳）。
   */
  function renderIslandItems (order) {
    const previous = islandButtons
    const existing = new Map(previous.map((node) => [node.dataset.view, node]))
    const nodes = order.map((key) => existing.get(key) || createItem(key))
    islandButtons = nodes

    const unchanged = previous.length === nodes.length && previous.every((node, i) => node === nodes[i])
    if (!unchanged) {
      const reused = nodes.filter((node) => previous.includes(node))
      const mutate = () => {
        clear(island)
        island.appendChild(thumb)
        for (const node of nodes) island.appendChild(node)
      }
      if (reused.length > 1) flipReorder(reused, mutate)
      else mutate()
    }
    updateActive()
    paintThumb()
  }

  function updateActive () {
    for (const node of islandButtons) {
      const active = node.dataset.view === activeKey
      node.classList.toggle('is-active', active)
      // 屏幕阅读器靠这个知道当前在哪一页
      if (active) node.setAttribute('aria-current', 'page')
      else node.removeAttribute('aria-current')
    }
  }

  store.select((state) => state.ui.view, (view) => {
    activeKey = view
    updateActive()
    paintThumb()
  })

  // 侧栏开关与「一直显示灵动岛」的开关都决定它要不要出现
  store.select((state) => state.ui.sidebarVisible, () => paintThumb())
  store.select((state) => state.settings.islandWithSidebar === true, () => paintThumb())

  let orderKey = ''
  store.select((state) => normalizeOrder(state.settings.sidebarOrder), (order) => {
    const key = order.join()
    if (key === orderKey) return
    orderKey = key
    renderIslandItems(order)
  }, { equals: (a, b) => a.join() === b.join() })

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
