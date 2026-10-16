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
    ['01-library.png', '歌曲列表', async () => {
      // 几何量测：内容区顶部那条「白条」到底是谁画的（工具条 vs 大标题 vs 舞台）
      await evaluate(win, `
        console.log('[band] ' + JSON.stringify((() => {
          const vis = (sel) => [...document.querySelectorAll(sel)].find((el) => el.getBoundingClientRect().height > 0)
          const b = (sel) => { const el = vis(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
          const cs = (sel) => { const el = vis(sel); if (!el) return null; const c = getComputedStyle(el); return { pos: c.position, bg: c.backgroundColor, bf: (c.backdropFilter || c.webkitBackdropFilter || '').slice(0, 40), h: c.height, top: c.top } }
          const tb = vis('.view-toolbar')
          const r = tb ? tb.getBoundingClientRect() : null
          const body = vis('.view-body')
          return {
            dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight,
            toolbar: b('.view-toolbar'), header: b('.view-header'), body: b('.view-body'),
            stage: b('.stage'), inner: b('.content-inner'),
            toolbarStyle: cs('.view-toolbar'),
            stuck: tb ? tb.classList.contains('is-stuck') : null,
            scrollTop: body ? body.scrollTop : null,
            at: r ? [[500, r.top + 4], [500, r.top + r.height / 2], [500, r.bottom + 6], [500, r.bottom + 40]].map((p) => {
              const el = document.elementFromPoint(p[0], p[1])
              return { x: p[0], y: Math.round(p[1]), el: el ? (el.className || el.tagName).toString().slice(0, 28) : null }
            }) : null
          }
        })())); return true`)
      await sleep(200)
      // 滚动后（is-stuck）的样子：工具条现在没有底色，靠 0.5px 分隔线 + 紧凑标题立结构，
      // 这里量一下它在滚动前后到底有没有出现，量完滚回去（截图仍是未滚动状态）
      await evaluate(win, `
        const vp = document.querySelector('.tracklist__viewport')
        const tb = [...document.querySelectorAll('.view-toolbar')].find((el) => el.getBoundingClientRect().height > 0)
        const title = tb ? tb.querySelector('.view-toolbar__title') : null
        const read = (tag) => {
          const c = getComputedStyle(tb)
          const t = title ? getComputedStyle(title) : null
          return { tag, stuck: tb.classList.contains('is-stuck'), border: c.borderBottomColor, bw: c.borderBottomWidth, titleOpacity: t ? t.opacity : null, bg: c.backgroundColor }
        }
        const before = read('未滚动')
        if (vp) { vp.scrollTop = 120; vp.dispatchEvent(new Event('scroll')) }
        await new Promise((r) => setTimeout(r, 400))
        const after = read('滚动 120px')
        if (vp) { vp.scrollTop = 0; vp.dispatchEvent(new Event('scroll')) }
        await new Promise((r) => setTimeout(r, 400))
        console.log('[stuck] ' + JSON.stringify({ before, after, restored: read('滚回顶部') }))
        return true`)
      await sleep(300)
    }],
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
      await evaluate(win, `console.log('[sidebar] ' + JSON.stringify((() => {
        const b = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
        const inside = [...document.querySelectorAll('body *')].map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.width > 40 && x.r.height > 10 && x.r.left >= 0 && x.r.right <= 250)
        return inside.slice(0, 22).map((x) => Object.assign({ c: (x.el.className || x.el.tagName).toString().slice(0, 22) }, b(x.el)))
      })())); return true`)
      await sleep(200)
      await evaluate(win, `console.log('[albums] ' + JSON.stringify((() => {
        const vis = (sel) => [...document.querySelectorAll(sel)].find((el) => el.getBoundingClientRect().height > 0)
        const b = (el) => el ? { x: Math.round(el.getBoundingClientRect().left), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null
        const cards = [...document.querySelectorAll('.cover-card')].slice(0, 6).map(b)
        return { grid: b(vis('.cover-grid')), header: b(vis('.view-header__title')), sub: b(vis('.view-header__subtitle')), toolMeta: b(vis('.view-toolbar__meta')), cards }
      })())); return true`)
      await sleep(200)
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
    ['11-artists.png', '艺人列表（头像按艺人名在线查，等首批到位再拍）', async () => {
      await evaluate(win, `window.__aria.actions.setView('artists'); return true`)
      await sleep(600)
      /*
       * 艺人头像现在是**按艺人名在线查**的（不再借某首歌的专辑封面），
       * 所以首屏会先显示首字母占位、再逐个换成照片 —— 不等一下就会拍到"一屏首字母"。
       * 第一批之前要付一次维基超时，之后每位约 0.3s（服务端串行 + 350ms 最小间隔），
       * 所以这里给 25s 预算，够 6 位到位即可。
       */
      await waitFor(win,
        `[...document.querySelectorAll('.artist-row__avatar img')].filter((img) => img.complete && img.naturalWidth > 0).length >= 6`,
        { timeout: 25000, label: '艺人列表头像' })
      await sleep(600)
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
    }],
    // 深色下的灵动岛：这颗胶囊只在深色里才最容易「看不见」，留一张对照图
    ['18-island-dark.png', '深色下的灵动岛（收起侧栏）', async () => {
      await evaluate(win, `
        const { actions, store } = window.__aria
        await actions.setSetting({ theme: 'dark' })
        // 灵动岛只在侧栏收起时出现，所以要把它收起来（不是展开）
        if (store.get().ui.sidebarVisible) actions.toggleSidebar()
        actions.setView('songs')
        await new Promise((r) => setTimeout(r, 1400))
        return true`)
      await sleep(900)
    }],
    // 多选：歌曲列表上选中几首，工具条给出批量动作
    ['19-selection.png', '批量选择歌曲', async () => {
      await evaluate(win, `
        const { actions, store } = window.__aria
        await actions.setSetting({ theme: 'system' })
        actions.setView('songs')
        actions.setSource({ type: 'all', value: null })
        actions.setQuery('')
        if (!store.get().ui.sidebarVisible) actions.toggleSidebar()
        await new Promise((r) => setTimeout(r, 1400))
        const tracks = actions.currentListTracks()
        // 走「开始多选」这条真实入口，截图里才会是勾选状态
        actions.startSelection(tracks[2] && tracks[2].id)
        actions.setSelection([2, 3, 4, 5, 6].map((index) => tracks[index] && tracks[index].id).filter(Boolean))
        await new Promise((r) => setTimeout(r, 700))
        return true`)
      await sleep(900)
    }],
    // 设置页的信息悬浮窗：必须走**鼠标**路径（键盘 focus 是另一条分支，位置算法不同）
    ['20-settings-tip.png', '设置页：信息悬浮窗的位置', async () => {
      await evaluate(win, `
        const { actions } = window.__aria
        actions.setQuery('')
        actions.setView('settings')
        await new Promise((r) => setTimeout(r, 1200))
        // 挑一个靠右的 ⓘ（工具栏/行尾附近最容易看出错位），拿到它的中心点当光标位置
        // 几何量测：把「同一条左边线、行高节奏、ⓘ 与标题垂直居中」变成数字
        {
          const rows = [...document.querySelectorAll('.settings__row')].slice(0, 10).map((r) => {
            const b = r.getBoundingClientRect()
            const t = r.querySelector('.settings__row-title')
            const i = r.querySelector('.settings__info')
            const tb = t ? t.getBoundingClientRect() : null
            const ib = i ? i.getBoundingClientRect() : null
            return {
              h: Math.round(b.height),
              titleX: tb ? Math.round(tb.left) : null,
              titleMidY: tb ? tb.top + tb.height / 2 : null,
              infoMidY: ib ? ib.top + ib.height / 2 : null
            }
          })
          const uniq = (list) => [...new Set(list.filter((v) => v != null))]
          const card = document.querySelector('.settings__card')
          const settingsScroll = document.querySelector('.settings.scroll')
          const head = settingsScroll ? settingsScroll.parentElement.querySelector('.view-header__title') : null
          const groupTitles = [...document.querySelectorAll('.settings__group-title')]
          const scopedSettings = document.querySelector('.settings.scroll') || document
          const style = (sel, root) => {
            const el = (root || scopedSettings).querySelector(sel)
            if (!el) return null
            const cs = getComputedStyle(el)
            return { size: cs.fontSize, weight: cs.fontWeight, lh: cs.lineHeight }
          }
          console.log('[type] ' + JSON.stringify({
            doc: getComputedStyle(document.body).fontSize,
            largeTitle: style('.view-header__title', document),
            groupTitle: style('.settings__group-title'),
            rowTitle: style('.settings__row-title'),
            rowValue: style('.settings__row-value'),
            navItem: style('.settings-nav__item'),
            navItemVisible: style('.settings-nav__item', document),
            boxes: (() => {
              const v = (sel) => [...document.querySelectorAll(sel)].find((el) => el.getBoundingClientRect().height > 0)
              const c = v('.settings.scroll')
              const card = v('.settings__card')
              const row = v('.settings__row')
              const t = v('.settings__row-title')
              const r = (el) => el ? { x: Math.round(el.getBoundingClientRect().left), w: Math.round(el.getBoundingClientRect().width) } : null
              return { container: r(c), card: r(card), row: r(row), rowTitle: r(t) }
            })(),
            info: style('.settings__info')
          }))
          console.log('[geom] ' + JSON.stringify({
            rowDetail: [...document.querySelectorAll('.settings__row')].slice(0, 14).map((r) => {
              const rect = r.getBoundingClientRect()
              const sw = r.querySelector('.switch')
              const sel = r.querySelector('select')
              const btn = r.querySelector('.btn')
              const slider = r.querySelector('.slider')
              const kind = sw ? 'switch' : (sel ? 'select' : (slider ? 'slider' : (btn ? 'button' : 'text')))
              const node = sw || sel || slider || btn
              const nb = node ? node.getBoundingClientRect() : null
              const title = r.querySelector('.settings__row-title')
              const tb = title ? title.getBoundingClientRect() : null
              return {
                t: (r.textContent || '').trim().slice(0, 6),
                rowH: Math.round(rect.height),
                kind,
                ctrlH: nb ? Math.round(nb.height) : null,
                lineH: tb ? Math.round(tb.height) : null
              }
            }),
            rowHeights: uniq(rows.map((r) => r.h)),
            titleXs: uniq(rows.map((r) => r.titleX)),
            infoOffsetY: uniq(rows.map((r) => (r.infoMidY != null && r.titleMidY != null) ? Math.round((r.infoMidY - r.titleMidY) * 10) / 10 : null)),
            groupTitleXs: uniq(groupTitles.map((g) => Math.round(g.getBoundingClientRect().left))),
            groupDetail: groupTitles.map((g) => ({
              text: (g.textContent || "").slice(0, 6),
              x: Math.round(g.getBoundingClientRect().left),
              inHead: Boolean(g.closest(".settings__group-head")),
              row: g.closest(".settings__group") ? Math.round(g.closest(".settings__group").getBoundingClientRect().left) : null
            })),
            cardX: card ? Math.round(card.getBoundingClientRect().left) : null,
            cardW: card ? Math.round(card.getBoundingClientRect().width) : null,
            headX: head ? Math.round(head.getBoundingClientRect().left) : null,
            headY: head ? Math.round(head.getBoundingClientRect().top) : null
          }))
        }
        const infos = [...document.querySelectorAll('.settings__info')]
        const pick = infos.find((n) => n.getBoundingClientRect().left > window.innerWidth * 0.55) || infos[0]
        const rect = pick.getBoundingClientRect()
        pick.dispatchEvent(new MouseEvent('mouseenter', {
          bubbles: false,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2)
        }))
        await new Promise((r) => setTimeout(r, 400))
        const tip = document.querySelector('.setting-tip')
        console.log(JSON.stringify({
          icon: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width) },
          tipHidden: tip ? tip.hidden : null,
          tip: tip ? { x: Math.round(tip.getBoundingClientRect().left), y: Math.round(tip.getBoundingClientRect().top), w: Math.round(tip.getBoundingClientRect().width), h: Math.round(tip.getBoundingClientRect().height) } : null
        }))
        return true`)
      await sleep(900)
    }],
    /*
     * macOS 标题栏的**模拟**核对（本机没有 Mac，这是能在 Windows 上做到的最接近的验证）。
     *
     * 做法：把 `data-platform` 切成 darwin（CSS 里有两条 darwin 规则：标题栏高度 46px、
     * 左侧给红黄绿留 84px），并摘掉自绘的窗口按钮 —— 真机上这一步由 titlebar.js 按 isMac 跳过。
     * 这不是真机截图，只用来确认 mac 分支的布局没崩：标题不压在圆点区域、右侧控件不溢出、
     * 内容区仍从侧栏右边开始。真机外观仍需要朋友那边确认。
     */
    ['21-mac-titlebar-emulated.png', 'macOS 标题栏（模拟 data-platform=darwin，非真机截图）', async () => {
      await evaluate(win, `
        const { actions } = window.__aria
        actions.setView('songs')
        document.documentElement.dataset.platform = 'darwin'
        document.querySelectorAll('.win-controls').forEach((node) => node.remove())
        // 上一条截图（设置页提示浮窗）留下的 fixed 浮层会飘到这张图上：鼠标没真的移开，它不会自己收
        document.querySelectorAll('.setting-tip').forEach((node) => node.remove())
        await new Promise((r) => setTimeout(r, 800))
        return true`)
      await sleep(400)
      await evaluate(win, `
        console.log('[mac-emu] ' + JSON.stringify((() => {
          const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
          const app = document.querySelector('.titlebar__app')
          return {
            platform: document.documentElement.dataset.platform,
            titlebarH: getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h').trim(),
            titlebar: box('.titlebar'),
            titlebarApp: box('.titlebar__app'),
            winControls: document.querySelectorAll('.win-controls').length,
            stage: box('.stage'),
            appTitleUnderTrafficLights: app ? Math.round(app.getBoundingClientRect().left) < 84 : null,
            overflowX: document.documentElement.scrollWidth - window.innerWidth
          }
        })())); return true`)
      await sleep(300)
    }],
    /*
     * 快捷键文案的**模拟**核对：macOS 上应该是 ⌘ / ⌥，而不是写死的 Ctrl / Alt。
     * 先切走再切回设置页，逼它重建一遍（文案在渲染时按平台生成）。
     */
    ['22-mac-shortcuts-emulated.png', 'macOS 快捷键文案（模拟：⌘ / ⌥）', async () => {
      await evaluate(win, `
        const { actions } = window.__aria
        document.documentElement.dataset.platform = 'darwin'
        actions.setView('songs')
        await new Promise((r) => setTimeout(r, 300))
        actions.setView('settings')
        await new Promise((r) => setTimeout(r, 900))
        document.querySelectorAll('.setting-tip').forEach((n) => n.remove())
        const nav = [...document.querySelectorAll('.settings-nav__item')].find((n) => n.textContent.includes('外观'))
        nav?.click()
        await new Promise((r) => setTimeout(r, 700))
        // 再把「快捷键」那一组滚到顶上，截图里才看得到 ⌘ / ⌥ 的写法
        const head = [...document.querySelectorAll('.settings__group-head, .settings__group-title')]
          .find((n) => (n.textContent || '').trim() === '快捷键')
        head?.scrollIntoView({ block: 'start' })
        await new Promise((r) => setTimeout(r, 500))
        return true`)
      await sleep(400)
      await evaluate(win, `
        console.log('[mac-keys] ' + JSON.stringify((() => {
          const rows = [...document.querySelectorAll('.settings__row')].filter((r) => r.querySelector('.kbd'))
          const keys = rows.map((r) => (r.querySelector('.kbd') || {}).textContent || '')
          return {
            platform: document.documentElement.dataset.platform,
            rows: rows.length,
            keys: keys.slice(0, 10),
            hasCtrl: keys.some((k) => k.includes('Ctrl')),
            hasAlt: keys.some((k) => k.includes('Alt')),
            hasCmd: keys.some((k) => k.includes('⌘'))
          }
        })())); return true`)
      await sleep(300)
    }],
    /*
     * macOS 正在播放页的顶栏（模拟）——这是**最后一条**没验过的 darwin CSS 规则：
     * `html[data-platform="darwin"] .now-playing__topbar { padding-left: 84px }`。
     * 正在播放页是全屏浮层，而窗口是 hiddenInset（红黄绿还在），所以它同样要让出那 84px。
     */
    ['23-mac-nowplaying-emulated.png', 'macOS 正在播放页顶栏（模拟：给红黄绿留 84px）', async () => {
      await evaluate(win, `
        const { actions } = window.__aria
        document.documentElement.dataset.platform = 'darwin'
        actions.setView('songs')
        await new Promise((r) => setTimeout(r, 300))
        actions.openNowPlaying({ lyrics: true })
        await new Promise((r) => setTimeout(r, 1300))
        document.querySelectorAll('.setting-tip').forEach((n) => n.remove())
        return true`)
      await sleep(400)
      await evaluate(win, `
        console.log('[mac-nowplaying] ' + JSON.stringify((() => {
          const bar = document.querySelector('.now-playing__topbar')
          const first = bar ? bar.firstElementChild : null
          const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
          const firstX = first ? Math.round(first.getBoundingClientRect().left) : null
          return {
            platform: document.documentElement.dataset.platform,
            topbar: box(bar),
            paddingLeft: bar ? getComputedStyle(bar).paddingLeft : null,
            firstChild: box(first),
            firstChildUnderTrafficLights: firstX === null ? null : firstX < 84,
            overflowX: document.documentElement.scrollWidth - window.innerWidth
          }
        })())); return true`)
      await sleep(300)
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

  // 示例播放列表只在截图里出现，拍完就删掉，免得留在自动化档案里；
  // 主题也还原成跟随系统
  await evaluate(win, `
    const { actions, store } = window.__aria
    for (const item of actions.playlists()) await actions.deletePlaylist(item.id)
    actions.setSource({ type: 'all', value: null })
    actions.clearSelection()
    await actions.setSetting({ theme: 'system' })
    if (!store.get().ui.sidebarVisible) actions.toggleSidebar()
    return true`)
  await sleep(600)

  console.log(`\n共 ${written.length} 张截图已写入 ${OUTPUT_DIR}\n`)
  return written.length
}

module.exports = { runScreenshots }
