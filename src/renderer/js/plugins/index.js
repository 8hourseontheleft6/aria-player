/**
 * 插件清单。新增插件：写一个 { id, name, setup(api) } 文件，然后加到这里。
 */

import { trackInfoPanel } from './track-info-panel.js'
import { quickActions } from './quick-actions.js'

export const BUILTIN_PLUGINS = [
  trackInfoPanel,
  quickActions
]
