'use strict'

/**
 * 在线缓存（封面 / 艺人头像）的容量上限、原子写与清理规划。
 *
 * 和 artwork-cache.js 同一套设计：`planPrune()` 只算"该删哪些"（dry-run，不碰磁盘），
 * `applyPlan()` 在用户 / 定时任务确认后才真删。区别在于**范围更窄**：
 *   · 只认 `online-cache/covers`、`online-cache/artists*` 这两类目录；
 *   · 只认 `<24 位十六进制>.bin` 与配套的 `.json` 元数据；
 *   · `lyrics/` 目录（在线歌词缓存）**一个文件都不碰** —— 需求明确：不删歌词。
 * 音频与用户文件本来就不在 online-cache 里，这里再用白名单挡一层。
 */

/** 只允许封面 / 艺人头像目录（artists、artists2 … 是版本化的目录名） */
const COVER_FOLDER_RE = /^artists\d*$|^covers$/
/** 缓存键是 hashKey() 的 sha1 前 24 位，配套 .bin（图片字节）与 .json（元数据） */
const COVER_FILE_RE = /^[0-9a-f]{16,40}\.(?:bin|json)$/

function isCoverFolder (folder) {
  return COVER_FOLDER_RE.test(String(folder || ''))
}

function isCoverFile (name) {
  return COVER_FILE_RE.test(String(name || ''))
}

function keyOf (name) {
  return String(name || '').replace(/\.(?:bin|json)$/i, '')
}

/**
 * 把文件列表聚合成"缓存条目"（同一 key 的 .bin + .json 算一条，必须一起删）。
 * 非封面目录 / 非封面文件一律进 untouched，不参与容量与淘汰计算。
 *
 * @param {Array<{folder: string, name: string, size: number, at: number}>} entries
 */
function groupEntries (entries) {
  const groups = new Map()
  const untouched = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const folder = String(entry && entry.folder || '')
    const name = String(entry && entry.name || '')
    const size = Math.max(0, Number(entry && entry.size) || 0)
    const at = Number(entry && entry.at) || 0
    if (!isCoverFolder(folder) || !isCoverFile(name)) {
      untouched.push({ folder, name, size, reason: 'not-online-cover-cache' })
      continue
    }
    const id = `${folder}/${keyOf(name)}`
    const group = groups.get(id) || { folder, id, bytes: 0, at: 0, files: [] }
    group.bytes += size
    group.at = Math.max(group.at, at)
    group.files.push({ folder, name, size })
    groups.set(id, group)
  }
  return { groups, untouched }
}

/**
 * 规划清理。**不改磁盘、不改入参**。
 *
 * @param {object} input
 * @param {Array<{folder: string, name: string, size: number, at: number}>} input.entries
 * @param {number} input.maxBytes 容量上限（0 = 不按容量清）
 * @param {number} [input.now]
 */
function planPrune ({ entries = [], maxBytes = 0, now = Date.now() } = {}) {
  const { groups, untouched } = groupEntries(entries)
  const all = [...groups.values()]
  const total = all.reduce((sum, group) => sum + group.bytes, 0)

  const removeGroups = []
  let bytesAfter = total
  if (maxBytes > 0 && total > maxBytes) {
    /* 按"最近一次访问"从旧到新淘汰（同一 key 的 bin+json 一起走） */
    const byAge = all.slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    for (const group of byAge) {
      if (bytesAfter <= maxBytes) break
      bytesAfter -= group.bytes
      removeGroups.push(group)
    }
  }

  const removed = new Set(removeGroups.map((group) => group.id))
  const remove = []
  for (const group of removeGroups) {
    for (const file of group.files) {
      remove.push({ folder: group.folder, name: file.name, size: file.size, reason: 'over-capacity' })
    }
  }
  remove.sort((a, b) => `${a.folder}/${a.name}`.localeCompare(`${b.folder}/${b.name}`))
  const keep = all
    .filter((group) => !removed.has(group.id))
    .map((group) => `${group.folder}/${group.id.split('/')[1]}`)
    .sort()

  return {
    dryRun: true,
    remove,
    keep,
    untouched,
    bytesBefore: total,
    bytesAfter,
    limit: Math.max(0, Number(maxBytes) || 0),
    entries: all.length,
    now
  }
}

/**
 * 执行清理计划。dir 是 online-cache 根目录，计划里的 folder 只允许封面目录。
 * 单条失败不影响其它条；文件已经不在了（ENOENT）不算失败。
 */
async function applyPlan (root, plan, { fs, dryRun = true } = {}) {
  const result = { dryRun, deleted: [], failed: [], bytesFreed: 0, skipped: [] }
  if (!plan || !Array.isArray(plan.remove)) return result
  const path = require('node:path')
  for (const item of plan.remove) {
    const folder = String(item && item.folder || '')
    const name = String(item && item.name || '')
    /* 双重保险：目录与文件名都必须过白名单，绝不放行路径分隔符或 lyrics */
    if (!isCoverFolder(folder) || !isCoverFile(name) || name.includes('/') || name.includes('\\')) {
      result.failed.push({ folder, name, message: 'not-online-cover-cache' })
      continue
    }
    if (dryRun) {
      result.deleted.push(`${folder}/${name}`)
      continue
    }
    try {
      await fs.unlink(path.join(root, folder, name))
      result.deleted.push(`${folder}/${name}`)
      result.bytesFreed += Math.max(0, Number(item.size) || 0)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        result.skipped.push(`${folder}/${name}`)
        continue
      }
      result.failed.push({ folder, name, message: String(error && error.code || error && error.message || error) })
    }
  }
  return result
}

/**
 * 原子写：先写同目录的临时文件再 rename。
 *
 * 为什么要：在线封面是"图片 + 元数据"两个文件，进程在两次写之间被杀掉，
 * 或者两个请求同时写同一个 key，都会留下"有 json 没 bin"或半截文件 ——
 * 后者在 readBinary 里表现为封面永远加载失败，而且不会自愈。
 */
async function writeFileAtomic (file, data, { fs } = {}) {
  const path = require('node:path')
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  )
  try {
    await fs.writeFile(temp, data)
    await fs.rename(temp, file)
  } catch (error) {
    try { await fs.unlink(temp) } catch { /* 临时文件可能没建出来 */ }
    throw error
  }
}

module.exports = { planPrune, applyPlan, writeFileAtomic, isCoverFolder, isCoverFile, COVER_FOLDER_RE, COVER_FILE_RE }
