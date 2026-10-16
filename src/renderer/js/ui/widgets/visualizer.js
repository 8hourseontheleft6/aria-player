/**
 * 音频可视化（从 wip/visualizer-immersive 分支重启的沉浸式示波器）。
 *
 * 数据来自 WebAudio 的 AnalyserNode：`engine.getTap()` 会建出音频图（与均衡器共用同一条链）。
 * 因此这里有一条**必须遵守**的规矩：只在真的要画的时候才去取接入点 ——
 * 一旦创建，音频输出就改走 WebAudio（原生路径没了）。样式选「关闭」时一个节点都不建。
 *
 * 三种画法 + 关闭，点顶栏那颗小按钮循环切换，选择记在设置里：
 *   bars —— 以中线为轴的镜像频谱，上面叠一条示波器波形（默认）
 *   wave —— 纯示波器波形（真的"示波器"）
 *   ring —— 环形频谱
 *
 * 两条踩过的坑写在代码里，别重犯：
 *   · 底部那层是**纯装饰**，必须 `pointer-events: none`：早先它铺满底部又接收鼠标，
 *     把播放控件、底部工具条那一排的点击全吃了（用户反馈「示波器阻挡 UI 按键」）。
 *   · 暂停时降帧：不降的话面板一开着就满帧空转，笔记本上风扇会说话。
 */

import { h, on } from '../../core/dom.js'
import { icon } from '../../core/icons.js'

/** 循环顺序：三种画法 + 关闭 */
export const VISUALIZER_STYLES = ['bars', 'wave', 'ring', 'off']

const STYLE_LABELS = {
  bars: '频谱 + 波形',
  wave: '示波器波形',
  ring: '环形频谱',
  off: '关闭'
}

export function visualizerStyleLabel (style) {
  return STYLE_LABELS[style] || STYLE_LABELS.bars
}

export function nextVisualizerStyle (current) {
  const index = VISUALIZER_STYLES.indexOf(current)
  return VISUALIZER_STYLES[(index + 1) % VISUALIZER_STYLES.length]
}

export function createVisualizer ({ engine, store, bus, getStyle = () => 'bars', onPickStyle = null }) {
  const canvas = h('canvas', { class: 'visualizer__canvas' })
  const strip = h('div', { class: 'visualizer', 'aria-hidden': 'true' }, canvas)

  const button = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: `音频可视化：${visualizerStyleLabel(getStyle())}（点击切换）`,
    onClick: () => {
      const next = nextVisualizerStyle(getStyle())
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
    const tap = typeof engine.getTap === 'function' ? engine.getTap() : null
    if (!tap || !tap.context) return false
    analyser = tap.context.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.78
    /*
     * 挂在 source 上，**不要**连到输出：tap.connect() 的语义是 source → node → destination，
     * 那样接会把声音播两遍。这里只要数据。
     */
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

  /** 主色优先用专辑取色（--tint，由 artwork 写进 :root），没有就退回强调色 */
  function accent () {
    const root = getComputedStyle(document.documentElement)
    return root.getPropertyValue('--tint').trim() ||
      root.getPropertyValue('--accent').trim() || '#0a84ff'
  }

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

    // 示波器波形压在中线上，带一点辉光
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

  function clear () {
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
  }

  function tick () {
    if (!running) return
    frame = requestAnimationFrame(tick)

    const style = getStyle()
    if (style !== lastStyle) {
      lastStyle = style
      strip.dataset.style = style
      button.title = `音频可视化：${visualizerStyleLabel(style)}（点击切换）`
      clear()
    }
    // 关闭：不建接入点、不画
    if (style === 'off') return

    if (!ensureAnalyser()) return

    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return

    const playing = store.get().playback.status === 'playing'

    analyser.getByteFrequencyData(freqData)
    analyser.getByteTimeDomainData(timeData)

    // 暂停时降到 ~6 帧，别空转
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
    lastStyle = getStyle()
    strip.dataset.style = lastStyle
    button.title = `音频可视化：${visualizerStyleLabel(lastStyle)}（点击切换）`
    resize()
    // 面板刚打开时布局可能还没定下来，下一帧再量一次
    requestAnimationFrame(resize)
    tick()
  }

  function stop () {
    running = false
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    clear()
  }

  on(window, 'resize', resize)
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null
  observer?.observe(canvas)

  strip.dataset.style = lastStyle

  return {
    element: strip,
    button,
    start,
    stop,
    resize,
    get running () { return running },
    get hasAnalyser () { return Boolean(analyser) },
    /** 测试用：读画布上有没有真的画东西（透明像素占比） */
    paintedRatio () {
      const width = canvas.width
      const height = canvas.height
      if (!width || !height) return 0
      const data = context.getImageData(0, 0, width, height).data
      let painted = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted++
      return painted / (width * height)
    },
    destroy () {
      stop()
      observer?.disconnect()
      try { analyser?.disconnect() } catch { /* 忽略 */ }
      analyser = null
    }
  }
}
