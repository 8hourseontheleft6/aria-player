'use strict'

/**
 * 「打开的文件」——player 档位唯一的曲目来源。
 *
 * 与本体里 library 服务的分工完全不同，**刻意不共用**：
 *   · library：扫描音乐文件夹 → 建索引 → 解析元数据/封面 → 目录监听 → 增量更新
 *   · openedFiles（本文件）：只记住"用户这次打开了哪些文件"，不建索引、不扫目录、不查在线
 *
 * 为什么要单独一个服务而不是给 library 加开关：
 * 档位的差别是"有没有这套东西"，不是"这套东西关掉了"。library 里有 watcher、封面缓存、
 * 在线补全等一整套联动，靠 if 关不干净，也说不清哪些副作用还在跑。
 *
 * 第 1 步只要求它能被挂上、能启动；真正接进播放链路是第 3 步的事。
 * 数据落在 userData/recent.json（两个档位 userData 各自独立，见第 2 步）。
 */

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

/** 最近打开的条目数上限（不是音乐库索引，只是一份"最近"清单） */
const RECENT_LIMIT = 50

function createOpenedFilesService (ctx) {
  /** @type {Array<{ path: string, name: string, openedAt: number }>} */
  let recent = []
  let loaded = false

  const file = () => path.join(app.getPath('userData'), 'recent.json')

  const load = () => {
    if (loaded) return
    loaded = true
    try {
      const raw = fs.readFileSync(file(), 'utf8')
      const parsed = JSON.parse(raw)
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

  return {
    async init () {
      load()
      return { recent: recent.length }
    },

    /** 最近打开（新在前）——空列表时渲染层要给一条出路（打开文件 / 打开文件夹） */
    getRecent () {
      load()
      return recent.map((item) => ({ ...item }))
    },

    /**
     * 记下一批路径。
     * 第 1 步只做记账（把路径与文件名收进"最近"）；第 3 步会把它交给播放队列。
     */
    async add (paths = []) {
      load()
      const now = Date.now()
      const incoming = paths
        .filter((item) => typeof item === 'string' && item)
        .map((item) => ({ path: item, name: path.basename(item), openedAt: now }))
      if (!incoming.length) return { added: 0, recent: recent.length }
      const seen = new Set(incoming.map((item) => item.path))
      recent = [...incoming, ...recent.filter((item) => !seen.has(item.path))].slice(0, RECENT_LIMIT)
      persist()
      return { added: incoming.length, recent: recent.length }
    },

    async clear () {
      recent = []
      persist()
      return { recent: 0 }
    }
  }
}

module.exports = { createOpenedFilesService, RECENT_LIMIT }
