/** 曲目右键菜单：内置动作 + 插件注册的 trackAction */

import { showContextMenu } from './overlay.js'
import { EVENTS } from '../core/bus.js'
import { formatDuration } from '../core/format.js'

export function createTrackMenu ({ store, bus, player, host, actions }) {
  function open (track, event) {
    if (!track) return
    const state = store.get()
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
        label: '从队列中移除',
        icon: 'minus',
        disabled: !inQueue,
        onClick: () => player.removeFromQueue(track.id)
      },
      { separator: true },
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
