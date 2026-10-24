/** 播放队列面板 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { formatDuration } from '../../core/format.js'
import { EVENTS } from '../../core/bus.js'

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

  /*
   * 计数行右侧顺带显示睡眠状态（「40 首 · 睡眠 15 分钟」）。
   * 队列**当参数传**进来 —— render 里的 playlist 是局部变量，函数定义在外面拿不到它
   * （上一版就是踩了这个，运行期 ReferenceError 把整个面板渲染搞坏了）。
   * 数据源是 store，状态是唯一事实来源，不缓存第二份真相。
   */
  let sleepMinutes = store.get().settings.sleepTimerMinutes || 0
  const paintCount = (queue) => {
    const parts = [queue.length ? `${queue.length} 首` : '']
    if (sleepMinutes) parts.push(`睡眠 ${sleepMinutes} 分钟`)
    countLabel.textContent = parts.filter(Boolean).join(' · ')
  }
  store.subscribe((state) => {
    const next = state.settings.sleepTimerMinutes || 0
    if (next === sleepMinutes) return
    sleepMinutes = next
    paintCount(player.playlist.queue)
  })

  /*
   * 队列拖动排序。
   *
   * 骨架抄侧栏（那里已经有 pointerdown → 阈值 5px → 指针移动重排 → 松手落盘）：
   *  · 拖动中只动 DOM（insertBefore），不给被拖的行加 transform —— 队列每行一样高，
   *    指针一过中线就换位，简单可靠；
   *  · 松手后把 DOM 顺序读成 id 列表交给 player.reorderQueue()，由它保证
   *    「当前曲目不变」并把顺序写进设置。
   */
  const DRAG_THRESHOLD = 5
  let drag = null
  let suppressClick = false

  function rows () {
    return [...body.querySelectorAll('.queue-item')]
  }

  function reorderRows (pointerY, node) {
    const others = rows().filter((item) => item !== node)
    let index = others.findIndex((item) => {
      const rect = item.getBoundingClientRect()
      return pointerY < rect.top + rect.height / 2
    })
    if (index === -1) index = others.length
    const next = others[index]
    if (next) body.insertBefore(node, next)
    else body.appendChild(node)
  }

  function onPointerMove (event) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const dy = event.clientY - drag.startY
    if (!drag.active) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return
      drag.active = true
      drag.node.classList.add('is-dragging')
      body.classList.add('is-reordering')
    }
    event.preventDefault()
    reorderRows(event.clientY, drag.node)
  }

  function endDrag (event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
    const { node, active } = drag
    drag = null
    node.classList.remove('is-dragging')
    body.classList.remove('is-reordering')
    if (!active) return
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)
    const ids = rows().map((item) => item.dataset.queueId).filter(Boolean)
    if (ids.length) {
      player.reorderQueue(ids)
      bus.emit(EVENTS.TOAST, { message: '队列顺序已保存', type: 'success', duration: 1600 })
    }
  }

  function onPointerDown (event) {
    if (event.button !== 0 || drag) return
    const node = event.target.closest('.queue-item')
    if (!node || !node.dataset.queueId) return
    drag = { node, pointerId: event.pointerId, startY: event.clientY, active: false }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }

  body.addEventListener('pointerdown', onPointerDown)
  body.addEventListener('click', (event) => {
    /* 拖动之后紧跟的那一次 click 不该被当成「跳到这首歌」 */
    if (!suppressClick) return
    event.stopPropagation()
    event.preventDefault()
    suppressClick = false
  }, true)

  function render () {
    const state = store.get()
    const playlist = player.playlist
    const order = playlist.order
    const queue = playlist.queue
    const byId = state.library.byId
    const currentId = state.playback.trackId

    clear(body)
    paintCount(queue)

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
        dataset: { queueId: track.id },
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
  store.select((state) => state.playback.queue, render, {
    /*
     * 必须比内容，不能只比长度。
     * 只比长度的话，从媒体墙点另一张专辑（曲目数恰好一样）时队列面板不会重画，
     * 用户看到的就是「点了 evermore，队列里还是上一张专辑」。
     */
    equals: (a, b) => a.length === b.length && a.every((id, index) => id === b[index])
  })
  store.select((state) => state.playback.trackId, () => {
    if (!element.hidden) render()
  })
  bus.on(EVENTS.QUEUE_CHANGED, () => {
    if (!element.hidden) render()
  })

  return { element, render }
}
