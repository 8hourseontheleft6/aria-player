/**
 * 声音均衡器：Web Audio 滤镜链。
 *
 * 链路（全部串在 audio 元素与 destination 之间）：
 *   input → 10×Peaking → 低频架 → 压缩器 → 补偿增益 → 饱和 → M/S 声场 → 干/湿混响 → output
 *
 * 设计取舍：
 *  · 所有节点**一次建好**，切换预设只改参数 —— 重建整条链会有一瞬间的爆音；
 *  · 混响的脉冲响应是**程序生成**的（指数衰减的噪声 + 前置延迟 + 阻尼低通），
 *    因为 data.json 里的 irFile（hall_medium.wav 等）并不存在；
 *  · 关闭均衡器 = 把所有参数归零（EQ 全 0、干声 100%、压缩与饱和旁路），
 *    而不是拆掉节点 —— 拆链同样会爆音，而且媒体元素只能 createMediaElementSource 一次。
 */

import { PRESETS, BAND_FREQUENCIES, FLAT_PRESET } from './equalizer-presets.js'

/** 软削波曲线：drive 0→几乎线性，1→明显圆润 */
function makeCurve (drive) {
  const amount = Math.max(0.0001, Math.min(1, drive))
  const k = amount * 40
  const samples = 2048
  const curve = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1
    curve[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  return curve
}

/** 生成混响脉冲响应：前置延迟 + 指数衰减噪声 + 阻尼 */
function makeImpulse (context, { decay = 1, preDelay = 0.02, damping = 0.4 } = {}) {
  const rate = context.sampleRate
  const length = Math.max(1, Math.floor(rate * Math.max(0.05, decay)))
  const delay = Math.max(0, Math.floor(rate * preDelay))
  const buffer = context.createBuffer(2, length + delay, rate)
  // 阻尼越高，高频衰减越快：给噪声做一个一阶低通
  const cutoff = 1 - Math.max(0, Math.min(0.95, damping))
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    let last = 0
    for (let i = 0; i < length; i++) {
      const noise = Math.random() * 2 - 1
      last = last + cutoff * (noise - last)
      data[delay + i] = last * Math.pow(1 - i / length, 2.6)
    }
  }
  return buffer
}

/**
 * @param {AudioContext} context
 * @returns {object} 均衡器实例
 */
export function createEqualizer (context) {
  const input = context.createGain()
  const output = context.createGain()

  /* ---------- 十段 EQ ---------- */
  const bands = BAND_FREQUENCIES.map((freq) => {
    const filter = context.createBiquadFilter()
    filter.type = 'peaking'
    filter.frequency.value = freq
    filter.Q.value = 0.707
    filter.gain.value = 0
    return filter
  })

  /* ---------- 低频增强（近似 data.json 的 dynamicBassEnhancement） ---------- */
  const bass = context.createBiquadFilter()
  bass.type = 'lowshelf'
  bass.frequency.value = 90
  bass.gain.value = 0

  /* ---------- 压缩器 + 补偿增益 ---------- */
  const compressor = context.createDynamicsCompressor()
  compressor.threshold.value = 0
  compressor.ratio.value = 1
  compressor.attack.value = 0.003
  compressor.release.value = 0.25
  compressor.knee.value = 24
  // 数据是「阈值 -24dB 且 ratio 1.5」这种温和设置，这里给一点点软拐点
  compressor.knee.value = 12
  const makeup = context.createGain()

  /* ---------- 饱和 ---------- */
  const shaper = context.createWaveShaper()
  shaper.oversample = '2x'
  shaper.curve = null

  /* ---------- 声场宽度（M/S，低频保持居中） ---------- */
  const splitter = context.createChannelSplitter(2)
  const midSum = context.createGain()
  midSum.gain.value = 0.5
  const negRight = context.createGain()
  negRight.gain.value = -1
  const sideSum = context.createGain()
  sideSum.gain.value = 0.5
  const sideHigh = context.createBiquadFilter()
  sideHigh.type = 'highpass'
  sideHigh.frequency.value = 130
  const sideLeft = context.createGain()
  const sideRight = context.createGain()
  const merger = context.createChannelMerger(2)

  /* ---------- 混响（干/湿） ---------- */
  const dry = context.createGain()
  const wet = context.createGain()
  const convolver = context.createConvolver()
  wet.gain.value = 0

  /* ---------- 串起来 ---------- */
  let node = input
  const chain = [input, ...bands, bass, compressor, makeup, shaper]
  for (const next of chain.slice(1)) {
    node.connect(next)
    node = next
  }
  // 压缩器到补偿增益（旁路时两者都是透明设置）
  node.connect(splitter)
  splitter.connect(midSum, 0)
  splitter.connect(midSum, 1)
  splitter.connect(negRight, 1)
  const leftTap = context.createGain()
  splitter.connect(leftTap, 0)
  leftTap.connect(sideSum)
  negRight.connect(sideSum)
  sideSum.connect(sideHigh)
  sideHigh.connect(sideLeft)
  sideHigh.connect(sideRight)
  midSum.connect(merger, 0, 0)
  midSum.connect(merger, 0, 1)
  sideLeft.connect(merger, 0, 0)
  sideRight.connect(merger, 0, 1)

  // 干湿汇合
  merger.connect(dry)
  merger.connect(convolver)
  convolver.connect(wet)
  dry.connect(output)
  wet.connect(output)

  /** 当前生效的预设 key（用于调试与自检） */
  let currentKey = FLAT_PRESET.key

  /**
   * 应用一组预设。enabled=false 时把所有参数归零（透明）。
   * @param {string} key 预设 key
   * @param {object} options { enabled }
   */
  function apply (key, { enabled = true } = {}) {
    const preset = enabled ? (PRESETS[key] || FLAT_PRESET) : FLAT_PRESET
    currentKey = enabled ? preset.key : 'off'
    const now = context.currentTime
    const ramp = 0.06 // 参数滑动，避免切换时爆音

    preset.eq.forEach((band, index) => {
      const filter = bands[index]
      if (!filter) return
      filter.frequency.setTargetAtTime(band.freq, now, 0.01)
      filter.Q.setTargetAtTime(band.q ?? 0.707, now, 0.01)
      filter.gain.setTargetAtTime(band.gain ?? 0, now, ramp / 3)
    })

    bass.gain.setTargetAtTime(preset.bass?.gain ?? 0, now, ramp / 3)
    if (preset.bass?.freq) bass.frequency.setTargetAtTime(preset.bass.freq, now, 0.01)

    const comp = preset.compressor
    compressor.threshold.setTargetAtTime(comp ? comp.threshold : 0, now, ramp / 3)
    compressor.ratio.setTargetAtTime(comp ? comp.ratio : 1, now, ramp / 3)
    compressor.attack.setTargetAtTime(comp ? comp.attack : 0.003, now, 0.01)
    compressor.release.setTargetAtTime(comp ? comp.release : 0.25, now, 0.01)
    makeup.gain.setTargetAtTime(comp ? Math.pow(10, (comp.makeupGain || 0) / 20) : 1, now, ramp / 3)

    const sat = preset.saturation
    shaper.curve = sat && sat.drive > 0 ? makeCurve(sat.drive) : null

    const width = preset.stereoWidth?.width ?? 0
    sideLeft.gain.setTargetAtTime(width, now, ramp / 3)
    sideRight.gain.setTargetAtTime(-width, now, ramp / 3)
    if (preset.stereoWidth?.lowCutoff) {
      sideHigh.frequency.setTargetAtTime(preset.stereoWidth.lowCutoff, now, 0.02)
    }

    const reverb = preset.reverb
    if (reverb && reverb.mix > 0) {
      convolver.buffer = makeImpulse(context, reverb)
      const mix = Math.min(0.6, reverb.mix)
      wet.gain.setTargetAtTime(mix, now, ramp)
      dry.gain.setTargetAtTime(1 - mix * 0.35, now, ramp)
    } else {
      wet.gain.setTargetAtTime(0, now, ramp)
      dry.gain.setTargetAtTime(1, now, ramp)
    }
  }

  apply(FLAT_PRESET.key, { enabled: false })

  return {
    input,
    output,
    apply,
    get presetKey () { return currentKey },
    /** 给设置页 / 自检看的实时参数 */
    snapshot () {
      return {
        preset: currentKey,
        bands: bands.map((filter) => ({
          freq: Math.round(filter.frequency.value),
          gain: Math.round(filter.gain.value * 10) / 10,
          q: Math.round(filter.Q.value * 1000) / 1000
        })),
        bassGain: Math.round(bass.gain.value * 10) / 10,
        compressor: {
          threshold: Math.round(compressor.threshold.value * 10) / 10,
          ratio: Math.round(compressor.ratio.value * 10) / 10
        },
        wet: Math.round(wet.gain.value * 100) / 100,
        sideWidth: Math.round(sideLeft.gain.value * 100) / 100,
        saturation: shaper.curve ? 'on' : 'off'
      }
    }
  }
}
