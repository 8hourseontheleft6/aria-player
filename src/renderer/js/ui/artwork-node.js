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
 */
export function createLazyArtwork (artwork, { root = null, rootMargin = '320px', fallbackIcon = 'music' } = {}) {
  /** @type {WeakMap<Element, object>} */
  const wanted = new WeakMap()

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const track = wanted.get(entry.target)
      if (!track) continue
      observer.unobserve(entry.target)
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
      observer.observe(node)
    },
    disconnect () {
      observer.disconnect()
    }
  }
}
