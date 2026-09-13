'use strict'

const fsp = require('node:fs/promises')
const path = require('node:path')

/** 目录索引缓存：小写文件名 -> 真实文件名（Windows 大小写不敏感，但保持可移植） */
const dirIndexCache = new Map()

/**
 * @param {string} dir
 * @returns {Promise<Map<string, string>>}
 */
async function listDirIndex (dir) {
  if (dirIndexCache.has(dir)) return dirIndexCache.get(dir)
  const index = new Map()
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      index.set(entry.name.toLowerCase(), entry.name)
    }
  } catch {
    // 目录不可读时返回空索引
  }
  dirIndexCache.set(dir, index)
  if (dirIndexCache.size > 4096) {
    const oldest = dirIndexCache.keys().next().value
    dirIndexCache.delete(oldest)
  }
  return index
}

function invalidateDirIndex (dir) {
  dirIndexCache.delete(dir)
}

/**
 * 在目录中按扩展名候选查找同名附件（如 .lrc / .txt / 封面图）。
 * @param {string} dir
 * @param {string} baseName 不含扩展名的文件名
 * @param {string[]} extensions 形如 ['.lrc']
 * @returns {Promise<string|null>} 绝对路径
 */
async function findSidecar (dir, baseName, extensions) {
  const index = await listDirIndex(dir)
  const lowerBase = baseName.toLowerCase()
  for (const ext of extensions) {
    const hit = index.get(lowerBase + ext)
    if (hit) return path.join(dir, hit)
  }
  return null
}

/** 在目录中查找常见封面文件名 */
async function findCoverImage (dir) {
  const index = await listDirIndex(dir)
  const stems = ['cover', 'folder', 'front', 'album', 'albumart', 'artwork', 'poster', '封面']
  const exts = ['.jpg', '.jpeg', '.png', '.webp']
  for (const stem of stems) {
    for (const ext of exts) {
      const hit = index.get(stem + ext)
      if (hit) return path.join(dir, hit)
    }
  }
  return null
}

/** 查找与音频同名的封面文件 */
async function findNamedImage (dir, baseName) {
  return findSidecar(dir, baseName, ['.jpg', '.jpeg', '.png', '.webp'])
}

/** 递归遍历音频文件（跳过隐藏目录与常见系统目录） */
const SKIP_DIRS = new Set([
  'node_modules', '$recycle.bin', 'system volume information', '.git',
  'windows', 'program files', 'program files (x86)', 'appdata'
])

/**
 * @param {string} root
 * @param {(filePath: string) => boolean} accept
 * @param {{ maxDepth?: number }} [options]
 * @returns {Promise<string[]>}
 */
async function walkFiles (root, accept, options = {}) {
  const maxDepth = options.maxDepth ?? 16
  const out = []
  const stack = [{ dir: root, depth: 0 }]

  while (stack.length) {
    const { dir, depth } = stack.pop()
    if (depth > maxDepth) continue
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const name = entry.name
      if (name.startsWith('.')) continue
      const full = path.join(dir, name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name.toLowerCase())) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile() && accept(full)) {
        out.push(full)
      }
    }
  }
  return out
}

module.exports = {
  listDirIndex,
  invalidateDirIndex,
  findSidecar,
  findCoverImage,
  findNamedImage,
  walkFiles
}
