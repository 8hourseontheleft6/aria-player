/**
 * 右侧「旋钮」：中间显示当前页首字母的圆形旋钮。
 *
 * 用户要的交互（参考图里中间那个 0）：
 *   · 圆盘中间是**当前页面的首字母**（页面第一首、或这一页多数歌曲的首字母）；
 *   · 在字母上滚滚轮 = 快速换字母；
 *   · 停下之后**平滑过渡**，让「第一首该字母开头的歌」停在页面最上方；
 *   · 左键按住上下拖动同样换字母；悬浮放大，空闲时收起成一小颗。
 *
 * 上一版是细长滚动条 + 字母条，用户否掉了；这版把「滚动比例」换成「字母定位」。
 */

import { h, on } from '../../core/dom.js'
import { initialOf } from '../../core/pinyin.js'

const IDLE_DELAY = 900
const STEP_PX = 26 // 拖动多少像素换一个字母

export function createScrollIndicator (scroller, { label = '滚动', getMarks = null } = {}) {
  const letterNode = h('span', { class: 'knob__letter', text: '0' })
  const hintNode = h('span', { class: 'knob__hint', text: '' })
  const knob = h('div', {
    class: 'knob',
    role: 'slider',
    tabindex: '0',
    'aria-label': label,
    'aria-orientation': 'vertical'
  }, letterNode, hintNode)

  let marks = []
  let index = 0
  let dragging = false
  let dragStartY = 0
  let dragStartIndex = 0
  let settleTimer = null
  let idleTimer = null
  let programmaticUntil = 0

  function ensureMarks () {
    if (!marks.length && typeof getMarks === 'function') marks = getMarks() || []
  }

  /** 当前视口顶部对应的字母下标 */
  function indexFromScroll () {
    ensureMarks()
    if (!marks.length) return 0
    const top = scroller.scrollTop + 6
    let found = 0
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].offset <= top) found = i
      else break
    }
    return found
  }

  function paint (options = {}) {
    ensureMarks()
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 1
    if (!marks.length || !scrollable) {
      knob.classList.add('is-hidden')
      return
    }
    knob.classList.remove('is-hidden')
    index = Math.max(0, Math.min(marks.length - 1, index))
    const mark = marks[index]
    letterNode.textContent = mark.letter
    hintNode.textContent = options.hint || ''
    knob.setAttribute('aria-valuenow', String(index))
    knob.setAttribute('aria-valuetext', `${mark.letter}（第 ${index + 1} 组 / 共 ${marks.length} 组）`)
    knob.style.setProperty('--knob-progress', `${(index / Math.max(1, marks.length - 1)) * 100}%`)
  }

  /** 平滑滚到当前字母的第一首 */
  function apply (smooth = true) {
    ensureMarks()
    const mark = marks[index]
    if (!mark) return
    programmaticUntil = Date.now() + 900
    scroller.scrollTo({ top: mark.offset, behavior: smooth ? 'smooth' : 'auto' })
  }

  function wake () {
    knob.classList.add('is-active')
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!dragging && !knob.matches(':hover')) knob.classList.remove('is-active')
    }, IDLE_DELAY)
  }

  function step (delta) {
    ensureMarks()
    if (!marks.length) return
    const next = Math.max(0, Math.min(marks.length - 1, index + delta))
    if (next === index) return
    index = next
    paint({ hint: `${index + 1}/${marks.length}` })
    wake()
    // 连续滚动时不要一路跳，停 260ms 再平滑过去
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => apply(true), 260)
  }

  on(knob, 'wheel', (event) => {
    event.preventDefault()
    step(event.deltaY > 0 ? 1 : -1)
  }, { passive: false })

  on(knob, 'pointerdown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    dragging = true
    dragStartY = event.clientY
    dragStartIndex = index
    knob.classList.add('is-dragging')
    wake()
    try { knob.setPointerCapture(event.pointerId) } catch { /* 无所谓 */ }
  })

  on(knob, 'pointermove', (event) => {
    if (!dragging) return
    ensureMarks()
    const steps = Math.round((event.clientY - dragStartY) / STEP_PX)
    const next = Math.max(0, Math.min(marks.length - 1, dragStartIndex + steps))
    if (next !== index) {
      index = next
      paint({ hint: `${index + 1}/${marks.length}` })
    }
  })

  const endDrag = (event) => {
    if (!dragging) return
    dragging = false
    knob.classList.remove('is-dragging')
    try { if (event?.pointerId !== undefined) knob.releasePointerCapture(event.pointerId) } catch { /* 已释放 */ }
    apply(true)
    wake()
  }
  on(knob, 'pointerup', endDrag)
  on(knob, 'pointercancel', endDrag)

  // 键盘也能用：上下换字母，回车跳过去
  on(knob, 'keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); step(1) } else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1) } else if (event.key === 'Enter') { event.preventDefault(); apply(true) }
  })

  on(knob, 'mouseenter', () => { ensureMarks(); wake() })
  on(knob, 'mouseleave', () => { if (!dragging) knob.classList.remove('is-active') })

  // 列表自己滚动时旋钮跟着显示当前字母（自己触发的平滑滚动就别抢）
  on(scroller, 'scroll', () => {
    if (Date.now() < programmaticUntil) return
    const at = indexFromScroll()
    if (at !== index) {
      index = at
      paint()
    }
  }, { passive: true })

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => paint()) : null
  observer?.observe(scroller)
  if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild)
  window.addEventListener('resize', () => paint())

  return {
    element: knob,
    refresh: () => paint(),
    setMarks (next) {
      marks = Array.isArray(next) ? next : []
      index = indexFromScroll()
      paint()
    },
    destroy () {
      observer?.disconnect()
      if (idleTimer) clearTimeout(idleTimer)
      if (settleTimer) clearTimeout(settleTimer)
    }
  }
}

/**
 * 把曲目列表折成「首字母 → 偏移量」。
 * 不查拼音词典：直接取标题首字符 —— 中文歌是「爱」「时」这类字，英文歌是 A/B/C，
 * 和列表里看到的完全对得上（用户要的就是「页面上大部分歌曲的首字母」这种感觉）。
 */
export function marksFromTracks (tracks, rowHeight) {
  const out = []
  let current = null
  tracks.forEach((track, index) => {
    const source = (track.title || track.artist || '#').trim()
    // 拼音首字母：中文歌也要能归到 A/B/C（排序也是按这个首字母分组的）
    const letter = initialOf(source)
    if (!current || current.letter !== letter) {
      current = { letter, offset: index * rowHeight, count: 0 }
      out.push(current)
    }
    current.count++
  })
  return out
}
