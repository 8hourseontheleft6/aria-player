/** 复用的封面视图：曲目变化时异步换图，带占位图标 */

import { h, clear, on } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { artworkKey } from '../../core/artwork.js'

export function createArtworkView ({ artwork, className = 'artwork', fallbackIcon = 'music', onClick = null }) {
  const element = h('div', { class: className }, icon(fallbackIcon))
  let currentKey = null

  async function setTrack (track) {
    const key = artworkKey(track)
    if (key === currentKey) return
    currentKey = key
    clear(element)
    element.appendChild(icon(fallbackIcon))
    if (!key) return
    const url = await artwork.resolveUrl(track)
    if (!url || artworkKey(track) !== currentKey) return
    clear(element)
    element.appendChild(h('img', { src: url, alt: '', decoding: 'async' }))
  }

  if (onClick) on(element, 'click', onClick)

  return { element, setTrack }
}

/**
 * 懒加载封面：只有滚进视口（+预加载边距）的节点才去解析封面，
 * 专辑网格、艺人列表、媒体墙都用它，避免几百张封面同时读盘。
 *
 * 三条节流措施（首屏一次涌现上百张封面时的卡顿就来自没有节流）：
 *  1) 并发上限：同时最多 4 个在途请求，主进程不会被封面解析压满
 *  2) 每帧配额：每帧最多启动 3 个，避免某一帧突然解码一大批图片
 *  3) suspend/resume：用 transform 平移时容器位置每帧都在变，
 *     浏览器要为所有观察目标重算相交性，因此手势期间直接断开观察
 */
const MAX_CONCURRENT = 4
const MAX_PER_FRAME = 3

export function createLazyArtwork (artwork, { root = null, rootMargin = '320px', fallbackIcon = 'music' } = {}) {
  /** @type {WeakMap<Element, object>} */
  const wanted = new WeakMap()
  /** 仍需要加载封面的节点（WeakMap 不可遍历，所以另存一份） */
  const pending = new Set()
  /** 已进入视口、等待节流放行的任务 */
  const queue = []
  let active = 0
  let pumpHandle = 0
  let suspended = false

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const track = wanted.get(entry.target)
      observer.unobserve(entry.target)
      if (!track) continue
      queue.push({ node: entry.target, track })
    }
    schedulePump()
  }, { root, rootMargin })

  function schedulePump () {
    if (pumpHandle || suspended) return
    pumpHandle = requestAnimationFrame(() => {
      pumpHandle = 0
      let started = 0
      while (queue.length && active < MAX_CONCURRENT && started < MAX_PER_FRAME && !suspended) {
        const job = queue.shift()
        if (!job.node.isConnected || job.node.querySelector('img')) {
          pending.delete(job.node)
          continue
        }
        active++
        started++
        paint(job.node, job.track)
          .catch(() => {})
          .then(() => {
            active--
            schedulePump()
          })
      }
      if (queue.length && !suspended) schedulePump()
    })
  }

  async function paint (node, track) {
    const key = artworkKey(track)
    node.dataset.artKey = key || ''
    if (!key) return
    const url = await artwork.resolveUrl(track)
    // 节点可能已经被回收给别的条目了
    if (!url || node.dataset.artKey !== key) return
    if (node.querySelector('img')) return
    node.replaceChildren(h('img', { src: url, alt: '', decoding: 'async', loading: 'lazy' }))
    pending.delete(node)
  }

  return {
    /**
     * @param {HTMLElement} node 封面容器
     * @param {object} track
     * @param {string|null} iconName 占位图标；传 null 则不放（用 CSS 占位，省下大量 DOM 节点）
     */
    observe (node, track, iconName = fallbackIcon) {
      if (iconName && !node.querySelector('img')) node.replaceChildren(icon(iconName))
      if (!track) return
      wanted.set(node, track)
      node.dataset.artKey = artworkKey(track) || ''
      if (node.querySelector('img')) return
      pending.add(node)
      if (!suspended) observer.observe(node)
    },

    /** 拖动期间暂停观察与加载，省掉每帧的相交性重算 */
    suspend () {
      if (suspended) return
      suspended = true
      observer.disconnect()
      if (pumpHandle) {
        cancelAnimationFrame(pumpHandle)
        pumpHandle = 0
      }
    },

    /** 松手后重新挂上还没拿到封面的节点，并继续放行队列 */
    resume () {
      if (!suspended) return
      suspended = false
      for (const node of [...pending]) {
        if (!node.isConnected || node.querySelector('img')) {
          pending.delete(node)
          continue
        }
        observer.observe(node)
      }
      schedulePump()
    },

    /**
     * 按几何手动兜底扫描：把「已经落在 root 可视范围内」的待加载节点直接送进队列。
     *
     * 为什么需要它：媒体墙的平移是靠祖先的 transform 完成的（纯合成，不触发布局），
     * 这种情况下 IntersectionObserver 不一定会为「因为平移而进入视口」的目标
     * 派发新的相交回调 —— 实测拖到中段之后，新露出来的格子一直是灰底占位图
     * （可见 129 格只有 20 格有封面，observing 正常但 queued/active 恒为 0）。
     *
     * 代价控制：
     *  · 只在「平移停稳 / 布局变化」这类时刻调用一次，不在每帧路径上；
     *  · 给了 root 时只看 root 子树内的节点，媒体墙之外的观察目标
     *    （专辑网格、艺人列表）直接跳过；
     *  · 每个节点只做一次 getBoundingClientRect，之后浏览器从布局缓存里读。
     *
     * @param {{ root?: Element|null, rootMargin?: number }} [options]
     */
    scan ({ root = null, rootMargin = 320 } = {}) {
      if (suspended) return { added: 0, scanned: 0, elapsedMs: 0 }
      const started = performance.now()
      const box = root ? root.getBoundingClientRect() : null
      // root 自己没尺寸（视图被隐藏）时不做，避免把别的视图的节点误判成可见
      if (box && (!box.width || !box.height)) return { added: 0, scanned: 0, elapsedMs: 0 }
      const left = (box ? box.left : 0) - rootMargin
      const top = (box ? box.top : 0) - rootMargin
      const right = (box ? box.right : window.innerWidth) + rootMargin
      const bottom = (box ? box.bottom : window.innerHeight) + rootMargin

      let added = 0
      let scanned = 0
      for (const node of [...pending]) {
        if (!node.isConnected || node.querySelector('img')) {
          pending.delete(node)
          continue
        }
        if (root && !root.contains(node)) continue
        scanned++
        const rect = node.getBoundingClientRect()
        // display:none 之类的零尺寸节点不参与，它们本来也显示不了封面
        if (!rect.width && !rect.height) continue
        if (rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom) continue
        const track = wanted.get(node)
        if (!track) {
          pending.delete(node)
          continue
        }
        // 先摘掉观察，避免同一个节点在两处重复排队
        //（真重复了也无害：出队时会因为已经有 img 而跳过）
        observer.unobserve(node)
        queue.push({ node, track })
        added++
      }
      if (added) schedulePump()
      return { added, scanned, elapsedMs: Math.round((performance.now() - started) * 100) / 100 }
    },

    /** 自检用：观察目标数、在途请求数、排队数 */
    get state () {
      return {
        suspended,
        pending: pending.size,
        observing: suspended ? 0 : pending.size,
        active,
        queued: queue.length
      }
    },

    disconnect () {
      observer.disconnect()
      queue.length = 0
      pending.clear()
    }
  }
}
