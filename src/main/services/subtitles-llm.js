'use strict'

/**
 * AI 字幕的**文本后处理**纯函数层（阶段 A 校正 / 阶段 B 翻译）。
 *
 * 这里只做四件事，全部可单测、不碰网络也不碰磁盘：
 *   ① 分批（每批 ≤40 行，行号用**全局下标**，方便回填）；
 *   ② 拼 prompt（带歌名/艺人/专辑作为上下文；约束写死）；
 *   ③ 解析模型返回的 JSON（容忍 ```json 围栏、前后废话）；
 *   ④ **索引严格校验**：返回的 i 集合必须与输入完全一致，否则整批丢弃。
 *
 * 校验为什么这么严：模型最爱干的事是"顺手合并两行""漏掉一行""多给一行"。
 * 一旦按顺序硬套回填，整段歌词就会错位 —— 那比不校正更糟。宁可整批丢。
 */

const PROMPT_VERSION = 'llm-v1'
const BATCH_SIZE = 40

/** 把行切成批，元素是 { i, text }，i 是**整首歌里的下标** */
function batchLines (lines, size = BATCH_SIZE) {
  const list = Array.isArray(lines) ? lines : []
  const width = Number.isFinite(size) && size > 0 ? Math.floor(size) : BATCH_SIZE
  const batches = []
  for (let start = 0; start < list.length; start += width) {
    const slice = []
    for (let i = start; i < Math.min(start + width, list.length); i++) {
      slice.push({ i, text: String(list[i] == null ? '' : list[i]) })
    }
    if (slice.length) batches.push(slice)
  }
  return batches
}

/** 从模型输出里抠出第一个 JSON 数组（容忍 ```json 围栏与前后废话） */
function extractJsonArray (raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (!text) return null
  /* 去围栏 */
  text = text.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) return null
  const body = text.slice(start, end + 1)
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 严格校验：索引集合与输入完全一致，且每条都有对应字段（非空字符串）。
 * @param {unknown} items extractJsonArray 的结果
 * @param {number[]} expected 输入批次的 i 列表
 * @param {string} field 'text' | 'translation'
 */
function validateIndexed (items, expected, field) {
  if (!Array.isArray(items)) return { ok: false, reason: 'not-array' }
  const wanted = new Set((Array.isArray(expected) ? expected : []).map(Number))
  const seen = new Set()
  const out = []
  for (const item of items) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'bad-item' }
    const index = Number(item.i)
    if (!Number.isInteger(index)) return { ok: false, reason: 'bad-index' }
    if (!wanted.has(index)) return { ok: false, reason: 'extra-index' }
    if (seen.has(index)) return { ok: false, reason: 'duplicate-index' }
    const value = item[field]
    if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'empty-' + field }
    seen.add(index)
    out.push({ i: index, value: value.trim() })
  }
  if (seen.size !== wanted.size) return { ok: false, reason: 'missing-index' }
  return { ok: true, items: out.sort((a, b) => a.i - b.i) }
}

/** 缓存键：sha1(原文 + 模型 + prompt 版本) —— 三者任一变化都要失效 */
function cacheKeyOf ({ text, model, promptVersion = PROMPT_VERSION }) {
  const crypto = require('node:crypto')
  return crypto.createHash('sha1')
    .update(String(text == null ? '' : text))
    .update('\u0000')
    .update(String(model == null ? '' : model))
    .update('\u0000')
    .update(String(promptVersion))
    .digest('hex')
}

function contextLine (meta) {
  if (!meta) return ''
  const parts = []
  if (meta.title) parts.push(`歌名：${meta.title}`)
  if (meta.artist) parts.push(`艺人：${meta.artist}`)
  if (meta.album) parts.push(`专辑：${meta.album}`)
  return parts.join('；')
}

/** 校正的 system prompt：只修字面错误，不许动意思 */
function correctionSystemPrompt () {
  return [
    '你是歌词校对员。输入是语音识别出来的歌词行，编号从 i 开始。',
    '只允许修：同音字、明显的漏字/多字、断句位置、标点。',
    '不允许：增删行、改行号、改写意思、润色措辞、翻译、合并或拆分句子。',
    '拿不准就原样保留（text 与原文完全一致）。',
    '输出必须是**严格 JSON 数组**，不要任何解释、不要 markdown 围栏。',
    '每个元素形如 {"i": 行号, "text": "校正后文本"}，i 必须与输入一一对应、数量完全一致。'
  ].join('\n')
}

function translationSystemPrompt (language) {
  const target = String(language || '').trim() || '简体中文'
  return [
    `你是歌词翻译。把每一行翻译成${target}，保持原意与语气，不要合并或拆分行。`,
    '输出必须是**严格 JSON 数组**，不要任何解释、不要 markdown 围栏。',
    '每个元素形如 {"i": 行号, "translation": "译文"}，i 必须与输入一一对应、数量完全一致。'
  ].join('\n')
}

/**
 * 拼 messages。
 * @param {{ mode: 'correct'|'translate', lines: string[], meta?: object, language?: string }} input
 */
function buildMessages ({ mode, lines, meta, language }) {
  const batches = batchLines(lines)
  const context = contextLine(meta)
  return batches.map((batch) => {
    const system = mode === 'translate'
      ? translationSystemPrompt(language)
      : correctionSystemPrompt()
    const user = [
      context ? `上下文：${context}` : '',
      mode === 'translate' ? '把下面每一行翻译成目标语言：' : '校对下面每一行：',
      JSON.stringify(batch)
    ].filter(Boolean).join('\n')
    return { system, user, batch }
  })
}

/** 把校正结果回填到行文本（不改行数） */
function applyCorrections (lines, items) {
  const list = (Array.isArray(lines) ? lines : []).map((line) => ({ ...line }))
  for (const item of Array.isArray(items) ? items : []) {
    const target = list[item.i]
    if (target) target.text = item.value
  }
  return list
}

/** 把译文回填到 line.translation */
function applyTranslations (lines, items) {
  const list = (Array.isArray(lines) ? lines : []).map((line) => ({ ...line }))
  for (const item of Array.isArray(items) ? items : []) {
    const target = list[item.i]
    if (target) target.translation = item.value
  }
  return list
}

/** 页面徽章文案：校正/翻译成功与否决定降级 */
function badgeOf ({ corrected, translated }) {
  if (translated) return 'AI · 本地 · 翻译'
  if (corrected) return 'AI · 校正'
  return 'AI · 本地'
}

module.exports = {
  PROMPT_VERSION,
  BATCH_SIZE,
  batchLines,
  extractJsonArray,
  validateIndexed,
  cacheKeyOf,
  buildMessages,
  applyCorrections,
  applyTranslations,
  badgeOf,
  correctionSystemPrompt,
  translationSystemPrompt
}
