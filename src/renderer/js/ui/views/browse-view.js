/**
 * 浏览视图：专辑列表 / 艺人列表 / 专辑详情 / 艺人详情。
 * 四个页面各自有独立的滚动容器，切换时只显示其中一个。
 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { EVENTS } from '../../core/bus.js'
import { formatDurationLong } from '../../core/format.js'
import { createCoverGrid, createArtistRows } from '../widgets/cover-grid.js'
import { createTrackList } from '../widgets/track-list.js'
import { createSearchBox } from '../widgets/search-box.js'
import { createListMenuButton } from '../menus/list-menu.js'
import { createLazyArtwork } from '../widgets/artwork-node.js'

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
  // 专辑 / 艺人各挂一只搜索框，与「全部歌曲」共用同一个 ui.query
  const albumsSearch = createSearchBox({ store, actions, placeholder: '搜索专辑或艺人…', width: 190 })
  const artistsSearch = createSearchBox({ store, actions, placeholder: '搜索艺人…', width: 170 })
  const albumsToolbar = h('div', { class: 'view-toolbar' },
    albumsTitle, h('div', { class: 'view-toolbar__spacer' }), albumsMeta, albumsSearch.element)
  const albumsHeader = pageHeader('专辑', '按艺人 / 专辑名排列')
  const albumsEmpty = h('div', { class: 'empty hidden' })
  const albumsScroll = h('div', { class: 'view-body scroll browse-scroll' }, albumGrid.element, albumsEmpty)
  const albumsPage = h('div', { class: 'browse-page' }, albumsToolbar, albumsHeader.element, albumsScroll)

  /**
   * 详情页头部的「滚动收起」联动。
   *
   * 实机反馈：「短列表滚不动，无论拖右边的条还是滚轮，一操作就上下鬼畜」。
   * 根因是反馈环：头部是 max-height 折叠 —— 它一收起，列表可用高度就变大、
   * 滚动位置被浏览器夹回（短列表直接归零），scroll 事件随即把头部展开，
   * 展开后内容又溢出……如此振荡。6 行这种「刚好装不满又刚好多一点」的列表最明显。
   *
   * 两个约束把环切断：
   *   ① 只有内容比视口高出 80px 以上（真的滚得动）时才允许收起 —— 短列表永不收起；
   *   ② 滞回：scrollTop > 24 才收起、< 8 才展开，不在阈值附近反复横跳。
   */
  function bindDetailCollapse (list, header) {
    on(list.viewport, 'scroll', () => {
      const viewport = list.viewport
      const overflow = viewport.scrollHeight - viewport.clientHeight
      if (overflow < 80) {
        header.classList.remove('is-collapsed')
        return
      }
      const top = viewport.scrollTop
      if (top > 24) header.classList.add('is-collapsed')
      else if (top < 8) header.classList.remove('is-collapsed')
    })
  }
  /* ================= 艺人列表 ================= */
  const artistRows = createArtistRows({ lazy, onOpen: (item) => actions.openArtist(item.key) })
  const artistsTitle = h('div', { class: 'view-toolbar__title', text: '艺人' })
  const artistsMeta = h('div', { class: 'view-toolbar__meta' })
  const artistsToolbar = h('div', { class: 'view-toolbar' },
    artistsTitle, h('div', { class: 'view-toolbar__spacer' }), artistsMeta, artistsSearch.element)
  const artistsHeader = pageHeader('艺人', '按名称排列')
  const artistsEmpty = h('div', { class: 'empty hidden' })
  const artistsScroll = h('div', { class: 'view-body scroll browse-scroll' }, artistRows.element, artistsEmpty)
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

  bindDetailCollapse(albumTrackList, albumDetailHeader)

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
  /*
   * 鼠标滚轮直接横着滚这排专辑卡。
   *
   * 横向容器默认只认 Shift+滚轮或触控板的横向手势，**鼠标用户会以为这排滚不动** ——
   * 卡片在右边缘被截断时尤其明显（截图里就是这样）。把纵向 deltaY 映射成横向滚动；
   * 到两端就**不** preventDefault，把滚动交回外层页面（否则鼠标在卡片上时页面滚不动，
   * 那是一种更难受的卡住）。已经在横向滚（deltaX 更大）的手势不重复处理。
   */
  on(artistAlbumStrip, 'wheel', (event) => {
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
    const max = artistAlbumStrip.scrollWidth - artistAlbumStrip.clientWidth
    if (max <= 0) return
    const target = artistAlbumStrip.scrollLeft + event.deltaY
    const clamped = Math.max(0, Math.min(max, target))
    /*
     * 到两端就 return（不 preventDefault），让滚动交回外层页面。
     * 比较必须带容差：`scrollWidth/clientWidth` 是**整数**（浏览器取整过），
     * `scrollLeft` 是**浮点**（实测 7034.28564453125）—— 直接用 === 会在末端
     * 差零点几像素而判定"还没到头"，于是照样拦截，页面就滚不动了。
     * 这个坑是自检那条「横向专辑条」抓出来的（读数里"拦截=true、位置不变=true"）。
     */
    if (Math.abs(clamped - artistAlbumStrip.scrollLeft) < 0.5) return
    event.preventDefault()
    artistAlbumStrip.scrollLeft = clamped
  }, { passive: false })
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
  // 艺人详情里的列表要自己吃满剩余高度并内部滚动（见 browse.css 的 .browse-detail__tracks）
  artistTrackList.element.classList.add('browse-detail__tracks')
  const artistDetailPage = h('div', { class: 'browse-page' },
    h('div', { class: 'view-toolbar' },
      h('div', { class: 'view-toolbar__title', text: '艺人' }),
      h('div', { class: 'view-toolbar__spacer' }),
      createListMenuButton({ actions, getTracks: () => artistTrackList.tracks })
    ),
    artistDetailHeader,
    artistTrackList.element
  )

  bindDetailCollapse(artistTrackList, artistDetailHeader)

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

  /*
   * 专辑 / 艺人页的空状态。
   *
   * 以前这两页没有空状态：搜不到东西时只在页头副标题写一句「没有匹配「X」的专辑」，
   * 下面是一片空白 —— 而**同一件事在歌曲页有一整块空状态**（图标 + 标题 + 说明，
   * 见 library-view.js 的 .empty）。自检那条「搜不到东西时」的探针把差异量出来了：
   * 歌曲页有 .empty，专辑 / 艺人页 0 个。补齐，用同一套 .empty 组件与同样的措辞。
   * 顺带覆盖首次启动（还没有音乐文件夹）——那是新用户一定会遇到的状态，
   * 空白页面对他毫无帮助，这里给一句解释加一个按钮。
   */
  function buildEmpty (node, { iconName, title, text, action }) {
    clear(node)
    node.append(
      icon(iconName, { className: 'icon icon--stroke empty__icon' }),
      h('div', { class: 'empty__title', text: title }),
      h('div', { class: 'empty__text', text: text }),
      action || ''
    )
    node.classList.remove('hidden')
  }

  function emptyContentFor (kind) {
    const state = store.get()
    if (!state.library.folders.length) {
      return {
        iconName: 'folder',
        title: '还没有音乐文件夹',
        text: '添加一个包含音乐的文件夹，Aria 会递归扫描并读取歌曲信息（封面、歌词都会一起读取）。',
        action: h('button', { class: 'btn btn--primary', type: 'button', onClick: () => actions.addFolder() }, icon('plus'), '添加音乐文件夹')
      }
    }
    return {
      iconName: 'search',
      title: kind === 'albums' ? '没有匹配的专辑' : '没有匹配的艺人',
      text: `没有找到与「${state.ui.query}」相关的${kind === 'albums' ? '专辑' : '艺人'}，换个关键词试试。`
    }
  }

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
      // 命中 0 时给一句明确的回答，而不是「…的 0 张专辑」（读起来像故障）
      albumsHeader.subtitleNode.textContent = state.ui.query
        ? (albums.length
            ? `匹配「${state.ui.query}」的 ${albums.length} 张专辑`
            : `没有匹配「${state.ui.query}」的专辑`)
        : `${albums.length} 张专辑 · ${state.library.tracks.length} 首歌曲`
      albumsScroll.scrollTop = 0
      // 空状态：搜不到、或者整个资料库还没有专辑（首次启动）
      if (!albums.length) {
        buildEmpty(albumsEmpty, emptyContentFor('albums'))
        albumGrid.element.style.display = 'none'
      } else {
        albumsEmpty.classList.add('hidden')
        albumGrid.element.style.display = ''
      }
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
      // 与专辑页同构：搜索时副标题写清「匹配了什么、命中多少」
      artistsHeader.subtitleNode.textContent = state.ui.query
        ? (artists.length
            ? `匹配「${state.ui.query}」的 ${artists.length} 位艺人`
            : `没有匹配「${state.ui.query}」的艺人`)
        : `${artists.length} 位艺人`
      // 与专辑页同构的空状态
      if (!artists.length) {
        buildEmpty(artistsEmpty, emptyContentFor('artists'))
        artistRows.element.style.display = 'none'
      } else {
        artistsEmpty.classList.add('hidden')
        artistRows.element.style.display = ''
      }
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
        // 艺人头像走**在线按名查**（伪曲目 artistOnly）：不再拿合作曲目的专辑封面顶替，
        // 查不到就显示占位图标（见 plugins/online-media.js 的 artworkProvider）
        /*
         * 无在线头像时用**首字母**占位（Apple 在通讯录/音乐里就是这么做的），比一个通用人形图标
         * 更像"这里本来有内容"。样式侧用 :has() 判断有没有真的 img，只在没图时才显示。
         */
        artistAvatar.dataset.initial = (artist.name || '?').trim().charAt(0).toUpperCase()
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

      /*
       * 头像这一行放在**上面的 if 之外**：每次显示这位艺人的详情都重新观察一次。
       *
       * 踩过的坑（实机「点进详情还是没有照片」）：它原本写在
       * `if (currentDetailKey !== 'artist:…')` 里面 —— 同一位歌手第二次点进来时
       * key 没变、这一行根本不执行；于是"旧版本失败过一次"的歌手在升级到修好的版本后
       * **永远不会重试**。observe() 自带 artKey 去重（图就是这个条目的就直接返回），
       * 所以重复调用没有额外开销。
       */
      lazy.observe(artistAvatar, { artistOnly: true, artist: artist.name }, 'artist')
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
