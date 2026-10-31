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
 *    位置仍由行列数据决定（不再用 order 排到首位，换歌时不会跳回左上角）。
 *
 * 3) 窗口化挂载 + 每格独立平移
 *    舞台只有视口那么大，永远不动；只有视口附近 40–80 个格子被挂进 DOM，
 *    平移时逐格写 transform（合成器上移动小层）。
 *    之前是"整面 4382×3325 的平面一起平移"，浏览器每帧重新栅格化整块 ——
 *    实测 68–73ms/帧；现在是 8.4ms/帧（120fps 上限）。
 *
 * 4) FLIP 过渡
 *    尺寸切换与聚焦块换位都先量旧位置、改 DOM、再量新位置，
 *    用 translate/scale 独立属性反向补偿后动画归零（与定位用的 transform 叠加）。
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

export function createMediaWall ({ store, bus, player, actions, lazy, artwork, isBackgroundReleased }) {
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

  /*
   * 空状态：一张专辑都没有时（搜不到、或者资料库还是空的），
   * 以前这面墙就是一块空白表面 —— 与专辑 / 艺人页同一类缺口（那两页也是这轮补的）。
   * 用同一套 .empty 组件与同样的措辞，视觉上与其它视图保持一致。
   */
  const emptyNode = h('div', { class: 'empty hidden' })

  // 右下角位置指示器：内容比视口大时才出现
  const minimapViewport = h('div', { class: 'wall-minimap__viewport' })
  const minimap = h('div', { class: 'wall-minimap', hidden: true }, minimapViewport)

  const element = h('div', { class: 'content-inner view-root' }, toolbar, header, viewport, emptyNode, minimap)

  /* ================================================================ */
  /* 2D 画布：平移、惯性、橡皮筋、位置指示器                            */
  /* ================================================================ */

  const pan = { x: 0, y: 0 }      // 已应用的位移
  const target = { x: 0, y: 0 }   // 目标位移：拖动 / 滚轮 / 惯性都往这里写
  const velocity = { x: 0, y: 0 }

  /**
   * 每张专辑的行列（纯计算，与 DOM 无关）。
   *
   * 舞台只有视口那么大、而且不动；格子按这里的行列算出的平面坐标定位，
   * 平移时只改每个格子自己的 transform。平面尺寸、minimap、命中测试、
   * 窗口区间全部由这份数据推出来，所以挂载/卸载不会反过来要求"重新量 DOM"。
   */
  const slots = []                // 当前已挂载的格子（自检用）
  const cells = []
  const rowStarts = []
  let cellRows = 0
  let featuredIndex = -1
  let slotPitch = 151             // 格子 + 间距
  let slotRows = 0
  let slotColumns = 0
  let visibleScanTimer = null
  let lastScan = null

  /*
   * 窗口化挂载：只把"看得见的那几十格"放进 DOM。
   *
   * 卸载时把元素留在 spare 里（不计入 DOM 节点数），来回拖时可以直接复用：
   * 封面已经加载好，不会闪一下占位图。上限 120 —— 再多就真的开始占内存了。
   */
  const spare = new Map()
  const SPARE_LIMIT = 120
  const WINDOW_MARGIN_ROWS = 1
  const WINDOW_MARGIN_COLS = 1
  /** 上一次算出来的窗口（平移时用它判断"要不要增删"） */
  const mountedWindow = { firstRow: 0, lastRow: -1, firstCol: 0, lastCol: -1, ready: false }

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

  /**
   * 用列数/行数直接算平面尺寸（**不读 DOM**）。
   * 这是窗口化的前提：舞台盒子只有一屏，平面是逻辑概念 —— 平移边界、minimap、
   * 命中测试都用这里的算术值，所以挂载/卸载格子不会迫使我们去量布局。
   */
  function planeMetrics () {
    const width = PAD * 2 + columns * tileSize + Math.max(0, columns - 1) * GAP
    const height = PAD * 2 + Math.max(1, cellRows) * tileSize + Math.max(0, cellRows - 1) * GAP
    return { width, height, columns, rows: cellRows }
  }

  function measureGeometry () {
    geometry.viewWidth = viewport.clientWidth
    geometry.viewHeight = viewport.clientHeight
    /*
     * 平面尺寸用算术值（planeMetrics），**不读 DOM**：
     * 这样"挂载/卸载了一批格子"本身不会迫使我们去量布局 —— 窗口化才可能便宜。
     * 数值与 grid 盒子的偏差由自检「平面尺寸可由行列算出」守着（要求 ≤1px）。
     */
    const metrics = planeMetrics()
    geometry.planeWidth = metrics.width
    geometry.planeHeight = metrics.height
    slotPitch = Math.max(1, tileSize + GAP)
    slotColumns = columns
    slotRows = cellRows

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

  /** 算每张专辑的行列：按行填，index % 9 === 3 与"正在播放那张"占 2×2 */
  function computeCells () {
    cells.length = 0
    const total = albumList.length
    const cols = Math.max(1, columns)
    featuredIndex = featuredKey ? albumList.findIndex((album) => album.key === featuredKey) : -1
    const occupied = new Set()
    let row = 0
    let col = 0
    for (let index = 0; index < total; index++) {
      const wanted = (index % 9 === 3 || index === featuredIndex) ? 2 : 1
      const span = Math.min(wanted, cols)
      for (;;) {
        if (col + span > cols) {
          row++
          col = 0
          continue
        }
        let fits = true
        for (let dr = 0; dr < span && fits; dr++) {
          for (let dc = 0; dc < span; dc++) {
            if (occupied.has((row + dr) * cols + (col + dc))) {
              fits = false
              break
            }
          }
        }
        if (fits) break
        col++
      }
      for (let dr = 0; dr < span; dr++) {
        for (let dc = 0; dc < span; dc++) occupied.add((row + dr) * cols + (col + dc))
      }
      cells.push({ row, col, span })
      col += span
    }
    cellRows = cells.reduce((max, cell) => Math.max(max, cell.row + cell.span), 0)
    /*
     * 行索引：rowStarts[r] = 第 r 行第一个格子的下标（cells 是行优先插入的，所以单调不减）。
     * 窗口化时用二分找首/末行对应的下标区间，避免每帧遍历全部专辑。
     */
    rowStarts.length = cellRows + 1
    let cursor = 0
    for (let row = 0; row < cellRows; row++) {
      while (cursor < cells.length && cells[cursor].row < row) cursor++
      rowStarts[row] = cursor
    }
    rowStarts[cellRows] = cells.length
  }

  /**
   * 当前位移下需要挂载的行范围 [first, last]（含一屏 overscan），O(log 行数)。
   * 目前只用于读数与自检 —— 挂载策略仍是全量，但窗口化的"算窗口"这一步已经是常数级。
   */
  function rowWindow (margin = 2) {
    if (!cellRows) return { first: 0, last: -1 }
    const first = Math.max(0, Math.floor((-pan.y - PAD) / slotPitch) - margin)
    const last = Math.min(cellRows - 1, Math.ceil((-pan.y + geometry.viewHeight - PAD) / slotPitch) + margin)
    return { first, last: Math.max(first, last) }
  }

  /** 窗口对应的专辑下标区间 [start, end) */
  function rowWindowIndexes (margin = 2) {
    const range = rowWindow(margin)
    if (range.last < range.first) return { start: 0, end: 0 }
    return { start: rowStarts[range.first] || 0, end: rowStarts[range.last + 1] || cells.length }
  }

  /* ================================================================ */
  /* 窗口化挂载：只把视口附近 40–80 个格子放进 DOM                       */
  /* ================================================================ */

  /** 当前位移下要挂载的行列范围（含 overscan），O(1) */
  function visibleRange (marginRows = WINDOW_MARGIN_ROWS, marginCols = WINDOW_MARGIN_COLS) {
    const pitch = Math.max(1, slotPitch)
    const firstRow = Math.max(0, Math.floor((-pan.y - PAD) / pitch) - marginRows)
    const lastRow = Math.min(cellRows - 1, Math.ceil((-pan.y + geometry.viewHeight - PAD) / pitch) + marginRows)
    const firstCol = Math.max(0, Math.floor((-pan.x - PAD) / pitch) - marginCols)
    const lastCol = Math.min(columns - 1, Math.ceil((-pan.x + geometry.viewWidth - PAD) / pitch) + marginCols)
    return {
      firstRow,
      lastRow: Math.max(firstRow, lastRow),
      firstCol,
      lastCol: Math.max(firstCol, lastCol)
    }
  }

  /** 格子左上角在平面里的坐标（纯算术） */
  function cellPosition (index) {
    const cell = cells[index]
    if (!cell) return null
    const pitch = Math.max(1, slotPitch)
    return {
      x: PAD + cell.col * pitch,
      y: PAD + cell.row * pitch,
      size: cell.span * tileSize + (cell.span - 1) * GAP,
      span: cell.span
    }
  }

  /** 把一格摆到"平面坐标 + 当前平移"上（写宽高 + transform） */
  function placeTile (entry) {
    const cell = cells[entry.index]
    if (!cell) return
    const position = cellPosition(entry.index)
    const node = entry.element
    const size = `${position.size}px`
    /*
     * 宽高按"跨度的实际像素"写死（1×1 / 2×2）。这里比对 style 字符串而不是缓存值：
     * 元素会从 spare 复用，只要有一次漏写，0×0 的格子就会一直停在平面上
     * （变换位置正常、但什么都看不见）—— 这类问题很难从截图上发现。
     */
    if (node.style.width !== size) {
      node.style.width = size
      node.style.height = size
    }
    entry.width = position.size
    entry.x = position.x
    entry.y = position.y
    node.style.transform = `translate3d(${position.x + pan.x}px, ${position.y + pan.y}px, 0)`
  }

  /** 每帧只改 transform：移动留在合成器上，不触发布局、不触发重绘 */
  function moveTiles () {
    for (const entry of tiles.values()) {
      entry.element.style.transform =
        `translate3d(${entry.x + pan.x}px, ${entry.y + pan.y}px, 0)`
    }
  }

  /** 整面重摆（行列变了：改密度 / 切布局 / 聚焦块换位 / 平移钳制） */
  function placeTiles () {
    slots.length = 0
    for (const entry of tiles.values()) {
      placeTile(entry)
      const cell = cells[entry.index]
      if (!cell) continue
      slots.push({
        node: entry.element,
        row: cell.row,
        column: cell.col,
        rowSpan: cell.span,
        columnSpan: cell.span,
        x: entry.x,
        y: entry.y,
        culled: false
      })
    }
  }

  function windowDiffers (range) {
    return !mountedWindow.ready ||
      range.firstRow !== mountedWindow.firstRow || range.lastRow !== mountedWindow.lastRow ||
      range.firstCol !== mountedWindow.firstCol || range.lastCol !== mountedWindow.lastCol
  }

  /** 卸下一格：从 DOM 摘掉、停止观察封面，但把元素留在 spare 里等着复用 */
  function unmountTile (entry) {
    if (entry.art) lazy.forget(entry.art)
    if (entry.element.contains(hero)) hero.remove()
    entry.element.classList.remove('is-featured')
    entry.element.remove()
    tiles.delete(entry.album.key)
    spare.set(entry.album.key, entry.element)
    while (spare.size > SPARE_LIMIT) {
      spare.delete(spare.keys().next().value)
    }
  }

  /** 挂上一格：优先复用 spare 里的元素（封面还在，不闪占位图） */
  function mountTile (album, index) {
    const cached = spare.get(album.key)
    let element
    if (cached) {
      spare.delete(album.key)
      element = cached
      element.classList.toggle('is-big', index % 9 === 3)
      element.dataset.index = String(index)
    } else {
      element = createTile(album, index)
    }
    const entry = {
      element,
      album,
      index,
      art: element.querySelector('.wall-tile__art'),
      x: 0,
      y: 0,
      width: 0
    }
    tiles.set(album.key, entry)
    grid.appendChild(element)
    if (index === featuredIndex) {
      element.classList.add('is-featured')
      if (hero.parentNode !== element) element.appendChild(hero)
      syncHeroContent()
    }
    if (entry.art) lazy.observe(entry.art, album.artworkTrack, null)
    placeTile(entry)
    return entry
  }

  /**
   * 把挂载集合收敛到当前窗口。
   *
   * 只在**窗口区间变了**的时候做增删；区间没变就是纯 O(1) 返回。
   * 聚焦块永不卸载：平移时它可能跑到屏幕外，但那样只是被舞台裁掉（不绘制），
   * 换歌回来时不用等重新挂载。
   */
  function syncWindow ({ force = false } = {}) {
    if (!cells.length || !cellRows) {
      if (tiles.size) {
        for (const entry of [...tiles.values()]) unmountTile(entry)
        mountedWindow.ready = false
      }
      slots.length = 0
      return 0
    }
    const range = visibleRange()
    if (!force && !windowDiffers(range)) return 0

    const wanted = new Map()
    for (let row = range.firstRow; row <= range.lastRow; row++) {
      const start = rowStarts[row] || 0
      const end = rowStarts[row + 1] || cells.length
      for (let index = start; index < end; index++) {
        const cell = cells[index]
        if (!cell) continue
        if (cell.col + cell.span - 1 < range.firstCol || cell.col > range.lastCol) continue
        wanted.set(index, albumList[index])
      }
    }
    if (featuredIndex >= 0) wanted.set(featuredIndex, albumList[featuredIndex])

    let changed = 0
    for (const entry of [...tiles.values()]) {
      if (entry.index === featuredIndex) continue
      if (!wanted.has(entry.index)) {
        unmountTile(entry)
        changed++
      }
    }
    for (const [index, album] of wanted) {
      if (!album || tiles.has(album.key)) continue
      mountTile(album, index)
      changed++
    }
    Object.assign(mountedWindow, range, { ready: true })
    placeTiles()
    return changed
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
   * 平移只改每个格子自己的 transform —— 舞台本身是视口大小、永远不动，
   * 所以浏览器每帧只需要合成这几十个小层，不再重新栅格化整面 4382×3325 的平面。
   */
  function writePan () {
    moveTiles()
    paintMinimap()
    syncWindow()
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
    /*
     * 顺序有讲究：先算行列、再刷新几何（视口尺寸是窗口计算的输入），
     * 最后才把挂载集合收敛到新窗口。反过来的话首次构建会拿旧的/零视口去算窗口，
     * 只会挂上一两列。
     */
    slotPitch = Math.max(1, tileSize + GAP)
    computeCells()
    measureGeometry()
    syncWindow({ force: true })
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

  /**
   * Ctrl / ⌘ + 滚轮 = 缩放。
   *
   * 走的是现有密度档位（S / M / L）而不是连续缩放：
   * 每档的列数与瓦片尺寸都由 computeLayout 统一算出来，跨格、裁剪、
   * 平面尺寸、平移边界全都跟着它走 —— 自己另做一套比例缩放会把这些全绕过，
   * 上次在瀑布墙上就吃过「改了尺寸但 slot 缓存没跟着刷」的亏。
   * 滚轮向上放大（更少更大的瓦片），向下缩小；到档位尽头就停住。
   */
  function zoomByWheel (direction) {
    const index = DENSITIES.findIndex((item) => item.id === density)
    if (index < 0) return false
    const next = DENSITIES[Math.min(DENSITIES.length - 1, Math.max(0, index + direction))]
    if (!next || next.id === density) return false
    setDensity(next.id)
    return true
  }

  /*
   * 挂到**捕获阶段**并 stopPropagation：这样按住 Ctrl/⌘ 滚轮时，
   * 下面原有的「滚轮平移」处理器根本收不到这个事件，两者不会同时发生。
   */
  viewport.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    // 触控板的捏合会以 ctrlKey + 很小的 deltaY 出现，用符号判断方向即可
    if (!zoomByWheel(event.deltaY > 0 ? -1 : 1)) return
  }, { passive: false, capture: true })

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
      /*
       * 用独立的 translate/scale 做 FLIP：格子的 transform 是"平面定位"，
       * 直接动画 transform 会把它从平面上抹掉（集体闪到左上角）。
       */
      const animation = node.animate([
        { transformOrigin: '0 0', translate: `${dx}px ${dy}px`, scale: `${scaleX} ${scaleY}` },
        { transformOrigin: '0 0', translate: '0px 0px', scale: '1 1' }
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
    /*
     * 封面观察放在 mountTile 里（挂上才观察、卸下就 forget）：
     * 窗口化之后同一个格子会反复进出 DOM，在这里 observe 会留下
     * 一堆已经脱离文档的观察目标 —— 那正是窗口化要省掉的开销。
     */

    /*
     * 尺寸花样（确定性）：只保留**偶发的 2×2**，不做 2×1 / 1×2 条状。
     * 原因有二：
     *   · 条状看着别扭（用户反馈去掉 1×2）；
     *   · 媒体墙有两条硬不变量 —— 格子是正方形、封面铺满格子（自检里各有一条检查），
     *     条状瓦片会同时破坏它们（2 列宽 1 行高 ≠ 正方形）。
     * 2×2 是 2 列 × 2 行，本身仍是正方形，和「正在播放那张」用的是同一种形状。
     * 每 9 张一轮，第 4 张放大；用索引取模而不是随机，保证同一张专辑形状稳定、自检可复现。
     */
    const shortcutShapes = index % 9 === 3
    const shapeClass = shortcutShapes ? 'is-big' : ''

    const tile = h('div', {
      class: `wall-tile${shapeClass ? ` ${shapeClass}` : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': `${album.name} — ${album.albumArtist}`,
      title: `${album.name} — ${album.albumArtist}`,
      style: { animationDelay: `${Math.min(index, 32) * 10}ms` },
      dataset: { key: album.key, index: String(index) },
      onClick: () => {
        if (tile.classList.contains('is-featured')) {
          actions.openNowPlaying({ lyrics: true })
          return
        }
        const ids = album.tracks.map((track) => track.id)
        /*
         * 位置补偿改成纯数据：点击前的行列由 cells 算出来（不再读 offsetLeft）。
         * 播放后聚焦块会变成 2×2，整墙重排，再把平移反向补偿回去，
         * 用户看到的就是"原地放大"。
         */
        const indexNow = albumList.findIndex((item) => item.key === album.key)
        const before = cellPosition(indexNow)
        player.playCollection(ids, ids[0])
        keepTileInPlace(albumList.findIndex((item) => item.key === album.key), before)
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
      h('div', { class: 'wall-tile__artist truncate', text: `${album.albumArtist} · ${album.trackCount} 首${album.year ? ` · ${album.year}` : ""}` })
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

    return tile
  }

  function rebuild (list, { animateIn, focus = false, preservePan = false }) {
    // 重建会换掉所有格子，但**不该动用户当前的视角**
    const previous = preservePan ? { x: pan.x, y: pan.y } : null

    /*
     * 清空：连 spare 一起清。专辑集合变了，暂存的旧元素可能对应已经不在墙上的专辑，
     * 留着只会在下次挂载时把错误的格子贴回去。
     */
    clear(grid)
    tiles.clear()
    spare.clear()
    /*
     * 先把聚焦块定下来再算行列：computeCells 会把正在播放那张排成 2×2，
     * 反过来的话要"先按没有焦点挂一遍、再重挂一遍"，首帧会白做一次。
     */
    featuredKey = null
    featuredIndex = -1
    mountedWindow.ready = false

    // 只摆当前窗口：applyLayout 会先算 cells，再按几何把 40–80 格挂上来
    featuredKey = currentAlbumKey()
    applyLayout()
    applyFeatured(featuredKey)
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
        if (hero.parentNode === entry.element) hero.remove()
      }
    }
    /*
     * 聚焦块是否成立只看 albumList（数据），不看它此刻有没有被挂载：
     * 平移后它可能在窗口外，但"正在播放的那张"仍然是它 —— 之前用 tiles.get(key)
     * 判断，窗口化时会出现 featuredKey 被置空、回墙找不到焦点的问题。
     */
    featuredKey = key && albumList.some((album) => album.key === key) ? key : null
    // 聚焦块占 2×2，会改变总槽位数 → 行列要重算；窗口强制重挂才能把新焦点摆对
    computeCells()
    syncWindow({ force: true })
    const entry = featuredKey ? tiles.get(featuredKey) : null
    if (entry) {
      entry.element.classList.add('is-featured')
      if (hero.parentNode !== entry.element) entry.element.appendChild(hero)
      syncHeroContent()
    } else if (hero.parentNode) {
      hero.remove()
    }
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
    /*
     * 换了聚焦块之后，把那块**平滑带到视口中央**。
     *
     * 为什么必须做：被点中的瓦片从 1×1（或 2×1 / 1×2）变成 2×2 时，网格会重排，
     * 它的位置可能跑到视口外面 —— 用户看到的就是「点一下歌，墙跳到别处、专辑不见了」
     * （反馈原话：点开会跳到屏幕外面打开）。这里只做一次位移动画，
     * 让放大的那块停在视野里，观感上是「它长大并来到你面前」。
     */
    /*
     * 注意：这里**不能**去 focusFeatured（把视图挪到聚焦块）。
     * 那会让「换歌」也移动整面墙 —— 正是用户早先抱怨的「播放时跳回左上角」。
     * 「点开的专辑要原地打开」由点击路径上的 keepTileInPlace() 负责补偿。
     */
    miniLyrics.reflow()
  }

  /**
   * 聚焦块从 1×1 变成 2×2 时整墙重排，这张瓦片可能挪位置。
   * 这里按「重排前后的平面坐标差」反向补偿平移，让它停在**原来的屏幕位置**上 ——
   * 用户看到的就是「原地放大」，而不是跳到屏幕外（反馈原话）。
   *
   * 位置全部来自 cells 的算术坐标，不再读 offsetLeft：窗口化之后格子是绝对定位 +
   * transform，offsetLeft 恒为 0，读它只会得到"没有位移"的假结论。
   */
  function keepTileInPlace (index, before) {
    const after = cellPosition(index)
    if (!after || !before) return
    const dx = after.x - before.x
    const dy = after.y - before.y
    if (!dx && !dy) return
    const limit = bounds()
    const nextX = clamp(pan.x - dx, limit.minX, limit.maxX)
    const nextY = clamp(pan.y - dy, limit.minY, limit.maxY)
    if (reduceMotion()) {
      cancelAnimation()
      pan.x = nextX
      pan.y = nextY
      target.x = nextX
      target.y = nextY
      writePan()
      return
    }
    animatePanTo(nextX, nextY, 300)
  }

  /**
   * 把正在播放的那张专辑平移到视口中央。
   *
   * 坐标同样来自 cells（平面坐标），不读 DOM —— 聚焦块可能根本不在窗口里
   * （用户把它拖走之后再切回来），那时 tiles 里没有它，但几何数据仍然知道它在哪。
   */
  function focusFeatured ({ animate = true } = {}) {
    if (!featuredKey) return false
    const index = albumList.findIndex((album) => album.key === featuredKey)
    if (index < 0) return false
    const position = cellPosition(index)
    if (!position) return false

    const limit = bounds()
    const nextX = clamp(limit.viewWidth / 2 - position.x - position.size / 2, limit.minX, limit.maxX)
    const nextY = clamp(limit.viewHeight / 2 - position.y - position.size / 2, limit.minY, limit.maxY)

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

  /*
   * 只把**有封面**的专辑放上墙（用户要求：没封面的就别放了）。
   *
   * 「有没有封面」只能异步问出来（要读内嵌图片 / 缓存），所以：
   * 先照常把墙建起来，同时在后台扫一遍；扫完若集合有变就重建一次。
   * 扫描结果按 token 作废，避免期间列表又变了还在用旧结果。
   * 兜底：如果一个都没扫到（例如整个库都没有封面），就退回显示全部 ——
   * 一面空墙看起来更像坏了。
   */
  let artFiltered = null
  let artScanToken = 0

  async function scanArtwork (list) {
    if (!artwork || !list.length) return
    const token = ++artScanToken
    const keys = new Set()
    let failures = 0
    await Promise.all(list.map(async (album) => {
      const track = album.artworkTrack
      if (!track) return
      try {
        if (await artwork.resolveUrl(track)) keys.add(album.key)
      } catch {
        /*
         * 抛异常 ≠ 「这张专辑没有封面」：可能只是磁盘 / IPC 的偶发失败。
         * 之前把它当成「没有封面」，于是扫描一旦大面积失败，整面墙几乎被清空
         * （自检里出现过 plane 高度只剩 6px 的空墙）。现在单独计数：
         * 只要出现过失败就判定本次扫描不可靠 —— 不筛，照常显示全部。
         */
        failures++
      }
    }))
    if (token !== artScanToken) return
    if (failures > 0) {
      artFiltered = null
      refresh()
      return
    }
    artFiltered = keys.size ? keys : null
    refresh()
  }

  function refresh ({ focus = false, focusAnimate = true } = {}) {
    /*
     * 最小化释放期间不要建墙。
     * 释放之后墙是空的，而任何一次 store / 资料库变化都会走到这里 —— 资料库
     * 监听触发的那次 refresh() 会把 474 个格子重新建回来，等于白释放。
     * 窗口还原时由 background-release 显式调一次 refresh()。
     */
    if (typeof isBackgroundReleased === 'function' && isBackgroundReleased()) return

    const state = store.get()
    const all = actions.albums()
    // 有封面扫描结果就只留有封面的；还没扫完先按全部展示，扫完再重建一次
    const filtered = artFiltered ? all.filter((album) => artFiltered.has(album.key)) : all
    /*
     * 按艺人成簇：同一位歌手的专辑挨在一起，墙上就会自然形成一片一片的「艺人区」，
     * 比现在这种「第一首歌在字母序里出现的先后」好认得多。
     *
     * 只在这里排序，**不动 grouping.js** —— 那是专辑页共用的，
     * 改它会连带影响专辑页顺序和好几条媒体墙自检（位置/距离那几项）。
     * 排序键：艺人 → 年份 → 专辑名，同一艺人的专辑按时间先后排。
     * 用 zh-Hans-CN 的 localeCompare，中文歌手名也能按拼音排上。
     */
    const list = [...filtered].sort((a, b) => {
      const byArtist = (a.albumArtist || '').localeCompare(b.albumArtist || '', 'zh-Hans-CN')
      if (byArtist) return byArtist
      const byYear = (a.year || 0) - (b.year || 0)
      if (byYear) return byYear
      return (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN')
    })
    if (!artFiltered) scanArtwork(all)
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

    /* 空状态：0 张专辑时给出解释（搜不到 / 还没加文件夹），否则藏起来 */
    if (!list.length) {
      const state = store.get()
      clear(emptyNode)
      if (!state.library.folders.length) {
        emptyNode.append(
          icon('folder', { className: 'icon icon--stroke empty__icon' }),
          h('div', { class: 'empty__title', text: '还没有音乐文件夹' }),
          h('div', { class: 'empty__text', text: '添加一个包含音乐的文件夹，Aria 会递归扫描并读取歌曲信息（封面、歌词都会一起读取）。' }),
          h('button', { class: 'btn btn--primary', type: 'button', onClick: () => actions.addFolder() }, icon('plus'), '添加音乐文件夹')
        )
      } else {
        emptyNode.append(
          icon('search', { className: 'icon icon--stroke empty__icon' }),
          h('div', { class: 'empty__title', text: '没有匹配的专辑' }),
          h('div', { class: 'empty__text', text: `没有找到与「${state.ui.query}」相关的专辑，换个关键词试试。` })
        )
      }
      emptyNode.classList.remove('hidden')
      grid.style.display = 'none'
    } else {
      emptyNode.classList.add('hidden')
      grid.style.display = ''
    }

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
   * 窗口化之后"墙上的 DOM"本来就只有一屏（约 60 格），但 spare 里还留着
   * 复用的元素、封面观察目标也还挂着，这里一并清掉。
   * albumList 清空 —— 下次 refresh() 会认为「列表变了」而重建。
   */
  function release () {
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
    for (const entry of tiles.values()) {
      if (entry.art) lazy.forget(entry.art)
    }
    if (hero.parentNode) hero.remove()
    clear(grid)
    tiles.clear()
    spare.clear()
    slots.length = 0
    slotRows = 0
    slotColumns = 0
    mountedWindow.ready = false
    lastScan = null
    featuredKey = null
    featuredIndex = -1
    albumList = []
    cells.length = 0
    cellRows = 0
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
    /* 离开视图释放前记下平移位置，回来重建后还原（不保留 DOM） */
    getPan: () => ({ x: pan.x, y: pan.y }),
    /* 自检用：行索引与当前窗口区间（窗口化之后就是"该挂哪些格子"）——每次现算，别返回旧快照 */
    rows: () => {
      const windowRange = rowWindowIndexes(2)
      const rowRange = rowWindow(2)
      return {
        totalRows: cellRows,
        cells: cells.length,
        rowWindow: [rowRange.first, rowRange.last],
        window: [windowRange.start, windowRange.end],
        mounted: tiles.size,
        spare: spare.size
      }
    },
    /* 自检用：算术平面尺寸、舞台盒子（应当等于视口）、以及行列 */
    planeMetrics: () => ({
      ...planeMetrics(),
      stageWidth: grid.clientWidth,
      stageHeight: grid.clientHeight,
      viewWidth: viewport.clientWidth,
      viewHeight: viewport.clientHeight
    }),
    setPan: ({ x = 0, y = 0 } = {}) => {
      target.x = x
      target.y = y
      if (panFrame) {
        cancelAnimationFrame(panFrame)
        panFrame = null
      }
      flushPan(false)
      return { x: pan.x, y: pan.y }
    },
    focusFeatured,
    get density () { return density },
    get layout () { return layout },
    get featuredKey () { return featuredKey },
    get tileCount () { return tiles.size },
    /** 自检用：当前平面与平移状态 */
    debugState: () => {
      syncWindow()
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
        rowCount: cellRows,
        tileSize: Math.round(tileSize),
        layout,
        pan: { x: Math.round(pan.x), y: Math.round(pan.y) },
        /*
         * 舞台是视口大小（窗口化的证据），平面尺寸在 bounds 里。
         * 保留 planeScroll 只为诊断，不再作为"平面与 DOM 一致"的判据。
         */
        planeScroll: { width: grid.scrollWidth, height: grid.scrollHeight },
        // 窗口化后不再有"屏幕外但仍挂载"的格子，culled 恒为 0
        culled: slots.filter((slot) => slot.culled).length,
        mounted: tiles.size,
        spare: spare.size,
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
        featuredSpan: featuredIndex >= 0 && cells[featuredIndex] ? cells[featuredIndex].span : null,
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
    /** 自检用：缓存的坐标与格子实际的 transform 是否还对得上 */
    debugSlotDrift: () => {
      let drift = 0
      let checked = 0
      for (const slot of slots) {
        if (!slot.node.isConnected) continue
        checked++
        const transform = getComputedStyle(slot.node).transform
        let tx = 0
        let ty = 0
        if (transform && transform !== 'none') {
          const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number)
          if (values.length === 16) { tx = values[12]; ty = values[13] } else { tx = values[4]; ty = values[5] }
        }
        const expectX = slot.x + pan.x
        const expectY = slot.y + pan.y
        if (Math.abs(tx - expectX) > 1 || Math.abs(ty - expectY) > 1) drift++
      }
      return { drift, checked, pitch: slotPitch, rows: slotRows, columns: slotColumns }
    },
    /**
     * 自检用：同步落一次平移（含样式写入、窗口增删与指示器更新），用来测「每帧平移的纯开销」。
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
      return { x: pan.x, y: pan.y, culled: 0, mounted: tiles.size }
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
