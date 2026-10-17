'use strict'

/**
 * 「打开的文件」——player 档位唯一的曲目来源。
 *
 * 与本体里 library 服务的分工完全不同，**刻意不共用**：
 *   · library：扫描音乐文件夹 → 建索引 → 解析元数据/封面 → 目录监听 → 增量更新
 *   · openedFiles（本文件）：只处理"用户这次打开了哪些文件"，读元数据，进临时队列。
 *     不建索引、不扫目录、不监听、不读封面、不联网。
 *
 * 为什么要单独一个服务而不是给 library 加开关：
 * 档位的差别是"有没有这套东西"，不是"这套东西关掉了"。library 里有 watcher、封面缓存、
 * 在线补全等一整套联动，靠 if 关不干净，也说不清哪些副作用还在跑（比如封面缓存目录）。
 *
 * 数据只落一份小清单：userData/recent.json（路径 + 文件名 + 时间）。
 * 重启后「最近打开」就是它 —— 那不是资料库索引，删掉也不影响任何东西。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { app } = require('electron')
const { readMetadata } = require('./metadata')

/** 最近打开的条目数上限（不是音乐库索引，只是一份"最近"清单） */
const RECENT_LIMIT = 50
/** 一次「打开文件夹」最多收多少个文件（防止手滑拖进整个磁盘） */
const FOLDER_FILE_LIMIT = 2000

/** 轻量播放器支持的音频扩展名（与 fileAssociations 保持一致） */
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.oga', '.opus', '.aac', '.wma', '.aiff', '.aif'])

const isAudio = (filePath) => AUDIO_EXTENSIONS.has(path.extname(String(filePath)).toLowerCase())

function createOpenedFilesService (ctx) {
  /** @type {Array<{ path: string, name: string, openedAt: number }>} */
  let recent = []
  let loaded = false
  /**
   * 本次会话里"用户真的打开过"的文件。
   *
   * media:// 协议要用它当白名单：本体是"只允许资料库目录内的文件"，
   * 而 player 没有资料库 —— 那就只放行用户亲手打开过的那些文件，
   * 而不是把整个磁盘都放开（安全边界不能因为换了个产品就没有）。
   */
  const allowed = new Set()

  const file = () => path.join(app.getPath('userData'), 'recent.json')

  const load = () => {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'))
      if (Array.isArray(parsed)) {
        recent = parsed
          .filter((item) => item && typeof item.path === 'string')
          .slice(0, RECENT_LIMIT)
      }
    } catch (err) {
      // 第一次运行没有这个文件是正常的；真的写坏了也不该挡住启动
      if (err && err.code !== 'ENOENT') console.warn('[openedFiles] 读取最近打开失败：', err.message)
    }
  }

  const persist = () => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.writeFileSync(file(), JSON.stringify(recent, null, 2), 'utf8')
    } catch (err) {
      console.warn('[openedFiles] 写入最近打开失败：', err.message)
    }
  }

  const remember = (paths) => {
    if (!paths.length) return
    const now = Date.now()
    const incoming = paths.map((item) => ({ path: item, name: path.basename(item), openedAt: now }))
    const seen = new Set(incoming.map((item) => item.path))
    recent = [...incoming, ...recent.filter((item) => !seen.has(item.path))].slice(0, RECENT_LIMIT)
    persist()
  }

  /**
   * 读一个文件的元数据 —— **刻意不读封面**。
   * 需求里写得很清楚：player 不生成封面缓存。所以这里把 covers 与 sidecarCover 都关掉，
   * 只拿标题/艺人/专辑/时长这些播放与显示必需的信息（解析也快得多）。
   */
  const trackOf = async (filePath, stat) => {
    const track = await readMetadata(filePath, { stat, covers: false, sidecarCover: false })
    return track
  }

  /**
   * 把用户"打开"的路径解析成可播放的曲目。
   * 文件夹只在这一刻遍历一次（不监听、不建索引），子目录也收 —— 拖一个专辑文件夹进来才符合直觉。
   */
  const resolve = async (paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).filter((item) => typeof item === 'string' && item)
    /** @type {Array<object>} */
    const tracks = []
    const accepted = []
    const rejected = []

    const takeFile = async (filePath) => {
      if (!isAudio(filePath)) {
        rejected.push({ path: filePath, reason: 'not-audio' })
        return
      }
      try {
        const stat = await fsp.stat(filePath)
        tracks.push(await trackOf(filePath, stat))
        accepted.push(filePath)
        allowed.add(filePath)
      } catch (err) {
        rejected.push({ path: filePath, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' })
      }
    }

    const takeFolder = async (folder) => {
      const queue = [folder]
      let seen = 0
      while (queue.length && seen < FOLDER_FILE_LIMIT) {
        const current = queue.shift()
        let entries
        try {
          entries = await fsp.readdir(current, { withFileTypes: true })
        } catch (err) {
          rejected.push({ path: current, reason: 'unreadable' })
          continue
        }
        for (const entry of entries) {
          if (seen >= FOLDER_FILE_LIMIT) break
          const full = path.join(current, entry.name)
          if (entry.isDirectory()) queue.push(full)
          else if (entry.isFile() && isAudio(full)) {
            seen++
            await takeFile(full)
          }
        }
      }
    }

    for (const item of list) {
      let stat
      try {
        stat = await fsp.stat(item)
      } catch {
        rejected.push({ path: item, reason: 'missing' })
        continue
      }
      if (stat.isDirectory()) await takeFolder(item)
      else await takeFile(item)
    }

    if (accepted.length) remember(accepted)
    return {
      action: tracks.length ? 'play' : 'none',
      trackIds: tracks.map((track) => track.id),
      tracks,
      accepted,
      rejected
    }
  }

  return {
    async init () {
      load()
      return { recent: recent.length }
    },

    /** 最近打开（新在前）—— 渲染层的空列表就是它；空的时候要给一条出路 */
    getRecent () {
      load()
      return recent.map((item) => ({ ...item }))
    },

    /**
     * 启动时把「最近打开」解析成曲目（读元数据，但不重复记进清单，
     * 也不因为文件被删掉就把整条记录丢掉 —— 只把解析不出来的跳过）。
     */
    async resolveRecent () {
      load()
      const tracks = []
      const missing = []
      for (const item of recent) {
        try {
          const stat = await fsp.stat(item.path)
          if (!stat.isFile() || !isAudio(item.path)) {
            missing.push(item.path)
            continue
          }
          tracks.push(await trackOf(item.path, stat))
          allowed.add(item.path)
        } catch {
          missing.push(item.path)
        }
      }
      return { tracks, missing, total: recent.length }
    },

    /** 解析并返回曲目（供「打开文件 / 打开文件夹 / 拖放」使用） */
    resolve,

    /** 只记账（不解析）：macOS 的 open-file 冷启动路径用它先收着，解析由渲染层统一做 */
    async add (paths = []) {
      load()
      const list = (Array.isArray(paths) ? paths : [paths]).filter((item) => typeof item === 'string' && item)
      if (!list.length) return { added: 0, recent: recent.length }
      remember(list)
      return { added: list.length, recent: recent.length }
    },

    async clear () {
      recent = []
      persist()
      return { recent: 0 }
    },

    /** media:// 的白名单：只放行用户真的打开过的文件（本体不用这条，它有自己的资料库目录白名单） */
    isAllowed (filePath) {
      return allowed.has(String(filePath))
    },

    paths: {
      file: () => file(),
      audioExtensions: [...AUDIO_EXTENSIONS]
    }
  }
}

module.exports = { createOpenedFilesService, RECENT_LIMIT, FOLDER_FILE_LIMIT, AUDIO_EXTENSIONS }
