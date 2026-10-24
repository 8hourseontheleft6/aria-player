'use strict'

/*
 * 自动更新检查：状态机文案 + 事件归并 + 配置（publish / 依赖 / 脚本保护）。
 *
 * electron-updater 本身要真窗口和真 feed 才跑得动，所以这里测的是**纯逻辑**：
 * 状态 → 文案、事件 → 状态、以及"配置有没有指对仓库、dist 脚本会不会偷偷发布"。
 * 真 feed 的那条链路在 smoke 里用本地 HTTP 服务跑（见 smoke.js 的自动更新一节）。
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

const { describeState, reduceEvent, STATES } = require(path.join(ROOT, 'src/main/services/updater'))

/* ---------------- ① 状态 → 文案 ---------------- */

check('状态集合齐全', STATES.join(',') === 'idle,checking,not-available,available,downloading,downloaded,error',
  STATES.join(','))
check('还没检查过 → 提示可检查', describeState({ status: 'idle' }).text.includes('还没检查过'))
check('无更新 → 明确说「已是最新版本」',
  /已是最新版本/.test(describeState({ status: 'not-available', version: '0.2.0' }).text))
check('发现新版本 → 说明版本号并开始下载',
  /发现新版本 0.3.0/.test(describeState({ status: 'available', version: '0.3.0' }).text))
check('下载中 → 带百分比',
  /正在下载 0\.3\.0：42%/.test(describeState({ status: 'downloading', version: '0.3.0', percent: 42 }).text))
const downloaded = describeState({ status: 'downloaded', version: '0.3.0' })
check('下完 → 给「重启安装」动作', downloaded.action === 'restart' && /重启后安装/.test(downloaded.text))
check('出错 → 给重试动作且有文案', describeState({ status: 'error', message: '网络不可用' }).action === 'retry')
check('没有 message 的出错误也有一句人话',
  describeState({ status: 'error' }).text.length > 0)

/* ---------------- ② 事件 → 状态 ---------------- */

let state = { status: 'idle', version: '0.2.0', percent: 0, message: '' }
state = reduceEvent(state, { type: 'checking' })
check('checking 事件', state.status === 'checking')
state = reduceEvent(state, { type: 'available', version: '0.3.0' })
check('available 事件带上版本', state.status === 'available' && state.version === '0.3.0')
state = reduceEvent(state, { type: 'progress', percent: 37.5 })
check('progress 事件 → downloading 且百分比保留',
  state.status === 'downloading' && Math.abs(state.percent - 37.5) < 1e-6)
state = reduceEvent(state, { type: 'downloaded', version: '0.3.0' })
check('downloaded 事件 → 100%', state.status === 'downloaded' && state.percent === 100)
state = reduceEvent(state, { type: 'error', message: 'boom' })
check('error 事件不清空版本', state.status === 'error' && state.version === '0.3.0')
const notAvailable = reduceEvent({ status: 'available', version: '0.3.0' }, { type: 'not-available', version: '0.2.0' })
check('not-available 事件 → 回到"已是最新"',
  notAvailable.status === 'not-available' && /已是最新版本/.test(describeState(notAvailable).text))

/* ---------------- ③ 配置 ---------------- */

const base = fs.readFileSync(path.join(ROOT, 'electron-builder.base.yml'), 'utf8')
check('publish 指向 GitHub 仓库', /provider:\s*github/.test(base) &&
  /owner:\s*8hourseontheleft6/.test(base) && /repo:\s*aria-player/.test(base))

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check('electron-updater 是运行时依赖', Boolean(pkg.dependencies['electron-updater']))
check('dist 脚本都带 --publish never（别让构建直接推 GitHub）',
  ['dist', 'dist:player', 'dist:unified'].every((key) => String(pkg.scripts[key]).includes('--publish never')),
  ['dist', 'dist:player', 'dist:unified'].map((key) => `${key}=${pkg.scripts[key]}`).join(' / '))

/* 产品身份没被影响 */
check('appId / productName 没改',
  pkg.name === 'aria-player' && fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8').includes('appId: com.aria.player'))

/* ---------------- ④ 固定 feed（generic provider）---------------- */

const updaterModule = require(path.join(ROOT, 'src/main/services/updater'))
const FEEDS = updaterModule.FEEDS || {}
check('三个产品各有一个固定 feed', Object.keys(FEEDS).join(',') === 'aria,player,unified',
  Object.keys(FEEDS).join(','))
check('feed 指向仓库里的 updates/<产品>',
  Object.values(FEEDS).every((url) => /\/main\/updates\/(aria|player|unified)$/.test(url)),
  Object.values(FEEDS).join(' / '))

for (const product of ['aria', 'player', 'unified']) {
  const file = path.join(ROOT, 'updates', product, 'latest.yml')
  if (!fs.existsSync(file)) {
    problems.push(`缺少 updates/${product}/latest.yml`)
    continue
  }
  const text = fs.readFileSync(file, 'utf8')
  const urls = [...text.matchAll(/url: (https:\/\/\S+)/g)].map((match) => match[1])
  const hasSha = /sha512: \S+/.test(text)
  const hasSize = /size: \d+/.test(text)
  const version = /^version: (\S+)/m.exec(text)
  check(`updates/${product}/latest.yml：版本行正确`, Boolean(version) && /^\d+\.\d+\.\d+/.test(version[1]),
    version ? version[1] : '无')
  check(`updates/${product}/latest.yml：下载地址是 GitHub Release 的绝对地址`,
    urls.length > 0 && urls.every((url) => url.startsWith('https://github.com/8hourseontheleft6/aria-player/releases/download/')),
    urls.join(','))
  check(`updates/${product}/latest.yml：带 sha512 与 size`, hasSha && hasSize)
}

/* 主进程里确实挂了延迟检查与 IPC */
const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
check('启动后延迟检查（不阻塞）', /updater\.schedule\(/.test(main))
const ipc = fs.readFileSync(path.join(ROOT, 'src/main/ipc.js'), 'utf8')
check('四个 IPC 都在', ['updater:state', 'updater:check', 'updater:download', 'updater:install']
  .every((channel) => ipc.includes(`'${channel}'`)))
check('事件频道在白名单里', ipc.includes("'updater:progress'"))
const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
check('preload 暴露了 updater 且白名单含事件', preload.includes('updater:') && preload.includes("'updater:progress'"))

console.log('')
if (problems.length) {
  console.log(`自动更新检查：${problems.length} 个问题`)
  for (const item of problems) console.log('  · ' + item)
  process.exit(1)
}
console.log('自动更新检查：0 问题')
