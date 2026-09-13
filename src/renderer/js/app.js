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

import { createTitlebar } from './ui/titlebar.js'
import { createSidebar } from './ui/sidebar.js'
import { createLibraryView } from './ui/library-view.js'
import { createSettingsView } from './ui/settings-view.js'
import { createPlayerBar } from './ui/player-bar.js'
import { createNowPlayingPanel } from './ui/now-playing-panel.js'
import { createQueuePanel } from './ui/queue-panel.js'
import { createTrackMenu } from './ui/track-menu.js'
import { toast, closeAllLayers } from './ui/overlay.js'

import { BUILTIN_PLUGINS } from './plugins/index.js'

const SORT_KEYS = ['default', 'title', 'artist', 'album', 'duration', 'year', 'added']

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
  const artwork = createArtworkService({ bus })

  registerBuiltinModes(host)
  host.loadAll(BUILTIN_PLUGINS)

  const player = createPlayerController({ store, bus, engine, playlist, host, artwork })

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
      store.set((state) => ({ ...state, ui: { ...state.ui, view } }))
    },

    setSource (source) {
      store.set((state) => ({ ...state, ui: { ...state.ui, view: 'songs', source } }))
      if (store.get().ui.nowPlayingOpen) actions.closeNowPlaying()
    },

    setQuery (query) {
      store.set((state) => ({ ...state, ui: { ...state.ui, query } }))
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

    playTrack (track) {
      if (!track) return
      const list = libraryView.tracks.map((item) => item.id)
      if (list.includes(track.id)) {
        player.playCollection(list, track.id)
      } else {
        player.playCollection([track.id], track.id)
      }
    },

    playAll () {
      const list = libraryView.tracks
      if (!list.length) {
        toast({ message: '列表里还没有歌曲', type: 'info' })
        return
      }
      if (store.get().playback.mode === 'shuffle') player.setMode('loop-list')
      player.playCollection(list.map((item) => item.id), list[0].id)
    },

    shuffleAll () {
      const list = libraryView.tracks
      if (!list.length) {
        toast({ message: '列表里还没有歌曲', type: 'info' })
        return
      }
      player.setMode('shuffle')
      player.playCollection(list.map((item) => item.id), list[Math.floor(Math.random() * list.length)].id)
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
  const settingsView = createSettingsView({ store, bus, player, actions, host })
  const playerBar = createPlayerBar({ store, bus, player, artwork, actions })
  const nowPlayingPanel = createNowPlayingPanel({ store, bus, player, artwork, host, actions })
  const queuePanel = createQueuePanel({ store, bus, player, artwork, actions })

  dom.titlebar.replaceWith(titlebar.element)
  dom.sidebar.replaceWith(sidebar.element)
  dom.content.append(libraryView.element, settingsView.element, queuePanel.element)
  dom.playerBar.replaceWith(playerBar.element)
  dom.nowPlaying.replaceWith(nowPlayingPanel.element)

  // 视图切换：歌曲列表 / 设置
  store.select((state) => state.ui.view, (view) => {
    libraryView.element.style.display = view === 'settings' ? 'none' : ''
    settingsView.element.style.display = view === 'settings' ? '' : 'none'
    if (view === 'settings') settingsView.render()
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
      track._search = normalizeForSearch(
        `${track.title} ${track.artist} ${track.album} ${track.albumArtist} ${track.file}`
      )
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

  remote.library.onScanProgress((progress) => {
    const scanning = progress.phase !== 'done'
    store.set((state) => ({
      ...state,
      ui: { ...state.ui, scanning, scanProgress: progress }
    }))
    if (progress.phase === 'done') {
      loadLibrary().then(() => {
        if (progress.total > 0) {
          toast({
            message: `资料库已更新：${progress.count} 首${progress.reused ? `（复用缓存 ${progress.reused} 首）` : ''}`,
            type: 'success',
            duration: 3000
          })
        }
      }).catch((err) => console.error('[app] 刷新资料库失败', err))
    }
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
  }

  bindKeyboard()

  boot().catch((err) => {
    console.error('[app] 启动失败', err)
    toast({ message: `启动失败：${err.message}`, type: 'error', duration: 8000 })
  })

  /* 调试与二次开发入口：开发者工具控制台里可以直接用 window.__aria */
  window.__aria = { bus, store, player, engine, playlist, host, artwork, actions, EVENTS }
}

main().catch((err) => {
  console.error(err)
  document.body.textContent = `启动失败：${err.message}`
})
