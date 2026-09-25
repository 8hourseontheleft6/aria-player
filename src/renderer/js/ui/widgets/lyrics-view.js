/**
 * 歌词视图：
 *  - 时间轴歌词逐行跟随播放滚动（Apple Music 式：当前行高亮放大）
 *  - 用户手动滚动时暂停跟随，并提供「回到当前」
 *  - 支持翻译行、逐字（卡拉OK）高亮、纯文本歌词
 *  - 内置偏移与字号调节
 *
 * 关于「只能往下翻、翻不上去」的那个 bug：
 *
 * 跟随是靠 `transform: translateY(-N px)` 把当前行推到正中的，而 `.lyrics`
 * 本身是个原生滚动容器（`overflow-y: auto`，滚动条隐藏）。当歌曲放到后半段时，
 * transform 已经是很负的值（内容被推上去一大截），但**容器的 scrollTop 仍然是 0**
 * —— transform 不产生滚动范围。于是用户能往下滚（scrollTop 增加），却没法往上滚
 * （scrollTop 已经贴着 0 了），表现就是「歌词只能往下拖」。
 *
 * 修法是手动滚动开始时做一次交接：把当前的 transform 折成 scrollTop
 * （`scrollTop = -translateY`）并把 transform 归零，视觉位置完全不变，
 * 但从此上下两个方向都是原生滚动，随便翻。回正时再折回去。
 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { EVENTS } from '../../core/bus.js'
import { karaokeProgress } from '../../core/lrc.js'
import { createSlider } from './slider.js'
import { openPopover } from './overlay.js'
import { remote } from '../../core/remote.js'

const RESUME_DELAY = 4200
/** 拖动超过这么多像素才算「在拖歌词」，否则仍然算点击某一行 */
const DRAG_THRESHOLD = 3

export function createLyricsView ({ className = 'lyrics-region', store, bus, player }) {  const inner = h('div', { class: 'lyrics__inner' })
  // tabindex：容器要能拿到焦点，方向键/PageDown 才有地方生效
  const scroller = h('div', { class: 'lyrics scroll', tabindex: '0' }, inner)

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
  /** 跟随播放时 inner 的位移（负数 = 内容被推上去） */
  let followY = 0
  let lastKaraokeIndex = -1
  /** @type {HTMLElement|null} */
  let sourceNode = null
  /** 拖动滚动用：{ pointerId, startY, moved, target } */
  let dragState = null
  /** 拖完紧跟着的那次 click 要吞掉（否则会顺带 seek 到那一行） */
  let suppressClick = false

  /* ------------------------------ 渲染 ------------------------------ */

  function buildToolbar () {
    clear(toolbar)

    const sourceLabel = h('span', { class: 'lyrics-source' })
    sourceNode = sourceLabel

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

    toolbar.append(sourceLabel, adjustButton, reloadButton)
    paintSource()
  }

  /** 显示歌词来源：本地文件显示文件名，在线来源显示提供方 */
  function paintSource () {
    if (!sourceNode) return
    const { source, file } = store.get().lyrics
    if (file) {
      sourceNode.textContent = file
      sourceNode.title = `来自本地歌词文件：${file}`
      sourceNode.classList.remove('is-online')
    } else if (source && !['lrc', 'txt', 'tag'].includes(source)) {
      sourceNode.textContent = source
      sourceNode.title = '歌词来源：在线服务'
      sourceNode.classList.add('is-online')
    } else if (source === 'tag') {
      sourceNode.textContent = '内嵌歌词'
      sourceNode.classList.remove('is-online')
    } else {
      sourceNode.textContent = ''
      sourceNode.classList.remove('is-online')
    }
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
    followY = 0
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
      /*
       * 没歌词时告诉用户「为什么没有」和「怎么办」。
       * 总开关（onlineFeatures）默认是关的 —— 这是当初定的默认（不联网）。
       * 但用户遇到的就是「没有 .lrc 的歌放不出歌词」，所以这里直接给一个开关：
       * 点一下打开总开关 + 歌词源，再重拉一次。
       */
      const onlineOff = store.get().settings.onlineFeatures !== true
      const enableOnline = h('button', {
        class: 'btn btn--primary',
        type: 'button',
        onClick: async () => {
          await remote.settings.set({ onlineFeatures: true, onlineLyrics: true })
          // 等设置落到 store 再重拉：插件读的是 store 里的开关
          setTimeout(() => player.reloadLyrics(), 400)
        }
      }, icon('search', { className: 'icon icon--stroke' }), '打开在线歌词')
      showEmpty({
        iconName: 'lyrics',
        title: isEmptyTrack ? '这首歌没有歌词' : '未找到歌词',
        text: onlineOff
          ? '本地没有找到 .lrc 文件。「在线歌词」打开后会自动联网匹配（也可在设置 → 在线功能里切换）。'
          : '把同名 .lrc 文件放在歌曲旁边即可自动加载；也支持「歌名 - 歌手.lrc」这类命名。',
        action: h('div', {
          class: 'lyrics-empty__actions',
          style: { display: 'flex', gap: '8px', justifyContent: 'center' }
        },
        onlineOff ? enableOnline : null,
        h('button', {
          class: onlineOff ? 'btn' : 'btn btn--primary',
          type: 'button',
          onClick: () => player.reloadLyrics()
        }, icon('refresh', { className: 'icon icon--stroke' }), '重新载入')
        )
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
          // 刚拖过歌词的那一下不算点击，否则会顺带跳走
          if (suppressClick) return
          player.seek(Math.max(0, line.time - 0.05))
          resumeFollow()
        }
      }, textNode, line.translation ? h('span', { class: 'lyrics__sub', text: line.translation }) : null)

      return node
    })
    inner.append(...lineNodes)
    activeIndex = -1
    followY = 0
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
    // 可视位置 = 布局位置 - scrollTop + 当前位移
    const layoutTop = lineRect.top - scrollerRect.top + scroller.scrollTop - followY
    const target = viewHeight / 2 - layoutTop - lineRect.height / 2

    if (Math.abs(target - followY) < 1) return
    followY = target
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

  /** 当前最多能滚多远 */
  function maxScrollTop () {
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  }

  function pauseFollow () {
    if (!userScrolling) {
      userScrolling = true
      scroller.classList.add('is-user-scrolling')
      resumeButton.classList.add('is-visible')

      /*
       * 交接：把跟随用的位移折成 scrollTop，然后让 transform 归零。
       * 视觉上完全不动（可视位置以前是 translateY，现在是 -scrollTop），
       * 但从此上下都能滚 —— 这一步就是「翻不上去」的修法本体。
       * 必须在加好 is-user-scrolling（Transition 关掉）之后做，否则会滑一下。
       */
      const handedOver = Math.min(Math.max(-followY, 0), maxScrollTop())
      if (handedOver > 0) {
        inner.style.transform = 'translateY(0)'
        scroller.scrollTop = handedOver
      } else if (followY > 0) {
        // 开头几行本来就被推到了中间，往上没有内容，保持原样即可
        scroller.scrollTop = 0
      }
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
    setScrolling(false)

    // 再把 scrollTop 折回位移，然后从当前位置平滑对齐到当前行
    const handedBack = -scroller.scrollTop
    scroller.scrollTop = 0
    inner.style.transition = 'none'
    inner.style.transform = `translateY(${handedBack}px)`
    followY = handedBack
    void inner.offsetHeight
    alignToActive({ animated: true })
  }

  function setScrolling (active) {
    scroller.classList.toggle('is-dragging', active)
  }

  /* ------------------------------ 手动滚动 ------------------------------ */

  on(scroller, 'wheel', (event) => {
    if (!lineNodes.length) return
    // 交接之后浏览器自己的滚动就能两个方向都走，这里只需要暂停跟随
    pauseFollow()
    void event
  }, { passive: true })

  /*
   * 指针拖动滚动：滚动条是隐藏的（scrollbar-width: none），光靠滚轮在触控板上
   * 还能用，鼠标就没法拖了。这里补一条「抓住歌词上下拖」，顺手把小幅度抖动的
   * 情况让给点击（点某一行要能 seek）。
   */
  on(scroller, 'pointerdown', (event) => {
    if (!lineNodes.length || event.button !== 0) return
    dragState = { pointerId: event.pointerId, startY: event.clientY, moved: false }
  })

  on(scroller, 'pointermove', (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    const dy = event.clientY - dragState.startY
    if (!dragState.moved) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return
      dragState.moved = true
      dragState.startY = event.clientY
      setScrolling(true)
      // 拖之前先做交接，否则 scrollTop 还贴着 0，往上拖不动
      pauseFollow()
      return
    }
    event.preventDefault()
    scroller.scrollTop -= event.clientY - dragState.startY
    dragState.startY = event.clientY
    pauseFollow()
  })

  function endDrag (event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    const moved = dragState.moved
    dragState = null
    setScrolling(false)
    if (moved) {
      // 拖完紧接着的那一次 click 不该被当成「点了这一行」
      suppressClick = true
      setTimeout(() => { suppressClick = false }, 0)
    }
  }

  on(scroller, 'pointerup', endDrag)
  on(scroller, 'pointercancel', endDrag)

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
    paintSource()
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
