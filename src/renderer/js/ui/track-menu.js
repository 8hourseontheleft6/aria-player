/** 曲目右键菜单：内置动作 + 插件注册的 trackAction（选中多首时切换成批量菜单） */

import { showContextMenu } from './overlay.js'
import { openPlaylistPicker } from './playlist-picker.js'
import { EVENTS } from '../core/bus.js'
import { formatDuration } from '../core/format.js'

export function createTrackMenu ({ store, bus, player, host, actions }) {
  function open (track, event, options = {}) {
    if (!track) return
    const state = store.get()
    const selection = state.ui.selection || []
    /*
     * 右键点在「已经选中的一批」里 → 整批操作。
     * 只选了一首不算批量（那就是普通菜单），否则每个单项操作都会多一层确认。
     */
    if (selection.length > 1 && selection.includes(track.id)) {
      openBatch(selection, options.list || null, event)
      return
    }
    const isCurrent = state.playback.trackId === track.id
    const inQueue = player.playlist.queue.includes(track.id)

    const items = [
      {
        label: isCurrent ? '重新开始播放' : '播放',
        icon: 'play',
        onClick: () => actions.playTrack(track)
      },
      {
        label: '下一首播放',
        icon: 'arrowRight',
        onClick: () => player.playNext(track.id)
      },
      {
        label: '添加到播放列表…',
        icon: 'queueAdd',
        onClick: (point) => openPlaylistPicker({
          anchor: fakeAnchor(point),
          actions,
          bus,
          trackIds: [track.id],
          playlistId: actions.currentPlaylist()?.id || null
        })
      },
      {
        label: '从队列中移除',
        icon: 'minus',
        disabled: !inQueue,
        onClick: () => player.removeFromQueue(track.id)
      },
      { separator: true },
      {
        label: '选择多首',
        icon: 'checkmark',
        onClick: () => {
          actions.setSelection([track.id], track.id)
          bus.emit(EVENTS.TOAST, {
            message: '按住 Ctrl 点其它歌可以多选，Shift 点选一整段',
            type: 'info',
            duration: 3200
          })
        }
      },
      {
        label: '在文件夹中显示',
        icon: 'folder',
        onClick: () => actions.revealTrack(track)
      },
      {
        label: '复制歌曲信息',
        icon: 'external',
        onClick: () => actions.copyTrackInfo(track)
      },
      {
        label: '定位到正在播放',
        icon: 'target',
        disabled: !state.playback.trackId,
        onClick: () => actions.locateCurrent()
      }
    ]

    /* 插件注册的动作 */
    const pluginActions = host.list('trackAction')
      .slice()
      .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
      .filter((action) => (typeof action.enabled === 'function' ? action.enabled(track, state) : true))

    if (pluginActions.length) {
      items.push({ separator: true })
      for (const action of pluginActions) {
        items.push({
          label: typeof action.label === 'function' ? action.label(track) : action.label,
          icon: action.icon || 'sparkles',
          onClick: () => {
            try {
              action.run(track, { store, bus, player, actions })
            } catch (err) {
              console.error(`[track-action] ${action.id} 执行失败`, err)
              bus.emit(EVENTS.TOAST, { message: `操作失败：${err.message}`, type: 'error' })
            }
          }
        })
      }
    }

    const x = event?.clientX ?? event?.x ?? window.innerWidth / 2
    const y = event?.clientY ?? event?.y ?? window.innerHeight / 2
    showContextMenu({ x, y, items })
  }

  /** 批量菜单：只列「一批歌」才有意义的动作 */
  function openBatch (selection, order, event) {
    const count = selection.length
    const items = [
      { header: true, label: `已选中 ${count} 首` },
      {
        label: `播放这 ${count} 首`,
        icon: 'play',
        onClick: () => actions.playSelection(order)
      },
      {
        label: '下一首播放',
        icon: 'arrowRight',
        onClick: () => actions.queueSelection('next', order)
      },
      {
        label: '添加到播放列表…',
        icon: 'queueAdd',
        onClick: (point) => openPlaylistPicker({
          anchor: fakeAnchor(point),
          actions,
          bus,
          trackIds: selection,
          playlistId: actions.currentPlaylist()?.id || null,
          onDone: () => actions.clearSelection()
        })
      },
      {
        label: '从队列中移除',
        icon: 'minus',
        onClick: () => {
          for (const id of selection) player.removeFromQueue(id)
          bus.emit(EVENTS.TOAST, { message: `已从队列移除 ${count} 首`, type: 'info' })
          actions.clearSelection()
        }
      },
      { separator: true },
      {
        label: '取消选择',
        icon: 'close',
        onClick: () => actions.clearSelection()
      }
    ]
    const x = event?.clientX ?? event?.x ?? window.innerWidth / 2
    const y = event?.clientY ?? event?.y ?? window.innerHeight / 2
    showContextMenu({ x, y, items })
  }

  /** 右键菜单是浮层，没有 DOM 锚点 —— 用点击位置做一个假锚点给它定位 */
  function fakeAnchor (event) {
    const x = event?.clientX ?? event?.x ?? window.innerWidth / 2
    const y = event?.clientY ?? event?.y ?? window.innerHeight / 2
    return { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }) }
  }

  function describe (track) {
    return [
      track.title,
      track.artist,
      track.album,
      formatDuration(track.duration, { forceHours: false }),
      track.path
    ].filter(Boolean).join(' — ')
  }

  return { open, describe }
}
