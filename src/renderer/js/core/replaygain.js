/**
 * ReplayGain（响度归一化）的纯逻辑。
 *
 * 为什么单独一个文件：dB → 线性增益、按设置挑哪个标签，这两件事不依赖 WebAudio，
 * 可以在 Node 里直接测（scripts/checks/check-replaygain.js）。
 *
 * 约定：
 *  · 'off'   → 0 dB，且**不创建** WebAudio 图（播放路径保持原生）
 *  · 'track' → 用 replaygain_track_gain
 *  · 'album' → 用 replaygain_album_gain，缺这张专辑的就退回 track，再没有就 0 dB
 *  · 任何缺失 / 非数值 / 离谱值（>±24 dB）都按 0 dB 处理，绝不让一首歌变哑
 */

export const REPLAY_GAIN_MODES = ['off', 'track', 'album']
export const REPLAY_GAIN_LABELS = {
  off: '关',
  track: '单曲',
  album: '专辑'
}

/** 合理区间：超过这个范围的标签一定是写错了（ReplayGain 实际很少超过 ±15 dB） */
const LIMIT_DB = 24

function sane (value) {
  /*
   * 必须先挡掉 null / undefined / ''：Number(null) 是 0，会把"没有这个标签"
   * 当成"标签写了 0dB"，专辑模式就永远回退不到单曲标签。
   */
  if (value === null || value === undefined || value === '') return null
  const db = Number(value)
  if (!Number.isFinite(db)) return null
  if (db < -LIMIT_DB || db > LIMIT_DB) return null
  return db
}

/**
 * 按设置与曲目挑出该用多少 dB。
 * @param {'off'|'track'|'album'} mode
 * @param {{ gainTrack?: number|null, gainAlbum?: number|null }} track
 */
export function resolveReplayGainDb (mode, track) {
  if (mode !== 'track' && mode !== 'album') return 0
  if (!track) return 0
  const trackDb = sane(track.gainTrack)
  const albumDb = sane(track.gainAlbum)
  if (mode === 'album') return albumDb ?? trackDb ?? 0
  return trackDb ?? 0
}

/** dB → 线性增益（WebAudio 的 gain.value 用这个） */
export function dbToLinearGain (db) {
  const value = sane(db)
  if (value === null || Math.abs(value) < 0.01) return 1
  return Math.pow(10, value / 20)
}

/**
 * 给人看的说明：设置页、播放页的提示都用它。
 * 返回 { db, label, source }，source 说明这个 dB 是从哪个标签来的。
 */
export function describeReplayGain (mode, track) {
  if (mode !== 'track' && mode !== 'album') {
    return { db: 0, label: '关', source: 'off' }
  }
  const trackDb = sane(track && track.gainTrack)
  const albumDb = sane(track && track.gainAlbum)
  if (mode === 'album') {
    if (albumDb !== null) return { db: albumDb, label: REPLAY_GAIN_LABELS.album, source: 'album' }
    if (trackDb !== null) return { db: trackDb, label: REPLAY_GAIN_LABELS.track, source: 'track-fallback' }
    return { db: 0, label: REPLAY_GAIN_LABELS.album, source: 'none' }
  }
  if (trackDb !== null) return { db: trackDb, label: REPLAY_GAIN_LABELS.track, source: 'track' }
  return { db: 0, label: REPLAY_GAIN_LABELS.track, source: 'none' }
}
