/** 复用的封面视图：曲目变化时异步换图，带占位图标 */

import { h, clear, on } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { artworkKey } from '../core/artwork.js'

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
