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
