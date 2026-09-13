/**
 * 内置插件：在线歌词与封面补全。
 *
 * 演示两个扩展点：
 *   lyricsProvider  —— 本地找不到 .lrc 时向 LRCLIB 要歌词
 *   artworkProvider —— 本地没有封面时向 Deezer / iTunes 要封面
 *
 * 所有网络请求都在主进程完成，渲染层只拿到文本与图片字节，
 * 因此这里不会给页面增加任何联网能力（CSP 仍然禁止 connect-src）。
 * 总开关在设置 -> 在线功能里，默认关闭。
 */

const LOCAL_SOURCES = new Set(['lrc', 'txt', 'tag'])

export const onlineMedia = {
  id: 'online-media',
  name: '在线歌词与封面',

  setup (api) {
    /* ---------------- 歌词：LRCLIB ---------------- */
    api.register('lyricsProvider', {
      id: 'lrclib',
      priority: 50,
      async load (track, { settings }) {
        if (!settings?.onlineFeatures || settings.onlineLyrics === false) return null
        const result = await api.services.remote.online.lyrics({
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration
        })
        if (!result || result.error || result.skipped || !result.text) return null
        return {
          text: result.text,
          file: null,
          source: `在线 · ${result.provider || 'LRCLIB'}`
        }
      }
    })

    /* ---------------- 封面：Deezer -> iTunes ---------------- */
    api.register('artworkProvider', {
      id: 'online-cover',
      priority: 50,
      async resolve (track, { remote }) {
        const settings = api.store.get().settings
        if (!settings?.onlineFeatures || settings.onlineCovers === false) return null
        const result = await remote.online.cover({
          title: track.title,
          artist: track.artist,
          albumArtist: track.albumArtist,
          album: track.album
        })
        if (!result || result.error || result.skipped || !result.data) return null
        return { data: result.data, mime: result.mime }
      }
    })
  }
}

/** 歌词视图用它判断是否要显示「来源：在线」这类提示 */
export function isOnlineLyricsSource (source) {
  return typeof source === 'string' && !LOCAL_SOURCES.has(source)
}
