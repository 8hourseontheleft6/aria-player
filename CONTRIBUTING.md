# 参与 Aria / Contributing

谢谢愿意花时间。这个项目有三条不太一样的地方，先说在前面，免得白跑一趟。

## 1. 这个仓库以「检查」为准绳

`npm run check` 是 13 步静态检查，`npm run smoke` 是界面自检（本体 200+ 条、播放器一套、Unified 一套）。
**任何改动都必须让这些检查保持绿色，一条都不许放宽。** 检查里有很多条是针对真实踩过的坑写的
（`docs/CONVENTIONS.md` 里逐条规定了"为什么这么查"），删断言、改阈值、在断言里写 `|| true`
这类"让步"会被直接打回。

## 2. 怎么跑起来

```bash
npm ci                 # 用 lock 文件装依赖（可复现）
npm start              # 起应用（= electron .）
npm run check          # 13 步静态检查，几秒钟
npm run fixtures       # 生成测试夹具（wav），手工试听用
npm run smoke          # 界面自检：需要 GUI、需要音乐库（见下）
```

`npm run smoke` 的注意事项（很重要，CI 跑不了）：

- 要**真窗口**：它会开浏览器窗口、抢单实例锁、模拟拖放与拖动、还会挪系统光标做"真拖"测试；
- 本体那 200 多条需要**一个真实的音乐文件夹**（默认读 `%USERPROFILE%\Music`）。没有音乐时
  一部分检查会按空库跑，条数不等于验收用的数量；
- 同一时间**只能跑一个实例**（单实例锁），跑之前把已开的 Aria 关掉；
- 播放器与 Unified 各自的套件是自包含的（夹具自己造）：

```bash
npx electron . --smoke --profile=player           # Aria Player 那套
npx electron . --smoke  <某个.wav>                # 模拟"双击文件"进播放器
ARIA_PRODUCT=unified npx electron . --smoke       # Unified 的完整版那一侧
ARIA_PRODUCT=unified npx electron . --smoke <x.wav>  # Unified 的播放器那一侧
```

## 3. 提交信息：首行英文，正文中文

沿用仓库现有风格：

```
fix(player): 清除历史的提示框只有一个图标、没有文字

【根因】toast() 收对象，传字符串解构出 message=undefined …
【验证】player 32/32；反向验证：改回字符串立刻红 …
```

- 首行：`type(scope): 英文一句话`，type 用 `feat / fix / chore / docs / test / refactor`。
- 正文：**中文**，写清"改了什么 / 为什么 / 验证了什么"。有反向验证请把读数贴上来。
- 一个提交只做一件事。版本号与产物别混在功能提交里。

## 4. 提 PR

1. Fork → 开分支（`fix/…`、`feat/…`）；
2. 改完跑 `npm run check`（必须绿）与相关自检（改了界面就跑 `npm run smoke`，把条数贴进 PR 描述）；
3. 用 `.github/PULL_REQUEST_TEMPLATE.md` 写描述，**贴读数**，别只写"已测试"；
4. 别动三件事：三个产品（Aria / Aria Player / Aria Unified）的 `appId` / `productName` / `userData`、
   打包配置、以及既有检查的断言；
5. 别提交 `release*/`、`*.log`、`tests/`、`node_modules/`、`.tmp/`（`.gitignore` 挡着，别加 `-f`）。

## 5. 想改界面

界面是 iOS 观感的手工实现，改之前先读 `docs/DESIGN.md`（视觉与交互约定）和
`docs/CONVENTIONS.md`（每个"反直觉"决定的来由）。改完跑 `npm run shots` 重出截图，
`npm run check` 里的 `check-shots` 会核对"文档引用的图是否都在出图清单里"。

## 6. 想加功能

渲染层有 7 个扩展点（`playbackMode / panel / trackAction / lyricsProvider / artworkProvider /
themeToken / audioTap`），见 `docs/EXTENDING.md`。**优先做成插件**，而不是往核心里塞 if。

## 7. 报告问题

- 普通 bug / 想法：用 `.github/ISSUE_TEMPLATE/` 里的模板；
- 安全问题：**不要开 issue**，按 [SECURITY.md](SECURITY.md) 私下报。

## 8. 行为准则

参与即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
