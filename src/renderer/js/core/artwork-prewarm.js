/**
 * 封面后台预热。
 *
 * 首次打开媒体墙时一屏要出上百张封面，即使有节流也要几秒才填满。
 * 这里的做法是：扫描完资料库之后，趁空闲一张一张地把封面读进主进程的磁盘缓存
 * （间隔 200ms 以上，UI 一旦在要封面就让路），这样之后打开媒体墙基本是秒出。
 *
 * 只预热磁盘缓存，不去碰渲染层的 blob 缓存，避免占着几百个 blob URL。
 */

const IDLE_INTERVAL = 220
const BUSY_RETRY = 900
const IDLE_RETRY = 1500

export function createArtworkPrewarmer ({ bus, remote, settings, actions, lazy, isBusy }) {
  /** @type {Set<string>} 本次会话已预热过的专辑 */
  const warmed = new Set()
  let timer = null
  let running = false
  let paused = false
  let stopped = false
  /** 最小化等场景下临时让路：与 paused（界面正忙）分开记，语义不同 */
  let suspended = false
  const stats = { warmed: 0, skipped: 0, failed: 0, startedAt: 0 }

  function enabled () {
    return settings.get().prewarmArtwork !== false
  }

  function schedule (delay) {
    if (stopped || suspended) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, delay)
  }

  function busy () {
    if (typeof isBusy === 'function') return isBusy()
    const state = lazy?.state
    return Boolean(state && (state.active > 0 || state.queued > 0))
  }

  async function tick () {
    timer = null
    if (stopped || !enabled()) return

    // 界面正在要封面 —— 让路，别和用户抢
    if (busy()) {
      paused = true
      schedule(BUSY_RETRY)
      return
    }
    paused = false

    const album = actions.albums().find((item) => !warmed.has(item.key))
    if (!album) {
      schedule(IDLE_RETRY)
      return
    }

    warmed.add(album.key)
    const track = album.artworkTrack
    if (!track?.id) {
      stats.skipped++
      schedule(IDLE_INTERVAL)
      return
    }

    try {
      await remote.library.artwork(track.id)
      stats.warmed++
    } catch {
      stats.failed++
    }
    schedule(IDLE_INTERVAL)
  }

  function start () {
    if (stopped) return
    if (!running) {
      running = true
      stats.startedAt = Date.now()
    }
    schedule(IDLE_INTERVAL)
  }

  /** 临时让路（最小化时用）：不结束会话，回来还能接着预热 */
  function suspend () {
    suspended = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function resume () {
    if (!suspended) return
    suspended = false
    if (!stopped && enabled()) schedule(IDLE_INTERVAL)
  }

  function stop () {
    stopped = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * 封面缓存被清空之后必须重来一遍。
   *
   * `warmed` 是「这个专辑我预热过」的记账，清空缓存并不会让它失效 ——
   * 于是清空之后预热器认为无事可做，缓存一直是空的，直到重启。
   * 设置页清空缓存时会发这个事件（自检里也用它来验证预热真的会重做）。
   */
  function reset () {
    warmed.clear()
    if (!stopped && enabled()) schedule(IDLE_INTERVAL)
  }

  bus.on('artwork:cache-cleared', reset)

  // 资料库变化后继续把新增的专辑补上（已预热过的不会重复）
  bus.on('library:updated', () => {
    if (!stopped && enabled()) schedule(IDLE_RETRY)
  })

  return {
    start,
    suspend,
    resume,
    reset,
    stop,
    get state () {
      return {
        running,
        paused,
        suspended,
        stopped,
        warmed: stats.warmed,
        failed: stats.failed,
        skipped: stats.skipped,
        tracked: warmed.size
      }
    }
  }
}
