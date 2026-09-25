/**
 * 音频可视化（早期 Windows Media Player 那种频谱条）。
 *
 * 数据来自 WebAudio 的 AnalyserNode：引擎的 getTap() 会建出音频图
 * （和均衡器共用同一条链），所以开启可视化意味着播放路径改走 WebAudio ——
 * 这和均衡器是同一个取舍，低频设备上第一次播放可能有一瞬间衔接。
 *
 * 三种样式循环切换：条形频谱 / 波形 / 环形。点一下切换，选择记在设置里。
 * 空闲（暂停）时降帧，不空转烧 CPU。
 */

import { h, on } from '../../core/dom.js'
import { icon } from '../../core/icons.js'

const STYLES = ['bars', 'wave', 'ring']
export const VISUALIZER_STYLES = STYLES

export function createVisualizer ({ engine, store, bus, getStyle = () => 'bars', onPickStyle = null }) {
  const canvas = h('canvas', { class: 'visualizer__canvas' })
  /*
   * 两条元素：
   *   · strip —— 铺在底部**只做装饰**，必须 pointer-events: none，
   *     否则它会盖住播放控件（用户反馈「示波器阻挡 UI 按键」）；
   *   · button —— 顶栏上的小按钮，切样式用它。
   */
  const strip = h('div', { class: 'visualizer', 'aria-hidden': 'true' }, canvas)
  const button = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '音频可视化样式',
    onClick: () => {
      const current = getStyle()
      const next = STYLES[(STYLES.indexOf(current) + 1) % STYLES.length]
      onPickStyle?.(next)
      bus.emit('visualizer:style', next)
    }
  }, icon('waveform', { className: 'icon icon--stroke' }))
  const context = canvas.getContext('2d')

  let analyser = null
  let freqData = null
  let timeData = null
  let frame = 0
  let running = false
  let lastStyle = getStyle()
  let idleFrames = 0

  function ensureAnalyser () {
    if (analyser) return true
    const tap = engine.getTap?.()
    if (!tap?.context) return false
    analyser = tap.context.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.78
    // 挂在 source 上（tap.connect 的语义就是 source → node → destination，别接到输出会重复发声）
    tap.source.connect(analyser)
    freqData = new Uint8Array(analyser.frequencyBinCount)
    timeData = new Uint8Array(analyser.fftSize)
    return true
  }

  function resize () {
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  /** 主色优先用专辑取色（--tint），没有就退回强调色 */
  function accent () {
    const root = getComputedStyle(document.documentElement)
    return root.getPropertyValue('--tint').trim() ||
      root.getPropertyValue('--accent').trim() || '#0a84ff'
  }

  /** 沉浸式：以中线为轴的镜像频谱 + 叠一层示波器波形 */
  function drawBars (width, height) {
    const mid = height / 2
    const bars = 96
    const gap = 1.2
    const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars)

    for (let i = 0; i < bars; i++) {
      const index = Math.floor(Math.pow(i / bars, 1.6) * (freqData.length * 0.62))
      const value = freqData[index] / 255
      const barHeight = Math.max(1, value * (height * 0.46))
      context.globalAlpha = 0.22 + value * 0.78
      // 上下镜像，像一条被声音推开的线
      context.fillRect(i * (barWidth + gap), mid - barHeight, barWidth, barHeight)
      context.fillRect(i * (barWidth + gap), mid, barWidth, barHeight * 0.72)
    }
    context.globalAlpha = 1

    // 示波器波形：压在中线上，带一点辉光
    context.save()
    context.shadowBlur = 12
    context.shadowColor = context.strokeStyle
    context.lineWidth = 1.6
    context.beginPath()
    const step = Math.max(1, Math.floor(timeData.length / width))
    for (let x = 0; x < width; x++) {
      const value = (timeData[x * step] - 128) / 128
      const y = mid + value * (height * 0.4)
      if (x === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.stroke()
    context.restore()
  }
  function drawWave (width, height) {
    context.lineWidth = 1.5
    context.beginPath()
    const step = Math.max(1, Math.floor(timeData.length / width))
    for (let x = 0; x < width; x++) {
      const value = (timeData[x * step] - 128) / 128
      const y = height / 2 + value * height * 0.45
      if (x === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.stroke()
  }

  function drawRing (width, height) {
    const cx = width / 2
    const cy = height / 2
    const radius = Math.min(cx, cy) * 0.55
    const bars = 72
    for (let i = 0; i < bars; i++) {
      const index = Math.floor(Math.pow(i / bars, 1.5) * (freqData.length * 0.6))
      const value = freqData[index] / 255
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2
      const inner = radius
      const outer = radius + value * radius * 0.7
      context.globalAlpha = 0.4 + value * 0.6
      context.beginPath()
      context.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner)
      context.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      context.stroke()
    }
    context.globalAlpha = 1
  }

  function tick () {
    if (!running) return
    frame = requestAnimationFrame(tick)
    if (!ensureAnalyser()) return

    const style = getStyle()
    if (style !== lastStyle) {
      lastStyle = style
      strip.dataset.style = style
    }

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const playing = store.get().playback.status === 'playing'

    analyser.getByteFrequencyData(freqData)
    analyser.getByteTimeDomainData(timeData)

    // 暂停时降到 6 帧左右，别空转
    idleFrames++
    if (!playing && idleFrames % 9 !== 0) return

    context.clearRect(0, 0, width, height)
    const color = accent()
    context.fillStyle = color
    context.strokeStyle = color

    if (style === 'wave') drawWave(width, height)
    else if (style === 'ring') drawRing(width, height)
    else drawBars(width, height)
  }

  function start () {
    if (running) return
    running = true
    resize()
    tick()
  }

  function stop () {
    running = false
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
  }

  on(window, 'resize', resize)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null
  observer?.observe(canvas)

  button.dataset.style = lastStyle

  return {
    element: strip,
    button,
    start,
    stop,
    resize,
    get running () { return running },
    destroy () {
      stop()
      observer?.disconnect()
      try { analyser?.disconnect() } catch { /* 忽略 */ }
      analyser = null
    }
  }
}
