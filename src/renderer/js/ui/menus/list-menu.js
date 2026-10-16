/**
 * 列表右上角的「⋯」菜单。
 *
 * 放的是「整页级」的操作 —— 现在只有「选择多个歌曲」这一条。
 *
 * 为什么批量选择要从这里开始，而不是在行上悬停就露出勾选框：
 * 列表平时就是「点一下选中、双击播放」，到处都能勾选会让这两种手势互相打架，
 * 用户会莫名其妙地进入一个自己没想进的状态。多选是一个**单独的动作**，
 * 有一个明确的入口（外加右键菜单里那条），进去之后才谈得上勾选。
 */

import { h } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { openPopover, popoverRows, closeAllLayers } from '../widgets/overlay.js'
import { modLabel, keyHint } from '../../core/format.js'

/**
 * @param {object} options
 * @param {object} options.actions
 * @param {() => object[]} [options.getTracks] 当前列表的曲目（「全选」用）
 * @param {Array<object>} [options.items] 追加项（{ label, value, onClick, danger } | { separator: true }）
 */
export function createListMenuButton ({ actions, getTracks = null, items = [] }) {
  const button = h('button', {
    class: 'btn btn--icon',
    type: 'button',
    title: '更多操作',
    onClick: () => open()
  }, icon('ellipsis', { className: 'icon icon--stroke' }))

  function open () {
    const tracks = typeof getTracks === 'function' ? (getTracks() || []) : []

    openPopover({
      anchor: button,
      placement: 'bottom-end',
      content: popoverRows([
        { title: '列表操作' },
        {
          label: '选择多个歌曲',
          value: modLabel(),
          onClick: () => {
            closeAllLayers()
            actions.startSelection()
          }
        },
        {
          label: '全选',
          value: keyHint('A'),
          onClick: () => {
            closeAllLayers()
            actions.startSelection()
            actions.setSelection(tracks.map((track) => track.id))
          }
        },
        ...items
      ])
    })
  }

  return button
}
