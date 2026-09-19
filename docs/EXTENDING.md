# 扩展指南

Aria 刻意把「能力」和「界面」分开，并在两处留了扩展缝：

- **渲染层（浏览器）**：插件宿主提供 6 个扩展点，插件是一个纯对象
- **主进程（Node）**：服务容器，用 `ctx.define(name, factory)` 注册新服务

两边的共同原则：**不要改别人的代码，往注册表里加东西**。内置功能（播放模式、歌词来源）
本身就走在同一套扩展点上，所以插件能做的事和内置功能没有区别。

---

## 一、渲染层插件

> 插件如果要画界面：颜色、间距、圆角、阴影、动效一律用 `tokens.css` 里的
> 令牌，别写裸值 —— 规则和例外见 **[DESIGN.md](DESIGN.md)**，`npm run check:styles`
> 会检查令牌是否用对、亮暗两套是否成对。

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

### 2. 七个扩展点

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
    return { text: await response.text(), source: '示例站点' }
  }
})
```

`source` 会显示在歌词区右上角（本地歌词显示文件名，在线来源显示这里给的名字）。

**渲染层不能联网**：页面的 CSP 不允许 `connect-src`，所以不要在渲染层直接 fetch 外部服务。
正确做法是在主进程加一个服务（见下方「主进程服务」），渲染层通过 IPC 拿到**文本或字节**。
内置的 `plugins/online-media.js` 就是这么做的：歌词走 LRCLIB、封面走 iTunes/Deezer，
请求全部在主进程发出，结果落在 `userData/online-cache`。

#### `artworkProvider` —— 封面来源

本地没有内嵌封面、目录里也没有图片时，按 `priority` 依次尝试。

```js
api.register('artworkProvider', {
  id: 'my-cover',
  priority: 50,
  async resolve (track, { remote }) {
    // 返回 { url } 或 { data: Uint8Array, mime }；返回 null 表示交给下一个来源
    const result = await remote.online.cover({ album: track.album, artist: track.artist })
    if (!result || !result.data) return null
    return { data: result.data, mime: result.mime }
  }
})
```

同一个「专辑 + 艺人」在一次会话里只会问一次，失败也会记住，因此不必自己做去重。

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
| 新的封面来源 | `artworkProvider` 扩展点 |
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

## 三·五、在线音源（音源脚本）

「在线音源」提供的是**机制**：装载、管理、运行你自己放进来的音源脚本，
搜索结果里会多出一块「网络结果」，和本地结果并列。

> **本项目不内置任何音源。** 没有音源时搜索结果里不会出现「网络结果」那一块
> ——「不添加音源就什么也搜不到」是设计使然，不是没做好。
> 脚本访问什么服务、是否合规，由你自己判断与负责。

### 放哪里

```
<userData>/music-sources/*.js      # Windows 一般是 %APPDATA%\Aria\music-sources
```

设置 → 在线音源里可以「导入脚本」（选一个 .js）、「打开目录」、「刷新」、单独启用/停用、移除。
目录里的 `.js` 在刷新时按 mtime 重新装载；装载失败的脚本会在列表里标出来并显示原因。

### 接口

脚本是 CommonJS，导出下面这些成员（`search` 与 `resolveUrl` 至少要有一个）：

```js
module.exports = {
  name: '我的音源',            // 显示名（缺省用文件名）
  version: '1.0.0',           // 可选
  description: '…',           // 可选

  // 搜索。返回数组，字段能做多少填多少。
  async search (query, { limit, request, signal }) {
    const res = await request('https://example.com/api/search', {
      params: { q: query, n: limit },
      headers: { Referer: 'https://example.com/' },
      responseType: 'json'       // 'json' | 'text' | 'buffer'
    })
    return (res.body?.list || []).slice(0, limit).map((item) => ({
      id: String(item.id),       // 音源内的唯一 id，解析地址时会原样还给你
      title: item.name,
      artist: item.singer,
      album: item.album,
      duration: item.interval,   // 秒
      quality: item.rate,        // 例如 '320k'
      payload: item              // 可选：原样保存，resolveUrl 时还给你
    }))
  },

  // 点「复制地址」时才会调用，返回可播放的 http(s) 直链
  async resolveUrl (track, { quality, request, signal }) {
    const res = await request('https://example.com/api/url', {
      params: { id: track.id, rate: quality },
      responseType: 'json'
    })
    return res.body.url
  },

  // 可选：歌词 / 封面（目前界面还没接，先留着口子）
  // async resolveLyrics (track, api) { return { text: '[00:01.00]…' } },
  // async resolveCover (track, api) { return 'https://…' }
}
```

### 沙箱里有什么

脚本跑在 Node 的 `vm` 上下文里，**只有**下面这些：

| 能力 | 说明 |
| --- | --- |
| `request(url, options)` | 极简 HTTP 客户端：`{ method, headers, body, params, timeout, responseType }` → `{ status, ok, headers, body, raw }` |
| `crypto` | `createHash / createHmac / randomBytes / randomUUID` |
| `zlib` | `gzipSync / gunzipSync / inflateSync / deflateSync` |
| `Buffer` `URL` `URLSearchParams` `TextDecoder` | 常用内置对象 |
| `setTimeout` / `clearTimeout` / `setInterval` / `clearInterval` | 定时器 |
| `console` | 输出会带上 `[source:文件名]` 前缀 |

**没有** `require`、`fs`、`process`、Electron API，也拿不到渲染层。
单次搜索 15 秒、解析地址 20 秒超时；某个音源抛错或超时只影响它自己，
界面上会把它标成出错、其他音源照常出结果。

### LX 音乐音源的兼容层

很多人手里已经有 LX Music（洛雪音乐）的自定义源脚本。这类脚本**不导出对象**，
而是通过宿主提供的全局 `lx` 用事件协议通信，第一句通常就是：

```js
const { EVENT_NAMES, request, on, send } = globalThis.lx
send(EVENT_NAMES.inited, { status: true, sources: { kw: { name: '酷我音乐', type: 'music', actions: ['musicUrl'], qualitys: ['128k','320k'] } } })
on(EVENT_NAMES.request, ({ source, action, info }) => { /* musicUrl / lyric / pic */ })
```

没有这个全局，脚本会直接抛 `Cannot destructure property 'EVENT_NAMES' of 'globalThis.lx'`。
所以宿主里内置了一套兼容实现（规范见 LX 官方文档的「自定义源脚本编写说明」）：
`EVENT_NAMES` / `send` / `on` / `off` / `request`（含旧版回调风格）/ `utils.crypto` / `utils.buffer` /
`version` / `env` / `currentScriptInfo`，并在装载时接收脚本发来的 `inited` 事件。

**但要说清楚一件事**：按官方规范，LX 音源只负责 `musicUrl`（拿播放地址）、
`lyric`（拿歌词）、`pic`（拿封面）—— **没有搜索**。搜索是 LX 客户端自己用它内置的源完成的。
所以在任何不自带那套搜索的宿主里（包括本项目），LX 音源都**不会产生搜索结果**，
它只能当解析器用。

因此本项目的处理是：

- LX 脚本照常装载，在设置里标成 **「LX 兼容 · 仅解析」**，并列出它声明的音源与动作；
- 搜索时它会出现一条说明（「按官方规范只提供解析…」），而不是默默没有结果；
- 如果将来有一个能搜索的脚本把结果里的 `payload.lx = { source, musicInfo }` 递过来，
  宿主就会按官方协议派发 `request({ source, action: 'musicUrl', info: { type, musicInfo } })`
  去解析地址，歌词同理（`action: 'lyric'`）。

### 外部搜索器（语言无关的子进程接口）

如果把「搜索」单独封装成另一个程序、只留一个调用接口，可以用这个：一个可执行文件 +
stdin/stdout 上的 JSON 协议，**用什么语言写都行**。

配置文件：`<userData>/music-sources/providers.json`

```json
[
  {
    "id": "my-finder",
    "name": "我的搜索器",
    "command": "node",
    "args": ["C:\\path\\to\\finder.js"],
    "env": { "ELECTRON_RUN_AS_NODE": "1" },
    "timeoutMs": 15000
  }
]
```

- `command` / `args`：怎么启动它；`cwd` 可选（默认是音源目录）；
- `env` 可选，会叠加在环境变量上。**在 Electron 里跑 node 脚本时记得带
  `ELECTRON_RUN_AS_NODE=1`** —— 否则 `process.execPath` 指向的是 Electron 本体，
  脚本会被当成窗口程序，既不读 stdin 也不回结果（自检就踩过这个坑）；
- 每次请求启动一次进程：把一行 JSON 写进 stdin 然后关闭，读取 stdout 的**最后一行** JSON。

协议：

| 请求（stdin 一行） | 期望返回（stdout 一行） |
| --- | --- |
| `{"action":"search","query":"…","limit":20}` | `{"results":[{"id","title","artist","album","duration","quality","payload"}]}` |
| `{"action":"resolve","item":{…}}` | `{"url":"https://…","headers":{…}}`（headers 可选） |
| `{"action":"lyrics","item":{…}}` | `{"text":"[00:01.00]…"}` |

出错时可以返回 `{"error":"原因"}`，非 0 退出码或非 JSON 输出都会按失败处理并把 stderr 末行带进错误信息。

> **本项目只提供这个接口，不提供任何实现**，也不打包任何实现 —— 具体接什么服务、
> 是否合规，由使用者自己负责。内置音源只有 Internet Archive 那一个（公共领域 / CC，免密钥）。

- 搜索结果分两块：**网络结果**（音源返回，可收起，每行带来源与质量标签）与**本地结果**（原有列表）；
- 每条在线结果有三个动作：**播放**（解析直链后直接在内置播放器里播，歌词会跟着加载）、
  **下载**（到默认目录或设置里指定的目录）、**复制地址**（解析直链到剪贴板）；
- 设置里可以：从链接导入、导入本地脚本、打开目录、刷新、**全部启用/全部停用**，
  以及逐条启用/停用/移除；每条音源还会显示本次会话的调用统计（搜索次数 / 成功 / 失败 / 最近耗时）。

播放是怎么接进来的：在线结果不是资料库曲目，所以播放时会把解析出来的直链包成一个
**合成曲目**（`id` 以 `online:` 开头、带 `onlineUrl`）注册进 `library.byId` ——
播放器、播放条、正在播放页照旧按 trackId 取对象，`core/media-url.js` 遇到 `onlineUrl`
就把直链交给 `<audio>`。合成曲目**不进** `library.tracks`，所以不会污染歌曲列表 / 专辑 / 媒体墙。
CSP 的 `media-src` 相应放开了 `https:`/`http:`（`connect-src` 仍然只允许 `app:`/`media:`，
渲染层自己依然不能发请求）。

歌词：音源提供 `resolveLyrics` 时优先用它，没有就退回本地 `.lrc`，再没有就走原来的在线歌词补全。

### 还没做的

- 音源列表还不能拖拽排序（搜索是并发跑的，顺序对结果影响不大）；
- 下载没有断点续传，也没有下载队列（一个一个点，各自独立）。


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
