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
const fsp = require('node:fs/promises')
const os = require('node:os')

const { decodeTextBuffer } = require('./util/text')

const POLL_INTERVAL = 250

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function evaluate (win, expression) {
  const result = win.webContents.executeJavaScript(`(async () => { ${expression} })()`, true)
  // executeJavaScript 在页面卡死时可能永不 settle，加一层超时保护。
  // 注意给足余量：自检里有些步骤本身就要等好几秒（惯性、防抖、动画收敛），
  // 而这个环境的 rAF 被节流到 ~7fps，15s 很容易被正常等待撞到。
  return Promise.race([
    result,
    sleep(90000).then(() => {
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

    /*
     * 等资料库既有内容、又完成加载。
     * 只等 loaded 是不够的：全新的用户数据目录（自动化模式用的是独立的）第一次启动时
     * 会先亮出「已加载」再跑全量扫描，此时 tracks 还是空的，
     * 后面的检查会全部拿着空资料库去测（表现为「0 首 / 带封面 0 首」）。
     */
    await waitFor(win,
      'window.__aria.store.get().library.loaded === true && window.__aria.store.get().library.tracks.length > 0',
      { label: '资料库加载', timeout: 180000 })

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

    /* ---------- 搜索：两档范围 + 搜索历史 ----------
     *
     * 先在主进程侧准备一个「只可能出现在歌词里」的关键词：
     * 从某个 .lrc 里取词，再确认它不出现在任何曲目的歌名/艺人/专辑里。
     * 这样「基础档搜不到、深度档搜得到」就是一条真正有区分度的断言。
     */
    const normalizeSearch = (value) => String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()

    const allTracks = ctx.get('library').getTracks()
    const basicHaystack = allTracks
      .map((track) => normalizeSearch(`${track.title} ${track.artist} ${track.album} ${track.albumArtist}`))
    const withLyrics = allTracks.filter((track) => track.lyricsPath)
    let lyricsKeyword = ''
    let lyricsSampleTitle = ''
    for (const track of withLyrics.slice(0, 40)) {
      let text = ''
      try {
        const raw = await fsp.readFile(track.lyricsPath)
        text = decodeTextBuffer(raw).text
      } catch {
        continue
      }
      const words = [...new Set(text.split(/[^0-9A-Za-z\u4e00-\u9fa5]+/))]
        .map((word) => word.trim())
        .filter((word) => word.length >= 4)
      const found = words.find((word) => {
        const normalized = normalizeSearch(word)
        return normalized.length >= 4 && !basicHaystack.some((haystack) => haystack.includes(normalized))
      })
      if (found) {
        lyricsKeyword = found
        lyricsSampleTitle = track.title
        break
      }
    }
    const artistSample = allTracks.find((track) => track.artist && track.artist.length >= 4)
    const genreSample = allTracks.find((track) => track.genre)

    const searchCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const keyword = ${JSON.stringify(lyricsKeyword)}
      const artist = ${JSON.stringify(artistSample ? artistSample.artist : '')}
      const artistTitle = ${JSON.stringify(artistSample ? artistSample.title : '')}
      const genre = ${JSON.stringify(genreSample ? genreSample.genre : '')}
      const sampleTitle = ${JSON.stringify(lyricsSampleTitle)}
      const rowTitles = () => [...document.querySelectorAll('.track-row')]
        .map((row) => row.textContent || '')
      const settle = async (ms = 420) => { await new Promise((r) => setTimeout(r, ms)) }

      actions.setView('songs')
      actions.setQuery('')
      await settle(200)

      // ① 基础档：按艺人搜
      actions.setSearchScope('basic')
      actions.setQuery(artist)
      await settle()
      const basicArtistRows = rowTitles()

      // ② 基础档：搜只出现在歌词里的词 —— 应当搜不到
      actions.setQuery(keyword)
      await settle()
      const basicLyricsRows = rowTitles()

      // ③ 深度档：同一个词 —— 应当能搜到那首歌
      actions.setSearchScope('deep')
      actions.setQuery(keyword)
      await settle(120)
      const scanning = store.get().ui.searchLyrics
      await actions.searchLyricsNow(keyword)
      await settle(300)
      const deepLyricsRows = rowTitles()
      const lyricsState = store.get().ui.searchLyrics

      // ④ 深度档：按流派搜（扩展字段）
      actions.setQuery(genre)
      await actions.searchLyricsNow(genre)
      await settle(300)
      const deepGenreRows = rowTitles()

      // ⑤ 搜索历史：提交、去重、移除、清空
      //    每一步都 await：设置写入是 IPC + 广播回声，不等的话后一步会读到旧值
      await actions.clearSearchHistory()
      actions.setQuery(artist)
      await actions.commitSearch(artist)
      await actions.commitSearch(artist)
      actions.setQuery(keyword)
      await actions.commitSearch(keyword)
      await settle(120)
      const historyAfterCommit = [...(store.get().settings.searchHistory || [])]
      await actions.removeSearchHistory(keyword)
      await settle(120)
      const historyAfterRemove = [...(store.get().settings.searchHistory || [])]
      await actions.clearSearchHistory()
      await settle(120)
      const historyAfterClear = [...(store.get().settings.searchHistory || [])]

      // 收尾：回到干净状态
      actions.setSearchScope('basic')
      actions.setQuery('')
      await settle(120)

      return {
        keyword, artist, artistTitle, genre, sampleTitle, scanning: Boolean(scanning),
        basicArtistRows, basicLyricsRows, deepLyricsRows, deepGenreRows,
        lyricsState, historyAfterCommit, historyAfterRemove, historyAfterClear
      }`)

    const search = searchCheck
    record('搜索：基础档匹配歌名/专辑/艺人',
      search.basicArtistRows.length > 0 &&
      search.basicArtistRows.some((text) => text.includes(search.artistTitle.slice(0, 6))),
      `按艺人「${search.artist}」搜到 ${search.basicArtistRows.length} 行，其中包含《${search.artistTitle}》`)
    record('搜索：基础档不搜歌词',
      search.keyword ? search.basicLyricsRows.length === 0 : true,
      search.keyword
        ? `「${search.keyword}」只出现在歌词里，基础档渲染 ${search.basicLyricsRows.length} 行（应为 0）`
        : '资料库里没有可用的歌词样本，跳过')
    record('搜索：深度档能搜到歌词里的词',
      Boolean(search.keyword) && search.deepLyricsRows.length > 0 &&
      search.deepLyricsRows.some((text) => text.includes(search.sampleTitle.slice(0, 6))),
      search.keyword
        ? `「${search.keyword}」深度档渲染 ${search.deepLyricsRows.length} 行（含《${search.sampleTitle}》）；` +
          `主进程扫描 ${search.lyricsState?.scanned ?? '—'} 份歌词、命中 ${search.lyricsState?.matched ?? '—'} 首、耗时 ${search.lyricsState?.elapsedMs ?? '—'}ms`
        : '资料库里没有可用的歌词样本，跳过')
    record('搜索：深度档能搜扩展字段（流派/年份/文件名等）',
      !search.genre || search.deepGenreRows.length > 0,
      search.genre
        ? `按流派「${search.genre}」搜到 ${search.deepGenreRows.length} 行`
        : '资料库里没有填了流派的曲目，跳过')
    record('搜索历史：记录 / 去重 / 移除 / 清空',
      search.historyAfterCommit.length === 2 &&
      search.historyAfterCommit[0] === search.keyword &&
      search.historyAfterCommit[1] === search.artist &&
      search.historyAfterRemove.length === 1 &&
      search.historyAfterRemove[0] === search.artist &&
      search.historyAfterClear.length === 0,
      `提交两次（同一词重复提交只留一条）→ ${JSON.stringify(search.historyAfterCommit)}；` +
      `移除一条 → ${JSON.stringify(search.historyAfterRemove)}；清空 → ${JSON.stringify(search.historyAfterClear)}`)

    /* ---------- 搜索框：图标式展开 + 范围切换 + 历史列表 ---------- */
    const searchPanelCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 240) => { await new Promise((r) => setTimeout(r, ms)) }
      actions.setView('songs')
      await actions.clearSearchHistory()
      await actions.commitSearch('love')
      await actions.commitSearch('Blues')
      actions.setSearchScope('basic')
      await settle(280)

      const slot = document.querySelector('.search-slot')
      const toggle = slot.querySelector('.btn')
      const input = document.querySelector('.search input')
      const panel = document.querySelector('.search-panel')
      const scopeButton = document.querySelector('.search__scope')
      const fieldWidth = () => Math.round(document.querySelector('.search').getBoundingClientRect().width)

      // ① 默认收起：只留一颗放大镜
      const collapsed = { open: slot.classList.contains('is-open'), width: fieldWidth() }

      toggle.click()
      await settle(420)
      input.focus()
      await settle()
      const opened = {
        open: slot.classList.contains('is-open'),
        width: fieldWidth(),
        hidden: panel.hidden,
        scopes: [...panel.querySelectorAll('.search-panel__scope')].map((node) => node.textContent),
        selected: panel.querySelector('.search-panel__scope.is-selected')?.textContent || '',
        history: [...panel.querySelectorAll('.search-panel__term')].map((node) => node.textContent),
        hint: panel.querySelector('.search-panel__hint')?.textContent || ''
      }

      panel.querySelector('[data-scope="deep"]').click()
      await settle(340)
      const afterScope = {
        scope: store.get().settings.searchScope,
        label: scopeButton.querySelector('span')?.textContent || '',
        isDeep: scopeButton.classList.contains('is-deep'),
        selected: panel.querySelector('.search-panel__scope.is-selected')?.textContent || '',
        hint: panel.querySelector('.search-panel__hint')?.textContent || '',
        placeholder: input.placeholder
      }

      panel.querySelector('.search-panel__term').click()
      await settle()
      const afterPick = { query: store.get().ui.query, value: input.value }

      input.focus()
      await settle(150)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await settle()
      const afterEscape = { hidden: panel.hidden }

      // ② 收起时连关键词一起清掉，免得「看不见却还在过滤」
      const queryBeforeClose = store.get().ui.query
      toggle.click()
      await settle(420)
      const afterCollapse = {
        open: slot.classList.contains('is-open'),
        width: fieldWidth(),
        query: store.get().ui.query
      }

      actions.setSearchScope('basic')
      actions.setQuery('')
      await actions.clearSearchHistory()
      await settle(150)
      return { collapsed, opened, afterScope, afterPick, afterEscape, queryBeforeClose, afterCollapse }
    `)
    record('搜索框：默认收起成图标，点开才展开',
      searchPanelCheck.collapsed.open === false &&
      searchPanelCheck.collapsed.width < 20 &&
      searchPanelCheck.opened.open === true &&
      searchPanelCheck.opened.width > 200 &&
      searchPanelCheck.queryBeforeClose !== '' &&
      searchPanelCheck.afterCollapse.open === false &&
      searchPanelCheck.afterCollapse.query === '',
      `收起时输入框宽 ${searchPanelCheck.collapsed.width}px（只留一颗放大镜）→ 点开后 ${searchPanelCheck.opened.width}px；` +
      `收起前关键词「${searchPanelCheck.queryBeforeClose}」→ 收起后已清空，宽度回到 ${searchPanelCheck.afterCollapse.width}px`)
    record('搜索面板：范围切换与历史列表',
      searchPanelCheck.opened.hidden === false &&
      searchPanelCheck.opened.scopes.length === 2 &&
      searchPanelCheck.opened.history.length === 2 &&
      searchPanelCheck.afterScope.scope === 'deep' &&
      searchPanelCheck.afterScope.selected === '含歌词等' &&
      searchPanelCheck.afterPick.query === 'Blues' &&
      searchPanelCheck.afterEscape.hidden === true,
      `展开后面板可见（范围 ${JSON.stringify(searchPanelCheck.opened.scopes)}，历史 ${JSON.stringify(searchPanelCheck.opened.history)}）；` +
      `切到深度档后按钮显示「${searchPanelCheck.afterScope.label}」、提示「${searchPanelCheck.afterScope.hint}」、占位「${searchPanelCheck.afterScope.placeholder}」；` +
      `点历史回填「${searchPanelCheck.afterPick.query}」；Esc 收起=${searchPanelCheck.afterEscape.hidden}`)

    /* ---------- 「看得见、点得到」：程序化 click 抓不到的那类问题 ----------
     *
     * 回归现场一：搜索面板挂在 .search 里，而 .search 带着 overflow:hidden
     * （收起动画需要），展开后没解除 —— 面板被整个裁掉，
     * 用户看到的就是「只能搜歌曲信息，切不了范围」。element.click() 照样能触发，
     * 所以旧断言全绿。
     * 回归现场二：队列面板 z-index 低于全屏播放页，在全屏里点队列「按了没用」。
     *
     * 这两条都用命中测试 + 真实鼠标事件序列来盯。
     */
    const hitRealityCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 320) => { await new Promise((r) => setTimeout(r, ms)) }
      const hitAt = (node) => {
        const rect = node.getBoundingClientRect()
        const x = Math.round(rect.left + rect.width / 2)
        const y = Math.round(rect.top + rect.height / 2)
        const found = document.elementFromPoint(x, y)
        return {
          x, y,
          inside: Boolean(found),
          className: found ? (found.className || found.tagName).toString().slice(0, 40) : '',
          isScope: Boolean(found && found.closest && found.closest('.search-panel__scope')),
          isPanel: Boolean(found && found.closest && found.closest('.search-panel')),
          isQueue: Boolean(found && found.closest && found.closest('.queue-panel'))
        }
      }
      // 真实鼠标序列（mousedown → mouseup → click），不是 element.click()
      const realClick = (node) => {
        const rect = node.getBoundingClientRect()
        const x = Math.round(rect.left + rect.width / 2)
        const y = Math.round(rect.top + rect.height / 2)
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          node.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type.includes('down') ? 1 : 0
          }))
        }
      }

      actions.setView('songs')
      actions.setSearchScope('basic')
      await settle(260)
      const slot = document.querySelector('.search-slot')
      if (!slot.classList.contains('is-open')) slot.querySelector('.btn').click()
      await settle(460)
      const deepButton = document.querySelector('.search-panel [data-scope="deep"]')
      const deepHit = deepButton ? hitAt(deepButton) : null
      if (deepButton) realClick(deepButton)
      await settle(420)
      const scopeAfterRealClick = store.get().settings.searchScope

      // 全屏播放页里的队列：按钮要有用，而且面板必须在最上层
      const restoreScope = 'basic'
      actions.openNowPlaying()
      await settle(600)
      actions.toggleQueue(true)
      await settle(600)
      const queuePanel = document.querySelector('.queue-panel')
      const queueHit = queuePanel ? hitAt(queuePanel) : null
      const nowPlayingPanel = document.querySelector('.now-playing')
      const queueRect = queuePanel ? queuePanel.getBoundingClientRect() : null
      const diag = {
        queueRect: queueRect ? [Math.round(queueRect.width), Math.round(queueRect.height), Math.round(queueRect.left), Math.round(queueRect.top)] : null,
        queueHidden: queuePanel ? queuePanel.hidden : null,
        queueZ: queuePanel ? getComputedStyle(queuePanel).zIndex : null,
        queuePosition: queuePanel ? getComputedStyle(queuePanel).position : null,
        nowPlayingZ: nowPlayingPanel ? getComputedStyle(nowPlayingPanel).zIndex : null,
        nowPlayingRect: nowPlayingPanel
          ? [Math.round(nowPlayingPanel.getBoundingClientRect().width), Math.round(nowPlayingPanel.getBoundingClientRect().height)]
          : null,
        // 队列中心点上，从最上面数的前几个元素
        stack: queuePanel
          ? document.elementsFromPoint(
            Math.round(queuePanel.getBoundingClientRect().left + 40),
            Math.round(queuePanel.getBoundingClientRect().top + 60)
          ).slice(0, 4).map((node) => (node.className || node.tagName).toString().slice(0, 28))
          : [],
        ancestors: queuePanel
          ? (() => {
            const out = []
            let node = queuePanel.parentElement
            while (node && out.length < 5) {
              const style = getComputedStyle(node)
              // 注意：这段是注入代码，里面不能再出现反引号（会截断外层模板字符串）
              out.push((node.className || node.tagName).toString().slice(0, 18) +
                '[z=' + style.zIndex + ',' + style.position + ',' + (style.transform === 'none' ? '-' : 'tf') + ']')
              node = node.parentElement
            }
            return out
          })()
          : []
      }
      const nowPlayingOpen = store.get().ui.nowPlayingOpen
      const queueOpen = store.get().ui.queueOpen
      actions.toggleQueue(false)
      actions.closeNowPlaying()
      actions.setSearchScope(restoreScope)
      actions.setQuery('')
      await settle(300)
      return {
        deepHit, scopeAfterRealClick, queueHit, nowPlayingOpen, queueOpen, diag,
        view: store.get().ui.view
      }
    `)
    record('搜索面板真的看得见、点得到',
      hitRealityCheck.deepHit &&
      hitRealityCheck.deepHit.isScope === true &&
      hitRealityCheck.scopeAfterRealClick === 'deep',
      `在「含歌词等」按钮中心 (${hitRealityCheck.deepHit?.x},${hitRealityCheck.deepHit?.y}) 做命中测试：` +
      `命中到的是 ${hitRealityCheck.deepHit?.className || '空'}（属于范围按钮=${hitRealityCheck.deepHit?.isScope}）；` +
      `真实鼠标序列点击后范围=${hitRealityCheck.scopeAfterRealClick}`)
    record('全屏播放页里队列按钮有用且在顶层',
      hitRealityCheck.nowPlayingOpen === true &&
      hitRealityCheck.queueOpen === true &&
      hitRealityCheck.queueHit &&
      hitRealityCheck.queueHit.isQueue === true,
      `打开正在播放全屏页后再开队列（nowPlayingOpen=${hitRealityCheck.nowPlayingOpen}、queueOpen=${hitRealityCheck.queueOpen}）：` +
      `队列面板 ${hitRealityCheck.diag?.queueRect?.join('×')} hidden=${hitRealityCheck.diag?.queueHidden} ` +
      `z=${hitRealityCheck.diag?.queueZ}/${hitRealityCheck.diag?.queuePosition}，播放页 z=${hitRealityCheck.diag?.nowPlayingZ}；` +
      `中心点的层序 ${JSON.stringify(hitRealityCheck.diag?.stack)}；队列的祖先 ${JSON.stringify(hitRealityCheck.diag?.ancestors)}`)

    const matchDetailCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 340) => { await new Promise((r) => setTimeout(r, ms)) }
      actions.setView('songs')
      const tracks = store.get().library.tracks
      const rows = () => [...document.querySelectorAll('.track-row')].map((row) => {
        const match = row.querySelector('.track-row__match')
        const title = row.querySelector('.track-row__title')
        return {
          titleText: title ? title.textContent : '',
          titleHl: title ? title.querySelectorAll('.hl').length : 0,
          matchLabel: match?.querySelector('.track-row__match-label')?.textContent || '',
          matchText: match ? match.textContent : '',
          matchHl: match ? match.querySelectorAll('.hl').length : 0,
          hasMatch: Boolean(match && match.childNodes.length)
        }
      })

      // ① 歌名命中：标题里应当出现高亮片段
      //    挑一个含 ASCII 词的标题，高亮匹配更稳（日文假名会走 NFD 分解那条路）
      const titleSample = tracks.find((track) => /[A-Za-z]{5,}/.test(track.title)) || tracks[0]
      const titleKeyword = (titleSample.title.match(/[A-Za-z]{5,}/) || [])[0] || titleSample.title.slice(0, 4)
      actions.setSearchScope('basic')
      actions.setQuery(titleKeyword)
      await settle()
      const titleRows = rows()

      // ② 歌词命中：用主进程给回来的命中行里取词，保证确实是歌词命中
      const probe = await actions.searchLyricsNow('the')
      const detail = (probe?.matches || []).find((item) => item.line && /[A-Za-z]{4,}/.test(item.line))
      let lyricRows = []
      let lyricDebug = null
      if (detail) {
        const word = (detail.line.match(/[A-Za-z]{4,}/) || [])[0]
        actions.setSearchScope('deep')
        await actions.searchLyricsNow(word)
        actions.setQuery(word)
        await settle(460)
        const info = store.get().ui.searchLyrics
        lyricRows = rows()
        lyricDebug = { word, matches: (info?.matches || []).length, line: detail.line.slice(0, 50) }
      } else {
        lyricDebug = { word: '', matches: (probe?.matches || []).length, line: '', reason: '主进程没有回传命中行' }
      }

      // ③ 没有搜索时不该有任何匹配详情
      actions.setQuery('')
      await settle(320)
      const noSearch = rows()

      actions.setSearchScope('basic')
      return {
        titleKeyword,
        titleWithHl: titleRows.filter((row) => row.titleHl > 0).length,
        titleTotal: titleRows.length,
        lyricMatched: lyricRows.filter((row) => row.matchLabel === '歌词匹配').length,
        lyricHl: lyricRows.reduce((sum, row) => sum + row.matchHl, 0),
        lyricSample: (lyricRows.find((row) => row.matchLabel === '歌词匹配') || {}).matchText || '',
        lyricDebug,
        noSearchMatchRows: noSearch.filter((row) => row.hasMatch).length
      }
    `)
    record('歌名命中时标题会带上高亮片段',
      matchDetailCheck.titleWithHl > 0,
      `按歌名片段「${matchDetailCheck.titleKeyword}」搜索：${matchDetailCheck.titleTotal} 行里 ${matchDetailCheck.titleWithHl} 行的标题带命中片段` +
      `（.hl 只在悬停时上色，不悬停保持原样）`)
    record('歌词命中时悬停显示命中的那一句',
      matchDetailCheck.lyricMatched > 0 && matchDetailCheck.lyricHl > 0,
      matchDetailCheck.lyricDebug
        ? `关键词「${matchDetailCheck.lyricDebug.word}」（取自歌词行「${matchDetailCheck.lyricDebug.line}…」，该词命中 ${matchDetailCheck.lyricDebug.matches} 首）：` +
          `${matchDetailCheck.lyricMatched} 行标为「歌词匹配」、共 ${matchDetailCheck.lyricHl} 处高亮；示例「${matchDetailCheck.lyricSample.slice(0, 56)}」`
        : '没有可用的歌词命中样本，跳过')
    record('没有搜索时不显示匹配详情',
      matchDetailCheck.noSearchMatchRows === 0,
      `清空关键词后仍有 ${matchDetailCheck.noSearchMatchRows} 行带着匹配详情（应为 0，未搜索时保持原来的样子）`)

    /* ---------- 歌词命中 → 点开歌曲自动跳到那一句（可开关） ---------- */
    const jumpCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const player = window.__aria.player
      const settle = async (ms = 300) => { await new Promise((r) => setTimeout(r, ms)) }
      const byId = store.get().library.byId
      const waitFor = async (predicate, timeout = 14000) => {
        const deadline = performance.now() + timeout
        while (performance.now() < deadline) {
          if (predicate()) return true
          await settle(250)
        }
        return false
      }

      // 找一个「命中行有明显时间轴」的词，这样跳没跳一眼可辨
      const probe = await actions.searchLyricsNow('the')
      const hits = (probe?.matches || []).filter((item) => item.line && item.time > 25)
      if (hits.length < 1) {
        return { skipped: true, reason: '没有时间轴足够靠后的歌词命中样本' }
      }
      const first = hits[0]
      const wordA = (first.line.match(/[A-Za-z]{4,}/) || [])[0]

      // 打开开关：点开应当跳到那一句
      await actions.setSetting({ jumpToMatchedLyric: true })
      actions.setSearchScope('deep')
      await actions.searchLyricsNow(wordA)
      actions.setQuery(wordA)
      await settle(420)
      const stateA = store.get().ui.searchLyrics
      const hitA = (stateA?.matches || []).find((item) => item.id === first.id) ||
        (stateA?.matches || [])[0]
      const trackA = hitA ? byId.get(hitA.id) : null
      let onResult = null
      if (trackA && hitA) {
        actions.playTrack(trackA, [trackA])
        const reached = await waitFor(() => player.getTime() >= hitA.time - 2)
        onResult = { time: Math.round(player.getTime()), target: Math.round(hitA.time), reached }
      }

      // 关掉开关：点开应当从头播，不跳
      await actions.setSetting({ jumpToMatchedLyric: false })
      const second = hits.find((item) => item.id !== first.id) || null
      let offResult = null
      if (second) {
        const wordB = (second.line.match(/[A-Za-z]{4,}/) || [])[0]
        await actions.searchLyricsNow(wordB)
        actions.setQuery(wordB)
        await settle(420)
        const stateB = store.get().ui.searchLyrics
        const hitB = (stateB?.matches || []).find((item) => item.id === second.id) ||
          (stateB?.matches || [])[0]
        const trackB = hitB ? byId.get(hitB.id) : null
        if (trackB && hitB) {
          actions.playTrack(trackB, [trackB])
          await settle(3200)
          offResult = { time: Math.round(player.getTime()), target: Math.round(hitB.time) }
        }
      }

      await actions.setSetting({ jumpToMatchedLyric: true })
      actions.setSearchScope('basic')
      actions.setQuery('')
      player.pause()
      await settle(200)
      return { skipped: false, wordA, onResult, offResult }
    `)
    record('歌词命中：点开歌曲跳到那一句（可在设置里关掉）',
      !jumpCheck.skipped &&
      jumpCheck.onResult && jumpCheck.onResult.reached &&
      (!jumpCheck.offResult || jumpCheck.offResult.time < jumpCheck.offResult.target - 5),
      jumpCheck.skipped
        ? jumpCheck.reason
        : `开关打开：搜索「${jumpCheck.wordA}」后点开，播放位置跳到 ${jumpCheck.onResult.time}s（命中句在 ${jumpCheck.onResult.target}s）；` +
          (jumpCheck.offResult
            ? `开关关闭：同样点开只播到 ${jumpCheck.offResult.time}s（命中句在 ${jumpCheck.offResult.target}s，没有跳）`
            : '开关关闭的对照组没有可用的第二首样本'))



    /* ---------- 从任何视图都能回到「全部歌曲」 ----------
     *
     * 回归现场：侧边栏的「全部歌曲」只调了 setSource，而 setSource 只在当前是设置页时
     * 才把视图切回歌曲 —— 从媒体墙 / 艺人 / 专辑点过来会「什么也没发生」，
     * 用户看到的就是「点过媒体墙、艺人之后就回不到全部歌曲页面」。
     * 这里逐个视图点一遍，断言真的回到了歌曲列表。
     */
    const backToSongsCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 420) => { await new Promise((r) => setTimeout(r, ms)) }
      const listContainer = document.querySelector('.track-list')?.closest('.view-root') ||
        document.querySelectorAll('.content-inner')[0]
      // 用「第一行的实际矩形高度」判断列表是否真的显示出来了
      // （offsetParent 在这种定位结构下恒为 null，外层容器的 rect 也不一定能代表）
      const listVisible = () => {
        const row = document.querySelector('.track-row')
        return (row?.getBoundingClientRect().height || 0) > 10
      }
      const visibleRoots = () => [...document.querySelectorAll('#content > .view-root')]
        .filter((node) => node.style.display !== 'none' && node.offsetParent !== null)
        .map((node) => (node.className || '').toString().slice(0, 24))

      const sidebarRow = (label) => [...document.querySelectorAll('.sidebar__row')]
        .find((node) => (node.textContent || '').includes(label))

      // 侧边栏里「全部歌曲」那一项
      const allSongsRow = sidebarRow('全部歌曲')
      const results = []
      for (const [label, action] of [
        ['专辑', () => actions.setView('albums')],
        ['艺人', () => actions.setView('artists')],
        ['媒体墙', () => actions.setView('wall')],
        ['设置', () => actions.setView('settings')]
      ]) {
        action()
        await settle()
        const before = { view: store.get().ui.view, visible: visibleRoots() }
        allSongsRow.click()
        await settle()
        results.push({
          label,
          before,
          view: store.get().ui.view,
          source: store.get().ui.source.type,
          detail: store.get().ui.detail ? store.get().ui.detail.key : null,
          visible: visibleRoots(),
          songsVisible: listVisible(),
          rows: document.querySelectorAll('.track-row').length
        })
      }
      // 队列面板打开着的时候也要能回到全部歌曲
      actions.toggleQueue(true)
      actions.setView('wall')
      await settle()
      allSongsRow.click()
      await settle()
      const withQueue = {
        view: store.get().ui.view,
        songsVisible: listVisible(),
        queueOpen: store.get().ui.queueOpen
      }
      actions.toggleQueue(false)
      actions.setView('songs')
      await settle(300)
      return { results, withQueue, hasRow: Boolean(allSongsRow) }
    `)
    const backToSongs = backToSongsCheck.results
    record('从任何视图都能回到「全部歌曲」',
      backToSongsCheck.hasRow &&
      backToSongs.every((item) => item.view === 'songs' && item.source === 'all' &&
        item.detail === null && item.songsVisible && item.rows > 0) &&
      backToSongsCheck.withQueue.view === 'songs' && backToSongsCheck.withQueue.songsVisible,
      backToSongs.map((item) => `${item.label}（切前 ${item.before.view}）→ ${item.view}/${item.source}，列表可见=${item.songsVisible}、${item.rows} 行`).join('；') +
      `；队列面板开着时 → ${backToSongsCheck.withQueue.view}，列表可见=${backToSongsCheck.withQueue.songsVisible}`)

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
      // 等 FLIP 收敛（本环境 rAF 被节流，onfinish 回调会有延迟，所以轮询等待）
      let flippingAfter = flippingRightAfter
      const settleStarted = performance.now()
      while (performance.now() - settleStarted < 6000) {
        await new Promise((r) => setTimeout(r, 200))
        flippingAfter = document.querySelectorAll('.wall-tile.is-flipping').length
        if (flippingAfter === 0) break
      }
      const settleMs = Math.round(performance.now() - settleStarted)
      const sizeAfter = grid?.style.getPropertyValue('--wall-size')
      const columnsAfter = grid?.style.getPropertyValue('--wall-columns')

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
        flippingRightAfter, flippingAfter, animated, settleMs,
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
      `切换瞬间有 ${wallView.flippingRightAfter} 个格子参与动画（共 ${wallView.animated} 个动画），${wallView.settleMs}ms 后收敛`)
    record('聚焦块跟随切歌',
      Boolean(wallView.afterSwitchKey) && wallView.afterSwitchKey === wallView.expectedSwitchKey &&
      wallView.afterSwitchTitle.length > 0 && wallView.afterSwitchPosition,
      `播放靠后的专辑后聚焦块移到它自己的位置（距原点 ${JSON.stringify(wallView.distanceFromOrigin)}，order=${wallView.afterSwitchOrder}），标题《${wallView.afterSwitchTitle}》`)
    record('媒体墙打开专辑', wallView.openedAlbum, '点击方块角标可进入专辑详情')

    /*
     * ---------- 格子几何 ----------
     *
     * 这一组是补上来的：之前所有自检都只看「有没有格子、点了能不能打开」，
     * 结果一个把整面墙压扁的 bug 溜了过去 —— 网格盒子收成「视口 + 一个步长」
     * 有了确定高度之后，auto 行被压缩去填容器，148px 的行被压成 32px：
     * 普通格子逐行重叠、聚焦块（跨 2 行）高度塌成 67px，封面被裁成一条。
     * 所以这里直接量几何：格子必须是方的、行节奏必须等于格子尺寸、
     * 聚焦块必须正好是 2 格 + 1 个间距、封面必须铺满格子。
     */
    const tileGeometry = await evaluate(win, `
      const wall = window.__aria.views.mediaWall
      // 前面那一步点进了专辑详情，几何必须在媒体墙可见时量
      window.__aria.actions.setView('wall')
      await new Promise((r) => setTimeout(r, 700))
      const state = wall.debugState()
      const size = state.tileSize
      const gap = 3
      const grid = document.querySelector('.media-wall')
      const tiles = [...document.querySelectorAll('.wall-tile')]
      const box = (node) => {
        const rect = node.getBoundingClientRect()
        return { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) }
      }
      const normal = tiles.filter((tile) => !tile.classList.contains('is-featured')).slice(0, 60)
      const featured = document.querySelector('.wall-tile.is-featured')

      // 行节奏：同一列里相邻两行的纵向间距应当等于 格子 + 间距。
      // 取「最小的正间距」而不是中位数：聚焦块占了 2×2，它所在的那一列会缺一格，
      // 于是会出现 2 倍间距的差值，用最小值才拿到真实的单行步长。
      const byColumn = new Map()
      for (const tile of normal) {
        const rect = box(tile)
        const list = byColumn.get(rect.left) || []
        list.push(rect.top)
        byColumn.set(rect.left, list)
      }
      const pitches = []
      for (const tops of byColumn.values()) {
        tops.sort((a, b) => a - b)
        for (let i = 1; i < tops.length; i++) {
          const delta = tops[i] - tops[i - 1]
          if (delta > 2) pitches.push(delta)
        }
      }
      const pitch = pitches.length ? Math.min(...pitches) : null

      // 封面是否铺满格子（悬停缩放不参与，这里只看静止状态）
      const artMismatch = normal.filter((tile) => {
        const img = tile.querySelector('.wall-tile__art img')
        if (!img) return false
        const t = box(tile)
        const i = box(img)
        return Math.abs(i.w - t.w) > 2 || Math.abs(i.h - t.h) > 2
      }).length

      const rows = getComputedStyle(grid).gridTemplateRows.split(' ')
      const rowSizes = rows.map((value) => Math.round(Number.parseFloat(value))).filter((value) => Number.isFinite(value))
      return {
        size,
        gap,
        squares: normal.every((tile) => { const rect = box(tile); return Math.abs(rect.w - rect.h) <= 1 }),
        normalBox: normal.length ? box(normal[0]) : null,
        featuredBox: featured ? box(featured) : null,
        pitch,
        expectPitch: size + gap,
        rowSizes,
        rowCount: rowSizes.length,
        rowsMatch: rowSizes.every((value) => Math.abs(value - size) <= 1),
        artMismatch
      }`)
    const expectFeatured = tileGeometry.size * 2 + tileGeometry.gap
    record('媒体墙格子是正方形',
      tileGeometry.squares && tileGeometry.normalBox &&
      Math.abs(tileGeometry.normalBox.w - tileGeometry.size) <= 1 &&
      Math.abs(tileGeometry.normalBox.h - tileGeometry.size) <= 1,
      `普通格子 ${tileGeometry.normalBox?.w}×${tileGeometry.normalBox?.h}，标称 ${tileGeometry.size}px；` +
      `行尺寸 ${tileGeometry.rowCount} 行，${tileGeometry.rowsMatch ? '全部等于格子尺寸' : `异常：${tileGeometry.rowSizes.slice(0, 4).join('/')}`}`)
    record('聚焦块正好是 2×2 格',
      tileGeometry.featuredBox &&
      Math.abs(tileGeometry.featuredBox.w - expectFeatured) <= 2 &&
      Math.abs(tileGeometry.featuredBox.h - expectFeatured) <= 2,
      `聚焦块 ${tileGeometry.featuredBox?.w}×${tileGeometry.featuredBox?.h}，应为 2×${tileGeometry.size}+${tileGeometry.gap}=${expectFeatured}`)
    record('媒体墙行节奏不重叠',
      tileGeometry.pitch !== null && Math.abs(tileGeometry.pitch - tileGeometry.expectPitch) <= 2,
      `相邻两行的纵向间距 ${tileGeometry.pitch}px，应为 ${tileGeometry.expectPitch}px（${tileGeometry.size}+${tileGeometry.gap}）`)
    record('封面铺满格子',
      tileGeometry.artMismatch === 0,
      tileGeometry.artMismatch === 0
        ? `抽查的格子中，封面尺寸与格子一致（没有被裁成一截）`
        : `${tileGeometry.artMismatch} 个格子的封面尺寸与格子不符`)


    /* ---------- 媒体墙的自由拖动（2D 画布） ---------- */

    const panCheck = await evaluate(win, `
      const { actions } = window.__aria
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 1300))

      const wall = window.__aria.views.mediaWall
      const viewport = document.querySelector('.wall-viewport')
      // 前面的检查会把视图切到歌曲列表，这里必须先切回媒体墙：
      // 视图隐藏时它是 0×0，可拖范围会被算成 0，拖动自然是「位移 0」
      window.__aria.actions.setView('wall')
      await new Promise((r) => setTimeout(r, 700))
      const rect = viewport.getBoundingClientRect()
      const cx = Math.round(rect.left + rect.width / 2)
      const cy = Math.round(rect.top + rect.height / 2)

      const pointer = (type, x, y, init = {}) => viewport.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, pointerType: 'mouse',
        clientX: x, clientY: y, ...init
      }))

      const initial = wall.debugState()

      // ① 中键斜向拖动：两个轴都应该动
      //    先把位置挪到可拖范围的中间 —— 贴着边界出发时这一拖会被钳制成零位移
      const midBounds = wall.debugState().bounds
      wall.debugApplyPan(Math.round(midBounds.minX / 2), Math.round(midBounds.minY / 2))
      await new Promise((r) => requestAnimationFrame(r))
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
      //    先把位置挪到可拖范围的中间：起始 pan 贴着 0（右/下方向的边界）时，
      //    这一拖会被钳制成零位移，看起来就像「Alt 拖动失效」（窗口小的时候尤其容易撞上）
      const altBounds = wall.debugState().bounds
      wall.debugApplyPan(Math.round(altBounds.minX / 2), Math.round(altBounds.minY / 2))
      await new Promise((r) => requestAnimationFrame(r))
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

    /* ---------- 拖到任何位置，屏幕上都得真的有格子 ----------
     *
     * 这条是补上来的，因为之前所有的判定都用 rect 相交 —— 而 rect 相交并不能说明
     * 元素真的看得见：被祖先 overflow:hidden 裁掉时 rect 照样相交。
     * 结果就是「为了让拖动变快，把网格裁成视口大小」那版自检全绿，
     * 而画面上其实只剩左上角一屏，拖到别处整片空白。
     *
     * 现在改为在墙视口里做网格命中测试：elementFromPoint 遵守裁剪与命中规则，
     * 命中不到格子就说明用户看到的是空白。
     */
    const hitCheck = await evaluate(win, `
      const wall = window.__aria.views.mediaWall
      const base = wall.debugState()
      const points = [
        [0, 0],
        [Math.round(base.bounds.minX / 2), Math.round(base.bounds.minY / 2)],
        [base.bounds.minX, base.bounds.minY],
        [Math.round(base.bounds.minX * 0.83), Math.round(base.bounds.minY * 0.17)],
        [Math.round(base.bounds.minX * 0.17), Math.round(base.bounds.minY * 0.83)]
      ]
      const stops = []
      for (const [x, y] of points) {
        wall.debugApplyPan(x, y)
        await new Promise((r) => requestAnimationFrame(r))
        const state = wall.debugState()
        stops.push({
          pan: state.pan,
          hit: wall.debugHitTest({ columns: 6, rows: 4 }),
          slotDrift: wall.debugSlotDrift().drift,
          culled: state.culled,
          planeScroll: state.planeScroll,
          plane: { width: Math.round(state.bounds.width), height: Math.round(state.bounds.height) },
          tileCount: state.tileCount ?? null
        })
      }
      wall.debugApplyPan(0, 0)
      await new Promise((r) => requestAnimationFrame(r))
      return { stops, total: wall.tileCount, culledAtOrigin: wall.debugState().culled }`)

    const hitStops = hitCheck.stops
    const hitRate = Math.min(...hitStops.map((stop) => stop.hit.tile / stop.hit.total))
    const hitCulled = hitStops.reduce((sum, stop) => sum + stop.hit.culled, 0)
    const hitDrift = Math.max(...hitStops.map((stop) => stop.slotDrift))
    /*
     * 阈值 0.75 而不是 1：格子之间有 3px 缝，采样点落在缝里（或平面边缘）是正常的，
     * 24 个点里偶尔差一两个命中不代表画面有问题。
     * 而真正出问题时的量级完全不同 —— 被裁掉那一版实测命中率是 0。
     */
    record('拖到任何位置画面都有内容',
      hitRate >= 0.75 && hitCulled === 0 && hitDrift === 0,
      `${hitStops.length} 个停靠点（含四角）各取 24 个点做命中测试：最差命中率 ${Math.round(hitRate * 100)}%，` +
      `命中的格子里有 ${hitCulled} 个是隐藏的（应为 0），行列缓存错位 ${hitDrift} 个（应为 0）；` +
      `各点命中 ${hitStops.map((stop) => stop.hit.tile).join('/')}，裁掉的格子数 ${hitStops.map((stop) => stop.culled).join('/')}` +
      `${hitStops.some((stop) => stop.hit.samples.length) ? `；未命中的例子 ${hitStops.find((stop) => stop.hit.samples.length).hit.samples.join('；')}` : ''}`)
    const planeDrift = Math.max(...hitStops.flatMap((stop) => [
      Math.abs(stop.planeScroll.width - stop.plane.width),
      Math.abs(stop.planeScroll.height - stop.plane.height)
    ]))
    record('平面尺寸与网格内容一致',
      planeDrift <= 8,
      `网格盒子 ${hitStops[0].plane.width}×${hitStops[0].plane.height}，` +
      `内容范围 ${hitStops[0].planeScroll.width}×${hitStops[0].planeScroll.height}（相差 ${planeDrift}px）；` +
      `共 ${hitCheck.total} 个格子，回到原点时裁掉 ${hitCheck.culledAtOrigin} 个`)

    /* ---------- 平移后新露出的格子要补加载封面 ----------
     *
     * 回归现场：为了让拖动快起来，格子的裁剪被放到了 .media-wall 自己身上，
     * 而平移只改祖先 transform（纯合成、不触发布局），IntersectionObserver
     * 不再为「因此进入视口」的格子派发新回调 —— 拖到中段之后新露出来的格子
     * 一直停在灰底占位图。现在靠「平移停稳后的几何兜底扫描」补上，这里盯着它。
     */
    const coverAfterPanCheck = await evaluate(win, `
      const wall = window.__aria.views.mediaWall
      const viewport = document.querySelector('.wall-viewport')
      const countVisible = () => {
        const box = viewport.getBoundingClientRect()
        const visible = [...document.querySelectorAll('.wall-tile')].filter((tile) => {
          const rect = tile.getBoundingClientRect()
          return rect.right > box.left && rect.left < box.right &&
            rect.bottom > box.top && rect.top < box.bottom
        })
        return {
          total: visible.length,
          withCover: visible.filter((tile) => tile.querySelector('img[src]')).length
        }
      }
      // 先把整面墙重建成「一张封面都还没加载」的状态，
      // 这样下面量到的差异只可能来自「平移之后的补加载」，和缓存是否热无关
      const rebuild = wall.debugRebuild()
      wall.debugApplyPan(0, 0)
      await new Promise((r) => setTimeout(r, 700))
      const home = countVisible()

      // 再拖到对角：那一带的格子从没进过视口，封面自然还没开始加载
      const state = wall.debugState()
      wall.debugApplyPan(state.bounds.minX, state.bounds.minY)
      await new Promise((r) => setTimeout(r, 250))
      const before = countVisible()
      // 兜底扫描在停稳 220ms 后跑，之后由节流慢慢出图（4 并发 / 每帧 3 个）
      await new Promise((r) => setTimeout(r, 6000))
      const after = countVisible()
      const scan = wall.debugState().scan
      wall.debugApplyPan(0, 0)
      await new Promise((r) => setTimeout(r, 300))
      return { rebuild, home, before, after, scan }`)

    const coverAfterPan = coverAfterPanCheck
    const coverRatio = coverAfterPan.after.total
      ? coverAfterPan.after.withCover / coverAfterPan.after.total
      : 0
    /*
     * 判据只看「拖过去之后，那一片格子里大多数有没有封面」。
     * 不去比较「拖之前 vs 拖之后」的增长：渲染层的封面 blob 是带缓存的，
     * 重建出来的格子也能瞬间拿到封面，所以「新露出的格子一开始没封面」这个前提
     * 并不成立（这么写过，结果是一条永远绿的假检查）。
     * 而回归时的症状很明确：新露出的格子停在灰底占位图上（当年是 20/129）。
     */
    record('平移后新露出的格子有封面',
      coverRatio >= 0.6 && (coverAfterPan.scan?.added || 0) > 0,
      `拖到对角：可见 ${coverAfterPan.after.total} 格 / 有封面 ${coverAfterPan.after.withCover} 格` +
      `（${Math.round(coverRatio * 100)}%）；` +
      `兜底扫描入队 ${coverAfterPan.scan?.added ?? '—'} 个（候选 ${coverAfterPan.scan?.scanned ?? '—'} 个，耗时 ${coverAfterPan.scan?.elapsedMs ?? '—'}ms）`)


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
      const stage = document.querySelector('.media-wall')
      const minimap = document.querySelector('.wall-minimap')
      const domRounds = 100
      const domStarted = performance.now()
      for (let i = 0; i < domRounds; i++) {
        void stage.offsetWidth
        void minimap.getBoundingClientRect()
        stage.style.transform = 'translate3d(' + (-i) + 'px,' + (-i) + 'px,0)'
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

    /* ---------- 帧率浮层：让用户自己量，而不是靠感觉 ---------- */

    const fpsCheck = await evaluate(win, `
      const overlay = document.querySelector('.fps-overlay')
      if (!overlay) return { missing: true }
      const before = { hidden: overlay.hidden, text: overlay.textContent.trim() }
      window.__aria.actions.setSetting({ showFps: true })
      await new Promise((r) => setTimeout(r, 1100))
      const on = { hidden: overlay.hidden, text: overlay.textContent.trim() }
      window.__aria.actions.setSetting({ showFps: false })
      await new Promise((r) => setTimeout(r, 400))
      const off = { hidden: overlay.hidden }
      window.__aria.actions.setSetting({ showFps: false })
      return { before, on, off }`)
    const fpsValue = Number((fpsCheck.on?.text.match(/(\d+) fps/) || [])[1])
    record('帧率浮层可开关',
      !fpsCheck.missing && fpsCheck.before.hidden === true && fpsCheck.on.hidden === false &&
      fpsCheck.off.hidden === true && Number.isFinite(fpsValue) && fpsValue > 0,
      fpsCheck.missing
        ? '未找到 .fps-overlay'
        : `默认隐藏（"${fpsCheck.before.text}"）→ 打开后显示 "${fpsCheck.on.text}" → 关闭后再次隐藏`)


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
    const prewarmBefore = await evaluate(win, `return window.__aria.prewarmer.state`)
    await sleep(6000)
    const prewarmAfter = await evaluate(win, `return window.__aria.prewarmer.state`)
    const prewarmFiles = (await artworkService.getArtworkStats()).files
    const prewarmDelta = prewarmAfter.warmed - prewarmBefore.warmed
    record('空闲时后台预热封面',
      prewarmAfter.warmed > 0 && prewarmFiles > 3 && !prewarmAfter.paused,
      `预热器本次会话已自行补了 ${prewarmAfter.warmed} 张（本轮 +${prewarmDelta}），封面缓存现有 ${prewarmFiles} 个文件；未打开媒体墙即可完成`)

    /* ---------- 切回媒体墙要定位到正在播放的专辑 ---------- */

    const focusCheck = await evaluate(win, `
      const { actions } = window.__aria
      const wall = window.__aria.views.mediaWall
      const albums = actions.albums()
      const snapshot = (label) => {
        const state = wall.debugState()
        return {
          label,
          layout: state.layout,
          columns: state.columns,
          tileSize: state.tileSize,
          pan: state.pan,
          bounds: {
            plane: [state.bounds.width, state.bounds.height],
            view: [state.bounds.viewWidth, state.bounds.viewHeight],
            minX: state.bounds.minX,
            minY: state.bounds.minY
          },
          featuredKey: (wall.featuredKey || '').slice(0, 10),
          featuredOffset: state.featuredOffset,
          center: state.tileCenterInViewport,
          viewportCenter: state.viewportCenter
        }
      }

      // 挑一张靠后的专辑播放（它的格子离平面左上角很远）
      const far = albums[Math.min(200, albums.length - 1)]
      actions.playCollectionOf(far.tracks, far.tracks[0])
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 1600))
      const afterEnter = snapshot('进入媒体墙')

      // 把平面拖回左上角，制造「正在播放的专辑不在视野里」
      const viewport = document.querySelector('.wall-viewport')
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: -4000, deltaY: -4000 }))
      await new Promise((r) => setTimeout(r, 900))
      const away = snapshot('拖走后')

      // 离开再回来
      actions.setView('songs')
      await new Promise((r) => setTimeout(r, 500))
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 1200))
      const afterReturn = snapshot('回来后')

      const distance = afterReturn.center && afterReturn.viewportCenter
        ? Math.round(Math.hypot(
            afterReturn.center.x - afterReturn.viewportCenter.x,
            afterReturn.center.y - afterReturn.viewportCenter.y))
        : null

      /*
       * 判据：目标专辑应当被摆到视口正中，除非那个方向已经顶到边界。
       * 墙能滚的范围有限，专辑离平面边缘太近时「居中」做不到 ——
       * 这时只要位移贴在边界上就是正确的，不能算定位失败。
       *
       * （不要用 offsetTop + windowOrigin 去反算「理论位移」：windowOrigin 是
       *  跟着 pan 吸附变化的，量的时候它已经和定位那一刻不是同一个值，
       *  算出来的期望值会差好几格。）
       */
      const finalState = wall.debugState()
      const slack = {
        x: Math.abs((afterReturn.center?.x ?? 0) - (afterReturn.viewportCenter?.x ?? 0)),
        y: Math.abs((afterReturn.center?.y ?? 0) - (afterReturn.viewportCenter?.y ?? 0))
      }
      const atBoundary = {
        x: finalState.pan.x <= finalState.bounds.minX + 1 || finalState.pan.x >= -1,
        y: finalState.pan.y <= finalState.bounds.minY + 1 || finalState.pan.y >= -1
      }
      return {
        afterEnter, away, afterReturn, distance, expectedKey: far.key.slice(0, 10),
        pan: finalState.pan, bounds: finalState.bounds, slack, atBoundary
      }
    `)
    const focusOk = Boolean(focusCheck.slack &&
      (focusCheck.slack.x <= 4 || focusCheck.atBoundary.x) &&
      (focusCheck.slack.y <= 4 || focusCheck.atBoundary.y))
    record('切回媒体墙定位到正在播放',
      focusOk && focusCheck.afterReturn.featuredKey === focusCheck.expectedKey,
      `期望专辑 ${focusCheck.expectedKey}；` +
      `进入 ${JSON.stringify(focusCheck.afterEnter)}；` +
      `拖走 ${JSON.stringify(focusCheck.away)}；` +
      `回来 ${JSON.stringify(focusCheck.afterReturn)}；` +
      `偏离视口中心 ${focusCheck.slack.x}×${focusCheck.slack.y}px` +
      `（x ${focusCheck.atBoundary.x ? '已顶到边界、属正常' : '未顶边界'}，y ${focusCheck.atBoundary.y ? '已顶到边界、属正常' : '未顶边界'}）`)

    /* ---------- 没有实际变化时不该打扰用户 ---------- */

    await evaluate(win, `
      // 清一下现有的 toast，便于判断这次有没有新弹
      document.querySelectorAll('.toast').forEach((node) => node.remove())
      return true`)
    const noopScan = await artworkService.scan({ reason: 'smoke-noop' })
    await sleep(1200)
    const toastCount = await evaluate(win, `return document.querySelectorAll('.toast').length`)
    record('无变化时不提示',
      noopScan.changed === 0 && toastCount === 0,
      `重扫未产生任何增减（changed=${noopScan.changed}，复用缓存 ${noopScan.reused} 首），界面上没有弹出提示（toast=${toastCount}）`)

    /* ---------- 双语歌词：迷你歌词必须同时显示主歌词与翻译 ---------- */

    // 找一个「同一时间戳出现两次」的歌词文件 = 双语歌词
    const bilingualTrack = await (async () => {
      const candidates = artworkService.getTracks().filter((track) => track.lyricsPath).slice(0, 120)
      for (const track of candidates) {
        let text = ''
        try {
          text = (await fsp.readFile(track.lyricsPath)).toString('utf8')
        } catch {
          continue
        }
        // 时间戳是 ASCII，即使文件是 GBK 也能正确数出来
        const stamps = [...text.matchAll(/\[(\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?)\]/g)].map((match) => match[1])
        const counts = new Map()
        for (const stamp of stamps) counts.set(stamp, (counts.get(stamp) || 0) + 1)
        const duplicated = [...counts.values()].filter((count) => count >= 2).length
        if (duplicated >= 5) return track
      }
      return null
    })()

    if (!bilingualTrack) {
      record('双语歌词迷你显示', true, '资料库里没有找到双语歌词，跳过')
    } else {
      const bilingualCheck = await evaluate(win, `
        const { actions, store } = window.__aria
        const track = store.get().library.byId.get(${JSON.stringify(bilingualTrack.id)})
        if (!track) return { error: '找不到曲目' }
        actions.setView('wall')
        actions.playTrack(track, [track])
        // 等歌词加载完
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250))
          if (store.get().lyrics.status === 'ready' && store.get().lyrics.lines.length > 3) break
        }
        const state = store.get().lyrics
        const nodes = [...document.querySelectorAll('.hero__lyrics .mini-lyrics__line')]
        const withSub = nodes.filter((node) => node.querySelector('.mini-lyrics__sub'))
        const sample = withSub.slice(0, 3).map((node) => ({
          main: node.querySelector('.mini-lyrics__main')?.textContent || '',
          sub: node.querySelector('.mini-lyrics__sub')?.textContent || ''
        }))
        const activeNode = document.querySelector('.hero__lyrics .mini-lyrics__line.is-active')
        return {
          title: track.title,
          lyricLines: state.lines.length,
          translated: state.lines.filter((line) => line.translation).length,
          renderedLines: nodes.length,
          renderedWithSub: withSub.length,
          sample,
          activeHasSub: Boolean(activeNode?.querySelector('.mini-lyrics__sub')),
          fullViewLines: document.querySelectorAll('.lyrics__line').length
        }`)
      const sampleOk = bilingualCheck.sample?.length > 0 &&
        bilingualCheck.sample.every((item) => item.main.length > 0 && item.sub.length > 0 && item.main !== item.sub)
      record('双语歌词迷你显示',
        bilingualCheck.renderedWithSub > 3 && bilingualCheck.renderedWithSub === bilingualCheck.translated && sampleOk,
        `《${bilingualCheck.title}》解析出 ${bilingualCheck.translated}/${bilingualCheck.lyricLines} 行带翻译，` +
        `迷你歌词渲染 ${bilingualCheck.renderedWithSub} 行带翻译；例：` +
        (bilingualCheck.sample || []).map((item) => `「${item.main}」/「${item.sub}」`).join('、'))
      record('双语歌词全屏视图', bilingualCheck.fullViewLines > 0,
        `全屏歌词仍渲染 ${bilingualCheck.fullViewLines} 行（与迷你歌词共用同一份解析结果）`)
    }

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
