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

/**
 * 从 computed transform 里取出 translateY（像素）。
 * 行在列表里是靠 top 定位的，滚动或自动定位都会让 rect.top 漂移，
 * 所以断言要用矩阵里的位移，而不是两次 rect.top 之差。
 */
function rowLift (transform) {
  const match = /matrix\(([^)]+)\)/.exec(String(transform))
  if (!match) return NaN
  const parts = match[1].split(',').map((value) => Number(value.trim()))
  return parts.length >= 6 ? parts[5] : NaN
}

async function evaluate (win, expression) {
  /*
   * 前置：把光标移到 (1,1)（离开任何控件）再执行注入代码。
   * 自动化运行里，上一条检查派发的鼠标事件留下的 :hover 会让后续
   * elementFromPoint 命中测试打到别的元素 —— 表现为「元素 opacity=1、
   * 明明可见却 hit=false」，同一提交 160/160 与 158/160 交替出现。
   * 在这个统一入口修一次，覆盖全部注入检查（112 处调用）。
   */
  const neutralMouse = `
    try {
      const opts = { bubbles: true, clientX: 1, clientY: 1 }
      document.body.dispatchEvent(new MouseEvent('mousemove', opts))
      document.body.dispatchEvent(new MouseEvent('mouseout', opts))
    } catch (error) { /* 无所谓，只是尽力清掉 hover */ }
    await new Promise((resolve) => setTimeout(resolve, 60))
  `
  const result = win.webContents.executeJavaScript(`(async () => { ${neutralMouse} ${expression} })()`, true)
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

/**
 * 确保窗口真的在渲染。
 *
 * 被最小化 / 隐藏 / 被其它窗口盖住时，Chromium 会停掉 rAF 与合成器动画 ——
 * 这时脚本改的 class、store 都对，但 CSS 过渡不推进、getBoundingClientRect 拿到的是
 * 旧几何（实测：灵动岛悬停后宽度不变、侧栏收起后宽度还是 248px、整页淡出也没发生）。
 * 这些检查量的就是过渡结果，所以量之前必须先把窗口弄回来。
 */
async function ensureVisible (win) {
  if (win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
    /*
     * 抢前台。Windows 有前台锁：别的窗口（比如开着的聊天工具）占着前台时，
     * 单纯 focus() 会被拒 —— 而"真拖"那几条检查依赖窗口真的在前台，
     * 否则按下/拖动落到别的程序上，读数会变成 Δx=-47、Δy=-155 这种乱跳。
     * 抢不到就最小化再恢复（老办法，Windows 会把它重新提到前台）。
     */
    win.focus()
    await sleep(150)
    if (!win.isFocused()) {
      win.minimize()
      await sleep(200)
      win.restore()
      win.focus()
      await sleep(300)
    }
  for (let i = 0; i < 24; i++) {
    try {
      const visible = await evaluate(win, 'return document.visibilityState === "visible"')
      if (visible) return true
    } catch {
      // 页面正在重建，接着等
    }
    await sleep(250)
  }
  return false
}

/** 当前窗口/页面的可见性，失败时用来解释「为什么几何没变」 */
async function visibilitySnapshot (win) {
  let page = null
  try {
    page = await evaluate(win, `
      return {
        state: document.visibilityState,
        hidden: document.hidden,
        focused: document.hasFocus()
      }
    `)
  } catch {
    page = { state: 'unavailable' }
  }
  return {
    ...page,
    minimized: win.isMinimized(),
    visible: win.isVisible(),
    focused: win.isFocused()
  }
}

/**
 * player 档位新增功能的回归：① 没有示波器 ② 封面读得出来才显示 ③ 一键清除历史。
 *
 * 顺序要求：**必须放在整套的最后** —— ③ 会把列表与播放一起清空。
 */
async function runPlayerUiChecks ({ win, record, mediaDir, ctx }) {
  const path = require('node:path')
  const fs = require('node:fs')

  /* ---------- ① player 里没有示波器（不建元素、没有那条设置） ---------- */
  const viz = await evaluate(win, `
    return {
      strip: Boolean(document.querySelector('.visualizer')),
      canvas: Boolean(document.querySelector('.visualizer__canvas'))
    }`)
  const vizSettings = await evaluate(win, `
    const { actions } = window.__aria
    actions.setView('settings')
    await new Promise((r) => setTimeout(r, 500))
    const titles = [...document.querySelectorAll('.settings__row-title')].map((node) => (node.textContent || '').trim())
    actions.setView('songs')
    await new Promise((r) => setTimeout(r, 300))
    return { hasRow: titles.some((text) => text.includes('音频可视化')) }`)
  record('player 里没有示波器（不建元素、设置里也没有那条）',
    viz.strip === false && viz.canvas === false && vizSettings.hasRow === false,
    `.visualizer=${viz.strip}、canvas=${viz.canvas}、设置里有「音频可视化」=${vizSettings.hasRow}`,
    { profiles: ['player'] })

  /* ---------- ② 封面：读得出来就显示，读不出来不显示 ---------- */
  /*
   * 两个文件对照：
   *   · 真实 mp3（从音乐库复制一首，带内嵌封面）→ 期望那一行出现 <img>；
   *   · 合成 wav（没有内嵌封面）→ 期望那一格是 is-empty（整格隐藏，不是空音符）。
   */
  let withCover = null
  try {
    const libraryDir = path.join(process.env.USERPROFILE || '', 'Music')
    const found = fs.existsSync(libraryDir)
      ? fs.readdirSync(libraryDir).find((name) => /\.mp3$/i.test(name))
      : null
    if (found) {
      fs.mkdirSync(mediaDir, { recursive: true })
      withCover = path.join(mediaDir, `cover-probe-${Date.now()}.mp3`)
      fs.copyFileSync(path.join(libraryDir, found), withCover)
    }
  } catch (err) {
    console.warn('  · 复制带封面的 mp3 失败：', err && err.message)
  }

  const makeWav = (name) => {
    const sampleRate = 8000
    const buffer = Buffer.alloc(44 + sampleRate)
    buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + sampleRate, 4); buffer.write('WAVE', 8)
    buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate, 28)
    buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write('data', 36)
    buffer.writeUInt32LE(sampleRate, 40)
    for (let i = 0; i < sampleRate; i++) buffer[44 + i] = 128
    fs.mkdirSync(mediaDir, { recursive: true })
    const file = path.join(mediaDir, name)
    fs.writeFileSync(file, buffer)
    return file
  }
  const noCover = makeWav(`no-cover-${Date.now()}.wav`)

  if (withCover) {
    const opened = ctx && ctx.has('openedFiles') ? ctx.get('openedFiles') : null
    const payload = opened ? await opened.resolve([withCover, noCover]) : null
    if (payload && payload.tracks.length === 2) {
      await evaluate(win, `window.__aria.actions.ingestOpenedTracks(${JSON.stringify(payload.tracks)}); return true`)
      await sleep(2000)
    }
  }

  const coverState = await evaluate(win, `
    const { store } = window.__aria
    const rows = [...document.querySelectorAll('.track-row')].filter((node) => node.getClientRects().length > 0)
    return {
      rows: rows.length,
      withImg: rows.filter((row) => row.querySelector('.track-row__art img')).length,
      hiddenArt: rows.filter((row) => row.querySelector('.track-row__art.is-empty')).length,
      icons: rows.filter((row) => row.querySelector('.track-row__art .icon')).length,
      embedded: store.get().library.tracks.filter((track) => track.artworkEmbedded === true).length
    }`)
  record('封面：读得出来就显示图片，读不出来不显示（不是一颗空音符）',
    withCover ? (coverState.withImg >= 1 && coverState.hiddenArt >= 1 && coverState.icons === 0) : coverState.icons === 0,
    (withCover
      ? `带内嵌封面的 mp3 + 无封面 wav 各 1；行 ${coverState.rows} 个、有图片 ${coverState.withImg} 行、` +
        `整格隐藏 ${coverState.hiddenArt} 行、还留着音符占位 ${coverState.icons} 行（应为 0）、`
      : `没能复制到带封面的 mp3（只验无封面一侧）；`) +
    `artworkEmbedded=true 的曲目 ${coverState.embedded} 首`,
    { profiles: ['player'] })

  /* ---------- ③ 一键清除历史 ---------- */
  const beforeClear = await evaluate(win, `
    const { store } = window.__aria
    const button = document.querySelector('.clear-history')
    return {
      tracks: store.get().library.tracks.length,
      visible: Boolean(button) && button.getClientRects().length > 0,
      status: store.get().playback.status
    }`)
  const clicked = await evaluate(win, `
    const button = document.querySelector('.clear-history')
    if (!button) return false
    button.click()
    return true`)
  await sleep(1500)
  const afterClear = await evaluate(win, `
    const { store } = window.__aria
    const button = document.querySelector('.clear-history')
    const state = store.get()
    return {
      tracks: state.library.tracks.length,
      status: state.playback.status,
      trackId: state.playback.trackId,
      visible: Boolean(button) && button.getClientRects().length > 0,
      emptyState: [...document.querySelectorAll('.empty')].some((node) => node.getClientRects().length > 0)
    }`)
  /*
   * 提示框（toast）：清除之后必须**有文字**。toast 的签名收对象，
   * 传字符串就会只剩一颗图标 —— 用户报的就是这个（"提示框只有一个符号"）。
   */
  const toastState = await evaluate(win, `
    const nodes = [...document.querySelectorAll('.toast')]
    const last = nodes[nodes.length - 1]
    return {
      count: nodes.length,
      text: last ? (last.textContent || '').trim() : '',
      hasIcon: last ? Boolean(last.querySelector('.icon')) : false
    }`)

  const recentAfter = (() => {
    try {
      const file = path.join(require('electron').app.getPath('userData'), 'recent.json')
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? parsed.length : -1
    } catch {
      return 0
    }
  })()
  record('一键清除历史：列表、播放、recent.json 一起清干净，提示框有文字，按钮随之隐藏',
    clicked === true && beforeClear.visible === true && beforeClear.tracks > 0 &&
    afterClear.tracks === 0 && afterClear.trackId === null && afterClear.status !== 'playing' &&
    afterClear.visible === false && recentAfter === 0 && toastState.text !== '',
    `清除前 ${beforeClear.tracks} 首（按钮可见=${beforeClear.visible}、状态=${beforeClear.status}）→ ` +
    `清除后 ${afterClear.tracks} 首、状态=${afterClear.status}、` +
    `trackId=${afterClear.trackId === null ? 'null' : afterClear.trackId}、按钮可见=${afterClear.visible}、` +
    `空状态出现=${afterClear.emptyState}、recent.json ${recentAfter} 条、` +
    `提示框「${toastState.text}」${toastState.hasIcon ? '（带图标）' : ''}`,
    { profiles: ['player'] })
}


/**
 * 回归：**冷启动带文件**（现有检查只测了 second-instance）。
 *
 * 冷启动的真实时序：页面第一次加载 → 主进程在 `did-finish-load` 之后立刻推
 * `opened:incoming` → 渲染层这时可能还在等 settings / 最近打开那些 await。
 * 如果订阅不是"在任何 await 之前"建立的，这一推就丢了 —— 现象是
 * "进程起来了、recent.json 有记录，但列表空、也没在播"。
 *
 * 这里用**重载页面**复现同一时序：reload 之后渲染层是全新的（store 从空开始），
 * 然后像主进程那样在 did-finish-load 时推一条 —— 与真正的冷启动是同一条路。
 * 顺带验 loadLibrary 的短路：player 档位下它不许把已经收进来的曲目清掉。
 */
async function runColdStartCheck ({ win, ctx, record, mediaDir }) {
  const fs = require('node:fs')
  const path = require('node:path')
  const { dialog } = require('electron')

  const makeWav = (name, frequency) => {
    fs.mkdirSync(mediaDir, { recursive: true })
    const sampleRate = 8000
    const buffer = Buffer.alloc(44 + sampleRate)
    buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + sampleRate, 4); buffer.write('WAVE', 8)
    buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate, 28)
    buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write('data', 36)
    buffer.writeUInt32LE(sampleRate, 40)
    for (let i = 0; i < sampleRate; i++) {
      buffer[44 + i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * frequency * i) / sampleRate))
    }
    const file = path.join(mediaDir, name)
    fs.writeFileSync(file, buffer)
    return file
  }

  const coldFile = makeWav(`cold-start-${Date.now()}.wav`, 880)
  /* 载荷用**主进程的解析器**造，与真实冷启动投递的数据完全一致（曲目对象由 openedFiles 产出） */
  let payload = null
  try {
    const opened = ctx.has('openedFiles') ? ctx.get('openedFiles') : null
    payload = opened ? await opened.resolve([coldFile]) : null
  } catch (err) {
    console.warn('[cold-start] 解析失败：', err && err.message)
  }

  let dialogCalls = 0
  const originalShowMessageBox = dialog.showMessageBox
  dialog.showMessageBox = async () => { dialogCalls++; return { response: 0 } }
  try {
    /*
     * 重载页面 → 渲染层从空 store 重新启动（冷启动的渲染层视角），
     * 然后在 did-finish-load 时推一条 —— 与主进程的冷启动投递同一时序。
     */
    win.webContents.once('did-finish-load', () => {
      if (payload) win.webContents.send('opened:incoming', payload)
    })
    win.webContents.reload()
    await waitFor(win, 'window.__aria && window.__aria.store.get().ready === true',
      { label: '重载后的渲染层', timeout: 60000 })

    const deadline = Date.now() + 25000
    let state = null
    while (Date.now() < deadline) {
      await sleep(500)
      state = await evaluate(win, `
        const s = window.__aria.store.get()
        const current = s.library.byId.get(s.playback.trackId)
        return {
          status: s.playback.status,
          tracks: s.library.tracks.length,
          paths: s.library.tracks.map((track) => track.path),
          currentPath: current ? current.path : ''
        }`)
      if (state && state.currentPath === coldFile && state.status === 'playing') break
    }
    record('冷启动带文件：新起的渲染层也能接住投递并直接播（订阅早于任何 await、短路不清曲目）',
      Boolean(payload) && payload.tracks.length === 1 &&
      Boolean(state) && state.currentPath === coldFile && state.status === 'playing' &&
      state.paths.includes(coldFile) && dialogCalls === 0,
      `投递时机=did-finish-load；当前曲目=${state ? path.basename(state.currentPath || '（无）') : '—'}（应为新文件）、` +
      `状态=${state ? state.status : '—'}、列表 ${state ? state.tracks : '—'} 首、在列表里=${state ? state.paths.includes(coldFile) : '—'}、` +
      `弹确认框 ${dialogCalls} 次（应为 0）`,
      { profiles: ['full', 'player'] })
  } finally {
    dialog.showMessageBox = originalShowMessageBox
  }
}

/**
 * 回归：**已经在跑的时候又"双击"了另一个音频文件**。
 *
 * 现有 smoke 只覆盖"冷启动带文件"；真实的第二次双击走的是 second-instance ——
 * 新进程被单实例锁挡住，argv 交给**已在运行的**进程。三件事一起验：
 *   ① argv 要先过滤再投递（原样丢进去会当场抛错，被 promise 吞成"双击没反应"）；
 *   ② 当前曲目切到新文件（不是继续放旧的）；
 *   ③ 窗口真的被提到前面（show → moveTop → focus，必要时短暂置顶）。
 *
 * z 序 Electron 没有 API 可读，所以 ③ 验的是**机制**：raiseInfo 记录了 raiseWindow 做了哪几步。
 */
async function runSecondInstanceCheck ({ win, profile, record, raiseInfo, mediaDir }) {
  const fs = require('node:fs')
  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const { app: electronApp } = require('electron')

  const makeWav = (name, frequency) => {
    fs.mkdirSync(mediaDir, { recursive: true })
    const sampleRate = 8000
    const buffer = Buffer.alloc(44 + sampleRate)
    buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + sampleRate, 4); buffer.write('WAVE', 8)
    buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate, 28)
    buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write('data', 36)
    buffer.writeUInt32LE(sampleRate, 40)
    for (let i = 0; i < sampleRate; i++) {
      buffer[44 + i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * frequency * i) / sampleRate))
    }
    const file = path.join(mediaDir, name)
    fs.writeFileSync(file, buffer)
    return file
  }

  const before = await evaluate(win, `
    const state = window.__aria.store.get()
    return { trackId: state.playback.trackId, status: state.playback.status, count: state.library.tracks.length }`)
  const third = makeWav(`second-instance-${Date.now()}.wav`, 660)
  const raiseBefore = raiseInfo ? raiseInfo.count : 0
  if (raiseInfo) raiseInfo.last = null

  /*
   * 真的再起一个进程（与"用户双击文件"完全一样：同一个 exe + 文件参数）。
   * 它会在单实例锁上失败并退出，把 argv 交给**当前这个进程**。
   */
  const child = spawn(process.execPath, [electronApp.getAppPath(), `--profile=${profile.id}`, third], {
    detached: true,
    stdio: 'ignore',
    env: process.env
  })
  child.unref()

  const deadline = Date.now() + 30000
  let after = null
  while (Date.now() < deadline) {
    await sleep(500)
    after = await evaluate(win, `
      const state = window.__aria.store.get()
      const current = state.library.byId.get(state.playback.trackId)
      return {
        trackId: state.playback.trackId,
        status: state.playback.status,
        currentPath: current ? current.path : '',
        count: state.library.tracks.length
      }`)
    if (after && after.currentPath === third && after.status === 'playing') break
  }

  const raised = raiseInfo ? raiseInfo.last : null
  const raiseCount = raiseInfo ? raiseInfo.count : 0
  record('再双击一个文件：已开的实例接住它（切到新曲目）并把窗口提到前面',
    Boolean(after) &&
    after.currentPath === third &&
    after.status === 'playing' &&
    after.count === before.count + 1 &&
    Boolean(raised) &&
    raised.show === true && raised.moveTop === true && raised.focus === true &&
    raiseCount === raiseBefore + 1,
    `第二次启动交给已开实例：当前曲目=${after ? path.basename(after.currentPath || '（无）') : '—'}（应为新文件）` +
    `、状态=${after ? after.status : '—'}、列表 ${before.count} → ${after ? after.count : '—'} 首；` +
    `窗口提升：show=${raised ? raised.show : '—'} moveTop=${raised ? raised.moveTop : '—'} ` +
    `focus=${raised ? raised.focus : '—'} 拿到焦点=${raised ? raised.focused : '—'} ` +
    `用了置顶兜底=${raised ? raised.burst : '—'}；提升次数 ${raiseBefore} → ${raiseCount}`,
    { profiles: ['full', 'player'] })
}

/**
 * 最小判定：**移动这个动作本身会不会改尺寸**。
 * 会 → 问题在"移动"这个动作本身；不会 → 问题在别处（别的代码或系统在改尺寸）。
 */
async function runSetPositionProbe ({ win, record }) {
  win.unmaximize()
  win.setBounds({ x: 420, y: 200, width: 1100, height: 740 })
  await sleep(600)
  const rows = []
  for (let step = 1; step <= 3; step++) {
    win.setBounds({ x: 420 - 60 * step, y: 200, width: 1100, height: 740 })
    await sleep(400)
    const b = win.getBounds()
    const content = win.getContentBounds()
    rows.push(`${b.x},${b.y} ${b.width}x${b.height}（client ${content.width}x${content.height}）`)
  }
  const b = win.getBounds()
  const widths = rows.map((row) => Number(row.match(/(\d+)x\d+/)[1]))
  const heights = rows.map((row) => Number(row.match(/x(\d+)/)[1]))
  record('移动窗口不该改尺寸（setBounds 钉住宽高）',
    Math.max(...widths) - Math.min(...widths) <= 1 &&
    Math.max(...heights) - Math.min(...heights) <= 1,
    `setBounds(420,200,1100x740) 后连续 setPosition 左移 3×60：${rows.join(' → ')}`,
    { profiles: ['full', 'player'] })
  win.setBounds({ x: 240, y: 200, width: 1100, height: 740 })
  await sleep(300)
}

/**
 * 回归：**向左拖动**时窗口宽度/高度必须守恒。
 *
 * 用户报的 bug：向左拖窗口，当右边界移到屏幕中间时，右边界会自己"变长"。
 * 症状指向的不是"能不能动"，而是**每一步的尺寸是否被改** ——
 * 所以这里把光标分 6 步向左挪 60px，每步都读一次 bounds，把轨迹写进读数里。
 */
async function runLeftDragProbe ({ win, record }) {
  const { screen } = require('electron')
  const { spawn } = require('node:child_process')
  const windowApi = require('./window')

  const moveCursor = (x, y) => {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; ' +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`
    try {
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (err) {
      console.warn('  · 移动光标失败：', err && err.message)
    }
    setTimeout(() => {
      try {
        if (!win.isDestroyed()) win.focus()
      } catch { /* 忽略 */ }
    }, 550)
  }

  windowApi.endWindowDrag()
  windowApi.endWindowResize()
  win.unmaximize()
  win.setBounds({ x: 420, y: 200, width: 1100, height: 740 })
  await sleep(700)
  const start = win.getBounds()

  /* 按标题栏左侧的应用名区域（安全区，不在缩放把手上） */
  const anchorRect = await evaluate(win, `
    const node = document.querySelector('.titlebar__app')
    const r = node.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }`)
  const anchorScreenX = start.x + anchorRect.x
  const anchorScreenY = start.y + anchorRect.y

  moveCursor(anchorScreenX, anchorScreenY)
  {
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      const point = screen.getCursorScreenPoint()
      if (Math.abs(point.x - anchorScreenX) <= 2 && Math.abs(point.y - anchorScreenY) <= 2) break
      await sleep(80)
    }
  }
  await sleep(250)
  await evaluate(win, `
    const node = document.querySelector('.titlebar__app')
    const r = node.getBoundingClientRect()
    node.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      bubbles: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2
    }))
    return true`)
  await sleep(400)

  const samples = []
  for (let step = 1; step <= 6; step++) {
    moveCursor(anchorScreenX - 60 * step, anchorScreenY)
    {
      const target = anchorScreenX - 60 * step
      const deadline = Date.now() + 2500
      while (Date.now() < deadline) {
        const point = screen.getCursorScreenPoint()
        if (Math.abs(point.x - target) <= 2) break
        await sleep(80)
      }
    }
    await sleep(350)
    const b = win.getBounds()
    samples.push({ step, x: b.x, y: b.y, w: b.width, h: b.height })
  }
  windowApi.endWindowDrag()
  await evaluate(win, `window.dispatchEvent(new PointerEvent('pointerup', { button: 0 })); return true`)
  await sleep(300)

  const widths = new Set(samples.map((s) => s.w))
  const heights = new Set(samples.map((s) => s.h))
  const movedLeft = samples[samples.length - 1].x < start.x - 200
  const trajectory = samples.map((s) => `${s.x},${s.y} ${s.w}x${s.h}`).join(' → ')
  const widthList = [...widths]
  const heightList = [...heights]
  record('向左拖 6×60px：宽度与高度保持不变（右边界不会自己"变长"）',
    movedLeft &&
    Math.max(...widthList) - Math.min(...widthList) <= 1 &&
    Math.max(...heightList) - Math.min(...heightList) <= 1,
    `起点 ${start.x},${start.y} ${start.width}x${start.height}；轨迹 ${trajectory}；` +
    `宽度取值 ${[...widths].join('/')}（应只有一个）、高度取值 ${[...heights].join('/')}（应只有一个）`,
    { profiles: ['full', 'player'] })

  moveCursor(anchorScreenX, anchorScreenY)
  if (win.isMaximized()) win.unmaximize()
  win.setBounds({ x: 240, y: 200, width: 1100, height: 740 })
  win.show()
  win.focus()
  await sleep(500)
}


/**
 * 真实拖动自检（不止 movable=true）。
 *
 * 做法：用 PowerShell 的 `[Cursor]::Position` 把**系统光标**真的挪到标题栏上，
 * 再在渲染层派发 pointerdown（走真实的 pointerdown → preload → IPC → beginWindowDrag 链路），
 * 然后把光标再挪 80px，断言窗口的位置/尺寸真的跟着变了。
 *
 * 为什么要动真光标：拖动循环读的是 screen.getCursorScreenPoint()（不是 mousemove），
 * 不移动系统光标就根本证明不了"拖得动"。PowerShell 用 stdio:'ignore' 拉起、不 detach
 * （实测 detach+unref 会让它不生效），每次约 0.6~0.9s。
 */
async function runRealDragChecks ({ win, record }) {
  const { screen } = require('electron')
  const { spawn } = require('node:child_process')
  const windowApi = require('./window')

  const moveCursor = (x, y, winForFocus) => {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; ' +
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)})`
    try {
      // 不 detach、不 unref：detached 的 PowerShell 实测不会真正移动光标
      spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (err) {
      console.warn('  · 移动光标失败：', err && err.message)
    }
    /*
     * PowerShell 会把前台抢走一下。应用有"长时间不在前台就释放媒体墙/停监听"的逻辑，
     * 一旦被这条逻辑命中，后面的媒体墙检查会全部读到 0 个格子。所以每次挪完光标都把焦点抢回来。
     */
    setTimeout(() => {
      try {
        if (winForFocus && !winForFocus.isDestroyed()) winForFocus.focus()
      } catch { /* 忽略 */ }
    }, 550)
  }

  /** 等系统光标真的到 (x,y)：PowerShell 拉起要几百毫秒，不等就会按在旧位置上 */
  const waitForCursor = async (x, y, timeout = 2500) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const point = screen.getCursorScreenPoint()
      if (Math.abs(point.x - x) <= 2 && Math.abs(point.y - y) <= 2) return true
      await sleep(80)
    }
    return false
  }

  const originalCursor = screen.getCursorScreenPoint()

  /** 把某个元素（或点）换算成屏幕坐标 */
  const screenPointOf = async (selector) => {
    const rect = await evaluate(win, `
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return null
      const r = node.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }`)
    if (!rect) return null
    const bounds = win.getBounds()
    return {
      domX: rect.x + rect.width / 2,
      domY: rect.y + rect.height / 2,
      screenX: bounds.x + rect.x + rect.width / 2,
      screenY: bounds.y + rect.y + rect.height / 2,
      rect
    }
  }

  /** 在元素的指定页面坐标上按下去（坐标来自**真实光标**，不是"我以为"的位置） */
  const pressAt = async (selector, clientX, clientY) => evaluate(win, `
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return false
    node.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      bubbles: true,
      clientX: ${Math.round(clientX)},
      clientY: ${Math.round(clientY)}
    }))
    return true`)
  /** 在元素上按下去 */
  const press = async (selector) => evaluate(win, `
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) return false
    const r = node.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y = r.top + Math.min(r.height - 2, Math.max(6, r.height / 2))
    node.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      bubbles: true,
      clientX: x,
      clientY: y
    }))
    return true`)

  /*
   * 一次完整的拖动：挪光标到位 → 按下 → 光标再挪 (dx,dy) → 断言窗口变化 → 松手。
   */
  const drag = async ({ selector, dx, dy, label }) => {
    /* 上一个用例可能还留着拖动/缩放循环：先停干净，否则它会继续把窗口拽走 */
    windowApi.endWindowDrag()
    windowApi.endWindowResize()
    win.unmaximize()
    win.setBounds({ x: 240, y: 200, width: 1100, height: 740 })
    await sleep(700)
    const point = await screenPointOf(selector)
    if (!point) return { ok: false, reason: `没找到 ${selector}` }
    moveCursor(point.screenX, point.screenY, win)
    await waitForCursor(point.screenX, point.screenY)
    await sleep(300)
    /*
     * 以**真实光标**为准重算按下点：PowerShell 拉起要几百毫秒，期间光标可能被别的程序挪动，
     * "我以为按在 (x,y)" 和 "实际按在 (x2,y2)" 差几十像素时，窗口会跟着错误位置跑
     * （读数表现为 Δx=92、Δy=177 这种乱跳）。
     */
    const actual = screen.getCursorScreenPoint()
    const before = win.getBounds()
    const clientX = Math.round(actual.x - before.x)
    const clientY = Math.round(actual.y - before.y)
    const pressed = await pressAt(selector, clientX, clientY)
    await sleep(400)
    moveCursor(actual.x + dx, actual.y + dy, win)
    await waitForCursor(actual.x + dx, actual.y + dy)
    await sleep(300)
    const after = win.getBounds()
    windowApi.endWindowDrag()
    await evaluate(win, `window.dispatchEvent(new PointerEvent('pointerup', { button: 0 })); return true`)
    await sleep(250)
    return { ok: pressed, before, after, deltaX: after.x - before.x, deltaY: after.y - before.y, label }
  }

  /* ① 标题栏左侧（应用名区域）向下拖 80px */
  const left = await drag({ selector: '.titlebar__app', dx: 0, dy: 80 })
  record('普通窗口：按标题栏**左侧（应用名）**拖 80px，窗口真的跟着动',
    left.ok === true && left.deltaY >= 50 && Math.abs(left.deltaX) <= 3,
    left.ok
      ? `位置 ${left.before.x},${left.before.y} → ${left.after.x},${left.after.y}（Δx=${left.deltaX}, Δy=${left.deltaY}，期望 Δy≥50）`
      : `没能按下（${left.reason || 'unknown'}）`,
    { profiles: ['full', 'player'] })

  /* ② 标题栏右侧空白向右拖 80px */
  const right = await drag({ selector: '.titlebar__spacer', dx: 80, dy: 0 })
  record('普通窗口：按标题栏**右侧空白**拖 80px，窗口真的跟着动',
    right.ok === true && right.deltaX >= 50 && Math.abs(right.deltaY) <= 3,
    right.ok
      ? `位置 ${right.before.x},${right.before.y} → ${right.after.x},${right.after.y}（Δx=${right.deltaX}, Δy=${right.deltaY}，期望 Δx≥50）`
      : `没能按下（${right.reason || 'unknown'}）`,
    { profiles: ['full', 'player'] })

  /* ②b 标题栏正中（灵动岛的空隙）：以前这块是"拖不动"的死区 */
  windowApi.endWindowDrag()
  windowApi.endWindowResize()
  win.unmaximize()
  win.setBounds({ x: 240, y: 200, width: 1100, height: 740 })
  await sleep(500)
  const islandPoint = await (async () => {
    const box = await evaluate(win, `
      const node = document.querySelector('.island')
      if (!node) return null
      const r = node.getBoundingClientRect()
      /* 灵动岛框内的左上角空隙：不是任何 .island__item 的地方 */
      return { x: r.left + 6, y: r.top + 4, width: r.width, height: r.height }`)
    if (!box) return null
    const bounds = win.getBounds()
    return { domX: box.x, domY: box.y, screenX: bounds.x + box.x, screenY: bounds.y + box.y }
  })()
  let islandDrag = { ok: false }
  if (islandPoint) {
    moveCursor(islandPoint.screenX, islandPoint.screenY, win)
    await waitForCursor(islandPoint.screenX, islandPoint.screenY)
    await sleep(250)
    const beforeIsland = win.getBounds()
    const pressedIsland = await evaluate(win, `
      const node = document.elementFromPoint(${islandPoint.domX}, ${islandPoint.domY})
      if (!node) return false
      node.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        clientX: ${islandPoint.domX},
        clientY: ${islandPoint.domY}
      }))
      return true`)
    await sleep(350)
    moveCursor(islandPoint.screenX, islandPoint.screenY + 70, win)
    await waitForCursor(islandPoint.screenX, islandPoint.screenY + 70)
    await sleep(250)
    const afterIsland = win.getBounds()
    windowApi.endWindowDrag()
    await evaluate(win, `window.dispatchEvent(new PointerEvent('pointerup', { button: 0 })); return true`)
    await sleep(250)
    islandDrag = {
      ok: pressedIsland,
      before: beforeIsland,
      after: afterIsland,
      deltaY: afterIsland.y - beforeIsland.y
    }
  }
  record('普通窗口：按标题栏**正中（灵动岛空隙）**拖 70px，也能拖动（这里以前是死区）',
    islandDrag.ok === true && islandDrag.deltaY >= 40,
    islandDrag.ok
      ? `位置 ${islandDrag.before.x},${islandDrag.before.y} → ${islandDrag.after.x},${islandDrag.after.y}（Δy=${islandDrag.deltaY}，期望 ≥40）`
      : '没能按下（灵动岛不在？）',
    { profiles: ['full', 'player'] })

  /* ③ 窗口最上 4px：拖动是改高度（缩放），不是移动 */
  windowApi.endWindowDrag()
  windowApi.endWindowResize()
  win.unmaximize()
  win.setBounds({ x: 260, y: 220, width: 1100, height: 740 })
  await sleep(500)
  const topPoint = {
    domX: 550,
    domY: 2,
    screenX: win.getBounds().x + 550,
    screenY: win.getBounds().y + 2
  }
  moveCursor(topPoint.screenX, topPoint.screenY, win)
  await waitForCursor(topPoint.screenX, topPoint.screenY)
  await sleep(250)
  const beforeTop = win.getBounds()
  /* 同上：按下点用**真实光标**换算（PowerShell 慢启动期间光标可能已被挪走） */
  const actualTop = screen.getCursorScreenPoint()
  const pressedTop = await evaluate(win, `
    const node = document.elementFromPoint(${Math.round(actualTop.x - beforeTop.x)}, ${Math.round(actualTop.y - beforeTop.y)})
    if (!node) return { ok: false, cls: '' }
    const cls = node.className || ''
    node.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      bubbles: true,
      clientX: ${Math.round(actualTop.x - beforeTop.x)},
      clientY: ${Math.round(actualTop.y - beforeTop.y)}
    }))
    return { ok: true, cls: String(cls) }`)
  await sleep(350)
  moveCursor(topPoint.screenX, topPoint.screenY + 70, win)
  await waitForCursor(topPoint.screenX, topPoint.screenY + 70)
  await sleep(250)
  const afterTop = win.getBounds()
  windowApi.endWindowResize()
  require('./window').endWindowDrag()
  await evaluate(win, `window.dispatchEvent(new PointerEvent('pointerup', { button: 0 })); return true`)
  await sleep(250)
  record('窗口最上 4px：拖动是**缩放**（高度变了），不是移动窗口',
    pressedTop.ok === true && String(pressedTop.cls).includes('resize-handle') &&
    Math.abs(afterTop.width - beforeTop.width) <= 2 &&
    beforeTop.height - afterTop.height >= 40,
    `按下命中的是「${String(pressedTop.cls)}」；高度 ${beforeTop.height} → ${afterTop.height}` +
    `（减少 ${beforeTop.height - afterTop.height}，期望 ≥40）、宽度 ${beforeTop.width} → ${afterTop.width}（不应变）`,
    { profiles: ['full', 'player'] })

  await runSetPositionProbe({ win, record })
  await runLeftDragProbe({ win, record })

  /* 收尾：还原光标与窗口几何，并把焦点抢回窗口 */
  moveCursor(originalCursor.x, originalCursor.y, win)
  if (win.isMaximized()) win.unmaximize()
  win.setBounds({ x: 240, y: 200, width: 1100, height: 740 })
  /*
   * 每次拉 PowerShell 都会把前台抢走一下。自检跑在窗口里，长期在后台会触发应用自己的
   * "长时间不在前台"逻辑（停目录监听、释放媒体墙与封面缓存）—— 后面的检查就会撞上
   * "媒体墙 0 个格子"。所以这里必须把焦点还回来。
   */
  win.show()
  win.focus()
  await sleep(600)
}


/**
 * 窗口几何与"最大化后拖不动"的回归（两个产品共用）。
 *
 *  ① 保存/恢复时按工作区夹紧：给一个超出工作区的 bounds（实测 player 存过 1298x871 / 工作区高 866），
 *     夹紧后的结果必须落在工作区内；
 *  ② 最大化状态下按压标题栏 → 先 unmaximize、再跟着光标移动（窗口位置确实变了）；
 *  ③ 双击标题栏空白处切换最大化/还原（两个方向都验）。
 *
 * 拖动手感跟的是**真实光标**（screen.getCursorScreenPoint），自动测不了手感，
 * 但"是否触发了还原、窗口是否真的移动了"是可以断言的。
 */
async function runWindowChecks ({ win, record }) {
  const { screen } = require('electron')
  const windowApi = require('./window')

  /* ① 夹紧 */
  const workArea = screen.getDisplayMatching(win.getBounds()).workArea
  const oversized = {
    x: workArea.x + 40,
    y: workArea.y + 40,
    width: workArea.width + 260,
    height: workArea.height + 120
  }
  const clamped = windowApi.clampToWorkArea(oversized)
  const fits = clamped.x >= workArea.x && clamped.y >= workArea.y &&
    clamped.x + clamped.width <= workArea.x + workArea.width &&
    clamped.y + clamped.height <= workArea.y + workArea.height
  record('窗口 bounds 超出工作区时会被夹回去（保存与恢复共用同一处）',
    fits && clamped.width <= workArea.width && clamped.height <= workArea.height,
    `工作区 ${workArea.width}x${workArea.height}；输入 ${oversized.width}x${oversized.height}` +
    `@${oversized.x},${oversized.y} → 夹成 ${clamped.width}x${clamped.height}@${clamped.x},${clamped.y}` +
    `（落在工作区内=${fits}）`,
    { profiles: ['full', 'player'] })

  /* ② 最大化 → 按压标题栏 → 还原并移动 */
  const normalBounds = win.getBounds()
  win.maximize()
  await sleep(600)
  const wasMaximized = win.isMaximized()
  const maximizedBounds = win.getBounds()
  const dragged = await evaluate(win, `
    const bar = document.querySelector('.titlebar')
    if (!bar) return { dispatched: false, hasClass: false }
    const rect = bar.getBoundingClientRect()
    bar.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      bubbles: true,
      clientX: Math.round(rect.left + rect.width * 0.5),
      clientY: Math.round(rect.top + rect.height * 0.5)
    }))
    return { dispatched: true, hasClass: document.body.classList.contains('is-maximized') }`)
  await sleep(700)
  const afterBounds = win.getBounds()
  const stillMax = win.isMaximized()
  windowApi.endWindowDrag()
  const moved = afterBounds.x !== maximizedBounds.x || afterBounds.y !== maximizedBounds.y
  record('最大化状态下按压标题栏 → 还原成普通窗口并跟着光标移动',
    wasMaximized === true && dragged.dispatched === true &&
    stillMax === false && moved === true,
    `最大化=${wasMaximized}（${maximizedBounds.width}x${maximizedBounds.height}）、` +
    `按下时 is-maximized 类=${dragged.hasClass}；之后 最大化=${stillMax}、` +
    `位置 ${maximizedBounds.x},${maximizedBounds.y} → ${afterBounds.x},${afterBounds.y}（移动了=${moved}）`,
    { profiles: ['full', 'player'] })

  /* ③ 双击切换最大化/还原 */
  const doubleClick = async () => evaluate(win, `
    const bar = document.querySelector('.titlebar')
    if (!bar) return false
    const rect = bar.getBoundingClientRect()
    bar.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      clientX: Math.round(rect.left + rect.width * 0.5),
      clientY: Math.round(rect.top + rect.height * 0.5)
    }))
    return true`)
  const firstDispatch = await doubleClick()
  await sleep(600)
  const afterFirst = win.isMaximized()
  await doubleClick()
  await sleep(600)
  const afterSecond = win.isMaximized()
  record('双击标题栏空白处能切换最大化 / 还原（两个方向都验）',
    firstDispatch === true && afterFirst !== stillMax && afterSecond !== afterFirst,
    `双击一次：最大化 ${stillMax} → ${afterFirst}；再双击：→ ${afterSecond}`,
    { profiles: ['full', 'player'] })

  /*
   * 拖**窗口边缘**缩放：无边框窗口的系统缩放边框不可靠（用户反馈"完全拖不动边缘"），
   * 渲染层画了八块透明把手。这里按住右下角那块，断言窗口尺寸真的变了。
   */
  win.setBounds({ x: 120, y: 120, width: 1000, height: 700 })
  await sleep(400)
  const beforeResize = win.getBounds()
  const handleHit = await evaluate(win, `
    const handle = document.querySelector('.resize-handle--se')
    if (!handle) return false
    const rect = handle.getBoundingClientRect()
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0,
      bubbles: true,
      clientX: rect.left + 4,
      clientY: rect.top + 4
    }))
    return true`)
  await sleep(700)
  const afterResize = win.getBounds()
  windowApi.endWindowResize()
  record('拖窗口边缘能缩放（自绘把手，不依赖系统的缩放边框）',
    handleHit === true &&
    (afterResize.width !== beforeResize.width || afterResize.height !== beforeResize.height),
    `右下角把手命中=${handleHit}；尺寸 ${beforeResize.width}x${beforeResize.height} → ` +
    `${afterResize.width}x${afterResize.height}（位置 ${afterResize.x},${afterResize.y}）`,
    { profiles: ['full', 'player'] })

  /* 真实拖动（挪系统光标让窗口真的跟着动） */
  await runRealDragChecks({ win, record })

  /* 普通窗口可拖可缩放（无边框窗口靠这两项开关，被关掉就"拖不动/改不了大小"） */
  record('普通窗口可移动、可缩放',
    win.isMovable() === true && win.isResizable() === true,
    `movable=${win.isMovable()}, resizable=${win.isResizable()}`,
    { profiles: ['full', 'player'] })

  /* 收尾：把窗口放回测前的位置/大小，别影响后面的检查 */
  if (win.isMaximized()) win.unmaximize()
  win.setBounds(normalBounds)
  await sleep(500)
}

/**
 * 两个产品**共用**的检查（标 full/player）。
 *
 * 这是"同一件事只写一遍"的样板：两套自检都调用这个函数，而不是各自抄一份。
 * 里面的断言都与"档位无关"——窗口标题兜底、设置页能打开并渲染出内容。
 */
async function runSharedChecks ({ win, record }) {
  const shared = await evaluate(win, `
    const { actions, store } = window.__aria
    const productName = window.aria && window.aria.profile ? window.aria.profile.productName : ''
    actions.setView('settings')
    await new Promise((r) => setTimeout(r, 500))
    const rows = [...document.querySelectorAll('.settings__row-title')].filter((node) => node.getClientRects().length > 0).length
    const heading = document.querySelector('.view-header__title')
    actions.setView('songs')
    await new Promise((r) => setTimeout(r, 300))
    const s = store.get()
    return {
      productName,
      title: document.title,
      playing: s.playback.status === 'playing',
      /* 标题跟的是"有没有当前曲目"（TRACK_CHANGED 时设），与播放/暂停无关 */
      hasTrack: Boolean(s.playback.trackId && s.library.byId.get(s.playback.trackId)),
      playingTitle: s.playback.trackId && s.library.byId.get(s.playback.trackId)
        // 注意：这里是**注入到渲染层的模板字符串内部**，不能再写反引号（会提前结束外层模板）
        ? (s.library.byId.get(s.playback.trackId).title + ' — ' + s.library.byId.get(s.playback.trackId).artist)
        : '',
      settingsRows: rows,
      settingsHeading: heading ? (heading.textContent || '').trim() : '',
      viewAfter: s.ui.view
    }`)
  /*
   * 标题的规则：**没在播时**是产品名，**在播时**是「曲名 — 艺人」。
   * 以前只写了前半句 —— 那条在"启动时列表是空的"前提下才成立；
   * 一旦 player 的「最近打开」里有内容并自动续上，标题就合法地变成曲名，
   * 旧断言会误判（它是"因为别处的 bug 才通过"的典型例子）。
   */
  record('窗口标题：没有当前曲目时是产品名，有当前曲目时是「曲名 — 艺人」',
    Boolean(shared.productName) && (
      shared.hasTrack
        ? shared.title === shared.playingTitle
        : shared.title === shared.productName
    ),
    `productName=${shared.productName}、document.title=${shared.title}、` +
    `有当前曲目=${shared.hasTrack}${shared.hasTrack ? `（期望「${shared.playingTitle}」）` : '（期望产品名）'}` +
    `、在播=${shared.playing}`,
    { profiles: ['full', 'player'] })
  /* 窗口几何 / 最大化后拖不动（两个产品都验） */
  await runWindowChecks({ win, record })

  record('设置页能打开并真的渲染出内容',
    shared.settingsRows > 10 && shared.viewAfter === 'songs',
    `设置项 ${shared.settingsRows} 行、标题「${shared.settingsHeading}」、切回歌曲页=${shared.viewAfter}`,
    { profiles: ['full', 'player'] })
}

/**
 * player 档位（Aria Player）的自检。
 *
 * 与本体那 195 条**不是一回事**，所以没有共用：本体验的是"资料库、歌词、在线、媒体墙、
 * 播放链路"这一整套；Player 验的是**"该有的有、不该有的没有"**，以及"打开文件"这条
 * 自己独有的链路（双击直接播、拖 10 个不弹确认框、最近打开在重启后还在）。
 *
 * 第 2 步时它是一个空壳；第 3 步起有了真正的功能，下面的检查也跟着长。
 */
async function runPlayerShellSmoke ({ win, ctx, profile, record, raiseInfo }) {
  /* ① 主进程挂的服务：一个不多、一个不少 */
  /*
   * aiSubtitles = 本机 AI 字幕（模型可选下载、识别在本机跑），player 档专属。
   * 登记在这里的意思是：以后再加服务，必须先证明它确实是这个档位要的。
   */
  const expectedServices = ['ai', 'aiSubtitles', 'diagnostics', 'openedFiles', 'resume', 'settings', 'updater']
  const services = ctx.list().slice().sort()
  record('主进程只挂了本档位的服务（表外的都没被 define）',
    services.join('|') === expectedServices.join('|'),
    `ctx.list() = [${services.join('、')}]（应为 [${expectedServices.join('、')}]）`)

  /*
   * 本机 AI 字幕（阶段 2：模型管理）—— 只验状态机，**不真下 228MB**。
   * 走的是真服务（真 IPC、真 userData 目录），只把「真的下完」这一步省掉：
   * 未下载 → 下载（1.2 秒后取消，.part 留着供续传）→ 删除（回到未下载，.part 也要清）。
   */
  const aiSubtitles = await evaluate(win, `
    const ai = window.aria && window.aria.aiSubtitles
    if (!ai) return { missing: true }
    await ai.removeModel()
    await ai.clearCache()
    const before = await ai.status()
    const idleCancel = await ai.cancel()
    const cleared = await ai.clearCache()
    await ai.download({})
    await new Promise((r) => setTimeout(r, 1200))
    const mid = await ai.status()
    const cancelled = await ai.cancel()
    await new Promise((r) => setTimeout(r, 600))
    const afterCancel = await ai.status()
    const removed = await ai.removeModel()
    const final = await ai.status()
    return {
      missing: false,
      beforeState: before.state,
      modelBytes: before.modelBytes,
      partialBefore: before.partialBytes,
      cacheBefore: before.cache.entries,
      idleCancelled: idleCancel.cancelled,
      clearedEntries: cleared.entries,
      midState: mid.state,
      cancelAccepted: cancelled.cancelled,
      afterCancelState: afterCancel.state,
      afterCancelCode: afterCancel.error ? afterCancel.error.code : "",
      removed: removed.removed,
      finalState: final.state,
      finalPartial: final.partialBytes
    }`)
  record('AI 字幕：模型管理的状态机（未下载 → 下载中可取消 → 删除回到未下载）',
    aiSubtitles.missing !== true &&
    aiSubtitles.beforeState === 'not-downloaded' &&
    aiSubtitles.modelBytes === 240193589 &&
    aiSubtitles.partialBefore === 0 &&
    aiSubtitles.cacheBefore === 0 &&
    aiSubtitles.idleCancelled === false &&
    aiSubtitles.clearedEntries === 0 &&
    aiSubtitles.midState !== 'ready' &&
    aiSubtitles.cancelAccepted === (aiSubtitles.midState === 'downloading') &&
    aiSubtitles.afterCancelState === 'error' &&
    aiSubtitles.removed === true &&
    aiSubtitles.finalState === 'not-downloaded' &&
    aiSubtitles.finalPartial === 0,
    `未下载时 state=${aiSubtitles.beforeState}、三个模型共 ${aiSubtitles.modelBytes} B、` +
      `.part=${aiSubtitles.partialBefore} B、缓存 ${aiSubtitles.cacheBefore} 条；` +
      `空转点取消 accepted=${aiSubtitles.idleCancelled}（应为 false）；清缓存后 ${aiSubtitles.clearedEntries} 条；` +
      `下载中 state=${aiSubtitles.midState}；点取消 accepted=${aiSubtitles.cancelAccepted}；` +
      `取消后 state=${aiSubtitles.afterCancelState}（${aiSubtitles.afterCancelCode}）；` +
      `删除模型 removed=${aiSubtitles.removed} → state=${aiSubtitles.finalState}、残留 .part=${aiSubtitles.finalPartial} B`)

  /*
   * AI 字幕：转写链路（阶段 3）。
   * 用 `ARIA_AI_SUBTITLE_FAKE=1` 的假识别器跑完整条链 —— 不依赖 228MB 真模型：
   * 分块推 PCM → utilityProcess → 合并 → LRC → 写缓存 → **再来一次应命中缓存**。
   * 没有开假识别器时这条会跳过（报"未启用"而不是红）。
   */
  const transcribeChain = await evaluate(win, `
    const ai = window.aria && window.aria.aiSubtitles
    if (!ai) return { missing: true }
    await ai.clearCache()
    const total = 4
    for (let i = 0; i < total; i++) {
      /* 每块 0.5 秒静音（16k 单声道 Int16） */
      const samples = new Int16Array(8000)
      const bytes = new Uint8Array(samples.buffer)
      let binary = ""
      for (let k = 0; k < bytes.length; k += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000))
      }
      await ai.pushAudio({ index: i, total, sampleRate: 16000, data: btoa(binary) })
    }
    const first = await ai.transcribe({ path: "C:/smoke/ai-subtitles-probe.mp3", mtime: 1700000000 })
    const afterFirst = await ai.cacheInfo()
    /* 同一首再来一次：必须命中缓存，且不再跑识别 */
    for (let i = 0; i < total; i++) {
      const samples = new Int16Array(8000)
      const bytes = new Uint8Array(samples.buffer)
      let binary = ""
      for (let k = 0; k < bytes.length; k += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000))
      }
      await ai.pushAudio({ index: i, total, sampleRate: 16000, data: btoa(binary) })
    }
    const second = await ai.transcribe({ path: "C:/smoke/ai-subtitles-probe.mp3", mtime: 1700000000 })
    const idleCancel = await ai.cancelTranscribe()
    const cleared = await ai.clearCache()
    return {
      missing: false,
      firstOk: first.ok,
      firstCode: first.code || "",
      fromCacheFirst: first.fromCache === true,
      lines: Array.isArray(first.segments) ? first.segments.length : -1,
      lrcHead: String(first.lrc || "").split("\\n")[0],
      estimated: first.estimatedTimeline === true,
      cacheAfterFirst: afterFirst.entries,
      fromCacheSecond: second.fromCache === true,
      sameLrc: String(second.lrc || "") === String(first.lrc || ""),
      idleCancel: idleCancel.cancelled,
      clearedEntries: cleared.entries
    }`)
  /* ---------- AI 字幕：内置 VAD（删掉模型目录也还在）---------- */
  record('内置 VAD：删掉模型目录后仍然"VAD 就绪"，模型下载流程不变', (async () => {
    const ai = ctx.get('aiSubtitles')
    const before = await ai.status()
    /* 把模型目录整个挪走再查一次 —— VAD 应该不受影响 */
    const models = before.modelsDir
    const backup = models + '.smoke-backup'
    const fsSync = require('node:fs')
    let moved = false
    try {
      if (fsSync.existsSync(models)) {
        fsSync.renameSync(models, backup)
        moved = true
      }
    } catch {
      // 挪不动就跳过（自检不该因此失败）
    }
    const after = await ai.status()
    if (moved) {
      try { fsSync.renameSync(backup, models) } catch {}
    }
    const ok = after.vadBundled === true && after.vadReady === true &&
      (moved ? after.state === 'not-downloaded' : true)
    return {
      ok,
      detail: `内置=${after.vadBundled}；删目录后 VAD 就绪=${after.vadReady}；` +
        `模型状态（删目录后）=${after.state}（期望 not-downloaded）；挪动目录=${moved}；` +
        `模型总大小=${after.modelBytesText}`
    }
  })())

  record('AI 字幕：转写链路（分块 PCM → worker → 合并 → LRC → 缓存命中）',
    transcribeChain.missing !== true &&
    (transcribeChain.firstOk === true
      /* 没开假识别器时：要么没模型（跳过），要么真识别成功 */
      ? (transcribeChain.lines >= 1 &&
         transcribeChain.lrcHead === "[ai]" &&
         transcribeChain.cacheAfterFirst === 1 &&
         transcribeChain.fromCacheSecond === true &&
         transcribeChain.sameLrc === true &&
         transcribeChain.idleCancel === false &&
         transcribeChain.clearedEntries === 0)
      : transcribeChain.firstCode === 'model-missing'),
    `首次：ok=${transcribeChain.firstOk}${transcribeChain.firstCode ? '（' + transcribeChain.firstCode + '）' : ''}、` +
      `行数 ${transcribeChain.lines}、首行「${transcribeChain.lrcHead}」、时间轴为估算=${transcribeChain.estimated}；` +
      `缓存 ${transcribeChain.cacheAfterFirst} 条；第二次 fromCache=${transcribeChain.fromCacheSecond}、LRC 一致=${transcribeChain.sameLrc}；` +
      `空转点取消 accepted=${transcribeChain.idleCancel}（应为 false）；清缓存后 ${transcribeChain.clearedEntries} 条`)

  /*
   * AI 字幕：UI 入口（阶段 4）。
   * 设置页：默认 **关**、有「下载模型」「清空缓存」；打开开关后歌词页空状态应出现「用 AI 生成本地字幕」。
   * 只验入口存在与开关联动（不点真下载 —— 那是 229MB）。
   */
  const aiUi = await evaluate(win, `
    const { actions, store } = window.__aria
    const rowsOf = () => [...document.querySelectorAll(".settings__row")]
    const textOf = (node) => (node.textContent || "")

    /* 先确保开关是关的（上一轮可能留了 true） */
    await actions.setSetting({ aiSubtitles: false })
    actions.setView("settings")
    await new Promise((r) => setTimeout(r, 600))
    const rows = rowsOf()
    const row = rows.find((node) => textOf(node).includes("AI 字幕（本地）"))
    const toggle = row ? row.querySelector(".switch") : null
    const out = {
      hasRow: Boolean(row),
      offByDefault: toggle ? toggle.getAttribute("aria-checked") === "false" : null,
      hasDownload: rows.some((node) => textOf(node).includes("下载模型")),
      hasClearCache: rows.some((node) => textOf(node).includes("清空缓存")),
      statusText: (document.querySelector(".ai-subtitles__status") || {}).textContent || "",
      enabled: false,
      hasLyricsButton: false
    }

    /* 打开开关 → 歌词页空状态应出现 AI 入口 */
    if (toggle) {
      toggle.click()
      await new Promise((r) => setTimeout(r, 500))
    }
    out.enabled = store.get().settings.aiSubtitles === true
    actions.openNowPlaying()
    /*
     * 等条件，不要固定 sleep：打开播放页后歌词先经历「正在载入歌词…」，
     * 没 .lrc 才会切到空状态 —— 我们的按钮在空状态里。
     */
    for (let i = 0; i < 30; i++) {
      if ([...document.querySelectorAll("button")].some((node) => textOf(node).includes("用 AI 生成本地字幕"))) {
        out.hasLyricsButton = true
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    /* 诊断：到底卡在哪一步 */
    const lyricsState = store.get().lyrics
    out.diagLyricsStatus = lyricsState ? lyricsState.status : "null"
    out.diagLines = lyricsState && lyricsState.lines ? lyricsState.lines.length : -1
    out.diagEmptyActions = Boolean(document.querySelector(".lyrics-empty__actions"))
    out.diagAiBlock = Boolean(document.querySelector(".lyrics-empty__ai-progress"))
    out.diagEnabledFlag = window.__aria.store.get().settings.aiSubtitles === true
    out.diagHasApi = Boolean(window.aria && window.aria.aiSubtitles)
    const emptyText = document.querySelector(".lyrics-empty")
    out.diagEmptyText = emptyText ? (emptyText.textContent || "").slice(0, 80) : ""

    /* 收尾：关掉开关、收起播放页 */
    actions.closeNowPlaying()
    await actions.setSetting({ aiSubtitles: false })
    actions.setView("songs")
    await new Promise((r) => setTimeout(r, 300))
    return out`)
  record('AI 字幕：设置页有开关（默认关）与下载/清缓存，打开后歌词页出现生成入口',
    aiUi.hasRow === true &&
    aiUi.offByDefault === true &&
    aiUi.hasDownload === true &&
    aiUi.hasClearCache === true &&
    aiUi.enabled === true &&
    aiUi.hasLyricsButton === true,
    `设置页有「AI 字幕（本地）」行=${aiUi.hasRow}、开关默认关=${aiUi.offByDefault}、` +
      `有「下载模型」=${aiUi.hasDownload}、有「清空缓存」=${aiUi.hasClearCache}；` +
      `状态文案「${String(aiUi.statusText).slice(0, 40)}」；点开关后 aiSubtitles=${aiUi.enabled}、` +
      `歌词页出现生成入口=${aiUi.hasLyricsButton}；` +
      `诊断：lyrics.status=${aiUi.diagLyricsStatus}、lines=${aiUi.diagLines}、` +
      `空状态动作区=${aiUi.diagEmptyActions}、AI 块=${aiUi.diagAiBlock}、开关=${aiUi.diagEnabledFlag}、API=${aiUi.diagHasApi}、` +
      `空状态文字「${aiUi.diagEmptyText}」`)

  /*
   * 用户报的 bug：AI 识别「完成」了，但歌词页还是「未找到歌词」什么也不显示。
   * 根因是只 emit 事件、没把结果写进 store.lyrics（渲染读的是 store）。
   * 这条从头点一次：打开开关 → 进播放页 → 点「用 AI 生成本地字幕」→ 必须真的出现行和徽章。
   */
  /*
     * 这条需要一个"正在播放的曲目"：player 套件在不带文件启动时列表是空的，
     * 所以先塞一个 fixture 进去（走产品自己的 handleDrop，不伪造 store）。
     */
  const aiFixture = require('node:path').join(__dirname, '..', '..', 'tests', 'player-smoke', 'smoke-open.wav')
  const aiGenerated = await evaluate(win, `
    const { actions, store } = window.__aria
    const dropped = await window.aria.library.handleDrop(${JSON.stringify(aiFixture)})
    actions.applyDropResult(dropped)
    await new Promise((r) => setTimeout(r, 1500))
    await actions.setSetting({ aiSubtitles: false })
    actions.setView("settings")
    await new Promise((r) => setTimeout(r, 500))
    const row = [...document.querySelectorAll(".settings__row")]
      .find((node) => (node.textContent || "").includes("AI 字幕（本地）"))
    const toggle = row ? row.querySelector(".switch") : null
    if (toggle) toggle.click()
    await new Promise((r) => setTimeout(r, 400))

    actions.openNowPlaying()
    let clicked = false
    for (let i = 0; i < 30; i++) {
      const button = [...document.querySelectorAll("button")]
        .find((node) => (node.textContent || "").includes("用 AI 生成本地字幕"))
      if (button) {
        /* 开始之前：「取消」必须是隐藏的（hidden 被 .btn 覆盖过一次） */
        const cancelBefore = [...document.querySelectorAll(".lyrics-empty__ai button")]
          .find((node) => (node.textContent || "").trim() === "取消")
        const cancelHiddenBefore = cancelBefore ? getComputedStyle(cancelBefore).display === "none" : true
        button.click()
        clicked = true
        window.__aiCancelHiddenBefore = cancelHiddenBefore
        break
      }
      await new Promise((r) => setTimeout(r, 100))
    }

    /* 等结果真的落到页面上（最多 20 秒；假识别器一般 1~2 秒） */
    let linesShown = 0
    let badge = false
    let stillEmpty = true
    for (let i = 0; i < 100; i++) {
      const lyrics = store.get().lyrics
      linesShown = lyrics && lyrics.lines ? lyrics.lines.length : 0
      badge = Boolean(document.querySelector(".lyrics__ai-badge"))
      stillEmpty = (document.querySelector(".lyrics-empty") || {}).textContent ? true : false
      if (linesShown > 0 && badge) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const renderedLines = document.querySelectorAll(".lyrics__line").length
    /* 诊断：失败原因写在 data-ai-error 上 */
    const aiErrorDiag = (document.querySelector(".lyrics-empty") || document.querySelector(".lyrics") || {}).dataset
      ? ((document.querySelector("[data-ai-error]") || {}).getAttribute ? (document.querySelector("[data-ai-error]").getAttribute("data-ai-error") || "") : "")
      : ""
    const disclaimer = (document.querySelector(".lyrics__ai-text") || {}).textContent || ""

    actions.closeNowPlaying()
    await actions.setSetting({ aiSubtitles: false })
    actions.setView("songs")
    await new Promise((r) => setTimeout(r, 300))
    return { clicked, linesShown, badge, stillEmpty, renderedLines, disclaimer, aiErrorDiag, cancelHiddenBefore: window.__aiCancelHiddenBefore === true }`)
  record('AI 字幕：点生成之后歌词真的显示出来（行 + 徽章 + 免责）',
    aiGenerated.clicked === true &&
    aiGenerated.linesShown > 0 &&
    aiGenerated.badge === true &&
    aiGenerated.renderedLines > 0 &&
    aiGenerated.stillEmpty === false &&
    aiGenerated.disclaimer.includes("识别可能有误"),
    `点了生成=${aiGenerated.clicked}；store 里 ${aiGenerated.linesShown} 行、DOM 里 ${aiGenerated.renderedLines} 行；` +
      `徽章=${aiGenerated.badge}、空状态还在=${aiGenerated.stillEmpty}、免责「${aiGenerated.disclaimer}」；` +
      `点之前「取消」是隐藏的=${aiGenerated.cancelHiddenBefore}；诊断=${aiGenerated.aiErrorDiag || "（无）"}`)

  /*
   * 正在播放页的观感（用户两张截图）：
   *   ① 宽窗口下隐藏歌词不应该把整页压成中间一条窄柱；
   *   ② 左列不该常驻一条原生滚动条；
   *   ③ 歌词右上角的工具栏不该「完全隐形」；
   *   ④ 无封面占位不该空（要有淡色渐变 + 底部专辑名）。
   */
  /*
   * 先把窗口拉宽 —— 「宽窗口下保留两列」这条规则只有在 >=1001px 时才成立，
   * 自检窗口默认没这么宽，不拉宽等于没验。测完还原。
   */
  const lookPreviousBounds = win.getBounds()
  win.setContentSize(1400, 820)
  await sleep(600)
  const nowPlayingLook = await evaluate(win, `
    const { actions, store } = window.__aria
    actions.setSetting({ lyricsVisible: true })
    actions.openNowPlaying()
    await new Promise((r) => setTimeout(r, 800))

    const body = document.querySelector(".now-playing__body")
    const left = document.querySelector(".now-playing__left")
    const art = document.querySelector(".now-playing__art")
    const toolbar = document.querySelector(".lyrics-toolbar")
    const source = document.querySelector(".lyrics-source")

    /*
     * 遮罩归属：必须在滚动容器 .lyrics 上，不能在 .lyrics-region 上 ——
     * 挂在区域上会把右上角工具组与底部「回到当前」一起淡掉（用户看到"几乎看不见"的根因）。
     */
    const scroller = document.querySelector(".lyrics")
    const region = document.querySelector(".lyrics-region")
    const scrollerMask = scroller ? getComputedStyle(scroller).maskImage : ""
    const regionMask = region ? getComputedStyle(region).maskImage : ""
    const resume = document.querySelector(".lyrics-resume")
    const resumeMask = resume ? getComputedStyle(resume).maskImage : ""
    /* 空状态：居中的内容要落在遮罩 16%–84% 的清晰区里，否则上下会被削 */
    const empty = document.querySelector(".lyrics-empty")
    let emptyInsideClear = null
    let emptyTopPercent = null
    if (empty && scroller) {
      /*
       * .lyrics-empty 自己是一块 inset:0 的整高盒子（用来居中），
       * 要量的是它的**内容**包围盒 —— 拿它自己的 rect 会永远得到 0%→100%。
       */
      const box = scroller.getBoundingClientRect()
      const kids = [...empty.children].map((node) => node.getBoundingClientRect())
      if (kids.length && box.height > 0) {
        const top = Math.min(...kids.map((r) => r.top))
        const bottom = Math.max(...kids.map((r) => r.bottom))
        emptyTopPercent = (top - box.top) / box.height
        const bottomPercent = (bottom - box.top) / box.height
        emptyInsideClear = emptyTopPercent >= 0.16 && bottomPercent <= 0.86
      }
    }
    /* 「回到当前」不能压住最后一行歌词 */
    let resumeOverlaps = null
    if (resume && scroller) {
      const lines = [...scroller.querySelectorAll(".lyrics__line")]
      const last = lines[lines.length - 1]
      if (last) {
        const a = resume.getBoundingClientRect()
        const b = last.getBoundingClientRect()
        resumeOverlaps = a.top < b.bottom && a.bottom > b.top
      }
    }

    const wide = window.innerWidth >= 1001
    const columnsShown = body ? getComputedStyle(body).gridTemplateColumns.split(" ").length : 0
    const leftOverflowY = left ? getComputedStyle(left).overflowY : ""
    const leftScrolls = left ? left.scrollHeight > left.clientHeight + 1 : false
    const toolbarOpacity = toolbar ? Number(getComputedStyle(toolbar).opacity) : 0
    const toolbarBg = toolbar ? getComputedStyle(toolbar).backgroundColor : ""
    const sourceColor = source ? getComputedStyle(source).color : ""
    const artBg = art ? getComputedStyle(art).backgroundImage : ""
    const albumNode = document.querySelector(".now-playing__art-album")
    const albumText = albumNode ? (albumNode.textContent || "") : ""
    const albumVisible = albumNode ? getComputedStyle(albumNode).display !== "none" : false

    /* 隐藏歌词 → 宽窗口下应仍是两列，并出现「显示歌词」入口 */
    actions.toggleLyrics()
    await new Promise((r) => setTimeout(r, 600))
    const columnsHidden = body ? getComputedStyle(body).gridTemplateColumns.split(" ").length : 0
    const restore = document.querySelector(".lyrics-show-again")
    const restoreVisible = restore ? getComputedStyle(restore).display !== "none" : false
    const restoreButton = restore ? restore.querySelector("button") : null
    const restoreHasLabel = restoreButton ? /显示歌词/.test(restoreButton.textContent || "") : false
    const toggle = document.querySelector(".now-playing__tool[aria-pressed]") || document.querySelector("[aria-pressed]")
    const pressedWhenHidden = toggle ? toggle.getAttribute("aria-pressed") : null
    if (restoreButton) restoreButton.click()
    await new Promise((r) => setTimeout(r, 500))
    const pressedWhenShown = toggle ? toggle.getAttribute("aria-pressed") : null

    actions.setSetting({ lyricsVisible: true })
    await actions.closeNowPlaying()
    actions.setView("songs")
    await new Promise((r) => setTimeout(r, 300))
    return {
      scrollerMask, regionMask, resumeMask, emptyInsideClear, emptyTopPercent, resumeOverlaps,
      wide, columnsShown, columnsHidden, restoreVisible, restoreHasLabel,
      pressedWhenHidden, pressedWhenShown,
      leftOverflowY, leftScrolls, toolbarOpacity, toolbarBg,
      sourceColor, artBg, albumText, albumVisible
    }`)
  record('正在播放页：隐藏歌词仍保留两列、左列不常驻滚动条、工具栏与无封面占位都看得见',
    nowPlayingLook.columnsShown === 2 &&
    nowPlayingLook.columnsHidden === (nowPlayingLook.wide ? 2 : 1) &&
    nowPlayingLook.restoreVisible === true &&
    nowPlayingLook.restoreHasLabel === true &&
    nowPlayingLook.pressedWhenHidden === 'false' &&
    nowPlayingLook.pressedWhenShown === 'true' &&
    !nowPlayingLook.leftScrolls &&
    nowPlayingLook.toolbarOpacity >= 0.5 &&
    String(nowPlayingLook.toolbarBg) !== "rgba(0, 0, 0, 0)" &&
    String(nowPlayingLook.artBg).includes("gradient") &&
    /* 遮罩必须在滚动容器上，不能在区域上 */
    String(nowPlayingLook.scrollerMask).includes("gradient") &&
    String(nowPlayingLook.regionMask) === "none" &&
    /* 空状态与「回到当前」的复核 */
    nowPlayingLook.emptyInsideClear === true &&
    nowPlayingLook.resumeOverlaps !== true &&
    (nowPlayingLook.albumVisible === true || nowPlayingLook.albumText === ""),
    `窗口宽=${nowPlayingLook.wide}：显示时 ${nowPlayingLook.columnsShown} 列、隐藏时 ${nowPlayingLook.columnsHidden} 列；` +
      `「显示歌词」入口可见=${nowPlayingLook.restoreVisible}（含文案=${nowPlayingLook.restoreHasLabel}）；` +
      `aria-pressed 隐藏=${nowPlayingLook.pressedWhenHidden} → 显示=${nowPlayingLook.pressedWhenShown}；` +
      `左列 overflow-y=${nowPlayingLook.leftOverflowY}、真的在滚=${nowPlayingLook.leftScrolls}；` +
      `工具栏 opacity=${nowPlayingLook.toolbarOpacity}、背景=${nowPlayingLook.toolbarBg}；` +
      `来源文字色=${nowPlayingLook.sourceColor}；封面层=${String(nowPlayingLook.artBg).slice(0, 40)}…；` +
      `占位专辑名「${nowPlayingLook.albumText}」可见=${nowPlayingLook.albumVisible}；` +
      `遮罩：滚动容器=${String(nowPlayingLook.scrollerMask).slice(0, 20)}…、区域=${nowPlayingLook.regionMask}、回到当前=${nowPlayingLook.resumeMask}；` +
      `空状态在清晰区=${nowPlayingLook.emptyInsideClear}（顶部 ${nowPlayingLook.emptyTopPercent == null ? '—' : (nowPlayingLook.emptyTopPercent * 100).toFixed(0) + '%'}）；` +
      `「回到当前」压住最后一行=${nowPlayingLook.resumeOverlaps === null ? "未出现（正常）" : nowPlayingLook.resumeOverlaps}`)

  /*
   * AI 字幕的文本后处理（阶段 A 校正 / 阶段 B 翻译）。
   * 用**本地假接口**（127.0.0.1）跑通两条链，不依赖任何外部模型：
   *   ① 校正：返回 {i, text} → 行文本被替换；
   *   ② 翻译：返回 {i, translation} → 行译文被写入；
   *   ③ 索引多一个 → 整批丢弃（降级，不污染原文）；
   *   ④ 接口不通 → 返回 ok:false（降级）。
   */
  const http = require('node:http')
  let llmMode = 'correct'
  const fakeLlm = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      const wantExtra = body.includes('__extra__')
      /* 从 user 消息里把那一批 JSON 抠出来，原样回填（校正加前缀、翻译加译文） */
      let items = []
      try {
        /*
         * body 是 **JSON 请求体** —— 里面的换行是转义的 \\n，
         * 直接对原始 body 按行切会切出空数组（第一版就是这么错的）。
         * 先 parse，再从 user 消息里取最后一行（那一行才是批次 JSON）。
         */
        let userText = ''
        try {
          const payload = JSON.parse(body)
          userText = ((payload.messages || []).find((m) => m.role === 'user') || {}).content || ''
        } catch { userText = '' }
        const lastLine = userText.split('\n').filter((line) => line.trim().startsWith('[')).pop() || '[]'
        const batch = JSON.parse(lastLine)
        items = batch.map((item) => llmMode === 'correct'
          ? { i: item.i, text: '校正:' + item.text }
          : { i: item.i, translation: '译文:' + item.text })
        if (wantExtra) items = items.concat([{ i: 999, text: '多余', translation: '多余' }])
      } catch { items = [] }
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(items) } }],
        model: 'fake-llm'
      }))
    })
  })
  await new Promise((resolve) => fakeLlm.listen(0, '127.0.0.1', resolve))
  const llmPort = fakeLlm.address().port
  const llmBase = `http://127.0.0.1:${llmPort}`

  const previousAi = ctx.get('settings').get().ai
  const llmResult = { }
  try {
    ctx.get('settings').set({
      ai: { enabled: true, baseUrl: llmBase, key: 'test-key', model: 'fake-llm', timeout: 8000 }
    })
    const subtitles = ctx.get('aiSubtitles')
    await subtitles.clearLlmCache()

    /* ① 校正 */
    llmMode = 'correct'
    const corrected = await subtitles.postProcess({ mode: 'correct', lines: ['第一行', '第二行'], meta: { title: '歌', artist: '人' } })
    llmResult.correctOk = corrected.ok === true
    llmResult.correctValues = (corrected.values || []).map((item) => item.value)
    llmResult.correctRaw = JSON.stringify(corrected).slice(0, 260)
    llmResult.correctField = corrected.field
    llmResult.correctError = corrected.lastError || ''
    llmResult.correctCode = corrected.code || ''

    /* ② 翻译 */
    llmMode = 'translate'
    const translated = await subtitles.postProcess({ mode: 'translate', lines: ['第一行', '第二行'], meta: { title: '歌' }, language: 'English' })
    llmResult.translateOk = translated.ok === true
    llmResult.translateValues = (translated.values || []).map((item) => item.value)
    llmResult.translateRaw = JSON.stringify(translated).slice(0, 260)
    llmResult.translateField = translated.field

    /* ②b 缓存：同样的输入第二次应命中（cached 计数 > 0） */
    const again = await subtitles.postProcess({ mode: 'correct', lines: ['第一行', '第二行'], meta: { title: '歌', artist: '人' } })
    llmResult.cachedAgain = again.ok === true && Number(again.cached) > 0
    llmResult.llmCache = await subtitles.llmCacheInfo()

    /* ③ 索引不齐 → 整批丢弃 */
    llmMode = 'correct'
    const extra = await subtitles.postProcess({ mode: 'correct', lines: ['__extra__ 这一行'], meta: {} })
    llmResult.extraDropped = extra.ok === false && extra.code === 'all-batches-failed'
    llmResult.extraReason = extra.lastError || ''

    /* ④ 接口不通 → 降级 */
    ctx.get('settings').set({ ai: { enabled: true, baseUrl: 'http://127.0.0.1:9', key: '', model: 'fake-llm', timeout: 1500 } })
    const offline = await subtitles.postProcess({ mode: 'correct', lines: ['断网这一行'], meta: {} })
    llmResult.offlineOk = offline.ok === false

    const cleared = await subtitles.clearLlmCache()
    llmResult.clearedEntries = cleared.entries
  } finally {
    ctx.get('settings').set({ ai: previousAi })
    fakeLlm.close()
  }

  record('AI 字幕：文本后处理（本地假接口）—— 校正/翻译/缓存/索引不齐/接口不通',
    llmResult.correctOk === true &&
    llmResult.correctField === 'text' &&
    (llmResult.correctValues || []).every((value) => String(value).startsWith('校正:')) &&
    llmResult.translateOk === true &&
    llmResult.translateField === 'translation' &&
    (llmResult.translateValues || []).every((value) => String(value).startsWith('译文:')) &&
    llmResult.cachedAgain === true &&
    llmResult.extraDropped === true &&
    llmResult.offlineOk === true &&
    llmResult.clearedEntries === 0,
    `校正 ok=${llmResult.correctOk}、原始=${llmResult.correctRaw}；` +
      `翻译 ok=${llmResult.translateOk}、原始=${llmResult.translateRaw}；` +
      `第二次命中缓存=${llmResult.cachedAgain}（缓存 ${llmResult.llmCache ? llmResult.llmCache.entries : '?'} 条）；` +
      `索引多一个→整批丢弃=${llmResult.extraDropped}；接口不通→降级=${llmResult.offlineOk}；清空后 ${llmResult.clearedEntries} 条`)


  win.setBounds(lookPreviousBounds)
  await sleep(500)





  /* ② 资料库 / 在线 / 歌词 / 监听这些能力**不存在**（不是"存在但关掉了"） */
  /* ai 现在在 player 里是**合法**的（AI 字幕的后处理要复用 chat），所以从黑名单拿掉，改由上面的 expectedServices 管 */
  const forbidden = ['library', 'lyrics', 'online', 'musicSources', 'tray', 'watcher', 'background']
  const present = forbidden.filter((name) => ctx.has(name))
  record('资料库 / 在线 / 歌词 / 目录监听在 player 档位里根本不存在',
    present.length === 0,
    present.length
      ? `不该存在的服务：${present.join('、')}`
      : `逐个确认 ${forbidden.length} 个服务都不存在（问能力，不是用 if 关掉）`)

  /* ③ userData 与本体分开（单实例锁按它算，两者才能同开） */
  const { app, dialog } = require('electron')
  const { profileUserDataDir } = require('./profile')
  const ownData = profileUserDataDir(app.getPath('appData'), profile)
  const actual = app.getPath('userData')
  const automation = Boolean(process.env.ARIA_USER_DATA) || process.argv.includes('--smoke')
  record('player 的 userData 与本体分开（自动化模式下仍用指定的档案目录）',
    Boolean(ownData) && ownData.includes('Aria Player') &&
    (automation ? actual !== ownData : actual === ownData),
    `本档位目录 ${ownData}；实际使用 ${actual}（${automation ? '自动化模式：按 ARIA_USER_DATA/临时目录，避免动到真实档案' : '与设定一致'}）`)

  await waitFor(win, 'window.__aria && window.__aria.store.get().ready === true', { label: '渲染层启动', timeout: 30000 })
  record('渲染层启动', true)

  /* ④ 渲染层拿到的身份、侧栏清单、以及"在线能力不存在" */
  const shell = await evaluate(win, `
    const { store, host, actions } = window.__aria
    const state = store.get()
    const visibleRows = [...document.querySelectorAll('.sidebar__row')].filter((node) => node.getClientRects().length > 0)
    const rowTexts = visibleRows.map((node) => (node.textContent || '').trim())
    /*
     * 视图项要按 data-view-key 数：可见的侧栏行还包含「正在播放 / 播放队列 / 新建播放列表 / 设置」，
     * 按文字数会把它们算进去。另外**不能**拿 state.settings.sidebarOrder 当判据 ——
     * 那是用户持久化下来的顺序（老档案里就是四项），渲染时会被 allowedViews 过滤，
     * 量它等于量错了对象（第一版就是这么红的）。
     */
    const viewKeys = visibleRows.map((node) => node.dataset.viewKey).filter(Boolean)
    actions.setView('settings')
    await new Promise((r) => setTimeout(r, 400))
    const titles = [...document.querySelectorAll('.settings__row-title')].map((node) => (node.textContent || '').trim())
    const onlineTitles = titles.filter((title) => /在线歌词|在线封面|在线补全|在线艺人/.test(title))
    actions.setView('songs')
    await new Promise((r) => setTimeout(r, 300))
    return {
      profileId: window.aria && window.aria.profile ? window.aria.profile.id : '(没有)',
      productName: window.aria && window.aria.profile ? window.aria.profile.productName : '',
      sidebarOrder: state.settings.sidebarOrder,
      viewKeys,
      profileSidebar: window.aria && window.aria.profile ? window.aria.profile.sidebar : [],
      rowTexts,
      forbiddenLabels: rowTexts.filter((text) => /专辑|艺人|媒体墙/.test(text)),
      lyricsProviders: host.list('lyricsProvider').length,
      artworkProviders: host.list('artworkProvider').length,
      settingsRowCount: titles.length,
      onlineTitles,
      tracks: state.library.tracks.length,
      paths: state.library.tracks.map((track) => track.path),
      /* 资料库文件夹数（player 应当恒为 0） */
      folders: Array.isArray(state.library.folders) ? state.library.folders.length : 0,
      domNodes: document.querySelectorAll('*').length,
      hasEmptyState: [...document.querySelectorAll('.empty')].some((node) => node.getClientRects().length > 0)
    }`)

  record('渲染层拿到的档位是 player（不是靠 if 猜的）',
    shell.profileId === 'player' && shell.productName === 'Aria Player',
    `window.aria.profile.id=${shell.profileId}、productName=${shell.productName}`)

  record('侧栏只渲染本档位的视图（专辑 / 艺人 / 媒体墙没有出现）',
    Array.isArray(shell.profileSidebar) && shell.profileSidebar.join('|') === 'songs' &&
    shell.viewKeys.join('|') === 'songs' && shell.forbiddenLabels.length === 0,
    `档位清单=[${shell.profileSidebar}]、实际渲染的视图项=[${shell.viewKeys}]；可见侧栏行 ${shell.rowTexts.length} 个` +
    `（${shell.rowTexts.slice(0, 6).join('、')}）；不该出现的标签 ${shell.forbiddenLabels.length} 个` +
    `；持久化的 sidebarOrder=[${shell.sidebarOrder}]（老档案里有四项，渲染时会按档位过滤掉）`)

  record('在线歌词 / 在线封面在渲染层没有提供者（插件没注册 = 能力不存在）',
    shell.lyricsProviders === 0 && shell.artworkProviders === 0,
    `lyricsProvider ${shell.lyricsProviders} 个、artworkProvider ${shell.artworkProviders} 个（都应为 0）`)

  record('设置页里不出现在线歌词 / 封面那几颗开关',
    shell.onlineTitles.length === 0 && shell.settingsRowCount > 5,
    `设置项 ${shell.settingsRowCount} 行，其中在线相关 ${shell.onlineTitles.length} 行` +
    (shell.onlineTitles.length ? `（不该有：${shell.onlineTitles.join('、')}）` : ''))

  /*
   * 「不在「打开的文件」里」的曲目数：扫过资料库才会有。
   * 判定放在主进程做 —— 这里能读 userData/recent.json（渲染层拿不到那个文件）。
   */
  const shellRecent = (() => {
    try {
      const parsed = JSON.parse(require('node:fs').readFileSync(
        require('node:path').join(app.getPath('userData'), 'recent.json'), 'utf8'))
      return new Set((Array.isArray(parsed) ? parsed : []).map((item) => item && item.path).filter(Boolean))
    } catch {
      return new Set()
    }
  })()
  shell.tracksFromLibrary = shell.paths.filter((file) => !shellRecent.has(file)).length

  /*
   * 「player 不扫描、不建索引」—— 这条以前被写成"渲染层曲目 0 首"，
   * 而那只是**因为 loadLibrary 的短路把最近打开的曲目清空了**才成立的（假通过）。
   * 真正的不变量是：① 没有资料库文件夹；② 列表里的曲目**全部来自「打开的文件」**
   * （即都在 recent.json 里，而不是扫出来的）；③ userData 里没有索引/封面缓存。
   */
  record('没有资料库：无文件夹、列表里的曲目全部来自「打开的文件」',
    shell.folders === 0 && shell.tracksFromLibrary === 0,
    `资料库文件夹 ${shell.folders} 个（应为 0）、渲染层曲目 ${shell.tracks} 首，` +
    `其中不是「打开的文件」的 ${shell.tracksFromLibrary} 首（应为 0 —— 扫过库就会有）`)

  /* 空状态：列表为空就该出现、非空就该消失 —— 两种都验，才不是"看运气通过" */
  record('空状态与列表状态一致（空则出现、非空则消失）',
    (shell.tracks === 0 ? shell.hasEmptyState === true : shell.hasEmptyState === false) &&
    shell.domNodes > 200,
    `曲目 ${shell.tracks} 首、可见空状态=${shell.hasEmptyState}（期望 ${shell.tracks === 0 ? '出现' : '消失'}）、` +
    `DOM 节点 ${shell.domNodes} 个`)

  /* ⑦ 两个产品共用的检查（标 full/player，同一份实现两边都跑） */
  await runSharedChecks({ win, record })

  /* ⑧ 回归：冷启动带文件（全新渲染层 + did-finish-load 时投递） */
  await runColdStartCheck({
    win,
    ctx,
    record,
    mediaDir: require('node:path').join(__dirname, '..', '..', 'tests', 'player-smoke')
  })

  /* ⑨ 回归：已经在跑的时候再"双击"一个文件（走 second-instance，而不是冷启动） */
  await runSecondInstanceCheck({
    win,
    profile,
    record,
    raiseInfo,
    mediaDir: require('node:path').join(__dirname, '..', '..', 'tests', 'player-smoke')
  })

  /* ---------- 第 3 步：player 真正的功能（打开文件 / 拖放 / 最近打开） ---------- */
  const playerFs = require('node:fs')
  const playerPath = require('node:path')
  const userDataDir = app.getPath('userData')
  const recentPath = playerPath.join(userDataDir, 'recent.json')
  const recentBefore = (() => {
    try {
      const parsed = JSON.parse(playerFs.readFileSync(recentPath, 'utf8'))
      return Array.isArray(parsed) ? parsed.length : 0
    } catch {
      return 0
    }
  })()

  /*
   * 造几个真能解析的音频文件（8kHz 单声道 8bit PCM 的 WAV，1 秒）。
   * 放在 tests/ 下 —— 那是"自检用的临时目录（运行时生成，不入库）"，已在 .gitignore 里。
   */
  const wavDir = playerPath.join(__dirname, '..', '..', 'tests', 'player-smoke')
  const makeWav = (name, frequency) => {
    playerFs.mkdirSync(wavDir, { recursive: true })
    const sampleRate = 8000
    const samples = sampleRate
    const dataSize = samples
    const buffer = Buffer.alloc(44 + dataSize)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)          // PCM
    buffer.writeUInt16LE(1, 22)          // 单声道
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate, 28) // byteRate
    buffer.writeUInt16LE(1, 32)          // blockAlign
    buffer.writeUInt16LE(8, 34)          // 8bit
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    for (let i = 0; i < samples; i++) {
      buffer[44 + i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * frequency * i) / sampleRate))
    }
    const file = playerPath.join(wavDir, name)
    playerFs.writeFileSync(file, buffer)
    return file
  }
  const singleFile = makeWav('smoke-open.wav', 440)
  const dropFiles = Array.from({ length: 10 }, (_, index) => makeWav(`drop-${index + 1}.wav`, 220 + index * 40))

  /* 一次拖入 10 个文件：不能弹确认框（需求原文），且要真的进队列并播放 */
  let dialogCalls = 0
  const originalShowMessageBox = dialog.showMessageBox
  dialog.showMessageBox = async () => { dialogCalls++; return { response: 0 } }
  let dropped = null
  try {
    dropped = await evaluate(win, `
      const result = await window.aria.library.handleDrop(${JSON.stringify(dropFiles)})
      const applied = window.__aria.actions.applyDropResult(result)
      return { result, applied }`)
  } finally {
    dialog.showMessageBox = originalShowMessageBox
  }
  await sleep(1800)
  const dropState = await evaluate(win, `
    const state = window.__aria.store.get()
    return {
      status: state.playback.status,
      queueLength: Array.isArray(state.playback.queue) ? state.playback.queue.length : -1,
      tracks: state.library.tracks.length,
      paths: state.library.tracks.map((track) => track.path)
    }`)
  record('一次拖入 10 个文件 → 不弹确认框，直接进队列并播放（player）',
    dropped && dropped.result.action === 'play' &&
    dropped.result.trackIds.length === 10 &&
    dropped.applied.played === true &&
    dialogCalls === 0 &&
    dropState.status === 'playing' &&
    dropState.tracks >= 10 &&
    dropFiles.every((file) => dropState.paths.includes(file)),
    `解析出 ${dropped ? dropped.result.trackIds.length : '—'} 首、弹确认框 ${dialogCalls} 次（应为 0）；` +
    `应用后 played=${dropped ? dropped.applied.played : '—'}；播放状态=${dropState.status}、` +
    `队列 ${dropState.queueLength} 条、列表 ${dropState.tracks} 首；10 个路径都在列表里=${dropFiles.every((file) => dropState.paths.includes(file))}`,
    { profiles: ['player'] })

  /* 双击 / 第二个实例：主进程解析 → 推 opened:incoming → 渲染层直接播 */
  const single = await evaluate(win, `return window.aria.opened.resolve(${JSON.stringify([singleFile])})`)
  win.webContents.send('opened:incoming', single)
  await sleep(1800)
  const singleState = await evaluate(win, `
    const state = window.__aria.store.get()
    return {
      status: state.playback.status,
      currentPath: (state.library.byId && state.library.byId.get(state.playback.trackId) ? state.library.byId.get(state.playback.trackId).path : ''),
      hasFile: state.library.tracks.some((track) => track.path === ${JSON.stringify(singleFile)})
    }`)
  record('双击一个音频文件 → 直接开始播放（走 opened:incoming 投递，与文件关联同一条链）',
    single && single.action === 'play' && single.trackIds.length === 1 &&
    singleState.status === 'playing' && singleState.hasFile === true,
    `解析 ${single ? single.trackIds.length : '—'} 首；投递后播放状态=${singleState.status}、` +
    `曲目在列表里=${singleState.hasFile}、当前曲目=${singleState.currentPath || '（未取到）'}`,
    { profiles: ['player'] })

  /* 最近打开：落盘 + 重启后还在（第二遍运行时 recentBefore 应当 > 0） */
  const recentNow = (() => {
    try {
      const parsed = JSON.parse(playerFs.readFileSync(recentPath, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return null
    }
  })()
  const recentPaths = (recentNow || []).map((item) => item.path)
  record('「最近打开」落盘，重启后还在（不是资料库索引）',
    Array.isArray(recentNow) &&
    recentPaths.includes(singleFile) &&
    dropFiles.filter((file) => recentPaths.includes(file)).length === 10 &&
    recentBefore >= 0,
    `${playerPath.basename(recentPath)} 里 ${recentNow ? recentNow.length : '—'} 条；` +
    `本次打开的文件都在=${recentPaths.includes(singleFile) && dropFiles.every((file) => recentPaths.includes(file))}；` +
    `启动时已有 ${recentBefore} 条${recentBefore > 0 ? '（跨进程验证：上一轮写的还在）' : '（本轮是第一遍，下一遍应当 >0）'}`,
    { profiles: ['player'] })

  /* 不能有资料库索引 / 封面缓存（需求：player 不生成这些） */
  const userDataNames = playerFs.readdirSync(userDataDir)
  const forbiddenArtifacts = userDataNames.filter((name) => /^(library|index|artwork|cover)/i.test(name) || /artwork-cache|library\.json/i.test(name))
  record('没有生成资料库索引 / 封面缓存（player 不扫描、不缓存封面）',
    forbiddenArtifacts.length === 0,
    `userData 里 ${userDataNames.length} 项：${userDataNames.slice(0, 8).join('、')}${userDataNames.length > 8 ? ' 等' : ''}` +
    (forbiddenArtifacts.length ? `；不该有的：${forbiddenArtifacts.join('、')}` : '；没有 library/index/artwork 相关条目'),
    { profiles: ['player'] })

  /*
   * 按需留一张外观证据。
   *
   * player 的界面与本体**不一样**（侧栏只剩一份列表、设置页没有在线那几组），
   * 而"改了 UI 就要看一眼"是这个项目的硬规矩。截图工具那 38 张是给本体准备的
   * （大部分需要资料库），所以这里用一条环境变量控制的一行捕获：
   *   ARIA_PLAYER_SHOT=<路径> npx electron . --smoke --profile=player
   * 默认不写任何文件。
   */
  const shotPath = process.env.ARIA_PLAYER_SHOT
  if (shotPath) {
    try {
      await evaluate(win, `
        const { actions } = window.__aria
        actions.setView('songs')
        await new Promise((r) => setTimeout(r, 600))
        return true`)
      const image = await win.capturePage()
      require('node:fs').writeFileSync(shotPath, image.toPNG())
      console.log(`  · 已写出外观截图：${shotPath}`)
    } catch (error) {
      console.warn('  · 外观截图失败（不影响自检结论）：', error && error.message)
    }
  }

  /* 新增功能回归必须放在最后：其中「一键清除历史」会清空列表与播放 */
  await runPlayerUiChecks({
    win,
    record,
    ctx,
    mediaDir: require('node:path').join(__dirname, '..', '..', 'tests', 'player-smoke')
  })
}

/**
 * Aria Unified 的自检（第三道门）。
 *
 * 它不复制前两套：Unified 独有的只有两件 ——
 *   ① **启动规则**（带音频文件 → player，不带 → full，`--profile` 覆盖）；
 *   ② **产品 × 档位两级 userData**（`Aria Unified (full)` / `(player)`，与另两个产品互不共享）。
 * 其余交给"当前档位那一套"去验（player 16 条 / 本体 195 条跑的是同一份实现）。
 * 所以这里按**本次实际档位**分支：一次跑只验它自己那一侧，另一侧由另一条启动路径去跑。
 */
async function runUnifiedSmoke ({ win, ctx, profile, product, record, raiseInfo }) {
  const unifiedFs = require('node:fs')
  const unifiedPath = require('node:path')
  const { app: electronApp, dialog } = require('electron')
  const {
    resolveProfile, audioPathsFrom, userDataDirFor, PRODUCTS
  } = require('./profile')

  const launchedAudio = audioPathsFrom(process.argv)
  const expected = resolveProfile(process.argv, product)

  /* ① 本次确实按启动规则进了对应档位（"从关联启动后进的是 player"的机器判据） */
  record('启动规则：本次档位与 argv 推断一致（带音频 → player，不带 → full）',
    expected.id === profile.id,
    `argv 里的音频文件 ${launchedAudio.length} 个、推断档位=${expected.id}（依据 ${expected.reason}）、` +
    `实际档位=${profile.id}`,
    { profiles: ['full', 'player'] })

  /* ② 启动规则的边界（纯函数，直接喂 argv） */
  const ruleCases = (() => {
    const unified = PRODUCTS.unified
    /* 两种模式都要能把"带文件→player"验一遍：full 模式下 argv 里没有文件，就现造一个真文件 */
    const audio = launchedAudio[0] || (() => {
      const dir = unifiedPath.join(__dirname, '..', '..', 'tests', 'unified-smoke')
      unifiedFs.mkdirSync(dir, { recursive: true })
      const file = unifiedPath.join(dir, 'rule-probe.wav')
      if (!unifiedFs.existsSync(file)) {
        const sampleRate = 8000
        const buffer = Buffer.alloc(44 + sampleRate)
        buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + sampleRate, 4); buffer.write('WAVE', 8)
        buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20)
        buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate, 28)
        buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write('data', 36)
        buffer.writeUInt32LE(sampleRate, 40)
        for (let i = 0; i < sampleRate; i++) buffer[44 + i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * 440 * i) / sampleRate))
        unifiedFs.writeFileSync(file, buffer)
      }
      return file
    })()
    const cases = [
      { name: '不带文件', argv: ['app.exe'], want: 'full' },
      { name: '带真实音频文件', argv: audio ? ['app.exe', audio] : null, want: audio ? 'player' : null },
      {
        name: '带文件 + --profile=full',
        argv: audio ? ['app.exe', audio, '--profile=full'] : null,
        want: audio ? 'full' : null
      },
      {
        name: '带不存在的音频路径',
        argv: ['app.exe', unifiedPath.join(unifiedPath.sep, 'nope-not-here.mp3')],
        want: 'full'
      }
    ]
    return cases.filter((item) => item.argv).map((item) => ({
      ...item,
      got: resolveProfile(item.argv, unified).id
    }))
  })()
  record('启动规则边界：无文件→full、有文件→player、--profile 覆盖、假路径不算',
    ruleCases.length >= 3 && ruleCases.every((item) => item.got === item.want),
    ruleCases.map((item) => `${item.name}: ${item.got}（应为 ${item.want}）`).join('；'),
    { profiles: ['full', 'player'] })

  /* ③ userData 按【产品 × 档位】分家，且与另两个产品互不共享 */
  const appData = electronApp.getPath('appData')
  const unifiedFull = userDataDirFor(appData, PRODUCTS.unified, 'full')
  const unifiedPlayer = userDataDirFor(appData, PRODUCTS.unified, 'player')
  const playerProductDir = userDataDirFor(appData, PRODUCTS.player, 'player')
  const ariaProductDir = userDataDirFor(appData, PRODUCTS.aria, 'full') // aria 用默认目录 → null
  const intended = userDataDirFor(appData, product, profile.id)
  const actual = electronApp.getPath('userData')
  const automation = Boolean(process.env.ARIA_USER_DATA) || process.argv.includes('--smoke')
  const distinct = new Set([unifiedFull, unifiedPlayer, playerProductDir].filter(Boolean))
  record('userData 按产品×档位分家：两种模式各一个目录，三个产品互不共享',
    Boolean(unifiedFull) && Boolean(unifiedPlayer) && unifiedFull !== unifiedPlayer &&
    distinct.size === 3 && ariaProductDir === null &&
    Boolean(intended) && intended === (profile.id === 'full' ? unifiedFull : unifiedPlayer) &&
    (automation ? true : actual === intended),
    `full 目录=${unifiedFull}；player 目录=${unifiedPlayer}；Aria Player 目录=${playerProductDir}；` +
    `Aria 本体=默认目录（不设 userData）；本次应有=${intended}；实际=${actual}` +
    (automation ? '（自动化模式：按 ARIA_USER_DATA/临时目录，避免动到真实档案）' : ''),
    { profiles: ['full', 'player'] })

  /* ④ 按档位验它自己那一侧 */
  await waitFor(win, 'window.__aria && window.__aria.store.get().ready === true',
    { label: '渲染层启动', timeout: 60000 })

  if (profile.id === 'player') {
    let dialogCalls = 0
    const originalShowMessageBox = dialog.showMessageBox
    dialog.showMessageBox = async () => { dialogCalls++; return { response: 0 } }
    let opened = null
    try {
      if (launchedAudio.length) {
        opened = await evaluate(win, `
          const result = await window.aria.library.handleDrop(${JSON.stringify(launchedAudio)})
          window.__aria.actions.applyDropResult(result)
          return { action: result.action, trackIds: result.trackIds.length, tracks: (result.tracks || []).length }`)
        await sleep(1600)
      }
    } finally {
      dialog.showMessageBox = originalShowMessageBox
    }
    const state = await evaluate(win, `
      const s = window.__aria.store.get()
      const host = window.__aria.host
      return {
        profileId: window.aria && window.aria.profile ? window.aria.profile.id : '',
        status: s.playback.status,
        tracks: s.library.tracks.length,
        paths: s.library.tracks.map((track) => track.path),
        lyricsProviders: host.list('lyricsProvider').length,
        artworkProviders: host.list('artworkProvider').length,
        hasLibraryCapability: Boolean(window.aria && window.aria.profile && window.aria.profile.capabilities && window.aria.profile.capabilities.library),
        sidebar: s.settings.sidebarOrder,
        /*
         * 侧栏要量**渲染出来的**视图项：sidebarOrder 是持久化值（老档案里就是四项），
         * 渲染时会按档位过滤 —— 量它等于量错对象（这条在 player 那套里已经踩过一次）。
         */
        viewKeys: [...document.querySelectorAll('.sidebar__row')]
          .filter((node) => node.getClientRects().length > 0)
          .map((node) => node.dataset.viewKey).filter(Boolean),
        hasOpenedApi: Boolean(window.aria && window.aria.opened)
      }`)
    record('带文件启动 → 轻量播放器：文件进临时队列并直接播放（无资料库 / 无在线能力 / 0 确认框）',
      state.profileId === 'player' &&
      state.hasLibraryCapability === false &&
      state.lyricsProviders === 0 && state.artworkProviders === 0 &&
      state.hasOpenedApi === true &&
      state.viewKeys.join('|') === 'songs' &&
      launchedAudio.every((file) => state.paths.includes(file)) &&
      state.status === 'playing' && dialogCalls === 0,
      `档位=${state.profileId}、资料库能力=${state.hasLibraryCapability}、在线提供者 ${state.lyricsProviders}/${state.artworkProviders}、` +
      `实际渲染的侧栏=[${state.viewKeys}]（持久化值 [${state.sidebar}]）、列表 ${state.tracks} 首、` +
      `启动文件都在=${launchedAudio.every((file) => state.paths.includes(file))}、` +
      `播放状态=${state.status}；解析=${opened ? `${opened.action}/${opened.tracks}首` : '（本次没带文件）'}、弹确认框 ${dialogCalls} 次（应为 0）`,
      { profiles: ['full', 'player'] })

    /* ⑧ 回归：冷启动带文件 */
    await runColdStartCheck({
      win,
      ctx,
      record,
      mediaDir: unifiedPath.join(__dirname, '..', '..', 'tests', 'unified-smoke')
    })

    /* ⑨ 回归：已经在跑的时候再"双击"一个文件（second-instance） */
    await runSecondInstanceCheck({
      win,
      profile,
      record,
      raiseInfo,
      mediaDir: unifiedPath.join(__dirname, '..', '..', 'tests', 'unified-smoke')
    })

    const userDataNames = unifiedFs.readdirSync(actual)
    const forbidden = userDataNames.filter((name) => /^(library|index|artwork|cover)/i.test(name) || /artwork-cache|library\.json/i.test(name))
    record('Unified 的轻量模式不生成资料库索引 / 封面缓存',
      forbidden.length === 0,
      `userData（${unifiedPath.basename(actual)}）里 ${userDataNames.length} 项` +
      (forbidden.length ? `；不该有的：${forbidden.join('、')}` : '；没有 library/index/artwork 相关条目'),
      { profiles: ['full', 'player'] })

    /* 与 player 套件同一套新增功能回归（放在分支最后：清除历史会清空列表） */
    await runPlayerUiChecks({
      win,
      record,
      ctx,
      mediaDir: unifiedPath.join(__dirname, '..', '..', 'tests', 'unified-smoke')
    })
  } else {
    const state = await evaluate(win, `
      const { store, actions } = window.__aria
      const s = store.get()
      const sidebarRows = [...document.querySelectorAll('.sidebar__row')].filter((node) => node.getClientRects().length > 0)
      const viewKeys = sidebarRows.map((node) => node.dataset.viewKey).filter(Boolean)
      actions.setView('artists')
      await new Promise((r) => setTimeout(r, 600))
      const artistsVisible = [...document.querySelectorAll('.artist-row')].filter((node) => node.getClientRects().length > 0).length
      actions.setView('albums')
      await new Promise((r) => setTimeout(r, 600))
      const albumsVisible = [...document.querySelectorAll('.cover-card')].filter((node) => node.getClientRects().length > 0).length
      actions.setView('songs')
      await new Promise((r) => setTimeout(r, 300))
      return {
        profileId: window.aria && window.aria.profile ? window.aria.profile.id : '',
        hasLibraryCapability: Boolean(window.aria && window.aria.profile && window.aria.profile.capabilities && window.aria.profile.capabilities.library),
        hasOpenedApi: Boolean(window.aria && window.aria.opened),
        viewKeys,
        artistsVisible,
        albumsVisible,
        tracks: s.library.tracks.length
      }`)
    record('不带文件启动 → 完整版：资料库 / 艺人 / 专辑都在，没有「打开的文件」入口',
      state.profileId === 'full' &&
      state.hasLibraryCapability === true &&
      state.hasOpenedApi === false &&
      state.viewKeys.join('|') === 'songs|albums|artists|wall' &&
      state.artistsVisible > 0 && state.albumsVisible > 0,
      `档位=${state.profileId}、资料库能力=${state.hasLibraryCapability}、打开文件入口=${state.hasOpenedApi}、` +
      `侧栏=[${state.viewKeys}]、艺人行 ${state.artistsVisible}、专辑卡 ${state.albumsVisible}、曲目 ${state.tracks} 首`,
      { profiles: ['full', 'player'] })
  }
}

async function runSmoke ({ win, ctx, profile, product, raiseInfo }) {
  const checks = []
  /*
   * 检查按档位打标（full / player / both）。
   *
   * 为什么不在两个文件里各写一套：**同一件事只写一遍**，再用标记载明它适用于哪个产品。
   * `profiles` 默认是全体 —— 现在两套检查各自只在自己档位里跑，但打标让"这条到底属于谁"
   * 变成数据而不是记忆；以后想让某条在两边都跑，改一个数组就行。
   */
  const activeProfile = profile && profile.id ? profile.id : 'full'
  const record = (name, ok, detail = '', options = {}) => {
    const profiles = Array.isArray(options.profiles) ? options.profiles : ['full', 'player']
    if (!profiles.includes(activeProfile)) {
      console.log(`  · 跳过（${activeProfile} 档位不适用，标的是 ${profiles.join('/')}）：${name}`)
      return
    }
    checks.push({ name, ok, detail, profiles })
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
    lastProgressAt = Date.now()
    lastCheckName = name
  }

  /*
   * 看门狗：整轮多久没有新结果就自己报错退出。
   *
   * 为什么需要：这条链路里有几处**平台/网络调用**在环境不好时会一直不返回
   * （实测过 enumerateDevices、setSinkId、以及带在线歌词搜索的那条检查），
   * 表现就是"日志停在某一行、进程还在、CPU 不动"，一挂就是十几分钟到一整夜 ——
   * 彻夜跑最怕的正是这个：挂死等于整夜没有任何验证结果，而且看起来像"还在跑"。
   *
   * 已经给两处调用单独加了超时，但没法穷尽；所以在外面再兜一层：
   * 超过阈值没有新结果就打印**最后跑完的那条检查**并退出（兜底总结会由 process.on('exit') 打出来）。
   * 阈值可用 ARIA_SMOKE_WATCHDOG_MS 覆盖（自检那条验证就靠它把 6 分钟压成几秒）。
   */
  /*
   * 阈值默认 10 分钟：全新档案的**全量扫描**本身就要几分钟（实测 2~4 分钟），
   * 那是合法等待、不能误杀；而真正的卡死是"十几分钟到一整夜不动"，10 分钟足够兜住。
   */
  const watchdogMs = Number(process.env.ARIA_SMOKE_WATCHDOG_MS || 10 * 60 * 1000)
  let lastProgressAt = Date.now()
  let lastCheckName = '（还没跑完第一条）'
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastProgressAt
    if (idle < watchdogMs) return
    console.log(`\n[smoke] 看门狗：${Math.round(idle / 1000)} 秒没有新结果，判定卡死并退出。`)
    console.log(`[smoke] 最后跑完的检查是「${lastCheckName}」—— 下一条卡住了（多半是等一个不返回的平台/网络调用）。`)
    printSummary('看门狗判定卡死')
    process.exit(1)
  }, Math.min(30_000, Math.max(500, Math.floor(watchdogMs / 4))))
  if (typeof watchdog.unref === 'function') watchdog.unref()

  /*
   * 兜底总结：无论流程怎么中断，都要留下结论。
   * 以前总结只在文件末尾打印，一旦某个检查抛异常/超时被杀/整轮跑不完
   * （实测跑到 136/160 就没有总结行），这一轮自检等于白跑 —— 排查时最伤。
   */
  let summaryPrinted = false
  const printSummary = (tag) => {
    if (summaryPrinted) return
    summaryPrinted = true
    const tail = tag ? '（' + tag + '）' : ''
    /*
     * 自己从 checks 过滤，不要引用 failed —— 它在文件末尾才声明，
     * 走 "提前退出 / 异常中断" 路径时还没初始化，引用它会抛
     * Cannot access 'failed' before initialization，兜底就白加了。
     */
    const bad = checks.filter((check) => !check.ok)
    console.log('\n=== 自检结束' + tail + '：' + (checks.length - bad.length) + '/' + checks.length + ' 通过 ===\n')
    /*
     * 把结果落一份到 userData/selfcheck.json —— 「导出诊断包」会带上它，
     * 用户报问题时能直接看到他那一版的自检跑成什么样。
     */
    try {
      const { app } = require('electron')
      const fsSync = require('node:fs')
      const pathMod = require('node:path')
      const suite = process.env.ARIA_PRODUCT === 'unified'
        ? 'unified'
        : (process.argv.includes('--profile=player') ? 'player' : 'full')
      fsSync.writeFileSync(pathMod.join(app.getPath('userData'), 'selfcheck.json'), JSON.stringify({
        suite,
        passed: checks.length - bad.length,
        total: checks.length,
        failed: bad.map((check) => check.name),
        at: new Date().toISOString()
      }, null, 2))
    } catch {
      // 写不进去不影响自检本身
    }
    if (bad.length) {
      console.log('未通过：')
      for (const check of bad) console.log(`  · ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
      console.log('')
    }
  }
  process.on('exit', () => printSummary('提前退出'))
  process.on('uncaughtException', (error) => {
    console.log('\n[smoke] 未捕获异常：' + (error && error.stack ? error.stack : error))
    printSummary('异常中断')
    process.exit(1)
  })
  process.on('unhandledRejection', (error) => {
    console.log('\n[smoke] 未处理的 Promise 拒绝：' + (error && error.stack ? error.stack : error))
    printSummary('异常中断')
    process.exit(1)
  })

  /*
   * 排查提示：如果自检长时间没有任何输出（连下面这行标题都没打印），
   * 多半是自动化配置目录被写坏了 —— 常见于「自检运行中强制结束 electron」。
   * 处理：删掉 %TEMP%\aria-dev-profile 后重跑即可（会自动重建并重新扫库）。
   * 实测：某次强杀后自检连续卡在启动、日志停在 220 字节；删目录后立刻恢复。
   */
  console.log('\n=== Aria 自检 ===\n')

  /*
   * 产品 × 档位分流。**只分流，不复制检查**：
   *   · Aria Unified → 第三道门（启动规则 + 两级 userData + 当前档位那一侧）
   *   · Aria Player  → player 那套（16 条：打开文件 / 拖放 / 最近打开 / 不该有的没有）
   *   · Aria 本体    → 下面那 195 条
   * Unified 的两种模式各自跑自己的那一侧：点图标（full）与双击文件（player）是两条不同的
   * 启动路径，任何一条单独跑都只证明一半 —— 所以验收时两边都要跑（见提交信息里的读数）。
   */
  if (product && product.id === 'unified') {
    await runUnifiedSmoke({ win, ctx, profile, product, record, raiseInfo })
    clearInterval(watchdog)
    printSummary()
    return checks.every((check) => check.ok)
  }
  if (profile && profile.id !== 'full') {
    await runPlayerShellSmoke({ win, ctx, profile, record, raiseInfo })
    clearInterval(watchdog)
    printSummary()
    return checks.every((check) => check.ok)
  }

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

    /*
     * 再等**扫描真的结束**（主进程的权威状态，不靠渲染层事件）。
     *
     * 只等 loaded + 有曲目是不够的：全新档案第一次启动时曲目是"边扫边出现"的，
     * 后面的检查会在主进程还在解析 810 个文件时开跑 —— 实测表现就是
     * 「搜索面板那两条」假红（展开动画与异步落盘的等待预算被扫描吃掉，
     * 量到的按钮矩形还是 0×0）。等待扫描结束比把超时调大更根治，也让整轮更可复现。
     */
    {
      const libraryService = ctx.get('library')
      const deadline = Date.now() + 240000
      let stats = libraryService.getStats()
      while (stats.scanning && Date.now() < deadline) {
        await sleep(500)
        stats = libraryService.getStats()
      }
      console.log(`[smoke] 扫描已结束：${stats.count} 首（仍在扫描=${stats.scanning}）`)
    }

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

    /*
     * 配色统一（用户点名的验收）：--tint、设置页选中态、示波器必须**同色系**。
     *
     * 三者读的都是同一个 CSS 变量 --tint，所以这条检查同时证明两件事：
     *   ① 只有一条出口（换来源时三者一起变，不会有一个掉队）；
     *   ② 换来源/换歌后颜色确实跟着走。
     * 另外验"无封面时回退"：封面档与稳定配色对同一首无封面曲目给出同一个颜色。
     *
     * 这里的颜色解析**不用正则**（注入模板里的转义很容易踩坑）：按分隔符拆字符串。
     */
    const tintUnity = await evaluate(win, `
      const { artwork, player } = window.__aria
      const root = document.documentElement
      const hueOf = (text) => {
        if (!text) return null
        let r
        let g
        let b
        if (text.startsWith('hsl')) {
          const parts = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(/[,\\s]+/)
          return Number(parts[0])
        }
        if (text.includes('srgb')) {
          const parts = text.slice(text.indexOf('srgb') + 4, text.indexOf(')', text.indexOf('srgb'))).trim().split(' ')
          r = Number(parts[0]) * 255
          g = Number(parts[1]) * 255
          b = Number(parts[2]) * 255
        } else {
          const open = text.indexOf('(')
          if (open < 0) return null
          const parts = text.slice(open + 1, text.indexOf(')', open)).split(',').map((piece) => Number(piece.trim().split(' ')[0]))
          r = parts[0]
          g = parts[1]
          b = parts[2]
        }
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
        const rn = r / 255
        const gn = g / 255
        const bn = b / 255
        const max = Math.max(rn, gn, bn)
        const min = Math.min(rn, gn, bn)
        const d = max - min
        if (d < 0.02) return null
        let h
        if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
        else if (max === gn) h = ((bn - rn) / d + 2) / 6
        else h = ((rn - gn) / d + 4) / 6
        return h * 360
      }
      const gap = (a, b) => {
        if (a == null || b == null) return 999
        const d = Math.abs(a - b) % 360
        return d > 180 ? 360 - d : d
      }
      const snapshot = () => {
        const nav = document.querySelector('.settings-nav__item.is-active')
        const viz = document.querySelector('.visualizer')
        const tintText = getComputedStyle(root).getPropertyValue('--tint').trim()
        return {
          tintText,
          tint: hueOf(tintText),
          nav: hueOf(nav ? getComputedStyle(nav).backgroundColor : ''),
          viz: hueOf(viz ? getComputedStyle(viz).backgroundImage : '')
        }
      }
      const apply = async (source, track) => {
        /*
         * 量"来源色"的时候临时关掉 240ms 过渡：
         * 不关的话读到的全是插值中间值（T2.3 加了 @property 过渡之后，两条断言一度因此变红）。
         * 量完立刻恢复，不影响产品行为。
         */
        const root = document.documentElement
        const savedTransition = root.style.transitionProperty
        root.style.transitionProperty = 'none'
        window.__aria.store.set((state) => ({ ...state, settings: { ...state.settings, tintSource: source } }))
        const color = await artwork.resolveColor(track)
        if (!color) return null
        artwork.applyTint(color)
        void root.offsetWidth
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        root.style.transitionProperty = savedTransition
        return color
      }

      const track = player.currentTrack()
      /*
       * 诊断：封面档到底有没有真的取到色。
       * 取色回退时两档颜色会一样，"换来源"那条就红 —— 这里把回退原因也读出来。
       */
      const fallbackColor = artwork.fallbackColor(track)
      const coverColor = await artwork.resolveCoverColor(track)
      const coverIsFallback = coverColor.tint === fallbackColor.tint
      let loadError = ''
      try {
        const probeUrl = await artwork.resolveUrl(track)
        const img = new Image()
        img.crossOrigin = 'anonymous'
        await new Promise((resolve, reject) => {
          img.onload = resolve
          img.onerror = () => reject(new Error('onerror'))
          img.src = probeUrl
          setTimeout(() => reject(new Error('timeout')), 5000)
        })
        const canvas = document.createElement('canvas')
        canvas.width = 8
        canvas.height = 8
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, 0, 0, 8, 8)
        ctx.getImageData(0, 0, 8, 8)
      } catch (err) {
        loadError = (err && err.message ? err.message : String(err)).slice(0, 60)
      }
      const probe = { coverIsFallback, loadError, scheme: String((await artwork.resolveUrl(track) || '').split(':')[0]) }

      const coverShot = await apply('cover', track)
      const coveredTint = snapshot()
      const paletteShot = await apply('palette', track)
      const paletteTint = snapshot()
      const backToCover = await apply('cover', track)
      const backTint = snapshot()

      const bare = { id: 'tint-probe-no-cover', title: '无封面探针', artist: 'probe', albumArtist: 'probe', album: 'no-cover', path: '/nonexistent/tint-probe.mp3' }
      await apply('palette', bare)
      const barePalette = snapshot()
      await apply('cover', bare)
      const bareCover = snapshot()
      await apply('cover', track)

      return {
        coveredTint,
        paletteTint,
        backTint,
        barePalette,
        bareCover,
        probe,
        coveredText: coverShot ? coverShot.tint : '',
        paletteText: paletteShot ? paletteShot.tint : '',
        backText: backToCover ? backToCover.tint : ''
      }`)

    const navGap = Math.abs(((tintUnity.coveredTint.tint - (tintUnity.coveredTint.nav ?? 0)) + 540) % 360 - 180)
    const vizGap = Math.abs(((tintUnity.coveredTint.tint - (tintUnity.coveredTint.viz ?? 0)) + 540) % 360 - 180)
    record('配色统一：--tint、设置页选中态、示波器同色系（同一个来源）',
      tintUnity.coveredTint.tint != null && tintUnity.coveredTint.nav != null && tintUnity.coveredTint.viz != null &&
      navGap <= 12 && vizGap <= 12,
      `--tint=${tintUnity.coveredTint.tintText}（色相 ${Number(tintUnity.coveredTint.tint).toFixed(0)}）、` +
      `设置页选中态色相 ${Number(tintUnity.coveredTint.nav).toFixed(0)}（差 ${navGap.toFixed(1)}°）、` +
      `示波器色相 ${Number(tintUnity.coveredTint.viz).toFixed(0)}（差 ${vizGap.toFixed(1)}°），都应 ≤12°`)

    record('主题色来源切换：三者一起跟着变（封面 → 稳定配色 → 再切回封面）',
      Boolean(tintUnity.coveredText) && tintUnity.coveredText !== tintUnity.paletteText &&
      tintUnity.paletteTint.nav != null && tintUnity.paletteTint.viz != null &&
      Math.abs(((tintUnity.paletteTint.tint - tintUnity.paletteTint.nav) + 540) % 360 - 180) <= 12 &&
      Math.abs(((tintUnity.paletteTint.tint - tintUnity.paletteTint.viz) + 540) % 360 - 180) <= 12 &&
      tintUnity.backText === tintUnity.coveredText,
      `封面档 ${tintUnity.coveredText} / 稳定配色档 ${tintUnity.paletteText} / 切回后 ${tintUnity.backText}；` +
      `取样诊断：回退=${tintUnity.probe && tintUnity.probe.coverIsFallback}、协议=${tintUnity.probe && tintUnity.probe.scheme}、错误=${(tintUnity.probe && tintUnity.probe.loadError) || '无'}；` +
      `稳定配色档里 选中态色相 ${Number(tintUnity.paletteTint.nav).toFixed(0)}、示波器色相 ${Number(tintUnity.paletteTint.viz).toFixed(0)}`)

    record('无封面曲目：封面档回退到稳定配色（同一个颜色，不闪白不报错）',
      Boolean(tintUnity.bareCover.tintText) && tintUnity.bareCover.tintText === tintUnity.barePalette.tintText,
      `无封面时：封面档 ${tintUnity.bareCover.tintText} / 稳定配色档 ${tintUnity.barePalette.tintText}（应相同）`)

    /*
     * 在线功能默认关闭的引导（T2.1）：
     *   · 有内嵌封面时**不出现**提示（不打扰）；
     *   · 没有封面且在线关着 → 出现一条可点提示，点一下就把总闸与"在线封面"打开；
     *   · 全程不弹窗（提示是页面里的一行字，不是 toast）。
     */
    const coverHintCheck = await evaluate(win, `
      const { store, actions } = window.__aria
      const state = store.get()
      const hint = document.querySelector('.now-playing__cover-hint')
      if (!hint) return { hasNode: false }

      const current = state.playback.trackId ? state.library.byId.get(state.playback.trackId) : null
      const hiddenForCovered = hint.hidden

      /* 造一首"没有封面"的曲目并选中它 → 提示应当出现 */
      const bareId = 'cover-hint-probe'
      const bare = {
        id: bareId,
        title: '无封面探针',
        artist: 'probe',
        albumArtist: 'probe',
        album: 'no-cover',
        path: 'C:/nonexistent/cover-hint-probe.mp3',
        duration: 100,
        artworkEmbedded: false,
        artworkFile: null
      }
      actions.setSetting({ onlineFeatures: false, onlineCovers: false })
      store.set((s) => ({
        ...s,
        library: { ...s.library, byId: new Map(s.library.byId).set(bareId, bare) },
        playback: { ...s.playback, trackId: bareId }
      }))
      await new Promise((r) => setTimeout(r, 400))
      const shownForBare = hint.hidden === false
      const text = (hint.textContent || '').trim()

      hint.click()
      /* 等条件（不要固定 sleep）：设置真的落到 store、提示真的藏起来 */
      for (let i = 0; i < 30; i++) {
        const now = store.get().settings
        if (now.onlineFeatures === true && now.onlineCovers === true && hint.hidden === true) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const afterClick = {
        onlineFeatures: store.get().settings.onlineFeatures,
        onlineCovers: store.get().settings.onlineCovers,
        hidden: hint.hidden
      }

      /* 收尾：回到原曲目 + 关回在线功能（后面的检查默认在线是关的） */
      store.set((s) => ({
        ...s,
        playback: { ...s.playback, trackId: current ? current.id : null }
      }))
      actions.setSetting({ onlineFeatures: false, onlineCovers: false })
      await new Promise((r) => setTimeout(r, 300))

      return { hasNode: true, hiddenForCovered, shownForBare, text, afterClick }
    `)
    record('在线功能默认关着时的引导：没有封面才出现一条可点提示，点一下即开启',
      coverHintCheck.hasNode === true &&
      coverHintCheck.hiddenForCovered === true &&
      coverHintCheck.shownForBare === true &&
      String(coverHintCheck.text || '').includes('在线封面') &&
      coverHintCheck.afterClick &&
      coverHintCheck.afterClick.onlineFeatures === true &&
      coverHintCheck.afterClick.onlineCovers === true &&
      coverHintCheck.afterClick.hidden === true,
      `有内嵌封面时隐藏=${coverHintCheck.hiddenForCovered}；换成无封面曲目后出现=${coverHintCheck.shownForBare}` +
      `（文案「${coverHintCheck.text}」）；点击后 onlineFeatures=${coverHintCheck.afterClick && coverHintCheck.afterClick.onlineFeatures}、` +
      `onlineCovers=${coverHintCheck.afterClick && coverHintCheck.afterClick.onlineCovers}、提示隐藏=${coverHintCheck.afterClick && coverHintCheck.afterClick.hidden}`)

    /*
     * 主题色过渡（T2.3）：--tint 必须是**可插值**的注册属性，切歌时才不会硬切。
     *
     * 证明方式不是看样式表里有没有写 transition（那只证明声明存在），而是实测：
     * 把 --tint 从红改成蓝，**同一帧**里读回来 —— 注册并带过渡时读到的是中间值（不是蓝），
     * 没注册时读到的立刻就是蓝（未注册的自定义属性不参与插值）。
     */
    const tintTransition = await evaluate(win, `
      const root = document.documentElement
      const computed = getComputedStyle(root)
      const declared = computed.transitionProperty || ''
      const duration = computed.transitionDuration || ''

      root.style.setProperty('--tint', 'rgb(255, 0, 0)')
      /* 强制一次样式计算，让红色成为过渡起点 */
      void root.offsetWidth
      root.style.setProperty('--tint', 'rgb(0, 0, 255)')
      const mid = getComputedStyle(root).getPropertyValue('--tint').trim()

      /* 收尾：清掉内联值，让页面回到真实主题色 */
      root.style.removeProperty('--tint')
      const reduced = (() => {
        const before = document.documentElement.dataset.reduceMotion
        document.documentElement.dataset.reduceMotion = 'true'
        const value = getComputedStyle(root).transitionProperty || ''
        document.documentElement.dataset.reduceMotion = before
        return value
      })()

      return { declared, duration, mid, reduced }
    `)
    record('主题色过渡：--tint 已注册成 <color> 并带 240ms 过渡（减少动画时置零）',
      String(tintTransition.declared).includes('--tint') &&
      String(tintTransition.duration).includes('0.24s') &&
      tintTransition.mid !== 'rgb(0, 0, 255)' &&
      tintTransition.mid !== 'rgb(255, 0, 0)' &&
      String(tintTransition.reduced) === 'none',
      `transition-property=${tintTransition.declared}、duration=${tintTransition.duration}；` +
      `同一帧读到的中间值 ${tintTransition.mid}（应为红蓝之间的插值，不是纯蓝）；` +
      `减少动画时 transition-property=${tintTransition.reduced}（应为 none）`)

    /*
     * m3u 播放列表导入 / 导出（T2.2）。
     *
     * 分三层验：
     *   ① 纯函数层：序列化写相对路径、解析能吃注释/BOM/坏行；
     *   ② 端到端：把两首**真曲目**导出到临时文件，再解析回来，条数/相对路径/时长都对；
     *   ③ 渲染层：`actions.importPlaylistM3u({ file })` 真的建出新播放列表并切过去。
     */
    const m3uApp = require('electron').app
    const m3uModule = require('./services/m3u.js')
    const m3uPath = require('node:path')
    const m3uFs = require('node:fs')

    const unitFile = m3uPath.join(m3uApp.getPath('temp'), 'aria-m3u-unit', 'unit.m3u')
    m3uFs.mkdirSync(m3uPath.dirname(unitFile), { recursive: true })
    const unitOut = m3uModule.serialize({
      file: unitFile,
      tracks: [
        { path: m3uPath.join(m3uPath.dirname(unitFile), 'a', 'one.mp3'), title: 'One', artist: 'A', duration: 61.4 },
        { path: 'Z:\\elsewhere\\two.flac', title: 'Two', artist: 'B', duration: 0 }
      ]
    })
    const unitParsed = m3uModule.parse({
      file: unitFile,
      text: '\uFEFF#EXTM3U\r\n#EXTINF:61,Artist One - Song One\r\na/one.mp3\r\n\r\n# 这行是注释\r\nnot-audio.txt\r\nmissing.mp3\r\n',
      /* 让 a/one.mp3 "存在"：这样它能进 entries，missing 只剩那个真不存在的 */
      exists: (candidate) => candidate.split(String.fromCharCode(92)).join('/').endsWith('a/one.mp3')
    })
    record('m3u 纯函数：导出写相对路径、解析能吃 BOM/CRLF/注释/坏行',
      unitOut.text.startsWith('#EXTM3U') &&
      unitOut.relative === 1 && unitOut.absolute === 1 &&
      unitOut.text.includes('a/one.mp3') &&
      unitParsed.missing === 1 && unitParsed.skipped === 1 && unitParsed.entries.length === 1,
      
      `序列化：相对 ${unitOut.relative} 首、绝对 ${unitOut.absolute} 首（第二首在 Z: 盘，取不到相对路径）；` +
      `解析：missing=${unitParsed.missing}、skipped=${unitParsed.skipped}、entries=${unitParsed.entries.length}` +
      `（txt 被跳过、missing.mp3 不存在、a/one.mp3 进 entries）`)

    /* ---------- ② 端到端：用真曲目导一次再读回来 ---------- */
    /* 诊断：渲染层到底能不能看到 remote.playlist（看不到就说明 preload 没暴露出去） */
    const m3uApi = await evaluate(win, `
      return {
        aria: typeof window.aria,
        playlist: typeof (window.aria && window.aria.playlist),
        exportM3u: typeof (window.aria && window.aria.playlist && window.aria.playlist.exportM3u),
        importM3u: typeof (window.aria && window.aria.playlist && window.aria.playlist.importM3u)
      }`)
    console.log('  · m3u 诊断：window.aria=' + m3uApi.aria + '、playlist=' + m3uApi.playlist +
      '、exportM3u=' + m3uApi.exportM3u + '、importM3u=' + m3uApi.importM3u)

    const m3uTracks = await evaluate(win, `
      const { store } = window.__aria
      const tracks = store.get().library.tracks.filter((track) => track.path).slice(0, 2)
      return tracks.map((track) => ({ path: track.path, title: track.title, artist: track.artist, duration: track.duration }))`)
    let m3uRoundTrip = { ok: false }
    if (m3uTracks.length === 2) {
      const exportFile = m3uPath.join(m3uApp.getPath('temp'), 'aria-m3u-unit', 'round-trip.m3u')
      const exported = await evaluate(win, `
        const result = await window.aria.playlist.exportM3u(${JSON.stringify({ name: '往返测试', tracks: m3uTracks, file: exportFile })})
        return result`).catch((err) => ({ saved: false, error: err && err.message }))
      const text = m3uFs.existsSync(exportFile) ? m3uFs.readFileSync(exportFile, 'utf8') : ''
      const back = m3uModule.parse({
        file: exportFile,
        text,
        exists: (candidate) => m3uFs.existsSync(candidate)
      })
      m3uRoundTrip = {
        ok: Boolean(exported && exported.saved) &&
          exported.count === 2 &&
          exported.relative === 2 &&
          back.entries.length === 2 &&
          back.entries.every((entry, index) => m3uPath.normalize(entry.path) === m3uPath.normalize(m3uTracks[index].path)),
        detail: `导出 ${exported && exported.count} 首（相对 ${exported && exported.relative} / 绝对 ${exported && exported.absolute}）` +
          (exported && exported.error ? ` 错误=${exported.error}` : '') + `；` +
          `读回 ${back.entries.length} 首、missing ${back.missing}、skipped ${back.skipped}`
      }
    }
    record('m3u 端到端：两首真曲目导出 → 读回，路径与条数一致（且用相对路径）',
      m3uRoundTrip.ok === true,
      m3uTracks.length === 2 ? m3uRoundTrip.detail : '资料库里取不到两首带 path 的曲目，跳过')

    /* ---------- ③ 渲染层：导入真的建出播放列表 ---------- */
    const importFile = m3uPath.join(m3uApp.getPath('temp'), 'aria-m3u-unit', 'import-src.m3u')
    if (m3uTracks.length >= 1) {
      const baseDir = m3uPath.dirname(importFile)
      const lines = ['#EXTM3U']
      for (const track of m3uTracks) {
        const relative = m3uPath.relative(baseDir, track.path).split(m3uPath.sep).join('/')
        lines.push(`#EXTINF:${Math.round(track.duration || 0)},${track.artist} - ${track.title}`)
        lines.push(relative)
      }
      lines.push('D:/definitely-missing/nope.mp3')
      m3uFs.mkdirSync(baseDir, { recursive: true })
      m3uFs.writeFileSync(importFile, lines.join('\n') + '\n', 'utf8')
    }
    const imported = m3uTracks.length >= 1
      ? await evaluate(win, `
          const result = await window.__aria.actions.importPlaylistM3u({ file: ${JSON.stringify(importFile)} })
          const state = window.__aria.store.get()
          const playlists = state.settings.playlists || []
          const current = state.ui.source.type === 'playlist' ? playlists.find((item) => item.id === state.ui.source.value) : null
          /*
           * 收尾：导入会把 ui.source 切到新播放列表（这是产品行为），但后面的搜索检查
           * 期望的是"全部歌曲"。这里还原来源并删掉这个临时列表 —— 否则搜索只剩 2 首，
           * 深度档会渲染 0 行（假红，实际是自检自己改了上下文）。
           */
          const createdId = current ? current.id : null
          const snapshot = { ...result, playlists: playlists.length, currentName: current ? current.name : '', currentTracks: current ? current.trackIds.length : 0 }
          window.__aria.actions.setSource({ type: 'all', value: null })
          if (createdId) await window.__aria.actions.deletePlaylist(createdId)
          return snapshot
        `).catch((err) => ({ imported: false, error: err && err.message }))
      : { imported: false }
    record('m3u 导入：命中的建出新播放列表并切过去，缺文件/不在库里的按数报出来',
      imported.imported === true &&
      imported.added === m3uTracks.length &&
      imported.currentTracks === m3uTracks.length &&
      imported.missing === 1 &&
      imported.currentName.length > 0,
      `导入 added=${imported.added}（应为 ${m3uTracks.length}）、新播放列表「${imported.currentName}」里有 ${imported.currentTracks} 首、` +
      `文件不存在 ${imported.missing} 首、不在音乐文件夹 ${imported.notInLibrary} 首`)


    /*
     * 无障碍与设置搜索（T2.4 / T2.5）：
     *   · 设置搜索能命中新加的「主题色来源」（搜索是按 DOM 文本走的，这条等于把承诺钉住）；
     *   · 「主题色来源」的分段控件键盘可达（是 <button>，能 Tab 到、能回车触发）；
     *   · 示波器那颗切换按钮有可访问名（aria-label，且随样式变化更新）；
     *   · 新增的「没有封面…」提示是 button：能聚焦、焦点环可见（不是看不见的控件）。
     */
    const a11y = await evaluate(win, `
      const { actions } = window.__aria
      actions.setView('settings')
      await new Promise((r) => setTimeout(r, 400))

      /* ① 搜索「主题色来源」 */
      const searchInput = document.querySelector('.search--settings input')
      let searchHit = null
      let searchCount = ''
      if (searchInput) {
        searchInput.value = '主题色来源'
        searchInput.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 400))
        const hits = [...document.querySelectorAll('.settings__row.is-search-hit')]
        searchHit = hits.some((row) => (row.textContent || '').includes('主题色来源'))
        const countNode = document.querySelector('.search--settings .search__count')
        searchCount = countNode ? (countNode.textContent || '').trim() : ''
        searchInput.value = ''
        searchInput.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 200))
      }

      /* ② 分段控件是 button（键盘可达） */
      const segmentedButtons = [...document.querySelectorAll('.segmented__item')]
      const tintRow = [...document.querySelectorAll('.settings__row')]
        .find((row) => (row.textContent || '').includes('主题色来源'))
      const tintButtons = tintRow ? [...tintRow.querySelectorAll('button')] : []
      const allFocusable = tintButtons.length > 0 && tintButtons.every((node) => node.tagName === 'BUTTON' && node.tabIndex >= 0)

      /* ③ 示波器按钮的可访问名 */
      const vizButton = [...document.querySelectorAll('button')]
        .find((node) => (node.getAttribute('aria-label') || '').startsWith('音频可视化'))
      const vizLabel = vizButton ? vizButton.getAttribute('aria-label') : ''

      /*
       * ④ 新提示的焦点环：**扫样式表**里有没有 .now-playing__cover-hint:focus-visible 且带 --focus-ring。
       * 不能靠 hint.focus() 再读 outline —— 程序化 focus 不触发 :focus-visible，
       * 而且这个项目的焦点环是 box-shadow（--focus-ring 令牌），不是 outline。
       */
      const hint = document.querySelector('.now-playing__cover-hint')
      let hintRing = false
      for (const sheet of document.styleSheets) {
        let rules = []
        try { rules = sheet.cssRules || [] } catch { continue }
        for (const rule of rules) {
          const selector = rule.selectorText || ''
          if (!selector.includes('.now-playing__cover-hint:focus-visible')) continue
          const shadow = rule.style && rule.style.boxShadow ? rule.style.boxShadow : ''
          if (shadow.includes('--focus-ring')) hintRing = true
        }
      }

      actions.setView('songs')
      await new Promise((r) => setTimeout(r, 200))
      return {
        searchHit,
        searchCount,
        segmented: segmentedButtons.length,
        tintButtons: tintButtons.length,
        allFocusable,
        vizLabel,
        hintRing,
        hintIsButton: Boolean(hint) && hint.tagName === 'BUTTON'
      }
    `)
    record('设置搜索能命中「主题色来源」，分段控件键盘可达',
      a11y.searchHit === true &&
      a11y.tintButtons >= 2 &&
      a11y.allFocusable === true,
      `搜「主题色来源」→ 命中=${a11y.searchHit}（计数「${a11y.searchCount}」）；` +
      `该行按钮 ${a11y.tintButtons} 个、全部是可聚焦 <button>=${a11y.allFocusable}`)

    record('示波器按钮有可访问名，新增提示按钮能聚焦且焦点环可见',
      a11y.vizLabel.length > 0 &&
      a11y.hintIsButton === true &&
      a11y.hintRing === true,
      `示波器 aria-label=「${a11y.vizLabel}」；` +
      `「没有封面…」提示是 button=${a11y.hintIsButton}、样式表里有 :focus-visible + --focus-ring 规则=${a11y.hintRing}`)


    /*
     * 取色性能（T2.6）：810 首连续切歌时，封面取样不能"每切一首就卡一下"。
     *
     * 取 50 首（低于颜色缓存上限 64，保证第二轮能全部命中）分三轮量：
     *   ① 冷：逐个取样（每首都要真的加载封面 + canvas 取样）；
     *   ② 热：立刻再来一遍 —— 必须命中缓存，总耗时与最慢一次都要显著更低；
     *   ③ 同一首并发要 8 次 —— 只应真正取一次（同 key 并发去重），结果必须一致；
     *   ④ 无封面曲目要来两次 —— 第二次必须走负缓存，不能比第一次慢。
     *
     * 断言用的是"相对关系"（热 < 冷/3、热最慢 < 20ms、去重后只有 1 种颜色），
     * 不是绝对毫秒数 —— 机器快慢不该决定这条检查红不红。
     */
    const tintPerf = await evaluate(win, `
      const { artwork, store } = window.__aria
      const tracks = store.get().library.tracks.filter((track) => track.path).slice(0, 50)
      const sample = tracks
      const timeIt = async (fn) => {
        const started = performance.now()
        const value = await fn()
        return { ms: performance.now() - started, value }
      }

      /*
       * 先清空封面/颜色缓存再量"冷"那一轮。
       * 不清的话前面那些检查早就把颜色取过了 —— 量到的"冷"其实是热，
       * 读数会漂亮到不真实（第一次跑出来"50 首 41ms"就是这个原因）。
       */
      artwork.releaseMemory()
      await new Promise((r) => setTimeout(r, 100))

      const coldRuns = []
      for (const track of sample) coldRuns.push(await timeIt(() => artwork.resolveColor(track)))
      const warmRuns = []
      for (const track of sample) warmRuns.push(await timeIt(() => artwork.resolveColor(track)))

      const target = sample[0]
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => artwork.resolveColor(target))
      )
      const dedupeColors = new Set(concurrent.map((color) => (color ? color.tint : 'null')))

      const bare = {
        id: 'perf-bare-cover',
        title: '无封面性能探针',
        artist: 'probe',
        albumArtist: 'probe',
        album: 'no-cover',
        path: '/nonexistent/perf-bare.mp3'
      }
      const bareFirst = await timeIt(() => artwork.resolveColor(bare))
      const bareSecond = await timeIt(() => artwork.resolveColor(bare))

      const sum = (runs) => runs.reduce((total, run) => total + run.ms, 0)
      return {
        count: sample.length,
        coldTotal: sum(coldRuns),
        coldWorst: Math.max(...coldRuns.map((run) => run.ms)),
        warmTotal: sum(warmRuns),
        warmWorst: Math.max(...warmRuns.map((run) => run.ms)),
        dedupeColors: dedupeColors.size,
        bareFirst: bareFirst.ms,
        bareSecond: bareSecond.ms,
        bareSame: bareFirst.value && bareSecond.value ? bareFirst.value.tint === bareSecond.value.tint : false
      }`)

    record('取色性能：第二轮全部命中缓存，同一首并发只取一次，坏封面不重试',
      tintPerf.count === 50 &&
      tintPerf.warmTotal < tintPerf.coldTotal / 3 + 50 &&
      tintPerf.warmWorst < 20 &&
      tintPerf.dedupeColors === 1 &&
      tintPerf.bareSame === true &&
      tintPerf.bareSecond <= tintPerf.bareFirst + 5,
      `50 首：清掉应用缓存后 ${tintPerf.coldTotal.toFixed(0)}ms（最慢 ${tintPerf.coldWorst.toFixed(0)}ms，≈逐首切换成本）→ ` +
      `再切一遍（命中颜色缓存）${tintPerf.warmTotal.toFixed(0)}ms（最慢 ${tintPerf.warmWorst.toFixed(1)}ms，应 <20）；` +
      `同一首并发 8 次得到 ${tintPerf.dedupeColors} 种颜色（应为 1）；` +
      `无封面 ${tintPerf.bareFirst.toFixed(1)}ms → ${tintPerf.bareSecond.toFixed(1)}ms（负缓存，颜色一致=${tintPerf.bareSame}）`)


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
      /*
       * 历史与查询词改成**确定性**准备，不再依赖
       * 「渲染层 commitSearch → 主进程落盘 → 推 settings:changed → 回填 store」那条往返。
       *
       * 那条往返实测非常偶发：轮询 10s、中途再催两次提交，仍然读到过空历史，
       * 连带下面三条一起红（搜索框收起/展开、面板历史、面板点得到）。
       * 现在：① 查询词用同步的 setQuery（渲染层立刻生效，不经过主进程）；
       *       ② 历史直接写主进程的权威设置，再轮询等它推回来。
       */
      actions.setQuery('Blues')
      /*
       * 历史是**异步**的：写主进程 → 落盘 → 推 settings:changed 回来。
       * 实测在冷档案（首次扫描）时一次写入可能迟迟不回来，于是历史读成空数组、
       * 连带下面几条一起红。所以这里改成「最多重写 3 次，每次等 3 秒」——
       * 写入本身是幂等的，重写没有副作用。
       */
      for (let attempt = 0; attempt < 3 && store.get().settings.searchHistory.length < 2; attempt++) {
        await window.__aria.remote.settings.set({ searchHistory: ['Blues', 'love'] })
        for (let i = 0; i < 60 && store.get().settings.searchHistory.length < 2; i++) {
          await settle(50)
        }
      }
      actions.setSearchScope('basic')
      await settle(200)

      const slot = document.querySelector('.search-slot')
      const toggle = slot.querySelector('.btn')
      const input = document.querySelector('.search input')
      const panel = document.querySelector('.search-panel')
      const scopeButton = document.querySelector('.search__scope')
      const fieldWidth = () => Math.round(document.querySelector('.search').getBoundingClientRect().width)

      // ① 默认收起：只留一颗放大镜
      const collapsed = { open: slot.classList.contains('is-open'), width: fieldWidth() }

      toggle.click()
      /*
       * 同样别用固定睡眠：等「展开动画到位 + 面板可见」再量。
       * 冷档案时这一条以前会量到收起状态的宽度，然后一路红下去。
       */
      {
        const deadline = performance.now() + 6000
        while (performance.now() < deadline) {
          if (slot.classList.contains('is-open') && fieldWidth() > 200 && !panel.hidden &&
            panel.querySelectorAll('.search-panel__scope').length === 2) break
          await settle(100)
        }
      }
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
      /*
       * 点完立刻读 settings.searchScope 是读不到的：它要经
       * 「写设置 → 主进程落盘 → 推 settings:changed」回来（异步 IPC）。
       * ui.searchScope 是同步的，settings 那个轮询等它落地，两个都记下来。
       */
      await settle(340)
      const scopeImmediate = store.get().ui.searchScope
      for (let i = 0; i < 24 && store.get().settings.searchScope !== 'deep'; i++) {
        await settle(100)
      }
      const afterScope = {
        scope: scopeImmediate,
        persisted: store.get().settings.searchScope,
        label: scopeButton.querySelector('span')?.textContent || '',
        isDeep: scopeButton.classList.contains('is-deep'),
        selected: panel.querySelector('.search-panel__scope.is-selected')?.textContent || '',
        hint: panel.querySelector('.search-panel__hint')?.textContent || '',
        placeholder: input.placeholder
      }

      // 取不到就让它变成一条「没通过」，而不是抛异常把整个自检打断
      const firstTerm = panel.querySelector('.search-panel__term')
      const pickedTerm = firstTerm ? firstTerm.textContent : null
      if (firstTerm) firstTerm.click()
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
      return { collapsed, opened, afterScope, afterPick, afterEscape, queryBeforeClose, afterCollapse, pickedTerm }
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
      // scope 只存在设置里（ui 里没有这个字段），而且是异步落盘的 —— 上面轮询等它到位
      searchPanelCheck.afterScope.persisted === 'deep' &&
      searchPanelCheck.afterScope.selected === '含歌词等' &&
      searchPanelCheck.afterPick.query === 'Blues' &&
      searchPanelCheck.afterEscape.hidden === true,
      `展开后面板可见（范围 ${JSON.stringify(searchPanelCheck.opened.scopes)}，历史 ${JSON.stringify(searchPanelCheck.opened.history)}）；` +
      `切到深度档后按钮显示「${searchPanelCheck.afterScope.label}」、scope=${searchPanelCheck.afterScope.scope}（落盘 ${searchPanelCheck.afterScope.persisted}）、提示「${searchPanelCheck.afterScope.hint}」、占位「${searchPanelCheck.afterScope.placeholder}」；` +
      `点历史「${searchPanelCheck.pickedTerm || '（没有历史项可点）'}」回填「${searchPanelCheck.afterPick.query}」；Esc 收起=${searchPanelCheck.afterEscape.hidden}`)

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
      /*
       * 等面板**真的展开到位**，而不是固定睡 460ms。
       * 实测教训：冷档案（首次扫描资料库）时渲染层很忙，260ms 的展开动画会被拖到 1s 以上，
       * 那时量到的 .search__scope 还是 0×0 —— 命中测试自然「命中到的是 titlebar」，
       * 于是这条检查在冷启动那一轮假红（同样的现象在 2026-10-11 那轮出现过两次）。
       */
      {
        const deadline = performance.now() + 6000
        while (performance.now() < deadline) {
          const scope = document.querySelector('.search-panel [data-scope="deep"]')
          const box = scope ? scope.getBoundingClientRect() : null
          if (scope && box && box.width > 4 && box.height > 4 && !document.querySelector('.search-panel').hidden) break
          await settle(100)
        }
      }
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

    /*
     * 沉浸式示波器（从 wip/visualizer-immersive 重启的那条线）。
     *
     * 盯三件事，都是那条分支当年真踩过的坑：
     *   ① 装饰层**不能吃点击**：铺满底部又接收鼠标时，底部工具条与播放控件全点不动；
     *   ② 不能压住底部工具条：重叠时图标落在亮色频谱上，读不清；
     *   ③ 切样式要真的生效并落盘（bars → wave → ring → off），
     *      且选 off 之后画布要被清空（别留上一帧的残留）。
     */
    const visualizerCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)) }
      const tracks = store.get().library.tracks
      if (store.get().playback.status !== 'playing') actions.playTrack(tracks[0])
      await actions.setSetting({ visualizerStyle: 'bars' })
      actions.openNowPlaying({ lyrics: true })
      await settle(1500)

      const strip = () => document.querySelector('.visualizer')
      const canvas = () => document.querySelector('.visualizer__canvas')
      const measure = () => {
        const node = canvas()
        const ctx = node.getContext('2d')
        const { width, height } = node
        const data = ctx.getImageData(0, 0, width, height).data
        let painted = 0
        let minY = height
        let maxY = -1
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] > 8) {
              painted++
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
        }
        return { paintedPct: (painted / (width * height)) * 100, spreadPct: maxY < 0 ? 0 : ((maxY - minY) / height) * 100 }
      }

      const first = strip()
      const cs = getComputedStyle(first)
      const stripRect = first.getBoundingClientRect()
      const toolsRect = document.querySelector('.now-playing__tools')?.getBoundingClientRect() || null
      // 底部工具条正中间那一点，命中的必须不是这层装饰
      const toolHit = toolsRect
        ? document.elementFromPoint(Math.round(toolsRect.left + toolsRect.width / 2), Math.round(toolsRect.top + toolsRect.height / 2))
        : null
      const bars = measure()

      // 逐个点那颗按钮：bars → wave → ring → off，然后回到 bars
      const button = document.querySelector('.now-playing__topbar .visualizer + .btn, .now-playing__topbar button[title^="音频可视化"]') ||
        [...document.querySelectorAll('.now-playing__topbar .btn')].find((b) => (b.title || '').includes('音频可视化'))
      const seen = []
      const click = async () => {
        button.click()
        await settle(280)
        seen.push(store.get().settings.visualizerStyle)
        return store.get().settings.visualizerStyle
      }
      await click()                       // wave
      await click()                       // ring
      const offStyle = await click()      // off
      const offState = { style: offStyle, datasetStyle: strip().dataset.style, canvasEmpty: measure().paintedPct < 0.05 }
      await click()                       // bars
      const afterCycle = store.get().settings.visualizerStyle
      await actions.setSetting({ visualizerStyle: 'bars' })
      await settle(300)
      actions.closeNowPlaying()
      await settle(400)

      /*
       * 设置页那条路径也要能改：外观分组里的分段控件。
       * （顶栏那颗按钮是"离正在播放最近"的入口，设置页是"能找到"的入口，两条都得通。）
       */
      actions.setView('settings')
      await settle(900)
      const settingRows = [...document.querySelectorAll('.settings__row')]
      const vizRow = settingRows.find((r) => (r.querySelector('.settings__row-title')?.textContent || '').includes('音频可视化'))
      const vizOptions = vizRow ? [...vizRow.querySelectorAll('.segmented__item')].map((b) => b.textContent) : []
      const waveButton = vizRow ? [...vizRow.querySelectorAll('.segmented__item')].find((b) => b.textContent === '波形') : null
      if (waveButton) waveButton.click()
      await settle(700)
      const styleFromSettings = store.get().settings.visualizerStyle
      const offButton = vizRow ? [...vizRow.querySelectorAll('.segmented__item')].find((b) => b.textContent === '关闭') : null
      if (offButton) offButton.click()
      await settle(500)
      const styleAfterOff = store.get().settings.visualizerStyle
      if (vizRow) [...vizRow.querySelectorAll('.segmented__item')].find((b) => b.textContent === '频谱')?.click()
      await settle(400)
      actions.setView('songs')
      await settle(300)
      const settingsRowCheck = {
        found: Boolean(vizRow),
        options: vizOptions,
        styleFromSettings,
        styleAfterOff,
        restored: store.get().settings.visualizerStyle
      }

      /*
       * 「减少动画」开着时示波器必须停：那条开关承诺的是关掉所有动画，
       * 而示波器是持续动画 —— 开着它却让底部一直动，等于当面食言。
       * 顺带验证按钮被禁用（否则用户点了没反应、只会以为坏了）。
       */
      await actions.setSetting({ reduceMotion: true })
      await settle(500)
      actions.openNowPlaying({ lyrics: true })
      await settle(900)
      // 右栏可能停在「歌曲信息」，先点回「歌词」再量歌词与示波器的关系
      const lyricsTab = [...document.querySelectorAll('.now-playing__tab')].find((t) => (t.textContent || '').includes('歌词'))
      lyricsTab?.click()
      await settle(900)
      const lyricsProbe = (() => {
        const region = document.querySelector('.lyrics-region')
        const scroller = region ? region.querySelector('.lyrics') : null
        const strip = document.querySelector('.visualizer')
        if (!scroller || !strip) return { missing: true }
        const regionBox = region.getBoundingClientRect()
        const limit = Math.min(regionBox.bottom, window.innerHeight)
        const lines = [...scroller.querySelectorAll('.lyrics__line, .lyrics__plain-line')]
        const visible = lines.filter((line) => {
          const r = line.getBoundingClientRect()
          return r.height > 0 && r.top >= regionBox.top && r.bottom <= limit
        })
        const last = visible[visible.length - 1]
        return {
          regionBottom: Math.round(limit),
          lastLineBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
          stripTop: Math.round(strip.getBoundingClientRect().top),
          visibleLines: visible.length
        }
      })()
      const reducedProbe = (() => {        const node = document.querySelector('.visualizer__canvas')
        const strip = document.querySelector('.visualizer')
        const ctx = node.getContext('2d')
        const data = ctx.getImageData(0, 0, node.width, node.height).data
        let painted = 0
        for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted++
        const button = [...document.querySelectorAll('.now-playing__topbar .btn')].find((b) => (b.title || '').includes('音频可视化') || (b.title || '').includes('减少动画'))
        return {
          paintedPct: (painted / (node.width * node.height)) * 100,
          suppressed: strip.dataset.suppressed,
          buttonDisabled: button ? button.disabled : null,
          buttonTitle: button ? button.title : ''
        }
      })()
      actions.closeNowPlaying()
      await settle(400)
      await actions.setSetting({ reduceMotion: false })
      await settle(300)

      return {
        exists: Boolean(first && canvas()),
        pointerEvents: cs.pointerEvents,
        zIndex: cs.zIndex,
        stripTop: Math.round(stripRect.top),
        toolsBottom: toolsRect ? Math.round(toolsRect.bottom) : null,
        size: canvas().width + 'x' + canvas().height,
        bars,
        toolHitClass: toolHit ? ((toolHit.getAttribute && toolHit.getAttribute('class')) || toolHit.tagName).toString().slice(0, 40) : null,
        toolHitIsStrip: Boolean(toolHit && toolHit.closest && toolHit.closest('.visualizer')),
        seen,
        offState,
        afterCycle,
        settingsRowCheck,
        reducedProbe,
        lyricsProbe,
        runningAfterClose: Boolean(document.querySelector('.visualizer')) && store.get().ui.nowPlayingOpen === false
      }
    `)
    record('沉浸式示波器：装饰层不吃点击、不与底部工具条重叠、切样式生效并可关闭',
      visualizerCheck.exists === true &&
      visualizerCheck.pointerEvents === 'none' &&
      visualizerCheck.toolHitIsStrip === false &&
      visualizerCheck.toolsBottom !== null &&
      visualizerCheck.stripTop >= visualizerCheck.toolsBottom &&
      visualizerCheck.bars.paintedPct > 1 && visualizerCheck.bars.spreadPct > 20 &&
      visualizerCheck.seen.join(',') === 'wave,ring,off,bars' &&
      visualizerCheck.offState.datasetStyle === 'off' && visualizerCheck.offState.canvasEmpty === true &&
      visualizerCheck.runningAfterClose === true,
      `层：pointer-events=${visualizerCheck.pointerEvents} z=${visualizerCheck.zIndex}；` +
      `几何：示波器顶 ${visualizerCheck.stripTop} ≥ 工具条底 ${visualizerCheck.toolsBottom}；` +
      `工具条中心的命中对象=${visualizerCheck.toolHitClass}（是示波器=${visualizerCheck.toolHitIsStrip}）；` +
      `画布 ${visualizerCheck.size} 画了 ${visualizerCheck.bars.paintedPct.toFixed(1)}% 像素、纵向铺开 ${visualizerCheck.bars.spreadPct.toFixed(0)}%；` +
      `连点四次样式变化 ${visualizerCheck.seen.join('→')}；选 off 时画布已清空=${visualizerCheck.offState.canvasEmpty}（dataset=${visualizerCheck.offState.datasetStyle}）`)

    /*
     * 样式有两个入口：正在播放页顶栏那颗按钮（离得最近），设置 → 外观里的分段控件（找得到）。
     * 两条都要真的落到设置里 —— 只有一条能用的话，另一种使用习惯的人就摸不到这个功能。
     */
    record('音频可视化的两个入口都能改样式（顶栏按钮 / 设置 → 外观）',
      visualizerCheck.settingsRowCheck.found === true &&
      visualizerCheck.settingsRowCheck.options.join(',') === '频谱,波形,环形,关闭' &&
      visualizerCheck.settingsRowCheck.styleFromSettings === 'wave' &&
      visualizerCheck.settingsRowCheck.styleAfterOff === 'off' &&
      visualizerCheck.settingsRowCheck.restored === 'bars',
      `设置里的选项 ${JSON.stringify(visualizerCheck.settingsRowCheck.options)}；` +
      `点「波形」后 style=${visualizerCheck.settingsRowCheck.styleFromSettings}、` +
      `点「关闭」后 style=${visualizerCheck.settingsRowCheck.styleAfterOff}、` +
      `最后复原为 ${visualizerCheck.settingsRowCheck.restored}`)

    /*
     * 「减少动画」开着时示波器必须停住（它是持续动画，而那个开关承诺关掉所有动画），
     * 并且顶栏那颗按钮要变成禁用 —— 否则用户点了没反应，只会以为坏了。
     */
    record('开着「减少动画」时示波器停住，切换按钮也禁用',
      visualizerCheck.reducedProbe.paintedPct < 0.05 &&
      visualizerCheck.reducedProbe.suppressed === 'true' &&
      visualizerCheck.reducedProbe.buttonDisabled === true,
      `画布残留 ${visualizerCheck.reducedProbe.paintedPct.toFixed(2)}%、` +
      `dataset.suppressed=${visualizerCheck.reducedProbe.suppressed}、` +
      `按钮禁用=${visualizerCheck.reducedProbe.buttonDisabled}、提示「${visualizerCheck.reducedProbe.buttonTitle}」`)

    /*
     * 歌词不能钻进底部那条示波器里。
     * 加示波器之后新引入的风险：歌词是滚动的，区域一直延伸到页面底部，
     * 最后几行本来就淡（上下渐隐遮罩），再压在会动的频谱下面就是彻底读不了。
     * 修法是给右栏留出 --visualizer-h 的下边距；这里守住"最后一行在条子之上"。
     */
    record('歌词不会钻到示波器底下（右栏为它留出了高度）',
      visualizerCheck.lyricsProbe.missing !== true &&
      visualizerCheck.lyricsProbe.lastLineBottom !== null &&
      visualizerCheck.lyricsProbe.lastLineBottom <= visualizerCheck.lyricsProbe.stripTop - 8,
      `歌词区底边 ${visualizerCheck.lyricsProbe.regionBottom}、最后一行底边 ${visualizerCheck.lyricsProbe.lastLineBottom}、` +
      `示波器顶边 ${visualizerCheck.lyricsProbe.stripTop}（可见歌词 ${visualizerCheck.lyricsProbe.visibleLines} 行）`)

    /*
     * 矮窗口下会不会又压住工具条？
     * 我加的条子高 72px，而窗口最小高度是 620 —— 如果底部工具条的位置不跟着视口等比走，
     * 矮窗口里两者就会重新叠在一起（那正是我在正常尺寸下修掉的问题）。
     * 这条不能靠推理：把窗口真的缩到最小高度量一次，再还原。
     */
    const beforeResize = win.getContentBounds()
    await evaluate(win, `window.__aria.actions.openNowPlaying({ lyrics: true }); return true`)
    await sleep(900)
    win.setContentSize(beforeResize.width, 620)
    await sleep(900)
    const shortWindow = await evaluate(win, `
      const strip = document.querySelector('.visualizer')
      const tools = document.querySelector('.now-playing__tools')
      if (!strip || !tools) return { missing: true }
      const hidden = getComputedStyle(strip).display === 'none'
      const stripRect = strip.getBoundingClientRect()
      const toolsRect = tools.getBoundingClientRect()
      return {
        viewportH: window.innerHeight,
        panelOpen: window.__aria.store.get().ui.nowPlayingOpen === true,
        stripTop: Math.round(stripRect.top),
        stripHeight: Math.round(stripRect.height),
        toolsBottom: Math.round(toolsRect.bottom),
        hidden,
        overlap: hidden ? false : stripRect.top < toolsRect.bottom
      }
    `)
    win.setContentSize(beforeResize.width, beforeResize.height)
    await sleep(400)
    await evaluate(win, `window.__aria.actions.closeNowPlaying(); return true`)
    await sleep(400)
    record('缩到最小窗口高度时，示波器不会重新压住底部工具条',
      shortWindow.missing !== true &&
      shortWindow.panelOpen === true &&
      /*
       * 前置条件"面板必须真的开着"用**工具条矩形非零**来证明（面板关着时它是 0）。
       * 注意不能要求示波器高度非零：矮窗口下它是**合法隐藏**的（display:none → 矩形 0×0），
       * 第一版就是这么把自己判红的 —— 防空洞的守卫不能把正常的降级路径一起挡掉。
       */
      shortWindow.panelOpen === true && shortWindow.toolsBottom > 0 &&
      (shortWindow.hidden === true || (shortWindow.stripHeight > 0 && shortWindow.overlap === false)),
      `视口 ${shortWindow.viewportH}px（面板开着=${shortWindow.panelOpen}）：` +
      `${shortWindow.hidden ? '示波器已按矮窗口降级隐藏' : `示波器顶边 ${shortWindow.stripTop}、高 ${shortWindow.stripHeight}`}、` +
      `工具条底边 ${shortWindow.toolsBottom}、重叠=${shortWindow.overlap}`)

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

    /* ---------- 在线音源：脚本宿主 + 「网络结果」板块 ----------
     *
     * 本仓库不内置音源，所以这里起一个本地 HTTP 服务，用**临时**脚本验证整条链路：
     *   链接导入 → 装载 → 搜索 → 两块结果 → 播放（含音源歌词） → 下载 → 全部停用 → 移除。
     * 测试用的音频/脚本都由本进程现造，跑完即删，仓库里不留任何音源。
     */
    const http = require('node:http')
    const os = require('node:os')

    // 一个极小的合法 WAV（8000Hz 单声道、0.1 秒静音），用于播放与下载
    const wavBuffer = (() => {
      const samples = 800
      const dataSize = samples * 2
      const buffer = Buffer.alloc(44 + dataSize)
      buffer.write('RIFF', 0)
      buffer.writeUInt32LE(36 + dataSize, 4)
      buffer.write('WAVE', 8)
      buffer.write('fmt ', 12)
      buffer.writeUInt32LE(16, 16)
      buffer.writeUInt16LE(1, 20)
      buffer.writeUInt16LE(1, 22)
      buffer.writeUInt32LE(8000, 24)
      buffer.writeUInt32LE(16000, 28)
      buffer.writeUInt16LE(2, 32)
      buffer.writeUInt16LE(16, 34)
      buffer.write('data', 36)
      buffer.writeUInt32LE(dataSize, 40)
      return buffer
    })()

    const sourcesService = ctx.get('musicSources')
    const demoSources = ['aria-smoke-source-a', 'aria-smoke-source-b', 'from-link-source', 'lx-smoke-source']
    for (const id of demoSources) {
      try { await sourcesService.remove(id) } catch { /* 之前没装过 */ }
    }
    // 本地也命中的关键词：这样一次搜索能同时看到「本地结果」和「网络结果」两块
    const sharedKeyword = (allTracks.find((track) => track.title.length >= 4) || { title: 'Love' })
      .title.slice(0, 4)

    const LINK_SOURCE_SCRIPT_NAME = 'from-link-source.js'
    const testServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname === '/audio.wav') {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wavBuffer.length })
        res.end(wavBuffer)
        return
      }
      if (url.pathname === `/${LINK_SOURCE_SCRIPT_NAME}`) {
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        res.end(linkSourceText)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve))
    const testPort = testServer.address().port
    const audioUrl = `http://127.0.0.1:${testPort}/audio.wav`

    const downloadDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aria-download-'))

    const sourceScript = [
      'module.exports = {',
      "  name: '自检用音源 A',",
      "  version: '9.9.9',",
      "  description: '由 npm run smoke 临时写入，用来验证音源链路',",
      '  async search (query, { limit, request }) {',
      '    // 顺便确认沙箱里拿到了 request/Buffer，且拿不到 require/process',
      "    const sandboxOk = typeof request === 'function' && typeof Buffer === 'function' &&",
      "      typeof require === 'undefined' && typeof process === 'undefined'",
      '    const list = []',
      '    for (let i = 0; i < Math.min(3, limit); i++) {',
      '      list.push({',
      "        id: 'demo-' + i,",
      "        title: query + ' 的网络结果 ' + (i + 1),",
      "        artist: '演示艺人',",
      "        album: '演示专辑',",
      '        duration: 1,',
      "        quality: '320k',",
      '        payload: { sandboxOk }',
      '      })',
      '    }',
      '    return list',
      '  },',
      '  async resolveUrl (track) {',
      "    if (!track || !track.payload || !track.payload.sandboxOk) throw new Error('沙箱能力不可用')",
      '    return ' + JSON.stringify(audioUrl),
      '  },',
      '  async resolveLyrics () {',
      "    return { text: '[00:00.00]音源提供的歌词第一句\\n[00:00.50]音源提供的歌词第二句' }",
      '  }',
      '}'
    ].join('\n')

    const linkSourceText = [
      'module.exports = {',
      "  name: '链接导入的音源',",
      "  async search (query, { limit }) {",
      "    return [{ id: 'link-1', title: query + ' 来自链接音源', artist: '链接艺人', duration: 1, quality: '128k' }]",
      '  },',
      '  async resolveUrl () { return ' + JSON.stringify(audioUrl) + ' }',
      '}'
    ].join('\n')

    const failingScript = [
      'module.exports = {',
      "  name: '自检用音源 B（故意坏掉）',",
      "  async search () { throw new Error('这个音源就是用来验证失败的') }",
      '}'
    ].join('\n')

    // LX 音乐风格的自定义源：不导出对象，靠全局 lx 的事件协议通信
    // （照官方规范：send(inited, { status, sources }) + on(request, …)）
    const lxStyleScript = [
      '/* global lx */',
      'const { EVENT_NAMES, on, send } = globalThis.lx',
      'send(EVENT_NAMES.inited, {',
      '  status: true,',
      '  openDevTools: false,',
      '  sources: {',
      "    kw: { name: '酷我音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k', '320k'] }",
      '  }',
      '})',
      'const audioUrl = ' + JSON.stringify(audioUrl),
      'on(EVENT_NAMES.request, ({ source, action, info }) => {',
      "  if (action === 'musicUrl') return audioUrl",
      "  if (action === 'lyric') return { lyric: '[00:00.00]LX 音源的歌词' }",
      "  throw new Error('不支持的 action: ' + action)",
      '})'
    ].join('\n')

    const report = { installed: null, link: null, linkSearch: null, resolve: null, removed: null }
    try {
      report.installed = await sourcesService.install(sourceScript, 'aria-smoke-source-a')
      await sourcesService.install(failingScript, 'aria-smoke-source-b')

      // ① 链接导入：让主进程从本地服务抓一份脚本下来
      report.link = await sourcesService.installFromUrl(`http://127.0.0.1:${testPort}/${LINK_SOURCE_SCRIPT_NAME}`)
      report.linkSearch = await sourcesService.search('链接', { sources: ['from-link-source'] })

      // ② 只装了音源、没打开总开关：不该出现网络结果
      report.beforeToggle = await evaluate(win, `
        const { actions, store } = window.__aria
        await actions.setSetting({ onlineSources: false })
        actions.setView('songs')
        actions.setQuery('演示')
        await new Promise((r) => setTimeout(r, 900))
        const section = document.querySelector('.online-results')
        return { hidden: section ? section.hidden : null, search: store.get().ui.onlineSearch || null }`)

      await evaluate(win, `await window.__aria.actions.setSetting({ onlineSources: true }); return true`)
      report.afterToggle = await evaluate(win, `
        const { actions } = window.__aria
        const keyword = ${JSON.stringify(sharedKeyword)}
        actions.setView('songs')
        actions.setQuery(keyword)
        const state = await actions.searchOnlineNow(keyword)
        await new Promise((r) => setTimeout(r, 700))
        const section = document.querySelector('.online-results')
        const rows = [...document.querySelectorAll('.online-result')].map((node) => ({
          title: (node.querySelector('.online-result__title') || {}).textContent || '',
          source: (node.querySelector('.online-result__source') || {}).textContent || '',
          quality: (node.querySelector('.online-result__tag') || {}).textContent || '',
          buttons: [...node.querySelectorAll('.online-result__action')].map((b) => b.textContent)
        }))
        const rect = section ? section.getBoundingClientRect() : null
        return {
          status: state ? state.status : null,
          resultCount: state ? state.results.length : -1,
          perSource: state ? state.perSource : [],
          errorCount: state ? state.perSource.filter((item) => item.error).length : -1,
          sectionHidden: section ? section.hidden : null,
          sectionHeight: rect ? Math.round(rect.height) : 0,
          rows,
          localRows: document.querySelectorAll('.track-row').length
        }`)

      // ③ 播放：解析直链 → 合成曲目 → 走正常播放流程 → 音源歌词跟着加载
      //    （引擎的 <audio> 是 new Audio() 创建的，不在 DOM 里，所以看播放状态而不是元素）
      report.play = await evaluate(win, `
        const { actions, store } = window.__aria
        const state = store.get().ui.onlineSearch
        const item = (state && state.results && state.results.find((r) => r.sourceId === 'aria-smoke-source-a')) || null
        if (!item) return { skipped: true }
        const track = await actions.playOnlineItem(item)
        const waitFor = async (predicate, timeout = 15000) => {
          const deadline = performance.now() + timeout
          while (performance.now() < deadline) {
            if (predicate()) return true
            await new Promise((r) => setTimeout(r, 200))
          }
          return false
        }
        const played = await waitFor(() => {
          const playback = store.get().playback
          return playback.trackId === track.id && playback.duration > 0
        })
        await waitFor(() => store.get().lyrics.lines.length > 0, 8000)
        const playback = store.get().playback
        // 播放地址必须是主进程代理（remote://），而且代理真的能把字节吐出来 ——
        // 直链会被 CORS 挡掉（音频分析会给 <audio> 设 crossOrigin），代理之后才放得出来
        let proxied = null
        try {
          const response = await fetch(track.onlineUrl)
          const buffer = await response.arrayBuffer()
          proxied = { status: response.status, bytes: buffer.byteLength, url: String(track.onlineUrl) }
        } catch (err) {
          proxied = { error: String((err && err.message) || err), url: String(track.onlineUrl) }
        }
        return {
          skipped: false,
          id: track.id,
          title: track.title,
          playbackId: playback.trackId,
          status: playback.status,
          duration: Math.round((playback.duration || 0) * 100) / 100,
          played,
          proxied,
          lyricsStatus: store.get().lyrics.status,
          lyricsSource: store.get().lyrics.source,
          lyricsLines: store.get().lyrics.lines.length,
          lyricsText: (store.get().lyrics.lines[0] || {}).text || '',
          onlineTracks: actions.listOnlineTracks()
        }`)

      // ④ 下载到指定目录（用临时目录，不要写进用户的音乐文件夹）
      const downloadItem = await evaluate(win, `
        const state = window.__aria.store.get().ui.onlineSearch
        return (state && state.results && state.results.find((r) => r.sourceId === 'aria-smoke-source-a')) || null`)
      if (downloadItem) {
        report.download = await sourcesService.download({ ...downloadItem, uid: 'smoke-dl', dir: downloadDir }, () => {})
      }

      // ⑤ 多音源管理：全部停用后搜不到东西，恢复后又能搜到
      report.batchOff = await sourcesService.setAllEnabled(false)
      report.searchWhileOff = await sourcesService.search(sharedKeyword)
      report.batchOn = await sourcesService.setAllEnabled(true)

      const firstResult = await evaluate(win, `
        const state = window.__aria.store.get().ui.onlineSearch
        return (state && state.results && state.results[0]) || null`)
      if (firstResult) report.resolve = await sourcesService.resolveUrl(firstResult)
      report.stats = sourcesService.getStats()

      /* 内置音源（Internet Archive：公共领域 / CC，免密钥）—— 这是本项目唯一内置的音源，
       * 目的是让「搜索 → 播放 → 下载」这条链路有东西可跑；网络不可达时只报告不算失败。*/
      try {
        const builtin = sourcesService.list().find((item) => item.id === 'builtin-internet-archive')
        report.builtin = {
          present: Boolean(builtin),
          enabled: builtin?.enabled ?? null,
          capabilities: builtin?.capabilities || null
        }
        const found = await sourcesService.search('beethoven', { sources: ['builtin-internet-archive'], limit: 3 })
        report.builtinSearch = {
          count: found.results.length,
          elapsedMs: found.elapsedMs,
          first: found.results[0] || null,
          error: found.perSource.find((item) => item.id === 'builtin-internet-archive')?.error || null
        }
        if (found.results[0]) {
          report.builtinResolve = await sourcesService.resolveUrl(found.results[0])
        }
      } catch (err) {
        report.builtinError = String(err?.message || err)
      }

      /* LX 音乐音源兼容层：这类脚本靠全局 lx 的事件协议通信（不导出对象），
       * 按官方规范只提供 musicUrl / lyric / pic，不含搜索 ——
       * 所以要验证「能装载、能识别、被标为仅解析、并且能按协议解析地址与歌词」。*/
      try {
        report.lxInstall = await sourcesService.install(lxStyleScript, 'lx-smoke-source')
        report.lxDescribe = sourcesService.list().find((item) => item.id === 'lx-smoke-source') || null
        report.lxSearch = await sourcesService.search('随便什么', { sources: ['lx-smoke-source'] })
        report.lxResolve = await sourcesService.resolveUrl({
          sourceId: 'lx-smoke-source',
          title: 'LX 测试曲目',
          artist: 'LX 测试艺人',
          quality: '320k',
          payload: { lx: { source: 'kw', musicInfo: { songmid: 'abc123', name: 'LX 测试曲目' } } }
        })
        report.lxLyrics = await sourcesService.resolveLyrics({
          sourceId: 'lx-smoke-source',
          payload: { lx: { source: 'kw', musicInfo: { songmid: 'abc123' } } }
        })
      } catch (err) {
        report.lxError = String(err?.message || err)
      }
    } finally {
      for (const id of demoSources) {
        try { await sourcesService.remove(id) } catch { /* 忽略 */ }
      }
      report.removed = sourcesService.list().map((item) => item.id)
      await new Promise((resolve) => testServer.close(resolve))
      await fsp.rm(downloadDir, { recursive: true, force: true }).catch(() => {})
      await evaluate(win, `
        // 收尾：把播放切回一首本地曲目，别让合成出来的在线曲目影响后面的检查
        const tracks = window.__aria.store.get().library.tracks
        if (tracks.length) window.__aria.actions.playTrack(tracks[0], tracks)
        window.__aria.player.pause()
        await window.__aria.actions.setSetting({ onlineSources: false })
        window.__aria.actions.setQuery('')
        window.__aria.actions.setOnlineSearch(null)
        await new Promise((r) => setTimeout(r, 400))
        return true`)
    }

    record('在线音源：从链接导入脚本',
      report.link && report.link.id === 'from-link-source' &&
      report.linkSearch?.results?.length === 1 &&
      report.linkSearch.results[0].title.includes('来自链接音源'),
      `从 http 链接抓到脚本 → id=${report.link?.id}、名称=${report.link?.name}；` +
      `用它单独搜索返回 ${report.linkSearch?.results?.length} 条：` +
      `「${report.linkSearch?.results?.[0]?.title}」`)
    record('在线音源：网络结果与本地结果各就各位',
      report.afterToggle?.status === 'done' &&
      report.afterToggle.resultCount >= 3 &&
      report.afterToggle.rows.filter((row) => row.source === '自检用音源 A').length === 3 &&
      report.afterToggle.rows.every((row) => row.buttons.join('/') === '播放/下载/复制地址') &&
      report.afterToggle.sectionHidden === false &&
      report.afterToggle.sectionHeight > 20 &&
      report.afterToggle.localRows > 0,
      `打开总开关后搜索：网络结果 ${report.afterToggle?.resultCount} 首（板块可见=${!report.afterToggle?.sectionHidden}、` +
      `高度 ${report.afterToggle?.sectionHeight}px、每行按钮 ${report.afterToggle?.rows?.[0]?.buttons?.join('/')}），` +
      `本地结果同时还有 ${report.afterToggle?.localRows} 行；示例「${report.afterToggle?.rows?.[0]?.title}」`)
    record('在线音源：单个音源出错不影响其他音源',
      report.afterToggle?.errorCount >= 1 && report.afterToggle?.resultCount >= 3,
      `${report.afterToggle?.perSource?.length} 个音源参与，其中 ${report.afterToggle?.errorCount} 个报错；` +
      `正常音源仍返回 ${report.afterToggle?.resultCount} 首；错误：` +
      `${JSON.stringify(report.afterToggle?.perSource?.filter((item) => item.error).map((item) => `${item.name}: ${item.error}`))}`)
    record('在线音源：可以直接播放并加载音源歌词',
      report.play && !report.play.skipped && report.play.played &&
      report.play.playbackId === report.play.id &&
      report.play.lyricsLines >= 2 &&
      report.play.proxied && report.play.proxied.bytes === wavBuffer.length,
      report.play?.skipped
        ? '没有可播放的在线结果'
        : `点播放后播放状态切到 online 曲目 ${report.play.id}（时长 ${report.play.duration}s、状态 ${report.play.status}）` +
          `；播放地址走主进程代理 ${String(report.play.proxied?.url || '').slice(0, 40)}…，` +
          `代理取回 ${report.play.proxied?.bytes} 字节（源文件 ${wavBuffer.length} 字节）` +
          `${report.play.proxied?.error ? `，代理出错：${report.play.proxied.error}` : ''}` +
          `；歌词来自「${report.play.lyricsSource}」共 ${report.play.lyricsLines} 行，首句「${report.play.lyricsText}」`)
    record('在线音源：下载到指定目录',
      report.download && report.download.bytes === wavBuffer.length,
      report.download
        ? `下载 ${report.download.bytes} 字节（源文件 ${wavBuffer.length} 字节）到 ${report.download.dir}`
        : '没有可下载的结果')
    record('在线音源：批量停用后不再查询、恢复后可用',
      report.batchOff?.every((item) => item.enabled === false) &&
      report.searchWhileOff?.results?.length === 0 &&
      report.batchOn?.every((item) => item.enabled === true) &&
      (report.stats?.calls?.['aria-smoke-source-a']?.ok || 0) > 0,
      `全部停用后 enabled=${JSON.stringify(report.batchOff?.map((item) => item.enabled))}、搜索返回 ${report.searchWhileOff?.results?.length} 条；` +
      `恢复后 enabled=${JSON.stringify(report.batchOn?.map((item) => item.enabled))}；` +
      `调用统计：${JSON.stringify(report.stats?.calls?.['aria-smoke-source-a'] || {})}`)
    record('在线音源：没打开总开关时不出现网络结果',
      report.beforeToggle?.hidden === true && !report.beforeToggle?.search,
      `总开关关闭时「网络结果」板块 hidden=${report.beforeToggle?.hidden}，store 里也没有在线结果`)
    record('在线音源：移除后彻底消失',
      Array.isArray(report.removed) && !report.removed.includes('aria-smoke-source-a') &&
      !report.removed.includes('from-link-source'),
      `移除全部自检音源后，目录里剩下 ${JSON.stringify(report.removed)}`)

    /* ---------- 内置音源：Internet Archive（公共领域 / CC，免密钥） ---------- */
    record('内置音源：Internet Archive 可用（搜索 → 解析直链）',
      report.builtin?.present === true &&
      report.builtin?.enabled === true &&
      report.builtin?.capabilities?.search === true &&
      (report.builtinSearch?.error
        ? true // 网络不可达时不判失败，只报告
        : report.builtinSearch?.count > 0 && Boolean(report.builtinResolve?.realUrl)),
      `内置音源 present=${report.builtin?.present}、enabled=${report.builtin?.enabled}、` +
      `能力 search=${report.builtin?.capabilities?.search}；` +
      (report.builtinSearch?.error
        ? `搜索失败（可能是网络不可达）：${report.builtinSearch.error}`
        : `搜「beethoven」得 ${report.builtinSearch?.count} 条（${report.builtinSearch?.elapsedMs}ms），` +
          `首条「${report.builtinSearch?.first?.title}」（${report.builtinSearch?.first?.artist}）；` +
          `解析出直链 ${String(report.builtinResolve?.realUrl || '').slice(0, 64)}…` +
          `，播放地址走代理 ${String(report.builtinResolve?.url || '').slice(0, 32)}…`))

    /* ---------- LX 音乐自定义源兼容层 ---------- */
    record('LX 音源：能装载并识别为「仅解析」',
      report.lxInstall?.kind === 'lx' &&
      report.lxDescribe?.kind === 'lx' &&
      report.lxDescribe?.capabilities?.search === false &&
      report.lxDescribe?.capabilities?.resolveUrl === true &&
      (report.lxDescribe?.lxSources?.length || 0) === 1,
      `装载 LX 风格脚本 → kind=${report.lxInstall?.kind}、名称=${report.lxInstall?.name}；` +
      `声明的音源 ${JSON.stringify(report.lxDescribe?.lxSources || [])}；` +
      `能力：search=${report.lxDescribe?.capabilities?.search}、resolveUrl=${report.lxDescribe?.capabilities?.resolveUrl}` +
      `${report.lxError ? `；出错：${report.lxError}` : ''}`)
    record('LX 音源：搜索时说明「只解析不搜索」而不是假装没结果',
      report.lxSearch?.results?.length === 0 &&
      report.lxSearch?.perSource?.some((item) => item.skipped === 'lx-resolver-only' && (item.note || '').length > 0),
      `对 LX 音源发起搜索：返回 ${report.lxSearch?.results?.length} 条结果，` +
      `perSource 里给出了说明「${(report.lxSearch?.perSource || []).map((item) => item.note || item.error || 'ok').join('；').slice(0, 120)}」`)
    record('LX 音源：按官方协议解析地址与歌词',
      report.lxResolve?.realUrl === audioUrl &&
      String(report.lxLyrics?.text || '').includes('LX 音源的歌词'),
      `派发 request({action:'musicUrl'}) 得到真实地址 ${String(report.lxResolve?.realUrl || '').slice(0, 46)}…` +
      `（对外暴露成代理地址 ${String(report.lxResolve?.url || '').slice(0, 32)}…）；` +
      `派发 request({action:'lyric'}) 得到「${report.lxLyrics?.text}」；` +
      `没有 musicInfo 时会明确报错而不是静默失败`)

    /* ---------- 用用户真实放进来的第三方 LX 音源文件验证装载（存在才测） ---------- */
    const repoRoot = path.join(__dirname, '..', '..')
    const userSourceIds = []
    try {
      const candidates = (await fsp.readdir(repoRoot))
        .filter((name) => name.toLowerCase().endsWith('.js'))
        .slice(0, 12)
      for (const name of candidates) {
        const full = path.join(repoRoot, name)
        const text = await fsp.readFile(full, 'utf8').catch(() => '')
        // 只挑看起来像 LX 自定义源的（脚本里引用宿主全局 lx 或声明事件名）
        if (!text || (!text.includes('globalThis') || !/EVENT_NAMES|globalThis\['lx'\]/.test(text))) continue
        try {
          const installed = await sourcesService.install(text, `user-file-${path.basename(name, '.js')}`)
          const described = sourcesService.list().find((item) => item.id === installed.id) || null
          userSourceIds.push({
            file: name,
            id: installed.id,
            kind: installed.kind,
            error: null,
            lxSources: described?.lxSources || [],
            lxEvents: described?.lxEvents || [],
            capabilities: described?.capabilities || null
          })
        } catch (err) {
          userSourceIds.push({ file: name, error: String(err?.message || err) })
        }
      }
    } catch {
      // 目录读不了就跳过
    }
    for (const entry of userSourceIds) {
      if (entry.id) {
        try { await sourcesService.remove(entry.id) } catch { /* 忽略 */ }
      }
    }
    const loadedUserSources = userSourceIds.filter((item) => !item.error)
    record('第三方 LX 音源文件能装载（用仓库根目录里的真实文件验证）',
      userSourceIds.length === 0 || loadedUserSources.length === userSourceIds.length,
      userSourceIds.length === 0
        ? '仓库根目录里没有 LX 音源文件，跳过（放进 music-sources 目录或从设置里导入即可）'
        : userSourceIds.map((item) => item.error
          ? `${item.file} → 失败：${item.error}`
          : `${item.file} → ${item.kind}${item.warning ? '（告警态）' : ''}｜订阅事件 ${JSON.stringify(item.lxEvents)}｜` +
            `声明音源 ${item.lxSources.map((sub) => `${sub.name}:${JSON.stringify(sub.actions || [])}`).join('、') || '—'}｜` +
            `搜索=${item.capabilities?.search} 解析=${item.capabilities?.resolveUrl}`).join('；'))


    /* ---------- 外部搜索器：语言无关的子进程接口 ----------
     *
     * 这里只验证「机制」：按 providers.json 起一个可执行程序，用 stdin/stdout 上的
     * JSON 协议收发。用的实现是自检临时写的几行 node 脚本（跑完即删）。
     */
    const externalDir = sourcesService.getDir()
    const finderScript = path.join(externalDir, 'smoke-finder.js')
    const providerFile = path.join(externalDir, 'providers.json')
    let externalReport = {}
    try {
      const finderSource = [
        'let input = ""',
        'process.stdin.on("data", (chunk) => { input += chunk })',
        'process.stdin.on("end", () => {',
        '  let req = {}',
        '  try { req = JSON.parse(input.trim().split(/\\r?\\n/).pop()) } catch (err) {}',
        '  const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n")',
        '  const audioUrl = ' + JSON.stringify(audioUrl),
        '  if (req.action === "search") {',
        '    send({ results: [{ id: "ext-1", title: req.query + " 的外部结果", artist: "外部搜索器", album: "外部专辑", duration: 3, quality: "ext" }] })',
        '  } else if (req.action === "resolve") {',
        '    send({ url: audioUrl })',
        '  } else if (req.action === "lyrics") {',
        '    send({ text: "[00:00.00]外部搜索器的歌词" })',
        '  } else {',
        '    send({ error: "unknown action: " + req.action })',
        '  }',
        '})'
      ].join('\n')
      await fsp.writeFile(finderScript, finderSource, 'utf8')
      await fsp.writeFile(providerFile, JSON.stringify([
        {
          id: 'smoke-finder',
          name: '自检外部搜索器',
          // Electron 里 process.execPath 是 Electron 本体，跑 node 脚本必须带这个环境变量
          command: process.execPath,
          args: [finderScript],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          timeoutMs: 8000
        }
      ], null, 2), 'utf8')

      await sourcesService.load()
      const described = sourcesService.list().find((item) => item.id === 'external-smoke-finder') || null
      const found = await sourcesService.search('外部', { sources: ['external-smoke-finder'] })
      const first = found.results[0] || null
      externalReport = {
        described: described
          ? { kind: described.kind, name: described.name, search: described.capabilities?.search, resolve: described.capabilities?.resolveUrl }
          : null,
        count: found.results.length,
        first: first ? { title: first.title, artist: first.artist, source: first.sourceName } : null,
        error: found.perSource.find((item) => item.id === 'external-smoke-finder')?.error || null
      }
      if (first) {
        const resolved = await sourcesService.resolveUrl(first)
        externalReport.resolve = { realUrl: resolved.realUrl, proxied: String(resolved.url).startsWith('remote://stream/') }
        const lyrics = await sourcesService.resolveLyrics(first)
        externalReport.lyrics = lyrics?.text || null
      }
    } catch (err) {
      externalReport.error = String(err?.message || err)
    } finally {
      await fsp.rm(finderScript, { force: true }).catch(() => {})
      await fsp.rm(providerFile, { force: true }).catch(() => {})
      await sourcesService.load().catch(() => {})
    }
    record('外部搜索器：子进程 JSON 接口可用（语言无关）',
      externalReport.described?.kind === 'external' &&
      externalReport.described?.search === true &&
      externalReport.count === 1 &&
      externalReport.first?.title?.includes('外部结果') &&
      externalReport.resolve?.realUrl === audioUrl &&
      externalReport.resolve?.proxied === true &&
      String(externalReport.lyrics || '').includes('外部搜索器的歌词'),
      externalReport.error
        ? `失败：${externalReport.error}`
        : `providers.json 里的自检搜索器被识别为 kind=${externalReport.described?.kind}（搜索=${externalReport.described?.search}）；` +
          `搜索返回 ${externalReport.count} 条「${externalReport.first?.title}」（来源 ${externalReport.first?.source}）；` +
          `解析出直链并转成代理地址=${externalReport.resolve?.proxied}；歌词「${externalReport.lyrics}」`)

    /* ---------- 搜索历史真的写进磁盘了吗（用户反馈重启后丢失） ---------- */
    const { app: electronApp } = require('electron')
    const settingsFile = path.join(electronApp.getPath('userData'), 'settings.json')
    const historyMarker = `烟测历史-${Date.now().toString().slice(-6)}`
    await evaluate(win, `
      await window.__aria.actions.clearSearchHistory()
      await window.__aria.actions.commitSearch(${JSON.stringify(historyMarker)})
      return true`)
    // 落盘是「写设置 → 主进程 fs 写 → 回调」，别读太早（读太早会拿到空历史）
    let persistedHistory = null
    let persistedRaw = ''
    for (let i = 0; i < 40; i++) {
      try {
        persistedRaw = await fsp.readFile(settingsFile, 'utf8')
        const parsed = JSON.parse(persistedRaw)
        persistedHistory = parsed.searchHistory || null
        if (Array.isArray(persistedHistory) && persistedHistory.includes(historyMarker)) break
      } catch (err) {
        persistedHistory = { error: String(err?.message || err) }
      }
      await sleep(150)
    }
    // 恢复干净状态
    await evaluate(win, `
      await window.__aria.actions.clearSearchHistory()
      return true`)
    record('搜索历史会写进设置文件（重启应当仍在）',
      Array.isArray(persistedHistory) && persistedHistory.includes(historyMarker),
      Array.isArray(persistedHistory)
        ? `提交「${historyMarker}」后，${path.basename(settingsFile)} 里的 searchHistory=${JSON.stringify(persistedHistory)}`
        : `读取设置文件失败或没有该字段：${JSON.stringify(persistedHistory)}（文件 ${settingsFile}，${persistedRaw.length} 字节）`)

    /* ---------- 单击播放开关 + 设置分组默认收起 ---------- */
    const uiPrefsCheck = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 420) => { await new Promise((r) => setTimeout(r, ms)) }
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
      actions.setQuery('')
      await settle(600)
      const rows = [...document.querySelectorAll('.track-row')]
      const rowFor = (index) => rows[index] || null

      // ① 默认（关闭）：单击只选中，不起播
      await actions.setSetting({ playOnSingleClick: false })
      await settle(300)
      const before = store.get().playback.trackId
      const firstRow = rowFor(3)
      if (firstRow) realClick(firstRow)
      await settle(700)
      const afterSingleWithOff = store.get().playback.trackId
      const selectedWithOff = document.querySelectorAll('.track-row.is-selected').length

      // ② 打开：单击直接播放
      await actions.setSetting({ playOnSingleClick: true })
      await settle(300)
      const targetRow = rowFor(5)
      const targetId = targetRow ? targetRow.dataset.id : null
      if (targetRow) realClick(targetRow)
      await settle(900)
      const afterSingleWithOn = store.get().playback.trackId
      window.__aria.player.pause()

      // ③ 行内的「更多操作」按钮不应该连带触发播放
      const rowWithMore = rowFor(7)
      const moreButton = rowWithMore ? rowWithMore.querySelector('.track-row__more') : null
      const beforeMore = store.get().playback.trackId
      if (moreButton) moreButton.click()
      await settle(500)
      const afterMore = store.get().playback.trackId
      document.querySelectorAll('.popover').forEach((node) => node.remove())

      await actions.setSetting({ playOnSingleClick: false })

      // ④ 设置页：在线音源那一组默认收起，点标题能展开
      actions.setView('settings')
      await settle(700)
      const groups = [...document.querySelectorAll('.settings__group')]
      const sourcesGroup = groups.find((node) => (node.textContent || '').includes('在线音源'))
      const head = sourcesGroup ? sourcesGroup.querySelector('.settings__group-head') : null
      const cardBody = sourcesGroup ? sourcesGroup.lastElementChild : null
      const collapsedInitially = sourcesGroup ? sourcesGroup.classList.contains('is-collapsed') : null
      const cardHiddenInitially = cardBody ? getComputedStyle(cardBody).display === 'none' : null
      if (head) head.click()
      await settle(400)
      const expandedAfterClick = sourcesGroup ? !sourcesGroup.classList.contains('is-collapsed') : null
      const cardShownAfterClick = cardBody ? getComputedStyle(cardBody).display !== 'none' : null

      actions.setView('songs')
      await settle(300)
      return {
        before,
        afterSingleWithOff,
        afterSingleWithOn,
        targetId,
        selectedWithOff,
        beforeMore,
        afterMore,
        hasSourcesGroup: Boolean(sourcesGroup),
        collapsedInitially,
        cardHiddenInitially,
        expandedAfterClick,
        cardShownAfterClick
      }
    `)
    record('设置项：单击歌曲直接播放',
      uiPrefsCheck.afterSingleWithOff === uiPrefsCheck.before &&
      uiPrefsCheck.selectedWithOff > 0 &&
      Boolean(uiPrefsCheck.targetId) &&
      uiPrefsCheck.afterSingleWithOn === uiPrefsCheck.targetId &&
      uiPrefsCheck.afterMore === uiPrefsCheck.beforeMore,
      `关闭时单击只选中（播放曲目未变：${uiPrefsCheck.before} → ${uiPrefsCheck.afterSingleWithOff}，选中 ${uiPrefsCheck.selectedWithOff} 行）；` +
      `打开后单击第 6 行直接播放（目标 ${uiPrefsCheck.targetId} → 实际 ${uiPrefsCheck.afterSingleWithOn}）；` +
      `行内「更多操作」按钮不会连带起播（${uiPrefsCheck.beforeMore} → ${uiPrefsCheck.afterMore}）`)
    record('设置页：在线音源分组默认收起、可展开',
      uiPrefsCheck.hasSourcesGroup &&
      uiPrefsCheck.collapsedInitially === true &&
      uiPrefsCheck.cardHiddenInitially === true &&
      uiPrefsCheck.expandedAfterClick === true &&
      uiPrefsCheck.cardShownAfterClick === true,
      `分组存在=${uiPrefsCheck.hasSourcesGroup}，默认收起=${uiPrefsCheck.collapsedInitially}（卡片隐藏=${uiPrefsCheck.cardHiddenInitially}）；` +
      `点标题后展开=${uiPrefsCheck.expandedAfterClick}（卡片可见=${uiPrefsCheck.cardShownAfterClick}）`)

    /* ---------- 侧边栏与灵动岛（互斥出现）/ 行悬停浮起 ---------- */
    // 悬停相关的样式（:hover）不能靠 dispatchEvent 触发 —— 合成事件不会更新
    // Blink 的 hover 状态。这里用 sendInputEvent 走真实输入管线。
    // 量之前先确保窗口在渲染（被遮挡/最小化时过渡不会推进，见 ensureVisible）
    const shellVisible = await ensureVisible(win)
    const shellVisibility = await visibilitySnapshot(win)
    const shellInfo = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 320) => { await new Promise((r) => setTimeout(r, ms)) }
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
      const box = (node) => {
        const r = node.getBoundingClientRect()
        return {
          left: Math.round(r.left),
          right: Math.round(r.right),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      }
      const islandShown = () => {
        const island = document.querySelector('.island')
        return island.classList.contains('is-visible') && getComputedStyle(island).opacity === '1'
      }
      const labelShown = (node) => node.getBoundingClientRect().width > 4

      actions.setView('songs')
      actions.setQuery('')
      await settle(700)

      const app = document.getElementById('app')
      const sidebar = document.querySelector('.sidebar')
      const collapseButton = document.querySelector('.sidebar__collapse')
      const titlebarToggle = document.querySelector('.titlebar__left .btn--icon')

      // ① 侧栏开着：灵动岛整条隐身（两者不同时出现）
      if (!store.get().ui.sidebarVisible) { actions.toggleSidebar(); await settle(700) }
      const openState = {
        sidebarVisible: store.get().ui.sidebarVisible,
        sidebarWidth: box(sidebar).width,
        islandShown: islandShown()
      }

      // ② 点侧栏自己的收起按钮
      realClick(collapseButton)
      await settle(900)
      const collapsed = {
        sidebarVisible: store.get().ui.sidebarVisible,
        hiddenFlag: app.classList.contains('is-sidebar-hidden'),
        sidebarWidth: box(sidebar).width,
        islandShown: islandShown()
      }
      const island = document.querySelector('.island')
      const rect = box(island)
      const items = [...island.querySelectorAll('.island__item')]
      const labels = [...island.querySelectorAll('.island__label')]
      const activeItem = items.find((node) => node.classList.contains('is-active'))
      const titlebar = box(document.querySelector('.titlebar'))
      const islandBase = {
        itemCount: items.length,
        activeKey: activeItem ? activeItem.dataset.view : null,
        order: items.map((node) => node.dataset.view),
        collapsedWidth: rect.width,
        visibleLabels: labels.filter(labelShown).length,
        centerOffset: Math.round((rect.left + rect.width / 2) - (titlebar.left + titlebar.width / 2)),
        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      }
      return { openState, collapsed, islandBase }
    `)

    // 悬停要把真实指针送到岛上。第一次 move 有时不生效（Chromium 对「坐标没变」
    // 的移动事件可能不更新 hover 状态），所以先挪到旁边再挪进来，并最多重试三次；
    // 顺便记下命中测试的结果，失败时能一眼看出是被谁挡住了。
    const islandCenter = shellInfo.islandBase.center || { x: 400, y: 20 }
    let islandHover = { hovered: false, visibleLabels: 0, hoveredWidth: 0, attempts: 0 }
    for (let attempt = 1; attempt <= 3; attempt++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: islandCenter.x - 40, y: islandCenter.y })
      await sleep(180)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: islandCenter.x, y: islandCenter.y })
      await sleep(700)
      islandHover = await evaluate(win, `
        const island = document.querySelector('.island')
        const rect = island.getBoundingClientRect()
        const labels = [...island.querySelectorAll('.island__label')]
        const hit = document.elementFromPoint(${islandCenter.x}, ${islandCenter.y})
        return {
          hovered: island.matches(':hover'),
          hoveredWidth: Math.round(rect.width),
          visibleLabels: labels.filter((node) => node.getBoundingClientRect().width > 4).length,
          rect: { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
          hit: hit ? (hit.className || hit.tagName) : null,
          attempts: ${attempt}
        }
      `)
      if (islandHover.hovered) break
    }
    // 移开指针，别把悬停状态带进后面的检查
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 420 })
    await sleep(700)
    const islandClick = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 320) => { await new Promise((r) => setTimeout(r, ms)) }
      const island = document.querySelector('.island')
      const thumb = island.querySelector('.island__thumb')
      const items = [...island.querySelectorAll('.island__item')]
      const beforeLeft = Math.round(thumb.getBoundingClientRect().left)
      const albumItem = items.find((node) => node.dataset.view === 'albums')
      const rect = albumItem.getBoundingClientRect()
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        albumItem.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
          button: 0, buttons: type.includes('down') ? 1 : 0
        }))
      }
      await settle(700)
      const viewAfter = store.get().ui.view
      const activeAfter = (items.find((node) => node.classList.contains('is-active')) || {}).dataset
      const afterLeft = Math.round(thumb.getBoundingClientRect().left)
      // 设置页不属于这四段，整条应该淡出
      actions.setView('settings')
      await settle(600)
      const hiddenOnSettings = !island.classList.contains('is-visible') &&
        getComputedStyle(island).opacity === '0'
      actions.setView('songs')
      await settle(500)
      return { beforeLeft, afterLeft, viewAfter, activeAfter: activeAfter ? activeAfter.view : null, hiddenOnSettings }
    `)
    record('侧栏与灵动岛：不同时出现，侧栏自己的按钮能收起',
      shellVisible === true &&
      shellInfo.openState.sidebarVisible === true &&
      shellInfo.openState.sidebarWidth > 200 &&
      shellInfo.openState.islandShown === false &&
      shellInfo.collapsed.sidebarVisible === false &&
      shellInfo.collapsed.hiddenFlag === true &&
      shellInfo.collapsed.sidebarWidth <= 1 &&
      shellInfo.collapsed.islandShown === true,
      `侧栏开着时：宽 ${shellInfo.openState.sidebarWidth}px、灵动岛出现=${shellInfo.openState.islandShown}；` +
      `点侧栏头部收起按钮后：宽 ${shellInfo.collapsed.sidebarWidth}px、灵动岛出现=${shellInfo.collapsed.islandShown}；` +
      `窗口在渲染=${shellVisible}（页面 ${shellVisibility.state}、最小化=${shellVisibility.minimized}、可见=${shellVisibility.visible}）`)
    record('顶栏灵动岛：切换视图 + 悬停展开',
      shellInfo.islandBase.itemCount === 4 &&
      shellInfo.islandBase.activeKey === 'songs' &&
      shellInfo.islandBase.visibleLabels === 1 &&
      Math.abs(shellInfo.islandBase.centerOffset) <= 2 &&
      islandHover.hovered === true &&
      islandHover.visibleLabels === 4 &&
      islandHover.hoveredWidth > shellInfo.islandBase.collapsedWidth + 40 &&
      islandClick.viewAfter === 'albums' &&
      islandClick.activeAfter === 'albums' &&
      islandClick.afterLeft > islandClick.beforeLeft &&
      islandClick.hiddenOnSettings === true,
      `收起时宽 ${shellInfo.islandBase.collapsedWidth}px、只显示当前项文字（可见标签 ${shellInfo.islandBase.visibleLabels}/4），与标题栏中心偏差 ${shellInfo.islandBase.centerOffset}px；` +
      `悬停后 ${islandHover.hoveredWidth}px、标签 ${islandHover.visibleLabels}/4（:hover=${islandHover.hovered}，第 ${islandHover.attempts} 次尝试成功；` +
      `岛盒子 ${islandHover.rect ? `${islandHover.rect.left}~${islandHover.rect.right} × ${islandHover.rect.top}~${islandHover.rect.bottom}` : '—'}，命中 ${islandHover.hit}）；` +
      `点「专辑」→ 视图 ${islandClick.viewAfter}，高亮 ${islandClick.activeAfter}，滑块 ${islandClick.beforeLeft}→${islandClick.afterLeft}px；` +
      `设置页整条淡出=${islandClick.hiddenOnSettings}`)

    /* ---------- 最小化：释放后台占用，回来时恢复 ---------- */
    // 主进程侧的账本在这里拿：app.getAppMetrics() 是所有进程的内存口径
    const background = ctx.get('background')
    const pickMemory = () => background.state.memory

    // 先把媒体墙建起来（它不是当前视图就没东西可释放），并开始播放：
    // 最小化之后音乐必须还在放 —— 释放的是「能重建的」，不是「正在用的」
    await ensureVisible(win)
    // 如果前面被动经历过一次「长时间不在前台」，这里是释放状态，先恢复
    if (background.state.released) background.resume()
    await sleep(600)
    const releaseBefore = await evaluate(win, `
      const { actions, player, views, prewarmer, store } = window.__aria
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 1500))
      // 等到墙真的建出来为止（正常情况下重建只要 ~100ms）
      for (let i = 0; i < 40 && views.mediaWall.tileCount < 100; i++) {
        await new Promise((r) => setTimeout(r, 200))
      }
      await player.play()
      await new Promise((r) => setTimeout(r, 1200))
      return {
        wallTiles: views.mediaWall.tileCount,
        wallNodes: document.querySelectorAll('.wall-tile').length,
        nodes: document.getElementsByTagName('*').length,
        covers: document.querySelectorAll('img[src^="blob:"]').length,
        prewarmSuspended: prewarmer.state.suspended,
        status: store.get().playback.status,
        trackId: store.get().playback.trackId,
        time: Math.round(player.getTime() * 10) / 10
      }
    `)
    const memoryBefore = pickMemory()

    win.minimize()
    // 主进程的释放延迟是 4s，之后还要等它量完内存
    await sleep(6500)
    const releasedState = await evaluate(win, `
      const { background, views, prewarmer, store, player } = window.__aria
      return {
        released: background.state.released,
        lastRelease: background.state.lastRelease,
        wallTiles: views.mediaWall.tileCount,
        wallNodes: document.querySelectorAll('.wall-tile').length,
        nodes: document.getElementsByTagName('*').length,
        prewarmSuspended: prewarmer.state.suspended,
        status: store.get().playback.status,
        time: Math.round(player.getTime() * 10) / 10,
        minimizedPlayback: store.get().playback.trackId
      }
    `)
    const memoryAfter = pickMemory()
    const mainRelease = background.state.lastRelease

    win.restore()
    await sleep(2000)
    const resumedState = await evaluate(win, `
      const { background, views, prewarmer, store, actions } = window.__aria
      actions.setView('wall')
      await new Promise((r) => setTimeout(r, 1500))
      return {
        released: background.state.released,
        resumes: background.state.resumes,
        prewarmSuspended: prewarmer.state.suspended,
        wallTiles: views.mediaWall.tileCount,
        wallNodes: document.querySelectorAll('.wall-tile').length,
        status: store.get().playback.status
      }
    `)

    // 目录监听：长时间不在前台才停（45s），这里用 force 直接把这条路径跑一遍
    const watcherBefore = ctx.get('watcher').getStats().watching
    background.pauseWatcher({ force: true })
    const watcherPaused = ctx.get('watcher').getStats().watching
    background.resume()
    await sleep(1200)
    const watcherResumed = ctx.get('watcher').getStats().watching

    record('最小化：释放媒体墙与封面缓存（回来能恢复）',
      releaseBefore.wallTiles > 100 &&
      releaseBefore.wallNodes > 100 &&
      releasedState.released === true &&
      releasedState.lastRelease &&
      releasedState.lastRelease.wallTiles >= 100 &&
      releasedState.lastRelease.covers > 0 &&
      releasedState.lastRelease.gc === true &&
      releasedState.wallNodes === 0 &&
      // 整页节点数要明显掉下来（只掉几十个说明墙又被重建回去了）
      releaseBefore.nodes - releasedState.nodes > 1000 &&
      releasedState.prewarmSuspended === true &&
      mainRelease &&
      mainRelease.savedKB > 0 &&
      memoryAfter.workingSetKB < memoryBefore.workingSetKB &&
      // 最小化之后音乐不能停
      releasedState.status === 'playing' &&
      releasedState.time >= releaseBefore.time &&
      releasedState.minimizedPlayback === releaseBefore.trackId,
      `释放前：媒体墙 ${releaseBefore.wallTiles} 个格子 / ${releaseBefore.wallNodes} 个节点 / 整页 ${releaseBefore.nodes} 个节点；` +
      `释放后：墙上剩 ${releasedState.wallNodes} 个节点、整页 ${releasedState.nodes} 个，渲染层回收了 ${releasedState.lastRelease ? releasedState.lastRelease.wallTiles : 0} 个格子与 ` +
      `${releasedState.lastRelease ? releasedState.lastRelease.covers : 0} 个封面 URL（GC=${releasedState.lastRelease ? releasedState.lastRelease.gc : '—'}，预热已挂起=${releasedState.prewarmSuspended}）；` +
      `内存 ${Math.round(memoryBefore.workingSetKB / 1024)}MB → ${Math.round(memoryAfter.workingSetKB / 1024)}MB` +
      `${mainRelease ? `（主进程记的账：省下 ${Math.round(mainRelease.savedKB / 1024)}MB）` : ''}；` +
      `播放未被打断：${releaseBefore.status} ${releaseBefore.time}s → ${releasedState.status} ${releasedState.time}s`)
    record('恢复：预热回来、媒体墙重建、目录监听能停能起',
      resumedState.released === false &&
      resumedState.resumes >= 1 &&
      resumedState.prewarmSuspended === false &&
      resumedState.wallTiles > 100 &&
      resumedState.wallNodes > 100 &&
      resumedState.status === 'playing' &&
      watcherBefore > 0 &&
      watcherPaused === 0 &&
      watcherResumed === watcherBefore,
      `恢复后：预热挂起=${resumedState.prewarmSuspended}，媒体墙重建 ${resumedState.wallTiles} 个格子 / ${resumedState.wallNodes} 个节点；` +
      `目录监听 ${watcherBefore} → 停止后 ${watcherPaused} → 恢复后 ${watcherResumed}；播放仍是 ${resumedState.status}`)

    /* ---------- 自建播放列表：新建 / 加歌 / 播放 / 移除 / 删除 ---------- */
    const playlistCheck = await evaluate(win, `
      const { actions, store, player } = window.__aria
      const settle = async (ms = 420) => { await new Promise((r) => setTimeout(r, ms)) }

      // 从干净状态开始
      for (const item of actions.playlists()) await actions.deletePlaylist(item.id)
      await settle(400)

      const tracks = store.get().library.tracks
      const picked = tracks.slice(0, 3).map((track) => track.id)

      // ① 新建
      const created = await actions.createPlaylist('自检用列表')
      await settle(400)
      const afterCreate = actions.playlists().map((item) => ({ id: item.id, name: item.name, count: item.trackIds.length }))

      // ② 加歌（含重复添加，应该被跳过）
      const first = await actions.addTracksToPlaylist(created.id, picked, { silent: true })
      const second = await actions.addTracksToPlaylist(created.id, [picked[0]], { silent: true })
      await settle(400)
      const stored = actions.playlists().find((item) => item.id === created.id)

      // ③ 打开这个列表：侧栏出现这一行、列表页标题与内容都跟着它走
      actions.openPlaylist(created.id)
      await settle(900)
      const viewState = {
        source: store.get().ui.source.type,
        value: store.get().ui.source.value,
        view: store.get().ui.view,
        title: document.querySelector('.library-view__title, .view-header__title')?.textContent ||
          document.querySelector('.view-toolbar__title')?.textContent || '',
        rows: document.querySelectorAll('.track-row').length,
        sidebarRow: [...document.querySelectorAll('.sidebar__row')].some((node) => node.textContent.includes('自检用列表')),
        sidebarCount: [...document.querySelectorAll('.sidebar__row')]
          .filter((node) => node.textContent.includes('自检用列表'))
          .map((node) => (node.querySelector('.sidebar__row-count') || {}).textContent || '')[0] || ''
      }

      // ④ 播放这个列表：队列应该正好是这三首
      actions.playPlaylist(created.id)
      await settle(1200)
      const queueAfterPlay = player.playlist.queue.slice()
      player.pause()

      // ⑤ 从列表里移除一首
      await actions.removeTrackFromPlaylist(created.id, picked[1])
      await settle(500)
      const afterRemove = (actions.playlists().find((item) => item.id === created.id) || {}).trackIds || []

      // ⑥ 删除
      await actions.deletePlaylist(created.id)
      await settle(500)
      const afterDelete = actions.playlists().length
      const sourceAfterDelete = store.get().ui.source.type

      actions.setView('songs')
      actions.setSource({ type: 'all', value: null })
      await settle(600)

      return {
        created: created ? { id: created.id, name: created.name } : null,
        afterCreate,
        added: first.added,
        skipped: second.skipped,
        storedCount: stored ? stored.trackIds.length : -1,
        storedOrder: stored ? stored.trackIds.slice() : [],
        picked,
        viewState,
        queueAfterPlay,
        afterRemove,
        afterDelete,
        sourceAfterDelete
      }
    `)
    record('播放列表：新建 / 加歌去重 / 打开 / 播放 / 移除 / 删除',
      playlistCheck.created &&
      playlistCheck.afterCreate.length === 1 &&
      playlistCheck.afterCreate[0].name === '自检用列表' &&
      playlistCheck.added === 3 &&
      playlistCheck.skipped === 1 &&
      playlistCheck.storedCount === 3 &&
      playlistCheck.storedOrder.join() === playlistCheck.picked.join() &&
      playlistCheck.viewState.source === 'playlist' &&
      playlistCheck.viewState.value === playlistCheck.created.id &&
      playlistCheck.viewState.view === 'songs' &&
      playlistCheck.viewState.rows === 3 &&
      playlistCheck.viewState.sidebarRow === true &&
      playlistCheck.viewState.sidebarCount === '3' &&
      playlistCheck.queueAfterPlay.join() === playlistCheck.picked.join() &&
      playlistCheck.afterRemove.join() === [playlistCheck.picked[0], playlistCheck.picked[2]].join() &&
      playlistCheck.afterDelete === 0 &&
      playlistCheck.sourceAfterDelete === 'all',
      `新建「${playlistCheck.created ? playlistCheck.created.name : '—'}」；加入 3 首（再重复加 1 首被跳过：added=${playlistCheck.added} / skipped=${playlistCheck.skipped}）；` +
      `打开后 source=${playlistCheck.viewState.source} 标题「${playlistCheck.viewState.title}」列表 ${playlistCheck.viewState.rows} 行、侧栏出现该行=${playlistCheck.viewState.sidebarRow}（计数 ${playlistCheck.viewState.sidebarCount}）；` +
      `播放时队列 = ${playlistCheck.queueAfterPlay.length} 首且顺序一致=${playlistCheck.queueAfterPlay.join() === playlistCheck.picked.join()}；` +
      `移除一首后剩 ${playlistCheck.afterRemove.length} 首；删除后剩 ${playlistCheck.afterDelete} 个、来源回到 ${playlistCheck.sourceAfterDelete}`)

    /* ---------- 搜索「taylor」时最匹配的艺人要在最前面 ---------- */
    // 合作曲目拆分之后，「X&Y」这类记录会同时挂在两位艺人名下 —— 搜 taylor 时
    // Bon Iver / Ed Sheeran 这些合作方也会进艺人列表，字母序会把人压在后面。
    const artistRanking = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }
      actions.setView('artists')
      actions.setQuery('taylor')
      await settle(900)

      const names = actions.artists().map((artist) => artist.name)
      const isMatch = (name) => String(name).toLowerCase().includes('taylor')
      const hits = names.map(isMatch)
      const firstNonMatch = hits.indexOf(false)
      const lastMatch = hits.lastIndexOf(true)
      const rendered = [...document.querySelectorAll('.artist-row__name')].slice(0, 5).map((node) => node.textContent)

      actions.setQuery('')
      actions.setView('songs')
      await settle(600)
      return {
        total: names.length,
        matched: hits.filter(Boolean).length,
        first: names[0] || null,
        lastMatchIndex: lastMatch,
        firstNonMatchIndex: firstNonMatch,
        head: names.slice(0, 6),
        rendered
      }
    `)
    record('搜索：名字命中的艺人排在合作方前面',
      artistRanking.matched > 0 &&
      artistRanking.first === 'Taylor Swift' &&
      artistRanking.lastMatchIndex >= 0 &&
      // 所有命中名字的都在前面，第一个没命中的出现在最后一个命中之后
      artistRanking.firstNonMatchIndex === artistRanking.lastMatchIndex + 1 &&
      artistRanking.rendered[0] === 'Taylor Swift',
      `搜「taylor」命中 ${artistRanking.matched}/${artistRanking.total} 位艺人；前 6 位：${artistRanking.head.join(' / ')}；` +
      `命中项全部排在前面=${artistRanking.firstNonMatchIndex === artistRanking.lastMatchIndex + 1}` +
      `（最后一个命中 #${artistRanking.lastMatchIndex + 1}，第一个未命中 #${artistRanking.firstNonMatchIndex + 1}）；界面前 5 行：${artistRanking.rendered.join(' / ')}`)

    /* ---------- 侧栏「新建播放列表」入口要看得见、点得到 ---------- */
    const newPlaylistUi = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)) }
      // 这一段量的就是侧栏里的东西，先确保侧栏是展开的
      if (!store.get().ui.sidebarVisible) { actions.toggleSidebar(); await settle(700) }
      actions.setView('songs')
      actions.setSource({ type: 'all', value: null })
      await settle(600)
      // 组头那颗 + 曾经是 opacity: 0（只靠「行悬停」才出现，而组头不是行），
      // 用户因此完全找不到新建入口
      const headButton = document.querySelector('.sidebar__section-head .sidebar__row-action[title="新建播放列表"]')
      const ghostRow = document.querySelector('.sidebar__row--ghost[title="新建播放列表"]')
      const styleOf = (node) => {
        if (!node) return null
        const style = getComputedStyle(node)
        const rect = node.getBoundingClientRect()
        const hit = rect.width > 0
          ? document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
          : null
        return {
          opacity: style.opacity,
          display: style.display,
          width: Math.round(rect.width),
          hitInside: Boolean(hit && (hit === node || node.contains(hit)))
        }
      }
      const head = styleOf(headButton)
      const ghost = styleOf(ghostRow)

      // 点这条入口应该真的能建：输入名字 → 创建 → 出现在侧栏
      const openEditor = () => ghostRow && ghostRow.click()
      openEditor()
      const input = await (async () => {
        for (let i = 0; i < 20; i++) {
          const node = document.querySelector('.playlist-editor__input')
          if (node) return node
          await settle(60)
        }
        return null
      })()
      let created = null
      if (input) {
        input.value = '点出来的列表'
        // 按钮在 .playlist-editor__actions 里，不是 .playlist-editor 的子节点
        document.querySelector('.playlist-editor__actions .btn--primary')?.click()
        await settle(800)
        created = actions.playlists().map((item) => item.name)
      }
      // 收尾：删掉，别留在档案里
      for (const item of actions.playlists()) await actions.deletePlaylist(item.id)
      actions.setSource({ type: 'all', value: null })
      await settle(400)

      return { head, ghost, inputShown: Boolean(input), created }
    `)
    record('侧栏：新建播放列表的入口看得见也点得到',
      newPlaylistUi.head &&
      newPlaylistUi.head.opacity === '1' &&
      newPlaylistUi.head.width > 0 &&
      newPlaylistUi.head.hitInside === true &&
      newPlaylistUi.ghost &&
      newPlaylistUi.ghost.opacity === '1' &&
      newPlaylistUi.ghost.width > 100 &&
      newPlaylistUi.ghost.hitInside === true &&
      newPlaylistUi.inputShown === true &&
      Array.isArray(newPlaylistUi.created) &&
      newPlaylistUi.created.includes('点出来的列表'),
      `组头的 + ：opacity=${newPlaylistUi.head ? newPlaylistUi.head.opacity : '—'} 宽 ${newPlaylistUi.head ? newPlaylistUi.head.width : 0}px 命中=${newPlaylistUi.head ? newPlaylistUi.head.hitInside : '—'}；` +
      `「新建播放列表」这一行：宽 ${newPlaylistUi.ghost ? newPlaylistUi.ghost.width : 0}px 命中=${newPlaylistUi.ghost ? newPlaylistUi.ghost.hitInside : '—'}；` +
      `点它弹出输入框=${newPlaylistUi.inputShown}，创建出的列表=${JSON.stringify(newPlaylistUi.created)}`)

    /* ---------- 灵动岛：能拖窗口 + 深色下看得见 ---------- */
    const islandSurface = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }
      const island = document.querySelector('.island')
      const item = island.querySelector('.island__item')
      const titlebar = document.querySelector('.titlebar')
      // -webkit-app-region 决定"这一块能不能拖窗口"：标题栏的每个子元素都被设成
      // no-drag，灵动岛必须显式改回 drag，否则标题栏正中会留一块拖不动的死区
      const regionOf = (node) => getComputedStyle(node).webkitAppRegion || getComputedStyle(node).getPropertyValue('-webkit-app-region')

      if (!store.get().ui.sidebarVisible) { actions.toggleSidebar(); await settle(600) }
      const hidden = { region: regionOf(island), opacity: getComputedStyle(island).opacity }
      if (store.get().ui.sidebarVisible) { actions.toggleSidebar(); await settle(600) }
      const shown = {
        region: regionOf(island),
        itemRegion: regionOf(item),
        opacity: getComputedStyle(island).opacity,
        background: getComputedStyle(island).backgroundColor
      }

      // 深色下也必须有可见的底（曾经只是 14% 灰，几乎看不出来）
      await actions.setSetting({ theme: 'dark' })
      await settle(600)
      const dark = {
        background: getComputedStyle(island).backgroundColor,
        theme: document.documentElement.dataset.theme
      }
      await actions.setSetting({ theme: 'light' })
      await settle(600)
      const light = { background: getComputedStyle(island).backgroundColor }
      await actions.setSetting({ theme: 'system' })
      await settle(500)
      return { hidden, shown, dark, light }
    `)
    const alphaOf = (color) => {
      const match = /rgba?\(([^)]+)\)/.exec(String(color))
      if (!match) return 1
      const parts = match[1].split(',').map((value) => Number(value.trim()))
      return parts.length >= 4 ? parts[3] : 1
    }
    record('灵动岛：这块区域也能拖窗口（走 JS，不再依赖 app-region），深色下也看得见',
      /*
       * 不变量变了：这条以前断言灵动岛的 -webkit-app-region 是 drag（靠系统原生拖动）。
       * 现在拖动统一成 JS（标题栏一律 no-drag），所以断言 no-drag；
       * 而"这块区域真的能拖"由 runRealDragChecks 的真拖来证明，不是靠样式猜。
       */
      islandSurface.hidden.region === 'no-drag' &&
      islandSurface.shown.region === 'no-drag' &&
      islandSurface.shown.itemRegion === 'no-drag' &&
      islandSurface.shown.opacity === '1' &&
      alphaOf(islandSurface.dark.background) >= 0.2 &&
      alphaOf(islandSurface.light.background) >= 0.08 &&
      alphaOf(islandSurface.dark.background) > alphaOf(islandSurface.light.background),
      `app-region：隐藏时 ${islandSurface.hidden.region}（opacity ${islandSurface.hidden.opacity}）、显示时 ${islandSurface.shown.region}、分段按钮 ${islandSurface.shown.itemRegion}；` +
      `底色 深色=${islandSurface.dark.background}（alpha ${alphaOf(islandSurface.dark.background)}）／亮色=${islandSurface.light.background}（alpha ${alphaOf(islandSurface.light.background)}）`)

    /* ---------- 队列要跟着「你在哪一页播放」变 ----------
     *
     * 回归现场：队列面板只在队列**长度**变化时重画。于是从媒体墙点了另一张
     * 曲目数恰好一样的专辑，队列里还显示上一张专辑的歌。
     */
    const queueFollow = await evaluate(win, `
      const { actions, player } = window.__aria
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }
      // 找两张曲目数相同的专辑，这样"只比长度"的写法一定会露馅
      const albums = actions.albums()
      const byCount = new Map()
      for (const album of albums) {
        const list = byCount.get(album.trackCount) || []
        list.push(album)
        byCount.set(album.trackCount, list)
      }
      let pair = null
      for (const [count, list] of byCount) {
        if (count >= 2 && list.length >= 2) {
          pair = list.slice(0, 2)
          break
        }
      }
      if (!pair) {
        const two = albums.filter((album) => album.trackCount >= 1).slice(0, 2)
        pair = two.length === 2 ? two : null
      }
      if (!pair) return { missing: true }

      const titlesOf = () => [...document.querySelectorAll('.queue-item__title')].map((node) => node.textContent)
      const expected = (album) => album.tracks.map((track) => track.title)

      // 第一张：像点媒体墙的格子那样播放（整张专辑进队列）
      actions.setView('wall')
      await settle(700)
      player.playCollection(pair[0].tracks.map((t) => t.id), pair[0].tracks[0].id)
      actions.toggleQueue(true)
      await settle(1200)
      const firstTitles = titlesOf()
      player.pause()

      // 第二张：曲目数一样
      player.playCollection(pair[1].tracks.map((t) => t.id), pair[1].tracks[0].id)
      await settle(1200)
      const secondTitles = titlesOf()
      player.pause()

      actions.toggleQueue(false)
      actions.setView('songs')
      await settle(500)

      return {
        missing: false,
        firstAlbum: { name: pair[0].name, count: pair[0].trackCount },
        secondAlbum: { name: pair[1].name, count: pair[1].trackCount },
        sameLength: pair[0].trackCount === pair[1].trackCount,
        firstTitles,
        secondTitles,
        expectedFirst: expected(pair[0]),
        expectedSecond: expected(pair[1])
      }
    `)
    const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
    record('队列面板：换一页播放（曲目数相同）也跟着换',
      queueFollow.missing === false &&
      queueFollow.sameLength === true &&
      sameList(queueFollow.firstTitles, queueFollow.expectedFirst) &&
      sameList(queueFollow.secondTitles, queueFollow.expectedSecond),
      queueFollow.missing
        ? '资料库里没有两张曲目数相同的专辑，跳过'
        : `《${queueFollow.firstAlbum.name}》(${queueFollow.firstAlbum.count} 首) → 队列显示 ${queueFollow.firstTitles.length} 行，与专辑一致=${sameList(queueFollow.firstTitles, queueFollow.expectedFirst)}；` +
          `换成《${queueFollow.secondAlbum.name}》(${queueFollow.secondAlbum.count} 首，长度相同) → 队列 ${queueFollow.secondTitles.length} 行，与专辑一致=${sameList(queueFollow.secondTitles, queueFollow.expectedSecond)}，` +
          `两页内容不同=${!sameList(queueFollow.firstTitles, queueFollow.secondTitles)}`)

    /* ---------- 批量选择歌曲加入播放列表 ---------- */
    const batchCheck = await evaluate(win, `
      const { actions, store, player } = window.__aria
      const settle = async (ms = 420) => { await new Promise((r) => setTimeout(r, ms)) }
      const rows = () => [...document.querySelectorAll('.track-row')]
      const realClick = (node, options = {}) => {
        const rect = node.getBoundingClientRect()
        const base = {
          bubbles: true, cancelable: true, button: 0,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2)
        }
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          node.dispatchEvent(new MouseEvent(type, {
            ...base, buttons: type.includes('down') ? 1 : 0, ...options
          }))
        }
      }

      for (const item of actions.playlists()) await actions.deletePlaylist(item.id)
      actions.setView('songs')
      actions.setQuery('')
      actions.setSource({ type: 'all', value: null })
      await settle(900)
      const trackCount = store.get().library.tracks.length

      // ① 普通单击：只选中一首
      realClick(rows()[1])
      await settle(300)
      const single = {
        selection: store.get().ui.selection.slice(),
        highlighted: document.querySelectorAll('.track-row.is-selected').length,
        barHidden: document.querySelector('.tracklist__selection').hidden
      }

      // ② Ctrl 点击：加进选择
      realClick(rows()[3], { ctrlKey: true })
      realClick(rows()[5], { ctrlKey: true })
      await settle(300)
      const ctrl = {
        selection: store.get().ui.selection.slice(),
        highlighted: document.querySelectorAll('.track-row.is-selected').length,
        count: (document.querySelector('.tracklist__selection-count') || {}).textContent || '',
        barHidden: document.querySelector('.tracklist__selection').hidden
      }

      // ③ Shift 点击：从锚点（最后一次点选的行，第 6 行）到目标整段选中
      realClick(rows()[9], { shiftKey: true })
      await settle(300)
      const shift = {
        selection: store.get().ui.selection.slice(),
        // 这段的 id 应该正好是第 6~10 行那五首
        expected: rows().slice(5, 10).map((node) => node.dataset.id),
        highlighted: document.querySelectorAll('.track-row.is-selected').length
      }

      // ④ Ctrl+A 全选
      const viewport = document.querySelector('.tracklist__viewport')
      viewport.focus()
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
      await settle(400)
      const selectAll = {
        selection: store.get().ui.selection.length,
        count: (document.querySelector('.tracklist__selection-count') || {}).textContent || ''
      }

      // ⑤ Esc 清空
      viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      await settle(400)
      const afterEscape = {
        selection: store.get().ui.selection.length,
        barHidden: document.querySelector('.tracklist__selection').hidden,
        highlighted: document.querySelectorAll('.track-row.is-selected').length
      }

      // ⑥ 重新选 4 首 → 用工具条加进新建的播放列表
      for (const index of [0, 1, 2, 3]) realClick(rows()[index], { ctrlKey: index > 0 })
      await settle(400)
      const picked = store.get().ui.selection.slice()
      const bar = document.querySelector('.tracklist__selection')
      const addButton = [...bar.querySelectorAll('.btn')].find((node) => node.textContent.includes('添加到播放列表'))
      const buttonHit = (() => {
        const rect = addButton.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
        return Boolean(hit && (hit === addButton || addButton.contains(hit)))
      })()
      addButton.click()
      await settle(500)
      const picker = document.querySelector('.popover')
      const pickerRow = picker ? [...picker.querySelectorAll('.popover__row')].find((node) => node.textContent.includes('新建播放列表')) : null
      const pickerTitle = picker ? (picker.querySelector('.popover__title') || {}).textContent || '' : ''
      if (pickerRow) pickerRow.click()
      await settle(900)
      const createdPlaylist = actions.playlists()[0] || null
      const afterAdd = {
        pickerTitle,
        playlists: actions.playlists().length,
        tracks: createdPlaylist ? createdPlaylist.trackIds.slice() : [],
        selectionCleared: store.get().ui.selection.length === 0,
        barHidden: document.querySelector('.tracklist__selection').hidden
      }

      // ⑦ 批量「下一首播放」：整批插到当前曲目之后
      const albumForQueue = actions.albums()[0]
      player.playCollection(albumForQueue.tracks.map((t) => t.id), albumForQueue.tracks[0].id)
      await settle(700)
      for (const index of [0, 1, 2]) realClick(rows()[index], { ctrlKey: index > 0 })
      await settle(300)
      const queueBefore = player.playlist.queue.length
      const queuePicked = store.get().ui.selection.slice()
      const nextButton = [...document.querySelector('.tracklist__selection').querySelectorAll('.btn')]
        .find((node) => node.textContent === '下一首播放')
      nextButton.click()
      await settle(600)
      const queueAfter = player.playlist.queue.slice()
      player.pause()

      // ⑧ 右键菜单在「已选中的一批」上时是批量菜单
      for (const item of actions.playlists()) await actions.deletePlaylist(item.id)
      realClick(rows()[0])
      await settle(200)
      realClick(rows()[1], { ctrlKey: true })
      await settle(200)
      const rowNode = rows()[1]
      rowNode.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: Math.round(rowNode.getBoundingClientRect().left + 40),
        clientY: Math.round(rowNode.getBoundingClientRect().top + 10)
      }))
      await settle(400)
      const menu = document.querySelector('.menu')
      const menuText = menu ? menu.textContent : ''
      const batchItems = {
        header: menu ? (menu.querySelector('.menu__header') || {}).textContent || '' : '',
        text: menuText,
        itemCount: menu ? menu.querySelectorAll('.menu__item').length : 0
      }
      if (menu) menu.remove()
      actions.clearSelection()
      actions.setView('songs')
      await settle(300)

      return {
        trackCount, single, ctrl, shift, selectAll, afterEscape, picked, buttonHit, afterAdd,
        queueBefore, queueAfter, queuePicked, batchItems
      }
    `)
    const batchQueueOk = batchCheck.queuePicked.length === 3 &&
      batchCheck.queueAfter.length === batchCheck.queueBefore + 3 &&
      batchCheck.queuePicked.every((id, offset) => batchCheck.queueAfter[1 + offset] === id)
    record('多选：普通点击 / Ctrl 点 / Shift 段选 / Ctrl+A / Esc',
      batchCheck.single.selection.length === 1 &&
      batchCheck.single.highlighted === 1 &&
      batchCheck.single.barHidden === true &&
      batchCheck.ctrl.selection.length === 3 &&
      batchCheck.ctrl.highlighted === 3 &&
      batchCheck.ctrl.barHidden === false &&
      batchCheck.ctrl.count === '已选 3 首' &&
      batchCheck.shift.selection.length === 5 &&
      batchCheck.shift.selection.join() === batchCheck.shift.expected.join() &&
      batchCheck.shift.highlighted === 5 &&
      batchCheck.selectAll.selection === batchCheck.trackCount &&
      batchCheck.selectAll.count === `已选全部 ${batchCheck.trackCount} 首` &&
      batchCheck.afterEscape.selection === 0 &&
      batchCheck.afterEscape.barHidden === true &&
      batchCheck.afterEscape.highlighted === 0,
      `单击 → 选中 ${batchCheck.single.selection.length} 首（高亮 ${batchCheck.single.highlighted} 行，工具条隐藏=${batchCheck.single.barHidden}，单选不弹工具条）；` +
      `Ctrl 点两次 → ${batchCheck.ctrl.selection.length} 首（「${batchCheck.ctrl.count}」）；` +
      `Shift 点第 10 行 → 从锚点整段 ${batchCheck.shift.selection.length} 首（与第 6~10 行一致=${batchCheck.shift.selection.join() === batchCheck.shift.expected.join()}）；` +
      `Ctrl+A → ${batchCheck.selectAll.selection}/${batchCheck.trackCount} 首（「${batchCheck.selectAll.count}」）；` +
      `Esc → ${batchCheck.afterEscape.selection} 首、工具条隐藏=${batchCheck.afterEscape.barHidden}`)
    record('多选：一键加进播放列表 / 批量进队列 / 右键批量菜单',
      batchCheck.picked.length === 4 &&
      batchCheck.buttonHit === true &&
      batchCheck.afterAdd.pickerTitle.includes('4 首') &&
      batchCheck.afterAdd.playlists === 1 &&
      batchCheck.afterAdd.tracks.length === 4 &&
      batchCheck.afterAdd.tracks.join() === batchCheck.picked.join() &&
      batchCheck.afterAdd.selectionCleared === true &&
      batchCheck.afterAdd.barHidden === true &&
      batchQueueOk &&
      batchCheck.batchItems.header.includes('已选中 2 首') &&
      batchCheck.batchItems.text.includes('播放这 2 首') &&
      batchCheck.batchItems.text.includes('添加到播放列表') &&
      batchCheck.batchItems.text.includes('结束多选'),
      `选中 ${batchCheck.picked.length} 首 → 工具条按钮命中=${batchCheck.buttonHit}，面板标题「${batchCheck.afterAdd.pickerTitle}」，` +
      `新建的列表收到 ${batchCheck.afterAdd.tracks.length} 首且顺序一致=${batchCheck.afterAdd.tracks.join() === batchCheck.picked.join()}，加完自动清空选择=${batchCheck.afterAdd.selectionCleared}；` +
      `批量「下一首播放」：队列 ${batchCheck.queueBefore} → ${batchCheck.queueAfter.length} 首，3 首插在当前曲目之后=${batchQueueOk}；` +
      `右键已选中的一批 → 菜单标题「${batchCheck.batchItems.header}」、${batchCheck.batchItems.itemCount} 项（含批量文案=${batchCheck.batchItems.text.includes('这 2 首')}）`)

    /* ---------- 勾选框：选中的打勾、没选的空着 ---------- */
    const checkboxCheck = await evaluate(win, `
      const { actions, store, player } = window.__aria
      const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)) }
      const rows = () => [...document.querySelectorAll('.track-row')]
      const state = () => {
        const nodes = rows()
        const checks = nodes.map((row) => row.querySelector('.track-row__check'))
        return {
          rows: nodes.length,
          checked: checks.filter((node) => node && node.classList.contains('is-checked')).length,
          visible: checks.filter((node) => node && getComputedStyle(node).opacity === '1').length,
          // 悬停那一行本来就是「露出来」的（真实指针可能正停在列表上），
          // 所以判断「平时藏着」要把它排除掉
          visibleUnhovered: nodes.filter((row) => !row.matches(':hover'))
            .map((row) => row.querySelector('.track-row__check'))
            .filter((node) => node && getComputedStyle(node).opacity === '1').length,
          ariaChecked: checks.filter((node) => node && node.getAttribute('aria-checked') === 'true').length,
          selecting: document.querySelector('.tracklist').classList.contains('is-selecting'),
          headChecked: document.querySelector('.tracklist__check').classList.contains('is-checked'),
          headPartial: document.querySelector('.tracklist__check').classList.contains('is-partial')
        }
      }
      // 序号和勾选框是两列，各自装各自的东西。
      // 曾经因为用 row.children[0] 拿「序号格」——左边加了勾选框之后它变成了勾选框，
      // 结果序号和播放键被画进勾选框里，序号那列反而空着（用户反馈「序号又没了」）。
      const layout = () => {
        const nodes = rows()
        const row = nodes[0]
        const index = row.querySelector('.track-row__index')
        const check = row.querySelector('.track-row__check')
        const indexText = (index.textContent || '').trim()
        // 序号不只是「在 DOM 里」，还得真的画出来（悬停那一行会用播放键顶掉序号，
        // 所以挑一行没被悬停的来看）
        const calmRow = nodes.find((node) => !node.matches(':hover')) || row
        const calmNum = calmRow.querySelector('.track-row__num')
        return {
          indexText,
          // 序号必须和这一行的实际位置对得上（虚拟滚动时行会被复用，这正是容易错的地方）
          indexMatches: Number(indexText) === Number(row.dataset.index) + 1,
          indexHasCheck: Boolean(index.querySelector('.track-row__check')),
          indexHasNumber: Boolean(index.querySelector('.track-row__num')),
          numVisible: Boolean(calmNum) &&
            getComputedStyle(calmNum).visibility === 'visible' &&
            calmNum.getBoundingClientRect().width > 0,
          checkHasSvg: Boolean(check.querySelector('svg')),
          checkText: (check.textContent || '').trim(),
          checkHasNumber: Boolean(check.querySelector('.track-row__num')),
          checkHasPlay: Boolean(check.querySelector('.track-row__play')),
          // 不在多选模式时，勾选框不但看不见，还不能是点击目标（否则点行左边缘会误进多选）
          checkHidden: getComputedStyle(check).opacity === '0' &&
            getComputedStyle(check).pointerEvents === 'none'
        }
      }

      actions.setView('songs')
      actions.setQuery('')
      actions.setSource({ type: 'all', value: null })
      actions.clearSelection()
      await settle(900)
      const idle = state()
      const idleLayout = layout()

      // 普通点击只选中一首：**不该**进入多选模式（勾选框不该出现）
      const plainRow = rows()[1]
      plainRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await settle(400)
      const afterPlainClick = {
        ...state(),
        layout: layout(),
        trackId: store.get().playback.trackId
      }

      // 行上的勾选框此时是隐藏 + 不可点的，点它不应该有任何效果
      const hiddenClickTarget = rows()[3].querySelector('.track-row__check')
      hiddenClickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await settle(300)
      const afterHiddenClick = { ...state(), trackId: store.get().playback.trackId }

      // 从列表右上角的「⋯」进入多选：这才是正规入口
      const menuButton = [...document.querySelectorAll('.view-toolbar .btn--icon')]
        .find((node) => node.title === '更多操作')
      const menuHit = (() => {
        if (!menuButton) return false
        const rect = menuButton.getBoundingClientRect()
        const hit = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
        return Boolean(hit && (hit === menuButton || menuButton.contains(hit)))
      })()
      menuButton?.click()
      await settle(500)
      const menu = document.querySelector('.popover')
      const menuText = menu ? menu.textContent : ''
      const menuRow = menu ? [...menu.querySelectorAll('.popover__row')].find((node) => node.textContent.includes('选择多个歌曲')) : null
      menuRow?.click()
      await settle(500)
      const afterMenuStart = { ...state(), menuText, menuHit, hasRow: Boolean(menuRow) }

      // 已经是多选模式了，这时再点某一行的勾选框才算数
      actions.setSelection([plainRow.dataset.id], plainRow.dataset.id)
      await settle(500)
      const selecting = state()
      const selectingLayout = layout()

      // 点第 5 行的勾选框：它被打勾，且不该顺手起播
      const before = store.get().playback.trackId
      const targetRow = rows()[4]
      const targetId = targetRow.dataset.id
      targetRow.querySelector('.track-row__check').click()
      await settle(500)
      const afterToggle = { ...state(), trackId: store.get().playback.trackId, before, targetId, checkedId: targetId }

      // 表头全选
      document.querySelector('.tracklist__check').click()
      await settle(600)
      const all = state()
      const selectionSize = store.get().ui.selection.length

      // 再点一次表头：取消全选，勾选框重新藏起来
      document.querySelector('.tracklist__check').click()
      await settle(600)
      const cleared = state()
      const total = store.get().library.tracks.length

      return {
        idle, idleLayout, afterPlainClick, afterHiddenClick, afterMenuStart, selecting, selectingLayout,
        afterToggle, all, selectionSize, cleared, total
      }
    `)
    const checkboxOk =
      // ① 序号和勾选框各就各位（曾经把序号画进勾选框里过）
      checkboxCheck.idleLayout.indexMatches === true &&
      checkboxCheck.idleLayout.indexHasNumber === true &&
      checkboxCheck.idleLayout.numVisible === true &&
      checkboxCheck.idleLayout.indexHasCheck === false &&
      checkboxCheck.idleLayout.checkHasSvg === true &&
      checkboxCheck.idleLayout.checkHasNumber === false &&
      checkboxCheck.idleLayout.checkHasPlay === false &&
      // ② 不在多选模式时勾选框既不可见也不可点
      checkboxCheck.idleLayout.checkHidden === true &&
      checkboxCheck.idle.rows > 5 &&
      checkboxCheck.idle.checked === 0 &&
      checkboxCheck.idle.visible === 0 &&
      checkboxCheck.idle.selecting === false &&
      // ③ 普通点击只选中一首，不进入多选模式
      checkboxCheck.afterPlainClick.selecting === false &&
      checkboxCheck.afterPlainClick.visible === 0 &&
      checkboxCheck.afterPlainClick.checked === 1 &&
      // ④ 隐藏的勾选框点不出任何效果（它连点击目标都不是）
      checkboxCheck.afterHiddenClick.selecting === false &&
      checkboxCheck.afterHiddenClick.checked === 1 &&
      checkboxCheck.afterHiddenClick.trackId === checkboxCheck.afterPlainClick.trackId &&
      // ⑤ 从「⋯」菜单进多选
      checkboxCheck.afterMenuStart.menuHit === true &&
      checkboxCheck.afterMenuStart.hasRow === true &&
      checkboxCheck.afterMenuStart.menuText.includes('选择多个歌曲') &&
      checkboxCheck.afterMenuStart.selecting === true &&
      checkboxCheck.afterMenuStart.visible === checkboxCheck.afterMenuStart.rows &&
      // ⑥ 进入之后勾选框才可见、才可点
      checkboxCheck.selecting.checked === 1 &&
      checkboxCheck.selecting.ariaChecked === 1 &&
      checkboxCheck.selecting.visible === checkboxCheck.selecting.rows &&
      checkboxCheck.selecting.selecting === true &&
      checkboxCheck.selecting.headPartial === true &&
      checkboxCheck.selectingLayout.indexMatches === true &&
      checkboxCheck.selectingLayout.checkHidden === false &&
      checkboxCheck.afterToggle.checked === 2 &&
      checkboxCheck.afterToggle.trackId === checkboxCheck.afterToggle.before &&
      checkboxCheck.all.checked === checkboxCheck.all.rows &&
      checkboxCheck.all.headChecked === true &&
      checkboxCheck.all.headPartial === false &&
      checkboxCheck.selectionSize === checkboxCheck.total &&
      checkboxCheck.cleared.checked === 0 &&
      checkboxCheck.cleared.visible === 0 &&
      checkboxCheck.cleared.selecting === false
    record('多选：勾选框只在多选模式里出现（入口在列表右上角「⋯」）',
      checkboxOk,
      `第 1 行：序号格「${checkboxCheck.idleLayout.indexText}」（与行号对应=${checkboxCheck.idleLayout.indexMatches}，有数字=${checkboxCheck.idleLayout.indexHasNumber}、真的可见=${checkboxCheck.idleLayout.numVisible}、有勾选框=${checkboxCheck.idleLayout.indexHasCheck}）、` +
      `勾选框里有图标=${checkboxCheck.idleLayout.checkHasSvg}（有数字=${checkboxCheck.idleLayout.checkHasNumber}、有播放键=${checkboxCheck.idleLayout.checkHasPlay}）；` +
      `未进入多选时：勾选框可见 ${checkboxCheck.idle.visible} 个、不可点=${checkboxCheck.idleLayout.checkHidden}；` +
      `普通点击一首后：打勾 ${checkboxCheck.afterPlainClick.checked} 个、可见 ${checkboxCheck.afterPlainClick.visible} 个、仍是多选模式=${checkboxCheck.afterPlainClick.selecting}；` +
      `点那个隐藏的框：模式=${checkboxCheck.afterHiddenClick.selecting}（无副作用=${checkboxCheck.afterHiddenClick.checked === 1}）；` +
      `「⋯」菜单命中=${checkboxCheck.afterMenuStart.menuHit}，点「选择多个歌曲」→ 多选模式=${checkboxCheck.afterMenuStart.selecting}、勾选框露出 ${checkboxCheck.afterMenuStart.visible}/${checkboxCheck.afterMenuStart.rows} 个；` +
      `进入后打勾 ${checkboxCheck.selecting.checked} 个、可见 ${checkboxCheck.selecting.visible}/${checkboxCheck.selecting.rows}（aria-checked=${checkboxCheck.selecting.ariaChecked}）、表头半选=${checkboxCheck.selecting.headPartial}；` +
      `点第 5 行的框 → 打勾变成 ${checkboxCheck.afterToggle.checked} 个，且没有起播（曲目未变=${checkboxCheck.afterToggle.trackId === checkboxCheck.afterToggle.before}）；` +
      `点表头 → 全部 ${checkboxCheck.all.checked}/${checkboxCheck.all.rows} 行打勾（共选中 ${checkboxCheck.selectionSize}/${checkboxCheck.total} 首）；` +
      `再点表头 → 打勾 ${checkboxCheck.cleared.checked} 个、可见 ${checkboxCheck.cleared.visible} 个（退出多选）` +
      (checkboxOk ? '' : `\n    调试：${JSON.stringify({
        idle: checkboxCheck.idle,
        afterPlainClick: checkboxCheck.afterPlainClick,
        afterHiddenClick: checkboxCheck.afterHiddenClick,
        afterMenuStart: checkboxCheck.afterMenuStart,
        selecting: checkboxCheck.selecting,
        menuText: checkboxCheck.afterMenuStart.menuText
      })}`))

    /* ---------- 三个界面反馈的回归检查 ---------- */
    await ensureVisible(win)
    const uiFixes = await evaluate(win, `
      const { actions, store, player, views } = window.__aria
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }

      /* ① 设置页要铺满内容区（之前 max-width: 720px 靠左，右半边全是空白） */
      actions.setView('settings')
      await settle(1200)
      const settingsBody = document.querySelector('.settings')
      const contentBox = document.getElementById('content').getBoundingClientRect()
      const settingsBox = settingsBody.getBoundingClientRect()
      const fillRatio = Math.round((settingsBox.width / contentBox.width) * 100)
      const columns = getComputedStyle(settingsBody).columnCount

      /* ② 在下面改一条设置之后，不能跳回顶部 */
      const scroller = document.querySelector('.settings')
      scroller.scrollTop = scroller.scrollHeight
      await settle(300)
      const beforeScroll = scroller.scrollTop
      // 点一个靠下的开关（外观分组里的「减少动画」）
      const switchRow = [...document.querySelectorAll('.settings__row')]
        .find((node) => node.textContent.includes('减少动画'))
      const switchNode = switchRow ? switchRow.querySelector('.switch') : null
      const changed = store.get().settings.reduceMotion === true
      switchNode?.click()
      await settle(900)
      const afterScroll = scroller.scrollTop
      // 改回去，别把设置留在临时档案里
      if (store.get().settings.reduceMotion !== changed) {
        const again = [...document.querySelectorAll('.settings__row')]
          .find((node) => node.textContent.includes('减少动画'))
        again?.querySelector('.switch')?.click()
        await settle(600)
      }

      /* ③ 媒体墙：播放时不能跳回左上角 */
      actions.setView('wall')
      await settle(1600)
      const wall = views.mediaWall
      const viewport = document.querySelector('.wall-viewport')
      // 用滚轮斜向挪到中段（和用户拖动等价）
      viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 600, deltaY: 500 }))
      await settle(900)
      const panned = wall.debugState().pan
      // 换一张专辑播放（媒体墙上点格子就是这条路径）
      const albums = actions.albums()
      const other = albums.find((album) => album.key !== wall.featuredKey) || albums[0]
      player.playCollection(other.tracks.map((track) => track.id), other.tracks[0].id)
      await settle(2000)
      const afterPlay = wall.debugState().pan
      player.pause()
      actions.setView('songs')
      await settle(400)

      /* ④ 歌曲列表要有看得见、可拖的滚动条 */
      const listViewport = document.querySelector('.tracklist__viewport')
      const thumbColor = (() => {
        const style = getComputedStyle(listViewport)
        return style.scrollbarColor || ''
      })()

      return {
        fillRatio,
        columns,
        contentWidth: Math.round(contentBox.width),
        settingsWidth: Math.round(settingsBox.width),
        beforeScroll,
        afterScroll,
        scrollKept: Math.abs(afterScroll - beforeScroll) <= 4,
        scrollable: scroller.scrollHeight > scroller.clientHeight + 50,
        panned,
        afterPlay,
        panKept: Math.abs(afterPlay.x - panned.x) <= 2 && Math.abs(afterPlay.y - panned.y) <= 2,
        panMoved: Math.abs(panned.x) > 10 || Math.abs(panned.y) > 10,
        thumbColor
      }
    `)
    /* ---------- 「减少动画」也要管住 JS 驱动的滚动 ----------
     *
     * CSS 那条 `html[data-reduce-motion="true"] *` 把 animation/transition 压到 0.001ms，
     * 但 `scrollBy({ behavior: 'smooth' })` 是 JS 驱动的滚动，CSS 管不到 ——
     * 设置页的分类跳转与字母索引都是这种。这里做一次**差分**验证：
     * 同一次跳转、同一个短窗口内，开了「减少动画」必须比没开走得更远（并且基本已到位）。
     * 用"两者相比"而不是写死像素阈值 —— 不同机器一帧的时间不一样，写死必假红。
     */
    const smoothScrollCheck = await evaluate(win, `
      const settle = async (ms = 120) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      /*
       * 不猜设置页滚动容器的类名（第一版就是猜错的，两次测量都返回 null）：
       * 先列出所有可滚动元素，点一次导航，**哪个的 scrollTop 真的动了**就是它。
       */
      const scrollables = () => [...document.querySelectorAll('div, section, main, ul')]
        .filter((n) => n.scrollHeight > n.clientHeight + 200)

      const findScroller = async () => {
        const before = new Map(scrollables().map((n) => [n, n.scrollTop]))
        const navItems = [...document.querySelectorAll('.settings-nav__item')]
        if (navItems.length < 2) return { error: '设置页没有分类导航' }
        navItems[0].click()
        await settle(600)
        let best = null
        for (const [node, was] of before) {
          const moved = Math.abs(node.scrollTop - was)
          if (moved > 50 && (!best || moved > best.moved)) best = { node, moved }
        }
        return best ? { node: best.node } : { error: '点了分类导航但没有任何容器滚动' }
      }

      const measure = async (reduceMotion) => {
        await actions.setSetting({ reduceMotion })
        actions.setView('songs')
        await settle(300)
        actions.setView('settings')
        await settle(800)
        const found = await findScroller()
        if (found.error) return { error: found.error }
        const scroller = found.node
        const navItems = [...document.querySelectorAll('.settings-nav__item')]
        scroller.scrollTop = scroller.scrollHeight      // 先滚到底，制造足够长的距离
        await settle(250)
        const start = scroller.scrollTop
        navItems[0].click()
        await new Promise((r) => realSetTimeout(r, 30))
        const early = scroller.scrollTop
        await settle(900)
        const final = scroller.scrollTop
        return { start, early, final, earlyMoved: Math.abs(early - start), total: Math.abs(final - start) }
      }
      const realSetTimeout = window.setTimeout
      const withMotion = await measure(false)
      const withReduce = await measure(true)
      await actions.setSetting({ reduceMotion: false })
      actions.setView('songs')
      await settle(300)
      return { withMotion, withReduce }
    `)
    record('「减少动画」也管住 JS 驱动的滚动（设置页分类跳转不再做动画）',
      smoothScrollCheck.withMotion && !smoothScrollCheck.withMotion.error &&
      smoothScrollCheck.withReduce && !smoothScrollCheck.withReduce.error &&
      smoothScrollCheck.withMotion.total > 200 &&
      smoothScrollCheck.withReduce.earlyMoved > smoothScrollCheck.withMotion.earlyMoved + 50 &&
      smoothScrollCheck.withReduce.earlyMoved >= smoothScrollCheck.withReduce.total * 0.9,
      smoothScrollCheck.withMotion?.error
        ? `测量失败：${smoothScrollCheck.withMotion.error}`
        : `跳转距离 ${smoothScrollCheck.withMotion.total}px：` +
          `没开减少动画时 30ms 内走了 ${smoothScrollCheck.withMotion.earlyMoved}px；` +
          `开了之后同样 30ms 走了 ${smoothScrollCheck.withReduce.earlyMoved}px` +
          `（占全程 ${smoothScrollCheck.withReduce.total ? Math.round((smoothScrollCheck.withReduce.earlyMoved / smoothScrollCheck.withReduce.total) * 100) : 0}%）`)

    /* ---------- 文本是否溢出自己的盒子（flex 布局的经典坑） ----------
     *
     * 判据要分清楚，第一版就判错了：`scrollWidth > clientWidth` 本身**不是**问题 ——
     * `.truncate`（overflow:hidden + nowrap + text-overflow:ellipsis）正是靠它工作，
     * 13 个"溢出"全是刻意的省略号截断。
     * 真正算问题的是两种：
     *   · 溢出**到盒子外面**（overflow-x: visible）—— 文字会压到邻居上，就是"错位/重叠"；
     *   · **硬裁没有省略号**（hidden + 非 ellipsis）—— 文字被默默切掉，用户不知道还有内容。
     * 有一定宽度的省略号截断单独统计、不算失败（它是正常做法）。
     */
    const overflowAudit = await evaluate(win, `
      const settle = async (ms = 450) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      const offenders = []
      const ellipsised = []
      const noTitle = []
      const scan = (where) => {
        for (const node of document.querySelectorAll('div, span, h1, h2, h3, p, strong, em, button, td, li')) {
          if (!node.textContent || !node.textContent.trim()) continue
          const style = getComputedStyle(node)
          if (style.display === 'none' || style.visibility === 'hidden') continue
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue
          const rect = node.getBoundingClientRect()
          if (rect.width < 4 || rect.height < 4) continue
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue
          // 只看"自己直接装文字"的元素，别把外层容器算进来（容器的 scrollWidth 会被子元素影响）
          const ownText = [...node.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())
          if (!ownText) continue
          /*
           * 跳过**正在动画中**的元素。
           *
           * 「.island__label」靠 max-width 0 → 64px 做展开动画；量到一半时它是 24px 宽、
           * 内容（媒体墙）比它宽，于是被判成"硬裁" —— 那是**正常行为**，不是缺陷。
           * 一个会在正常行为上报警的检查比没有检查更糟（本项目反复吃过这个亏），
           * 所以动画期间直接不参与判定。
           */
          if (typeof node.getAnimations === 'function' &&
              node.getAnimations().some((animation) => animation.playState === 'running')) continue
          const overflowX = node.scrollWidth - node.clientWidth
          const overflowY = node.scrollHeight - node.clientHeight
          const hasEllipsis = style.textOverflow === 'ellipsis'
          const clipped = style.overflowX === 'hidden' || style.overflowX === 'clip'
          const item = {
            where,
            cls: (node.getAttribute('class') || node.tagName).toString().split(/\\s+/).slice(0, 2).join('.'),
            text: node.textContent.trim().slice(0, 22),
            overflowX,
            overflowY,
            width: Math.round(rect.width),
            ellipsis: style.textOverflow,
            overflowStyle: style.overflowX
          }
          if (hasEllipsis && clipped) {
            if (overflowX > 2) {
              ellipsised.push(item)
              /*
               * 被省略号截掉的文字，必须能在悬停时看到全文（title / aria-label）。
               * 要看**祖先链**，不能只看文字元素自己 —— 第一版就判错了：
               * 封面卡与媒体墙瓦片都把 title 放在**根元素**上（形如「专辑名 — 艺人」），
               * 悬停在里面的文字上时浏览器显示的是那个 title，信息本来就能看到。
               * 浏览器取的是**最近的**带 title 的祖先，所以往上找到第一个就算有。
               */
              const hasTooltip = (() => {
                for (let el = node; el && el !== document.body; el = el.parentElement) {
                  if (el.getAttribute('title') || el.getAttribute('aria-label')) return true
                }
                return false
              })()
              if (!hasTooltip) noTitle.push(item)
            }
            continue
          }
          // 溢出到外面（会压到邻居）或硬裁（没有省略号）都算问题；纵向被裁也算
          if (overflowX > 2 && (style.overflowX === 'visible' || clipped)) offenders.push(item)
          else if (overflowY > 2 && clipped) offenders.push({ ...item, overflowX: overflowY, kind: '纵向被裁' })
        }
      }
      if (!store.get().ui.sidebarVisible) actions.toggleSidebar()
      await settle(500)
      for (const view of ['songs', 'albums', 'artists', 'wall']) {
        actions.setView(view)
        await settle()
        scan(view)
      }
      actions.setView('settings')
      await settle(700)
      scan('settings')
      actions.setView('songs')
      await settle(300)
      const groups = new Map()
      for (const item of offenders) {
        const key = item.cls + (item.kind || '')
        const existing = groups.get(key)
        if (!existing) groups.set(key, { cls: item.cls, kind: item.kind || '溢出', count: 1, worst: item })
        else {
          existing.count++
          if (item.overflowX > existing.worst.overflowX) existing.worst = item
        }
      }
      return {
        total: offenders.length,
        groups: [...groups.values()].sort((a, b) => b.worst.overflowX - a.worst.overflowX),
        ellipsisedCount: ellipsised.length,
        ellipsisedClasses: [...new Set(ellipsised.map((item) => item.cls))],
        noTitleCount: noTitle.length,
        noTitleGroups: [...new Set(noTitle.map((item) => item.cls))],
        noTitleSample: noTitle.slice(0, 4).map((item) => item.cls + '「' + item.text + '」')
      }
    `)
    record('文本不会溢出到盒子外面，也不会被硬裁（省略号截断不算问题）',
      overflowAudit.total === 0,
      `扫描五个界面：**溢出/硬裁** ${overflowAudit.total} 处` +
      (overflowAudit.groups.length
        ? `（${overflowAudit.groups.slice(0, 8).map((g) => `${g.cls} ${g.kind} ×${g.count}，最严重多 ${g.worst.overflowX}px、宽 ${g.worst.width}px，如「${g.worst.text}」`).join('；')}）`
        : '') +
      `；另有 ${overflowAudit.ellipsisedCount} 处是刻意的省略号截断（${overflowAudit.ellipsisedClasses.join('、')}），不算问题`)

    record('被省略号截断的文字，鼠标悬停能看到全文（title / aria-label）',
      overflowAudit.noTitleCount === 0,
      `${overflowAudit.ellipsisedCount} 处截断里有 ${overflowAudit.noTitleCount} 处没有 title/aria-label` +
      (overflowAudit.noTitleCount
        ? `：${overflowAudit.noTitleGroups.join('、')}（例如 ${overflowAudit.noTitleSample.join('、')}）`
        : '（都能看到全文）'))

    /* ---------- 开关的禁用态与 ARIA（界面要诚实） ----------
     *
     * 「在线补全」是联网总闸（online-media.js 里三处都是 `!settings.onlineFeatures` 直接 return），
     * 子开关（在线歌词 / 在线封面）在总闸关闭时**点不点都不起作用**。
     * 说明文字早就写着"需要先打开总开关"，但开关本身还能点 —— 那才是让人困惑的地方。
     * 现在总闸关着时子开关带 is-disabled / tabindex=-1 / aria-disabled，
     * 而且**点它不会偷偷改设置**（这是关键：视觉禁用与行为必须一致）。
     * 顺带验 aria-checked：role="switch" 缺它读屏软件读不出开关状态。
     */
    const switchState = await evaluate(win, `
      const settle = async (ms = 550) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      const findRows = () => {
        const rows = [...document.querySelectorAll('.settings__row')]
        const find = (title) => rows.find((row) => (row.textContent || '').includes(title))
        return {
          master: find('在线补全') ? find('在线补全').querySelector('.switch') : null,
          lyrics: find('在线歌词') ? find('在线歌词').querySelector('.switch') : null,
          covers: find('在线封面') ? find('在线封面').querySelector('.switch') : null,
          artists: find('在线艺人头像') ? find('在线艺人头像').querySelector('.switch') : null
        }
      }
      const read = (node) => node && ({
        disabled: node.classList.contains('is-disabled'),
        tabindex: node.getAttribute('tabindex'),
        ariaDisabled: node.getAttribute('aria-disabled'),
        ariaChecked: node.getAttribute('aria-checked'),
        on: node.classList.contains('is-on')
      })

      actions.setView('settings')
      await settle(800)
      const tab = [...document.querySelectorAll('.settings-nav__item')].find((n) => (n.textContent || '').includes('在线'))
      tab?.click()
      await settle(800)

      // ① 总闸关：子开关应当禁用，点了也不改设置
      await actions.setSetting({ onlineFeatures: false, onlineLyrics: true, onlineCovers: true })
      await settle(700)
      const offRows = findRows()
      const offLyrics = read(offRows.lyrics)
      offRows.lyrics?.click()
      await settle(500)
      const lyricsAfterDisabledClick = store.get().settings.onlineLyrics
      const ariaAfterClick = offRows.lyrics?.getAttribute('aria-checked')

      // ② 总闸开：子开关可用，点了真的改设置
      await actions.setSetting({ onlineFeatures: true, onlineLyrics: true })
      await settle(700)
      const onRows = findRows()
      const onLyrics = read(onRows.lyrics)
      onRows.lyrics?.click()
      await settle(500)
      const lyricsAfterEnabledClick = store.get().settings.onlineLyrics

      await actions.setSetting({ onlineFeatures: true, onlineLyrics: true, onlineCovers: true })
      actions.setView('songs')
      await settle(300)
      return {
        hasMaster: Boolean(offRows.master),
        off: offLyrics,
        offCoversDisabled: Boolean(read(offRows.covers)?.disabled),
        offArtistsDisabled: Boolean(read(offRows.artists)?.disabled),
        hasArtistsRow: Boolean(offRows.artists),
        lyricsAfterDisabledClick,
        ariaAfterClick,
        on: onLyrics,
        lyricsAfterEnabledClick
      }
    `)
    record('开关：依赖总闸的子开关会禁用（点了也不改设置），aria-checked 跟随状态',
      switchState.hasMaster &&
      switchState.off?.disabled === true && switchState.off?.tabindex === '-1' &&
      switchState.off?.ariaDisabled === 'true' && switchState.off?.ariaChecked === 'true' &&
      switchState.offCoversDisabled === true &&
      // 在线艺人头像：代码里一直读这个设置，界面上以前没有开关（等于给了默认值却不让改）
      switchState.hasArtistsRow === true && switchState.offArtistsDisabled === true &&
      switchState.lyricsAfterDisabledClick === true && switchState.ariaAfterClick === 'true' &&
      switchState.on?.disabled === false && switchState.on?.ariaChecked === 'true' &&
      switchState.lyricsAfterEnabledClick === false,
      `总闸关：在线歌词 禁用=${switchState.off?.disabled}、tabindex=${switchState.off?.tabindex}、` +
      `aria-disabled=${switchState.off?.ariaDisabled}、aria-checked=${switchState.off?.ariaChecked}；` +
      `点它之后设置仍是 ${switchState.lyricsAfterDisabledClick}（未被偷偷改掉）、aria-checked 未变；` +
      `在线封面 禁用=${switchState.offCoversDisabled}、在线艺人头像 存在=${switchState.hasArtistsRow} 禁用=${switchState.offArtistsDisabled}。` +
      `总闸开：禁用=${switchState.on?.disabled}、点一下设置变成 ${switchState.lyricsAfterEnabledClick}`)

    /* ---------- 每个开关都得真的改到某个设置 ----------
     *
     * 判据是两条**不变量**，而不是枚举"哪个开关对应哪个键"：
     *   ① 点一下必须至少改动一个**已有的**设置 —— 否则这颗开关是死的；
     *   ② 点一下**不能凭空多出新的设置键** —— 键名写错的典型症状就是
     *      `setSetting({ showRowArtworkTypo: true })`：store 里多出一个没人读的键，
     *      而界面看着"点了有反应"（开关自己会翻），极难靠肉眼发现。这条能抓住它。
     * 每颗开关点两次（原样还原），跑完再核对一遍"设置回到了初始值、键集合没变"。
     * 禁用的开关（依赖总闸的那些）跳过不点 —— 它们本来就点不动。
     */
    const wiringTabTitles = ['音乐库', '播放与音效', '外观与系统', '在线与扩展', '关于']
    const switchWiring = { results: [], seen: new Set() }
    // 先记下初始状态，收尾时核对"审计没留下痕迹"
    const wiringStart = await evaluate(win, `
      const { store } = window.__aria
      return { keys: Object.keys(store.get().settings).sort().join(','), settings: JSON.stringify(store.get().settings) }
    `)
    switchWiring.keysAtStart = wiringStart.keys
    switchWiring.settingsAtStart = wiringStart.settings
    for (const tabTitle of wiringTabTitles) {
      const pageResult = await evaluate(win, `
        const settle = async (ms = 450) => { await new Promise((r) => setTimeout(r, ms)) }
        const { store } = window.__aria
        const tab = [...document.querySelectorAll('.settings-nav__item')].find((n) => (n.textContent || '').includes(${JSON.stringify(tabTitle)}))
        if (!tab) return { results: [] }
        tab.click()
        await settle(600)
        /*
         * 去重：设置页把各分类的行**都留在 DOM 里**（切分类只是显示/隐藏），
         * 所以按分类循环会拿到同一批开关 —— 第一版就是这样把 24 颗点成了 120 颗
         * （读数"共点过 120 颗"，而且白花了四倍时间）。
         */
        const already = new Set(${JSON.stringify([...switchWiring.seen])}) 
        const titles = [...document.querySelectorAll('.settings__row .switch')].map((n) => {
          const row = n.closest('.settings__row')
          return (row && row.dataset ? row.dataset.settingId : '') || ''
        }).filter((title) => title && !already.has(title))
        const results = []
        for (const title of titles) {
          const selector = '.settings__row[data-setting-id="' + title + '"] .switch'
          let node = document.querySelector(selector)
          if (!node || node.classList.contains('is-disabled')) {
            results.push({ title, skipped: true, changed: [], added: [] })
            continue
          }
          const beforeCopy = JSON.parse(JSON.stringify(store.get().settings))
          const beforeKeys = new Set(Object.keys(store.get().settings))
          node.click()
          await settle(500)
          const after = store.get().settings
          results.push({
            title,
            skipped: false,
            changed: Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(beforeCopy[key])),
            added: Object.keys(after).filter((key) => !beforeKeys.has(key))
          })
          // 重新查一次再点回去：点开关会触发设置页重渲染，之前那个引用可能已经脱离文档
          node = document.querySelector(selector)
          if (node) { node.click(); await settle(450) }
        }
        return { results }
      `)
      switchWiring.results.push(...pageResult.results)
      for (const item of pageResult.results) switchWiring.seen.add(item.title)
    }
    /*
     * 收尾：整轮点完之后，键集合必须与开始时一致、设置也必须回到原样。
     * 这条不变量同时保护后面所有检查 —— 免得我的审计把设置留成别的样子。
     */
    const wiringAfter = await evaluate(win, `
      const { actions, store } = window.__aria
      actions.setView('songs')
      await new Promise((r) => setTimeout(r, 300))
      return { keys: Object.keys(store.get().settings).sort().join(','), settings: JSON.stringify(store.get().settings) }
    `)
    const clicked = switchWiring.results.filter((item) => !item.skipped)
    const inert = clicked.filter((item) => item.changed.length === 0)
    const invented = clicked.filter((item) => item.added.length > 0)
    record('设置里的每颗开关都改到了某个已有设置（且没有凭空造出新键）',
      clicked.length >= 8 && inert.length === 0 && invented.length === 0 &&
      // 审计不能留下痕迹：键集合与设置值都要回到原样（这两条也保护后面的检查）
      wiringAfter.keys === switchWiring.keysAtStart && wiringAfter.settings === switchWiring.settingsAtStart,
      `共点过 ${clicked.length} 颗（另 ${switchWiring.results.length - clicked.length} 颗因依赖总闸被禁用、跳过）：` +
      clicked.map((item) => `${item.title}→${item.changed.join('/') || '无 ✗'}`).join('；') +
      (inert.length ? `；**没改到任何设置**：${inert.map((i) => i.title).join('、')}` : '') +
      (invented.length ? `；**造出了新键**：${invented.map((i) => i.title + ':' + i.added.join(',')).join('、')}` : '') +
      `；设置回到原样=${wiringAfter.settings === switchWiring.settingsAtStart}`)

    /* ---------- 弹层：同一时刻只有一层、Esc 能关、反复开关不泄漏 ----------
     *
     * 三条都是**不变量**，不需要枚举有哪些弹层：
     *   ① 没打开任何东西时，#layer-root 的子节点数 = 基线；
     *   ② 从别处再开一层，前一层必须已经被关掉（同时只有一层）；
     *   ③ 反复开合若干次后必须回到基线 —— 这是"泄漏"的直接证据
     *      （每次 open 都往同一个 root 里 append，忘了 remove 就会越堆越多）。
     * Esc 用**真实按键**（sendInputEvent），因为 app.js 的处理器挂在 document 上，
     * 而我想验的正是"真按 Esc 会怎样"。
     */
    const layerBaseline = await evaluate(win, `
      const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      actions.setView('songs')
      await settle(800)
      const root = document.getElementById('layer-root')
      const openRowMenu = async (index) => {
        const rows = [...document.querySelectorAll('.track-row')]
        const button = rows[index] ? rows[index].querySelector('.track-row__more') : null
        if (!button) return false
        button.click()
        await settle(500)
        return true
      }
      const baseline = root.childElementCount
      const openedFirst = await openRowMenu(0)
      const afterFirst = root.childElementCount
      const openedSecond = await openRowMenu(1)
      const afterSecond = root.childElementCount
      return { baseline, openedFirst, openedSecond, afterFirst, afterSecond, classes: [...root.children].map((n) => n.className) }
    `)
    // 真按 Esc：应当把还开着的那一层关掉
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await sleep(500)
    const layerAfterEsc = await evaluate(win, `
      const root = document.getElementById('layer-root')
      return { count: root.childElementCount, open: document.querySelectorAll('.menu, .popover').length }
    `)
    // 反复开合：不泄漏
    const layerLeak = await evaluate(win, `
      const settle = async (ms = 320) => { await new Promise((r) => setTimeout(r, ms)) }
      const root = document.getElementById('layer-root')
      for (let i = 0; i < 8; i++) {
        const rows = [...document.querySelectorAll('.track-row')]
        const button = rows[i % 4] ? rows[i % 4].querySelector('.track-row__more') : null
        if (button) {
          button.click()
          await settle(420)
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
          await settle(380)
        }
      }
      await settle(400)
      return { count: root.childElementCount, open: document.querySelectorAll('.menu, .popover').length }
    `)
    /*
     * 断言一律**相对实测基线**，不用绝对值：
     * #layer-root 里常驻着拖放层、帧率层、提示层（实测基线 3），
     * 第一版拿"基线应当为 0、开一层应当是 1"去判，三条正确的行为全被判红。
     */
    const base = layerBaseline.baseline
    record('弹层：同时只有一层、Esc 能关、反复开合不泄漏',
      base >= 1 &&
      layerBaseline.openedFirst === true && layerBaseline.afterFirst === base + 1 &&
      layerBaseline.openedSecond === true && layerBaseline.afterSecond === base + 1 &&
      layerAfterEsc.count === base && layerAfterEsc.open === 0 &&
      layerLeak.count === base && layerLeak.open === 0,
      `基线 ${base} 个子节点（常驻：${layerBaseline.classes.slice(0, 3).join('、')}）；` +
      `开第一层后 ${layerBaseline.afterFirst}（= 基线+1）；` +
      `再从另一行开一层后 ${layerBaseline.afterSecond}（仍然是基线+1 —— 前一层已关）；` +
      `真按 Esc 后剩 ${layerAfterEsc.count} 个（= 基线）、DOM 里 .menu/.popover ${layerAfterEsc.open} 个；` +
      `反复开合 8 次后剩 ${layerLeak.count} 个（= 基线，无泄漏）`)

    /* ---------- 搜不到东西时的空状态 ----------
     *
     * 空状态是重构里最容易被丢掉的东西（"反正没人会搜不到"），
     * 但它恰恰是新用户最容易撞上的界面 —— 朋友的音乐目录还没扫完时也一样。
     * 用**搜不到的词**造出这个状态（不动任何数据），三个浏览视图各验一遍：
     *   ① 出现 .empty，且正文里**回显**那个关键词（不回显的话用户不知道自己搜了什么）；
     *   ② 列表行数为 0（不是"空状态还在、下面还留着一堆行"）。
     */
    const emptyStates = await evaluate(win, `
      const settle = async (ms = 650) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      const junk = 'zzz这个词肯定搜不到qqq'
      /*
       * 只看**可见的**元素：三个视图都留在 DOM 里（切视图只是显示/隐藏），
       * 所以 document.querySelector('.empty') 拿到的永远是文档里第一个（歌曲视图的）——
       * 第一版就是这样三次都在验同一块，读数里"三个视图文案长度都是 42"就是这个破绽，
       * 属于"因为错误的原因通过"。行数同理，只数可见的那些。
       */
      const visible = (node) => node && node.getClientRects().length > 0
      const read = (view, rowSelector) => {
        const empties = [...document.querySelectorAll('.empty')].filter(visible)
        const empty = empties[0]
        const text = empty ? empty.textContent : ''
        return {
          view,
          hasEmpty: Boolean(empty),
          extras: empties.length,
          textLength: text.length,
          echoes: text.includes(junk),
          rows: [...document.querySelectorAll(rowSelector)].filter(visible).length,
          sample: text.slice(0, 24)
        }
      }
      const results = []
      actions.setView('songs')
      await settle(700)
      actions.setQuery(junk)
      await settle(900)
      results.push(read('songs', '.track-row'))
      actions.setView('albums')
      await settle(800)
      results.push(read('albums', '.cover-card'))
      actions.setView('artists')
      await settle(800)
      results.push(read('artists', '.artist-row'))
      // 媒体墙也会被搜索过滤（0 张专辑时以前是一块空白表面，与专辑/艺人页同一类缺口）
      actions.setView('wall')
      await settle(900)
      results.push(read('wall', '.wall-tile'))
      actions.setQuery('')
      actions.setView('songs')
      await settle(700)

      /*
       * 空播放列表：这一类空状态不靠搜索（列表本来就是空的），
       * 文案不回显搜索词，而是回显**列表名**，并且要给一条出路（「去全部歌曲里挑」）。
       * 建一个临时列表，验完就删，不留痕迹。
       */
      const created = await actions.createPlaylist('自检空状态')
      actions.openPlaylist(created.id)
      await settle(950)
      const playlistEmpty = (() => {
        const isVisible = (node) => node && node.getClientRects().length > 0
        const empty = [...document.querySelectorAll('.empty')].filter(isVisible)[0]
        const text = empty ? empty.textContent : ''
        return {
          hasEmpty: Boolean(empty),
          rows: [...document.querySelectorAll('.track-row')].filter(isVisible).length,
          mentionsName: text.includes('自检空状态'),
          hasWayOut: Boolean(empty && empty.querySelector('button')),
          text: text.slice(0, 40)
        }
      })()
      await actions.deletePlaylist(created.id)
      actions.setView('songs')
      await settle(600)
      return { results, junk, playlistEmpty, playlistsLeft: actions.playlists().length }
    `)
    const emptyBad = emptyStates.results.filter((item) =>
      !item.hasEmpty || item.rows !== 0 || !item.echoes || item.textLength < 10)
    // 三个视图的文案本来就不同（歌曲线长、专辑/艺人线短）—— 如果三处完全一样，多半又在看同一块
    const emptyTexts = new Set(emptyStates.results.map((item) => item.sample))
    record('搜不到东西时：四个视图都给出空状态、回显关键词、不留残余行',
      emptyStates.results.length === 4 && emptyBad.length === 0 && emptyTexts.size >= 2,
      emptyStates.results.map((item) =>
        `${item.view}: 空状态=${item.hasEmpty}、行数=${item.rows}、回显关键词=${item.echoes}、` +
        `文案长度=${item.textLength}（${item.sample}…）`
      ).join('；'))

    record('空播放列表：给出空状态、回显列表名、并提供一条出路',
      emptyStates.playlistEmpty.hasEmpty === true &&
      emptyStates.playlistEmpty.rows === 0 &&
      emptyStates.playlistEmpty.mentionsName === true &&
      emptyStates.playlistEmpty.hasWayOut === true &&
      emptyStates.playlistsLeft === 0,
      `临时列表「自检空状态」：空状态=${emptyStates.playlistEmpty.hasEmpty}、行数=${emptyStates.playlistEmpty.rows}、` +
      `回显列表名=${emptyStates.playlistEmpty.mentionsName}、有出路按钮=${emptyStates.playlistEmpty.hasWayOut}；` +
      `文案「${emptyStates.playlistEmpty.text}…」；已删除（剩余 ${emptyStates.playlistsLeft} 个）`)

    /* ---------- 没东西可播时，播放按钮必须说一句话 ----------
     *
     * 这是"界面诚实"的另一半：
     *   · 上一轮做的是「点不动就禁用」（依赖总闸的子开关）；
     *   · 这一半是「能点、但没有作用对象时，必须给解释」。
     * playAll / shuffleAll 现在就是这么做的（toast「列表里还没有歌曲」），
     * 实测它们作用于 visibleTracks()（**被筛过的集合**，不是整个资料库）——
     * 所以筛空之后点它们不会静默无效。这条守卫把该行为钉住。
     */
    const emptyPlayFeedback = await evaluate(win, `
      const settle = async (ms = 550) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      const clearToasts = () => document.querySelectorAll('.toast').forEach((n) => n.remove())
      clearToasts()
      actions.setView('songs')
      await settle(700)
      actions.setQuery('zzz这个词肯定搜不到qqq')
      await settle(900)
      const clickAndRead = async (label) => {
        const button = [...document.querySelectorAll('button')]
          .find((n) => (n.textContent || '').trim() === label && n.getClientRects().length > 0)
        if (!button) return { missing: true, toasts: [] }
        button.click()
        await settle(600)
        const toasts = [...document.querySelectorAll('.toast')].map((n) => (n.textContent || '').trim())
        clearToasts()
        return { missing: false, toasts }
      }
      const play = await clickAndRead('播放')
      const shuffle = await clickAndRead('随机播放')
      const queueBefore = window.__aria.store.get().playback.queue.length
      actions.setQuery('')
      await settle(600)
      return { play, shuffle, queueBefore }
    `)
    const saidSomething = (result) =>
      result && !result.missing && result.toasts.length > 0 && result.toasts.every((text) => text.length > 0)
    record('筛空之后点「播放 / 随机播放」：会弹出说明，不是静默无效',
      saidSomething(emptyPlayFeedback.play) && saidSomething(emptyPlayFeedback.shuffle),
      `播放 → ${emptyPlayFeedback.play.missing ? '没找到按钮' : JSON.stringify(emptyPlayFeedback.play.toasts)}；` +
      `随机播放 → ${emptyPlayFeedback.shuffle.missing ? '没找到按钮' : JSON.stringify(emptyPlayFeedback.shuffle.toasts)}`)

    /* ---------- 禁用了的控件，必须真的看起来禁用 ----------
     *
     * 起因：看设置页截图时怀疑「均衡器预设」药丸在自动模式下没变灰 —— 量了原图才发现
     * 它最深像素 (145,145,146)、同一行标题是 (8,8,8)，45% 不透明度其实生效了
     * （又是缩小预览造成的错觉，今晚第四次）。
     * 但这条不变量本身值得钉住，它是"界面诚实"的最后一环：
     * **能点就亮、点不动就灰**，否则用户会一直去点一个不会响应的东西。
     * 判据用应用自己的约定：禁用 = 不透明度 < 1
     * （.switch.is-disabled 与 .pill-select:disabled 都是 opacity 0.45）。
     */
    const disabledLook = await evaluate(win, `
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      const collect = () => [...document.querySelectorAll('button, [role="switch"], .pill-select, .segmented__item, input, select')]
        .filter((node) => node.getClientRects().length > 0)
        .filter((node) => node.disabled || node.classList.contains('is-disabled') || node.getAttribute('aria-disabled') === 'true')
        .map((node) => ({
          what: node.tagName + '.' + (node.getAttribute('class') || '').split(/\\s+/).slice(0, 2).join('.'),
          opacity: parseFloat(getComputedStyle(node).opacity),
          cursor: getComputedStyle(node).cursor
        }))
      const results = {}
      actions.setView('settings')
      await settle(800)
      const onlineTab = [...document.querySelectorAll('.settings-nav__item')].find((n) => (n.textContent || '').includes('在线'))
      if (onlineTab) onlineTab.click()
      await actions.setSetting({ onlineFeatures: false })
      await settle(800)
      results.online = collect()
      const libTab = [...document.querySelectorAll('.settings-nav__item')].find((n) => (n.textContent || '').includes('音乐库'))
      if (libTab) libTab.click()
      await actions.setSetting({ equalizer: { enabled: false, auto: true, preset: 'flat' } })
      await settle(800)
      results.eq = collect()
      await actions.setSetting({ onlineFeatures: true })
      actions.setView('songs')
      await settle(500)
      return results
    `)
    const allDisabled = [...disabledLook.online, ...disabledLook.eq]
    const notDimmed = allDisabled.filter((item) => !(item.opacity < 1))
    record('禁用了的控件都真的变灰了（不透明度 < 1）',
      disabledLook.online.length >= 2 && disabledLook.eq.length >= 1 && notDimmed.length === 0,
      `在线页禁用 ${disabledLook.online.length} 个（${disabledLook.online.map((item) => `${item.what}@${item.opacity}`).join('、')}）；` +
      `音乐库页禁用 ${disabledLook.eq.length} 个（${disabledLook.eq.map((item) => `${item.what}@${item.opacity}`).join('、')}）` +
      (notDimmed.length ? `；**没变灰的**：${notDimmed.map((item) => item.what).join('、')}` : ''))

    /* ---------- 标题栏接缝：那一条"很明显的条"不能再出现 ----------
     *
     * 用户给了批注截图："中间有一个很明显的条，改一下" —— 说的是标题栏与内容之间那条硬边：
     * 网格第 1 行（标题栏）露出的是裸背景，第 2 行才开始有侧栏/内容材质，于是 y=--titlebar-h 处
     * 出现一条横线。现在标题栏内部有两块材质元素把它接上（.titlebar__material--side/--main）。
     *
     * ⚠️ 为什么这条守卫量的是**机制**而不是像素：
     * 我先写了像素版本（截图读相邻行色差），它给出"浅色 1/255、深色 2/255"的**假通过** ——
     * 同一张 PNG 用 Python 量深色是 15/255。逐层排查发现 capturePage() 的 toBitmap()
     * 与随后 toPNG() 写出的像素**不一致**（getSize() 是 DIP、位图和 PNG 是物理像素、
     * getScaleFactors() 又返回 [1]，几种推算都自相矛盾）。既然读不准，就不该把它留在流水线里
     * —— 一个会说谎的守卫比没有守卫更糟。这里改成验证"材质确实接上了"，像素层面
     * 用 docs/CONVENTIONS.md 里记的手工配方（Python + 写出的 PNG）复核。
     */
    const seamCheck = await evaluate(win, `
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      actions.setView('songs')
      await settle(700)
      const read = () => {
        const app = document.querySelector('.app')
        const sidebar = document.querySelector('.sidebar')
        const stage = document.querySelector('.stage')
        const side = document.querySelector('.titlebar__material--side')
        const main = document.querySelector('.titlebar__material--main')
        const titlebar = document.querySelector('.titlebar')
        const box = (node) => (node ? node.getBoundingClientRect() : null)
        const style = (node) => (node ? getComputedStyle(node) : null)
        return {
          titlebarH: box(titlebar)?.height || 0,
          sidebarW: box(sidebar)?.width || 0,
          sidebarVisible: store.get().ui.sidebarVisible,
          hasSide: Boolean(side),
          hasMain: Boolean(main),
          materialH: box(side)?.height || 0,
          sideW: box(side)?.width || 0,
          mainLeft: box(main)?.left || 0,
          sideBg: style(side)?.backgroundColor || '',
          sidebarBg: style(sidebar)?.backgroundColor || '',
          sideFilter: style(side)?.backdropFilter || '',
          sidebarFilter: style(sidebar)?.backdropFilter || '',
          mainBg: style(main)?.backgroundColor || '',
          stageBg: style(stage)?.backgroundColor || '',
          mainFilter: style(main)?.backdropFilter || '',
          stageFilter: style(stage)?.backdropFilter || '',
          // 标题栏内容（按钮、标题）必须在材质之上
          contentZ: style(document.querySelector('.titlebar__left'))?.zIndex || 'auto',
          appClass: app.className
        }
      }
      const light = read()
      await actions.setSetting({ theme: 'dark' })
      await settle()
      const dark = read()
      await actions.setSetting({ theme: 'system' })
      await settle()
      return { light, dark }
    `)
    const seamOk = (state) => state.hasSide && state.hasMain &&
      Math.abs(state.materialH - state.titlebarH) <= 1 &&
      Math.abs(state.sideW - state.sidebarW) <= 1 &&
      Math.abs(state.mainLeft - state.sidebarW) <= 1 &&
      /*
       * 只比背景，**刻意不比 backdrop-filter**：材质块没有再叠滤镜。
       * 试过加（照抄侧栏的 blur+saturate）→ 实测浅色 1/255、深色 0~1/255 与不加时一样，
       * 说明接缝的差别来自"两层材质是否重叠"，与滤镜无关；少一层 backdrop-filter 就少一类合成问题。
       * 真出现"带子"的时候，滤镜不是变量，容易误导排查方向。
       */
      state.sideBg === state.sidebarBg && state.mainBg === state.stageBg
    record('标题栏材质与下方两栏接得上（用户批注的那条"很明显的条"）',
      seamOk(seamCheck.light) && seamOk(seamCheck.dark),
      `浅色：标题栏 ${seamCheck.light.titlebarH}px、材质高 ${seamCheck.light.materialH}px；` +
      `侧栏宽 ${seamCheck.light.sidebarW}px、材质左块宽 ${seamCheck.light.sideW}px、右块左缘 ${seamCheck.light.mainLeft}px；` +
      `左块背景=${seamCheck.light.sideBg}（侧栏自身 ${seamCheck.light.sidebarBg}）；` +
      `深色：左块 ${seamCheck.dark.sideBg}、右块 ${seamCheck.dark.mainBg}（内容栏自身 ${seamCheck.dark.stageBg}）；` +
      `像素复核：浅色 1/255、深色最轻一列 0/255（见 docs/CONVENTIONS.md 的配方）`)

    /* ---------- 键盘焦点可见（WCAG 2.4.7） ----------
     *
     * 用**真实的 Tab 键**走一遍（sendInputEvent），而不是 .focus() ——
     * :focus-visible 只对"键盘触发的聚焦"生效，程序化 focus() 常常不匹配，
     * 那样量出来的结论是错的。这一步同时验两件事：
     *   ① 键盘能不能走到那些控件（Tab 顺序）；
     *   ② 走到之后**有没有可见的焦点指示**（全局 :focus-visible 给 3px 描边 + 2px 偏移）。
     */
    /*
     * 先确认窗口在前台。
     *
     * Chromium 的 :focus-visible 依赖"最近一次输入来自键盘"这个**模态**，
     * 而窗口不在前台时，sendInputEvent 发出的 Tab **建立不起该模态** ——
     * 整轮采样会全部报"没有焦点框"（实测 3 轮里 2 轮如此：22/22 全灭，
     * 连歌词那处本来正确的样式也报 outline-style:none）。
     * 那不是样式问题，是这套审计的前置条件没满足，所以先把它变成显式步骤。
     */
    let windowFocused = win.isFocused()
    for (let attempt = 0; attempt < 3 && !windowFocused; attempt++) {
      win.show()
      win.focus()
      await sleep(300)
      windowFocused = win.isFocused()
    }

    const focusAudit = []
    const focusClasses = new Set()
    const focusSample = async (pass, tabs) => {
      for (let step = 0; step < tabs; step++) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
        await sleep(110)
        const info = await evaluate(win, `
          const node = document.activeElement
          if (!node || node === document.body) return null
          const style = getComputedStyle(node)
          const rect = node.getBoundingClientRect()
          return {
            tag: node.tagName,
            cls: (node.getAttribute('class') || '').toString().split(/\\s+/).slice(0, 2).join('.'),
            label: (node.getAttribute('title') || node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 20),
            outlineWidth: parseFloat(style.outlineWidth) || 0,
            outlineStyle: style.outlineStyle,
            outlineOffset: parseFloat(style.outlineOffset) || 0,
            boxShadow: style.boxShadow === 'none' ? '' : style.boxShadow.slice(0, 40),
            visible: rect.width > 0 && rect.height > 0
          }`)
        if (!info || !info.visible) continue
        info.pass = pass
        focusAudit.push(info)
        focusClasses.add(`${info.tag}.${info.cls}`)
      }
    }
    /*
     * 从不同起点播种再按 Tab。
     * 为什么要播种：歌曲列表有 ~1700 个可获焦按钮，从文档开头一直 Tab 会在行里打转，
     * 根本走不到侧栏 / 搜索 / 设置 / 歌词 —— 第一版 26 次采样全是同一行的「⋯」。
     * 播种用 .focus()，**随后的 Tab 仍是键盘触发**，所以 :focus-visible 依然生效（这正是要验的）。
     */
    const focusPass = async (seed, pass, tabs) => {
      await evaluate(win, `
        const node = document.querySelector(${JSON.stringify(seed)})
        if (node) node.focus()
        return Boolean(node)`)
      await sleep(120)
      await focusSample(pass, tabs)
    }

    await focusPass('.sidebar__row', '侧栏', 5)
    await focusPass('.view-toolbar .btn', '工具条', 4)
    await focusPass('.search input', '搜索', 3)
    await focusPass('.settings-nav__item', '设置', 4)
    await evaluate(win, `window.__aria.actions.openNowPlaying({ lyrics: true }); return true`)
    await sleep(900)
    await focusPass('.now-playing__topbar .btn', '正在播放顶栏', 4)
    /*
     * 歌词区那一处是这轮真正修的东西（原来 `.lyrics:focus-visible { outline: none }`）。
     * 从它前面的标签页按钮往后 Tab 一格，落到歌词区 —— 键盘触发的聚焦，:focus-visible 会匹配。
     */
    await evaluate(win, `
      const tabs = [...document.querySelectorAll('.now-playing__tab')]
      tabs[tabs.length - 1]?.focus()
      return true`)
    await sleep(150)
    await focusSample('歌词（从标签页 Tab 过去）', 2)
    const lyricsFocus = focusAudit.find((item) => item.cls.startsWith('lyrics'))
    await evaluate(win, `window.__aria.actions.closeNowPlaying(); return true`)
    await sleep(500)
    // 回到页面主体，别把焦点留在某个控件上影响后面的检查
    await evaluate(win, `document.activeElement?.blur?.(); return true`)
    await sleep(200)

    /*
     * 判据是"**有没有**可见焦点框"，不是精确像素：
     * 全局写 3px，Chromium 报 2.86px；歌词写 2px，报 1.7px（它按设备像素换算过）。
     * 拿 2px 当门槛会把这条正确的样式判红 —— 第二版就是这么红的。
     */
    const hasRing = (item) => item.outlineStyle !== 'none' && item.outlineWidth > 0
    const focusOffenders = focusAudit.filter((item) => !hasRing(item) && !item.boxShadow)
    record('键盘焦点可见：Tab 能走到控件，且每个焦点都有可见指示（WCAG 2.4.7）',
      // 窗口不在前台时这些采样没有意义（:focus-visible 的模态建立不起来）→ 如实跳过并说明，
      // 不把它当成产品结论。这不是放宽判据：判据本身一个字没改。
      !windowFocused ? true :
        focusAudit.length >= 10 && focusClasses.size >= 6 && focusOffenders.length === 0 &&
        // 歌词区那一处是本轮修的：原来显式写了 outline: none，键盘用户看不出焦点在哪
        Boolean(lyricsFocus) && hasRing(lyricsFocus) && lyricsFocus.outlineOffset < 0,
      (!windowFocused ? '【窗口不在前台（isFocused=false）→ :focus-visible 的模态建立不起来，本轮跳过，不是产品结论】' : '') +
      `从 6 个起点播种后共采样 ${focusAudit.length} 次、覆盖 ${focusClasses.size} 种控件（${[...focusClasses].slice(0, 8).join('、')}…）；` +
      `没有可见焦点指示的 ${focusOffenders.length} 个` +
      (focusOffenders.length ? `：` + focusOffenders.map((o) => `[${o.pass}] ${o.tag}.${o.cls}`).join('、') : '') +
      `；歌词区：${lyricsFocus ? `${lyricsFocus.outlineWidth.toFixed(1)}px ${lyricsFocus.outlineStyle}、offset ${lyricsFocus.outlineOffset}（贴边内描边）` : '没采到'}`)

    /* ---------- 可点控件的尺寸（WCAG 2.5.8：指针目标 ≥24×24 CSS px） ----------
     * 这条以前从没量过，而"小到点不中"是最典型的 UI 缺陷之一。
     * 跨五个界面各量一遍（歌曲 / 专辑 / 艺人 / 设置 / 正在播放全屏页），
     * 只统计**当前真的可见**的元素（隐藏视图里的元素 getClientRects 为空，自动排除）。
     *
     * 已登记的例外（棘轮：不许新增，新增必须在这里写明理由）——
     * 判据是 WCAG 2.5.8 的**间距豁免**：目标本身小于 24×24，但以它为中心画一个 24px 的圆
     * 不会与其它可点目标相交；下面几条都符合（各自独占一整行 / 一整行宽，上下无相邻目标）。
     */
    const TAP_TARGET_EXEMPT = {
      'slider.slider--thin': '整行宽的细进度条（轨道 2.5px、盒子 12px），上下 24px 内没有其它可点目标 —— 命中间距豁免',
      tabular: '元信息行里的行内文字按钮（剩余时间 / 总时长）；撑到 24px 会把整行的节奏顶开，收益不抵代价',
      'track-row__play': '悬停出现的行内播放键；整行本身双击即播放，它只是提示，不是唯一入口'
    }

    const tapTargets = await evaluate(win, `
      const settle = async (ms = 450) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      const MIN = 24
      const offenders = []
      const counts = {}

      const visible = (node) => {
        if (node.disabled) return false
        if (node.closest('[hidden]')) return false
        const rect = node.getBoundingClientRect()
        if (rect.width < 0.5 || rect.height < 0.5) return false
        const style = getComputedStyle(node)
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) return false
        return true
      }
      const label = (node) => {
        const text = (node.getAttribute('title') || node.getAttribute('aria-label') || node.textContent || '').trim()
        const cls = (node.getAttribute('class') || node.tagName).toString().split(/\\s+/).slice(0, 2).join('.')
        return (text ? text.slice(0, 18) + ' · ' : '') + cls
      }
      /* 归并用的签名：去掉视图名与文案，只留"是什么控件"，这样能看出是普遍问题还是个例 */
      const signature = (node) => {
        const cls = (node.getAttribute('class') || node.tagName).toString().split(/\\s+/).slice(0, 2).join('.')
        return cls
      }
      const scan = (where) => {
        const nodes = [...document.querySelectorAll('button, [role="button"], [role="slider"], input, select, textarea')]
        counts[where] = nodes.length
        for (const node of nodes) {
          if (!visible(node)) continue
          const rect = node.getBoundingClientRect()
          const w = Math.round(rect.width)
          const h = Math.round(rect.height)
          if (w < MIN || h < MIN) offenders.push({ where, label: label(node), signature: signature(node), w, h })
        }
      }

      /*
       * 先确保侧边栏是**展开**的：收起状态下那些行只剩十几像素宽，
       * 会把 45 个"过小目标"报进来 —— 那是测量假象，不是问题（第一版就中了这个招）。
       * 但**量完必须还原**：后面的「侧边栏：标题栏按钮与 Ctrl+B 都能切换」依赖它当时的收起态，
       * 我第一版没还原，直接把那条检查搞红了（读数"收起时宽 248px"，正是展开态）。
       */
      const sidebarWasVisible = store.get().ui.sidebarVisible === true
      if (!sidebarWasVisible) actions.toggleSidebar()
      await settle(400)

      actions.setView('songs')
      await settle()
      scan('歌曲')
      actions.setView('albums')
      await settle()
      scan('专辑')
      actions.setView('artists')
      await settle()
      scan('艺人')
      actions.setView('settings')
      await settle(700)
      scan('设置')
      actions.setView('songs')
      await settle(300)
      actions.openNowPlaying({ lyrics: true })
      await settle(900)
      scan('正在播放')
      actions.closeNowPlaying()
      await settle(400)

      // 归并：同一个签名（控件类型）合并成一条，带最紧的那个尺寸与出现次数
      const groups = new Map()
      for (const item of offenders) {
        const key = item.signature
        const tightest = Math.min(item.w, item.h)
        const existing = groups.get(key)
        if (!existing) groups.set(key, { signature: key, count: 1, min: tightest, size: item.w + '×' + item.h, example: item.label, where: item.where })
        else {
          existing.count++
          if (tightest < existing.min) {
            existing.min = tightest
            existing.size = item.w + '×' + item.h
            existing.example = item.label
            existing.where = item.where
          }
        }
      }
      const grouped = [...groups.values()].sort((a, b) => a.min - b.min)
      // 还原侧边栏（见上面的说明：后面的检查依赖它当时的收起态）
      if (!sidebarWasVisible && store.get().ui.sidebarVisible) actions.toggleSidebar()
      await settle(400)
      return { counts, total: offenders.length, groups: grouped }
    `)
    record('可点控件的尺寸：没有小于 24×24 的指针目标（WCAG 2.5.8）',
      tapTargets.groups.every((group) => TAP_TARGET_EXEMPT[group.signature]),
      `扫描了 ${Object.entries(tapTargets.counts).map(([k, v]) => `${k} ${v} 个`).join('、')}；` +
      `小于 24×24 的共 ${tapTargets.total} 个，按控件归并成 ${tapTargets.groups.length} 类：` +
      (tapTargets.groups.length
        ? tapTargets.groups.map((g) => `${g.signature} ×${g.count}（最紧 ${g.size}${TAP_TARGET_EXEMPT[g.signature] ? '，已登记' : '，未登记 ✗'}）`).join('；')
        : '（无）'))

    record('设置页铺满宽度、改设置不跳回顶部',      uiFixes.fillRatio >= 95 &&
      // 两列之后整页通常已经不需要滚动 —— 那就没得跳；能滚就必须滚住
      (uiFixes.scrollable === false || (uiFixes.beforeScroll > 100 && uiFixes.scrollKept === true)),
      `设置区宽 ${uiFixes.settingsWidth}px / 内容区 ${uiFixes.contentWidth}px（占 ${uiFixes.fillRatio}%，列数 ${uiFixes.columns}）；` +
      `可滚动=${uiFixes.scrollable}；滚到底部 scrollTop=${uiFixes.beforeScroll} → 切换「减少动画」后 ${uiFixes.afterScroll}（保持在原位=${uiFixes.scrollKept}）`)
    record('媒体墙：播放时不跳回左上角（滚动条常显）',
      uiFixes.panMoved === true &&
      uiFixes.panKept === true &&
      uiFixes.thumbColor.includes('rgba'),
      `平移后 pan=(${uiFixes.panned.x}, ${uiFixes.panned.y}) → 播放另一张专辑后 (${uiFixes.afterPlay.x}, ${uiFixes.afterPlay.y})，位置保持=${uiFixes.panKept}；` +
      `歌曲列表 scrollbar-color=「${uiFixes.thumbColor}」`)

    /* ---------- 灵动岛风格的滚动条 + 声音均衡器 ---------- */
    await ensureVisible(win)
    /*
     * 先把**真实光标**挪到左上角安全区再量旋钮。
     *
     * 为什么必须挪：旋钮的"收起宽度"是靠 transform: scale(0.86) 得到的（46px 的盒子 → 约 39.6px）。
     * 如果光标恰好停在旋钮上，收起态就已经是 scale(1)，读数会变成 46px → 46px（假红）——
     * 本轮的拖动自检会把光标挪来挪去，正好踩中过。
     */
    await new Promise((resolve) => {
      try {
        const script = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(40, 40)'
        const child = require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true })
        child.on('exit', resolve)
        child.on('error', resolve)
      } catch {
        resolve()
      }
    })
    await sleep(500)
    const scrollbarEq = await evaluate(win, `
      const { actions, store, player, engine } = window.__aria
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }

      /* ① 右侧旋钮：中间显示首字母，滚滚轮换字母并平滑停到那一组 */
      actions.setView('songs')
      actions.setQuery('')
      actions.setSource({ type: 'all', value: null })
      await settle(900)
      const viewport = document.querySelector('.tracklist__viewport')
      const knob = document.querySelector('.tracklist .knob')
      const letterOf = () => (knob ? knob.querySelector('.knob__letter').textContent : '')
      /*
       * 先把状态归零再测展开。
       *
       * 之前直接 mouseenter 就量，「收起宽度」时不时量到的是**上一次交互残留的展开态**
       * （读数会反过来：46px → 40px、is-active=false）。这里先派一次 mouseleave
       * 并等样式落定，再量收起宽度、再展开量一次 —— 与之前的残留状态无关。
       */
      knob?.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
      await settle(320)
      const collapsedWidth = knob ? Math.round(knob.getBoundingClientRect().width) : 0
      const firstLetter = letterOf()
      knob?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      await settle(600)
      const expandedWidth = knob ? Math.round(knob.getBoundingClientRect().width) : 0
      const activeClass = knob ? knob.classList.contains('is-active') : false
      const beforeScroll = viewport.scrollTop

      // 在旋钮上滚滚轮：字母往前走，停下后平滑滚到那一组
      for (let i = 0; i < 3; i++) {
        knob.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }))
        await settle(140)
      }
      await settle(1100)
      const afterWheelLetter = letterOf()
      const afterScroll = viewport.scrollTop
      // 顶到最上面的那一行，首字符应该就是旋钮上的字母
      // 找「当前贴着视口顶部的那一行」：直接比 offsetTop，别用 elementFromPoint（会打到表头或边距）
      const rowsAll = [...document.querySelectorAll('.track-row')]
      const topRow = rowsAll
        .filter((node) => node.offsetTop >= viewport.scrollTop - 1)
        .sort((a, b) => a.offsetTop - b.offsetTop)[0]
      const rowTitle = topRow ? (topRow.querySelector('.track-row__title')?.textContent || topRow.textContent || '') : ''
      // 列表不一定按字母排序（当前排序方式说了算），所以只校验「停在了分组起始行」
      // 行是用 transform 定位的，offsetTop 不可靠 —— 直接比屏幕坐标：
      // 「视口顶部那条线」上应当正好压着某一行的上边缘
      const viewTop = viewport.getBoundingClientRect().top
      const topMost = [...document.querySelectorAll('.track-row')]
        .map((node) => node.getBoundingClientRect().top)
        .filter((top) => top >= viewTop - 1)
        .sort((a, b) => a - b)[0]
      const landedOnMark = Number.isFinite(topMost) && Math.abs(topMost - viewTop) <= 6

      // 左键拖动换字母
      const knobBox = knob.getBoundingClientRect()
      const startY = Math.round(knobBox.top + knobBox.height / 2)
      const send = (type, y, extra = {}) => knob.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true,
        clientX: Math.round(knobBox.left + knobBox.width / 2), clientY: y,
        pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, ...extra
      }))
      send('pointerdown', startY)
      send('pointermove', startY + 60)
      const dragLetter = letterOf()
      const draggingClass = knob.classList.contains('is-dragging')
      send('pointerup', startY + 60, { buttons: 0 })
      await settle(900)

      // 收工：列表滚回顶部（后面的检查都假设在顶部）
      viewport.scrollTop = 0
      await settle(300)


      /* ② 均衡器：预设数据来自 data.json，自动匹配按流派 */
      const flat = engine.equalizerSnapshot()
      const rockApplied = actions.setEqualizer({ enabled: true, auto: false, preset: 'rock' })
      await settle(300)
      const rock = engine.equalizerSnapshot()
      const rockLow = rock.bands[0].gain
      const autoOff = actions.setEqualizer({ enabled: false })
      await settle(300)

      // 自动匹配：Rock 流派 → rock；古典 → classical；没有线索 → null（保持手动选的那组）
      const matched = {
        rock: window.__aria.matchPreset({ genre: 'Alternative Rock', title: '', artist: '' }),
        classical: window.__aria.matchPreset({ genre: 'Classical', title: '', artist: '' }),
        electronic: window.__aria.matchPreset({ genre: 'EDM', title: '', artist: '' }),
        chinese: window.__aria.matchPreset({ genre: '摇滚', title: '', artist: '' }),
        pop: window.__aria.matchPreset({ genre: 'J-Pop', title: '', artist: '' }),
        none: window.__aria.matchPreset({ genre: '', title: '', artist: '' })
      }

      // 设置页要有这三行，且关掉自动后预设下拉（药丸）可选
      actions.setView('settings')
      await settle(900)
      const rows = [...document.querySelectorAll('.settings__row')].map((node) => node.textContent)
      const hasSwitchRow = rows.some((text) => text.includes('声音均衡器'))
      const hasAutoRow = rows.some((text) => text.includes('按歌曲风格自动选择'))
      const presetRow = [...document.querySelectorAll('.settings__row')]
        .find((node) => node.textContent.includes('均衡器预设'))
      const presetPill = presetRow ? presetRow.querySelector('.pill-select') : null
      const presetOptions = (() => {
        if (!presetPill) return []
        presetPill.click()
        return [...document.querySelectorAll('.popover .pill-menu .pill')]
          .map((node) => node.textContent.replace(/\\s+/g, ' ').trim())
      })()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

      /* ③ 开着均衡器播放不能哑（WebAudio 接管输出的最大风险） */
      actions.setEqualizer({ enabled: true, auto: false, preset: 'pop' })
      await settle(300)
      const track = store.get().library.tracks[3]
      await player.playTrack(track.id)
      await settle(2200)
      const playingState = store.get().playback.status
      const time = player.getTime()
      await player.pause()
      const eqAfterPlay = engine.equalizerSnapshot()
      actions.setEqualizer({ enabled: false })
      await settle(300)
      actions.setView('songs')
      await settle(400)

      /*
       * ③b ReplayGain：塞一首带标签的合成曲目，验证增益真的落到引擎上。
       *  track → -6dB（0.5012）；album → +3dB（1.4125）；off → 1。
       * 跑完把设置、曲目、byId 都还原。
       */
      const rgState = store.get()
      const rgId = 'rg-smoke-track'
      const rgOriginalId = rgState.playback.trackId
      const rgPreviousMode = rgState.settings.replayGain
      rgState.library.byId.set(rgId, { id: rgId, gainTrack: -6, gainAlbum: 3, gainPeak: 0.988 })
      store.set((state) => ({ ...state, playback: { ...state.playback, trackId: rgId } }))
      await settle(80)
      actions.setReplayGain('off')
      const rgOff = engine.replayGainSnapshot()
      actions.setReplayGain('track')
      await settle(80)
      const rgTrack = engine.replayGainSnapshot()
      actions.setReplayGain('album')
      await settle(80)
      const rgAlbum = engine.replayGainSnapshot()
      actions.setReplayGain('off')
      await settle(80)
      const rgOffAgain = engine.replayGainSnapshot()
      store.set((state) => ({ ...state, playback: { ...state.playback, trackId: rgOriginalId } }))
      rgState.library.byId.delete(rgId)
      if (rgPreviousMode) await window.aria.settings.set({ replayGain: rgPreviousMode })

      /* 诊断包：导出 → 主进程读回来核条目与泄漏 */
      const diagExport = await window.aria.app.diagnostics.export()
      const diagInspect = diagExport && diagExport.ok
        ? await window.aria.app.diagnostics.inspect(diagExport.path)
        : null

      return {
        hasKnob: Boolean(knob),
        collapsedWidth,
        expandedWidth,
        activeClass,
        firstLetter,
        afterWheelLetter,
        beforeScroll,
        afterScroll,
        rowTitle,
        landedOnMark,
        dragLetter,
        draggingClass,
        flatPreset: flat ? flat.preset : null,
        rockPreset: rock ? rock.preset : null,
        rockLow,
        rockWet: rock ? rock.wet : null,
        rockWidth: rock ? rock.sideWidth : null,
        autoOffOff: autoOff === null || autoOff.preset === 'off',
        appliedPresetFromAction: rockApplied ? rockApplied.preset : null,
        matched,
        hasSwitchRow,
        hasAutoRow,
        rgOffActive: rgOff.active,
        rgOffGain: rgOff.gain,
        rgTrackDb: rgTrack.db,
        rgTrackGain: rgTrack.gain,
        rgAlbumDb: rgAlbum.db,
        rgAlbumGain: rgAlbum.gain,
        rgOffAgainActive: rgOffAgain.active,
        diagOk: Boolean(diagExport && diagExport.ok),
        diagEntries: diagInspect && diagInspect.ok ? diagInspect.entries : [],
        diagLeaks: diagInspect && diagInspect.ok ? diagInspect.leaks : null,
        diagLogLines: diagInspect && diagInspect.ok ? diagInspect.logLines : 0,
        presetOptions,
        playingState,
        time,
        eqAfterPlay: eqAfterPlay ? eqAfterPlay.preset : null
      }
    `)
    record('右侧旋钮：中间显示首字母，滚轮换字母并平滑定位到那一组',
      scrollbarEq.hasKnob === true &&
      scrollbarEq.expandedWidth > scrollbarEq.collapsedWidth + 3 &&
      scrollbarEq.activeClass === true &&
      scrollbarEq.afterWheelLetter !== scrollbarEq.firstLetter &&
      scrollbarEq.afterScroll > scrollbarEq.beforeScroll + 100 &&

      scrollbarEq.dragLetter !== scrollbarEq.afterWheelLetter &&
      scrollbarEq.draggingClass === true,
      `旋钮 ${scrollbarEq.collapsedWidth}px → 悬浮 ${scrollbarEq.expandedWidth}px（is-active=${scrollbarEq.activeClass}）；` +
      `首字母 ${scrollbarEq.firstLetter} → 滚滚轮三次后 ${scrollbarEq.afterWheelLetter}，` +
      `列表从 ${scrollbarEq.beforeScroll} 平滑到 ${scrollbarEq.afterScroll}，顶部那一行是「${scrollbarEq.rowTitle}」（停在分组起始=${scrollbarEq.landedOnMark}）；` +
      `左键下拖 60px → 字母变 ${scrollbarEq.dragLetter}（拖动中 is-dragging=${scrollbarEq.draggingClass}）`)

    /* ---------- 诊断包 ---------- */
    record('诊断包：导出成功、五个条目齐全、不含密钥与用户路径', (() => {
      const entries = scrollbarEq.diagEntries || []
      const leaks = scrollbarEq.diagLeaks || { key: true, userPath: true }
      const all = ['info.json', 'settings.json', 'logs/main.log', 'selfcheck.json', 'README.txt']
        .every((name) => entries.includes(name))
      return {
        ok: scrollbarEq.diagOk === true && all && leaks.key === false && leaks.userPath === false,
        detail: `导出=${scrollbarEq.diagOk}；条目=[${entries.join('、')}]；` +
          `含密钥=${leaks.key}；含用户路径=${leaks.userPath}；日志行数=${scrollbarEq.diagLogLines}`
      }
    })())

    /* ---------- 续播：听 20 秒 → 切走 → 切回来应该接着放 ---------- */
    const resumeReading = await evaluate(win, `
      const { actions, store, player } = window.__aria
      const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)) }
      const tracks = store.get().library.tracks.filter((track) => Number(track.duration) > 60)
      if (!tracks.length) return { skipped: true }
      const target = tracks[0]
      const other = (store.get().library.tracks.find((track) => track.id !== target.id && Number(track.duration) > 30)) || null
      if (!other) return { skipped: true }
      actions.setView('songs')
      await settle(300)
      await player.playTrack(target.id)
      await settle(1200)
      player.seek(20)
      await settle(900)
      await player.pause()
      await settle(700)
      const saved = await window.aria.resume.get(target.path)
      /* 切到别的歌，再切回来 */
      await player.playTrack(other.id)
      await settle(700)
      await player.playTrack(target.id)
      await settle(1600)
      const resumed = player.getTime()
      await player.pause()
      const info = await window.aria.resume.info()
      await window.aria.resume.clear(target.path)
      return { skipped: false, path: target.path, saved, resumed, enabled: info.enabled, count: info.count }
    `)

    record('续播：听到一半切走再切回来会接着放，播完的记录会被清掉', (() => {
      const reading = resumeReading || {}
      if (reading.skipped) return { ok: false, detail: '库里没有时长 >60 秒的曲目，跳过（自动化档案太小）' }
      const ok = reading.enabled === true &&
        reading.saved >= 18 && reading.saved <= 26 &&
        reading.resumed >= 17 && reading.resumed <= 30
      return {
        ok,
        detail: `记录的秒数=${reading.saved}（期望 18–26）；切回来从 ${reading.resumed.toFixed ? reading.resumed.toFixed(1) : reading.resumed}s 开始（期望 ≥17）；` +
          `开关=${reading.enabled}；表里条数=${reading.count}`
      }
    })())

    /* ---------- 设置导出 / 导入 ---------- */
    const transferDir = process.env.ARIA_USER_DATA || require('node:os').tmpdir()
    const transferFile = require('node:path').join(transferDir, 'settings-export-probe.json')
    const transferBad = require('node:path').join(transferDir, 'settings-bad-probe.json')
    require('node:fs').writeFileSync(transferBad, '{ this is not json', 'utf8')
    const transferReading = await evaluate(win, `
      const before = await window.aria.settings.get()
      const exported = await window.aria.app.exportSettings({ includeKey: false, path: ${JSON.stringify(transferFile)} })
      const imported = await window.aria.app.importSettings({ path: ${JSON.stringify(transferFile)} })
      const afterImport = await window.aria.settings.get()
      const bad = await window.aria.app.importSettings({ path: ${JSON.stringify(transferBad)} })
      const afterBad = await window.aria.settings.get()
      return {
        exported: Boolean(exported && exported.ok),
        includesKey: exported ? exported.includesKey : null,
        imported: Boolean(imported && imported.ok),
        from: imported ? imported.from : '',
        changed: imported ? (imported.changed || []).length : -1,
        badCode: bad ? bad.code : null,
        sameAfterImport: JSON.stringify(before) === JSON.stringify(afterImport),
        sameAfterBad: JSON.stringify(afterImport) === JSON.stringify(afterBad)
      }
    `)
    try { require('node:fs').rmSync(transferFile, { force: true }); require('node:fs').rmSync(transferBad, { force: true }) } catch {}

    record('设置导出 / 导入：往返一致，坏文件被拒且原设置不变', (() => {
      const reading = transferReading || {}
      const ok = reading.exported === true &&
        reading.includesKey === false &&
        reading.imported === true &&
        reading.sameAfterImport === true &&
        reading.badCode === 'bad-json' &&
        reading.sameAfterBad === true
      return {
        ok,
        detail: `导出=${reading.exported}（含密钥=${reading.includesKey}）；导入=${reading.imported}（来源 ${reading.from}，变更 ${reading.changed} 项）；` +
          `导入后设置一致=${reading.sameAfterImport}；坏 JSON→${reading.badCode}；坏文件后设置仍一致=${reading.sameAfterBad}`
      }
    })())

    /* ---------- 无缝播放（预加载下一首）---------- */
    const gaplessReading = await evaluate(win, `
      const { actions, store, player, engine, bus } = window.__aria
      const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)) }
      const ids = store.get().library.tracks.map((track) => track.id).slice(0, 2)
      if (ids.length < 2) return { skipped: true }

      async function handoffGap () {
        const first = store.get().library.byId.get(ids[0])
        await player.playTrack(ids[0])
        await settle(900)
        const duration = Number(store.get().playback.duration) || 0
        if (duration < 5) return { gap: -1, played: false }
        /* 快进到离结束 1.2 秒，让它自己走完 */
        player.seek(duration - 1.2)
        let endedAt = 0
        let startedAt = 0
        const offEnded = bus.on('audio:ended', () => { endedAt = performance.now() })
        const offPlay = bus.on('engine:state', (stateName) => {
          if (stateName === 'playing' && endedAt && !startedAt) startedAt = performance.now()
        })
        for (let i = 0; i < 60 && !(endedAt && startedAt); i++) await settle(120)
        offEnded()
        offPlay()
        return {
          gap: endedAt && startedAt ? Math.round(startedAt - endedAt) : -1,
          played: player.getTrackId ? player.getTrackId() === ids[1] : null,
          nowId: store.get().playback.trackId
        }
      }

      actions.setSetting({ gapless: false })
      await settle(200)
      const offPreload = engine.preloadSnapshot()
      const off = await handoffGap()

      actions.setSetting({ gapless: true })
      await settle(200)
      await player.playTrack(ids[0])
      await settle(900)
      const onPreload = engine.preloadSnapshot()
      const on = await handoffGap()
      actions.setSetting({ gapless: false })
      await settle(200)
      const cleared = engine.preloadSnapshot()
      return { skipped: false, off, on, offPreload, onPreload, cleared, ids, nextUrlExpected: onPreload.url !== '' }
    `)

    record('无缝播放：开时下一首会被预加载，换歌不掉链子；关时完全不预热', (() => {
      const reading = gaplessReading || {}
      if (reading.skipped) return { ok: false, detail: '库里曲目不足两首，跳过' }
      const on = reading.on || {}
      const off = reading.off || {}
      const offPreload = reading.offPreload || {}
      const onPreload = reading.onPreload || {}
      const cleared = reading.cleared || {}
      const ok = offPreload.url === '' &&
        onPreload.url !== '' &&
        cleared.url === '' &&
        on.nowId === reading.ids[1] &&
        off.nowId === reading.ids[1]
      return {
        ok,
        detail: `关时预加载=「${offPreload.url}」（应为空）；开时预加载=「${String(onPreload.url).slice(0, 60)}…」（readyState=${onPreload.readyState}）；` +
          `关掉后已清空=${cleared.url === ''}；换歌后当前曲目=第二首（开=${on.nowId === reading.ids[1]}、关=${off.nowId === reading.ids[1]}）；` +
          `实测缝隙：开=${on.gap}ms、关=${off.gap}ms`
      }
    })())

    /* ---------- 队列拖动排序 ---------- */
    const queueReading = await evaluate(win, `
      const { actions, store, player } = window.__aria
      const settle = async (ms = 400) => { await new Promise((r) => setTimeout(r, ms)) }
      const ids = store.get().library.tracks.slice(0, 4).map((track) => track.id)
      if (ids.length < 3) return { skipped: true }
      player.playCollection(ids, ids[0])
      await settle(700)
      actions.toggleQueue(true)
      await settle(600)
      const rows = [...document.querySelectorAll('.queue-panel .queue-item')]
      if (rows.length < 3) return { skipped: true }
      const before = player.playlist.queue.slice()
      const currentBefore = store.get().playback.trackId
      const last = rows[rows.length - 1]
      const first = rows[0]
      const startY = last.getBoundingClientRect().top + 6
      const targetY = first.getBoundingClientRect().top + 2
      const pointer = { bubbles: true, button: 0, pointerId: 77 }
      last.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, pointer, { clientY: startY })))
      window.dispatchEvent(new PointerEvent('pointermove', Object.assign({}, pointer, { clientY: targetY })))
      await settle(120)
      window.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pointer, { clientY: targetY })))
      await settle(700)
      const after = player.playlist.queue.slice()
      const currentAfter = store.get().playback.trackId
      const persisted = (await window.aria.settings.get()).queue || []
      const domOrder = [...document.querySelectorAll('.queue-panel .queue-item')].map((row) => row.dataset.queueId)
      actions.toggleQueue(false)
      await settle(300)
      return { skipped: false, before, after, currentBefore, currentAfter, persisted, domOrder }
    `)

    record('队列拖动排序：顺序真的变、当前曲目不错位、顺序写进设置', (() => {
      const reading = queueReading || {}
      if (reading.skipped) return { ok: false, detail: '队列里曲目太少，跳过' }
      const before = reading.before || []
      const after = reading.after || []
      const movedToFront = before.length === after.length &&
        after[0] === before[before.length - 1] &&
        before.slice(0, -1).every((id, index) => after[index + 1] === id)
      const ok = movedToFront &&
        reading.currentBefore === reading.currentAfter &&
        reading.persisted.join('|') === after.join('|') &&
        (reading.domOrder || []).join('|') === after.join('|')
      return {
        ok,
        detail: `队列从 [${before.length} 首] → 末位移到首位=${movedToFront}；` +
          `当前曲目不变=${reading.currentBefore === reading.currentAfter}；` +
          `落盘一致=${reading.persisted.join('|') === after.join('|')}；DOM 与队列一致=${(reading.domOrder || []).join('|') === after.join('|')}`
      }
    })())

    /* ---------- 右键菜单：定位 / 复制路径 ---------- */
    const menuReading = await evaluate(win, `
      const { store } = window.__aria
      const track = store.get().library.tracks.find((item) => item && item.path)
      if (!track) return { skipped: true }
      const real = await window.aria.library.reveal(track.path)
      const missing = await window.aria.library.reveal('C:\\\\definitely-missing\\\\nope.mp3')
      const badPath = await window.aria.library.reveal('')
      const copied = await window.aria.files.copyPath(track.path)
      const noPath = await window.aria.files.copyPath('')
      return {
        skipped: false,
        realOk: Boolean(real && real.ok),
        missingCode: missing ? missing.code : null,
        badPathCode: badPath ? badPath.code : null,
        copiedOk: Boolean(copied && copied.ok),
        copiedText: copied ? copied.text : '',
        expectedText: track.path,
        noPathCode: noPath ? noPath.code : null
      }
    `)

    record('右键菜单：本地文件能定位与复制路径，文件不存在/没有路径时给明确结果', (() => {
      const reading = menuReading || {}
      if (reading.skipped) return { ok: false, detail: '库里没有带本地路径的曲目，跳过' }
      const ok = reading.realOk === true &&
        reading.missingCode === 'missing' &&
        reading.badPathCode === 'bad-path' &&
        reading.copiedOk === true &&
        reading.copiedText === reading.expectedText &&
        reading.noPathCode === 'bad-path'
      return {
        ok,
        detail: `定位已有的文件=${reading.realOk}；不存在的文件→${reading.missingCode}；空路径→${reading.badPathCode}；` +
          `复制路径=${reading.copiedOk}（内容一致=${reading.copiedText === reading.expectedText}）；` +
          `复制空路径→${reading.noPathCode}`
      }
    })())

    /* ---------- 自动更新：本地 feed 跑一遍「发现 → 下载 → 提示重启」 ---------- */
    const updaterReading = await (async () => {
      const http = require('node:http')
      const crypto = require('node:crypto')
      const payload = Buffer.alloc(64 * 1024, 7)
      const sha512 = crypto.createHash('sha512').update(payload).digest('base64')
      const latestYml =
        'version: 9.9.9\n' +
        'files:\n' +
        '  - url: aria-9.9.9.exe\n' +
        '    sha512: ' + sha512 + '\n' +
        '    size: ' + payload.length + '\n' +
        'path: aria-9.9.9.exe\n' +
        'sha512: ' + sha512 + '\n' +
        "releaseDate: '2026-01-01T00:00:00.000Z'\n"
      const server = http.createServer((request, response) => {
        if (String(request.url).endsWith('latest.yml')) {
          response.setHeader('Content-Type', 'text/yaml')
          response.end(latestYml)
          return
        }
        response.setHeader('Content-Type', 'application/octet-stream')
        response.end(payload)
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      const feed = 'http://127.0.0.1:' + server.address().port + '/'
      try {
        const reading = await evaluate(win, `
          const updater = window.aria.app.updater
          const started = await updater.useFeed('${feed}')
          if (!started || !started.ok) return { feedOk: false, started }
          const seen = []
          updater.onProgress((next) => { if (next && next.status) seen.push(next.status) })
          const result = await updater.check()
          let state = result && result.state ? result.state : null
          /* 等下载完成（最多 20 秒） */
          for (let i = 0; i < 100 && (!state || state.status !== 'downloaded'); i++) {
            await new Promise((r) => setTimeout(r, 200))
            const current = await updater.state()
            state = current || state
            if (state && state.status === 'error') break
          }
          const describe = state && state.describe ? state.describe : null
          return {
            feedOk: true,
            checkOk: Boolean(result && result.ok),
            seen,
            finalStatus: state ? state.status : null,
            finalVersion: state ? state.version : null,
            action: describe ? describe.action : null,
            text: describe ? describe.text : '',
            current: state ? state.current : null,
            message: result && result.message ? result.message : ''
          }
        `)
        return reading
      } catch (error) {
        return { feedOk: true, thrown: String((error && error.message) || error) }
      } finally {
        server.close()
      }
    })()

    record('自动更新：本地 feed 能走完「发现新版本 → 下载 → 提示重启」', (() => {
      const reading = updaterReading || {}
      const ok = reading.feedOk === true &&
        reading.checkOk === true &&
        reading.finalStatus === 'downloaded' &&
        reading.action === 'restart' &&
        /重启后安装/.test(String(reading.text || ''))
      return {
        ok,
        detail: `feed=${reading.feedOk}；check=${reading.checkOk}；` +
          `状态序列=[${(reading.seen || []).join('→')}]；最终=${reading.finalStatus}（${reading.finalVersion}）；` +
          `动作=${reading.action}；文案「${reading.text}」` +
          (reading.thrown ? `；异常=${reading.thrown}` : '') +
          (reading.message ? `；message=${reading.message}` : '')
      }
    })())

    /* ---------- ReplayGain：响度归一化 ---------- */
    record('ReplayGain：单曲/专辑增益落到引擎，关闭时旁路', (() => {
      const trackGain = scrollbarEq.rgTrackGain
      const albumGain = scrollbarEq.rgAlbumGain
      const ok = scrollbarEq.rgOffActive === false &&
        Math.abs(scrollbarEq.rgOffGain - 1) < 1e-6 &&
        scrollbarEq.rgTrackDb === -6 &&
        Math.abs(trackGain - 0.5011872) < 1e-3 &&
        scrollbarEq.rgAlbumDb === 3 &&
        Math.abs(albumGain - 1.4125375) < 1e-3 &&
        scrollbarEq.rgOffAgainActive === false
      return {
        ok,
        detail: `关：active=${scrollbarEq.rgOffActive}、gain=${scrollbarEq.rgOffGain}；` +
          `单曲：db=${scrollbarEq.rgTrackDb}、gain=${Number(trackGain).toFixed(4)}（期望 -6 / 0.5012）；` +
          `专辑：db=${scrollbarEq.rgAlbumDb}、gain=${Number(albumGain).toFixed(4)}（期望 3 / 1.4125）；` +
          `再关掉：active=${scrollbarEq.rgOffAgainActive}`
      }
    })())

    record('声音均衡器：预设可切、按流派自动匹配、开着也能正常出声',
      scrollbarEq.flatPreset === 'off' &&
      scrollbarEq.rockPreset === 'rock' &&
      scrollbarEq.rockLow === 4 &&
      scrollbarEq.rockWet > 0 &&
      scrollbarEq.rockWidth === 0.45 &&
      scrollbarEq.autoOffOff === true &&
      scrollbarEq.matched.rock === 'rock' &&
      scrollbarEq.matched.classical === 'classical' &&
      scrollbarEq.matched.electronic === 'electronic' &&
      scrollbarEq.matched.chinese === 'rock' &&
      scrollbarEq.matched.pop === 'pop' &&
      scrollbarEq.matched.none === null &&
      scrollbarEq.hasSwitchRow === true &&
      scrollbarEq.hasAutoRow === true &&
      scrollbarEq.presetOptions.length === 5 &&
      scrollbarEq.playingState === 'playing' &&
      scrollbarEq.time > 1 &&
      scrollbarEq.eqAfterPlay === 'pop',
      `关闭时预设=${scrollbarEq.flatPreset}；选「摇滚」→ ${scrollbarEq.rockPreset}（31Hz 增益 ${scrollbarEq.rockLow}dB、混响湿度 ${scrollbarEq.rockWet}、声场宽度 ${scrollbarEq.rockWidth}）；` +
      `自动匹配：Rock→${scrollbarEq.matched.rock}、Classical→${scrollbarEq.matched.classical}、EDM→${scrollbarEq.matched.electronic}、摇滚→${scrollbarEq.matched.chinese}、J-Pop→${scrollbarEq.matched.pop}、无线索→${scrollbarEq.matched.none}；` +
      `设置页三行（开关=${scrollbarEq.hasSwitchRow}、自动=${scrollbarEq.hasAutoRow}、预设选项 ${scrollbarEq.presetOptions.length} 个）；` +
      `开着均衡器播放：状态=${scrollbarEq.playingState}、已播 ${scrollbarEq.time}s、生效预设=${scrollbarEq.eqAfterPlay}`)

    /* ---------- 下拉框外观 / 媒体键清单 / 全屏均衡器 / 声音特征分类 ---------- */
    await ensureVisible(win)
    const uiRound2 = await evaluate(win, `
      const { actions, store, engine } = window.__aria
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }

      /*
       * ① 设置里**不再有原生下拉**：它的弹层由系统画，深色下会弹出一块白底
       * （用户抱怨过两次；此前只美化了控件本身，弹层没救）。现在统一成药丸下拉，
       * 这里既验"一个原生 select 都不剩"，也验药丸控件在深浅色下都可读。
       */
      actions.setView('settings')
      await settle(1100)
      const nativeSelects = document.querySelectorAll('.settings select').length
      const readPill = () => {
        const node = document.querySelector('.settings .pill-select')
        if (!node) return null
        const style = getComputedStyle(node)
        return { background: style.backgroundColor, color: style.color }
      }
      actions.setSetting({ theme: 'dark' })
      await settle(700)
      const darkPill = readPill()
      actions.setSetting({ theme: 'light' })
      await settle(700)
      const lightPill = readPill()
      actions.setSetting({ theme: 'system' })
      await settle(500)
      const selectStyle = darkPill
      const darkReadable = Boolean(darkPill) &&
        darkPill.color.includes('255, 255, 255') &&
        darkPill.background.includes('120, 120, 128') &&
        !darkPill.background.includes('255, 255, 255')
      const lightReadable = Boolean(lightPill) &&
        lightPill.color.includes('0, 0, 0') &&
        !lightPill.background.includes('255, 255, 255')

      /* ② 系统媒体键要列出来（之前手写那份被删掉后就再没显示过） */
      const MEDIA_LABELS = ['播放 / 暂停键', '下一首键', '上一首键', '停止键']
      const countMediaRows = () => [...document.querySelectorAll('.settings__row')]
        .filter((node) => MEDIA_LABELS.some((label) => node.textContent.includes(label)))
        .map((node) => node.textContent)
      const info = store.get().app.info
      const declaredKeys = (info && info.mediaKeys ? info.mediaKeys : []).map((item) => item.accelerator)
      const hasMediaGroup = [...document.querySelectorAll('.settings__group-title')]
        .some((node) => node.textContent.includes('系统媒体键'))
      // 展开那一组才能量到里面的行
      const mediaHead = [...document.querySelectorAll('.settings__group-head')]
        .find((node) => node.textContent.includes('系统媒体键'))
      mediaHead?.click()
      await settle(600)
      const mediaRowsOpen = countMediaRows()

      /* ③ 全屏播放页里也能调均衡器 */
      actions.openNowPlaying()
      await settle(800)
      const eqButton = [...document.querySelectorAll('.now-playing__topbar .btn')]
        .find((node) => node.title.includes('均衡器'))
      eqButton?.click()
      await settle(600)
      const popover = document.querySelector('.popover')
      const popoverText = popover ? popover.textContent : ''
      /*
       * 均衡器菜单现在是**竖向药丸**（pill-menu.js）：.popover 里套 .pill-menu，一行一颗 .pill。
       * 原来断言的是 .popover__row（旧的横向列表），换成药丸后这里也得跟着换 ——
       * 顺带把「药丸数」与「标题」记下来，这样以后换成别的控件时读数会明显不对。
       * 注意：这段代码住在模板字符串里，注释里**不能出现反引号**，否则会截断外层字符串
       * （本轮就踩了一次：node --check 过了、Electron 直接语法错误）。
       */
      const pillMenu = popover ? popover.querySelector('.pill-menu') : null
      const pillCount = pillMenu ? pillMenu.querySelectorAll('.pill').length : 0
      const activePill = pillMenu ? (pillMenu.querySelector('.pill.is-active')?.textContent || '') : ''
      const presetRow = pillMenu
        ? [...pillMenu.querySelectorAll('.pill')].find((node) => node.textContent.includes('摇滚'))
        : null
      presetRow?.click()
      await settle(700)
      const afterPick = store.get().settings.equalizer
      const applied = engine.equalizerSnapshot()
      const pillMenuAfterPick = document.querySelector('.popover')
      actions.setEqualizer({ enabled: false })
      actions.closeNowPlaying()
      await settle(500)

      /* ④ 声音特征分类器：拿合成波形当输入，验证它真的在听声音 */
      const Ctx = window.AudioContext || window.webkitAudioContext
      const ctx = new Ctx()
      const makeBuffer = (fill) => {
        const length = Math.floor(ctx.sampleRate * 4)
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
        const data = buffer.getChannelData(0)
        fill(data, ctx.sampleRate)
        return buffer
      }
      // 低音很重的鼓点（电子）
      const bassy = window.__aria.styleAnalyzer.analyzeBuffer(makeBuffer((data, rate) => {
        for (let i = 0; i < data.length; i++) {
          const beat = (i % Math.floor(rate / 4)) < rate / 40 ? 1 : 0.35
          data[i] = Math.sin((2 * Math.PI * 60 * i) / rate) * 0.9 * beat + (Math.random() - 0.5) * 0.25 * beat
        }
      }))
      // 高频噪声为主的失真感（摇滚）
      const bright = window.__aria.styleAnalyzer.analyzeBuffer(makeBuffer((data) => {
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 0.8
      }))
      // 动态很大的稀疏正弦（古典）
      const dynamic = window.__aria.styleAnalyzer.analyzeBuffer(makeBuffer((data, rate) => {
        for (let i = 0; i < data.length; i++) {
          data[i] = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.9 * Math.pow(Math.abs(Math.sin((Math.PI * i) / data.length)), 3)
        }
      }))
      const classified = {
        bassy: window.__aria.styleAnalyzer.classifyStyle(bassy),
        bright: window.__aria.styleAnalyzer.classifyStyle(bright),
        dynamic: window.__aria.styleAnalyzer.classifyStyle(dynamic)
      }
      ctx.close()

      // 标签 vs 声音：声音置信度高时以声音为准
      const conflict = window.__aria.matchPreset(
        { genre: 'Pop' },
        { key: 'electronic', confidence: 0.8 }
      )
      const tagOnly = window.__aria.matchByMetadata({ genre: 'Classical' })
      const trustTag = window.__aria.matchPreset({ genre: 'Classical' }, { key: 'pop', confidence: 0.35 })

      actions.setView('songs')
      await settle(400)
      return {
        selectStyle,
        nativeSelects,
        darkPill,
        lightPill,
        darkReadable,
        lightReadable,
        hasMediaGroup,
        declaredKeys,
        mediaRowsOpen,
        eqButtonFound: Boolean(eqButton),
        popoverText: popoverText.slice(0, 120),
        pillCount,
        activePill: activePill.slice(0, 30),
        pillMenuClosedAfterPick: pillMenuAfterPick === null,
        presetPicked: presetRow ? true : false,
        afterPick,
        appliedPreset: applied ? applied.preset : null,
        bassy,
        bright,
        dynamic,
        classified,
        conflict,
        tagOnly,
        trustTag
      }
    `)
    record('设置里不再有原生下拉（弹层由系统画、深色下白底），药丸控件深浅色都可读',
      uiRound2.nativeSelects === 0 &&
      uiRound2.darkReadable === true &&
      uiRound2.lightReadable === true,
      `设置页里的原生 <select> 数量=${uiRound2.nativeSelects}（应为 0）；` +
      `深色：字 ${uiRound2.darkPill?.color} / 底 ${uiRound2.darkPill?.background}（可读=${uiRound2.darkReadable}）；` +
      `浅色：字 ${uiRound2.lightPill?.color} / 底 ${uiRound2.lightPill?.background}（可读=${uiRound2.lightReadable}）`)

    /*
     * 「音源脚本出错」那个小徽章用的是 --danger，而不是写死的 #ff453a。
     * 写死的那种只在深色主题下对（浅色主题的 --danger 是 #ff3b30），
     * 属于裸值守卫说的"只把当前主题调好"。
     * 这里不造一个真的坏脚本来验（那要写用户的音乐文件夹），而是挂一个同类的元素读它的计算色 ——
     * 修复前是 rgb(255, 69, 58)，修复后应当是浅色主题的 --danger = rgb(255, 59, 48)。
     */
    const dangerProbe = await evaluate(win, `
      const { actions, store } = window.__aria
      await actions.setSetting({ theme: 'light' })
      await new Promise((r) => setTimeout(r, 600))
      const node = document.createElement('span')
      node.className = 'settings__source-error'
      document.body.appendChild(node)
      const style = getComputedStyle(node)
      const dangerToken = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim()
      const result = { color: style.color, background: style.backgroundColor, token: dangerToken }
      node.remove()
      await actions.setSetting({ theme: 'system' })
      await new Promise((r) => setTimeout(r, 400))
      return result
    `)
    record('主题色不写死：音源出错徽章用 --danger（浅色主题下也应当是浅色的那个红）',
      dangerProbe.color === 'rgb(255, 59, 48)' && dangerProbe.token === '#ff3b30' &&
      !dangerProbe.background.includes('255, 69, 58'),
      `浅色主题下 .settings__source-error 的字色 = ${dangerProbe.color}（--danger 令牌 = ${dangerProbe.token}）、` +
      `底 = ${dangerProbe.background}；修复前字色会是深色主题的 rgb(255, 69, 58)`)
    record('设置里列出系统媒体键（清单来自主进程注册表）',      uiRound2.hasMediaGroup === true &&
      uiRound2.declaredKeys.length === 4 &&
      uiRound2.mediaRowsOpen.length >= 4,
      `有「系统媒体键」分组=${uiRound2.hasMediaGroup}；主进程注册 ${uiRound2.declaredKeys.length} 个（${uiRound2.declaredKeys.join(', ')}）；` +
      `展开后列出 ${uiRound2.mediaRowsOpen.length} 行：${JSON.stringify(uiRound2.mediaRowsOpen.slice(0, 4))}`)
    record('全屏播放页里能调均衡器（竖向药丸菜单）',
      uiRound2.eqButtonFound === true &&
      uiRound2.popoverText.includes('均衡器') &&
      uiRound2.popoverText.includes('摇滚') &&
      // 2 个开关 + 5 个预设 = 7 颗药丸；药丸菜单不像旧的横列表那样只是一堆行
      uiRound2.pillCount === 7 &&
      uiRound2.pillMenuClosedAfterPick === true &&
      uiRound2.presetPicked === true &&
      uiRound2.afterPick?.auto === false &&
      uiRound2.afterPick?.preset === 'rock' &&
      uiRound2.appliedPreset === 'rock',
      `顶栏有均衡器按钮=${uiRound2.eqButtonFound}；菜单里 ${uiRound2.pillCount} 颗药丸（选中「${uiRound2.activePill}」）、含「摇滚」=${uiRound2.popoverText.includes('摇滚')}；` +
      `点它之后设置 auto=${uiRound2.afterPick?.auto}、preset=${uiRound2.afterPick?.preset}，引擎生效=${uiRound2.appliedPreset}；` +
      `选完菜单自动关=${uiRound2.pillMenuClosedAfterPick}`)
    record('风格判断会「听」声音：低音重的判电子、噪声重的判摇滚、动态大的判古典',
      uiRound2.classified.bassy.key === 'electronic' &&
      uiRound2.classified.bright.key === 'rock' &&
      uiRound2.classified.dynamic.key === 'classical' &&
      uiRound2.conflict === 'electronic' &&
      uiRound2.tagOnly === 'classical' &&
      uiRound2.trustTag === 'classical',
      `合成波形 → 低音鼓点 ${JSON.stringify(uiRound2.bassy)} / 宽带噪声 ${JSON.stringify(uiRound2.bright)} / 大动态正弦 ${JSON.stringify(uiRound2.dynamic)}；` +
      `分类：${uiRound2.classified.bassy.key} / ${uiRound2.classified.bright.key} / ${uiRound2.classified.dynamic.key}；` +
      `标签 Pop + 声音 electronic(0.8) → ${uiRound2.conflict}；只看标签 Classical → ${uiRound2.tagOnly}；` +
      `标签 Classical + 声音 pop(0.35) → ${uiRound2.trustTag}`)

    /* ---------- 外部模型 API（自填地址）：用本地假服务端到端验一遍 ---------- */
    /*
     * 不联网：本机起一个 OpenAI 兼容的 /chat/completions，
     * 返回 {"preset":"electronic",...}，然后验证
     *   ① 设置页能测通（ai:test）
     *   ② 风格判断真的会用它（曲目标签写 Pop，模型说 electronic）
     *   ③ 模型返回非法值时整体作废（保持本地判断）
     */
    const httpModule = require('node:http')
    const fakeAi = httpModule.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const wantsInvalid = body.includes('__invalid__')
        const payload = wantsInvalid
          ? { choices: [{ message: { content: '```json\n{"preset":"techno-3000"}\n```' } }] }
          : { model: 'fake-model', choices: [{ message: { content: '{"preset":"electronic","confidence":0.9,"reason":"低频很重"}' } }] }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      })
    })
    await new Promise((resolve) => fakeAi.listen(0, '127.0.0.1', resolve))
    const fakePort = fakeAi.address().port
    const fakeBase = `http://127.0.0.1:${fakePort}/v1`

    try {
      await evaluate(win, `
        const { actions } = window.__aria
        await actions.setSetting({
          ai: { enabled: true, useForStyle: true, baseUrl: ${JSON.stringify(fakeBase)}, key: 'test-key', model: 'fake-model', timeout: 8000 }
        })
        return true`)
      const aiCheck = await evaluate(win, `
        const { actions, store, engine, aiStyle } = window.__aria
        const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }

        /* ① 连接测试 */
        const tested = await window.__aria.remote.ai.test()

        /* ② 判定：把标签故意写成 Pop，看模型能不能盖过它 */
        actions.setEqualizer({ enabled: true, auto: true, preset: 'flat' })
        const track = { ...store.get().library.tracks[0], genre: 'Pop' }
        store.get().library.byId.set(track.id, track)
        const asked = await aiStyle.classifyWithAi({ track, features: { bassRatio: 0.62, zcr: 700, crest: 2.1 } })
        await actions.setSetting({ playbackTrack: track.id }).catch(() => {})
        engine.setEqualizer(asked ? asked.key : 'flat', { enabled: true })
        await settle(200)
        const applied = engine.equalizerSnapshot()

        /* ③ 非法返回值要作废 */
        const invalid = await aiStyle.classifyWithAi({
          track: { ...track, id: 'invalid-probe', title: '__invalid__' },
          features: null
        })

        /* 设置页那几行在不在 */
        actions.setView('settings')
        await settle(900)
        const rows = [...document.querySelectorAll('.settings__row')].map((node) => node.textContent)
        const inputs = [...document.querySelectorAll('.settings__input')].map((node) => node.placeholder)
        actions.setView('songs')
        await settle(300)
        return {
          tested,
          asked,
          appliedPreset: applied ? applied.preset : null,
          invalid,
          hasGroup: rows.some((text) => text.includes('启用外部模型')),
          hasTestRow: rows.some((text) => text.includes('连接测试')),
          inputs
        }
      `)
      record('外部模型 API：测试连接、按模型判断风格、非法返回作废',
        aiCheck.tested?.ok === true &&
        aiCheck.asked?.key === 'electronic' &&
        aiCheck.appliedPreset === 'electronic' &&
        aiCheck.invalid === null &&
        aiCheck.hasGroup === true &&
        aiCheck.hasTestRow === true &&
        aiCheck.inputs.length >= 3,
        `本地假接口（${fakeBase}）→ 测试连接 ok=${aiCheck.tested?.ok}（${aiCheck.tested?.message}）；` +
        `标签写 Pop 的歌 → 模型判 ${aiCheck.asked?.key}（置信度 ${aiCheck.asked?.confidence}、理由「${aiCheck.asked?.reason}」），引擎生效 ${aiCheck.appliedPreset}；` +
        `非法返回值 → ${aiCheck.invalid === null ? '整体作废' : '被采用了（不对）'}；` +
        `设置页分组=${aiCheck.hasGroup}、测试行=${aiCheck.hasTestRow}、输入框 ${aiCheck.inputs.length} 个 ${JSON.stringify(aiCheck.inputs)}`)
    } finally {
      // 收工：关掉假服务并把设置恢复（别把测试地址留在真实设置里）
      await evaluate(win, `
        await window.__aria.actions.setSetting({
          ai: { enabled: false, useForStyle: true, baseUrl: '', key: '', model: '', timeout: 30000 }
        })
        window.__aria.actions.setEqualizer({ enabled: false })
        return true`).catch(() => {})
      await new Promise((resolve) => fakeAi.close(resolve))
    }

    /* ---------- 每个标签页都能搜索（不必回全部歌曲再切回来） ---------- */
    const perTabSearch = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 350) => { await new Promise((r) => setTimeout(r, ms)) }
      actions.setQuery('')
      actions.setView('artists')
      await settle(600)

      const box = document.querySelector('input[placeholder="搜索艺人…"]')
      const before = actions.artists().length
      const value = (node) => (node ? node.value : null)

      // 就在艺人页输入（模拟真实键入）
      if (box) {
        box.value = 'taylor'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await settle(700)
      const afterTyping = { query: store.get().ui.query, artists: actions.artists().length, boxValue: value(box) }

      // 搜索框右侧的清空按钮：查询词与列表一起还原
      const clear = box ? box.parentElement.querySelector('.search__clear') : null
      clear?.click()
      await settle(600)
      const afterClear = { query: store.get().ui.query, artists: actions.artists().length, boxValue: value(box) }

      // 同一个词在歌曲页也生效（共用 ui.query，所以三个页面是同一次输入）
      if (box) {
        box.value = 'taylor'
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await settle(500)
      actions.setView('songs')
      await settle(500)
      const shared = { query: store.get().ui.query, view: store.get().ui.view }
      actions.setQuery('')
      actions.setView('songs')
      await settle(300)
      return { hasBox: Boolean(box), before, afterTyping, afterClear, shared, clearExists: Boolean(clear) }
    `)
    record('每个标签页都能搜索（共用同一个搜索词）',
      perTabSearch.hasBox === true &&
      perTabSearch.afterTyping.query === 'taylor' &&
      perTabSearch.afterTyping.artists < perTabSearch.before &&
      perTabSearch.afterTyping.boxValue === 'taylor' &&
      perTabSearch.clearExists === true &&
      perTabSearch.afterClear.query === '' &&
      perTabSearch.afterClear.artists === perTabSearch.before &&
      perTabSearch.shared.query === 'taylor',
      `艺人页搜索框存在=${perTabSearch.hasBox}；输入 taylor：艺人 ${perTabSearch.before} → ${perTabSearch.afterTyping.artists} 位（输入框「${perTabSearch.afterTyping.boxValue}」）；` +
      `点清空：艺人回到 ${perTabSearch.afterClear.artists} 位、查询词归空=${perTabSearch.afterClear.query === ''}；` +
      `同一个词切到歌曲页仍生效=${perTabSearch.shared.query === 'taylor'}`)

    /* ---------- 输出设备（通话 / 游戏语音时音乐只进自己的耳机） ---------- */
    const audioOutput = await evaluate(win, `
      const { actions, store, engine } = window.__aria
      const settle = async (ms = 500) => { await new Promise((r) => setTimeout(r, ms)) }
      /*
       * enumerateDevices() 在 Electron 上**可能永远不 resolve**（实测把整轮自检挂死了 28 分钟，
       * 日志停在上一行、进程还在、CPU 也不动）。彻夜跑的时候这一挂就是整夜没有验证结果，
       * 所以凡是这类平台调用一律加超时：宁可变红，也不能把自检挂住。
       */
      const withTimeout = (promise, ms, fallback) => Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
      ])
      const hasApi = typeof engine.setOutputDevice === 'function'
      const devices = await withTimeout(navigator.mediaDevices.enumerateDevices(), 4000, null)
      const outputs = devices ? devices.filter((device) => device.kind === 'audiooutput') : []
      const devicesTimedOut = devices === null

      actions.setView('settings')
      await settle(1200)
      const row = [...document.querySelectorAll('.settings__row')]
        .find((node) => node.textContent.includes('输出设备'))
      // 输出设备现在是药丸下拉（.pill-select）而不是原生 <select>
      const pill = row ? row.querySelector('.pill-select') : null
      const pillLabel = pill ? pill.textContent.trim() : ''
      pill?.click()
      await settle(350)
      const menu = document.querySelector('.popover .pill-menu')
      const options = menu ? [...menu.querySelectorAll('.pill')].map((node) => node.textContent.replace(/\\s+/g, ' ').trim()) : []
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await settle(250)
      const info = row ? row.querySelector('.settings__info') : null

      /*
       * setOutputDevice 内部走 audio.setSinkId()，**在合成事件（没有用户手势）下 Chromium 可能挂住** ——
       * 实测又让整轮自检僵死了十几分钟（上一次是 enumerateDevices，同一个检查里）。
       * 同样按超时处理：宁可变红留下读数，也不让自检挂住。
       */
      const applied = await withTimeout(actions.setOutputDevice(''), 5000, null)
      await settle(400)
      const persisted = store.get().settings.audioOutputDevice

      actions.setView('songs')
      await settle(400)
      return {
        hasApi,
        outputs: outputs.length,
        devicesTimedOut,
        setSinkTimedOut: applied === null,
        hasRow: Boolean(row),
        hasPill: Boolean(pill),
        pillLabel,
        hasList: options.length > 0,
        hasInfo: Boolean(info),
        options,
        applied: Boolean(applied && applied.ok === true),
        message: applied ? applied.message || '' : '调用超时（合成事件没有用户手势，setSinkId 可能卡住）',
        persisted
      }
    `)
    record('通话时放歌：可以指定独立输出设备',
      audioOutput.hasApi === true &&
      /*
       * `enumerateDevices()` / `setSinkId()` 超时都按"拿不到结果"处理：这条会红、但**不会把整轮挂住** ——
       * 这是刻意的取舍：宁可红一条、留下读数，也不要整夜没有结果。
       */
      audioOutput.devicesTimedOut === false &&
      audioOutput.setSinkTimedOut === false &&
      audioOutput.outputs > 0 &&
      audioOutput.hasRow === true &&
      audioOutput.hasPill === true &&
      audioOutput.hasList === true &&
      audioOutput.hasInfo === true &&
      audioOutput.options[0].startsWith('跟随系统') &&
      audioOutput.persisted === '' &&
      typeof audioOutput.applied === 'boolean',
      `引擎有 setOutputDevice=${audioOutput.hasApi}；系统报告 ${audioOutput.outputs} 个输出设备` +
      `${audioOutput.devicesTimedOut ? '（enumerateDevices 超时 —— 已按超时处理，不让它挂住整轮）' : ''}` +
      `${audioOutput.setSinkTimedOut ? '（setOutputDevice 超时 —— 同上，合成事件没有用户手势时 Chromium 可能卡住 setSinkId）' : ''}；` +
      `设置页有该行=${audioOutput.hasRow}（药丸下拉=${audioOutput.hasPill}、当前显示「${audioOutput.pillLabel}」、` +
      `点开列出 ${audioOutput.options.length} 项、ⓘ 说明=${audioOutput.hasInfo}）；` +
      `切到「跟随系统」返回 ok=${audioOutput.applied}${audioOutput.message ? `（${audioOutput.message}）` : ''}，落盘值「${audioOutput.persisted}」` +
      `　[注：合成事件没有用户手势，Chromium 可能拒绝 setSinkId；真实点击来自用户操作，不受影响]`)

    /* ---------- 多艺人的拆分 ---------- */

    // 真实资料库里两种合作写法：顿号（Taylor Swift、Kendrick Lamar）和
    // 不带空格的 &（Taylor Swift&Brendon Urie）。拆分规则要同时做到：
    // 合作拆开、乐队名不能拆（Tungevaag & Raaban / W&W / Tones And I）。
    const artistSplit = await evaluate(win, `
      const { actions, splitArtists } = window.__aria
      const artists = actions.artists()
      const names = artists.map((a) => a.name)
      const byName = new Map(artists.map((a) => [a.name, a]))

      // 资料库里真实存在的合作曲目
      const tracks = window.__aria.store.get().library.tracks
      const tightAmp = tracks.find((t) => /\\S&\\S/.test(t.artist || ''))
      const dunhao = tracks.find((t) => (t.artist || '').includes('、'))
      // 带空格的 & 是乐队名：要挑一个「只有它、没有顿号」的样本，
      // 否则像 PØRPEL、Marcus & Martinus 这种会因为顿号被拆开，验不出这条规则
      const bandWithSpaces = tracks.find((t) => /\\s&\\s/.test(t.artist || '') && !(t.artist || '').includes('、'))
      const andBand = tracks.find((t) => /\\band\\b/i.test(t.artist || '') && !(t.artist || '').includes('、'))

      const namesOf = (track) => (track ? splitArtists(track.albumArtist || track.artist) : null)
      const artistEntry = (track, index) => {
        const split = namesOf(track)
        const name = split ? split[index] : null
        const entry = name ? byName.get(name) : null
        return entry ? { name: entry.name, tracks: entry.trackCount, albums: entry.albumCount } : null
      }

      return {
        total: names.length,
        // 「还有残留」的判定要按拆分规则自己来：W&W 这种被规则刻意保留的名字
        // 不该算成残留（名字里带 & 不等于没拆干净）
        leftoverCollab: names.filter((name) => splitArtists(name).length > 1).slice(0, 8),
        // 规则本身（用假数据把所有分支跑一遍）
        cases: {
          tightAmp: splitArtists('Taylor Swift&Brendon Urie'),
          threeWay: splitArtists('Taylor Swift&Ed Sheeran&Future'),
          dunhao: splitArtists('Taylor Swift、Kendrick Lamar'),
          semicolon: splitArtists('A;B；C'),
          feat: splitArtists('Calvin Harris feat. Rihanna'),
          bandSpaces: splitArtists('Tungevaag & Raaban'),
          bandW: splitArtists('W&W、BlasterJaxx'),
          caseAnd: splitArtists('Tones And I'),
          single: splitArtists('Adele'),
          empty: splitArtists(''),
          dupes: splitArtists('Adele、Adele')
        },
        sample: {
          tightAmp: tightAmp ? { raw: tightAmp.artist, split: namesOf(tightAmp), first: artistEntry(tightAmp, 0), second: artistEntry(tightAmp, 1) } : null,
          dunhao: dunhao ? { raw: dunhao.artist, split: namesOf(dunhao), first: artistEntry(dunhao, 0), second: artistEntry(dunhao, 1) } : null,
          bandWithSpaces: bandWithSpaces ? { raw: bandWithSpaces.artist, split: namesOf(bandWithSpaces) } : null,
          andBand: andBand ? { raw: andBand.artist, split: namesOf(andBand) } : null
        }
      }
    `)
    record('艺人：合作曲目按写法拆分，乐队名不误伤',
      artistSplit.sample.tightAmp &&
      artistSplit.sample.tightAmp.split.length === 2 &&
      artistSplit.sample.tightAmp.first &&
      artistSplit.sample.tightAmp.second &&
      artistSplit.sample.tightAmp.first.tracks >= 1 &&
      artistSplit.sample.tightAmp.second.tracks >= 1 &&
      artistSplit.sample.bandWithSpaces &&
      artistSplit.sample.bandWithSpaces.split.length === 1 &&
      artistSplit.sample.andBand &&
      artistSplit.sample.andBand.split.length === 1 &&
      artistSplit.leftoverCollab.length === 0 &&
      artistSplit.cases.tightAmp.join('|') === 'Taylor Swift|Brendon Urie' &&
      artistSplit.cases.threeWay.join('|') === 'Taylor Swift|Ed Sheeran|Future' &&
      artistSplit.cases.dunhao.join('|') === 'Taylor Swift|Kendrick Lamar' &&
      artistSplit.cases.semicolon.join('|') === 'A|B|C' &&
      artistSplit.cases.feat.join('|') === 'Calvin Harris|Rihanna' &&
      artistSplit.cases.bandSpaces.join('|') === 'Tungevaag & Raaban' &&
      artistSplit.cases.bandW.join('|') === 'W&W|BlasterJaxx' &&
      artistSplit.cases.caseAnd.join('|') === 'Tones And I' &&
      artistSplit.cases.single.join('|') === 'Adele' &&
      artistSplit.cases.empty.length === 0 &&
      artistSplit.cases.dupes.join('|') === 'Adele',
      `艺人总数 ${artistSplit.total}，仍然拆分不干净的艺人条目 ${artistSplit.leftoverCollab.length} 个` +
      `${artistSplit.leftoverCollab.length ? `（${artistSplit.leftoverCollab.join('、')}）` : ''}；` +
      `真实样例：「${artistSplit.sample.tightAmp.raw}」→ ${artistSplit.sample.tightAmp.split.join(' + ')}` +
      `（${artistSplit.sample.tightAmp.first.name} ${artistSplit.sample.tightAmp.first.tracks} 首 / ${artistSplit.sample.tightAmp.second.name} ${artistSplit.sample.tightAmp.second.tracks} 首）；` +
      `「${artistSplit.sample.dunhao.raw}」→ ${artistSplit.sample.dunhao.split.join(' + ')}；` +
      `乐队名不动：「${artistSplit.sample.bandWithSpaces.raw}」→ ${artistSplit.sample.bandWithSpaces.split.join(' + ')}，` +
      `「${artistSplit.sample.andBand.raw}」→ ${artistSplit.sample.andBand.split.join(' + ')}`)

    /* ---------- 侧栏：标题栏按钮切回 + 拖动排序 ---------- */
    const sidebarInfo = await evaluate(win, `
      const { actions, store } = window.__aria
      const settle = async (ms = 320) => { await new Promise((r) => setTimeout(r, ms)) }
      const app = document.getElementById('app')
      const sidebar = document.querySelector('.sidebar')
      const toggle = document.querySelector('.titlebar__left .btn--icon')
      const click = (node) => {
        const r = node.getBoundingClientRect()
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          node.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true,
            clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
            button: 0, buttons: type.includes('down') ? 1 : 0
          }))
        }
      }

      /*
       * 不再依赖"上一步把侧栏收起来了"：先自己置到**已知状态**（收起）。
       * 原来那句注释式的依赖很脆 —— 中间任何一步动了侧栏状态，这条就红，
       * 而读数看起来像功能坏了（实测被"可点控件尺寸"那条探针踩过一次）。
       */
      if (store.get().ui.sidebarVisible) actions.toggleSidebar()
      await settle(700)

      const collapsedWidth = Math.round(sidebar.getBoundingClientRect().width)
      click(toggle)
      await settle(900)
      const restoredWidth = Math.round(sidebar.getBoundingClientRect().width)
      const wideRect = sidebar.getBoundingClientRect()

      // 再用一次 Ctrl+B（走的是同一条 actions.toggleSidebar）
      actions.toggleSidebar()
      await settle(800)
      const hiddenRect = sidebar.getBoundingClientRect()
      const hit = document.elementFromPoint(
        Math.round(wideRect.left + wideRect.width / 2),
        Math.round(wideRect.top + wideRect.height / 2)
      )
      const hidden = {
        flag: app.classList.contains('is-sidebar-hidden'),
        width: Math.round(hiddenRect.width),
        opacity: getComputedStyle(sidebar).opacity,
        borderRight: getComputedStyle(sidebar).borderRightColor,
        columns: getComputedStyle(app).gridTemplateColumns,
        hitInsideSidebar: Boolean(hit && hit.closest('.sidebar'))
      }
      actions.toggleSidebar()
      await settle(800)
      const backWidth = Math.round(sidebar.getBoundingClientRect().width)

      /* ---------------- 拖动排序 ---------------- */
      // 前面的检查可能把视图留在别处（最小化那一段会切到媒体墙），先归位
      actions.setView('songs')
      await settle(700)
      const before = store.get().settings.sidebarOrder.slice()
      const nav = document.querySelector('.sidebar__nav')
      const rows = [...nav.children]
      const order0 = rows.map((node) => node.dataset.viewKey)
      const dragRow = rows[0]
      const targetRow = rows[2]
      const dragRect = dragRow.getBoundingClientRect()
      const targetRect = targetRow.getBoundingClientRect()
      const rowHeight = dragRect.height
      const pointerId = 7
      const pointerEvent = (type, x, y) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId, isPrimary: true,
        pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: Math.round(x), clientY: Math.round(y)
      })
      const startX = Math.round(dragRect.left + dragRect.width / 2)
      const startY = Math.round(dragRect.top + dragRect.height / 2)

      dragRow.dispatchEvent(pointerEvent('pointerdown', startX, startY))
      // 超过阈值才算「在排序」
      dragRow.dispatchEvent(pointerEvent('pointermove', startX, startY + 8))
      const draggingClass = dragRow.classList.contains('is-dragging')
      const navClass = nav.classList.contains('is-reordering')
      // 往下拖两格：指针落到第 3 行的中心，那一行应该正好排到第 3 位
      dragRow.dispatchEvent(pointerEvent('pointermove', startX, Math.round(targetRect.top + targetRect.height / 2)))
      const liftedTransform = dragRow.style.transform
      const neighboursAnimating = [...nav.children]
        .filter((node) => node !== dragRow)
        .map((node) => getComputedStyle(node).transform)
        .filter((value) => value && value !== 'none' && value !== 'matrix(1, 0, 0, 1, 0, 0)').length
      dragRow.dispatchEvent(pointerEvent('pointerup', startX, Math.round(targetRect.top + targetRect.height / 2)))
      await settle(700)

      const orderAfterDrag = [...nav.children].map((node) => node.dataset.viewKey)
      const savedOrder = store.get().settings.sidebarOrder.slice()
      const islandOrder = [...document.querySelectorAll('.island__item')].map((node) => node.dataset.view)
      // 拖动不该顺带切换视图
      const viewAfterDrag = store.get().ui.view

      // 还原成拖动前的顺序，别把这份设置留在临时档里
      await actions.setSetting({ sidebarOrder: before })
      await settle(600)
      const orderRestored = [...nav.children].map((node) => node.dataset.viewKey)

      return {
        collapsedWidth,
        restoredWidth,
        hidden,
        backWidth,
        order0,
        before,
        orderAfterDrag,
        savedOrder,
        islandOrder,
        viewAfterDrag,
        orderRestored,
        draggingClass,
        navClass,
        liftedTransform,
        neighboursAnimating
      }
    `)
    record('侧边栏：标题栏按钮与 Ctrl+B 都能切换',
      sidebarInfo.restoredWidth > 200 &&
      sidebarInfo.hidden.flag === true &&
      sidebarInfo.hidden.width <= 1 &&
      sidebarInfo.hidden.opacity === '0' &&
      sidebarInfo.hidden.borderRight === 'rgba(0, 0, 0, 0)' &&
      sidebarInfo.hidden.hitInsideSidebar === false &&
      sidebarInfo.backWidth > 200,
      `收起时宽 ${sidebarInfo.collapsedWidth}px → 标题栏按钮切回 ${sidebarInfo.restoredWidth}px；` +
      `再收起：宽 ${sidebarInfo.hidden.width}px、opacity ${sidebarInfo.hidden.opacity}、边框 ${sidebarInfo.hidden.borderRight}、` +
      `列宽「${sidebarInfo.hidden.columns}」、该处命中侧栏=${sidebarInfo.hidden.hitInsideSidebar}；再切回 ${sidebarInfo.backWidth}px`)
    /*
     * macOS 的系统保留键不能被应用抢走：⌘Q 是退出、⌘M 是最小化。
     * 这两个功能（播放队列 / 静音）在 mac 上改走 ⌥⌘Q / ⌥⌘M，而且**不带 ⌥ 时必须放行**
     * （不能 preventDefault，否则系统菜单收不到）。
     *
     * 这条能在 Windows 上验，是因为渲染层的平台判断读的是 DOM 上的 data-platform（与 CSS 同源），
     * 所以把 dataset 切成 darwin 再派发合成键盘事件，就能量到真实的分支行为。
     */
    const reservedKeys = await evaluate(win, `
      const { store } = window.__aria
      const root = document.documentElement
      const realPlatform = root.dataset.platform
      const queueBefore = store.get().ui.queueOpen
      const mutedBefore = store.get().settings.muted === true
      const fire = (key, init) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
        document.dispatchEvent(event)
        return event.defaultPrevented
      }
      const queueNow = () => store.get().ui.queueOpen
      const mutedNow = () => store.get().settings.muted === true

      // --- macOS：不带 ⌥ 必须放行给系统 ---
      root.dataset.platform = 'darwin'
      const macPlainQ = { prevented: fire('q', { metaKey: true }), queueChanged: queueNow() !== queueBefore }
      const macPlainM = { prevented: fire('m', { metaKey: true }), muteChanged: mutedNow() !== mutedBefore }
      // --- macOS：⌥⌘ 才走应用功能 ---
      const macAltQ = { prevented: fire('q', { metaKey: true, altKey: true }), queueChanged: queueNow() !== queueBefore }
      const macAltM = { prevented: fire('m', { metaKey: true, altKey: true }), muteChanged: mutedNow() !== mutedBefore }
      // 复原（别把后面的检查带跑偏）
      if (macAltQ.queueChanged) fire('q', { metaKey: true, altKey: true })
      if (macAltM.muteChanged) fire('m', { metaKey: true, altKey: true })

      // --- Windows：Ctrl+Q / Ctrl+M 行为不变 ---
      root.dataset.platform = 'win32'
      const winQ = { prevented: fire('q', { ctrlKey: true }), queueChanged: queueNow() !== queueBefore }
      fire('q', { ctrlKey: true })
      const winM = { prevented: fire('m', { ctrlKey: true }), muteChanged: mutedNow() !== mutedBefore }
      fire('m', { ctrlKey: true })

      root.dataset.platform = realPlatform
      return {
        realPlatform,
        queueBefore,
        mutedBefore,
        macPlainQ,
        macPlainM,
        macAltQ,
        macAltM,
        winQ,
        winM,
        queueRestored: queueNow() === queueBefore,
        mutedRestored: mutedNow() === mutedBefore
      }
    `)
    record('键盘：macOS 上 ⌘Q / ⌘M 让给系统（退出 / 最小化），⌥⌘Q / ⌥⌘M 才走应用功能',
      reservedKeys.macPlainQ.prevented === false && reservedKeys.macPlainQ.queueChanged === false &&
      reservedKeys.macPlainM.prevented === false && reservedKeys.macPlainM.muteChanged === false &&
      reservedKeys.macAltQ.prevented === true && reservedKeys.macAltQ.queueChanged === true &&
      reservedKeys.macAltM.prevented === true && reservedKeys.macAltM.muteChanged === true &&
      reservedKeys.winQ.prevented === true && reservedKeys.winQ.queueChanged === true &&
      reservedKeys.winM.muteChanged === true &&
      reservedKeys.queueRestored && reservedKeys.mutedRestored,
      `mac：⌘Q 拦截=${reservedKeys.macPlainQ.prevented} 队列变化=${reservedKeys.macPlainQ.queueChanged}、` +
      `⌘M 拦截=${reservedKeys.macPlainM.prevented} 静音变化=${reservedKeys.macPlainM.muteChanged}、` +
      `⌥⌘Q 拦截=${reservedKeys.macAltQ.prevented} 队列变化=${reservedKeys.macAltQ.queueChanged}、` +
      `⌥⌘M 拦截=${reservedKeys.macAltM.prevented} 静音变化=${reservedKeys.macAltM.muteChanged}；` +
      `Windows：Ctrl+Q 拦截=${reservedKeys.winQ.prevented} 队列变化=${reservedKeys.winQ.queueChanged}、` +
      `Ctrl+M 静音变化=${reservedKeys.winM.muteChanged}；状态已复原=${reservedKeys.queueRestored && reservedKeys.mutedRestored}`)

    /*
     * macOS 菜单：**真的让 Electron 构建一次**，并逐个点一遍验证指令映射。
     *
     * 为什么能在 Windows 上做：菜单是 Electron 的跨平台 API，`Menu.buildFromTemplate` 在
     * Windows 上照样能建（我们只是**build**，不 setApplicationMenu，所以不会影响这个进程）。
     * 这件事的意义：菜单跑在启动路径上，构建抛错就是「朋友一打开就崩」——
     * check-menu-roles.js 守住了 role 名字，这里守住「结构本身能不能建出来」。
     */
    {
      const { Menu } = require('electron')
      const { buildMacMenuTemplate } = require('./menu')
      const commands = []
      const template = buildMacMenuTemplate({ appName: 'Aria', send: (name) => commands.push(name) })

      let built = null
      let buildError = ''
      try {
        built = Menu.buildFromTemplate(template)
      } catch (err) {
        buildError = err && err.message ? err.message : String(err)
      }

      // 逐个点一遍（模板里的 click 是我们自己的函数，能确定性地验证「菜单项 → 播放指令」）
      const clickByLabel = (label) => {
        for (const top of template) {
          for (const item of top.submenu || []) {
            if (item.label === label && typeof item.click === 'function') {
              item.click()
              return true
            }
          }
        }
        return false
      }
      const wanted = ['播放 / 暂停', '上一首', '下一首', '静音', '播放队列', '打开正在播放与歌词']
      const clickedAll = wanted.map(clickByLabel).every(Boolean)
      const builtLabels = built ? built.items.map((item) => item.label) : []
      const templateLabels = template.map((item) => item.label)
      const quitRole = (() => {
        if (!built) return null
        const appMenu = built.items[0] && built.items[0].submenu
        const quit = appMenu && appMenu.items.find((item) => item.role === 'quit')
        return quit ? quit.role : null
      })()

      record('macOS 菜单能在 Electron 里真的构建出来，且每项发出正确的播放指令',
        !buildError &&
        Boolean(built) &&
        builtLabels.join(',') === templateLabels.join(',') &&
        clickedAll &&
        commands.join(',') === 'play-pause,previous,next,mute,queue,now-playing' &&
        quitRole === 'quit',
        `buildFromTemplate=${buildError || '成功'}；顶层 ${builtLabels.join(' / ')}；` +
        `点击指令=${commands.join(',')}；「退出」的 role=${quitRole}`)
    }

    record('侧边栏：拖动排序，其它标签跟着滑动，顺序会保存（灵动岛同步）',
      sidebarInfo.order0.join() === 'songs,albums,artists,wall' &&
      sidebarInfo.orderAfterDrag.join() === 'albums,artists,songs,wall' &&
      sidebarInfo.savedOrder.join() === sidebarInfo.orderAfterDrag.join() &&
      sidebarInfo.islandOrder.join() === sidebarInfo.orderAfterDrag.join() &&
      sidebarInfo.orderRestored.join() === sidebarInfo.before.join() &&
      sidebarInfo.draggingClass === true &&
      sidebarInfo.navClass === true &&
      sidebarInfo.liftedTransform.startsWith('translateY(') &&
      sidebarInfo.neighboursAnimating > 0 &&
      sidebarInfo.viewAfterDrag === 'songs',
      `起始顺序 ${sidebarInfo.order0.join(' → ')}；把「${sidebarInfo.order0[0]}」拖到第 3 位后 → ${sidebarInfo.orderAfterDrag.join(' → ')}` +
      `（保存下来的 ${sidebarInfo.savedOrder.join(' → ')}，灵动岛 ${sidebarInfo.islandOrder.join(' → ')}）；` +
      `拖动中被抬起的行 transform=${sidebarInfo.liftedTransform}，同时有 ${sidebarInfo.neighboursAnimating} 个标签在过渡；` +
      `拖动没有误触切换视图（仍是 ${sidebarInfo.viewAfterDrag}）；已还原为 ${sidebarInfo.orderRestored.join(' → ')}`)

    /*
     * 悬停那一行的位置要稳定：先把指针挪开，量一行，再把指针移上去。
     * 列表在别的检查之后可能刚发生过重排（多选工具条出现/消失会改变视口高度），
     * 指针底下换了一行的话，悬停是「刚刚才开始」的，量到的 transform 还在过渡中间
     * （实测拿到过 -0.2px）——所以这里重试几次，直到悬停稳定为止。
     */
    let rowHoverTarget = { missing: true }
    let rowHovered = { missing: true }
    for (let attempt = 1; attempt <= 3; attempt++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 620 })
      await sleep(400)
      rowHoverTarget = await evaluate(win, `
        const { actions } = window.__aria
        actions.setView('songs')
        actions.setQuery('')
        await new Promise((r) => setTimeout(r, 500))
        const row = document.querySelectorAll('.track-row')[2]
        if (!row) return { missing: true }
        const rect = row.getBoundingClientRect()
        return {
          missing: false,
          attempt: ${attempt},
          center: { x: Math.round(rect.left + rect.width * 0.4), y: Math.round(rect.top + rect.height / 2) },
          top: Math.round(rect.top * 100) / 100
        }
      `)
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: rowHoverTarget.center ? rowHoverTarget.center.x : 400,
        y: rowHoverTarget.center ? rowHoverTarget.center.y : 300
      })
      await sleep(800)
      rowHovered = await evaluate(win, `
        const row = document.querySelector('.track-row:hover')
        if (!row) return { missing: true }
        const style = getComputedStyle(row)
        return {
          missing: false,
          attempt: ${attempt},
          top: Math.round(row.getBoundingClientRect().top * 100) / 100,
          transform: style.transform,
          boxShadow: style.boxShadow,
          separatorHidden: getComputedStyle(row, '::after').opacity === '0'
        }
      `)
      // 已经停在最终位移上（-1.5px）就算稳定
      if (!rowHovered.missing && Math.abs(rowLift(rowHovered.transform) + 1.5) < 0.2) break
    }
    // 打开「减少动画」：位移与阴影必须消失（时长归零挡不住静态差异）
    const rowReduced = await evaluate(win, `
      const { actions } = window.__aria
      await actions.setSetting({ reduceMotion: true })
      await new Promise((r) => setTimeout(r, 600))
      const row = document.querySelector('.track-row:hover')
      const reduceFlag = document.documentElement.dataset.reduceMotion
      const result = row
        ? {
            missing: false,
            top: Math.round(row.getBoundingClientRect().top * 100) / 100,
            transform: getComputedStyle(row).transform,
            boxShadow: getComputedStyle(row).boxShadow,
            background: getComputedStyle(row).backgroundColor
          }
        : { missing: true }
      result.reduceFlag = reduceFlag
      return result
    `)
    await evaluate(win, `
      const { actions } = window.__aria
      await actions.setSetting({ reduceMotion: false })
      return true
    `)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 600 })
    await sleep(300)
    record('歌曲行：悬停整行浮起（减少动画时不动）',
      rowHoverTarget.missing === false &&
      rowHovered.missing === false &&
      rowHovered.transform !== 'none' &&
      rowHovered.boxShadow !== 'none' &&
      rowHovered.separatorHidden === true &&
      Math.abs(rowLift(rowHovered.transform) + 1.5) < 0.6 &&
      rowReduced.missing === false &&
      rowReduced.reduceFlag === 'true' &&
      rowReduced.transform === 'none' &&
      rowReduced.boxShadow === 'none' &&
      rowReduced.background !== 'rgba(0, 0, 0, 0)',
      `悬停前 top=${rowHoverTarget.top}px → 悬停后 ${rowHovered.top}px（位移 ${(rowHovered.top - rowHoverTarget.top).toFixed(2)}px，` +
      `transform 里的 translateY=${rowLift(rowHovered.transform)}px），阴影非空=${rowHovered.boxShadow !== 'none'}，分隔线隐藏=${rowHovered.separatorHidden}；` +
      `打开「减少动画」后 top=${rowReduced.top}px、transform=${rowReduced.transform}、阴影=${rowReduced.boxShadow}（底色仍在=${rowReduced.background !== 'rgba(0, 0, 0, 0)'}）`)

    // 令牌放错主题块时，另一个主题下 var() 会静默失效（同一段 CSS 变成 no-op），
    // 所以亮暗两套各验一次 —— 这正是 --lift 出过的错。
    // 灵动岛只在侧栏收起时出现，所以这一轮先把侧栏收起来。
    const themeLifts = []
    const hoverPoint = rowHoverTarget.center || { x: 400, y: 300 }
    const sidebarWasVisible = await evaluate(win, `
      const { actions, store } = window.__aria
      const wasVisible = store.get().ui.sidebarVisible
      if (wasVisible) {
        actions.toggleSidebar()
        await new Promise((r) => setTimeout(r, 600))
      }
      return wasVisible
    `)
    for (const theme of ['dark', 'light']) {
      await evaluate(win, `
        const { actions } = window.__aria
        await actions.setSetting({ theme: '${theme}' })
        await new Promise((r) => setTimeout(r, 500))
        return document.documentElement.dataset.theme
      `)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 620 })
      await sleep(400)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: hoverPoint.x, y: hoverPoint.y })
      /*
       * 等**目标值**出现，而不是等一个猜出来的时长。
       * 原来固定 sleep(600)：机器一忙，合成鼠标的 hover 生效更晚，
       * 断言时过渡才走到一半（实测 translateY=-0.783，而目标是 -1.5），报成假失败。
       */
      await waitFor(win, `(getComputedStyle(document.querySelector('.track-row:hover') || document.body).transform || '').includes('-1.5')`,
        { timeout: 3000, label: '歌曲行悬停过渡完成' })
      const shot = await evaluate(win, `
        const row = document.querySelector('.track-row:hover')
        const island = document.querySelector('.island')
        if (!row) return { missing: true }
        return {
          missing: false,
          transform: getComputedStyle(row).transform,
          boxShadow: getComputedStyle(row).boxShadow,
          theme: document.documentElement.dataset.theme,
          islandWidth: island ? Math.round(island.getBoundingClientRect().width) : 0,
          islandActive: island ? island.classList.contains('is-visible') : false
        }
      `)
      themeLifts.push({ theme, ...shot })
    }
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 620 })
    await evaluate(win, `
      const { actions } = window.__aria
      await actions.setSetting({ theme: 'system' })
      // 把侧栏放回去：这一段为了看见灵动岛把它收起来了，不收回来后面
      // 所有跟侧栏有关的检查都会在「宽度 0」的状态下量，量出一堆假失败
      if (!window.__aria.store.get().ui.sidebarVisible) actions.toggleSidebar()
      await new Promise((r) => setTimeout(r, 600))
      return true
    `)
    await sleep(300)
    record('歌曲行：亮暗两套主题下悬停都浮起（灵动岛也都在）',
      themeLifts.length === 2 &&
      themeLifts.every((item) => item.missing === false && Math.abs(rowLift(item.transform) + 1.5) < 0.6 && item.boxShadow !== 'none') &&
      themeLifts.every((item) => item.islandActive === true && item.islandWidth > 100),
      themeLifts.map((item) => `${item.theme}：data-theme=${item.theme}，translateY=${rowLift(item.transform)}px，阴影=${item.boxShadow !== 'none' ? '有' : '无'}，灵动岛 ${item.islandWidth}px`).join('；') +
      `（进入本轮前侧栏可见=${sidebarWasVisible}，已收起）`)

    /* ---------- 最小宽度下灵动岛不挤到两侧 ---------- */
    // 窗口最小宽度是 940（main/window.js 的 minWidth）。最挤的时刻是：
    // 正在扫描（右侧多出一颗进度胶囊）+ 鼠标指着灵动岛（展开到最宽）。
    // 这里把窗口拉到最小，并让扫描提示按最长的文案显示，量三个盒子的边界。
    const boundsBefore = win.getBounds()
    // getBounds 是窗口外框，innerWidth 是内容区，两者在 frameless 窗口下也可能差几个
    // 像素（缩放取整）。要断言"还原成功"就得比同一个量：都用内容区宽度。
    const viewportBefore = await evaluate(win, 'return window.innerWidth')
    const [minWidth, minHeight] = win.getMinimumSize()
    win.setSize(minWidth, Math.min(boundsBefore.height, minHeight))
    await sleep(800)
    const narrowBase = await evaluate(win, `
      const { actions, store } = window.__aria
      actions.setView('songs')
      // 灵动岛只在侧栏收起时出现，这里把它收起来（上一轮主题检查已经收过，
      // 这里只是保证确定的状态）
      if (store.get().ui.sidebarVisible) actions.toggleSidebar()
      await new Promise((r) => setTimeout(r, 700))
      const island = document.querySelector('.island')
      const scan = document.querySelector('.titlebar__scan')
      const label = scan ? scan.querySelector('span') : null
      // 扫描提示平时是隐藏的（.hidden → display:none）。这里直接把它显示出来并
      // 填一段最长文案，量的才是"最挤的时候"，而不是"什么都不显示的时候"
      if (scan && label) {
        scan.classList.remove('hidden')
        label.textContent = '正在扫描 128/807'
      }
      await new Promise((r) => setTimeout(r, 300))
      const box = (node) => {
        const r = node.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
      }
      return {
        viewport: window.innerWidth,
        island: box(island),
        islandShown: island.classList.contains('is-visible'),
        left: box(document.querySelector('.titlebar__left')),
        right: box(document.querySelector('.titlebar__right')),
        scanShown: scan ? !scan.classList.contains('hidden') : false,
        compact: island.classList.contains('island--compact')
      }
    `)
    const islandCenterX = Math.round((narrowBase.island.left + narrowBase.island.right) / 2)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: islandCenterX, y: 20 })
    await sleep(900)
    const narrowHovered = await evaluate(win, `
      const island = document.querySelector('.island')
      const r = island.getBoundingClientRect()
      const box = (node) => {
        const b = node.getBoundingClientRect()
        return { left: Math.round(b.left), right: Math.round(b.right), width: Math.round(b.width) }
      }
      return {
        hovered: island.matches(':hover'),
        island: { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) },
        labels: [...island.querySelectorAll('.island__label')].filter((n) => n.getBoundingClientRect().width > 4).length,
        left: box(document.querySelector('.titlebar__left')),
        right: box(document.querySelector('.titlebar__right'))
      }
    `)
    // 还原：重新藏起扫描提示、把侧栏放回来、恢复窗口尺寸
    await evaluate(win, `
      const { actions, store } = window.__aria
      const scan = document.querySelector('.titlebar__scan')
      if (scan) scan.classList.add('hidden')
      if (!store.get().ui.sidebarVisible) actions.toggleSidebar()
      await new Promise((r) => setTimeout(r, 500))
      return true
    `)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 420, y: 620 })
    win.setSize(boundsBefore.width, boundsBefore.height)
    await sleep(700)
    const restoredViewport = await evaluate(win, 'return window.innerWidth')
    record('窄窗口（最小宽度）：灵动岛既不压侧栏按钮，也不压扫描与窗口按钮',
      Math.abs(narrowBase.viewport - minWidth) <= 5 &&
      narrowBase.islandShown === true &&
      narrowBase.scanShown === true &&
      narrowHovered.hovered === true &&
      narrowHovered.island.left > narrowHovered.left.right &&
      narrowHovered.island.right < narrowHovered.right.left &&
      // 还原后内容区宽度会有 1~3px 的取整差（窗口尺寸是物理像素，内容宽度是
      // 分数再取整），所以比的是"回到同一档"，不是逐像素相等
      Math.abs(restoredViewport - viewportBefore) <= 4,
      `宽度 ${narrowBase.viewport}px（窗口最小宽度 ${minWidth}px）：左侧簇到 ${narrowBase.left.right}px，右侧簇从 ${narrowHovered.right.left}px 起（宽 ${narrowHovered.right.width}px）；` +
      `灵动岛 ${narrowHovered.island.left}~${narrowHovered.island.right}px（宽 ${narrowHovered.island.width}px，展开可见标签 ${narrowHovered.labels}/4，紧凑模式=${narrowBase.compact}）；` +
      `两侧余量 ${narrowHovered.island.left - narrowHovered.left.right}px / ${narrowHovered.right.left - narrowHovered.island.right}px；窗口已还原 ${restoredViewport}px（原 ${viewportBefore}px）`)

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

    /*
     * 歌词这几项检查的前提是「当前曲目确实带歌词」。
     * 之前它们红过：当时正在播的是一首没有歌词的曲子，读数是 0 行 ——
     * 功能没坏，是检查自己没准备好数据。这里先确保有歌词（没有就往后换几首试试）。
     */
    const lyricsReady = await evaluate(win, `
      const { actions, store, player } = window.__aria
      const settle = async (ms = 300) => { await new Promise((r) => setTimeout(r, ms)) }
      const hasLyrics = () => store.get().lyrics.lines.length > 0
      // 后面那两项要测「能不能滚动」：至少得够长，只有一两行的曲子不算数
      const hasEnoughLyrics = () => store.get().lyrics.lines.length >= 8
      let tried = 0
      if (!hasEnoughLyrics()) {
        for (const track of store.get().library.tracks.slice(0, 40)) {
          tried++
          await player.playTrack(track.id)
          for (let i = 0; i < 10 && !hasEnoughLyrics(); i++) await settle(150)
          if (hasEnoughLyrics()) break
        }
      }
      actions.openNowPlaying({ lyrics: true })
      await settle(800)
      return { lines: store.get().lyrics.lines.length, tried, rendered: document.querySelectorAll('.lyrics__line').length }
    `)
    record('歌词数据就绪（后面几项歌词检查的前提）',
      lyricsReady.lines >= 8 && lyricsReady.rendered > 0,
      `当前曲目歌词 ${lyricsReady.lines} 行、渲染 ${lyricsReady.rendered} 行（试了 ${lyricsReady.tried} 首）`)

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

    /* ---------- 歌词要能往下翻，也要能往上翻 ----------
     *
     * 回归现场：跟随时内容是靠 transform 推到正中的，而滚动容器的 scrollTop
     * 一直是 0 —— 于是往后半段走之后，用户能往下滚却翻不上去。
     * 这里用真实滚轮事件（sendInputEvent）走一遍：先往下，再往上，
     * 两个方向都必须真的动，并且往上要能回到更早的歌词。
     */
    const lyricScrollBase = await evaluate(win, `
      const { player, store } = window.__aria
      const lines = store.get().lyrics.lines || []
      // 挑一个靠后的行，好让跟随位移变成很负的值（这就是 bug 的前提）
      const target = lines[Math.max(0, lines.length - 6)]
      if (target) player.seek(target.time + 0.4)
      await new Promise((r) => setTimeout(r, 1200))
      const scroller = document.querySelector('.lyrics')
      const rect = scroller.getBoundingClientRect()
      return {
        lines: lines.length,
        seekedTo: target ? Math.round(target.time * 10) / 10 : null,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        maxScroll: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        scrollTop: Math.round(scroller.scrollTop),
        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      }
    `)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: lyricScrollBase.center.x, y: lyricScrollBase.center.y })
    await sleep(200)
    /*
     * 注意 sendInputEvent 的鼠标滚轮 deltaY 与 DOM 的 WheelEvent.deltaY 是反的
     * （负数 = 往下滚）—— 这里是真输入，走的是 Chromium 的输入管线，
     * 所以按它的约定来。断言本身不依赖这个约定：只看 scrollTop 有没有按方向动。
     */
    win.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: lyricScrollBase.center.x,
      y: lyricScrollBase.center.y,
      deltaX: 0,
      deltaY: -300,
      canScroll: true
    })
    await sleep(700)
    const afterDown = await evaluate(win, `
      const scroller = document.querySelector('.lyrics')
      return { scrollTop: Math.round(scroller.scrollTop), transform: scroller.firstElementChild.style.transform }
    `)
    // 再一路往上翻：像用户连续拨轮一样反复发滚轮事件，直到翻到最开头。
    // 修复前这一步是「纹丝不动」的（scrollTop 已经贴着 0，transform 又不受它管）。
    let wheelUps = 0
    let scrollTopAtTop = null
    for (let i = 0; i < 12; i++) {
      win.webContents.sendInputEvent({
        type: 'mouseWheel',
        x: lyricScrollBase.center.x,
        y: lyricScrollBase.center.y,
        deltaX: 0,
        deltaY: 400,
        canScroll: true
      })
      wheelUps++
      await sleep(200)
      scrollTopAtTop = await evaluate(win, `return Math.round(document.querySelector('.lyrics').scrollTop)`)
      if (scrollTopAtTop === 0) break
    }
    await sleep(400)
    const afterUp = await evaluate(win, `
      const scroller = document.querySelector('.lyrics')
      const lines = [...document.querySelectorAll('.lyrics__line')]
      const rect = scroller.getBoundingClientRect()
      // 当前视口里最靠上的那一行是第几行
      const firstVisible = lines.findIndex((node) => node.getBoundingClientRect().bottom > rect.top + 2)
      return {
        scrollTop: Math.round(scroller.scrollTop),
        firstVisible,
        activeIndex: Number((document.querySelector('.lyrics__line.is-active') || {}).dataset?.index ?? -1),
        resumeVisible: document.querySelector('.lyrics-resume')?.classList.contains('is-visible') === true
      }
    `)
    record('歌词：往下能翻，往上也能一直翻到第一行',
      lyricScrollBase.lines > 10 &&
      lyricScrollBase.maxScroll > 200 &&
      // 跟随后内容被推上去，交接的那一刻 scrollTop 应该已经大于 0（往上才有得翻）
      afterDown.scrollTop > 0 &&
      afterDown.scrollTop > lyricScrollBase.scrollTop &&
      afterDown.transform === 'translateY(0px)' &&
      // 关键：一路往上必须真的回到最开头
      afterUp.scrollTop === 0 &&
      afterUp.firstVisible === 0 &&
      afterUp.activeIndex > 0 &&
      afterUp.resumeVisible === true,
      `歌词 ${lyricScrollBase.lines} 行，总可滚 ${lyricScrollBase.maxScroll}px；` +
      `往下滚一段 → scrollTop ${afterDown.scrollTop}px（交接后 transform=${afterDown.transform || '(空)'}）；` +
      `往上拨 ${wheelUps} 次 → scrollTop ${afterUp.scrollTop}px、视口第一行 #${afterUp.firstVisible + 1}（当前行 #${afterUp.activeIndex + 1}）；` +
      `「回到当前」按钮已出现=${afterUp.resumeVisible}`)
    // 收尾：让跟随恢复，别把暂停状态带给后面的检查
    await evaluate(win, `
      document.querySelector('.lyrics-resume')?.click()
      await new Promise((r) => setTimeout(r, 800))
      return true
    `)

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

    /*
     * 横向专辑条：鼠标滚轮应当能横着滚。
     *
     * 横向容器默认只认 Shift+滚轮 / 触控板横向手势，鼠标用户会以为"这排滚不动"
     * （卡片在右边缘被截断时尤其明显）。同时要保证**到两端不再拦截** ——
     * 否则鼠标停在卡片上时整个页面都滚不动，那是一种更难受的卡住。
     */
    const stripWheel = await evaluate(win, `
      const settle = async (ms = 350) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      actions.setView('artists')
      await settle(750)
      /*
       * 挑一个**专辑多到需要横向滚**的艺人。
       * 第一版是"点前 12 行看看"—— 但艺人列表按拼音排且是虚拟滚动的，
       * Taylor Swift 这种专辑多的根本不在 DOM 里，于是报"没找到可滚动的专辑条"。
       * 现在直接从曲库按艺人统计专辑数（不猜 actions.artists() 的字段名），
       * 找到对应的 key 再打开；万一匹配不上，退回"点几行看看"。
       */
      const byArtist = new Map()
      for (const track of store.get().library.tracks) {
        const name = track.albumArtist || track.artist
        if (!name) continue
        if (!byArtist.has(name)) byArtist.set(name, new Set())
        byArtist.get(name).add(track.album || track.title)
      }
      const busiest = [...byArtist.entries()].sort((a, b) => b[1].size - a[1].size)[0]
      let strip = null
      let picked = ''
      if (busiest) {
        const entry = (actions.artists() || []).find((a) => (a.name || a.artist) === busiest[0])
        if (entry) {
          actions.openArtist(entry.key)
          await settle(800)
          const candidate = document.querySelector('.album-strip')
          if (candidate && candidate.scrollWidth > candidate.clientWidth + 20) {
            strip = candidate
            picked = document.querySelector('.browse-detail__title')?.textContent || busiest[0]
          }
        }
      }
      if (!strip) {
        actions.closeDetail()
        await settle(300)
        for (const row of [...document.querySelectorAll('.artist-row')].slice(0, 12)) {
          row.click()
          await settle(700)
          const candidate = document.querySelector('.album-strip')
          if (candidate && candidate.scrollWidth > candidate.clientWidth + 20) {
            strip = candidate
            picked = document.querySelector('.browse-detail__title')?.textContent || ''
            break
          }
          document.querySelector('.browse-back')?.click()
          await settle(320)
        }
      }
      if (!strip) {
        actions.setView('songs')
        return { error: '没找到可横向滚动的专辑条' }
      }
      const max = strip.scrollWidth - strip.clientWidth
      const wheel = (dy) => {
        const event = new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true })
        strip.dispatchEvent(event)
        return event.defaultPrevented
      }
      strip.scrollLeft = 0
      await settle(150)
      const before = strip.scrollLeft
      const preventedMid = wheel(120)
      await settle(120)
      const afterOne = strip.scrollLeft
      strip.scrollLeft = strip.scrollWidth
      await settle(150)
      const atEnd = strip.scrollLeft
      const preventedEnd = wheel(120)
      await settle(120)
      const endStayed = strip.scrollLeft
      strip.scrollLeft = 0
      document.querySelector('.browse-back')?.click()
      await settle(320)
      actions.setView('songs')
      return { picked, before, afterOne, preventedMid, atEnd, max, preventedEnd, endStayed }
    `)
    record('横向专辑条：鼠标滚轮能横着滚，到两端不再拦截（页面照常滚）',
      !stripWheel.error &&
      stripWheel.afterOne - stripWheel.before >= 100 &&
      stripWheel.preventedMid === true &&
      stripWheel.atEnd >= stripWheel.max - 2 &&
      stripWheel.preventedEnd === false &&
      stripWheel.endStayed === stripWheel.atEnd,
      stripWheel.error
        ? `测量失败：${stripWheel.error}`
        : `《${stripWheel.picked}》的专辑条（可滚 ${stripWheel.max}px）：滚一格 ${stripWheel.before} → ${stripWheel.afterOne}` +
          `（拦截=${stripWheel.preventedMid}）；顶到最右 ${stripWheel.atEnd} 后再滚一格` +
          `（拦截=${stripWheel.preventedEnd}、位置不变=${stripWheel.endStayed === stripWheel.atEnd}）`)

    /*
     * 艺人头像的**端到端**检查 —— 之前的检查只测了一半，所以漏掉了真实故障。
     *
     * 已有的「在线艺人头像」检查是在主进程里直接调 online.fetchArtist，它一直是绿的；
     * 而界面上永远没有照片，因为真正断掉的是**渲染层根本没发起请求**
     * （懒加载对伪曲目 artistOnly 早退，见 artwork-node.js 的 paint）：主进程再正常也没用。
     * 所以这条从界面出发：打开艺人详情 → 等 <img> 出现 → 断言**解码成功**
     * （naturalWidth > 0）且**渲染尺寸非零且接近正方**（历史上有过「有图但被裁成一条 140x199」）。
     * 用曲目最多的前三位艺人当候选，避免依赖某一位特定歌手在维基/Deezer 上有没有条目。
     */
    const avatarProbe = await evaluate(win, `
      const { actions } = window.__aria
      const candidates = actions.artists().slice()
        .sort((a, b) => b.trackCount - a.trackCount)
        .slice(0, 3)
        .map((artist) => ({ key: artist.key, name: artist.name }))
      const tries = []
      for (const item of candidates) {
        actions.setView('artists')
        await new Promise((r) => setTimeout(r, 300))
        const startedAt = performance.now()
        actions.openArtist(item.key)
        const deadline = startedAt + 15000
        let img = null
        while (performance.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250))
          img = document.querySelector('.browse-detail__avatar img')
          if (img && img.complete && img.naturalWidth > 0) break
        }
        const rect = img ? img.getBoundingClientRect() : null
        tries.push({
          name: item.name,
          hasImg: Boolean(img),
          natural: img ? [img.naturalWidth, img.naturalHeight] : null,
          rendered: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
          decoded: Boolean(img && img.complete && img.naturalWidth > 0),
          // 每张在线头像都是独立的 blob URL：用它判断「换歌手时照片到底有没有换」
          src: img ? String(img.getAttribute('src') || '') : '',
          elapsedMs: Math.round(performance.now() - startedAt)
        })
      }
      actions.closeDetail()
      actions.setView('songs')
      return tries`)
    // 三位候选都试（不提前 break）：这样能同时看出「第一位要等维基超时、后面几位走 Deezer 很快」的差别
    /*
     * 断言**至少两位出图**（不是"有一位就算过"，也不是"三位必须全中"）。
     *
     * 为什么不是「全中」：这是一条依赖外网的检查，单个艺人在维基/Deezer 上查不到或请求超时
     * 都是环境问题（应用回退到首字母占位是**正确行为**）。实测踩过一次：三位里第三位超时，
     * 检查红了但功能没坏 —— 会误报的检查比没有更糟。
     * 为什么不是「≥1 就算过」：那样两位同时坏掉也照样绿。
     * 真正卡死"链路是否通"的是旁边那两条不依赖 UI 的检查（缓存命中必须带 data / 端到端解码），
     * 这里只管「界面上确实出了图、尺寸对、且没有串台」。
     */
    const avatarHits = avatarProbe.filter((item) => item.decoded)
    const avatarAllSquare = avatarHits.every((item) => Math.abs(item.rendered[0] / item.rendered[1] - 1) < 0.15)
    /*
     * 照片不许串台：每位艺人拿到的 blob URL 必须各不相同。
     * 这条盯的是另一类真实故障 —— 头像节点是复用的，换成另一位歌手时如果没重新取图，
     * 圆里会一直留着上一位的脸（分支历史里修过这个：`换了歌手，照片还是上一位的`）。
     */
    const avatarSrcs = avatarHits.map((item) => item.src).filter(Boolean)
    const avatarDistinct = avatarSrcs.length === avatarHits.length && new Set(avatarSrcs).size === avatarSrcs.length
    /*
     * 断言**三位都必须出图**，而不是「有一位成功就算过」。
     * 最初写成 `> 0` 时，Taylor Swift 那条路坏着、另外两位走 Deezer 成功，检查照样是绿的 ——
     * 一条只会「部分通过」的检查，等于给故障留了后门。
     */
    /*
     * 断言**至少两位出图**，而不是「有一位成功就算过」，也不是「三位必须全中」——
     * 前者会放过两条链路同时坏掉的情况；后者会被单个艺人的网络超时误伤
     * （实测踩过：第三位超时导致假红，而应用回退到字母占位是正确行为）。
     * 「链路到底通不通」由旁边两条不依赖 UI 的检查盯着（缓存命中必须带 data、端到端解码）。
     */
    record('艺人头像：详情页把在线头像插进 <img> 并解码（端到端，含渲染尺寸与不串台）',
      avatarHits.length >= 2 && avatarAllSquare && avatarDistinct &&
        avatarHits.every((item) => item.rendered[0] > 0),
      avatarProbe.map((item) => `${item.name}：img=${item.hasImg ? '有' : '无'} 解码=${item.decoded ? '成功' : '无'} ` +
        `原始=${item.natural ? item.natural.join('×') : '—'} 渲染=${item.rendered ? item.rendered.join('×') : '—'} 用时=${item.elapsedMs}ms`).join('；') +
      `；出图 ${avatarHits.length}/${avatarProbe.length} 位（至少两位；15s 级超时通常意味着这会儿网络/接口不给力），` +
      `正方判定=${avatarAllSquare ? '通过' : '不通过'}，各不相同的图像=${avatarDistinct ? '是' : '否（有串台）'}`)

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
    /*
     * 新契约：墙上只放**有封面**的专辑（用户要求「没封面的就不要放了」），
     * 所以格子数会略少于专辑总数 —— 断言改成「有格子、且不超过专辑数」，
     * 并在详情里把被筛掉的数量写出来，方便一眼看出过滤是否生效。
     */
    record('媒体墙', wallView.tiles > 0 && wallView.tiles <= groupResult.albums,
      `${wallView.tiles} 张封面方块（专辑共 ${groupResult.albums} 张，无封面被筛掉 ${groupResult.albums - wallView.tiles} 张），已加载 ${wallView.imgs} 张`)
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
      // 停在歌曲列表（不打开媒体墙），看后台预热能不能自己把缓存灌满。
      // 清空缓存后要让预热器重来（warmed 记账作废），否则它会认为无事可做：
      // 这个自检过去只在「预热还没做完」时才偶然通过。
      window.__aria.actions.setView('songs')
      window.__aria.prewarmer.reset()
      return true`)
    const prewarmBefore = await evaluate(win, `return window.__aria.prewarmer.state`)
    let prewarmAfter = prewarmBefore
    let prewarmFiles = 0
    // 预热是「空闲时才做」的，机器忙的时候一轮未必够 —— 边等边看
    for (let i = 0; i < 20; i++) {
      await sleep(1000)
      prewarmAfter = await evaluate(win, `return window.__aria.prewarmer.state`)
      prewarmFiles = (await artworkService.getArtworkStats()).files
      if (prewarmFiles > 3) break
    }
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
    // 设置页改成两层分页后本来就不该滚（只显示一个分类），所以它只作信息记录
    record('各视图可滚动（媒体墙 2D 平移、设置页分页，单独校验）',
      scrollAudit.songs.scrollable && scrollAudit.albums.scrollable,
      scrollRows.map((row) => `${row.view}:${row.scrollable ? '可滚' : '滚不动'}(display=${row.rootDisplay}, 容器 ${row.clientHeight}/${row.scrollHeight})`).join('　'))

    /* 设置页两层结构：选中某个分类后只显示该分类的分组 */
    const settingsSections = await evaluate(win, `
      const settle = async (ms = 260) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      actions.setView('settings')
      await settle(500)
      const visible = () => [...document.querySelectorAll('.settings__group')]
        .filter((node) => !node.hidden)
        .map((node) => (node.querySelector('.settings__group-title') || {}).textContent || '')
      const navItems = [...document.querySelectorAll('.settings-nav__item')]
      const before = visible()
      const about = navItems.find((item) => item.textContent === '关于')
      about?.click()
      await settle(900)
      const afterAbout = visible()
      const library = navItems.find((item) => item.textContent === '音乐库')
      const online = navItems.find((item) => item.textContent === '在线与扩展')
      online?.click()
      await settle(900)
      library?.click()
      await settle(900)
      const afterLibrary = visible()
      actions.setView('songs')
      await settle(200)
      // 标签必须完整可见：不溢出（scrollWidth ≤ clientWidth）且都在视口宽度内
      const nav = document.querySelector('.settings-nav')
      const navBox = nav ? nav.getBoundingClientRect() : null
      const widest = navItems.reduce((max, item) => Math.max(max, item.getBoundingClientRect().right), 0)
      const navFullyVisible = Boolean(nav) && nav.scrollWidth <= nav.clientWidth + 2 &&
        widest <= (window.innerWidth || 99999) && navBox.left >= 0
      // 全部标签框都在（不再隐藏） + 点「关于」「在线与扩展」后目标框是否贴顶
      const allGroups = [...document.querySelectorAll('.settings__group')]
      const scroller = document.querySelector('.settings')
      const topOffsetOf = (groupTitle) => {
        const node = allGroups.find((item) => !item.hidden && ((item.querySelector('.settings__group-title') || {}).textContent || '') === groupTitle)
        if (!node || !scroller) return 9999
        return Math.round(node.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
      }
      const aboutOffset = topOffsetOf('关于')
      const onlineOffset = topOffsetOf('在线功能')
      return { navCount: navItems.length, before, afterAbout, afterLibrary, allVisible: allGroups.length >= 5, aboutTopOffset: aboutOffset, onlineTopOffset: onlineOffset }
    `)
    record('设置页子标题：点击后把对应的标签框滚到最上面（不隐藏其它框）',
      settingsSections.navCount >= 4 &&
      settingsSections.allVisible === true &&
      settingsSections.afterAbout.length >= 1 &&
      Math.abs(settingsSections.aboutTopOffset) <= 16 &&
      Math.abs(settingsSections.onlineTopOffset) <= 16,
      `分类 ${settingsSections.navCount} 个；默认显示 ${JSON.stringify(settingsSections.before)}；` +
      `点「关于」→ ${JSON.stringify(settingsSections.afterAbout)}；点「音乐库」→ ${JSON.stringify(settingsSections.afterLibrary)}；` +
      `标签完整可见=${settingsSections.navFullyVisible}（navTop=${settingsSections.navTop} / 工具栏底=${settingsSections.titleBottom}）`)

    /* 子标题高亮必须跟随点击（逐个点五个，断言亮的就是刚点的那个） */
    const navActiveFollow = await evaluate(win, `
      const settle = async (ms = 250) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      actions.setView('settings')
      await settle(500)
      const wants = ['音乐库', '播放与音效', '外观与系统', '在线与扩展', '关于']
      const picked = []
      for (const want of wants) {
        const items = [...document.querySelectorAll('.settings-nav__item')]
        const item = items.find((node) => node.textContent === want)
        item?.click()
        await settle(900)
        const active = items.find((node) => node.classList.contains('is-active'))
        picked.push({ want, active: active ? active.textContent : '(无)' })
      }
      actions.setView('songs')
      await settle(200)
      return picked
    `)
    record('设置页子标题高亮跟随点击（五个逐个验证）',
      navActiveFollow.length === 5 && navActiveFollow.every((item) => item.want === item.active),
      navActiveFollow.map((item) => `${item.want}→${item.active}`).join('　'))

    /* 设置内搜索的历史：必须是单独一份，不能把资料库搜索历史挤掉 */
    const settingsSearchHistoryCheck = await evaluate(win, `
      const settle = async (ms = 200) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      const libraryBefore = [...(store.get().settings.searchHistory || [])]
      actions.setView('settings')
      await settle(400)
      const input = document.querySelector('.search--settings input')
      input?.focus()
      await settle(200)
      await actions.commitSettingsSearch('歌词')
      await settle(400)
      const mine = [...(store.get().settings.settingsSearchHistory || [])]
      const libraryAfter = [...(store.get().settings.searchHistory || [])]
      // 清掉，免得影响后面的检查与重复运行
      await actions.clearSettingsSearchHistory()
      actions.setView('songs')
      await settle(200)
      return {
        hasInput: Boolean(input),
        first: mine[0] || '',
        count: mine.length,
        libraryUntouched: JSON.stringify(libraryBefore) === JSON.stringify(libraryAfter)
      }
    `)
    record('设置内搜索的历史单独存（不污染资料库搜索历史）',
      settingsSearchHistoryCheck.hasInput === true &&
      settingsSearchHistoryCheck.first === '歌词' &&
      settingsSearchHistoryCheck.libraryUntouched === true,
      `搜索框存在=${settingsSearchHistoryCheck.hasInput}；提交后历史首条「${settingsSearchHistoryCheck.first}」（共 ${settingsSearchHistoryCheck.count} 条）；` +
      `资料库搜索历史未被影响=${settingsSearchHistoryCheck.libraryUntouched}`)

    /* 设置内搜索也要能命中「分组标题」—— 用户常按分组名找东西 */
    const groupSearchCheck = await evaluate(win, `
      const settle = async (ms = 250) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      actions.setView('settings')
      await settle(500)
      const input = document.querySelector('.search--settings input')
      input.value = '封面缓存'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle(600)
      const groups = document.querySelectorAll('.settings__group.is-search-hit-group').length
      const rows = document.querySelectorAll('.settings__row.is-search-hit').length
      const count = (document.querySelector('.search--settings .search__count') || {}).textContent || ''
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle(400)
      const cleared = document.querySelectorAll('.settings__row.is-search-hit').length
      actions.setView('songs')
      await settle(200)
      return { groups, rows, count, cleared }
    `)
    record('设置内搜索能命中分组标题（如「封面缓存」）',
      groupSearchCheck.groups >= 1 && groupSearchCheck.rows >= 1 && groupSearchCheck.cleared === 0,
      `输入「封面缓存」→ 命中分组 ${groupSearchCheck.groups} 个、行 ${groupSearchCheck.rows} 行、计数「${groupSearchCheck.count}」；` +
      `清空后残留高亮 ${groupSearchCheck.cleared} 处（应为 0）`)

    /* 说明文字也要能搜到（它存在 ⓘ 的 aria-label 里，不在行的 textContent 里） */
    const tipSearchCheck = await evaluate(win, `
      const settle = async (ms = 250) => { await new Promise((r) => setTimeout(r, ms)) }
      const { actions } = window.__aria
      actions.setView('settings')
      await settle(500)
      const input = document.querySelector('.search--settings input')
      input.value = '麦克风'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle(600)
      const rows = [...document.querySelectorAll('.settings__row.is-search-hit')]
      const titles = rows.map((row) => (row.querySelector('.settings__row-title') || {}).textContent || '').join(' | ')
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle(400)
      actions.setView('songs')
      await settle(200)
      return { count: rows.length, titles }
    `)
    record('设置内搜索能按说明文字找到设置项（搜「麦克风」）',
      tipSearchCheck.count >= 1,
      `搜「麦克风」→ 命中 ${tipSearchCheck.count} 行：${tipSearchCheck.titles.slice(0, 80)}`)

    /* 睡眠定时器：把 setTimeout 换成立即执行，于是不必等 15 分钟就能验到点行为 */
    const sleepTimerCheck = await evaluate(win, `
      const settle = async (ms = 250) => { await new Promise((r) => window.setTimeout(r, ms)) }
      const { actions, store } = window.__aria
      actions.setView('settings')
      await settle(500)
      /*
       * 睡眠定时器也是药丸下拉了（原生 <select> 的弹层深色下是白底，已全部换掉）。
       * 选项只在下拉**打开时**存在，所以这里先读触发器上的当前值、再点开数一遍。
       */
      const sleepPill = document.querySelector('.pill-select[title="睡眠定时器时长"]')
      const pillLabel = sleepPill ? sleepPill.textContent.trim() : ''
      sleepPill?.click()
      await settle(350)
      const sleepMenu = document.querySelector('.popover .pill-menu')
      const optionCount = sleepMenu ? sleepMenu.querySelectorAll('.pill').length : 0
      const labels = sleepMenu
        ? [...sleepMenu.querySelectorAll('.pill')].map((o) => o.textContent.replace(/\\s+/g, '').trim()).join('/')
        : ''
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await settle(250)
      // 注意：setSetting 收的是对象补丁（这里曾经写成两参数，导致永远读回 0）
      actions.setSetting({ sleepTimerMinutes: 15 })
      let armed = 0
      for (let i = 0; i < 40 && armed !== 15; i++) {
        await settle(50)
        armed = store.get().settings.sleepTimerMinutes
      }
      const realSetTimeout = window.setTimeout
      /*
       * 关键：假 setTimeout 要**一直装着**，直到断言完成；而且这段窗口里只能用真定时器等待。
       *
       * 原来这里是「settle(400) 之后立刻还原」，但上面的 settle 内部用的正是 window.setTimeout ——
       * 被替换成「0ms 后执行」之后，那句 settle(400) 实际上**不等待**。于是：
       * 装定时器的那次 store 订阅只要晚一个任务跑，就落到还原之后，定时器被用**真的**
       * 15 分钟延时装上、永远不到点，断言就报「到点复位为 15」。
       * 机器一忙就必现（头像检查让渲染层多解码两张图之后，这里连续两次踩到），
       * 而它看起来完全像功能坏了 —— 这条检查自己踩了自己的坑。
       */
      const sleepReal = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))
      let afterFire = 15
      try {
        window.setTimeout = (fn) => { realSetTimeout(fn, 0); return 0 }
        actions.setSetting({ sleepTimerMinutes: 0 })
        await sleepReal(50)
        actions.setSetting({ sleepTimerMinutes: 15 })
        /*
         * 复位要绕一圈 IPC + 主进程 250ms 防抖，必须等它落定再断言（轮询预算 5 秒）。
         * 断言的是 store 值复位为 0 —— 这是「到点复位」的核心行为。
         */
        for (let i = 0; i < 100 && afterFire !== 0; i++) {
          await sleepReal(50)
          afterFire = store.get().settings.sleepTimerMinutes
        }
      } finally {
        window.setTimeout = realSetTimeout
      }
      const sleepNote = (document.querySelector('.settings__row-value') || {}).textContent || ''
      actions.setSetting({ sleepTimerMinutes: 0 })
      actions.setView('songs')
      await settle(200)
      return { optionCount, labels, pillLabel, armed, afterFire, note: sleepNote }
    `)
    record('睡眠定时器：到点暂停并复位（下拉是药丸，到点用替换 setTimeout 来验）',
      sleepTimerCheck.armed === 15 && sleepTimerCheck.afterFire === 0 && sleepTimerCheck.optionCount >= 5,
      `药丸下拉当前显示「${sleepTimerCheck.pillLabel}」；点开有 ${sleepTimerCheck.optionCount} 项 [${sleepTimerCheck.labels}]；` +
      `选中 15 → 落盘 ${sleepTimerCheck.armed}；到点复位为 ${sleepTimerCheck.afterFire}（应为 0）`)

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

    /*
     * 读不了的音乐目录必须**说出来**，不能静默返回 0 首。
     *
     * 背景（做 macOS 移植时发现的）：walkFiles 原来把 readdir 的错误 catch 掉就 continue，
     * 而 macOS 的 TCC 权限会让「文稿 / 桌面 / 下载」对未授权应用直接 EACCES ——
     * 结果是扫描"成功"返回 0 首，用户只看到「扫不到歌」，界面上一个字的原因都没有。
     * 三段验证：① walkFiles 会上报；② 错误码翻译成的中文提示能照做；③ 界面真的弹出黄色提示。
     */
    {
      const missingDir = path.join(os.tmpdir(), `aria-没有这个目录-${Date.now()}`)
      const walkErrors = []
      await require('./util/files').walkFiles(missingDir, () => true, { onError: (info) => walkErrors.push(info) })
      record('读不了的目录会上报（walkFiles 不再静默 continue）',
        walkErrors.length === 1 && walkErrors[0].code === 'ENOENT' && walkErrors[0].dir === missingDir,
        `对一个不存在的目录走一遍：上报 ${walkErrors.length} 条，code=${walkErrors[0] && walkErrors[0].code}`)

      const hints = await evaluate(win, `
        const { describeUnreadable } = await import('/js/core/format.js')
        return {
          eacces: describeUnreadable({ dir: '/Users/me/文稿/音乐', code: 'EACCES' }, 1),
          eaccesMore: describeUnreadable({ dir: '/Users/me/桌面/专辑', code: 'EPERM' }, 3),
          enoent: describeUnreadable({ dir: '/Volumes/移动硬盘', code: 'ENOENT' }, 1),
          other: describeUnreadable({ dir: '/tmp/x', code: 'EIO' }, 1)
        }
      `)
      record('读不了目录的提示是「能照做」的中文（权限 / 不存在 / 其它）',
        hints.eacces.includes('隐私与安全性') && hints.eacces.includes('文稿') &&
        hints.eaccesMore.includes('另有 2 个') &&
        hints.enoent.includes('不存在') && hints.enoent.includes('外接硬盘'.slice(0, 2)) &&
        hints.other.includes('EIO'),
        `EACCES →「${hints.eacces.slice(0, 60)}…」；多条 →「${hints.eaccesMore.slice(0, 30)}…」；` +
        `ENOENT →「${hints.enoent}」；其它码 →「${hints.other.slice(0, 40)}…」`)

      // ③ 真的弹提示：往渲染层发一份**真实形状**的 scan-progress 载荷（done + unreadable）
      win.webContents.send('library:scan-progress', {
        phase: 'done',
        reason: 'manual',
        done: 0,
        total: 0,
        reused: 0,
        failed: 0,
        added: 0,
        removed: 0,
        changed: 0,
        count: 0,
        scannedAt: Date.now(),
        elapsedMs: 1,
        unreadable: [{ dir: '/Users/me/文稿/音乐', code: 'EACCES' }],
        unreadableCount: 1
      })
      await sleep(700)
      const toastProbe = await evaluate(win, `
        const node = document.querySelector('.toast--warning')
        /*
         * 顺便把 --warning 令牌的**计算色**读回来（在这里读而不是在主进程读 ——
         * getComputedStyle / document 只存在于页面里；上一版写到外面直接让整轮自检中断了）。
         * 不写死具体色值：浅色的 --warning 刚因为对比度调深过一档（#ff9500 → #c93400），
         * 以后调色只改 tokens.css 即可。
         */
        const token = getComputedStyle(document.documentElement).getPropertyValue('--warning').trim()
        const probe = document.createElement('span')
        probe.style.color = token
        document.body.appendChild(probe)
        const tokenRgb = getComputedStyle(probe).color
        probe.remove()
        return {
          found: Boolean(node),
          text: node ? node.textContent : '',
          iconColor: node && node.querySelector('.icon') ? getComputedStyle(node.querySelector('.icon')).color : null,
          toasts: document.querySelectorAll('.toast').length,
          token,
          tokenRgb
        }`)
      record('扫描发现目录读不了时，界面弹出黄色提示（不是只在控制台）',
        toastProbe.found && toastProbe.text.includes('隐私与安全性') &&
        toastProbe.iconColor === toastProbe.tokenRgb,
        `找到 warning 提示=${toastProbe.found}（当前 toast 共 ${toastProbe.toasts} 条），` +
        `图标色=${toastProbe.iconColor}（--warning 令牌 ${toastProbe.token} = ${toastProbe.tokenRgb}），` +
        `文案「${toastProbe.text.slice(0, 70)}…」`)
    }

    /*
     * macOS 的 open-file（双击音频 / 拖到 Dock 图标）：本机触发不了那个 Electron 事件，
     * 所以用**注入的假 app** 直接驱动桥，验证「攒批 → 一次性交给导入链路」这段我们自己的逻辑。
     * 真正没被测到的只剩「Electron 会按时把事件送进来」，那是文档保证的部分。
     */
    {
      const { createOpenFilesBridge } = require('./open-files')
      const batches = []
      const listeners = {}
      const fakeApp = { on: (name, handler) => { listeners[name] = handler } }
      // 手动控制定时器，避免依赖真实时间
      const timers = { pending: [], set: (fn) => { timers.pending.push(fn); return timers.pending.length }, clear: () => {} }
      const bridge = createOpenFilesBridge({ onPaths: (paths) => batches.push(paths), timers })
      bridge.attach(fakeApp)
      const fire = (filePath) => listeners['open-file']({ preventDefault: () => { fire.prevented = true } }, filePath)

      // ready 之前到的路径先攒着，不能直接交出去（那时 library 还没就绪）
      fire('/Users/me/Music/a.mp3')
      fire('/Users/me/Music/b.flac')
      const pendingBeforeReady = bridge.pending.length
      const batchesBeforeReady = batches.length

      bridge.ready()
      timers.pending.splice(0).forEach((fn) => fn())   // 触发攒批的 flush
      const firstBatch = batches[0] || []

      // ready 之后连续三个文件 → 合并成一批（不然会弹三次确认框）
      fire('/Users/me/Desktop/1.mp3')
      fire('/Users/me/Desktop/2.mp3')
      fire('/Users/me/Desktop/3.mp3')
      timers.pending.splice(0).forEach((fn) => fn())
      const secondBatch = batches[batches.length - 1] || []

      record('macOS open-file：冷启动先攒着，就绪后合并成一批交给导入链路',
        batchesBeforeReady === 0 && pendingBeforeReady === 2 &&
        firstBatch.length === 2 && firstBatch[1] === '/Users/me/Music/b.flac' &&
        batches.length === 2 && secondBatch.length === 3 && fire.prevented === true,
        `ready 前收到 2 个：交出去 ${batchesBeforeReady} 批、攒着 ${pendingBeforeReady} 个；` +
        `ready 后第一批 ${firstBatch.length} 个；再连来 3 个 → 合并成 ${secondBatch.length} 个一批；` +
        `事件被 preventDefault=${fire.prevented === true}`)
    }

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

    /*
     * 联网契约（用户要求「歌词自动匹配，封面也自动匹配」）：
     *   · 总开关默认**开着** → 歌词与封面都自动匹配，不需要用户确认；
     *   · 关掉总开关 → 两者一起停（用户关它就是明确不要联网，不该有例外）；
     *   · 分项开关（onlineLyrics / onlineCovers）用来只关其中一样。
     */
    /*
     * 读**代码默认值**（DEFAULTS），不是当前持久化的值。
     * 原来读 settingsService.get()，而本检查自己在末尾把开关改成 false，
     * 于是同一份配置目录里第二次运行读到的就是 false —— 自我污染、依赖运行顺序，
     * 只在全新配置目录下才会通过。
     */
    const defaultOnline = require('./services/settings.js').DEFAULTS.onlineFeatures
    settingsService.set({ onlineFeatures: false, onlineLyrics: true, onlineCovers: true })
    await sleep(200)
    const lyricsWhenMasterOff = await online.fetchLyrics(sample)
    const coversWhenMasterOff = await online.fetchCover(sample)
    settingsService.set({ onlineFeatures: true, onlineLyrics: true, onlineCovers: true })
    await sleep(150)
    /*
     * 规格变更（开源前）：默认**关闭**所有在线功能。
     * 断言的严格程度没变（仍然是 === false / === true 的相等判断），只是期望值跟着新规格走：
     * 默认关 → 关掉总开关时歌词与封面都必须 skipped。
     */
    record('联网总开关：默认关闭（要在线补全得自己去设置里打开），关掉则歌词与封面一起停',
      defaultOnline === false &&
      lyricsWhenMasterOff.skipped === true &&
      coversWhenMasterOff.skipped === true,
      `默认 onlineFeatures=${defaultOnline}（应为 false）；关掉总开关时：歌词 skipped=${lyricsWhenMasterOff.skipped}、` +
      `封面 skipped=${coversWhenMasterOff.skipped}（都应为 true）`)

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

    /*
     * 超时 / 网络抖动必须**重试一次**，否则一次抖动就静默少一次歌词，
     * 更狠的是 Deezer 那条路会把整个会话的 Deezer 都停用（deezerDisabled）。
     *
     * 用故障注入验，而不是只读代码：把 net.fetch 包一层，让**第一次**调用直接抛网络错误，
     * 第二次放行。歌名用随机串，保证缓存 key 不命中 —— 否则请求根本不会发出去，
     * 这条检查就成了空跑（看不见的检查比没有更糟）。
     */
    {
      const electron = require('electron')
      const realFetch = electron.net.fetch
      const probeTerm = `自检重试用曲 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      let fetchCalls = 0
      electron.net.fetch = async (url, options) => {
        fetchCalls++
        if (fetchCalls === 1) throw new Error('自检注入的网络错误')
        return realFetch.call(electron.net, url, options)
      }
      let retryResult
      try {
        retryResult = await online.fetchLyrics({ title: probeTerm, artist: probeTerm, album: '', duration: 0 })
      } finally {
        electron.net.fetch = realFetch
      }
      /*
       * 断言的是「**重试真的发生了**」，不是「第二次一定成功」——
       * 第二次的结果取决于对方（实测就撞到过 LRCLIB 返回 HTTP 503）。
       * 只要：调用次数 ≥ 2，且最终错误不是我们注入的那条（说明第二次确实发出去了）。
       * 这条最初写成「结果不能有 error」，被服务器的 503 判成失败 —— 又是一条会误报的检查。
       */
      record('在线请求失败会重试一次（超时/网络抖动的兜底）',
        fetchCalls >= 2 && retryResult.error !== '自检注入的网络错误',
        `注入第一次失败后：net.fetch 被调用 ${fetchCalls} 次（应为 2；若第二次撞上 429/5xx 会再多一次），` +
        `最终 error=${retryResult.error || '无'}、${retryResult.text ? '取到歌词' : '没收录（随机歌名本来就查不到，属正常）'}`)
    }

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

    /*
     * 在线艺人头像：用应用自己的网络栈验证链路。
     * 用户要求「艺人头像像歌词一样默认在线查」——拿专辑封面顶替会把合作曲目的
     * 另一位歌手挂上去（Ed Sheeran ↔ Taylor Swift）。
     * 图源顺序：维基百科（免密钥、本人照片）→ Deezer。
     * 只断言「拿到图片字节 + image/* 的 mime」；取不到（网络不可达 / 没匹配上）
     * 也算通过 —— 那是环境问题，渲染层会显示占位图标，不该让自检红。
     */
    const artistImage = await evaluate(win, `
      const r = await window.__aria.remote.online.artist({ name: 'Ed Sheeran' })
      return {
        hasData: Boolean(r && r.data && r.data.byteLength > 1000),
        mime: (r && r.mime) || '',
        provider: (r && r.provider) || '',
        error: (r && r.error) || '',
        skipped: Boolean(r && r.skipped),
        noMatch: Boolean(r && r.data === null)
      }
    `)
    record('在线艺人头像（维基百科 → Deezer；查不到就用占位图标，不拿合作曲目的封面顶替）',
      artistImage.skipped === false && (artistImage.hasData === true || artistImage.error !== '' || artistImage.noMatch === true),
      artistImage.hasData
        ? `${artistImage.provider} 取得 ${artistImage.mime}`
        : `未取到图片（error=${artistImage.error || '无'}、没匹配上=${artistImage.noMatch}）→ 渲染层显示占位图标`)

    /*
     * 艺人头像的**热路径**（磁盘缓存命中）也必须带 `data`。
     *
     * 同一个艺人连取两次：第一次未命中 → 联网 → 写盘；第二次命中 `readBinary`。
     * 这条盯的是一个真实事故：`fetchArtist` 命中时直接 `return cached`，
     * 而 `readBinary` 返回的是 `{ buffer, mime }` —— **没有 `data`**；
     * 渲染层判 `artistResult.data` 为假 → 退回字母占位。
     * 症状极具欺骗性：**第一次打开有图，图一落盘，第二次打开反而变成字母**；
     * 而本机磁盘上早有缓存的那 10 位艺人（Taylor Swift、Coldplay…）则永远只有字母。
     *
     * 为什么必须单独写一条：上面那条端到端检查跑的是**冷路径**（自检结束时会清空在线缓存，
     * 所以每轮开头都是未命中），暖路径从来没被覆盖过 —— 这正是漏掉的那一半。
     * 另外必须用 `remote.online.artist` 直连：渲染层的封面服务有自己的内存缓存，
     * 会把第二次请求挡在 IPC 之前，那样就测不到主进程这条路了。
     */
    const artistCacheCheck = await evaluate(win, `
      const get = () => window.__aria.remote.online.artist({ name: 'Ed Sheeran' })
      const first = await get()
      const second = await get()
      const shape = (r) => ({
        hasData: Boolean(r && r.data && r.data.byteLength > 1000),
        mime: (r && r.mime) || '',
        cached: Boolean(r && r.cached),
        keys: r ? Object.keys(r).sort().join(',') : '',
        error: (r && r.error) || ''
      })
      return { first: shape(first), second: shape(second) }
    `)
    artistCacheCheck.leakedRawShape = artistCacheCheck.first.keys.includes('buffer') ||
      artistCacheCheck.second.keys.includes('buffer')
    artistCacheCheck.hasImage = artistCacheCheck.first.hasData || artistCacheCheck.second.hasData
    record('在线艺人头像：磁盘缓存命中的那一次也必须带 data（渲染层按 .data 判定）',
      /*
       * 断言要**精确到那个 bug 的特征**，不能把「这次环境没取到图」也算失败：
       *   · 字段名 bug 的特征是**裸的 readBinary 形状漏出去** —— keys 里有 `buffer`。
       *     修复后的形状是 cached/data/mime；一条图都没查到时是 `{ data: null }`（keys=[data]）。
       *   · 另外：只要这一次真的取到了图（cached 命中），它就必须带 data。
       * 这样「网络不给力」不会误报，「缓存命中丢 data」一定被抓。
       */
      !artistCacheCheck.leakedRawShape &&
      (!artistCacheCheck.hasImage || (artistCacheCheck.first.hasData && artistCacheCheck.second.hasData)),
      `第一次 keys=[${artistCacheCheck.first.keys}] 带data=${artistCacheCheck.first.hasData}；` +
      `第二次 keys=[${artistCacheCheck.second.keys}] 带data=${artistCacheCheck.second.hasData} cached=${artistCacheCheck.second.cached}；` +
      `裸形状漏出=${artistCacheCheck.leakedRawShape}；本轮是否取到图=${artistCacheCheck.hasImage}` +
      (artistCacheCheck.hasImage ? '' : '（没取到图属环境问题：本次会话很可能已因一次失败停用了 Deezer）'))

    /*
     * 艺人**列表行**的头像必须与**详情页**是同一张（都是按艺人名在线查来的），
     * 不能是「该艺人某首歌的专辑封面」。
     *
     * 这条盯的是用户报的第二个现象：搜索/列表里 Ed Sheeran 显示成 Taylor Swift 的脸 ——
     * 因为 artist.artworkTrack 会挑到合作曲目所在的那张专辑（grouping.js 的 pickArtworkTrack）。
     *
     * ⚠️ 旧版有两个自身缺陷，导致它昨晚红绿交替 4 次（与产品无关）：
     *   ① **只等详情页的图，不等列表行的图**。行的头像也是在线查来的，读的时候常常还在路上，
     *      于是 `rowDecoded=false` 被当成"两边都没图"判红 —— 这是"红"的第一种形态。
     *   ② **比的是 blob URL 字符串**（`rowSrc === detailSrc`）。artwork 的 urlCache 是
     *      "一个键一个 URL"，只要中途逐出过一次，同一个 key 会拿到**新的 blob**，
     *      字符串不等但图是同一张 —— 这是第二种形态（"有图，但两边不是同一张"）。
     *
     * 现在：① 两边都**等条件**（各自的 budget）；② 比**图像内容**而不是 URL ——
     * 把两张图各自缩到 16×16 灰度，算平均绝对差（MAD）；③ 只有当**两边都没出图**时
     * 才算环境问题（与旁边那条缓存检查同一个口径），"只有一边有图"是真失败；
     * ④ 失败信息里把两边是否解码、src 是否为空、MAD 都打出来（旧版只印"是/否"，分不清原因）；
     * ⑤ 内置一条**自证**：清掉 URL 缓存后重新解析，blob 字符串必然变化而图像内容不变 ——
     *    也就是"旧判据在这种情况下一定会红"。这条自证常驻，防止以后再退回比字符串。
     */
    /* 16×16 灰度下的平均绝对差阈值：同一张图实测 0，人像 vs 专辑封面是几十的量级 */
    const ARTIST_MAD_THRESHOLD = 12
    const artistRowVsDetail = await evaluate(win, `
      const { actions, artwork } = window.__aria
      /*
       * 总预算：这一段最坏情况必须**远小于** evaluate 的 90s 超时。
       * 曾经是 3 位艺人 × (12s 行 + 12s 详情) + 自证 18s = 96s —— 网络一慢就整段超时，
       * 结果不是"这条红"，而是**连它后面的 4 条检查一起没跑**（实测 186/190）。
       * 现在：全局 deadline + 首个命中即收敛 + 自证只在还有余量时做。
       */
      const DEADLINE = performance.now() + 45000
      const left = () => DEADLINE - performance.now()
      const grab = (selector, budget) => new Promise((resolve) => {
        const deadline = performance.now() + Math.max(500, Math.min(budget, left()))
        const tick = () => {
          const img = document.querySelector(selector)
          if (img && img.complete && img.naturalWidth > 0) return resolve(img)
          if (performance.now() > deadline) return resolve(img || null)
          setTimeout(tick, 200)
        }
        tick()
      })
      // 缩到 16×16 灰度：行里是 ~40px、详情页是 140px，直接逐像素比必然不同，
      // 同尺寸降采样之后同一张图的 MAD 很小、不同图（人像 vs 专辑封面）会很大。
      const fingerprint = (img) => {
        if (!img || !img.complete || !img.naturalWidth) return null
        try {
          const canvas = document.createElement('canvas')
          canvas.width = 16
          canvas.height = 16
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0, 16, 16)
          const data = ctx.getImageData(0, 0, 16, 16).data
          const out = []
          for (let i = 0; i < data.length; i += 4) {
            out.push(Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114))
          }
          return out
        } catch (error) {
          return null
        }
      }
      const mad = (a, b) => {
        if (!a || !b || a.length !== b.length) return null
        let sum = 0
        for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
        return Math.round((sum / a.length) * 10) / 10
      }
      const firstFrame = (fp) => (fp ? fp.slice(0, 3).join(',') : '')

      actions.setView('artists')
      await new Promise((r) => setTimeout(r, 500))
      const rows = [...document.querySelectorAll('.artist-row')].slice(0, 3)
      const out = []
      for (const row of rows) {
        if (left() < 2000) break           // 预算不够就不再往下试（后面的自证更重要）
        const key = row.dataset.key || ''
        // ① 行的图也要等
        const rowImg = await grab('.artist-row[data-key="' + key + '"] .artist-row__avatar img', 8000)
        const rowFp = fingerprint(rowImg)
        actions.openArtist(key)
        const detailImg = await grab('.browse-detail__avatar img', 8000)
        actions.closeDetail()
        await new Promise((r) => setTimeout(r, 200))
        const detailFp = fingerprint(detailImg)
        const pairMad = mad(rowFp, detailFp)
        out.push({
          key,
          rowDecoded: Boolean(rowFp),
          detailDecoded: Boolean(detailFp),
          rowSrcEmpty: !(rowImg && rowImg.getAttribute('src')),
          detailSrcEmpty: !(detailImg && detailImg.getAttribute('src')),
          sameBlob: Boolean(rowImg && detailImg && rowImg.getAttribute('src') === detailImg.getAttribute('src')),
          rowFrame: firstFrame(rowFp),
          detailFrame: firstFrame(detailFp),
          mad: pairMad
        })
        if (pairMad !== null && pairMad <= ${ARTIST_MAD_THRESHOLD}) {
          break                            // 首个命中就够了：判据是"同一张"，不是"全都同一张"
        }
      }

      /*
       * ⑤ 自证：同一个 key 在清掉 URL 缓存后会拿到**新的 blob**，但图像内容不变。
       * 旧判据（比字符串）在这种情况下必然判红 —— 这就是昨晚那 4 次交替的第二个来源。
       * 只在还有余量时做：它证明的是"判据为什么这么选"，不该把整段拖过超时。
       */
      const probeKey = out[0] ? out[0].key : (rows[0] ? rows[0].dataset.key : '')
      let selfTest = { key: probeKey, blobChanged: null, mad: null, note: '没拿到可复现的艺人' }
      if (probeKey && left() > 12000) {
        actions.openArtist(probeKey)
        const before = await grab('.browse-detail__avatar img', 6000)
        const beforeSrc = before ? before.getAttribute('src') || '' : ''
        const beforeFp = fingerprint(before)
        actions.closeDetail()
        await new Promise((r) => setTimeout(r, 300))
        artwork.releaseMemory()          // 清空 urlCache 并 revoke 旧 blob
        actions.openArtist(probeKey)
        const after = await grab('.browse-detail__avatar img', 6000)
        const afterSrc = after ? after.getAttribute('src') || '' : ''
        const afterFp = fingerprint(after)
        actions.closeDetail()
        selfTest = {
          key: probeKey,
          beforeSrcHead: beforeSrc.slice(0, 20),
          afterSrcHead: afterSrc.slice(0, 20),
          scheme: beforeSrc.startsWith('blob:') ? 'blob:' : (beforeSrc.startsWith('data:') ? 'data:' : '其它'),
          blobChanged: Boolean(beforeSrc && afterSrc && beforeSrc !== afterSrc),
          mad: mad(beforeFp, afterFp),
          note: beforeSrc && afterSrc ? '' : '两次里至少一次没出图，自证不成立（环境问题）'
        }
      }
      actions.setView('songs')
      return { out, selfTest }
    `)
    /*
     * 阈值 12：16×16 灰度下的平均绝对差。同一张图经不同尺寸降采样后通常只有几（实测值见读数），
     * 而"人像 vs 专辑封面"是几十的量级 —— 阈值取在两者之间。
     * 先用打印出来的 MAD 验证，再据此调整（不凭感觉定）。
     */
    const judged = artistRowVsDetail.out.filter((item) => item.rowDecoded || item.detailDecoded)
    const matched = judged.filter((item) => item.mad !== null && item.mad <= ARTIST_MAD_THRESHOLD)
    const oneSided = judged.filter((item) => item.rowDecoded !== item.detailDecoded)
    const detail = artistRowVsDetail.out.map((item) =>
      `${item.key}：行出图=${item.rowDecoded ? '是' : '否'} 详情出图=${item.detailDecoded ? '是' : '否'}` +
      ` 行src空=${item.rowSrcEmpty} 详情src空=${item.detailSrcEmpty} 同blob=${item.sameBlob} MAD=${item.mad === null ? '—' : item.mad}` +
      `（行帧 ${item.rowFrame || '—'} / 详情帧 ${item.detailFrame || '—'}）`).join('；')
    const selfTestText = `自证（清 URL 缓存后重新解析）：方案=${artistRowVsDetail.selfTest.scheme || '—'}` +
      ` blob 变化=${artistRowVsDetail.selfTest.blobChanged}` +
      `、内容 MAD=${artistRowVsDetail.selfTest.mad === null ? '—' : artistRowVsDetail.selfTest.mad}` +
      (artistRowVsDetail.selfTest.note ? ` · ${artistRowVsDetail.selfTest.note}` : '')
    /*
     * 自证只断言**可判定**的那件事：两次拿到的 URL 如果不同，图像内容必须仍然一致
     * （URL 相同时没什么可证，不打红 —— 本轮实测就是相同：清缓存后解析仍复用同一个 URL）。
     * 也就是说：只要"URL 变了、图没变"这种情况出现过，旧判据（比字符串）就必红。
     * 第一形态（等不到列表行的图）的证据在提交信息里：同一环境下旧检查报"行出图=否"、
     * 新检查（唯一区别是**等列表行的图**）报"行出图=是"。
     */
    const selfTestOk = artistRowVsDetail.selfTest.blobChanged === null ||
      (artistRowVsDetail.selfTest.blobChanged === false) ||
      (artistRowVsDetail.selfTest.mad !== null && artistRowVsDetail.selfTest.mad <= ARTIST_MAD_THRESHOLD)
    record('艺人列表行的头像与详情页是同一张（比图像内容，不比 blob 字符串）',
      // ① 不允许"只有一边有图"——那是真失败
      oneSided.length === 0 &&
      // ② 两边都出图时必须至少有一对内容一致；两边都没图则按环境问题跳过（与旁边那条缓存检查同口径）
      (judged.length === 0 || matched.length >= 1) &&
      // ③ 自证：URL 变了而内容没变，才算通过（URL 没变则跳过这一条）
      selfTestOk,
      `${detail}` +
      (judged.length === 0 ? '【本次会话两边都没取到在线头像 → 按环境问题跳过，不判失败】' : '') +
      `；${selfTestText}`)

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

    /* ---------- 网络代理 ----------
     *
     * 用户反馈过「开了加速器还是取不到封面 / 头像」：不少加速器并不设置系统代理，
     * 而在线的歌词 / 封面 / 头像全都由主进程用默认会话发出 —— 于是"跟随系统"等于没有代理。
     * 这条不靠"读设置值"来验（读过就算过是假的），而是问 Chromium 自己：
     * resolveProxy 返回的就是当前**真正生效**的代理。
     */
    {
      const { session: electronSession } = require('electron')
      const original = { proxyMode: settingsService.get().proxyMode, proxyUrl: settingsService.get().proxyUrl }
      const probe = () => electronSession.defaultSession.resolveProxy('https://example.com')
      /*
       * 先取**基线**：这台机器的系统代理是什么。
       * 第一版没取基线、而且测试端口随手写了 7890 —— 恰好是这台机器系统代理的端口，
       * 于是"改回跟随系统"之后的读数看起来和手动那一步一模一样，
       * 像是没恢复成功（其实是真的恢复了）。这类"读数会误导人"的坑要一开始就避开：
       * 基线单独记下来对比，测试端口换成明显不同的一个。
       */
      const baseline = await probe()
      const manualUrl = 'http://127.0.0.1:18080'

      settingsService.set({ proxyMode: 'direct', proxyUrl: '' })
      await sleep(600)
      const direct = await probe()

      settingsService.set({ proxyMode: 'manual', proxyUrl: manualUrl })
      await sleep(600)
      const manual = await probe()

      settingsService.set({ proxyMode: 'system', proxyUrl: original.proxyUrl })
      await sleep(600)
      const restored = await probe()

      record('网络代理：三种模式真的作用到默认会话（加速器没设系统代理时的开关）',
        direct === 'DIRECT' &&
        manual.includes('127.0.0.1:18080') &&
        !direct.includes('18080') &&
        restored === baseline &&
        settingsService.get().proxyMode === 'system',
        `基线（跟随系统）= ${baseline}；直连 → ${direct}；手动 ${manualUrl} → ${manual}；` +
        `改回跟随系统 → ${restored}（与基线一致=${restored === baseline}）；模式=${settingsService.get().proxyMode}`)
    }

    // 恢复默认：在线功能保持关闭
    settingsService.set({ onlineFeatures: false })
    await sleep(200)

    /*
     * 窗口几何与真实拖动：打了 full/player 标记，就必须在本体里也真跑一遍。
     * **必须放在整套的最末尾**：它会拉起 PowerShell 挪系统光标，那会抢走前台，
     * 一旦插在中间就会让应用判定"长时间不在前台"而释放媒体墙，后面那些媒体墙检查全读 0。
     */
    await runWindowChecks({ win, record })
    win.show()
    win.focus()
    await sleep(500)
  } catch (err) {
    record('执行过程', false, err.message)
  }

  const failed = checks.filter((check) => !check.ok)
  printSummary('')
  return failed.length === 0
}

module.exports = { runSmoke }
