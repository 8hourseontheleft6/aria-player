/** 设置页：iOS 分组列表风格 */

import { h, clear } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { formatDurationLong, formatRelativeTime, formatRate, formatBytes } from '../core/format.js'
import { createSlider } from './slider.js'

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
  ['↑ / ↓、回车', '在列表中移动选择 / 播放'],
  ['Esc', '关闭浮层 / 返回上一级 / 收起正在播放']
]

export function createSettingsView ({ store, bus, player, actions, host }) {
  const element = h('div', { class: 'content-inner', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' } })

  const toolbar = h('div', { class: 'view-toolbar' },
    h('div', { class: 'view-toolbar__title', text: '设置' }),
    h('div', { class: 'view-toolbar__spacer' })
  )

  const scroll = h('div', { class: 'settings scroll view-body' })
  element.append(toolbar, scroll)

  /* ------------------------------ 小组件 ------------------------------ */

  function card (rows) {
    return h('div', { class: 'settings__card' }, ...rows)
  }

  function group (title, rows) {
    return h('div', { class: 'settings__group' },
      title ? h('div', { class: 'settings__group-title', text: title }) : null,
      card(rows)
    )
  }

  function row ({ title, sub, control, onClick, className = '' }) {
    const node = h(onClick ? 'button' : 'div', {
      class: `settings__row ${className}`.trim(),
      type: onClick ? 'button' : undefined,
      onClick
    },
    h('div', { class: 'settings__row-text' },
      h('div', { class: 'settings__row-title', text: title }),
      sub ? h('div', { class: 'settings__row-sub', text: sub }) : null
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
      })
    ]))

    /* ---------- 播放 ---------- */
    scroll.appendChild(group('播放', [
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
    ]))

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
