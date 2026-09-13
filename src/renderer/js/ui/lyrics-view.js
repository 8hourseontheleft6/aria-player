/**
 * 歌词视图：
 *  - 时间轴歌词逐行跟随播放滚动（Apple Music 式：当前行高亮放大）
 *  - 用户手动滚动时暂停跟随，并提供「回到当前」
 *  - 支持翻译行、逐字（卡拉OK）高亮、纯文本歌词
 *  - 内置偏移与字号调节
 */

import { h, on, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { EVENTS } from '../core/bus.js'
import { karaokeProgress } from '../core/lrc.js'
import { createSlider } from './slider.js'
import { openPopover } from './overlay.js'

const RESUME_DELAY = 4200

export function createLyricsView ({ className = 'lyrics-region', store, bus, player }) {
  const inner = h('div', { class: 'lyrics__inner' })
  const scroller = h('div', { class: 'lyrics scroll' }, inner)

  const resumeButton = h('button', {
    class: 'lyrics-resume',
    type: 'button',
    onClick: () => resumeFollow()
  }, icon('downToLine', { className: 'icon icon--stroke' }), h('span', { text: '回到当前' }))

  const toolbar = h('div', { class: 'lyrics-toolbar' })
  const element = h('div', { class: `${className} lyrics-region` }, scroller, toolbar, resumeButton)

  /** @type {Array<HTMLElement>} */
  let lineNodes = []
  let activeIndex = -1
  let userScrolling = false
  let resumeTimer = null
  let translateY = 0
  let lastKaraokeIndex = -1

  /* ------------------------------ 渲染 ------------------------------ */

  function buildToolbar () {
    clear(toolbar)

    const adjustButton = h('button', {
      class: 'btn btn--icon-sm',
      type: 'button',
      title: '歌词显示设置',
      onClick: () => openDisplayPopover(adjustButton)
    }, icon('sliders', { className: 'icon icon--stroke' }))

    const reloadButton = h('button', {
      class: 'btn btn--icon-sm',
      type: 'button',
      title: '重新载入歌词',
      onClick: () => player.reloadLyrics()
    }, icon('refresh', { className: 'icon icon--stroke' }))

    toolbar.append(adjustButton, reloadButton)
  }

  function openDisplayPopover (anchor) {
    const settings = store.get().settings

    const offsetSlider = createSlider({
      min: -5000,
      max: 5000,
      step: 50,
      value: settings.lyricOffsetMs,
      formatTooltip: (value) => `${value > 0 ? '+' : ''}${Math.round(value)} ms`,
      onInput: (value) => player.setLyricOffset(value)
    })

    const scaleSlider = createSlider({
      min: 0.7,
      max: 1.6,
      step: 0.05,
      value: settings.lyricFontScale,
      formatTooltip: (value) => `${Math.round(value * 100)}%`,
      onInput: (value) => player.setLyricFontScale(value)
    })

    openPopover({
      anchor,
      placement: 'bottom-end',
      content: [
        h('div', { class: 'popover__title', text: '歌词偏移（+ 表示歌词提前）' }),
        h('div', { style: { padding: '0 8px 6px' } }, offsetSlider.element),
        h('div', { style: { display: 'flex', gap: '4px', padding: '0 8px 10px' } },
          ...[0, 500, -500, 1000].map((value) => h('button', {
            class: 'btn btn--sm',
            type: 'button',
            text: value === 0 ? '重置' : `${value > 0 ? '+' : ''}${value}ms`,
            onClick: () => {
              player.setLyricOffset(value)
              offsetSlider.setValue(value, { force: true })
            }
          }))
        ),
        h('div', { class: 'popover__sep' }),
        h('div', { class: 'popover__title', text: '字号' }),
        h('div', { style: { padding: '0 8px 8px' } }, scaleSlider.element)
      ]
    })
  }

  function showEmpty ({ iconName, title, text, action }) {
    clear(inner)
    lineNodes = []
    activeIndex = -1
    inner.style.transform = 'none'
    translateY = 0
    inner.appendChild(h('div', { class: 'lyrics-empty' },
      icon(iconName, { className: 'icon icon--stroke' }),
      h('div', { class: 'lyrics-empty__title', text: title }),
      h('div', { class: 'lyrics-empty__text', text }),
      action || null
    ))
  }

  function render () {
    const lyrics = store.get().lyrics
    element.style.setProperty('--lyric-scale', String(store.get().settings.lyricFontScale))

    if (lyrics.status === 'loading') {
      showEmpty({ iconName: 'waveform', title: '正在载入歌词…', text: '正在这首歌曲所在目录里查找 .lrc 歌词文件' })
      return
    }

    if (lyrics.status === 'plain' && lyrics.plain?.length) {
      clear(inner)
      lineNodes = []
      activeIndex = -1
      inner.style.transform = 'none'
      const box = h('div', { class: 'lyrics--plain' })
      for (const line of lyrics.plain) {
        box.appendChild(h('div', { class: 'lyrics__plain-line', text: line }))
      }
      inner.appendChild(box)
      return
    }

    if (!lyrics.lines?.length) {
      const isEmptyTrack = lyrics.status === 'empty'
      showEmpty({
        iconName: 'lyrics',
        title: isEmptyTrack ? '这首歌没有歌词' : '未找到歌词',
        text: '把同名 .lrc 文件放在歌曲旁边即可自动加载；也支持「歌名 - 歌手.lrc」这类命名。',
        action: h('button', {
          class: 'btn',
          type: 'button',
          onClick: () => player.reloadLyrics()
        }, icon('refresh', { className: 'icon icon--stroke' }), '重新载入')
      })
      return
    }

    clear(inner)
    lineNodes = lyrics.lines.map((line, index) => {
      const textNode = line.words?.length
        ? h('span', { class: 'lyrics__words', text: line.text })
        : h('span', { text: line.text })

      const node = h('button', {
        class: 'lyrics__line',
        type: 'button',
        dataset: { index: String(index) },
        onClick: () => {
          player.seek(Math.max(0, line.time - 0.05))
          resumeFollow()
        }
      }, textNode, line.translation ? h('span', { class: 'lyrics__sub', text: line.translation }) : null)

      return node
    })
    inner.append(...lineNodes)
    activeIndex = -1
    translateY = 0
    inner.style.transform = 'none'
  }

  /* ------------------------------ 跟随滚动 ------------------------------ */

  function alignToActive ({ animated = true } = {}) {
    const node = lineNodes[activeIndex]
    if (!node) return
    if (userScrolling) return

    const viewHeight = scroller.clientHeight
    if (!viewHeight) return

    const lineRect = node.getBoundingClientRect()
    const scrollerRect = scroller.getBoundingClientRect()
    // scrollTop 归零时，可视位置 = 布局位置 + 当前位移
    const layoutTop = lineRect.top - scrollerRect.top + scroller.scrollTop - translateY
    const target = viewHeight / 2 - layoutTop - lineRect.height / 2

    if (Math.abs(target - translateY) < 1) return
    translateY = target
    inner.style.transition = animated ? '' : 'none'
    inner.style.transform = `translateY(${target}px)`
    if (!animated) requestAnimationFrame(() => { inner.style.transition = '' })
  }

  function setActive (index) {
    if (index === activeIndex) return
    const previous = lineNodes[activeIndex]
    previous?.classList.remove('is-active')
    previous?.classList.remove('is-near')

    activeIndex = index
    lastKaraokeIndex = -1

    const node = lineNodes[index]
    if (!node) return
    node.classList.add('is-active')
    lineNodes[index - 1]?.classList.add('is-near')
    lineNodes[index + 1]?.classList.add('is-near')

    alignToActive()
  }

  function pauseFollow () {
    if (!userScrolling) {
      userScrolling = true
      scroller.classList.add('is-user-scrolling')
      resumeButton.classList.add('is-visible')
    }
    if (resumeTimer) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(resumeFollow, RESUME_DELAY)
  }

  function resumeFollow () {
    if (resumeTimer) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
    if (!userScrolling) return
    userScrolling = false
    scroller.classList.remove('is-user-scrolling')
    resumeButton.classList.remove('is-visible')
    scroller.scrollTop = 0
    // 先把位移归零，再按布局位置重新对齐
    inner.style.transition = 'none'
    inner.style.transform = 'translateY(0)'
    translateY = 0
    void inner.offsetHeight
    alignToActive({ animated: true })
  }

  on(scroller, 'wheel', (event) => {
    if (lineNodes.length) {
      pauseFollow()
      void event
    }
  }, { passive: true })

  on(scroller, 'pointerdown', () => {
    if (lineNodes.length) pauseFollow()
  })

  on(scroller, 'keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) pauseFollow()
  })

  /* ------------------------------ 事件 ------------------------------ */

  bus.on(EVENTS.LYRICS_LOADED, () => {
    userScrolling = false
    scroller.classList.remove('is-user-scrolling')
    resumeButton.classList.remove('is-visible')
    scroller.scrollTop = 0
    render()
    // 立即对齐到当前播放位置，避免打开面板时歌词还在顶部
    const index = player.activeLyricIndex(player.getTime())
    if (index >= 0) {
      activeIndex = -1
      setActive(index)
      alignToActive({ animated: false })
    }
  })

  bus.on(EVENTS.LYRICS_ACTIVE, ({ index }) => {
    setActive(index)
  })

  bus.on(EVENTS.TIME, ({ time }) => {
    if (activeIndex < 0 || activeIndex === lastKaraokeIndex) return
    const line = store.get().lyrics.lines?.[activeIndex]
    if (!line?.words?.length) return
    const node = lineNodes[activeIndex]
    const wordsNode = node?.querySelector('.lyrics__words')
    if (!wordsNode) return
    wordsNode.style.setProperty('--karaoke', `${(karaokeProgress(line, time) * 100).toFixed(1)}%`)
  })

  store.select((state) => state.settings.lyricFontScale, (scale) => {
    element.style.setProperty('--lyric-scale', String(scale))
    alignToActive({ animated: false })
  })

  store.select((state) => state.lyrics.status, () => render())

  const resizeObserver = new ResizeObserver(() => alignToActive({ animated: false }))
  resizeObserver.observe(scroller)

  buildToolbar()

  return {
    element,
    render,
    alignToActive,
    get activeIndex () {
      return activeIndex
    }
  }
}
