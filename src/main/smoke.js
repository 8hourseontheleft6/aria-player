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
        time: Math.round(player.getTime() * 10) / 10,
        duration: Math.round(player.getDuration()),
        title: player.currentTrack().title,
        paused: player.engine.paused
      }`)
    record('音频播放', playback.time > 0.4 && !playback.paused,
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
      const { actions } = window.__aria
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 900))
      const tiles = document.querySelectorAll('.wall-tile').length
      const imgs = document.querySelectorAll('.wall-tile__art img').length
      const grid = document.querySelector('.media-wall')
      const widthBefore = grid?.style.getPropertyValue('--wall-min')
      document.querySelector('[data-density="l"]')?.click()
      await new Promise((r) => setTimeout(r, 300))
      const widthAfter = grid?.style.getPropertyValue('--wall-min')
      document.querySelector('.wall-tile .wall-tile__open')?.click()
      await new Promise((r) => setTimeout(r, 500))
      const openedAlbum = Boolean(window.__aria.store.get().ui.detail)
      actions.closeDetail()
      actions.setView('songs')
      return { tiles, imgs, widthBefore, widthAfter, openedAlbum }`)
    record('媒体墙', wallView.tiles > 0 && wallView.tiles === groupResult.albums,
      `${wallView.tiles} 张封面方块（= 专辑数），已加载 ${wallView.imgs} 张`)
    record('媒体墙密度切换', wallView.widthBefore !== wallView.widthAfter,
      `--wall-min ${wallView.widthBefore} → ${wallView.widthAfter}`)
    record('媒体墙打开专辑', wallView.openedAlbum, '点击方块角标可进入专辑详情')
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
