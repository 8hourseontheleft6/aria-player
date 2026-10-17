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

/** 设置页的分段控件用短标签，太长会挤 */
const STYLE_SHORT_LABELS = {
  bars: '频谱',
  wave: '波形',
  ring: '环形',
  off: '关闭'
}

export function visualizerStyleLabel (style, short = false) {
  const table = short ? STYLE_SHORT_LABELS : STYLE_LABELS
  return table[style] || table.bars
}

/** 设置页的选项（顺序与循环顺序一致，标签只有这一处真相） */
export function visualizerChoices () {
  return VISUALIZER_STYLES.map((id) => ({ id, label: visualizerStyleLabel(id, true) }))
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

  /*
   * aria-label 跟着当前样式走：读屏软件念的是"音频可视化：bars（点击切换）"，
   * 而不是一个没有名字的图标按钮（title 只是悬停提示，不能替代可访问名）。
   */
  const syncButtonLabel = () => {
    button.setAttribute('aria-label', `音频可视化：${visualizerStyleLabel(getStyle())}（点击切换）`)
  }
  syncButtonLabel()
  bus.on('visualizer:style', syncButtonLabel)

  const context = canvas.getContext('2d')

  let analyser = null
  let freqData = null
  let timeData = null
  let frame = 0
  let running = false
  let lastStyle = getStyle()
  let idleFrames = 0
  let suppressed = false

  /**
   * 「减少动画」的判断与应用其它地方保持同一套（见 ui/views/media-wall.js）：
   * 先问设置，再看 html 上的 data-reduce-motion。
   *
   * 为什么示波器也要听它的：那个开关的承诺是「关闭所有过渡与弹簧动画」，
   * 而示波器是**持续**动画 —— 开着它却让底部一直动，等于当面食言。
   */
  function reduceMotion () {
    return store.get().settings.reduceMotion === true ||
      document.documentElement.dataset.reduceMotion === 'true'
  }

  function paintButton () {
    if (suppressed) {
      button.disabled = true
      button.title = '音频可视化已暂停：设置 → 外观 里的「减少动画」开着'
      return
    }
    button.disabled = false
    button.title = `音频可视化：${visualizerStyleLabel(getStyle())}（点击切换）`
  }

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
    /*
     * 这条只有 72px 高，画正圆会小得像颗痣（截图里能直接看出来）。
     * 改成**椭圆**：横向按宽度拉开，纵向贴合条高 —— 一样是环形频谱，但铺满整条。
     */
    const rx = Math.min(width * 0.3, height * 2.4)
    const ry = height * 0.42
    const bars = 96
    for (let i = 0; i < bars; i++) {
      const index = Math.floor(Math.pow(i / bars, 1.5) * (freqData.length * 0.6))
      const value = freqData[index] / 255
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      const outer = 1 + value * 0.75
      context.globalAlpha = 0.35 + value * 0.65
      context.beginPath()
      context.moveTo(cx + cos * rx, cy + sin * ry)
      context.lineTo(cx + cos * rx * outer, cy + sin * ry * outer)
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

    // 「减少动画」开着：整条不画（只在状态切换的那一帧清一次，不是每帧都清）
    const nowSuppressed = reduceMotion()
    if (nowSuppressed !== suppressed) {
      suppressed = nowSuppressed
      strip.dataset.suppressed = suppressed ? 'true' : 'false'
      clear()
      paintButton()
    }
    if (suppressed) return

    const style = getStyle()
    if (style !== lastStyle) {
      lastStyle = style
      strip.dataset.style = style
      paintButton()
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
    suppressed = reduceMotion()
    strip.dataset.style = lastStyle
    strip.dataset.suppressed = suppressed ? 'true' : 'false'
    paintButton()
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
  strip.dataset.suppressed = 'false'
  paintButton()

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
