# 第三方依赖与素材 / Third-party notices

Aria 以 MIT 许可发布（见 [LICENSE](LICENSE)）。下面列出**运行时依赖**、**打包工具**与**素材**的来源与许可。
本仓库不包含任何音乐文件、不内置任何在线音源，也不附带任何第三方 UI 素材包。

## 运行时依赖（会被打进安装包）

| 名称 | 用途 | 许可 | 备注 |
| --- | --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 桌面运行时（含 Chromium 与 Node.js） | MIT | 安装包里还带着 Chromium / Node.js 的第三方组件与各自的许可，见 Electron 发布包内的 `LICENSES.chromium.html` |
| [music-metadata](https://github.com/Borewit/music-metadata) | 读取音频标签与内嵌封面 | MIT | 只在主进程使用 |
| [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) | 独立工作线程中的音源脚本解释器 | MIT | 包含 QuickJS/QuickJS-ng 与 Emscripten 运行时，依各依赖包附带许可分发 |
| [buffer](https://github.com/feross/buffer) | 解释器内部的 Buffer 兼容实现 | MIT | 同时使用 MIT 许可的 base64-js、BSD-3-Clause 许可的 ieee754 |

## 开发/打包工具（不会进安装包）

| 名称 | 用途 | 许可 |
| --- | --- | --- |
| [electron-builder](https://www.electron.build/) | 打 Windows / macOS 安装包 | MIT |
| [Electron](https://www.electronjs.org/)（devDependency） | 本地跑与打包 | MIT |

完整清单（含间接依赖与版本）见 `package-lock.json`；每个包的许可以其自身 `package.json` 为准。

## 素材

| 素材 | 位置 | 来源 | 许可 |
| --- | --- | --- | --- |
| 界面图标 | `src/renderer/js/core/icons.js` | 本项目手写 SVG path（自己画的） | 自有 |
| 字体 | 无 | **不使用 Web 字体**，全部走系统字体（Windows 上回落到 Segoe UI，macOS 上 SF Pro） | 系统自带 |
| 截图 | `docs/screenshots/` 目录里的 PNG | 本项目自己截的界面（不含第三方商标或美术素材） | 自有 |
| 均衡器预设数值 | `docs/equalizer-data.json` | 自己测出来的频响数据 | 自有 |
| 测试夹具（`tests/`） | 运行时由 `npm run fixtures` 或自检脚本生成 | 程序合成的正弦波 WAV / 本机音乐库里复制的一首 mp3（**不进仓库**） | 自有 / 用户本机 |
| 配色与设计参考 | — | 视觉风格参考了 iOS 的观感，但所有颜色、间距、图形都是本项目自己的实现 | 自有 |

## 不在仓库里的东西（也是为了法律风险）

- 没有任何音频文件、没有任何专辑封面、没有任何歌词文本。
- 不内置、不分发任何在线音源脚本（设置页要从你自己的文件导入）。
- 在线歌词（LRCLIB）与在线封面（iTunes / Deezer）**默认关闭或在设置里单独开启**，请求由用户的机器直接发出，
  本项目不代理、不缓存到第三方、也不提供任何内容。

## 商标声明

Aria 与 Apple Inc. 没有任何关系；未获其背书或赞助。文中提到的其它产品名与商标归各自所有者所有。
"iOS"、"macOS"、"Windows" 等名称仅用于**说明兼容性与设计参考**，不表示任何隶属关系。

## sherpa-onnx（运行时，随安装包分发）

- 项目：https://github.com/k2-fsa/sherpa-onnx
- 许可：**Apache License 2.0**
- 在本应用里的形态：npm 包 `sherpa-onnx-node`（N-API 包装）+ 平台包
  `sherpa-onnx-win-x64`（内含 `sherpa-onnx.node`、`sherpa-onnx-c-api.dll`、`onnxruntime.dll`）。
- 用途：在**本机**跑语音识别（「AI 字幕」）。不上传任何音频。

## SenseVoice 模型与 silero VAD 模型（**不随包分发**）

- SenseVoice-small（int8）：HuggingFace 仓库
  `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` 里的 `model.int8.onnx` + `tokens.txt`。
- silero VAD：`silero_vad.onnx`，来自 sherpa-onnx 官方 release（`asr-models`）。
- **这两个模型不打包进安装包**：只有在用户于「设置 → AI 字幕」里**主动点下载**之后，
  才会从上面的下载源取到本机（默认 HuggingFace，备用 hf-mirror.com），
  并在下载前在界面上写明来源与体积。
- **许可**：
  - SenseVoice-small：**FunASR MODEL_LICENSE**（自定义模型许可，**不是 OSI 认证的开源许可**）
    <https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE>
  - silero VAD：**MIT** <https://github.com/snakers4/silero-vad/blob/master/LICENSE>
- 我们只分发**下载地址与 SHA256**，不分发模型本身。使用这些模型需要遵守上面各自的许可。
