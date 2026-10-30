'use strict'

/**
 * 播放历史（任务 5）。
 *
 * 为什么单独一个文件：以前每次切歌都会 `markPlayed` → `saveCache()`，
 * 也就是把**整份 library-cache.json**（810 首、几百 KB）重写一遍。
 * 历史只是「路径 → 时间戳」，独立存成小文件、防抖批量落盘即可。
 *
 * 规则：
 *  · 上限 500 条（按时间倒序保留最近的）；
 *  · 原子写（复用 util/atomic-json），失败只记日志，绝不影响播放；
 *  · 退出时 flush；
 *  · 旧数据兼容：没有这个文件就是空历史，library-cache 里的 lastPlayed 仍然生效。
 */

const path = require('node:path')
const fsp = require('node:fs/promises')
const { app } = require('electron')
const { writeJsonAtomic } = require('../util/atomic-json')

const HISTORY_VERSION = 1
const LIMIT = 500
const DEBOUNCE_MS = 1200

function createPlayHistory (ctx, { limit = LIMIT, debounceMs = DEBOUNCE_MS } = {}) {
  const file = path.join(app.getPath('userData'), 'play-history.json')
  /** @type {Map<string, number>} path → 最近播放时间 */
  let played = new Map()
  let loaded = false
  let timer = null
  let writing = Promise.resolve()
  const stats = { writes: 0, bytesWritten: 0, lastWriteAt: 0, skipped: 0 }

  async function load () {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'))
      const source = parsed && parsed.version === HISTORY_VERSION && parsed.played ? parsed.played : {}
      for (const [key, value] of Object.entries(source)) {
        const at = Number(value)
        if (key && Number.isFinite(at) && at > 0) played.set(key, at)
      }
      trim()
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[history] 读取失败，按空历史处理:', err.message)
    }
  }

  function trim () {
    if (played.size <= limit) return
    const sorted = [...played.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    played = new Map(sorted)
  }

  function schedule () {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      write().catch(() => {})
    }, debounceMs)
    if (timer.unref) timer.unref()
  }

  async function write () {
    const payload = {
      version: HISTORY_VERSION,
      played: Object.fromEntries(played)
    }
    const text = JSON.stringify(payload)
    writing = writing.then(() => writeJsonAtomic(file, payload)).then(() => {
      stats.writes++
      stats.bytesWritten += Buffer.byteLength(text, 'utf8')
      stats.lastWriteAt = Date.now()
    }).catch((error) => {
      console.warn('[history] 写入失败（不影响播放）:', error.message)
    })
    return writing
  }

  return {
    async init () {
      await load()
      return { count: played.size, file }
    },
    async mark (trackPath, at = Date.now()) {
      await load()
      const key = String(trackPath || '')
      if (!key) return null
      played.delete(key)
      played.set(key, at)
      trim()
      schedule()
      return at
    },
    /** 把历史合并进曲目对象（library 加载 / 扫描完成后调用） */
    async apply (list) {
      await load()
      if (!Array.isArray(list) || !list.length) return 0
      let applied = 0
      for (const track of list) {
        const at = played.get(track.path)
        if (!at) continue
        /* 取两者较新的：老缓存里的 lastPlayed 也不能丢 */
        if (!Number(track.lastPlayed) || at > Number(track.lastPlayed)) {
          track.lastPlayed = at
          applied++
        }
      }
      return applied
    },
    get (trackPath) {
      return played.get(String(trackPath || '')) || 0
    },
    async flush () {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await writing.catch(() => {})
      if (!loaded) return
      await write()
    },
    stats: () => ({ ...stats, count: played.size, file })
  }
}

module.exports = { createPlayHistory, HISTORY_VERSION, LIMIT }
