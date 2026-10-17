/** 自绘标题栏：拖拽区 + 侧栏开关 + 视图切换（灵动岛）+ 扫描进度 + 窗口按钮 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { remote } from '../../core/remote.js'
import { flipReorder } from '../../core/reorder.js'
import { EVENTS } from '../../core/bus.js'
import { keyHint } from '../../core/format.js'
import { VIEW_ITEMS, normalizeOrder, allowedViews } from './sidebar.js'

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
  store.select((state) => normalizeOrder(state.settings.sidebarOrder, allowedViews(state)), (order) => {
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

  /*
   * 最大化 / 还原按钮：必须在**窗口按钮组之前**定义 —— 按钮组里直接引用它。
   * （第一版放在 element 之前，也就是引用之后，于是运行时 TDZ：
   *   "Cannot access 'maximizeButton' before initialization"，渲染层整个起不来。）
   */
  const MAXIMIZE_PATH = 'M6.2 6.2h11.6v11.6H6.2z'
  const RESTORE_PATH = 'M9.2 6.2h8.6v8.6M6.2 9.2h8.6v8.6H6.2z'
  const maximizeIcon = icon('maximize', { className: 'icon icon--stroke' })
  const maximizeButton = h('button', {
    class: 'win-controls__btn',
    type: 'button',
    title: '最大化',
    onClick: () => remote.window.toggleMaximize()
  }, maximizeIcon)

  // Windows / Linux 自绘窗口按钮；macOS 用系统红绿灯
  if (!store.get().app.isMac) {
    right.appendChild(h('div', { class: 'win-controls' },
      h('button', {
        class: 'win-controls__btn',
        type: 'button',
        title: '最小化',
        onClick: () => remote.window.minimize()
      }, icon('minus', { className: 'icon icon--stroke' })),
      /*
       * 最大化 / 还原按钮：图标与提示随状态切换（icons.js 里本来就有 restore 图形）。
       * 以前无论什么状态都是「最大化」图标 —— 最大化之后点它其实是还原，图标却在骗人。
       */
      maximizeButton,
      h('button', {
        class: 'win-controls__btn win-controls__btn--close',
        type: 'button',
        title: '关闭',
        onClick: () => remote.window.close()
      }, icon('close', { className: 'icon icon--stroke' }))
    ))
  }

  /*
   * 标题栏下面那层「材质补条」。
   *
   * 网格是两行：第 1 行标题栏，第 2 行才是侧栏与内容；材质只画在第 2 行的元素上，
   * 于是 y = --titlebar-h 处出现一条硬边（用户批注截图："中间有一个很明显的条，改一下"）。
   * 这里在标题栏内部补两块**真实元素**，把两侧材质接上去：
   *   · 左块宽度 = 侧栏宽度，用侧栏的材质（blur(34px) saturate(180%)）；
   *   · 右块铺满其余宽度，用内容的材质（blur(blur*0.6)）。
   *
   * 为什么不用伪元素：一开始写在 `.app::before/::after` 上，浅色下正常，
   * 深色下**在出图那条采集路径里整条带子仍是裸背景**（实测 Δ=13~16/255）——
   * 伪元素上的 backdrop-filter 在部分合成路径下不生效，换成真实元素才稳。
   * z-index: -1 让它们待在标题栏自身内容（z-index 由 .titlebar 的 20 提供）之下。
   */
  const materialSide = h('div', { class: 'titlebar__material titlebar__material--side' })
  const materialMain = h('div', { class: 'titlebar__material titlebar__material--main' })
  const materialLayer = h('div', { class: 'titlebar__materials' }, materialSide, materialMain)

  const element = h('header', { class: 'titlebar' },
    materialLayer,
    h('div', { class: 'titlebar__left' }, sidebarToggle, appName),
    h('div', { class: 'titlebar__spacer' }),
    island,
    right
  )

  // 挂载后各段才有真实宽度（此时可能还没进 DOM，量到 0 也没关系，
  // ResizeObserver 会在真正布局完成后补一次）
  paintThumb()

  /*
   * 最大化 / 还原的状态同步（只影响图标与提示；拖动不再分状态，见下）。
   */
  const applyMaximized = (maximized) => {
    const on = Boolean(maximized)
    document.body.classList.toggle('is-maximized', on)
    element.classList.toggle('is-maximized', on)
    maximizeIcon.setAttribute('d', on ? RESTORE_PATH : MAXIMIZE_PATH)
    maximizeButton.title = on ? '还原' : '最大化'
  }
  applyMaximized(Boolean(store.get().settings.window && store.get().settings.window.maximized))
  remote.window.onMaximizedChange((maximized) => applyMaximized(maximized))

  /*
   * 拖动窗口：**唯一的一条路**，普通窗口与最大化窗口都走这里。
   *
   * 为什么不再交给 `-webkit-app-region: drag`：用户那边普通窗口拖不动，而双击（我们自己的 JS）
   * 好用 —— 坏的正是 native drag 这条路。所以标题栏所有区域都改成 no-drag（shell.css），
   * 按下时把两种信息都交给主进程：
   *   · offsetX/offsetY：光标在窗口内的**像素**位置（普通状态用它，窗口不会跳）；
   *   · ratioX/ratioY：光标在标题栏内的**比例**（最大化还原后窗口变小，按比例映射才不跳）。
   * 主进程按"当前是否最大化"自己选一种（beginWindowDrag 里 wasMaximized 那句）。
   */
  on(element, 'pointerdown', (event) => {
    if (event.button !== 0) return
    /*
     * 只有真正的控件不参与拖动（窗口按钮、灵动岛里的按钮、输入框）。
     * 以前把整个 .island 排除掉了 —— 那会在标题栏正中留一块"拖不动"的死区
     * （用户反馈过这件事）。现在灵动岛的空隙也能拖。
     */
    if (event.target.closest('button, input, .win-controls')) return
    const rect = element.getBoundingClientRect()
    const ratioX = rect.width ? (event.clientX - rect.left) / rect.width : 0.5
    const ratioY = rect.height ? (event.clientY - rect.top) / rect.height : 0.05
    Promise.resolve(remote.window.beginDrag({
      ratioX,
      ratioY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    })).catch(() => {})
    event.preventDefault()
    const stop = () => {
      Promise.resolve(remote.window.endDrag()).catch(() => {})
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('blur', stop)
    }
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('blur', stop)
  })

  // 双击标题栏空白处切换最大化（Windows 习惯）
  on(element, 'dblclick', (event) => {
    if (event.target.closest('button')) return
    remote.window.toggleMaximize()
  })

  bus.on(EVENTS.TRACK_CHANGED, ({ track }) => {
    /*
     * 没在播放时用**产品名**做窗口标题，而不是写死的 'Aria'：
     * player 档位下窗口标题应该显示「Aria Player」（任务栏、Alt+Tab 里才认得出是哪个产品）。
     * 产品名来自档位（window.aria.profile），拿不到才退回 'Aria' —— 本体行为完全不变。
     */
    const productName = (window.aria && window.aria.profile && window.aria.profile.productName) || 'Aria'
    document.title = track ? `${track.title} — ${track.artist}` : productName
  })

  /*
   * 启动时也设一次：TRACK_CHANGED 只在"换歌"时触发，没播过歌的话标题会一直停在
   * index.html 里那个写死的「Aria」（第 3 步的自检就是在这条上红的）。
   */
  {
    const productName = (window.aria && window.aria.profile && window.aria.profile.productName) || 'Aria'
    document.title = productName
  }

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
