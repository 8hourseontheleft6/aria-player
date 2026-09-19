/** media:// URL 构造。加 v= 参数做缓存失效，避免换了封面还是旧图。 */

export function fileMediaUrl (filePath, version) {
  if (!filePath) return null
  const base = `media://local/?p=${encodeURIComponent(filePath)}`
  return version ? `${base}&v=${version}` : base
}

export function trackMediaUrl (track) {
  // 在线音源的曲目没有本地文件：把音源解析出来的直链直接交给 <audio>
  // （CSP 的 media-src 已经允许 https:/http:，见 index.html）
  if (track?.onlineUrl) return track.onlineUrl
  if (!track?.path) return null
  return fileMediaUrl(track.path, track.mtimeMs)
}
