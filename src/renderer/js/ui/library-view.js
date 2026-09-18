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

  /* ---------------- 搜索：范围切换 + 搜索历史 ---------------- */

  /*
   * 两档范围：
   *   歌曲信息 —— 歌名 / 专辑 / 艺人（纯内存匹配，输入即出结果）
   *   含歌词等 —— 再加上歌词（主进程读 .lrc）与年份、流派、文件名、编码格式
   * 歌词是异步的，所以这里还要显示「正在搜歌词」以及命中数量。
   */
  const SCOPE_LABELS = { basic: '歌曲信息', deep: '含歌词等' }
  let searchScope = store.get().settings.searchScope === 'deep' ? 'deep' : 'basic'
  let searchPanelOpen = false

  const scopeButtons = ['basic', 'deep'].map((scope) => h('button', {
    class: `search-panel__scope${scope === searchScope ? ' is-selected' : ''}`,
    type: 'button',
    'data-scope': scope,
    onClick: () => actions.setSearchScope(scope)
  }, SCOPE_LABELS[scope]))

  const historyList = h('div', { class: 'search-panel__history' })
  const searchHint = h('div', { class: 'search-panel__hint' })

  const searchPanel = h('div', { class: 'search-panel', hidden: true },
    h('div', { class: 'search-panel__row' },
      h('span', { class: 'search-panel__label', text: '搜索范围' }),
      h('div', { class: 'search-panel__scope-group' }, ...scopeButtons)
    ),
    h('div', { class: 'search-panel__row', 'data-empty': '最近搜索' },
      h('span', { class: 'search-panel__label', text: '最近搜索' }),
      h('button', {
        class: 'search-panel__clear',
        type: 'button',
        title: '清空搜索历史',
        onClick: () => actions.clearSearchHistory()
      }, '清空')
    ),
    historyList,
    searchHint
  )
  // 面板里的交互不能把输入框的焦点抢走，否则下拉一开就关
  on(searchPanel, 'mousedown', (event) => event.preventDefault())

  function renderSearchPanel () {
    const state = store.get()
    searchScope = state.settings.searchScope === 'deep' ? 'deep' : 'basic'
    scopeLabelNode.textContent = SCOPE_LABELS[searchScope]
    for (const button of scopeButtons) {
      button.classList.toggle('is-selected', button.dataset.scope === searchScope)
    }
    const history = state.settings.searchHistory || []
    historyList.replaceChildren(...history.map((item) => h('div', { class: 'search-panel__item' },
      h('button', {
        class: 'search-panel__term',
        type: 'button',
        title: `搜索「${item}」`,
        onClick: () => {
          searchInput.value = item
          actions.setQuery(item)
          actions.commitSearch(item)
          // 先聚焦再关面板：反过来的话聚焦事件会把面板又打开
          searchInput.focus()
          openSearchPanel(false)
        }
      }, icon('clock', { className: 'icon icon--stroke' }), h('span', { text: item })),
      h('button', {
        class: 'search-panel__remove',
        type: 'button',
        title: '从历史中移除',
        onClick: () => actions.removeSearchHistory(item)
      }, icon('close', { className: 'icon icon--stroke' }))
    )))
    historyList.hidden = history.length === 0

    const lyrics = state.ui.searchLyrics
    const deep = searchScope === 'deep'
    if (!deep) {
      searchHint.textContent = '当前只搜索歌名、专辑与艺人'
    } else if (!state.ui.query.trim()) {
      searchHint.textContent = '还会搜索歌词文件，以及年份、流派、文件名、编码格式'
    } else if (lyrics?.scanning) {
      searchHint.textContent = '正在搜索歌词…'
    } else if (lyrics && lyrics.error) {
      searchHint.textContent = `歌词搜索失败：${lyrics.error}`
    } else if (lyrics) {
      searchHint.textContent = `已扫描 ${lyrics.scanned} 份歌词，命中 ${lyrics.matched} 首（${lyrics.elapsedMs}ms）`
    } else {
      searchHint.textContent = '还会搜索歌词文件，以及年份、流派、文件名、编码格式'
    }
    searchInput.placeholder = deep ? '搜索歌词、年份、流派…' : '搜索歌名、专辑、艺人'
  }

  function syncSearchPanel () {
    searchPanel.hidden = !searchPanelOpen
    searchInput.setAttribute('aria-expanded', String(searchPanelOpen))
    scopeSelect.classList.toggle('is-deep', searchScope === 'deep')
  }

  function openSearchPanel (open) {
    searchPanelOpen = open
    renderSearchPanel()
    syncSearchPanel()
  }

  const scopeLabelNode = h('span', { text: SCOPE_LABELS[searchScope] })
  const scopeSelect = h('button', {
    class: 'search__scope',
    type: 'button',
    title: '搜索范围与搜索历史',
    onClick: () => openSearchPanel(!searchPanelOpen)
  }, scopeLabelNode, icon('chevronDown', { className: 'icon icon--stroke' }))

  function commitQuery () {
    if (searchInput.value.trim()) actions.commitSearch(searchInput.value)
  }

  const searchInput = h('input', {
    type: 'search',
    placeholder: '搜索歌名、专辑、艺人',
    spellcheck: false,
    onInput: (event) => actions.setQuery(event.target.value),
    onFocus: () => openSearchPanel(true),
    onBlur: () => {
      // 失焦（比如点开一首歌开始播放）就算「用过这次搜索」，记进历史
      commitQuery()
      openSearchPanel(false)
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') {
        commitQuery()
        openSearchPanel(false)
        searchInput.blur()
      } else if (event.key === 'Escape') {
        openSearchPanel(false)
        searchInput.blur()
      }
    }
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
  const searchBox = h('label', { class: 'search' },
    icon('search', { className: 'icon icon--stroke' }),
    searchInput,
    scopeSelect,
    searchClear,
    searchPanel
  )

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

  const element = h('div', { class: 'content-inner view-root' },
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
    /*
     * 签名里必须带上「歌词命中」：深度搜索时列表内容取决于主进程异步返回的 id，
     * 不带上它的话结果到了也不会重绘（列表会一直停在「0 首」）。
     */
    const lyricsSignature = state.ui.searchLyrics
      ? `${state.ui.searchLyrics.query}#${state.ui.searchLyrics.ids?.length ?? 0}#${state.ui.searchLyrics.scanning ? 1 : 0}`
      : '-'
    const signature = `${tracks.length}|${state.ui.source.type}|${state.ui.source.value}|${state.ui.query}|${state.ui.sort.key}|${state.ui.sort.direction}|${state.library.tracks.length}|${state.settings.searchScope}|${lyricsSignature}`
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
    // 搜索面板：范围按钮、历史、歌词搜索进度都跟着 store 走
    searchScope = state.settings.searchScope === 'deep' ? 'deep' : 'basic'
    scopeLabelNode.textContent = SCOPE_LABELS[searchScope]
    for (const button of scopeButtons) {
      button.classList.toggle('is-selected', button.dataset.scope === searchScope)
    }
    scopeSelect.classList.toggle('is-deep', searchScope === 'deep')
    searchInput.placeholder = searchScope === 'deep' ? '搜索歌词、年份、流派…' : '搜索歌名、专辑、艺人'
    if (searchPanelOpen) renderSearchPanel()

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
    // 设置也要算进来：搜索范围（basic/deep）会影响占位符、范围按钮与提示文案，
    // 只盯 ui/library 的话，点了范围按钮界面不会有任何反应
    if (state.ui === prev.ui && state.library === prev.library && state.settings === prev.settings) return
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
