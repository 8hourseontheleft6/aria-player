/** 底部播放条：进度、传输控制、播放模式、音量、倍速、歌词/队列入口 */

import { h, on } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { EVENTS } from '../../core/bus.js'
import { formatDuration, formatRate, keyHint, reservedKeyHint } from '../../core/format.js'
import { createSlider } from '../widgets/slider.js'
import { createArtworkView } from '../widgets/artwork-node.js'
import { openPopover, showContextMenu } from '../widgets/overlay.js'

const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2]

export function createPlayerBar ({ store, bus, player, artwork, actions }) {
  /* ---------------- 左侧：当前曲目 ---------------- */
  const art = createArtworkView({
    artwork,
    className: 'player-bar__art',
    onClick: () => actions.openNowPlaying()
  })

  const titleNode = h('div', { class: 'player-bar__title truncate', text: '未在播放' })
  const artistNode = h('div', { class: 'player-bar__artist truncate', text: '双击列表中的歌曲开始播放' })

  const nowBlock = h('div', { class: 'player-bar__now' },
    art.element,
    h('div', { class: 'player-bar__meta' }, titleNode, artistNode)
  )

  /* ---------------- 顶部进度条 ---------------- */
  const progress = createSlider({
    className: 'slider--thin',
    min: 0,
    max: 1,
    value: 0,
    buffered: true,
    formatTooltip: (value) => formatDuration(value),
    onCommit: (value) => player.seek(value)
  })

  /* ---------------- 中间：传输控制 ---------------- */
  const modeButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '播放模式',
    onClick: () => player.cycleMode(),
    onContextmenu: (event) => {
      event.preventDefault()
      openModeMenu(event)
    }
  }, icon('repeat', { className: 'icon icon--stroke' }))

  const prevButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: `上一首 (${keyHint('←')})`,
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
    title: `下一首 (${keyHint('→')})`,
    onClick: () => player.next()
  }, icon('next'))

  const controls = h('div', { class: 'player-bar__controls' },
    modeButton, prevButton, playButton, nextButton)

  /* ---------------- 右侧：工具 ---------------- */
  const lyricsButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '歌词',
    onClick: () => actions.openNowPlaying({ lyrics: true })
  }, icon('lyrics', { className: 'icon icon--stroke' }))

  const rateButton = h('button', {
    class: 'player-bar__rate',
    type: 'button',
    title: '播放速度',
    onClick: () => openRatePopover(rateButton)
  }, formatRate(store.get().settings.playbackRate))

  const muteButton = h('button', {
    class: 'btn btn--icon-sm',
    type: 'button',
    title: '静音 (M)',
    onClick: () => player.toggleMute()
  }, icon('speaker'))

  const volumeSlider = createSlider({
    className: 'slider--volume',
    min: 0,
    max: 1,
    value: store.get().settings.volume,
    formatTooltip: (value) => `${Math.round(value * 100)}%`,
    onInput: (value) => player.setVolume(value)
  })

  const queueButton = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: `播放队列 (${reservedKeyHint('Q')})`,
    onClick: () => actions.toggleQueue()
  }, icon('waveform', { className: 'icon icon--stroke' }))

  const tools = h('div', { class: 'player-bar__tools' },
    lyricsButton, rateButton,
    h('div', { class: 'player-bar__volume' }, muteButton, volumeSlider.element),
    queueButton
  )

  const element = h('footer', { class: 'player-bar' },
    h('div', { class: 'player-bar__progress' }, progress.element),
    nowBlock,
    controls,
    tools
  )

  on(nowBlock, 'dblclick', () => actions.openNowPlaying())

  /* ---------------- 弹出菜单 ---------------- */
  function openModeMenu (event) {
    const modes = player.modes
    showContextMenu({
      x: event.clientX,
      y: event.clientY - modes.length * 30 - 40,
      items: modes.map((mode) => ({
        label: `${mode.name}${mode.description ? ` — ${mode.description}` : ''}`,
        icon: mode.icon,
        checked: player.mode.id === mode.id,
        onClick: () => player.setMode(mode.id)
      }))
    })
  }

  function openRatePopover (anchor) {
    const current = store.get().settings.playbackRate
    const sliderHolder = h('div', { style: { padding: '4px 8px 8px' } })

    const rateSlider = createSlider({
      min: 0.5,
      max: 2,
      step: 0.05,
      value: current,
      formatTooltip: (value) => formatRate(value),
      onInput: (value) => {
        player.setRate(value)
        refreshRatePresets(value)
      }
    })
    sliderHolder.appendChild(rateSlider.element)

    const presetRow = h('div', {
      style: { display: 'flex', gap: '4px', padding: '0 8px 8px', flexWrap: 'wrap' }
    })

    const buttons = RATE_PRESETS.map((rate) => h('button', {
      class: 'btn btn--sm',
      type: 'button',
      text: formatRate(rate),
      onClick: () => {
        player.setRate(rate)
        rateSlider.setValue(rate, { force: true })
        refreshRatePresets(rate)
      }
    }))
    presetRow.append(...buttons)

    function refreshRatePresets (value) {
      buttons.forEach((button, index) => {
        const active = Math.abs(RATE_PRESETS[index] - value) < 0.001
        button.classList.toggle('btn--primary', active)
      })
    }
    refreshRatePresets(current)

    const pitchSwitch = h('span', {
      class: `switch${store.get().settings.preservesPitch ? ' is-on' : ''}`,
      role: 'switch',
      tabindex: '0',
      onClick: () => {
        const next = !store.get().settings.preservesPitch
        player.setPreservesPitch(next)
        pitchSwitch.classList.toggle('is-on', next)
      }
    })

    openPopover({
      anchor,
      placement: 'top-end',
      content: [
        h('div', { class: 'popover__title', text: '播放速度' }),
        sliderHolder,
        presetRow,
        h('div', { class: 'popover__sep' }),
        h('div', { class: 'popover__row' },
          h('span', { text: '保持音调' }),
          pitchSwitch
        ),
        h('div', {
          class: 'popover__row',
          style: { fontSize: 'var(--text-footnote)', color: 'var(--label-3)' },
          text: '关闭后变速会连带改变音高（类似老式磁带机）'
        })
      ]
    })
  }

  /* ---------------- 状态绑定 ---------------- */
  bus.on(EVENTS.TIME, ({ time, duration, buffered }) => {
    if (duration && progress.value !== duration) progress.setRange(0, duration)
    progress.setValue(time)
    progress.setBuffered(buffered)
    progress.setTooltip(formatDuration(progress.dragging ? progress.value : time))
  })

  bus.on(EVENTS.TRACK_CHANGED, ({ track }) => {
    titleNode.textContent = track.title
    artistNode.textContent = `${track.artist}${track.album ? ` — ${track.album}` : ''}`
    art.setTrack(track)
    progress.setRange(0, track.duration || 1)
    progress.setValue(0)
  })

  bus.on(EVENTS.MODE_CHANGED, (mode) => {
    modeButton.title = `播放模式：${mode.name}（右键选择）`
    modeButton.replaceChildren(icon(mode.icon, { className: 'icon icon--stroke' }))
    modeButton.classList.toggle('is-active', mode.id !== 'loop-list')
  })

  bus.on('player:volume-changed', (volume) => {
    volumeSlider.setValue(volume)
    muteButton.replaceChildren(icon(volume === 0 || store.get().settings.muted ? 'muteX' : 'speaker'))
  })

  store.select((state) => state.playback.status, (status) => {
    const playing = status === 'playing' || status === 'loading'
    playButton.replaceChildren(icon(playing ? 'pause' : 'play'))
  })

  store.select((state) => state.settings.playbackRate, (rate) => {
    rateButton.textContent = formatRate(rate)
    rateButton.classList.toggle('is-active', Math.abs(rate - 1) > 0.001)
  })

  store.select((state) => state.library.tracks.length, (count) => {
    if (count && titleNode.textContent === '未在播放') {
      artistNode.textContent = `${count} 首曲目已就绪`
    }
  })

  // 初始化显示
  modeButton.classList.remove('is-active')
  muteButton.replaceChildren(icon(store.get().settings.muted ? 'muteX' : 'speaker'))

  return { element, openRatePopover, progress }
}
