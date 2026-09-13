/**
 * 歌曲列表（虚拟滚动）。
 * 只渲染可视区的行，几万首也不卡；行高固定，用绝对定位 + 容器高度撑开滚动条。
 */

import { h, on, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { formatDuration } from '../core/format.js'
import { EVENTS } from '../core/bus.js'

const ROW_HEIGHT = 54
const OVERSCAN = 6

const SORT_COLUMNS = [
  { key: 'title', label: '标题' },
  { key: 'album', label: '专辑' },
  { key: 'duration', label: '时长' }
]

export function createTrackList ({ store, bus, player, artwork, actions }) {
  const canvas = h('div', { class: 'tracklist__canvas' })
  const viewport = h('div', { class: 'tracklist__viewport scroll', tabindex: '0' }, canvas)

  /* ---------------- 表头 ---------------- */
  const headIndex = h('span', { text: '#' })
  const headCells = SORT_COLUMNS.map((column) => {
    const arrow = icon('chevronDown', { className: 'icon icon--stroke' })
    const node = h('button', {
      class: 'tracklist__sort',
      type: 'button',
      dataset: { key: column.key },
      onClick: () => actions.setSort(column.key)
    }, h('span', { text: column.label }), arrow)
    return node
  })

  const head = h('div', { class: 'tracklist__head' },
    headIndex,
    headCells[0],
    headCells[1],
    headCells[2]
  )

  const element = h('div', { class: 'tracklist' }, head, viewport)

  /* ---------------- 状态 ---------------- */
  /** @type {Array<object>} */
  let tracks = []
  /** @type {Map<number, HTMLElement>} */
  const rendered = new Map()
  let selectedId = null
  let scheduled = false

  function schedule () {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      renderWindow()
    })
  }

  /* ---------------- 行 ---------------- */
  function createRow (index, track) {
    const row = h('div', {
      class: 'track-row',
      dataset: { id: track.id, index: String(index) },
      style: { top: `${index * ROW_HEIGHT}px` }
    })

    const indexCell = h('div', { class: 'track-row__index' })
    const artCell = h('div', { class: 'track-row__art' }, icon('music'))
    const titleNode = h('div', { class: 'track-row__title' })
    const artistNode = h('div', { class: 'track-row__artist truncate', text: track.artist })

    const main = h('div', { class: 'track-row__main' },
      artCell,
      h('div', { class: 'track-row__text' }, titleNode, artistNode)
    )

    const right = h('div', { class: 'track-row__right' },
      h('span', { class: 'track-row__duration tabular', text: formatDuration(track.duration) }),
      h('button', {
        class: 'track-row__more',
        type: 'button',
        title: '更多操作',
        onClick: (event) => {
          event.stopPropagation()
          actions.openTrackMenu(track, event)
        }
      }, icon('ellipsis'))
    )

    row.append(indexCell, main, h('div', { class: 'track-row__album truncate', text: track.album }), right)
    paintRow(row, track, index)

    on(row, 'click', () => {
      selectedId = track.id
      refreshSelection()
    })
    on(row, 'dblclick', () => actions.playTrack(track))
    on(row, 'contextmenu', (event) => {
      event.preventDefault()
      selectedId = track.id
      refreshSelection()
      actions.openTrackMenu(track, event)
    })

    return row
  }

  function paintRow (row, track, index) {
    const state = store.get()
    const isCurrent = state.playback.trackId === track.id
    row.classList.toggle('is-current', isCurrent)
    row.classList.toggle('is-selected', selectedId === track.id)

    const indexCell = row.children[0]
    clear(indexCell)

    if (isCurrent) {
      const playing = state.playback.status === 'playing' || state.playback.status === 'loading'
      const bars = h('div', { class: `bars${playing ? '' : ' is-paused'}` },
        h('span'), h('span'), h('span'))
      const playButton = h('button', {
        class: 'track-row__play is-playing',
        type: 'button',
        title: '暂停',
        onClick: (event) => {
          event.stopPropagation()
          actions.togglePlay()
        }
      }, icon(playing ? 'pause' : 'play'))
      indexCell.append(bars, playButton)
    } else {
      indexCell.append(
        h('span', { class: 'track-row__num', text: String(index + 1) }),
        h('button', {
          class: 'track-row__play',
          type: 'button',
          title: '播放',
          onClick: (event) => {
            event.stopPropagation()
            actions.playTrack(track)
          }
        }, icon('play'))
      )
    }

    // 标题 + 歌词标记
    const titleNode = row.querySelector('.track-row__title')
    clear(titleNode)
    titleNode.append(h('span', { class: 'truncate', text: track.title }))
    if (track.lyricsPath) {
      titleNode.append(h('span', { class: 'track-row__badge', title: '有歌词' },
        icon('lyrics', { className: 'icon icon--stroke' }), '词'))
    }

    loadArtwork(row.querySelector('.track-row__art'), track)
  }

  const artworkRequests = new WeakMap()

  async function loadArtwork (node, track) {
    if (!store.get().settings.showRowArtwork) return
    if (node.querySelector('img')) return
    // 同一行的并发请求只保留最后一次（快速滚动时行会被复用）
    artworkRequests.set(node, track.id)
    const url = await artwork.resolveUrl(track)
    if (artworkRequests.get(node) !== track.id) return
    if (!url || node.querySelector('img')) return
    const image = h('img', { src: url, alt: '', decoding: 'async' })
    clear(node)
    node.appendChild(image)
  }

  /* ---------------- 虚拟滚动 ---------------- */
  function renderWindow () {
    if (!tracks.length) {
      clear(canvas)
      rendered.clear()
      return
    }
    const scrollTop = viewport.scrollTop
    const height = viewport.clientHeight || 600
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    const end = Math.min(tracks.length - 1, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN)

    for (const [index, node] of rendered) {
      if (index < start || index > end) {
        node.remove()
        rendered.delete(index)
      }
    }

    for (let index = start; index <= end; index++) {
      const track = tracks[index]
      if (!track) continue
      const existing = rendered.get(index)
      if (existing && existing.dataset.id === track.id) continue
      if (existing) {
        existing.remove()
        rendered.delete(index)
      }
      const row = createRow(index, track)
      canvas.appendChild(row)
      rendered.set(index, row)
    }
  }

  function refreshSelection () {
    for (const node of rendered.values()) {
      node.classList.toggle('is-selected', node.dataset.id === selectedId)
    }
  }

  function refreshCurrent () {
    for (const [index, node] of rendered) {
      const track = tracks[index]
      if (track) paintRow(node, track, index)
    }
  }

  /* ---------------- 对外 API ---------------- */
  function setTracks (list) {
    tracks = Array.isArray(list) ? list : []
    canvas.style.height = `${tracks.length * ROW_HEIGHT}px`
    // 保留了行元素但索引含义变了，直接全部重建更安全
    for (const node of rendered.values()) node.remove()
    rendered.clear()
    schedule()
  }

  function scrollToIndex (index, { center = true } = {}) {
    const target = Math.max(0, Math.min(index, tracks.length - 1))
    if (center) viewport.scrollTop = target * ROW_HEIGHT - viewport.clientHeight / 2 + ROW_HEIGHT / 2
    else viewport.scrollTop = target * ROW_HEIGHT
    schedule()
  }

  function scrollToTrack (id) {
    const index = tracks.findIndex((track) => track.id === id)
    if (index >= 0) scrollToIndex(index)
  }

  /* ---------------- 事件 ---------------- */
  on(viewport, 'scroll', schedule, { passive: true })
  on(viewport, 'keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const currentIndex = tracks.findIndex((track) => track.id === selectedId)
      const nextIndex = Math.max(0, Math.min(tracks.length - 1, (currentIndex < 0 ? -1 : currentIndex) + (event.key === 'ArrowDown' ? 1 : -1)))
      const track = tracks[nextIndex]
      if (!track) return
      selectedId = track.id
      scrollToIndex(nextIndex, { center: false })
      refreshSelection()
    } else if (event.key === 'Enter') {
      const track = tracks.find((item) => item.id === selectedId)
      if (track) actions.playTrack(track)
    }
  })

  const resizeObserver = new ResizeObserver(schedule)
  resizeObserver.observe(viewport)

  function paintSortHeaders () {
    const sort = store.get().ui.sort
    for (const cell of headCells) {
      const active = cell.dataset.key === sort.key
      cell.classList.toggle('is-active', active)
      const arrow = cell.querySelector('.icon')
      if (arrow) arrow.style.transform = active && sort.direction === 'desc' ? 'rotate(180deg)' : ''
    }
  }

  bus.on(EVENTS.TRACK_CHANGED, () => schedule())
  store.select((state) => `${state.playback.trackId}|${state.playback.status}|${state.settings.showRowArtwork}`,
    () => schedule())
  store.select((state) => state.ui.sort, paintSortHeaders)
  paintSortHeaders()

  return {
    element,
    viewport,
    setTracks,
    scrollToTrack,
    scrollToIndex,
    refreshCurrent,
    schedule,
    get tracks () { return tracks }
  }
}
