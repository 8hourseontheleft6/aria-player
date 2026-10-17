#!/usr/bin/env node
/**
 * 生成自检/试听用的测试夹具（WAV）。
 *
 * 为什么需要它：`tests/` 里那些 wav 是自检跑起来时现造的，`.gitignore` 挡着不进仓库
 * （免得几十 MB 二进制塞进 git 历史）。但新人 clone 下来想手工试「双击音频用播放器打开」
 * 时，手里得有一个能播的文件 —— 这个脚本就是把它们造出来。
 *
 *   node scripts/make-fixtures.mjs      # 或者 npm run fixtures
 *
 * 产物（全部是程序合成的 8kHz 单声道 8bit PCM，几百 KB 以内）：
 *   tests/player-smoke/smoke-open.wav        试听/冷启动用
 *   tests/player-smoke/drop-1..10.wav        拖放用（10 个，噪声音高各不同）
 *   tests/unified-smoke/rule-probe.wav       启动规则探针用
 *
 * 注意：自检本身**不需要**先跑这个 —— smoke.js 在用到时会自己造（用的同一个格式）。
 * 这个脚本只服务于"手工试一遍"和新同学的方便。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE_RATE = 8000

/** 造一个 8kHz/8bit/单声道 PCM 的 WAV：一声正弦，够长到能看见进度条动 */
function makeWav (frequency) {
  const samples = SAMPLE_RATE // 1 秒
  const buffer = Buffer.alloc(44 + samples)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // fmt 块长度
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // 单声道
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE, 28) // byteRate
  buffer.writeUInt16LE(1, 32) // blockAlign
  buffer.writeUInt16LE(8, 34) // 8 bit
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples, 40)
  for (let i = 0; i < samples; i++) {
    buffer[44 + i] = Math.round(128 + 100 * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE))
  }
  return buffer
}

function writeFixture (relativePath, frequency) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, makeWav(frequency))
  return target
}

const created = []
created.push(writeFixture('tests/player-smoke/smoke-open.wav', 440))
for (let index = 1; index <= 10; index++) {
  // 每个拖放文件给不同音高，自检里要区分"十首不同的歌"
  created.push(writeFixture(`tests/player-smoke/drop-${index}.wav`, 300 + index * 40))
}
created.push(writeFixture('tests/unified-smoke/rule-probe.wav', 660))

const total = created.reduce((sum, file) => sum + fs.statSync(file).size, 0)
console.log(`夹具已生成：${created.length} 个文件，共 ${Math.round(total / 1024)} KB`)
for (const file of created) console.log('  ' + path.relative(root, file))
console.log('\n这些文件在 .gitignore 里（不进仓库）。自检本身不需要先跑这一步。')
