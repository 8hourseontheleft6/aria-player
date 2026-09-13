/** 主内容区：全部歌曲 / 某文件夹的歌曲列表 */

import { h, on, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { formatDurationLong, normalizeForSearch } from '../core/format.js'
import { selectVisibleTracks, selectTitle } from '../core/selectors.js'
import { EVENTS } from '../core/bus.js'
import { createTrackList } from './track-list.js'
import { openPopover, popoverRows } from './overlay.js'

const SORT_OPTIONS = [
  { key: 'default', label: '默认（艺人 / 专辑 / 音轨）' },
  { key: 'title', label: '标题' },
  { key: 'artist', label: '艺人' },
  { key: 'album', label: '专辑' },
  { key: 'duration', label: '时长' },
  { key: 'year', label: '年份' },
  { key: 'added', label: '文件修改时间' }
]

export function createLibraryView ({ store, bus, player, artwork, actions, trackListOptions }) {
  const trackList = createTrackList({ store, bus, player, artwork, actions, ...trackListOptions })

  /* ---------------- 工具栏 ---------------- */
  const compactTitle = h('div', { class: 'view-toolbar__title', text: '全部歌曲' })
  const metaLabel = h('div', { class: 'view-toolbar__meta' })

  const sortButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '排序方式',
    onClick: () => {
      openPopover({
        anchor: sortButton,
        placement: 'bottom-end',
        content: popoverRows([
          { title: '排序方式' },
          ...SORT_OPTIONS.map((option) => ({
            label: option.label,
            value: store.get().ui.sort.key === option.key
              ? (store.get().ui.sort.direction === 'desc' ? '↓' : '↑')
              : '',
            onClick: () => actions.setSort(option.key)
          }))
        ])
      })
    }
  }, icon('list', { className: 'icon icon--stroke' }))

  const searchInput = h('input', {
    type: 'search',
    placeholder: '搜索歌曲、艺人、专辑',
    spellcheck: false,
    onInput: (event) => actions.setQuery(event.target.value)
  })
  const searchClear = h('button', {
    class: 'search__clear',
    type: 'button',
    title: '清除',
    onClick: () => {
      searchInput.value = ''
      actions.setQuery('')
      searchInput.focus()
    }
  }, icon('close', { className: 'icon icon--stroke' }))
  const searchBox = h('label', { class: 'search' }, icon('search', { className: 'icon icon--stroke' }), searchInput, searchClear)

  const scanButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '重新扫描音乐目录',
    onClick: () => actions.rescan()
  }, icon('refresh', { className: 'icon icon--stroke' }))

  const locateButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '定位到正在播放',
    onClick: () => {
      const id = store.get().playback.trackId
      if (id) trackList.scrollToTrack(id)
    }
  }, icon('target', { className: 'icon icon--stroke' }))

  const toolbar = h('div', { class: 'view-toolbar' },
    compactTitle,
    h('div', { class: 'view-toolbar__spacer' }),
    metaLabel,
    searchBox,
    locateButton,
    sortButton,
    scanButton
  )

  /* ---------------- 大标题 ---------------- */
  const playAllButton = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    onClick: () => actions.playAll()
  }, icon('play'), '播放')

  const shuffleButton = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => actions.shuffleAll()
  }, icon('shuffle', { className: 'icon icon--stroke' }), '随机播放')

  const headerTitle = h('h1', { class: 'view-header__title', text: '全部歌曲' })
  const headerSubtitle = h('div', { class: 'view-header__subtitle' })

  const header = h('div', { class: 'view-header' },
    h('div', { class: 'view-header__row' },
      h('div', {}, headerTitle, headerSubtitle),
      h('div', { class: 'view-header__actions' }, shuffleButton, playAllButton)
    )
  )

  const empty = h('div', { class: 'empty hidden' })

  const element = h('div', { class: 'content-inner', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' } },
    toolbar,
    header,
    empty,
    trackList.element
  )

  /* ---------------- 数据计算 ---------------- */
  function computeTracks (state) {
    return selectVisibleTracks(state)
  }

  let lastSignature = ''
  function refresh () {
    const state = store.get()
    const tracks = computeTracks(state)
    const signature = `${tracks.length}|${state.ui.source.type}|${state.ui.source.value}|${state.ui.query}|${state.ui.sort.key}|${state.ui.sort.direction}|${state.library.tracks.length}`
    if (signature !== lastSignature) {
      lastSignature = signature
      trackList.setTracks(tracks)
    }

    const total = tracks.reduce((sum, track) => sum + (track.duration || 0), 0)
    const title = selectTitle(state, '全部歌曲')

    headerTitle.textContent = title
    compactTitle.textContent = title
    metaLabel.textContent = `${tracks.length} 首 · ${formatDurationLong(total)}`

    if (state.ui.query) {
      const parts = normalizeForSearch(state.ui.query).split(/\s+/).filter(Boolean)
      headerSubtitle.textContent = parts.length
        ? `匹配「${state.ui.query}」的 ${tracks.length} 首 · ${formatDurationLong(total)}`
        : `${tracks.length} 首 · ${formatDurationLong(total)}`
    } else {
      headerSubtitle.textContent = `${tracks.length} 首 · ${formatDurationLong(total)}`
    }

    searchClear.parentElement.classList.toggle('has-value', Boolean(state.ui.query))
    if (searchInput.value !== state.ui.query) searchInput.value = state.ui.query

    /* 空状态 */
    clear(empty)
    let emptyContent = null
    if (!state.library.folders.length) {
      emptyContent = {
        iconName: 'folder',
        title: '还没有音乐文件夹',
        text: '添加一个包含音乐的文件夹，Aria 会递归扫描并读取歌曲信息（封面、歌词都会一起读取）。',
        action: h('button', { class: 'btn btn--primary', type: 'button', onClick: () => actions.addFolder() }, icon('plus'), '添加音乐文件夹')
      }
    } else if (state.ui.scanning && !state.library.tracks.length) {
      const progress = state.ui.scanProgress
      const percent = progress?.total ? `${Math.round((progress.done / progress.total) * 100)}%` : ''
      emptyContent = {
        iconName: 'waveform',
        title: '正在建立资料库',
        text: progress?.total ? `已处理 ${progress.done} / ${progress.total} 首 ${percent}` : '正在查找音乐文件…',
        action: h('div', { class: 'progress-bar', style: { width: '240px' } },
          h('div', { class: 'progress-bar__fill', style: { width: percent || '10%' } }))
      }
    } else if (!tracks.length && state.library.tracks.length) {
      emptyContent = {
        iconName: 'search',
        title: '没有匹配的歌曲',
        text: `没有找到与「${state.ui.query}」相关的曲目，换个关键词试试。`,
        action: null
      }
    }

    if (emptyContent) {
      empty.append(
        icon(emptyContent.iconName, { className: 'icon icon--stroke empty__icon' }),
        h('div', { class: 'empty__title', text: emptyContent.title }),
        h('div', { class: 'empty__text', text: emptyContent.text }),
        emptyContent.action || ''
      )
      empty.classList.remove('hidden')
      trackList.element.style.display = 'none'
    } else {
      empty.classList.add('hidden')
      trackList.element.style.display = ''
    }

    // 大标题随滚动收起
    const collapsed = trackList.viewport.scrollTop > 18
    header.classList.toggle('is-collapsed', collapsed)
    toolbar.classList.toggle('is-stuck', collapsed)
  }

  on(trackList.viewport, 'scroll', () => {
    const collapsed = trackList.viewport.scrollTop > 18
    header.classList.toggle('is-collapsed', collapsed)
    toolbar.classList.toggle('is-stuck', collapsed)
  }, { passive: true })

  bus.on(EVENTS.LIBRARY_UPDATED, refresh)
  store.subscribe((state, prev) => {
    if (state.ui === prev.ui && state.library === prev.library) return
    refresh()
  })

  refresh()

  return {
    element,
    refresh,
    focusSearch: () => {
      searchInput.focus()
      searchInput.select()
    },
    focusTrack: (id) => trackList.scrollToTrack(id),
    get tracks () { return trackList.tracks }
  }
}
