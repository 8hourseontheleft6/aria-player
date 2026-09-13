# Aria

iOS 设计风格的本地音乐播放器，Electron 套壳，零构建步骤（原生 ES Module）。

![tech](https://img.shields.io/badge/Electron-42-0a84ff) ![tech](https://img.shields.io/badge/渲染层-原生%20ESM-5e5ce6)

> 版本 `0.0.0-dev`：开发中，尚未发布正式版本，接口与数据结构仍可能变动。

## 界面

| 歌曲列表 | 正在播放与歌词 |
| --- | --- |
| ![歌曲列表](docs/screenshots/01-library.png) | ![正在播放](docs/screenshots/02-now-playing.png) |

| 专辑网格 | 专辑详情 |
| --- | --- |
| ![专辑网格](docs/screenshots/09-albums.png) | ![专辑详情](docs/screenshots/10-album-detail.png) |

| 媒体墙 | 艺人 |
| --- | --- |
| ![媒体墙](docs/screenshots/12-wall.png) | ![艺人列表](docs/screenshots/11-artists.png) |

| 播放队列 | 设置 |
| --- | --- |
| ![播放队列](docs/screenshots/04-queue.png) | ![设置](docs/screenshots/06-settings.png) |

深色主题：

| 歌曲列表 | 正在播放与歌词 |
| --- | --- |
| ![深色歌曲列表](docs/screenshots/08-library-dark.png) | ![深色正在播放](docs/screenshots/07-now-playing-dark.png) |

> 界面会跟随封面取色，`--tint` 由当前专辑封面实时计算，侧栏与底栏的毛玻璃会透出这层色调。

## 功能

- **资料库**：递归扫描本地音乐目录，读取 ID3 / MP4 / FLAC / Vorbis 元数据与内嵌封面（`music-metadata`，缺失时自动降级到内置 ID3 解析器）
- **浏览**：歌曲列表（虚拟滚动，几万首不卡）、专辑网格、艺人列表、媒体墙（满屏封面马赛克，三档尺寸），专辑/艺人详情页支持整张播放、随机播放、加入队列
- **媒体墙聚焦**：正在播放的那张专辑**就在自己的位置上**跨 2×2 放大成聚焦块（模糊封面打底 + 曲目信息 + 同步滚动的迷你歌词 + 传输控件 + 进度条），周围的封面顺延让路；切换尺寸、聚焦块换位都走 FLIP 过渡，整墙平滑推移而不是硬跳
- **媒体墙自由画布**：网格铺成一块比窗口更大的二维平面（列数按专辑数算，接近视口比例），
  **中键拖动**或 **Alt + 左键拖动**可以横竖斜任意方向移动整面墙，滚轮/触控板同样可用；
  松手带惯性滑行（按真实时间衰减，低帧率机器手感一致）、越界有橡皮筋阻尼并回弹，
  右下角有位置指示器（可点可拖）；也可以切回「适应宽度」布局（铺满窗口宽度、只竖向移动）
- **播放**：顺序播放、列表循环、单曲循环、随机播放，暂停 / 上一曲 / 下一曲 / 进度条拖动与缓冲显示
- **歌词**：自动匹配同名或「歌名-歌手」`.lrc`，逐行跟随滚动、双语翻译行、逐字（卡拉 OK）高亮、手动滚动后「回到当前」、偏移与字号调节，支持 GBK/UTF-8/UTF-16 编码探测与内嵌歌词
- **变速**：0.5× – 2×（步进 0.05），可开关「保持音调」
- **系统集成**：托盘图标与菜单、关闭窗口最小化到托盘、任务栏进度条与缩略图按钮（上一首/播放/下一首）、系统媒体键、Windows 系统媒体弹窗（含封面）
- **自动同步**：可开启目录监听，音乐文件夹里增删文件后按扩展名过滤 + 防抖自动刷新资料库；把文件夹或歌曲直接拖进窗口即可导入/播放
- **在线补全（默认关闭）**：本地没有歌词时向 LRCLIB 取时间轴歌词，没有封面时向 iTunes / Deezer 补 600×600 封面。全部请求由主进程发出，页面本身仍然不能联网，结果缓存在本地
- **界面**：iOS/macOS 风格 —— 毛玻璃材质、分组列表、大标题收起、iOS 开关 / 分段控件 / 滑块、跟随封面的动态配色、正在播放全屏页

## 运行

```bash
npm install
npm start        # 启动
npm run dev      # 启动并打开开发者工具
```

> 如果 `npm install` 阶段 Electron 二进制下载失败（网络受限），可以手动把已缓存的
> `%LOCALAPPDATA%\electron\Cache\electron-v<版本>-win32-x64.zip` 解压到
> `node_modules/electron/dist`，并在 `node_modules/electron/path.txt` 写入 `electron.exe`。

首次启动会自动把系统音乐目录加入资料库并扫描；之后启动只做增量刷新（文件未变则只 stat，秒开）。

## 开发工具

这几个脚本都是无人值守的，退出码可直接用于 CI：

```bash
npm run smoke            # 完整链路自检（90 项：资料库→播放→seek→变速→队列→模式→歌词→协议→界面→浏览→系统集成→监听→在线补全）
npm run perf             # 帧率诊断：逐视图量 rAF 间隔 + 拖动路径 A/B 对照（见「性能」一节）
npm run audit            # 视觉审计：计算样式 / 几何 / 截图位图统计，输出 docs/screenshots/audit.json
npm run shots            # 生成 docs/screenshots/ 下的界面截图
npm run probe -- "D:\Music" 20   # 命令行探针：直接验证元数据与歌词解析（不启动 Electron）
node scripts/probe-lyrics.js "D:\Music" 3
                         # 歌词探针：打印双语歌词的解析结果（主歌词 / 翻译 / 迷你歌词各显示什么）
node scripts/check-imports.js    # 找出未使用的 import
node scripts/check-injected.js   # 校验 smoke 里注入到渲染层的代码片段能否解析
                                 # （注入代码写在模板字符串里，多一个括号很难肉眼发现）
npx electron scripts/preview.js docs/screenshots/01-library.png 104
                         # 把截图转成文本预览（结构图 + 色相图），无图形界面时也能审版面
```

## 性能

### 拖动的每帧开销（媒体墙）

整面墙是一块比窗口大得多的二维平面（474 张专辑 ≈ 4684×2419 CSS px，@1.75x 就是 8200×4200
设备像素）。如果直接平移这块平面，浏览器每帧都要为它重新栅格化，实测只有 **9fps**。
现在的做法是三层结构（细节写在 `styles/browse.css` 顶部）：

```
.wall-viewport   视口大小、overflow:hidden
  .wall-window   视口 + 一个步长，被 translate(pan + windowOrigin) 平移  ← 被搬运的合成层
    .media-wall  同样大小的盒子、overflow:hidden，网格轨道仍是整面墙
                 用 translate(-windowOrigin) 在窗口里反向滚动
```

两层 transform 相加恰好等于 pan，所以格子坐标一格都不会错位；被搬运的层只有视口那么大，
拖到哪儿都有内容。

两次实测（`npm run perf`，同一轮里改 CSS 做 A/B，排除环境波动）：

| 做法 | 每帧 | 结论 |
| --- | --- | --- |
| 直接平移整面墙 | 111.8ms（9fps） | 基线 |
| 平移视口大小的窗口，但网格盒子仍是整面墙 | 111.8ms（9fps） | 裁剪不落在铺格子的那一层 → 474 个格子全被栅格化 |
| 窗口 + 网格盒子都收成视口大小并裁剪 | 12.1ms（83fps） | **6 倍差距只来自「裁剪在哪一层」** |
| 再把格子上多余的 `contain: paint` 去掉 | 11.4ms（88fps） | 格子已有 `overflow:hidden`，重复的绘制隔离只是多一层绘制根 |

脚本还会顺带确认「JS 只有 0.02ms/帧」，把瓶颈锁定在绘制而不是脚本；
量出的空闲基准是 8.33ms/帧（120fps 上限），可以判断某次卡顿到底是环境节流还是这一档真有开销。

### 帧率浮层

设置 → 外观 → **显示帧率**，右下角会实时显示「帧率 · 平均帧耗时 · 最近两秒最差的一帧」。
卡与不卡最终取决于用户机器的 GPU、驱动与刷新率，开发机上的数字不能替用户下结论，
所以留了一个能自己看的入口（默认关闭，关掉时不会留下任何每帧回调）。

### 首次打开的封面加载

媒体墙一屏就有上百张封面，最容易出问题的是「首次打开时的封面加载风暴」。这里做了四层处理：

1. **渲染层节流**：封面请求同时最多 4 个在途、每帧最多启动 3 个，不会一次性发起上百个 IPC
2. **主进程落盘缓存**：内嵌封面第一次读取时就缩到 480px、转成 JPEG（约 45KB）存到
   `%APPDATA%\Aria\artwork-cache`，之后只读小文件；源文件 mtime 变化会自动失效
   （实测冷读 15ms → 热读 1ms）
3. **空闲时后台预热**：资料库就绪后一张一张把封面灌进缓存，界面在要封面或正在切歌加载时自动让路
4. **少建 DOM**：几百个格子的占位图标改用 CSS 绘制，省下近千个 SVG 节点

拖动手势期间还会暂停封面懒加载的 IntersectionObserver（容器每帧都在移动，否则浏览器要
为几百个观察目标重算相交性），并在平移路径上完全不读 DOM。设置页里可以看到封面缓存占用并一键清空。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `Ctrl + ← / →` | 上一首 / 下一首 |
| `Ctrl + ↑ / ↓` | 音量 ±5% |
| `← / →` | 快退 / 快进 5 秒（正在播放页） |
| `Ctrl + L` | 打开正在播放与歌词 |
| `Ctrl + Q` | 播放队列 |
| `Ctrl + B` | 显示 / 隐藏边栏 |
| `Ctrl + O` | 添加音乐文件夹 |
| `Ctrl + F` | 搜索 |
| `Ctrl + M` | 静音 |
| `M` | 切换播放模式 |
| `[ / ]` | 播放速度 ±0.05× |
| `中键拖动` | 在媒体墙里任意方向移动整面墙 |
| `Alt` + 左键拖动 | 同上（没有中键时用这个） |
| `Esc` | 关闭浮层 / 返回上一级 / 收起正在播放 |

键盘上的媒体键（播放/暂停、上一首、下一首）由主进程全局快捷键接管，可在设置里关闭。
托盘菜单、任务栏缩略图按钮与系统媒体弹窗走的是同一条指令链路（`media:command`）。

## 项目结构

```
src/
  main/                        主进程
    main.js                    组装：服务 → 协议 → IPC → 窗口
    registry.js                服务容器（主进程的扩展缝）
    protocols.js               app:// 静态资源 + media:// 流式音频（支持 Range，seek 必需）
    ipc.js                     IPC 频道与事件转发
    window.js                  无边框窗口、主题、渲染层控制台转发
    smoke.js                   --smoke 自检脚本
    services/
      settings.js              设置持久化与广播
      library.js               目录管理、递归扫描、元数据缓存、封面
      metadata.js              music-metadata 封装（含兜底）
      id3-lite.js              兜底 ID3v2/v1 解析器
      lyrics.js                歌词文件定位与编码探测
    util/                      文本解码、目录索引、MIME
  preload/preload.js           contextBridge 安全桥（频道白名单）
  renderer/
    index.html
    styles/                    tokens / base / components / shell / library / player / nowplaying / settings
    js/
      app.js                   渲染层组装（composition root）
      core/                    bus store dom icons format remote media-url artwork
                               audio-engine playlist playback-modes lrc plugin-host
                               selectors（可见曲目） grouping（专辑/艺人索引） player-controller
      ui/                      titlebar sidebar library-view browse-view media-wall
                               cover-grid track-list player-bar now-playing-panel lyrics-view
                               queue-panel settings-view slider overlay artwork-node track-menu
      plugins/                 内置示例插件
```

## 扩展

不想破坏现有结构地加功能，请看 **[docs/EXTENDING.md](docs/EXTENDING.md)**。速览：

```js
// src/renderer/js/plugins/my-plugin.js
export const myPlugin = {
  id: 'my-plugin',
  name: '我的插件',
  setup (api) {
    api.register('trackAction', {
      id: 'hello',
      label: '打个招呼',
      icon: 'sparkles',
      run (track, { bus }) {
        bus.emit('ui:toast', { message: `你好，${track.title}`, type: 'success' })
      }
    })
  }
}
```

渲染层有 7 个扩展点：`playbackMode`、`panel`、`trackAction`、`lyricsProvider`、
`artworkProvider`、`themeToken`、`audioTap`；主进程侧则通过 `ctx.define(name, factory)` 注册服务。
开发者工具里 `window.__aria` 可以直接操作 store / 播放器 / 插件宿主。

## 已知边界

- Chromium 能解码的格式有限：`.mp3 .m4a .aac .flac .wav .ogg/.opus .webm`。`.wma` / `.ape` 不支持（想支持需要引入解码器，见 EXTENDING 的 `audioTap` 一节）。
- 歌词偏移采用「正值让歌词提前」的约定（`最终时间 = 标签时间 − offset`），与多数播放器一致；若你的歌词源习惯相反，负值即可。
- 在线补全默认关闭，且只做「歌词 + 封面」。所有网络请求都在主进程发出，渲染层 CSP 依然禁止联网；缓存位于 `%APPDATA%\Aria\online-cache`（设置页可一键清空）。
- 在线封面宁可空着也不放错：只有专辑名或艺人名能对上时才采用（低于阈值的匹配会被丢弃）。Deezer 在部分网络下不可达，此时会自动只用 iTunes。

### 待修：平移后新露出的格子不加载封面

现象：把媒体墙拖到中段之后，新露出来的那一片格子只有灰底占位图，不再出封面；
`debugState().lazy` 显示 `observing` 正常、`queued`/`active` 一直是 0，
也就是**观察者没有为「因为平移而进入视口」的格子派发新的相交回调**
（实测：可见 129 格，其中有封面的只有 20 格）。

成因推测：为了让拖动快起来，格子的裁剪被放到了 `.media-wall` 自己身上
（见「性能」一节），而平移只改变祖先的 transform（纯合成、不触发布局），
Chromium 的 IntersectionObserver 更新周期可能因此没有重算被裁剪目标的新相交关系。
对照证据：`docs/screenshots/14-wall-scrolled.png` 在改动前是 2MB 的正常画面，
改动后变成 202KB 的一片占位图；仓库里保留的是改动前那张，等修好后再重新生成。

修的方向（还没做）：不要只依赖 IntersectionObserver —— 在 `endGestureSoon()` 恢复观察时，
同步遍历 `pending`，用 `getBoundingClientRect()` 与墙视口求一次交，
把命中的节点直接塞进队列（只在「平移停稳后」做一次，代价可忽略）。
`artwork-node.js` 里加一个 `flushVisible(root, margin)` 之类的入口即可。

