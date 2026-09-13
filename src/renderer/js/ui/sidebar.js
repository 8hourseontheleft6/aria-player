/** 侧边栏：资料库来源、音乐文件夹、设置入口、扫描状态 */

import { h, on, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { formatDurationLong } from '../core/format.js'
import { EVENTS } from '../core/bus.js'

function row ({ iconName, label, count, selected, onClick, action }) {
  const node = h('button', {
    class: `sidebar__row${selected ? ' is-selected' : ''}`,
    type: 'button',
    title: label,
    onClick
  },
  icon(iconName, { className: 'icon icon--stroke' }),
  h('span', { class: 'truncate', text: label }),
  count !== undefined ? h('span', { class: 'sidebar__row-count', text: String(count) }) : null,
  action || null)
  return node
}

export function createSidebar ({ store, bus, actions }) {
  const scroll = h('div', { class: 'sidebar__scroll scroll' })
  const footer = h('div', { class: 'sidebar__footer' })
  const element = h('aside', { class: 'sidebar' }, scroll, footer)

  function render () {
    const state = store.get()
    const { ui, library, playback } = state
    const albumCount = actions.albums?.().length || 0
    const artistCount = actions.artists?.().length || 0
    clear(scroll)
    clear(footer)

    /* ---------------- 资料库 ---------------- */
    const librarySection = h('div', { class: 'sidebar__section' },
      h('div', { class: 'sidebar__section-head' }, h('span', { text: '资料库' })),
      row({
        iconName: 'music',
        label: '正在播放',
        selected: ui.nowPlayingOpen,
        onClick: () => actions.openNowPlaying()
      }),
      row({
        iconName: 'list',
        label: '全部歌曲',
        count: library.tracks.length || undefined,
        selected: ui.view === 'songs' && ui.source.type === 'all',
        onClick: () => actions.setSource({ type: 'all', value: null })
      }),
      row({
        iconName: 'disc',
        label: '专辑',
        count: albumCount || undefined,
        selected: ui.view === 'albums',
        onClick: () => actions.setView('albums')
      }),
      row({
        iconName: 'artist',
        label: '艺人',
        count: artistCount || undefined,
        selected: ui.view === 'artists',
        onClick: () => actions.setView('artists')
      }),
      row({
        iconName: 'wall',
        label: '媒体墙',
        selected: ui.view === 'wall',
        onClick: () => actions.setView('wall')
      }),
      row({
        iconName: 'waveform',
        label: '播放队列',
        count: playback.queue.length || undefined,
        selected: ui.queueOpen,
        onClick: () => actions.toggleQueue()
      })
    )
    scroll.appendChild(librarySection)

    /* ---------------- 文件夹 ---------------- */
    const folders = library.folders
    const folderSection = h('div', { class: 'sidebar__section' },
      h('div', { class: 'sidebar__section-head' },
        h('span', { text: '音乐文件夹' }),
        h('button', {
          class: 'sidebar__row-action',
          type: 'button',
          title: '添加文件夹',
          onClick: () => actions.addFolder()
        }, icon('plus', { className: 'icon icon--stroke' }))
      )
    )

    if (!folders.length) {
      folderSection.appendChild(h('div', { class: 'sidebar__hint', text: '还没有音乐文件夹，点右上角 + 添加。' }))
    } else {
      for (const folder of folders) {
        const name = folder.split(/[\\/]/).filter(Boolean).pop() || folder
        const count = library.tracks.filter((track) => track.path.startsWith(folder)).length
        folderSection.appendChild(row({
          iconName: 'folder',
          label: name,
          count: count || undefined,
          selected: ui.source.type === 'folder' && ui.source.value === folder,
          onClick: () => actions.setSource({ type: 'folder', value: folder }),
          action: h('span', {
            class: 'sidebar__row-action',
            title: '从资料库移除',
            onClick: (event) => {
              event.stopPropagation()
              actions.removeFolder(folder)
            }
          }, icon('close', { className: 'icon icon--stroke' }))
        }))
      }
    }

    scroll.appendChild(folderSection)

    /* ---------------- 底部 ---------------- */
    footer.appendChild(row({
      iconName: 'sliders',
      label: '设置',
      selected: ui.view === 'settings',
      onClick: () => actions.setView('settings')
    }))

    const stats = library.tracks.length
      ? `${library.tracks.length} 首 · ${formatDurationLong(library.totalDuration)}`
      : '资料库为空'
    footer.appendChild(h('div', { class: 'sidebar__hint', text: stats }))
  }

  bus.on(EVENTS.LIBRARY_UPDATED, render)
  bus.on(EVENTS.TRACK_CHANGED, render)
  store.subscribe((state, prev) => {
    if (state.ui === prev.ui && state.library === prev.library) return
    render()
  })

  render()
  return { element, render }
}
