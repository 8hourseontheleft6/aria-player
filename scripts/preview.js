'use strict'

/**
 * 把截图转成「文本预览」，方便在没有图形界面的环境里审阅版面与配色。
 *
 *   npx electron scripts/preview.js docs/screenshots/01-library.png [列数]
 *
 * 输出两张图：
 *   结构图 —— 用字符深浅表示亮度，能看出边栏/列表/封面块的版式
 *   色彩图 —— 高饱和区域用色相字母标注（R 红 Y 黄 G 绿 C 青 B 蓝 P 紫 M 品红）
 */

const path = require('node:path')
const { app, nativeImage } = require('electron')

const RAMP = ' .:-=+*#%@'

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

function hueLetter (h) {
  if (h < 25 || h >= 335) return 'R'
  if (h < 70) return 'Y'
  if (h < 160) return 'G'
  if (h < 200) return 'C'
  if (h < 260) return 'B'
  if (h < 295) return 'P'
  return 'M'
}

function preview (file, cols = 100, crop = null) {
  const source = nativeImage.createFromPath(file)
  if (source.isEmpty()) {
    console.error(`无法读取图片: ${file}`)
    return
  }
  // 局部放大用：整图缩到几十列时，标题栏里一颗 170px 的胶囊只剩 8 个字符，
  // 什么都看不出来。给一个裁切参数就能盯着局部看。
  const image = crop ? source.crop(crop) : source
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const step = 4

  const rows = Math.max(6, Math.round((cols * (height / width)) / 2.05))
  const cellW = width / cols
  const cellH = height / rows

  const structure = []
  const colors = []
  const histogram = new Map()

  for (let cy = 0; cy < rows; cy++) {
    let structureRow = ''
    let colorRow = ''
    for (let cx = 0; cx < cols; cx++) {
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      const x0 = Math.floor(cx * cellW)
      const x1 = Math.max(x0 + 1, Math.floor((cx + 1) * cellW))
      const y0 = Math.floor(cy * cellH)
      const y1 = Math.max(y0 + 1, Math.floor((cy + 1) * cellH))

      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const offset = (y * width + x) * step
          b += bitmap[offset]
          g += bitmap[offset + 1]
          r += bitmap[offset + 2]
          count++
        }
      }
      if (!count) {
        structureRow += ' '
        colorRow += ' '
        continue
      }
      r = Math.round(r / count)
      g = Math.round(g / count)
      b = Math.round(b / count)

      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      structureRow += RAMP[Math.min(RAMP.length - 1, Math.round(luma * (RAMP.length - 1)))]

      const { h, s } = rgbToHsl(r, g, b)
      colorRow += s > 0.14 ? hueLetter(h) : RAMP[Math.min(RAMP.length - 1, Math.round(luma * (RAMP.length - 1)))]

      const key = `${r >> 5}-${g >> 5}-${b >> 5}`
      const entry = histogram.get(key) || { r: 0, g: 0, b: 0, count: 0 }
      entry.r += r
      entry.g += g
      entry.b += b
      entry.count++
      histogram.set(key, entry)
    }
    structure.push(structureRow)
    colors.push(colorRow)
  }

  console.log(`\n=== ${path.basename(file)} — ${width}×${height} → ${cols}×${rows} ===\n`)
  console.log('— 结构图 —')
  for (const row of structure) console.log(`|${row}|`)
  console.log('\n— 色彩图 —')
  for (const row of colors) console.log(`|${row}|`)

  const top = [...histogram.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((entry) => {
      const total = cols * rows
      const percent = ((entry.count / total) * 100).toFixed(1)
      return `rgb(${Math.round(entry.r / entry.count)},${Math.round(entry.g / entry.count)},${Math.round(entry.b / entry.count)}) ${percent}%`
    })
  console.log('\n— 主要色块 —')
  console.log(`  ${top.join('  |  ')}\n`)
}

app.whenReady().then(() => {
  const file = process.argv[2]
  const cols = Number(process.argv[3] || 100)
  const cropArg = process.argv[4]
  if (!file) {
    console.error('用法: npx electron scripts/preview.js <png> [列数] [x,y,w,h]')
    app.exit(1)
    return
  }
  let crop = null
  if (cropArg) {
    const parts = cropArg.split(',').map((value) => Number(value.trim()))
    if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
      console.error('裁切参数格式应为 x,y,w,h（单位：图片像素，可用脚本输出的图片尺寸换算）')
      app.exit(1)
      return
    }
    crop = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
  }
  preview(path.resolve(file), cols, crop)
  app.exit(0)
})
