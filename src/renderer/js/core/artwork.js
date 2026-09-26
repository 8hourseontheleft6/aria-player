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

export function createArtworkService ({ bus, host = null }) {
  /** @type {Map<string, {url: string, blob: boolean}>} */
  const urlCache = new Map()
  /** @type {Map<string, {tint: string, tint2: string}>} */
  const colorCache = new Map()
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map()
  /** 在线补全相关：同一张专辑只问一次，失败的在本次会话里不再重试 */
  const onlineInFlight = new Map()
  const onlineFailed = new Set()

  /** 由 HSL 三元组生成 { tint, tint2, tintSoft } */
  const makeColor = (h, s, l) => ({
    tint: `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`,
    tint2: `hsl(${Math.round((h + 44) % 360)} ${Math.round(Math.max(38, s - 8))}% ${Math.round(Math.max(38, l - 6))}%)`,
    tintSoft: `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}% / 0.18)`
  })

  /**
   * 稳定的「随机色」：由「艺人|专辑」哈希出一个色相。
   * 同一张专辑永远同一个颜色（不会每次刷新都变），但不同专辑彼此独立。
   * 饱和度/亮度也从同一个种子派生一点变化 —— 否则所有专辑「鲜度」一样，
   * 看起来像同一条色带。范围压在偏深偏实的区间，浅色主题下也看得清。
   */
  const fallbackColor = (track) => {
    const seed = `${track?.albumArtist || track?.artist || ''}|${track?.album || track?.title || ''}`
    const { hue } = colorFromString(seed)
    const { hue: salt } = colorFromString(`${seed}|salt`)
    const saturation = 58 + (salt % 26)        // 58~83
    const lightness = 44 + ((salt * 7) % 15)   // 44~58
    return makeColor(hue, saturation, lightness)
  }

  function rememberBlob (key, url) {
    urlCache.set(key, { url, blob: true })
    if (urlCache.size > BLOB_CACHE_LIMIT) {
      const [oldestKey, entry] = urlCache.entries().next().value
      urlCache.delete(oldestKey)
      if (entry.blob) URL.revokeObjectURL(entry.url)
    }
  }

  /** 在线封面补全：把机会交给 artworkProvider 扩展点 */
  function onlineKey (track) {
    const artist = track?.albumArtist || track?.artist || ''
    const album = track?.album || ''
    if (!artist && !album) return null
    return `o:${artist}|${album}`
  }

  async function resolveFromProviders (track) {
    if (!host) return null
    const providers = host.list('artworkProvider')
    if (!providers.length) return null

    const key = onlineKey(track)
    if (!key) return null
    if (urlCache.has(key)) return urlCache.get(key).url
    if (onlineFailed.has(key)) return null
    if (onlineInFlight.has(key)) return onlineInFlight.get(key)

    const task = (async () => {
      try {
        const ordered = providers.slice().sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
        for (const provider of ordered) {
          try {
            const result = await provider.resolve(track, { remote })
            if (!result) continue
            const url = result.url || (result.data ? bytesToBlobUrl(result.data, result.mime) : null)
            if (!url) continue
            rememberBlob(key, url)
            return url
          } catch (err) {
            console.warn(`[artwork] 封面来源 ${provider.id} 失败`, err)
          }
        }
        onlineFailed.add(key)
        return null
      } finally {
        onlineInFlight.delete(key)
      }
    })()

    onlineInFlight.set(key, task)
    return task
  }

  /** @returns {Promise<string|null>} */
  async function resolveUrl (track) {
    const key = artworkKey(track)
    if (!key) return resolveFromProviders(track)
    if (urlCache.has(key)) return urlCache.get(key).url

    if (track.artworkFile) {
      const url = `media://local/?p=${encodeURIComponent(track.artworkFile)}&v=${track.mtimeMs}`
      urlCache.set(key, { url, blob: false })
      return url
    }

    if (!track.artworkEmbedded) return resolveFromProviders(track)
    if (inFlight.has(key)) return inFlight.get(key)

    const task = (async () => {
      try {
        const result = await remote.library.artwork(track.id)
        if (!result || !result.data) return resolveFromProviders(track)
        const url = bytesToBlobUrl(result.data, result.mime)
        rememberBlob(key, url)
        return url
      } catch (err) {
        console.warn('[artwork] 内嵌封面读取失败', err)
        return resolveFromProviders(track)
      } finally {
        inFlight.delete(key)
      }
    })()

    inFlight.set(key, task)
    return task
  }

  /** 用 canvas 从封面图取主色调（受 CORS 限制失败时回退到由专辑名生成的稳定配色） */
  async function resolveColor (track) {
    /*
     * 默认就用「稳定的随机色」，**不再从封面取样**（用户偏好）：
     * 封面取色常常发灰发白（大面积白底/灰摄影），不同专辑之间的观感也不稳定；
     * 由「艺人|专辑」哈希出来的颜色反而更整齐，而且是稳定的（同一张专辑恒定）。
     *
     * 下面那段 canvas 取样的实现保留着，将来若要提供「按封面取色」可以直接接回来。
     */
    return fallbackColor(track)
  }

  /** 保留：按封面取主色（当前默认不走这里） */
  async function resolveCoverColor (track) {
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
        // 比之前更深、更实一点：用户反馈取出来的颜色偏浅、发灰
        Math.min(90, Math.max(54, hsl.s * 122)),
        Math.min(60, Math.max(38, hsl.l * 86))
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

  /**
   * 释放封面缓存（最小化时调用）。
   *
   * 缓存的 blob 最多 120 个，每个都是解码过的位图（480px 见方约 1MB），
   * 这是渲染层里最容易悄悄涨起来的一块。这里 revoke 掉 URL 并清空表，
   * 之后有人要同一张封面会重新走一次 IPC（按下限缓存，值）。
   *
   * 注意：已经显示在 <img> 上的图片不会因此消失 —— revoke 只让「这个 URL
   * 不能再被加载」，已经解码好的位图还在元素里。
   */
  function releaseMemory () {
    let revoked = 0
    for (const entry of urlCache.values()) {
      if (entry.blob) {
        URL.revokeObjectURL(entry.url)
        revoked++
      }
    }
    const urls = urlCache.size
    urlCache.clear()
    colorCache.clear()
    return { urls, revoked }
  }

  // resolveCoverColor：按封面取主色（当前默认不走这里，保留给将来需要时用）
  return { resolveUrl, resolveColor, resolveCoverColor, applyTint, fallbackColor, releaseMemory }
}
