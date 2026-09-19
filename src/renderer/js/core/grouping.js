/**
 * 专辑 / 艺人分组索引。
 *
 * 从曲目列表派生，带记忆化：只有曲目数组或排序方式变化时才重建。
 * 专辑封面取「第一首有封面的曲目」，因此同一张专辑的所有曲目共用一次封面读取。
 */

const UNKNOWN_ALBUM = '未知专辑'
const UNKNOWN_ARTIST = '未知艺人'

/*
 * 「一个字段里塞了多个艺人」的拆分规则。
 *
 * 规则是照着真实资料库定的（scripts/probe-artists.js 会把所有写法列出来），
 * 不是凭想象写正则 —— 拆分最怕误伤乐队名，而乐队名里恰好什么符号都有：
 *
 *   Taylor Swift&Brendon Urie      → 拆（没有空格 = 合作）
 *   Tungevaag & Raaban             → 不拆（有空格 = 乐队名本身带 &）
 *   W&W、BlasterJaxx               → 拆成 W&W / BlasterJaxx（顿号是列表分隔符）
 *   Tones And I                    → 不拆（"and" 出现在 "Florence And The Machine"
 *                                    这类乐队名里，绝不能当分隔符）
 *   Fitz And The Tantrums          → 不拆
 *
 * 所以：
 *   · 顿号、分号是明确的列表分隔符，一律拆；
 *   · 半角/全角 & 只有「两边都不带空格」时才拆，而且两边都得够长
 *     （否则 W&W 会被拆成 W / W）；
 *   · feat. / with / vs 是明确的合作标记，拆；
 *   · "and"、逗号、斜杠、加号、x 一律不拆（乐队名里的误伤率高得多）。
 */
const ARTIST_SEPARATOR = /[、;；]|\s+(?:feat|ft|featuring|with|vs)\.?\s+/i
/** 没有空格夹着的 & —— 这是「合作」而不是乐队名的特征 */
const TIGHT_AMPERSAND = /(?<=\S)[&＆](?=\S)/

/** 把 `A&B` 拆开；遇到 W&W 这种两边只有一两个字符的，原样保留 */
function splitTightAmpersand (text) {
  if (!TIGHT_AMPERSAND.test(text)) return [text]
  const parts = text.split(/[&＆]/)
  if (parts.some((part) => part.trim().length < 2)) return [text]
  return parts
}

/**
 * 把「艺人」字段拆成一组艺人名。
 *
 * 曲目里存的原始字符串（`track.artist`）不动 —— 列表行、正在播放仍然显示
 * 完整署名，那是这条记录的真实信息；只有**分组索引**用拆分后的名字，
 * 这样「艺人」页里就不会出现一个叫「Taylor Swift&Brendon Urie」的艺人。
 *
 * @param {string} value 形如 "Taylor Swift&Brendon Urie" / "A、B、C"
 * @returns {string[]} 去重、去空白后的艺人名；空值返回 []
 */
export function splitArtists (value) {
  if (!value) return []
  const out = []
  const seen = new Set()
  for (const chunk of String(value).split('\u0000')) {
    for (const piece of chunk.split(ARTIST_SEPARATOR)) {
      for (const part of splitTightAmpersand(piece)) {
        const name = part.trim()
        if (!name) continue
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(name)
      }
    }
  }
  return out
}

/** 拆不开或本来就是空的，就回落到「未知艺人」 */
function artistNamesOf (track) {
  const names = splitArtists(track.albumArtist || track.artist)
  return names.length ? names : [UNKNOWN_ARTIST]
}

/** 专辑的稳定标识：专辑艺人 + 专辑名。媒体墙据此把格子与「正在播放」对应起来 */
export function albumKeyOf (track) {
  return `${track.albumArtist || track.artist || ''}\u0000${track.album || UNKNOWN_ALBUM}`
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
    // 按拆分后的艺人计数：「Taylor Swift&Brendon Urie」算两个，不是一个
    for (const name of artistNamesOf(track)) {
      artists.set(name, (artists.get(name) || 0) + 1)
    }
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

    // 合作曲目会同时挂到每个署名艺人的名下：
    // 「Taylor Swift&Brendon Urie」既出现在 Taylor Swift 页，也出现在 Brendon Urie 页
    for (const artistKey of artistNamesOf(track)) {
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
