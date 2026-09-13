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

import { h, on, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { EVENTS } from '../core/bus.js'
import { albumKeyOf } from '../core/grouping.js'
import { createMiniLyrics } from './mini-lyrics.js'

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

export function createMediaWall ({ store, bus, player, actions, lazy }) {
  let density = 'm'
  let layout = 'canvas'  /** @type {Array<object>} */
  let albumList = []
  /** @type {Map<string, {element: HTMLElement, album: object}>} */
  const tiles = new Map()
  let featuredKey = null
  let enteringTimer = null
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

  const toolbar = h('div', { class: 'view-toolbar' },
    titleNode,
    h('div', { class: 'view-toolbar__spacer' }),
    countNode,
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

  const pan = { x: 0, y: 0 }
  const velocity = { x: 0, y: 0 }
  let dragging = false
  let inertiaFrame = null
  let suppressClick = false
  let lastPointer = { x: 0, y: 0, time: 0 }

  function reduceMotion () {
    return store.get().settings.reduceMotion === true ||
      document.documentElement.dataset.reduceMotion === 'true'
  }

  function planeSize () {
    return { width: grid.offsetWidth, height: grid.offsetHeight }
  }

  function bounds () {
    const { width, height } = planeSize()
    const viewWidth = viewport.clientWidth
    const viewHeight = viewport.clientHeight
    return {
      minX: Math.min(0, viewWidth - width),
      maxX: 0,
      minY: Math.min(0, viewHeight - height),
      maxY: 0,
      width,
      height,
      viewWidth,
      viewHeight
    }
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  /** 越界时按比例阻尼，做出「拉得动但拉不远」的手感 */
  function rubber (value, min, max, factor = ELASTIC) {
    if (value > max) return max + (value - max) * factor
    if (value < min) return min + (value - min) * factor
    return value
  }

  function applyPan (x, y, { elastic = false } = {}) {
    const limit = bounds()
    pan.x = elastic ? rubber(x, limit.minX, limit.maxX) : clamp(x, limit.minX, limit.maxX)
    pan.y = elastic ? rubber(y, limit.minY, limit.maxY) : clamp(y, limit.minY, limit.maxY)
    grid.style.transform = `translate3d(${pan.x}px, ${pan.y}px, 0)`
    paintMinimap(limit)
  }

  /** 只取消正在跑的惯性帧，不动速度（惯性启动时要先取消旧帧再读速度） */
  function cancelInertiaFrame () {
    if (inertiaFrame) {
      cancelAnimationFrame(inertiaFrame)
      inertiaFrame = null
    }
  }

  function stopInertia () {
    cancelInertiaFrame()
    velocity.x = 0
    velocity.y = 0
  }

  /** 松手后的惯性滑行：撞到边界就停，不留回弹 */
  function startInertia () {
    cancelInertiaFrame()
    let vx = velocity.x
    let vy = velocity.y
    velocity.x = 0
    velocity.y = 0
    if (reduceMotion() || (Math.abs(vx) < 0.4 && Math.abs(vy) < 0.4)) {
      applyPan(pan.x, pan.y)
      return
    }
    const step = () => {
      vx *= INERTIA_DECAY
      vy *= INERTIA_DECAY
      const limit = bounds()
      const nextX = clamp(pan.x + vx, limit.minX, limit.maxX)
      const nextY = clamp(pan.y + vy, limit.minY, limit.maxY)
      if (nextX === limit.minX || nextX === limit.maxX) vx = 0
      if (nextY === limit.minY || nextY === limit.maxY) vy = 0
      applyPan(nextX, nextY)
      if (Math.abs(vx) < INERTIA_MIN && Math.abs(vy) < INERTIA_MIN) {
        inertiaFrame = null
        return
      }
      inertiaFrame = requestAnimationFrame(step)
    }
    inertiaFrame = requestAnimationFrame(step)
  }

  /* ---------------- 位置指示器 ---------------- */

  function paintMinimap (limit = bounds()) {
    const pannable = limit.minX < -1 || limit.minY < -1
    minimap.hidden = !pannable
    if (!pannable) return

    const maxWidth = 108
    const maxHeight = 74
    const scale = Math.min(maxWidth / limit.width, maxHeight / limit.height)
    const mapWidth = Math.max(30, Math.round(limit.width * scale))
    const mapHeight = Math.max(24, Math.round(limit.height * scale))
    minimap.style.width = `${mapWidth}px`
    minimap.style.height = `${mapHeight}px`

    const boxWidth = clamp(Math.round(limit.viewWidth * scale), 12, mapWidth)
    const boxHeight = clamp(Math.round(limit.viewHeight * scale), 12, mapHeight)
    const boxX = clamp(Math.round(-pan.x * scale), 0, mapWidth - boxWidth)
    const boxY = clamp(Math.round(-pan.y * scale), 0, mapHeight - boxHeight)

    minimap.dataset.scale = String(scale)
    minimapViewport.style.width = `${boxWidth}px`
    minimapViewport.style.height = `${boxHeight}px`
    minimapViewport.style.transform = `translate3d(${boxX}px, ${boxY}px, 0)`
  }

  /** 点/拖指示器：把视口中心移到对应位置 */
  function panFromMinimap (event) {
    const rect = minimap.getBoundingClientRect()
    const scale = Number(minimap.dataset.scale) || 1
    const localX = clamp(event.clientX - rect.left, 0, rect.width)
    const localY = clamp(event.clientY - rect.top, 0, rect.height)
    const limit = bounds()
    const targetX = -(localX / scale) + limit.viewWidth / 2
    const targetY = -(localY / scale) + limit.viewHeight / 2
    stopInertia()
    applyPan(targetX, targetY)
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
    applyPan(pan.x + dx, pan.y + dy, { elastic: true })
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
    const limit = bounds()
    // 越界（橡皮筋状态）先回弹，否则进入惯性滑行
    if (pan.x > limit.maxX || pan.x < limit.minX || pan.y > limit.maxY || pan.y < limit.minY) {
      stopInertia()
      applyPan(pan.x, pan.y)
    } else {
      startInertia()
    }
    // 防御：万一拖完没有 click 事件（例如在窗口外松开），别把下一次点击也吞掉
    if (suppressClick) setTimeout(() => { suppressClick = false }, 350)
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
    applyPan(pan.x - event.deltaX, pan.y - event.deltaY)
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
    applyPan(pan.x, pan.y)
  }

  function setLayout (next) {
    if (next === layout) return
    layout = next
    for (const button of layoutButtons) {
      button.classList.toggle('is-selected', button.dataset.layout === layout)
    }
    paintSegmentedThumb(layoutSegmented, layoutThumb)
    actions.setSetting({ wallLayout: layout })
    flip(() => {
      applyLayout()
      stopInertia()
      applyPan(0, 0)
    })
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
    const viewportBottom = window.innerHeight + 500
    let near = 0
    for (const child of grid.children) {
      const rect = child.getBoundingClientRect()
      const visible = rect.bottom > -200 && rect.top < viewportBottom
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
    lazy.observe(art, album.artworkTrack, 'disc')

    const tile = h('div', {
      class: 'wall-tile',
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

  function rebuild (list, { animateIn }) {
    clear(grid)
    tiles.clear()
    const fragment = document.createDocumentFragment()
    list.forEach((album, index) => fragment.appendChild(createTile(album, index)))
    grid.appendChild(fragment)

    applyLayout()
    featuredKey = null
    applyFeatured(currentAlbumKey())
    applyPan(0, 0)

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

  /* ================================================================ */
  /* 渲染                                                              */
  /* ================================================================ */

  function refresh () {
    const state = store.get()
    const list = actions.albums()
    const rebuilt = list !== albumList
    albumList = list

    if (rebuilt) {
      rebuild(list, { animateIn: true })
    } else {
      const key = currentAlbumKey()
      flip(() => {
        applyLayout()
        if (key !== featuredKey) applyFeatured(key)
      })
      if (key === featuredKey && key) syncHeroContent()
      applyPan(pan.x, pan.y)
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

  /* ---------------- 事件 ---------------- */

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
        refresh()
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
    applyPan(0, 0)
  })

  const resizeObserver = new ResizeObserver(() => {
    if (store.get().ui.view !== 'wall') return
    const before = columns
    applyLayout()
    if (columns !== before) applyPan(pan.x, pan.y)
    else applyPan(pan.x, pan.y)
  })
  resizeObserver.observe(viewport)

  return {
    element,
    refresh,
    get density () { return density },
    get layout () { return layout },
    get featuredKey () { return featuredKey },
    get tileCount () { return tiles.size },
    /** 自检用：当前平面与平移状态 */
    debugState: () => {
      const limit = bounds()
      return {
        columns,
        tileSize: Math.round(tileSize),
        layout,
        pan: { x: Math.round(pan.x), y: Math.round(pan.y) },
        bounds: limit,
        horizontal: limit.minX < -1,
        vertical: limit.minY < -1,
        dragging,
        pannable: limit.minX < -1 || limit.minY < -1
      }
    }
  }
}
