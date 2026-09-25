/**
 * 右侧的「滚动轮盘」：可收缩、可弹出的字母索引条。
 *
 * 用户否掉了上一版细长滚动条（拖动时滑块不跟手、样式也不喜欢），要的是：
 *   · 平时收成一条很窄的把手，鼠标靠近 / 悬浮才展开；
 *   · 展开后中间是一列**首字母**（当前页歌曲的首字母），旁边一个「选中框」表示视口位置；
 *   · 悬浮到字母上会放大，点它直接跳到那一组；
 *   · 滚轮在轮盘上滚 = 大范围翻动（比普通滚动快得多）；
 *   · 左键拖动选中框 = 连续滚动。
 *
 * 上一版的 bug 也在这里修掉：拖动时滑块要**跟着手指走**。
 * 之前拖动过程中提前 return，只更新了 scrollTop 却没更新滑块位置，
 * 于是松手后滑块才「瞬移」过去。现在拖动中每帧都按指针位置画。
 */

import { h, on } from '../../core/dom.js'

const IDLE_DELAY = 1100
const WHEEL_SPEED = 4 // 轮盘上滚轮的倍率

export function createScrollIndicator (scroller, { label = '滚动', getMarks = null } = {}) {
  const rail = h('div', { class: 'wheel__marks' })
  const box = h('div', { class: 'wheel__box' })
  const wheel = h('div', {
    class: 'wheel',
    role: 'scrollbar',
    'aria-label': label,
    'aria-orientation': 'vertical'
  }, rail, box)

  let idleTimer = null
  let dragging = false
  let dragOffset = 0
  let marks = []
  let lastTick = 0

  /** 视口高度 / 内容高度 → 选中框的位置与高度 */
  function geometry () {
    const view = scroller.clientHeight
    const total = scroller.scrollHeight
    const trackH = wheel.clientHeight || view
    const boxH = Math.max(28, Math.round((view / Math.max(1, total)) * trackH))
    const maxScroll = Math.max(1, total - view)
    const maxTop = Math.max(1, trackH - boxH)
    const top = (scroller.scrollTop / maxScroll) * maxTop
    return { view, total, trackH, boxH, maxScroll, maxTop, top }
  }

  function refresh () {
    const { view, total, boxH, top } = geometry()
    if (!view || total <= view + 1) {
      wheel.classList.add('is-hidden')
      return
    }
    wheel.classList.remove('is-hidden')
    box.style.height = `${boxH}px`
    box.style.transform = `translateY(${Math.round(top)}px)`
    wheel.setAttribute('aria-valuenow', String(Math.round(scroller.scrollTop)))

    // 首字母：只在展开时才画（收起时别浪费）
    if (wheel.classList.contains('is-active')) paintMarks()
  }

  /** 把首字母铺到轨道上，位置按「那一组在列表里的比例」定 */
  function paintMarks () {
    if (!marks.length) return
    const { trackH } = geometry()
    const total = Math.max(1, scroller.scrollHeight)
    const nodes = marks.map((mark) => h('button', {
      class: 'wheel__mark',
      type: 'button',
      text: mark.letter,
      title: `${mark.letter}（${mark.count} 首）`,
      style: { top: `${Math.round((mark.offset / total) * Math.max(0, trackH - 16))}px` },
      onClick: (event) => {
        event.stopPropagation()
        scroller.scrollTop = mark.offset
        wake()
      }
    }))
    rail.replaceChildren(...nodes)
  }

  function wake () {
    wheel.classList.add('is-active')
    paintMarks()
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!dragging && !wheel.matches(':hover')) wheel.classList.remove('is-active')
    }, IDLE_DELAY)
  }

  function scrollFromPointer (clientY) {
    const rect = wheel.getBoundingClientRect()
    const { boxH, maxTop, maxScroll } = geometry()
    const local = clientY - rect.top - dragOffset
    const clamped = Math.max(0, Math.min(maxTop, local))
    scroller.scrollTop = (clamped / maxTop) * maxScroll
    // 关键：拖动过程中也要画，不然松手才「瞬移」
    box.style.transform = `translateY(${Math.round(clamped)}px)`
  }

  on(box, 'pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    dragging = true
    const rect = box.getBoundingClientRect()
    dragOffset = event.clientY - rect.top
    wheel.classList.add('is-dragging', 'is-active')
    wake()
    try { box.setPointerCapture(event.pointerId) } catch { /* 无所谓 */ }
  })

  on(box, 'pointermove', (event) => {
    if (!dragging) return
    scrollFromPointer(event.clientY)
  })

  const endDrag = (event) => {
    if (!dragging) return
    dragging = false
    wheel.classList.remove('is-dragging')
    try { if (event?.pointerId !== undefined) box.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
    wake()
    refresh()
  }
  on(box, 'pointerup', endDrag)
  on(box, 'pointercancel', endDrag)

  // 点轮盘空白 = 跳到那一段
  on(wheel, 'pointerdown', (event) => {
    if (event.target !== wheel && event.target !== rail) return
    const { boxH, maxTop, maxScroll } = geometry()
    const rect = wheel.getBoundingClientRect()
    const target = Math.max(0, Math.min(maxTop, event.clientY - rect.top - boxH / 2))
    scroller.scrollTop = (target / maxTop) * maxScroll
    wake()
  })

  // 滚轮：大幅翻动（用户要「上下大规模翻动」）
  on(wheel, 'wheel', (event) => {
    event.preventDefault()
    scroller.scrollTop += event.deltaY * WHEEL_SPEED
    wake()
  }, { passive: false })

  on(wheel, 'mouseenter', () => wake())
  on(wheel, 'mouseleave', () => { if (!dragging) wake() })

  on(scroller, 'scroll', () => {
    refresh()
    const now = Date.now()
    // 滚动时亮起来，但不要每帧都重画字母
    if (!wheel.classList.contains('is-active')) wake()
    else if (now - lastTick > 400) { lastTick = now; paintMarks() }
  }, { passive: true })

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => refresh()) : null
  observer?.observe(scroller)
  if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild)
  window.addEventListener('resize', refresh)

  return {
    element: wheel,
    refresh,
    /** 列表换了：重新算首字母（track-list 在 setTracks 时调用） */
    setMarks (next) {
      marks = Array.isArray(next) ? next : []
      if (wheel.classList.contains('is-active')) paintMarks()
    },
    destroy () {
      observer?.disconnect()
      window.removeEventListener('resize', refresh)
      if (idleTimer) clearTimeout(idleTimer)
    }
  }
}

/**
 * 把曲目列表折成「首字母 → 偏移量」。
 * 用拼音/拉丁首字母不现实（要词典），所以直接取标题的第一个字符并大写 ——
 * 中文歌就是「中」「爱」这类字，英文歌就是 A/B/C，和列表里看到的对得上。
 */
export function marksFromTracks (tracks, rowHeight) {
  const out = []
  let current = null
  tracks.forEach((track, index) => {
    const source = (track.title || track.artist || '#').trim()
    const letter = (source[0] || '#').toUpperCase()
    if (!current || current.letter !== letter) {
      current = { letter, offset: index * rowHeight, count: 0 }
      out.push(current)
    }
    current.count++
  })
  return out
}
