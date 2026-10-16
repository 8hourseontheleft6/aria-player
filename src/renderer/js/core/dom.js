/**
 * 极简 DOM 构建工具。
 * 不引入框架：整个渲染层用 h() 直接建节点，避免打包器与构建步骤。
 *
 *   h('div', { class: 'row', onClick: fn }, '文本', h('span', ...))
 */

export function h (tag, props, ...children) {
  const node = document.createElement(tag)

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue

      if (key === 'class' || key === 'className') {
        node.className = value
      } else if (key === 'text') {
        node.textContent = String(value)
      } else if (key === 'html') {
        // 仅用于可信的内联 SVG 图标
        node.innerHTML = value
      } else if (key === 'style' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) {
          if (val === null || val === undefined) continue
          if (prop.startsWith('--')) node.style.setProperty(prop, String(val))
          else node.style[prop] = val
        }
      } else if (key === 'dataset' && typeof value === 'object') {
        Object.assign(node.dataset, value)
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value)
      } else if (key in node && key !== 'list' && typeof value !== 'object') {
        try {
          node[key] = value
        } catch {
          node.setAttribute(key, String(value))
        }
      } else {
        node.setAttribute(key, String(value))
      }
    }
  }

  append(node, children)
  return node
}

function append (node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    if (Array.isArray(child)) append(node, child)
    else if (child instanceof Node) node.appendChild(child)
    else node.appendChild(document.createTextNode(String(child)))
  }
}

/** 用 HTML 字符串建节点（仅用于本地可信模板，如内联 SVG） */
export function fragment (html) {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild
}

export function qs (selector, root = document) {
  return root.querySelector(selector)
}

export function qsa (selector, root = document) {
  return [...root.querySelectorAll(selector)]
}

export function clear (node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

/** 事件委托 */
export function delegate (root, eventName, selector, handler) {
  const listener = (event) => {
    const target = event.target instanceof Element ? event.target.closest(selector) : null
    if (target && root.contains(target)) handler(event, target)
  }
  root.addEventListener(eventName, listener)
  return () => root.removeEventListener(eventName, listener)
}

/* ---------------- 常用交互 ---------------- */

export function on (target, type, handler, options) {
  target.addEventListener(type, handler, options)
  return () => target.removeEventListener(type, handler, options)
}

/** 点击外部关闭（浮层用） */
export function onOutsideClick (element, handler) {
  const listener = (event) => {
    if (!element.contains(event.target)) handler(event)
  }
  // 延迟绑定，避免触发当前这次点击
  const timer = setTimeout(() => document.addEventListener('pointerdown', listener, true), 0)
  return () => {
    clearTimeout(timer)
    document.removeEventListener('pointerdown', listener, true)
  }
}

/**
 * 「减少动画」开着吗？
 *
 * CSS 那边由 `html[data-reduce-motion="true"] *` 统一把 animation/transition 的时长压到 0.001ms，
 * 但那条规则**管不到 JS 驱动的运动** —— `scrollTo({ behavior: 'smooth' })`、canvas 动画、
 * 惯性滚动都不看 CSS。所以这些地方必须自己问一次。
 *
 * 与应用其它地方（ui/views/media-wall.js）同一套判据：先看设置在 html 上留下的这个标记。
 */
export function prefersReducedMotion () {
  return document.documentElement.dataset.reduceMotion === 'true'
}

export function raf (fn) {
  let handle = 0
  let running = false
  const loop = (time) => {
    fn(time)
    if (running) handle = requestAnimationFrame(loop)
  }
  return {
    start () {
      if (running) return
      running = true
      handle = requestAnimationFrame(loop)
    },
    stop () {
      running = false
      cancelAnimationFrame(handle)
    },
    get running () {
      return running
    }
  }
}

export function debounce (fn, wait = 150) {
  let timer = null
  return (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, wait)
  }
}

/** 把元素滚动到可视区（虚拟列表定位用） */
export function scrollIntoViewIfNeeded (scroller, element, padding = 8) {
  const top = element.offsetTop
  const bottom = top + element.offsetHeight
  const viewTop = scroller.scrollTop
  const viewBottom = viewTop + scroller.clientHeight
  if (top < viewTop + padding) scroller.scrollTop = top - padding
  else if (bottom > viewBottom - padding) scroller.scrollTop = bottom - scroller.clientHeight + padding
}
