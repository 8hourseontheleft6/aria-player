/**
 * 媒体墙：满屏封面马赛克。
 *
 * 三种交互叠在一起：
 *
 * 1) 自由画布（2D 平移）
 *    网格用固定尺寸 + 计算出的列数铺成一块比视口更大的「平面」，
 *    整块用 transform 平移，因此可以横竖斜任意方向拖动 —— 像 Apple Watch 的图标网格。
 *    中键拖动、Alt + 左键拖动都可以；滚轮/触控板直接平移；松手带惯性；
 *    越界有橡皮筋阻尼并回弹。右下角有位置指示器（可点可拖）。
 *    另提供「适应宽度」布局：铺满窗口宽度、只有竖向可动（原来的行为）。
 *
 * 2) 正在播放的专辑放大聚焦
 *    跨 2×2 的格子，内含曲目信息、同步滚动的迷你歌词、传输控件与进度条，
 *    并自动排到平面左上角（order:-1）。
 *
 * 3) FLIP 过渡
 *    尺寸切换与聚焦块换位都先量旧位置、改 DOM、再量新位置，
 *    用 transform 反向补偿后动画归零，整墙平滑推移而不是硬跳。
 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { EVENTS } from '../../core/bus.js'
import { albumKeyOf } from '../../core/grouping.js'
import { createMiniLyrics } from '../widgets/mini-lyrics.js'

const DENSITIES = [
  { id: 's', label: '小', min: 96 },
  { id: 'm', label: '中', min: 148 },
  { id: 'l', label: '大', min: 220 }
]

const LAYOUTS = [
  { id: 'canvas', label: '自由画布', title: '铺成一块比窗口更大的平面，可横竖斜任意方向拖动' },
  { id: 'fit', label: '适应宽度', title: '铺满窗口宽度，只有竖向可以移动' }
]

const GAP = 3
/** 网格内边距，算列数与铺满宽度时都要算进去 */
const PAD = 3
const FLIP_DURATION = 460
const FLIP_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'
const INERTIA_DECAY = 0.93
const INERTIA_MIN = 0.06
/** 每帧最大滑行位移，避免猛甩一下墙面飞出去 */
const INERTIA_MAX_VELOCITY = 58
const ELASTIC = 0.35

export function createMediaWall ({ store, bus, player, actions, lazy, isBackgroundReleased }) {
  let density = 'm'
  let layout = 'canvas'  /** @type {Array<object>} */
  let albumList = []
  /** @type {Map<string, {element: HTMLElement, album: object}>} */
  const tiles = new Map()
  let featuredKey = null
  let enteringTimer = null
  /** 是否已经建过一次墙：第一次建才允许把视角放在左上角，之后一律保住当前视角 */
  let hadFirstBuild = false
  /** 平面尺寸与列数（由 computeLayout 决定） */
  let columns = 6
  let tileSize = 148

  /* ---------------- 工具栏 ---------------- */
  const titleNode = h('div', { class: 'view-toolbar__title', text: '媒体墙' })
  const countNode = h('div', { class: 'view-toolbar__meta' })

  const densitySegmented = h('div', { class: 'segmented segmented--icons' })
  const densityThumb = h('div', { class: 'segmented__thumb' })
  const densityButtons = DENSITIES.map((item) => h('button', {
    class: `segmented__item${item.id === density ? ' is-selected' : ''}`,
    type: 'button',
    text: item.label,
    dataset: { density: item.id },
    title: `封面尺寸：${item.label}`,
    onClick: () => setDensity(item.id)
  }))
  densitySegmented.append(densityThumb, ...densityButtons)

  const layoutSegmented = h('div', { class: 'segmented' })
  const layoutThumb = h('div', { class: 'segmented__thumb' })
  const layoutButtons = LAYOUTS.map((item) => h('button', {
    class: `segmented__item${item.id === layout ? ' is-selected' : ''}`,
    type: 'button',
    text: item.label,
    dataset: { layout: item.id },
    title: item.title,
    onClick: () => setLayout(item.id)
  }))
  layoutSegmented.append(layoutThumb, ...layoutButtons)

  function paintSegmentedThumb (segmented, thumb) {
    const active = segmented.querySelector('.segmented__item.is-selected')
    if (!active || !active.offsetWidth) {
      requestAnimationFrame(() => paintSegmentedThumb(segmented, thumb))
      return
    }
    thumb.style.width = `${active.offsetWidth}px`
    thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`
  }

  const playAllButton = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    onClick: () => actions.playAll()
  }, icon('play'), '播放全部')

  const shuffleButton = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => actions.shuffleAll()
  }, icon('shuffleAll', { className: 'icon icon--stroke' }), '随机播放')

  const locateButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '回到正在播放的专辑',
    onClick: () => {
      if (!focusFeatured()) {
        bus.emit(EVENTS.TOAST, { message: '还没有正在播放的歌曲', type: 'info' })
      }
    }
  }, icon('target', { className: 'icon icon--stroke' }))

  const toolbar = h('div', { class: 'view-toolbar' },
    titleNode,
    h('div', { class: 'view-toolbar__spacer' }),
    countNode,
    locateButton,
    layoutSegmented,
    densitySegmented,
    shuffleButton,
    playAllButton
  )

  const header = h('div', { class: 'view-header' },
    h('div', { class: 'view-header__row' },
      h('div', {},
        h('h1', { class: 'view-header__title', text: '媒体墙' }),
        h('div', { class: 'view-header__subtitle' },
          h('span', { text: '点击专辑即播放；' }),
          h('span', { class: 'kbd', text: '中键' }),
          h('span', { text: ' 或 ' }),
          h('span', { class: 'kbd', text: 'Alt' }),
          h('span', { text: ' + 拖动可以任意方向移动整面墙，滚轮同样可用' })
        )
      )
    )
  )

  /* ---------------- 聚焦块 ---------------- */
  const heroTitle = h('div', { class: 'hero__title truncate', text: '' })
  const heroArtist = h('div', { class: 'hero__artist truncate', text: '' })

  const miniLyrics = createMiniLyrics({ store, bus, player, className: 'hero__lyrics' })

  const prevButton = h('button', {
    class: 'hero__control',
    type: 'button',
    title: '上一首',
    onClick: (event) => {
      event.stopPropagation()
      player.prev()
    }
  }, icon('prev'))

  const playButton = h('button', {
    class: 'hero__control hero__control--main',
    type: 'button',
    title: '播放 / 暂停',
    onClick: (event) => {
      event.stopPropagation()
      player.toggle()
    }
  }, icon('pause'))

  const nextButton = h('button', {
    class: 'hero__control',
    type: 'button',
    title: '下一首',
    onClick: (event) => {
      event.stopPropagation()
      player.next()
    }
  }, icon('next'))

  const expandButton = h('button', {
    class: 'hero__expand',
    type: 'button',
    title: '打开正在播放',
    onClick: (event) => {
      event.stopPropagation()
      actions.openNowPlaying({ lyrics: true })
    }
  }, icon('chevronUp', { className: 'icon icon--stroke' }))

  const progressFill = h('i')

  const hero = h('div', { class: 'wall-tile__hero' },
    h('div', { class: 'hero__scrim' }),
    h('div', { class: 'hero__content' },
      h('div', { class: 'hero__badge' },
        h('span', { class: 'bars' }, h('span'), h('span'), h('span')),
        h('span', { text: '正在播放' })
      ),
      h('div', { class: 'hero__meta' }, heroTitle, heroArtist),
      miniLyrics.element,
      h('div', { class: 'hero__controls' }, prevButton, playButton, nextButton, expandButton)
    ),
    h('div', { class: 'hero__progress' }, progressFill)
  )
  on(hero, 'click', (event) => event.stopPropagation())
  on(hero, 'dblclick', (event) => event.stopPropagation())

  /* ---------------- 平面与视口 ---------------- */
  const grid = h('div', { class: 'media-wall' })
  const viewport = h('div', { class: 'wall-viewport' }, grid)

  // 右下角位置指示器：内容比视口大时才出现
  const minimapViewport = h('div', { class: 'wall-minimap__viewport' })
  const minimap = h('div', { class: 'wall-minimap', hidden: true }, minimapViewport)

  const element = h('div', { class: 'content-inner view-root' }, toolbar, header, viewport, minimap)

  /* ================================================================ */
  /* 2D 画布：平移、惯性、橡皮筋、位置指示器                            */
  /* ================================================================ */

  const pan = { x: 0, y: 0 }      // 已应用的位移
  const target = { x: 0, y: 0 }   // 目标位移：拖动 / 滚轮 / 惯性都往这里写
  const velocity = { x: 0, y: 0 }

  /**
   * 每个格子在平面里的行列。
   *
   * 只用来算「哪些格子看得见」，所以不回读 DOM：布局变化后（重建 / 改密度 /
   * 聚焦块换位）量一次，之后平移途中只看缓存。
   */
  const slots = []                // 与 grid.children 同序
  let slotPitch = 151             // 格子 + 间距
  let slotRows = 0
  let slotColumns = 0
  let cullTimer = null
  let visibleScanTimer = null
  let lastScan = null

  /**
   * 几何缓存。
   *
   * 平移过程中绝对不能读 DOM —— grid.offsetWidth 或 getBoundingClientRect() 都会
   * 强制同步重排，在一帧里做两次就会明显掉帧。所以平面尺寸、视口尺寸、指示器尺寸
   * 全部在这里算好，只在「布局真的变了」的时候刷新（重建、改尺寸/布局、窗口缩放）。
   */
  const geometry = {
    planeWidth: 0, planeHeight: 0,
    viewWidth: 0, viewHeight: 0,
    mapScale: 1, mapWidth: 0, mapHeight: 0
  }
  const MINIMAP_MAX = { width: 108, height: 74 }

  let dragging = false
  let animationFrame = null   // 惯性 / 回弹动画
  let panFrame = null         // 每帧一次平移落地的合流帧
  let elasticPending = false
  let suppressClick = false
  let lastPointer = { x: 0, y: 0, time: 0 }
  let minimapSizePainted = ''
  let minimapBoxPainted = ''

  function reduceMotion () {
    return store.get().settings.reduceMotion === true ||
      document.documentElement.dataset.reduceMotion === 'true'
  }

  /** 只在布局变化时调用：这里会读 DOM，属于少数几次可接受的强制重排 */
  function measureGeometry () {
    geometry.viewWidth = viewport.clientWidth
    geometry.viewHeight = viewport.clientHeight
    // 平面尺寸就是网格自己的盒子（宽度是 max-content，高度由 17 行轨道撑开）
    geometry.planeWidth = grid.offsetWidth
    geometry.planeHeight = grid.offsetHeight
    cacheSlots()

    const scale = Math.min(
      MINIMAP_MAX.width / Math.max(1, geometry.planeWidth),
      MINIMAP_MAX.height / Math.max(1, geometry.planeHeight)
    )
    geometry.mapScale = scale
    geometry.mapWidth = Math.max(30, Math.round(geometry.planeWidth * scale))
    geometry.mapHeight = Math.max(24, Math.round(geometry.planeHeight * scale))

    const sizeKey = `${geometry.mapWidth}x${geometry.mapHeight}`
    if (sizeKey !== minimapSizePainted) {
      minimapSizePainted = sizeKey
      minimap.style.width = `${geometry.mapWidth}px`
      minimap.style.height = `${geometry.mapHeight}px`
    }
    minimap.dataset.scale = String(scale)
    minimapBoxPainted = ''
    paintMinimap()
  }

  /** 全部走缓存，没有 DOM 读取 */
  function bounds () {
    return {
      minX: Math.min(0, geometry.viewWidth - geometry.planeWidth),
      maxX: 0,
      minY: Math.min(0, geometry.viewHeight - geometry.planeHeight),
      maxY: 0,
      width: geometry.planeWidth,
      height: geometry.planeHeight,
      viewWidth: geometry.viewWidth,
      viewHeight: geometry.viewHeight
    }
  }

  /* ================================================================ */
  /* 屏幕外格子不参与绘制                                                */
  /* ================================================================ */

  /**
   * 量一遍每个格子的行列（只在布局变化后调用）。
   *
   * 布局是网格自动填充，行列本来由浏览器决定，但平移途中不能每帧回读 DOM，
   * 所以这里量一次存下来；聚焦块跨 2×2，它的 span 一并记住。
   */
  function cacheSlots () {
    slots.length = 0
    slotPitch = Math.max(1, tileSize + GAP)
    slotRows = 0
    slotColumns = columns
    let index = 0
    for (const node of grid.children) {
      const row = Math.max(0, Math.round((node.offsetTop - PAD) / slotPitch))
      const column = Math.max(0, Math.round((node.offsetLeft - PAD) / slotPitch))
      const rowSpan = Math.max(1, Math.round((node.offsetHeight + GAP) / slotPitch))
      const columnSpan = Math.max(1, Math.round((node.offsetWidth + GAP) / slotPitch))
      /*
       * culled 必须从元素当前的类里读回来，不能一律当 false：
       * 重算布局时（重建 / 改密度 / 聚焦块换位）元素上可能还留着上一次的 is-culled，
       * 如果这里记成 false，updateCulling 会认为「状态没变」而不再写样式，
       * 那些格子就永久隐藏了 —— 表现是拖回原点后画面里出现整条空带。
       */
      slots[index++] = {
        node,
        row,
        column,
        rowSpan,
        columnSpan,
        culled: node.classList.contains('is-culled')
      }
      slotRows = Math.max(slotRows, row + rowSpan)
    }
  }

  /**
   * 按当前位移决定哪些格子看得见，屏幕外的加 .is-culled（visibility: hidden）。
   *
   * 用 visibility 而不是 display:none —— 后者会让网格重新自动填充，
   * 整面墙每次都会重排；visibility 只跳过绘制，布局一点不变。
   * 只对「状态真的变了」的格子写样式，所以一帧通常只有进出画面边缘的那几个。
   */
  function updateCulling () {
    if (!slots.length) return 0
    const margin = 1
    const firstRow = Math.floor((-pan.y - PAD) / slotPitch) - margin
    const lastRow = Math.ceil((-pan.y + geometry.viewHeight - PAD) / slotPitch) + margin
    const firstColumn = Math.floor((-pan.x - PAD) / slotPitch) - margin
    const lastColumn = Math.ceil((-pan.x + geometry.viewWidth - PAD) / slotPitch) + margin

    let changed = 0
    for (const slot of slots) {
      const visible = slot.row + slot.rowSpan - 1 >= firstRow && slot.row <= lastRow &&
        slot.column + slot.columnSpan - 1 >= firstColumn && slot.column <= lastColumn
      const culled = !visible
      if (culled === slot.culled) continue
      slot.culled = culled
      slot.node.classList.toggle('is-culled', culled)
      changed++
    }
    return changed
  }

  /** 平移途中不必每帧都算裁剪：按位移变化量节流，一帧最多一次 */
  function scheduleCulling () {
    if (cullTimer) return
    cullTimer = requestAnimationFrame(() => {
      cullTimer = null
      updateCulling()
    })
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  /** 越界时按比例阻尼，做出「拉得动但拉不远」的手感 */
  function rubber (value, min, max, factor = ELASTIC) {
    if (value > max) return max + (value - max) * factor
    if (value < min) return min + (value - min) * factor
    return value
  }

  /**
   * 只写样式、不算边界（调用方保证 pan 已经合法）。
   *
   * 平移直接作用在平面上：屏幕位置 = 平面内坐标 + pan，没有第二层变换，
   * 也就没有「裁剪域跟着 transform 走」那类坑。
   * 省绘制交给 updateCulling()（屏幕外的格子 visibility: hidden）。
   */
  function writePan () {
    grid.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0)`
    paintMinimap()
    scheduleCulling()
    scheduleVisibleScan()
  }

  /**
   * 平移停稳后补一次「可见性兜底扫描」。
   *
   * 平移只改祖先 transform（纯合成、不触发布局），IntersectionObserver
   * 不一定会为因此进入视口的格子派发新回调，结果就是拖到中段之后新露出来的
   * 格子一直是灰底占位图（见 lazy.scan 的注释）。这里在最后一次平移之后
   * 220ms（手势的 resume 定在 180ms）自己按几何补一次，代价只在停稳时付一次。
   */
  function scheduleVisibleScan (delay = 220) {
    if (visibleScanTimer) clearTimeout(visibleScanTimer)
    visibleScanTimer = setTimeout(() => {
      visibleScanTimer = null
      if (!viewport.clientWidth || !viewport.clientHeight) return
      const result = lazy.scan({ root: viewport })
      if (result.added) lastScan = { ...result, at: Date.now() }
    }, delay)
  }

  /** 把 target 落成 pan 并写 DOM */
  function flushPan (elastic = elasticPending) {
    elasticPending = false
    const limit = bounds()
    pan.x = elastic ? rubber(target.x, limit.minX, limit.maxX) : clamp(target.x, limit.minX, limit.maxX)
    pan.y = elastic ? rubber(target.y, limit.minY, limit.maxY) : clamp(target.y, limit.minY, limit.maxY)
    writePan()
  }

  /** 一帧最多落地一次：一次手势事件可能触发多次 pointermove/wheel */
  function scheduleFlush () {
    if (panFrame) return
    panFrame = requestAnimationFrame(() => {
      panFrame = null
      flushPan()
    })
  }

  /**
   * 手势期间暂停封面懒加载观察。
   * 几百个观察目标 + 每帧都在变的容器位置 = 每帧几十毫秒的相交性重算，
   * 这是平移卡顿的主因；松手后再整体挂回去。
   */
  let resumeTimer = null
  function beginGesture () {
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    lazy.suspend()
  }

  function endGestureSoon () {
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      // 惯性还在滑行就继续等，等整面墙彻底停稳再恢复观察
      if (animationFrame) {
        endGestureSoon()
        return
      }
      lazy.resume()
    }, 180)
  }

  function setPan (x, y, { elastic = false } = {}) {
    target.x = x
    target.y = y
    if (elastic) elasticPending = true
    scheduleFlush()
  }

  /** 取消惯性 / 回弹动画，并把 target 对齐到当前实际位置 */
  function cancelAnimation () {
    if (animationFrame) {
      cancelAnimationFrame(animationFrame)
      animationFrame = null
    }
    target.x = pan.x
    target.y = pan.y
  }

  function stopInertia () {
    cancelAnimation()

    velocity.x = 0
    velocity.y = 0
  }

  /** 松手后的惯性滑行：撞到边界就停，不留回弹 */
  function startInertia () {
    cancelAnimation()
    let vx = clamp(velocity.x, -INERTIA_MAX_VELOCITY, INERTIA_MAX_VELOCITY)
    let vy = clamp(velocity.y, -INERTIA_MAX_VELOCITY, INERTIA_MAX_VELOCITY)
    velocity.x = 0
    velocity.y = 0
    if (reduceMotion() || (Math.abs(vx) < 0.4 && Math.abs(vy) < 0.4)) {
      target.x = pan.x
      target.y = pan.y
      return
    }
    let previous = performance.now()
    const step = (now) => {
      // 按真实时间衰减：衰减率与位移都换算成「相当于多少帧」，
      // 这样低帧率机器上不会出现「滑行持续十几秒」的诡异手感
      const delta = Math.min(50, Math.max(1, now - previous))
      previous = now
      const frames = delta / 16.667
      const decay = Math.pow(INERTIA_DECAY, frames)
      vx *= decay
      vy *= decay

      const limit = bounds()
      const nextX = clamp(pan.x + vx * frames, limit.minX, limit.maxX)
      const nextY = clamp(pan.y + vy * frames, limit.minY, limit.maxY)
      if (nextX === limit.minX || nextX === limit.maxX) vx = 0
      if (nextY === limit.minY || nextY === limit.maxY) vy = 0
      pan.x = nextX
      pan.y = nextY
      target.x = nextX
      target.y = nextY
      writePan()
      if (Math.abs(vx) < INERTIA_MIN && Math.abs(vy) < INERTIA_MIN) {
        animationFrame = null
        return
      }
      animationFrame = requestAnimationFrame(step)
    }
    animationFrame = requestAnimationFrame(step)
  }

  /** 橡皮筋回弹：用 easeOutCubic 近似 iOS 的弹簧，比直接吸附自然 */
  function animatePanTo (x, y, duration = 280) {
    cancelAnimation()
    const startX = pan.x
    const startY = pan.y
    const started = performance.now()
    if (reduceMotion() || (Math.abs(x - startX) < 0.5 && Math.abs(y - startY) < 0.5)) {
      pan.x = x
      pan.y = y
      writePan()
      return
    }
    const step = (now) => {
      const progress = Math.min(1, (now - started) / duration)
      const eased = 1 - (1 - progress) ** 3
      pan.x = startX + (x - startX) * eased
      pan.y = startY + (y - startY) * eased
      target.x = pan.x
      target.y = pan.y
      writePan()
      if (progress < 1) animationFrame = requestAnimationFrame(step)
      else animationFrame = null
    }
    animationFrame = requestAnimationFrame(step)
  }

  /* ---------------- 位置指示器 ---------------- */

  /** 只写样式，尺寸取自几何缓存，绝不读 DOM */
  function paintMinimap () {
    const limit = bounds()
    const pannable = limit.minX < -1 || limit.minY < -1
    minimap.hidden = !pannable
    if (!pannable) return

    const { mapScale, mapWidth, mapHeight } = geometry
    const boxWidth = clamp(Math.round(limit.viewWidth * mapScale), 12, mapWidth)
    const boxHeight = clamp(Math.round(limit.viewHeight * mapScale), 12, mapHeight)
    const boxKey = `${boxWidth}x${boxHeight}`
    if (boxKey !== minimapBoxPainted) {
      minimapBoxPainted = boxKey
      minimapViewport.style.width = `${boxWidth}px`
      minimapViewport.style.height = `${boxHeight}px`
    }

    const boxX = clamp(Math.round(-pan.x * mapScale), 0, mapWidth - boxWidth)
    const boxY = clamp(Math.round(-pan.y * mapScale), 0, mapHeight - boxHeight)
    minimapViewport.style.transform = `translate3d(${boxX}px, ${boxY}px, 0)`
  }

  /** 点/拖指示器：把视口中心移到对应位置 */
  function panFromMinimap (event) {
    const rect = minimap.getBoundingClientRect()
    const localX = clamp(event.clientX - rect.left, 0, rect.width)
    const localY = clamp(event.clientY - rect.top, 0, rect.height)
    const limit = bounds()
    const nextX = -(localX / geometry.mapScale) + limit.viewWidth / 2
    const nextY = -(localY / geometry.mapScale) + limit.viewHeight / 2
    stopInertia()
    setPan(nextX, nextY)
  }

  on(minimap, 'pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    minimap.setPointerCapture(event.pointerId)
    panFromMinimap(event)
    const move = (moveEvent) => panFromMinimap(moveEvent)
    const up = () => {
      minimap.removeEventListener('pointermove', move)
      minimap.removeEventListener('pointerup', up)
    }
    minimap.addEventListener('pointermove', move)
    minimap.addEventListener('pointerup', up)
  })

  /* ---------------- 拖动平移 ---------------- */

  function isPanGesture (event) {
    if (event.button === 1) return true // 中键
    if (event.button === 0 && event.altKey) return true // Alt + 左键
    return false
  }

  on(viewport, 'mousedown', (event) => {
    // 中键在 Windows 上会触发自动滚动，这里一并挡掉
    if (event.button === 1) event.preventDefault()
  })

  on(viewport, 'auxclick', (event) => {
    if (event.button === 1) event.preventDefault()
  })

  on(viewport, 'pointerdown', (event) => {
    if (!isPanGesture(event)) return
    event.preventDefault()
    stopInertia()
    beginGesture()
    dragging = true
    suppressClick = false
    viewport.classList.add('is-panning')
    try {
      viewport.setPointerCapture(event.pointerId)
    } catch {
      // 某些合成事件没有可捕获的指针，忽略
    }
    lastPointer = { x: event.clientX, y: event.clientY, time: performance.now() }
  })

  on(viewport, 'pointermove', (event) => {
    if (!dragging) return
    const now = performance.now()
    const dx = event.clientX - lastPointer.x
    const dy = event.clientY - lastPointer.y
    const elapsed = Math.max(1, now - lastPointer.time)
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) suppressClick = true
    // 换算成「每帧位移」，松手后按同一速度继续滑行（带上限，防止猛甩飞出去）
    velocity.x = clamp((dx / elapsed) * 16, -INERTIA_MAX_VELOCITY, INERTIA_MAX_VELOCITY)
    velocity.y = clamp((dy / elapsed) * 16, -INERTIA_MAX_VELOCITY, INERTIA_MAX_VELOCITY)
    lastPointer = { x: event.clientX, y: event.clientY, time: now }
    // 累加到 target（而不是已应用的 pan），否则同一帧内的多次 move 会丢位移
    setPan(target.x + dx, target.y + dy, { elastic: true })
  })

  const endDrag = (event) => {
    if (!dragging) return
    dragging = false
    viewport.classList.remove('is-panning')
    try {
      viewport.releasePointerCapture?.(event.pointerId)
    } catch {
      // 忽略
    }
    // 丢掉还没落地的合流帧，把橡皮筋状态同步落下来
    if (panFrame) {
      cancelAnimationFrame(panFrame)
      panFrame = null
    }
    flushPan(true)

    const limit = bounds()
    const outOfBounds = pan.x > limit.maxX || pan.x < limit.minX || pan.y > limit.maxY || pan.y < limit.minY
    if (outOfBounds) {
      // 越界就先回弹到边界内，再交给惯性
      animatePanTo(
        clamp(pan.x, limit.minX, limit.maxX),
        clamp(pan.y, limit.minY, limit.maxY)
      )
    } else {
      startInertia()
    }
    // 防御：万一拖完没有 click 事件（例如在窗口外松开），别把下一次点击也吞掉
    if (suppressClick) setTimeout(() => { suppressClick = false }, 350)
    endGestureSoon()
  }

  on(viewport, 'pointerup', endDrag)
  on(viewport, 'pointercancel', endDrag)

  // 拖动结束后紧接着的那次 click 不应触发播放
  on(window, 'click', (event) => {
    if (!suppressClick) return
    suppressClick = false
    event.stopPropagation()
    event.preventDefault()
  }, true)

  on(viewport, 'wheel', (event) => {
    event.preventDefault()
    stopInertia()
    beginGesture()
    // 触控板的惯性滚动会带来密集的 wheel 事件，同样合流到一帧一次
    setPan(target.x - event.deltaX, target.y - event.deltaY)
    endGestureSoon()
  }, { passive: false })

  /* ================================================================ */
  /* 布局：列数与尺寸                                                    */
  /* ================================================================ */

  function preset () {
    return DENSITIES.find((item) => item.id === density) || DENSITIES[1]
  }

  function computeLayout (total) {
    const viewWidth = Math.max(1, viewport.clientWidth)
    const viewHeight = Math.max(1, viewport.clientHeight)
    const size = preset().min
    // 网格自带 PAD 的内边距，算「放得下几列」和「铺满宽度」时都要扣掉，
    // 否则平面会比视口宽出 2*PAD，导致「适应宽度」也出现一点点横向可拖
    const usable = Math.max(1, viewWidth - PAD * 2)
    const fitColumns = Math.max(1, Math.floor((usable + GAP) / (size + GAP)))

    if (layout === 'fit') {
      // 铺满宽度：算出精确尺寸，等价于原来的 1fr 效果
      const exact = Math.max(60, (usable - GAP * (fitColumns - 1)) / fitColumns)
      return { columns: fitColumns, size: exact }
    }

    // 自由画布：列数取「能铺满」与「按视口比例算出的方形平面」的较大者，
    // 这样专辑多的时候平面会明显宽于窗口，横竖斜都能拖
    const target = Math.ceil(Math.sqrt(Math.max(1, total) * (viewWidth / viewHeight)))
    const wanted = Math.max(fitColumns, Math.min(Math.max(1, total), target))
    return { columns: wanted, size }
  }

  function applyLayout () {
    const next = computeLayout(albumList.length)
    columns = next.columns
    tileSize = next.size
    grid.style.setProperty('--wall-columns', String(columns))
    grid.style.setProperty('--wall-size', `${tileSize}px`)
    // 平面尺寸 / 格子行列都变了，几何缓存必须跟着刷新（这里的一次强制重排是必要开销）
    measureGeometry()
    updateCulling()
  }

  /** 布局 / 尺寸变化后重新收敛平移状态（reset=true 时回到平面左上角） */
  function settlePan ({ reset = false } = {}) {
    cancelAnimation()
    if (reset) {
      pan.x = 0
      pan.y = 0
    }
    target.x = pan.x
    target.y = pan.y
    flushPan(false)
  }

  function setDensity (next) {
    if (next === density) return
    density = next
    for (const button of densityButtons) {
      button.classList.toggle('is-selected', button.dataset.density === density)
    }
    paintSegmentedThumb(densitySegmented, densityThumb)

    flip(() => {
      applyLayout()
      const key = currentAlbumKey()
      if (key !== featuredKey) applyFeatured(key)
    })
    settlePan()
  }

  function setLayout (next) {
    if (next === layout) return
    layout = next
    for (const button of layoutButtons) {
      button.classList.toggle('is-selected', button.dataset.layout === layout)
    }
    paintSegmentedThumb(layoutSegmented, layoutThumb)
    actions.setSetting({ wallLayout: layout })
    flip(() => applyLayout())
    settlePan({ reset: true })
  }

  /* ================================================================ */
  /* FLIP                                                              */
  /* ================================================================ */

  function settle () {
    if (enteringTimer) {
      clearTimeout(enteringTimer)
      enteringTimer = null
    }
    grid.classList.remove('is-entering')
    for (const node of grid.querySelectorAll('.is-flipping')) {
      for (const running of node.getAnimations()) running.cancel()
      node.classList.remove('is-flipping')
    }
  }

  /**
   * 量位置时减去平面自身的 left/top，这样得到的是「平面内坐标」，
   * 与当前的平移量无关 —— 否则平移过程中做 FLIP 会算出错误位移。
   */
  function measure () {
    const map = new Map()
    const origin = grid.getBoundingClientRect()
    // 只有「墙视口附近」的格子值得做 FLIP；其余的在窗口裁剪之外，看不见也动不到
    const box = viewport.getBoundingClientRect()
    let near = 0
    for (const child of grid.children) {
      const rect = child.getBoundingClientRect()
      const visible = rect.bottom > box.top - 200 && rect.top < box.bottom + 200 &&
        rect.right > box.left - 200 && rect.left < box.right + 200
      map.set(child, {
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        width: rect.width,
        height: rect.height,
        near: visible
      })
      if (visible) near++
      if (near > 260) break
    }
    return map
  }

  function flip (mutate) {
    settle()
    const before = measure()
    mutate()
    if (reduceMotion()) return
    const after = measure()

    for (const [node, next] of after) {
      const previous = before.get(node)
      if (!previous || !next.near || !previous.near) continue
      const dx = previous.left - next.left
      const dy = previous.top - next.top
      const sameSize = Math.abs(previous.width - next.width) < 0.5 &&
        Math.abs(previous.height - next.height) < 0.5
      if (sameSize && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue

      const scaleX = next.width ? previous.width / next.width : 1
      const scaleY = next.height ? previous.height / next.height : 1

      node.classList.add('is-flipping')
      const animation = node.animate([
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})` },
        { transformOrigin: '0 0', transform: 'none' }
      ], { duration: FLIP_DURATION, easing: FLIP_EASING })
      animation.onfinish = () => node.classList.remove('is-flipping')
      animation.oncancel = () => node.classList.remove('is-flipping')
    }
  }

  /* ================================================================ */
  /* 格子                                                              */
  /* ================================================================ */

  function createTile (album, index) {
    const art = h('div', { class: 'wall-tile__art' })
    // 媒体墙有几百个格子，占位图标改用 CSS 画，省下几百个 SVG 节点
    lazy.observe(art, album.artworkTrack, null)

    /*
     * 尺寸花样（确定性，不用随机数）：一堵墙全是同样大小的方块太平。
     * 每 11 张一轮：第 4 张 2×2、第 7 张 2×1（宽）、第 10 张 1×2（高），其余 1×1。
     * 用「索引取模」而不是随机，是为了让同一张专辑每次落在同一个形状上、自检也稳定。
     * 正在播放那张由 .is-featured 覆盖成 2×2（CSS 里排在花样之后，优先级更高）。
     * 跨格尺寸由 cacheSlots() 按实际 offsetWidth/Height 量出来，所以几何/裁剪/平移都不受影响。
     */
    const pattern = index % 11
    const shapeClass = pattern === 3 ? 'is-big' : pattern === 6 ? 'is-wide' : pattern === 9 ? 'is-tall' : ''

    const tile = h('div', {
      class: `wall-tile${shapeClass ? ` ${shapeClass}` : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${album.name} — ${album.albumArtist}`,
      title: `${album.name} — ${album.albumArtist}`,
      style: { animationDelay: `${Math.min(index, 32) * 10}ms` },
      dataset: { key: album.key },
      onClick: () => {
        if (tile.classList.contains('is-featured')) {
          actions.openNowPlaying({ lyrics: true })
          return
        }
        const ids = album.tracks.map((track) => track.id)
        player.playCollection(ids, ids[0])
      },
      onDblclick: () => actions.openAlbum(album.key),
      onKeydown: (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        tile.click()
      },
      onContextmenu: (event) => {
        event.preventDefault()
        actions.openTrackMenu(
          album.tracks.find((track) => track.id === store.get().playback.trackId) || album.tracks[0],
          event
        )
      }
    },
    art,
    h('div', { class: 'wall-tile__info' },
      h('div', { class: 'wall-tile__name truncate', text: album.name }),
      h('div', { class: 'wall-tile__artist truncate', text: `${album.albumArtist} · ${album.trackCount} 首` })
    ),
    h('span', {
      class: 'wall-tile__open',
      title: '查看专辑',
      onClick: (event) => {
        event.stopPropagation()
        actions.openAlbum(album.key)
      }
    }, icon('chevronRight', { className: 'icon icon--stroke' }))
    )

    tiles.set(album.key, { element: tile, album })
    return tile
  }

  function rebuild (list, { animateIn, focus = false, preservePan = false }) {
    // 重建会换掉所有格子，但**不该动用户当前的视角**
    const previous = preservePan ? { x: pan.x, y: pan.y } : null

    clear(grid)
    tiles.clear()
    const fragment = document.createDocumentFragment()
    list.forEach((album, index) => fragment.appendChild(createTile(album, index)))
    grid.appendChild(fragment)

    applyLayout()
    featuredKey = null
    applyFeatured(currentAlbumKey())
    if (previous) {
      pan.x = previous.x
      pan.y = previous.y
      target.x = previous.x
      target.y = previous.y
      // 只做边界钳制，不回左上角
      settlePan()
      writePan()
    } else {
      settlePan({ reset: true })
    }
    // 重建后直接定位到正在播放的专辑，而不是停在平面左上角
    if (focus) focusFeatured({ animate: false })

    if (animateIn && !reduceMotion()) {
      grid.classList.add('is-entering')
      if (enteringTimer) clearTimeout(enteringTimer)
      enteringTimer = setTimeout(() => grid.classList.remove('is-entering'), 900)
    }
  }

  /* ================================================================ */
  /* 聚焦块                                                            */
  /* ================================================================ */

  function currentAlbumKey () {
    const state = store.get()
    const track = state.library.byId.get(state.playback.trackId)
    if (!track) return null
    return albumKeyOf(track)
  }

  function syncHeroContent () {
    const state = store.get()
    const track = state.library.byId.get(state.playback.trackId)
    if (!track) return
    heroTitle.textContent = track.title
    heroArtist.textContent = `${track.artist}${track.album ? ` · ${track.album}` : ''}`
    const playing = state.playback.status === 'playing' || state.playback.status === 'loading'
    playButton.replaceChildren(icon(playing ? 'pause' : 'play'))
    hero.classList.toggle('is-paused', !playing)
    const bars = hero.querySelector('.hero__badge .bars')
    if (bars) bars.classList.toggle('is-paused', !playing)
  }

  /** 把聚焦块搬到当前专辑的格子里（纯 DOM 操作，动画由调用方决定） */
  function applyFeatured (key) {
    for (const [tileKey, entry] of tiles) {
      if (tileKey === key) continue
      if (entry.element.classList.contains('is-featured')) {
        entry.element.classList.remove('is-featured')
        hero.remove()
      }
    }
    featuredKey = key
    const entry = key ? tiles.get(key) : null
    if (entry) {
      entry.element.classList.add('is-featured')
      entry.element.appendChild(hero)
      syncHeroContent()
    } else {
      // 当前专辑不在墙上（例如被文件夹 / 搜索过滤掉了），当作没有聚焦块
      featuredKey = null
    }
    // 聚焦块占 2×2，会改变总槽位数 → 平面尺寸与位置指示器都要跟着刷新
    measureGeometry()
  }

  /** 让聚焦块跟上当前播放的专辑 */
  function syncFeatured ({ animate = true } = {}) {
    const key = currentAlbumKey()
    if (key === featuredKey) {
      if (key) syncHeroContent()
      return
    }
    if (!animate || reduceMotion()) {
      settle()
      applyFeatured(key)
    } else {
      flip(() => applyFeatured(key))
    }
    miniLyrics.reflow()
  }

  /**
   * 把正在播放的那张专辑平移到视口中央。
   *
   * 这里刻意用 offsetLeft/offsetTop 而不是 getBoundingClientRect()：
   * 定位往往紧跟在一次 FLIP 之后，而 getBoundingClientRect 会把正在跑的
   * transform 算进去，量到的是动画中间的位置，算出来的目标就完全不对。
   * offsetLeft/offsetTop 是布局值，不受 transform 影响。
   */
  function focusFeatured ({ animate = true } = {}) {
    if (!featuredKey) return false
    const entry = tiles.get(featuredKey)
    if (!entry) return false

    const node = entry.element
    const width = node.offsetWidth
    const height = node.offsetHeight
    if (!width || !height) return false

    const limit = bounds()
    const nextX = clamp(limit.viewWidth / 2 - node.offsetLeft - width / 2, limit.minX, limit.maxX)
    const nextY = clamp(limit.viewHeight / 2 - node.offsetTop - height / 2, limit.minY, limit.maxY)

    if (Math.abs(nextX - pan.x) < 1 && Math.abs(nextY - pan.y) < 1) return true
    if (animate && !reduceMotion()) {
      animatePanTo(nextX, nextY, 420)
    } else {
      cancelAnimation()
      pan.x = nextX
      pan.y = nextY
      target.x = nextX
      target.y = nextY
      writePan()
    }
    return true
  }

  /* ================================================================ */
  /* 渲染                                                              */
  /* ================================================================ */

  function refresh ({ focus = false, focusAnimate = true } = {}) {
    /*
     * 最小化释放期间不要建墙。
     * 释放之后墙是空的，而任何一次 store / 资料库变化都会走到这里 —— 资料库
     * 监听触发的那次 refresh() 会把 474 个格子重新建回来，等于白释放。
     * 窗口还原时由 background-release 显式调一次 refresh()。
     */
    if (typeof isBackgroundReleased === 'function' && isBackgroundReleased()) return

    const state = store.get()
    const list = actions.albums()
    /*
     * 只在「专辑集合真的变了」时才重建。
     *
     * list 是索引派生出来的数组，播放、改设置这些操作都会让 store 走一遍，
     * 万一索引重建就会换一个新数组 —— 只要里面的专辑没变，重建就是纯浪费：
     * 474 个格子全换一遍 DOM，而且会把平移重置回左上角
     * （用户反馈的「播放歌曲时突然跳回最左上角」就是这么来的）。
     */
    const sameContent = list.length === albumList.length &&
      list.every((album, index) => album.key === albumList[index]?.key)
    const rebuilt = list !== albumList && !sameContent
    albumList = list

    if (rebuilt) {
      // 用户正在看这面墙：重建也要保住他的视角（首次构建没有 previous，才回左上角）
      rebuild(list, { animateIn: true, focus, preservePan: hadFirstBuild })
      hadFirstBuild = true
    } else {
      const key = currentAlbumKey()
      flip(() => {
        applyLayout()
        if (key !== featuredKey) applyFeatured(key)
      })
      if (key === featuredKey && key) syncHeroContent()
      settlePan()
      if (focus) focusFeatured({ animate: focusAnimate })
    }

    countNode.textContent = `${list.length} 张专辑 · ${state.library.tracks.length} 首`
    densitySegmented.style.display = list.length ? '' : 'none'
    layoutSegmented.style.display = list.length ? '' : 'none'
    requestAnimationFrame(() => {
      paintSegmentedThumb(densitySegmented, densityThumb)
      paintSegmentedThumb(layoutSegmented, layoutThumb)
    })
    requestAnimationFrame(() => miniLyrics.align())
  }

  /* ================================================================ */
  /* 释放                                                              */
  /* ================================================================ */

  /**
   * 丢掉媒体墙占的内存（最小化时调用）。
   *
   * 一面墙是 474 个格子 / 约 4000 个 DOM 节点，是渲染层里最大的一块。
   * 这里把格子、槽位缓存、各种待跑的定时器和惯性动画全部清掉，并把
   * albumList 清空 —— 这样下次 refresh() 会认为「列表变了」而重建
   * （重建本来就很快，实测 474 个格子约 100ms）。
   */
  function release () {
    if (cullTimer) {
      clearTimeout(cullTimer)
      cullTimer = null
    }
    if (visibleScanTimer) {
      clearTimeout(visibleScanTimer)
      visibleScanTimer = null
    }
    if (enteringTimer) {
      clearTimeout(enteringTimer)
      enteringTimer = null
    }
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    cancelAnimation()
    stopInertia()
    if (panFrame) {
      cancelAnimationFrame(panFrame)
      panFrame = null
    }

    const released = tiles.size
    const nodes = grid.childElementCount
    clear(grid)
    tiles.clear()
    slots.length = 0
    slotRows = 0
    slotColumns = 0
    lastScan = null
    featuredKey = null
    albumList = []
    return { tiles: released, nodes }
  }

  /* ================================================================ */
  /* 事件                                                              */
  /* ================================================================ */

  bus.on(EVENTS.LIBRARY_UPDATED, () => {
    if (store.get().ui.view === 'wall') refresh()
  })

  bus.on(EVENTS.TRACK_CHANGED, () => {
    if (store.get().ui.view !== 'wall') return
    syncFeatured()
  })

  bus.on(EVENTS.TIME, ({ time, duration }) => {
    if (store.get().ui.view !== 'wall' || !featuredKey) return
    const ratio = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0
    progressFill.style.width = `${ratio * 100}%`
  })

  store.select((state) => state.playback.status, () => {
    if (featuredKey) syncHeroContent()
  })

  store.subscribe((state, prev) => {
    if (state.ui === prev.ui && state.library === prev.library) return
    if (state.ui.view !== 'wall') return
    refresh()
  })

  store.select((state) => state.ui.view, (view, previous) => {
    if (view === 'wall' && previous !== undefined) {
      requestAnimationFrame(() => {
        // 每次切回媒体墙都定位到正在播放的专辑，而不是回到平面左上角。
        // 这里必须用同步定位：切视图的同一帧视口尺寸会从 0 变成实际值，
        // ResizeObserver 随后会调 settlePan()，动画版本会被它打断。
        refresh({ focus: true, focusAnimate: false })
        miniLyrics.reflow()
      })
    }
  })

  // 恢复上次选择的布局（设置在启动时才加载，所以这里要跟着同步一次）
  store.select((state) => state.settings.wallLayout, (value) => {
    const next = value === 'fit' ? 'fit' : 'canvas'
    if (next === layout) return
    layout = next
    for (const button of layoutButtons) {
      button.classList.toggle('is-selected', button.dataset.layout === layout)
    }
    paintSegmentedThumb(layoutSegmented, layoutThumb)
    applyLayout()
    settlePan({ reset: true })
  })

  const resizeObserver = new ResizeObserver(() => {
    if (store.get().ui.view !== 'wall') return
    applyLayout()
    // 切回媒体墙时视口尺寸会从 0 变成实际值，而「定位到正在播放」的动画
    // 可能刚在同一帧启动 —— 这里不能调 settlePan()，否则它会 cancelAnimation()
    // 把定位动画掐掉。applyLayout 已经刷新了几何缓存，动画下一帧就会用新边界。
    if (animationFrame) return
    settlePan()
  })
  resizeObserver.observe(viewport)

  return {
    element,
    refresh,
    release,
    focusFeatured,
    get density () { return density },
    get layout () { return layout },
    get featuredKey () { return featuredKey },
    get tileCount () { return tiles.size },
    /** 自检用：当前平面与平移状态 */
    debugState: () => {
      const limit = bounds()
      const featured = featuredKey ? tiles.get(featuredKey) : null
      let featuredOffset = null
      let tileCenterInViewport = null
      if (featured) {
        const gridRect = grid.getBoundingClientRect()
        const tileRect = featured.element.getBoundingClientRect()
        featuredOffset = {
          left: Math.round(tileRect.left - gridRect.left),
          top: Math.round(tileRect.top - gridRect.top)
        }
        const viewportRect = viewport.getBoundingClientRect()
        tileCenterInViewport = {
          x: Math.round(tileRect.left + tileRect.width / 2 - viewportRect.left),
          y: Math.round(tileRect.top + tileRect.height / 2 - viewportRect.top)
        }
      }
      return {
        columns,
        tileSize: Math.round(tileSize),
        layout,
        pan: { x: Math.round(pan.x), y: Math.round(pan.y) },
        planeScroll: { width: grid.scrollWidth, height: grid.scrollHeight },
        // 裁剪统计：当前有多少格子被判定为屏幕外（不参与绘制）
        culled: slots.filter((slot) => slot.culled).length,
        slotRows,
        slotColumns,
        // 最近一次「可见性兜底扫描」的结果（平移停稳后补加载新露出的封面）
        scan: lastScan,
        bounds: limit,
        horizontal: limit.minX < -1,
        vertical: limit.minY < -1,
        dragging,
        pannable: limit.minX < -1 || limit.minY < -1,
        lazy: lazy.state,
        featuredOffset,
        tileCenterInViewport,
        viewportCenter: { x: Math.round(limit.viewWidth / 2), y: Math.round(limit.viewHeight / 2) }
      }
    },
    /**
     * 自检用：在墙视口里做一次网格命中测试，回答「用户在这个位置看到的是不是格子」。
     *
     * 为什么非要这么做：DOM 上的 rect 相交并不能说明元素真的可见 ——
     * 被祖先 overflow:hidden 裁掉、或者被判定为屏幕外而不绘制时，rect 依然相交。
     * 之前正是靠 rect 判定通过了自检，而画面上其实只剩左上角一屏（拖到别处全白）。
     * elementFromPoint 会遵守裁剪与命中规则，所以它是「是否真的看得见」的证据。
     */
    debugHitTest: ({ columns = 6, rows = 4 } = {}) => {
      const box = viewport.getBoundingClientRect()
      // 拖动期间格子是 pointer-events:none（避免拖动时触发悬停），
      // 但这里问的是「看不看得见」，所以临时摘掉这个类，测完恢复
      const wasPanning = viewport.classList.contains('is-panning')
      if (wasPanning) viewport.classList.remove('is-panning')
      const result = { tile: 0, empty: 0, culled: 0, other: 0, samples: [] }
      for (let i = 1; i <= columns; i++) {
        for (let j = 1; j <= rows; j++) {
          const x = Math.round(box.left + (box.width * i) / (columns + 1))
          const y = Math.round(box.top + (box.height * j) / (rows + 1))
          const node = document.elementFromPoint(x, y)
          if (!node) { result.empty++; continue }
          const tile = node.closest ? node.closest('.wall-tile') : null
          if (tile) {
            result.tile++
            if (tile.classList.contains('is-culled')) result.culled++
          } else if (node === viewport || node === grid) {
            result.empty++
            if (result.samples.length < 3) {
              // 这个点上几何上到底有没有格子、它可见吗
              // （采样点可能正好落在 3px 的格子缝里，那属于正常情况）
              const covering = slots.filter((slot) => {
                const rect = slot.node.getBoundingClientRect()
                return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
              })
              result.samples.push(
                `${x - Math.round(box.left)},${y - Math.round(box.top)} → 命中的是 ${(node.className || node.tagName).toString().slice(0, 16)}` +
                `，该点上有 ${covering.length} 个格子` +
                (covering.length
                  ? `（第 ${covering[0].row} 行第 ${covering[0].column} 列，visibility=${getComputedStyle(covering[0].node).visibility}）`
                  : '（落在格子缝或平面边缘，正常）')
              )
            }
          } else {
            result.other++
          }
        }
      }
      if (wasPanning) viewport.classList.add('is-panning')
      result.total = columns * rows
      result.wasPanning = wasPanning
      return result
    },
    /** 自检用：缓存的行列与 DOM 实际位置是否还对得上（布局变化后忘了刷新就会错位） */
    debugSlotDrift: () => {
      let drift = 0
      let checked = 0
      for (const slot of slots) {
        if (!slot.node.isConnected) continue
        checked++
        const row = Math.round((slot.node.offsetTop - PAD) / slotPitch)
        const column = Math.round((slot.node.offsetLeft - PAD) / slotPitch)
        if (row !== slot.row || column !== slot.column) drift++
      }
      return { drift, checked, pitch: slotPitch, rows: slotRows, columns: slotColumns }
    },
    /**
     * 自检用：同步落一次平移（含样式写入、裁剪与指示器更新），用来测「每帧平移的纯开销」。
     * 刻意绕过 rAF 合流，这样测到的就是真实的一帧工作量。
     */
    debugApplyPan: (x, y) => {
      target.x = x
      target.y = y
      if (panFrame) {
        cancelAnimationFrame(panFrame)
        panFrame = null
      }
      flushPan(false)
      if (cullTimer) {
        cancelAnimationFrame(cullTimer)
        cullTimer = null
      }
      return { x: pan.x, y: pan.y, culled: updateCulling() }
    },

    /** 自检用：重新构建整面墙并返回耗时（首屏卡顿主要来自这里） */
    debugRebuild: () => {
      const started = performance.now()
      rebuild(albumList, { animateIn: false })
      return {
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
        tiles: tiles.size,
        nodes: grid.querySelectorAll('*').length
      }
    }
  }
}
