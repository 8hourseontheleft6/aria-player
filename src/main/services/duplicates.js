'use strict'

/**
 * 重复曲目检测（**只报告，不删文件**）。
 *
 * 两段式，避免对几千首歌全量算哈希：
 *  1. **初筛**：按「文件大小 + 时长（±1 秒）」分组 —— 完全相同的文件一定同组，
 *     不同码率的同一首歌大小差很多，一般不会同组；
 *  2. **判重**：同组内算**内容指纹**（首 64KB + 末尾 64KB + 大小的 sha1，够区分且很快）。
 *     指纹相同 → 「完全重复」；指纹不同 → 「可能重复」（同大小同时长但内容不同，
 *     或者同一首歌的不同版本）。
 *
 * 另外单独给一组「可能重复」：**同艺人 + 同标题 + 时长接近**，但大小不同（不同码率 / 不同来源）。
 * 这类不报"完全重复"，只标"可能重复"，免得用户误以为文件一模一样。
 *
 * 为什么用"首尾 64KB + 大小"而不是整文件哈希：一个 60MB 的 FLAC 全量哈希要几百毫秒，
 * 一个库几百首就是分钟级；首尾采样对"同一首歌的两次拷贝"完全够用（同大小 + 首尾一致）。
 */

const fs = require('node:fs')
const crypto = require('node:crypto')

const SAMPLE = 64 * 1024
const DURATION_SLACK = 1

/** 时长的取整桶：把 179.9 和 180.1 归到一起 */
function durationBucket (seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.round(value / DURATION_SLACK) * DURATION_SLACK
}

/** 初筛：按 大小 + 时长桶 分组，只返回 >1 条的同组 */
function groupBySizeAndDuration (tracks) {
  const buckets = new Map()
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || !track.path) continue
    const size = Number(track.size) || 0
    if (!size) continue
    const key = `${size}|${durationBucket(track.duration)}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(track)
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, tracks: list }))
}

/** 内容指纹：首 64KB + 末尾 64KB + 大小（读不到文件返回空串） */
async function contentFingerprint (filePath) {
  let handle
  try {
    handle = await fs.promises.open(filePath, 'r')
    const stat = await handle.stat()
    const size = stat.size
    const head = Buffer.alloc(Math.min(SAMPLE, size))
    const tail = Buffer.alloc(Math.min(SAMPLE, size))
    if (head.length) await handle.read(head, 0, head.length, 0)
    if (tail.length) await handle.read(tail, 0, tail.length, Math.max(0, size - tail.length))
    return crypto.createHash('sha1').update(head).update(tail).update(String(size)).digest('hex')
  } catch {
    return ''
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

/** 同艺人 + 同标题 的"可能重复"（大小不同也算，用于不同码率的同一首歌） */
function likelyGroups (tracks) {
  const buckets = new Map()
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || !track.path) continue
    const title = String(track.title || '').trim().toLowerCase()
    const artist = String(track.artist || '').trim().toLowerCase()
    if (!title) continue
    const key = `${artist}|${title}|${durationBucket(track.duration)}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(track)
  }
  return [...buckets.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, tracks: list }))
}

/**
 * 完整扫描。
 *
 * @param {Array} tracks 曲目列表
 * @param {{ fingerprint?: (filePath: string) => Promise<string> }} [options] 自检可注入假指纹
 * @returns {Promise<{ exact: Array, likely: Array, scanned: number, hashed: number }>}
 */
async function scan (tracks, options = {}) {
  const list = Array.isArray(tracks) ? tracks : []
  const fingerprint = typeof options.fingerprint === 'function' ? options.fingerprint : contentFingerprint
  const exact = []
  const exactPaths = new Set()
  let hashed = 0

  for (const group of groupBySizeAndDuration(list)) {
    /* 同组内按指纹再分一次 */
    const byHash = new Map()
    for (const track of group.tracks) {
      hashed++
      const digest = await fingerprint(track.path)
      if (!digest) continue
      if (!byHash.has(digest)) byHash.set(digest, [])
      byHash.get(digest).push(track)
    }
    for (const [digest, same] of byHash.entries()) {
      if (same.length < 2) continue
      for (const track of same) exactPaths.add(track.path)
      exact.push({
        key: digest,
        size: Number(same[0].size) || 0,
        duration: Number(same[0].duration) || 0,
        tracks: same.map((track) => ({ id: track.id, path: track.path, title: track.title, artist: track.artist }))
      })
    }
  }

  /* 可能重复：同艺人+标题+时长接近，但**没被算进完全重复**的 */
  const likely = []
  for (const group of likelyGroups(list)) {
    const remaining = group.tracks.filter((track) => !exactPaths.has(track.path))
    if (remaining.length < 2) continue
    likely.push({
      key: group.key,
      tracks: remaining.map((track) => ({
        id: track.id,
        path: track.path,
        title: track.title,
        artist: track.artist,
        size: Number(track.size) || 0,
        bitrate: Number(track.bitrate) || 0
      }))
    })
  }

  return { exact, likely, scanned: list.length, hashed }
}

module.exports = { scan, groupBySizeAndDuration, likelyGroups, contentFingerprint, durationBucket, SAMPLE }
