/**
 * 各标签页共用的搜索框。
 *
 * 背景：搜索原本只挂在「全部歌曲」页的工具栏上，于是想按歌手找歌的人得
 * 「回全部歌曲 → 搜 Taylor → 再切到艺人页」，很别扭（用户反馈）。
 *
 * 做法：三处（专辑 / 艺人 / 可选媒体墙）各挂一只**同源**的搜索框，
 * 都读写同一个 `ui.query` —— 一个词输入一次，所有页面同时生效；
 * 各页副标题本来就会显示「匹配「Taylor」的 N 张专辑 / N 位艺人」，天然有反馈。
 *
 * 样式复用 components.css 里已有的 `.search` 系列，不另造一套外观。
 * 与全部歌曲那只的区别：这里**不带范围与历史面板**（那是歌曲页的专属能力），
 * 只做「输入 → 过滤 → 清空」。
 */

import { h, on } from '../../core/dom.js'
import { icon } from '../../core/icons.js'

export function createSearchBox ({ store, actions, placeholder = '搜索…', width = 180 }) {
  const input = h('input', {
    type: 'search',
    placeholder,
    spellcheck: 'false',
    'aria-label': placeholder
  })

  const clearButton = h('button', {
    class: 'search__clear',
    type: 'button',
    title: '清空搜索',
    onClick: () => {
      // 直接写 store：清空后各页都会跟着回到完整列表
      actions.setQuery('')
      input.value = ''
      input.focus()
    }
  }, icon('close', { className: 'icon icon--stroke' }))

  const element = h('div', { class: 'search', style: { width: `${width}px` } },
    icon('search', { className: 'icon icon--stroke' }),
    input,
    clearButton
  )

  // 输入即过滤（各页的渲染签名都包含 ui.query，所以会自己重排）
  on(input, 'input', () => actions.setQuery(input.value))
  on(input, 'keydown', (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    actions.setQuery('')
    input.value = ''
    input.blur()
  })

  // 别的页面 / 快捷键改了查询词，这里要跟着显示
  store.select((state) => state.ui.query || '', (query) => {
    if (input.value !== query) input.value = query
    element.classList.toggle('has-value', Boolean(query))
  })

  return {
    element,
    focus: () => input.focus()
  }
}
