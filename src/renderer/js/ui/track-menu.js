/** 曲目右键菜单：内置动作 + 插件注册的 trackAction */

import { showContextMenu, openPopover, popoverRows, closeAllLayers } from './overlay.js'
import { EVENTS } from '../core/bus.js'
import { formatDuration } from '../core/format.js'

export function createTrackMenu ({ store, bus, player, host, actions }) {
  /**
   * 「添加到播放列表」：列出所有自建播放列表，最后一项是新建。
   * 菜单里不嵌套子菜单（右键菜单没有二级），所以这里另开一个小面板。
   */
  function openPlaylistPicker ({ anchor, track }) {
    const playlist = actions.currentPlaylist()
    const rows = actions.playlists().map((item) => ({
      label: item.name,
      value: `${item.trackIds.length} 首`,
      onClick: async () => {
        closeAllLayers()
        await actions.addTracksToPlaylist(item.id, [track.id])
      }
    }))

    if (playlist) {
      rows.push({ separator: true })
      rows.push({
        label: `从「${playlist.name}」中移除`,
        value: '',
        danger: true,
        onClick: async () => {
          closeAllLayers()
          await actions.removeTrackFromPlaylist(playlist.id, track.id)
          bus.emit(EVENTS.TOAST, { message: `已从「${playlist.name}」移除`, type: 'info' })
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
        await actions.addTracksToPlaylist(created.id, [track.id], { silent: true })
        bus.emit(EVENTS.TOAST, { message: `已新建「${created.name}」并加入 1 首`, type: 'success' })
      }
    })

    openPopover({
      anchor,
      placement: 'bottom-start',
      content: popoverRows([
        { title: playlist ? `添加到播放列表（当前：${playlist.name}）` : '添加到播放列表' },
        ...rows
      ])
    })
  }

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
        label: '添加到播放列表…',
        icon: 'queueAdd',
        onClick: () => openPlaylistPicker({ anchor: { getBoundingClientRect: () => anchorRect(event) }, track })
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

  /** 右键菜单是浮层，没有 DOM 锚点 —— 用点击位置做一个假锚点给它定位 */
  function anchorRect (event) {
    const x = event?.clientX ?? event?.x ?? window.innerWidth / 2
    const y = event?.clientY ?? event?.y ?? window.innerHeight / 2
    return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 }
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
