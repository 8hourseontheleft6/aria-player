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
