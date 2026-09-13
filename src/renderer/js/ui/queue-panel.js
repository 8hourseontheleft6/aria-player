/** 播放队列面板 */

import { h, on, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { formatDuration } from '../core/format.js'
import { EVENTS } from '../core/bus.js'

export function createQueuePanel ({ store, bus, player, artwork, actions }) {
  const countLabel = h('div', { class: 'view-toolbar__meta' })
  const body = h('div', { class: 'queue-panel__body scroll' })

  const clearButton = h('button', {
    class: 'btn btn--icon-sm',
    type: 'button',
    title: '清空队列',
    onClick: () => {
      player.playlist.clear()
      bus.emit(EVENTS.QUEUE_CHANGED, [])
      actions.toggleQueue(false)
    }
  }, icon('trash', { className: 'icon icon--stroke' }))

  const closeButton = h('button', {
    class: 'btn btn--icon-sm',
    type: 'button',
    title: '关闭',
    onClick: () => actions.toggleQueue(false)
  }, icon('close', { className: 'icon icon--stroke' }))

  const head = h('div', { class: 'queue-panel__head' },
    h('div', {}, h('div', { class: 'queue-panel__title', text: '播放队列' }), countLabel),
    h('div', { style: { display: 'flex', gap: '4px' } }, clearButton, closeButton)
  )

  const element = h('div', { class: 'queue-panel', hidden: true }, head, body)

  function render () {
    const state = store.get()
    const playlist = player.playlist
    const order = playlist.order
    const queue = playlist.queue
    const byId = state.library.byId
    const currentId = state.playback.trackId

    clear(body)
    countLabel.textContent = queue.length ? `${queue.length} 首` : ''

    if (!queue.length) {
      body.appendChild(h('div', { class: 'empty' },
        icon('waveform', { className: 'icon icon--stroke empty__icon' }),
        h('div', { class: 'empty__title', text: '队列是空的' }),
        h('div', { class: 'empty__text', text: '在列表里双击一首歌，或点「播放」把当前列表加入队列。' })
      ))
      return
    }

    order.forEach((queueIndex, position) => {
      const track = byId.get(queue[queueIndex])
      if (!track) return
      const isCurrent = track.id === currentId

      const artNode = h('div', { class: 'queue-item__art' }, icon('music'))
      if (state.settings.showRowArtwork) {
        artwork.resolveUrl(track).then((url) => {
          if (!url) return
          clear(artNode)
          artNode.appendChild(h('img', { src: url, alt: '', decoding: 'async' }))
        }).catch(() => {})
      }

      const row = h('button', {
        class: `queue-item${isCurrent ? ' is-current' : ''}`,
        type: 'button',
        onClick: () => {
          player.jumpToQueuePosition(position)
          actions.closeQueueOnNarrow()
        },
        onContextmenu: (event) => {
          event.preventDefault()
          actions.openTrackMenu(track, event)
        }
      },
      artNode,
      h('div', { class: 'queue-item__text' },
        h('div', { class: 'queue-item__title truncate', text: track.title }),
        h('div', { class: 'queue-item__artist truncate', text: track.artist })
      ),
      h('span', { class: 'queue-item__duration', text: formatDuration(track.duration) })
      )

      if (isCurrent) {
        row.appendChild(h('div', { class: 'bars' }, h('span'), h('span'), h('span')))
      }
      body.appendChild(row)
    })
  }

  store.select((state) => state.ui.queueOpen, (open) => {
    element.hidden = !open
    if (open) render()
  })
  store.select((state) => state.playback.queue, render, { equals: (a, b) => a.length === b.length })
  store.select((state) => state.playback.trackId, () => {
    if (!element.hidden) render()
  })
  bus.on(EVENTS.QUEUE_CHANGED, () => {
    if (!element.hidden) render()
  })

  return { element, render }
}
