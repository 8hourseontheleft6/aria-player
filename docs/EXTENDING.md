# 扩展指南

Aria 刻意把「能力」和「界面」分开，并在两处留了扩展缝：

- **渲染层（浏览器）**：插件宿主提供 6 个扩展点，插件是一个纯对象
- **主进程（Node）**：服务容器，用 `ctx.define(name, factory)` 注册新服务

两边的共同原则：**不要改别人的代码，往注册表里加东西**。内置功能（播放模式、歌词来源）
本身就走在同一套扩展点上，所以插件能做的事和内置功能没有区别。

---

## 一、渲染层插件

### 1. 写一个插件

新建 `src/renderer/js/plugins/my-plugin.js`：

```js
export const myPlugin = {
  id: 'my-plugin',            // 唯一 id
  name: '我的插件',            // 显示名（设置页会列出来）
  setup (api) {               // 返回的函数会在卸载时调用
    const off = api.register('trackAction', { /* … */ })
    return () => off()
  }
}
```

然后在 `src/renderer/js/plugins/index.js` 里加进 `BUILTIN_PLUGINS` 数组即可。

`setup(api)` 里的 `api` 提供：

| 成员 | 说明 |
| --- | --- |
| `api.register(point, item)` | 注册扩展点条目，返回注销函数 |
| `api.list(point)` / `api.get(point, id)` | 读取已注册的条目 |
| `api.bus` | 事件总线（`on` / `emit`），事件名见 `core/bus.js` 的 `EVENTS` |
| `api.store` | 状态容器（`get` / `set` / `select`） |
| `api.services` | `{ engine, playlist, remote }`，需要更底层能力时用 |
| `api.log` / `api.warn` | 带前缀的日志 |

> 开发者工具控制台里有 `window.__aria`，可以直接操作 store、播放器和插件宿主，调试很方便。

### 2. 六个扩展点

#### `playbackMode` —— 播放模式

决定「播完之后怎么办」。内置的 4 种模式也是用它注册的。

```js
api.register('playbackMode', {
  id: 'play-once',
  name: '只播放一次',
  short: '单次',
  icon: 'stop',                      // 见 core/icons.js 的图标名
  description: '播完当前曲目就停下来',
  shuffle: false,                    // true 表示这个模式会打乱播放顺序
  onEnded: ({ hasNext }) => 'stop',
  onNext: ({ hasNext, hasPrev, index, queueLength }) => hasNext ? 'next' : null,
  onPrev: ({ hasPrev }) => hasPrev ? 'prev' : null
})
```

三个回调都返回「动作」，由控制器执行：

| 动作 | 含义 |
| --- | --- |
| `'next'` / `'prev'` | 队列里的下一首 / 上一首 |
| `'restart'` / `'last'` | 回到队列第一首 / 最后一首 |
| `'replay'` | 从头重播当前曲目 |
| `'reshuffle'` | 重新洗牌并播放第一首（随机模式用） |
| `'stop'` | 暂停并停在当前位置（状态变为 `ended`） |
| `null` | 什么都不做 |

#### `panel` —— 「正在播放」页的标签页

右栏默认是歌词，注册的面板会作为并列标签出现。

```js
api.register('panel', {
  id: 'spectrum',
  title: '频谱',
  mount (container, { bus, player, store, artwork }) {
    const canvas = document.createElement('canvas')
    container.appendChild(canvas)
    // …绘制逻辑…
    return () => { /* 卸载清理：取消 rAF、断开节点 */ }
  }
})
```

`mount` 返回的函数在切换标签或关闭面板时调用，**务必在这里释放资源**。

配合 `audioTap` 可以拿到实时音频数据（见下方示例）。

#### `trackAction` —— 曲目右键菜单

```js
api.register('trackAction', {
  id: 'copy-path',
  label: '复制文件路径',            // 也可以是 (track) => string
  icon: 'external',
  order: 10,                        // 数字小的排前面
  enabled: (track) => track.size > 0, // 可选，false 时不显示
  run (track, { store, bus, player, actions }) {
    navigator.clipboard.writeText(track.path)
    bus.emit('ui:toast', { message: '已复制', type: 'success' })
  }
})
```

#### `lyricsProvider` —— 歌词来源

内置来源（同目录 `.lrc`、同名 `.txt`、内嵌标签）都没有结果时，按 `priority` 从小到大依次尝试。

```js
api.register('lyricsProvider', {
  id: 'my-lyrics',
  priority: 50,                     // 数字越小越先尝试
  async load (track, { settings }) {
    // 返回三种形态之一：
    //   { text: '[00:12.00]歌词…' }         → 交给内置 LRC 解析器
    //   { lines: [{ time, text }] }         → 已经解析好的时间轴
    //   null / undefined                    → 交给下一个来源
    const response = await fetch(`https://example.com/lyric?q=${encodeURIComponent(track.title)}`)
    if (!response.ok) return null
    return { text: await response.text() }
  }
})
```

注意：渲染层的 CSP 默认只允许 `app:` / `media:`，要联网取歌词需要同时调整
`src/renderer/index.html` 里的 `connect-src`，并在设置里给用户一个开关。

#### `themeToken` —— 换肤

```js
api.register('themeToken', {
  id: 'neon',
  name: '霓虹',
  tokens: {
    '--accent': '#ff2d55',
    '--tint': '#ff2d55',
    '--tint-2': '#af52de'
  }
})
```

注册后令牌会立即写入 `document.documentElement` 的 style，之后注册的插件也会在注册时生效。
可覆盖的令牌见 `src/renderer/styles/tokens.css`（`--label`、`--separator`、`--radius-*` 等都可以改）。

#### `audioTap` —— 音频处理 / 可视化

拿到 WebAudio 图，可以插分析器或音效节点。

```js
api.register('audioTap', {
  id: 'visualizer',
  setup (tap) {
    const analyser = tap.context.createAnalyser()
    analyser.fftSize = 1024
    const disconnect = tap.connect(analyser)   // 串到输出上
    const data = new Uint8Array(analyser.frequencyBinCount)
    const timer = setInterval(() => {
      analyser.getByteFrequencyData(data)
      // 用 data 画图
    }, 33)
    return () => {
      clearInterval(timer)
      disconnect()
    }
  }
})
```

`tap` 的接口：

| 成员 | 说明 |
| --- | --- |
| `tap.context` | `AudioContext` |
| `tap.source` | `MediaElementAudioSourceNode` |
| `tap.connect(node)` | 把节点接到输出，返回断开函数 |
| `tap.resume()` | 恢复被浏览器挂起的 context |

**重要**：`engine.getTap()` 只在插件调用时才创建 WebAudio 图。一旦创建，音频输出就改由
WebAudio 直连 destination——因此音频元素必须是 CORS 模式（`crossOrigin="anonymous"`，
`media://` 协议已经返回 `Access-Control-Allow-Origin: *`），否则会输出静音。
不要在启动时无条件创建接入点。

---

## 二、主进程服务

主进程里所有能力都是服务，用 `ctx.define` 注册、`ctx.get` 取用：

```js
// src/main/main.js 的 bootstrap() 里
ctx.define('lastfm', (ctx) => {
  const settings = ctx.get('settings')
  return {
    async scrobble (track) { /* … */ }
  }
})
```

服务工厂返回的对象就是服务实例（单个进程内单例，惰性创建）。用 `ctx.onCleanup(fn)`
注册退出时清理；`ctx.on(event, handler)` / `ctx.emit(event, payload)` 是进程内总线。

要让渲染层能用，在 `src/main/ipc.js` 的 `handlers` 里加一行：

```js
'lastfm:scrobble': (_event, track) => ctx.get('lastfm').scrobble(track)
```

然后在 `src/preload/preload.js` 的白名单里暴露出去（**任何新频道都必须显式加进白名单**，
这是安全边界，不要绕过）。

### 想加的功能落在哪一层？

| 需求 | 放哪 |
| --- | --- |
| 界面、快捷键、主题、歌词渲染 | 渲染层插件 |
| 读写本地文件、调用系统能力、联网 | 主进程服务 + IPC |
| 新的播放顺序 | `playbackMode` 扩展点 |
| 新的歌词来源 | `lyricsProvider` 扩展点 |
| 音频可视化 / 音效 | `audioTap` 扩展点 |

---

## 三、替换核心实现

各层之间只通过明确接口通信，所以整块替换是可行的：

- **换播放内核**（比如支持 `.wma` / `.ape`）：重写 `core/audio-engine.js`，只要对外仍是
  `load / play / pause / seek / setRate / getTime / getDuration / getBufferedEnd` 这组方法，
  上层不用改。主进程侧再加一个解码服务即可。
- **换元数据解析**：`src/main/services/metadata.js` 是唯一入口，换掉它不影响扫描逻辑。
- **换歌词解析格式**（比如 LRC 之外还要支持 KRC、TTML）：`core/lrc.js` 只暴露
  `parseLrc / parsePlainLyrics / findLineIndex / karaokeProgress`，换实现即可；
  也可以在 `applyParsedLyrics` 之前插入自己的解析器。
- **换界面配色**：`styles/tokens.css` 是唯一的颜色真源，改一处全局生效。
  封面动态配色由 `core/artwork.js` 写入 `--tint` / `--tint-2`。

## 四、自检

改完代码跑一遍：

```bash
npm run smoke
```

它会在真实 Electron 里跑完整链路（资料库 → 播放 → seek → 变速 → 队列 → 模式 →
歌词 → 协议 Range/CORS → WebAudio → 界面），并逐项打印结果，退出码可直接用于 CI。

调试单个解析器时还有更轻的探针：

```bash
npm run probe -- "D:\Music" 20
```
