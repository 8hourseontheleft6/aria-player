/**
 * 插件宿主：渲染层的扩展点注册表。
 *
 * 六个扩展点（POINTS）：
 *   playbackMode   播放模式      —— 决定「播完之后怎么办」
 *   panel          「正在播放」右栏的标签页
 *   trackAction    曲目动作      —— 出现在列表右键菜单里
 *   lyricsProvider 歌词来源      —— 内置歌词找不到时的兜底（在线歌词、翻译等）
 *   themeToken     主题令牌      —— 覆盖 CSS 变量换肤
 *   audioTap       音频处理      —— 拿到 WebAudio 节点做可视化/音效
 *
 * 插件写法见 src/renderer/js/plugins/ 与 docs/EXTENDING.md。
 */

export const POINTS = {
  playbackMode: {
    title: '播放模式',
    description: '提供一种播放顺序策略，会出现在模式切换器里',
    required: ['id', 'name', 'onEnded']
  },
  panel: {
    title: '面板',
    description: '「正在播放」右栏的标签页，与歌词并列',
    required: ['id', 'title', 'mount']
  },
  trackAction: {
    title: '曲目动作',
    description: '曲目右键菜单中的一项',
    required: ['id', 'label', 'run']
  },
  lyricsProvider: {
    title: '歌词来源',
    description: '内置来源没有结果时依次尝试，可返回文本或已解析的行',
    required: ['id', 'load']
  },
  themeToken: {
    title: '主题令牌',
    description: '覆盖 CSS 变量（--accent 等）实现换肤',
    required: ['id', 'tokens']
  },
  audioTap: {
    title: '音频处理',
    description: '访问 WebAudio 图，可插入分析器或音效节点',
    required: ['id', 'setup']
  }
}

export const POINT_NAMES = Object.keys(POINTS)

export function createPluginHost ({ bus, store, services }) {
  /** @type {Map<string, Map<string, object>>} */
  const registry = new Map(POINT_NAMES.map((name) => [name, new Map()]))
  /** @type {Map<string, {id: string, name: string, dispose: Function}>} */
  const plugins = new Map()

  function assertPoint (point) {
    if (!registry.has(point)) {
      throw new Error(`未知扩展点: ${point}（可用: ${POINT_NAMES.join(', ')}）`)
    }
  }

  function register (point, item) {
    assertPoint(point)
    if (!item || !item.id) throw new Error(`扩展点 ${point} 的条目必须有 id`)
    const spec = POINTS[point]
    for (const field of spec.required) {
      if (item[field] === undefined) {
        throw new Error(`扩展点 ${point} 的条目 ${item.id} 缺少字段 ${field}`)
      }
    }
    registry.get(point).set(item.id, item)
    bus.emit('plugin:registered', { point, item })
    return () => {
      registry.get(point).delete(item.id)
      bus.emit('plugin:unregistered', { point, item })
    }
  }

  function list (point) {
    assertPoint(point)
    return [...registry.get(point).values()]
  }

  function get (point, id) {
    assertPoint(point)
    return registry.get(point).get(id) ?? null
  }

  const api = {
    register,
    list,
    get,
    points: POINTS,
    bus,
    store,
    services,
    log: (...args) => console.log('%c[plugin]', 'color:#0a84ff', ...args),
    warn: (...args) => console.warn('[plugin]', ...args)
  }

  /**
   * 定义一个插件。
   * @param {{id: string, name?: string, setup: (api: object) => (void | Function | {dispose: Function})}} definition
   */
  function define (definition) {
    if (!definition?.id || typeof definition.setup !== 'function') {
      throw new Error('插件定义需要 { id, setup(api) }')
    }
    const plugin = {
      id: definition.id,
      name: definition.name || definition.id,
      disposers: []
    }

    // 给插件一个受控的注册函数：记录 disposer 便于卸载
    const scopedApi = {
      ...api,
      register (point, item) {
        const dispose = register(point, item)
        plugin.disposers.push(dispose)
        return dispose
      }
    }

    try {
      const result = definition.setup(scopedApi)
      if (typeof result === 'function') plugin.disposers.push(result)
      else if (result && typeof result.dispose === 'function') plugin.disposers.push(() => result.dispose())
    } catch (err) {
      console.error(`[plugin] ${plugin.id} 初始化失败`, err)
      return null
    }

    plugins.set(plugin.id, plugin)
    console.log(`%c[plugin]%c ${plugin.name} 已加载`, 'color:#30d158', 'color:inherit')
    return plugin
  }

  function unload (id) {
    const plugin = plugins.get(id)
    if (!plugin) return false
    for (const dispose of plugin.disposers.reverse()) {
      try {
        dispose()
      } catch (err) {
        console.error(`[plugin] ${id} 卸载异常`, err)
      }
    }
    plugins.delete(id)
    return true
  }

  function loadAll (definitions = []) {
    const loaded = []
    for (const definition of definitions) {
      const plugin = define(definition)
      if (plugin) loaded.push(plugin)
    }
    return loaded
  }

  function loaded () {
    return [...plugins.values()].map(({ id, name }) => ({ id, name }))
  }

  return { api, define, loadAll, unload, loaded, register, list, get, POINTS }
}
