'use strict'

/**
 * 视觉审计：不靠眼睛，用「计算样式 + 几何 + 位图统计」验证界面真的按设计渲染了。
 *
 *   npm run audit
 *
 * 输出分两部分：
 *   1. DOM 审计 —— 关键元素的实际计算样式与位置（颜色、圆角、毛玻璃、字号、是否有溢出）
 *   2. 位图审计 —— 对截图分区域统计亮度/色彩，确认不是空白页、封面真的画出来了
 */

const fsp = require('node:fs/promises')
const path = require('node:path')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OUTPUT_DIR = path.join(__dirname, '..', '..', 'docs', 'screenshots')

async function evaluate (win, expression) {
  return win.webContents.executeJavaScript(`(async () => { ${expression} })()`, true)
}

async function waitFor (win, condition, { timeout = 120000, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await evaluate(win, `return Boolean(${condition})`)) return true
    } catch {
      // 忽略，继续轮询
    }
    await sleep(300)
  }
  throw new Error(`等待超时：${label}`)
}

/** DOM 侧审计脚本：在渲染层里跑，返回纯数据 */
const DOM_AUDIT = `
  const cs = (selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const style = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      color: style.color,
      background: style.backgroundColor,
      radius: style.borderTopLeftRadius,
      font: style.fontFamily.split(',')[0].replace(/["']/g, ''),
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      backdrop: style.backdropFilter || style.webkitBackdropFilter,
      visible: r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
  }
  const root = getComputedStyle(document.documentElement)
  const image = document.querySelector('.player-bar__art img')
  const activeLyric = document.querySelector('.lyrics__line.is-active')
  const idleLyric = document.querySelector('.lyrics__line:not(.is-active)')

  return {
    theme: document.documentElement.dataset.theme,
    platform: document.documentElement.dataset.platform,
    tokens: {
      accent: root.getPropertyValue('--accent').trim(),
      tint: root.getPropertyValue('--tint').trim(),
      label: root.getPropertyValue('--label').trim(),
      separator: root.getPropertyValue('--separator').trim(),
      radiusLg: root.getPropertyValue('--radius-lg').trim()
    },
    body: cs('body'),
    sidebar: cs('.sidebar'),
    titlebar: cs('.titlebar'),
    toolbar: cs('.view-toolbar'),
    largeTitle: cs('.view-header__title'),
    playerBar: cs('.player-bar'),
    artInBar: cs('.player-bar__art'),
    playButton: cs('.btn--transport'),
    nowPlayingTransport: cs('.now-playing__controls .btn--transport'),
    // 注意：设置页里也有 .switch / .segmented，所以限定作用域查询
    settingsSwitch: cs('.settings .switch'),
    modeSegment: cs('.now-playing__tools .segmented'),
    modeSegmentThumb: cs('.now-playing__tools .segmented__thumb'),
    modeSegmentItems: document.querySelectorAll('.now-playing__tools .segmented__item').length,
    progressThumb: cs('.now-playing__progress .slider__thumb'),
    volumeSlider: cs('.player-bar__volume .slider'),
    ratePill: cs('.player-bar__rate'),
    badge: cs('.track-row__badge'),
    nowPlaying: cs('.now-playing'),
    nowPlayingArt: cs('.now-playing__art'),
    lyricsRegion: cs('.lyrics-region'),
    counts: {
      rows: document.querySelectorAll('.track-row').length,
      columns: document.querySelectorAll('.tracklist__head > *').length,
      lyricsLines: document.querySelectorAll('.lyrics__line').length,
      activeLyrics: document.querySelectorAll('.lyrics__line.is-active').length,
      lyricsBadges: document.querySelectorAll('.track-row__badge').length,
      tabs: document.querySelectorAll('.now-playing__tab').length,
      settingsCards: document.querySelectorAll('.settings__card').length,
      visibleRowsWithLyrics: [...document.querySelectorAll('.track-row')]
        .filter((row) => row.querySelector('.track-row__badge')).length
    },
    artwork: image ? { loaded: image.complete && image.naturalWidth > 0, natural: [image.naturalWidth, image.naturalHeight], src: image.src.slice(0, 24) } : null,
    lyricTypography: activeLyric && idleLyric ? {
      activeSize: getComputedStyle(activeLyric).fontSize,
      idleSize: getComputedStyle(idleLyric).fontSize,
      activeColor: getComputedStyle(activeLyric).color,
      idleColor: getComputedStyle(idleLyric).color,
      innerTransform: getComputedStyle(document.querySelector('.lyrics__inner')).transform
    } : null,
    overflow: {
      horizontal: document.documentElement.scrollWidth - window.innerWidth,
      vertical: document.documentElement.scrollHeight - window.innerHeight
    },
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
  }
`

/** 位图统计：把画面分成若干区域，看亮度与色彩分布是否合理 */
function analyzeImage (image) {
  const size = image.getSize()
  const bitmap = image.getBitmap()
  const bytesPerPixel = bitmap.length / (size.width * size.height)

  const region = (x0, y0, x1, y1) => {
    let r = 0
    let g = 0
    let b = 0
    let count = 0
    let min = 255
    let max = 0
    for (let y = Math.max(0, y0); y < Math.min(size.height, y1); y += 2) {
      for (let x = Math.max(0, x0); x < Math.min(size.width, x1); x += 2) {
        const offset = (y * size.width + x) * bytesPerPixel
        // nativeImage 的位图是 BGRA
        const blue = bitmap[offset]
        const green = bitmap[offset + 1]
        const red = bitmap[offset + 2]
        r += red
        g += green
        b += blue
        const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue
        if (luma < min) min = luma
        if (luma > max) max = luma
        count++
      }
    }
    if (!count) return null
    return {
      rgb: [Math.round(r / count), Math.round(g / count), Math.round(b / count)],
      luma: Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) / count),
      contrast: Math.round(max - min)
    }
  }

  const w = size.width
  const h = size.height
  return {
    size: [w, h],
    bytesPerPixel,
    whole: region(0, 0, w, h),
    sidebar: region(0, 60, Math.round(w * 0.18), h - 90),
    content: region(Math.round(w * 0.28), 90, w - 40, h - 140),
    playerBar: region(0, h - 70, w, h),
    // 底部条左侧的一小块：专辑封面所在位置
    playerArtwork: region(20, h - 62, 74, h - 10)
  }
}

async function runVisualAudit ({ win }) {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true })
  await waitFor(win, 'window.__aria && window.__aria.store.get().library.loaded === true', { label: '资料库' })

  const states = []

  /* ---------- 状态 1：歌曲列表 ---------- */
  await evaluate(win, `
    const { store, actions, player } = window.__aria
    const tracks = store.get().library.tracks
    const track = tracks.find((t) => t.lyricsPath) || tracks[0]
    actions.playTrack(track)
    await new Promise((r) => setTimeout(r, 1600))
    player.pause()
    player.seek(40)
    actions.setView('songs')
    await new Promise((r) => setTimeout(r, 700))
    return true`)
  const libraryDom = await evaluate(win, DOM_AUDIT)
  const libraryImage = await captureAndSave(win, '01-library.png')
  states.push({ name: '歌曲列表', dom: libraryDom, image: libraryImage })

  /* ---------- 状态 2：正在播放（歌词） ---------- */
  await evaluate(win, `
    const { actions, player, store } = window.__aria
    actions.openNowPlaying({ lyrics: true })
    await new Promise((r) => setTimeout(r, 1200))
    const lines = store.get().lyrics.lines
    if (lines.length > 14) player.seek(lines[14].time + 0.5)
    await new Promise((r) => setTimeout(r, 1600))
    return true`)
  const nowPlayingDom = await evaluate(win, DOM_AUDIT)
  const nowPlayingImage = await captureAndSave(win, '02-now-playing.png')
  states.push({ name: '正在播放', dom: nowPlayingDom, image: nowPlayingImage })

  /* ---------- 状态 3：设置 ---------- */
  await evaluate(win, `
    window.__aria.actions.closeNowPlaying()
    window.__aria.actions.setView('settings')
    await new Promise((r) => setTimeout(r, 800))
    return true`)
  const settingsDom = await evaluate(win, DOM_AUDIT)
  const settingsImage = await captureAndSave(win, '06-settings.png')
  states.push({ name: '设置', dom: settingsDom, image: settingsImage })

  /* ---------- 状态 4：深色主题下的正在播放 ---------- */
  await evaluate(win, `
    const { actions, player, store } = window.__aria
    actions.setTheme('dark')
    await new Promise((r) => setTimeout(r, 300))
    actions.setView('songs')
    actions.openNowPlaying({ lyrics: true })
    await new Promise((r) => setTimeout(r, 1200))
    const lines = store.get().lyrics.lines
    if (lines.length > 20) player.seek(lines[20].time + 0.5)
    await new Promise((r) => setTimeout(r, 1500))
    return true`)
  const darkDom = await evaluate(win, DOM_AUDIT)
  const darkImage = await captureAndSave(win, '07-now-playing-dark.png')
  states.push({ name: '正在播放（深色）', dom: darkDom, image: darkImage })

  /* ---------- 状态 5：深色主题的歌曲列表 ---------- */
  await evaluate(win, `
    window.__aria.actions.closeNowPlaying()
    await new Promise((r) => setTimeout(r, 700))
    return true`)
  const darkLibraryDom = await evaluate(win, DOM_AUDIT)
  const darkLibraryImage = await captureAndSave(win, '08-library-dark.png')
  states.push({ name: '歌曲列表（深色）', dom: darkLibraryDom, image: darkLibraryImage })

  // 恢复跟随系统，别把用户设置改掉
  await evaluate(win, `window.__aria.actions.setTheme('system'); return true`)

  /* ---------- 补充检查：有歌词的曲目要在列表里出现角标 ---------- */
  const badgeCheck = await evaluate(win, `
    const { store, actions } = window.__aria
    const track = store.get().library.tracks.find((t) => t.lyricsPath)
    actions.setView('songs')
    actions.setQuery(track ? track.title.slice(0, 6) : '')
    await new Promise((r) => setTimeout(r, 500))
    const badges = document.querySelectorAll('.track-row__badge').length
    const rows = document.querySelectorAll('.track-row').length
    actions.setQuery('')
    return { title: track?.title || '', badges, rows }`)
  console.log('【有歌词曲目的角标】')
  console.log(`  搜索「${badgeCheck.title.slice(0, 6)}」→ ${badgeCheck.rows} 行，其中带歌词角标 ${badgeCheck.badges} 行\n`)

  /* ---------- 输出 ---------- */
  console.log('\n=== 视觉审计 ===\n')
  for (const state of states) {
    console.log(`【${state.name}】`)
    const { dom, image } = state
    console.log(`  主题 ${dom.theme} / 平台 ${dom.platform} / 视口 ${dom.viewport.w}×${dom.viewport.h} @${dom.viewport.dpr}x`)
    console.log(`  令牌 accent=${dom.tokens.accent} tint=${dom.tokens.tint} separator=${dom.tokens.separator}`)
    console.log(`  侧边栏 ${JSON.stringify(dom.sidebar?.rect)} bg=${dom.sidebar?.background} 毛玻璃=${dom.sidebar?.backdrop}`)
    console.log(`  播放条 ${JSON.stringify(dom.playerBar?.rect)} bg=${dom.playerBar?.background}`)
    console.log(`  大标题 ${dom.largeTitle?.fontSize}/${dom.largeTitle?.fontWeight} color=${dom.largeTitle?.color}`)
    console.log(`  主播放键 ${JSON.stringify(dom.playButton?.rect)} bg=${dom.playButton?.background} 圆角=${dom.playButton?.radius}`)
    console.log(`  列表行数=${dom.counts.rows}（带歌词角标 ${dom.counts.visibleRowsWithLyrics}）歌词行=${dom.counts.lyricsLines} 高亮=${dom.counts.activeLyrics} 标签页=${dom.counts.tabs} 设置卡片=${dom.counts.settingsCards}`)
    console.log(`  模式分段控件 ${JSON.stringify(dom.modeSegment?.rect)} 项数=${dom.modeSegmentItems} 滑块=${JSON.stringify(dom.modeSegmentThumb?.rect)}`)
    console.log(`  设置页开关 ${JSON.stringify(dom.settingsSwitch?.rect)} 开关色=${dom.settingsSwitch?.background}`)
    console.log(`  封面 ${dom.artwork ? `已加载=${dom.artwork.loaded} 尺寸=${dom.artwork.natural.join('×')}` : '无'}`)
    if (dom.lyricTypography) {
      console.log(`  歌词字号 高亮=${dom.lyricTypography.activeSize} 其它=${dom.lyricTypography.idleSize} 位移=${dom.lyricTypography.innerTransform}`)
    }
    console.log(`  溢出 横向=${dom.overflow.horizontal} 纵向=${dom.overflow.vertical}`)
    console.log(`  位图 ${image.size.join('×')} 整体亮度=${image.whole.luma} 对比=${image.whole.contrast}`)
    console.log(`    侧栏 rgb=${image.sidebar.rgb} 亮度=${image.sidebar.luma}`)
    console.log(`    内容 rgb=${image.content.rgb} 亮度=${image.content.luma} 对比=${image.content.contrast}`)
    console.log(`    底部条 rgb=${image.playerBar.rgb} 封面区 rgb=${image.playerArtwork.rgb} 对比=${image.playerArtwork.contrast}`)
    console.log('')
  }

  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'audit.json'),
    JSON.stringify(states, null, 2),
    'utf8'
  )
  console.log(`审计数据已写入 ${path.join(OUTPUT_DIR, 'audit.json')}\n`)
  return true
}

async function captureAndSave (win, file) {
  const image = await win.webContents.capturePage()
  await fsp.writeFile(path.join(OUTPUT_DIR, file), image.toPNG())
  return analyzeImage(image)
}

module.exports = { runVisualAudit, analyzeImage }
