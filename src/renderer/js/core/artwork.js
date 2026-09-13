/**
 * 封面服务：
 *  - 解析曲目封面 URL（同名图片直接走 media://；内嵌封面走 IPC 取字节再转 Blob）
 *  - 从封面提取主色调，写入 CSS 变量 --tint / --tint-2，让界面颜色跟着唱片走
 */

import { remote, bytesToBlobUrl } from './remote.js'
import { colorFromString } from './format.js'

const BLOB_CACHE_LIMIT = 120

export function artworkKey (track) {
  if (!track) return null
  if (track.artworkFile) return `f:${track.artworkFile}`
  if (track.artworkEmbedded) return `e:${track.albumArtist}|${track.album}|${track.artist}`
  return null
}

function rgbToHsl (r, g, b) {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }
  return { h: h * 360, s, l }
}

export function createArtworkService ({ bus }) {
  /** @type {Map<string, {url: string, blob: boolean}>} */
  const urlCache = new Map()
  /** @type {Map<string, {tint: string, tint2: string}>} */
  const colorCache = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map()

  /** 由 HSL 三元组生成 { tint, tint2, tintSoft } */
  const makeColor = (h, s, l) => ({
    tint: `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`,
    tint2: `hsl(${Math.round((h + 44) % 360)} ${Math.round(Math.max(38, s - 8))}% ${Math.round(Math.max(38, l - 6))}%)`,
    tintSoft: `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}% / 0.18)`
  })

  const fallbackColor = (track) => {
    const seed = `${track?.albumArtist || track?.artist || ''}|${track?.album || track?.title || ''}`
    const { hue } = colorFromString(seed)
    return makeColor(hue, 68, 56)
  }

  function rememberBlob (key, url) {
    urlCache.set(key, { url, blob: true })
    if (urlCache.size > BLOB_CACHE_LIMIT) {
      const [oldestKey, entry] = urlCache.entries().next().value
      urlCache.delete(oldestKey)
      if (entry.blob) URL.revokeObjectURL(entry.url)
    }
  }

  /** @returns {Promise<string|null>} */
  async function resolveUrl (track) {
    const key = artworkKey(track)
    if (!key) return null
    if (urlCache.has(key)) return urlCache.get(key).url

    if (track.artworkFile) {
      const url = `media://local/?p=${encodeURIComponent(track.artworkFile)}&v=${track.mtimeMs}`
      urlCache.set(key, { url, blob: false })
      return url
    }

    if (!track.artworkEmbedded) return null
    if (inFlight.has(key)) return inFlight.get(key)

    const task = (async () => {
      try {
        const result = await remote.library.artwork(track.id)
        if (!result || !result.data) return null
        const url = bytesToBlobUrl(result.data, result.mime)
        rememberBlob(key, url)
        return url
      } catch (err) {
        console.warn('[artwork] 内嵌封面读取失败', err)
        return null
      } finally {
        inFlight.delete(key)
      }
    })()

    inFlight.set(key, task)
    return task
  }

  /** 用 canvas 从封面图取主色调（受 CORS 限制失败时回退到由专辑名生成的稳定配色） */
  async function resolveColor (track) {
    const url = await resolveUrl(track)
    if (!url) return fallbackColor(track)
    if (colorCache.has(url)) return colorCache.get(url)

    try {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error('封面加载失败'))
        image.src = url
        setTimeout(() => reject(new Error('封面加载超时')), 8000)
      })

      const size = 18
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(image, 0, 0, size, size)
      const { data } = ctx.getImageData(0, 0, size, size)

      let rSum = 0
      let gSum = 0
      let bSum = 0
      let weight = 0
      let hueX = 0
      let hueY = 0

      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue
        const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2])
        if (l < 0.14 || l > 0.92) continue
        const w = 0.25 + s * s
        const rad = (h * Math.PI) / 180
        hueX += Math.cos(rad) * w
        hueY += Math.sin(rad) * w
        weight += w
        rSum += data[i] * w
        gSum += data[i + 1] * w
        bSum += data[i + 2] * w
      }

      if (!weight) throw new Error('封面缺少可用像素')
      const hue = ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360
      const r = Math.round(rSum / weight)
      const g = Math.round(gSum / weight)
      const b = Math.round(bSum / weight)
      const hsl = rgbToHsl(r, g, b)

      const color = makeColor(
        hue,
        Math.min(88, Math.max(48, hsl.s * 118)),
        Math.min(72, Math.max(46, hsl.l * 92))
      )
      colorCache.set(url, color)
      if (colorCache.size > 64) colorCache.delete(colorCache.keys().next().value)
      return color
    } catch {
      const fallback = fallbackColor(track)
      colorCache.set(url, fallback)
      return fallback
    }
  }

  /** 把配色写进 CSS 变量 */
  function applyTint (color) {
    const root = document.documentElement
    root.style.setProperty('--tint', color.tint)
    root.style.setProperty('--tint-2', color.tint2)
    root.style.setProperty('--tint-soft', color.tintSoft || color.tint)
  }

  return { resolveUrl, resolveColor, applyTint, fallbackColor }
}
