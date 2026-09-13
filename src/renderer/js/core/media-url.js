/** media:// URL 构造。加 v= 参数做缓存失效，避免换了封面还是旧图。 */

export function fileMediaUrl (filePath, version) {
  if (!filePath) return null
  const base = `media://local/?p=${encodeURIComponent(filePath)}`
  return version ? `${base}&v=${version}` : base
}

export function trackMediaUrl (track) {
  if (!track?.path) return null
  return fileMediaUrl(track.path, track.mtimeMs)
}
