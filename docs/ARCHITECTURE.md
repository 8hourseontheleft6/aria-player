# 项目结构

这份文档回答两个问题：**东西在哪**、**想加功能该动哪**。
（设计语言见 [DESIGN.md](DESIGN.md)，扩展点细节见 [EXTENDING.md](EXTENDING.md)。）

## 一、目录

```
aria-player/
├── src/
│   ├── main/                       主进程（Node 环境，能碰文件与系统）
│   │   ├── main.js                 组装：注册服务 → 协议 → IPC → 开窗 → 扫描
│   │   ├── window.js               窗口创建与平台差异（macOS 红绿灯 / 无边框 / 任务栏）
│   │   ├── ipc.js                  渲染层能调的通道白名单（invoke / on）
│   │   ├── protocols.js            app:// media:// remote:// 三个自定义协议
│   │   ├── registry.js             极简服务容器（define / get / on / onCleanup）
│   │   ├── services/               主进程能力，一个文件一个能力
│   │   │   ├── settings.js         设置持久化 + 变更广播
│   │   │   ├── library.js          扫描、索引、封面缓存
│   │   │   ├── metadata.js         music-metadata + 内置 ID3 兜底
│   │   │   ├── id3-lite.js         轻量 ID3 解析（无依赖兜底）
│   │   │   ├── lyrics.js           .lrc 定位与解析
│   │   │   ├── online.js           LRCLIB / iTunes 在线补全（默认关闭）
│   │   │   ├── music-sources.js    音源宿主：脚本沙箱 / LX 兼容层 / 外部搜索器 / remote:// 代理
│   │   │   ├── watcher.js          目录监听（防抖 + 扩展名过滤）
│   │   │   ├── background.js       最小化后释放后台占用，回前台恢复
│   │   │   └── tray.js             托盘、系统媒体键、任务栏进度
│   │   ├── util/                   纯函数工具（文件、mime、位图、文本编码）
│   │   ├── smoke.js                自检（条数跑 `npm run smoke` 看；含注入渲染层的代码片段）
│   │   ├── screenshot.js           截图（npm run shots）
│   │   ├── perf.js                 帧率诊断（npm run perf）
│   │   └── visual-audit.js         视觉审计（npm run audit）
│   ├── preload/preload.js          contextBridge 白名单（安全边界，新通道必须登记）
│   └── renderer/                   渲染层（无打包器，原生 ES module）
│       ├── index.html              CSP 与容器骨架
│       ├── js/
│       │   ├── app.js              组合根：建 store / 播放器 / 视图，装配 actions
│       │   ├── core/               与界面无关的能力
│       │   │   ├── store.js        状态容器（set / select / subscribe）
│       │   │   ├── bus.js          事件名常量
│       │   │   ├── remote.js       主进程桥 + 非 Electron 兜底
│       │   │   ├── audio-engine.js HTMLAudio 封装（含 WebAudio 插入点）
│       │   │   ├── player-controller.js  播放控制（队列 / 模式 / 歌词跟随）
│       │   │   ├── playlist.js     播放队列（queue / order / cursor）
│       │   │   ├── playlists.js    自建播放列表（纯函数）
│       │   │   ├── selectors.js    可见曲目 = 来源 + 搜索 + 排序
│       │   │   ├── grouping.js     专辑 / 艺人索引、合作艺人拆分、相关度排序
│       │   │   ├── lrc.js          歌词解析（时间轴 / 翻译 / 逐字）
│       │   │   ├── artwork.js      封面 URL 与取色
│       │   │   ├── artwork-prewarm.js 空闲预热（可挂起）
│       │   │   ├── background-release.js 最小化释放的渲染层一半
│       │   │   ├── plugin-host.js  插件宿主（扩展点注册与调用）
│       │   │   ├── reorder.js      FLIP 重排动画
│       │   │   ├── playback-modes.js 内置播放模式
│       │   │   ├── media-url.js / format.js / dom.js / icons.js
│       │   ├── plugins/            内置插件（走扩展点，不是特权代码）
│       │   └── ui/
│       │       ├── views/          整页视图：歌曲列表 / 专辑·艺人 / 媒体墙 / 设置
│       │       ├── panels/         常驻外壳：标题栏 / 侧栏 / 播放条 / 正在播放 / 队列
│       │       ├── menus/          弹层：曲目右键菜单 / 列表「⋯」/ 播放列表选择器
│       │       └── widgets/        可复用件：列表、歌词、封面格子、浮层、滑块…
│       └── styles/                 按界面区域拆分的 CSS
│           ├── tokens.css          设计令牌（颜色 / 圆角 / 阴影 / 间距 / 动效）
│           ├── base.css            重置与滚动条
│           ├── shell.css           外壳：标题栏 / 侧栏 / 灵动岛 / 视图工具栏
│           ├── components.css      通用组件：按钮 / 分段控件 / 弹层 / 菜单 / Toast
│           ├── library.css         歌曲列表（含虚拟滚动与多选工具条）
│           ├── browse.css          专辑网格 / 艺人列表 / 详情页 / 媒体墙
│           ├── nowplaying.css      正在播放与歌词
│           ├── player.css          底部播放条
│           ├── settings.css        设置页
│           ├── dropzone.css        拖放浮层
│           └── fps.css             帧率浮层
├── scripts/
│   ├── checks/                     静态检查：未用 import / 注入代码语法 / 设计令牌
│   ├── probes/                     命令行探针：资料库 / 歌词 / 艺人字段（不启 Electron）
│   └── preview.js                  把截图转成文本预览
├── docs/
│   ├── ARCHITECTURE.md             本文（结构 + 该动哪）
│   ├── DESIGN.md                   设计语言与动效规则
│   ├── EXTENDING.md                扩展点与 SPI
│   └── screenshots/                界面截图与 audit.json
└── tests/                          自检用的临时目录（运行时生成，不入库）
```

## 二、依赖方向（别打破）

```
main/*  ──IPC──▶  preload  ──window.aria──▶  renderer
                                                │
        renderer/js/core/*  ◀── ui/* 只通过 actions 与 core 交互
```

- **主进程**不引用渲染层代码；渲染层不 `require` 任何 Node 能力（`sandbox: true`）。
- **`ui/` 不直接改 store，也不直接调播放器** —— 一律走 `app.js` 里的 `actions`。
  这样「行为」集中在一处，视图可以随便换。
- **`core/` 不引用 `ui/`**。要做界面反馈就 `bus.emit(EVENTS.TOAST, ...)`。
- `plugins/` 与内置功能平权：插件只用扩展点，够不着 `ui/` 内部的私有函数。

## 三、想加功能，动哪

| 想做的事 | 落点 |
| --- | --- |
| 新的界面、快捷键、主题、歌词渲染 | `renderer/js/plugins/` + [EXTENDING.md](EXTENDING.md) 的七个扩展点 |
| 读写文件 / 调系统能力 / 联网 | `main/services/` 新服务 → `ipc.js` 登记 → `preload.js` 白名单 |
| 新的播放顺序 | `core/playback-modes.js`（`playbackMode` 扩展点） |
| 新的歌词 / 封面来源 | `lyricsProvider` / `artworkProvider` 扩展点 |
| 列表多一种「来源」 | `ui/…` 里设 `ui.source` + `core/selectors.js`（列表页、播放、随机播放自动复用） |
| 列表右侧多一个菜单项 | `ui/menus/list-menu.js` |
| 侧栏多一个视图 | `ui/panels/sidebar.js` 的 `VIEW_ITEMS`（顺序由 `settings.sidebarOrder` 决定） |
| 最小化时要一起释放的东西 | `core/background-release.js` + `main/services/background.js` |
| 一套新的配色 / 圆角 / 阴影 | `styles/tokens.css`，然后 `npm run check:styles` |

## 四、约定

- **不加打包器**：渲染层是原生 ES module，改完刷新即可；模块路径要写全 `.js` 后缀。
- **主进程服务惰性单例**：`ctx.define(name, factory)` 注册，`ctx.get(name)` 取用。
- **事件频道要登记**：主 → 渲染的通道必须同时出现在 `main/ipc.js` 与
  `preload/preload.js` 的 `EVENT_CHANNELS` 里（漏了会以「未允许的事件频道」直接崩）。
- **设计令牌**：间距 / 圆角 / 阴影 / 动效只用 `tokens.css` 里的变量，亮暗两套成对定义。
- **改动要能自检**：新增交互尽量在 `main/smoke.js` 里补一条「真的点一下看结果」的检查。
