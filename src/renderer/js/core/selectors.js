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

/** 按关键词过滤（多个关键词之间是「与」） */
export function filterByQuery (tracks, query) {
  const keyword = normalizeForSearch(query)
  if (!keyword) return tracks
  const parts = keyword.split(/\s+/).filter(Boolean)
  if (!parts.length) return tracks
  return tracks.filter((track) => {
    const haystack = track._search ||
      normalizeForSearch(`${track.title} ${track.artist} ${track.album} ${track.albumArtist}`)
    return parts.every((part) => haystack.includes(part))
  })
}

/**
 * 当前可见曲目（已排序）。
 * @param {object} state store 状态
 * @param {{ applyQuery?: boolean }} [options]
 */
export function selectVisibleTracks (state, options = {}) {
  const { library, ui } = state
  let list = filterBySource(library.tracks, ui.source)
  if (options.applyQuery !== false) list = filterByQuery(list, ui.query)
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
