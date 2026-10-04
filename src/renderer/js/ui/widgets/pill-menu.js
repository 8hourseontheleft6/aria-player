/**
 * 竖向药丸菜单：设置里的下拉、全屏播放页的均衡器，都用它。
 *
 * 为什么不用原生 select：原生下拉的弹层由系统画，我们能改的只有控件本身，
 * 深色下要么白底要么和整体风格不搭（用户两次反馈）。这里用「按钮 + 浮层」
 * 自己画：一行一个药丸，选中的那颗抬起来（和灵动岛的滑块同一套语言）。
 */

import { h } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { openPopover, closeAllLayers } from '../widgets/overlay.js'
import { popoverRows } from '../widgets/overlay.js'

/**
 * 触发器：显示当前选项，点开是竖向药丸列表。
 * @param {object} options
 * @param {Array<{value:string,label:string,hint?:string}>} options.items
 * @param {string} options.value
 * @param {(value:string) => void} options.onPick
 * @param {boolean} [options.disabled]
 * @param {string} [options.title]
 */
export function createPillSelect ({ items = [], value, onPick, disabled = false, title = '' }) {
  const label = h('span', { class: 'pill-select__label' })
  const button = h('button', {
    class: 'pill-select',
    type: 'button',
    title,
    disabled,
    onClick: () => {
      if (disabled) return
      openPillMenu({ anchor: button, items, value: current(), onPick: (next) => { setValue(next); onPick?.(next) } })
    }
  }, label, icon('chevronDown', { className: 'icon icon--stroke pill-select__chevron' }))

  let currentValue = value
  const current = () => currentValue
  function setValue (next) {
    currentValue = next
    label.textContent = items.find((item) => item.value === next)?.label || String(next)
  }
  setValue(value)

  return {
    element: button,
    setValue,
    /** 选项列表会变（例如设备插拔），换掉之后保持当前值 */
    setItems (next) { items = Array.isArray(next) ? next : []; setValue(currentValue) },
    setDisabled (flag) { button.disabled = Boolean(flag) }
  }
}

/**
 * 浮层：竖向药丸列表（也可用于「开关 / 自动」这类非单选入口）。
 * @param {object} options
 * @param {HTMLElement} options.anchor
 * @param {string} [options.title]
 * @param {Array<object>} options.items { value, label, hint, active, onClick }
 * @param {string} [options.value] 单选模式下的当前值
 * @param {(value:string)=>void} [options.onPick]
 */
export function openPillMenu ({ anchor, title = '', items = [], value = null, onPick = null }) {
  const rows = items.map((item) => {
    const isActive = item.active !== undefined
      ? item.active
      : (value !== null && item.value === value)
    const row = h('button', {
      class: `pill${isActive ? ' is-active' : ''}${item.danger ? ' is-danger' : ''}`,
      type: 'button',
      onClick: () => {
        closeAllLayers()
        if (onPick && item.value !== undefined) onPick(item.value)
        item.onClick?.()
      }
    },
    h('span', { class: 'pill__label', text: item.label }),
    item.hint ? h('span', { class: 'pill__hint', text: item.hint }) : null,
    isActive ? icon('checkmark', { className: 'icon icon--stroke pill__check' }) : null
    )
    return row
  })

  openPopover({
    anchor,
    placement: 'bottom-end',
    content: h('div', { class: 'pill-menu' },
      title ? h('div', { class: 'pill-menu__title', text: title }) : null,
      ...rows
    )
  })
}

export { popoverRows }
