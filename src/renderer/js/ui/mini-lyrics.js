/**
 * 迷你歌词：3~5 行的同步滚动歌词，用于媒体墙的聚焦块这类小尺寸容器。
 * 与大歌词视图共用状态（store.lyrics + LYRICS_ACTIVE 事件），但不可交互、不做偏移设置。
 */

import { h, clear } from '../core/dom.js'
import { EVENTS } from '../core/bus.js'

export function createMiniLyrics ({ store, bus, player, className = '' }) {
  const inner = h('div', { class: 'mini-lyrics__inner' })
  const element = h('div', { class: `mini-lyrics ${className}`.trim() }, inner)

  /** @type {HTMLElement[]} */
  let lineNodes = []
  let activeIndex = -1
  let translateY = 0

  function render () {
    const lyrics = store.get().lyrics
    clear(inner)
    lineNodes = []
    activeIndex = -1
    translateY = 0
    inner.style.transform = 'none'

    let texts = []
    if (lyrics.lines?.length) texts = lyrics.lines.map((line) => line.text)
    else if (lyrics.plain?.length) texts = lyrics.plain

    if (!texts.length) {
      const message = lyrics.status === 'loading'
        ? '正在载入歌词…'
        : lyrics.status === 'empty' ? '纯音乐，请欣赏' : '暂无歌词'
      inner.appendChild(h('div', { class: 'mini-lyrics__empty', text: message }))
      return
    }

    for (const text of texts) {
      lineNodes.push(h('div', { class: 'mini-lyrics__line', text: text }))
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
