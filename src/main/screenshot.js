'use strict'

/**
 * 开发用截图工具：把关键界面截成 PNG，方便审阅视觉与写文档。
 *
 *   npm run shots
 *
 * 输出到 docs/screenshots/。
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
      // 渲染层还没就绪
    }
    await sleep(300)
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 等媒体墙把封面真正加载完再截图。
 *
 * 关键是「连续 1s 出图数量不再增长」，而不是「懒加载队列空了」：
 * 移动整面墙之后，新露出来的格子要等 IntersectionObserver 下一帧回调才会入队，
 * 所以刚平移完的那一刻队列本来就是空的，用队列判断会立刻返回，
 * 截出来的就是一整面浅灰占位图（曾经真的截出过一张几乎全白的「媒体墙」）。
 */
const WAIT_COVERS = `
  {
    let lastCount = -1
    let stableSince = performance.now()
    const deadline = performance.now() + 15000
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400))
      const count = document.querySelectorAll('.wall-tile img[src]').length
      if (count !== lastCount) {
        lastCount = count
        stableSince = performance.now()
      } else if (performance.now() - stableSince > 1000) {
        break
      }
    }
    await new Promise((r) => setTimeout(r, 300))
  }`

async function runScreenshots ({ win }) {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true })
  await waitFor(win, 'window.__aria && window.__aria.store.get().library.loaded === true', { label: '资料库' })

  // 先放一首带歌词的歌，seek 到 40 秒，这样歌词有时间轴高亮
  await evaluate(win, `
    const { store, actions, player } = window.__aria
    const tracks = store.get().library.tracks
    const track = tracks.find((t) => t.lyricsPath) || tracks[0]
    actions.playTrack(track)
    await new Promise((r) => setTimeout(r, 1500))
    player.pause()
    player.seek(40)
    await new Promise((r) => setTimeout(r, 600))
    return true`)

  const shots = [
    ['01-library.png', '歌曲列表', async () => {}],
    ['02-now-playing.png', '正在播放（含歌词）', async () => {
      await evaluate(win, `window.__aria.actions.openNowPlaying({ lyrics: true }); return true`)
      await sleep(1400)
      // 让歌词滚动到中间位置
      await evaluate(win, `
        const player = window.__aria.player
        const lines = window.__aria.store.get().lyrics.lines
        if (lines.length > 12) player.seek(lines[12].time + 0.4)
        await new Promise((r) => setTimeout(r, 1400))
        return true`)
    }],
    ['03-now-playing-info.png', '歌曲信息面板（插件扩展点）', async () => {
      await evaluate(win, `
        const tabs = [...document.querySelectorAll('.now-playing__tab')]
        const target = tabs.find((t) => t.textContent !== '歌词')
        target?.click()
        return true`)
      await sleep(800)
    }],
    ['04-queue.png', '播放队列', async () => {
      await evaluate(win, `
        window.__aria.actions.closeNowPlaying()
        const tracks = window.__aria.store.get().library.tracks
        window.__aria.player.playCollection(tracks.slice(0, 40).map((t) => t.id), tracks[2].id)
        window.__aria.actions.toggleQueue(true)
        return true`)
      await sleep(1200)
    }],
    ['05-search.png', '搜索（含范围切换与搜索历史）', async () => {
      await evaluate(win, `
        const { actions } = window.__aria
        actions.toggleQueue(false)
        // 攒几条历史，让下拉面板里有内容可看
        await actions.clearSearchHistory()
        for (const term of ['love', 'Taylor', 'Blues']) await actions.commitSearch(term)
        actions.setSearchScope('deep')
        actions.setQuery('love')
        await new Promise((r) => setTimeout(r, 400))
        // 搜索默认收起成一颗放大镜，先点开再聚焦（这样范围按钮与历史面板才可见）
        document.querySelector('.search-slot .btn')?.click()
        document.querySelector('.search input')?.focus()
        return true`)
      await sleep(1400)
    }],
    ['06-settings.png', '设置', async () => {
      await evaluate(win, `window.__aria.actions.setQuery(''); window.__aria.actions.setView('settings'); return true`)
      await sleep(900)
    }],
    ['09-albums.png', '专辑网格', async () => {
      await evaluate(win, `window.__aria.actions.setView('albums'); return true`)
      await sleep(1600)
    }],
    ['10-album-detail.png', '专辑详情', async () => {
      await evaluate(win, `
        const { actions } = window.__aria
        const albums = actions.albums()
        // 挑一张曲目最多的专辑，能看出详情页的曲目列表
        const album = albums.slice().sort((a, b) => b.trackCount - a.trackCount)[0]
        actions.openAlbum(album.key)
        return true`)
      await sleep(1600)
    }],
    ['11-artists.png', '艺人列表', async () => {
      await evaluate(win, `window.__aria.actions.setView('artists'); return true`)
      await sleep(1400)
    }],
    ['13-artist-detail.png', '艺人详情', async () => {
      await evaluate(win, `
        const { actions } = window.__aria
        const artists = actions.artists().slice().sort((a, b) => b.trackCount - a.trackCount)
        actions.openArtist(artists[0].key)
        return true`)
      await sleep(1600)
    }],
    ['12-wall.png', '媒体墙（含正在播放聚焦块）', async () => {
      await evaluate(win, `
        const { actions, player, store } = window.__aria
        actions.setView('wall')
        const lines = store.get().lyrics.lines
        if (lines.length > 16) player.seek(lines[16].time + 0.4)
        await player.play()
        await new Promise((r) => setTimeout(r, 2200))

        // 聚焦块现在留在专辑自己的位置上，可能不在首屏 —— 把它平移到画面中央
        const tile = document.querySelector('.wall-tile.is-featured')
        const viewport = document.querySelector('.wall-viewport')
        if (tile && viewport) {
          const vr = viewport.getBoundingClientRect()
          const tr = tile.getBoundingClientRect()
          const dx = (vr.left + vr.width / 2) - (tr.left + tr.width / 2)
          const dy = (vr.top + vr.height / 2) - (tr.top + tr.height / 2)
          viewport.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaX: -dx, deltaY: -dy
          }))
        }
        ${WAIT_COVERS}
        return true`)
      await sleep(1200)
    }],
    ['14-wall-scrolled.png', '媒体墙（斜向拖到中段）', async () => {
      await evaluate(win, `
        // 用滚轮事件做一次斜向平移，验证二维画布
        const viewport = document.querySelector('.wall-viewport')
        viewport.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaX: 700, deltaY: 900
        }))
        ${WAIT_COVERS}
        return true`)
      await sleep(600)
    }],
    ['15-wall-large.png', '媒体墙（大尺寸 + 回到起点）', async () => {
      await evaluate(win, `
        document.querySelector('[data-density="l"]')?.click()
        return true`)
      await sleep(600)
      await evaluate(win, `
        // 回到平面左上角：反向滚轮等量抵消
        const viewport = document.querySelector('.wall-viewport')
        viewport.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaX: -4000, deltaY: -4000
        }))
        ${WAIT_COVERS}
        return true`)
      await sleep(600)
    }],
    // 侧栏收起后的样子：标题栏正中的灵动岛接管导航（两者不同时出现）
    ['16-sidebar-hidden.png', '收起侧栏（灵动岛接管导航）', async () => {
      await evaluate(win, `
        const { actions, store } = window.__aria
        actions.setView('songs')
        if (store.get().ui.sidebarVisible) actions.toggleSidebar()
        await new Promise((r) => setTimeout(r, 900))
        return true`)
      await sleep(900)
    }],
    // 自建播放列表：拍完就把示例列表删掉，别留在自动化档案里污染后面的截图
    ['17-playlist.png', '自建播放列表', async () => {
      await evaluate(win, `
        const { actions, store } = window.__aria
        if (!store.get().ui.sidebarVisible) actions.toggleSidebar()
        for (const item of actions.playlists()) await actions.deletePlaylist(item.id)
        const created = await actions.createPlaylist('深夜通勤')
        const tracks = store.get().library.tracks
        const picked = [tracks[0], tracks[5], tracks[12], tracks[30], tracks[48]].filter(Boolean)
        await actions.addTracksToPlaylist(created.id, picked.map((t) => t.id), { silent: true })
        actions.openPlaylist(created.id)
        await new Promise((r) => setTimeout(r, 1200))
        return true`)
      await sleep(1200)
    }]
  ]

  const written = []
  for (const [file, label, prepare] of shots) {
    await prepare()
    await sleep(350)
    const image = await win.webContents.capturePage()
    const target = path.join(OUTPUT_DIR, file)
    await fsp.writeFile(target, image.toPNG())
    written.push(`${file}（${label}）`)
    console.log(`  ✓ ${file} — ${label}`)
  }

  // 示例播放列表只在截图里出现，拍完就删掉，免得留在自动化档案里
  await evaluate(win, `
    const { actions } = window.__aria
    for (const item of actions.playlists()) await actions.deletePlaylist(item.id)
    actions.setSource({ type: 'all', value: null })
    return true`)
  await sleep(400)

  console.log(`\n共 ${written.length} 张截图已写入 ${OUTPUT_DIR}\n`)
  return written.length
}

module.exports = { runScreenshots }
