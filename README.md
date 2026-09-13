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
- **媒体墙聚焦**：正在播放的那张专辑会跨 2×2 放大成聚焦块（模糊封面打底 + 曲目信息 + 同步滚动的迷你歌词 + 传输控件 + 进度条）并自动排到首位；切换尺寸、聚焦块换位都走 FLIP 过渡，整墙平滑推移而不是硬跳
- **媒体墙自由画布**：网格铺成一块比窗口更大的二维平面（列数按专辑数算，接近视口比例），
  **中键拖动**或 **Alt + 左键拖动**可以横竖斜任意方向移动整面墙，滚轮/触控板同样可用；
  松手带惯性滑行、越界有橡皮筋阻尼并回弹，右下角有位置指示器（可点可拖）；
  也可以切回「适应宽度」布局（铺满窗口宽度、只竖向移动）
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
npm run smoke            # 完整链路自检（62 项：资料库→播放→seek→变速→队列→模式→歌词→协议→界面→浏览→系统集成→监听→在线补全）
npm run audit            # 视觉审计：计算样式 / 几何 / 截图位图统计，输出 docs/screenshots/audit.json
npm run shots            # 生成 docs/screenshots/ 下的界面截图
npm run probe -- "D:\Music" 20   # 命令行探针：直接验证元数据与歌词解析（不启动 Electron）
node scripts/check-imports.js    # 找出未使用的 import
npx electron scripts/preview.js docs/screenshots/01-library.png 104
                         # 把截图转成文本预览（结构图 + 色相图），无图形界面时也能审版面
```

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
