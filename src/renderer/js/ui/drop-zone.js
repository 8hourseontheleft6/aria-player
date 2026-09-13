/**
 * 拖拽导入：把文件夹或歌曲拖进窗口。
 *
 * 只做「显示拖放界面 + 取路径 + 把结果转成播放/提示」，
 * 具体的判断（是否已在资料库、要不要加目录）交给主进程，避免两边逻辑分叉。
 */

import { h, on } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { remote } from '../core/remote.js'
import { EVENTS } from '../core/bus.js'

export function createDropZone ({ bus, actions }) {
  const title = h('div', { class: 'drop-zone__title', text: '松开即可导入' })
  const subtitle = h('div', {
    class: 'drop-zone__text',
    text: '文件夹会加入资料库；歌曲会立即播放'
  })

  const element = h('div', { class: 'drop-zone' },
    h('div', { class: 'drop-zone__card' },
      icon('plus', { className: 'icon icon--stroke drop-zone__icon' }),
      title,
      subtitle
    )
  )

  let depth = 0

  function hasFiles (event) {
    const types = event.dataTransfer?.types
    if (!types) return false
    return [...types].includes('Files')
  }

  function show () {
    element.classList.add('is-active')
  }

  function hide () {
    depth = 0
    element.classList.remove('is-active')
  }

  on(window, 'dragenter', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth++
    show()
  })

  on(window, 'dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  })

  on(window, 'dragleave', (event) => {
    if (!hasFiles(event)) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) hide()
  })

  on(window, 'drop', async (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    hide()

    const files = event.dataTransfer?.files
    const paths = remote.paths.fromFiles(files)
    if (!paths.length) {
      bus.emit(EVENTS.TOAST, { message: '没能读取到文件路径（只支持从资源管理器拖入）', type: 'error' })
      return
    }

    let result
    try {
      result = await remote.library.handleDrop(paths)
    } catch (err) {
      bus.emit(EVENTS.TOAST, { message: `导入失败：${err.message}`, type: 'error' })
      return
    }

    if (result.action === 'play' && result.trackIds.length) {
      actions.playDroppedTracks(result.trackIds)
      return
    }

    if (result.action === 'added') {
      bus.emit(EVENTS.TOAST, {
        message: `已加入 ${result.added.length} 个文件夹，正在扫描…`,
        type: 'success'
      })
      return
    }

    const reasons = new Set((result.rejected || []).map((item) => item.reason))
    const message = reasons.has('not-audio')
      ? '拖入的文件不是支持的音频格式'
      : reasons.has('missing')
        ? '拖入的文件或文件夹不存在'
        : '没有可导入的内容'
    bus.emit(EVENTS.TOAST, { message, type: 'error' })
  })

  return { element, show, hide }
}
