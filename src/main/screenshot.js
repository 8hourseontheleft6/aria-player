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
    ['05-search.png', '搜索', async () => {
      await evaluate(win, `
        window.__aria.actions.toggleQueue(false)
        window.__aria.actions.setQuery('love')
        return true`)
      await sleep(900)
    }],
    ['06-settings.png', '设置', async () => {
      await evaluate(win, `window.__aria.actions.setQuery(''); window.__aria.actions.setView('settings'); return true`)
      await sleep(900)
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

  console.log(`\n共 ${written.length} 张截图已写入 ${OUTPUT_DIR}\n`)
  return written.length
}

module.exports = { runScreenshots }
