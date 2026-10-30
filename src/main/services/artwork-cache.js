'use strict'

/**
 * 封面磁盘缓存的清理**规划**（任务 3 的剩余部分，先做纯逻辑 + 自检，尚未接线）。
 *
 * 设计上刻意分成两步：
 *   planPrune()  纯计算，返回"该删哪些、为什么"，**不动磁盘** —— 这就是需求里的 dry-run；
 *   applyPlan()  由调用方在确认后执行删除（本文件不直接删，方便先测再开）。
 *
 * 只处理 artwork-cache 里的**可重建**文件（`.jpg`），其它一律不碰：
 * 音频、歌词、用户文件永远不在候选里。
 */

const JPEG_RE = /^(?:thumb-)?[0-9a-f]{8,}\.jpg$/i

/**
 * @param {object} input
 * @param {Array<{name: string, size: number, at: number}>} input.files  目录里的文件（at = 最近访问/修改时间）
 * @param {number} input.maxBytes  容量上限
 * @param {number} [input.maxAgeMs] 超过这个年龄的孤儿直接清（0/undefined = 不按年龄清）
 * @param {Set<string>|string[]} [input.keepIds] 仍在库里的曲目 id（不在其中的缓存视为孤儿）
 * @param {number} [input.now]
 */
function planPrune ({ files = [], maxBytes = 0, maxAgeMs = 0, keepIds = null, now = Date.now() } = {}) {
  const keep = keepIds ? new Set(keepIds) : null
  const candidates = []
  const untouched = []
  for (const file of Array.isArray(files) ? files : []) {
    const name = String(file && file.name || '')
    const size = Math.max(0, Number(file && file.size) || 0)
    const at = Number(file && file.at) || 0
    /* 不是"可重建的封面缓存"就一律不动 */
    if (!JPEG_RE.test(name)) {
      untouched.push({ name, size, reason: 'not-artwork-cache' })
      continue
    }
    const id = name.replace(/^thumb-/, '').replace(/\.jpg$/i, '')
    if (keep && !keep.has(id)) {
      candidates.push({ name, size, at, reason: 'orphan' })
      continue
    }
    if (maxAgeMs > 0 && at > 0 && now - at > maxAgeMs) {
      candidates.push({ name, size, at, reason: 'stale' })
      continue
    }
    candidates.push({ name, size, at, reason: 'keep' })
  }

  let bytes = candidates.filter((item) => item.reason === 'keep').reduce((sum, item) => sum + item.size, 0)
  const remove = candidates.filter((item) => item.reason !== 'keep')

  /* 仍然超容量：按 at 从旧到新淘汰（LRU），直到回到上限以内 */
  if (maxBytes > 0 && bytes > maxBytes) {
    const byAge = candidates
      .filter((item) => item.reason === 'keep')
      .slice()
      .sort((a, b) => a.at - b.at)
    for (const item of byAge) {
      if (bytes <= maxBytes) break
      bytes -= item.size
      remove.push({ ...item, reason: 'over-capacity' })
    }
  }

  const removeNames = new Set(remove.map((item) => item.name))
  return {
    dryRun: true,
    remove: remove.slice().sort((a, b) => a.name.localeCompare(b.name)),
    keep: candidates.filter((item) => !removeNames.has(item.name)).map((item) => item.name).sort(),
    untouched,
    bytesAfter: bytes,
    bytesBefore: candidates.reduce((sum, item) => sum + item.size, 0),
    limit: maxBytes
  }
}

module.exports = { planPrune, JPEG_RE }
