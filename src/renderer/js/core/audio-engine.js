/**
 * 音频引擎：包一层 HTMLAudioElement。
 * 只负责「播放」这件事，队列 / 模式 / 歌词都在上层，
 * 因此想换成 WebAudio 或加音效，只需要替换/包装这一层。
 */

import { createEqualizer } from './equalizer.js'

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
  /*
   * ReplayGain：只在真需要时（设置不是 off 且 dB 不为 0）才把音频图建出来。
   * 关掉时绝不建图 —— 播放路径保持原生，和没这个功能时完全一致。
   */
  let replayGainDb = 0

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

  /**
   * 指定输出设备（Chromium 的 setSinkId）。
   *
   * 这是「一边通话 / 打游戏语音，一边放歌，而对方听不到」的关键：
   * Windows / macOS 都允许按应用选择输出设备。把音乐送到**耳机**、把通话留在
   * 原来的设备（往往是音箱或另一副耳机），麦克风就不会拾到音乐，
   * 通话对端自然什么都听不到 —— 不需要虚拟声卡，也不需要把音乐调小。
   *
   * 传空字符串 = 跟随系统默认输出。设备被拔掉时浏览器会抛错，
   * 这时回落到默认设备并如实返回失败，由调用方提示用户。
   */
  async function setOutputDevice (deviceId) {
    if (typeof audio.setSinkId !== 'function') {
      return { ok: false, message: '当前运行时不支持指定输出设备' }
    }
    try {
      await audio.setSinkId(deviceId || '')
      return { ok: true }
    } catch (err) {
      // 设备没了就退回默认，别让播放直接哑掉
      try {
        await audio.setSinkId('')
        return { ok: false, message: `指定输出设备失败（${err.message}），已回退到系统默认` }
      } catch {
        return { ok: false, message: `指定输出设备失败：${err.message}` }
      }
    }
  }

  /** 当前实际生效的输出设备 id（空字符串 = 系统默认） */
  function outputDevice () {
    return typeof audio.sinkId === 'string' ? audio.sinkId : ''
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
    /*
     * 均衡器串在 source 与 destination 之间。
     * 建好之后音频输出就完全走 WebAudio 了 —— 这也是它「懒创建」的原因：
     * 用户没开均衡器、插件也没要可视化时，一个节点都不建，播放路径保持原生。
     */
    const equalizer = createEqualizer(context)
    /*
     * ReplayGain 的增益节点串在 source 与均衡器之间：
     *   source → replayGainNode → equalizer.input → ... → destination
     * 这样它调整的是「这首歌的响度」，不是用户自己的音量滑杆（那个还在 audio.volume 上）。
     */
    const replayGainNode = context.createGain()
    replayGainNode.gain.value = linearGain(replayGainDb)
    source.connect(replayGainNode)
    replayGainNode.connect(equalizer.input)
    equalizer.output.connect(context.destination)

    const extraNodes = new Set()
    tap = {
      context,
      source,
      equalizer,
      replayGainNode,
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

  /**
   * 设置均衡器。
   *
   * @param {string} key 预设 key（见 core/equalizer-presets.js）
   * @param {object} options { enabled }
   * @returns {object|null} 当前参数快照（拿不到上下文时返回 null）
   */
  function setEqualizer (key, { enabled = true } = {}) {
    // 关闭且从没建过图：什么都不用做，播放路径保持原生
    if (!enabled && !tap) return null
    const active = getTap()
    if (!active?.equalizer) return null
    active.equalizer.apply(key, { enabled })
    // 用户手势之外（例如启动时恢复设置）上下文可能是挂起的，这里顺手唤醒
    if (context_state_suspended(active)) active.resume()
    return active.equalizer.snapshot()
  }

  function context_state_suspended (active) {
    return active?.context?.state === 'suspended'
  }

  /** dB → 线性增益（0dB 与极小值都按 1 处理，避免浮点噪音） */
  function linearGain (db) {
    const value = Number(db)
    if (!Number.isFinite(value) || Math.abs(value) < 0.01) return 1
    return Math.pow(10, value / 20)
  }

  /**
   * 设置响度归一化的增益。
   *
   * @param {number} db 目标增益（0 表示不处理）
   * @returns {{ db: number, gain: number, active: boolean }}
   *
   * 注意 0dB 的行为：**不建图**。这样「关掉归一化」与「从没开过」在音频路径上完全一致。
   */
  function setReplayGain (db) {
    const value = Number(db)
    replayGainDb = Number.isFinite(value) ? value : 0
    if (Math.abs(replayGainDb) < 0.01) {
      if (tap?.replayGainNode) tap.replayGainNode.gain.value = 1
      return { db: 0, gain: 1, active: false }
    }
    const active = getTap()
    if (active?.replayGainNode) {
      active.replayGainNode.gain.value = linearGain(replayGainDb)
      if (context_state_suspended(active)) active.resume()
    }
    return { db: replayGainDb, gain: linearGain(replayGainDb), active: Boolean(active?.replayGainNode) }
  }

  /** 当前生效的 ReplayGain（没建过图时 active=false） */
  function replayGainSnapshot () {
    const node = tap?.replayGainNode
    return {
      db: replayGainDb,
      gain: node ? node.gain.value : linearGain(replayGainDb),
      active: Boolean(node) && Math.abs(replayGainDb) >= 0.01
    }
  }

  /** 均衡器当前参数（没建过图时返回 null） */
  function equalizerSnapshot () {
    return tap?.equalizer ? tap.equalizer.snapshot() : null
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
    setOutputDevice,
    outputDevice,
    setEqualizer,
    equalizerSnapshot,
    setReplayGain,
    replayGainSnapshot,
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
