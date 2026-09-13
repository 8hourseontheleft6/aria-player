/** 媒体墙：满屏封面马赛克，鼠标悬停显示专辑信息，点击即播 */

import { h, on, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { EVENTS } from '../core/bus.js'

const DENSITIES = [
  { id: 's', label: '小', min: 96 },
  { id: 'm', label: '中', min: 148 },
  { id: 'l', label: '大', min: 220 }
]

export function createMediaWall ({ store, bus, player, actions, lazy }) {
  let density = 'm'

  /* ---------------- 工具栏 ---------------- */
  const titleNode = h('div', { class: 'view-toolbar__title', text: '媒体墙' })
  const countNode = h('div', { class: 'view-toolbar__meta' })

  const densitySegmented = h('div', { class: 'segmented' })
  const thumb = h('div', { class: 'segmented__thumb' })
  const densityButtons = DENSITIES.map((item) => h('button', {
    class: `segmented__item${item.id === density ? ' is-selected' : ''}`,
    type: 'button',
    text: item.label,
    dataset: { density: item.id },
    title: `封面尺寸：${item.label}`,
    onClick: () => {
      density = item.id
      for (const button of densityButtons) button.classList.toggle('is-selected', button.dataset.density === density)
      applyDensity()
      paintThumb()
    }
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

  /* ---------------- 大标题 ---------------- */
  const header = h('div', { class: 'view-header' },
    h('div', { class: 'view-header__row' },
      h('div', {},
        h('h1', { class: 'view-header__title', text: '媒体墙' }),
        h('div', { class: 'view-header__subtitle', text: '全部专辑的封面墙，点击任意一张开始播放' })
      )
    )
  )

  /* ---------------- 墙 ---------------- */
  const grid = h('div', { class: 'media-wall' })
  const scroll = h('div', { class: 'media-wall__scroll scroll view-body' }, grid)

  const element = h('div', {
    class: 'content-inner',
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' }
  }, toolbar, header, scroll)

  on(scroll, 'scroll', () => {
    const stuck = scroll.scrollTop > 18
    header.classList.toggle('is-collapsed', stuck)
    toolbar.classList.toggle('is-stuck', stuck)
  }, { passive: true })

  function applyDensity () {
    const preset = DENSITIES.find((item) => item.id === density) || DENSITIES[1]
    grid.style.setProperty('--wall-min', `${preset.min}px`)
  }

  /* ---------------- 渲染 ---------------- */
  let renderedKeys = ''

  function render (albums) {
    const signature = `${albums.length}|${density}`
    if (signature === renderedKeys) return
    renderedKeys = signature

    clear(grid)
    const fragment = document.createDocumentFragment()
    albums.forEach((album, index) => {
      const art = h('div', { class: 'wall-tile__art' })
      lazy.observe(art, album.artworkTrack, 'disc')

      const tile = h('button', {
        class: 'wall-tile',
        type: 'button',
        title: `${album.name} — ${album.albumArtist}`,
        style: { animationDelay: `${Math.min(index, 40) * 12}ms` },
        dataset: { key: album.key },
        onClick: () => {
          const ids = album.tracks.map((track) => track.id)
          player.playCollection(ids, ids[0])
        },
        onDblclick: () => actions.openAlbum(album.key),
        onContextmenu: (event) => {
          event.preventDefault()
          actions.openTrackMenu(album.tracks[0], event)
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

      fragment.appendChild(tile)
    })
    grid.appendChild(fragment)
  }

  store.subscribe((state, prev) => {
    if (state.ui === prev.ui && state.library === prev.library) return
    if (state.ui.view !== 'wall') return
    refresh()
  })

  function refresh () {
    const state = store.get()
    const albums = actions.albums()
    render(albums)
    countNode.textContent = `${albums.length} 张专辑 · ${state.library.tracks.length} 首`
    densitySegmented.style.display = albums.length ? '' : 'none'
    requestAnimationFrame(paintThumb)
  }

  bus.on(EVENTS.LIBRARY_UPDATED, refresh)
  applyDensity()

  return { element, refresh, get density () { return density } }
}
