/**
 * 应用入口：组装（composition root）。
 *
 * 渲染层的结构：
 *   core/   与界面无关的能力（队列、引擎、歌词解析、插件宿主…）
 *   ui/     界面组件，只通过 actions 与 core 交互
 *   plugins/扩展，通过插件宿主注册到扩展点
 *
 * 想替换某一层（例如把 HTMLAudio 换成 WebAudio、把本地歌词换成在线歌词），
 * 只需要在这一层换掉对应的实现，其它模块不用动。
 */

import { createBus, EVENTS } from './core/bus.js'
import { createStore, initialState } from './core/store.js'
import { remote, isElectron } from './core/remote.js'
import { normalizeForSearch } from './core/format.js'
import { createAudioEngine } from './core/audio-engine.js'
import { createPlaylist } from './core/playlist.js'
import { createPluginHost } from './core/plugin-host.js'
import { registerBuiltinModes } from './core/playback-modes.js'
import { createArtworkService } from './core/artwork.js'
import { createPlayerController } from './core/player-controller.js'
import { createLibraryIndex } from './core/grouping.js'
import { selectVisibleTracks } from './core/selectors.js'
import { createArtworkPrewarmer } from './core/artwork-prewarm.js'

import { createTitlebar } from './ui/titlebar.js'
import { createSidebar } from './ui/sidebar.js'
import { createLibraryView } from './ui/library-view.js'
import { createBrowseView } from './ui/browse-view.js'
import { createMediaWall } from './ui/media-wall.js'
import { createSettingsView } from './ui/settings-view.js'
import { createPlayerBar } from './ui/player-bar.js'
import { createNowPlayingPanel } from './ui/now-playing-panel.js'
import { createQueuePanel } from './ui/queue-panel.js'
import { createTrackMenu } from './ui/track-menu.js'
import { createDropZone } from './ui/drop-zone.js'
import { createLazyArtwork } from './ui/artwork-node.js'
import { toast, closeAllLayers } from './ui/overlay.js'
import { createFpsOverlay } from './ui/fps-overlay.js'

import { BUILTIN_PLUGINS } from './plugins/index.js'

const SORT_KEYS = ['default', 'title', 'artist', 'album', 'duration', 'year', 'added']
/** 搜索历史最多留这么多条（新的在前） */
const SEARCH_HISTORY_LIMIT = 10

async function main () {
  /* ------------------------------------------------------------------ */
  /* 基础服务                                                            */
  /* ------------------------------------------------------------------ */
  const bus = createBus()
  const store = createStore(initialState())
  const engine = createAudioEngine({ bus })
  const playlist = createPlaylist()
  const host = createPluginHost({
    bus,
    store,
    services: { engine, playlist, remote }
  })
  const artwork = createArtworkService({ bus, host })

  registerBuiltinModes(host)
  host.loadAll(BUILTIN_PLUGINS)

  const player = createPlayerController({ store, bus, engine, playlist, host, artwork })

  /* ------------------------------------------------------------------ */
  /* 可见曲目与分组索引（带记忆化，避免每次渲染重算 800 首）               */
  /* ------------------------------------------------------------------ */
  const libraryIndex = createLibraryIndex()
  let visibleCache = null
  let visibleKey = [null, null, null, null]

  function visibleTracks () {
    const state = store.get()
    const { library, ui } = state
    if (visibleCache &&
      visibleKey[0] === library.tracks && visibleKey[1] === ui.source &&
      visibleKey[2] === ui.query && visibleKey[3] === ui.sort) {
      return visibleCache
    }
    visibleCache = selectVisibleTracks(state)
    visibleKey = [library.tracks, ui.source, ui.query, ui.sort]
    return visibleCache
  }

  function index () {
    return libraryIndex.get(visibleTracks())
  }

  /** 封面后台预热：空闲时把封面灌进主进程的磁盘缓存，让媒体墙秒出图 */
  let lazyArtwork = null
  const prewarmer = createArtworkPrewarmer({
    bus,
    remote,
    settings: {
      get: () => store.get().settings
    },
    actions: { albums: () => index().albumList },
    isBusy: () => {
      // 界面正在加载封面时让路
      const state = lazyArtwork?.state
      if (state && (state.active > 0 || state.queued > 0)) return true
      // 切歌时的加载/缓冲窗口也让路，别和播放启动抢主进程
      const status = store.get().playback.status
      return status === 'loading' || status === 'buffering'
    }
  })

  /* ------------------------------------------------------------------ */
  /* DOM 容器                                                            */
  /* ------------------------------------------------------------------ */
  const dom = {
    titlebar: document.getElementById('titlebar'),
    sidebar: document.getElementById('sidebar'),
    content: document.getElementById('content'),
    playerBar: document.getElementById('player-bar'),
    nowPlaying: document.getElementById('now-playing'),
    app: document.getElementById('app')
  }

  /* ------------------------------------------------------------------ */
  /* 动作（UI 只调用这里，不直接改 store / 播放器）                        */
  /* ------------------------------------------------------------------ */
  const actions = {
    setView (view) {
      store.set((state) => ({
        ...state,
        ui: {
          ...state.ui,
          view,
          // 从侧边栏切换视图时总是回到列表页，不保留上一次的专辑/艺人详情
          detail: null
        }
      }))
      if (store.get().ui.nowPlayingOpen) actions.closeNowPlaying()
    },

    setSource (source) {
      store.set((state) => ({
        ...state,
        ui: {
          ...state.ui,
          source,
          detail: null,
          view: state.ui.view === 'settings' ? 'songs' : state.ui.view
        }
      }))
    },

    /* ---------- 专辑 / 艺人浏览 ---------- */
    albums: () => index().albumList,
    artists: () => index().artistList,
    albumByKey: (key) => index().albums.get(key) || null,
    artistByKey: (key) => index().artists.get(key) || null,

    openAlbum (key) {
      store.set((state) => ({ ...state, ui: { ...state.ui, view: 'albums', detail: { type: 'album', key } } }))
    },

    openArtist (key) {
      store.set((state) => ({ ...state, ui: { ...state.ui, view: 'artists', detail: { type: 'artist', key } } }))
    },

    closeDetail () {
      store.set((state) => ({ ...state, ui: { ...state.ui, detail: null } }))
    },

    /** 用某个集合（专辑 / 艺人 / 搜索结果）作为队列播放 */
    playCollectionOf (tracks, startTrack) {
      const list = (tracks || []).map((track) => track.id)
      if (!list.length) return
      const start = startTrack?.id || list[0]
      if (store.get().playback.mode === 'shuffle') player.setMode('loop-list')
      player.playCollection(list, start)
    },

    shuffleCollectionOf (tracks) {
      const list = (tracks || []).map((track) => track.id)
      if (!list.length) return
      player.setMode('shuffle')
      player.playCollection(list, list[Math.floor(Math.random() * list.length)])
    },

    setQuery (query) {
      store.set((state) => ({ ...state, ui: { ...state.ui, query } }))
      // 深度搜索时歌词要问主进程，这里跟着防抖触发
      requestSearchLyrics()
    },

    /**
     * 切换搜索范围。
     * basic = 只搜歌曲信息（歌名 / 专辑 / 艺人）；deep = 再算上歌词、年份、流派、文件名等。
     */
    setSearchScope (scope) {
      const next = scope === 'deep' ? 'deep' : 'basic'
      if (next === 'basic') actions.setSearchLyrics(null)
      requestSearchLyrics({ scope: next })
      // 返回 promise：界面点击与自检都可以等写盘回来
      return actions.setSetting({ searchScope: next })
    },

    /** 主进程搜歌词的结果回填（只认「对应当前关键词」的那一份） */
    setSearchLyrics (result) {
      store.set((state) => ({ ...state, ui: { ...state.ui, searchLyrics: result } }))
    },

    /**
     * 记一条搜索历史。
     * 只在用户真的「用了一次搜索」时调用（回车 / 点结果 / 失焦），不是每敲一个字都记，
     * 否则历史会被 "t"/"ta"/"tay" 这种半截词塞满。
     */
    commitSearch (query = store.get().ui.query) {
      const trimmed = String(query || '').trim()
      if (!trimmed) return null
      const history = store.get().settings.searchHistory || []
      const next = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, SEARCH_HISTORY_LIMIT)
      // 返回 promise：调用方（界面 / 自检）可以等写盘回来再继续，
      // 否则连续两次提交会被设置回声按旧值覆盖（自检里真的撞到过）
      return actions.setSetting({ searchHistory: next })
    },

    removeSearchHistory (query) {
      const history = store.get().settings.searchHistory || []
      return actions.setSetting({ searchHistory: history.filter((item) => item !== query) })
    },

    clearSearchHistory () {
      return actions.setSetting({ searchHistory: [] })
    },

    /** 自检用：直接跑一次歌词搜索（不走防抖），并把结果写进 store */
    async searchLyricsNow (query = store.get().ui.query) {
      const result = await runLyricsSearch(String(query || ''))
      actions.setSearchLyrics(result)
      return result
    },

    setSort (key) {
      if (!SORT_KEYS.includes(key)) return
      store.set((state) => {
        const same = state.ui.sort.key === key
        return {
          ...state,
          ui: {
            ...state.ui,
            sort: {
              key,
              direction: same && state.ui.sort.direction === 'asc' ? 'desc' : 'asc'
            }
          }
        }
      })
    },

    toggleSidebar () {
      store.set((state) => ({ ...state, ui: { ...state.ui, sidebarVisible: !state.ui.sidebarVisible } }))
    },

    openNowPlaying ({ lyrics = null } = {}) {
      store.set((state) => ({
        ...state,
        ui: {
          ...state.ui,
          nowPlayingOpen: true,
          lyricsVisible: lyrics === null ? state.ui.lyricsVisible : lyrics
        }
      }))
      bus.emit(EVENTS.NOW_PLAYING_OPEN, true)
    },

    closeNowPlaying () {
      store.set((state) => ({ ...state, ui: { ...state.ui, nowPlayingOpen: false } }))
    },

    toggleLyrics () {
      store.set((state) => ({ ...state, ui: { ...state.ui, lyricsVisible: !state.ui.lyricsVisible } }))
    },

    toggleRemainingTime () {
      actions.setSetting({ showRemainingTime: !store.get().settings.showRemainingTime })
    },

    toggleQueue (force) {
      store.set((state) => ({
        ...state,
        ui: { ...state.ui, queueOpen: typeof force === 'boolean' ? force : !state.ui.queueOpen }
      }))
    },

    closeQueueOnNarrow () {
      if (window.innerWidth < 1100) actions.toggleQueue(false)
    },

    playTrack (track, context) {
      if (!track) return
      // context 由列表组件传入（专辑详情、艺人详情的列表会传自己的曲目集合），
      // 这样「点哪首歌就以哪个集合作为队列」的行为在各视图里一致
      const source = Array.isArray(context) && context.length ? context : visibleTracks()
      const list = source.map((item) => item.id)
      if (list.includes(track.id)) player.playCollection(list, track.id)
      else player.playCollection([track.id], track.id)
    },

    playAll () {
      const list = visibleTracks()
      if (!list.length) {
        toast({ message: '列表里还没有歌曲', type: 'info' })
        return
      }
      actions.playCollectionOf(list, list[0])
    },

    shuffleAll () {
      const list = visibleTracks()
      if (!list.length) {
        toast({ message: '列表里还没有歌曲', type: 'info' })
        return
      }
      actions.shuffleCollectionOf(list)
    },

    togglePlay () {
      player.toggle()
    },

    async addFolder () {
      try {
        const result = await remote.library.pickFolders()
        if (result?.ok) {
          await loadLibrary()
          toast({ message: `已添加 ${result.added.length} 个文件夹，正在扫描…`, type: 'success' })
        }
      } catch (err) {
        toast({ message: `添加失败：${err.message}`, type: 'error' })
      }
    },

    async removeFolder (folder) {
      await remote.library.removeFolder(folder)
      await loadLibrary()
      toast({ message: '已从资料库移除该目录', type: 'info' })
    },

    rescan (force = false) {
      remote.library.scan({ force: Boolean(force) }).catch((err) => {
        toast({ message: `扫描失败：${err.message}`, type: 'error' })
      })
      toast({ message: force ? '正在重新扫描（会重新读取全部元数据）' : '正在扫描…', type: 'info' })
    },

    revealTrack (track) {
      if (!track) return
      remote.library.reveal(track.path)
    },

    revealUserData () {
      const userData = store.get().app.info?.userData
      if (userData) remote.library.reveal(`${userData}\\settings.json`)
    },

    async copyTrackInfo (track) {
      const text = trackMenu.describe(track)
      try {
        await navigator.clipboard.writeText(text)
        toast({ message: '已复制歌曲信息', type: 'success' })
      } catch {
        toast({ message: '复制失败，剪贴板不可用', type: 'error' })
      }
    },

    locateCurrent () {
      const id = store.get().playback.trackId
      if (!id) return
      actions.setView('songs')
      libraryView.focusTrack(id)
    },

    openTrackMenu (track, event) {
      trackMenu.open(track, event)
    },

    /** 拖入歌曲后播放（主进程已经完成路径校验与资料库归属判断） */
    playDroppedTracks (trackIds) {
      const ids = (trackIds || []).filter(Boolean)
      if (!ids.length) return
      player.playCollection(ids, ids[0])
      const first = store.get().library.byId.get(ids[0])
      toast({
        message: ids.length > 1
          ? `已加入队列并播放：${first?.title || ''} 等 ${ids.length} 首`
          : `正在播放：${first?.title || ''}`,
        type: 'success'
      })
    },

    setTheme (theme) {
      actions.setSetting({ theme })
    },

    async setSetting (patch) {
      const next = await remote.settings.set(patch)
      applySettings(next)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 组件挂载                                                            */
  /* ------------------------------------------------------------------ */
  const titlebar = createTitlebar({ store, bus, actions })
  const sidebar = createSidebar({ store, bus, actions })
  const trackMenu = createTrackMenu({ store, bus, player, host, actions })
  const libraryView = createLibraryView({ store, bus, player, artwork, actions })
  // 封面懒加载器由 app 统一持有：专辑网格、艺人列表、媒体墙共用同一个 IntersectionObserver
  lazyArtwork = createLazyArtwork(artwork)
  const browseView = createBrowseView({ store, bus, player, artwork, actions, lazy: lazyArtwork })
  const mediaWall = createMediaWall({ store, bus, player, actions, lazy: lazyArtwork })
  const settingsView = createSettingsView({ store, bus, player, actions, host })
  const playerBar = createPlayerBar({ store, bus, player, artwork, actions })
  const nowPlayingPanel = createNowPlayingPanel({ store, bus, player, artwork, host, actions })
  const queuePanel = createQueuePanel({ store, bus, player, artwork, actions })
  const dropZone = createDropZone({ bus, actions })
  const fpsOverlay = createFpsOverlay({ store })

  dom.titlebar.replaceWith(titlebar.element)
  dom.sidebar.replaceWith(sidebar.element)
  dom.content.append(libraryView.element, browseView.element, mediaWall.element, settingsView.element, queuePanel.element)
  dom.playerBar.replaceWith(playerBar.element)
  dom.nowPlaying.replaceWith(nowPlayingPanel.element)
  document.getElementById('layer-root').appendChild(dropZone.element)
  document.getElementById('layer-root').appendChild(fpsOverlay.element)

  // 视图切换：歌曲列表 / 专辑 / 艺人 / 媒体墙 / 设置
  // 注意两点：
  //  1) 几个视图可能共用同一个容器（专辑与艺人共用 browseView），所以按
  //     「容器 -> 支持的视图」组织，避免同一元素被后面的分支又设回 display:none
  //  2) 这里只切换 display，视图自身的布局（display:flex/height:100%）由
  //     .view-root 类提供。不要把布局写进内联 style，否则置空 display 时会被一起清掉，
  //     里面的滚动容器就失去了高度约束（曾经导致媒体墙整页滚不动）
  const viewContainers = [
    { views: ['songs'], element: libraryView.element },
    { views: ['albums', 'artists'], element: browseView.element },
    { views: ['wall'], element: mediaWall.element },
    { views: ['settings'], element: settingsView.element }
  ]

  store.select((state) => `${state.ui.view}|${state.ui.detail ? state.ui.detail.key : ''}`, () => {
    const view = store.get().ui.view
    for (const container of viewContainers) {
      container.element.style.display = container.views.includes(view) ? '' : 'none'
    }
    if (view === 'settings') settingsView.render()
    // 媒体墙自己会监听 ui.view 并在切回时刷新 + 定位到正在播放的专辑，
    // 这里不要再调一次 —— 它会紧跟一次 settlePan()，把刚开始的定位动画取消掉
    if (view === 'albums' || view === 'artists') browseView.render()
  })

  store.select((state) => state.ui.sidebarVisible, (visible) => {
    dom.app.classList.toggle('is-sidebar-hidden', !visible)
  })

  /* ------------------------------------------------------------------ */
  /* 插件主题令牌：把 themeToken 扩展点注册的 CSS 变量写进根节点            */
  /* ------------------------------------------------------------------ */
  function applyThemeTokens () {
    const root = document.documentElement
    for (const token of host.list('themeToken')) {
      for (const [property, value] of Object.entries(token.tokens || {})) {
        root.style.setProperty(property, String(value))
      }
    }
  }

  bus.on('plugin:registered', ({ point }) => {
    if (point === 'themeToken') applyThemeTokens()
  })
  applyThemeTokens()

  /* ------------------------------------------------------------------ */
  /* 设置与主题                                                          */
  /* ------------------------------------------------------------------ */
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

  function resolveTheme (theme) {
    if (theme === 'light' || theme === 'dark') return theme
    return mediaQuery.matches ? 'dark' : 'light'
  }

  function applyTheme (theme) {
    const resolved = resolveTheme(theme)
    document.documentElement.dataset.theme = resolved
    store.set((state) => ({ ...state, theme: resolved }))
  }

  function applySettings (settings) {
    store.set((state) => ({ ...state, settings: { ...state.settings, ...settings } }))
    applyTheme(settings.theme)
    document.documentElement.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
    engine.setVolume(settings.volume)
    engine.setMuted(settings.muted)
    engine.setRate(settings.playbackRate)
    engine.setPreservesPitch(settings.preservesPitch)
  }

  mediaQuery.addEventListener('change', () => {
    if (store.get().settings.theme === 'system') applyTheme('system')
  })
  remote.theme.onChanged(() => {
    if (store.get().settings.theme === 'system') applyTheme('system')
  })

  remote.settings.onChanged((next) => applySettings(next))

  /* ------------------------------------------------------------------ */
  /* 资料库                                                              */
  /* ------------------------------------------------------------------ */
  async function loadLibrary () {
    const [tracks, state] = await Promise.all([
      remote.library.tracks(),
      remote.library.state()
    ])

    const byId = new Map()
    let totalDuration = 0
    for (const track of tracks) {
      // 预计算搜索串，避免每次输入都重新拼字符串
      // _search 是「歌曲信息」档用的（歌名 / 艺人 / 专辑 / 专辑艺人）
      track._search = normalizeForSearch(
        `${track.title} ${track.artist} ${track.album} ${track.albumArtist}`
      )
      // _deepSearch 是「含歌词等」那一档额外算的：年份、流派、文件名、目录、编码格式
      track._deepSearch = normalizeForSearch([
        track._search,
        track.genre, track.year, track.file, track.dir, track.path,
        track.codec, track.bitrate, track.sampleRate,
        track.lossless ? '无损 lossless flac' : '有损 lossy'
      ].filter(Boolean).join(' '))
      byId.set(track.id, track)
      totalDuration += track.duration || 0
    }

    store.set((prev) => ({
      ...prev,
      library: {
        loaded: true,
        tracks,
        byId,
        folders: state.folders,
        scannedAt: state.stats.scannedAt,
        totalDuration
      }
    }))
    bus.emit(EVENTS.LIBRARY_UPDATED, { count: tracks.length })
    return tracks
  }

  /* ------------------------------------------------------------------ */
  /* 深度搜索：歌词由主进程去读 .lrc                                      */
  /* ------------------------------------------------------------------ */

  /*
   * 歌词不在渲染层：全库几百个 .lrc 文件由主进程读一遍并缓存（按 mtime 失效），
   * 这里只负责防抖调用、把结果按「关键词」标注后交给 store。
   * 标注关键词是必须的：搜索是异步的，输入过程中旧结果会晚到，
   * 拿它去过滤会闪出错误的列表（selectors 里会核对 query 才采信）。
   */
  let lyricsSearchTimer = null
  let lyricsSearchToken = 0

  async function runLyricsSearch (query) {
    const started = performance.now()
    const parts = normalizeForSearch(query).split(/\s+/).filter(Boolean)
    if (!parts.length) return null
    try {
      const result = await remote.library.searchLyrics({ query })
      return {
        query,
        ids: result?.ids || [],
        scanned: result?.scanned || 0,
        matched: result?.matched || 0,
        truncated: Boolean(result?.truncated),
        elapsedMs: result?.elapsedMs ?? Math.round((performance.now() - started) * 100) / 100
      }
    } catch (err) {
      console.warn('[app] 歌词搜索失败', err)
      return { query, ids: [], scanned: 0, matched: 0, error: String(err?.message || err) }
    }
  }

  /** 输入变化 / 切换范围时调用：只有深度档且有词才真的去搜 */
  function requestSearchLyrics ({ immediate = false, scope = null } = {}) {
    const state = store.get()
    const effectiveScope = scope || (state.settings.searchScope === 'deep' ? 'deep' : 'basic')
    const deep = effectiveScope === 'deep'
    const query = state.ui.query
    if (lyricsSearchTimer) {
      clearTimeout(lyricsSearchTimer)
      lyricsSearchTimer = null
    }
    if (!deep || !String(query || '').trim()) {
      if (state.ui.searchLyrics) actions.setSearchLyrics(null)
      return
    }
    // 已经搜过同一个词就不重复劳动
    if (state.ui.searchLyrics && state.ui.searchLyrics.query === query) return

    const run = async () => {
      const token = ++lyricsSearchToken
      // 先亮出「正在搜歌词」，免得用户以为没有结果
      actions.setSearchLyrics({ query, ids: [], scanning: true })
      const result = await runLyricsSearch(query)
      if (token !== lyricsSearchToken) return
      actions.setSearchLyrics(result)
    }
    if (immediate) run()
    else lyricsSearchTimer = setTimeout(run, 260)
  }

  remote.library.onScanProgress((progress) => {
    const scanning = progress.phase !== 'done'
    store.set((state) => ({
      ...state,
      ui: { ...state.ui, scanning, scanProgress: progress }
    }))
    if (progress.phase !== 'done') return

    loadLibrary().then(() => {
      // 只有真的增减了曲目才提示；启动时的增量刷新、什么都没变的重扫都保持安静
      if (!progress.changed) {
        if (progress.reason === 'watch') {
          console.log(`[app] 目录有动静但资料库没有变化（复用缓存 ${progress.reused} 首），不提示`)
        }
        return
      }
      const parts = []
      if (progress.added) parts.push(`新增 ${progress.added} 首`)
      if (progress.removed) parts.push(`移除 ${progress.removed} 首`)
      toast({
        message: `资料库已更新：${parts.join('、')}（共 ${progress.count} 首）`,
        type: 'success',
        duration: 3200
      })
    }).catch((err) => console.error('[app] 刷新资料库失败', err))
  })

  // 目录监听的提示同样只在真的变化时才出现
  remote.library.onWatchUpdate((payload) => {
    if (!payload.added && !payload.removed) {
      console.log('[app] 目录监听：检测到文件变化但曲目未变，保持安静')
      return
    }
    const parts = []
    if (payload.added) parts.push(`新增 ${payload.added} 首`)
    if (payload.removed) parts.push(`移除 ${payload.removed} 首`)
    toast({ message: `音乐目录有变化：${parts.join('、')}`, type: 'info', icon: 'refresh', duration: 3200 })
  })

  remote.library.onWatchError((payload) => {
    console.warn('[app] 目录监听异常:', payload)
  })

  /* ------------------------------------------------------------------ */
  /* 键盘快捷键                                                          */
  /* ------------------------------------------------------------------ */
  function isTextInput (target) {
    if (!(target instanceof HTMLElement)) return false
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
  }

  function bindKeyboard () {
    document.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey

      if (event.key === 'Escape') {
        if (document.querySelector('.menu, .popover')) {
          closeAllLayers()
          event.preventDefault()
          return
        }
        if (store.get().ui.queueOpen) {
          actions.toggleQueue(false)
          event.preventDefault()
          return
        }
        if (store.get().ui.detail && !store.get().ui.nowPlayingOpen) {
          actions.closeDetail()
          event.preventDefault()
          return
        }
        if (store.get().ui.nowPlayingOpen) {
          actions.closeNowPlaying()
          event.preventDefault()
        }
        return
      }

      if (mod && event.key.toLowerCase() === 'f') {
        actions.setView('songs')
        libraryView.focusSearch()
        event.preventDefault()
        return
      }

      if (mod && event.key.toLowerCase() === 'o') {
        actions.addFolder()
        event.preventDefault()
        return
      }

      if (isTextInput(event.target) && !mod) return

      if (mod) {
        switch (event.key) {
          case 'ArrowRight':
            player.next()
            event.preventDefault()
            return
          case 'ArrowLeft':
            player.prev()
            event.preventDefault()
            return
          case 'ArrowUp':
            player.setVolume(Math.min(1, store.get().settings.volume + 0.05))
            event.preventDefault()
            return
          case 'ArrowDown':
            player.setVolume(Math.max(0, store.get().settings.volume - 0.05))
            event.preventDefault()
            return
          case 'l':
          case 'L':
            actions.openNowPlaying({ lyrics: true })
            event.preventDefault()
            return
          case 'q':
          case 'Q':
            actions.toggleQueue()
            event.preventDefault()
            return
          case 'b':
          case 'B':
            actions.toggleSidebar()
            event.preventDefault()
            return
          case 'm':
          case 'M':
            player.toggleMute()
            event.preventDefault()
            return
          default:
            break
        }
      }

      if (event.code === 'Space') {
        player.toggle()
        event.preventDefault()
        return
      }

      if (!mod && store.get().ui.nowPlayingOpen) {
        if (event.key === 'ArrowRight') {
          player.seekBy(5)
          event.preventDefault()
          return
        }
        if (event.key === 'ArrowLeft') {
          player.seekBy(-5)
          event.preventDefault()
          return
        }
      }

      if (!mod && !store.get().ui.nowPlayingOpen) {
        if (event.key === 'm' || event.key === 'M') {
          player.cycleMode()
          event.preventDefault()
          return
        }
        if (event.key === '[') {
          player.setRate(Math.max(0.5, store.get().settings.playbackRate - 0.05))
          event.preventDefault()
          return
        }
        if (event.key === ']') {
          player.setRate(Math.min(2, store.get().settings.playbackRate + 0.05))
          event.preventDefault()
          return
        }
      }
    })
  }

  /* ------------------------------------------------------------------ */
  /* Toast 桥接                                                          */
  /* ------------------------------------------------------------------ */
  bus.on(EVENTS.TOAST, (payload) => toast(payload))

  /* ------------------------------------------------------------------ */
  /* 系统集成指令：系统媒体键 / 托盘菜单 / 任务栏缩略图按钮               */
  /* ------------------------------------------------------------------ */
  function bindSystemCommands () {
    const handlers = {
      'play-pause': () => player.toggle(),
      play: () => player.play(),
      pause: () => player.pause(),
      next: () => player.next(),
      previous: () => player.prev(),
      stop: () => player.pause()
    }
    remote.media.onCommand((command) => {
      const handler = handlers[command]
      if (handler) handler()
      else console.warn('[app] 未知的播放指令:', command)
    })
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */
  async function boot () {
    if (!isElectron) {
      toast({ message: '当前不在 Electron 中运行，功能不可用', type: 'error', duration: 8000 })
      return
    }

    const info = await remote.app.info()
    const settings = await remote.settings.get()

    document.documentElement.dataset.platform = info.platform
    store.set((state) => ({
      ...state,
      ready: true,
      app: { info, platform: info.platform, isMac: info.isMac }
    }))

    applySettings(settings)

    player.init()
    player.setMode(settings.playbackMode)

    const tracks = await loadLibrary()

    // 恢复上次播放的曲目（只加载不播放，避免一启动就出声）
    if (settings.lastTrackPath) {
      const track = tracks.find((item) => item.path === settings.lastTrackPath)
      if (track) {
        playlist.sync([track.id], { keepId: track.id })
        player.prepare(track.id)
        const list = libraryView.tracks.map((item) => item.id)
        if (list.includes(track.id)) {
          playlist.sync(list, { keepId: track.id })
        }
      }
    }

    // 空资料库时直接把设置页推到用户面前
    if (!tracks.length && !settings.folders.length) {
      actions.setView('settings')
    }

    // 资料库就绪后开始后台预热封面（会在界面忙时自动让路）
    if (tracks.length) prewarmer.start()
  }

  bindKeyboard()
  bindSystemCommands()

  boot().catch((err) => {
    console.error('[app] 启动失败', err)
    toast({ message: `启动失败：${err.message}`, type: 'error', duration: 8000 })
  })

  /* 调试与二次开发入口：开发者工具控制台里可以直接用 window.__aria */
  window.__aria = {
    bus, store, player, engine, playlist, host, artwork, actions, EVENTS, prewarmer,
    // 视图组件：自检与调试会用到（例如媒体墙的 debugState / 平移）
    views: { libraryView, browseView, mediaWall, settingsView, playerBar, nowPlayingPanel, queuePanel }
  }
}

main().catch((err) => {
  console.error(err)
  document.body.textContent = `启动失败：${err.message}`
})
