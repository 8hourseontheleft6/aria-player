/** 可复用的封面网格（专辑视图、艺人详情都用它） */

import { h, on } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { clear } from '../core/dom.js'

export function createCoverGrid ({ lazy, onOpen, onPlay, className = '' }) {
  const element = h('div', { class: `cover-grid ${className}`.trim() })

  /**
   * @param {Array<{key: string, title: string, subtitle: string, artworkTrack: object, badge?: string}>} items
   */
  function setItems (items) {
    clear(element)
    const fragment = document.createDocumentFragment()

    for (const item of items) {
      const art = h('div', { class: 'cover-card__art' })
      lazy.observe(art, item.artworkTrack)

      const card = h('button', {
        class: 'cover-card',
        type: 'button',
        dataset: { key: item.key },
        title: `${item.title}${item.subtitle ? ` — ${item.subtitle}` : ''}`,
        onClick: () => onOpen?.(item)
      },
      art,
      h('div', { class: 'cover-card__meta' },
        h('div', { class: 'cover-card__title truncate', text: item.title }),
        h('div', { class: 'cover-card__sub truncate', text: item.subtitle || '' })
      ),
      onPlay
        ? h('span', {
          class: 'cover-card__play',
          title: '播放',
          onClick: (event) => {
            event.stopPropagation()
            onPlay(item)
          }
        }, icon('play'))
        : null,
      item.badge ? h('span', { class: 'cover-card__badge', text: item.badge }) : null
      )

      // 悬停时才出现的播放键需要阻止冒泡，pointerdown 也要拦一下避免触发卡片动画
      if (onPlay) on(card.querySelector('.cover-card__play'), 'pointerdown', (event) => event.stopPropagation())

      fragment.appendChild(card)
    }

    element.appendChild(fragment)
  }

  return { element, setItems, clear: () => clear(element) }
}

/** 艺人行（圆形头像 + 名称 + 统计） */
export function createArtistRows ({ lazy, onOpen }) {
  const element = h('div', { class: 'artist-rows' })

  function setItems (items) {
    clear(element)
    const fragment = document.createDocumentFragment()

    for (const item of items) {
      const avatar = h('div', { class: 'artist-row__avatar' })
      lazy.observe(avatar, item.artworkTrack, 'artist')

      fragment.appendChild(h('button', {
        class: 'artist-row',
        type: 'button',
        dataset: { key: item.key },
        onClick: () => onOpen?.(item)
      },
      avatar,
      h('div', { class: 'artist-row__text' },
        h('div', { class: 'artist-row__name truncate', text: item.name }),
        h('div', { class: 'artist-row__meta truncate', text: `${item.albumCount} 张专辑 · ${item.trackCount} 首` })
      ),
      icon('chevronRight', { className: 'icon icon--stroke artist-row__chevron' })
      ))
    }

    element.appendChild(fragment)
  }

  return { element, setItems }
}
