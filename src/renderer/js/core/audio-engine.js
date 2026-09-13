/**
 * 音频引擎：包一层 HTMLAudioElement。
 * 只负责「播放」这件事，队列 / 模式 / 歌词都在上层，
 * 因此想换成 WebAudio 或加音效，只需要替换/包装这一层。
 */

const ERROR_MESSAGES = {
  1: '播放被中止',
  2: '读取文件失败，文件可能已被移动',
  3: '解码失败，文件可能已损坏',
  4: '无法播放该格式'
}

export function createAudioEngine ({ bus }) {
  const audio = new Audio()
  audio.preload = 'metadata'
  audio.autoplay = false
  // 走 CORS 模式取音频，这样 WebAudio 接入点（插件可视化/音效）才能拿到真实数据，
  // 否则 MediaElementAudioSourceNode 会输出静音。media:// 协议已返回 ACAO 头。
  audio.crossOrigin = 'anonymous'
  // 变速时保持音调（Chromium 支持 preservesPitch）
  if ('preservesPitch' in audio) audio.preservesPitch = true
  if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true

  let currentUrl = null
  let pendingPlay = null
  let tap = null

  const EVENTS = [
    'loadstart', 'loadedmetadata', 'durationchange', 'timeupdate', 'progress',
    'playing', 'pause', 'waiting', 'canplay', 'seeking', 'seeked', 'ended',
    'ratechange', 'volumechange', 'stalled', 'error'
  ]

  for (const name of EVENTS) {
    audio.addEventListener(name, () => {
      bus.emit(`audio:${name}`, audio)
    })
  }

  audio.addEventListener('play', () => bus.emit('engine:state', 'playing'))
  audio.addEventListener('pause', () => bus.emit('engine:state', 'paused'))

  function load (url) {
    if (!url) return
    if (currentUrl === url) return
    currentUrl = url
    audio.src = url
    try {
      audio.load()
    } catch {
      // 某些情况下 load() 会抛 AbortError，忽略即可
    }
  }

  async function play () {
    if (!currentUrl) return false
    try {
      pendingPlay = audio.play()
      await pendingPlay
      pendingPlay = null
      return true
    } catch (err) {
      pendingPlay = null
      if (err && err.name === 'AbortError') return false
      bus.emit('engine:error', { code: 0, message: err?.message || '播放失败' })
      return false
    }
  }

  function pause () {
    audio.pause()
  }

  function stop () {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    currentUrl = null
  }

  function toggle () {
    if (audio.paused) return play()
    pause()
    return Promise.resolve(true)
  }

  function seek (seconds) {
    const target = Math.max(0, Math.min(Number(seconds) || 0, getDuration() || Number(seconds) || 0))
    try {
      audio.currentTime = target
    } catch {
      // 尚未加载元数据时忽略
    }
  }

  function seekBy (delta) {
    seek(getTime() + delta)
  }

  function getTime () {
    return Number.isFinite(audio.currentTime) ? audio.currentTime : 0
  }

  function getDuration () {
    return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
  }

  function getBufferedEnd () {
    try {
      const ranges = audio.buffered
      if (!ranges || !ranges.length) return 0
      const time = getTime()
      // 找到覆盖当前播放位置的区间
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= time + 0.35 && time <= ranges.end(i)) return ranges.end(i)
      }
      return ranges.end(ranges.length - 1)
    } catch {
      return 0
    }
  }

  function setVolume (value) {
    audio.volume = Math.max(0, Math.min(1, Number(value) || 0))
  }

  function getVolume () {
    return audio.volume
  }

  function setMuted (value) {
    audio.muted = Boolean(value)
  }

  function setRate (value) {
    const rate = Math.max(0.25, Math.min(4, Number(value) || 1))
    audio.playbackRate = rate
    return rate
  }

  function setPreservesPitch (value) {
    const flag = Boolean(value)
    if ('preservesPitch' in audio) audio.preservesPitch = flag
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = flag
  }

  function lastError () {
    const error = audio.error
    if (!error) return null
    return { code: error.code, message: ERROR_MESSAGES[error.code] || '播放出错' }
  }

  /**
   * WebAudio 插入点：插件可以拿到 analyser 之类做可视化。
   *
   * 注意两点：
   *  1. 只有插件真的需要时才创建 —— 一旦创建，音频输出就改由 WebAudio 直连
   *     destination，若音频元素不是 CORS 模式就会被静音。
   *  2. 创建后如果 AudioContext 处于 suspended（没有用户手势），需要 resume。
   */
  function getTap () {
    if (tap) return tap
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    const context = new Ctx()
    const source = context.createMediaElementSource(audio)
    source.connect(context.destination)
    const extraNodes = new Set()
    tap = {
      context,
      source,
      /** 把节点串到输出上，返回断开函数 */
      connect (node) {
        source.connect(node)
        node.connect(context.destination)
        extraNodes.add(node)
        return () => {
          try {
            source.disconnect(node)
            node.disconnect(context.destination)
          } catch {
            // 已断开
          }
          extraNodes.delete(node)
        }
      },
      resume: () => context.state === 'suspended' ? context.resume() : Promise.resolve(),
      dispose () {
        for (const node of extraNodes) {
          try {
            source.disconnect(node)
            node.disconnect(context.destination)
          } catch {
            // 忽略
          }
        }
        extraNodes.clear()
        source.disconnect()
        return context.close()
      }
    }
    return tap
  }

  function dispose () {
    audio.pause()
    audio.removeAttribute('src')
    tap?.dispose()
    tap = null
  }

  /** 只有在插件创建过接入点时才会恢复 AudioContext（没有则什么都不做） */
  function resumeTap () {
    if (tap && tap.context.state === 'suspended') tap.context.resume().catch(() => {})
  }

  return {
    element: audio,
    load,
    play,
    pause,
    stop,
    toggle,
    seek,
    seekBy,
    getTime,
    getDuration,
    getBufferedEnd,
    setVolume,
    getVolume,
    setMuted,
    setRate,
    setPreservesPitch,
    lastError,
    getTap,
    resumeTap,
    dispose,
    get paused () {
      return audio.paused
    },
    get ended () {
      return audio.ended
    },
    get currentUrl () {
      return currentUrl
    }
  }
}
