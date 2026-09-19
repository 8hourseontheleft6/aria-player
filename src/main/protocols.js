'use strict'

const { protocol, net } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { Readable } = require('node:stream')

const { mimeFor } = require('./util/mime')

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer')

/**
 * 允许渲染层以 CORS 方式取用这些资源。
 * media:// 必须带上它：否则 <audio crossOrigin="anonymous"> 会因缺少
 * Access-Control-Allow-Origin 而加载失败，而 WebAudio 的
 * MediaElementAudioSourceNode 又会因为 CORS 限制输出静音。
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
}

/** app://   —— 渲染层自身的 HTML/CSS/JS（标准 scheme，因此 ES module 可用）
 *  media:// —— 本地音乐与封面（流式 + Range，seek 必需） */
const SCHEMES = [
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  },
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  },
  {
    /*
     * remote: —— 在线音源的播放代理。
     *
     * 为什么必须有它：直链交给渲染层的 <audio> 时，跨源会撞上 CORS
     * （音频分析插件会设 crossOrigin，浏览器就会做 CORS 检查），
     * 而绝大多数音源返回的地址不会带 Access-Control-Allow-Origin。
     * 代理一层之后，渲染层拿到的是同应用内的地址，而且主进程可以顺手
     * 补上 Referer/User-Agent 之类的请求头 —— 很多音源没有这个头就 403。
     */
    scheme: 'remote',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
]

/** 必须在 app ready 之前调用 */
function registerSchemes () {
  protocol.registerSchemesAsPrivileged(SCHEMES)
}

/* ------------------------------------------------------------------ */
/* app://                                                              */
/* ------------------------------------------------------------------ */

function safeResolve (root, urlPath) {
  const decoded = decodeURIComponent(urlPath)
  const target = path.resolve(root, '.' + path.posix.normalize(decoded))
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return target
}

async function handleAppRequest (request) {
  const url = new URL(request.url)
  let pathname = url.pathname
  if (!pathname || pathname === '/') pathname = '/index.html'
  const filePath = safeResolve(RENDERER_ROOT, pathname)
  if (!filePath) return new Response('Forbidden', { status: 403 })

  try {
    const stat = await fsp.stat(filePath)
    if (stat.isDirectory()) return handleAppRequest(new Request(new URL('/index.html', url)))
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'Content-Type': mimeFor(filePath) } })
    }
    const data = await fsp.readFile(filePath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mimeFor(filePath),
        'Cache-Control': 'no-cache',
        ...CORS_HEADERS
      }
    })
  } catch {
    return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS_HEADERS } })
  }
}

/* ------------------------------------------------------------------ */
/* media://                                                            */
/* ------------------------------------------------------------------ */

/**
 * http Range 解析。返回 null 表示无 Range，{invalid:true} 表示 416。
 * @param {string|null} header
 * @param {number} size
 */
function parseRangeHeader (header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim())
  if (!match) return { invalid: true }

  let start
  let end
  if (match[1] === '') {
    const suffixLength = Number(match[2])
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true }
    start = Math.max(0, size - suffixLength)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return { invalid: true }
  }
  return { start, end }
}

function isInsideRoots (filePath, roots) {
  const resolved = path.resolve(filePath)
  return roots.some((root) => {
    const rel = path.relative(root, resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/**
 * @param {object} ctx 服务容器（惰性取用 library 服务，避免循环依赖）
 */
function registerMediaHandler (ctx) {
  protocol.handle('media', async (request) => {
    const url = new URL(request.url)
    const encoded = url.searchParams.get('p')

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (!encoded) return new Response('Bad Request', { status: 400, headers: CORS_HEADERS })

    let filePath
    try {
      filePath = decodeURIComponent(encoded)
    } catch {
      return new Response('Bad Request', { status: 400, headers: CORS_HEADERS })
    }

    // 只允许播放用户已加入资料库的目录内的文件
    const roots = ctx.has('library') ? ctx.get('library').getAllowedRoots() : []
    if (!isInsideRoots(filePath, roots)) {
      return new Response('Forbidden', { status: 403, headers: CORS_HEADERS })
    }

    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch {
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
    }
    if (!stat.isFile()) return new Response('Not Found', { status: 404, headers: CORS_HEADERS })

    const size = stat.size
    const mime = mimeFor(filePath)
    const range = parseRangeHeader(request.headers.get('range'), size)

    if (range && range.invalid) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, ...CORS_HEADERS }
      })
    }

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          ...CORS_HEADERS
        }
      })
    }

    if (size === 0) {
      return new Response(new Uint8Array(0), {
        status: 200,
        headers: { 'Content-Type': mime, 'Content-Length': '0', 'Accept-Ranges': 'bytes', ...CORS_HEADERS }
      })
    }

    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const nodeStream = fs.createReadStream(filePath, { start, end })
    // 客户端 seek 时会取消请求，toWeb 会把取消传播为 stream.destroy()
    const body = Readable.toWeb(nodeStream)

    const headers = {
      'Content-Type': mime,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

    return new Response(body, { status: range ? 206 : 200, headers })
  })
}

/**
 * remote:// —— 在线音源的流式代理。
 *
 * 音源解析出来的直链登记在 musicSources 的令牌表里，渲染层只拿到
 * `remote://stream/<token>`；真实地址与请求头留在主进程，页面拿不到也不需要。
 * Range 透传给上游（这样拖动进度条仍然能 seek）。
 */
function registerRemoteHandler (ctx) {
  protocol.handle('remote', async (request) => {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }
    const url = new URL(request.url)
    const token = url.pathname.replace(/^\/+/, '').split('/').pop()
    if (!token || !ctx.has('musicSources')) {
      return new Response('Bad Request', { status: 400, headers: CORS_HEADERS })
    }
    const entry = ctx.get('musicSources').getStreamTarget(token)
    if (!entry) return new Response('Not Found', { status: 404, headers: CORS_HEADERS })

    const range = request.headers.get('range')
    const headers = { ...(entry.headers || {}) }
    if (range) headers.Range = range
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'Aria/0.0.0-dev (local music player)'
    }

    let upstream
    try {
      upstream = await net.fetch(entry.url, { headers, redirect: 'follow' })
    } catch (err) {
      return new Response(`Upstream error: ${err.message}`, { status: 502, headers: CORS_HEADERS })
    }
    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`Upstream HTTP ${upstream.status}`, { status: upstream.status, headers: CORS_HEADERS })
    }

    const out = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS
    }
    const length = upstream.headers.get('content-length')
    if (length) out['Content-Length'] = length
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) out['Content-Range'] = contentRange

    if (request.method === 'HEAD' || !upstream.body) {
      return new Response(null, { status: upstream.status, headers: out })
    }
    return new Response(upstream.body, { status: upstream.status, headers: out })
  })
}

function registerProtocols (ctx) {
  protocol.handle('app', handleAppRequest)
  registerMediaHandler(ctx)
  registerRemoteHandler(ctx)
}

/** 渲染层用来引用本地文件的 URL 构造器（同时给 main 内部使用） */
function toMediaUrl (filePath, version) {
  const base = `media://local/?p=${encodeURIComponent(filePath)}`
  return version ? `${base}&v=${version}` : base
}

module.exports = { registerSchemes, registerProtocols, toMediaUrl, RENDERER_ROOT }
