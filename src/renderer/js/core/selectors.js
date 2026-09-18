/**
 * 从资料库里派生「当前可见曲目」：来源过滤 + 搜索 + 排序。
 * 歌曲列表、专辑/艺人视图、媒体墙共用这一份逻辑，保证各处看到的集合一致。
 */

import { normalizeForSearch } from './format.js'

export const SORT_KEYS = ['default', 'title', 'artist', 'album', 'duration', 'year', 'added']

const collatorOptions = { sensitivity: 'base', numeric: true }

export function compareTracks (sort) {
  const direction = sort?.direction === 'desc' ? -1 : 1
  const text = (a, b) => String(a || '').localeCompare(String(b || ''), 'zh-Hans-CN', collatorOptions)
  const key = sort?.key || 'default'

  return (a, b) => {
    let result = 0
    switch (key) {
      case 'title':
        result = text(a.title, b.title)
        break
      case 'artist':
        result = text(a.artist, b.artist) || text(a.album, b.album) || text(a.title, b.title)
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
      default:
        result = text(a.albumArtist, b.albumArtist) || text(a.album, b.album) ||
          (a.discNo - b.discNo) || (a.trackNo - b.trackNo) || text(a.title, b.title)
    }
    if (result === 0) result = text(a.title, b.title) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
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
 * 深度匹配：除歌曲信息之外，还包括年份、流派、文件名、所在文件夹、编码格式。
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
  let list = filterBySource(library.tracks, ui.source)
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
  sorted.sort(compareTracks(ui.sort))
  return sorted
}

/** 搜索关键词是否命中了某些曲目（用于视图标题） */
export function selectTitle (state, fallback) {
  const { ui } = state
  if (ui.query) return '搜索结果'
  if (ui.source?.type === 'folder' && ui.source.value) {
    return ui.source.value.split(/[\\/]/).filter(Boolean).pop() || '文件夹'
  }
  return fallback
}
