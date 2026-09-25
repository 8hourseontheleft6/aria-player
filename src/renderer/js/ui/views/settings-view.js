/** 设置页：iOS 分组列表风格 */

import { h, on, clear } from '../../core/dom.js'
import { icon } from '../../core/icons.js'
import { remote } from '../../core/remote.js'
import { formatDurationLong, formatRelativeTime, formatRate, formatBytes } from '../../core/format.js'
import { createSlider } from '../widgets/slider.js'
import { toast } from '../widgets/overlay.js'

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
  ['Ctrl + L', '打开正在播放与歌词'],
  ['Ctrl + Q', '播放队列'],
  ['Ctrl + B', '显示 / 隐藏边栏'],
  ['Ctrl + O', '添加音乐文件夹'],
  ['Ctrl + F', '搜索'],
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

  const toolbar = h('div', { class: 'view-toolbar' },
    h('div', { class: 'view-toolbar__title', text: '设置' }),
    h('div', { class: 'view-toolbar__spacer' })
  )

  const scroll = h('div', { class: 'settings scroll view-body' })

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

  function showTip (anchorNode, text) {
    infoLayer.textContent = text
    infoLayer.hidden = false
    // 先显示再量：宽度由内容决定
    const rect = anchorNode.getBoundingClientRect()
    const box = infoLayer.getBoundingClientRect()
    const left = Math.max(12, Math.min(rect.left - 8, window.innerWidth - box.width - 12))
    const above = rect.top - box.height - 8
    infoLayer.style.left = `${left}px`
    infoLayer.style.top = `${above > 12 ? above : rect.bottom + 8}px`
  }

  function infoIcon (text) {
    if (!text) return null
    return h('span', {
      class: 'settings__info',
      role: 'img',
      tabindex: '0',
      'aria-label': text,
      onMouseenter: (event) => showTip(event.currentTarget, text),
      onMouseleave: hideTip,
      onFocus: (event) => showTip(event.currentTarget, text),
      onBlur: hideTip
    }, 'i')
  }

  element.append(toolbar, scroll, infoLayer)
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

  function render () {
    const state = store.get()
    const settings = state.settings
    const library = state.library
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
     * 输出设备列表要现取：插拔耳机、切蓝牙都会变。
     * 名字需要 media 权限（主进程已放行），拿不到就退化成「输出设备 N」。
     */
    const outputSelect = h('select', { class: 'settings__select' })
    let outputDevices = []
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
      } catch {
        outputDevices = []
      }
      paintOutputDevices()
    }
    on(outputSelect, 'change', () => actions.setOutputDevice(outputSelect.value))
    paintOutputDevices()
    loadOutputDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', loadOutputDevices)

    scroll.appendChild(group('播放', [
      row({
        title: '输出设备',
        sub: '通话 / 游戏语音时想让对方听不到音乐：把这里选成你的耳机（通话留在原设备）。音乐只进你的耳朵，麦克风拾不到它，对方就什么也听不到。留「跟随系统」则与其它应用共用默认输出。',
        control: outputSelect
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
          }
        }, '清空'))
      }),
      row({
        title: '空闲时预热封面',
        sub: '后台一张一张地把封面读进缓存（界面正在加载封面时会自动让路），这样打开媒体墙基本是秒出',
        control: switchControl(settings.prewarmArtwork !== false, (value) => actions.setSetting({ prewarmArtwork: value }))
      })
    ], { collapsible: true, collapsed: true }))

    scroll.appendChild(group('在线功能', [
      row({
        title: '在线补全歌词与封面',
        sub: '开启后会向 LRCLIB（歌词）与 Deezer / iTunes（封面）发起请求。这是本项目唯一的联网功能，默认关闭；请求全部由主进程发出，页面本身仍然不能联网。',
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
    ], { collapsible: true, collapsed: true }, {
      collapsible: true,
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
    ], { collapsible: true, collapsed: true }))

    /* ---------- 快捷键 ---------- */
    scroll.appendChild(group('快捷键', SHORTCUTS.map(([key, description]) => row({
      title: description,
      control: h('span', { class: 'kbd', text: key })
    }))))

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
  }

  store.subscribe((state, prev) => {
    if (state.settings === prev.settings && state.library === prev.library && state.app === prev.app) return
    if (store.get().ui.view !== 'settings') return
    render()
  })

  render()
  return { element, render }
}
