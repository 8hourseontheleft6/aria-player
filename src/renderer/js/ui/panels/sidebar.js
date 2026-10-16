/** 侧边栏：视图导航（可拖动排序）、音乐文件夹、设置入口 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { formatDurationLong, keyHint } from '../../core/format.js'
import { flipReorder } from '../../core/reorder.js'
import { normalizePlaylists } from '../../core/playlists.js'
import { openPopover, popoverRows } from '../widgets/overlay.js'
import { EVENTS } from '../../core/bus.js'

/** 视图项的四个定义；顺序由 settings.sidebarOrder 决定（灵动岛用同一份顺序） */
export const VIEW_ITEMS = {
  songs: {
    iconName: 'list',
    label: '全部歌曲',
    count: ({ state }) => state.library.tracks.length,
    selected: (state) => state.ui.view === 'songs' && state.ui.source.type === 'all',
    /*
     * 点「全部歌曲」必须真的回到歌曲列表。
     * 只调 setSource 不够：它只在当前是设置页时才把视图切回歌曲，
     * 从媒体墙 / 艺人 / 专辑点过来会「什么也没发生」——
     * 用户反馈的「点过媒体墙、艺人后就回不到全部歌曲」就是这个。
     */
    activate: (actions) => {
      actions.setSource({ type: 'all', value: null })
      actions.setView('songs')
    }
  },
  albums: {
    iconName: 'disc',
    label: '专辑',
    count: ({ albumCount }) => albumCount,
    selected: (state) => state.ui.view === 'albums',
    activate: (actions) => actions.setView('albums')
  },
  artists: {
    iconName: 'artist',
    label: '艺人',
    count: ({ artistCount }) => artistCount,
    selected: (state) => state.ui.view === 'artists',
    activate: (actions) => actions.setView('artists')
  },
  wall: {
    iconName: 'wall',
    label: '媒体墙',
    count: () => undefined,
    selected: (state) => state.ui.view === 'wall',
    activate: (actions) => actions.setView('wall')
  }
}

export const VIEW_KEYS = Object.keys(VIEW_ITEMS)

/** 把设置里的顺序规整成一份完整、无重复的键列表 */
export function normalizeOrder (order) {
  const out = []
  for (const key of Array.isArray(order) ? order : []) {
    if (VIEW_ITEMS[key] && !out.includes(key)) out.push(key)
  }
  for (const key of VIEW_KEYS) {
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/** 拖动超过这么多像素才算「在排序」，否则仍然是一次点击 */
const DRAG_THRESHOLD = 5

function row ({ iconName, label, count, selected, onClick, action, draggable }) {
  const node = h('button', {
    class: `sidebar__row${selected ? ' is-selected' : ''}`,
    type: 'button',
    title: label,
    dataset: draggable ? { viewKey: draggable } : {},
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

  const collapseButton = h('button', {
    class: 'sidebar__collapse btn btn--icon',
    type: 'button',
    title: `收起侧栏 (${keyHint('B')})`,
    onClick: () => actions.toggleSidebar()
  }, icon('chevronLeft', { className: 'icon icon--stroke' }))

  const element = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar__head' },
      h('span', { class: 'sidebar__title', text: 'Aria' }),
      collapseButton),
    scroll,
    footer)

  /** 视图行的容器：拖动排序只在这个容器里发生，所以「正在播放」「播放队列」不会被卷进来 */
  const nav = h('div', { class: 'sidebar__nav' })

  /* ------------------------------------------------------------------ */
  /* 拖动排序                                                            */
  /* ------------------------------------------------------------------ */

  /** @type {null | {node: HTMLElement, pointerId: number, startY: number, grabOffset: number, active: boolean}} */
  let drag = null
  /** 拖动结束后紧跟的那一次 click 要吞掉（否则会被当成「切换视图」） */
  let suppressClick = false

  function navRows () {
    return [...nav.children]
  }

  /** 当前 DOM 顺序 → 视图键列表 */
  function currentOrder () {
    return navRows().map((node) => node.dataset.viewKey).filter(Boolean)
  }

  /**
   * 把拖动中的行插到指针所在的位置。
   * 每次重排都用 FLIP 给「其它行」补动画 —— 被拖的那一行不参与 FLIP，
   * 因为它由指针直接驱动（见 onPointerMove 里的重算）。
   */
  function reorderTo (pointerY) {
    const node = drag.node
    const all = navRows()
    const others = all.filter((item) => item !== node)

    let index = others.findIndex((item) => {
      const rect = item.getBoundingClientRect()
      return pointerY < rect.top + rect.height / 2
    })
    if (index === -1) index = others.length

    const desired = [...others]
    desired.splice(index, 0, node)
    if (desired.every((item, i) => item === all[i])) return

    flipReorder(others, () => {
      const next = desired[index + 1]
      if (next) nav.insertBefore(node, next)
      else nav.appendChild(node)
    })
  }

  function onPointerMove (event) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const dy = event.clientY - drag.startY
    if (!drag.active) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return
      drag.active = true
      drag.node.classList.add('is-dragging')
      nav.classList.add('is-reordering')
    }
    event.preventDefault()

    reorderTo(event.clientY)

    /*
     * 让这一行跟着指针走。要点：量之前必须先清掉自己的 transform，
     * 否则 getBoundingClientRect 拿到的是「已经位移过」的位置，越算越偏。
     */
    drag.node.style.transform = ''
    const layoutTop = drag.node.getBoundingClientRect().top
    drag.node.style.transform = `translateY(${event.clientY - drag.grabOffset - layoutTop}px)`
  }

  function endDrag (event) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)

    const { node, active } = drag
    drag = null
    node.classList.remove('is-dragging')
    node.style.transform = ''
    nav.classList.remove('is-reordering')

    if (!active) return

    suppressClick = true
    setTimeout(() => { suppressClick = false }, 0)

    const order = currentOrder()
    const saved = normalizeOrder(store.get().settings.sidebarOrder)
    if (order.join() !== saved.join()) {
      actions.setSetting({ sidebarOrder: order })
      bus.emit(EVENTS.TOAST, { message: '侧栏顺序已保存', type: 'success', duration: 1600 })
    }
  }

  function onPointerDown (event) {
    if (event.button !== 0 || drag) return
    const node = event.currentTarget
    if (event.target.closest('.sidebar__row-action')) return
    const rect = node.getBoundingClientRect()
    drag = {
      node,
      pointerId: event.pointerId,
      startY: event.clientY,
      grabOffset: event.clientY - rect.top,
      active: false
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
  }

  /* ------------------------------------------------------------------ */
  /* 播放列表：新建 / 重命名 / 删除                                       */
  /* ------------------------------------------------------------------ */

  /** 一个小输入弹层：新建和重命名共用（Electron 里没有 window.prompt） */
  function openPlaylistEditor ({ anchor, mode, playlist = null }) {
    const input = h('input', {
      class: 'playlist-editor__input',
      type: 'text',
      value: mode === 'create' ? '' : playlist.name,
      placeholder: '播放列表名称',
      maxlength: '60'
    })

    const popover = openPopover({
      anchor,
      placement: 'bottom-start',
      content: [
        h('div', { class: 'popover__title', text: mode === 'create' ? '新建播放列表' : '重命名播放列表' }),
        h('div', { class: 'playlist-editor' }, input),
        h('div', { class: 'playlist-editor__actions' },
          h('button', {
            class: 'btn btn--sm',
            type: 'button',
            text: '取消',
            onClick: () => popover.close()
          }),
          h('button', {
            class: 'btn btn--sm btn--primary',
            type: 'button',
            text: mode === 'create' ? '创建' : '保存',
            onClick: async () => {
              const name = input.value.trim()
              if (!name) {
                input.focus()
                return
              }
              if (mode === 'create') {
                const created = await actions.createPlaylist(name)
                if (created) actions.openPlaylist(created.id)
              } else {
                await actions.renamePlaylist(playlist.id, name)
              }
              popover.close()
            }
          })
        )
      ]
    })
    setTimeout(() => input.focus(), 30)
    on(input, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const confirmButton = popover.element?.querySelector('.btn--primary')
        confirmButton?.click()
      }
    })
    return popover
  }

  function openPlaylistMenu ({ anchor, playlist }) {
    const popover = openPopover({
      anchor,
      placement: 'bottom-end',
      content: popoverRows([
        { title: playlist.name },
        { label: '播放', value: '', onClick: () => { actions.playPlaylist(playlist.id); popover.close() } },
        { label: '随机播放', value: '', onClick: () => { actions.shufflePlaylist(playlist.id); popover.close() } },
        { separator: true },
        {
          label: '重命名…',
          value: '',
          onClick: () => {
            popover.close()
            openPlaylistEditor({ anchor, mode: 'rename', playlist })
          }
        },
        {
          label: '删除播放列表',
          value: '',
          danger: true,
          onClick: () => {
            popover.close()
            actions.deletePlaylist(playlist.id)
            bus.emit(EVENTS.TOAST, { message: `已删除「${playlist.name}」`, type: 'info' })
          }
        }
      ])
    })
    return popover
  }

  /* ------------------------------------------------------------------ */
  /* 渲染                                                                */
  /* ------------------------------------------------------------------ */

  function render () {
    // 拖动过程中不要重建：重排靠搬动现有节点，重建会把拖动中的那一行抽走
    if (drag && drag.active) return

    const state = store.get()
    const { ui, library, playback } = state
    const nowPlayingOpen = ui.nowPlayingOpen
    const albumCount = actions.albums?.().length || 0
    const artistCount = actions.artists?.().length || 0
    clear(scroll)
    clear(footer)
    clear(nav)

    /* ---------------- 资料库 ---------------- */
    const librarySection = h('div', { class: 'sidebar__section' },
      h('div', { class: 'sidebar__section-head' }, h('span', { text: '资料库' })),
      row({
        iconName: 'music',
        label: '正在播放',
        selected: nowPlayingOpen,
        onClick: () => actions.openNowPlaying()
      })
    )

    // 可拖动排序的四个视图项，顺序来自设置
    const order = normalizeOrder(state.settings.sidebarOrder)
    const counts = { state, albumCount, artistCount }
    for (const key of order) {
      const item = VIEW_ITEMS[key]
      const node = row({
        iconName: item.iconName,
        label: item.label,
        count: item.count(counts) || undefined,
        selected: item.selected(state),
        draggable: key,
        onClick: () => {
          if (suppressClick) return
          item.activate(actions)
        }
      })
      on(node, 'pointerdown', onPointerDown)
      nav.appendChild(node)
    }

    librarySection.appendChild(nav)
    librarySection.appendChild(row({
      iconName: 'waveform',
      label: '播放队列',
      count: playback.queue.length || undefined,
      selected: ui.queueOpen,
      onClick: () => actions.toggleQueue()
    }))
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
          // 同上：点文件夹也是「看这个文件夹里的歌」，从别的视图点过来要真的切过去
          onClick: () => {
            actions.setSource({ type: 'folder', value: folder })
            actions.setView('songs')
          },
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

    /* ---------------- 自建播放列表 ---------------- */
    const playlists = normalizePlaylists(state.settings.playlists)
    const playlistSection = h('div', { class: 'sidebar__section' },
      h('div', { class: 'sidebar__section-head' },
        h('span', { text: '播放列表' }),
        h('button', {
          class: 'sidebar__row-action',
          type: 'button',
          title: '新建播放列表',
          onClick: (event) => openPlaylistEditor({ anchor: event.currentTarget, mode: 'create' })
        }, icon('plus', { className: 'icon icon--stroke' }))
      )
    )

    if (!playlists.length) {
      playlistSection.appendChild(h('div', { class: 'sidebar__hint', text: '还没有播放列表。在歌曲上右键就能加进来。' }))
    } else {
      for (const playlist of playlists) {
        const count = actions.playlistTracks(playlist.id).length
        playlistSection.appendChild(row({
          iconName: 'queueAdd',
          label: playlist.name,
          count: count || undefined,
          selected: ui.source.type === 'playlist' && ui.source.value === playlist.id,
          onClick: () => {
            if (suppressClick) return
            actions.openPlaylist(playlist.id)
          },
          action: h('span', {
            class: 'sidebar__row-action',
            title: '播放列表操作',
            onClick: (event) => {
              event.stopPropagation()
              openPlaylistMenu({ anchor: event.currentTarget, playlist })
            }
          }, icon('ellipsis', { className: 'icon icon--stroke' }))
        }))
      }
    }

    // 光靠组头那颗小小的 + 不好找，再放一条明确的入口
    playlistSection.appendChild(h('button', {
      class: 'sidebar__row sidebar__row--ghost',
      type: 'button',
      title: '新建播放列表',
      onClick: (event) => openPlaylistEditor({ anchor: event.currentTarget, mode: 'create' })
    },
    icon('plus', { className: 'icon icon--stroke' }),
    h('span', { class: 'truncate', text: '新建播放列表' })))

    scroll.appendChild(playlistSection)

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
    if (state.ui === prev.ui && state.library === prev.library && state.settings === prev.settings) return
    render()
  })

  render()
  return { element, render }
}
