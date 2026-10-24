'use strict'

/**
 * 每首曲目的播放位置（续播）。
 *
 * 数据只有一份小 JSON：userData/resume.json
 *   { version: 1, entries: { "<文件路径>": { seconds, updatedAt } } }
 *
 * 三条规则（都有自检）：
 *  · 上限 500 条，超了按 updatedAt 丢最旧的；
 *  · 只有"听了一段"才值得记（>= 5 秒），太靠尾巴（离结束 < 10 秒）不记 —— 那种情况多半是听完了；
 *  · 播完（ended）立刻删掉这条，下次从头开始。
 *
 * 关掉设置（resumePlayback=false）后，读写都不再碰这个文件。
 */

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

const LIMIT = 500
const MIN_SECONDS = 5
const TAIL_SECONDS = 10
const VERSION = 1

/** 只保留最近 N 条（纯函数，自检直接测） */
function trimEntries (entries, limit = LIMIT) {
  const list = Object.entries(entries || {})
  if (list.length <= limit) return { entries: { ...(entries || {}) }, dropped: 0 }
  const sorted = list.sort((a, b) => Number(b[1] && b[1].updatedAt) - Number(a[1] && a[1].updatedAt))
  const kept = sorted.slice(0, limit)
  return { entries: Object.fromEntries(kept), dropped: list.length - limit }
}

/**
 * 这个位置值不值得记（纯函数）。
 * @param {number} seconds 当前秒数
 * @param {number} duration 总时长（0/未知时不看尾巴）
 */
function isRestorable (seconds, duration) {
  const value = Number(seconds)
  const total = Number(duration)
  if (!Number.isFinite(value) || value < MIN_SECONDS) return false
  /* 剩下不到（含正好）TAIL_SECONDS 秒就当听完了，别记 —— 边界取等号 */
  if (Number.isFinite(total) && total > 0 && value >= total - TAIL_SECONDS) return false
  return true
}

function createResumeService (ctx) {
  const settings = ctx.get('settings')
  const filePath = path.join(app.getPath('userData'), 'resume.json')

  /** @type {Record<string, { seconds: number, updatedAt: number }>} */
  let entries = {}
  let loaded = false
  let writing = Promise.resolve()
  let timer = null

  function enabled () {
    return settings.get().resumePlayback !== false
  }

  function load () {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (parsed && parsed.entries && typeof parsed.entries === 'object') {
        entries = parsed.entries
      }
    } catch {
      // 没有文件 / 文件坏了：当作空表，不影响播放
      entries = {}
    }
  }

  function persist () {
    if (!enabled()) return Promise.resolve()
    const snapshot = { version: VERSION, entries: trimEntries(entries, LIMIT).entries }
    writing = writing.catch(() => {}).then(async () => {
      try {
        const { writeJsonAtomic } = require('../util/atomic-json')
        await writeJsonAtomic(filePath, snapshot)
      } catch (error) {
        console.error('[resume] 写入失败:', error && error.message)
      }
    })
    return writing
  }

  function schedule () {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      persist()
    }, 1500)
    if (timer.unref) timer.unref()
  }

  return {
    /** 某一首的位置（关掉设置时永远返回 0） */
    get (filePathArg) {
      if (!enabled()) return 0
      load()
      const item = entries[String(filePathArg || '')]
      return item && Number.isFinite(Number(item.seconds)) ? Number(item.seconds) : 0
    },

    /** 记一次位置；不值得记的位置会被忽略 */
    set (filePathArg, seconds, duration) {
      const key = String(filePathArg || '')
      if (!key || !enabled()) return { ok: false, code: 'disabled' }
      if (!isRestorable(seconds, duration)) return { ok: false, code: 'not-worth-it' }
      load()
      entries[key] = { seconds: Math.round(Number(seconds) * 10) / 10, updatedAt: Date.now() }
      const trimmed = trimEntries(entries, LIMIT)
      entries = trimmed.entries
      schedule()
      return { ok: true, count: Object.keys(entries).length, dropped: trimmed.dropped }
    },

    /** 播完 / 用户主动从头开始时删掉 */
    clear (filePathArg) {
      const key = String(filePathArg || '')
      load()
      if (!entries[key]) return { ok: true, removed: false }
      delete entries[key]
      schedule()
      return { ok: true, removed: true }
    },

    /** 诊断/设置页用 */
    info () {
      load()
      return { enabled: enabled(), count: Object.keys(entries).length, limit: LIMIT, file: filePath }
    },

    async flush () {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      await persist()
    }
  }
}

module.exports = { createResumeService, trimEntries, isRestorable, LIMIT, MIN_SECONDS, TAIL_SECONDS }
