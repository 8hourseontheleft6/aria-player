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
 * 额外提供 suspend / resume：媒体墙用 transform 平移时，
 * 容器位置每帧都在变，浏览器要为所有观察目标重算相交性（几百个目标就是几十毫秒），
 * 因此拖动期间直接断开观察，松手后再重新挂上。
 */
export function createLazyArtwork (artwork, { root = null, rootMargin = '320px', fallbackIcon = 'music' } = {}) {
  /** @type {WeakMap<Element, object>} */
  const wanted = new WeakMap()
  /** 仍需要加载封面的节点（WeakMap 不可遍历，所以另存一份） */
  const pending = new Set()
  let suspended = false

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const track = wanted.get(entry.target)
      if (!track) continue
      observer.unobserve(entry.target)
      pending.delete(entry.target)
      paint(entry.target, track)
    }
  }, { root, rootMargin })

  async function paint (node, track) {
    const key = artworkKey(track)
    node.dataset.artKey = key || ''
    if (!key) return
    const url = await artwork.resolveUrl(track)
    // 节点可能已经被回收给别的条目了
    if (!url || node.dataset.artKey !== key) return
    if (node.querySelector('img')) return
    node.replaceChildren(h('img', { src: url, alt: '', decoding: 'async', loading: 'lazy' }))
  }

  return {
    /**
     * @param {HTMLElement} node 封面容器（内部会先放一个占位图标）
     * @param {object} track
     */
    observe (node, track, iconName = fallbackIcon) {
      if (!node.querySelector('img')) node.replaceChildren(icon(iconName))
      if (!track) return
      wanted.set(node, track)
      node.dataset.artKey = artworkKey(track) || ''
      if (!node.querySelector('img')) pending.add(node)
      if (!suspended) observer.observe(node)
    },

    /** 拖动期间暂停观察，省掉每帧的相交性重算 */
    suspend () {
      if (suspended) return
      suspended = true
      observer.disconnect()
    },

    /** 松手后重新挂上还没拿到封面的节点 */
    resume () {
      if (!suspended) return
      suspended = false
      let skipped = 0
      for (const node of [...pending]) {
        if (!node.isConnected || node.querySelector('img')) {
          pending.delete(node)
          continue
        }
        observer.observe(node)
        skipped++
      }
      return skipped
    },

    /** 自检用：当前观察目标数与暂停状态 */
    get state () {
      return { suspended, pending: pending.size, observing: suspended ? 0 : pending.size }
    },

    disconnect () {
      observer.disconnect()
      pending.clear()
    }
  }
}
