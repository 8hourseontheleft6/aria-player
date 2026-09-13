/**
 * 媒体墙：满屏封面马赛克。
 *
 * 两个关键交互：
 *  1) 正在播放的专辑会「放大聚焦」成一个跨 2×2 的大格子，内含当前曲目、
 *     同步滚动的迷你歌词、传输控件与进度条，并自动排到最前面（order:-1）
 *  2) 小/中/大 切换与聚焦块换位都走 FLIP：先量旧位置 → 改 DOM → 量新位置 →
 *     用 transform 反向补偿再动画归零，因此整墙是平滑推移而不是硬跳
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

const FLIP_DURATION = 460
const FLIP_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)'

export function createMediaWall ({ store, bus, player, actions, lazy }) {
  let density = 'm'
  /** @type {Array<object>} */
  let albumList = []
  /** @type {Map<string, {element: HTMLElement, album: object}>} */
  const tiles = new Map()
  let featuredKey = null
  let enteringTimer = null

  /* ---------------- 工具栏 ---------------- */
  const titleNode = h('div', { class: 'view-toolbar__title', text: '媒体墙' })
  const countNode = h('div', { class: 'view-toolbar__meta' })

  const densitySegmented = h('div', { class: 'segmented segmented--icons' })
  const thumb = h('div', { class: 'segmented__thumb' })
  const densityButtons = DENSITIES.map((item) => h('button', {
    class: `segmented__item${item.id === density ? ' is-selected' : ''}`,
    type: 'button',
    text: item.label,
    dataset: { density: item.id },
    title: `封面尺寸：${item.label}`,
    onClick: () => setDensity(item.id)
  }))
  densitySegmented.append(thumb, ...densityButtons)

  function paintThumb () {
    const active = densityButtons.find((button) => button.classList.contains('is-selected'))
    if (!active || !active.offsetWidth) {
      requestAnimationFrame(paintThumb)
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
    densitySegmented,
    shuffleButton,
    playAllButton
  )

  const header = h('div', { class: 'view-header' },
    h('div', { class: 'view-header__row' },
      h('div', {},
        h('h1', { class: 'view-header__title', text: '媒体墙' }),
        h('div', { class: 'view-header__subtitle', text: '封面墙：点击任意专辑即播放，正在播放的那张会放大聚焦' })
      )
    )
  )

  /* ---------------- 聚焦块（唯一实例，移动到当前专辑的格子里） ---------------- */
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
  // 聚焦块里的点击不应触发格子的「播放整张专辑」
  on(hero, 'click', (event) => event.stopPropagation())
  on(hero, 'dblclick', (event) => event.stopPropagation())

  /* ---------------- 墙 ---------------- */
  const grid = h('div', { class: 'media-wall' })
  const scroll = h('div', { class: 'media-wall__scroll scroll view-body' }, grid)

  const element = h('div', { class: 'content-inner view-root' }, toolbar, header, scroll)

  on(scroll, 'scroll', () => {
    const stuck = scroll.scrollTop > 18
    header.classList.toggle('is-collapsed', stuck)
    toolbar.classList.toggle('is-stuck', stuck)
  }, { passive: true })

  /* ---------------- FLIP ---------------- */

  function reduceMotion () {
    return store.get().settings.reduceMotion === true ||
      document.documentElement.dataset.reduceMotion === 'true'
  }

  /** 只关心视口附近（含预读区）的格子，远端的格子不做动画 */
  function measure (limit) {
    const map = new Map()
    const viewportBottom = window.innerHeight + 500
    let index = 0
    for (const child of grid.children) {
      const rect = child.getBoundingClientRect()
      const near = rect.bottom > -200 && rect.top < viewportBottom
      map.set(child, {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        near
      })
      if (near) index++
      if (index > 240) break // 防御：极端情况下不无止境地量下去
      void limit
    }
    return map
  }

  /**
   * 让所有正在跑的动画立刻落到终态。
   * getBoundingClientRect 会把 transform 算进去，所以量尺寸之前必须先收敛，
   * 否则连续切换密度时前后两次测量会互相污染。
   */
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

  /* ---------------- 密度 ---------------- */

  function preset () {
    return DENSITIES.find((item) => item.id === density) || DENSITIES[1]
  }

  function setDensity (next) {
    if (next === density) return
    density = next
    for (const button of densityButtons) {
      button.classList.toggle('is-selected', button.dataset.density === density)
    }
    paintThumb()
    flip(() => grid.style.setProperty('--wall-min', `${preset().min}px`))
  }

  /* ---------------- 格子 ---------------- */

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

    if (animateIn && !reduceMotion()) {
      grid.classList.add('is-entering')
      if (enteringTimer) clearTimeout(enteringTimer)
      enteringTimer = setTimeout(() => grid.classList.remove('is-entering'), 900)
    }
    // 新建的格子需要重新按当前播放状态定位聚焦块
    featuredKey = null
    syncFeatured({ animate: false })
  }

  /* ---------------- 聚焦块同步 ---------------- */

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

  /* ---------------- 渲染 ---------------- */

  function refresh () {
    const state = store.get()
    const list = actions.albums()
    const rebuilt = list !== albumList
    albumList = list

    if (rebuilt) {
      // 重建时不做 FLIP：新格子直接播放入场动画，聚焦块同步但不做位移过渡
      rebuild(list, { animateIn: true })
      grid.style.setProperty('--wall-min', `${preset().min}px`)
    } else {
      // 一次 mutate 里同时处理密度与聚焦块，保证只有一次测量与一次动画
      const key = currentAlbumKey()
      flip(() => {
        grid.style.setProperty('--wall-min', `${preset().min}px`)
        if (key !== featuredKey) applyFeatured(key)
      })
      if (key === featuredKey && key) syncHeroContent()
    }

    countNode.textContent = `${list.length} 张专辑 · ${state.library.tracks.length} 首`
    densitySegmented.style.display = list.length ? '' : 'none'
    requestAnimationFrame(paintThumb)
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

  // 视图切回媒体墙时，重新量一次（隐藏期间尺寸为 0，FLIP 会算错）
  store.select((state) => state.ui.view, (view, previous) => {
    if (view === 'wall' && previous !== undefined) {
      requestAnimationFrame(() => {
        refresh()
        miniLyrics.reflow()
      })
    }
  })

  grid.style.setProperty('--wall-min', `${preset().min}px`)

  return {
    element,
    refresh,
    get density () { return density },
    get featuredKey () { return featuredKey },
    get tileCount () { return tiles.size }
  }
}
