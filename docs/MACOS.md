# Aria 的 macOS 版：怎么出包、怎么装、测什么

> 目标读者：**手上有 Mac 的那个人**（或者负责出包的人）。
> 应用**不签名、不公证**——只是发给朋友测试，不上架 App Store。

---

## 一、先说结论：dmg 必须在 macOS 上产出

`electron-builder` 明确拒绝在 Windows / Linux 上打 macOS 目标：

```
⨯ Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build
```

所以在没有 Mac 的机器上，只有两条路可走：

| 路线 | 需要什么 | 产物 |
| --- | --- | --- |
| **A. GitHub Actions（推荐）** | 一个 GitHub 仓库（把代码推上去） | `release/Aria-<版本>-arm64.dmg` 等，从 Actions 页面下载 |
| **B. 任何一台 Mac** | 装了 Node.js 20+（[nodejs.org](https://nodejs.org)） | 同上，直接得到文件 |
| **C. 把源码包给对方，让她自己打** | 对方那台 Mac + Node.js | 同上；包内最外层有《先读我.md》，两条命令搞定 |

**C 的包怎么生成**（在 Windows 上就能做）：

```bash
node scripts/make-mac-source-zip.js
# → release/aria-<版本>-mac-source.zip（约 500 KB，只含构建所需文件）
```

包里已经带了 `scripts/mac-adhoc-sign.js`（ad-hoc 签名钩子）与 `build/icon.png`，
所以对方那边 `npm run dist:mac` 出来的 dmg 和 CI 出来的**完全同源**。

无论哪条路，`build/icon.png`、`build.mac` 里的不签名配置和 `scripts/mac-adhoc-sign.js`
（ad-hoc 签名钩子）都已经在仓库里，**不需要再改任何东西**。

---

## 二、路线 A：GitHub Actions 出 dmg

```bash
# 1) 在 GitHub 上建一个空仓库（私有也行），然后：
git remote add origin git@github.com:<你的账号>/<仓库名>.git
git push -u origin main

# 2) 出包：手动点一次，或者推一个标签自动出
#    手动：仓库页面 → Actions → build-mac → Run workflow
git tag -a mac-test -m "mac 测试包" && git push origin mac-test
```

跑完在 **Actions → build-mac → 该次运行 → Artifacts → aria-mac** 里下载，
里面是 4 个文件：

```
Aria-<版本>-arm64.dmg     Apple Silicon（M 系列）用这个
Aria-<版本>-x64.dmg       Intel Mac 用这个
Aria-<版本>-arm64.zip     同上（zip 版，dmg 打不开时的备选）
Aria-<版本>-x64.zip
```

工作流里已经包含：`npm run check`（红了就不出包）、两个架构各一份 dmg + zip、
**afterPack 阶段的 ad-hoc 签名**（见下一节）、以及产物校验和打印。

## 三、路线 B：在一台 Mac 上直接打

```bash
npm install
npm run dist:mac        # = electron-builder --mac --publish never
```

产物同样落在 `release/` 下。

---

## 四、为什么不签名也能跑，但第一次要「手动放行」

- 我们**没有** Apple 开发者证书，所以不做签名/公证（`mac.identity: null`、
  `hardenedRuntime: false`）——这是刻意的，只为内部测试。
- 但 **Apple Silicon 上没签名 = 直接报「已损坏，无法打开」**（arm64 要求至少 ad-hoc 签名）。
  所以 `scripts/mac-adhoc-sign.js` 会在打包时执行
  `codesign --force --deep --sign - <App>.app`。这一步不需要证书。
- 从浏览器/AirDrop 下来的文件会带上 `com.apple.quarantine`，Gatekeeper 仍会拦一次。第一次打开：

  1. 把 `Aria.app` 拖进「应用程序」；
  2. **右键（或按住 Control 点）→「打开」→ 再点一次「打开」**；
  3. 如果系统只给「移到废纸篓」：系统设置 → 隐私与安全性 → 往下找到 Aria → 「仍要打开」；
  4. 还不行（多半是 zip 解压丢了签名状态），在终端执行一次：

     ```bash
     xattr -cr /Applications/Aria.app
     ```

     之后再打开即可。这一步只做一次。

---

## 五、让朋友测什么（按重要性排）

先看一眼「关于」里的版本号是不是你要测的那一版。

| # | 测什么 | 期望 |
| --- | --- | --- |
| 1 | 启动、窗口外观 | 无边框但**保留原生红黄绿三个圆点**（左上角），标题栏文字不压在圆点上 |
| 2 | 首次扫描音乐资料库 | 设置 → 音乐文件夹 → 添加；扫完歌曲数正确。**如果扫不到歌**，先看有没有一条黄色提示 —— 它会说清是「没权限」还是「路径没了」 |
| 2b | **菜单栏**（屏幕最上方） | 有「Aria / 播放 / 编辑 / 显示 / 窗口」五栏（中文）。点「播放 → 播放 / 暂停」能控制播放；「Aria → 关于 Aria」能看到版本 |
| 3 | 播放 / 暂停 / 上一首下一首 / 进度拖动 | 声音正常，进度随手 |
| 4 | 歌词 | 本地 `.lrc` 或在线（LRCLIB）都能出；滚动跟随 |
| 5 | 封面与艺人头像 | 网格里出封面；艺人页出照片（不是字母占位） |
| 6 | 深色模式 | 跟随系统切换，文字与面板都正常 |
| 7 | 全屏（绿灯）/ 最小化 / 关闭窗口 | 关闭窗口后应用仍在（点 Dock 图标能回来） |
| 8 | `⌘Q` 退出、再打开 | 设置与曲库不丢（退出前会落盘） |
| 9 | 快捷键 | `⌘F` 搜索、`⌘B` 收起侧栏、`⌥⌘Q` 队列、`⌥⌘M` 静音；`⌘Q` 退出、`⌘M` 最小化**由系统负责**（应用刻意不占这两个键） |
| 10 | 菜单栏图标（系统托盘） | 有图标，点开有播放控制；媒体键**可能需要签名才生效**，不行就用菜单栏那套 |
| 11 | 拖拽导入 | 把音频文件/文件夹拖进窗口能导入 |
| 11b | **双击音频 / 拖到 Dock 图标** | 在 Finder 里双击一首音频（或把它拖到 Dock 上的 Aria 图标）→ 应用打开并处理：资料库里的直接播，库外的会问一句要不要把所在文件夹加进来（`app.on('open-file')`，见 `src/main/open-files.js`） |
| 12 | 睡眠定时器 | 设置里选 15 分钟，行的提示文字与到点行为正常 |

### 出问题怎么反馈

- **截图**最有用（界面问题请带上深色/浅色各一张）。
- 崩溃或卡住：打开「控制台」(Console.app) → 左边选「系统日志」或搜索 `Aria`，
  把相关几行复制出来；也可以看 `~/Library/Application Support/Aria/`。
- 想拿更细的日志：在终端里运行
  `/Applications/Aria.app/Contents/MacOS/Aria --dev`
  （会打开开发者工具，控制台里的红字就是线索）。

---

## 六、macOS 上已知的取舍（不是 bug）
| 现象 | 说明 |
| --- | --- |
| 系统媒体键（键盘上的 ⏯）可能没反应 | 未签名的应用在 macOS 上不一定能接管媒体键；菜单栏图标里的控制一定可用 |
| `⌘Q` / `⌘M` 是系统的（退出 / 最小化），应用不占用 | 这两个键在任何 mac 应用里都属于系统；原本做「队列 / 静音」的两个功能改到 `⌥⌘Q` / `⌥⌘M`，界面上的快捷键表会按平台显示 |
| 首次打开要右键 →「打开」 | 未公证的应用都会被 Gatekeeper 拦一次，见第四节 |
| 没有「正在播放」的系统级集成（锁屏/控制中心） | 需要原生模块，本次移植不做 |
| Dock 上没有进度条 | 只在设置里做了任务栏/Dock 进度的地方保持一致 |
| 窗口圆角、阴影 | 由系统提供（`titleBarStyle: 'hiddenInset'`），应用只负责标题栏内容 |
| 菜单栏里没有「帮助」 | 没有可指向的在线文档（本地应用、不上架）。要现场排查就走「显示 → 开发者工具」 |
| **音乐放在「文稿 / 桌面 / 下载」里可能扫不到** | 这是 macOS 的 TCC 权限（不是应用 bug）：未授权的应用读这些目录会被系统拒绝。应用现在会弹一条**黄色提示**说明原因并给出下一步：去「系统设置 → 隐私与安全性 → 文件与文件夹」授权，或把音乐放进「音乐」文件夹（`~/Music` 不受此限制）。外接硬盘同理，需要「文件与文件夹」里放行 |

---

## 七、mac 相关的代码都在哪（给以后维护的人）

| 位置 | 干什么 |
| --- | --- |
| `src/main/window.js` | `titleBarStyle: 'hiddenInset'`、红黄绿位置（`trafficLightPosition`）、非 mac 才 `Menu.setApplicationMenu(null)` |
| `src/main/menu.js` | **菜单栏**（Aria / 播放 / 编辑 / 显示 / 窗口）。播放指令走 `ctx.emit('player:command', …)`，与托盘、媒体键同一条链路；整段 try/catch，装不上就退默认菜单，绝不影响启动 |
| `scripts/checks/check-menu-roles.js` | 守住菜单：role 白名单从 `node_modules/electron/electron.d.ts` 读，顺手拦住「应用功能占用 ⌘Q / ⌘M」 |
| `scripts/mac-adhoc-sign.js` | 打包时对 `.app` 做 ad-hoc 签名（Apple Silicon 必需） |
| `src/renderer/js/core/format.js` | `keyHint()` / `reservedKeyHint()`：界面上的 ⌘ / ⌥ 文案只在这里定义 |
| `src/main/tray.js` | 菜单栏图标用 template image（mac 上会自动适配深浅色） |
| `main.js` 的 `app.on('activate')` / `window-all-closed` | 关闭窗口不退出、点 Dock 图标能回来（mac 的常规行为） |
