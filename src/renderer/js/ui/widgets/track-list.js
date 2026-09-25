/**
 * 歌曲列表（虚拟滚动）。
 * 只渲染可视区的行，几万首也不卡；行高固定，用绝对定位 + 容器高度撑开滚动条。
 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { formatDuration } from '../../core/format.js'
import { highlightParts } from '../../core/selectors.js'
import { openPlaylistPicker } from '../menus/playlist-picker.js'
import { EVENTS } from '../../core/bus.js'

const ROW_HEIGHT = 54
const OVERSCAN = 6

const SORT_COLUMNS = [
  { key: 'title', label: '标题' },
  { key: 'album', label: '专辑' },
  { key: 'duration', label: '时长' }
]

export function createTrackList ({ store, bus, player, artwork, actions, matchFor = null, playlistId = null }) {  const canvas = h('div', { class: 'tracklist__canvas' })
  const viewport = h('div', { class: 'tracklist__viewport scroll', tabindex: '0' }, canvas)

  /* ---------------- 表头 ---------------- */
  const checkIcon = (className) => icon('checkmark', { className: 'icon icon--stroke' })

  // 表头上那颗 = 全选 / 取消全选；部分选中时显示成短横
  const headCheck = h('button', {
    class: 'tracklist__check',
    type: 'button',
    title: '全选 / 取消全选 (Ctrl+A)',
    onClick: () => {
      const selected = new Set(store.get().ui.selection)
      const all = tracks.length > 0 && tracks.every((track) => selected.has(track.id))
      if (!all && !store.get().ui.selecting) actions.startSelection()
      actions.setSelection(all ? [] : tracks.map((track) => track.id))
    }
  }, checkIcon())

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
    headCheck,
    headIndex,
    headCells[0],
    headCells[1],
    headCells[2]
  )

  /* ---------------- 多选工具条 ---------------- */
  const selectionCount = h('span', { class: 'tracklist__selection-count' })

  /** 当前列表里被选中的曲目 id（顺序按列表顺序）—— 批量动作只认这一份 */
  function selectedIdsInList () {
    const selected = new Set(store.get().ui.selection || [])
    return tracks.filter((track) => selected.has(track.id)).map((track) => track.id)
  }

  /** 正在看的是不是某个自建播放列表（决定面板里有没有「从列表中移除」） */
  function currentPlaylistId () {
    return typeof playlistId === 'function' ? playlistId() : playlistId
  }

  const selectAllButton = h('button', {
    class: 'btn btn--sm',
    type: 'button',
    text: '全选',
    title: '选中当前列表里的全部歌曲 (Ctrl+A)',
    onClick: () => {
      const selected = new Set(store.get().ui.selection)
      const all = tracks.length > 0 && tracks.every((track) => selected.has(track.id))
      actions.setSelection(all ? [] : tracks.map((track) => track.id))
    }
  })
  const selectionBar = h('div', { class: 'tracklist__selection', hidden: true },
    h('div', { class: 'tracklist__selection-info' },
      icon('checkmark', { className: 'icon icon--stroke' }),
      selectionCount),
    h('div', { class: 'tracklist__selection-actions' },
      h('button', {
        class: 'btn btn--sm btn--primary',
        type: 'button',
        text: '添加到播放列表…',
        onClick: (event) => openPlaylistPicker({
          anchor: event.currentTarget,
          actions,
          bus,
          // 只加「这个列表里被选中的那些」：多选可能跨视图残留（虽然切视图会清，
          // 但按列表取一次更稳，加进去的数量和工具条上显示的永远一致）
          trackIds: selectedIdsInList(),
          playlistId: currentPlaylistId(),
          onDone: () => actions.clearSelection()
        })
      }),
      h('button', {
        class: 'btn btn--sm',
        type: 'button',
        text: '下一首播放',
        title: '插到当前播放的下一首',
        onClick: () => actions.queueSelection('next', tracks)
      }),
      h('button', {
        class: 'btn btn--sm',
        type: 'button',
        text: '加入队列',
        title: '追加到播放队列末尾',
        onClick: () => actions.queueSelection('end', tracks)
      }),
      selectAllButton,
      h('button', {
        class: 'btn btn--sm',
        type: 'button',
        text: '结束多选',
        title: '退出多选模式 (Esc)',
        onClick: () => actions.clearSelection()
      }))
  )

  const element = h('div', { class: 'tracklist' }, head, selectionBar, viewport)

  /* ---------------- 状态 ---------------- */
  /** @type {Array<object>} */
  let tracks = []
  /** @type {Map<number, HTMLElement>} */
  const rendered = new Map()
  /** 选中集合（每帧只从 store 同步一次，避免每行都去查数组） */
  let selection = new Set()
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

    /*
     * 勾选框：只在多选模式里出现（见 library.css 的说明）。
     * 它不是入口 —— 入口在列表右上角的「⋯」和歌曲右键菜单里。
     */
    const check = h('button', {
      class: 'track-row__check',
      type: 'button',
      role: 'checkbox',
      title: '选中这一首',
      'aria-checked': 'false',
      tabindex: '-1',
      onClick: (event) => {
        event.stopPropagation()
        if (!store.get().ui.selecting) return
        actions.toggleSelection(track.id)
      }
    }, checkIcon())
    row.__check = check

    const indexCell = h('div', { class: 'track-row__index' })
    row.__index = indexCell
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
          actions.openTrackMenu(track, event, { list: tracks })
        }
      }, icon('ellipsis'))
    )

    row.append(check, indexCell, main, h('div', { class: 'track-row__album truncate' },
      h('span', { class: 'track-row__album-text truncate' }),
      // 悬停时才出现的「为什么搜到它」：默认 display:none，
      // 与专辑名共用同一个格子，所以显示出来不会让行高/列宽发生变化
      h('span', { class: 'track-row__match truncate' })
    ), right)
    paintRow(row, track, index)

    /*
     * 点击语义（和桌面上的文件列表一致）：
     *   · Ctrl / Cmd 点击：加进选择或去掉，不播放（这就算开始多选了）；
     *   · Shift 点击：从锚点到这一首整段选中，不播放；
     *   · 开了「单击歌曲直接播放」时：点行就播（这个设置是用户明确要求的，
     *     不能被多选模式悄悄顶掉），多选走勾选框 / Ctrl / Shift；
     *   · 已经在多选模式里：点行 = 勾选 / 取消勾选这一首
     *     （勾选框都露出来了，这时候「点一下把其它选择全清掉」才奇怪）；
     *   · 其余情况：点行只选中这一首，**不会**进入多选模式 ——
     *     多选要显式开始（右键菜单「开始多选」或点勾选框）。
     * 勾选框自己有 stopPropagation，不会走到这里。
     */
    on(row, 'click', (event) => {
      if (event.shiftKey) {
        selectRangeTo(index)
        return
      }
      if (event.ctrlKey || event.metaKey) {
        actions.toggleSelection(track.id)
        return
      }
      const playing = store.get().settings.playOnSingleClick === true
      if (playing) {
        actions.setSelection([track.id], track.id)
        // 行内已有自己的行为的小按钮不要连带触发（它们多数已经 stopPropagation，这里再兜一层）
        if (event.target?.closest?.('.track-row__more, .track-row__play')) return
        actions.playTrack(track, tracks)
        return
      }
      if (store.get().ui.selecting) {
        actions.toggleSelection(track.id)
        return
      }
      actions.setSelection([track.id], track.id)
    })
    on(row, 'dblclick', () => actions.playTrack(track, tracks))
    on(row, 'contextmenu', (event) => {
      event.preventDefault()
      // 右键点在「已选中的一批」里 → 菜单作用于整批；否则右键就是「只选这一首」
      const current = store.get().ui.selection
      if (!current.includes(track.id)) actions.setSelection([track.id], track.id)
      actions.openTrackMenu(track, event, { list: tracks })
    })

    return row
  }

  /** Shift 点选：从锚点到目标这一段的 id */
  function selectRangeTo (index) {
    const anchorId = store.get().ui.selectionAnchor
    const anchorIndex = anchorId ? tracks.findIndex((item) => item.id === anchorId) : -1
    const from = anchorIndex < 0 ? index : anchorIndex
    const [start, end] = from <= index ? [from, index] : [index, from]
    const ids = tracks.slice(start, end + 1).map((track) => track.id)
    // 锚点保持不变，这样连续 Shift 点选是「以锚点为中心」伸缩，而不是逐段累加
    actions.setSelection(ids, anchorId || tracks[index].id)
  }

  function paintRow (row, track, index) {
    const state = store.get()
    const isCurrent = state.playback.trackId === track.id
    const checked = selection.has(track.id)
    row.classList.toggle('is-current', isCurrent)
    row.classList.toggle('is-selected', checked)
    if (row.__check) {
      row.__check.classList.toggle('is-checked', checked)
      row.__check.setAttribute('aria-checked', checked ? 'true' : 'false')
    }

    /*
     * 用存下来的引用，不要用 row.children[0]。
     * 左边加了勾选框那一列之后，children[0] 就是勾选框了 —— 曾经因此把序号和播放键
     * 画进了勾选框里，序号那一列反而空着（用户反馈「序号又没了」）。
     */
    const indexCell = row.__index
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
            actions.playTrack(track, tracks)
          }
        }, icon('play'))
      )
    }

    // 标题 + 歌词标记
    const titleNode = row.querySelector('.track-row__title')
    clear(titleNode)
    // 搜索命中歌名时把命中片段标出来（样式上只在悬停时才真正高亮）
    const match = matchFor ? matchFor(track) : null
    const parts = match ? match.parts : []
    const titleText = h('span', { class: 'truncate' })
    for (const piece of highlightParts(track.title, parts)) {
      titleText.append(piece.hit
        ? h('span', { class: 'hl', text: piece.text })
        : h('span', { text: piece.text }))
    }
    titleNode.append(titleText)
    if (track.lyricsPath) {
      titleNode.append(h('span', { class: 'track-row__badge', title: '有歌词' },
        icon('lyrics', { className: 'icon icon--stroke' }), '词'))
    }

    // 专辑名 + 悬停显示的匹配详情
    const albumText = row.querySelector('.track-row__album-text')
    if (albumText) albumText.textContent = track.album
    const matchNode = row.querySelector('.track-row__match')
    if (matchNode) {
      clear(matchNode)
      if (match && match.label) {
        matchNode.dataset.kind = match.kind
        matchNode.title = `${match.label}：${match.text || track.title}`
        matchNode.append(h('span', { class: 'track-row__match-label', text: match.label }))
        const text = match.kind === 'title' ? track.title : match.text
        for (const piece of highlightParts(text, parts)) {
          matchNode.append(piece.hit
            ? h('span', { class: 'hl', text: piece.text })
            : h('span', { text: piece.text }))
        }
      }
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

  /** 把 store 里的选择同步到已渲染的行 + 工具条 + 表头的全选框 */
  function syncSelection () {
    const state = store.get()
    const selected = state.ui.selection || []
    selection = new Set(selected)
    // 「多选模式」是显式进入的：只有它打开时，所有行的勾选框才一起露出来
    element.classList.toggle('is-selecting', state.ui.selecting === true)
    for (const node of rendered.values()) {
      const checked = selection.has(node.dataset.id)
      node.classList.toggle('is-selected', checked)
      if (node.__check) {
        node.__check.classList.toggle('is-checked', checked)
        node.__check.setAttribute('aria-checked', checked ? 'true' : 'false')
      }
    }
    const selectedInList = tracks.filter((track) => selection.has(track.id)).length
    const all = tracks.length > 0 && selectedInList >= tracks.length
    headCheck.classList.toggle('is-checked', all)
    headCheck.classList.toggle('is-partial', selectedInList > 0 && !all)
    headCheck.setAttribute('aria-checked', all ? 'true' : selectedInList > 0 ? 'mixed' : 'false')
    paintSelectionBar(selectedInList)
  }

  function paintSelectionBar (count) {
    // 单选不弹工具条：普通单击总会有选中项，弹出来只会挡住列表；
    // 这些批量动作的意义在「多首」时才成立（单首走右键菜单或勾选框）
    selectionBar.hidden = count < 2
    if (count < 2) return
    const total = tracks.length
    const allSelected = total > 0 && count >= total
    selectionCount.textContent = allSelected ? `已选全部 ${total} 首` : `已选 ${count} 首`
    selectAllButton.textContent = allSelected ? '取消全选' : '全选'
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
    syncSelection()
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
      const currentIndex = tracks.findIndex((track) => track.id === store.get().ui.selectionAnchor)
      const nextIndex = Math.max(0, Math.min(tracks.length - 1, (currentIndex < 0 ? -1 : currentIndex) + (event.key === 'ArrowDown' ? 1 : -1)))
      const track = tracks[nextIndex]
      if (!track) return
      actions.setSelection([track.id], track.id)
      scrollToIndex(nextIndex, { center: false })
    } else if (event.key === 'Enter') {
      const track = tracks.find((item) => item.id === store.get().ui.selectionAnchor)
      if (track) actions.playTrack(track, tracks)
    } else if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
      // 列表里按 Ctrl+A 就是「全选当前列表」，顺便进入多选模式
      event.preventDefault()
      if (!store.get().ui.selecting) actions.startSelection()
      actions.setSelection(tracks.map((track) => track.id))
    } else if (event.key === 'Escape') {
      actions.clearSelection()
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
  // 选择 / 多选模式可能是别处改的（工具条、右键菜单、切视图时清空），统一在这里同步
  store.select((state) => state.ui.selection, syncSelection, {
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index])
  })
  store.select((state) => state.ui.selecting === true, () => syncSelection())
  store.select((state) => state.ui.source, () => syncSelection())
  syncSelection()
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
