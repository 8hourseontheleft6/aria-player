/** 设置页：iOS 分组列表风格 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { remote } from '../../core/remote.js'
import { formatDurationLong, formatRelativeTime, formatRate, formatBytes } from '../../core/format.js'
import { createSlider } from '../widgets/slider.js'
import { toast } from '../widgets/overlay.js'
import { presetOptions, PRESETS } from '../../core/equalizer-presets.js'

const THEMES = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' }
]

const SHORTCUTS = [
  ['空格', '播放 / 暂停'],
  ['Ctrl + ← / →', '上一首 / 下一首'],
  ['Ctrl + ↑ / ↓', '音量增减 5%'],
  ['← / →', '快退 / 快进 5 秒（正在播放页）'],
      ['← / →', '设置页：在分类之间切换（键盘也能跳分类）'],
  ['Ctrl + L', '打开正在播放与歌词'],
  ['Ctrl + Q', '播放队列'],
  ['Ctrl + B', '显示 / 隐藏边栏'],
  ['Ctrl + O', '添加音乐文件夹'],
  ['Ctrl + F', '搜索（设置页聚焦设置内搜索，其它页聚焦资料库搜索）'],
  ['Ctrl + M', '静音'],
  ['M', '切换播放模式'],
  ['[ / ]', '播放速度 -0.05× / +0.05×'],
  ['中键拖动', '媒体墙：任意方向移动整面墙'],
  ['Alt + 左键拖动', '媒体墙：同上（无中键时）'],
  ['↑ / ↓、回车', '媒体墙以外的列表：移动选择 / 播放'],
  ['列表右上角「⋯」', '开始多选（也可以在歌曲上右键 → 开始多选）'],
  ['Ctrl / ⌘ + 点击', '加进多选（再点一次取消）'],
  ['Shift + 点击', '从上一首到这一首整段选中'],
  ['Ctrl + A', '全选当前列表'],
  ['Esc', '关闭浮层 / 返回上一级 / 收起正在播放 / 退出多选']
]

export function createSettingsView ({ store, bus, player, actions, host }) {
  const element = h('div', { class: 'content-inner view-root' })

  /*
   * 顶部分区导航：设置项多了之后一屏屏翻很累，点一下直接跳到那一大块
   * （按分组标题找锚点，不依赖硬编码索引）。
   * 注意：这两个声明必须在工具栏之前 —— 工具栏里要用 sectionNav，
   * 放在后面就是 TDZ（这个文件已经栽过一次，见 infoLayer）。
   */
  const SECTIONS = [
    { label: '音乐库', groups: ['音乐文件夹'] },
    { label: '播放与音效', groups: ['播放', '均衡器', '歌词'] },
    { label: '外观与系统', groups: ['外观', '系统集成', '快捷键', '系统媒体键'] },
    { label: '在线与扩展', groups: ['在线功能', '在线音源', '插件与扩展点', '外部模型（自填 API）', '封面缓存'] },
    { label: '关于', groups: ['关于'] }
  ]
  // 当前选中的设置分类（两层结构的「第二层」由它决定显示哪一组）
  let activeSection = SECTIONS[0].label
  // 滚动联动是否已绑定（设置页会重渲染多次，避免叠加监听）
  let navScrollBound = false
  // 点击子标题后的静默期：这段时间内联动高亮不生效
  let navClickUntil = 0
  // 是否发生过手动滚动（点击定位不算）
  let navUserScrolled = false
  let navClickTimer = null
  const sectionNav = h('div', {
    class: 'settings-nav',
    role: 'group',
    'aria-label': '设置分类'
  })

  /*
   * 设置内搜索（第 6 步）
   *
   * 外观复用全局 `.search`：放大镜 + 输入框 + 有内容才出现的清空按钮，
   * 与专辑页 / 艺人页的搜索框同一套（见 widgets/search-box.js）。
   * 区别只在行为：这里是在当前页内匹配设置项并滚动定位，不写 ui.query ——
   * ui.query 是过滤资料库的，写进去会把歌曲页/专辑页一起改掉。
   */
  const searchInput = h('input', {
    type: 'search',
    placeholder: '搜索设置（如 歌词 / 封面 / 快捷键）',
    'aria-label': '搜索设置项',
    spellcheck: 'false'
  })
  const searchCount = h('span', { class: 'search__count' })
  const searchClear = h('button', {
    class: 'search__clear',
    type: 'button',
    title: '清空搜索',
    onClick: () => clearSearch()
  }, icon('close', { className: 'icon icon--stroke' }))
  /* 最近搜索面板：与歌曲页同一套 .search-panel 样式，挂在搜索框下面 */
  const settingsHistoryList = h('div', { class: 'search-panel__history' })
  const settingsSearchPanel = h('div', { class: 'search-panel', hidden: true },
    h('div', { class: 'search-panel__row' },
      h('span', { class: 'search-panel__label', text: '最近搜索' }),
      h('button', {
        class: 'search-panel__clear',
        type: 'button',
        title: '清空搜索历史',
        onClick: () => actions.clearSettingsSearchHistory()
      }, '清空')
    ),
    settingsHistoryList
  )
  // 面板里的交互不能把输入框的焦点抢走，否则下拉一开就关
  on(settingsSearchPanel, 'mousedown', (event) => event.preventDefault())

  const searchBox = h('div', { class: 'search search--settings' },
    icon('search', { className: 'icon icon--stroke' }),
    searchInput,
    searchCount,
    searchClear
  )
  const toolbar = h('div', { class: 'view-toolbar' },
    h('div', { class: 'view-toolbar__title', text: '设置' }),
    h('div', { class: 'settings-search-wrap' }, searchBox, settingsSearchPanel)
  )

  const scroll = h('div', { class: 'settings scroll view-body' })

  /*
   * 大标题与子标题行都放进滚动区（与歌曲/专辑页同构：标题是内容的一部分）。
   * 之前只有 view-toolbar__title，而它默认 opacity:0、要工具栏「吸顶」才浮现，
   * 设置页又不滚动 → 整页从头到尾看不到「设置」二字（看图才发现）。
   */
  const pageHeader = h('div', { class: 'view-header' },
    h('h1', { class: 'view-header__title', text: '设置' })
  )
  /*
   * 设置的说明文字统一走这个悬浮提示：鼠标停在 ⓘ 上（或 Tab 聚焦）才显示。
   *
   * 之前每条设置下面都挂着一两行说明，整页又长又碎。说明本身有用，但属于
   * 「需要时才看」的信息 —— 收进 ⓘ 之后主列表只剩「标题 + 控件」，扫一眼就能找到要改的。
   * 注意声明必须在使用之前：上一版把 infoLayer 用在了声明之前，TDZ 直接把渲染层干崩了。
   */
  const infoLayer = h('div', { class: 'setting-tip', hidden: true })

  function hideTip () {
    infoLayer.hidden = true
  }

  /**
   * 把气泡放在**鼠标附近**（右下 12px），而不是按 ⓘ 的位置算。
   * 之前按锚点算，两列布局下常常离指针很远（用户反馈「出现在鼠标右侧很远」）。
   */
  function showTip (anchorNode, text, event) {
    infoLayer.textContent = text
    infoLayer.hidden = false
    const box = infoLayer.getBoundingClientRect()
    const point = event && Number.isFinite(event.clientX)
      ? { x: event.clientX, y: event.clientY }
      : (() => { const r = anchorNode.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom } })()
    let left = point.x + 14
    let top = point.y + 16
    // 贴边时翻到另一侧，别被视口切掉
    if (left + box.width > window.innerWidth - 8) left = Math.max(8, point.x - box.width - 14)
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, point.y - box.height - 12)
    infoLayer.style.left = `${Math.round(left)}px`
    infoLayer.style.top = `${Math.round(top)}px`
  }

  function infoIcon (text) {
    if (!text) return null
    return h('span', {
      class: 'settings__info',
      role: 'img',
      tabindex: '0',
      'aria-label': text,
      onMouseenter: (event) => showTip(event.currentTarget, text, event),
      onMouseleave: hideTip,
      onFocus: (event) => showTip(event.currentTarget, text, null),
      onBlur: hideTip
    }, 'i')
  }

  /*
   * 分类标签独立成一行，放在「设置」标题下面。
   * 原来是塞在工具栏最右侧：5 个标签单行排列会溢出，得左右拖着才看得全
   * （用户反馈「右边的设置标签」）。放在下面成一行、允许换行就不会再溢出。
   */
  const navRow = h('div', { class: 'settings-nav-row' }, sectionNav)

  /*
   * 版本号放在分类标签同一行右侧。
   * 排查问题时第一件事就是确认「你在跑哪一版」，而它原来只在最底部「关于」里
   * （用户反馈「根本看不到版本号」）。这里自带一次 app.info 查询，不依赖别处。
   */
  const navVersion = h('span', { class: 'settings-nav__version', text: '' })
  navRow.appendChild(navVersion)

  remote.app.info().then((info) => {
    navVersion.textContent = `Aria ${info?.version || ''}`
  }).catch(() => {})
  /* ------------------------------------------------------------------
   * 设置内搜索（第 6 步）
   *
   * 关键词同时匹配「设置项标题」与「说明文字」（直接用行元素的文本，最省事也最准）。
   * 回车在匹配项之间循环跳转；滚动位置用 rect 差值算 —— offsetTop 在
   * column-span 多列布局下不可靠（之前实测会把「在线与扩展」判成「关于」）。
   * ------------------------------------------------------------------ */
  let searchHits = []
  let searchIndex = -1

  const clearSearchHits = () => {
    for (const row of scroll.querySelectorAll('.settings__row')) row.classList.remove('is-search-hit')
    for (const group of scroll.querySelectorAll('.settings__group')) group.classList.remove('is-search-hit-group')
    searchHits = []
    searchIndex = -1
  }

  const runSearch = (rawQuery) => {
    const query = (rawQuery || '').trim().toLowerCase()
    clearSearchHits()
    if (!query) {
      searchCount.textContent = ''
      return
    }
    /*
     * 两处都查：设置项行 + 分组标题。
     * 只查行是不够的 —— 用户常按分组名找东西（「封面缓存」「在线音源」「快捷键」），
     * 而这些名字不一定出现在成员行的文本里，于是搜出来是「无匹配」。
     * 分组命中时把它的所有行也算命中：整块亮起来，符合直觉。
     */
    const hit = new Set()
    /*
     * 可搜文本 = 行的文本 + 该行所有 ⓘ 的 aria-label。
     * 说明文字只存在 aria-label 里（infoIcon 的写法），行的 textContent 只有一个 i ——
     * 所以不看 aria-label 的话，「匹配说明文字」这句承诺是空的：
     * 用户按说明里的词找（如「麦克风」）会一无所获。
     */
    const searchableOf = (row) => {
      const tips = [...row.querySelectorAll('.settings__info')]
        .map((node) => node.getAttribute('aria-label') || '')
        .join(' ')
      return ((row.textContent || '') + ' ' + tips).toLowerCase()
    }
    for (const row of scroll.querySelectorAll('.settings__row')) {
      if (searchableOf(row).includes(query)) hit.add(row)
    }
    for (const group of scroll.querySelectorAll('.settings__group')) {
      const title = (group.querySelector('.settings__group-title')?.textContent || '').toLowerCase()
      if (!title.includes(query)) continue
      group.classList.add('is-search-hit-group')
      for (const row of group.querySelectorAll('.settings__row')) hit.add(row)
    }
    // 按 DOM 顺序排，回车逐个跳转才符合阅读顺序
    searchHits = [...hit].sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
    for (const row of searchHits) row.classList.add('is-search-hit')
    searchCount.textContent = searchHits.length ? searchHits.length + ' 项匹配' : '无匹配'
    if (searchHits.length) {
      searchIndex = 0
      scrollToHit(0)
    }
  }

  const scrollToHit = (index) => {
    const target = searchHits[index]
    if (!target) return
    const delta = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    scroll.scrollBy({ top: delta - 16, behavior: 'smooth' })
  }

  /*
   * 渲染「最近搜索」。点一条就把它填进输入框并立刻搜（同时重新提到历史最前），
   * 与歌曲页的交互一致；没有历史时整块隐藏，不占地方。
   */
  const renderSettingsHistory = () => {
    const history = store.get().settings.settingsSearchHistory || []
    settingsHistoryList.replaceChildren(...history.map((item) => h('div', { class: 'search-panel__item' },
      h('button', {
        class: 'search-panel__term',
        type: 'button',
        title: `搜索「${item}」`,
        onClick: () => {
          searchInput.value = item
          searchBox.classList.add('has-value')
          runSearch(item)
          actions.commitSettingsSearch(item)
          searchInput.focus()
          settingsSearchPanel.hidden = true
        }
      }, icon('clock', { className: 'icon icon--stroke' }), h('span', { text: item })),
      h('button', {
        class: 'search-panel__remove',
        type: 'button',
        title: '从历史中移除',
        onClick: () => { actions.removeSettingsSearch(item); renderSettingsHistory() }
      }, icon('close', { className: 'icon icon--stroke' }))
    )))
    settingsHistoryList.hidden = history.length === 0
    return history.length > 0
  }

  on(searchInput, 'focus', () => { settingsSearchPanel.hidden = !renderSettingsHistory() })
  on(searchInput, 'blur', () => { settingsSearchPanel.hidden = true })

  let searchTimer = null

  /* 清空：输入框、匹配高亮、计数、清空按钮显隐一起复位 */
  const clearSearch = () => {
    searchInput.value = ''
    searchTimer = null
    searchBox.classList.remove('has-value')
    runSearch('')
  }

  on(searchInput, 'input', () => {
    // 清空按钮的显隐沿用全局规则：.search.has-value .search__clear
    searchBox.classList.toggle('has-value', Boolean(searchInput.value))
    // 输入时不立刻跳，避免页面在打字过程中乱晃
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => runSearch(searchInput.value), 260)
  })

  on(searchInput, 'keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      actions.commitSettingsSearch(searchInput.value)
      if (!searchHits.length) { runSearch(searchInput.value); return }
      searchIndex = (searchIndex + 1) % searchHits.length
      scrollToHit(searchIndex)
    } else if (event.key === 'Escape') {
      clearSearch()
      searchInput.blur()
    }
  })


  /*
   * 大标题放在工具栏与子标题行之间（eBay…不，是 iOS 设置页的顺序：标题 → 分类 → 内容）。
   * 刻意不把它塞进滚动区：那样要挪动子标题行的父节点，自检立刻报「分类 0 个」——
   * 只是个标题，不值得动结构。
   */
  element.append(toolbar, pageHeader, navRow, scroll, infoLayer)
  // 滚动时气泡会跟丢，直接收起来
  on(scroll, 'scroll', hideTip, { passive: true })

  /* ------------------------------ 小组件 ------------------------------ */

  function card (rows) {
    return h('div', { class: 'settings__card' }, ...rows)
  }

  function group (title, rows, { collapsible = false, collapsed = false, sub = '' } = {}) {
    if (!collapsible) {
      return h('div', { class: 'settings__group' },
        title ? h('div', { class: 'settings__group-title', text: title }) : null,
        card(rows)
      )
    }
    // 可收起分组：默认状态由调用方给，点标题整行切换；箭头跟着转
    let isCollapsed = collapsed
    const body = card(rows)
    const chevron = icon('chevronDown', { className: 'icon icon--stroke' })
    const head = h('button', {
      class: 'settings__group-head',
      type: 'button',
      onClick: () => {
        isCollapsed = !isCollapsed
        wrapper.classList.toggle('is-collapsed', isCollapsed)
        head.setAttribute('aria-expanded', String(!isCollapsed))
      }
    },
    h('span', { class: 'settings__group-title', text: title }),
    sub ? h('span', { class: 'settings__group-sub', text: sub }) : null,
    h('span', { class: 'settings__group-spacer' }),
    chevron
    )
    const wrapper = h('div', { class: `settings__group is-collapsible${collapsed ? ' is-collapsed' : ''}` }, head, body)
    head.setAttribute('aria-expanded', String(!collapsed))
    return wrapper
  }

  function row ({ title, sub, control, onClick, className = '' }) {
    const node = h(onClick ? 'button' : 'div', {
      class: `settings__row ${className}`.trim(),
      type: onClick ? 'button' : undefined,
      // 整页重建后按它找回焦点（见 render 的开头）
      dataset: { settingId: title },
      onClick
    },
    h('div', { class: 'settings__row-text' },
      h('div', { class: 'settings__row-title' }, h('span', { text: title }), infoIcon(sub))
    ),
    control ? h('div', { class: 'settings__row-control' }, control) : null
    )
    return node
  }

  function switchControl (value, onChange) {
    const node = h('span', {
      class: `switch${value ? ' is-on' : ''}`,
      role: 'switch',
      tabindex: '0',
      onClick: (event) => {
        event.stopPropagation()
        const next = !node.classList.contains('is-on')
        node.classList.toggle('is-on', next)
        onChange(next)
      }
    })
    return node
  }

  function segmented (items, current, onChange) {
    const thumb = h('div', { class: 'segmented__thumb' })
    const node = h('div', { class: 'segmented' }, thumb)
    const buttons = items.map((item) => h('button', {
      class: `segmented__item${item.id === current ? ' is-selected' : ''}`,
      type: 'button',
      text: item.label,
      dataset: { id: item.id },
      onClick: () => {
        for (const button of buttons) button.classList.toggle('is-selected', button.dataset.id === item.id)
        paint()
        onChange(item.id)
      }
    }))
    node.append(...buttons)

    function paint () {
      const active = buttons.find((button) => button.classList.contains('is-selected'))
      if (!active) return
      thumb.style.width = `${active.offsetWidth}px`
      thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`
    }
    requestAnimationFrame(paint)
    return node
  }

  function sliderControl ({ min, max, step, value, format, onChange, width = 200 }) {
    const holder = h('div', { style: { width: `${width}px` } })
    const slider = createSlider({
      className: 'slider--thin',
      min,
      max,
      step,
      value,
      formatTooltip: format,
      onInput: (next) => {
        onChange(next)
        valueLabel.textContent = format(next)
      }
    })
    const valueLabel = h('span', { class: 'settings__row-value', text: format(value) })
    holder.appendChild(slider.element)
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, holder, valueLabel)
  }

  /* ------------------------------ 渲染 ------------------------------ */

  /**
   * 输出设备列表缓存在**工厂作用域**里（不是 render 里）。
   *
   * 之前放在 render 内，于是每次改设置整页重建 → 列表清空 → 下拉框先变短（只剩「跟随系统」）
   * → 异步 enumerateDevices 回来再变长。用户看到的「突然变短然后变长」就是这个
   * （用户反馈里点名了输出设备那个框）。
   */
  let outputDevices = []
  let outputDevicesLoaded = false
  let outputDevicesListenerAdded = false
  let sectionNavListenerAdded = false

  function render () {
    const state = store.get()
    const settings = state.settings
    const library = state.library
    /*
     * 记住滚动位置。
     * 每改一条设置都会 store 变化 → 整页重建，而重建后的新节点从 scrollTop 0 开始 ——
     * 用户在下面调完一项就被弹回顶部（用户反馈的「调好了之后会直接跳到最上面」）。
     * 重建前存、重建后还原，顺便把「正在交互的元素」也恢复焦点。
     */
    const previousScroll = scroll.scrollTop
    const activeId = document.activeElement?.dataset?.settingId || null
    clear(scroll)

    /* ---------- 音乐文件夹 ---------- */
    const folderRows = []
    if (!library.folders.length) {
      folderRows.push(h('div', { class: 'settings__empty', text: '还没有添加音乐文件夹。添加后 Aria 会递归扫描其中的音频文件，并读取内嵌封面与同名歌词。' }))
    } else {
      for (const folder of library.folders) {
        const count = library.tracks.filter((track) => track.path.startsWith(folder)).length
        folderRows.push(row({
          title: folder.split(/[\\/]/).filter(Boolean).pop() || folder,
          sub: `${folder}　·　${count} 首`,
          control: h('button', {
            class: 'btn btn--icon-sm',
            type: 'button',
            title: '移除',
            onClick: (event) => {
              event.stopPropagation()
              actions.removeFolder(folder)
            }
          }, icon('trash', { className: 'icon icon--stroke' }))
        }))
      }
    }

    folderRows.push(h('div', { class: 'settings__actions' },
      h('button', { class: 'btn btn--primary', type: 'button', onClick: () => actions.addFolder() }, icon('plus'), '添加文件夹'),
      h('button', { class: 'btn', type: 'button', onClick: () => actions.rescan(true) }, icon('refresh', { className: 'icon icon--stroke' }), '重新扫描')
    ))

    const withLyrics = library.tracks.filter((track) => track.lyricsPath).length
    const totalSize = library.tracks.reduce((sum, track) => sum + (track.size || 0), 0)
    folderRows.push(row({
      title: '资料库统计',
      sub: [
        `${library.tracks.length} 首`,
        formatDurationLong(library.totalDuration),
        formatBytes(totalSize),
        `带歌词 ${withLyrics} 首`,
        `上次扫描：${formatRelativeTime(library.scannedAt)}`
      ].join('　·　')
    }))

    scroll.appendChild(group('音乐文件夹', folderRows))

    /* ---------- 外观 ---------- */
    scroll.appendChild(group('外观', [
      row({
        title: '主题',
        control: segmented(THEMES, settings.theme, (theme) => actions.setTheme(theme))
      }),
      row({
        title: '在列表中显示封面',
        sub: '关闭后列表更紧凑，滚动更快',
        control: switchControl(settings.showRowArtwork, (value) => actions.setSetting({ showRowArtwork: value }))
      }),
      row({
        title: '减少动画',
        sub: '关闭所有过渡与弹簧动画',
        control: switchControl(Boolean(settings.reduceMotion), (value) => actions.setSetting({ reduceMotion: value }))
      }),
      row({
        title: '侧边栏打开时也显示灵动岛',
        sub: '默认两者不同时出现：侧边栏开着时它就是导航，收起后才由标题栏正中的灵动岛接管。打开这个开关，灵动岛会一直在（位置与顺序都和侧栏一致）',
        control: switchControl(settings.islandWithSidebar === true, (value) => actions.setSetting({ islandWithSidebar: value }))
      }),
      row({
        title: '显示帧率',
        sub: '在右下角显示实时帧率与帧耗时（最近两秒平均 · 最差）。拖动媒体墙、开合视图时可以直观看到数字，方便确认卡顿是否真的消失',
        control: switchControl(settings.showFps === true, (value) => actions.setSetting({ showFps: value }))
      })
    ]))

    /* ---------- 播放 ---------- */
    /*
     * 「当前判定依据」要现算：它跟着正在播放的歌走。
     */
    const basis = actions.equalizerBasis ? actions.equalizerBasis() : null
    const basisLabel = (() => {
      if (!settings.equalizer?.enabled) return '均衡器已关闭'
      if (settings.equalizer?.auto === false) return '手动选择的预设'
      const parts = []
      if (basis?.byAudio) parts.push(`声音（低音 ${basis.byAudio.features.bassRatio.toFixed(2)}、过零 ${Math.round(basis.byAudio.features.zcr)}、峰值因数 ${basis.byAudio.features.crest.toFixed(1)}）`)
      if (basis?.byMetadata) parts.push(`标签（${basis.byMetadata}）`)
      return parts.length ? parts.join(' + ') : '还没有线索'
    })()
    /*
     * 输出设备列表要现取：插拔耳机、切蓝牙都会变。
     * 名字需要 media 权限（主进程已放行），拿不到就退化成「输出设备 N」。
     */
    const outputSelect = h('select', { class: 'settings__select' })
    function paintOutputDevices () {
      const current = store.get().settings.audioOutputDevice || ''
      outputSelect.replaceChildren(
        h('option', { value: '', text: '跟随系统' }),
        ...outputDevices
          .filter((device) => device.deviceId && device.deviceId !== 'default')
          .map((device, index) => h('option', {
            value: device.deviceId,
            text: device.label || `输出设备 ${index + 1}`
          }))
      )
      outputSelect.value = current
    }
    async function loadOutputDevices () {
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        outputDevices = list.filter((device) => device.kind === 'audiooutput')
        outputDevicesLoaded = true
      } catch {
        outputDevices = []
      }
      paintOutputDevices()
    }
    on(outputSelect, 'change', () => actions.setOutputDevice(outputSelect.value))
    paintOutputDevices()
    // 已经有缓存就不再异步刷一遍（否则每次改设置都会重放一次宽度跳动）
    if (!outputDevicesLoaded) loadOutputDevices()
    if (!outputDevicesListenerAdded) {
      navigator.mediaDevices?.addEventListener?.('devicechange', loadOutputDevices)
      outputDevicesListenerAdded = true
    }

    /*
     * 均衡器独立成一个子菜单（用户反馈：每大块再细分一下）。
     * 折叠标题上直接写清当前状态（开关 / 自动 / 生效预设），
     * 展开后是完整设置 + 十段增益的可视化。
     */
    const eqPresetSelect = h('select', { class: 'settings__select' })
    eqPresetSelect.replaceChildren(...presetOptions().map((option) =>
      h('option', { value: option.value, text: option.label })))
    eqPresetSelect.value = settings.equalizer?.preset || 'flat'
    eqPresetSelect.disabled = settings.equalizer?.auto !== false
    on(eqPresetSelect, 'change', () => actions.setEqualizer({ preset: eqPresetSelect.value }))

    const eqSnapshot = { preset: basis?.preset, bands: basis?.bands || [] }
    const eqBands = (eqSnapshot ? eqSnapshot.bands : []).map((band) => {
      // 增益范围按 ±8dB 画，超出就截断（数据里最大是 +6）
      const ratio = Math.max(-1, Math.min(1, (band.gain || 0) / 8))
      const height = Math.round(Math.abs(ratio) * 22) + 2
      return h('div', { class: 'eq-band', title: `${band.freq}Hz ${band.gain > 0 ? '+' : ''}${band.gain}dB` },
        h('div', {
          class: `eq-band__bar${ratio < 0 ? ' is-cut' : ''}`,
          style: { height: `${height}px` }
        }),
        h('span', { class: 'eq-band__label', text: band.freq >= 1000 ? `${band.freq / 1000}k` : String(band.freq) })
      )
    })

    const eqState = !settings.equalizer?.enabled
      ? '已关闭'
      : `${settings.equalizer?.auto === false ? '手动' : '自动'} · ${PRESETS[eqSnapshot?.preset]?.displayName || '原声'}`

    scroll.appendChild(group('均衡器', [
      row({
        title: '声音均衡器',
        sub: '按预设给声音做处理（十段均衡 + 压缩 + 混响 + 声场 + 饱和）。预设参数来自 data.json：古典/交响、摇滚/金属、流行/人声、电子/舞曲。开启后音频会改走 WebAudio 输出，极少数设备上第一次播放可能有不到一秒的衔接。',
        control: switchControl(settings.equalizer?.enabled === true,
          (value) => actions.setEqualizer({ enabled: value }))
      }),
      row({
        title: '当前频响',
        sub: '十段增益的实时形状（±8dB 满格）。低于 0dB 的段用另一侧表示。',
        control: h('div', { class: 'eq-bands' }, ...eqBands)
      }),
      row({
        title: '按歌曲风格自动选择',
        sub: '判断顺序：外部模型（如果开了）→ 声音特征 → 流派标签。识别不出来就用你手动选的那一组。',
        control: switchControl(settings.equalizer?.auto !== false,
          (value) => actions.setEqualizer({ auto: value }))
      }),
      row({
        title: '均衡器预设',
        sub: '自动匹配关闭时使用这一组。原声 = 不做任何处理。',
        control: h('div', { class: 'select' }, eqPresetSelect)
      }),
      row({
        title: '用声音辅助判断风格',
        sub: '只看标签常常判不准：本地库里一大半文件没有流派标签，写着「Pop」的合辑里也可能塞着电子和摇滚。打开后 Aria 会解码当前歌曲的中段 30 秒，算三个特征（低音占比 / 过零率 / 峰值因数）来判断风格 —— 全程本地，不联网，结果按曲目缓存。',
        control: switchControl(settings.styleAnalysis !== false,
          (value) => actions.setSetting({ styleAnalysis: value }))
      }),
      row({
        title: '当前判定依据',
        sub: '自动模式实际用了哪条线索。标签来自文件元数据，声音来自上面那套特征分析。',
        control: h('span', { class: 'settings__row-value', text: basisLabel })
      })
    ], { collapsible: true, sub: eqState }))

    scroll.appendChild(group('播放', [
      row({
        title: '输出设备',
        sub: '通话 / 游戏语音时想让对方听不到音乐：把这里选成你的耳机（通话留在原设备）。音乐只进你的耳朵，麦克风拾不到它，对方就什么也听不到。留「跟随系统」则与其它应用共用默认输出。',
        control: h('div', { class: 'select' }, outputSelect)
      }),
      row({
        title: '单击歌曲直接播放',
        sub: '打开后，单击列表里的歌曲就直接播放（默认需要双击，单击只选中）。这个设置对歌曲列表、专辑详情、艺人详情都生效；多选请用行首的勾选框或 Ctrl / Shift 点击',
        control: switchControl(settings.playOnSingleClick === true,
          (value) => actions.setSetting({ playOnSingleClick: value }))
      }),
      row({
        title: '默认播放速度',
        sub: `当前 ${formatRate(settings.playbackRate)}，播放中也可以随时调整`,
        control: sliderControl({
          min: 0.5,
          max: 2,
          step: 0.05,
          value: settings.playbackRate,
          format: formatRate,
          onChange: (value) => player.setRate(value),
          width: 160
        })
      }),
      row({
        title: '保持音调',
        sub: '变速播放时不变调（关闭后类似磁带机效果）',
        control: switchControl(settings.preservesPitch, (value) => player.setPreservesPitch(value))
      }),
      row({
        title: '系统媒体键',
        sub: '全局接管键盘上的播放 / 上一首 / 下一首按键',
        control: switchControl(settings.globalMediaKeys, (value) => actions.setSetting({ globalMediaKeys: value }))
      })
    ]))

    /* ---------- 歌词 ---------- */
    scroll.appendChild(group('歌词', [
      row({
        title: '搜索到歌词时跳到那一句',
        sub: '在「含歌词等」范围里搜到的歌，点开时自动跳到歌词命中的那一句（在结果里悬停可以看到是哪一句）',
        control: switchControl(settings.jumpToMatchedLyric !== false,
          (value) => actions.setSetting({ jumpToMatchedLyric: value }))
      }),
      row({
        title: '全局偏移',
        sub: '正值让歌词提前显示，可用来校准时间轴',
        control: sliderControl({
          min: -3000,
          max: 3000,
          step: 50,
          value: settings.lyricOffsetMs,
          format: (value) => `${value > 0 ? '+' : ''}${Math.round(value)} ms`,
          onChange: (value) => player.setLyricOffset(value)
        })
      }),
      row({
        title: '歌词字号',
        control: sliderControl({
          min: 0.7,
          max: 1.6,
          step: 0.05,
          value: settings.lyricFontScale,
          format: (value) => `${Math.round(value * 100)}%`,
          onChange: (value) => player.setLyricFontScale(value),
          width: 160
        })
      })
    ]))

    /* ---------- 系统集成 ---------- */
    const trayOn = settings.trayEnabled !== false
    scroll.appendChild(group('系统集成', [
      row({
        title: '显示托盘图标',
        sub: '托盘菜单可以播放/暂停、切歌、显示主窗口',
        control: switchControl(trayOn, (value) => actions.setSetting({ trayEnabled: value }))
      }),
      row({
        title: '关闭窗口时最小化到托盘',
        sub: trayOn ? '点关闭按钮只隐藏窗口，音乐继续播放；从托盘菜单可退出' : '需要先打开「显示托盘图标」，否则关闭后将无法找回窗口',
        control: switchControl(Boolean(settings.closeToTray) && trayOn, (value) => actions.setSetting({ closeToTray: value }))
      }),
      row({
        title: '任务栏显示播放进度',
        sub: '在任务栏图标上叠加进度条，并使用缩略图上的上一首/播放/下一首按钮',
        control: switchControl(settings.taskbarProgress !== false, (value) => actions.setSetting({ taskbarProgress: value }))
      }),
      row({
        title: '自动监听音乐目录',
        sub: '目录里新增或删除音乐时自动刷新资料库（复制整张专辑时会等文件安静下来再扫一次）',
        control: switchControl(settings.watchFolders !== false, (value) => actions.setSetting({ watchFolders: value }))
      })
    ]))

    /* ---------- 在线功能 ---------- */
    const onlineOn = Boolean(settings.onlineFeatures)
    const cacheLabel = h('span', { class: 'settings__row-value', text: '—' })
    remote.online.stats().then((info) => {
      if (!info) return
      cacheLabel.textContent = info.files
        ? `${info.files} 个文件 · ${formatBytes(info.size)}`
        : '暂无缓存'
    }).catch(() => { cacheLabel.textContent = '—' })

    const artworkCacheLabel = h('span', { class: 'settings__row-value', text: '—' })
    remote.library.artworkStats().then((info) => {
      if (!info) return
      artworkCacheLabel.textContent = info.files
        ? `${info.files} 张 · ${formatBytes(info.bytes)}`
        : '暂无缓存'
    }).catch(() => { artworkCacheLabel.textContent = '—' })

    scroll.appendChild(group('封面缓存', [
      row({
        title: '磁盘封面缓存',
        sub: '首次读取内嵌封面时会缩到 480px 并存到本地，之后打开专辑或媒体墙只读小文件（源文件变化后自动失效）',
        control: h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        artworkCacheLabel,
        h('button', {
          class: 'btn btn--sm btn--destructive',
          type: 'button',
          onClick: async () => {
            const result = await remote.library.clearArtworkCache()
            toast({
              message: result?.ok ? '封面缓存已清空' : `清理失败：${result?.message || '未知错误'}`,
              type: result?.ok ? 'success' : 'error'
            })
            artworkCacheLabel.textContent = '暂无缓存'
            // 告诉预热器：记账作废，重新补一遍（否则它会以为缓存还在，一直不再预热）
            if (result?.ok) bus.emit('artwork:cache-cleared')
          }
        }, '清空'))
      }),
      row({
        title: '空闲时预热封面',
        sub: '后台一张一张地把封面读进缓存（界面正在加载封面时会自动让路），这样打开媒体墙基本是秒出',
        control: switchControl(settings.prewarmArtwork !== false, (value) => actions.setSetting({ prewarmArtwork: value }))
      })
    ], { collapsible: true }))

    scroll.appendChild(group('在线功能', [
      row({
        title: '在线补全（歌词 / 封面）',
        sub: '开启后会向 LRCLIB（歌词）与 Deezer / iTunes（封面）发起请求。这是本项目联网行为的总闸（歌词与封面都走它），**默认开启**（歌词自动匹配；封面默认不匹配，需要时可在下面单独打开）；想彻底断网就把这里关掉，两者一起停。请求全部由主进程发出，页面本身仍然不能联网。',
        control: switchControl(onlineOn, (value) => actions.setSetting({ onlineFeatures: value }))
      }),
      row({
        title: '在线歌词',
        sub: onlineOn ? '本地没有 .lrc 时向 LRCLIB 查询（含时间轴）' : '需要先打开总开关',
        control: switchControl(settings.onlineLyrics !== false, (value) => actions.setSetting({ onlineLyrics: value }))
      }),
      row({
        title: '在线封面',
        sub: onlineOn ? '歌曲没有内嵌封面、目录里也没有图片时，按「专辑 + 艺人」补齐 600×600 封面' : '需要先打开总开关',
        control: switchControl(settings.onlineCovers !== false, (value) => actions.setSetting({ onlineCovers: value }))
      }),
      row({
        title: '在线缓存',
        sub: '命中的歌词与封面会缓存在本地，未命中的结果 24 小时内不会重复请求',
        control: h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        cacheLabel,
        h('button', {
          class: 'btn btn--sm btn--destructive',
          type: 'button',
          onClick: async () => {
            const result = await remote.online.clearCache()
            toast({
              message: result?.ok ? '在线缓存已清空' : `清理失败：${result?.message || '未知错误'}`,
              type: result?.ok ? 'success' : 'error'
            })
            cacheLabel.textContent = '暂无缓存'
          }
        }, '清空'))
      })
    ]))

    /* ---------- 在线音源 ---------- */
    /*
     * 这里只管「机制」：装载、开关、移除用户自己放进来的音源脚本。
     * 本项目不内置任何音源 —— 没有音源时搜索结果里就不会出现「网络结果」那一块。
     */
    const sourcesHost = h('div', { class: 'settings__sources' })
    const sourcesCount = h('span', { class: 'settings__row-value', text: '—' })
    const downloadDirLabel = h('span', { class: 'settings__row-value', text: '默认（第一个音乐文件夹）' })

    async function refreshSources () {
      let list = []
      let stats = null
      try {
        [list, stats] = await Promise.all([remote.sources.list(), remote.sources.stats()])
      } catch {
        list = []
      }
      sourcesCount.textContent = list.length
        ? `${list.filter((item) => item.enabled).length}/${list.length} 已启用`
        : '尚未添加'
      try {
        const dir = await remote.sources.defaultDownloadDir()
        const configured = store.get().settings.downloadDir
        downloadDirLabel.textContent = configured ? configured : `默认（${dir}）`
      } catch {
        downloadDirLabel.textContent = '默认（第一个音乐文件夹）'
      }
      clear(sourcesHost)
      if (!list.length) {
        sourcesHost.append(h('div', { class: 'settings__sources-empty' },
          '还没有音源。可以「从链接导入」（填一个 .js 脚本的直链），或点「导入脚本」选本地文件，' +
          '也可以点「打开目录」把脚本放进 <userData>/music-sources（目录里的 .js 刷新时自动装载）。'))
        return
      }
      for (const item of list) {
        const call = stats?.calls?.[item.id]
        const callText = call
          ? `搜索 ${call.search} 次 · 成功 ${call.ok} · 失败 ${call.failed}` +
            `${call.lastMs ? ` · 最近 ${call.lastMs}ms` : ''}`
          : '本次会话还没有调用过'
        const isLx = item.kind === 'lx'
        sourcesHost.append(h('div', { class: 'settings__source' },
          h('div', { class: 'settings__source-main' },
            h('div', { class: 'settings__source-name' },
              item.name,
              item.version ? h('span', { class: 'settings__source-version', text: `v${item.version}` }) : null,
              isLx ? h('span', { class: 'settings__source-tag', text: 'LX 兼容 · 仅解析' }) : null,
              item.error ? h('span', { class: 'settings__source-error', text: '装载失败' }) : null
            ),
            h('div', { class: 'settings__source-sub', text: item.error || item.description || item.file }),
            item.lxSources?.length
              ? h('div', { class: 'settings__source-sub', text: `声明的音源：${item.lxSources.map((sub) => `${sub.name}(${sub.key})${sub.actions?.length ? ` [${sub.actions.join(',')}]` : ''}`).join('、')}` })
              : null,
            h('div', { class: 'settings__source-sub', text: callText })
          ),
          switchControl(item.enabled, async (value) => {
            await remote.sources.setEnabled(item.id, value)
            await refreshSources()
          }),
          h('button', {
            class: 'btn btn--sm btn--destructive',
            type: 'button',
            onClick: async () => {
              await remote.sources.remove(item.id)
              toast({ message: `已移除音源「${item.name}」`, type: 'success' })
              await refreshSources()
            }
          }, '移除')
        ))
      }
    }

    const sourceUrlInput = h('input', {
      class: 'settings__input',
      type: 'text',
      spellcheck: false,
      placeholder: 'https://…/source.js'
    })

    scroll.appendChild(group('在线音源', [
      row({
        title: '启用在线音源',
        sub: '打开后，搜索时会同时向已启用的音源查询，结果单独显示在「网络结果」里；可以逐条播放、下载，歌词也会跟着加载。本项目不内置音源，需要你自己导入（脚本访问什么服务、是否合规由你判断）。',
        control: switchControl(settings.onlineSources === true,
          (value) => actions.setSetting({ onlineSources: value }))
      }),
      row({
        title: '从链接导入音源',
        sub: '填一个音源脚本（.js）的直链，由主进程抓下来并校验后装入音源目录',
        control: h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        sourceUrlInput,
        h('button', {
          class: 'btn btn--sm btn--primary',
          type: 'button',
          onClick: async (event) => {
            const url = sourceUrlInput.value.trim()
            if (!url) {
              toast({ message: '先填脚本链接', type: 'info' })
              return
            }
            const button = event.currentTarget
            button.disabled = true
            button.textContent = '导入中…'
            try {
              const result = await remote.sources.installFromUrl(url)
              toast({ message: `已导入音源「${result.name}」`, type: 'success' })
              sourceUrlInput.value = ''
              await refreshSources()
            } catch (err) {
              toast({ message: `导入失败：${String(err?.message || err)}`, type: 'error', duration: 4600 })
            } finally {
              button.disabled = false
              button.textContent = '导入'
            }
          }
        }, '导入'))
      }),
      row({
        title: '多音源管理',
        sub: '批量开关、重新装载、导入本地脚本或直接打开音源目录；下面每条音源都能单独启用/停用/移除，并显示本次会话的调用统计',
        control: h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        sourcesCount,
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: async () => {
            await remote.sources.setAllEnabled(true)
            await refreshSources()
          }
        }, '全部启用'),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: async () => {
            await remote.sources.setAllEnabled(false)
            await refreshSources()
          }
        }, '全部停用'),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: async () => {
            const picked = await remote.sources.pickFile()
            if (!picked || picked.canceled) return
            try {
              const result = await remote.sources.install({ text: picked.text, name: picked.name })
              toast({ message: `已导入音源「${result.name}」`, type: 'success' })
            } catch (err) {
              toast({ message: `导入失败：${String(err?.message || err)}`, type: 'error', duration: 4200 })
            }
            await refreshSources()
          }
        }, '导入脚本'),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: () => remote.sources.openDir()
        }, '打开目录'),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: async () => {
            await remote.sources.reload()
            await refreshSources()
            toast({ message: '已重新装载音源', type: 'success' })
          }
        }, '刷新'))
      }),
      row({
        title: '下载目录',
        sub: '在线结果的下载位置。默认用第一个音乐文件夹 —— 下载进去之后目录监听会自动把它收进资料库',
        control: h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        downloadDirLabel,
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: async () => {
            const dir = await remote.sources.pickDownloadDir()
            if (!dir) return
            await actions.setSetting({ downloadDir: dir })
            await refreshSources()
            toast({ message: `下载目录已改为 ${dir}`, type: 'success' })
          }
        }, '选择目录'),
        h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: async () => {
            await actions.setSetting({ downloadDir: '' })
            await refreshSources()
          }
        }, '用默认'))
      }),
      sourcesHost
    ], {
      collapsible: true,
      // 开着的时候自动展开：用户是来管音源的，不该还要再点一下
      collapsed: settings.onlineSources !== true,
      sub: settings.onlineSources === true ? '已开启' : '默认关闭'
    }))
    refreshSources()

    /* ---------- 插件 ---------- */
    const plugins = host.loaded()
    scroll.appendChild(group('插件与扩展点', [
      row({
        title: '已加载插件',
        sub: plugins.length ? plugins.map((item) => item.name).join('　·　') : '暂无插件',
        control: h('span', { class: 'settings__row-value', text: `${plugins.length}` })
      }),
      ...Object.entries(host.POINTS).map(([pointId, point]) => row({
        title: point.title,
        sub: point.description,
        control: h('span', { class: 'settings__row-value', text: `${host.list(pointId).length} 项` })
      }))
    ], { collapsible: true }))

    /* ---------- 外部模型（自填 API） ---------- */
    /*
     * 密钥处理：只「写」不「读」。
     * 主进程保存的密钥不会回到渲染层，所以输入框留空 = 不改动已有密钥；
     * 想换就填新的，想清空就点旁边的「清除」。这样窗口被截图/投屏也不泄露。
     */
    const ai = settings.ai || {}
    const aiBase = h('input', {
      class: 'settings__input',
      type: 'text',
      spellcheck: 'false',
      placeholder: 'https://api.openai.com/v1',
      value: ai.baseUrl || ''
    })
    const aiModel = h('input', {
      class: 'settings__input',
      type: 'text',
      spellcheck: 'false',
      placeholder: 'gpt-4o-mini / deepseek-chat / qwen2.5:7b',
      value: ai.model || ''
    })
    const aiKey = h('input', {
      class: 'settings__input',
      type: 'password',
      spellcheck: 'false',
      placeholder: ai.key ? '已保存（留空则不修改）' : 'sk-…（本地模型可留空）',
      value: ''
    })
    const saveAi = (patch) => actions.setSetting({ ai: { ...ai, ...patch } })
    on(aiBase, 'change', () => saveAi({ baseUrl: aiBase.value.trim() }))
    on(aiModel, 'change', () => saveAi({ model: aiModel.value.trim() }))
    on(aiKey, 'change', () => {
      if (aiKey.value) saveAi({ key: aiKey.value.trim() })
    })
    const aiTestButton = h('button', {
      class: 'btn btn--sm',
      type: 'button',
      text: '测试连接',
      onClick: async (event) => {
        const button = event.currentTarget
        button.disabled = true
        button.textContent = '测试中…'
        // 输入框里可能刚改还没失焦，测之前先存一次
        await saveAi({
          baseUrl: aiBase.value.trim(),
          model: aiModel.value.trim(),
          ...(aiKey.value ? { key: aiKey.value.trim() } : {})
        })
        const result = await remote.ai.test()
        button.disabled = false
        button.textContent = '测试连接'
        toast({
          message: result?.ok ? result.message : `连接失败：${result?.message || '未知错误'}`,
          type: result?.ok ? 'success' : 'error',
          duration: result?.ok ? 2600 : 5200
        })
        if (result?.ok) aiKey.value = ''
      }
    })
    const aiKeyClear = h('button', {
      class: 'btn btn--sm',
      type: 'button',
      text: '清除密钥',
      onClick: () => {
        aiKey.value = ''
        saveAi({ key: '' })
        toast({ message: '已清除保存的密钥', type: 'success' })
      }
    })

    scroll.appendChild(group('外部模型（自填 API）', [
      row({
        title: '启用外部模型',
        sub: '用你自己填的接口来判断歌曲风格（挑均衡器预设）。协议是 OpenAI 兼容的 /chat/completions，所以 OpenAI、DeepSeek、通义都行，本地跑的 Ollama / LM Studio / vLLM 也只要改接口地址（例如 http://127.0.0.1:11434/v1）。请求由主进程发出：渲染层发不出外部请求，密钥也不会被读回界面。',
        control: switchControl(ai.enabled === true, (value) => saveAi({ enabled: value }))
      }),
      row({
        title: '接口地址',
        sub: '结尾的 /v1 要保留，Aria 会自己拼 /chat/completions。',
        control: h('div', { class: 'settings__field' }, aiBase)
      }),
      row({
        title: '模型名',
        control: h('div', { class: 'settings__field' }, aiModel)
      }),
      row({
        title: '密钥',
        sub: '只存在本机的设置文件里（settings.json），不会上传到别处；界面上不会把已保存的密钥显示出来。本地模型通常不需要密钥。',
        control: h('div', { class: 'settings__field' }, aiKey, aiKeyClear)
      }),
      row({
        title: '连接测试',
        sub: '发一句最小请求验证地址、密钥与模型名。失败时会显示接口的原始错误（密钥已打码）。',
        control: aiTestButton
      }),
      row({
        title: '用它判断风格',
        sub: '关闭后外部模型不参与风格判断（其它用途以后再加）。判断结果会显示成一条提示，并把「当前判定依据」补上模型给出的理由。',
        control: switchControl(ai.useForStyle !== false, (value) => saveAi({ useForStyle: value }))
      })
    ], { collapsible: true, sub: '隐私：只发送歌曲信息与本地特征，音频文件不会上传' }))

    /* ---------- 快捷键 ---------- */
    scroll.appendChild(group('快捷键', SHORTCUTS.map(([key, description]) => row({
      title: description,
      control: h('span', { class: 'kbd', text: key })
    }))))

    /*
     * 系统媒体键单独一组，而且**直接从主进程的注册表渲染**。
     *
     * 之前这一组是手写的，某次整理快捷键列表时被顺手删掉，
     * 于是「哪个键对应哪个操作」的说明就这么消失了（用户反馈）。
     * 现在清单只有一个来源：main/ipc.js 的 MEDIA_KEYS → app:info.mediaKeys。
     */
    const mediaKeys = state.app.info?.mediaKeys || []
    if (mediaKeys.length) {
      const KEY_LABEL = {
        MediaPlayPause: '播放 / 暂停键',
        MediaNextTrack: '下一首键',
        MediaPreviousTrack: '上一首键',
        MediaStop: '停止键'
      }
      const COMMAND_LABEL = {
        'play-pause': '播放 / 暂停',
        next: '下一首',
        previous: '上一首',
        stop: '停止'
      }
      scroll.appendChild(group('系统媒体键', [
        row({
          title: '注册为全局快捷键',
          sub: '在任何程序里按键盘上的媒体键都能控制 Aria。关掉之后系统会把它交还给别的播放器。也可以从托盘菜单里随时切换。',
          control: switchControl(state.settings.globalMediaKeys !== false,
            (value) => actions.setSetting({ globalMediaKeys: value }))
        }),
        ...mediaKeys.map((item) => row({
          title: COMMAND_LABEL[item.command] || item.command,
          control: h('span', { class: 'kbd', text: KEY_LABEL[item.accelerator] || item.accelerator })
        }))
      ], { collapsible: true }))
    }

    /* ---------- 关于 ---------- */
    const info = state.app.info
    scroll.appendChild(group('关于', [
      h('div', { class: 'settings__about' },
        h('div', {}, h('b', { text: 'Aria' }), ` ${info?.version || '0.0.0-dev'} — iOS 设计风格的本地音乐播放器（开发中，尚未发布正式版）`),
        h('div', {}, `Electron ${info?.electron || '-'} · Chromium ${info?.chrome || '-'} · Node ${info?.node || '-'}`),
        h('div', {}, `配置文件目录：${info?.userData || '-'}`)
      ),
      row({
        title: '打开配置目录说明',
        sub: 'settings.json 保存设置，library-cache.json 保存元数据缓存，删除后者会触发一次完整重扫',
        control: h('button', {
          class: 'btn btn--sm',
          type: 'button',
          onClick: () => actions.revealUserData()
        }, '在文件夹中显示')
      })
    ]))

    /*
     * 还原滚动位置与焦点（见函数开头）。
     * 放在最后：此时新内容已经在 DOM 里，scrollTop 才设得住。
     */
    if (previousScroll) scroll.scrollTop = previousScroll
    /*
     * 整页重建时先把过渡关掉两帧。
     * 重建出来的控件都是「新节点」，分段控件的滑块、下拉框的宽度会从初始值过渡到目标值 ——
     * 用户看到的就是「突然变短然后变长」（反馈里点名的主题框与输出设备框）。
     */
    scroll.classList.add('is-repainting')
    requestAnimationFrame(() => requestAnimationFrame(() => scroll.classList.remove('is-repainting')))

    /* 分区导航：按分组标题找锚点，点一下滚过去；滚动时高亮当前块 */
    const groupNodes = [...scroll.querySelectorAll('.settings__group')]

  /*
   * 按子标题顺序重排标签框（修正「播放与音效 / 外观与系统 看起来放反了」）。
   * 标签框在 DOM 里的原始顺序是零散的：外观 会排在 均衡器/播放 之前，
   * 于是点子标题滚动定位时，落到的是别类的地盘。这里统一按 SECTIONS 排。
   * 用 includes 匹配标题，避开分组标题尾部带 ⓘ 的字符。
   */
  const sectionIndexOf = (node) => {
    const title = node.querySelector('.settings__group-title')?.textContent || ''
    const index = SECTIONS.findIndex((item) => item.groups.some((group) => title.includes(group)))
    return index === -1 ? SECTIONS.length : index
  }
  const orderedGroups = [...groupNodes].sort((a, b) => sectionIndexOf(a) - sectionIndexOf(b))
  for (const node of orderedGroups) scroll.append(node)
    /*
     * 两层结构：选中某个分类**只显示该类的分组**，而不是滚过去。
     *
     * 之前的做法是「单页 + 锚点导航」——点一下平滑滚到那一块，页面依旧长得吓人
     * （用户反馈「设置页太长」）。改成分页之后，首屏只留一类设置，短得多；
     * 分类本身始终列在导航里，什么都不会藏起来找不着。
     * activeSection 放在闭包外层，重渲染后仍停在你刚看的那一类。
     */
    /** 某个子标题对应的**第一个标签框**（滚动定位的目标） */
    const sectionTarget = (label) => {
      const section = SECTIONS.find((item) => item.label === label) || SECTIONS[0]
      return groupNodes.find((node) => section.groups.includes(node.querySelector('.settings__group-title')?.textContent || ''))
    }

    const highlightSection = (label) => {
      for (const item of sectionNav.children) {
        item.classList.toggle('is-active', item.dataset.section === label)
        // 无障碍：当前分类标出来，读屏和自动化都好判断
        if (item.dataset.section === label) item.setAttribute('aria-current', 'true')
        else item.removeAttribute('aria-current')
      }
    }

    /*
     * 点子标题 → 滚到对应的标签框，让它在最上面。
     * 之前是「把其它类隐藏掉」，用户更喜欢全部留在一页、靠滚动定位
     * （需求原话：选择什么，就把页面下拉到对应的位置）。
     * shouldScroll=true 只在点击时传，避免每次重渲染都跳一下。
     */
    const applySection = (label, shouldScroll = false) => {
      activeSection = label
      highlightSection(label)
      const target = sectionTarget(label)
      if (!target || !shouldScroll) return
      // 点击后这段时间内不采纳联动高亮：平滑滚动途中会连续触发 scroll，
      // 会把刚点中的子标题覆盖成别的（用户反馈「点谁都显示关于」）。
      navClickUntil = Date.now() + 1500
      // 滚动动画期间与结束后都再确认一次高亮：点击就是唯一权威
      clearTimeout(navClickTimer)
      navClickTimer = setTimeout(() => highlightSection(label), 900)
      // 用 rect 差值算目标位置，不依赖 offsetTop / offsetParent
      const delta = target.getBoundingClientRect().top - scroll.getBoundingClientRect().top
      scroll.scrollBy({ top: delta - 8, behavior: 'smooth' })
    }

    /*
   * 方向键在分类之间移动（Home/End 到首尾）：这类「一排互斥选项」的常规操作。
   * 移动的同时按点击处理 —— 于是键盘也能像鼠标一样跳分类。
   * 用事件委托绑在容器上：视图会重渲染、按钮会重建，绑容器就不必反复解绑。
   */
  on(sectionNav, 'keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const items = [...sectionNav.children]
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement)
    let next = current < 0 ? 0 : current
    if (event.key === 'ArrowLeft') next = current <= 0 ? items.length - 1 : current - 1
    else if (event.key === 'ArrowRight') next = current >= items.length - 1 ? 0 : current + 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    event.preventDefault()
    items[next].focus()
    applySection(items[next].dataset.section || activeSection, true)
  })

  sectionNav.replaceChildren(...SECTIONS.map((section) => h('button', {
      class: 'settings-nav__item',
      type: 'button',
      text: section.label,
      dataset: { section: section.label },
      onClick: () => applySection(section.label, true)
    })))
    applySection(activeSection)

    /*
     * 滚动联动：高亮「当前停在最上面的那一类」，和点击定位形成闭环。
     * 用标志位保证只绑一次 —— 设置页每次重渲染都会走这段代码，
     * 不拦就会叠加出 N 个滚动监听（老代码里就是这么处理的）。
     */
    if (!navScrollBound) {
      // 只有手动滚动（滚轮 / 触控板）才算「用户在浏览」，点击定位不算
      on(scroll, 'wheel', () => { navUserScrolled = true }, { passive: true })
      on(scroll, 'scroll', () => {
        if (Date.now() < navClickUntil) return
        // 没手动滚过就不联动 —— 否则点击后的定位会被判成别的类
        if (!navUserScrolled) return
        const scrollerTop = scroll.getBoundingClientRect().top
        /*
         * 反过来查：先找出「当前贴在顶部附近、且位置最低的那个标签框」，
         * 再反查它属于哪个子标题。
         * 不能按「每个子标题的第一个标签框」去比 —— 标签框在 DOM 里的顺序与
         * 子标题顺序并不一致（「封面缓存」属于在线与扩展，却排在「在线功能」前面），
         * 那样会把「在线与扩展」判成别的类（实测错判成「关于」）。
         */
        const labelOfGroup = (node) => {
          const title = node.querySelector('.settings__group-title')?.textContent || ''
          const section = SECTIONS.find((item) => item.groups.includes(title))
          return section ? section.label : null
        }
        let current = activeSection
        let best = -Infinity
        for (const node of groupNodes) {
          const top = node.getBoundingClientRect().top - scrollerTop
          if (top <= 80 && top > best) {
            best = top
            current = labelOfGroup(node) || current
          }
        }
        if (current !== activeSection) {
          activeSection = current
          highlightSection(current)
        }
      }, { passive: true })
      navScrollBound = true
    }
    if (activeId) {
      const restored = scroll.querySelector(`[data-setting-id="${activeId}"]`)
      // 焦点原本在「控件」上（开关 / 下拉），恢复时也优先还给它
      const target = restored?.querySelector('button, select, input, [tabindex]') || restored
      target?.focus?.({ preventScroll: true })
    }
  }

  store.subscribe((state, prev) => {
    if (state.settings === prev.settings && state.library === prev.library && state.app === prev.app) return
    if (store.get().ui.view !== 'settings') return
    render()
  })

  render()
  return {
    element,
    render,
    /**
     * 让 Ctrl+F 在设置页聚焦到设置内搜索（与歌曲页同一套肌肉记忆）。
     * 这里的搜索只作用于本页，不会写 ui.query，所以不会连带过滤资料库。
     */
    focusSearch: () => {
      searchInput.focus()
      searchInput.select()
    }
  }
}
