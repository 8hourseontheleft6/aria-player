'use strict'

/**
 * Aria Unified 的入口（一个安装包，两种模式）。
 *
 * 只声明"我是哪个产品"，**不预设档位** —— 档位由启动方式决定（见 src/main/profile.js）：
 *   点图标启动          → 没有音频文件 → full（完整版）
 *   双击音频 / 文件关联 → argv 里有真实音频文件 → player（轻量播放器，直接播）
 *   显式 --profile=…    → 覆盖上面两条（调试用）
 *
 * 为什么用环境变量而不是把 argv 改一改：electron-builder 只能给一个 `main`，
 * 让入口自己声明身份最直白，也不会污染用户的命令行。
 */
process.env.ARIA_PRODUCT = 'unified'

require('./main')
