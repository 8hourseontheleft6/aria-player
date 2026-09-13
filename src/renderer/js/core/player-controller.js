/**
 * 播放控制器：把「队列 + 模式 + 音频引擎 + 歌词 + 设置」串起来。
 * 所有 UI 都只调用这里的方法，不直接碰 HTMLAudioElement。
 */

import { EVENTS } from './bus.js'
import { raf } from './dom.js'
import { remote } from './remote.js'
import { trackMediaUrl } from './media-url.js'
import { parseLrc, parsePlainLyrics, findLineIndex, karaokeProgress } from './lrc.js'
import { DEFAULT_MODE } from './playback-modes.js'

const TIMED_LRC = /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/

export function createPlayerController ({ store, bus, engine, playlist, host, artwork }) {
  let modeId = store.get().settings.playbackMode || DEFAULT_MODE
  let ticker = null
  let lyricsToken = 0
  /** 当前歌词原文，用于调整偏移后重新解析 */
  let currentLyrics = null
  let lastActiveIndex = -1
  const disposers = []

  const getTrack = (id) => store.get().library.byId.get(id) || null

  function currentTrack () {
    return getTrack(playbackTrackId())
  }

  function playbackTrackId () {
    return store.get().playback.trackId
  }

  function mode () {
    return host.get('playbackMode', modeId) || host.list('playbackMode')[0]
  }

  function modeContext () {
    return {
      hasNext: playlist.hasNext(),
      hasPrev: playlist.hasPrev(),
      index: playlist.index,
      queueLength: playlist.length,
      shuffle: playlist.shuffle
    }
  }

  /* ------------------------------------------------------------------ */
  /* 状态同步                                                            */
  /* ------------------------------------------------------------------ */

  function syncPlaybackState (patch) {
    store.set((state) => ({ ...state, playback: { ...state.playback, ...patch } }))
  }

  function syncQueueState () {
    syncPlaybackState({
      queue: playlist.queue.slice(),
      queueIndex: playlist.index,
      mode: modeId
    })
  }

  /* ------------------------------------------------------------------ */
  /* 曲目加载                                                            */
  /* ------------------------------------------------------------------ */

  async function loadTrack (trackId, { autoplay = true, keepPosition = false } = {}) {
    const track = getTrack(trackId)
    if (!track) return false

    const url = trackMediaUrl(track)
    if (!url) return false

    engine.load(url)
    engine.setRate(store.get().settings.playbackRate)
    engine.setVolume(store.get().settings.volume)
    engine.setMuted(store.get().settings.muted)
    engine.setPreservesPitch(store.get().settings.preservesPitch)

    syncPlaybackState({
      trackId: track.id,
      status: autoplay ? 'loading' : 'paused',
      duration: track.duration || 0,
      error: null
    })

    bus.emit(EVENTS.TRACK_CHANGED, { track, autoplay })
    remote.settings.set({ lastTrackPath: track.path }).catch(() => {})

    // 封面配色 + 歌词并行加载
    applyArtworkTint(track)
    loadLyrics(track)

    if (autoplay) {
      const ok = await engine.play()
      if (!ok && !engine.paused) {
        syncPlaybackState({ status: 'error', error: engine.lastError()?.message || '播放失败' })
      }
    }
    return true
  }

  async function playTrack (trackId) {
    if (trackId === playbackTrackId()) {
      return engine.play()
    }
    if (playlist.moveToId(trackId) === null) {
      playlist.sync([trackId], { keepId: trackId })
      syncQueueState()
    }
    syncQueueState()
    return loadTrack(trackId, { autoplay: true })
  }

  /** 只加载不播放（启动时恢复上次的曲目用） */
  async function prepare (trackId) {
    if (!getTrack(trackId)) return false
    if (playlist.moveToId(trackId) === null) playlist.sync([trackId], { keepId: trackId })
    syncQueueState()
    return loadTrack(trackId, { autoplay: false })
  }

  /** 用一组曲目作为队列并播放其中某一首（点列表播放按钮走这里） */
  async function playCollection (ids, startId = null) {
    const list = Array.isArray(ids) ? ids : []
    if (!list.length) return false
    const start = startId || list[0]
    playlist.sync(list, { keepId: start })
    playlist.moveToId(start)
    if (mode().shuffle) playlist.setShuffle(true, { anchorId: start })
    syncQueueState()
    return loadTrack(start, { autoplay: true })
  }

  /* ------------------------------------------------------------------ */
  /* 传输控制                                                            */
  /* ------------------------------------------------------------------ */

  function toggle () {
    if (!playbackTrackId()) {
      const queue = playlist.queue
      if (queue.length) return playCollection(queue, queue[0])
      const first = store.get().library.tracks[0]
      if (first) return playCollection([first.id], first.id)
      bus.emit(EVENTS.TOAST, { message: '资料库还是空的，先添加一个音乐文件夹吧', type: 'info' })
      return false
    }
    return engine.toggle()
  }

  function play () {
    if (!playbackTrackId()) return toggle()
    return engine.play()
  }

  function pause () {
    engine.pause()
  }

  function executeAction (action, { silent = false } = {}) {
    switch (action) {
      case 'next': {
        const id = playlist.advance()
        syncQueueState()
        return id ? loadTrack(id, { autoplay: true }) : false
      }
      case 'prev': {
        const id = playlist.rewind()
        syncQueueState()
        return id ? loadTrack(id, { autoplay: true }) : false
      }
      case 'restart': {
        const id = playlist.first()
        syncQueueState()
        return id ? loadTrack(id, { autoplay: true }) : false
      }
      case 'last': {
        const id = playlist.last()
        syncQueueState()
        return id ? loadTrack(id, { autoplay: true }) : false
      }
      case 'replay': {
        engine.seek(0)
        return engine.play()
      }
      case 'reshuffle': {
        playlist.setShuffle(true, { anchorId: null })
        const id = playlist.first()
        syncQueueState()
        return id ? loadTrack(id, { autoplay: true }) : false
      }
      case 'stop': {
        engine.pause()
        engine.seek(0)
        syncPlaybackState({ status: 'ended' })
        return false
      }
      default:
        if (!silent) bus.emit(EVENTS.TOAST, { message: '已经是队列的尽头了', type: 'info' })
        return false
    }
  }

  function next () {
    return executeAction(mode().onNext(modeContext()))
  }

  function prev () {
    // iOS 习惯：播放超过 3 秒时「上一首」先回到本曲开头
    if (engine.getTime() > 3) {
      engine.seek(0)
      return true
    }
    return executeAction(mode().onPrev(modeContext()))
  }

  function seek (seconds) {
    engine.seek(seconds)
    // 暂停状态下 seeked 事件可能来得较晚，这里立即刷新一次进度与歌词
    emitTimeNow()
  }

  function seekBy (delta) {
    engine.seekBy(delta)
  }

  function setMode (id) {
    const target = host.get('playbackMode', id)
    if (!target) return
    modeId = target.id
    const currentId = playbackTrackId()
    playlist.setShuffle(Boolean(target.shuffle), { anchorId: currentId })
    syncQueueState()
    remote.settings.set({ playbackMode: modeId }).catch(() => {})
    bus.emit(EVENTS.MODE_CHANGED, target)
  }

  function cycleMode () {
    const modes = host.list('playbackMode')
    if (!modes.length) return
    const index = modes.findIndex((item) => item.id === modeId)
    const next = modes[(index + 1) % modes.length]
    setMode(next.id)
    bus.emit(EVENTS.TOAST, { message: `播放模式：${next.name}`, type: 'info', icon: next.icon })
  }

  function toggleMode (idA, idB) {
    setMode(modeId === idA ? idB : idA)
  }

  function setRate (rate) {
    const applied = engine.setRate(rate)
    store.set((state) => ({
      ...state,
      settings: { ...state.settings, playbackRate: applied },
      playback: { ...state.playback, rate: applied }
    }))
    remote.settings.set({ playbackRate: applied }).catch(() => {})
    bus.emit('player:rate-changed', applied)
    return applied
  }

  function setVolume (value) {
    const volume = Math.max(0, Math.min(1, Number(value) || 0))
    engine.setVolume(volume)
    if (volume > 0 && store.get().settings.muted) setMuted(false)
    store.set((state) => ({ ...state, settings: { ...state.settings, volume } }))
    remote.settings.set({ volume }).catch(() => {})
    bus.emit('player:volume-changed', volume)
    return volume
  }

  function setMuted (muted) {
    engine.setMuted(muted)
    store.set((state) => ({ ...state, settings: { ...state.settings, muted } }))
    remote.settings.set({ muted }).catch(() => {})
    bus.emit('player:volume-changed', muted ? 0 : engine.getVolume())
    return muted
  }

  function toggleMute () {
    return setMuted(!store.get().settings.muted)
  }

  function setPreservesPitch (value) {
    engine.setPreservesPitch(value)
    store.set((state) => ({ ...state, settings: { ...state.settings, preservesPitch: value } }))
    remote.settings.set({ preservesPitch: value }).catch(() => {})
  }

  function removeFromQueue (trackId) {
    playlist.remove(trackId)
    syncQueueState()
    bus.emit(EVENTS.QUEUE_CHANGED, playlist.queue.slice())
  }

  function playNext (trackIds) {
    playlist.insertNext(trackIds)
    syncQueueState()
    bus.emit(EVENTS.QUEUE_CHANGED, playlist.queue.slice())
    bus.emit(EVENTS.TOAST, { message: '已添加到播放队列的下一首', type: 'success' })
  }

  function jumpToQueuePosition (position) {
    const id = playlist.moveTo(position)
    syncQueueState()
    return id ? loadTrack(id, { autoplay: true }) : false
  }

  /* ------------------------------------------------------------------ */
  /* 封面与配色                                                          */
  /* ------------------------------------------------------------------ */

  async function applyArtworkTint (track) {
    try {
      const color = await artwork.resolveColor(track)
      if (color) artwork.applyTint(color)
    } catch {
      artwork.applyTint(artwork.fallbackColor(track))
    }
  }

  /* ------------------------------------------------------------------ */
  /* 歌词                                                                */
  /* ------------------------------------------------------------------ */

  function applyParsedLyrics (payload, rawText) {
    const settings = store.get().settings
    let lines = []
    let plain = null
    let meta = {}
    let source = payload.source || 'unknown'

    if (Array.isArray(payload.lines)) {
      lines = payload.lines.map((line, index) => ({
        index,
        time: Number(line.time) || 0,
        end: Number(line.end) || Number.POSITIVE_INFINITY,
        text: String(line.text ?? ''),
        translation: String(line.translation ?? ''),
        words: line.words || null
      }))
      for (let i = 0; i < lines.length; i++) {
        if (!Number.isFinite(lines[i].end)) {
          lines[i].end = i + 1 < lines.length ? lines[i + 1].time : Number.POSITIVE_INFINITY
        }
      }
      meta = payload.meta || {}
    } else if (payload.text && TIMED_LRC.test(payload.text)) {
      const parsed = parseLrc(payload.text, { offsetMs: settings.lyricOffsetMs })
      lines = parsed.lines
      meta = parsed.meta
    } else if (payload.text) {
      plain = parsePlainLyrics(payload.text)
      source = payload.source === 'lrc' ? 'txt' : (payload.source || 'txt')
    }

    currentLyrics = { raw: rawText ?? payload.text ?? null, payload, source, file: payload.file || null }
    lastActiveIndex = -1

    store.set((state) => ({
      ...state,
      lyrics: {
        status: lines.length ? 'ready' : (plain?.length ? 'plain' : 'empty'),
        source,
        file: payload.file || null,
        meta,
        lines,
        plain,
        trackId: state.playback.trackId
      }
    }))
    bus.emit(EVENTS.LYRICS_LOADED, { source, lines, plain, meta })
  }

  async function loadLyrics (track) {
    const token = ++lyricsToken
    currentLyrics = null
    store.set((state) => ({
      ...state,
      lyrics: { status: 'loading', source: null, file: null, lines: [], plain: null, meta: {}, trackId: track.id }
    }))

    let payload = null
    try {
      const file = await remote.lyrics.load({ path: track.path, title: track.title, artist: track.artist })
      if (file?.text) payload = { source: file.source, text: file.text, file: file.file }
    } catch (err) {
      console.warn('[lyrics] 本地歌词读取失败', err)
    }

    // 本地没有时，依次询问插件提供的歌词源
    if (!payload) {
      const providers = host.list('lyricsProvider')
        .slice()
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
      for (const provider of providers) {
        try {
          const result = await provider.load(track, { settings: store.get().settings })
          if (!result) continue
          if (result.lines?.length) {
            payload = { source: provider.id, lines: result.lines, meta: result.meta || {} }
            break
          }
          if (result.text) {
            payload = { source: provider.id, text: result.text, file: result.file || null }
            break
          }
        } catch (err) {
          console.warn(`[lyrics] 插件歌词源 ${provider.id} 失败`, err)
        }
      }
    }

    if (token !== lyricsToken) return
    if (!payload) {
      store.set((state) => ({
        ...state,
        lyrics: { status: 'none', source: null, file: null, lines: [], plain: null, meta: {}, trackId: track.id }
      }))
      bus.emit(EVENTS.LYRICS_LOADED, null)
      return
    }

    applyParsedLyrics(payload, payload.text ?? null)
  }

  /** 调整歌词偏移（毫秒）：立即重排时间轴，无需重新读盘 */
  function setLyricOffset (offsetMs, { persist = true } = {}) {
    const value = Math.round(Number(offsetMs) || 0)
    store.set((state) => ({ ...state, settings: { ...state.settings, lyricOffsetMs: value } }))
    if (persist) remote.settings.set({ lyricOffsetMs: value }).catch(() => {})
    if (currentLyrics && !Array.isArray(currentLyrics.payload.lines) && currentLyrics.raw) {
      applyParsedLyrics(currentLyrics.payload, currentLyrics.raw)
    }
  }

  function setLyricFontScale (scale) {
    const value = Math.max(0.7, Math.min(1.6, Number(scale) || 1))
    store.set((state) => ({ ...state, settings: { ...state.settings, lyricFontScale: value } }))
    remote.settings.set({ lyricFontScale: value }).catch(() => {})
  }

  function activeLyricIndex (time) {
    return findLineIndex(store.get().lyrics.lines, time)
  }

  /** 根据时间更新当前歌词行（ticker 与 seek / 暂停时都会调用） */
  function updateActiveLyric (time) {
    const lines = store.get().lyrics.lines
    if (!lines?.length) {
      if (lastActiveIndex !== -1) lastActiveIndex = -1
      return
    }
    const index = findLineIndex(lines, time)
    if (index === lastActiveIndex) return
    lastActiveIndex = index
    bus.emit(EVENTS.LYRICS_ACTIVE, { index, line: index >= 0 ? lines[index] : null, time })
  }

  /** 立即广播一次播放位置（不依赖 rAF 循环） */
  function emitTimeNow () {
    const time = engine.getTime()
    const duration = engine.getDuration() || store.get().playback.duration
    const buffered = engine.getBufferedEnd()
    bus.emit(EVENTS.TIME, { time, duration, buffered })
    updateActiveLyric(time)
  }

  /* ------------------------------------------------------------------ */
  /* 每秒刷新的播放位置（走 rAF，不进 store，避免整体重渲染）             */
  /* ------------------------------------------------------------------ */

  function startTicker () {
    if (ticker?.running) return
    ticker = ticker || raf(() => {
      emitTimeNow()
    })
    ticker.start()
  }

  function stopTicker () {
    ticker?.stop()
  }

  /* ------------------------------------------------------------------ */
  /* 引擎事件                                                            */
  /* ------------------------------------------------------------------ */

  function bindEngine () {
    disposers.push(bus.on('audio:loadedmetadata', () => {
      const duration = engine.getDuration()
      if (duration) syncPlaybackState({ duration })
      syncMediaSessionPosition()
    }))

    disposers.push(bus.on('audio:durationchange', () => {
      const duration = engine.getDuration()
      if (duration) syncPlaybackState({ duration })
    }))

    disposers.push(bus.on('audio:playing', () => {
      syncPlaybackState({ status: 'playing', error: null })
      startTicker()
      // 只有插件已创建过 WebAudio 接入点时才需要恢复 AudioContext
      engine.resumeTap()
    }))

    disposers.push(bus.on('audio:pause', () => {
      const status = store.get().playback.status
      // 'ended' 是「播放到末尾停住」的语义，不要被 pause 事件覆盖成 'paused'
      if (status !== 'error' && status !== 'ended') syncPlaybackState({ status: 'paused' })
      stopTicker()
      emitTimeNow()
    }))

    // seek 完成 / 暂停状态下拖动进度条，都要刷新进度与歌词高亮
    disposers.push(bus.on('audio:seeked', () => emitTimeNow()))

    disposers.push(bus.on('audio:waiting', () => {
      if (store.get().playback.status === 'playing') syncPlaybackState({ status: 'buffering' })
    }))

    disposers.push(bus.on('audio:ended', () => {
      executeAction(mode().onEnded(modeContext()))
    }))

    disposers.push(bus.on('audio:error', () => {
      const error = engine.lastError()
      if (!error) return
      syncPlaybackState({ status: 'error', error: error.message })
      stopTicker()
      bus.emit(EVENTS.TOAST, { message: error.message, type: 'error' })
    }))

    disposers.push(bus.on('engine:error', (error) => {
      bus.emit(EVENTS.TOAST, { message: error.message, type: 'error' })
    }))
  }

  /* ------------------------------------------------------------------ */
  /* 系统媒体会话（Windows 音量弹窗 / macOS 正在播放）                    */
  /* ------------------------------------------------------------------ */

  function syncMediaSessionPosition () {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
    try {
      const duration = engine.getDuration()
      if (!duration) return
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: engine.element.playbackRate,
        position: Math.min(engine.getTime(), duration)
      })
    } catch {
      // 某些状态组合下会抛错，忽略
    }
  }

  function updateMediaSession (track) {
    if (!('mediaSession' in navigator)) return
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist,
        album: track.album
      })
    } catch {
      // MediaMetadata 不可用时忽略
    }
  }

  function configureMediaSessionHandlers () {
    if (!('mediaSession' in navigator)) return
    // 主进程已经用全局快捷键接管媒体键时，就不再注册会话处理器，避免一次按键触发两次
    const useGlobalKeys = store.get().settings.globalMediaKeys
    const handlers = {
      play: () => play(),
      pause: () => pause(),
      nexttrack: () => next(),
      previoustrack: () => prev(),
      stop: () => pause(),
      seekbackward: () => seekBy(-10),
      seekforward: () => seekBy(10),
      seekto: (details) => {
        if (typeof details.seekTime === 'number') seek(details.seekTime)
      }
    }
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(action, useGlobalKeys ? null : handler)
      } catch {
        // 个别 action 不被支持
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  function bindEvents () {
    disposers.push(bus.on(EVENTS.TRACK_CHANGED, ({ track }) => {
      updateMediaSession(track)
    }))

    disposers.push(bus.on('audio:playing', () => syncMediaSessionPosition()))
  }

  function init () {
    const settings = store.get().settings
    engine.setVolume(settings.volume)
    engine.setMuted(settings.muted)
    engine.setRate(settings.playbackRate)
    engine.setPreservesPitch(settings.preservesPitch)
    if (!host.get('playbackMode', modeId)) modeId = host.list('playbackMode')[0]?.id || DEFAULT_MODE
    bindEngine()
    bindEvents()
    configureMediaSessionHandlers()
    syncPlaybackState({ mode: modeId, rate: settings.playbackRate })
  }

  function dispose () {
    stopTicker()
    engine.dispose()
    for (const dispose of disposers.splice(0)) dispose()
  }

  return {
    init,
    dispose,
    // 传输
    toggle,
    play,
    pause,
    next,
    prev,
    seek,
    seekBy,
    playTrack,
    prepare,
    playCollection,
    jumpToQueuePosition,
    removeFromQueue,
    playNext,
    // 模式
    setMode,
    cycleMode,
    toggleMode,
    get mode () {
      return mode()
    },
    get modes () {
      return host.list('playbackMode')
    },
    // 参数
    setRate,
    setVolume,
    setMuted,
    toggleMute,
    setPreservesPitch,
    setLyricOffset,
    setLyricFontScale,
    // 只读
    currentTrack,
    getTime: () => engine.getTime(),
    getDuration: () => engine.getDuration() || store.get().playback.duration,
    getBufferedEnd: () => engine.getBufferedEnd(),
    activeLyricIndex,
    karaokeProgress,
    get playlist () {
      return playlist
    },
    get engine () {
      return engine
    },
    get currentLyrics () {
      return currentLyrics
    },
    reloadLyrics: () => {
      const track = currentTrack()
      if (track) loadLyrics(track)
    }
  }
}
