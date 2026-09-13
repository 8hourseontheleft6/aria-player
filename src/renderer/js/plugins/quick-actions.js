/**
 * 示例插件 ②：快捷动作与「只播一次」模式。
 *
 * 演示 `trackAction`（曲目右键菜单）与 `playbackMode`（自定义播放模式）两个扩展点。
 * 想写自己的插件，照着这个文件的形状复制一份即可。
 */

import { EVENTS } from '../core/bus.js'

export const quickActions = {
  id: 'quick-actions',
  name: '快捷动作',

  setup (api) {
    /* ---------- 1) 曲目右键菜单动作 ---------- */
    api.register('trackAction', {
      id: 'copy-file-path',
      label: '复制文件路径',
      icon: 'external',
      order: 10,
      run (track, { bus }) {
        navigator.clipboard?.writeText(track.path)
        bus.emit(EVENTS.TOAST, { message: '已复制文件路径', type: 'success' })
      }
    })

    api.register('trackAction', {
      id: 'copy-track-info',
      label: '复制「歌名 - 歌手」',
      icon: 'lyrics',
      order: 20,
      run (track, { bus }) {
        navigator.clipboard?.writeText(`${track.title} - ${track.artist}`)
        bus.emit(EVENTS.TOAST, { message: '已复制歌曲信息', type: 'success' })
      }
    })

    /* ---------- 2) 自定义播放模式 ---------- */
    api.register('playbackMode', {
      id: 'play-once',
      name: '只播放一次',
      short: '单次',
      icon: 'stop',
      description: '播完当前曲目就停下来',
      onEnded: () => 'stop',
      onNext: ({ hasNext }) => (hasNext ? 'next' : null),
      onPrev: ({ hasPrev }) => (hasPrev ? 'prev' : null)
    })
  }
}
