/**
 * iOS 风格滑块。进度条、音量、倍速共用。
 * 拖动时通过 onInput 实时回调，松手时 onCommit 提交（用于 seek）。
 */

import { h, on } from '../core/dom.js'

export function createSlider ({
  className = '',
  min: initialMin = 0,
  max: initialMax = 1,
  step = 0,
  value = 0,
  buffered = false,
  tooltip = true,
  formatTooltip = (v) => String(v),
  onInput = null,
  onCommit = null
} = {}) {
  let min = initialMin
  let max = initialMax

  const fill = h('div', { class: 'slider__fill' })
  const bufferedFill = buffered ? h('div', { class: 'slider__buffered' }) : null
  const track = h('div', { class: 'slider__track' }, bufferedFill, fill)
  const thumb = h('div', { class: 'slider__thumb' })
  const tooltipNode = tooltip ? h('div', { class: 'slider__tooltip' }) : null

  const element = h('div', {
    class: `slider ${className}`.trim(),
    role: 'slider',
    tabindex: '0'
  }, track, thumb, tooltipNode)

  let current = value
  let dragging = false
  let position = 0

  function quantize (raw) {
    let next = Math.max(min, Math.min(max, raw))
    if (step > 0) next = Math.round(next / step) * step
    return next
  }

  function ratioOf (value) {
    if (max === min) return 0
    return Math.max(0, Math.min(1, (value - min) / (max - min)))
  }

  function paint (value) {
    position = ratioOf(value)
    fill.style.width = `${position * 100}%`
    thumb.style.left = `${position * 100}%`
    if (tooltipNode) tooltipNode.textContent = formatTooltip(value)
    element.setAttribute('aria-valuenow', String(Math.round(value * 100) / 100))
  }

  function valueFromEvent (event) {
    const rect = track.getBoundingClientRect()
    if (!rect.width) return current
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    return quantize(min + ratio * (max - min))
  }

  on(element, 'pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = true
    element.classList.add('is-dragging')
    element.setPointerCapture?.(event.pointerId)
    const next = valueFromEvent(event)
    current = next
    paint(next)
    if (tooltipNode) {
      tooltipNode.style.left = `${position * 100}%`
    }
    onInput?.(next, { dragging: true })
    event.preventDefault()
    event.stopPropagation()
  })

  on(element, 'pointermove', (event) => {
    if (!dragging) return
    const next = valueFromEvent(event)
    if (next === current) return
    current = next
    paint(next)
    if (tooltipNode) tooltipNode.style.left = `${position * 100}%`
    onInput?.(next, { dragging: true })
  })

  const endDrag = (event) => {
    if (!dragging) return
    dragging = false
    element.classList.remove('is-dragging')
    element.releasePointerCapture?.(event.pointerId)
    onCommit?.(current)
  }

  on(element, 'pointerup', endDrag)
  on(element, 'pointercancel', endDrag)

  // 键盘可达性
  on(element, 'keydown', (event) => {
    const big = (max - min) / 10
    const small = step || (max - min) / 100
    let next = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = quantize(current + small)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = quantize(current - small)
    else if (event.key === 'PageUp') next = quantize(current + big)
    else if (event.key === 'PageDown') next = quantize(current - big)
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    if (next === null) return
    event.preventDefault()
    current = next
    paint(next)
    onInput?.(next, { dragging: false })
    onCommit?.(next)
  })

  paint(value)

  return {
    element,
    get value () {
      return current
    },
    get dragging () {
      return dragging
    },
    setValue (next, { force = false } = {}) {
      if (dragging && !force) return
      const value = quantize(next)
      if (value === current && !force) return
      current = value
      paint(value)
    },
    setRange (nextMin, nextMax) {
      min = nextMin
      max = nextMax
      paint(current)
    },
    setBuffered (seconds) {
      if (!bufferedFill) return
      bufferedFill.style.width = `${ratioOf(seconds) * 100}%`
    },
    setTooltip (text) {
      if (tooltipNode) tooltipNode.textContent = text
    }
  }
}
