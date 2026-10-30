'use strict'

/**
 * P0 基线测量（`npm run perf:baseline`）。
 *
 * 只测量、不改产品行为：
 *  1. 冷启动：app ready → ready-to-show → 五段打点（shellBuilt / settingsReady / libraryReady /
 *     firstUsableViewport / sourcesReady）
 *  2. 空闲 RSS：静置 60 秒后按进程分列
 *  3. 播放中：播 30 秒后的 RSS/CPU（示波器开、关各一次）
 *  4. 媒体墙：打开 10 秒后的 RSS、节点数、帧率
 *  5. 扫描：冷扫描（先删缓存）与热扫描的耗时、文件数
 *
 * 打点约定：
 *  · main 在 whenReady / ready-to-show 时各记一个 Date.now()（见 main.js 的 BOOT）
 *  · 渲染层在 main() 末尾记 performance.now()（见 app.js 的 __ariaBootMarks）
 *  · 渲染层的 performance.now() 是相对 timeOrigin 的，所以换算成 epoch 再相减
 */

const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function evaluate (win, expression) {
  return win.webContents.executeJavaScript(`(async () => { ${expression} })()`)
}

/** 按进程类型汇总 RSS（KB → MB） */
function memoryByType () {
  const { app } = require('electron')
  const byType = {}
  for (const metric of app.getAppMetrics()) {
    const type = metric.type === 'Tab' ? 'renderer' : metric.type === 'GPU' ? 'GPU'
      : metric.type === 'Utility' ? 'utility' : metric.type === 'Browser' ? 'main' : metric.type
    const rss = (metric.memory && metric.memory.workingSetSize) || 0
    if (!byType[type]) byType[type] = { rss: 0, cpu: 0, count: 0 }
    byType[type].rss += rss
    byType[type].cpu += metric.cpu.percentCPUUsage || 0
    byType[type].count += 1
  }
  for (const value of Object.values(byType)) {
    value.rssMB = Math.round(value.rss / 1024 * 10) / 10
    value.cpu = Math.round(value.cpu * 10) / 10
  }
  return byType
}

function mainMemory () {
  const usage = process.memoryUsage()
  return {
    rssMB: Math.round(usage.rss / 1024 / 1024 * 10) / 10,
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024 * 10) / 10
  }
}

/** 页内 rAF 采样：返回 { median, p95, worst } */
const FPS_PROBE = `
  const gaps = []
  let last = performance.now()
  const started = performance.now()
  while (performance.now() - started < 3000) {
    await new Promise((r) => requestAnimationFrame(r))
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  return {
    frames: gaps.length,
    median: Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100,
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 100) / 100,
    worst: Math.round(sorted[sorted.length - 1] * 100) / 100
  }`

/** 统一的"清一次 GC"：渲染层与主进程都清，然后再采样 */
async function collectGarbage (win) {
  try {
    await evaluate(win, 'window.gc && window.gc(); return true')
  } catch {}
  try {
    if (typeof global.gc === 'function') global.gc()
  } catch {}
  await sleep(400)
}

async function runPerfBaseline ({ win, ctx }) {
  const { app } = require('electron')
  const out = { at: new Date().toISOString(), version: app.getVersion() }

  console.log('\n=== P0 基线 ===\n')
  console.log(`版本 ${out.version}  平台 ${process.platform}/${process.arch}  Electron ${process.versions.electron}`)

  /* ---------- 1. 冷启动（五段）---------- */
  await new Promise((resolve) => {
    if (win.webContents.isLoading() === false) return resolve()
    win.webContents.once('did-finish-load', resolve)
  })
  const boot = globalThis.__ariaBoot || {}
  const STAGES = ['shellBuilt', 'settingsReady', 'libraryReady', 'firstUsableViewport', 'sourcesReady']

  /* 音源可能很慢（用户装了慢脚本时以 10 秒计），所以最多等 15 秒再读数 */
  const readMarks = () => evaluate(win, `
    const marks = window.__ariaBootMarks
    if (!marks) return null
    const copy = {}
    for (const key of ${JSON.stringify(STAGES)}) if (marks[key] !== undefined) copy[key] = marks[key]
    copy.interactive = marks.interactive
    copy.timeOrigin = marks.timeOrigin
    copy.sourcesReadyCount = marks.sourcesReadyCount
    copy.firstUsableViewportView = marks.firstUsableViewportView
    return copy`)
  let pageBoot = await readMarks()
  const deadline = Date.now() + 15000
  /*
   * 等最后一段出现再读数：firstUsableViewport 才是真正的「首屏可用」。
   * sourcesReady 可能比它更早（本地没装慢音源时），不能拿它当收尾条件。
   */
  /* 等到 sourcesReady 也出现（它可能明显晚于首屏：慢音源场景要 5–6 秒） */
  /* 两种收尾条件都要满足：首屏已可用，且音源已有结论（跳过/完成/失败） */
  while (Date.now() < deadline && pageBoot && (pageBoot.firstUsableViewport === undefined || pageBoot.sourcesReady === undefined)) {
    await sleep(300)
    pageBoot = await readMarks()
  }
  if (!pageBoot) pageBoot = { timeOrigin: 0 }

  const toMs = (mark) => (mark != null && pageBoot.timeOrigin && boot.readyAt
    ? Math.round(pageBoot.timeOrigin + mark - boot.readyAt)
    : null)
  const stages = {}
  for (const name of STAGES) stages[name] = toMs(pageBoot[name])

  out.coldStart = {
    readyAt: boot.readyAt || 0,
    readyToShowAt: boot.readyToShowAt || 0,
    readyToShowMs: boot.readyAt && boot.readyToShowAt ? boot.readyToShowAt - boot.readyAt : 0,
    stages,
    legacyInteractiveMs: toMs(pageBoot.interactive),
    sourcesReadyCount: pageBoot.sourcesReadyCount || 0,
    firstUsableViewportView: pageBoot.firstUsableViewportView || null
  }
  const st = out.coldStart.stages
  const fmt = (value) => (value == null ? '—' : `${value}ms`)
  console.log(`1) 冷启动：ready→ready-to-show ${out.coldStart.readyToShowMs}ms`)
  console.log(`   shellBuilt          ${fmt(st.shellBuilt)}`)
  console.log(`   settingsReady       ${fmt(st.settingsReady)}`)
  console.log(`   libraryReady        ${fmt(st.libraryReady)}`)
  console.log(`   firstUsableViewport ${fmt(st.firstUsableViewport)}${out.coldStart.firstUsableViewportView ? `（视图 ${out.coldStart.firstUsableViewportView}）` : ''}`)
  console.log(`   sourcesReady        ${fmt(st.sourcesReady)}（${out.coldStart.sourcesReadyCount} 个音源）`)
  console.log(`   [旧] interactive     ${fmt(out.coldStart.legacyInteractiveMs)} —— 语义是 shellBuilt，别再当"可交互"`)

  /* 等资料库就绪再往下测 */
  for (let i = 0; i < 120; i++) {
    const ready = await evaluate(win, 'return Boolean(window.__aria && window.__aria.store.get().library.loaded)')
    if (ready) break
    await sleep(500)
  }
  /* 资料库就绪耗时：冷缓存时这一项才是"全量扫描"的真实代价 */
  out.libraryReadyMs = boot.readyAt ? Math.round(Date.now() - boot.readyAt) : 0
  const trackCount = await evaluate(win, 'return window.__aria.store.get().library.tracks.length')
  out.libraryTracks = trackCount
  console.log(`   资料库 ${trackCount} 首（ready→就绪 ${out.libraryReadyMs}ms）`)

  /* ---------- 2. 空闲 RSS（静置 60 秒）---------- */
  await evaluate(win, `window.__aria.actions.setView('songs'); return true`)
  console.log('2) 空闲：静置 60 秒…')
  await sleep(60000)
  out.idle = { byType: memoryByType(), main: mainMemory() }
  console.log(`   ${Object.entries(out.idle.byType).map(([type, value]) => `${type} ${value.rssMB}MB×${value.count}`).join('  ')}`)

  /* ---------- 3. 播放中（示波器关 / 开各一次）---------- */
  const playingOnce = async (label, visualizer) => {
    await evaluate(win, `
      window.__timeEvents = 0
      window.__vizDraws = 0
      if (!window.__clearRectWrapped) {
        window.__clearRectWrapped = true
        const proto = CanvasRenderingContext2D.prototype
        const original = proto.clearRect
        proto.clearRect = function (...args) {
          if (window.__countViz) window.__vizDraws++
          return original.apply(this, args)
        }
      }
      window.__countViz = true
      window.__longTasks = 0
      if (window.__timeOff) window.__timeOff()
      window.__timeOff = window.__aria.bus.on(window.__aria.EVENTS.TIME, () => { window.__timeEvents++ })
      if (!window.__longObserver && 'PerformanceObserver' in window) {
        try {
          window.__longObserver = new PerformanceObserver((list) => { window.__longTasks += list.getEntries().length })
          window.__longObserver.observe({ entryTypes: ['longtask'] })
        } catch (err) { window.__longObserver = null }
      }
      return true`)
    await evaluate(win, `
      const { store, actions } = window.__aria
      actions.setSetting({ visualizer: ${JSON.stringify(visualizer)} })
      /* 示波器在"正在播放"面板里，不打开面板就等于没测 */
      if (${JSON.stringify(visualizer)}) actions.openNowPlaying({ lyrics: false })
      const tracks = store.get().library.tracks
      const track = tracks.find((t) => Number(t.duration) > 120) || tracks[0]
      actions.playTrack(track)
      return true`)
    await sleep(30000)
    const probe = await evaluate(win, 'window.__countViz = false; return { timeEvents: window.__timeEvents || 0, longTasks: window.__longTasks || 0, vizDraws: window.__vizDraws || 0 }')
    const sample = { byType: memoryByType(), main: mainMemory(), timeEvents: probe.timeEvents, timeHz: Math.round(probe.timeEvents / 30 * 10) / 10, longTasks: probe.longTasks, vizDraws: probe.vizDraws, vizFps: Math.round(probe.vizDraws / 30 * 10) / 10 }
    console.log(`3) 播放 30 秒（示波器 ${visualizer ? '开' : '关'}）：TIME ${sample.timeHz}/秒，示波器 ${sample.vizFps} 帧/秒，长任务 ${sample.longTasks} 个；` +
      Object.entries(sample.byType).map(([type, value]) => `${type} ${value.rssMB}MB/${value.cpu}%`).join('  '))
    await evaluate(win, 'window.__aria.player.pause(); return true')
    return { visualizer, ...sample }
  }
  out.playingVisualizerOff = await playingOnce('off', false)
  out.playingVisualizerOn = await playingOnce('on', true)

  /* ---------- 4. 媒体墙（打开 10 秒）---------- */
  await evaluate(win, `window.__aria.actions.setView('wall'); return true`)
  await sleep(10000)
  const wall = await evaluate(win, `
    const nodes = document.querySelectorAll('.wall-viewport *').length
    const tiles = document.querySelectorAll('.wall-tile').length
    const debug = window.__aria.views.mediaWall.debugState()
    const fps = await (async () => {
      ${FPS_PROBE}
    })()
    return { nodes, tiles, median: fps.median, p95: fps.p95, worst: fps.worst, culled: debug.culled }`)
  out.wall = { nodes: wall.nodes, tiles: wall.tiles, fps: { median: wall.median, p95: wall.p95 }, byType: memoryByType() }
  console.log(`4) 媒体墙 10 秒：${out.wall.tiles} 格 / ${out.wall.nodes} 节点；` +
    `帧间隔中位 ${wall.median}ms（≈${Math.round(1000 / wall.median)}fps，p95 ${wall.p95}ms）；` +
    `renderer ${out.wall.byType.renderer ? out.wall.byType.renderer.rssMB : '?'}MB`)

  /* ---------- 5. 扫描（强制全量 / 复用缓存）---------- */
  const library = ctx.get('library')
  let poolStats = null
  let coldMs = 0
  let warmMs = 0
  let files = 0
  let uiLatencyMs = 0
  let mainCpu = 0
  const cpuSamples = []

  const sampleWhile = async (promise) => {
    let done = false
    const started = Date.now()
    promise.then(() => { done = true }, () => { done = true })
    while (!done && Date.now() - started < 120000) {
      const metrics = app.getAppMetrics().find((metric) => metric.type === 'Browser')
      if (metrics) cpuSamples.push(metrics.cpu.percentCPUUsage || 0)
      /* 扫描期间 UI 还活着吗：切视图 + 读下一帧的间隔 */
      const latency = await evaluate(win, `
        const t0 = performance.now()
        window.__aria.actions.setView('albums')
        window.__aria.actions.setQuery('blues')
        await new Promise((r) => requestAnimationFrame(r))
        window.__aria.actions.setView('songs')
        window.__aria.actions.setQuery('')
        await new Promise((r) => requestAnimationFrame(r))
        return Math.round(performance.now() - t0)`)
      if (Number.isFinite(latency)) uiLatencyMs = Math.max(uiLatencyMs, latency)
      await sleep(120)
    }
    mainCpu = cpuSamples.length ? Math.round((cpuSamples.reduce((a, v) => a + v, 0) / cpuSamples.length) * 10) / 10 : 0
  }

  try {
    const started = Date.now()
    await sampleWhile(library.scan({ reason: 'perf-force', force: true }))
    coldMs = Date.now() - started
    const warmStart = Date.now()
    await library.scan({ reason: 'perf-warm' })
    warmMs = Date.now() - warmStart
    files = library.getStats().count
    poolStats = library.metadataPoolStats ? library.metadataPoolStats() : null
  } catch (error) {
    console.log(`   扫描测量失败：${error.message}`)
  }
  out.scan = { coldMs, warmMs, files, uiLatencyMs, mainCpu, cpuSamples: cpuSamples.length, pool: poolStats }
  console.log(`5) 扫描：强制全量 ${coldMs}ms ／ 复用缓存 ${warmMs}ms，${files} 个文件；` +
    `扫描期间主进程 CPU 均值 ${mainCpu}%（${cpuSamples.length} 次采样）、UI 响应上限 ${uiLatencyMs}ms` + (poolStats ? `；worker 池 ${poolStats.size} 个` : ''))

  /* ---------- 6. 离开媒体墙（P1-3）---------- */
  await evaluate(win, `window.__aria.actions.setView('wall'); return true`)
  await sleep(3000)
  const wallProbe = `
    const nodes = document.querySelectorAll('.wall-viewport *').length
    const tiles = document.querySelectorAll('.wall-tile').length
    const pan = window.__aria.views.mediaWall.getPan ? window.__aria.views.mediaWall.getPan() : null
    return { nodes, tiles, pan }`
  await collectGarbage(win)
  const wallBefore = await evaluate(win, wallProbe)
  await evaluate(win, `window.__aria.actions.setView('songs'); return true`)
  await sleep(10000)
  await collectGarbage(win)
  const wallAway = await evaluate(win, wallProbe)
  const awayMemory = memoryByType()
  await evaluate(win, `window.__aria.actions.setView('wall'); return true`)
  await sleep(2500)
  await collectGarbage(win)
  const wallBack = await evaluate(win, wallProbe)
  out.wallIdle = {
    before: { ...wallBefore, rendererMB: out.wall.byType.renderer ? out.wall.byType.renderer.rssMB : 0 },
    away: { ...wallAway, rendererMB: awayMemory.renderer ? awayMemory.renderer.rssMB : 0 },
    back: wallBack,
    panRestored: Boolean(wallBefore.pan && wallBack.pan &&
      wallBefore.pan.x === wallBack.pan.x && wallBefore.pan.y === wallBack.pan.y)
  }
  console.log(`6) 离开媒体墙：在墙 ${wallBefore.nodes} 节点（renderer ${out.wallIdle.before.rendererMB}MB）` +
    ` → 去歌曲页 10s 后 ${wallAway.nodes} 节点（renderer ${out.wallIdle.away.rendererMB}MB）` +
    ` → 回墙 ${wallBack.nodes} 节点，平移还原=${out.wallIdle.panRestored}`)

  /* ---------- 7. 播放历史写盘（任务 5）---------- */
  const cachePath = path.join(app.getPath('userData'), 'library-cache.json')
  const statOf = (file) => { try { const st = fs.statSync(file); return { size: st.size, mtimeMs: st.mtimeMs } } catch { return null } }
  const cacheBefore = statOf(cachePath)
  const historyBefore = library.getPlayHistoryStats ? library.getPlayHistoryStats().bytesWritten : 0
  await evaluate(win, `
    const { remote, store } = window.__aria
    const tracks = store.get().library.tracks.slice(0, 100)
    for (const track of tracks) {
      try { await remote.library.markPlayed(track.id) } catch (err) {}
    }
    return true`)
  await sleep(2500)
  const cacheAfter = statOf(cachePath)
  const historyAfter = library.getPlayHistoryStats ? library.getPlayHistoryStats() : { bytesWritten: 0 }
  const cacheBytes = cacheBefore ? cacheBefore.size : 0
  out.history = {
    switches: 100,
    historyBytes: historyAfter.bytesWritten - historyBefore,
    cacheRewritten: Boolean(cacheBefore && cacheAfter && cacheAfter.mtimeMs !== cacheBefore.mtimeMs),
    cacheBytes,
    fullRewriteBytes: cacheBytes * 100
  }
  console.log(`7) 播放历史：连播 100 首 → 历史文件写入 ${(out.history.historyBytes / 1024).toFixed(1)} KB；` +
    `library-cache.json ${out.history.cacheRewritten ? '被重写 ✗' : '未改动 ✓'}（该文件 ${(cacheBytes / 1024).toFixed(0)} KB，改前约 ${(out.history.fullRewriteBytes / 1024 / 1024).toFixed(1)} MB）`)

  /* 落一份 JSON，方便与改后对比 */
  const target = path.join(process.cwd(), '.tmp', `perf-baseline-${Date.now()}.json`)
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8')
    console.log(`\n读数已写入 ${path.relative(process.cwd(), target)}`)
  } catch (error) {
    console.log(`\n写读数失败：${error.message}`)
  }
  return out
}

module.exports = { runPerfBaseline }
