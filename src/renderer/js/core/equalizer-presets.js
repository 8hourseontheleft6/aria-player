/**
 * 均衡器预设数据。
 *
 * 来源：`docs/equalizer-data.json`（用户提供的声音均衡器参数，原始文件原样入库）。
 * 烘进代码是为了让应用不依赖运行时读取外部文件；数值保持原样，
 * 只挑出**能在 Web Audio 里如实实现**的部分。
 *
 * 已实现：EQ 十段（PeakingFilter）、压缩器（DynamicsCompressor）、饱和（WaveShaper）、
 *         混响（用程序生成的脉冲响应做 Convolver，见 equalizer.js）、声场宽度（M/S）、
 *         低频增强（近似为低架滤波）。
 * 未实现（数据里有，但这版不做，避免「看起来有其实没有」）：
 *         · loudnessNormalization.targetLUFS —— 需要 ITU-R BS.1770 响度表，另开一版；
 *         · multibandCompression / parallelCompression —— 需要多路分频，收益小；
 *         · globalSettings.hrirPath / enableCrossfeed —— 需要真实 HRIR 数据
 *           （数据里那个路径本来就是占位符）；
 *         · convolution 混响用的 irFile（hall_medium.wav 等）—— 文件不存在，
 *           改成按 decay / preDelay / damping 现场生成等价的噪声脉冲响应。
 */

/** 十段频率，四组预设共用 */
export const BAND_FREQUENCIES = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

/** 原声：全平，作为默认与「关闭自动」时的落点 */
export const FLAT_PRESET = {
  key: 'flat',
  displayName: '原声（不处理）',
  eq: BAND_FREQUENCIES.map((freq) => ({ freq, gain: 0, q: 0.707 })),
  compressor: null,
  reverb: null,
  stereoWidth: null,
  saturation: null,
  bass: null
}

export const PRESETS = {
  flat: FLAT_PRESET,

  classical: {
    key: 'classical',
    displayName: '古典 / 交响',
    eq: [
      { freq: 31, gain: 1.0, q: 0.707 },
      { freq: 63, gain: 0.5, q: 0.707 },
      { freq: 125, gain: 0.0, q: 0.707 },
      { freq: 250, gain: 0.0, q: 0.707 },
      { freq: 500, gain: 0.0, q: 0.707 },
      { freq: 1000, gain: 0.0, q: 0.707 },
      { freq: 2000, gain: -1.0, q: 0.707 },
      { freq: 4000, gain: -1.5, q: 0.707 },
      { freq: 8000, gain: -2.0, q: 0.707 },
      { freq: 16000, gain: -3.0, q: 0.707 }
    ],
    compressor: { threshold: -24, ratio: 1.5, attack: 0.005, release: 0.05, makeupGain: 0 },
    // 大厅：0.18 的湿度 + 1.0s 衰减（数据里的 hall_medium + mix 0.18）
    reverb: { mix: 0.18, decay: 1.0, preDelay: 0.02, damping: 0.35 },
    // lowCutoff 150：150Hz 以下不加宽（低频保持居中，避免单声道兼容问题）
    stereoWidth: { lowCutoff: 150, width: 0.08 },
    saturation: null,
    bass: null
  },

  rock: {
    key: 'rock',
    displayName: '摇滚 / 金属',
    eq: [
      { freq: 31, gain: 4.0, q: 0.707 },
      { freq: 63, gain: 5.0, q: 0.700 },
      { freq: 125, gain: 3.0, q: 0.600 },
      { freq: 250, gain: 1.0, q: 0.650 },
      { freq: 500, gain: -2.0, q: 0.750 },
      { freq: 1000, gain: -1.0, q: 0.720 },
      { freq: 2000, gain: 1.0, q: 0.680 },
      { freq: 4000, gain: 3.0, q: 0.660 },
      { freq: 8000, gain: 4.0, q: 0.640 },
      { freq: 16000, gain: 5.0, q: 0.620 }
    ],
    compressor: { threshold: -22, ratio: 4.0, attack: 0.002, release: 0.04, makeupGain: 2 },
    reverb: { mix: 0.14, decay: 0.65, preDelay: 0.012, damping: 0.5 },
    stereoWidth: { lowCutoff: 180, width: 0.45 },
    saturation: { drive: 0.06, type: 'soft_clip' },
    bass: null
  },

  pop: {
    key: 'pop',
    displayName: '流行 / 人声',
    eq: [
      { freq: 31, gain: 3.0, q: 0.710 },
      { freq: 63, gain: 3.5, q: 0.690 },
      { freq: 125, gain: 2.0, q: 0.670 },
      { freq: 250, gain: 1.0, q: 0.730 },
      { freq: 500, gain: 0.5, q: 0.740 },
      { freq: 1000, gain: 1.5, q: 0.760 },
      { freq: 2000, gain: 2.0, q: 0.780 },
      { freq: 4000, gain: 1.5, q: 0.770 },
      { freq: 8000, gain: 1.0, q: 0.790 },
      { freq: 16000, gain: 0.5, q: 0.810 }
    ],
    compressor: { threshold: -26, ratio: 2.5, attack: 0.003, release: 0.07, makeupGain: 1 },
    // 数据里 pop 用的是 algorithmic 混响：size 0.55 / preDelay 25ms / mix 0.17 / damping 0.42
    reverb: { mix: 0.17, decay: 0.9, preDelay: 0.025, damping: 0.42 },
    stereoWidth: { lowCutoff: 130, width: 0.32 },
    saturation: null,
    bass: null
  },

  electronic: {
    key: 'electronic',
    displayName: '电子 / 舞曲',
    eq: [
      { freq: 31, gain: 5.0, q: 0.550 },
      { freq: 63, gain: 6.0, q: 0.530 },
      { freq: 125, gain: 4.0, q: 0.580 },
      { freq: 250, gain: 1.0, q: 0.610 },
      { freq: 500, gain: -1.0, q: 0.630 },
      { freq: 1000, gain: 0.0, q: 0.590 },
      { freq: 2000, gain: 1.0, q: 0.570 },
      { freq: 4000, gain: 2.0, q: 0.560 },
      { freq: 8000, gain: 3.0, q: 0.540 },
      { freq: 16000, gain: 4.0, q: 0.520 }
    ],
    compressor: { threshold: -20, ratio: 5.0, attack: 0.001, release: 0.03, makeupGain: 3 },
    reverb: { mix: 0.38, decay: 1.2, preDelay: 0.03, damping: 0.3 },
    stereoWidth: { lowCutoff: 110, width: 0.75 },
    saturation: { drive: 0.04, type: 'tube' },
    // dynamicBassEnhancement：subHarmonicMix 0.07 / lowpassFreq 90
    // 次谐波合成太玄学，这里近似成 90Hz 处的低架提升
    bass: { freq: 90, gain: 1.4 }
  }
}

export const PRESET_KEYS = ['flat', 'classical', 'rock', 'pop', 'electronic']

/*
 * 自动匹配：按流派（以及标题 / 专辑里的线索）挑一组预设。
 *
 * 关键词给中英文两套 —— 资料库里的流派字段两种写法都有。
 * 顺序即优先级：越具体的风格排越前面（metal 比 rock 具体，edm 比 electronic 具体）。
 */
const RULES = [
  { key: 'electronic', words: ['electronic', 'electronica', 'edm', 'dance', 'house', 'techno', 'trance', 'dubstep', 'dnb', 'drum and bass', 'synth', 'electro', '电子', '舞曲', '電音', '电音', '浩室', '迷幻'] },
  { key: 'rock', words: ['rock', 'metal', 'punk', 'grunge', 'hardcore', 'emo', 'alternative', 'indie rock', 'post-rock', '摇滚', '搖滾', '金属', '金屬', '朋克', '硬核', '后摇'] },
  { key: 'classical', words: ['classical', 'orchestra', 'orchestral', 'symphony', 'chamber', 'baroque', 'romantic', 'opera', 'piano', 'instrumental', 'soundtrack', 'score', '古典', '交响', '交響', '管弦', '室内乐', '巴洛克', '歌剧', '钢琴', '原声', '配乐', '轻音乐'] },
  { key: 'pop', words: ['pop', 'vocal', 'idol', 'k-pop', 'j-pop', 'ballad', 'acoustic', 'folk', 'country', 'r&b', 'rnb', 'soul', 'hip hop', 'hip-hop', 'rap', 'jazz', '流行', '人声', '民谣', '乡村', '爵士', '说唱', '情歌', '抒情'] }
]

/**
 * 按曲目挑预设。
 * @param {object|null} track 需要 genre 字段（元数据里读到的风格），缺失时返回 null
 * @returns {string|null} 预设 key；没有线索返回 null（调用方保持当前预设）
 */
export function matchPreset (track) {
  if (!track) return null
  const fields = [track.genre, track.title, track.album, track.artist]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (!fields.trim()) return null

  for (const rule of RULES) {
    if (rule.words.some((word) => fields.includes(word))) return rule.key
  }
  return null
}

/** 给设置页用的选项列表 */
export function presetOptions () {
  return PRESET_KEYS.map((key) => ({ value: key, label: PRESETS[key].displayName }))
}
