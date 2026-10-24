'use strict'

/**
 * 滚动日志 + 脱敏。
 *
 * 为什么不用现成的：主进程只需要「写文件、滚动、读最后 N 行」三件事，
 * 自己六十行就够，不必为它加依赖。
 *
 * 脱敏是硬要求（诊断包会带走日志）：
 *  · 外部模型的 key（`sk-...`、`ghp_...`、Bearer token、`api_key=...`）
 *  · URL 里的凭据（`http://user:pass@host`）
 *  · 用户名路径（`C:\Users\<名字>`、`/home/<名字>`、`/Users/<名字>`）
 */

const fs = require('node:fs')
const path = require('node:path')

const MAX_BYTES = 512 * 1024
const MAX_LINES = 2000

let logFile = null
let stream = null
let secret = ''

const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\b(api[_-]?key|token|secret|password)\s*[=:]\s*["']?[^"'\s,}]{6,}["']?/gi
]

/** 脱敏：key、URL 凭据、用户名路径 */
function redact (text) {
  let out = String(text == null ? '' : text)
  if (secret) out = out.split(secret).join('***')
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, (match) => {
    const prefix = /^(api[_-]?key|token|secret|password)/i.exec(match)
    if (prefix) return `${prefix[1]}=***`
    if (/^Bearer/i.test(match)) return 'Bearer ***'
    return '***'
  })
  /* URL 里的 user:pass@ */
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
  /* 用户名路径（注意：`\b` 在 `/` 前面不成立，所以这里不能用它） */
  out = out.replace(/\b([A-Za-z]:\\Users\\)[^\\/\s]+/g, '$1***')
  out = out.replace(/(\/home\/)[^/\s]+/g, '$1***')
  out = out.replace(/(\/Users\/)[^/\s]+/g, '$1***')
  return out
}

/** 当前进程的用户名路径（给诊断包替换用；日志里已经按规则替换过） */
function userPaths () {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const out = []
  if (home) out.push(home)
  if (process.env.APPDATA) out.push(process.env.APPDATA)
  if (process.env.LOCALAPPDATA) out.push(process.env.LOCALAPPDATA)
  return out
}

function rotateIfNeeded () {
  if (!logFile) return
  try {
    const size = fs.statSync(logFile).size
    if (size < MAX_BYTES) return
    if (stream) {
      stream.end()
      stream = null
    }
    fs.renameSync(logFile, `${logFile}.1`)
  } catch {
    // 文件还不存在或改名失败：下一行重开就是了
    if (stream) {
      stream.end()
      stream = null
    }
  }
}

/** 初始化（userData/logs/main.log）；重复调用安全 */
function init (dir) {
  if (logFile) return logFile
  const target = path.join(dir, 'logs')
  fs.mkdirSync(target, { recursive: true })
  logFile = path.join(target, 'main.log')
  return logFile
}

/** 记一行（自动脱敏 + 滚动） */
function write (level, message, extra) {
  const line = `[${new Date().toISOString()}] [${level}] ${redact(message)}` +
    (extra === undefined ? '' : ' ' + redact(typeof extra === 'string' ? extra : JSON.stringify(extra))) + '\n'
  if (!logFile) {
    process.stdout.write(redact(line))
    return
  }
  try {
    rotateIfNeeded()
    if (!stream) stream = fs.createWriteStream(logFile, { flags: 'a' })
    stream.write(line)
  } catch {
    // 写日志失败不能再抛（会把崩溃处理器套进死循环）
  }
}

/** 记一串「某段自检/启动步骤」的结果，给诊断包用 */
function info (message, extra) { write('info', message, extra) }
function warn (message, extra) { write('warn', message, extra) }
function error (message, extra) { write('error', message, extra) }

/** 最近 N 行（诊断包用；读不到就是空数组） */
function tail (limit = MAX_LINES) {
  if (!logFile) return []
  const files = [logFile, `${logFile}.1`].filter((file) => {
    try { return fs.existsSync(file) } catch { return false }
  })
  const lines = []
  for (const file of files) {
    try {
      lines.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean))
    } catch {
      // 忽略
    }
  }
  return lines.slice(-limit)
}

/** 告诉日志器当前的密钥（这样连「原样打印 key」的日志也能被换掉） */
function setSecret (value) {
  secret = String(value || '')
}

module.exports = { init, write, info, warn, error, tail, redact, setSecret, userPaths, file: () => logFile }
