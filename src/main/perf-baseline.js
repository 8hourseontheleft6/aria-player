'use strict'

/**
 * P0 基线测量（`npm run perf:baseline`）。
 *
 * 只测量、不改产品行为：
 *  1. 冷启动：app ready → ready-to-show → 渲染层首屏可交互
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

async function runPerfBaseline ({ win, ctx }) {
  const { app } = require('electron')
  const out = { at: new Date().toISOString(), version: app.getVersion() }

  console.log('\n=== P0 基线 ===\n')
  console.log(`版本 ${out.version}  平台 ${process.platform}/${process.arch}  Electron ${process.versions.electron}`)

  /* ---------- 1. 冷启动 ---------- */
  await new Promise((resolve) => {
    if (win.webContents.isLoading() === false) return resolve()
    win.webContents.once('did-finish-load', resolve)
  })
  const boot = globalThis.__ariaBoot || {}
  const pageBoot = await evaluate(win, `
    const marks = window.__ariaBootMarks || null
    return marks ? { interactive: marks.interactive, timeOrigin: marks.timeOrigin } : null`)
  const interactiveEpoch = pageBoot && pageBoot.timeOrigin ? pageBoot.timeOrigin + pageBoot.interactive : 0
  out.coldStart = {
    readyAt: boot.readyAt || 0,
    readyToShowAt: boot.readyToShowAt || 0,
    interactiveEpoch,
    readyToShowMs: boot.readyAt && boot.readyToShowAt ? boot.readyToShowAt - boot.readyAt : 0,
    interactiveMs: boot.readyAt && interactiveEpoch ? Math.round(interactiveEpoch - boot.readyAt) : 0
  }
  console.log(`1) 冷启动：ready→ready-to-show ${out.coldStart.readyToShowMs}ms；ready→首屏可交互 ${out.coldStart.interactiveMs}ms`)

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
      const { store, actions } = window.__aria
      actions.setSetting({ visualizer: ${JSON.stringify(visualizer)} })
      const tracks = store.get().library.tracks
      const track = tracks.find((t) => Number(t.duration) > 120) || tracks[0]
      actions.playTrack(track)
      return true`)
    await sleep(30000)
    const sample = { byType: memoryByType(), main: mainMemory() }
    console.log(`3) 播放 30 秒（示波器 ${visualizer ? '开' : '关'}）：` +
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
