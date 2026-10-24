'use strict'

/**
 * 设置的导出 / 导入。
 *
 * 三条硬要求（都有自检）：
 *  1. 导出默认**不含** AI key —— 只写 `ai.hasKey: true`，需要时显式选「包含密钥」；
 *  2. 导入前先校验：不是对象、缺字段、字段类型不对、版本太新 —— 一律拒绝，
 *     **绝不覆盖现有设置**（调用方只有在拿到 ok 的时候才 set）；
 *  3. 旧版本文件能迁移：没有 `version` 的当成 0，缺的键用默认值补齐，多余的键丢掉。
 *
 * 文件格式：
 *   { "kind": "aria-settings", "version": 1, "exportedAt": "...", "app": "0.2.0-beta.1",
 *     "settings": { ... }, "includesKey": false }
 */

const { DEFAULTS, publicSettings } = require('./settings')

const KIND = 'aria-settings'
const VERSION = 1
/** 比这个更新的文件不认识 —— 拒绝，免得把新字段冲掉 */
const MAX_VERSION = 1

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** 深合并：以 base 为骨架，patch 里类型对得上的才覆盖（类型不对就忽略） */
function mergeTyped (base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in base)) continue
    const expected = base[key]
    if (isPlainObject(expected)) {
      if (isPlainObject(value)) out[key] = mergeTyped(expected, value)
      continue
    }
    if (Array.isArray(expected)) {
      if (Array.isArray(value)) out[key] = value
      continue
    }
    if (typeof expected === typeof value && value !== null) out[key] = value
  }
  return out
}

/**
 * 导出：默认脱敏。
 * @param {object} settings 当前设置（含密钥）
 * @param {{ includeKey?: boolean, appVersion?: string }} options
 */
function buildExport (settings, { includeKey = false, appVersion = '' } = {}) {
  const base = JSON.parse(JSON.stringify(settings || {}))
  let includesKey = false
  if (isPlainObject(base.ai)) {
    if (includeKey && base.ai.key) includesKey = true
    if (!includeKey) {
      delete base.ai.key
      base.ai.hasKey = Boolean(settings.ai && settings.ai.key)
    }
  }
  return {
    kind: KIND,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    app: String(appVersion || ''),
    includesKey,
    settings: base
  }
}

/**
 * 导入：校验 + 迁移。
 * @param {string} text 文件内容
 * @returns {{ ok: true, settings: object, migratedFrom: number, includesKey: boolean } |
 *           { ok: false, code: string, message: string }}
 */
function parseImport (text) {
  let parsed
  try {
    parsed = JSON.parse(String(text || ''))
  } catch {
    return { ok: false, code: 'bad-json', message: '不是有效的 JSON 文件' }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, code: 'not-object', message: '文件内容必须是一个对象' }
  }
  /* 没有 kind 的老文件：只要它看起来像设置（有 volume 之类）就当成 v0 */
  const looksLikeRawSettings = parsed.kind !== KIND && (
    'volume' in parsed || 'theme' in parsed || 'equalizer' in parsed || 'folders' in parsed
  )
  if (parsed.kind !== KIND && !looksLikeRawSettings) {
    return { ok: false, code: 'wrong-kind', message: '这不是 Aria 的设置文件' }
  }
  const source = looksLikeRawSettings ? parsed : parsed.settings
  if (!isPlainObject(source)) {
    return { ok: false, code: 'no-settings', message: '文件里没有 settings 对象' }
  }
  const fileVersion = Number(looksLikeRawSettings ? 0 : parsed.version)
  if (Number.isFinite(fileVersion) && fileVersion > MAX_VERSION) {
    return {
      ok: false,
      code: 'too-new',
      message: `这个文件来自更新的版本（v${fileVersion}），当前只认到 v${MAX_VERSION}`
    }
  }
  /* 迁移骨架：v0（裸设置）→ v1 只是"补默认值 + 丢掉不认识/类型不对的键" */
  const merged = mergeTyped(DEFAULTS, source)
  /*
   * hasKey 是只读状态，不能写回设置；导入时如果文件里只有 hasKey 没有 key，
   * 把当前已有的 key 保住（用户导入设置不该把自己的密钥清掉）。
   */
  delete merged.ai?.hasKey
  return {
    ok: true,
    settings: merged,
    migratedFrom: Number.isFinite(fileVersion) ? fileVersion : 0,
    includesKey: Boolean(source.ai && typeof source.ai.key === 'string' && source.ai.key.length > 0)
  }
}

/** 导入时要不要把已有的密钥保留下来（文件里没带 key 的时候） */
function keepExistingKey (next, current) {
  if (!isPlainObject(next.ai) || !isPlainObject(current.ai)) return next
  if (next.ai.key) return next
  if (current.ai.key) next.ai.key = current.ai.key
  return next
}

/** 给人看的摘要（导入确认与提示用） */
function summarise (result, current) {
  if (!result || !result.ok) return result
  const changes = []
  const before = publicSettings(current)
  const after = publicSettings(result.settings)
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes.push(key)
  }
  return {
    ...result,
    changed: changes,
    from: result.migratedFrom === VERSION ? `v${VERSION}` : `v${result.migratedFrom}（已迁移）`
  }
}

module.exports = {
  buildExport,
  parseImport,
  keepExistingKey,
  summarise,
  mergeTyped,
  KIND,
  VERSION,
  MAX_VERSION
}
