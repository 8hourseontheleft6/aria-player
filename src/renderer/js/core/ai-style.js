/**
 * 用外部模型判断风格（可选，用户自填 API）。
 *
 * 定位：本地特征分析已经能给出一个不错的答案（见 style-analyzer.js），
 * 这一步是**锦上添花**——把歌曲信息 + 本地算出的三个特征一起发给模型，
 * 让它在这四组预设里挑一个最合适的。之所以值得，是因为它能用上本地算不出的东西：
 * 歌名/专辑/艺人里的风格线索、以及「低音重但其实是民谣」这类常识。
 *
 * 边界（重要）：
 *   · **音频文件不上传**，只发文本（曲目信息 + 三个数字）；
 *   · 模型必须从固定列表里选一个，返回不是合法值就整体作废，保持本地判断；
 *   · 结果按曲目缓存，一首歌只问一次；失败静默回退（不打断播放、不弹错误）。
 */

import { remote } from './remote.js'
import { PRESET_KEYS, PRESETS } from './equalizer-presets.js'

const CACHE_LIMIT = 300
/** trackId → preset key | null（null = 问过了但没用） */
const cache = new Map()

const SYSTEM_PROMPT = [
  '你是音乐风格分类器。用户会给你一首歌的信息和它的音频特征，',
  '你必须在给定的均衡器预设里挑一个最合适的，并且只输出 JSON。',
  '可用预设与含义：',
  ...PRESET_KEYS.map((key) => `- ${key}: ${PRESETS[key].displayName}`),
  '输出格式严格为：{"preset":"<key>","confidence":0~1,"reason":"<20 字以内>"}',
  '不要输出任何其它文字或代码块标记。'
].join('\n')

/** 从模型回复里抠出 JSON（模型偶尔会包一层 ```json） */
export function parseAnswer (content) {
  if (typeof content !== 'string') return null
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(content.slice(start, end + 1))
    if (!PRESET_KEYS.includes(parsed.preset)) return null
    const confidence = Number(parsed.confidence)
    return {
      key: parsed.preset,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 40) : ''
    }
  } catch {
    return null
  }
}

/**
 * 问一次外部模型。
 * @param {object} options { track, features }
 * @returns {Promise<{key,confidence,reason}|null>}
 */
export async function classifyWithAi ({ track, features }) {
  if (!track?.id) return null
  if (cache.has(track.id)) return cache.get(track.id)

  const payload = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          title: track.title || '',
          artist: track.artist || '',
          album: track.album || '',
          genre: track.genre || '',
          year: track.year || null,
          features: features
            ? {
                bassRatio: Number(features.bassRatio?.toFixed(3)),
                zeroCrossingRate: Math.round(features.zcr || 0),
                crestFactor: Number(features.crest?.toFixed(2))
              }
            : null
        })
      }
    ],
    temperature: 0,
    maxTokens: 120
  }

  let result = null
  try {
    const response = await remote.ai.chat(payload)
    if (response?.ok) result = parseAnswer(response.content)
  } catch {
    result = null
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  cache.set(track.id, result)
  return result
}

export function cachedAiStyle (trackId) {
  return cache.get(trackId) || null
}

export function clearAiCache () {
  cache.clear()
}

/** 只做一次连通性测试（设置页用） */
export function testAi () {
  return remote.ai.test()
}
