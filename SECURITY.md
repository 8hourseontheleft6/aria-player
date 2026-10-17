# 安全政策 / Security Policy

## 报告漏洞

**请不要开公开 issue。** 请用 GitHub 的「Security → Report a vulnerability」
（Privately report a vulnerability，即 Security Advisory）私下报告，或在仓库主页找到维护者邮箱单独联系。

报告里请尽量包含：

- 受影响的版本（`package.json` 的 `version`）与平台（Windows / macOS，哪个产品：Aria / Aria Player / Aria Unified）
- 复现步骤或最小复现工程
- 影响面：能读到任意文件？能执行任意代码？能绕过渲染层 CSP？
- 你的联系方式（想被署名的化）

我们会在 **72 小时内**确认收到，并在修复后于 release notes 里致谢（除非你希望匿名）。

## 支持范围

只对**最新发布版本**修安全问题；`main` 分支上的开发版不单独出补丁。

## 这个项目在安全上的既有设计（便于你判断哪些是"设计"、哪些是"漏洞"）

- 渲染层 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，**CSP 禁止渲染层联网**；
  所有网络请求由主进程的 `net` 发出。绕不出 CSP 的联网**不是**漏洞，那是既定设计。
- 渲染层能访问本地文件的通道都带白名单：
  - `media://` 只放行「资料库根目录内」或「这次/最近打开过的文件」；
  - `opened:artwork` 只放行已打开文件的封面，读不到就返回 null。
  如果能读到白名单外任意路径，**是**漏洞，请报告。
- 在线歌词/封面/音源**默认关闭**（或需在设置里单独打开）；音源是用户自己导入的脚本，
  不随本项目分发 —— 因此"导入的脚本能做什么"属于用户自担风险，不在本政策范围内。
- 不签名构建（Windows / macOS）会被 SmartScreen / Gatekeeper 拦，这是**已知**的，不是漏洞；
  见 README 的「未签名构建」一节。

## 我们不会做的事

- 不会在安装包里收集遥测或上报数据（应用不联网时也能完整使用）；
- 不会把你的音乐文件名、路径、歌词内容发到任何服务器（在线补全只发歌名/艺人/专辑名，
  且必须是你在设置里打开的）。
