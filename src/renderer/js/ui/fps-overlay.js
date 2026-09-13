/**
 * 实时帧率浮层（设置 → 外观 → 显示帧率，默认关闭）。
 *
 * 为什么要有这个：卡与不卡最终取决于用户那台机器的 GPU、驱动和刷新率，
 * 开发机上量出来的数字不能替用户下结论。打开这个开关之后，
 * 右下角会实时显示「当前帧率 · 平均帧耗时 · 最近两秒最差的一帧」，
 * 拖动、开合视图、播放时的表现都能直接看到数字，而不是靠感觉。
 *
 * 代价控制：
 *  · 只在开关打开时跑 rAF 循环，关掉后立刻停掉（不留一个常驻的每帧回调）；
 *  · 采样窗口 2s、DOM 最多每 250ms 更新一次，本身不会成为卡顿源；
 *  · 指针事件穿透，不会挡住下面的界面。
 */

import { h } from '../core/dom.js'

const SAMPLE_WINDOW_MS = 2000
const PAINT_INTERVAL_MS = 250

export function createFpsOverlay ({ store }) {
  const valueNode = h('span', { class: 'fps-overlay__value', text: '— fps' })
  const detailNode = h('span', { class: 'fps-overlay__detail', text: '' })
  const element = h('div', { class: 'fps-overlay', hidden: true, 'aria-hidden': 'true' }, valueNode, detailNode)

  /** @type {{ time: number, gap: number }[]} */
  let samples = []
  let frame = null
  let lastTime = 0
  let lastPaint = 0

  function tick (now) {
    frame = requestAnimationFrame(tick)
    if (lastTime) samples.push({ time: now, gap: now - lastTime })
    lastTime = now
    // 只保留最近两秒的样本
    while (samples.length > 2 && now - samples[0].time > SAMPLE_WINDOW_MS) samples.shift()
    if (now - lastPaint < PAINT_INTERVAL_MS || !samples.length) return
    lastPaint = now

    let total = 0
    let worst = 0
    for (const sample of samples) {
      total += sample.gap
      if (sample.gap > worst) worst = sample.gap
    }
    const average = total / samples.length
    valueNode.textContent = `${Math.round(1000 / average)} fps`
    // 最差一帧单独标出来：平均值好看、偶尔掉一帧，主观上依然是「卡」
    detailNode.textContent = `${average.toFixed(1)}ms · 最差 ${worst.toFixed(0)}ms`
  }

  function start () {
    if (frame) return
    samples = []
    lastTime = 0
    lastPaint = 0
    frame = requestAnimationFrame(tick)
  }

  function stop () {
    if (!frame) return
    cancelAnimationFrame(frame)
    frame = null
  }

  function sync () {
    const enabled = store.get().settings.showFps === true
    element.hidden = !enabled
    if (enabled) start()
    else stop()
  }

  sync()
  store.subscribe(sync)

  return {
    element,
    destroy () {
      stop()
      element.remove()
    }
  }
}
