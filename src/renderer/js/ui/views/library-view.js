/** 主内容区：全部歌曲 / 某文件夹的歌曲列表 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { formatDurationLong, formatDuration, normalizeForSearch } from '../../core/format.js'
import { remote } from '../../core/remote.js'
import { selectVisibleTracks, selectTitle, describeMatch } from '../../core/selectors.js'
import { EVENTS } from '../../core/bus.js'
import { createTrackList } from '../widgets/track-list.js'
import { createListMenuButton } from '../menus/list-menu.js'
import { openPopover, popoverRows, closeAllLayers } from '../widgets/overlay.js'

const SORT_OPTIONS = [
  { key: 'default', label: '字母顺序（默认）' },
  { key: 'title', label: '标题' },
  { key: 'artist', label: '艺人' },
  { key: 'album', label: '专辑' },
  { key: 'duration', label: '时长' },
  { key: 'year', label: '年份' },
  { key: 'added', label: '文件修改时间' }
]

export function createLibraryView ({ store, bus, player, artwork, actions, trackListOptions }) {
  /**
   * 「这条结果为什么被搜出来」—— 列表悬停时显示匹配详情用。
   * 歌词命中只认「对应当前关键词」的那一份结果（异步搜索会晚到一步）。
   */
  function matchFor (track) {
    const state = store.get()
    const raw = state.ui.query.trim()
    if (!raw) return null
    const scope = state.settings.searchScope === 'deep' ? 'deep' : 'basic'
    const lyrics = state.ui.searchLyrics && state.ui.searchLyrics.query === state.ui.query
      ? (state.ui.searchLyrics.matches || []).find((item) => item.id === track.id)
      : null
    const info = describeMatch(track, state.ui.query, { scope, lyricsMatch: lyrics || null })
    if (!info) return null
    /*
     * 高亮用「用户原样输入的关键词」，不能用归一化后的：
     * 归一化会做 NFD 分解（假名、带变音符的字母会被拆成基字符 + 组合记号），
     * 拿它去匹配原文就永远匹配不上，标题/歌词行都高亮不出来。
     */
    const parts = raw.split(/\s+/).filter(Boolean)
    return { ...info, parts }
  }

  const trackList = createTrackList({
    store,
    bus,
    player,
    artwork,
    actions,
    matchFor,
    // 正在看自建播放列表时，多选面板里多一条「从列表中移除」
    playlistId: () => (store.get().ui.source.type === 'playlist' ? store.get().ui.source.value : null),
    ...trackListOptions
  })

  /* ---------------- 工具栏 ---------------- */
  const compactTitle = h('div', { class: 'view-toolbar__title', text: '全部歌曲' })
  const metaLabel = h('div', { class: 'view-toolbar__meta' })

  const sortButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '排序方式',
    onClick: () => {
      // 自建播放列表的顺序是用户自己排的，所以「默认」在那里就是「列表顺序」
      const inPlaylist = store.get().ui.source.type === 'playlist'
      openPopover({
        anchor: sortButton,
        placement: 'bottom-end',
        content: popoverRows([
          { title: '排序方式' },
          ...SORT_OPTIONS.map((option) => ({
            label: option.key === 'default' && inPlaylist ? '默认（播放列表顺序）' : option.label,
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

  /*
   * 搜索默认只留一个放大镜图标，点开才展开输入框 ——
   * 工具栏平时保持干净（这是需求里「现在的搜索很丑」那条）。
   * 收起时如果还有关键词就顺带清掉，免得出现「看不见却还在过滤」的状态。
   */
  function setSearchOpen (open) {
    searchSlot.classList.toggle('is-open', open)
    if (open) {
      searchInput.focus()
    } else {
      openSearchPanel(false)
      if (searchInput.value) {
        searchInput.value = ''
        actions.setQuery('')
      }
    }
  }

  const searchToggle = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '搜索（Ctrl + F）',
    onClick: () => setSearchOpen(!searchSlot.classList.contains('is-open'))
  }, icon('search', { className: 'icon icon--stroke' }))

  const searchSlot = h('div', { class: 'search-slot' }, searchToggle, searchBox)

  /*
   * 工具栏只留三个按钮：搜索 / 排序 / ⋯。
   * 「定位到正在播放」「重新扫描音乐目录」是低频操作，收进 ⋯ 里 ——
   * 五个图标按钮排在一起既挤又难扫（用户反馈过界面不协调）。
   */
  const toolbar = h('div', { class: 'view-toolbar' },
    compactTitle,
    h('div', { class: 'view-toolbar__spacer' }),
    metaLabel,
    searchSlot,
    sortButton,
    // 批量选择 + 低频操作的入口
    createListMenuButton({
      actions,
      getTracks: () => trackList.tracks,
      items: [
        { separator: true },
        {
          label: '定位到正在播放',
          value: '',
          onClick: () => {
            closeAllLayers()
            const id = store.get().playback.trackId
            if (id) trackList.scrollToTrack(id)
          }
        },
        {
          label: '重新扫描音乐目录',
          value: '',
          onClick: () => {
            closeAllLayers()
            actions.rescan()
          }
        }
      ]
    })
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

  /* ---------------- 网络结果（在线音源） ----------------
   *
   * 搜索结果分两块：上面是本地曲目（原来的列表），这里是音源返回的网络结果。
   * 本仓库不内置任何音源，所以没装音源时这里根本不出现；
   * 装了音源但没打开总开关也一样不出现（和在线补全的默认行为保持一致）。
   */
  const onlineList = h('div', { class: 'online-results__list' })
  const onlineSummary = h('div', { class: 'online-results__summary' })
  const onlineSection = h('div', { class: 'online-results', hidden: true })

  const onlineHead = h('div', { class: 'online-results__head' },
    h('div', { class: 'online-results__title' },
      icon('search', { className: 'icon icon--stroke' }),
      h('span', { text: '网络结果' }),
      onlineSummary
    ),
    h('button', {
      class: 'online-results__toggle',
      type: 'button',
      onClick: () => {
        onlineCollapsed = !onlineCollapsed
        renderOnline()
      }
    }, h('span', { text: '收起' }))
  )
  onlineSection.append(onlineHead, onlineList)
  let onlineCollapsed = false
  let lastOnlineSignature = ''

  async function copyOnlineUrl (item, button) {
    const original = button.textContent
    button.textContent = '解析中…'
    button.disabled = true
    try {
      const result = await remote.sources.resolve(item)
      await navigator.clipboard.writeText(result.url)
      toast({ message: `已复制「${item.title}」的播放地址（${result.sourceName}）`, type: 'success' })
    } catch (err) {
      toast({ message: `解析失败：${String(err?.message || err)}`, type: 'error', duration: 4200 })
    } finally {
      button.textContent = original
      button.disabled = false
    }
  }

  function renderOnline () {
    const state = store.get()
    const enabled = state.settings.onlineSources === true
    const search = state.ui.onlineSearch
    const relevant = enabled && search && search.query === state.ui.query ? search : null
    const signature = relevant
      ? `${relevant.status}|${relevant.results.length}|${relevant.perSource.map((s) => `${s.id}:${s.count}:${s.error || ''}`).join(',')}|${onlineCollapsed}|` +
        `${relevant.results.map((item) => {
          const dl = (state.ui.downloads || {})[item.uid || `${item.sourceId}:${item.sourceTrackId}`]
          return dl ? `${dl.status}${dl.status === 'running' ? Math.round((dl.percent || 0) / 10) : ''}` : '-'
        }).join('')}`
      : 'hidden'
    if (signature === lastOnlineSignature) return
    lastOnlineSignature = signature

    if (!relevant) {
      onlineSection.hidden = true
      return
    }
    onlineSection.hidden = false
    onlineCollapsed = onlineCollapsed && relevant.status === 'done'
    onlineSection.classList.toggle('is-collapsed', onlineCollapsed)
    onlineHead.querySelector('.online-results__toggle span').textContent = onlineCollapsed ? '展开' : '收起'

    clear(onlineSummary)
    if (relevant.status === 'loading') {
      onlineSummary.append(h('span', { class: 'online-results__meta', text: '搜索中…' }))
    } else if (relevant.status === 'error') {
      onlineSummary.append(h('span', { class: 'online-results__meta is-error', text: `失败：${relevant.error}` }))
    } else {
      const failed = relevant.perSource.filter((item) => item.error).length
      onlineSummary.append(
        h('span', { class: 'online-results__count', text: `${relevant.results.length} 首` }),
        h('span', {
          class: 'online-results__meta',
          text: `${relevant.perSource.length} 个音源` +
            `${failed ? `（${failed} 个出错）` : ''} · ${Math.round(relevant.elapsedMs)}ms`
        })
      )
    }

    clear(onlineList)
    if (relevant.status === 'loading') {
      onlineList.append(h('div', { class: 'online-results__hint', text: '正在向已启用的音源查询…' }))
      return
    }
    if (!relevant.results.length) {
      const failed = relevant.perSource.filter((item) => item.error)
      // LX 音乐音源按官方规范只做解析、不做搜索，这里要把原因说清楚，别让用户以为是坏了
      const resolverOnly = relevant.perSource.filter((item) => item.skipped === 'lx-resolver-only')
      onlineList.append(h('div', { class: 'online-results__hint' },
        h('div', { text: failed.length && failed.length === relevant.perSource.length
          ? '所有音源都出错了：'
          : '音源没有返回结果。' }),
        ...failed.slice(0, 3).map((item) => h('div', { class: 'online-results__error', text: `${item.name}：${item.error}` })),
        ...resolverOnly.slice(0, 3).map((item) => h('div', { class: 'online-results__error', text: `${item.name}：${item.note}` }))
      ))
      return
    }
    for (const item of relevant.results) {
      const uid = item.uid || `${item.sourceId}:${item.sourceTrackId}`
      const download = (state.ui.downloads || {})[uid]
      const copyButton = h('button', {
        class: 'online-result__action',
        type: 'button',
        title: '解析出播放地址并复制到剪贴板',
        onClick: (event) => {
          event.stopPropagation()
          copyOnlineUrl(item, copyButton)
        }
      }, '复制地址')
      const playButton = h('button', {
        class: 'online-result__action is-primary',
        type: 'button',
        title: '解析直链并直接播放（歌词会跟着一起加载）',
        onClick: async (event) => {
          event.stopPropagation()
          playButton.disabled = true
          playButton.textContent = '解析中…'
          try {
            await actions.playOnlineItem(item)
          } catch (err) {
            toast({ message: `播放失败：${String(err?.message || err)}`, type: 'error', duration: 4200 })
          } finally {
            playButton.disabled = false
            playButton.textContent = '播放'
          }
        }
      }, '播放')
      const downloadButton = h('button', {
        class: 'online-result__action',
        type: 'button',
        title: '下载到默认目录（设置里可指定目录）',
        onClick: (event) => {
          event.stopPropagation()
          actions.downloadOnlineItem(item)
        }
      }, '下载')

      onlineList.append(h('div', { class: 'online-result' },
        h('div', { class: 'online-result__main' },
          h('div', { class: 'online-result__title truncate', text: item.title, title: item.title }),
          h('div', { class: 'online-result__sub truncate' },
            [item.artist, item.album].filter(Boolean).join(' · ') || '—'),
          download
            ? h('div', { class: 'online-result__progress' },
              h('div', { class: 'online-result__progress-bar' },
                h('div', {
                  class: 'online-result__progress-fill',
                  style: { width: `${download.status === 'done' ? 100 : (download.percent ?? 8)}%` }
                })),
              h('span', {
                class: 'online-result__progress-text',
                text: download.status === 'done'
                  ? '已下载'
                  : download.status === 'error'
                    ? `失败：${download.error}`
                    : `下载中 ${download.percent != null ? `${download.percent}%` : ''}`
              }))
            : null
        ),
        h('div', { class: 'online-result__meta' },
          item.quality ? h('span', { class: 'online-result__tag', text: item.quality }) : null,
          h('span', { class: 'online-result__source', text: item.sourceName }),
          h('span', { class: 'online-result__duration tabular', text: item.duration ? formatDuration(item.duration) : '' })
        ),
        h('div', { class: 'online-result__actions' }, playButton, downloadButton, copyButton)
      ))
    }
  }

  const element = h('div', { class: 'content-inner view-root' },
    toolbar,
    header,
    onlineSection,
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
    // 搜索结果分两块：这块是网络结果（音源），下面那块是本地曲目
    renderOnline()

    /* 空状态 */
    clear(empty)
    let emptyContent = null
    const playlist = actions.currentPlaylist ? actions.currentPlaylist() : null
    if (playlist && !tracks.length && !state.ui.query) {
      emptyContent = {
        iconName: 'queueAdd',
        title: `「${playlist.name}」还是空的`,
        text: '在任意歌曲上右键 →「添加到播放列表…」就能加进来；歌曲列表、专辑详情、媒体墙里的歌都行。',
        action: h('button', {
          class: 'btn btn--primary',
          type: 'button',
          onClick: () => actions.setSource({ type: 'all', value: null })
        }, '去全部歌曲里挑')
      }
    } else if (!state.library.folders.length) {
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

  /*
   * 扫描期间把连续的「资料库更新」合并成一次刷新 —— 这是实机反馈的频闪来源：
   * 扫描按批次推进，每个批次都 refresh() 一次（整表重算 + setTracks），
   * 而行是按索引做虚拟滚动的：列表一变长，行就会被拆掉重建、封面重新加载，
   * 眼睛看到的就是一片闪烁（鼠标停在「全部歌曲」上时尤其明显）。
   *
   * 关键是**只对「扫描进行中的资料库变化」合并**：
   * 上一版我把所有更新一起延迟 140ms，结果视图切换 / 排序 / 搜索也跟着变慢，
   * 自检红了 28 条 —— 那些路径必须保持立即刷新。
   * 扫描结束时 ui.scanning 变化会走 refreshNow()，把待处理的那次立刻补上，不会漏结果。
   */
  let pendingScanRefresh = null

  function refreshNow () {
    if (pendingScanRefresh) {
      clearTimeout(pendingScanRefresh)
      pendingScanRefresh = null
    }
    refresh()
  }

  function refreshForLibraryChange () {
    if (store.get().ui.scanning !== true) {
      refreshNow()
      return
    }
    if (pendingScanRefresh) return
    pendingScanRefresh = setTimeout(() => {
      pendingScanRefresh = null
      refresh()
    }, 200)
  }

  bus.on(EVENTS.LIBRARY_UPDATED, refreshForLibraryChange)
  store.subscribe((state, prev) => {
    // 设置也要算进来：搜索范围（basic/deep）会影响占位符、范围按钮与提示文案，
    // 只盯 ui/library 的话，点了范围按钮界面不会有任何反应
    if (state.ui === prev.ui && state.library === prev.library && state.settings === prev.settings) return
    // 扫描中的「仅资料库变化」才合并；其余（视图、排序、搜索、设置）立即刷新
    const onlyLibrary = state.ui === prev.ui && state.settings === prev.settings
    if (onlyLibrary && state.ui.scanning === true) refreshForLibraryChange()
    else refreshNow()
  })

  refresh()

  return {
    element,
    refresh,
    focusSearch: () => {
      // Ctrl+F：先展开搜索框（默认收起时只有一个图标）再聚焦
      setSearchOpen(true)
      searchInput.focus()
      searchInput.select()
    },
    focusTrack: (id) => trackList.scrollToTrack(id),
    get tracks () { return trackList.tracks }
  }
}
