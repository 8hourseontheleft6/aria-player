'use strict'

/**
 * 诊断包：把「排查问题需要的东西」打成一个 zip。
 *
 * 里面**只有**这些（每一项都有意为之，别往里加音频/歌词/密钥/完整用户路径）：
 *   info.json        版本、Electron/Chrome/Node、OS、架构、locale、启动时间
 *   settings.json    脱敏后的设置（ai.key 已不存在，见 services/settings.js 的 publicSettings）
 *   logs/main.log    最近 200 行日志（写入时已脱敏）
 *   selfcheck.json   最近一次自检的结果（smoke 结束时写进 userData）
 *   README.txt       这个包是什么、里面有什么、怎么读
 *
 * 关键点：**打包前再脱敏一次**（日志里可能混进第三方输出），并把本机路径替换成占位符。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { writeZip } = require('../util/zip')
const log = require('../util/log')

const MAX_LOG_LINES = 200
const BUNDLE_NAME = 'diagnostics'

/**
 * 把本机路径换成占位符。
 *
 * 两个细节：
 *  · 长前缀先替换（C:\Users\x\AppData 比 C:\Users\x 长，否则会留下半截路径）
 *  · 要求后面是路径分隔符或结尾 —— 不然 C:\A 会把 C:\AB 也吃掉
 */
function scrubPaths (text, roots) {
  let out = String(text == null ? '' : text)
  const sorted = [...new Set(roots.filter(Boolean))].sort((a, b) => b.length - a.length)
  for (const root of sorted) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    /* 只挡「后面紧跟字母数字」的情况（C:\A 不该吃掉 C:\AB）；后面是分隔符或结尾都算命中 */
    out = out.replace(new RegExp(escaped + '(?!\\w)', 'g'), '<app-data>')
  }
  return out
}

/**
 * 组装 zip 的条目（纯函数：不碰 electron，自检可以直接调）。
 *
 * @param {object} input
 * @param {object} input.info           版本/平台等（见 collectInfo）
 * @param {object} input.settings       已脱敏的设置
 * @param {string[]} input.logLines     日志行（调用方取 tail）
 * @param {object|null} input.selfCheck 最近一次自检
 * @param {string[]} input.paths        要替换成本机占位符的路径
 */
function buildEntries ({ info, settings, logLines, selfCheck, paths = [] }) {
  /* 顺序要紧：先按本机前缀换占位符，再走通用脱敏（否则用户名先变 *** 就替换不上了） */
  const scrub = (text) => log.redact(scrubPaths(text, paths))
  const readme = [
    '这是 Aria 的「导出诊断包」。',
    '',
    '内容：',
    '  info.json       版本 / 平台 / 运行时版本',
    '  settings.json   脱敏后的设置（不含任何密钥）',
    '  logs/main.log   最近 ' + MAX_LOG_LINES + ' 行日志（写入时已脱敏）',
    '  selfcheck.json  最近一次自检的结果（如果跑过）',
    '',
    '不含：音频文件、歌词文本、封面、密钥、完整的用户名路径。',
    '有问题请把这个 zip 附在 issue 里。'
  ].join('\n')

  return [
    { name: 'info.json', data: JSON.stringify(info, null, 2) },
    { name: 'settings.json', data: JSON.stringify(settings, null, 2) },
    { name: 'logs/main.log', data: logLines.map(scrub).join('\n') + '\n' },
    { name: 'selfcheck.json', data: JSON.stringify(selfCheck || { note: '还没跑过自检' }, null, 2) },
    { name: 'README.txt', data: readme }
  ]
}

function collectInfo () {
  const { app } = require('electron')
  return {
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale || '',
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    now: new Date().toISOString()
  }
}

function createDiagnosticsService (ctx) {
  const settings = ctx.get('settings')
  const { app, shell } = require('electron')

  function userData () {
    return app.getPath('userData')
  }

  function readSelfCheck () {
    try {
      return JSON.parse(fs.readFileSync(path.join(userData(), 'selfcheck.json'), 'utf8'))
    } catch {
      return null
    }
  }

  return {
    /**
     * 读回一个诊断包（自检用）：列出条目、数日志行、检查有没有泄漏。
     * 泄漏检查在主进程做 —— 只有这里知道密钥是什么。
     */
    async inspectBundle (file) {
      try {
        const { readZip } = require('../util/zip')
        const entries = readZip(file)
        const names = Object.keys(entries)
        const key = String((settings.get().ai || {}).key || '')
        const texts = names.map((name) => entries[name].toString('utf8')).join('\n')
        const leaks = {
          key: key.length > 6 && texts.includes(key),
          userPath: /[A-Za-z]:\\Users\\[^\\*]/.test(texts) || /\/home\/(?!\*)/.test(texts)
        }
        return {
          ok: true,
          entries: names,
          logLines: (entries['logs/main.log'] || Buffer.from('')).toString('utf8').split('\n').filter(Boolean).length,
          leaks
        }
      } catch (error) {
        return { ok: false, code: 'inspect-failed', message: String((error && error.message) || error) }
      }
    },

    /**
     * 导出诊断包，返回 { ok, path } 或 { ok: false, code, message }。
     * 写在 userData/diagnostics/ 下（不弹保存框，避免打断用户；导完用资源管理器定位）。
     */
    async exportBundle () {
      try {
        const { publicSettings } = require('./settings')
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const target = path.join(userData(), 'diagnostics')
        fs.mkdirSync(target, { recursive: true })
        const file = path.join(target, `${BUNDLE_NAME}-${stamp}.zip`)

        const entries = buildEntries({
          info: collectInfo(),
          settings: publicSettings(settings.get()),
          logLines: log.tail(MAX_LOG_LINES),
          selfCheck: readSelfCheck(),
          paths: [userData(), os.homedir(), process.env.APPDATA || '', process.env.LOCALAPPDATA || '']
        })
        writeZip(file, entries)
        log.info('诊断包已导出', { file: path.basename(file), entries: entries.length })
        /* 自动化（自检/截图）时别真的弹资源管理器 —— 它会抢焦点，把后面的检查搅乱 */
        if (!process.env.ARIA_USER_DATA) shell.showItemInFolder(file)
        return { ok: true, path: file }
      } catch (error) {
        log.error('导出诊断包失败', { message: error && error.message })
        return { ok: false, code: 'export-failed', message: String((error && error.message) || error) }
      }
    }
  }
}

module.exports = { createDiagnosticsService, buildEntries, scrubPaths, collectInfo, MAX_LOG_LINES }
