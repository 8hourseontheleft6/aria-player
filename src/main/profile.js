'use strict'

/**
 * 一个代码库、三个产品（**不许 fork 代码**：三张身份证，同一份实现）。
 *
 *   产品（PRODUCTS）——"我是哪个安装包"，由入口文件用 ARIA_PRODUCT 声明：
 *     aria     本体 Aria（原产品，行为一个字都不动，userData 继续用 Electron 默认目录）
 *     player   Aria Player（轻量播放器，固定 player 档位）
 *     unified  Aria Unified（**一个安装包两种模式**，启动时按 argv 决定档位）
 *
 *   档位（PROFILES）——"这次跑哪些能力"，决定挂哪些服务、注册哪些插件、侧栏几项：
 *     full     资料库、艺人/专辑、歌词、在线补全、媒体墙……现有全部能力
 *     player   打开任意位置的音频文件、队列与播放控制；没有资料库/艺人/专辑/歌词/在线查图
 *
 * 为什么要分两层：Unified 的两种模式必须**各有自己的 userData**
 * （`Aria Unified (full)` 与 `Aria Unified (player)`），否则"完整模式开着时再双击音频"
 * 会撞上同一个单实例锁，文件被塞给完整版去导入 —— 而需求要的是**起一个真正的 player 进程**。
 *
 * 这份表是**唯一事实来源**：main.js 照着它挂载，scripts/checks/check-profiles.js 照着它判定。
 * 为什么不是到处写 `if (profile === 'player')`：那种写法每加一个功能就要回头补一处判断，
 * 漏一处就是"产品里冒出一个它不该有的能力"。这里改成**按表挂载** —— 没挂上的服务就是不存在，
 * 消费方只问"这个能力在不在"（ctx.has），不问"我是什么档位"。
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
    /*
     * 能力标记：给**渲染层**判断用的、与上面两条同源的布尔量。
     *
     * 为什么需要它：渲染层有些启动路径会去问主进程要资料库（例如 app.js 的 loadLibrary），
     * 而 player 档位没有 library 服务 —— 那个 IPC 会被兜成 null，渲染层再拿它当数组用就报
     * "tracks is not iterable"（第 2 步的截图抓到的就是这个错误提示）。
     * 与其在几十处写空值防御，不如让渲染层问一句"这个产品有没有资料库能力"。
     * 这三个标记**必须与 services / plugins 一致**，check-profiles 会逐条交叉验证。
     */
    capabilities: { library: true, online: true, lyrics: true, sources: true, visualizer: true },
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
    // 三个能力都没有 —— 与上面的 services / plugins 严格对应
    capabilities: { library: false, online: false, lyrics: false, sources: false, visualizer: false },
    /*
     * 只有一份列表（打开的文件）。视图 id 仍叫 songs —— 渲染层的歌曲列表是"一列曲目"
     * 这个通用件，player 里它渲染的就是当前打开的文件（第 3 步接线）。
     */
    sidebar: ['songs']
  }
}

const DEFAULT_PROFILE = 'full'

/**
 * 产品表。"我是哪个安装包"。
 *
 *   presetProfile  固定档位（Aria Player 永远是 player）；null 表示"启动时再定"
 *   userDataMode   'default' 用 Electron 默认目录；'product-profile' 用 `<产品名> (<档位>)`
 *
 * 注意 Aria 本体是 'default'：现有用户的资料库/缓存都在原处，升级后不能"我的歌不见了"。
 */
const PRODUCTS = {
  aria: {
    id: 'aria',
    productName: 'Aria',
    appId: 'com.aria.player',
    presetProfile: null,
    userDataMode: 'default'
  },
  player: {
    id: 'player',
    productName: 'Aria Player',
    appId: 'com.aria.player.lite',
    presetProfile: 'player',
    userDataMode: 'product-profile'
  },
  unified: {
    id: 'unified',
    productName: 'Aria Unified',
    appId: 'com.aria.player.unified',
    presetProfile: null,
    userDataMode: 'product-profile'
  }
}

const DEFAULT_PRODUCT = 'aria'

/**
 * 认产品。`ARIA_PRODUCT` 由入口文件声明（main-unified.js 设 unified）。
 * 兼容旧入口：main-player.js 只设 `ARIA_PROFILE=player` —— 那种情况下也算 player 产品。
 * 认不出的产品**要吵**（与档位同样的理由：静默退回本体等于打出一个名不副实的包）。
 */
function resolveProduct (env = process.env) {
  const raw = String(env.ARIA_PRODUCT || '').trim()
  if (raw) {
    if (!PRODUCTS[raw]) {
      return {
        id: DEFAULT_PRODUCT,
        requested: raw,
        error: `认不出的产品「${raw}」（可选：${Object.keys(PRODUCTS).join(' / ')}）`,
        product: PRODUCTS[DEFAULT_PRODUCT]
      }
    }
    return { id: raw, requested: raw, error: null, product: PRODUCTS[raw] }
  }
  if (String(env.ARIA_PROFILE || '').trim() === 'player') {
    return { id: 'player', requested: 'player', error: null, product: PRODUCTS.player }
  }
  return { id: DEFAULT_PRODUCT, requested: null, error: null, product: PRODUCTS[DEFAULT_PRODUCT] }
}

/** 轻量播放器支持的音频扩展名（与 opened-files.js / fileAssociations 保持一致） */
const AUDIO_EXTENSION_RE = /\.(mp3|m4a|flac|wav|ogg|oga|opus|aac|wma|aiff|aif)$/i

/**
 * 从命令行里挑出**真实存在的**音频文件。
 * Unified 的两种模式靠它区分（带文件 = 轻量，不带 = 完整），
 * 文件关联与 second-instance 用的也是它 —— 同一套判据，不另写一份。
 */
function audioPathsFrom (argv = []) {
  const fs = require('node:fs')
  const list = []
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg || arg.startsWith('-')) continue
    if (!AUDIO_EXTENSION_RE.test(arg)) continue
    try {
      if (fs.statSync(arg).isFile()) list.push(arg)
    } catch {
      // 路径不存在就当没给过
    }
  }
  return list
}

/**
 * 从命令行解析档位。优先级（高 → 低）：
 *   ① `--profile=full|player`（调试用，显式覆盖一切）
 *   ② 产品的固定档位（Aria Player 永远 player）
 *   ③ **Unified 的启动规则**：argv 里有真实存在的音频文件 → player，否则 full
 *   ④ 默认 full
 *
 * 支持 `--profile=player` 与 `--profile player` 两种写法。
 *
 * @param {string[]} argv
 * @param {object} [product] resolveProduct() 的 product（不传就自己认一次）
 * @returns {{ id: string, requested: string|null, error: string|null, profile: object, reason: string }}
 */
function resolveProfile (argv = process.argv, product = resolveProduct().product) {
  let requested = null
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i])
    if (arg.startsWith('--profile=')) requested = arg.slice('--profile='.length)
    else if (arg === '--profile') requested = argv[i + 1]
  }
  let reason = 'explicit'
  /*
   * ① 显式覆盖优先 —— 后面两条只是"没指定时怎么猜"。
   */
  if (requested === null || requested === '') {
    if (product && product.presetProfile) {
      requested = product.presetProfile
      reason = 'product-preset'
    } else if (product && product.id === 'unified') {
      /*
       * ③ Unified 的启动规则：**带音频文件启动 = 轻量播放器**，否则完整版。
       * 判据是"文件真的存在"，不是"参数里出现了 .mp3 字样"：
       * 资源管理器双击过来的路径一定是真实文件；而 `--foo.mp3` 这种不该被当成文件。
       */
      const audio = audioPathsFrom(argv)
      requested = audio.length ? 'player' : 'full'
      reason = audio.length ? 'argv-audio' : 'argv-empty'
    } else {
      requested = DEFAULT_PROFILE
      reason = 'default'
    }
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
      profile: PROFILES[DEFAULT_PROFILE],
      reason
    }
  }
  return { id, requested: id, error: null, profile: PROFILES[id], reason }
}

/**
 * 这个产品这个档位该用哪个 userData 目录名。
 *
 *   aria  → null（Electron 默认目录，行为与改动前完全一致）
 *   其余  → `<产品名> (<档位>)`：Aria Player (player) / Aria Unified (full) / Aria Unified (player)
 *
 * 三个产品之间绝不共用目录；Unified 的两种模式也各有各的 —— 这是"完整模式开着时
 * 双击音频还能起一个真正的 player 进程"的前提（Electron 的单实例锁按 userData 算）。
 */
function userDataDirName (product, profileId) {
  if (!product || product.userDataMode === 'default') return null
  return `${product.productName} (${profileId})`
}

function userDataDirFor (appDataDir, product, profileId) {
  const name = userDataDirName(product, profileId)
  return name ? require('node:path').join(appDataDir, name) : null
}

/**
 * 兼容旧签名（Aria Player 的自检与 main.js 早期代码用它）。
 * 语义没变：非 full 档位 → `<产品名> (<档位>)`；full → null。
 */
function profileUserDataDir (appDataDir, profile) {
  if (!profile || profile.id === DEFAULT_PROFILE) return null
  return require('node:path').join(appDataDir, `${profile.productName} (${profile.id})`)
}

/**
 * Windows 的任务栏身份（AppUserModelID）。
 *
 * 为什么要按**模式**再分一层：Aria Unified 的两种模式是两个进程、两套 userData，
 * 但它们的 exe 是同一个文件 —— Windows 会按 exe 路径把它们并成**一个任务栏按钮**，
 * 于是"完整版开着、又起了 player"在任务栏上看起来只有一个窗口，点它就是完整版。
 * 加上模式后缀（.full / .player）之后，两者各自一个按钮、各自可以单独切换。
 *
 * 前两个产品不受影响：Aria 仍是 com.aria.player、Aria Player 仍是 com.aria.player.lite。
 */
function appIdFor (product, profileId) {
  if (!product) return 'com.aria.player'
  if (product.id === 'unified') return `${product.appId}.${profileId}`
  return product.appId
}

module.exports = {
  PROFILES,
  DEFAULT_PROFILE,
  PRODUCTS,
  DEFAULT_PRODUCT,
  AUDIO_EXTENSION_RE,
  resolveProduct,
  resolveProfile,
  audioPathsFrom,
  appIdFor,
  userDataDirName,
  userDataDirFor,
  profileUserDataDir
}
