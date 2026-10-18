'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')

const ROOT = path.resolve(__dirname, '..', '..')

/** 只替换 Electron/故障注入依赖；被测模块和相对依赖均执行仓库原代码。 */
function loader (overrides = {}) {
  const cache = new Map()
  function load (file) {
    file = require.resolve(file)
    if (cache.has(file)) return cache.get(file).exports
    const mod = new Module(file, module)
    cache.set(file, mod)
    mod.filename = file
    mod.paths = Module._nodeModulePaths(path.dirname(file))
    const normal = mod.require.bind(mod)
    mod.require = (id) => {
      if (Object.hasOwn(overrides, id)) return overrides[id]
      if (id.startsWith('.')) return load(path.resolve(path.dirname(file), id))
      return normal(id)
    }
    mod._compile(fs.readFileSync(file, 'utf8'), file)
    return mod.exports
  }
  return (relative) => load(path.join(ROOT, relative))
}

async function harness (t, overrides = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aria-backend-test-'))
  const handlers = new Map()
  const events = []
  let bridge
  const electron = {
    app: { getPath: (name) => name === 'userData' ? dir : path.join(dir, name) },
    net: { fetch: (...args) => fetch(...args) },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), on () {}, removeListener () {}, removeHandler: (name) => handlers.delete(name) },
    ipcRenderer: { invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name)({}, ...args)), on () {} },
    contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api } },
    globalShortcut: { unregisterAll () {}, register () {} },
    nativeTheme: { on () {} }, webUtils: {},
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (name, value) => events.push({ name, value }) } }] }
  }
  const load = loader({ electron, ...overrides })
  const ctx = load('src/main/registry.js').createContext()
  ctx.define('settings', (context) => load('src/main/services/settings.js').createSettingsService(context))
  await ctx.get('settings').init()
  t.after(async () => { await ctx.disposeAll(); await fsp.rm(dir, { recursive: true, force: true }) })
  return {
    dir, ctx, load, handlers, events, electron,
    connect () {
      load('src/main/ipc.js').registerIpc(ctx)
      load('src/preload/preload.js')
      return bridge
    }
  }
}

module.exports = { harness, loader, ROOT }
