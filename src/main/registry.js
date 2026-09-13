'use strict'

/**
 * 主进程侧的极简服务容器：依赖注入 + 生命周期 + 事件。
 *
 * 这是主进程的「扩展缝」。任何新能力（例如 Last.fm scrobble、音频转码、
 * 系统媒体控制 SMTC）都应该：
 *   1. 写成一个服务工厂：create(ctx) => ({ ...公开方法 })
 *   2. 通过 ctx.define('name', factory) 注册
 *   3. 通过 ctx.get('name') 取用，不要在模块间直接 require 具体实现
 *
 * @returns {object} ctx
 */
function createContext () {
  /** @type {Map<string, {factory: Function, instance: any}>} */
  const services = new Map()
  /** @type {Array<Function>} */
  const cleanups = []
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()

  const ctx = {
    /**
     * 注册一个服务工厂（惰性实例化）。
     * @param {string} name
     * @param {(ctx: object) => any} factory
     */
    define (name, factory) {
      if (services.has(name)) throw new Error(`服务已注册: ${name}`)
      services.set(name, { factory, instance: null })
      return ctx
    },

    /** 取用服务（首次调用时实例化） */
    get (name) {
      const entry = services.get(name)
      if (!entry) throw new Error(`服务未注册: ${name}`)
      if (entry.instance === null) entry.instance = entry.factory(ctx)
      return entry.instance
    },

    has (name) {
      return services.has(name)
    },

    /** 列出已注册的服务名，便于调试/自省 */
    list () {
      return [...services.keys()]
    },

    /** 注册一个在退出时执行的清理函数 */
    onCleanup (fn) {
      cleanups.push(fn)
      return () => {
        const i = cleanups.indexOf(fn)
        if (i >= 0) cleanups.splice(i, 1)
      }
    },

    /** 进程内部事件总线 */
    on (event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return () => listeners.get(event)?.delete(handler)
    },

    emit (event, payload) {
      const set = listeners.get(event)
      if (!set) return
      for (const handler of [...set]) {
        try {
          handler(payload)
        } catch (err) {
          console.error(`[ctx] 事件处理失败 ${event}:`, err)
        }
      }
    },

    async disposeAll () {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          await fn()
        } catch (err) {
          console.error('[ctx] 清理失败:', err)
        }
      }
      services.clear()
      listeners.clear()
    }
  }

  return ctx
}

module.exports = { createContext }
