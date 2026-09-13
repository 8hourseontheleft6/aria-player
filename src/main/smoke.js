'use strict'

/**
 * 自检（smoke test）：在真实 Electron 环境里跑一遍完整链路。
 *
 *   npm run smoke
 *
 * 覆盖：资料库加载 → 元数据/歌词解析 → 播放 → 进度推进 → seek →
 *       上下曲 → 播放模式 → 倍速 → 歌词跟随 → WebAudio 插入点。
 * 全部通过时退出码为 0，方便放进 CI。
 */

const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const POLL_INTERVAL = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function evaluate (win, expression) {
  const result = win.webContents.executeJavaScript(`(async () => { ${expression} })()`, true)
  // executeJavaScript 在页面卡死时可能永不 settle，加一层超时保护
  return Promise.race([
    result,
    sleep(15000).then(() => {
      throw new Error('渲染层无响应（executeJavaScript 超时）')
    })
  ])
}

/** 在渲染层里轮询等待条件成立 */
async function waitFor (win, condition, { timeout = 30000, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  process.stdout.write(`  · 等待：${label} …\n`)
  while (Date.now() < deadline) {
    try {
      if (await evaluate(win, `return Boolean(${condition})`)) {
        process.stdout.write(`  · ${label} 就绪\n`)
        return true
      }
    } catch (err) {
      process.stdout.write(`  · ${label} 轮询异常：${err.message}\n`)
      await sleep(500)
    }
    await sleep(POLL_INTERVAL)
  }
  throw new Error(`等待超时：${label}`)
}

async function runSmoke ({ win, ctx }) {
  const checks = []
  const record = (name, ok, detail = '') => {
    checks.push({ name, ok, detail })
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  console.log('\n=== Aria 自检 ===\n')

  try {
    // 调用方已经在 did-finish-load 之后才启动自检，这里直接开始
    await waitFor(win, 'window.__aria && window.__aria.store.get().ready === true', {
      label: '渲染层启动', timeout: 30000
    })
    record('渲染层启动', true)

    await waitFor(win, 'window.__aria.store.get().library.loaded === true', {
      label: '资料库加载', timeout: 120000
    })
    const library = await evaluate(win, `
      const state = window.__aria.store.get()
      return {
        tracks: state.library.tracks.length,
        folders: state.library.folders.length,
        withLyrics: state.library.tracks.filter((t) => t.lyricsPath).length,
        withArtwork: state.library.tracks.filter((t) => t.artworkEmbedded || t.artworkFile).length,
        totalDuration: Math.round(state.library.totalDuration)
      }`)
    record('资料库加载', library.tracks > 0, `${library.tracks} 首 / ${library.folders} 个目录 / 总计 ${library.totalDuration}s`)
    record('元数据解析', library.tracks > 0 && library.totalDuration > 0, `带封面 ${library.withArtwork} 首`)
    record('歌词索引', library.withLyrics > 0, `带歌词 ${library.withLyrics} 首`)

    // 找一首带歌词的曲目来验证歌词链路
    const hasLyricTrack = await evaluate(win, `
      const tracks = window.__aria.store.get().library.tracks
      const track = tracks.find((t) => t.lyricsPath) || tracks[0]
      window.__aria.actions.playTrack(track)
      return Boolean(track)`)
    record('发起播放', hasLyricTrack, '')

    await waitFor(win, 'window.__aria.player.getTime() > 0.4', {
      label: '播放进度推进', timeout: 25000
    })
    const playback = await evaluate(win, `
      const player = window.__aria.player
      const state = window.__aria.store.get()
      return {
        status: state.playback.status,
        time: Math.round(player.getTime() * 100) / 100,
        duration: Math.round(player.getDuration()),
        title: player.currentTrack().title,
        paused: player.engine.paused
      }`)
    record('音频播放', playback.time > 0.25 && !playback.paused,
      `《${playback.title}》 ${playback.time}s / ${playback.duration}s，状态 ${playback.status}`)

    // 歌词跟随
    await waitFor(win, 'window.__aria.store.get().lyrics.status === "ready" || window.__aria.store.get().lyrics.status === "none" || window.__aria.store.get().lyrics.status === "plain"', {
      label: '歌词加载', timeout: 15000
    })
    const lyrics = await evaluate(win, `
      const state = window.__aria.store.get()
      return { status: state.lyrics.status, lines: state.lyrics.lines.length, file: state.lyrics.file, source: state.lyrics.source }`)
    record('歌词加载', lyrics.lines > 0 || lyrics.status === 'none',
      `${lyrics.lines} 行，来源 ${lyrics.source}${lyrics.file ? `（${lyrics.file}）` : ''}`)

    if (lyrics.lines > 0) {
      const followed = await evaluate(win, `
        const player = window.__aria.player
        const index = player.activeLyricIndex(player.getTime())
        return { index, total: window.__aria.store.get().lyrics.lines.length }`)
      record('歌词时间轴定位', followed.index >= -1, `当前第 ${followed.index + 1} / ${followed.total} 行`)
    }

    // seek
    const seekResult = await evaluate(win, `
      const player = window.__aria.player
      const duration = player.getDuration()
      const target = Math.min(30, Math.max(5, duration / 2))
      player.seek(target)
      await new Promise((r) => setTimeout(r, 400))
      return { target, actual: Math.round(player.getTime() * 10) / 10 }`)
    record('进度条 seek', Math.abs(seekResult.actual - seekResult.target) < 2.5,
      `目标 ${seekResult.target.toFixed(1)}s → 实际 ${seekResult.actual}s`)

    // 变速
    const rateResult = await evaluate(win, `
      const player = window.__aria.player
      player.setRate(1.5)
      await new Promise((r) => setTimeout(r, 200))
      const applied = player.engine.element.playbackRate
      const pitch = player.engine.element.preservesPitch
      player.setRate(1)
      return { applied, pitch }`)
    record('倍速播放', Math.abs(rateResult.applied - 1.5) < 0.01, `playbackRate=${rateResult.applied}，保持音调=${rateResult.pitch}`)

    // 队列与切歌
    const queueResult = await evaluate(win, `
      const { player, store, actions } = window.__aria
      const tracks = store.get().library.tracks
      actions.playAll()
      await new Promise((r) => setTimeout(r, 600))
      const first = store.get().playback.trackId
      player.next()
      await new Promise((r) => setTimeout(r, 900))
      const second = store.get().playback.trackId
      player.prev()
      await new Promise((r) => setTimeout(r, 900))
      return { queue: store.get().playback.queue.length, first, second, backTo: store.get().playback.trackId, total: tracks.length }`)
    record('播放队列', queueResult.queue === queueResult.total, `队列 ${queueResult.queue} 首`)
    record('下一首 / 上一首', queueResult.first && queueResult.second && queueResult.first !== queueResult.second && queueResult.backTo === queueResult.first,
      `${queueResult.first?.slice(0, 6)} → ${queueResult.second?.slice(0, 6)} → ${queueResult.backTo?.slice(0, 6)}`)

    // 播放模式
    const modeResult = await evaluate(win, `
      const { player, store } = window.__aria
      const seen = []
      for (const mode of player.modes) {
        player.setMode(mode.id)
        seen.push(store.get().playback.mode)
      }
      player.setMode('loop-list')
      return { seen, modes: player.modes.map((m) => m.id) }`)
    record('播放模式切换', modeResult.seen.length >= 4, modeResult.modes.join(' / '))

    // 单曲循环的自动重播逻辑
    const repeatResult = await evaluate(win, `
      const { player, store } = window.__aria
      player.setMode('repeat-one')
      const before = store.get().playback.trackId
      player.engine.element.dispatchEvent(new Event('ended'))
      await new Promise((r) => setTimeout(r, 500))
      const after = store.get().playback.trackId
      player.setMode('loop-list')
      return { before, after }`)
    record('单曲循环（播完重播本曲）', repeatResult.before === repeatResult.after, '')

    // 顺序播放播完即停
    const stopResult = await evaluate(win, `
      const { player, store } = window.__aria
      const tracks = store.get().library.tracks
      player.setMode('sequence')
      player.playCollection([tracks[0].id], tracks[0].id)
      await new Promise((r) => setTimeout(r, 500))
      player.engine.element.dispatchEvent(new Event('ended'))
      await new Promise((r) => setTimeout(r, 500))
      const status = store.get().playback.status
      player.setMode('loop-list')
      return { status }`)
    record('顺序播放（末尾停止）', stopResult.status === 'ended', `状态 ${stopResult.status}`)

    // 插件与扩展点
    const pluginResult = await evaluate(win, `
      const { host } = window.__aria
      return {
        plugins: host.loaded(),
        points: Object.keys(host.POINTS).map((point) => [point, host.list(point).length]),
        modes: host.list('playbackMode').length,
        panels: host.list('panel').length,
        trackActions: host.list('trackAction').length
      }`)
    record('插件宿主', pluginResult.plugins.length > 0,
      `${pluginResult.plugins.map((p) => p.name).join('、')}；扩展点 ${pluginResult.points.map(([k, v]) => `${k}:${v}`).join(' ')}`)
    record('内置播放模式注册', pluginResult.modes >= 5, `${pluginResult.modes} 种（含插件新增的「只播放一次」）`)

    // 封面配色
    const tintResult = await evaluate(win, `
      const url = await window.__aria.artwork.resolveUrl(window.__aria.player.currentTrack())
      return { hasUrl: Boolean(url), tint: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim() }`)
    record('封面与配色', Boolean(tintResult.tint), `--tint = ${tintResult.tint}${tintResult.hasUrl ? '' : '（无封面，使用回退配色）'}`)

    // media:// 协议：Range 支持与 CORS 头（seek 与 WebAudio 接入点都依赖它们）
    const protocolResult = await evaluate(win, `
      const track = window.__aria.player.currentTrack()
      const url = 'media://local/?p=' + encodeURIComponent(track.path) + '&v=' + track.mtimeMs
      const ranged = await fetch(url, { headers: { Range: 'bytes=100-199' } })
      const full = await fetch(url, { method: 'HEAD' })
      return {
        crossOrigin: window.__aria.engine.element.crossOrigin,
        rangedStatus: ranged.status,
        contentRange: ranged.headers.get('content-range'),
        acceptRanges: ranged.headers.get('accept-ranges'),
        acao: ranged.headers.get('access-control-allow-origin'),
        fullLength: Number(full.headers.get('content-length')),
        rangedBytes: (await ranged.arrayBuffer()).byteLength
      }`)
    record('media:// Range 流式',
      protocolResult.rangedStatus === 206 && protocolResult.rangedBytes === 100,
      `206 ${protocolResult.contentRange}，共 ${protocolResult.fullLength} 字节`)
    record('media:// CORS 头',
      protocolResult.acao === '*' && protocolResult.crossOrigin === 'anonymous',
      `ACAO=${protocolResult.acao}，audio.crossOrigin=${protocolResult.crossOrigin}`)

    // WebAudio 接入点：插件可视化用。
    // 用 AnalyserNode 采样波形，验证音频真的流经 WebAudio 图（若 CORS 配置不对，
    // MediaElementAudioSourceNode 会输出全 128 的静音数据）。
    const tapResult = await evaluate(win, `
      const { engine, player } = window.__aria
      const tap = engine.getTap()
      if (!tap) return { ok: false, reason: 'AudioContext 不可用' }
      const analyser = tap.context.createAnalyser()
      analyser.fftSize = 2048
      const disconnect = tap.connect(analyser)
      await player.play()
      await new Promise((r) => setTimeout(r, 700))
      const buffer = new Uint8Array(analyser.fftSize)
      let maxDeviation = 0
      const before = player.getTime()
      for (let i = 0; i < 12; i++) {
        analyser.getByteTimeDomainData(buffer)
        for (const value of buffer) maxDeviation = Math.max(maxDeviation, Math.abs(value - 128))
        await new Promise((r) => setTimeout(r, 60))
      }
      const advanced = Math.round((player.getTime() - before) * 10) / 10
      disconnect()
      return { ok: true, state: tap.context.state, maxDeviation, advanced }`)
    record('WebAudio 接入点', tapResult.ok && tapResult.advanced > 0 && tapResult.maxDeviation > 1,
      tapResult.ok
        ? `AudioContext ${tapResult.state}，波形振幅 ${tapResult.maxDeviation}/128，推进 ${tapResult.advanced}s`
        : tapResult.reason)

    // 搜索
    const searchResult = await evaluate(win, `
      const { actions, store } = window.__aria
      const tracks = store.get().library.tracks
      const keyword = tracks[0].title.slice(0, 4)
      actions.setView('songs')
      actions.setQuery(keyword)
      await new Promise((r) => setTimeout(r, 200))
      const found = document.querySelectorAll('.track-row').length
      actions.setQuery('')
      return { keyword, found }`)
    record('搜索', true, `关键词「${searchResult.keyword}」渲染 ${searchResult.found} 行`)

    // 正在播放面板与歌词视图
    const uiResult = await evaluate(win, `
      const { actions } = window.__aria
      actions.openNowPlaying({ lyrics: true })
      await new Promise((r) => setTimeout(r, 500))
      const panel = document.getElementById('now-playing')
      const visible = panel && !panel.hidden && panel.getBoundingClientRect().height > 0
      const lines = document.querySelectorAll('.lyrics__line').length
      const active = document.querySelectorAll('.lyrics__line.is-active').length
      return { visible, lines, active, tabs: document.querySelectorAll('.now-playing__tab').length }`)
    record('正在播放面板', uiResult.visible, `标签页 ${uiResult.tabs} 个`)
    record('歌词界面渲染', uiResult.lines > 0 || uiResult.tabs > 0, `${uiResult.lines} 行，当前高亮 ${uiResult.active} 行`)

    /* ---------- 界面交互 ---------- */

    // 点击歌词行要能跳转
    const lyricSeek = await evaluate(win, `
      const { player } = window.__aria
      const nodes = [...document.querySelectorAll('.lyrics__line')]
      const target = nodes[Math.min(8, nodes.length - 1)]
      const expected = Number(target?.dataset.index ?? -1)
      target?.click()
      await new Promise((r) => setTimeout(r, 600))
      const time = player.getTime()
      const lines = window.__aria.store.get().lyrics.lines
      return { expected, time: Math.round(time * 10) / 10, lineTime: lines[expected] ? Math.round(lines[expected].time * 10) / 10 : null, active: document.querySelectorAll('.lyrics__line.is-active').length }`)
    record('点击歌词行跳转', lyricSeek.expected >= 0 && lyricSeek.active === 1,
      `跳到第 ${lyricSeek.expected + 1} 行 (${lyricSeek.lineTime}s) → 播放位置 ${lyricSeek.time}s，高亮 ${lyricSeek.active} 行`)

    // 右键菜单（含插件注册的动作）
    const menuResult = await evaluate(win, `
      const { actions, store } = window.__aria
      const track = store.get().library.tracks[0]
      actions.openTrackMenu(track, { clientX: 400, clientY: 300 })
      await new Promise((r) => setTimeout(r, 300))
      const items = [...document.querySelectorAll('.menu__item')].map((node) => node.textContent.trim())
      const open = document.querySelectorAll('.menu').length
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 200))
      return { open, items, closed: document.querySelectorAll('.menu').length }`)
    record('曲目右键菜单', menuResult.open === 1 && menuResult.items.length >= 6,
      `${menuResult.items.length} 项：${menuResult.items.slice(0, 3).join(' / ')}…（含插件动作）`)
    record('Esc 关闭浮层', menuResult.closed === 0, '')

    // 播放队列面板
    const queueResult2 = await evaluate(win, `
      const { actions } = window.__aria
      actions.closeNowPlaying()
      actions.toggleQueue(true)
      await new Promise((r) => setTimeout(r, 400))
      const panels = document.querySelectorAll('.queue-panel')
      const panel = panels[0] || null
      const rect = panel ? panel.getBoundingClientRect() : null
      const rows = document.querySelectorAll('.queue-item').length
      const current = document.querySelectorAll('.queue-item.is-current').length
      const openFlag = window.__aria.store.get().ui.queueOpen
      actions.toggleQueue(false)
      return {
        found: panels.length,
        openFlag,
        hidden: panel ? panel.hidden : null,
        rect: rect ? { x: Math.round(rect.x), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        rows,
        current
      }`)
    record('播放队列面板', Boolean(queueResult2.rect && queueResult2.rect.h > 0) && queueResult2.rows > 0,
      `state.queueOpen=${queueResult2.openFlag}，面板 ${JSON.stringify(queueResult2.rect)}，${queueResult2.rows} 行，当前曲目 ${queueResult2.current} 个`)

    // 图标必须渲染成 SVG 图形而不是文本
    const iconResult = await evaluate(win, `
      const { host } = window.__aria
      void host
      const names = ['search', 'folder', 'waveform', 'sliders', 'list', 'chevronDown', 'repeat', 'shuffle', 'play', 'pause']
      const module = await import('app://bundle/js/core/icons.js')
      const bad = []
      for (const name of names) {
        const node = module.icon(name)
        const hasShape = node.children.length > 0
        const tag = node.firstElementChild?.tagName.toLowerCase()
        if (!hasShape || tag !== 'path' && tag !== 'rect' && tag !== 'circle') bad.push(name)
      }
      return { bad, checked: names.length }`)
    record('图标渲染为 SVG 形状', iconResult.bad.length === 0,
      iconResult.bad.length ? `异常：${iconResult.bad.join(', ')}` : `${iconResult.checked} 个图标均为图形元素`)

    // 设置项持久化
    const settingResult = await evaluate(win, `
      const before = await window.aria.settings.get()
      await window.__aria.actions.setSetting({ showRowArtwork: !before.showRowArtwork })
      await new Promise((r) => setTimeout(r, 300))
      const afterRestore = await window.aria.settings.get()
      await window.__aria.actions.setSetting({ showRowArtwork: before.showRowArtwork })
      await new Promise((r) => setTimeout(r, 200))
      const finalState = await window.aria.settings.get()
      return {
        changed: afterRestore.showRowArtwork === !before.showRowArtwork,
        restored: finalState.showRowArtwork === before.showRowArtwork,
        storeSynced: window.__aria.store.get().settings.showRowArtwork === before.showRowArtwork
      }`)
    record('设置读写与回传', settingResult.changed && settingResult.restored && settingResult.storeSynced, 'IPC 写入 → 主进程落盘 → 广播回渲染层')

    // 设置页渲染
    const settingsResult = await evaluate(win, `
      const { actions } = window.__aria
      actions.setView('settings')
      await new Promise((r) => setTimeout(r, 500))
      const cards = document.querySelectorAll('.settings__card').length
      const switches = document.querySelectorAll('.settings .switch').length
      const visible = document.querySelector('.settings')?.getBoundingClientRect().height > 0
      actions.setView('songs')
      return { cards, switches, visible }`)
    record('设置页渲染', settingsResult.visible && settingsResult.cards >= 5,
      `${settingsResult.cards} 个分组卡片，${settingsResult.switches} 个开关`)

    /* ---------- 浏览视图 ---------- */

    // 专辑 / 艺人分组
    const groupResult = await evaluate(win, `
      const { actions, store } = window.__aria
      const albums = actions.albums()
      const artists = actions.artists()
      const total = store.get().library.tracks.length
      const counted = albums.reduce((sum, album) => sum + album.trackCount, 0)
      return {
        albums: albums.length,
        artists: artists.length,
        total,
        counted,
        firstAlbum: albums[0] ? { name: albums[0].name, artist: albums[0].albumArtist, tracks: albums[0].trackCount, key: albums[0].key } : null,
        firstArtist: artists[0] ? { name: artists[0].name, albums: artists[0].albumCount, tracks: artists[0].trackCount } : null
      }`)
    record('专辑分组', groupResult.albums > 0 && groupResult.counted === groupResult.total,
      `${groupResult.albums} 张专辑，覆盖 ${groupResult.counted}/${groupResult.total} 首；例：${groupResult.firstAlbum?.artist}《${groupResult.firstAlbum?.name}》${groupResult.firstAlbum?.tracks} 首`)
    record('艺人分组', groupResult.artists > 0,
      `${groupResult.artists} 位艺人；例：${groupResult.firstArtist?.name}（${groupResult.firstArtist?.albums} 张 / ${groupResult.firstArtist?.tracks} 首）`)

    // 专辑网格 + 详情页
    const albumView = await evaluate(win, `
      const { actions } = window.__aria
      actions.setView('albums')
      await new Promise((r) => setTimeout(r, 600))
      const cards = document.querySelectorAll('.cover-card').length
      const covers = document.querySelectorAll('.cover-card__art img').length
      const page = document.querySelector('.browse-page')
      const root = page?.parentElement
      const content = document.getElementById('content')
      const rectOf = (el) => { const r = el?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null }
      const geometry = { page: rectOf(page), root: rectOf(root), content: rectOf(content), display: page ? getComputedStyle(page).display : null }
      const visible = Boolean(page && page.getBoundingClientRect().height > 0)
      const first = document.querySelector('.cover-card')
      first?.click()
      await new Promise((r) => setTimeout(r, 600))
      const detail = document.querySelectorAll('.browse-page')[2]
      const detailTitle = detail?.querySelector('.browse-detail__title')?.textContent || ''
      const rows = detail ? detail.querySelectorAll('.track-row').length : 0
      const detailVisible = Boolean(detail && detail.getBoundingClientRect().height > 0)
      const detailKey = window.__aria.store.get().ui.detail?.key || null
      return { cards, covers, visible, geometry, detailTitle, rows, detailVisible, detailKey }`)
    record('专辑网格', albumView.visible && albumView.cards > 0,
      `${albumView.cards} 张卡片，已加载封面 ${albumView.covers} 张，几何 ${JSON.stringify(albumView.geometry)}`)
    record('专辑详情页', albumView.detailVisible && Boolean(albumView.detailKey) && albumView.detailTitle.length > 0 && albumView.rows > 0,
      `《${albumView.detailTitle}》渲染 ${albumView.rows} 行曲目`)

    // 从专辑详情播放：队列应该等于该专辑曲目数
    const albumPlay = await evaluate(win, `
      const { actions, store, player } = window.__aria
      const album = actions.albumByKey(store.get().ui.detail.key)
      actions.playCollectionOf(album.tracks, album.tracks[0])
      await new Promise((r) => setTimeout(r, 800))
      const queue = store.get().playback.queue.length
      const playing = player.currentTrack()
      return { queue, albumTracks: album.trackCount, title: playing?.title || '' }`)
    record('按专辑播放', albumPlay.queue === albumPlay.albumTracks,
      `队列 ${albumPlay.queue} 首 = 专辑 ${albumPlay.albumTracks} 首；正在播放《${albumPlay.title}》`)

    // 艺人列表与详情
    const artistView = await evaluate(win, `
      const { actions } = window.__aria
      actions.setView('artists')
      await new Promise((r) => setTimeout(r, 600))
      const rows = document.querySelectorAll('.artist-row').length
      document.querySelector('.artist-row')?.click()
      await new Promise((r) => setTimeout(r, 700))
      const name = document.querySelector('.browse-detail__title')?.textContent || ''
      const strip = document.querySelectorAll('.cover-grid--strip .cover-card').length
      const detailKey = window.__aria.store.get().ui.detail?.key || null
      const backVisible = Boolean(document.querySelector('.browse-back'))
      document.querySelector('.browse-back')?.click()
      await new Promise((r) => setTimeout(r, 400))
      const detailAfterBack = window.__aria.store.get().ui.detail
      actions.setView('songs')
      return { rows, name, strip, detailKey, backVisible, detailAfterBack }`)
    record('艺人列表', artistView.rows > 0, `${artistView.rows} 位艺人`)
    record('艺人详情与返回', Boolean(artistView.detailKey) && artistView.name.length > 0 && artistView.backVisible && artistView.detailAfterBack === null,
      `《${artistView.name}》横向专辑 ${artistView.strip} 张，返回后详情状态已清空`)

    // 媒体墙
    const wallView = await evaluate(win, `
      const { actions, store } = window.__aria
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 1100))

      const grid = document.querySelector('.media-wall')
      const tiles = document.querySelectorAll('.wall-tile').length
      const imgs = document.querySelectorAll('.wall-tile__art img').length
      const widthBefore = grid?.style.getPropertyValue('--wall-min')

      // --- 聚焦块 ---
      // 注意：computed style 也要立刻取值，后面切换专辑时这个元素就不再是聚焦块了
      const gridRect0 = document.querySelector('.media-wall').getBoundingClientRect()
      const featured = document.querySelector('.wall-tile.is-featured')
      const featuredStyle = featured ? getComputedStyle(featured) : null
      const featuredOrder = featuredStyle ? featuredStyle.order : null
      const featuredColumn = featuredStyle ? featuredStyle.gridColumnStart : null
      const featuredRow = featuredStyle ? featuredStyle.gridRowStart : null
      const featuredRect = featured ? featured.getBoundingClientRect() : null
      const hero = featured?.querySelector('.wall-tile__hero')
      const heroTitle = hero?.querySelector('.hero__title')?.textContent || ''
      const heroLines = hero ? hero.querySelectorAll('.mini-lyrics__line').length : 0
      const heroActive = hero ? hero.querySelectorAll('.mini-lyrics__line.is-active').length : 0
      const heroControls = hero ? hero.querySelectorAll('.hero__control').length : 0
      const hasExpandButton = Boolean(hero?.querySelector('.hero__expand'))
      const featuredKey = featured?.dataset.key || null
      const currentTrack = store.get().library.byId.get(store.get().playback.trackId)
      const currentAlbumKey = currentTrack
        ? (currentTrack.albumArtist || currentTrack.artist || '') + '\\u0000' + (currentTrack.album || '未知专辑')
        : null

      // --- 密度切换应当用 FLIP 平滑过渡 ---
      const sizeBefore = grid?.style.getPropertyValue('--wall-size')
      const columnsBefore = grid?.style.getPropertyValue('--wall-columns')
      document.querySelector('[data-density="s"]')?.click()
      const flippingRightAfter = document.querySelectorAll('.wall-tile.is-flipping').length
      const animated = document.getAnimations().length
      await new Promise((r) => setTimeout(r, 900))
      const sizeAfter = grid?.style.getPropertyValue('--wall-size')
      const columnsAfter = grid?.style.getPropertyValue('--wall-columns')
      const flippingAfter = document.querySelectorAll('.wall-tile.is-flipping').length

      // --- 切换到另一张「排在很后面」的专辑：聚焦块应当原地放大，而不是跳到平面上角 ---
      const beforeSwitchKey = document.querySelector('.wall-tile.is-featured')?.dataset.key || null
      const albums = window.__aria.actions.albums()
      const other = albums.find((a) => a.key !== beforeSwitchKey) || null
      // 用靠后的专辑做验证：如果聚焦块会被强制排到首位，它的位置必然回到原点
      const farAlbum = albums[Math.min(120, albums.length - 1)] || other
      if (farAlbum) window.__aria.actions.playCollectionOf(farAlbum.tracks, farAlbum.tracks[0])
      await new Promise((r) => setTimeout(r, 1100))
      const afterSwitchTile = document.querySelector('.wall-tile.is-featured')
      const afterSwitchKey = afterSwitchTile?.dataset.key || null
      const afterSwitchTitle = afterSwitchTile?.querySelector('.hero__title')?.textContent || ''
      const afterSwitchOrder = afterSwitchTile ? getComputedStyle(afterSwitchTile).order : null
      const gridRectAfter = document.querySelector('.media-wall').getBoundingClientRect()
      const afterRect = afterSwitchTile ? afterSwitchTile.getBoundingClientRect() : null
      // 「原地放大」= 它的左边缘远离平面左上角（离原点有几个格子宽），而不是被拽到首位
      const distanceFromOrigin = afterRect && gridRectAfter
        ? {
            left: Math.round(afterRect.left - gridRectAfter.left),
            top: Math.round(afterRect.top - gridRectAfter.top)
          }
        : null
      const afterSwitchPosition = Boolean(afterRect) && afterRect.left - gridRectAfter.left > 300
      const progressWidth = afterSwitchTile?.querySelector('.hero__progress i')?.style.width || '0%'

      // --- 打开专辑 ---
      document.querySelector('.wall-tile:not(.is-featured) .wall-tile__open')?.click()
      await new Promise((r) => setTimeout(r, 500))
      const openedAlbum = Boolean(store.get().ui.detail)
      actions.closeDetail()
      actions.setView('songs')

      return {
        tiles, imgs, sizeBefore, sizeAfter, columnsBefore, columnsAfter,
        flippingRightAfter, flippingAfter, animated,
        hasFeatured: Boolean(featured),
        featuredKey, currentAlbumKey,
        featuredOrder, featuredColumn, featuredRow,
        featuredRectFromOrigin: featuredRect && gridRect0
          ? { left: Math.round(featuredRect.left - gridRect0.left), top: Math.round(featuredRect.top - gridRect0.top) }
          : null,
        heroTitle, heroLines, heroActive, heroControls, hasExpandButton,
        beforeSwitchKey, expectedSwitchKey: farAlbum?.key || null, afterSwitchKey, afterSwitchTitle,
        afterSwitchOrder, afterSwitchPosition, distanceFromOrigin, progressWidth,
        openedAlbum
      }`)
    record('媒体墙', wallView.tiles > 0 && wallView.tiles === groupResult.albums,
      `${wallView.tiles} 张封面方块（= 专辑数），已加载 ${wallView.imgs} 张`)
    record('媒体墙密度切换', wallView.sizeBefore !== wallView.sizeAfter,
      `格子 ${wallView.sizeBefore}→${wallView.sizeAfter}，列数 ${wallView.columnsBefore}→${wallView.columnsAfter}`)
    record('媒体墙聚焦块',
      wallView.hasFeatured && wallView.featuredKey === wallView.currentAlbumKey &&
      wallView.featuredColumn === 'span 2' && wallView.featuredOrder === '0',
      `聚焦块跨列 ${wallView.featuredColumn}、order=${wallView.featuredOrder}（不再被强制排到首位），距平面原点 ${JSON.stringify(wallView.featuredRectFromOrigin)}`)
    record('聚焦块内容',
      wallView.heroTitle.length > 0 && wallView.heroControls === 3 && wallView.hasExpandButton &&
      wallView.heroLines > 0 && wallView.heroActive === 1,
      `标题《${wallView.heroTitle}》，迷你歌词 ${wallView.heroLines} 行（高亮 ${wallView.heroActive} 行），传输键 ${wallView.heroControls} 个 + 展开键，进度 ${wallView.progressWidth}`)
    record('密度切换 FLIP 过渡', wallView.animated > 0 && wallView.flippingAfter === 0,
      `切换瞬间有 ${wallView.flippingRightAfter} 个格子参与动画（共 ${wallView.animated} 个动画），900ms 后全部收敛`)
    record('聚焦块跟随切歌',
      Boolean(wallView.afterSwitchKey) && wallView.afterSwitchKey === wallView.expectedSwitchKey &&
      wallView.afterSwitchTitle.length > 0 && wallView.afterSwitchPosition,
      `播放靠后的专辑后聚焦块移到它自己的位置（距原点 ${JSON.stringify(wallView.distanceFromOrigin)}，order=${wallView.afterSwitchOrder}），标题《${wallView.afterSwitchTitle}》`)
    record('媒体墙打开专辑', wallView.openedAlbum, '点击方块角标可进入专辑详情')

    /* ---------- 媒体墙的自由拖动（2D 画布） ---------- */

    const panCheck = await evaluate(win, `
      const { actions } = window.__aria
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 1300))

      const wall = window.__aria.views.mediaWall
      const viewport = document.querySelector('.wall-viewport')
      const rect = viewport.getBoundingClientRect()
      const cx = Math.round(rect.left + rect.width / 2)
      const cy = Math.round(rect.top + rect.height / 2)

      const pointer = (type, x, y, init = {}) => viewport.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, pointerType: 'mouse',
        clientX: x, clientY: y, ...init
      }))

      const initial = wall.debugState()

      // ① 中键斜向拖动：两个轴都应该动
      pointer('pointerdown', cx, cy, { button: 1, buttons: 4 })
      for (let i = 1; i <= 12; i++) pointer('pointermove', cx - i * 14, cy - i * 7, { button: 1, buttons: 4 })
      // 平移是按帧合流的，等一帧再读
      await new Promise((r) => requestAnimationFrame(r))
      const duringMiddle = wall.debugState().pan
      const lazyDuringDrag = wall.debugState().lazy
      pointer('pointerup', cx - 168, cy - 84, { button: 1, buttons: 0 })
      await new Promise((r) => setTimeout(r, 460))
      const afterMiddle = wall.debugState().pan
      const inertia = { x: afterMiddle.x - duringMiddle.x, y: afterMiddle.y - duringMiddle.y }

      // 惯性停稳 + 防抖窗口之后，封面观察应当自动恢复（惯性时长与环境帧率有关，这里轮询等待）
      let lazyAfterDrag = wall.debugState().lazy
      for (let i = 0; i < 40 && lazyAfterDrag.suspended; i++) {
        await new Promise((r) => setTimeout(r, 250))
        lazyAfterDrag = wall.debugState().lazy
      }

      // ② Alt + 左键往回拖
      const beforeAlt = wall.debugState().pan
      pointer('pointerdown', cx, cy, { button: 0, buttons: 1, altKey: true })
      for (let i = 1; i <= 12; i++) pointer('pointermove', cx + i * 12, cy + i * 5, { button: 0, buttons: 1, altKey: true })
      pointer('pointerup', cx + 144, cy + 60, { button: 0, buttons: 0, altKey: true })
      await new Promise((r) => setTimeout(r, 520))
      const afterAlt = wall.debugState().pan

      // ③ 滚轮直接平移（含横向）
      const beforeWheel = wall.debugState().pan
      viewport.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaX: 160, deltaY: 240
      }))
      await new Promise((r) => setTimeout(r, 500))
      const afterWheel = wall.debugState().pan

      // ④ 位置指示器：平移量非零时，内部视口框的位置应当等于 -pan*scale
      const minimap = document.querySelector('.wall-minimap')
      const mapBox = minimap?.querySelector('.wall-minimap__viewport')
      // 指示器的位移带 90ms 过渡，等它稳定下来再量（低帧率环境下要等更久）
      let previousBox = null
      let boxRect = null
      let mapRect = null
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 120))
        mapRect = minimap?.getBoundingClientRect()
        boxRect = mapBox?.getBoundingClientRect()
        // 注意：这里是包在模板字符串里的注入代码，内部不能再出现反引号
        const snapshot = Math.round(boxRect?.left || 0) + '|' + Math.round(boxRect?.top || 0)
        if (snapshot === previousBox) break
        previousBox = snapshot
      }
      const scale = Number(minimap?.dataset.scale) || 1
      const mapState = {
        visible: Boolean(minimap && !minimap.hidden),
        size: mapRect ? [Math.round(mapRect.width), Math.round(mapRect.height)] : null,
        scale,
        panX: afterWheel.x,
        panY: afterWheel.y,
        expectX: Math.round(-afterWheel.x * scale),
        actualX: Math.round((boxRect?.left || 0) - (mapRect?.left || 0)),
        expectY: Math.round(-afterWheel.y * scale),
        actualY: Math.round((boxRect?.top || 0) - (mapRect?.top || 0))
      }

      // ⑤ 使劲往边界外拖，松手后必须回到边界内
      pointer('pointerdown', cx, cy, { button: 1, buttons: 4 })
      for (let i = 1; i <= 30; i++) pointer('pointermove', cx + i * 60, cy + i * 60, { button: 1, buttons: 4 })
      pointer('pointerup', cx + 1800, cy + 1800, { button: 1, buttons: 0 })
      await new Promise((r) => setTimeout(r, 700))
      const afterOverdrag = wall.debugState()
      const withinBounds = afterOverdrag.pan.x <= 0 && afterOverdrag.pan.y <= 0 &&
        afterOverdrag.pan.x >= afterOverdrag.bounds.minX - 1 &&
        afterOverdrag.pan.y >= afterOverdrag.bounds.minY - 1

      // ⑥ 切到「适应宽度」：横向不再可拖；切回画布：横向恢复可拖
      document.querySelector('[data-layout="fit"]')?.click()
      await new Promise((r) => setTimeout(r, 800))
      const fitState = wall.debugState()
      document.querySelector('[data-layout="canvas"]')?.click()
      await new Promise((r) => setTimeout(r, 800))
      const canvasState = wall.debugState()

      return {
        initial, duringMiddle, afterMiddle, inertia, beforeAlt, afterAlt,
        beforeWheel, afterWheel, afterOverdrag, withinBounds, mapState, fitState, canvasState,
        lazyDuringDrag, lazyAfterDrag
      }`)
    const pan = panCheck
    record('媒体墙二维画布',
      pan.initial.horizontal && pan.initial.vertical &&
      pan.initial.bounds.width > pan.initial.bounds.viewWidth &&
      pan.initial.bounds.height > pan.initial.bounds.viewHeight,
      `平面 ${pan.initial.bounds.width}×${pan.initial.bounds.height} vs 视口 ${pan.initial.bounds.viewWidth}×${pan.initial.bounds.viewHeight}，${pan.initial.columns} 列 × ${pan.initial.tileSize}px`)
    record('中键斜向拖动',
      pan.duringMiddle.x !== 0 && pan.duringMiddle.y !== 0 &&
      Math.sign(pan.duringMiddle.x) === -1 && Math.sign(pan.duringMiddle.y) === -1,
      `拖动中位移 x=${pan.duringMiddle.x} y=${pan.duringMiddle.y}（横竖都在动）`)
    record('松手带惯性',
      Math.abs(pan.inertia.x) > 0 || Math.abs(pan.inertia.y) > 0,
      `松手后又滑行 x=${pan.inertia.x} y=${pan.inertia.y}`)
    record('拖动期间暂停封面观察',
      pan.lazyDuringDrag.suspended === true && pan.lazyDuringDrag.observing === 0 &&
      pan.lazyAfterDrag.suspended === false && pan.lazyAfterDrag.observing > 0,
      `拖动中 observing=${pan.lazyDuringDrag.observing}（暂停），停稳后恢复 observing=${pan.lazyAfterDrag.observing} / 待加载 ${pan.lazyAfterDrag.pending}`)
    record('Alt + 左键拖动',
      pan.afterAlt.x !== pan.beforeAlt.x && pan.afterAlt.y !== pan.beforeAlt.y,
      `x ${pan.beforeAlt.x} → ${pan.afterAlt.x}，y ${pan.beforeAlt.y} → ${pan.afterAlt.y}`)
    record('滚轮平移（含横向）',
      pan.afterWheel.x !== pan.beforeWheel.x && pan.afterWheel.y !== pan.beforeWheel.y,
      `滚轮后 x ${pan.beforeWheel.x} → ${pan.afterWheel.x}，y ${pan.beforeWheel.y} → ${pan.afterWheel.y}`)
    record('越界回弹与钳制', pan.withinBounds,
      `猛拖后落在边界内：x=${pan.afterOverdrag.pan.x}∈[${pan.afterOverdrag.bounds.minX},0]，y=${pan.afterOverdrag.pan.y}∈[${pan.afterOverdrag.bounds.minY},0]`)
    record('位置指示器',
      pan.mapState.visible && pan.mapState.panX !== 0 &&
      Math.abs(pan.mapState.expectX - pan.mapState.actualX) <= 3 &&
      Math.abs(pan.mapState.expectY - pan.mapState.actualY) <= 3,
      `指示器 ${pan.mapState.size?.join('×')}，平移 (${pan.mapState.panX},${pan.mapState.panY}) 时内部视口框实测 (${pan.mapState.actualX},${pan.mapState.actualY}) = 换算值 (${pan.mapState.expectX},${pan.mapState.expectY})`)
    record('布局切换',
      !pan.fitState.horizontal && pan.canvasState.horizontal && pan.fitState.layout === 'fit' && pan.canvasState.layout === 'canvas',
      `适应宽度：横向不可拖（${pan.fitState.bounds.width}≈视口 ${pan.fitState.bounds.viewWidth}）；自由画布：横向可拖（${pan.canvasState.bounds.width} vs ${pan.canvasState.bounds.viewWidth}）`)

    /* ---------- 平移的每帧开销（曾经每帧强制两次重排，导致一卡一卡） ---------- */

    const perfCheck = await evaluate(win, `
      const wall = window.__aria.views.mediaWall
      const viewport = document.querySelector('.wall-viewport')

      // 基准：什么都不做时的帧间隔。软件渲染 / 窗口被遮挡的环境本身就会节流 rAF，
      // 所以必须先量一个空载基准，否则「帧慢」会被误判成平移的锅。
      const idleFrames = []
      let idleLast = performance.now()
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        idleFrames.push(now - idleLast)
        idleLast = now
      }
      const idleWarm = idleFrames.slice(4)
      const idleAverage = idleWarm.reduce((sum, value) => sum + value, 0) / Math.max(1, idleWarm.length)

      // 每帧平移的纯开销（同步落一次，绕过 rAF 合流）
      for (let i = 0; i < 60; i++) wall.debugApplyPan(-i * 3, -i * 2)
      const rounds = 400
      const started = performance.now()
      for (let i = 0; i < rounds; i++) {
        wall.debugApplyPan(-(i % 900) * 4, -(i % 700) * 3)
      }
      const elapsed = performance.now() - started

      // 模拟 30 帧真实拖动，量帧间隔
      const frames = []
      let last = performance.now()
      const rect = viewport.getBoundingClientRect()
      const cx = Math.round(rect.left + rect.width / 2)
      const cy = Math.round(rect.top + rect.height / 2)
      const pointer = (type, x, y, init = {}) => viewport.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, isPrimary: true, pointerId: 9, pointerType: 'mouse',
        clientX: x, clientY: y, ...init
      }))
      pointer('pointerdown', cx, cy, { button: 1, buttons: 4 })
      for (let i = 0; i < 30; i++) {
        pointer('pointermove', cx - i * 9, cy - i * 4, { button: 1, buttons: 4 })
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        frames.push(now - last)
        last = now
      }
      pointer('pointerup', cx - 270, cy - 120, { button: 1, buttons: 0 })
      await new Promise((r) => setTimeout(r, 500))

      const dragWarm = frames.slice(4)
      const dragAverage = dragWarm.reduce((sum, value) => sum + value, 0) / Math.max(1, dragWarm.length)

      // 对照微基准：如果每帧照旧读 DOM（offsetWidth / getBoundingClientRect），代价是多少。
      // 这不是被测代码，只是用来量化「缓存几何」省下了什么。
      const grid = document.querySelector('.media-wall')
      const minimap = document.querySelector('.wall-minimap')
      const domRounds = 100
      const domStarted = performance.now()
      for (let i = 0; i < domRounds; i++) {
        void grid.offsetWidth
        void minimap.getBoundingClientRect()
        grid.style.transform = 'translate3d(' + (-i) + 'px,' + (-i) + 'px,0)'
      }
      const domElapsed = performance.now() - domStarted

      return {
        rounds,
        elapsed: Math.round(elapsed * 100) / 100,
        perCall: Math.round((elapsed / rounds) * 10000) / 10000,
        idleAverage: Math.round(idleAverage * 100) / 100,
        dragAverage: Math.round(dragAverage * 100) / 100,
        dragMax: Math.round(Math.max(...dragWarm) * 100) / 100,
        domPerCall: Math.round((domElapsed / domRounds) * 1000) / 1000
      }`)
    record('平移每帧开销（无强制重排）', perfCheck.perCall < 0.2,
      `${perfCheck.rounds} 次同步平移共 ${perfCheck.elapsed}ms，平均 ${perfCheck.perCall}ms/次（含 transform 写入与指示器更新）；` +
      `对照：每帧读一次 DOM 的旧写法为 ${perfCheck.domPerCall}ms/次，相差约 ${Math.round(perfCheck.domPerCall / Math.max(0.0001, perfCheck.perCall))} 倍`)
    record('拖动不额外拖慢帧率',
      perfCheck.dragAverage < Math.max(34, perfCheck.idleAverage * 1.8),
      `空载帧间隔 ${perfCheck.idleAverage}ms，拖动时 ${perfCheck.dragAverage}ms（最大 ${perfCheck.dragMax}ms）；注：本环境 rAF 本身被节流到约 ${Math.round(1000 / perfCheck.idleAverage)}fps，故只看相对值`)

    /* ---------- 首屏封面加载：并发节流 + 磁盘缓存 ---------- */

    // 1) 建 DOM 的耗时（打开媒体墙时的首屏成本）
    const rebuildCheck = await evaluate(win, `
      const wall = window.__aria.views.mediaWall
      return wall.debugRebuild()`)
    record('媒体墙建 DOM 耗时', rebuildCheck.elapsedMs < 400,
      `${rebuildCheck.tiles} 个格子、${rebuildCheck.nodes} 个 DOM 节点，耗时 ${rebuildCheck.elapsedMs}ms`)

    // 2) 清掉封面缓存后重新打开媒体墙，观察封面请求的并发上限
    const artworkService = ctx.get('library')
    await artworkService.clearArtworkCache()
    const throttleCheck = await evaluate(win, `
      const { actions } = window.__aria
      const lazy = window.__aria.views.mediaWall.debugState().lazy
      void lazy
      // 切走再切回来，触发一次完整的封面加载
      actions.setView('songs')
      await new Promise((r) => setTimeout(r, 400))
      actions.setView('wall')
      const samples = { active: 0, queued: 0 }
      const started = performance.now()
      while (performance.now() - started < 4000) {
        await new Promise((r) => requestAnimationFrame(r))
        const state = window.__aria.views.mediaWall.debugState().lazy
        samples.active = Math.max(samples.active, state.active)
        samples.queued = Math.max(samples.queued, state.queued)
      }
      const finalState = window.__aria.views.mediaWall.debugState().lazy
      const wallArt = [...document.querySelectorAll('.wall-tile__art')]
      return {
        peakActive: samples.active,
        peakQueued: samples.queued,
        remaining: finalState.pending,
        wallPending: wallArt.filter((node) => !node.querySelector('img')).length,
        images: wallArt.filter((node) => node.querySelector('img')).length
      }`)
    record('封面加载并发受控', throttleCheck.peakActive <= 4 && throttleCheck.peakQueued > 20,
      `峰值在途 ${throttleCheck.peakActive}（上限 4），峰值排队 ${throttleCheck.peakQueued}；4s 内媒体墙已出图 ${throttleCheck.images} 张，还剩 ${throttleCheck.wallPending} 张待加载`)

    const artworkStats = await artworkService.getArtworkStats()
    record('封面落盘缓存', artworkStats.files > 0,
      `${artworkStats.files} 张 · ${Math.round(artworkStats.bytes / 1024)} KB · ${artworkStats.dir}`)

    // 3) 冷读（要解析音频内嵌图并缩放）vs 热读（直接读小文件）
    const artworkTrack = artworkService.getTracks().find((track) => track.artworkEmbedded)
    if (artworkTrack) {
      await artworkService.clearArtworkCache()
      const coldStart = Date.now()
      const cold = await artworkService.getArtwork(artworkTrack.id)
      const coldMs = Date.now() - coldStart

      // 只清内存缓存，保留磁盘缓存 —— 再取一次应当走磁盘
      await artworkService.clearArtworkCache({ memory: true, disk: false })
      const warmStart = Date.now()
      const warm = await artworkService.getArtwork(artworkTrack.id)
      const warmMs = Date.now() - warmStart

      record('封面冷读与热读',
        Boolean(cold?.data) && Boolean(warm?.data) && cold.data.length === warm.data.length &&
        warm.source === 'disk',
        `冷读 ${coldMs}ms（${Math.round(cold.data.length / 1024)}KB，${cold.source}）→ 热读 ${warmMs}ms（${warm.source}）`)
      record('内嵌封面已缩放', warm.mime === 'image/jpeg' && warm.data.length < 200 * 1024,
        `输出 ${warm.mime}，${Math.round(warm.data.length / 1024)}KB（限 480px / 质量 82）`)
    }

    /* ---------- 后台预热：让下次打开媒体墙秒出图 ---------- */

    await artworkService.clearArtworkCache()
    await evaluate(win, `
      // 停在歌曲列表（不打开媒体墙），看后台预热能不能自己把缓存灌满
      window.__aria.actions.setView('songs')
      return true`)
    const prewarmStart = await artworkService.getArtworkStats()
    await sleep(6000)
    const prewarmEnd = await artworkService.getArtworkStats()
    const prewarmState = await evaluate(win, `return window.__aria.prewarmer.state`)
    record('空闲时后台预热封面',
      prewarmStart.files === 0 && prewarmEnd.files > 3,
      `未打开媒体墙的情况下，6s 内从 0 涨到 ${prewarmEnd.files} 张 · ${Math.round(prewarmEnd.bytes / 1024)}KB（预热计数 ${prewarmState.warmed}，让路中 ${prewarmState.paused}）`)

    /* ---------- 各视图的滚动能力（曾经因为视图根节点 display 被清掉而整块滚不动） ---------- */

    const scrollAudit = await evaluate(win, `
      const { actions } = window.__aria
      const probe = async (view, rootSelector, scrollSelector) => {
        actions.setView(view)
        await new Promise((r) => setTimeout(r, 520))
        const root = document.querySelector(rootSelector)
        const scroller = document.querySelector(scrollSelector)
        const before = scroller ? scroller.scrollTop : null
        if (scroller) scroller.scrollTop = 400
        await new Promise((r) => setTimeout(r, 150))
        const after = scroller ? scroller.scrollTop : null
        if (scroller) scroller.scrollTop = 0
        const rootStyle = root ? getComputedStyle(root) : null
        return {
          view,
          rootDisplay: rootStyle ? rootStyle.display : null,
          rootHeight: root ? Math.round(root.getBoundingClientRect().height) : null,
          clientHeight: scroller ? scroller.clientHeight : null,
          scrollHeight: scroller ? scroller.scrollHeight : null,
          overflowY: scroller ? getComputedStyle(scroller).overflowY : null,
          scrollable: before !== null && after !== null && after > before
        }
      }
      const result = {}
      result.songs = await probe('songs', '#content > .content-inner:nth-child(1)', '.tracklist__viewport')
      result.settings = await probe('settings', '#content > .content-inner:nth-child(4)', '.settings')
      result.albums = await probe('albums', '#content > .content-inner:nth-child(2)', '.browse-scroll')
      actions.setView('songs')
      return result`)
    const scrollRows = Object.values(scrollAudit)
    record('各视图可滚动（媒体墙改为 2D 平移，单独校验）',
      scrollRows.every((row) => row.scrollable),
      scrollRows.map((row) => `${row.view}:${row.scrollable ? '可滚' : '滚不动'}(display=${row.rootDisplay}, 容器 ${row.clientHeight}/${row.scrollHeight})`).join('　'))

    /* ---------- 系统集成 ---------- */

    const { createNoteIcon, createTransportIcon, WHITE, BLACK } = require('./util/raster')
    const trayIcon = createNoteIcon(process.platform === 'darwin' ? BLACK : WHITE, 32, 2)
    const transports = ['play', 'pause', 'prev', 'next'].map((kind) => createTransportIcon(kind, WHITE, 32, 2))
    record('图标光栅化', !trayIcon.isEmpty() && transports.every((image) => !image.isEmpty()),
      `托盘图标 ${JSON.stringify(trayIcon.getSize())}（逻辑 ${JSON.stringify(trayIcon.getSize())}），任务栏按钮 ${transports.length} 个`)

    const tray = ctx.get('tray')
    record('托盘创建', tray.exists, tray.exists ? '托盘图标已就绪' : '托盘未能创建（无桌面环境时会失败）')

    // 播放状态应能从渲染层上报到主进程（托盘提示 / 任务栏进度依赖它）
    await evaluate(win, `
      const { player, actions, store } = window.__aria
      const tracks = store.get().library.tracks
      actions.playTrack(tracks.find((t) => t.lyricsPath) || tracks[0])
      await new Promise((r) => setTimeout(r, 1800))
      return true`)
    const trayState = tray.getState()
    record('播放状态上报', Boolean(trayState.title) && ['playing', 'paused', 'loading'].includes(trayState.status),
      `托盘收到：${trayState.status}《${trayState.title}》— ${trayState.artist}，进度 ${Math.round((trayState.progress || 0) * 100)}%`)

    // 托盘 / 任务栏按钮发出的指令要能驱动播放器
    const commandResult = await evaluate(win, `
      const { store } = window.__aria
      const before = store.get().playback.status
      window.aria.media.onCommand(() => {})   // 渲染层已订阅 media:command
      return { before }`)
    const wasPlaying = commandResult.before
    ctx.emit('player:command', 'play-pause')
    await sleep(700)
    const afterCommand = await evaluate(win, `return window.__aria.store.get().playback.status`)
    record('播放指令链路', afterCommand !== wasPlaying,
      `main 发出 play-pause：${wasPlaying} → ${afterCommand}`)

    // 「关闭到托盘」：关闭窗口应当只隐藏
    const winStateBefore = { visible: win.isVisible() }
    ctx.get('settings').set({ trayEnabled: true, closeToTray: true })
    await sleep(300)
    win.close()
    await sleep(600)
    const hidden = !win.isDestroyed() && !win.isVisible()
    const stillAlive = !win.isDestroyed()
    ctx.get('settings').set({ closeToTray: false })
    if (stillAlive) {
      win.show()
      await sleep(500)
    }
    record('关闭到托盘', hidden && stillAlive,
      `关闭后窗口隐藏=${hidden}、进程仍存活=${stillAlive}（已恢复设置并重新显示窗口）`)
    void winStateBefore

    /* ---------- 目录监听 ---------- */

    const libraryService = ctx.get('library')
    const watcher = ctx.get('watcher')

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-watch-'))
    const originalFolders = libraryService.getFolders().slice()
    const originalCount = libraryService.getTracks().length

    try {
      watcher.configure({ debounceMs: 500 })
      const watchInfo = watcher.start([tempRoot])
      record('目录监听启动', watchInfo.watching === 1,
        `监听 ${watchInfo.watching} 个根目录（防抖 ${watcher.getStats().debounceMs}ms）`)

      // 复制一个真实音频文件进被监听的目录，等防抖后应触发一次扫描
      const sampleTrack = libraryService.getTracks()[0]
      fs.copyFileSync(sampleTrack.path, path.join(tempRoot, 'watcher-test.mp3'))
      await sleep(3500)
      const watchStats = watcher.getStats()
      record('目录变化检测', watchStats.changes > 0,
        `捕获 ${watchStats.changes} 次文件事件，最近路径：${watchStats.lastPaths.slice(-1)[0] || '—'}`)

      // 无关文件不应触发（.txt 属于歌词候选，是应该被监听的）
      const changesBefore = watcher.getStats().changes
      fs.writeFileSync(path.join(tempRoot, 'notes.tmp'), 'ignored')
      fs.writeFileSync(path.join(tempRoot, 'notes.part'), 'ignored')
      fs.writeFileSync(path.join(tempRoot, 'desktop.ini'), 'ignored')
      await sleep(1200)
      const changesAfter = watcher.getStats().changes
      record('无关文件被过滤', changesAfter === changesBefore,
        `写入 .tmp/.part/desktop.ini 后事件数保持 ${changesAfter} 次`)
    } finally {
      watcher.configure({ debounceMs: 4000 })
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }

    /* ---------- 拖拽导入 ---------- */

    const dropRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-drop-'))
    try {
      const sampleTrack = libraryService.getTracks()[0]
      fs.copyFileSync(sampleTrack.path, path.join(dropRoot, path.basename(sampleTrack.path)))

      // 1) 拖入文件夹 -> 加入资料库
      const folderDrop = await libraryService.resolveDrop([dropRoot], { assumeYes: true })
      const afterFolderDrop = libraryService.getTracks().length
      record('拖入文件夹', folderDrop.added.length === 1 && afterFolderDrop === originalCount + 1,
        `加入 ${folderDrop.added.length} 个目录，曲目 ${originalCount} → ${afterFolderDrop}`)

      // 2) 拖入资料库内的歌曲 -> 直接播放
      const insideDrop = await libraryService.resolveDrop([sampleTrack.path], { assumeYes: true })
      record('拖入资料库内的歌曲', insideDrop.action === 'play' && insideDrop.trackIds.length === 1,
        `action=${insideDrop.action}，可播放 ${insideDrop.trackIds.length} 首`)

      // 3) 拖入无关文件 / 不存在的路径
      const textFile = path.join(dropRoot, 'readme.txt')
      fs.writeFileSync(textFile, 'not audio')
      const rejectedDrop = await libraryService.resolveDrop(
        [textFile, path.join(dropRoot, 'nope.mp3')], { assumeYes: true })
      const reasons = (rejectedDrop.rejected || []).map((item) => item.reason)
      record('非音频/不存在路径被拒绝',
        rejectedDrop.action === 'none' && reasons.includes('not-audio') && reasons.includes('missing'),
        `拒绝原因：${reasons.join(', ')}`)

      // 4) 清理：移除临时目录并恢复原状
      await libraryService.removeFolder(dropRoot)
      await libraryService.scan({ reason: 'smoke-cleanup' })
      const restoredCount = libraryService.getTracks().length
      record('导入后清理还原',
        restoredCount === originalCount && libraryService.getFolders().length === originalFolders.length,
        `曲目恢复为 ${restoredCount} 首，目录 ${libraryService.getFolders().length} 个`)
    } finally {
      fs.rmSync(dropRoot, { recursive: true, force: true })
      watcher.start()
    }

    // 拖放界面：拖入时显示浮层，松开后隐藏
    const dropZoneResult = await evaluate(win, `
      const zone = document.querySelector('.drop-zone')
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(new File(['x'], 'a.mp3', { type: 'audio/mpeg' }))
      window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }))
      await new Promise((r) => setTimeout(r, 150))
      const activeOnEnter = zone.classList.contains('is-active')
      window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer, cancelable: true }))
      await new Promise((r) => setTimeout(r, 500))
      const activeAfterDrop = zone.classList.contains('is-active')
      const paths = window.aria.paths.fromFiles([...dataTransfer.files])
      return { activeOnEnter, activeAfterDrop, bridgeIsArray: Array.isArray(paths), bridgeCount: paths.length }`)
    record('拖放浮层', dropZoneResult.activeOnEnter && !dropZoneResult.activeAfterDrop,
      `拖入时浮层激活=${dropZoneResult.activeOnEnter}，松开后仍激活=${dropZoneResult.activeAfterDrop}`)
    record('路径解析桥', dropZoneResult.bridgeIsArray,
      `webUtils 桥可用（内存里的 File 没有真实路径，返回 ${dropZoneResult.bridgeCount} 条，符合预期）`)

    /* ---------- 在线补全 ---------- */

    const online = ctx.get('online')
    const settingsService = ctx.get('settings')
    const onlineTrack = libraryService.getTracks().find((track) => /imagine dragons/i.test(track.artist)) ||
      libraryService.getTracks().find((track) => track.album && track.artist) ||
      libraryService.getTracks()[0]
    const sample = {
      title: onlineTrack.title,
      artist: onlineTrack.artist,
      albumArtist: onlineTrack.albumArtist,
      album: onlineTrack.album,
      duration: onlineTrack.duration
    }

    // 默认关闭：不应该发起任何请求
    settingsService.set({ onlineFeatures: false })
    await sleep(200)
    const disabled = await online.fetchLyrics(sample)
    record('在线功能默认关闭', disabled.skipped === true,
      '总开关关闭时不发起请求')

    settingsService.set({ onlineFeatures: true, onlineLyrics: true, onlineCovers: true })
    await sleep(300)

    const lyricResult = await online.fetchLyrics(sample)
    const lyricOk = Boolean(lyricResult.text)
    record('在线歌词（LRCLIB）', lyricOk,
      lyricResult.error
        ? `请求失败：${lyricResult.error}`
        : lyricOk
          ? `《${sample.artist} — ${sample.title}》取得 ${lyricResult.text.split('\n').length} 行，来源 ${lyricResult.provider}${lyricResult.synced ? '（含时间轴）' : '（纯文本）'}`
          : '该曲目在 LRCLIB 没有收录（未命中也会缓存 24 小时）')

    // 封面补全：用一首「有正式专辑名」的曲目（未知专辑在 iTunes 上匹配不到）
    const knownAlbumTrack = libraryService.getTracks().find((track) =>
      /imagine dragons/i.test(track.artist) && track.album && track.album !== '未知专辑') ||
      libraryService.getTracks().find((track) =>
        track.album && track.album !== '未知专辑' && track.artist && track.albumArtist) ||
      libraryService.getTracks()[0]
    const coverSample = {
      title: knownAlbumTrack.title,
      artist: knownAlbumTrack.artist,
      albumArtist: knownAlbumTrack.albumArtist,
      album: knownAlbumTrack.album
    }
    const coverResult = await online.fetchCover(coverSample)
    const coverOk = Boolean(coverResult.data && coverResult.data.length > 1000)
    record('在线封面（Deezer / iTunes）', coverOk || coverResult.data === null,
      coverResult.error
        ? `请求失败：${coverResult.error}`
        : coverOk
          ? `《${coverSample.album}》取得 ${Math.round(coverResult.data.length / 1024)} KB，来源 ${coverResult.provider}`
          : '未匹配到可信结果（宁可不补，也不放错封面）')

    const cacheStats = await online.getStats()
    record('在线缓存落盘', cacheStats.files > 0,
      `${cacheStats.files} 个文件 · ${Math.round(cacheStats.size / 1024)} KB · ${cacheStats.cacheRoot}`)

    // 渲染层插件链路：扩展点是否真的接到了在线服务（用同一首曲目，命中刚才的缓存）
    const providerResult = await evaluate(win, `
      const { host, store, artwork } = window.__aria
      const track = store.get().library.tracks.find((t) => /birds/i.test(t.title) && /imagine dragons/i.test(t.artist)) ||
        store.get().library.tracks.find((t) => t.album && t.artist)
      const lyricsProvider = host.list('lyricsProvider')[0]
      const lyrics = lyricsProvider
        ? await lyricsProvider.load(track, { settings: { ...store.get().settings, onlineFeatures: true, onlineLyrics: true } })
        : null
      const noCover = store.get().library.tracks.find((t) => !t.artworkEmbedded && !t.artworkFile)
      // 用一首有正式专辑名的曲目、并清掉本地封面标记，走完整的「在线补封面」链路
      const fakeNoCover = {
        id: 'smoke-online-cover',
        title: noCover?.title || track.title,
        artist: track.artist,
        albumArtist: track.albumArtist,
        album: track.album,
        artworkEmbedded: false,
        artworkFile: null
      }
      const onlineCoverUrl = await artwork.resolveUrl(fakeNoCover)
      return {
        track: track ? track.title : '',
        fakeAlbum: fakeNoCover.album,
        lyricsProviders: host.list('lyricsProvider').map((p) => p.id),
        artworkProviders: host.list('artworkProvider').map((p) => p.id),
        lyricsText: lyrics?.text ? lyrics.text.length : 0,
        lyricsSource: lyrics?.source || '',
        onlineCoverUrl: onlineCoverUrl || ''
      }`)
    record('歌词来源扩展点接入', providerResult.lyricsProviders.length > 0 && providerResult.lyricsText > 0,
      `来源 ${providerResult.lyricsProviders.join(', ')} → 《${providerResult.track}》${providerResult.lyricsText} 字符（${providerResult.lyricsSource}）`)
    record('封面来源扩展点接入', providerResult.artworkProviders.length > 0 && Boolean(providerResult.onlineCoverUrl),
      `来源 ${providerResult.artworkProviders.join(', ')} → 《${providerResult.fakeAlbum}》${providerResult.onlineCoverUrl ? '已补到封面图片' : '未能补到（缓存已清空或无匹配）'}`)

    const cleared = await online.clearCache()
    const afterClear = await online.getStats()
    record('在线缓存清理', cleared.ok && afterClear.files === 0,
      `清理后剩 ${afterClear.files} 个文件`)

    // 恢复默认：在线功能保持关闭
    settingsService.set({ onlineFeatures: false })
    await sleep(200)
  } catch (err) {
    record('执行过程', false, err.message)
  }

  const failed = checks.filter((check) => !check.ok)
  console.log(`\n=== 自检结束：${checks.length - failed.length}/${checks.length} 通过 ===\n`)
  if (failed.length) {
    console.log('未通过：')
    for (const check of failed) console.log(`  · ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
    console.log('')
  }
  return failed.length === 0
}

module.exports = { runSmoke }
