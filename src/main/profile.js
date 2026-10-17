'use strict'

/**
 * 产品档位：一个代码库、两个产品。
 *
 *   full   本体（Aria）：资料库、艺人/专辑、歌词、在线补全、媒体墙……现有全部能力
 *   player 轻量音频播放器（Aria Player）：打开任意位置的音频文件、队列与播放控制，
 *          没有资料库扫描、没有艺人/专辑页、没有歌词与在线查图
 *
 * 这份表是**唯一事实来源**，main.js 照着它挂载，scripts/checks/check-profiles.js 照着它判定。
 * 为什么不是到处写 `if (profile === 'player')`：那种写法每加一个功能就要回头补一处判断，
 * 漏一处就是"产品里冒出一个它不该有的能力"。这里改成**按表挂载** —— 没挂上的服务就是不存在，
 * 消费方只问"这个能力在不在"（ctx.has），不问"我是什么档位"。
 *
 * 档位来源：命令行 `--profile=player`（默认 full）。**刻意不做成设置项**：
 * 它决定的是"这是哪个产品"，不是用户偏好；设置项会让同一份安装包出现两副面孔，
 * 而两个产品的 userData 必须各自独立（见第 2 步）。
 */

/** 每个档位允许挂载的服务。check-profiles 会把这些名字和 main.js 的工厂表逐一对上。 */
const PROFILES = {
  full: {
    id: 'full',
    productName: 'Aria',
    // 现有 9 个服务，一个不多一个不少（守卫按棘轮盯着，掉一个就红）
    services: [
      'settings',
      'library',
      'lyrics',
      'online',
      'ai',
      'musicSources',
      'tray',
      'watcher',
      'background'
    ],
    // 渲染层插件：能力由"注册不注册"决定，online-media 不注册 = 没有在线歌词/封面
    plugins: ['trackInfoPanel', 'quickActions', 'onlineMedia'],
    // 侧栏是数据驱动的（store.js 的 sidebarOrder），短清单即可
    sidebar: ['songs', 'albums', 'artists', 'wall']
  },
  player: {
    id: 'player',
    productName: 'Aria Player',
    /*
     * 只有两个：设置 + 「打开的文件」。
     * 注意这里**没有** library / watcher / online / lyrics —— 少了它们，
     * 资料库扫描、目录监听、在线查图在 player 里根本不存在（而不是"存在但关掉了"）。
     */
    services: ['settings', 'openedFiles'],
    // 一个插件都不注册：没有在线歌词/封面，也没有曲目信息面板
    plugins: [],
    /*
     * 只有一份列表（打开的文件）。视图 id 仍叫 songs —— 渲染层的歌曲列表是"一列曲目"
     * 这个通用件，player 里它渲染的就是当前打开的文件（第 3 步接线）。
     */
    sidebar: ['songs']
  }
}

const DEFAULT_PROFILE = 'full'

/**
 * 从命令行解析档位。
 * 支持 `--profile=player` 与 `--profile player` 两种写法。
 *
 * @param {string[]} argv
 * @returns {{ id: string, requested: string|null, error: string|null, profile: object }}
 */
function resolveProfile (argv = process.argv) {
  let requested = null
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg.startsWith('--profile=')) requested = arg.slice('--profile='.length)
    else if (arg === '--profile') requested = argv[i + 1]
  }
  if (requested === null || requested === '') {
    return { id: DEFAULT_PROFILE, requested: null, error: null, profile: PROFILES[DEFAULT_PROFILE] }
  }
  const id = String(requested).trim()
  if (!PROFILES[id]) {
    /*
     * 认不出的档位**要吵**，不要静默退回 full：
     * 打包时写错一个字母（--profile=plyer）如果悄悄变成本体，
     * 那台机器上就会装出一个"名字叫 Player、其实是完整版"的东西，而且没人会发现。
     */
    return {
      id: DEFAULT_PROFILE,
      requested: id,
      error: `认不出的档位「${id}」（可选：${Object.keys(PROFILES).join(' / ')}）`,
      profile: PROFILES[DEFAULT_PROFILE]
    }
  }
  return { id, requested: id, error: null, profile: PROFILES[id] }
}

module.exports = { PROFILES, DEFAULT_PROFILE, resolveProfile }
