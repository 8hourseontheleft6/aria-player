/**
 * 用户自建播放列表。
 *
 * 数据存在设置里（`settings.playlists`），结构刻意保持扁平：
 *
 *   { id: 'pl-1a2b3c', name: '开车听', trackIds: ['曲目 id'...], createdAt: 1700000000000 }
 *
 * 只存曲目 **id**，不存曲目对象：
 *   · 资料库重扫（文件改名、元数据修正）后 id 不变，播放列表跟着自动更新；
 *   · 曲目被删掉时这一条会取不到，读取时直接跳过（见 tracksOf），
 *     列表里不会留下一个点不动的幽灵。
 *
 * 这里全是纯函数：不碰 store、不发 IPC，方便自检里直接拿假数据跑。
 */

/** 最多允许多少个播放列表（纯保护，防止设置文件被写成几万条） */
export const PLAYLIST_LIMIT = 100

function randomId () {
  return `pl-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`
}

/** 把设置里读到的值规整成合法数组（设置文件是用户可编辑的，什么都可能在里面） */
export function normalizePlaylists (value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const name = String(item.name || '').trim()
    if (!name) continue
    let id = String(item.id || '').trim()
    if (!id || seen.has(id)) id = randomId()
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      trackIds: Array.isArray(item.trackIds) ? item.trackIds.filter((id2) => typeof id2 === 'string') : [],
      createdAt: Number(item.createdAt) || Date.now()
    })
    if (out.length >= PLAYLIST_LIMIT) break
  }
  return out
}

export function findPlaylist (playlists, id) {
  if (!id) return null
  return (Array.isArray(playlists) ? playlists : []).find((item) => item.id === id) || null
}

export function makePlaylist (name, { now = Date.now(), id = null } = {}) {
  return {
    id: id || randomId(),
    name: String(name || '').trim() || '新建播放列表',
    trackIds: [],
    createdAt: now
  }
}

export function renamePlaylist (playlists, id, name) {
  const next = String(name || '').trim()
  if (!next) return playlists
  return playlists.map((item) => (item.id === id ? { ...item, name: next } : item))
}

export function removePlaylist (playlists, id) {
  return playlists.filter((item) => item.id !== id)
}

/**
 * 追加曲目。已经在列表里的不重复添加（保持原位置）。
 * @returns {{ playlists: object[], added: number, skipped: number }}
 */
export function addTracks (playlists, id, trackIds) {
  const incoming = (Array.isArray(trackIds) ? trackIds : [trackIds]).filter(Boolean)
  let added = 0
  let skipped = 0
  const next = playlists.map((item) => {
    if (item.id !== id) return item
    const seen = new Set(item.trackIds)
    const merged = item.trackIds.slice()
    for (const trackId of incoming) {
      if (seen.has(trackId)) {
        skipped++
        continue
      }
      seen.add(trackId)
      merged.push(trackId)
      added++
    }
    return { ...item, trackIds: merged }
  })
  return { playlists: next, added, skipped }
}

export function removeTrack (playlists, id, trackId) {
  return playlists.map((item) => (
    item.id === id ? { ...item, trackIds: item.trackIds.filter((value) => value !== trackId) } : item
  ))
}

/** 播放列表里还有效的曲目（文件被删掉的那些直接跳过） */
export function tracksOf (playlist, byId) {
  if (!playlist || !byId) return []
  const out = []
  for (const id of playlist.trackIds) {
    const track = byId.get(id)
    if (track) out.push(track)
  }
  return out
}

/** 某个播放列表里失效的条目数（设置页显示「N 首（M 首已失效）」用） */
export function missingCount (playlist, byId) {
  if (!playlist || !byId) return 0
  return playlist.trackIds.filter((id) => !byId.get(id)).length
}
