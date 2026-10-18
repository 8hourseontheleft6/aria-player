'use strict'

// 用真实窗口、preload、IPC、net 和工作线程验证后端集成；用户数据全部放在临时目录。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-electron-backend-'))
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
  folders: [], watchFolders: false, onlineFeatures: false, trayEnabled: false, globalMediaKeys: false
}))
process.env.ARIA_USER_DATA = directory
const artifacts = path.join(__dirname, '..', '..', '.tmp', 'backend-electron')
const timer = setTimeout(() => { console.error('Electron 后端集成检查超时'); app.exit(1) }, 45000)
let modelCalls = 0
const server = http.createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url === '/v1/chat/completions') {
    let text = ''
    for await (const chunk of request) text += chunk
    const payload = JSON.parse(text)
    modelCalls++
    const translated = payload.messages[0].content.includes('日语') ? 'こんにちは' : '你好'
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ i: 0, translation: translated }]) } }] }))
  } else response.end(JSON.stringify({ title: 'Electron fixture' }))
})

async function main () {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  require('../../src/main/main')
  await app.whenReady()
  let win
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    win = BrowserWindow.getAllWindows()[0]
    if (win && !win.webContents.isLoading()) {
      const ready = await win.webContents.executeJavaScript('Boolean(window.__aria && document.querySelector(".settings"))').catch(() => false)
      if (ready) break
      await win.webContents.executeJavaScript('window.__aria?.actions.setView("settings")').catch(() => {})
    }
    await delay(50)
  }
  assert.ok(win, '应用窗口已创建')
  const evaluate = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`)
  const profile = await evaluate('return window.aria.profile.id')
  const secret = 'fixture-key-never-sent-back'
  const config = { ai: { enabled: true, baseUrl: `${baseUrl}/v1`, model: 'fixture', key: secret } }
  const saved = await evaluate(`return window.aria.settings.set(${JSON.stringify(config)})`)
  assert.equal(saved.ai.hasKey, true)
  assert.equal(Object.hasOwn(saved.ai, 'key'), false)
  const publicState = await evaluate('return window.aria.settings.get()')
  assert.equal(JSON.stringify(publicState).includes(secret), false)
  await evaluate('window.__aria.actions.setView("settings"); window.__aria.views.settingsView.render()')
  const field = await evaluate(`
    const input = [...document.querySelectorAll('input[type="password"]')][0];
    input?.scrollIntoView({block:'center'});
    return input && {value: input.value, placeholder: input.placeholder};
  `)
  assert.deepEqual(field, { value: '', placeholder: '已保存（留空则不修改）' })
  console.log('PASS: real IPC settings replies and password field contain no saved key')

  if (profile === 'full') {
    const script = `module.exports = { name: 'Electron fixture', async search() {
      const response = await request(${JSON.stringify(baseUrl)});
      return [{id:'1',title:response.body.title,payload:{escape:console.log.constructor('return typeof process')()}}];
    }, resolveUrl() { return 'https://fixture.test/audio.mp3' } }`
    const installed = await evaluate(`return window.aria.sources.install(${JSON.stringify({ name: 'electron-fixture', text: script })})`)
    const on = await evaluate(`return window.aria.sources.setEnabled(${JSON.stringify(installed.id)}, true)`)
    assert.equal(on.find((item) => item.id === installed.id).enabled, true)
    const result = await evaluate(`return window.aria.sources.search(${JSON.stringify({ query: 'test', sources: [installed.id] })})`)
    assert.equal(result.results[0]?.title, 'Electron fixture', JSON.stringify(result.perSource))
    assert.equal(result.results[0].payload.escape, 'undefined')
    const off = await evaluate(`return window.aria.sources.setEnabled(${JSON.stringify(installed.id)}, false)`)
    assert.equal(off.find((item) => item.id === installed.id).enabled, false)
    await evaluate(`return window.aria.sources.remove(${JSON.stringify(installed.id)})`)
    console.log('PASS: real Electron source import, network request, sandbox boundary and enable/disable')
  } else {
    const input = { mode: 'translate', lines: ['hello'], language: '简体中文' }
    const first = await evaluate(`return window.aria.aiSubtitles.postProcess(${JSON.stringify(input)})`)
    const second = await evaluate(`return window.aria.aiSubtitles.postProcess(${JSON.stringify({ ...input, language: '日语' })})`)
    const cached = await evaluate(`return window.aria.aiSubtitles.postProcess(${JSON.stringify(input)})`)
    assert.equal(first.values[0].value, '你好')
    assert.equal(second.values[0].value, 'こんにちは')
    assert.equal(cached.cached, 1)
    assert.equal(modelCalls, 2)
    console.log('PASS: real Electron model requests and per-language subtitle cache')
  }

  await fsp.mkdir(artifacts, { recursive: true })
  const screenshot = path.join(artifacts, `${process.env.ARIA_PRODUCT || 'aria'}-${profile}-settings.png`)
  await delay(200)
  await fsp.writeFile(screenshot, (await win.webContents.capturePage()).toPNG())
  const stored = JSON.parse(await fsp.readFile(path.join(directory, 'settings.json'), 'utf8'))
  assert.equal(stored.ai.key, secret)
  await evaluate('return window.aria.settings.set({ai:{key:""}})')
  console.log(`PASS: settings persisted; screenshot ${screenshot}`)
  console.log(`Electron backend integration passed (${process.env.ARIA_PRODUCT || 'aria'}/${profile})`)
}

main().then(() => finish(0), (error) => { console.error(error); finish(1) })
function finish (status) {
  clearTimeout(timer)
  server.close()
  try { fs.rmSync(directory, { recursive: true, force: true }) } catch { /* Windows 可能仍持有窗口缓存文件 */ }
  app.exit(status)
}
