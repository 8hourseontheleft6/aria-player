/**
 * 从资料库里派生「当前可见曲目」：来源过滤 + 搜索 + 排序。
 * 歌曲列表、专辑/艺人视图、媒体墙共用这一份逻辑，保证各处看到的集合一致。
 */

import { normalizeForSearch } from './format.js'
import { findPlaylist, tracksOf } from './playlists.js'
import { compareByInitialThenTitle } from './pinyin.js'

export const SORT_KEYS = ['default', 'title', 'artist', 'album', 'duration', 'year', 'added']

const collatorOptions = { sensitivity: 'base', numeric: true }

/**
 * 排序比较器。
 *
 * `default` 现在等于「按标题的字母顺序（中文按拼音首字母）」——
 * 用户反馈默认顺序看不出规律（原本是专辑/艺人序，列表里 T、S、T、M 混着），
 * 而且右侧的首字母旋钮只有在字母序下才有意义。
 * 想要回专辑/艺人序，用排序菜单里的「专辑」或「艺人」。
 */
export function compareTracks (sort) {
  const direction = sort?.direction === 'desc' ? -1 : 1
  const text = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN', collatorOptions)
  const titles = (a, b) => compareByInitialThenTitle(a.title, b.title)
  const key = sort?.key || 'default'

  return (a, b) => {
    let result = 0
    switch (key) {
      case 'title':
        result = titles(a, b)
        break
      case 'artist':
        result = text(a.artist, b.artist) || text(a.album, b.album) || titles(a, b)
        break
      case 'album':
        result = text(a.album, b.album) || (a.discNo - b.discNo) || (a.trackNo - b.trackNo)
        break
      case 'duration':
        result = a.duration - b.duration
        break
      case 'year':
        result = (a.year || 0) - (b.year || 0) || text(a.album, b.album)
        break
      case 'added':
        result = (a.mtimeMs || 0) - (b.mtimeMs || 0)
        break
      case 'firstSeen':
        /* 最近添加：第一次被扫描到的时间（没播过也有值） */
        result = (a.firstSeen || 0) - (b.firstSeen || 0)
        break
      case 'lastPlayed':
        /* 最近播放：最后播放时间；没播过的按 0 处理（排最前面再靠 direction 翻） */
        result = (a.lastPlayed || 0) - (b.lastPlayed || 0)
        break
      default:
        result = titles(a, b)
        break
    }
    // 同分时用标题收尾（同样走拼音），最后用路径保证稳定
    if (result === 0) result = titles(a, b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    return result * direction
  }
}

/** 按来源（全部 / 某个文件夹）过滤 */
export function filterBySource (tracks, source) {
  if (!source || source.type !== 'folder' || !source.value) return tracks
  const prefix = source.value
  return tracks.filter((track) => track.path.startsWith(prefix))
}

/** 把查询串拆成关键词（多关键词之间是「与」） */
export function queryParts (query) {
  const keyword = normalizeForSearch(query)
  if (!keyword) return []
  return keyword.split(/\s+/).filter(Boolean)
}

/**
 * 基础匹配：歌名 / 艺人 / 专辑 / 专辑艺人。
 * 这是第一档搜索的全部，也是第二档（深度搜索）里最先被算的那一层。
 */
export function matchesBasic (track, parts) {
  if (!parts.length) return true
  if (!track._search) {
    track._search = normalizeForSearch(`${track.title} ${track.artist} ${track.album} ${track.albumArtist}`)
  }
  return parts.every((part) => track._search.includes(part))
}

/**
 * 深度匹配：除歌曲信息之外，还包括年份、流派、文件名、所在文件夹、路径、编码格式、比特率、采样率、有无损。
 * 歌词不在这里 —— 歌词在 .lrc 文件里，由主进程搜完把 id 交回来（见 ui.searchLyrics）。
 */
export function matchesExtended (track, parts) {
  if (!parts.length) return false
  if (!track._deepSearch) {
    const lossless = track.lossless ? '无损 lossless flac' : '有损 lossy'
    track._deepSearch = normalizeForSearch([
      track.title, track.artist, track.album, track.albumArtist,
      track.genre, track.year, track.file, track.dir, track.path,
      track.codec, track.bitrate, track.sampleRate, lossless
    ].filter(Boolean).join(' '))
  }
  return parts.every((part) => track._deepSearch.includes(part))
}

/**
 * 按关键词过滤（多个关键词之间是「与」）。
 *
 * @param {object[]} tracks
 * @param {string} query
 * @param {{ scope?: 'basic'|'deep', lyricsIds?: Set<string>|null }} [options]
 *   深度搜索时：歌曲信息、年份/流派/文件名等、歌词命中 三者是「或」的关系 ——
 *   用户输入一个词时，不管它出现在哪里都应该被找出来。
 */
export function filterByQuery (tracks, query, options = {}) {
  const parts = queryParts(query)
  if (!parts.length) return tracks
  const deep = options.scope === 'deep'
  const lyricsIds = options.lyricsIds || null
  return tracks.filter((track) => {
    if (matchesBasic(track, parts)) return true
    if (!deep) return false
    if (matchesExtended(track, parts)) return true
    return Boolean(lyricsIds && lyricsIds.has(track.id))
  })
}

/**
 * 当前可见曲目（已排序）。
 * @param {object} state store 状态
 * @param {{ applyQuery?: boolean }} [options]
 */
export function selectVisibleTracks (state, options = {}) {
  const { library, ui, settings } = state
  /*
   * 自建播放列表：曲目与顺序都来自列表本身（不按资料库顺序走），
   * 失效的条目在这里被跳过 —— 顺序是用户自己排的，不能被排序键覆盖。
   */
  const playlist = ui.source?.type === 'playlist'
    ? findPlaylist(settings?.playlists, ui.source.value)
    : null
  let list = playlist ? tracksOf(playlist, library.byId) : filterBySource(library.tracks, ui.source)
  if (options.applyQuery !== false) {
    const scope = settings?.searchScope === 'deep' ? 'deep' : 'basic'
    /*
     * 歌词命中的 id 只在「结果对应当前关键词」时才采信：
     * 主进程的搜索是异步的，输入过程中旧结果会晚到一步 ——
     * 拿旧结果去过滤会闪出错误的列表。
     */
    const lyricsIds = scope === 'deep' && ui.searchLyrics && ui.searchLyrics.query === ui.query
      ? new Set(ui.searchLyrics.ids || [])
      : null
    list = filterByQuery(list, ui.query, { scope, lyricsIds })
  }
  const sorted = list.slice()
  // 播放列表只有用户显式选了排序方式才排；默认保持他自己排的顺序
  if (!playlist || ui.sort.key !== 'default') sorted.sort(compareTracks(ui.sort))
  return sorted
}

/** 搜索关键词是否命中了某些曲目（用于视图标题） */
export function selectTitle (state, fallback) {
  const { ui, settings } = state
  if (ui.query) return '搜索结果'
  if (ui.source?.type === 'playlist' && ui.source.value) {
    const playlist = findPlaylist(settings?.playlists, ui.source.value)
    return playlist ? playlist.name : '播放列表'
  }
  if (ui.source?.type === 'folder' && ui.source.value) {
    return ui.source.value.split(/[\\/]/).filter(Boolean).pop() || '文件夹'
  }
  return fallback
}

/** 把一段文本按关键词切成「普通 / 命中」两种片段，界面悬停时用它做高亮 */
export function highlightParts (text, parts) {
  const source = String(text || '')
  if (!source || !parts?.length) return [{ text: source, hit: false }]
  const escaped = parts
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
  if (!escaped.length) return [{ text: source, hit: false }]
  let regex
  try {
    regex = new RegExp(`(${escaped.join('|')})`, 'gi')
  } catch {
    return [{ text: source, hit: false }]
  }
  const out = []
  let last = 0
  for (const match of source.matchAll(regex)) {
    if (match.index > last) out.push({ text: source.slice(last, match.index), hit: false })
    out.push({ text: match[0], hit: true })
    last = match.index + match[0].length
  }
  if (last < source.length) out.push({ text: source.slice(last), hit: false })
  return out
}

/** 某个字段是否被全部关键词命中 */
function fieldHits (value, parts) {
  const haystack = normalizeForSearch(value)
  return Boolean(haystack) && parts.every((part) => haystack.includes(part))
}

/**
 * 这条结果「为什么」被搜出来 —— 界面悬停时用它显示匹配详情。
 *
 * 优先级就是用户直觉的顺序：歌名 → 艺人 → 专辑 → 歌词 → 其他信息。
 * 歌名命中时不额外交代内容（标题自己会被高亮），只回一个标记。
 *
 * @param {object} track
 * @param {string} query
 * @param {{ scope?: 'basic'|'deep', lyricsMatch?: { line?: string, time?: number|null, lineIndex?: number }|null }} [options]
 */
export function describeMatch (track, query, options = {}) {
  const parts = queryParts(query)
  if (!parts.length || !track) return null

  if (fieldHits(track.title, parts)) return { kind: 'title', label: '歌名匹配', highlightTitle: true }
  if (fieldHits(track.artist, parts)) return { kind: 'artist', label: '艺人匹配', text: track.artist }
  if (fieldHits(track.album, parts)) return { kind: 'album', label: '专辑匹配', text: track.album }

  const lyrics = options.lyricsMatch
  if (lyrics && lyrics.line) {
    return {
      kind: 'lyrics',
      label: '歌词匹配',
      text: lyrics.line,
      time: lyrics.time ?? null,
      lineIndex: lyrics.lineIndex ?? -1
    }
  }

  if (options.scope !== 'deep') return null
  const extended = [
    { label: '流派', value: track.genre },
    { label: '年份', value: track.year ? String(track.year) : '' },
    { label: '文件名', value: track.file },
    { label: '文件夹', value: track.dir },
    { label: '编码', value: track.codec },
    { label: '码率', value: track.bitrate ? `${track.bitrate} kbps` : '' },
    { label: '采样率', value: track.sampleRate ? `${track.sampleRate} Hz` : '' },
    { label: '无损', value: track.lossless ? '无损 lossless flac' : '' }
  ].find((item) => fieldHits(item.value, parts))
  if (!extended) return null
  return { kind: 'extended', label: `${extended.label}匹配`, text: String(extended.value) }
}
