/**
 * 轻量状态容器：单一 state 树 + 选择器订阅。
 * 高频变化的数据（播放位置）不放在这里走渲染，而是由 rAF 直接读取，
 * 这里只保留结构性状态。
 */

export function createStore (initialState = {}) {
  let state = initialState
  /** @type {Set<Function>} */
  const listeners = new Set()

  function notify (prev, meta) {
    for (const listener of [...listeners]) {
      try {
        listener(state, prev, meta)
      } catch (err) {
        console.error('[store] 订阅者异常', err)
      }
    }
  }

  return {
    get () {
      return state
    },

    /** 传对象做浅合并，或传函数做自定义更新 */
    set (patch, meta) {
      const prev = state
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch }
      if (next === prev) return state
      state = next
      notify(prev, meta)
      return state
    },

    subscribe (listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * 按选择器订阅，值不变则不回调。
     * @param {(state: object) => any} selector
     * @param {(value: any, previous: any) => void} handler
     * @param {{ equals?: (a: any, b: any) => boolean, immediate?: boolean }} [options]
     */
    select (selector, handler, options = {}) {
      const equals = options.equals || Object.is
      let current = selector(state)
      if (options.immediate !== false) {
        try {
          handler(current, undefined)
        } catch (err) {
          console.error('[store] 选择器初始化异常', err)
        }
      }
      return this.subscribe((next) => {
        let value
        try {
          value = selector(next)
        } catch {
          return
        }
        if (equals(value, current)) return
        const previous = current
        current = value
        handler(value, previous)
      })
    },

    /** 数组选择器的浅比较辅助 */
    selectArray (selector, handler, options = {}) {
      return this.select(selector, handler, {
        ...options,
        equals: (a, b) => Array.isArray(a) && Array.isArray(b) &&
          a.length === b.length && a.every((item, index) => item === b[index])
      })
    }
  }
}

/** 创建应用的初始状态树 */
export function initialState () {
  return {
    ready: false,
    app: { info: null, platform: 'win32', isMac: false },
    settings: {
      theme: 'system',
      volume: 0.85,
      muted: false,
      playbackRate: 1,
      preservesPitch: true,
      playbackMode: 'loop-list',
      lyricOffsetMs: 0,
      lyricFontScale: 1,
      showRowArtwork: true,
      showFps: false,
      searchScope: 'basic',
      searchHistory: [],
      jumpToMatchedLyric: true,
      playOnSingleClick: false,
      // 侧边栏 / 灵动岛里视图项的顺序（可拖动自定义）
      sidebarOrder: ['songs', 'albums', 'artists', 'wall'],
      // 侧栏开着时是否也显示灵动岛（默认 false = 两者不同时出现）
      islandWithSidebar: false,
      // 用户自建播放列表：[{ id, name, trackIds, createdAt }]
      playlists: [],
      onlineSources: false,
      musicSources: {},
      downloadDir: '',
      globalMediaKeys: true,
      showRemainingTime: false
    },
    theme: 'dark',
    ui: {
      view: 'songs',
      source: { type: 'all', value: null },
      detail: null,
      query: '',
      // 在线音源搜索结果：{ query, status, results, perSource, error, elapsedMs }
      onlineSearch: null,
      // 下载进度：uid -> { status, percent, received, total, path, error }
      downloads: {},
      // 深度搜索的歌词命中结果：{ query, ids, scanning, scanned, matched, elapsedMs }
      searchLyrics: null,
      sort: { key: 'default', direction: 'asc' },
      nowPlayingOpen: false,
      queueOpen: false,
      sidebarVisible: true,
      lyricsVisible: true,
      toast: null,
      scanning: false,
      scanProgress: null,
      dropActive: false
    },
    library: {
      loaded: false,
      folders: [],
      tracks: [],
      byId: new Map(),
      scannedAt: 0,
      totalDuration: 0
    },
    playback: {
      trackId: null,
      status: 'idle',
      duration: 0,
      mode: 'loop-list',
      queue: [],
      queueIndex: -1,
      error: null,
      rate: 1
    },
    lyrics: {
      status: 'idle',
      source: null,
      file: null,
      lines: [],
      plain: null,
      trackId: null
    }
  }
}
