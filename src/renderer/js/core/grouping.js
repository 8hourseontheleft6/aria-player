/**
 * 专辑 / 艺人分组索引。
 *
 * 从曲目列表派生，带记忆化：只有曲目数组或排序方式变化时才重建。
 * 专辑封面取「第一首有封面的曲目」，因此同一张专辑的所有曲目共用一次封面读取。
 */

const UNKNOWN_ALBUM = '未知专辑'

function albumKeyOf (track) {
  return `${track.albumArtist || track.artist || ''}\u0000${track.album || UNKNOWN_ALBUM}`
}

function artistKeyOf (track) {
  return track.albumArtist || track.artist || '未知艺人'
}

function pickArtworkTrack (tracks) {
  return tracks.find((track) => track.artworkEmbedded || track.artworkFile) || tracks[0]
}

function summarize (tracks) {
  let duration = 0
  let year = 0
  const artists = new Map()
  for (const track of tracks) {
    duration += track.duration || 0
    if (!year && track.year) year = track.year
    const name = track.artist || '未知艺人'
    artists.set(name, (artists.get(name) || 0) + 1)
  }
  // 出现次数最多的艺人作为专辑的展示艺人
  let mainArtist = ''
  let best = -1
  for (const [name, count] of artists) {
    if (count > best) {
      best = count
      mainArtist = name
    }
  }
  return { duration, year, mainArtist, artistCount: artists.size }
}

export function buildIndex (tracks) {
  /** @type {Map<string, object>} */
  const albums = new Map()
  /** @type {Map<string, object>} */
  const artists = new Map()

  for (const track of tracks) {
    const albumKey = albumKeyOf(track)
    let album = albums.get(albumKey)
    if (!album) {
      album = {
        key: albumKey,
        type: 'album',
        name: track.album || UNKNOWN_ALBUM,
        albumArtist: track.albumArtist || track.artist || '未知艺人',
        tracks: []
      }
      albums.set(albumKey, album)
    }
    album.tracks.push(track)

    const artistKey = artistKeyOf(track)
    let artist = artists.get(artistKey)
    if (!artist) {
      artist = {
        key: artistKey,
        type: 'artist',
        name: artistKey,
        albums: new Set(),
        tracks: []
      }
      artists.set(artistKey, artist)
    }
    artist.albums.add(albumKey)
    artist.tracks.push(track)
  }

  const albumList = [...albums.values()]
  for (const album of albumList) {
    album.tracks.sort((a, b) => (a.discNo - b.discNo) || (a.trackNo - b.trackNo) || a.title.localeCompare(b.title, 'zh-Hans-CN'))
    Object.assign(album, summarize(album.tracks))
    album.trackCount = album.tracks.length
    album.artworkTrack = pickArtworkTrack(album.tracks)
  }

  const artistList = [...artists.values()]
  for (const artist of artistList) {
    artist.trackCount = artist.tracks.length
    artist.albumList = [...artist.albums].map((key) => albums.get(key)).filter(Boolean)
    artist.albumList.sort((a, b) => (b.year || 0) - (a.year || 0) || String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
    artist.albumCount = artist.albumList.length
    Object.assign(artist, summarize(artist.tracks))
    artist.artworkTrack = pickArtworkTrack(artist.tracks)
  }

  albumList.sort((a, b) => String(a.albumArtist).localeCompare(String(b.albumArtist), 'zh-Hans-CN', { sensitivity: 'base' }) ||
    String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { sensitivity: 'base' }))
  artistList.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { sensitivity: 'base' }))

  return { albums, albumList, artists, artistList }
}

export function createLibraryIndex () {
  let cached = null
  let cachedTracks = null

  return {
    /** @param {Array<object>} tracks 已排序的可见曲目 */
    get (tracks) {
      if (cached && cachedTracks === tracks) return cached
      cached = buildIndex(tracks)
      cachedTracks = tracks
      return cached
    },
    invalidate () {
      cached = null
      cachedTracks = null
    }
  }
}
