/** 「正在播放」全屏面板：大封面、进度、传输控制、播放模式、倍速、歌词与插件面板 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { EVENTS } from '../../core/bus.js'
import { formatDuration, formatRate, reservedKeyHint } from '../../core/format.js'
import { createSlider } from '../widgets/slider.js'
import { createArtworkView } from '../widgets/artwork-node.js'
import { createLyricsView } from '../widgets/lyrics-view.js'
import { createVisualizer } from '../widgets/visualizer.js'
import { openPopover, popoverRows, closeAllLayers } from '../widgets/overlay.js'
import { presetOptions, matchPreset, PRESETS } from '../../core/equalizer-presets.js'

const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2]

export function createNowPlayingPanel ({ store, bus, player, engine, artwork, host, actions }) {
  /* ---------------- 背景 ---------------- */
  const artBackground = h('div', { class: 'now-playing__art-bg' })
  const veil = h('div', { class: 'now-playing__veil' })
  // 专辑色光晕：让底部那条示波器「融」进背景，而不是硬贴在页面上
  const glow = h('div', { class: 'now-playing__glow' })
  /*
   * 沉浸式示波器：横贯页面底部的一条（纯装饰，不接收鼠标 —— 见 visualizer.js 里的说明）。
   * 样式存在设置里，点顶栏那颗小按钮循环切换。
   */
  const visualizer = createVisualizer({
    engine,
    store,
    bus,
    getStyle: () => store.get().settings.visualizerStyle || 'bars',
    onPickStyle: (style) => actions.setSetting({ visualizerStyle: style })
  })

  /* ---------------- 顶栏 ---------------- */
  const closeButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '收起 (Esc)',
    onClick: () => actions.closeNowPlaying()
  }, icon('chevronDown', { className: 'icon icon--stroke' }))

  const lyricsToggle = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '显示/隐藏歌词',
    onClick: () => actions.toggleLyrics()
  }, icon('lyrics', { className: 'icon icon--stroke' }))

  const queueToggle = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: `播放队列 (${reservedKeyHint('Q')})`,
    onClick: () => actions.toggleQueue()
  }, icon('waveform', { className: 'icon icon--stroke' }))

  const revealButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '在文件夹中显示',
    onClick: () => {
      const track = player.currentTrack()
      if (track) actions.revealTrack(track)
    }
  }, icon('folder', { className: 'icon icon--stroke' }))

  /*
   * 均衡器：全屏播放页里也能直接调。
   *
   * 面板里放的是「开关 + 自动 + 预设」三件事 —— 和设置页同一套 actions，
   * 区别只是这里离正在播放的歌最近，试听风格时不用来回切页面。
   */
  const eqButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '声音均衡器',
    onClick: () => openEqualizerMenu(eqButton)
  }, icon('sliders', { className: 'icon icon--stroke' }))

  function openEqualizerMenu (anchor) {
    const settings = store.get().settings.equalizer || { enabled: false, auto: true, preset: 'flat' }
    const current = store.get().playback.trackId
      ? store.get().library.byId.get(store.get().playback.trackId)
      : null
    const matched = settings.enabled && settings.auto !== false ? matchPreset(current) : null
    const apply = (patch) => {
      closeAllLayers()
      actions.setEqualizer(patch)
    }
    const rows = [
      { title: '声音均衡器' },
      {
        label: settings.enabled ? '关闭均衡器' : '开启均衡器',
        value: settings.enabled ? '已开启' : '已关闭',
        onClick: () => apply({ enabled: !settings.enabled })
      },
      {
        label: '按歌曲风格自动选择',
        value: settings.auto !== false ? '开' : '关',
        onClick: () => apply({ auto: settings.auto === false })
      },
      { separator: true },
      { title: matched ? `自动匹配到「${PRESETS[matched].displayName}」` : '选择预设' },
      ...presetOptions().map((option) => ({
        label: option.label,
        // 自动模式下手动项是灰的：这时生效的是自动匹配出来的那一组
        value: settings.auto === false
          ? (settings.preset === option.value ? '使用中' : '')
          : (matched === option.value ? '自动选中' : ''),
        onClick: () => apply({ auto: false, preset: option.value, enabled: true })
      }))
    ]
    openPopover({
      anchor,
      placement: 'bottom-end',
      content: popoverRows(rows)
    })
  }

  const topbar = h('div', { class: 'now-playing__topbar' },
    closeButton,
    h('div', { class: 'now-playing__caption', text: '正在播放' }),
    h('div', { class: 'now-playing__spacer' }),
    revealButton,
    // 可视化样式切换（底部那条只是装饰，不接收鼠标，所以切换入口放在这里）
    visualizer.button,
    eqButton,
    lyricsToggle,
    queueToggle
  )

  /* ---------------- 左栏 ---------------- */
  const art = createArtworkView({ artwork, className: 'now-playing__art', fallbackIcon: 'music' })

  const titleNode = h('div', { class: 'now-playing__title truncate', text: '未在播放' })
  const artistNode = h('div', { class: 'now-playing__artist truncate', text: '' })
  const albumNode = h('div', { class: 'now-playing__album truncate', text: '' })

  const info = h('div', { class: 'now-playing__info' }, titleNode, artistNode, albumNode)

  const progress = createSlider({
    className: 'slider--thin',
    min: 0,
    max: 1,
    value: 0,
    buffered: true,
    formatTooltip: (value) => formatDuration(value),
    onCommit: (value) => player.seek(value)
  })

  const elapsedLabel = h('span', { class: 'tabular', text: '0:00' })
  const remainLabel = h('button', {
    type: 'button',
    class: 'tabular',
    title: '点击切换「剩余时间 / 总时长」',
    onClick: () => {
      actions.toggleRemainingTime()
      updateTimes(player.getTime(), player.getDuration())
    }
  }, '0:00')

  const times = h('div', { class: 'now-playing__times' }, elapsedLabel, remainLabel)
  const progressBlock = h('div', { class: 'now-playing__progress' }, progress.element, times)

  const prevButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '上一首',
    onClick: () => player.prev()
  }, icon('prev'))

  const playButton = h('button', {
    class: 'btn btn--transport',
    type: 'button',
    title: '播放 / 暂停 (空格)',
    onClick: () => player.toggle()
  }, icon('play'))

  const nextButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '下一首',
    onClick: () => player.next()
  }, icon('next'))

  const controls = h('div', { class: 'now-playing__controls' }, prevButton, playButton, nextButton)

  /* ---------------- 模式分段控件 ---------------- */
  const modeSegmented = h('div', { class: 'segmented segmented--icons' })
  /** @type {Array<Function>} 需要在面板显示后重新测量的绘制函数 */
  const segmentedPainters = []

  function buildModeSegmented () {
    clear(modeSegmented)
    const modes = player.modes
    if (!modes.length) return
    const thumb = h('div', { class: 'segmented__thumb' })
    modeSegmented.appendChild(thumb)

    const items = modes.map((mode) => h('button', {
      class: 'segmented__item',
      type: 'button',
      title: mode.description ? `${mode.name} — ${mode.description}` : mode.name,
      dataset: { mode: mode.id },
      onClick: () => {
        player.setMode(mode.id)
        schedulePaint()
      }
    }, icon(mode.icon, { className: 'icon icon--stroke' })))
    modeSegmented.append(...items)

    function paint () {
      const current = store.get().playback.mode
      let activeNode = null
      for (const item of items) {
        const active = item.dataset.mode === current
        item.classList.toggle('is-selected', active)
        if (active) activeNode = item
      }
      if (!activeNode) return false
      const width = activeNode.offsetWidth
      // 面板处于隐藏状态时量不到宽度，返回 false 让调度器稍后重试
      if (!width) return false
      thumb.style.width = `${width}px`
      thumb.style.transform = `translateX(${activeNode.offsetLeft - 2}px)`
      return true
    }

    /** 面板刚打开 / 尺寸变化时也要重排，否则滑块会停在宽度 0 */
    function schedulePaint (attempt = 0) {
      requestAnimationFrame(() => {
        if (!paint() && attempt < 12) schedulePaint(attempt + 1)
      })
    }

    segmentedPainters.push(schedulePaint)
    schedulePaint()
    store.select((state) => state.playback.mode, () => schedulePaint())
    store.select((state) => state.ui.nowPlayingOpen, (open) => {
      if (open) schedulePaint()
    })
    const observer = new ResizeObserver(() => schedulePaint())
    observer.observe(modeSegmented)
  }

  /* ---------------- 工具行 ---------------- */
  const rateButton = h('button', {
    class: 'now-playing__tool',
    type: 'button',
    title: '播放速度',
    onClick: () => openRatePopover(rateButton)
  }, icon('gauge', { className: 'icon icon--stroke' }), h('span', { text: formatRate(store.get().settings.playbackRate) }))

  const lyricsStateButton = h('button', {
    class: 'now-playing__tool',
    type: 'button',
    title: '歌词显示/隐藏',
    onClick: () => actions.toggleLyrics()
  }, icon('lyrics', { className: 'icon icon--stroke' }), h('span', { text: '歌词' }))

  const tools = h('div', { class: 'now-playing__tools' }, modeSegmented, rateButton, lyricsStateButton)

  const left = h('div', { class: 'now-playing__left' },
    art.element, info, progressBlock, controls, tools)

  /* ---------------- 右栏：歌词 + 插件面板 ---------------- */
  const lyricsView = createLyricsView({ className: 'lyrics-region', store, bus, player })
  const tabs = h('div', { class: 'now-playing__tabs' })
  const panelHost = h('div', { class: 'now-playing__panel-host' })
  const right = h('div', { class: 'now-playing__right' }, tabs, panelHost)

  let activePanelId = 'lyrics'
  let panelDisposer = null

  function mountPanel (id) {
    activePanelId = id
    if (panelDisposer) {
      try {
        panelDisposer()
      } catch (err) {
        console.error('[now-playing] 面板卸载失败', err)
      }
      panelDisposer = null
    }
    clear(panelHost)

    const definition = id === 'lyrics' ? null : host.get('panel', id)
    if (!definition) {
      panelHost.appendChild(lyricsView.element)
    } else {
      const container = h('div', { class: 'now-playing__panel' })
      panelHost.appendChild(container)
      try {
        const dispose = definition.mount(container, { store, bus, player, artwork, host })
        if (typeof dispose === 'function') panelDisposer = dispose
      } catch (err) {
        console.error(`[now-playing] 面板 ${id} 挂载失败`, err)
        container.appendChild(h('div', { class: 'empty', text: '该面板加载失败，详见开发者工具控制台。' }))
      }
    }
    paintTabs()
  }

  function paintTabs () {
    clear(tabs)
    const definitions = [{ id: 'lyrics', title: '歌词' }, ...host.list('panel')]
    for (const definition of definitions) {
      tabs.appendChild(h('button', {
        class: `now-playing__tab${definition.id === activePanelId ? ' is-selected' : ''}`,
        type: 'button',
        text: definition.title,
        onClick: () => {
          if (definition.id !== activePanelId) mountPanel(definition.id)
        }
      }))
    }
    tabs.style.visibility = definitions.length > 1 ? 'visible' : 'hidden'
  }

  bus.on('plugin:registered', ({ point }) => {
    if (point === 'panel') paintTabs()
  })
  bus.on('plugin:unregistered', ({ point, item }) => {
    if (point !== 'panel') return
    if (item.id === activePanelId) mountPanel('lyrics')
    else paintTabs()
  })

  /* ---------------- 倍速面板 ---------------- */
  function openRatePopover (anchor) {
    const holder = h('div', { style: { padding: '4px 8px 8px' } })
    const rateSlider = createSlider({
      min: 0.5,
      max: 2,
      step: 0.05,
      value: store.get().settings.playbackRate,
      formatTooltip: (value) => formatRate(value),
      onInput: (value) => {
        player.setRate(value)
        paintPresets(value)
      }
    })
    holder.appendChild(rateSlider.element)

    const presetRow = h('div', { style: { display: 'flex', gap: '4px', padding: '0 8px 8px', flexWrap: 'wrap' } })
    const presetButtons = RATE_PRESETS.map((rate) => h('button', {
      class: 'btn btn--sm',
      type: 'button',
      text: formatRate(rate),
      onClick: () => {
        player.setRate(rate)
        rateSlider.setValue(rate, { force: true })
        paintPresets(rate)
      }
    }))
    presetRow.append(...presetButtons)

    function paintPresets (value) {
      presetButtons.forEach((button, index) => {
        button.classList.toggle('btn--primary', Math.abs(RATE_PRESETS[index] - value) < 0.001)
      })
    }
    paintPresets(store.get().settings.playbackRate)

    const pitchSwitch = h('span', {
      class: `switch${store.get().settings.preservesPitch ? ' is-on' : ''}`,
      role: 'switch',
      onClick: () => {
        const next = !store.get().settings.preservesPitch
        player.setPreservesPitch(next)
        pitchSwitch.classList.toggle('is-on', next)
      }
    })

    openPopover({
      anchor,
      placement: 'top-center',
      content: [
        h('div', { class: 'popover__title', text: '播放速度（0.5× – 2×）' }),
        holder,
        presetRow,
        h('div', { class: 'popover__sep' }),
        h('div', { class: 'popover__row' }, h('span', { text: '保持音调' }), pitchSwitch)
      ]
    })
  }

  /* ---------------- 主结构 ---------------- */
  /*
   * 层级（见 nowplaying.css 里的 z-index 一组）：封面底 0 → 玻璃/光晕 1 → 示波器 2 → 内容 3 → 顶栏 4。
   * 示波器压在内容之下、玻璃之上，所以既看得见又不会挡住任何可点的东西。
   */
  const body = h('div', { class: 'now-playing__body' }, left, right)
  const element = h('section', { class: 'now-playing', id: 'now-playing', hidden: true },
    artBackground, veil, glow, visualizer.element, topbar, body)

  /* ---------------- 时间显示 ---------------- */
  function updateTimes (time, duration) {
    elapsedLabel.textContent = formatDuration(time)
    const showRemaining = store.get().settings.showRemainingTime
    remainLabel.textContent = showRemaining
      ? `-${formatDuration(Math.max(0, duration - time))}`
      : formatDuration(duration)
  }

  bus.on(EVENTS.TIME, ({ time, duration, buffered }) => {
    if (duration && progress.value !== duration) progress.setRange(0, duration)
    progress.setValue(time)
    progress.setBuffered(buffered)
    progress.setTooltip(formatDuration(progress.dragging ? progress.value : time))
    updateTimes(progress.dragging ? progress.value : time, duration)
  })

  bus.on(EVENTS.TRACK_CHANGED, ({ track }) => {
    titleNode.textContent = track.title
    titleNode.title = track.title
    artistNode.textContent = track.artist
    albumNode.textContent = `${track.album}${track.year ? ` · ${track.year}` : ''}`
    art.setTrack(track)
    progress.setRange(0, track.duration || 1)
    progress.setValue(0)
    updateTimes(0, track.duration || 0)

    // 换歌时封面做一个轻微的回弹，让打开面板/切歌更有反馈
    art.element.classList.remove('is-flipping')
    void art.element.offsetWidth
    art.element.classList.add('is-flipping')

    artwork.resolveUrl(track).then((url) => {
      artBackground.style.backgroundImage = url ? `url("${url}")` : 'none'
    }).catch(() => {
      artBackground.style.backgroundImage = 'none'
    })
  })

  store.select((state) => state.playback.status, (status) => {
    const playing = status === 'playing' || status === 'loading'
    playButton.replaceChildren(icon(playing ? 'pause' : 'play'))
  })

  store.select((state) => state.settings.playbackRate, (rate) => {
    const label = rateButton.querySelector('span')
    if (label) label.textContent = formatRate(rate)
  })

  store.select((state) => state.ui.lyricsVisible, (visible) => {
    body.classList.toggle('is-lyrics-hidden', !visible)
    lyricsToggle.classList.toggle('is-active', visible)
    lyricsStateButton.classList.toggle('is-active', visible)
    if (visible) requestAnimationFrame(() => lyricsView.alignToActive({ animated: false }))
  })

  store.select((state) => state.ui.nowPlayingOpen, (open) => {
    if (open) {
      element.hidden = false
      element.classList.remove('is-closing')
      updateTimes(player.getTime(), player.getDuration())
      requestAnimationFrame(() => lyricsView.alignToActive({ animated: false }))
      // 只在面板打开时绘帧；关掉就停，别在后台空转（暂停时它自己还会降到 ~6 帧）
      visualizer.start()
    } else if (!element.hidden) {
      visualizer.stop()
      element.classList.add('is-closing')
      setTimeout(() => {
        if (!store.get().ui.nowPlayingOpen) element.hidden = true
        element.classList.remove('is-closing')
      }, 260)
    }
  })

  buildModeSegmented()
  paintTabs()
  mountPanel('lyrics')

  return { element, artBackground }
}
