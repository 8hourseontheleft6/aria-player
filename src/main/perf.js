'use strict'

/**
 * 帧率诊断（npm run perf）：
 *
 * 在不同视图下测量 requestAnimationFrame 的实际间隔，用来区分
 * 「环境本身就在节流」和「某个视图真的拖慢了帧率」。
 *
 * 之所以要单独做这件事：自检里的空载基准如果是在媒体墙显示时测的，
 * 那它测的其实是「媒体墙的空载」，得不出任何结论。
 *
 * 输出每一档的：平均帧间隔、p95、最差、每秒帧数、以及该视图的 DOM 节点数。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function evaluate (win, expression) {
  return win.webContents.executeJavaScript(`(async () => { ${expression} })()`, true)
}

async function waitFor (win, condition, { timeout = 120000, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await evaluate(win, `return Boolean(${condition})`)) return true
    } catch {
      // 继续轮询
    }
    await sleep(300)
  }
  throw new Error(`等待超时：${label}`)
}

/** 在渲染层里跑若干帧，返回帧间隔统计 */
const MEASURE = (frames) => `
  const gaps = []
  let last = performance.now()
  for (let i = 0; i < ${frames}; i++) {
    await new Promise((r) => requestAnimationFrame(r))
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }
  const warm = gaps.slice(4)
  const sorted = [...warm].sort((a, b) => a - b)
  const sum = warm.reduce((acc, value) => acc + value, 0)
  return {
    average: Math.round((sum / warm.length) * 100) / 100,
    median: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
    worst: Math.round(sorted[sorted.length - 1] * 100) / 100,
    nodes: document.querySelectorAll('*').length
  }
`

/**
 * 等渲染层真正安静下来再开始测量。
 *
 * 踩过的坑：封面预热每 220ms 走一次 IPC，刚打开媒体墙时懒加载也在排队，
 * 这段时间测出来的「设置页 23ms/帧」其实是别人的活儿，和被测的那一档无关。
 * 所以每个测量点之前都先等到连续若干帧的中位间隔回到预算之内。
 */
async function waitQuiet (win, { frames = 16, budget = 12, timeout = 60000, label = '安静' } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(win, `
      const gaps = []
      let last = performance.now()
      for (let i = 0; i < ${frames}; i++) {
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        gaps.push(now - last)
        last = now
      }
      const warm = gaps.slice(4).sort((a, b) => a - b)
      return {
        median: Math.round(warm[Math.floor(warm.length / 2)] * 100) / 100,
        pending: window.__aria?.lazy?.state?.pending ?? -1,
        active: window.__aria?.lazy?.state?.active ?? -1,
        queued: window.__aria?.lazy?.state?.queued ?? -1
      }`)
    if (last.median <= budget) return last
    await sleep(700)
  }
  console.log(`  （等待${label}超时：中位 ${last?.median}ms，封面在途 ${last?.active}、排队 ${last?.queued}）`)
  return last
}

async function measure (win, label, expression, frames = 50) {
  const result = await evaluate(win, `${expression}
    ${MEASURE(frames)}`)
  console.log(
    `  ${label.padEnd(26)} 平均 ${String(result.average).padStart(7)}ms  ` +
    `中位 ${String(result.median).padStart(7)}ms  p95 ${String(result.p95).padStart(7)}ms  ` +
    `最差 ${String(result.worst).padStart(7)}ms  ≈${String(Math.round(1000 / result.average)).padStart(3)}fps  ` +
    `DOM ${result.nodes}`
  )
  return result
}

async function runPerf ({ win, ctx }) {
  console.log('\n=== 帧率诊断 ===\n')
  await waitFor(win, 'window.__aria && window.__aria.store.get().library.loaded === true', { label: '资料库' })

  // 合成方式很关键：软件合成下「移动一个大层」会变成 CPU 级别的整屏重绘
  try {
    const { app } = require('electron')
    const status = app.getGPUFeatureStatus()
    console.log(`合成方式：gpu_compositing=${status.gpu_compositing}  webgl=${status.webgl}  ` +
      `rasterization=${status.rasterization}  video_decode=${status.video_decode}`)
  } catch (err) {
    console.log(`合成方式：读取失败（${err.message}）`)
  }

  // 后台预热会以 220ms 的节奏持续打扰测量，先在诊断期间停掉（只影响本次进程）
  await evaluate(win, `
    try { window.__aria.prewarmer?.stop() } catch (err) {}
    // 页内「等到安静」：每个测量点先让它把余下的活儿干完
    window.__perfQuiet = async (frames = 12) => {
      const gaps = []
      let last = performance.now()
      for (let i = 0; i < frames; i++) {
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        gaps.push(now - last)
        last = now
      }
      const warm = gaps.slice(4).sort((a, b) => a - b)
      return Math.round(warm[Math.floor(warm.length / 2)] * 100) / 100
    }
    return true`)

  await sleep(1500)
  console.log(`视口 ${await evaluate(win, 'return window.innerWidth + "×" + window.innerHeight + " @" + window.devicePixelRatio + "x"')}\n`)

  await evaluate(win, `
    const { store, actions } = window.__aria
    const tracks = store.get().library.tracks
    const track = tracks.find((t) => t.lyricsPath) || tracks[0]
    actions.playTrack(track)
    await new Promise((r) => setTimeout(r, 1500))
    window.__aria.player.pause()
    return true`)

  const idle = await waitQuiet(win, { label: '空载安静', timeout: 45000 })
  console.log(`空载基准：中位 ${idle.median}ms/帧；封面 在途 ${idle.active} / 排队 ${idle.queued} / 观察 ${idle.pending}\n`)

  const results = {}
  results.settings = await measure(win, '设置页（DOM 最少）', `
    window.__aria.actions.setView('settings')
    await new Promise((r) => setTimeout(r, 700))
    await window.__perfQuiet()`)
  results.songs = await measure(win, '歌曲列表', `
    window.__aria.actions.setView('songs')
    await new Promise((r) => setTimeout(r, 700))
    await window.__perfQuiet()`)
  results.nowPlaying = await measure(win, '正在播放（歌词）', `
    window.__aria.actions.openNowPlaying({ lyrics: true })
    await new Promise((r) => setTimeout(r, 1000))
    await window.__perfQuiet()`)
  results.wallIdle = await measure(win, '媒体墙（静止）', `
    window.__aria.actions.closeNowPlaying()
    window.__aria.actions.setView('wall')
    await new Promise((r) => setTimeout(r, 2000))
    await window.__perfQuiet()`, 60)

  // 拖动中的帧率，以及若干 A/B 对照（同一轮里改 CSS 再量，排除环境波动）
  const override = (css) => `
    document.getElementById('perf-override')?.remove()
    ${css
      ? `{
        const style = document.createElement('style')
        style.id = 'perf-override'
        style.textContent = ${JSON.stringify(css)}
        document.head.appendChild(style)
      }`
      : ''}`

  const panProbe = async (label, prepare = '', frames = 45) => {
    const result = await evaluate(win, `
      ${prepare}
      await new Promise((r) => setTimeout(r, 300))
      await window.__perfQuiet()
      const viewport = document.querySelector('.wall-viewport')
      const stage = document.querySelector('.wall-window')
      const grid = document.querySelector('.media-wall')
      // 把平面拉回中间，保证每次测量的起点一致
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: -2000, deltaY: -2000 }))
      await new Promise((r) => setTimeout(r, 500))
      const rect = viewport.getBoundingClientRect()
      const cx = Math.round(rect.left + rect.width / 2)
      const cy = Math.round(rect.top + rect.height / 2)
      const pointer = (type, x, y, init = {}) => viewport.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, isPrimary: true, pointerId: 3, pointerType: 'mouse',
        clientX: x, clientY: y, ...init
      }))
      // 先单独量「事件处理本身」的开销：同步派发一批 pointermove，中间不落帧。
      // 这一项很小而帧间隔很大 → 瓶颈在绘制/合成，而不是 JS。
      pointer('pointerdown', cx, cy, { button: 1, buttons: 4 })
      const dispatchStart = performance.now()
      for (let i = 0; i < 20; i++) pointer('pointermove', cx - i * 6, cy - i * 3, { button: 1, buttons: 4 })
      const handlerMs = Math.round(((performance.now() - dispatchStart) / 20) * 1000) / 1000
      const gaps = []
      let last = performance.now()
      for (let i = 0; i < ${frames}; i++) {
        pointer('pointermove', cx - i * 6, cy - i * 3, { button: 1, buttons: 4 })
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        gaps.push(now - last)
        last = now
      }
      pointer('pointerup', cx - 300, cy - 150, { button: 1, buttons: 0 })
      await new Promise((r) => setTimeout(r, 1200))
      const warm = gaps.slice(4)
      const sorted = [...warm].sort((a, b) => a - b)
      const layer = stage.getBoundingClientRect()
      const plane = grid.getBoundingClientRect()
      return {
        average: Math.round((warm.reduce((acc, v) => acc + v, 0) / warm.length) * 100) / 100,
        median: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
        worst: Math.round(sorted[sorted.length - 1] * 100) / 100,
        handlerMs,
        nodes: document.querySelectorAll('*').length,
        layerCss: [Math.round(layer.width), Math.round(layer.height)],
        layerDevice: [Math.round(layer.width * devicePixelRatio), Math.round(layer.height * devicePixelRatio)],
        planeCss: [Math.round(plane.width), Math.round(plane.height)]
      }
    `)
    console.log(
      `  ${label.padEnd(24)} 平均 ${String(result.average).padStart(7)}ms  ` +
      `中位 ${String(result.median).padStart(7)}ms  最差 ${String(result.worst).padStart(7)}ms  ` +
      `≈${String(Math.round(1000 / result.average)).padStart(3)}fps  ` +
      `JS ${String(result.handlerMs).padStart(6)}ms  ` +
      `被平移层 ${result.layerCss.join('×')}（设备 ${result.layerDevice.join('×')}，平面 ${result.planeCss.join('×')}）`
    )
    return result
  }

  /*
   * 对照实验说明：
   * 被平移的是「视口 + 一个步长」大小的 .wall-window，网格的盒子也收成同样大小
   * 并 overflow:hidden，所以每帧要栅格化的范围只有窗口那么大。
   * 步长越小窗口越小（代价 ∝ 层面积），但网格 transform 的改写越频繁。
   */
  const setStep = (value) => `
    document.getElementById('perf-override')?.remove()
    window.__aria.views.mediaWall.debugSetWindowStep(${value})`

  console.log('\n  ── 拖动路径对照 ──')
  results.wallPan = await panProbe('拖动（当前实现）', override(''))
  results.wallPanStep151 = await panProbe('拖动（步长 151 = 一格）', setStep(151))
  results.wallPanStep64 = await panProbe('拖动（步长 64）', setStep(64))
  results.wallPanStep16 = await panProbe('拖动（步长 16）', setStep(16))
  results.wallPanNoContainPaint = await panProbe('拖动（格子只留 contain:layout）', `${setStep(0)}
    document.getElementById('perf-override')?.remove()
    {
      const style = document.createElement('style')
      style.id = 'perf-override'
      style.textContent = '.wall-tile { contain: layout !important; }'
      document.head.appendChild(style)
    }`)
  results.wallPanRestored = await panProbe('拖动（复位后复测）', setStep(0))

  /*
   * 首次打开媒体墙：清掉封面缓存（含磁盘），切走再切回来，量封面涌入那几秒的帧间隔。
   * 用户反馈的「刚打开媒体墙比较卡」就发生在这一段。
   */
  console.log('\n  ── 首次打开（清空封面缓存后重新进入） ──')
  try {
    const library = ctx.get('library')
    await library.clearArtworkCache({ memory: true, disk: true })
    await evaluate(win, `window.__aria.actions.setView('songs'); await new Promise((r) => setTimeout(r, 500)); return true`)
    const open = await evaluate(win, `
      const gaps = []
      const samples = { active: 0, queued: 0, pending: 0 }
      window.__aria.actions.setView('wall')
      const started = performance.now()
      let last = performance.now()
      while (performance.now() - started < 5000) {
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        gaps.push({ t: Math.round(now - started), gap: now - last })
        last = now
        const state = window.__aria.views.mediaWall.debugState().lazy
        samples.active = Math.max(samples.active, state.active)
        samples.queued = Math.max(samples.queued, state.queued)
        samples.pending = Math.max(samples.pending, state.pending)
      }
      const images = document.querySelectorAll('.wall-tile img').length
      const all = gaps.map((item) => item.gap)
      const sorted = [...all].sort((a, b) => a - b)
      const firstSecond = gaps.filter((item) => item.t <= 1000).map((item) => item.gap)
      const firstSecondAvg = firstSecond.reduce((acc, v) => acc + v, 0) / Math.max(1, firstSecond.length)
      const buckets = [0, 1, 2, 3, 4].map((second) => {
        const slice = gaps.filter((item) => item.t > second * 1000 && item.t <= (second + 1) * 1000).map((item) => item.gap)
        return slice.length ? Math.round((slice.reduce((acc, v) => acc + v, 0) / slice.length) * 10) / 10 : 0
      })
      return {
        average: Math.round((all.reduce((acc, v) => acc + v, 0) / all.length) * 100) / 100,
        median: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
        p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
        worst: Math.round(sorted[sorted.length - 1] * 100) / 100,
        firstSecond: Math.round(firstSecondAvg * 100) / 100,
        buckets,
        samples,
        images
      }`)
    console.log(
      `  清缓存后进入媒体墙：整体 ${open.average}ms/帧（中位 ${open.median}，p95 ${open.p95}，最差 ${open.worst}）`
    )
    console.log(
      `  逐秒：${open.buckets.map((value, index) => `${index + 1}s ${value}ms`).join('  ')}` +
      `　（首秒 ${open.firstSecond}ms）`
    )
    console.log(
      `  封面：峰值在途 ${open.samples.active} / 排队 ${open.samples.queued} / 观察 ${open.samples.pending}，` +
      `5s 内出图 ${open.images} 张`
    )
    results.wallOpenCold = open
    results.wallOpenFirstSecond = { average: open.firstSecond }
  } catch (err) {
    console.log(`  （首次打开测量失败：${err.message}）`)
  }

  // 结论：和设置页（DOM 最少）对比
  const baseline = results.settings.average
  console.log('')
  console.log(`  基准（设置页）${baseline}ms/帧 ≈ ${Math.round(1000 / baseline)}fps`)
  for (const [key, value] of Object.entries(results)) {
    if (key === 'settings') continue
    const ratio = (value.average / baseline).toFixed(2)
    const verdict = value.average / baseline < 1.25
      ? '与基准相当（说明这一档没有额外开销）'
      : '明显慢于基准（这一档有开销）'
    console.log(`  ${key.padEnd(12)} ${String(value.average).padStart(7)}ms  比值 ${ratio}×  ${verdict}`)
  }
  console.log('')
  return results
}

module.exports = { runPerf }
