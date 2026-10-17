'use strict'

/**
 * Aria Player 的入口（轻量音频播放器）。
 *
 * 为什么要有这个 3 行的文件，而不是在打包配置里想办法传 `--profile=player`：
 * 两个产品共用同一份代码，而 electron-builder 只能给一个 `main` —— 换入口最直白。
 * `ARIA_PROFILE` 只是"构建期默认值"：命令行里显式写 `--profile=full` 仍然优先，
 * 调试时可以直接用本体跑这个入口（`ARIA_PROFILE=full npx electron .` 同理反之）。
 *
 * 身份必须在这里（而不是在 bootstrap 里）确定，因为 main.js 会在
 * requestSingleInstanceLock() **之前**按档位设置 userData —— 两个产品的设置与缓存各自独立，
 * 而 Electron 的单实例锁正是按 userData 目录区分的，于是两者可以同时开着、互不干扰。
 */
process.env.ARIA_PROFILE = 'player'

require('./main')
