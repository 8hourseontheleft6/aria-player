# 发版流程 / Releasing

## 找安装包 / 清理旧产物 / 归档旧版本

每打一次包，`release*/` 里就多一对 exe；几十个版本之后很难找。四个命令解决：

```bash
npm run artifacts              # 只列当前版本（package.json 的 version）那六个，带体积与 SHA256
npm run artifacts -- --all     # 再加上历史归档（release*/_archive/<版本>/）
npm run clean:dist             # 旧版本**归档**到 release*/_archive/<版本>/，并清掉 win-unpacked/.icon-ico
npm run clean:dist -- --purge  # 真要删（不归档）
npm run clean:dist -- --keep-unpacked   # 要直接跑打包产物时保留 win-unpacked
npm run fetch-release 0.1.0    # 把 GitHub Releases 上的某个旧版本拉回本地归档（用 API 的 digest 校验）
```

**归档布局**（三个产品各一个目录，`clean:dist` 与 `fetch-release` 都往这里放）：

```
release/_archive/<版本>/          ← Aria-Setup / Aria-portable
release-player/_archive/<版本>/   ← Aria-Player-Setup / -portable
release-unified/_archive/<版本>/  ← Aria-Unified-Setup / -portable
```

`clean:dist` **默认是归档不是删除** —— 0.1.1 发布时手一抖把 beta 系列的本地安装包删掉过一次，
所以默认行为改成"先留着，要删得显式写 `--purge`"。`fetch-release` 可以随时把发布过的版本
从 GitHub 拉回来（已归档且校验通过的文件会跳过）。

（`release*/` 全部在 .gitignore 里，发布走 GitHub Releases，不进仓库。）

## 发 Release 时必须带上 latest.yml

electron-builder 配了 `publish: github`，每次打包会在 `release*/` 里生成 `latest.yml`。
**上传附件时一并传它**（六个安装包 + `latest.yml`），否则 electron-updater 会报
`Cannot find latest.yml`。0.1.0 / 0.1.1 是在配 publish 之前打的包，所以那两个 Release 里没有它。

## 仓库地址与署名（已填好）

发布用的仓库地址已经写进 `package.json`，不需要再替换：

| 位置 | 现在的值 |
| --- | --- |
| `package.json` → `repository.url` | `https://github.com/8hourseontheleft6/aria-player.git` |
| `package.json` → `homepage` | `https://github.com/8hourseontheleft6/aria-player#readme` |
| `package.json` → `bugs.url` | `https://github.com/8hourseontheleft6/aria-player/issues` |

署名：`package.json` 的 `author` 与 `LICENSE` 的版权人保持一致（`deepseek` / 「8左边的白马6」）。


## 版本号怎么定

- 公开前是 `0.1.0-beta.NN`（开发中，接口可能变）。**第一次公开发布建议 `0.1.0`**（去掉 `-beta`）：
  这是"第一个能用的公开版"，不是 1.0 —— 语义化版本里 `0.x` 本来就不承诺稳定性。
- 之后：`0.1.x` 修 bug，`0.2.0` 加功能，`1.0.0` 留给"接口与数据结构冻结"。
- 三个产品（Aria / Aria Player / Aria Unified）**共用一个版本号**，一次发三套包。

```bash
# 1. 改版本（三套包会跟着走）
node -e "const fs=require('fs');const p=require('./package.json');p.version='0.1.0';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
node scripts/make-mac-source-zip.js   # 源码包也要重打（check 会核对指纹）
npm run check                          # 必须全绿
```

## 打标签 → CI 出包

`.github/workflows/build-mac.yml` 监听 `v*` 与 `stable-*` 标签：推标签即出 macOS 的 dmg + zip（arm64 + x64），
产物在 Actions 页面下载。Windows 包目前**在本地打**（见下），因为要保证用本机的 `winCodeSign` 缓存。

```bash
git tag -a v0.1.0 -m "Aria 0.1.0"
git push origin v0.1.0
```

## 本地出三套包（Windows）

```bash
npm run dist            # Aria            → release/Aria-Setup-<ver>.exe + Aria-<ver>-portable.exe
npm run dist:player     # Aria Player     → release-player/
npm run dist:unified    # Aria Unified    → release-unified/
```

产物**不进仓库**（`.gitignore` 挡着 `release*/`）。

## 上传到 GitHub Releases

每个 release 上传 **六个**文件 + 一份校验和：

| 产品 | 文件 |
| --- | --- |
| Aria | `Aria-Setup-<ver>.exe`、`Aria-<ver>-portable.exe` |
| Aria Player | `Aria-Player-Setup-<ver>.exe`、`Aria-Player-<ver>-portable.exe` |
| Aria Unified | `Aria-Unified-Setup-<ver>.exe`、`Aria-Unified-<ver>-portable.exe` |

```bash
# 在 release 目录下算 SHA256，贴进 Release 说明
Get-FileHash -Algorithm SHA256 release\*.exe, release-player\*.exe, release-unified\*.exe |
  ForEach-Object { '{0}  {1}' -f $_.Hash.ToLower(), (Split-Path $_.Path -Leaf) } |
  Set-Content SHA256SUMS.txt
```

Release 说明里请写明：

- 三个产品**分别是什么**、该下哪个（一句话）；
- **未签名**：Windows SmartScreen / macOS Gatekeeper 会拦，首次如何放行（见 README「未签名构建」）；
- 三个包各自的 **SHA256**；
- 不提供任何内容、仅供个人学习；在线补全默认关闭（如开启，说明会向哪发请求）。

## 发完自检

- [ ] `npm ci && npm run check` 在干净 clone 里全绿
- [ ] 三个 Setup 与三个 portable 都能装上/跑起来，`FileVersion` 等于新版本号
- [ ] `git ls-files` 里没有 `release*/`、`*.log`、`tests/`
- [ ] Release 页面上的 SHA256 与本地一致
- [ ] README 里"版本见 package.json"这句话不需要改（它引用的是文件，不是写死的号）
