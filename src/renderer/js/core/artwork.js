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

  /**
   * 由 HSL 三元组生成 { tint, tint2, tintSoft }，**按当前主题夹一次范围**。
   *
   * 为什么按主题夹：同一个色相在深色底上要偏亮才看得清，在浅色（近白）底上
   * 反而要偏暗、偏饱和才不像"发灰的土色"—— 之前两套主题共用一套亮度，
   * 浅色下背景几乎看不出专辑色（用户反馈过）。
   */
  const themeNow = () => (typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'light' ? 'light' : 'dark')

  const makeColor = (h, s, l, theme = themeNow()) => {
    const range = theme === 'light'
      ? { sMin: 46, sMax: 78, lMin: 38, lMax: 56 }
      : { sMin: 52, sMax: 86, lMin: 48, lMax: 66 }
    const sat = Math.min(range.sMax, Math.max(range.sMin, s))
    const lit = Math.min(range.lMax, Math.max(range.lMin, l))
    return {
      tint: `hsl(${Math.round(h)} ${Math.round(sat)}% ${Math.round(lit)}%)`,
      tint2: `hsl(${Math.round((h + 44) % 360)} ${Math.round(Math.max(range.sMin - 6, sat - 8))}% ${Math.round(Math.max(range.lMin - 4, lit - 6))}%)`,
      tintSoft: `hsl(${Math.round(h)} ${Math.round(sat)}% ${Math.round(lit)}% / 0.18)`
    }
  }

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
    const url = await resolveUrl(track)
    if (!url) return fallbackColor(track)
    // 缓存里存的是原始 HSL：命中时按**当前主题**重新格式化（切主题后颜色立刻跟上）
    if (colorCache.has(url)) {
      const cached = colorCache.get(url)
      return makeColor(cached.h, cached.s, cached.l)
    }

    try {
      const image = new Image()
      image.crossOrigin = 'anonymous'
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error('封面加载失败'))
        image.src = url
        setTimeout(() => reject(new Error('封面加载超时')), 8000)
      })

      const size = 24
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(image, 0, 0, size, size)
      const { data } = ctx.getImageData(0, 0, size, size)

      /*
       * 主色聚类，而不是整图平均。
       *
       * 平均法的问题：封面大面积是白/灰/黑时，平均出来就是灰调；一张很艳的封面
       * 只要配一块大白底，饱和度也会被拉平（用户反馈「有些曲子取色不好」）。
       * 这里按色相分 24 个桶，权重用 s²（偏爱鲜艳像素）再乘一个「别太亮也别太暗」的
       * 中间调系数，取权重最高的桶，并在桶内算饱和度/亮度的加权平均 ——
       * 得到的是「这张封面上最显眼的那一色」，而不是所有像素的混合。
       */
      const BUCKETS = 24
      const bucketWeight = new Float64Array(BUCKETS)
      const bucketS = new Float64Array(BUCKETS)
      const bucketL = new Float64Array(BUCKETS)
      const bucketPixels = new Float64Array(BUCKETS)

      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue
        const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2])
        // 近乎纯黑/纯白/灰的像素不参与投票（它们本来就不是「颜色」）
        if (l < 0.12 || l > 0.94 || s < 0.08) continue
        const midTone = 1 - Math.min(1, Math.abs(l - 0.55) * 1.6)
        const w = 0.15 + s * s * (0.4 + midTone)
        const bucket = Math.min(BUCKETS - 1, Math.floor((h / 360) * BUCKETS))
        bucketWeight[bucket] += w
        bucketS[bucket] += s * w
        bucketL[bucket] += l * w
        bucketPixels[bucket] += 1
      }

      let best = -1
      let bestWeight = 0
      for (let b = 0; b < BUCKETS; b++) {
        if (bucketWeight[b] > bestWeight) {
          bestWeight = bucketWeight[b]
          best = b
        }
      }
      if (best < 0 || !bucketPixels[best]) throw new Error('封面缺少可用像素')

      const sAvg = bucketS[best] / bestWeight
      const lAvg = bucketL[best] / bestWeight
      // 桶中心角作为色相（桶内色相本来就很接近，不需要再做圆周平均）
      const hue = ((best + 0.5) * 360) / BUCKETS

      /*
       * 缓存的是「原始 HSL」，不是格式化后的字符串 ——
       * 这样切换亮/暗主题时，下一次 resolveColor 会按新主题重新夹范围，
       * 不需要清缓存也能立刻正确（之前缓存字符串，切主题后颜色会停在旧主题上）。
       */
      const raw = { h: hue, s: Math.min(92, Math.max(40, sAvg * 118)), l: Math.min(76, Math.max(34, lAvg * 100)) }
      colorCache.set(url, raw)
      if (colorCache.size > 64) colorCache.delete(colorCache.keys().next().value)
      return makeColor(raw.h, raw.s, raw.l)
    } catch {
      const fallback = fallbackColor(track)
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

  return { resolveUrl, resolveColor, applyTint, fallbackColor, releaseMemory }
}
