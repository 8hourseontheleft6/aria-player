/**
 * 浏览视图：专辑列表 / 艺人列表 / 专辑详情 / 艺人详情。
 * 四个页面各自有独立的滚动容器，切换时只显示其中一个。
 */

import { h, on } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { EVENTS } from '../core/bus.js'
import { formatDurationLong } from '../core/format.js'
import { createCoverGrid, createArtistRows } from './cover-grid.js'
import { createTrackList } from './track-list.js'
import { createListMenuButton } from './list-menu.js'
import { createLazyArtwork } from './artwork-node.js'

export function createBrowseView ({ store, bus, player, artwork, actions, lazy: injectedLazy = null }) {
  const lazy = injectedLazy || createLazyArtwork(artwork)

  /* ================= 专辑列表 ================= */
  const albumGrid = createCoverGrid({
    lazy,
    onOpen: (item) => actions.openAlbum(item.key),
    onPlay: (item) => actions.playCollectionOf(item.tracks, item.tracks[0])
  })

  const albumsTitle = h('div', { class: 'view-toolbar__title', text: '专辑' })
  const albumsMeta = h('div', { class: 'view-toolbar__meta' })
  const albumsToolbar = h('div', { class: 'view-toolbar' },
    albumsTitle, h('div', { class: 'view-toolbar__spacer' }), albumsMeta)
  const albumsHeader = pageHeader('专辑', '按艺人 / 专辑名排列')
  const albumsScroll = h('div', { class: 'view-body scroll browse-scroll' }, albumGrid.element)
  const albumsPage = h('div', { class: 'browse-page' }, albumsToolbar, albumsHeader.element, albumsScroll)

  /* ================= 艺人列表 ================= */
  const artistRows = createArtistRows({ lazy, onOpen: (item) => actions.openArtist(item.key) })
  const artistsTitle = h('div', { class: 'view-toolbar__title', text: '艺人' })
  const artistsMeta = h('div', { class: 'view-toolbar__meta' })
  const artistsToolbar = h('div', { class: 'view-toolbar' },
    artistsTitle, h('div', { class: 'view-toolbar__spacer' }), artistsMeta)
  const artistsHeader = pageHeader('艺人', '按名称排列')
  const artistsScroll = h('div', { class: 'view-body scroll browse-scroll' }, artistRows.element)
  const artistsPage = h('div', { class: 'browse-page' }, artistsToolbar, artistsHeader.element, artistsScroll)

  /* ================= 详情页公共部件 ================= */
  function backRow (label, onClick) {
    return h('button', { class: 'browse-back', type: 'button', onClick },
      icon('chevronLeft', { className: 'icon icon--stroke' }),
      h('span', { text: label })
    )
  }

  /* ================= 专辑详情 ================= */
  const albumCover = h('div', { class: 'browse-detail__cover' })
  const albumName = h('h1', { class: 'browse-detail__title', text: '' })
  const albumArtistNode = h('div', { class: 'browse-detail__subtitle', text: '' })
  const albumStats = h('div', { class: 'browse-detail__stats', text: '' })

  const albumPlayButton = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    onClick: () => {
      const album = actions.albumByKey(store.get().ui.detail?.key)
      if (album) actions.playCollectionOf(album.tracks, album.tracks[0])
    }
  }, icon('play'), '播放')

  const albumShuffleButton = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => {
      const album = actions.albumByKey(store.get().ui.detail?.key)
      if (album) actions.shuffleCollectionOf(album.tracks)
    }
  }, icon('shuffleAll', { className: 'icon icon--stroke' }), '随机播放')

  const albumQueueButton = h('button', {
    class: 'btn',
    type: 'button',
    title: '把整张专辑加到下一首之后',
    onClick: () => {
      const album = actions.albumByKey(store.get().ui.detail?.key)
      if (album) player.playNext(album.tracks.map((track) => track.id))
    }
  }, icon('queueAdd', { className: 'icon icon--stroke' }), '加入队列')

  const albumDetailHeader = h('div', { class: 'browse-detail' },
    backRow('专辑', () => actions.closeDetail()),
    h('div', { class: 'browse-detail__row' },
      albumCover,
      h('div', { class: 'browse-detail__info' },
        albumName,
        albumArtistNode,
        albumStats,
        h('div', { class: 'browse-detail__actions' }, albumPlayButton, albumShuffleButton, albumQueueButton)
      )
    )
  )

  const albumTrackList = createTrackList({ store, bus, player, artwork, actions })
  const albumDetailPage = h('div', { class: 'browse-page' },
    h('div', { class: 'view-toolbar' },
      h('div', { class: 'view-toolbar__title', text: '专辑' }),
      h('div', { class: 'view-toolbar__spacer' }),
      // 批量选择的入口（另一个是歌曲右键菜单里的「开始多选」）
      createListMenuButton({ actions, getTracks: () => albumTrackList.tracks })
    ),
    albumDetailHeader,
    albumTrackList.element
  )

  on(albumTrackList.viewport, 'scroll', () => {
    const stuck = albumTrackList.viewport.scrollTop > 18
    albumDetailHeader.classList.toggle('is-collapsed', stuck)
  }, { passive: true })

  /* ================= 艺人详情 ================= */
  const artistAvatar = h('div', { class: 'browse-detail__avatar' })
  const artistName = h('h1', { class: 'browse-detail__title', text: '' })
  const artistStats = h('div', { class: 'browse-detail__stats', text: '' })

  const artistPlayButton = h('button', {
    class: 'btn btn--primary',
    type: 'button',
    onClick: () => {
      const artist = actions.artistByKey(store.get().ui.detail?.key)
      if (artist) actions.playCollectionOf(artist.tracks, artist.tracks[0])
    }
  }, icon('play'), '播放')

  const artistShuffleButton = h('button', {
    class: 'btn',
    type: 'button',
    onClick: () => {
      const artist = actions.artistByKey(store.get().ui.detail?.key)
      if (artist) actions.shuffleCollectionOf(artist.tracks)
    }
  }, icon('shuffleAll', { className: 'icon icon--stroke' }), '随机播放')

  const artistAlbumStrip = h('div', { class: 'album-strip scroll' })
  const artistGrid = createCoverGrid({
    lazy,
    className: 'cover-grid--strip',
    onOpen: (item) => actions.openAlbum(item.key)
  })

  const artistDetailHeader = h('div', { class: 'browse-detail browse-detail--artist' },
    backRow('艺人', () => actions.closeDetail()),
    h('div', { class: 'browse-detail__row' },
      artistAvatar,
      h('div', { class: 'browse-detail__info' },
        artistName,
        artistStats,
        h('div', { class: 'browse-detail__actions' }, artistPlayButton, artistShuffleButton)
      )
    ),
    artistAlbumStrip
  )

  const artistTrackList = createTrackList({ store, bus, player, artwork, actions })
  const artistDetailPage = h('div', { class: 'browse-page' },
    h('div', { class: 'view-toolbar' },
      h('div', { class: 'view-toolbar__title', text: '艺人' }),
      h('div', { class: 'view-toolbar__spacer' }),
      createListMenuButton({ actions, getTracks: () => artistTrackList.tracks })
    ),
    artistDetailHeader,
    artistTrackList.element
  )

  on(artistTrackList.viewport, 'scroll', () => {
    const stuck = artistTrackList.viewport.scrollTop > 18
    artistDetailHeader.classList.toggle('is-collapsed', stuck)
  }, { passive: true })

  /* ================= 页面容器 ================= */
  const pages = {
    albums: albumsPage,
    artists: artistsPage,
    albumDetail: albumDetailPage,
    artistDetail: artistDetailPage
  }

  const element = h('div', { class: 'content-inner view-root' },
    ...Object.values(pages))

  function pageHeader (title, subtitle) {
    const titleNode = h('h1', { class: 'view-header__title', text: title })
    const subtitleNode = h('div', { class: 'view-header__subtitle', text: subtitle })
    const element = h('div', { class: 'view-header' },
      h('div', { class: 'view-header__row' }, h('div', {}, titleNode, subtitleNode)))
    return { element, titleNode, subtitleNode }
  }

  function showPage (name) {
    for (const [key, page] of Object.entries(pages)) {
      page.style.display = key === name ? '' : 'none'
    }
  }

  /* ================= 渲染 ================= */
  let albumsSignature = ''
  let artistsSignature = ''
  let currentDetailKey = null

  function render () {
    const state = store.get()
    const view = state.ui.view
    const detail = state.ui.detail

    if (view === 'albums' && !detail) {
      showPage('albums')
      const albums = actions.albums()
      const signature = `${albums.length}|${state.ui.query}|${state.ui.source.value}|${state.settings.showRowArtwork}`
      if (signature !== albumsSignature) {
        albumsSignature = signature
        albumGrid.setItems(albums.map((album) => ({
          key: album.key,
          title: album.name,
          subtitle: `${album.albumArtist}${album.year ? ` · ${album.year}` : ''} · ${album.trackCount} 首`,
          artworkTrack: album.artworkTrack
        })))
      }
      albumsMeta.textContent = `${albums.length} 张专辑`
      albumsHeader.subtitleNode.textContent = state.ui.query
        ? `匹配「${state.ui.query}」的 ${albums.length} 张专辑`
        : `${albums.length} 张专辑 · ${state.library.tracks.length} 首歌曲`
      albumsScroll.scrollTop = 0
      return
    }

    if (view === 'artists' && !detail) {
      showPage('artists')
      const artists = actions.artists()
      const signature = `${artists.length}|${state.ui.query}|${state.ui.source.value}`
      if (signature !== artistsSignature) {
        artistsSignature = signature
        artistRows.setItems(artists)
      }
      artistsMeta.textContent = `${artists.length} 位艺人`
      artistsHeader.subtitleNode.textContent = `${artists.length} 位艺人`
      return
    }

    if (detail?.type === 'album') {
      showPage('albumDetail')
      const album = actions.albumByKey(detail.key)
      if (!album) {
        actions.closeDetail()
        return
      }
      if (currentDetailKey !== `album:${detail.key}:${state.settings.showRowArtwork}`) {
        currentDetailKey = `album:${detail.key}:${state.settings.showRowArtwork}`
        albumName.textContent = album.name
        albumName.title = album.name
        albumArtistNode.textContent = album.albumArtist
        albumStats.textContent = [
          album.year ? String(album.year) : '',
          `${album.trackCount} 首`,
          formatDurationLong(album.duration)
        ].filter(Boolean).join(' · ')
        lazy.observe(albumCover, album.artworkTrack, 'disc')
        albumTrackList.setTracks(album.tracks)
      }
      return
    }

    if (detail?.type === 'artist') {
      showPage('artistDetail')
      const artist = actions.artistByKey(detail.key)
      if (!artist) {
        actions.closeDetail()
        return
      }
      if (currentDetailKey !== `artist:${detail.key}:${state.settings.showRowArtwork}`) {
        currentDetailKey = `artist:${detail.key}:${state.settings.showRowArtwork}`
        artistName.textContent = artist.name
        artistName.title = artist.name
        artistStats.textContent = `${artist.albumCount} 张专辑 · ${artist.trackCount} 首 · ${formatDurationLong(artist.duration)}`
        lazy.observe(artistAvatar, artist.artworkTrack, 'artist')
        artistGrid.setItems(artist.albumList.map((album) => ({
          key: album.key,
          title: album.name,
          subtitle: `${album.year || ''}${album.year ? ' · ' : ''}${album.trackCount} 首`,
          artworkTrack: album.artworkTrack
        })))
        artistAlbumStrip.replaceChildren(artistGrid.element)
        artistAlbumStrip.style.display = artist.albumList.length > 1 ? '' : 'none'
        artistTrackList.setTracks(artist.tracks)
      }
      return
    }

    showPage('albums')
  }

  /* ================= 状态订阅 ================= */
  bus.on(EVENTS.LIBRARY_UPDATED, () => {
    albumsSignature = ''
    artistsSignature = ''
    currentDetailKey = null
    if (['albums', 'artists'].includes(store.get().ui.view)) render()
  })

  store.subscribe((state, prev) => {
    if (state.ui === prev.ui && state.library === prev.library && state.settings === prev.settings) return
    if (!['albums', 'artists'].includes(state.ui.view) && !state.ui.detail) return
    render()
  })

  render()

  return {
    element,
    render,
    lazy,
    invalidate: () => {
      albumsSignature = ''
      artistsSignature = ''
      currentDetailKey = null
    }
  }
}
