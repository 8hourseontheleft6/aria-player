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
import { normalizeForSearch, isMacOS, describeUnreadable } from './core/format.js'
import { createAudioEngine } from './core/audio-engine.js'
import { resolveReplayGainDb } from './core/replaygain.js'
import { matchPreset, matchByMetadata, PRESETS } from './core/equalizer-presets.js'
import { analyzeTrack, cachedAnalysis, analyzeBuffer, classifyStyle } from './core/style-analyzer.js'
import { classifyWithAi, cachedAiStyle, parseAnswer } from './core/ai-style.js'
import { createPlaylist } from './core/playlist.js'
import { createPluginHost } from './core/plugin-host.js'
import { registerBuiltinModes } from './core/playback-modes.js'
import { createArtworkService } from './core/artwork.js'
import { createPlayerController } from './core/player-controller.js'
import { createLibraryIndex, splitArtists } from './core/grouping.js'
import { createBackgroundRelease } from './core/background-release.js'
import {
  PLAYLIST_LIMIT,
  normalizePlaylists,
  findPlaylist,
  makePlaylist,
  tracksOf,
  renamePlaylist as renamePlaylistIn,
  removePlaylist as removePlaylistFrom,
  addTracks as addTracksToPlaylistIn,
  removeTrack as removeTrackFromPlaylistIn
} from './core/playlists.js'
import { selectVisibleTracks } from './core/selectors.js'
import { createArtworkPrewarmer } from './core/artwork-prewarm.js'

import { createTitlebar } from './ui/panels/titlebar.js'
import { createSidebar } from './ui/panels/sidebar.js'
import { createLibraryView } from './ui/views/library-view.js'
import { createBrowseView } from './ui/views/browse-view.js'
import { createMediaWall } from './ui/views/media-wall.js'
import { createSettingsView } from './ui/views/settings-view.js'
import { createPlayerBar } from './ui/panels/player-bar.js'
import { createNowPlayingPanel } from './ui/panels/now-playing-panel.js'
import { createQueuePanel } from './ui/panels/queue-panel.js'
import { createTrackMenu } from './ui/menus/track-menu.js'
import { createDropZone } from './ui/widgets/drop-zone.js'
import { createResizeHandles } from './ui/widgets/resize-handles.js'
import { createLazyArtwork } from './ui/widgets/artwork-node.js'
import { toast, closeAllLayers } from './ui/widgets/overlay.js'
import { createFpsOverlay } from './ui/widgets/fps-overlay.js'

import { BUILTIN_PLUGINS, pluginsForProfile } from './plugins/index.js'

const SORT_KEYS = ['default', 'title', 'artist', 'album', 'duration', 'year', 'added']
/** 搜索历史最多留这么多条（新的在前） */
const SEARCH_HISTORY_LIMIT = 10

/*
 * 产品档位（由 preload 从命令行同步带过来，见 src/main/profile.js）。
 * 拿不到就按本体：缺信息时把功能弄丢，比多留几个更糟。
 */
const PROFILE = (window.aria && window.aria.profile) || {
  id: 'full',
  productName: 'Aria',
  plugins: BUILTIN_PLUGINS.map((plugin) => plugin.id),
  capabilities: { library: true, online: true, lyrics: true, sources: true },
  sidebar: ['songs', 'albums', 'artists', 'wall']
}

async function main () {
  /*
   * 「打开的文件」投递：**在任何 await 之前**就把监听挂上。
   *
   * 冷启动带文件时，主进程在 did-finish-load 之后立刻推 opened:incoming ——
   * 那时渲染层的 main() 可能还在等 settings / 最近打开这些 await，订阅还没建立，
   * 事件就丢了（现象：进程起来了、recent.json 有记录、列表和播放都是空的）。
   * 兜底 PROFILE 也带 capabilities，所以这里先按能力判断；
   * 收到的载荷先排队，等 actions 就绪（下面 openedSink 赋值处）再按顺序处理。
   */
  const pendingOpened = []
  let openedSink = null
  if (remote.opened) {
    remote.opened.onIncoming((payload) => {
      if (openedSink) openedSink(payload)
      else pendingOpened.push(payload)
    })
  }

  /* ------------------------------------------------------------------ */
  /* 基础服务                                                            */
  /* ------------------------------------------------------------------ */
  const bus = createBus()
  const store = createStore(initialState(PROFILE))
  const engine = createAudioEngine({ bus })
  const playlist = createPlaylist()
  const host = createPluginHost({
    bus,
    store,
    services: { engine, playlist, remote }
  })
  const artwork = createArtworkService({ bus, host, store })

  registerBuiltinModes(host)
  /*
   * 按档位注册插件 —— 这是"能力开关"的唯一落点：
   * online-media 不注册，在线歌词 / 在线封面在渲染层就没人提供（扩展点空着），
   * 而不是"实现了但用 if 关掉"。player 档位的 plugins 是空数组，于是什么都不注册。
   */
  host.loadAll(pluginsForProfile(PROFILE.plugins))

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
    // 搜索词也传进去：名字命中的专辑/艺人要排到前面（见 grouping.js 的 rankByName）
    return libraryIndex.get(visibleTracks(), store.get().ui.query)
  }

  /** 封面后台预热：空闲时把封面灌进主进程的磁盘缓存，让媒体墙秒出图 */
  let lazyArtwork = null

  /**
   * 「最小化已释放」标志。
   * 媒体墙要据此拒绝重建 —— 释放之后任何一次 store / 资料库变化都会走到
   * refresh()，不拦的话刚拆掉的 474 个格子立刻又建回来了（自检抓到过）。
   */
  const backgroundState = { released: false }
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
  /** 换视图 / 换来源 / 换搜索词时都要清掉多选：列表已经不是同一批歌了 */
  const clearedSelection = { selection: [], selectionAnchor: null, selecting: false }

  const actions = {
    setView (view) {
      store.set((state) => ({
        ...state,
        ui: {
          ...state.ui,
          view,
          ...clearedSelection,
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
          ...clearedSelection,
          detail: null,
          view: state.ui.view === 'settings' ? 'songs' : state.ui.view
        }
      }))
    },

    /* ---------- 多选 ---------- */

    /**
     * 整批替换选择。
     * @param {string[]} ids
     * @param {string|null} anchor 范围选择的锚点（Shift 点选时用）
     */
    setSelection (ids, anchor = null) {
      const selection = Array.isArray(ids) ? ids.filter(Boolean) : []
      store.set((state) => ({
        ...state,
        ui: {
          ...state.ui,
          selection,
          selectionAnchor: anchor && selection.includes(anchor)
            ? anchor
            : (selection.length ? selection[selection.length - 1] : null),
          // 多选模式只在「本来就开着 且 还有勾选项」时保留：
          // 全部取消勾选之后就自动退出，不会留在「开着但一个没选」的中间态
          selecting: state.ui.selecting === true && selection.length > 0
        }
      }))
    },

    /** Ctrl/Cmd 点选：加进选择或从中移除，锚点跟着走（顺带进入多选模式） */
    toggleSelection (id) {
      const selection = store.get().ui.selection
      const next = selection.includes(id) ? selection.filter((value) => value !== id) : [...selection, id]
      actions.setSelection(next, id)
      store.set((state) => ({ ...state, ui: { ...state.ui, selecting: true } }))
    },

    /**
     * 显式进入多选模式（右键菜单「开始多选」、点行首的勾选框走这里）。
     * 「多选」是一个单独的操作，不是点着点着就悄悄进去了 ——
     * 普通点击永远只是「选中这一首」。
     */
    startSelection (trackId = null) {
      const current = store.get().ui.selection
      const selection = trackId
        ? (current.includes(trackId) ? current.slice() : [trackId])
        : current.slice()
      store.set((state) => ({
        ...state,
        ui: {
          ...state.ui,
          selection,
          selectionAnchor: trackId || state.ui.selectionAnchor,
          selecting: true
        }
      }))
    },

    clearSelection () {
      if (!store.get().ui.selection.length && !store.get().ui.selecting) return
      store.set((state) => ({ ...state, ui: { ...state.ui, ...clearedSelection } }))
    },

    /** 当前页面（歌曲列表 / 专辑详情 / 艺人详情）显示的那一批曲目 */
    currentListTracks () {
      const { ui } = store.get()
      if (ui.detail?.type === 'album') return actions.albumByKey(ui.detail.key)?.tracks || []
      if (ui.detail?.type === 'artist') return actions.artistByKey(ui.detail.key)?.tracks || []
      return visibleTracks()
    },

    /** 当前这批选择对应的曲目（顺序按列表里的顺序，不是点击顺序） */
    selectedTracks (order = null) {
      const selection = new Set(store.get().ui.selection)
      if (!selection.size) return []
      const source = Array.isArray(order) ? order : actions.currentListTracks()
      return source.filter((track) => selection.has(track.id))
    },

    /** 选中的歌曲进队列：next = 插到当前曲目之后，end = 追加到末尾 */
    queueSelection (mode = 'next', order = null) {
      const tracks = actions.selectedTracks(order)
      if (!tracks.length) return 0
      const ids = tracks.map((track) => track.id)
      if (mode === 'next') player.playNext(ids)
      else player.appendToQueue(ids)
      actions.clearSelection()
      return ids.length
    },

    /** 播放选中的这些（顺序按列表顺序） */
    playSelection (order = null) {
      const tracks = actions.selectedTracks(order)
      if (!tracks.length) return
      player.playCollection(tracks.map((track) => track.id), tracks[0].id)
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

    /* ---------------- 自建播放列表 ---------------- */

    playlists () {
      return normalizePlaylists(store.get().settings.playlists)
    },

    playlistTracks (id) {
      const playlist = findPlaylist(this.playlists(), id)
      return tracksOf(playlist, store.get().library.byId)
    },

    async createPlaylist (name) {
      const playlists = this.playlists()
      if (playlists.length >= PLAYLIST_LIMIT) {
        toast({ message: `播放列表最多 ${PLAYLIST_LIMIT} 个`, type: 'info' })
        return null
      }
      const playlist = makePlaylist(name)
      await actions.setSetting({ playlists: [...playlists, playlist] })
      return playlist
    },

    /**
     * 把当前播放列表导出成 m3u（T2.2）。
     *
     * 路径由主进程写成"相对 m3u 文件所在目录"（跨盘才退回绝对路径）——
     * 这样把 m3u 和音乐一起拷到别的机器也能用。
     */
    async exportCurrentPlaylistM3u () {
      const state = store.get()
      const id = state.ui.source && state.ui.source.type === 'playlist' ? state.ui.source.value : null
      const playlist = id ? findPlaylist(actions.playlists(), id) : null
      if (!playlist) {
        toast({ message: '先打开一个播放列表，再导出', type: 'info' })
        return { saved: false }
      }
      const tracks = tracksOf(playlist, state.library.byId)
      if (!tracks.length) {
        toast({ message: '这个播放列表还是空的', type: 'info' })
        return { saved: false }
      }
      const result = await remote.playlist.exportM3u({
        name: playlist.name,
        tracks: tracks.map((track) => ({
          path: track.path,
          title: track.title,
          artist: track.artist,
          duration: track.duration
        }))
      })
      if (result && result.saved) {
        toast({
          message: `已导出 ${result.count} 首（${result.relative} 首相对路径${result.absolute ? `，${result.absolute} 首绝对路径` : ''}）`,
          type: 'success'
        })
      }
      return result
    },

    /**
     * 从 m3u 导入成一个新播放列表（T2.2）。
     *
     * 只把"已经在资料库里的"对进去（按 path 精确匹配）—— 不在资料库的曲目没有曲目对象，
     * 硬塞进来会得到一堆播不了的条目。没命中的在 toast 里报数并给下一步提示。
     * `file` 只给自检用（不传就弹文件对话框）。
     */
    async importPlaylistM3u ({ file = '' } = {}) {
      const result = await remote.playlist.importM3u({ file })
      if (!result || !result.imported) return { imported: false }

      const state = store.get()
      const byPath = new Map(state.library.tracks.map((track) => [track.path, track.id]))
      const ids = []
      for (const entry of result.entries) {
        const id = byPath.get(entry.path)
        if (id) ids.push(id)
      }
      const notInLibrary = result.entries.length - ids.length

      const playlist = makePlaylist(result.name || '导入的播放列表')
      const next = ids.length
        ? addTracksToPlaylistIn([...actions.playlists(), { ...playlist, trackIds: [] }], playlist.id, ids).playlists
        : [...actions.playlists(), playlist]
      await actions.setSetting({ playlists: next })
      actions.setSource({ type: 'playlist', value: playlist.id })

      const parts = [`导入 ${ids.length} 首`]
      if (result.missing) parts.push(`${result.missing} 个文件不存在`)
      if (result.skipped) parts.push(`${result.skipped} 个不是可播格式`)
      if (notInLibrary) parts.push(`${notInLibrary} 首不在音乐文件夹里（先把所在文件夹加入资料库再导入）`)
      toast({ message: parts.join('，'), type: ids.length ? 'success' : 'info' })
      return { imported: true, added: ids.length, notInLibrary, missing: result.missing, skipped: result.skipped }
    },

    async renamePlaylist (id, name) {
      const playlists = renamePlaylistIn(this.playlists(), id, name)
      await actions.setSetting({ playlists })
      return findPlaylist(playlists, id)
    },

    async deletePlaylist (id) {
      const playlists = removePlaylistFrom(this.playlists(), id)
      await actions.setSetting({ playlists })
      // 正在看这个列表的话，回到全部歌曲，别停在一个已经不存在的来源上
      if (store.get().ui.source.type === 'playlist' && store.get().ui.source.value === id) {
        actions.setSource({ type: 'all', value: null })
      }
    },

    /** 把一批曲目加进播放列表（已在里面的不重复加） */
    async addTracksToPlaylist (id, trackIds, { silent = false } = {}) {
      const ids = (Array.isArray(trackIds) ? trackIds : [trackIds]).filter(Boolean)
      if (!ids.length) return { added: 0, skipped: 0 }
      const result = addTracksToPlaylistIn(this.playlists(), id, ids)
      await actions.setSetting({ playlists: result.playlists })
      if (!silent) {
        const playlist = findPlaylist(result.playlists, id)
        const name = playlist ? playlist.name : '播放列表'
        const message = result.added
          ? `已添加 ${result.added} 首到「${name}」${result.skipped ? `（${result.skipped} 首已在列表里）` : ''}`
          : `这些歌都已经在「${name}」里了`
        bus.emit(EVENTS.TOAST, { message, type: result.added ? 'success' : 'info' })
      }
      return result
    },

    async removeTrackFromPlaylist (id, trackId) {
      const playlists = removeTrackFromPlaylistIn(this.playlists(), id, trackId)
      await actions.setSetting({ playlists })
    },

    openPlaylist (id) {
      actions.setSource({ type: 'playlist', value: id })
      actions.setView('songs')
    },

    /** 播放整个自建播放列表（顺序就是列表里的顺序） */
    playPlaylist (id, startTrackId = null) {
      const tracks = actions.playlistTracks(id)
      if (!tracks.length) {
        toast({ message: '这个播放列表还是空的', type: 'info' })
        return
      }
      if (store.get().playback.mode === 'shuffle') player.setMode('loop-list')
      const start = startTrackId ? tracks.find((track) => track.id === startTrackId) : null
      player.playCollection(tracks.map((track) => track.id), (start || tracks[0]).id)
    },

    shufflePlaylist (id) {
      const tracks = actions.playlistTracks(id)
      if (!tracks.length) {
        toast({ message: '这个播放列表还是空的', type: 'info' })
        return
      }
      player.setMode('shuffle')
      player.playCollection(tracks.map((track) => track.id), tracks[Math.floor(Math.random() * tracks.length)].id)
    },

    /** 当前是不是正在看某个自建播放列表 */
    currentPlaylist () {
      const { ui } = store.get()
      if (ui.source.type !== 'playlist') return null
      return findPlaylist(actions.playlists(), ui.source.value)
    },

    setQuery (query) {
      store.set((state) => ({ ...state, ui: { ...state.ui, query, ...clearedSelection } }))
      // 深度搜索时歌词要问主进程，这里跟着防抖触发
      requestSearchLyrics()
      // 在线音源搜索同样防抖；总开关没开时它自己会清空结果
      requestOnlineSearch()
    },

    /** 在线音源搜索结果落 store（界面按关键词核对后再显示） */
    setOnlineSearch (result) {
      store.set((state) => ({ ...state, ui: { ...state.ui, onlineSearch: result } }))
    },

    /** 自检用：立刻跑一次在线音源搜索（不走防抖） */
    async searchOnlineNow (query = store.get().ui.query) {
      requestOnlineSearch({ immediate: true })
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const state = store.get().ui.onlineSearch
        if (state && state.query === query && state.status !== 'loading') return state
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return store.get().ui.onlineSearch
    },

    /** 解析一条在线结果的播放地址（播放/下载都由它兜底） */
    async resolveOnlineUrl (item) {
      return remote.sources.resolve(item || {})
    },

    /** 播放一条在线结果（解析直链 → 合成曲目 → 走正常播放流程 → 歌词照常加载） */
    playOnlineItem (item) {
      return playOnlineItem(item)
    },

    /** 下载一条在线结果到「默认目录」或指定目录 */
    async downloadOnlineItem (item, dir = '') {
      if (!item) return null
      const uid = item.uid || `${item.sourceId}:${item.sourceTrackId}`
      const patch = (next) => store.set((state) => ({
        ...state,
        ui: {
          ...state.ui,
          downloads: { ...(state.ui.downloads || {}), [uid]: { ...(state.ui.downloads?.[uid] || {}), ...next } }
        }
      }))
      patch({ status: 'running', percent: null, received: 0, total: 0 })
      try {
        const result = await remote.sources.download({ ...item, uid, dir: dir || undefined })
        patch({ status: 'done', percent: 100, path: result.path, dir: result.dir, bytes: result.bytes })
        toast({
          message: `已下载「${item.title}」到 ${result.dir}${result.inLibrary ? '（在资料库目录里，稍后会自动入库）' : ''}`,
          type: 'success',
          duration: 4200
        })
        return result
      } catch (err) {
        const message = String(err?.message || err)
        patch({ status: 'error', error: message })
        toast({ message: `下载失败：${message}`, type: 'error', duration: 4600 })
        return null
      }
    },

    /** 自检用：当前会话里合成出来的在线曲目 */
    listOnlineTracks: () => listOnlineTracks().map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      sourceName: track.sourceName,
      onlineUrl: track.onlineUrl
    })),

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

    /*
     * 设置页的搜索历史（与资料库搜索历史分开存，见 settings.js 的注释）。
     * 同样只在「真的用了一次搜索」时记录，避免被 "t"/"ta" 这种半截词塞满。
     */
    commitSettingsSearch (query) {
      const trimmed = String(query || '').trim()
      if (!trimmed) return null
      const history = store.get().settings.settingsSearchHistory || []
      const next = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, SEARCH_HISTORY_LIMIT)
      return actions.setSetting({ settingsSearchHistory: next })
    },

    removeSettingsSearch (query) {
      const history = store.get().settings.settingsSearchHistory || []
      return actions.setSetting({ settingsSearchHistory: history.filter((item) => item !== query) })
    },

    clearSettingsSearchHistory () {
      return actions.setSetting({ settingsSearchHistory: [] })
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
      // 来自歌词搜索结果的话，记下要跳的那一句（等这一首就绪后再 seek）
      scheduleLyricSeek(track)
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
      if (!track.path) {
        toast({ message: '在线音源没有本地文件可定位', type: 'info', duration: 2600 })
        return
      }
      remote.library.reveal(track.path).then((result) => {
        if (result && result.ok === false) {
          toast({ message: result.message || '文件不在了（可能被移动或删除）', type: 'error', duration: 3600 })
        }
      }).catch(() => {})
    },

    /** 复制本地文件路径（在线音源给一句说明，不复制假的路径） */
    async copyTrackPath (track) {
      if (!track) return
      if (!track.path) {
        toast({ message: '在线音源没有本地路径可复制', type: 'info', duration: 2600 })
        return
      }
      const result = await remote.files.copyPath(track.path).catch(() => null)
      toast({
        message: result && result.ok ? '已复制文件路径' : '复制失败，剪贴板不可用',
        type: result && result.ok ? 'success' : 'error',
        duration: 2400
      })
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

    openTrackMenu (track, event, options = {}) {
      trackMenu.open(track, event, options)
    },

    /**
     * 把一批**已经解析好的曲目**收进当前列表（player 档位的"打开的文件"用它）。
     *
     * 为什么需要单独一个 action：player 没有资料库，`loadLibrary()` 被能力短路掉了，
     * 曲目是"用户这次打开的那些文件"，由主进程解析好送上来。这里做的规范化
     * （_search / _deepSearch 预计算、byId、时长合计）与 loadLibrary 完全一致，
     * 所以列表、搜索、队列、播放这些下游一件都不用改 —— 它们只认"一份曲目数组"。
     */
    ingestOpenedTracks (tracks, { replace = false } = {}) {
      const list = (Array.isArray(tracks) ? tracks : []).filter((track) => track && track.id)
      if (!list.length && !replace) return { count: 0 }
      const previous = replace ? [] : store.get().library.tracks
      const merged = new Map()
      for (const track of previous) merged.set(track.id, track)
      for (const track of list) {
        // 与 loadLibrary 同一套预计算：搜索要用，缺了这两项深度搜索就不准
        track._search = normalizeForSearch(`${track.title} ${track.artist} ${track.album} ${track.albumArtist}`)
        track._deepSearch = normalizeForSearch([
          track._search,
          track.genre, track.year, track.file, track.dir, track.path
        ].filter(Boolean).join(' '))
        merged.set(track.id, track)
      }
      const all = [...merged.values()]
      const byId = new Map(all.map((track) => [track.id, track]))
      const totalDuration = all.reduce((sum, track) => sum + (track.duration || 0), 0)
      store.set((state) => ({
        ...state,
        library: { ...state.library, loaded: true, tracks: all, byId, totalDuration }
      }))
      bus.emit(EVENTS.LIBRARY_UPDATED, { count: all.length })
      return { count: list.length, total: all.length }
    },

    /** player 档位启动时载入「最近打开」 */
    async loadRecentOpened () {
      if (!remote.opened) return { count: 0 }
      const result = await remote.opened.recent()
      if (result && result.tracks) actions.ingestOpenedTracks(result.tracks)
      return {
        count: result && result.tracks ? result.tracks.length : 0,
        missing: result && result.missing ? result.missing.length : 0,
        total: result && result.total ? result.total : 0
      }
    },

    /**
     * 一键清除「最近打开」历史（player 档位）。
     *
     * 三件事一起做，缺一件就会留下怪状态：
     *   ① 主进程清掉 recent.json（**不动任何音频文件**，只是这份清单）；
     *   ② 列表清空（列表就是这个历史本身）；
     *   ③ 播放停下并回到空状态 —— 否则会出现"列表空了但还在放上一首"。
     */
    async clearOpenedHistory () {
      if (!remote.opened) return { cleared: 0 }
      const result = await remote.opened.clear()
      const cleared = result && Number.isFinite(result.cleared) ? result.cleared : 0
      try {
        player.pause()
      } catch {
        /* 没有正在播放的曲目时 pause 可能直接返回，忽略 */
      }
      playlist.sync([])
      store.set((state) => ({
        ...state,
        library: { ...state.library, loaded: true, tracks: [], byId: new Map(), totalDuration: 0 },
        playback: {
          ...state.playback,
          trackId: null,
          status: 'idle',
          position: 0,
          duration: 0,
          queue: [],
          queueIndex: -1
        }
      }))
      bus.emit(EVENTS.LIBRARY_UPDATED, { count: 0 })
      /*
       * toast 的签名是 toast({ message, type, icon, duration }) —— 收**对象**。
       * 之前传了字符串，解构出来 message 是 undefined，于是提示框里只有一颗图标、没有字。
       */
      toast({ message: `已清除 ${cleared} 条历史记录（音频文件没有被删除）`, type: 'success' })
      return { cleared }
    },

    /** 打开文件 / 打开文件夹（player 档位）—— 解析完成后收进列表并播放第一首 */
    async openFromDisk (mode) {
      if (!remote.opened) return { action: 'unsupported' }
      const result = await remote.opened.pick(mode)
      if (!result || result.action === 'cancelled') return { action: 'cancelled' }
      if (result.tracks && result.tracks.length) {
        actions.ingestOpenedTracks(result.tracks)
        actions.playDroppedTracks(result.trackIds)
      } else {
        toast({ message: '没有可播放的音频文件', type: 'error' })
      }
      return result
    },

    /**
     * 处理一次"打开/拖入"的结果（主进程返回的统一形状）。
     *
     * 拖放浮层与「打开文件」按钮都走这里，自检也直接调它 —— 于是
     * "主进程解析 → 收进列表 → 播放"这条链只写一遍，测的也就是真正跑的那条。
     * 判据是"结果里带不带 tracks"（数据驱动）：本体的 resolveDrop 不返回 tracks，
     * 这里就只做播放那一步，行为与改动前完全一致。
     */
    applyDropResult (result) {
      if (!result || result.action === 'cancelled') return { played: false }
      if (Array.isArray(result.tracks) && result.tracks.length) {
        actions.ingestOpenedTracks(result.tracks)
      }
      if (result.action === 'play' && Array.isArray(result.trackIds) && result.trackIds.length) {
        actions.playDroppedTracks(result.trackIds)
        return { played: true, count: result.trackIds.length }
      }
      return { played: false }
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

    /**
     * 切换音频输出设备（通话 / 游戏语音场景的关键）。
     *
     * 把音乐送到耳机、通话留在原设备：麦克风拾不到音乐，通话对方就听不到 ——
     * 不需要虚拟声卡，也不用把音乐调小。设备被拔掉时 setSinkId 会失败，
     * 引擎自己回退到系统默认，这里把设置也改回去并提示。
     */
    async setOutputDevice (deviceId) {
      const id = deviceId || ''
      const result = await engine.setOutputDevice(id)
      await actions.setSetting({ audioOutputDevice: result.ok ? id : '' })
      if (!result.ok) {
        bus.emit(EVENTS.TOAST, { message: result.message, type: 'error', duration: 4200 })
      }
      return result
    },

    /**
     * 声音均衡器。
     *
     * @param {object} patch { enabled?, auto?, preset? }
     * @returns {object|null} 应用后的参数快照
     */
    setEqualizer (patch = {}) {
      const current = store.get().settings.equalizer || { enabled: false, auto: true, preset: 'flat' }
      const next = { ...current, ...patch }
      store.set((state) => ({ ...state, settings: { ...state.settings, equalizer: next } }))
      remote.settings.set({ equalizer: next }).catch(() => {})
      return actions.applyEqualizer()
    },

    /**
     * 设置响度归一化模式。
     *
     * @param {'off'|'track'|'album'} mode
     * @returns {{ db: number, gain: number, active: boolean }}
     */
    setReplayGain (mode) {
      const next = mode === 'track' || mode === 'album' ? mode : 'off'
      store.set((state) => ({ ...state, settings: { ...state.settings, replayGain: next } }))
      remote.settings.set({ replayGain: next }).catch(() => {})
      return actions.applyReplayGain()
    },

    /**
     * 响度归一化（ReplayGain）。
     * 设置改成 'off' 时把增益放回 1 并**不建图**，播放路径与没开这个功能时一致。
     */
    applyReplayGain () {
      const state = store.get()
      const mode = state.settings.replayGain
      const track = state.library.byId.get(state.playback.trackId) || null
      return engine.setReplayGain(resolveReplayGainDb(mode, track))
    },

    /**
     * 把当前设置落到引擎上。
     * 自动模式下按「正在播放的那首歌」挑预设：标签优先、音频分析兜底
     * （分析是异步的，算完会自己再调一次这里）。
     */
    applyEqualizer () {
      const state = store.get()
      const config = state.settings.equalizer || { enabled: false, auto: true, preset: 'flat' }
      if (!config.enabled) return engine.setEqualizer('flat', { enabled: false })

      const track = state.library.byId.get(state.playback.trackId) || null
      let key = config.preset || 'flat'
      if (config.auto) {
        const analysis = state.settings.styleAnalysis === false ? null : cachedAnalysis(state.playback.trackId)
        const aiStyle = aiStyleEnabled() ? cachedAiStyle(state.playback.trackId) : null
        // 优先级：外部模型（它能看到歌名/专辑这些本地算不出的线索）> 声音特征 > 标签
        const matched = aiStyle?.key || matchPreset(track, analysis)
        if (matched) key = matched
        // 还没分析过就补一次；算完再应用（analyzing 里的去重避免来回触发）
        if (!analysis && track && state.settings.styleAnalysis !== false) {
          analyzeEqualizerTrack(track)
        }
        // 开了外部模型且还没问过，就把「特征 + 曲目信息」发过去问一次
        if (!aiStyle && track && aiStyleEnabled()) {
          askAiForStyle(track, analysis)
        }
      }
      return engine.setEqualizer(key, { enabled: true })
    },

    /** 当前生效预设的判定依据（设置页与全屏播放页都用它做说明） */
    equalizerBasis () {
      const state = store.get()
      const track = state.library.byId.get(state.playback.trackId) || null
      const analysis = cachedAnalysis(state.playback.trackId)
      return {
        preset: engine.equalizerSnapshot()?.preset || 'off',
        // 十段增益（设置页画频响形状用）
        bands: engine.equalizerSnapshot()?.bands || [],
        byMetadata: matchByMetadata(track),
        byAudio: analysis ? { key: analysis.key, confidence: analysis.confidence, features: analysis.features } : null,
        byAi: aiStyleEnabled() ? cachedAiStyle(state.playback.trackId) : null
      }
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
  const mediaWall = createMediaWall({
    store,
    bus,
    player,
    actions,
    // 传 artwork：媒体墙要用它筛掉没有封面的专辑
    artwork,
    lazy: lazyArtwork,
    isBackgroundReleased: () => backgroundState.released
  })
  const settingsView = createSettingsView({ store, bus, player, actions, host })
  const playerBar = createPlayerBar({ store, bus, player, artwork, actions })
  const nowPlayingPanel = createNowPlayingPanel({ store, bus, player, engine, artwork, host, actions })
  const queuePanel = createQueuePanel({ store, bus, player, artwork, actions })
  const dropZone = createDropZone({ bus, actions })
  const fpsOverlay = createFpsOverlay({ store })

  dom.titlebar.replaceWith(titlebar.element)
  dom.sidebar.replaceWith(sidebar.element)
  dom.content.append(libraryView.element, browseView.element, mediaWall.element, settingsView.element, queuePanel.element)
  dom.playerBar.replaceWith(playerBar.element)
  dom.nowPlaying.replaceWith(nowPlayingPanel.element)
  /*
   * 窗口边缘的缩放把手：挂在 body 上（position: fixed，不参与布局），
   * 不放进 .app 里 —— .app 自己有层叠上下文，放进去会被全屏播放页盖住。
   */
  const resizeHandles = createResizeHandles()
  document.body.appendChild(resizeHandles.element)

  document.getElementById('layer-root').appendChild(dropZone.element)
  document.getElementById('layer-root').appendChild(fpsOverlay.element)

  /*
   * 队列面板挂在哪：全屏播放页打开时挂进播放页里，否则挂回内容区。
   *
   * 为什么必须挪：`.app` 自己带着 `z-index: 1`，是一个层叠上下文，
   * 而全屏播放页是它的兄弟、`z-index: 40` —— 于是整个 app 子树都在播放页下面，
   * 队列面板自己把 z-index 抬到 45 也没用（实测确实被压住，用户看到的就是
   * 「全屏里点队列按了没反应，退出全屏才看得到」）。挂进播放页后就跟它同层了。
   */
  function mountQueuePanel () {
    const state = store.get()
    const host = state.ui.nowPlayingOpen ? nowPlayingPanel.element : dom.content
    if (queuePanel.element.parentElement !== host) host.appendChild(queuePanel.element)
  }
  store.select((state) => `${state.ui.nowPlayingOpen}|${state.ui.queueOpen}`, mountQueuePanel)

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

  /**
   * 用当前设置给"正在播放的那首"重新取一次主题色。
   * 只在「主题色来源」这个设置变化时调用 —— 换歌时由 player-controller 自己取。
   */
  function retintCurrentTrack () {
    const state = store.get()
    const track = state.playback.trackId ? state.library.byId.get(state.playback.trackId) : null
    if (!track) return
    artwork.resolveColor(track)
      .then((color) => { if (color) artwork.applyTint(color) })
      .catch(() => { /* 取色失败就保持现有颜色，不打断播放 */ })
  }

  function applySettings (settings) {
    store.set((state) => ({ ...state, settings: { ...state.settings, ...settings } }))
    applyTheme(settings.theme)
    document.documentElement.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false'
    engine.setVolume(settings.volume)
    engine.setMuted(settings.muted)
    engine.setRate(settings.playbackRate)
    engine.setPreservesPitch(settings.preservesPitch)
    // 均衡器设置变了就落到引擎（自动模式下按当前曲目挑预设）
    actions.applyEqualizer()
    // 响度归一化同理（关掉时这里只是把增益放回 1，不会建图）
    actions.applyReplayGain()
    /*
     * 主题色来源（封面 / 稳定配色）变了：立刻重新取色。
     * 不重新取的话要等下一首歌才生效 —— 用户会以为这个开关坏了。
     */
    if (settings.tintSource) retintCurrentTrack()
  }

  mediaQuery.addEventListener('change', () => {
    if (store.get().settings.theme === 'system') applyTheme('system')
  })
  remote.theme.onChanged(() => {
    if (store.get().settings.theme === 'system') applyTheme('system')
  })

  /*
   * 首次播放后再补上均衡器。
   *
   * 开关是持久化的，但音频图不能在启动时就建：建了它播放路径就交给 WebAudio，
   * 而那时还没有任何用户手势，AudioContext 只能挂起（等于没声音）。
   * 所以记一笔「待应用」，等真的播起来（用户手势已经发生）再落地。
   */
  store.select((state) => state.playback.status === 'playing', (playing) => {
    if (!playing) return
    if (pendingEqualizer) {
      pendingEqualizer = false
      actions.applyEqualizer()
    }
    // 归一化只在需要真加增益时才建图，所以每首歌播起来都补一次
    actions.applyReplayGain()
  })

  /* ------------------------------------------------------------------ */
  /* 在线音源：把网络结果变成「能播的曲目」                                */
  /* ------------------------------------------------------------------ */

  /*
   * 在线结果不是资料库里的曲目，但播放器、播放条、正在播放页都按 trackId 去
   * library.byId 里取对象。所以这里造一个「合成曲目」塞进那张表：
   *   · 只有 id 带 online: 前缀、并且带 onlineUrl，播放时走直链（见 core/media-url.js）；
   *   · 不进 library.tracks，所以不会污染歌曲列表 / 专辑 / 媒体墙；
   *   · loadLibrary() 会整表替换，所以每次载入后要重新塞一遍。
   */
  const onlineTracks = new Map()

  /** 均衡器开着但音频图还没建（等第一次播放的用户手势），见文件末尾的说明 */
  let pendingEqualizer = false

  /** 正在做音频分析的曲目（同一首别重复算） */
  const analyzing = new Set()

  /**
   * 分析一首曲目的声音特征，算完把均衡器重算一遍。
   *
   * 为什么值得：本地库里一大半文件没有流派标签，光看元数据自动均衡几乎不生效；
   * 解码 30 秒算三个特征（低音占比 / 过零率 / 峰值因数）就能给出一个靠谱的风格。
   * 分析失败一律静默 —— 它只是锦上添花，不该影响播放。
   */
  async function analyzeEqualizerTrack (track) {
    if (!track?.id || analyzing.has(track.id)) return
    analyzing.add(track.id)
    try {
      // 注意：这里不传引擎的上下文 —— 那会把音频图提前建出来（见 applyEqualizer 的说明）。
      // 分析器自己临时建一个用完就关，代价比强行激活播放链小。
      const result = await analyzeTrack(track, null)
      if (result) actions.applyEqualizer()
    } finally {
      analyzing.delete(track.id)
    }
  }

  /** 外部模型（自填 API）是否接管风格判断 */
  function aiStyleEnabled () {
    const ai = store.get().settings.ai || {}
    return ai.enabled === true && ai.useForStyle !== false && Boolean(ai.baseUrl && ai.model)
  }

  /** 正在问外部模型的曲目（同一首别重复问） */
  const askingAi = new Set()

  /**
   * 把「曲目信息 + 本地特征」发给外部模型，让它挑一组预设。
   * 只发文本，**不上传音频**；答得不在列表里就当没答（本地判断继续生效）。
   */
  async function askAiForStyle (track, analysis) {
    if (!track?.id || askingAi.has(track.id)) return
    askingAi.add(track.id)
    try {
      const result = await classifyWithAi({ track, features: analysis?.features || null })
      // 有用就立刻生效；没用也缓存下来，不再反复问同一首
      actions.applyEqualizer()
      bus.emit(EVENTS.TOAST, {
        message: result
          ? `外部模型判断为「${PRESETS[result.key]?.displayName || result.key}」${result.reason ? `：${result.reason}` : ''}`
          : '外部模型没有给出可用结果，继续用本地判断',
        type: result ? 'success' : 'info',
        duration: 2600
      })
    } catch {
      // 静默：外部模型只是锦上添花，不该影响播放
    } finally {
      askingAi.delete(track.id)
    }
  }

  function registerOnlineTrack (item, resolved) {
    const id = `online:${item.uid || item.sourceId + ':' + item.sourceTrackId}`
    const track = {
      id,
      title: item.title || '(未知标题)',
      artist: item.artist || item.sourceName || '在线音源',
      album: item.album || '',
      albumArtist: item.artist || '',
      duration: Number(item.duration) || 0,
      year: 0,
      genre: '',
      path: null,
      file: '',
      dir: '',
      onlineUrl: resolved.url,
      onlineHeaders: resolved.headers || null,
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      sourceTrackId: item.sourceTrackId ?? null,
      sourcePayload: item.payload ?? null,
      isOnline: true,
      artworkEmbedded: false,
      artworkFile: null
    }
    onlineTracks.set(id, track)
    store.set((state) => ({
      ...state,
      library: { ...state.library, byId: new Map(state.library.byId).set(id, track) }
    }))
    return track
  }

  function registerKnownOnlineTracks () {
    const byId = store.get().library.byId
    for (const [id, track] of onlineTracks) byId.set(id, track)
  }

  /** 设置里显示/清理用 */
  function listOnlineTracks () {
    return [...onlineTracks.values()]
  }

  /** 播放一条在线结果：先解析直链，再交给普通播放流程 */
  async function playOnlineItem (item) {
    if (!item) return null
    const resolved = await remote.sources.resolve(item)
    const track = registerOnlineTrack(item, resolved)
    player.playCollection([track.id], track.id)
    toast({
      message: `正在播放在线结果：${track.title}（${item.sourceName}）`,
      type: 'success',
      duration: 2600
    })
    return track
  }

  remote.settings.onChanged((next) => applySettings(next))
  remote.settings.onSaveError((error) => toast({ message: error.message, type: 'error' }))

  /* 下载进度：主进程按 uid 推过来，写进 store 供结果行显示 */
  remote.sources.onDownloadProgress((progress) => {
    if (!progress?.uid) return
    store.set((state) => ({
      ...state,
      ui: {
        ...state.ui,
        downloads: {
          ...(state.ui.downloads || {}),
          [progress.uid]: {
            ...(state.ui.downloads?.[progress.uid] || {}),
            status: progress.done ? 'done' : 'running',
            percent: progress.percent ?? null,
            received: progress.received || 0,
            total: progress.total || 0,
            path: progress.path || undefined
          }
        }
      }
    }))
  })

  /*
   * 「从歌词搜索点开歌曲 → 跳到命中的那一句」：
   * 切歌后音频要先拿到时长，这时才能 seek，所以在播放状态更新时试着落地一次。
   */
  store.select((state) => `${state.playback.trackId}|${state.playback.status}|${state.playback.duration}`,
    () => {
      if (pendingLyricSeek) flushPendingLyricSeek()
    }, { immediate: false })

  /* ------------------------------------------------------------------ */
  /* 资料库                                                              */
  /* ------------------------------------------------------------------ */
  async function loadLibrary () {
    /*
     * 没有资料库能力的产品（player 档位）**根本不该问**主进程要资料库：
     * library:state 会被兜成 null，而下面要 for...of 迭代它 —— 实测就是启动时弹
     * 「启动失败：tracks is not iterable」。与其在几十处写空值防御，不如在这里按能力短路。
     */
    if (!PROFILE.capabilities || PROFILE.capabilities.library !== true) {
      /*
       * 短路也要把状态标成"已加载"，并**返回与正常路径同样的东西**（tracks 数组）：
       * 调用方是 `const tracks = await loadLibrary()`，返回形状不一致会让启动断在那里
       * （第一版返回了个对象，渲染层再没 ready，自检卡在"等待渲染层启动"）。
       *
       * ⚠️ 但**绝不能清空已有曲目**：player 档位的列表是"打开的文件"，由
       * ingestOpenedTracks 填进来（最近打开 / 拖放 / 双击 / 冷启动带文件）。
       * 这里原来写死 tracks: []，一旦 ingest 发生在 loadLibrary 之前就会被整表抹掉 ——
       * 现象是"文件明明解析了、recent.json 也有，列表却是空的"。所以只标 loaded，不碰曲目。
       */
      store.set((prev) => ({
        ...prev,
        library: { ...prev.library, loaded: true }
      }))
      return store.get().library.tracks
    }
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
    // 资料库整表重建后，把本次会话里已经合成过的在线曲目塞回去（它们不在 library.tracks 里）
    registerKnownOnlineTracks()
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
        // 命中详情（哪一行歌词、那一行的文本与时间轴）也要带上：
        // 界面用它在悬停时高亮、并把时间交给「点开歌曲跳到那一句」
        matches: result?.matches || [],
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

  /**
   * 「从歌词搜索结果点开歌曲时，自动跳到命中的那一句」。
   *
   * 返回这首歌在当前搜索结果里的歌词命中（含时间轴）；没有命中、
   * 关键词已经变了、或者用户在设置里关掉了这个功能，都返回 null。
   */
  function matchedLyricFor (trackId) {
    const state = store.get()
    if (state.settings.jumpToMatchedLyric === false) return null
    const search = state.ui.searchLyrics
    if (!search || !trackId) return null
    if (search.query !== state.ui.query) return null
    const hit = (search.matches || []).find((item) => item.id === trackId)
    if (!hit || typeof hit.time !== 'number' || hit.time <= 0) return null
    return hit
  }

  /*
   * 待执行的「跳到歌词句」：不能立刻 seek —— 刚切歌时音频还没拿到时长，
   * 这时 seek 会被丢掉。所以记下来，等这一首真的就绪（有时间轴）再跳一次。
   */
  let pendingLyricSeek = null

  function scheduleLyricSeek (track) {
    const hit = track ? matchedLyricFor(track.id) : null
    pendingLyricSeek = hit ? { trackId: track.id, time: hit.time, line: hit.line } : null
    return pendingLyricSeek
  }

  function flushPendingLyricSeek () {
    if (!pendingLyricSeek) return false
    const state = store.get()
    if (state.playback.trackId !== pendingLyricSeek.trackId) {
      pendingLyricSeek = null
      return false
    }
    if (!(state.playback.duration > 0)) return false
    const target = Math.min(pendingLyricSeek.time, Math.max(0, state.playback.duration - 0.5))
    const applied = pendingLyricSeek
    pendingLyricSeek = null
    player.seek(target)
    toast({
      message: `已跳到歌词「${String(applied.line || '').slice(0, 24)}」`,
      type: 'success',
      duration: 2600
    })
    return true
  }

  /**
   * 在线音源搜索。
   *
   * 只在「总开关打开 + 有关键词」时才真的发请求；同一关键词不重复搜。
   * 结果带上关键词存进 store，界面核对关键词一致后才显示 ——
   * 和歌词搜索同一个道理：异步结果会晚到。
   */
  let onlineSearchTimer = null
  let onlineSearchToken = 0

  function requestOnlineSearch ({ immediate = false } = {}) {
    const state = store.get()
    const query = String(state.ui.query || '').trim()
    if (onlineSearchTimer) {
      clearTimeout(onlineSearchTimer)
      onlineSearchTimer = null
    }
    if (state.settings.onlineSources !== true || !query) {
      if (state.ui.onlineSearch) actions.setOnlineSearch(null)
      return
    }
    const current = state.ui.onlineSearch
    if (current && current.query === query && current.status === 'done') return

    const run = async () => {
      const token = ++onlineSearchToken
      actions.setOnlineSearch({ query, status: 'loading', results: [], perSource: [] })
      const started = performance.now()
      try {
        const result = await remote.sources.search({ query })
        if (token !== onlineSearchToken) return
        actions.setOnlineSearch({
          query,
          status: 'done',
          results: result?.results || [],
          perSource: result?.perSource || [],
          elapsedMs: result?.elapsedMs ?? Math.round(performance.now() - started)
        })
      } catch (err) {
        if (token !== onlineSearchToken) return
        actions.setOnlineSearch({
          query,
          status: 'error',
          results: [],
          perSource: [],
          error: String(err?.message || err)
        })
      }
    }
    if (immediate) run()
    else onlineSearchTimer = setTimeout(run, 460)
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

    /*
     * 有目录读不进去时必须**说出来**。
     *
     * macOS 的 TCC 会让「文稿 / 桌面 / 下载」对未授权应用直接报 EACCES ——
     * 那种情况下扫描会"成功返回 0 首"，用户只看到「扫不到歌」，
     * 而我们这边（日志、界面）都没有线索。所以这里按错误码给一句能照做的中文提示。
     */
    if (progress.unreadableCount) {
      const first = progress.unreadable && progress.unreadable[0]
      toast({
        message: describeUnreadable(first, progress.unreadableCount),
        type: 'warning',
        duration: 7000
      })
    }

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
          return
        }
        // 都没得关的时候，Esc 用来清掉多选
        if (store.get().ui.selection.length) {
          actions.clearSelection()
          event.preventDefault()
        }
        return
      }

      // Ctrl+A：列表聚焦时由列表自己处理（它知道当前列表有哪几首），
      // 这里兜住焦点不在列表上的情况（例如刚点过工具条）
      if (mod && event.key.toLowerCase() === 'a' && !isTextInput(event.target)) {
        const list = actions.currentListTracks ? actions.currentListTracks() : null
        if (list && list.length) {
          if (!store.get().ui.selecting) actions.startSelection()
          actions.setSelection(list.map((track) => track.id))
          event.preventDefault()
        }
        return
      }

      if (mod && event.key.toLowerCase() === 'f') {
        /*
         * 人在设置页时，「搜索」指的显然是设置项，而不是把他扔到歌曲页去。
         * 设置页自己那只搜索框只作用于本页（不写 ui.query），所以就地聚焦即可；
         * 其它视图维持原行为：切到歌曲页并聚焦资料库搜索。
         */
        if (store.get().ui.view === 'settings') settingsView.focusSearch()
        else {
          actions.setView('songs')
          libraryView.focusSearch()
        }
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
        /*
         * macOS 上 ⌘Q 是「退出应用」、⌘M 是「最小化」，都是**系统保留键**。
         * 这两个功能（播放队列 / 静音）原来直接占用它们并 preventDefault()，
         * 后果是：按 ⌘M 想最小化，结果被静音；⌘Q 想退出，却先去开关了队列。
         * 所以 mac 上这两个功能改走 ⌥⌘Q / ⌥⌘M —— 不带 ⌥ 时直接放行，交给系统菜单。
         */
        const mac = isMacOS()
        const reservedTaken = mac && !event.altKey
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
            if (reservedTaken) return
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
            if (reservedTaken) return
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
  /* 最小化后释放后台占用                                                */
  /* ------------------------------------------------------------------ */
  const backgroundRelease = createBackgroundRelease({
    store,
    prewarmer,
    artwork,
    mediaWall,
    nowPlaying: nowPlayingPanel
  })

  remote.app.onBackgroundChange(({ phase }) => {
    backgroundState.released = phase === 'release'
    if (phase === 'release') {
      const result = backgroundRelease.release()
      console.log('[app] 最小化释放：', JSON.stringify(result))
    } else if (phase === 'resume') {
      backgroundRelease.resume()
    }
  })

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
    // 输出设备是浏览器侧的设置，启动时自己应用一次（不经过 settings:changed）
    if (settings.audioOutputDevice) {
      engine.setOutputDevice(settings.audioOutputDevice).then((result) => {
        if (!result.ok) console.warn('[app] 输出设备恢复失败：', result.message)
      })
    }
    /*
     * 均衡器开关是持久化的，但音频图**不在启动时创建**：
     * 建了它就会把播放路径交给 WebAudio，而这时还没有任何用户手势，
     * AudioContext 只能是挂起状态（等于没声音）。等第一次播放或用户动设置时再建。
     * 记一笔「待应用」，在首次播放后补上。
     */
    if (settings.equalizer?.enabled) {
      pendingEqualizer = true
    }
    store.set((state) => ({
      ...state,
      ready: true,
      /*
       * 保留 state.app 里已有的字段（尤其 profile）：
       * 这里以前是整块替换 `app: { info, platform, isMac }`，把 initialState 放进去的
       * 档位信息一起丢掉了 —— 于是 player 档位下 allowedViews() 读不到清单，
       * 侧栏又退回全量四页（专辑/艺人/媒体墙凭空出现）。这是第 2 步的检查抓出来的。
       */
      app: { ...state.app, info, platform: info.platform, isMac: info.isMac }
    }))

    applySettings(settings)

    player.init()
    player.setMode(settings.playbackMode)

    /*
     * player 档位：启动时载入「最近打开」。
     *
     * loadLibrary() 在没有资料库能力时是短路的（返回空数组），所以这里用
     * window.aria.opened 这个**能力入口**判断要不要去读最近打开清单 ——
     * 本体没有这个入口，一行都不会走到。
     * 读的是 userData/recent.json + 解析元数据；不建索引、不读封面、不联网。
     */
    if (remote.opened) {
      try {
        const loaded = await actions.loadRecentOpened()
        if (loaded.total) {
          console.log(`[app] 最近打开：${loaded.count} 首可播 / 共 ${loaded.total} 条（${loaded.missing} 条文件已不在）`)
        }
      } catch (err) {
        console.warn('[app] 载入最近打开失败：', err && err.message)
      }
      /*
       * 这里只读「最近打开」（列表要用它）；**订阅与排空放在下面"恢复上次曲目"之后** ——
       * 顺序不对的话，恢复那一步的 player.prepare 会把刚播起来的冷启动文件停掉。
       */
    }

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

    /*
     * 恢复上次的队列顺序（含拖动过的顺序）。只留库里还在的曲目 ——
     * 文件被删掉之后不该留下一条点不开的行。队列顺序是"用户的排序"，优先于视图默认列表。
     */
    const savedQueue = Array.isArray(settings.queue)
      ? settings.queue.filter((id) => store.get().library.byId.has(id))
      : []
    if (savedQueue.length) {
      playlist.sync(savedQueue, { keepId: store.get().playback.trackId || null })
      bus.emit(EVENTS.QUEUE_CHANGED, savedQueue)
    }
    }

    /*
     * 现在才把「打开的文件」的处理函数装上，并把启动期间攒下的载荷按顺序补处理。
     *
     * ⚠️ 顺序很关键：必须**排在"恢复上次曲目"之后**。
     * 那段会 player.prepare(lastTrackPath) —— 它是同步的、会停掉当前播放；
     * 如果冷启动的文件先播了、恢复再执行，结果就是"文件在列表里、但没在播、状态 paused"。
     * 这正是冷启动检查第二次跑出来的：入列成功、播放被覆盖。
     * 放在后面之后，冷启动文件是最终状态；之后到达的新载荷由 openedSink 直接处理。
     */
    if (remote.opened) {
      openedSink = (payload) => {
        if (!payload || !Array.isArray(payload.tracks) || !payload.tracks.length) return
        actions.ingestOpenedTracks(payload.tracks)
        if (payload.trackIds && payload.trackIds.length) actions.playDroppedTracks(payload.trackIds)
      }
      for (const payload of pendingOpened.splice(0)) openedSink(payload)
    }

    // 空资料库时直接把设置页推到用户面前（player 档位停在列表页 —— 那里有空状态与打开入口）
    if (!tracks.length && !settings.folders.length && !remote.opened) {
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
    // 主进程桥（自检要直接调 ai:test 这类只有主进程能发的请求）
    remote,
    // 艺人名拆分（合作写法的规则都在这里，控制台里可以直接试）
    splitArtists,
    // 均衡器的风格匹配（自检直接拿它验规则）
    matchPreset,
    matchByMetadata,
    // 声音特征分析（自检拿合成波形验分类器）
    styleAnalyzer: { analyzeBuffer, classifyStyle },
    cachedAnalysis,
    // 外部模型风格判断（自检拿它直接问一次假接口）
    aiStyle: {
      classifyWithAi,
      cached: cachedAiStyle,
      parseAnswer
    },
    // 最小化后的释放 / 恢复（自检会用它读释放账目）
    background: backgroundRelease,
    // 视图组件：自检与调试会用到（例如媒体墙的 debugState / 平移）
    views: { libraryView, browseView, mediaWall, settingsView, playerBar, nowPlayingPanel, queuePanel }
  }
}

main().catch((err) => {
  console.error(err)
  document.body.textContent = `启动失败：${err.message}`
})
