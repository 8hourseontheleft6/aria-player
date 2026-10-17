/**
 * 插件注册表与档位选择。新增插件：写一个 { id, name, setup(api) } 文件，然后加到这里。
 *
 * 为什么是"注册表 + 按档位挑"而不是直接导出一个数组：
 * 档位要决定的是**注册哪些插件** —— online-media 不注册，在线歌词 / 在线封面这两条能力
 * 就根本不存在（扩展点上没人实现），而不是"功能都在、只是被 if 关掉了"。
 * 档位清单来自主进程（src/main/profile.js，经 preload 的 window.aria.profile 传下来），
 * 渲染层**不抄一份**，两边就不会不一致。
 */

import { trackInfoPanel } from './track-info-panel.js'
import { quickActions } from './quick-actions.js'
import { onlineMedia } from './online-media.js'

/** id → 插件。id 必须与 profile.js 里的清单逐字对应（check-profiles 会核对） */
export const PLUGIN_REGISTRY = {
  trackInfoPanel,
  quickActions,
  onlineMedia
}

/** 全量清单（本体用）；顺序即注册顺序 */
export const BUILTIN_PLUGINS = Object.values(PLUGIN_REGISTRY)

/**
 * 按档位挑出要注册的插件。
 * 传进来的不是数组时退回全量 —— 拿不到档位就别把功能弄丢。
 * @param {string[]} ids profile.plugins
 * @returns {Array<object>}
 */
export function pluginsForProfile (ids) {
  if (!Array.isArray(ids)) return BUILTIN_PLUGINS.slice()
  return ids.map((id) => PLUGIN_REGISTRY[id]).filter(Boolean)
}
