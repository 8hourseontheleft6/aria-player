/** 极简事件总线：用于模块之间解耦（插件也通过它监听播放器事件） */

export function createBus () {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  /** @type {Array<{event: string, handler: Function}>} */
  const onceQueue = []

  function on (event, handler) {
    if (typeof event === 'string' && event.endsWith('*')) {
      return onAny(event.slice(0, -1), handler)
    }
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(handler)
    return () => off(event, handler)
  }

  function onAny (prefix, handler) {
    const key = `*${prefix}`
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key).add(handler)
    return () => off(key, handler)
  }

  function off (event, handler) {
    listeners.get(event)?.delete(handler)
  }

  function once (event, handler) {
    onceQueue.push({ event, handler })
    return on(event, (...args) => {
      const index = onceQueue.findIndex((item) => item.handler === handler)
      if (index >= 0) onceQueue.splice(index, 1)
      handler(...args)
    })
  }

  function emit (event, payload) {
    for (const handler of listeners.get(event) ?? []) {
      try {
        handler(payload)
      } catch (err) {
        console.error(`[bus] ${event} 处理失败`, err)
      }
    }
    for (const [key, handlers] of listeners) {
      if (!key.startsWith('*')) continue
      if (!event.startsWith(key.slice(1))) continue
      for (const handler of handlers) {
        try {
          handler(payload, event)
        } catch (err) {
          console.error(`[bus] ${key} 处理失败`, err)
        }
      }
    }
  }

  function clear () {
    listeners.clear()
  }

  return { on, once, off, emit, clear }
}

export const EVENTS = {
  TRACK_CHANGED: 'player:track-changed',
  STATE_CHANGED: 'player:state-changed',
  MODE_CHANGED: 'player:mode-changed',
  QUEUE_CHANGED: 'player:queue-changed',
  TIME: 'player:time',
  LYRICS_LOADED: 'lyrics:loaded',
  LYRICS_ACTIVE: 'lyrics:active-line',
  LIBRARY_UPDATED: 'library:updated',
  SETTINGS_CHANGED: 'settings:changed',
  TOAST: 'ui:toast',
  NOW_PLAYING_OPEN: 'ui:now-playing-open'
}
