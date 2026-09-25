/**
 * 「添加到播放列表…」的小面板。
 *
 * 曲目右键菜单和多选工具条共用它 —— 两边都是「把一首或一批歌加进某个列表」，
 * 只是数量不同，所以做成一个按 id 数组工作的函数。
 */

import { openPopover, popoverRows, closeAllLayers } from '../widgets/overlay.js'

/**
 * @param {object} options
 * @param {HTMLElement|{getBoundingClientRect: Function}} options.anchor 定位锚点
 * @param {object} options.actions 动作集合
 * @param {object} [options.bus] 事件总线（用来弹提示）
 * @param {string[]} options.trackIds 要加入的曲目
 * @param {string|null} [options.playlistId] 当前所在的播放列表（会有「从列表中移除」）
 * @param {Function} [options.onDone] 加完之后回调（例如清掉多选）
 */
export function openPlaylistPicker ({ anchor, actions, bus, trackIds, playlistId = null, onDone = null }) {
  const ids = (Array.isArray(trackIds) ? trackIds : [trackIds]).filter(Boolean)
  if (!ids.length) return null

  const current = playlistId ? actions.playlists().find((item) => item.id === playlistId) : null
  const count = ids.length
  const toast = (payload) => bus?.emit?.('ui:toast', payload)

  const rows = actions.playlists().map((item) => ({
    label: item.name,
    value: `${item.trackIds.length} 首`,
    onClick: async () => {
      closeAllLayers()
      const result = await actions.addTracksToPlaylist(item.id, ids)
      onDone?.(result)
    }
  }))

  if (current) {
    rows.push({ separator: true })
    rows.push({
      label: `从「${current.name}」中移除`,
      value: '',
      danger: true,
      onClick: async () => {
        closeAllLayers()
        for (const id of ids) await actions.removeTrackFromPlaylist(current.id, id)
        toast({ message: `已从「${current.name}」移除 ${count} 首`, type: 'info' })
        onDone?.({ removed: count })
      }
    })
  }

  rows.push({ separator: true })
  rows.push({
    label: '新建播放列表…',
    value: '',
    onClick: async () => {
      closeAllLayers()
      const created = await actions.createPlaylist(`播放列表 ${actions.playlists().length + 1}`)
      if (!created) return
      await actions.addTracksToPlaylist(created.id, ids, { silent: true })
      toast({ message: `已新建「${created.name}」并加入 ${count} 首`, type: 'success' })
      onDone?.({ created: created.id, added: count })
    }
  })

  return openPopover({
    anchor,
    placement: 'bottom-start',
    content: popoverRows([
      { title: current ? `添加到播放列表（当前：${current.name}）` : `添加到播放列表（${count} 首）` },
      ...rows
    ])
  })
}
