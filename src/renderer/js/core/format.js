/** 格式化与文本工具 */

import { isMac as bridgeIsMac } from './remote.js'

/**
 * 当前是不是 macOS。
 *
 * 优先读 DOM 上的 `data-platform`（CSS 里的 darwin 规则用的是同一个来源，
 * 渲染层只留一个真相），拿不到再退回 preload 给的值。
 * 这样界面上所有和平台有关的文案（⌘ / Ctrl、⌥ / Alt）只需一处判断。
 */
export function isMacOS () {
  const fromDom = document.documentElement?.dataset?.platform
  if (fromDom) return fromDom === 'darwin'
  return bridgeIsMac
}

/** 命令键的写法：macOS 是 ⌘，其它平台是 Ctrl */
export function modLabel () {
  return isMacOS() ? '⌘' : 'Ctrl'
}

/** Option / Alt 键的写法：macOS 是 ⌥ */
export function altLabel () {
  return isMacOS() ? '⌥' : 'Alt'
}

/**
 * 组合键提示文案。macOS 习惯不带加号（⌘F），Windows / Linux 写 Ctrl+F。
 * @param {string} combo 例如 'F'、'← / →'、'A'
 */
export function keyHint (combo) {
  return isMacOS() ? `⌘${combo}` : `Ctrl+${combo}`
}

/**
 * 把「扫描时读不了某个音乐目录」翻译成用户能照做的一句话。
 *
 * 错误码来自主进程（Node 的 fs 错误）。放在这里而不是 app.js 里，
 * 是为了让自检能直接 import 这个模块做断言（smoke 里有对应的一条）。
 * macOS 上最常见的是 EACCES/EPERM —— TCC 权限不让未授权的应用读「文稿 / 桌面 / 下载」，
 * 而扫描会"成功返回 0 首"，用户只看到「扫不到歌」，所以这句提示必须给出可执行的下一步。
 *
 * @param {{ dir?: string, code?: string }} info
 * @param {number} count 一共多少个目录读不了（>1 时补一句）
 */
export function describeUnreadable (info, count = 1) {
  const where = info && info.dir ? `「${info.dir}」` : '某个音乐文件夹'
  const code = (info && info.code) || 'UNKNOWN'
  const more = count > 1 ? `（另有 ${count - 1} 个目录也读不了）` : ''
  if (code === 'EACCES' || code === 'EPERM') {
    return `没有权限读取${where}${more} —— macOS 上请到「系统设置 → 隐私与安全性 → 文件与文件夹」允许 Aria 访问，或把音乐放进「音乐」文件夹`
  }
  if (code === 'ENOENT') {
    return `${where}不存在了${more} —— 可能被移动、重命名，或外接硬盘没插上`
  }
  if (code === 'ENOTDIR') {
    return `${where}不是一个文件夹${more} —— 在设置里移除它，再重新添加正确的目录`
  }
  return `读取${where}失败（${code}）${more} —— 到设置里检查这个音乐文件夹还能不能访问`
}

/**
 * 与 macOS **系统保留键**冲突的那几个功能用这个：
 * ⌘Q 是「退出」、⌘M 是「最小化」，不能让应用抢走（用户按 ⌘M 想最小化，结果被静音了）。
 * 所以 macOS 上这两个功能改走 ⌥⌘ 变体；其它平台没有这个冲突，仍用 Ctrl+。
 * 目前用于「播放队列」与「静音」，改绑定时记得同时改这里和 app.js 的按键分支。
 */
export function reservedKeyHint (combo) {
  return isMacOS() ? `⌥⌘${combo}` : `Ctrl+${combo}`
}

/** 秒 -> "3:45" / "1:02:33" */
export function formatDuration (seconds, { forceHours = false } = {}) {
  if (!Number.isFinite(seconds) || seconds < 0) return forceHours ? '0:00:00' : '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (h > 0 || forceHours) return `${h}:${pad(m)}:${pad(s)}`
  return `${m}:${pad(s)}`
}

/** 秒 -> "1 小时 12 分钟" */
export function formatDurationLong (seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 分钟'
  const totalMinutes = Math.round(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分钟`
  if (h > 0) return `${h} 小时`
  return `${m} 分钟`
}

export function formatBytes (bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** 播放速度显示：1 -> "1×"，1.25 -> "1.25×" */
export function formatRate (rate) {
  const rounded = Math.round(rate * 100) / 100
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, '')
  return `${text}×`
}

/** 搜索用归一化：小写 + 去变音符 */
export function normalizeForSearch (value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

export function escapeRegExp (value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 相对时间：刚刚 / 3 分钟前 */
export function formatRelativeTime (timestamp) {
  if (!timestamp) return '从未'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

/** 把路径缩短显示：C:\Users\me\Music -> …\Music（保留首尾） */
export function shortenPath (value, head = 16, tail = 26) {
  const text = String(value || '')
  if (text.length <= head + tail + 3) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

export function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function unique (list) {
  return [...new Set(list)]
}

/** 简单的字符串哈希，用于确定性选择（比如没有封面时生成配色） */
export function hashString (value) {
  let hash = 2166136261
  const text = String(value || '')
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 由字符串生成稳定的 HSL 颜色 */
export function colorFromString (value, { saturation = 62, lightness = 52 } = {}) {
  const hue = hashString(value) % 360
  return { hsl: `hsl(${hue} ${saturation}% ${lightness}%)`, hue }
}
