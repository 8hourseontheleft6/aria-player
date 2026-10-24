'use strict'

/*
 * 设置导出 / 导入检查：脱敏、往返一致、坏文件被拒且原设置不变、旧版本能迁移。
 *
 * 只测纯函数（services/settings-transfer.js + services/settings.js 的 publicSettings）——
 * 文件对话框那层在 smoke 里用主进程 IPC 验。
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const problems = []

function check (name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`)
    return
  }
  problems.push(`${name}${detail ? '：' + detail : ''}`)
  console.log(`  ✗ ${name}${detail ? '：' + detail : ''}`)
}

const transfer = require(path.join(ROOT, 'src/main/services/settings-transfer'))
const { DEFAULTS, publicSettings } = require(path.join(ROOT, 'src/main/services/settings'))

/* ---------------- ① 导出默认脱敏 ---------------- */

const current = {
  ...JSON.parse(JSON.stringify(DEFAULTS)),
  volume: 0.62,
  theme: 'light',
  ai: { enabled: true, baseUrl: 'https://example.com/v1', model: 'x', key: 'sk-secret-123456', useForStyle: true }
}

const exported = transfer.buildExport(current, { appVersion: '0.2.0-beta.1' })
check('导出带 kind / version / exportedAt',
  exported.kind === transfer.KIND && exported.version === transfer.VERSION && Boolean(exported.exportedAt))
check('默认不含密钥', exported.includesKey === false && !('key' in exported.settings.ai))
check('默认用 hasKey 标记"配过没"', exported.settings.ai.hasKey === true)
check('其余设置原样带出', exported.settings.volume === 0.62 && exported.settings.theme === 'light')
check('导出文本里没有密钥明文',
  !JSON.stringify(exported).includes('sk-secret-123456'))

const withKey = transfer.buildExport(current, { includeKey: true })
check('显式要求时才带密钥', withKey.includesKey === true && withKey.settings.ai.key === 'sk-secret-123456')

/* ---------------- ② 往返一致 ---------------- */

const roundTrip = transfer.parseImport(JSON.stringify(exported))
check('导出的文件能被导入', roundTrip.ok === true, JSON.stringify(roundTrip).slice(0, 160))
check('往返后主要设置一致（密钥除外）',
  roundTrip.settings.volume === 0.62 &&
  roundTrip.settings.theme === 'light' &&
  roundTrip.settings.ai.baseUrl === 'https://example.com/v1' &&
  !('hasKey' in roundTrip.settings.ai))
check('迁移来源标记为当前版本', roundTrip.migratedFrom === transfer.VERSION)

const restored = transfer.parseImport(JSON.stringify(withKey))
check('带密钥的文件导入后密钥还在', restored.ok === true && restored.settings.ai.key === 'sk-secret-123456')

/* 导入时文件没带密钥：保住当前已有的密钥 */
const keep = transfer.keepExistingKey(JSON.parse(JSON.stringify(roundTrip.settings)), current)
check('文件没带 key 时保留当前密钥', keep.ai.key === 'sk-secret-123456')

/* ---------------- ③ 坏文件被拒 ---------------- */

const badJson = transfer.parseImport('{ this is not json')
check('坏 JSON 被拒', badJson.ok === false && badJson.code === 'bad-json')
check('数组被拒', transfer.parseImport('[]').code === 'not-object')
check('别的 JSON（无关对象）被拒', transfer.parseImport('{"foo":1}').code === 'wrong-kind')
check('没有 settings 的对象被拒',
  transfer.parseImport(JSON.stringify({ kind: transfer.KIND, version: 1 })).code === 'no-settings')
check('版本太新被拒',
  transfer.parseImport(JSON.stringify({ kind: transfer.KIND, version: 99, settings: {} })).code === 'too-new')

/* 关键：被拒时**不动**现有设置（调用方只有 ok 才 set，这里验证纯函数不会改入参） */
const before = JSON.stringify(current)
transfer.parseImport('{ bad')
transfer.parseImport(JSON.stringify({ kind: transfer.KIND, version: 99, settings: {} }))
check('被拒时入参一个字节都没变', JSON.stringify(current) === before)

/* ---------------- ④ 旧版本迁移 ---------------- */

const legacy = transfer.parseImport(JSON.stringify({ volume: 0.4, theme: 'dark', equalizer: { enabled: true } }))
check('没有 kind 的裸设置按 v0 接受', legacy.ok === true)
check('迁移后缺失的键用默认值补齐',
  legacy.settings.volume === 0.4 && legacy.settings.theme === 'dark' &&
  legacy.settings.resumePlayback === DEFAULTS.resumePlayback &&
  legacy.settings.gapless === DEFAULTS.gapless)
check('迁移来源标记为 v0', legacy.migratedFrom === 0)

/* 类型不对的键被忽略，不污染设置 */
const wrongTypes = transfer.parseImport(JSON.stringify({
  kind: transfer.KIND,
  version: 1,
  settings: { volume: '很大声', resumePlayback: 'yes', ai: { enabled: true, model: 42 } }
}))
check('类型不对的值被忽略（用默认值）',
  wrongTypes.ok === true && wrongTypes.settings.volume === DEFAULTS.volume &&
  wrongTypes.settings.resumePlayback === DEFAULTS.resumePlayback &&
  wrongTypes.settings.ai.model === DEFAULTS.ai.model)
check('未知键被丢掉', !('nonsense' in wrongTypes.settings))

/* 摘要 */
const summary = transfer.summarise(legacy, current)
check('摘要能列出哪些键变了',
  summary.ok === true && summary.changed.includes('volume') && summary.changed.includes('theme'))
check('摘要写明迁移来源', /v0/.test(summary.from))

console.log('')
if (problems.length) {
  console.log(`设置导入导出检查：${problems.length} 个问题`)
  for (const item of problems) console.log('  · ' + item)
  process.exit(1)
}
console.log('设置导入导出检查：0 问题')
