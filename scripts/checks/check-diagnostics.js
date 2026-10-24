'use strict'

/*
 * 诊断包检查：脱敏 + zip 往返 + 打包内容 + 泄漏检查。
 *
 * 这里能跑纯函数（buildEntries / redact / writeZip / readZip）——
 * 它们刻意不依赖 electron，所以自检不需要开窗口就能验。
 */

const fs = require('node:fs')
const os = require('node:os')
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

const log = require(path.join(ROOT, 'src/main/util/log'))
const { writeZip, readZip } = require(path.join(ROOT, 'src/main/util/zip'))
const { buildEntries, scrubPaths } = require(path.join(ROOT, 'src/main/services/diagnostics'))

/* ---------------- ① 脱敏 ---------------- */

const redactCases = [
  ['key=sk-abcdef1234567890 rejected', 'key=*** rejected', 'sk- 形式的 key'],
  ['Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer ***', 'Bearer token'],
  ['GET https://user:pass123@example.com/v1/models', 'GET https://***@example.com/v1/models', 'URL 里的凭据'],
  ['saved at C:\\Users\\fkdlz\\AppData\\Roaming\\Aria\\settings.json', 'saved at C:\\Users\\***\\AppData\\Roaming\\Aria\\settings.json', 'Windows 用户名路径'],
  ['home /home/fkdlz/.config/aria', 'home /home/***/.config/aria', 'Linux 用户名路径'],
  ['mac /Users/fkdlz/Library/Application Support/Aria', 'mac /Users/***/Library/Application Support/Aria', 'macOS 用户名路径'],
  ['api_key="abcd1234efgh"', 'api_key=***', 'api_key= 形式']
]

for (const [input, expected, label] of redactCases) {
  const actual = log.redact(input)
  check(`脱敏：${label}`, actual === expected, `得到 ${JSON.stringify(actual)}`)
}

log.setSecret('MY-REAL-KEY-42')
check('脱敏：密钥原样出现也能替换', log.redact('upstream said MY-REAL-KEY-42 is invalid') === 'upstream said *** is invalid')
log.setSecret('')

/* ---------------- ② zip 往返 ---------------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-diag-'))
const zipFile = path.join(dir, 'bundle.zip')
const entries = [
  { name: 'a.txt', data: 'hello 中文\n' },
  { name: 'sub/b.json', data: JSON.stringify({ x: 1 }) },
  { name: 'big.txt', data: 'x'.repeat(5000) }
]
writeZip(zipFile, entries)
const back = readZip(zipFile)
check('zip 条目数正确', Object.keys(back).length === 3, Object.keys(back).join(','))
check('zip 文本往返一致', back['a.txt'].toString('utf8') === 'hello 中文\n')
check('zip 压缩过的 5000 字节能还原', back['big.txt'].toString('utf8').length === 5000)
check('zip 子目录文件名保留', Boolean(back['sub/b.json']))

/* ---------------- ③ 打包内容 ---------------- */

const userData = 'C:\\Users\\fkdlz\\AppData\\Roaming\\Aria'
const bundle = buildEntries({
  info: { version: '0.2.0-beta.1', platform: 'win32', arch: 'x64' },
  settings: { volume: 0.8, ai: { hasKey: true, baseUrl: 'https://example.com/v1' } },
  logLines: [
    '2026-10-24T00:00:00.000Z [info] 启动',
    `2026-10-24T00:00:01.000Z [warn] 读取 ${userData}\\settings.json 失败`,
    '2026-10-24T00:00:02.000Z [error] key=sk-shouldnotleak12345'
  ],
  selfCheck: { suite: 'full', passed: 219, total: 219 },
  paths: [userData]
})

const names = bundle.map((entry) => entry.name)
check('诊断包恰好五个条目', names.length === 5, names.join(','))
check('有条目 info.json / settings.json / logs/main.log / selfcheck.json / README.txt',
  ['info.json', 'settings.json', 'logs/main.log', 'selfcheck.json', 'README.txt'].every((name) => names.includes(name)))

const text = bundle.map((entry) => String(entry.data)).join('\n')
check('app data 路径被替换成 <app-data>', text.includes('<app-data>'), '没看到占位符')
check('没有泄漏 sk- 开头的 key', !/sk-shouldnotleak/.test(text))
check('没有泄漏用户名路径', !/C:\\Users\\fkdlz/.test(text))
check('README 里写明了「不含」什么', /不含/.test(String(bundle.find((entry) => entry.name === 'README.txt').data)))
check('selfcheck.json 带的是最近一次结果',
  JSON.parse(String(bundle.find((entry) => entry.name === 'selfcheck.json').data)).passed === 219)

/* ④ 整包写出来再读回：确认最终 zip 里也干净 */
const finalZip = path.join(dir, 'bundle-final.zip')
writeZip(finalZip, bundle)
const finalText = Object.values(readZip(finalZip)).map((buffer) => buffer.toString('utf8')).join('\n')
check('最终 zip 里没有 key', !/sk-shouldnotleak/.test(finalText))
check('最终 zip 里没有用户名', !/fkdlz/.test(finalText))
check('scrubPaths 只替换给定前缀',
  scrubPaths('x C:\\A C:\\AB', ['C:\\A']) === 'x <app-data> C:\\AB')

fs.rmSync(dir, { recursive: true, force: true })

console.log('')
if (problems.length) {
  console.log(`诊断包检查：${problems.length} 个问题`)
  for (const item of problems) console.log('  · ' + item)
  process.exit(1)
}
console.log('诊断包检查：0 问题')
