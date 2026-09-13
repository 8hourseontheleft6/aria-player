/**
 * 图标集：内联 SVG，风格参照 SF Symbols（传输控件用实心，工具图标用描边）。
 * 想加图标，在 ICONS 里补一条即可。
 */

const FILLED = {
  play: '<path d="M8.2 4.9v14.2c0 1.1 1.2 1.7 2.1 1.1l11-7.1c.8-.5.8-1.7 0-2.2l-11-7.1c-.9-.6-2.1 0-2.1 1.1z"/>',
  pause: '<rect x="6.4" y="4.4" width="4" height="15.2" rx="1.5"/><rect x="13.6" y="4.4" width="4" height="15.2" rx="1.5"/>',
  next: '<path d="M5.6 6.1v11.8c0 .9 1 1.4 1.7.9l9-5.9c.7-.4.7-1.4 0-1.8l-9-5.9c-.7-.5-1.7 0-1.7.9z"/><rect x="17.2" y="4.6" width="2.9" height="14.8" rx="1.45"/>',
  prev: '<path d="M18.4 6.1v11.8c0 .9-1 1.4-1.7.9l-9-5.9c-.7-.4-.7-1.4 0-1.8l9-5.9c.7-.5 1.7 0 1.7.9z"/><rect x="3.9" y="4.6" width="2.9" height="14.8" rx="1.45"/>',
  stop: '<rect x="5.5" y="5.5" width="13" height="13" rx="2.6"/>',
  music: '<path d="M20.4 3.1c0-.8-.7-1.4-1.5-1.2L8.6 4.5c-.6.1-1 .7-1 1.3v10.4a4 4 0 1 0 1.9 3.4V7.7l9.4-2.3v7.4a4 4 0 1 0 1.5 3.1V3.1z"/>',
  ellipsis: '<circle cx="5.2" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.8" cy="12" r="1.7"/>',
  sparkles: '<path d="M12 2.6l1.9 5.3 5.3 1.9-5.3 1.9L12 17l-1.9-5.3L4.8 9.8l5.3-1.9z"/><path d="M18.8 15.4l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z"/>',
  speaker: '<path d="M3.4 9.2h3.3l4.4-3.9c.6-.5 1.5-.1 1.5.7v12c0 .8-.9 1.2-1.5.7l-4.4-3.9H3.4A1 1 0 0 1 2.4 14v-3.8a1 1 0 0 1 1-1z"/>',
  dot: '<circle cx="12" cy="12" r="4"/>'
}

const STROKE = {
  chevronDown: 'M6.2 9.6 12 15.4l5.8-5.8',
  chevronUp: 'M6.2 14.4 12 8.6l5.8 5.8',
  chevronLeft: 'M14.6 6.2 8.8 12l5.8 5.8',
  chevronRight: 'M9.4 6.2 15.2 12l-5.8 5.8',
  close: 'M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6',
  minus: 'M5 12h14',
  maximize: 'M6.2 6.2h11.6v11.6H6.2z',
  restore: 'M9.2 6.2h8.6v8.6M6.2 9.2h8.6v8.6H6.2z',
  search: 'M11 4.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6zM16 16l4.4 4.4',
  shuffle: 'M3.2 6.6h3.4c1.3 0 2.5.6 3.2 1.7l4.6 6.8c.7 1.1 1.9 1.7 3.2 1.7h3.2M3.2 17.4h3.4c1.3 0 2.5-.6 3.2-1.7l.8-1.2M14.4 9.9l.8-1.2c.7-1.1 1.9-1.7 3.2-1.7h3.2M18.8 3.8l3 2.8-3 2.8M18.8 14.6l3 2.8-3 2.8',
  repeat: 'M7.4 3.4 4 6.8l3.4 3.4M4 6.8h12.6a3.4 3.4 0 0 1 3.4 3.4v1.2M16.6 20.6 20 17.2l-3.4-3.4M20 17.2H7.4A3.4 3.4 0 0 1 4 13.8v-1.2',
  repeatOne: 'M7.4 3.4 4 6.8l3.4 3.4M4 6.8h12.6a3.4 3.4 0 0 1 3.4 3.4v1.2M16.6 20.6 20 17.2l-3.4-3.4M20 17.2H7.4A3.4 3.4 0 0 1 4 13.8v-1.2M11.4 10.4l1.8-1.2v6',
  arrowRight: 'M4.5 12h14M13.5 6.8 18.8 12l-5.3 5.2',
  list: 'M8.4 6.6h11.2M8.4 12h11.2M8.4 17.4h11.2M4.4 6.6h.02M4.4 12h.02M4.4 17.4h.02',
  sidebar: 'M4.2 6.2h15.6v11.6H4.2zM9.6 6.2v11.6',
  folder: 'M3.6 7.4a2 2 0 0 1 2-2h3.1l1.9 2.1h7.8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z',
  plus: 'M12 5.2v13.6M5.2 12h13.6',
  trash: 'M4.6 7h14.8M9.6 7V5.4h4.8V7M6.6 7l.9 12.4h9l.9-12.4M10.2 10.6v5.8M13.8 10.6v5.8',
  refresh: 'M20 11.4a8 8 0 1 0-2.1 5.8M20 5.6v5.8h-5.8',
  waveform: 'M4 10.2v3.6M8 6.6v10.8M12 3.6v16.8M16 7.6v8.8M20 10.4v3.2',
  checkmark: 'M5.2 12.6 9.6 17 18.8 7.2',
  sliders: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h8M16 17h4',
  gearCircle: 'M12 15.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2z',
  info: 'M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4zM12 11v5.4M12 8.1h.02',
  external: 'M14.2 4.8h5v5M19.2 4.8 11 13M16.8 13.4v4.8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.2V8.6A1.6 1.6 0 0 1 5.6 7h4.8',
  clock: 'M12 3.8a8.2 8.2 0 1 0 0 16.4 8.2 8.2 0 0 0 0-16.4zM12 7.4V12l3.2 2',
  lyrics: 'M4.6 6.8h14.8M4.6 12h9.6M4.6 17.2h11.8',
  gauge: 'M20 17.2a9 9 0 1 0-16 0M12 13.2 16.2 9',
  muteX: 'M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8',
  downToLine: 'M12 4.2v10M8 10.6l4 4 4-4M5 19.4h14',
  target: 'M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2zM12 9.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z',
  textSize: 'M4 18.4 8.2 5.6l4.2 12.8M5.6 14.2h5.2M15.4 18.4V11c0-1.2 1-2.1 2.3-2.1s2.3.9 2.3 2.1v7.4M15.4 14.4h4.6'
}

function wrap (body, { stroke }) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${stroke ? ' class="icon icon--stroke"' : ''}>${body}</svg>`
}

/**
 * FILLED 里存的是完整的内联标记（可含多个 <path>/<rect>），
 * STROKE 里存的是 path 的 d 数据，这里必须补上 <path d="..."> 外壳，
 * 否则浏览器会把那段数据当成文本渲染出来。
 */
function bodyFor (name) {
  if (FILLED[name]) return { markup: FILLED[name], stroke: false }
  if (STROKE[name]) return { markup: `<path d="${STROKE[name]}"/>`, stroke: true }
  return { markup: FILLED.dot, stroke: false }
}

/**
 * @param {string} name
 * @param {{ className?: string, stroke?: boolean }} [options]
 * @returns {SVGElement}
 */
export function icon (name, options = {}) {
  const { markup: body, stroke: isStroke } = bodyFor(name)
  const markup = wrap(body, { stroke: options.stroke ?? isStroke })
  const template = document.createElement('template')
  template.innerHTML = markup
  const node = template.content.firstElementChild
  node.setAttribute('class', options.className || 'icon')
  return node
}

/** 供 html: 属性使用的原始字符串 */
export function iconMarkup (name, className = 'icon') {
  const { markup: body, stroke: isStroke } = bodyFor(name)
  return `<svg viewBox="0 0 24 24" class="${className}${isStroke ? ' icon--stroke' : ''}" aria-hidden="true">${body}</svg>`
}

export const ICON_NAMES = [...Object.keys(FILLED), ...Object.keys(STROKE)]
