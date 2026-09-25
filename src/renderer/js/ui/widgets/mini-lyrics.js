/**
 * 迷你歌词：3~5 行的同步滚动歌词，用于媒体墙的聚焦块这类小尺寸容器。
 * 与大歌词视图共用状态（store.lyrics + LYRICS_ACTIVE 事件），但不可交互、不做偏移设置。
 *
 * 双语歌词必须同时渲染主歌词与翻译行：中文歌词文件常见的形式是
 * 「中文在前、英文在后、时间戳相同」，只取 line.text 就会变成
 * 前面几行英文、后面全是中文，看起来像「只剩翻译了」。
 */

import { h, clear } from '../../core/dom.js'
import { EVENTS } from '../../core/bus.js'

export function createMiniLyrics ({ store, bus, player, className = '' }) {
  const inner = h('div', { class: 'mini-lyrics__inner' })
  const element = h('div', { class: `mini-lyrics ${className}`.trim() }, inner)

  /** @type {HTMLElement[]} */
  let lineNodes = []
  let activeIndex = -1
  let translateY = 0

  /** 一行 = 主歌词（+ 可选的翻译行） */
  function createLine (text, translation) {
    return h('div', { class: 'mini-lyrics__line' },
      h('div', { class: 'mini-lyrics__main', text }),
      translation ? h('div', { class: 'mini-lyrics__sub', text: translation }) : null)
  }

  function render () {
    const lyrics = store.get().lyrics
    clear(inner)
    lineNodes = []
    activeIndex = -1
    translateY = 0
    inner.style.transform = 'none'

    if (lyrics.lines?.length) {
      for (const line of lyrics.lines) {
        lineNodes.push(createLine(line.text, line.translation))
      }
    } else if (lyrics.plain?.length) {
      for (const text of lyrics.plain) lineNodes.push(createLine(text, ''))
    }

    if (!lineNodes.length) {
      const message = lyrics.status === 'loading'
        ? '正在载入歌词…'
        : lyrics.status === 'empty' ? '纯音乐，请欣赏' : '暂无歌词'
      inner.appendChild(h('div', { class: 'mini-lyrics__empty', text: message }))
      return
    }

    inner.append(...lineNodes)

    // 直接对齐到当前播放位置，避免刚显示时还停在第一行
    setActive(player ? player.activeLyricIndex(player.getTime()) : -1, { silent: true })
    align()
  }

  function align () {
    const node = lineNodes[activeIndex]
    const viewHeight = element.clientHeight
    if (!node || !viewHeight) return
    const lineRect = node.getBoundingClientRect()
    const boxRect = element.getBoundingClientRect()
    const layoutTop = lineRect.top - boxRect.top - translateY
    const target = viewHeight / 2 - layoutTop - lineRect.height / 2
    if (Math.abs(target - translateY) < 0.5) return
    translateY = target
    inner.style.transform = `translateY(${target}px)`
  }

  function setActive (index, { silent = false } = {}) {
    if (index === activeIndex) return
    lineNodes[activeIndex]?.classList.remove('is-active')
    lineNodes[activeIndex]?.classList.remove('is-near')
    lineNodes[index - 1]?.classList.remove('is-near')
    lineNodes[index + 1]?.classList.remove('is-near')

    activeIndex = index
    const node = lineNodes[index]
    if (!node) return
    node.classList.add('is-active')
    lineNodes[index - 1]?.classList.add('is-near')
    lineNodes[index + 1]?.classList.add('is-near')
    if (!silent) align()
  }

  bus.on(EVENTS.LYRICS_LOADED, () => {
    render()
    // 容器刚拿到新内容时高度可能还在变，等一帧再对齐
    requestAnimationFrame(align)
  })
  bus.on(EVENTS.LYRICS_ACTIVE, ({ index }) => setActive(index))
  store.select((state) => state.lyrics.status, () => render())

  render()

  return {
    element,
    render,
    align,
    setActive,
    /** 容器尺寸变化后（例如被移动到别的格子）重新对齐 */
    reflow: () => requestAnimationFrame(align)
  }
}
