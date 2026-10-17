/**
 * 窗口边缘的缩放把手。
 *
 * 为什么需要：这是个**无边框**窗口（frame: false）。Windows 上无边框窗口的"系统缩放边框"
 * 有时候能用、有时候不行（实测用户那边是**完全拖不动边缘**）。与其赌系统行为，不如自己画
 * 八块透明把手（四边 + 四角）覆盖在窗口边缘上：
 *   · 它们带 `-webkit-app-region: no-drag`，所以鼠标事件能到达渲染层；
 *   · pointerdown 时把"从哪条边、按在什么比例位置"交给主进程，
 *     主进程用 screen.getCursorScreenPoint() 驱动 setBounds（与"最大化拖出"同一套思路）。
 *
 * 最大化 / 全屏时整层隐藏：那时边缘在屏幕外，留着只会挡住滚动条。
 */
import { h, on } from '../../core/dom.js'
import { remote } from '../../core/remote.js'

const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

export function createResizeHandles () {
  const element = h('div', { class: 'resize-handles' })

  for (const edge of EDGES) {
    const handle = h('div', { class: `resize-handle resize-handle--${edge}`, 'data-edge': edge })
    on(handle, 'pointerdown', (event) => {
      if (event.button !== 0) return
      const root = element.getBoundingClientRect()
      /*
       * 光标相对整个窗口的比例：主进程据此算出"露在外面的那块"新尺寸，
       * 拖左/上边时窗口的左/上坐标也要跟着动，所以比例比像素更好用。
       */
      const ratioX = root.width ? (event.clientX - root.left) / root.width : 0.5
      const ratioY = root.height ? (event.clientY - root.top) / root.height : 0.5
      Promise.resolve(remote.window.beginResize({ edge, ratioX, ratioY })).catch(() => {})
      event.preventDefault()

      const stop = () => {
        Promise.resolve(remote.window.endResize()).catch(() => {})
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
        window.removeEventListener('blur', stop)
      }
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
      window.addEventListener('blur', stop)
    })
    element.appendChild(handle)
  }

  /** 最大化 / 全屏时把把手藏起来（边缘在屏幕外，留着会挡住滚动条） */
  const applyState = () => {
    const maximized = document.body.classList.contains('is-maximized')
    element.classList.toggle('is-hidden', maximized)
  }
  applyState()
  const observer = new MutationObserver(applyState)
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })

  return { element, dispose: () => observer.disconnect() }
}
