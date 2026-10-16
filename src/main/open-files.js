'use strict'

/**
 * macOS：把文件拖到 Dock 图标、或在 Finder 里双击音频 → 导入 / 播放。
 *
 * 为什么单独一个模块：mac 特有的 Electron 事件（`open-file`）我在这台 Windows 机器上**触发不了**，
 * 所以把「攒批 → 交给导入链路」这段逻辑做成纯函数式的桥，用注入的假 app 就能验证
 * （见 smoke 里的「macOS open-file」那条）。真正没被测到的只剩「Electron 会不会按时把事件送进来」，
 * 那是文档保证的部分。
 *
 * 两个细节：
 *  · **冷启动**：双击一个音频文件启动应用时，open-file 会在窗口建好之前到达。
 *    所以没就绪时先把路径攒起来，等 ready() 再一次交出去。
 *  · **攒批**：一次拖 10 个文件会触发 10 次事件 —— 逐个提交会弹 10 次「是否加入资料库」的确认框。
 *    所以合并成一个批次（默认 150ms 内的都算一次）。
 */

function createOpenFilesBridge ({ onPaths, delay = 150, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
  if (typeof onPaths !== 'function') throw new Error('createOpenFilesBridge 需要 onPaths')

  const queue = []
  let timer = null
  let ready = false

  function flush () {
    timer = null
    const batch = queue.splice(0)
    if (batch.length) onPaths(batch)
  }

  function schedule () {
    if (timer) timers.clear(timer)
    timer = timers.set(flush, delay)
  }

  function enqueue (paths) {
    for (const item of paths || []) if (item) queue.push(item)
    if (!ready || !queue.length) return
    schedule()
  }

  return {
    /** 挂到 Electron 的 app 上（传入真的 app，或测试用的假货） */
    attach (app) {
      app.on('open-file', (event, filePath) => {
        // 不 preventDefault 的话 macOS 会按自己的默认行为处理（我们不想让它再开一个实例）
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
        enqueue([filePath])
      })
    },

    /** 窗口与资料库都就绪后调用 */
    ready () {
      ready = true
      if (queue.length) schedule()
    },

    enqueue,
    get pending () { return queue.slice() }
  }
}

module.exports = { createOpenFilesBridge }
