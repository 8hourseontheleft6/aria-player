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
  /*
   * 艺人头像的伪曲目（artistOnly：只有艺人名）也要有自己的 key。
   *
   * 没有 key 就返回 null 时，懒加载那边的去重是「节点上的 artKey === 这次的 key」，
   * 而所有伪曲目的 key 都是空串 —— 于是插上第一张头像之后，换到另一位歌手时
   * 判断为「图就是这个条目的」直接返回，圆里一直留着上一位的脸（自检里
   * 「各不相同的图像」这条抓到的就是它：三位艺人拿到的是同一个 blob URL）。
   * 给了 key，节点复用时的去重、缓存、串台判断才都成立。
   */
  if (track.artistOnly) return `artist:${track.artist || track.albumArtist || ''}`
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

export function createArtworkService ({ bus, host = null, store = null }) {
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
        /*
         * 内嵌封面有两条来源：
         *   · 资料库档位：library.artwork（走索引，能读任何库内文件）；
         *   · player 档位：**没有 library 服务**（IPC 会被兜成 null），改用 opened.artwork ——
         *     只认"这次 / 最近打开过"的文件（主进程那份白名单）。
         * 之前 player 里也走第一条，于是永远拿不到封面：列表里一行图片都没有。
         */
        const caps = window.aria && window.aria.profile ? window.aria.profile.capabilities : null
        const useOpened = Boolean(caps && caps.library !== true && remote.opened && remote.opened.artwork)
        const result = useOpened
          ? await remote.opened.artwork(track.path)
          : await remote.library.artwork(track.id)
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

  /**
   * 主题色的**唯一来源**。
   *
   * 用户要求"背景、示波器、选项框选中态、光晕必须跟随同一个颜色来源" ——
   * 这些位置读的都是 CSS 变量 --tint / --tint-2（见 applyTint），所以只要这里只有一条出口，
   * 它们就必然同色系。两档由设置决定：
   *   cover   → 从封面取样（默认）
   *   palette → 「艺人|专辑」哈希出的稳定配色
   * 取不到色 / 过灰 / 过白时 resolveCoverColor 内部回退到 palette，所以这里不用再兜。
   */
  async function resolveColor (track) {
    const source = store ? store.get().settings.tintSource : 'cover'
    if (source === 'palette') return fallbackColor(track)
    return resolveCoverColor(track)
  }

  /**
   * 按封面取主色（默认路径）。
   *
   * 三个必须：
   *   · **稳定**：缓存键用 artworkKey(track)（`e:艺人|专辑` / `f:路径`），
   *     不能用 blob URL —— 那东西每次加载都不同，按它缓存等于没缓存。
   *   · **不卡**：同一个 key 的并发取样只做一次（inFlight）；失败也缓存（负缓存），不反复重试。
   *   · **只在内存里做**：canvas + Image，没有任何磁盘写入 —— player 档不能生成封面缓存目录。
   */
  async function resolveCoverColor (track) {
    const key = artworkKey(track)
    if (!key) return fallbackColor(track)
    const cached = colorCache.get(key)
    if (cached) return cached
    const flightKey = 'color:' + key
    if (inFlight.has(flightKey)) return inFlight.get(flightKey)

    const task = (async () => {
      const url = await resolveUrl(track)
      if (!url) return rememberColor(key, fallbackColor(track))

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

        let sSum = 0
        let lSum = 0
        let weight = 0
        let hueX = 0
        let hueY = 0

        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 128) continue
          const { h, s, l } = rgbToHsl(data[i], data[i + 1], data[i + 2])
          /* 跳过近黑与近白的像素：它们对"这张专辑是什么颜色"没有发言权 */
          if (l < 0.14 || l > 0.92) continue
          const w = 0.25 + s * s
          const rad = (h * Math.PI) / 180
          hueX += Math.cos(rad) * w
          hueY += Math.sin(rad) * w
          weight += w
          /*
           * 直接累加**每个像素自己的**饱和度/亮度，而不是先把 RGB 平均再转 HSL。
           * 后者是错的：一张红绿蓝都有的彩色封面，RGB 平均下来就是灰的 ——
           * 「取出来的颜色偏浅发灰」（旧注释里那句用户反馈）和这次的质量门误判都是它造成的。
           */
          sSum += s * w
          lSum += l * w
        }

        if (!weight) throw new Error('封面缺少可用像素')
        const hue = ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360
        const sampled = { s: sSum / weight, l: lSum / weight }
        /*
         * 整体质量门（用户要求：取样失败、**过灰**、**过白**时回退到稳定配色）。
         * 逐像素门只去掉黑白像素；一整张灰白摄影仍会算出 s≈0.05 / l≈0.8 的"颜色"，
         * 那种颜色铺到光晕与示波器上就是一层脏灰。这里直接回退。
         */
        /*
         * 整体质量门（用户要求：取样失败、**过灰**、**过白**时回退到稳定配色）。
         * 逐像素门已经去掉近黑/近白像素；这里再看整张图的平均饱和与平均亮度：
         *   · 平均饱和 < 0.12 —— 黑白摄影 / 灰底封面，怎么取都是脏灰；
         *   · 平均亮度 > 0.85 —— 大面积白底，取出来铺到光晕上会发光过度；
         *   · 平均亮度 < 0.08 —— 全黑封面。
         * 三种都回退，并且**缓存**这次回退（负缓存），不反复重试同一张图。
         */
        if (sampled.s < 0.12 || sampled.l > 0.85 || sampled.l < 0.08) {
          return rememberColor(key, fallbackColor(track))
        }

        return rememberColor(key, makeColor(
          hue,
          // 比取样值更深、更实一点：浅色封面取出来的颜色铺在光晕上会发飘
          Math.min(90, Math.max(54, sampled.s * 122)),
          Math.min(60, Math.max(38, sampled.l * 86))
        ))
      } catch {
        /* 加载失败 / 超时 / 取不到像素：负缓存，避免每次切歌都重试同一张坏封面 */
        return rememberColor(key, fallbackColor(track))
      }
    })()

    inFlight.set(flightKey, task)
    try {
      return await task
    } finally {
      inFlight.delete(flightKey)
    }
  }

  /** 写入颜色缓存（带容量上限），返回同一个颜色对象 */
  function rememberColor (key, color) {
    colorCache.set(key, color)
    if (colorCache.size > 64) colorCache.delete(colorCache.keys().next().value)
    return color
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
