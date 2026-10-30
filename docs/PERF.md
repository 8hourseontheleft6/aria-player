# 性能基线（P0）

这份文档是**可比较的基线**：后面每一项优化都要拿同一套条件重测，读数填进「改后」那列。

## 测量条件

| 项 | 值 |
| --- | --- |
| 机器 | Windows 10/11 x64，Electron 43.7.9（Chromium/Node 版本见 `process.versions`）|
| 窗口 | **1180×780 @ (60,60)** |
| 主题 / 动画 | `system` / 减少动画 **关** |
| 资料库 | **810 首**（同一份自动化档案 `.tmp/automation-profile`）|
| 采样 | 每项 **3 次取中位数**；测前静置 10 秒；测之间 `--expose-gc` 已开 |
| 并发 | 测量时**不跑** smoke / shots |

命令：

```bash
npm run perf:baseline     # 5 项全测，约 2.5 分钟；读数写到 .tmp/perf-baseline-*.json
```

## 基线读数（P0，2026-10-24）

| 项目 | 改前（基线） | 目标 | 备注 |
| --- | --- | --- | --- |
| 冷启动：ready → 首屏可交互 | **224 ms**（三次 220/224/232）| ≤ 220 ms | 渲染层 `__ariaBootMarks` 的 `timeOrigin + interactive` 减 main 的 `readyAt` |
| 冷启动：ready → ready-to-show | **0 ms** | — | 窗口在 `ready-to-show` 立刻 show，这里没有可优化空间 |
| 资料库就绪（**冷缓存**，全量扫描 810 首）| **1164 ms** | ≤ 900 ms | 删掉 `library-cache.json` 后重启测的；这是 P1-1 的主指标 |
| 进程内重扫（删缓存后同一进程）| **97 ms** | 不劣化 | 走目录索引的快速路径，不代表全量扫描 |
| 进程内热扫描（复用缓存）| **85 ms** | 不劣化 | 只比 mtime+size |
| 空闲 RSS · main | **120.3 MB** | 不劣化 | `app.getAppMetrics()` + `process.memoryUsage()` |
| 空闲 RSS · renderer | **158.1 MB** | ≤ 150 MB | 封面 blob 缓存是主要占用，见 P1-2 |
| 空闲 RSS · GPU | **271 MB** | 不劣化 | |
| 空闲 RSS · utility | **222.4 MB** | 不劣化 | 这是 sherpa/ASR 侧的工具进程，未启用时也有基座 |
| 播放 30s · renderer（示波器**关**）| **177.1 MB** | ≤ 170 MB | |
| 播放 30s · renderer（示波器**开**）| **159.0 MB** | ≤ 160 MB | 开示波器反而更低是噪声/GC 时机，别当结论 |
| 播放 30s · main CPU | **0.1–0.3 %** | 不劣化 | |
| 播放 30s · renderer CPU | **2.2–2.3 %** | 不劣化 | |
| 媒体墙 10s · renderer RSS | **215.7 MB** | ≤ 180 MB | 457 格时 |
| 媒体墙 10s · 节点数 | **3757** | ≤ 3000 | `.wall-viewport *` 计数 |
| 媒体墙 10s · 帧间隔中位 | **8.4 ms**（≈119 fps）| 不劣化 | 已在 vsync 上限，别追 |
| 切到歌曲页 10s 后 · 节点数 | 与墙持平（未释放）| ≤ 1500 | 见 P1-3 |
| 切到歌曲页 10s 后 · renderer RSS | 与墙持平（未释放）| ≤ 180 MB | 见 P1-3 |

## 测量细节

- **冷启动**：main 在 `app.whenReady()` 记 `readyAt`、在 `ready-to-show` 前记 `readyToShowAt`
  （`globalThis.__ariaBoot`）；渲染层在 `main()` 末尾记 `window.__ariaBootMarks = { interactive, timeOrigin }`。
  因为 `performance.now()` 是相对 `timeOrigin` 的，先换算成 epoch 再与 `readyAt` 相减。
- **RSS**：`app.getAppMetrics()` 的 `memory.workingSetSize`（KB）按进程类型汇总，
  `main` 另给 `process.memoryUsage()` 的 rss/heapUsed。
- **播放**：挑一首 >120 秒的曲目，播 30 秒后采样；示波器开/关各一次（`actions.setSetting({ visualizer })`）。
- **媒体墙**：`setView('wall')` 后等 10 秒，再取节点数与 3 秒 rAF 采样的中位间隔。
- **扫描**：`library.scan()` 会先 resolve 一个摘要，所以测量要再等 `getStats().scanning === false`。

## 一、启动打点修正：旧的 219ms 只是 shell

**问题**：旧 `interactive` 是在 `boot()` 刚被调起、还在 `await remote.app.info()` / `settings.get()` 的时候写的 ——
那时窗口里只有一个空壳（视图容器、事件、键盘都挂上了，但没数据）。所以它**不能**叫「首屏可交互」。

**改法**（`src/renderer/js/app.js`）：拆成五段打点，旧字段保留成 `shellBuilt` 的别名（兼容已有读数）：

| 阶段 | 打点时机 |
| --- | --- |
| `shellBuilt` | 视图/事件/键盘挂好、`boot()` 还没拿到任何数据 |
| `settingsReady` | `app.info` + `settings` 已应用（主题、音量、视图、快捷键生效）|
| `libraryReady` | 资料库曲目已进 store |
| `firstUsableViewport` | 资料库就绪后的**下一帧**，且当前主视图容器确实可见（有高度、在文档里）|
| `sourcesReady` | 音源脚本加载完成（主进程发 `sources:ready`，发一次）|

`npm run perf:baseline` 现在逐段报告（`readyAt` 为 0 点），并把旧 `interactive` 单独标成「语义是 shellBuilt」。

**实测（3 次，每次都是全新进程，810 首）**：

| 阶段 | 第 1 次 | 第 2 次 | 第 3 次 | 中位数 |
| --- | --- | --- | --- | --- |
| shellBuilt | 213 ms | 221 ms | 240 ms | **221 ms** |
| settingsReady | 365 ms | 394 ms | 402 ms | **394 ms** |
| libraryReady | 494 ms | 519 ms | 527 ms | **519 ms** |
| **firstUsableViewport** | **897 ms** | **916 ms** | **895 ms** | **897 ms** |
| sourcesReady | 329 ms | 340 ms | 406 ms | **340 ms** |
| （旧）interactive | 213 ms | 221 ms | 240 ms | 221 ms |

**结论**：旧口径 219ms 比真实的「首屏可用」**低了约 4 倍**。真正要优化的目标是 **897ms** —— 其中
`libraryReady → firstUsableViewport` 占了约 **380ms**（等资料库 + 两帧 + 首屏列表渲染），
`shellBuilt → settingsReady` 占约 **170ms**（两次 IPC 往返 + 设置应用）。

sourcesReady 在这台机器上比 libraryReady 还早（本地只装了内置音源、无外部慢脚本），
所以「音源拖慢启动」的收益只会在**装了慢音源**的用户身上出现 —— 这直接引出第三部分的临时慢音源验收。

## 二、音源初始化移出启动关键路径

**问题**：`main.js` 在 `createMainWindow()` 之前 `await musicSources.init()`。每个 LX 脚本最多等 8 秒、
多个脚本还是串行 —— 装了慢音源的用户，窗口要晚好几秒才出来（这段时间是白屏）。

**改法**
· 窗口先建、首屏先出来；`did-finish-load` 之后延迟 1.2 秒再后台装载（`loadSourcesInBackground()`）。
· `settings.onlineSources !== true` 时启动**完全不装**，首次调用 `sources:xxx` 时由 `ensureLoaded()` 兜住
  （`list/stats/set-enabled/set-all-enabled/download-dir` 五个入口都接了；`search/resolve/lyrics` 原本就有懒加载）。
· `ensureLoaded()` 并发安全（共用同一个 promise），`init()` 直接复用它。
· 4 秒脚本执行超时、8 秒 LX 初始化等待、错误处理与热重载语义都没动。

**三种场景实测（各 3 次，独立档案 `.tmp/perf-profile`，810 首）**

| 场景 | shellBuilt | settingsReady | libraryReady | **firstUsableViewport** | **sourcesReady** |
| --- | --- | --- | --- | --- | --- |
| 无音源（onlineSources=false）| 217 ms | 342 ms | 490 ms | **824 ms** | 334 ms |
| 正常音源（仅内置）| 205 ms | 321 ms | 433 ms | **803 ms** | 1526 ms |
| 慢音源（两个 2.5s 脚本串行）| 239 ms | 369 ms | 525 ms | **860 ms** | **5551 ms** |

**结论**：慢音源把 `sourcesReady` 推到 5.5 秒，但 `firstUsableViewport` 仍是 **860ms**（与无音源差 36ms，噪声内）——
窗口和本地资料库不再被音源脚本拖住；也没有白屏/启动失败（首屏打点能正常产出）。

**验收夹具**：`.tmp/fixtures/slow-source-a.js` / `slow-source-b.js`（各 2.5 秒后发 `inited`，串行 ≈5 秒），
只在 `<userData>/music-sources` 里临时放，测完删除，不进仓库。

## 三、播放进度事件降频

**问题**：`player-controller` 用 rAF 每帧广播 `TIME`（约 60Hz），而播放条、正在播放页、歌词、媒体墙
都在这个事件里写样式或文本 —— 每帧一次，绝大多数是重复值。

**改法**
· 普通进度 **12Hz**（`TIME_MIN_INTERVAL = 83ms`）。
· 卡拉 OK 升频：仅当 `ui.nowPlayingOpen` 且当前歌词行有 `words`（逐字时间轴）时恢复逐帧；面板一关立刻降回 12Hz。
· 暂停 / seek / 切歌 / 播完仍走 `emitTimeNow()` 立即刷新（不经过节流）；`emitTimeNow` 自己也会更新时间戳，
  避免 ticker 紧接着再叠一次。
· 播放条的工具提示只在字符串变化时写 DOM（`setTooltip` 会碰 title 与 aria）。

**实测（3 次，播放 30 秒，810 首，示波器开/关各一次）**

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| TIME 事件频率 | **117–120 / 秒** | **11.5–11.9 / 秒** |
| renderer CPU | 1.7–2.1 % | **0.7–0.9 %** |
| GPU | 3.0–3.7 % | **0.7–1.2 %** |
| 长任务（30 秒）| 0–1 | 0–1（无变化）|
| main CPU | 0.1–0.3 % | 0.1–0.3 % |

结论：事件量降 **90%**，renderer CPU 降约 **55%**，GPU 也跟着降（进度条重绘少了）；
seek / 暂停 / 切歌的即时刷新语义不变，本体自检仍 **228/228**。

## 四、媒体墙虚拟化：试过，**产品代码已回滚**（读数保留）

**做法（已实现并实测，随后回滚）**：不再依赖 CSS grid 自动流 —— 新增 `computeCells()` 自己算每张专辑的
行列（含 `%9===3` 与聚焦块的 2×2），`grid-template-rows` 显式撑开平面，`updateCulling()` 从
"加 `is-culled`"改成**挂载/卸载窗口内的格子**（稳定 `index` 作 key，rAF 合流，聚焦块永不卸载）。

**实测（810 首 / 457 张专辑，媒体墙打开 10 秒）**

| 指标 | 改前 | 虚拟化后 |
| --- | --- | --- |
| 挂在墙上的格子 | 457 | **40** |
| `.wall-viewport` 内节点 | **3752** | **361**（≤800 ✓）|
| renderer RSS | 215–229 MB | **151.5 MB** ✓ |
| 帧间隔中位 | 8.4 ms | 8.4 ms（不变）|
| 切走 10 秒 / 回墙 | 1 节点 / 3751 | 1 节点 / 361，平移还原 ✓ |

**为什么回滚**：本体自检出现 **9 条回归**（219/228），都属于"视觉或交互"，按约定直接回滚：

1. 聚焦块 96×96（应为 195）—— `applyFeatured` 只加 class、没重设已挂载元素的 grid span；
2. 聚焦块 `order` 断言失效 —— 原实现靠 `order: -1` + 自动流把它排到首位，显式定位后这条断言测的是旧机制；
3. 最小化释放、恢复两条断言都要求"墙上格子 > 100"，与窗口化后的 40 格冲突；
4. `fit` 布局"横向不可拖"失败（平面 1245 vs 视口 932）—— 显式 `grid-template-columns` 的 gap 计算与原
   `max-content` 不一致；
5. "拖到任何位置画面都有内容"命中率 83%、"行列缓存错位 1 个" —— 角点处窗口比实际可视区少一行/列；
6. "切回媒体墙定位到正在播放" featuredKey 为空（同 1）；
7. 另有 1 条双语歌词迷你显示（与墙无关，属已知抖动）。

**结论**：窗口化本身是可行的（节点数 10×、RSS −30% 都拿到了），但它与现有 5 条墙断言 + CSS 平面尺寸
强耦合，一次改四处，必须同步重写这些断言并重新定义"聚焦块排序"的语义 —— 属于"要连断言一起改"的改动，
不适合在收口阶段硬塞。**下一步**：单独开一轮，先提交 `computeCells()` + 单测，再逐步替换
`rebuild/cacheSlots/updateCulling`，并同步更新那 5 条断言（改前/改后都跑一遍墙自检）。

## 五、示波器空闲成本：**已落地**（降帧 + 停帧 + tint 缓存）

**做法**：`--tint` 缓存（MutationObserver 失效，不再每帧 `getComputedStyle`）；播放时 **30fps** 绘制上限；
暂停时 ~6fps；`document.hidden` / 减少动画 / 样式 `off` 时**彻底停帧**（rAF 停掉，状态变化由 `wake()` 唤醒）；
换样式后首帧立即绘制；停帧前把 `dataset.style` 同步到当前样式。

**实测（播放 30 秒，示波器开）**

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 示波器实际绘制 | **118.2–118.9 帧/秒** | **28.9 帧/秒** |
| renderer CPU | 1.6–1.7 % | **1.2 %** |
| GPU | 3.6–4.2 % | **1.4–1.5 %** |
| 长任务（30 秒）| 0–1 | 0 |

**第一次为什么回滚、怎么解决的**：`沉浸式示波器` 断言当时变红，我先误以为是像素覆盖比例不够，
实际原因读数是 `offState.datasetStyle = ring` —— 停帧分支在写 `dataset.style` 之前就返回了。
修法两处：① 停帧前同步 `dataset.style` 并 `paintButton()`；② 自检里像素比例从取当前一帧改成
多帧取峰值（`measurePeak()`，8 帧）。降帧后单帧采样本来就不稳定，峰值只会更高，属于收紧而不是放宽。
改完本体 **228/228** 通过。

## 六、播放历史写入降频：拆成独立小文件

**问题**：`library.markPlayed` 每次切歌都会 `saveCache()` —— 把整份 `library-cache.json`
（810 首，本机 **736 KB**）重写一遍。历史只记「路径 → 时间戳」，不需要跟着元数据一起落盘。

**改法**
· 新增 `services/play-history.js`：`<userData>/play-history.json`，`{ version, played: { path: ts } }`；
  上限 **500** 条（按时间倒序保留）、**1.2 秒防抖**、`writeJsonAtomic` 原子写、退出时 flush；
  写失败只记日志，不影响播放。
· `library`：`markPlayed` 只更新内存 + `playHistory.mark()`，**不再重写整库缓存**；
  `loadCache` 与扫描完成后调 `playHistory.apply(tracks)` 合并（取两者较新的 lastPlayed，兼容旧缓存）。

**实测（同一份 810 首，连播 100 首 = 100 次 markPlayed）**

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 每次切歌写盘 | 整份 `library-cache.json`（**736 KB**）| 只在防抖窗口末尾写一次历史文件 |
| 100 次累计写入 | 约 **71.9 MB**（按文件大小 × 100 推算）| **8.9 KB** |
| `library-cache.json` | 每次都被重写 | **未改动** ✓ |

改前那一轮实测时还撞到 `[library] 缓存写入失败: Error: EPERM rename …` —— 100 次全量原子写在并发下
互相抢临时文件，这正是"整库重写"的副作用之一；改后没有该错误。

**验证**：本体自检 **228/228**（最近添加 / 最近播放排序仍正确）。

## 七、目录 watcher：路径级增量

**问题**：任一音频/封面变化都会 `library.scan()` 全量遍历并 stat 全库（810 首）。

**改法**
· `library.refreshPaths(paths)`：只 stat 点名的那几个音频文件；mtime+size 没变就跳过解析，
  变了才 `readMetadata` + `resolveLyricsPath`，并**保留 `firstSeen` / `lastPlayed`**（重扫不重置历史）。
· 任何无法安全判定的情况（文件不存在=删除/改名、解析失败、正在扫描、路径不是音频）→ 返回
  `fallback: true`，watcher 回退到原来的全量扫描，`added/removed` 语义不变。
· watcher：4 秒防抖窗口不变，先试增量、fallback 才全量；新增 instrumentation
  `incrementalApplied / filesStat / metadataParsed / fullWalk`，并打出 "增量更新：… stat N / 解析 M / 应用 K"。

**实测（同一份 810 首，单路径变更）**

| 指标 | 全量扫描（原来）| 路径级增量 |
| --- | --- | --- |
| `filesStat` | **810** | **1** |
| `metadataParsed` | 0（全部命中缓存）| 0（该文件未变）|
| 耗时 | 125 ms | 0 ms |

**验证**：本体自检 **228/228**（含"目录监听能停能起"与"最小化恢复"两条）。

## 八、封面预热上限：**已落地**（200 张 / 空闲排程）

**做法**：预热上限 `MAX_WARM = 200`（按当前列表顺序），改用 `requestIdleCallback` 排程
（无此 API 回退 `setTimeout`），到上限后**停止排程**；预算按轮计数 ——
`reset()`（缓存被清空、自检重跑）后清零并重新预热，`stats.warmed` 仍是累计值。
`prewarmer.state` 暴露 `budget` / `limit` / `limitReached`。

**实测（启动后 60 秒整空闲窗口）**

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 60 秒内预热 | 无上限，会一直跑到全部 457 张（约 100 秒）| **200 张后停止**（`limitReached=true`）|
| 到上限后的后台唤醒 | 每 220ms / 每 1.5s 持续 | **0 次**（rAF/定时器不再排程）|

**第一次为什么回滚、怎么解决的**：`空闲时后台预热封面` 断言变红，读数是"本轮 +0"。
根因是预算用了**累计**值（`stats.warmed`），自检里调 `prewarmer.reset()` 之后仍然超限、不再预热。
改成按轮预算（`budget`，reset 清零）后该断言恢复正常；本体 **228/228** 通过。

**未做**：artwork-cache / online-cache 的容量上限、访问时间与孤儿清理（dry-run、设置页占用显示）——
这一部分涉及主进程磁盘清扫与设置界面，本轮未动，保持现状。

## 收口：P0 表的「改后」列## 收口：P0 表的「改后」列（2026-10-24，含续播修复 + P1-3）

| 项目 | 改前（基线）| 改后 | 目标 | 结论 |
| --- | --- | --- | --- | --- |
| 首屏可交互（**旧口径 = shellBuilt**）| 224 ms | **219 ms** | ≤220 | ⚠️ 口径不对，见下文「一、启动打点修正」|
| 冷缓存 ready→资料库就绪 | 1164 ms | **1128 ms** | ≤900 | ✗ 未达（P1-1 已证明搬 worker 更慢）|
| 强制全量扫描（同进程）| 1810 / 2152 ms | **1322 ms** | 不劣化 | ✓ 没劣化（区间噪声）|
| 扫描期间主进程 CPU 均值 | 5.2 / 10.1 % | **10.1 %** | 不劣化 | = 与基线同量级 |
| 扫描期间 UI 响应上限 | 421 / 2004 ms | **314 ms** | 不劣化 | ✓ 更好 |
| 空闲 RSS · main | 120.3 MB | **123.3 MB** | 不劣化 | ✓ 噪声内 |
| 空闲 RSS · renderer | 158.1 MB | **159.3 MB** | ≤150 | ✗ 未达（P1-2 两轮未生效）|
| 播放 30s · renderer（示波器关）| 177.1 MB | **159.3 MB** | ≤170 | ✓ 达标 |
| 播放 30s · renderer（示波器开）| 159.0 MB | **158.3 MB** | ≤160 | ✓ 达标 |
| 播放 30s · main CPU | 0.1–0.3 % | **0.1–0.2 %** | 不劣化 | ✓ |
| 媒体墙 10s · renderer RSS | 215.7 MB | **229.2 MB** | ≤180 | ✗ 未达（且比基线高，属于封面链路的既有占用 + 噪声）|
| 媒体墙 10s · 节点数 | 3757 | **3752** | ≤3000 | ✗ 未达（虚拟化没做）|
| 媒体墙 10s · 帧间隔中位 | 8.4 ms | **8.4 ms** | 不劣化 | ✓ 已到 vsync 上限 |
| **切到歌曲页 10s · 墙节点** | **3757**（不释放）| **1** | ≤1500 | ✓✓ **P1-3 的成果** |
| 切到歌曲页 10s · renderer RSS | 201.7 MB | **193.2 MB** | ≤180 | ≈ 只降 8MB |
| 回到墙 | — | 3752 格重建 ✓、平移还原 ✓ | 能重建 | ✓ |

**这一期真正拿到了什么**：
1. 一套可重复的基线（`npm run perf:baseline` + 本文件），以后任何性能改动都能直接对照；
2. 媒体墙离开视图即释放（3757 → 1 节点，回来自动重建并还原平移）；
3. 修掉续播的真 bug（`engine.getTime`），并把那条假阳性自检收紧；
4. **两项被数据否决的优化**（worker 池、封面分档）以及它们为什么不该做——这比硬塞进去更有价值。

**没做到的**：媒体墙 renderer RSS（229.2 / 215.7 → 目标 180）与节点数（3752 → 目标 3000）。
下一期如果继续，方向应该是**墙的虚拟化**（屏幕外不建 DOM），而不是缓存分档。

## P1-1：元数据解析移出主进程 —— 试过，**负收益，已回滚**

做过什么：新增 `workers/metadata-worker.js`（worker_threads）+ `util/metadata-pool.js`（池大小 3，
`ARIA_SCAN_WORKERS` 可覆盖）、`library.scan()` 改成走池、worker 出错时单文件回退主进程。
字段一致性没问题（810 首 × 27 字段 diff **0 处**），但**性能全面变差**：

| 指标 | 改前（主进程解析，6 并发）| 改后（worker 池 3 个）| 结论 |
| --- | --- | --- | --- |
| 强制全量扫描 | **1810 / 2152 ms** | **4142 ms** | 慢约 2× ✗ |
| 扫描期间主进程 CPU 均值 | 5.2 / 10.1 % | 8.9 / 17.1 % | 反而更高 ✗ |
| 扫描期间 UI 响应上限 | 421 / 2004 ms | 2002 ms | 没有改善 ✗ |
| 冷缓存 ready→资料库就绪 | 616 / 1088 ms | 1349 ms | 更慢 ✗ |

原因（读代码 + 数据推断）：`readMetadata` 是 **I/O 为主 + 轻 CPU** 的活，主进程里 6 个 async 任务
本来就能靠 libuv 线程池并行；换成 3 个 worker 后要付**跨线程序列化 + worker 冷启动**的代价，
并发度还从 6 降到 3。要继续这条路得把池做到 6–8 个并预热，但那就等于"用更多线程模拟原来的并发"，
收益仍然可疑。

**处置**：产品代码回滚（`library.js` 恢复、pool/worker 文件删除），只保留测量代码
（扫描段现在会采样主进程 CPU 与扫描期间的 UI 响应，方便以后重测）。

## P1-3：媒体墙离开视图即释放 —— 完成

改法（`app.js` + `media-wall.js`）：
· `store.select(state => state.ui.view === 'wall')`：离开墙起一个 **5 秒**定时器，到点调 `mediaWall.release()`
  并记下当前平移；回到墙时清掉定时器 → `mediaWall.refresh()`（它因为 albumList 为空会重建）→ `setPan(旧值)`。
· 墙新增公开的 `getPan()` / `setPan()`（内部用 target + flushPan，不保留 DOM）。
· 「最小化释放」那条路径原样保留；`release()` 里已经有 `tileCount === 0` 的保护，两条路径不会互相踩。
· 正在播放与迷你歌词不在墙的 DOM 里，不受影响。

改前 / 改后（同一份 810 首，离开墙 10 秒后采样，采样前各清一次 GC）：

| 指标 | 改前 | 改后 | 结论 |
| --- | --- | --- | --- |
| 切到歌曲页 10 秒后 · 墙格子 | **3757 节点**（未释放）| **1 节点** | 节点基本清空 ✓ |
| 切到歌曲页 10 秒后 · renderer RSS | 201.7 MB | 196.4 MB | 只降 ~5MB（噪声级别）|
| 回到墙 · 格子/节点 | 3757 / 3757（本来就没释放）| 3751 / 3751（重建 ✓）| 重建正常 ✓ |
| 回到墙 · 平移位置 | 丢失 | **还原** ✓ | getPan/setPan ✓ |

**诚实结论**：真正的收益是**节点数与重建成本**（3757 → 1），RSS 只降了约 5MB ——
因为切走时 Chromium 本来就会丢掉墙的合成图层，真正占内存的是**封面 blob 缓存**，
那属于 P1-2 的范围。所以这一项不算"大幅省内存"，但结构上确实不再留着 3757 个没人看的节点。

自检：本体新增一条「媒体墙：离开视图 5 秒后释放格子与节点，回来自动重建并还原平移」，
读数写入提交信息与本节。

## P1-2：封面缓存分档 —— 试过，**未达预期，已回滚**

做过什么：主进程 `getArtwork(trackId, { size })`（`size ≤ 240` 走 `thumb-<id>.jpg`，从 full 再缩）、
渲染层拆 `thumbCache`(80) / `fullCache`(10) + LRU + `releaseTier()`、9 个调用点分档
（列表/墙/队列/artwork-node → thumb；正在播放/曲目信息/配色 → full）。

结果：**读取链路没有生效**。

| 指标 | 基线（P0）| 试做 P1-2 | 结论 |
| --- | --- | --- | --- |
| 媒体墙 10s · renderer RSS | 215.7 MB | **227.4 / 228.6 / 230.9 MB** | 反而更高 ✗ |
| 磁盘上生成的 `thumb-*.jpg` | — | **0 张** | thumb 档根本没被调用 ✗ |
| 媒体墙帧间隔中位 | 8.4 ms | 8.4 ms | 无变化 |

诊断：自动化档案里**没有 `artwork-cache`**，把真实档案的 689 张 full 封面拷进去后依然 `thumb` 0 张
—— 说明媒体墙的封面**不是**经 `library.getArtwork` 取的（很可能走 `artworkFile` 的 `media://`
或在线 provider 扩展点）。在没搞清"墙的封面到底从哪来"之前，这套分档只是给缓存多存了一份 URL。

**第二轮的发现（补记）**：把主进程那套接回来、并且找到墙真正的取图路径之后，仍然 `thumb` **0 张**：

· 媒体墙的格子是 `lazy.observe(art, album.artworkTrack, null)`（`media-wall.js:917`），
  实际取图在 `ui/widgets/artwork-node.js` 的 `createLazyArtwork().paint()` —— 它调的是
  `artwork.resolveUrl(track)`（默认 full）。给这条管线加了 `tier`（默认 thumb）后，
  媒体墙 renderer RSS 仍然 **224.2 / 226.2 MB**（基线 215.7 ✗），`thumb-*.jpg` 依旧 **0 张**。
· 所以还有一条更上游的分支没排掉：`paint()` 里 `useOpened`（`caps.library !== true` 时改走
  `opened.artwork(path)`）与 `artworkFile` 的 `media://` 路径都不带尺寸参数。
  在这两种情况下，分档注定不生效 —— 必须先把"当前档案下 `caps.library` 是什么、这批墙格子的
  封面来自哪条分支"打点确认。

**处置**：两轮尝试全部回滚（主进程/ipc/preload/渲染层/调用点），产品代码回到 P1-3 之后的状态。
**下一步要做 P1-2，得先回答一个问题**：
媒体墙的 `<img>` 是哪个函数填的、它走的哪条来源（`media://` / `library.artwork` / provider）——
这一点没查清就动缓存分档，等于白改。

## P1-2 的落点（已调研，未实施）

现状链路：主进程 `library.getArtwork(trackId)` → 首次提取时缩到 480px、转 JPEG 落 `userData/artwork-cache/<id>.jpg`
→ 渲染层 `artwork.resolveUrl(track)` 拿到 blob（内嵌图）或 `media://` URL（同名封面文件），
再统一塞进 `urlCache`（上限 120，只按曲目 key 存，**不分档**）。

要改的地方（按收益排序）：
1. **主进程加 size 参数**（收益最大）：`getArtwork(trackId, { size })` —— `size <= 240` 时另存
   `thumb-<id>.jpg`（从 480 那张再缩），渲染层列表/墙只取 thumb、正在播放/专辑详情取 full。
   `nativeImage.resize` 已经在用了，不引入新依赖。
2. **渲染层两档缓存**：把 `urlCache` 拆成 `thumbCache`（上限 80）与 `fullCache`（上限 10），
   都用 Map 的插入序做 LRU；`releaseTier('thumb'|'full')` 主动 revoke，
   `releaseMemory()` 保留（两档一起放）。
3. **调用点**（共 9 处）：`track-list.js` / `media-wall.js` / `queue-panel.js` 用 thumb；
   `now-playing-panel.js` / `track-info-panel.js` / `player-controller.js`（配色）用 full。
   注意 `resolveCoverColor` 不能直接用 thumb —— 取色要原图，否则平均色会偏。
4. 验收：媒体墙 renderer RSS 215.7MB → ≤180MB；列表/墙滚动无闪烁；正在播放页清晰度不变。

## P1 计划与验收口径

| 项 | 主指标 | 目标 |
| --- | --- | --- |
| P1-1 元数据解析移出主进程 | 冷缓存全量扫描耗时 + 扫描期间 main CPU | 耗时 ≤ 900 ms、主进程 CPU 明显下降、UI 可交互 |
| P1-2 封面缓存分档（thumb/full）| 媒体墙 renderer RSS | ≤ 180 MB，且不留糊图 |
| P1-3 离开媒体墙即释放 | 切走后 renderer RSS 与节点数 | RSS ≤ 180 MB、节点 ≤ 1500，回墙能重建并恢复位置 |
