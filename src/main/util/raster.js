'use strict'

/**
 * 极简位图光栅器：手绘托盘图标与任务栏缩略图按钮图标。
 *
 * 为什么要自己画：托盘 / 缩略图按钮需要 nativeImage，而 nativeImage 不认 SVG。
 * 这里直接生成 BGRA 像素缓冲（nativeImage.createFromBitmap 要求的格式），
 * 不引入任何依赖，也不用往仓库里塞二进制图标。
 */

const { nativeImage } = require('electron')

function color (input) {
  if (typeof input === 'string') {
    const hex = input.replace('#', '')
    const value = parseInt(hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex, 16)
    return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: 1 }
  }
  return { r: input.r || 0, g: input.g || 0, b: input.b || 0, a: input.a === undefined ? 1 : input.a }
}

function createCanvas (width, height) {
  const pixels = Buffer.alloc(width * height * 4) // BGRA，全透明

  function blend (x, y, source) {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= width || py >= height) return
    const offset = (py * width + px) * 4
    const src = color(source)
    if (src.a >= 1) {
      pixels[offset] = src.b
      pixels[offset + 1] = src.g
      pixels[offset + 2] = src.r
      pixels[offset + 3] = 255
      return
    }
    const dstAlpha = pixels[offset + 3] / 255
    const outAlpha = src.a + dstAlpha * (1 - src.a)
    if (outAlpha <= 0) return
    pixels[offset] = Math.round((src.b * src.a + pixels[offset] * dstAlpha * (1 - src.a)) / outAlpha)
    pixels[offset + 1] = Math.round((src.g * src.a + pixels[offset + 1] * dstAlpha * (1 - src.a)) / outAlpha)
    pixels[offset + 2] = Math.round((src.r * src.a + pixels[offset + 2] * dstAlpha * (1 - src.a)) / outAlpha)
    pixels[offset + 3] = Math.round(outAlpha * 255)
  }

  const canvas = {
    width,
    height,

    fillRect (x, y, w, h, fill) {
      for (let py = Math.round(y); py < Math.round(y + h); py++) {
        for (let px = Math.round(x); px < Math.round(x + w); px++) blend(px, py, fill)
      }
      return canvas
    },

    fillCircle (cx, cy, radius, fill) {
      // 4x 超采样做抗锯齿，小图标下边缘会干净很多
      const samples = 3
      for (let py = Math.floor(cy - radius) - 1; py <= Math.ceil(cy + radius) + 1; py++) {
        for (let px = Math.floor(cx - radius) - 1; px <= Math.ceil(cx + radius) + 1; px++) {
          let hits = 0
          for (let sy = 0; sy < samples; sy++) {
            for (let sx = 0; sx < samples; sx++) {
              const dx = px + (sx + 0.5) / samples - cx
              const dy = py + (sy + 0.5) / samples - cy
              if (dx * dx + dy * dy <= radius * radius) hits++
            }
          }
          if (!hits) continue
          const base = color(fill)
          blend(px, py, { ...base, a: base.a * (hits / (samples * samples)) })
        }
      }
      return canvas
    },

    /** 扫描线填充多边形（偶奇规则），用于画音符的符杠 */
    fillPolygon (points, fill) {
      if (points.length < 3) return canvas
      let minY = Infinity
      let maxY = -Infinity
      for (const point of points) {
        minY = Math.min(minY, point[1])
        maxY = Math.max(maxY, point[1])
      }
      for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
        const crossings = []
        for (let i = 0; i < points.length; i++) {
          const [x1, y1] = points[i]
          const [x2, y2] = points[(i + 1) % points.length]
          if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
            crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1))
          }
        }
        crossings.sort((a, b) => a - b)
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          for (let x = Math.ceil(crossings[i]); x <= Math.floor(crossings[i + 1]); x++) blend(x, y, fill)
        }
      }
      return canvas
    },

    /** @param {number} scaleFactor 传入 2 表示这是 2 倍图，逻辑尺寸减半 */
    toImage (scaleFactor = 1) {
      return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor })
    }
  }

  return canvas
}

/* ------------------------------------------------------------------ */
/* 具体图标                                                            */
/* ------------------------------------------------------------------ */

/** 八分音符：托盘图标 */
function createNoteIcon (fill, size = 32, scaleFactor = 2) {
  const unit = size / 32
  const canvas = createCanvas(size, size)
  const head = 4.4 * unit
  canvas.fillCircle(11 * unit, 23 * unit, head, fill)
  canvas.fillCircle(23 * unit, 20 * unit, head, fill)
  canvas.fillRect(13.4 * unit, 7 * unit, 2.2 * unit, 16 * unit, fill)
  canvas.fillRect(25.4 * unit, 4 * unit, 2.2 * unit, 16 * unit, fill)
  canvas.fillPolygon([
    [13.4 * unit, 7.4 * unit],
    [27.6 * unit, 4.4 * unit],
    [27.6 * unit, 8.6 * unit],
    [13.4 * unit, 11.6 * unit]
  ], fill)
  return canvas.toImage(scaleFactor)
}

function createTransportIcon (kind, fill, size = 32, scaleFactor = 2) {
  const u = size / 32
  const canvas = createCanvas(size, size)
  const bar = (x) => canvas.fillRect(x * u, 7 * u, 2.6 * u, 18 * u, fill)
  const triangle = (points) => canvas.fillPolygon(points.map(([x, y]) => [x * u, y * u]), fill)

  if (kind === 'play') {
    triangle([[9, 6], [25, 16], [9, 26]])
  } else if (kind === 'pause') {
    canvas.fillRect(9 * u, 6 * u, 4.4 * u, 20 * u, fill)
    canvas.fillRect(18.6 * u, 6 * u, 4.4 * u, 20 * u, fill)
  } else if (kind === 'next') {
    triangle([[6, 6], [20, 16], [6, 26]])
    bar(22)
  } else if (kind === 'prev') {
    triangle([[26, 6], [12, 16], [26, 26]])
    bar(7)
  } else if (kind === 'stop') {
    canvas.fillRect(9 * u, 9 * u, 14 * u, 14 * u, fill)
  }
  return canvas.toImage(scaleFactor)
}

const WHITE = { r: 255, g: 255, b: 255, a: 1 }
const BLACK = { r: 0, g: 0, b: 0, a: 1 }

module.exports = {
  createCanvas,
  createNoteIcon,
  createTransportIcon,
  WHITE,
  BLACK
}
