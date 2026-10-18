'use strict'

/**
 * 「AI 字幕（本地）」的常量表与**纯函数**。
 *
 * 为什么单独一个文件：URL / 文件大小 / SHA256 这三样是"一旦写错就会下载到坏模型"的东西，
 * 必须放在一处、可被自检直接读；而下面的小函数（URL 拼接、缓存键、字节格式化）是纯的，
 * 单元测试不需要起窗口、不需要网络。
 *
 * 许可与来源（下载前 UI 要展示）：
 *   · 运行时 sherpa-onnx（Apache-2.0）
 *   · 模型 SenseVoice-small（FunASR / SenseVoice，见 HF 仓库卡片；模型**不随包分发**）
 *   · VAD silero_vad.onnx（k2-fsa/sherpa-onnx release 里的 silero VAD 模型）
 */

/** 下载源：默认 HuggingFace，备用 hf-mirror（国内可达性好）。 */
const SOURCES = {
  huggingface: {
    id: 'huggingface',
    label: 'HuggingFace',
    base: 'https://huggingface.co',
    repo: '/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main',
    vadBase: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'
  },
  'hf-mirror': {
    id: 'hf-mirror',
    label: 'hf-mirror.com（备用）',
    base: 'https://hf-mirror.com',
    repo: '/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main',
    vadBase: 'https://hf-mirror.com/k2-fsa/sherpa-onnx/releases/download/asr-models'
  }
}

/*
 * 三个文件的大小与 SHA256 都是**实测真值**（本次 spike 逐个下载核对过），不是抄的：
 *   model.int8.onnx 239,233,841 B / tokens.txt 315,894 B / silero_vad.onnx 643,854 B
 * 校验失败就删掉重下，绝不让半个坏模型进入 ready 状态。
 */
const MODEL_FILES = [
  {
    id: 'senseVoice',
    name: 'model.int8.onnx',
    dir: 'sense-voice',
    kind: 'model',
    bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'
  },
  {
    id: 'tokens',
    name: 'tokens.txt',
    dir: 'sense-voice',
    kind: 'model',
    bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'
  },
  {
    id: 'vad',
    name: 'silero_vad.onnx',
    dir: 'sense-voice',
    kind: 'vad',
    bytes: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
  }
]

/** 下载模型时至少还要留这么多余量，否则报"磁盘不足"（避免下到一半写满）。 */
const DISK_SLACK_BYTES = 64 * 1024 * 1024

const CACHE_LIMIT_ENTRIES = 200
const CACHE_LIMIT_BYTES = 20 * 1024 * 1024

function sourceById (id) {
  return SOURCES[id] || SOURCES.huggingface
}

/** 拼某个文件的下载地址：模型走仓库路径，VAD 走 release 路径。 */
function fileUrl (sourceId, file) {
  const source = sourceById(sourceId)
  if (file.kind === 'vad') return `${source.vadBase}/${file.name}`
  return `${source.base}${source.repo}/${file.name}`
}

/** 人类可读的体积（1024 进制，和系统里显示的一致）。 */
function formatBytes (bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index++
  }
  return `${size >= 100 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
}

/**
 * 缓存键：`sha1(路径 + mtime + 模型指纹)`。
 *
 * 三个都要进：路径区分曲目、mtime 让"文件换了"失效、模型指纹让"换了模型"也失效。
 * 纯函数（crypto 只做哈希，不碰磁盘），可以直接单测。
 */
function cacheKeyOf ({ path, mtime, model }) {
  const crypto = require('node:crypto')
  return crypto.createHash('sha1')
    .update(String(path || ''))
    .update('\u0000')
    .update(String(mtime == null ? '' : mtime))
    .update('\u0000')
    .update(String(model || ''))
    .digest('hex')
}

/** 三个文件加起来多大（用于"下载需要 X MB"的提示与磁盘检查）。 */
function totalModelBytes () {
  return MODEL_FILES.reduce((sum, file) => sum + file.bytes, 0)
}

/** 模型指纹：用来做缓存键的一部分，也用来判断"模型是否换过"。 */
function modelFingerprint () {
  return MODEL_FILES.map((file) => file.sha256.slice(0, 12)).join('-')
}

module.exports = {
  SOURCES,
  MODEL_FILES,
  DISK_SLACK_BYTES,
  CACHE_LIMIT_ENTRIES,
  CACHE_LIMIT_BYTES,
  sourceById,
  fileUrl,
  formatBytes,
  cacheKeyOf,
  totalModelBytes,
  modelFingerprint
}
