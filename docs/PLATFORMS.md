# 平台适配

三个平台各是什么状态、差在哪、下一步动什么。**结论先放这里**：

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows | 完整支持 | 开发与自检都在这里跑（自检全绿；条数见 `npm run smoke` 的输出） |
| macOS | 代码已就位，待真机验证 | 红绿灯内嵌、系统菜单、媒体键都按 macOS 分支写了；没有 Mac 机器，只能静态核对 + 靠用户验证 |
| Android | **Electron 到不了** | 见第四节：要么换壳（Capacitor/Tauri），要么用「手机浏览器 + 局域网遥控」。已经给出可执行的接法 |

---

## 一、Windows（基准平台）

- 无边框窗口 + 自绘顶栏；窗口按钮、任务栏进度、缩略图按钮都在 `main/window.js` / `services/tray.js`。
- 自检 `npm run smoke`、截图 `npm run shots`、帧率 `npm run perf`、视觉审计 `npm run audit` 都在 Windows 上验证过。
- **通话 / 游戏语音时放歌**：设置 → 播放 → **输出设备**。把 Aria 的输出选成耳机，
  通话留在原设备（音箱 / 另一副耳机），音乐就只进你的耳朵 ——
  麦克风拾不到音乐，通话对方自然听不到。这条走的是 Windows 的「按应用选择输出设备」
  （Chromium 的 `setSinkId`），不需要虚拟声卡，也不用把音乐调小。
  设置项旁边有 ⓘ 说明，`core/audio-engine.js` 的 `setOutputDevice()` 是唯一实现点。

## 二、macOS

代码里已经按平台分支的地方：

- `main/window.js`：`frame: true` + `titleBarStyle: 'hiddenInset'` + `trafficLightPosition`，
  标题栏左侧留出 84px 给红绿灯（`styles/shell.css` 的 `html[data-platform="darwin"]`）。
- `main/window.js`：macOS 保留系统菜单（`Menu.setApplicationMenu(null)` 只在非 mac 执行），
  否则 Cmd+Q / Cmd+W / 复制粘贴全都没了。
- `renderer`：`isMac` 用于隐藏自绘窗口按钮；`Ctrl` 与 `⌘` 在快捷键里等价处理。

**待验证 / 已知缺口**（没有 Mac 机器，这一步必须真机跑）：

1. **打包**：仓库目前只有开发脚本（`npm start`），没有 electron-builder 配置 ——
   Mac 上至少需要 `dmg` / `zip` 目标、`com.aria.player` 的 bundle id、
   `hardenedRuntime` 与签名（不签名则首次打开要右键 → 打开）。
2. **系统「正在播放」**：macOS 的菜单栏 / 控制中心需要 `navigator.mediaSession`
   的 metadata 与 action handler（Windows 的 SMTC 也吃这一套，属于双赢）。
   下一步在 `player-controller` 里随 `TRACK_CHANGED` 写 `mediaSession.metadata` 即可。
3. **媒体键**：现在走的是 Electron 的 `globalShortcut`；macOS 上更合规的做法是
   `MediaPlayPause` 等系统媒体键 + `mediaSession` 的 handler。
4. **省电**：macOS 上 `backgroundThrottling: false` 会阻止后台节流，
   电池模式下建议跟随「最小化时释放」那套逻辑（已经实现，见 `services/background.js`）。

## 三、Android：为什么不是「移植」

Electron 只支持 Windows / macOS / Linux —— **Android 上没有 Electron 运行时**，
所以不存在「编译一下就能跑」的路径。可选方案只有三条：

| 方案 | 代价 | 何时选 |
| --- | --- | --- |
| A. 手机浏览器 + 局域网遥控（**推荐先做**） | 小：主进程加一个只监听局域网的 HTTP/WS 服务 + 一个响应式页面 | 想在手机上控制电脑放歌、看歌词 |
| B. Capacitor / Tauri 换壳 | 大：渲染层能复用，但主进程那套（扫描、解码、协议）要重写成原生插件 | 想要一个真正的手机端 App |
| C. 完全原生（Kotlin + Media3） | 最大 | 要上架、要后台播放通知栏 |

**方案 A 的接法**（现有结构已经够用，不需要动渲染层的业务代码）：

1. `main/services/remote.js` 新建一个服务：`http.createServer` + `ws`，
   **只绑局域网地址**，用一次性 token 鉴权（打印在电脑端的设置页里）；
2. 暴露的是**已有的动作**：`library.state` / `player.play-pause` / `next` / `prev` /
   `player.state`（进度与歌词）；
3. 手机端页面就放在 `src/main/remote-page/`，一个自包含的 `index.html`，
   用 WebSocket 收状态、发指令；
4. 安全边界：默认关闭；只在用户打开开关后监听；token 失效即断开；
   不暴露任何文件系统路径（只给曲目元数据与封面字节）。

**不做的事**：把本地音乐文件直接推到手机（版权与流量都不合适），
手机端定位是「遥控器 + 歌词屏」。

## 四、跨平台时最容易踩的坑（已在本仓库处理）

- **路径**：一律 `path.join`，不拼字符串；`app://` 协议里也用 `path` 归一化。
- **换行与编码**：歌词与设置文件都按 UTF-8 读写，歌词额外探测 GBK / UTF-16
  （`main/util/text.js`）。
- **快捷键**：`Ctrl` 与 `⌘` 都认（`app.js` 的 `mod`）。
- **托盘**：macOS 的托盘点击行为与 Windows 不同，`services/tray.js` 里按平台分支。
- **窗口按钮**：macOS 用系统红绿灯，其它平台自绘（`titlebar`）。
