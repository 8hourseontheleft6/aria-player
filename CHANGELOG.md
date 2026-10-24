# 变更历史 / Changelog

## 0.2.0-beta.3

收尾版：把自动更新闭环，修掉 beta.2 里"更新源仍是 GitHub provider"的问题。

- **更新源彻底换成固定 feed**：`updates/<产品>/latest.yml`（raw.githubusercontent）+ generic provider。
  不再使用 GitHub provider / channel —— 那个字段同时是"预发布通道"和 yml 后缀，
  一设就让 beta 版匹配不上 releases.atom。
- **feed 由 Release 资产生成**：sha512 与 size 都取自**上传后的资产**，不是本地文件。
- 本版起，装好的 beta.3 点「设置 → 关于 → 检查更新」能读到真实 feed 并正确提示「已是最新版本」。
- 其余与 0.2.0-beta.2 相同。

## 0.2.0-beta.2

- 11 项 0.2.0 功能齐活：ReplayGain、崩溃日志 + 诊断包、自动更新、无缝播放（预加载）、
  续播、队列拖动排序、右键菜单（定位/复制路径）、最近添加·最近播放、重复检测、
  设置导出/导入、内置 silero VAD。
- `npm run check` 扩到 20 步；本体 227 条、player 39 条、Unified 10+4 条自检。

## 0.2.0-beta.1

- 安全与健壮性：IPC 全量参数、设置原子写与密钥不回传、翻译缓存键补全、音源脚本 QuickJS 沙箱。

## 0.1.1

- 同上（PR #1 的 rebase-merge）。

## 0.1.0

- 首个公开版本：本地 AI 字幕（含可选校正/翻译）、按封面取色、m3u 导入导出。
