/**
 * 示例插件 ①：歌曲信息面板。
 *
 * 演示 `panel` 扩展点 —— 在「正在播放」右栏加一个与「歌词」并列的标签页。
 * 它会被自动出现在标签栏里，切走时调用返回的清理函数。
 */

import { h } from '../core/dom.js'
import { icon } from '../core/icons.js'
import { EVENTS } from '../core/bus.js'
import { formatBytes, formatDuration } from '../core/format.js'

export const trackInfoPanel = {
  id: 'track-info-panel',
  name: '歌曲信息面板',

  setup (api) {
    api.register('panel', {
      id: 'track-info',
      title: '歌曲信息',

      mount (container, { bus, player, store, artwork }) {
        const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px', paddingBottom: '20px' } })
        container.appendChild(list)

        function field (label, value) {
          return h('div', { style: { display: 'flex', gap: '12px', alignItems: 'baseline' } },
            h('div', { style: { width: '72px', flex: 'none', fontSize: 'var(--text-footnote)', color: 'var(--label-3)' }, text: label }),
            h('div', { style: { fontSize: 'var(--text-subhead)', color: 'var(--label)', userSelect: 'text', wordBreak: 'break-all' }, text: value || '—' })
          )
        }

        async function render () {
          const track = player.currentTrack()
          list.replaceChildren()
          if (!track) {
            list.appendChild(h('div', { class: 'empty', text: '还没有正在播放的歌曲' }))
            return
          }

          const cover = h('div', { style: { width: '132px', height: '132px', borderRadius: '12px', overflow: 'hidden', background: 'var(--fill-quaternary)', display: 'grid', placeItems: 'center' } })
          list.appendChild(h('div', { style: { display: 'flex', gap: '16px', alignItems: 'center' } },
            cover,
            h('div', { style: { minWidth: '0' } },
              h('div', { style: { fontSize: 'var(--text-title3)', fontWeight: '700' }, text: track.title }),
              h('div', { style: { color: 'var(--label-2)', fontSize: 'var(--text-callout)' }, text: track.artist }),
              h('div', { style: { color: 'var(--label-3)', fontSize: 'var(--text-footnote)' }, text: track.album })
            )
          ))

          const url = await artwork.resolveUrl(track)
          if (url) cover.appendChild(h('img', { src: url, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } }))
          else cover.appendChild(icon('music'))

          list.appendChild(h('div', { style: { display: 'grid', gap: '9px' } },
            field('格式', `${track.ext.replace('.', '').toUpperCase()}${track.lossless ? ' · 无损' : ''}`),
            field('时长', formatDuration(track.duration, { forceHours: true })),
            field('码率', track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : '—'),
            field('采样率', track.sampleRate ? `${(track.sampleRate / 1000).toFixed(1)} kHz` : '—'),
            field('大小', formatBytes(track.size)),
            field('音轨', track.trackNo ? `${track.discNo || 1} - ${track.trackNo}` : '—'),
            field('年份', track.year ? String(track.year) : '—'),
            field('歌词', track.lyricsPath ? '已找到 .lrc 文件' : '未找到歌词文件'),
            field('文件', track.path)
          ))
        }

        render()
        const offTrack = bus.on(EVENTS.TRACK_CHANGED, render)
        const offLyrics = bus.on(EVENTS.LYRICS_LOADED, render)
        void store

        return () => {
          offTrack()
          offLyrics()
        }
      }
    })
  }
}
