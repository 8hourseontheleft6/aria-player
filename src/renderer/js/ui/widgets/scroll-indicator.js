/**
 * 灵动岛风格的滚动指示条（自定义，不用原生滚动条）。
 *
 * 为什么自己画：原生滚动条没法做成「悬浮药丸 + 悬停放大 + 拖动再放大」的样子，
 * 而这是 Aria 顶栏灵动岛的语言。这里的观感刻意和灵动岛对齐：
 *   · 收起态：细、半透明（--fill-floating + 0.5px 描边）
 *   · 悬停 / 滚动：变宽变亮（scaleX + 更实的填充）
 *   · 拖动中：再放大一点并加阴影，像被「拿起来」
 *
 * 行为：
 *   · 拖动滑块 = 滚动（带指针捕获，松手才结束）
 *   · 点轨道空白 = 跳到那一段
 *   · 内容不够一屏时自动隐藏
 */

import { h, on } from '../../core/dom.js'

const MIN_THUMB = 34
const IDLE_DELAY = 900

export function createScrollIndicator (scroller, { label = '滚动' } = {}) {
  const thumb = h('div', { class: 'scrollbar__thumb' })
  const element = h('div', {
    class: 'scrollbar',
    role: 'scrollbar',
    'aria-label': label,
    'aria-orientation': 'vertical',
    'aria-valuemin': '0'
  }, thumb)

  let idleTimer = null
  let dragging = false
  let dragStartY = 0
  let dragStartTop = 0

  /** 把当前滚动位置画到滑块上 */
  function refresh () {
    const view = scroller.clientHeight
    const total = scroller.scrollHeight
    if (!view || total <= view + 1) {
      element.classList.add('is-hidden')
      return
    }
    element.classList.remove('is-hidden')

    const box = element.getBoundingClientRect()
    const trackH = box.height || view
    const thumbH = Math.max(MIN_THUMB, Math.round((view / total) * trackH))
    const maxScroll = total - view
    const maxTop = trackH - thumbH
    const top = maxScroll > 0 ? Math.round((scroller.scrollTop / maxScroll) * maxTop) : 0

    if (dragging) return // 拖动中由指针位置决定，别被滚动事件拽回去
    thumb.style.height = `${thumbH}px`
    thumb.style.transform = `translateY(${top}px)`
    element.setAttribute('aria-valuemax', String(Math.round(maxScroll)))
    element.setAttribute('aria-valuenow', String(Math.round(scroller.scrollTop)))
  }

  /** 动一下就「醒过来」，停一会儿再收起（灵动岛同款节奏） */
  function wake () {
    element.classList.add('is-active')
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!dragging && !element.matches(':hover')) element.classList.remove('is-active')
    }, IDLE_DELAY)
  }

  function trackGeometry () {
    const box = element.getBoundingClientRect()
    const thumbH = thumb.getBoundingClientRect().height || MIN_THUMB
    const maxTop = Math.max(1, box.height - thumbH)
    const maxScroll = Math.max(1, scroller.scrollHeight - scroller.clientHeight)
    return { box, maxTop, maxScroll }
  }

  function scrollToTop (top) {
    const { maxTop, maxScroll } = trackGeometry()
    scroller.scrollTop = (Math.max(0, Math.min(maxTop, top)) / maxTop) * maxScroll
  }

  on(thumb, 'pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
    dragging = true
    dragStartY = event.clientY
    dragStartTop = thumb.getBoundingClientRect().top - element.getBoundingClientRect().top
    element.classList.add('is-dragging', 'is-active')
    try {
      thumb.setPointerCapture(event.pointerId)
    } catch {
      // 没有指针捕获也能用
    }
  })

  on(thumb, 'pointermove', (event) => {
    if (!dragging) return
    const delta = event.clientY - dragStartY
    scrollToTop(dragStartTop + delta)
  })

  const endDrag = (event) => {
    if (!dragging) return
    dragging = false
    element.classList.remove('is-dragging')
    try {
      if (event?.pointerId !== undefined) thumb.releasePointerCapture(event.pointerId)
    } catch {
      // 已经释放
    }
    wake()
    refresh()
  }
  on(thumb, 'pointerup', endDrag)
  on(thumb, 'pointercancel', endDrag)

  // 点轨道空白处 = 跳到那一段
  on(element, 'pointerdown', (event) => {
    if (event.target === thumb) return
    const { box } = trackGeometry()
    const thumbH = thumb.getBoundingClientRect().height || MIN_THUMB
    scrollToTop(event.clientY - box.top - thumbH / 2)
    wake()
  })

  on(element, 'mouseenter', () => {
    element.classList.add('is-active')
  })
  on(element, 'mouseleave', () => {
    if (!dragging) wake()
  })

  on(scroller, 'scroll', () => {
    refresh()
    wake()
  }, { passive: true })

  // 内容或容器尺寸变化时重新量（列表换页、窗口拉伸、进入多选让出列宽…）
  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => refresh())
    : null
  observer?.observe(scroller)
  if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild)

  const onWindowResize = () => refresh()
  window.addEventListener('resize', onWindowResize)

  return {
    element,
    refresh,
    destroy () {
      observer?.disconnect()
      window.removeEventListener('resize', onWindowResize)
      if (idleTimer) clearTimeout(idleTimer)
    }
  }
}
