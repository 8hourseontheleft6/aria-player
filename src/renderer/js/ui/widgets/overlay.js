/** 浮层：弹出面板 / 右键菜单 / Toast */

import { h, on, onOutsideClick } from '../../core/dom.js'
import { icon } from '../../core/icons.js'

let layerRoot = null
/** @type {Set<{close: Function}>} */
const openLayers = new Set()

function root () {
  if (!layerRoot) layerRoot = document.getElementById('layer-root')
  return layerRoot
}

export function closeAllLayers () {
  for (const layer of [...openLayers]) layer.close()
}

/** 在锚点附近弹出一个面板 */
export function openPopover ({ anchor, content, placement = 'top-end', gap = 8, onClose }) {
  closeAllLayers()
  const node = h('div', { class: 'popover', role: 'dialog' }, content)
  root().appendChild(node)

  const rect = anchor.getBoundingClientRect()
  const width = node.offsetWidth
  const height = node.offsetHeight
  let left
  let top

  if (placement.startsWith('top')) top = rect.top - height - gap
  else top = rect.bottom + gap

  if (placement.endsWith('end')) left = rect.right - width
  else if (placement.endsWith('center')) left = rect.left + rect.width / 2 - width / 2
  else left = rect.left

  left = Math.max(10, Math.min(left, window.innerWidth - width - 10))
  top = Math.max(10, Math.min(top, window.innerHeight - height - 10))

  node.style.left = `${left}px`
  node.style.top = `${top}px`
  node.style.setProperty('--popover-origin', placement.startsWith('top') ? 'bottom center' : 'top center')

  let closed = false
  const layer = {
    element: node,
    close () {
      if (closed) return
      closed = true
      openLayers.delete(layer)
      disposeOutside()
      node.remove()
      onClose?.()
    }
  }
  const disposeOutside = onOutsideClick(node, () => layer.close())
  openLayers.add(layer)
  return layer
}

/**
 * 右键菜单。
 * @param {{x:number, y:number, items:Array<object>}} options
 * items: { label, icon, onClick, disabled, checked } | { separator: true } | { header: true }
 * onClick 会收到菜单的落点 { x, y } —— 有的动作要基于它再弹一个面板。
 */
export function showContextMenu ({ x, y, items = [] }) {
  closeAllLayers()
  const node = h('div', { class: 'menu', role: 'menu' })

  for (const item of items) {
    if (item.separator) {
      node.appendChild(h('div', { class: 'menu__separator' }))
      continue
    }
    // 分组标题（例如「已选中 12 首」）：不是可点的项
    if (item.header) {
      node.appendChild(h('div', { class: 'menu__header', text: item.label }))
      continue
    }
    const row = h('button', {
      class: `menu__item${item.disabled ? ' is-disabled' : ''}${item.danger ? ' is-danger' : ''}`,
      type: 'button',
      onClick: () => {
        layer.close()
        item.onClick?.({ x, y })
      }
    },
    item.icon ? icon(item.icon, { className: 'icon icon--stroke' }) : null,
    h('span', { class: 'truncate', text: item.label }),
    item.checked ? icon('checkmark', { className: 'icon icon--stroke' }) : null)
    node.appendChild(row)
  }

  root().appendChild(node)

  const width = node.offsetWidth
  const height = node.offsetHeight
  node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`
  node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`

  let closed = false
  const layer = {
    element: node,
    close () {
      if (closed) return
      closed = true
      openLayers.delete(layer)
      disposeOutside()
      node.remove()
    }
  }
  const disposeOutside = onOutsideClick(node, () => layer.close())
  openLayers.add(layer)
  return layer
}

/* ------------------------------ Toast ------------------------------ */

let toastLayer = null

export function toast ({ message, type = 'info', icon: iconName = 'info', duration = 2400 }) {
  if (!toastLayer) {
    toastLayer = h('div', { class: 'toast-layer' })
    root().appendChild(toastLayer)
  }

  const node = h('div', { class: `toast toast--${type}` },
    icon(type === 'error' ? 'info' : (iconName || 'info'), { className: 'icon icon--stroke' }),
    h('span', { text: message })
  )
  toastLayer.appendChild(node)

  const remove = () => {
    node.classList.add('is-leaving')
    setTimeout(() => node.remove(), 200)
  }
  const timer = setTimeout(remove, duration)
  on(node, 'click', () => {
    clearTimeout(timer)
    remove()
  })

  // 最多同时显示 3 条
  while (toastLayer.children.length > 3) toastLayer.firstElementChild.remove()
  return remove
}

/** 一个竖向的操作列表（面板里常用） */
export function popoverRows (rows) {
  const nodes = []
  for (const row of rows) {
    if (row.separator) {
      nodes.push(h('div', { class: 'popover__sep' }))
      continue
    }
    if (row.title) {
      nodes.push(h('div', { class: 'popover__title', text: row.title }))
      continue
    }
    const children = [
      h('span', { class: 'truncate', text: row.label }),
      row.value !== undefined ? h('span', { class: 'settings__row-value', text: String(row.value) }) : null,
      row.control || null
    ].filter(Boolean)

    nodes.push(row.onClick
      ? h('button', {
        class: `popover__row${row.danger ? ' is-danger' : ''}`,
        type: 'button',
        onClick: row.onClick
      }, children)
      : h('div', { class: 'popover__row' }, children))
  }
  return nodes
}
