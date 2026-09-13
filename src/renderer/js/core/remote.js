/** 渲染层与主进程之间的桥。脱离 Electron 打开时会退化为可读的错误提示。 */

const bridge = globalThis.aria || null

export const isElectron = Boolean(bridge)
export const isMac = bridge?.isMac ?? false
export const platform = bridge?.platform ?? 'unknown'

function unavailable (name) {
  return () => Promise.reject(new Error(`《${name}》只能在 Electron 中运行`))
}

function createStub () {
  const noop = () => () => {}
  return {
    app: { info: unavailable('获取应用信息') },
    settings: {
      get: unavailable('读取设置'),
      set: unavailable('写入设置'),
      reset: unavailable('重置设置'),
      onChanged: noop
    },
    library: {
      state: unavailable('读取资料库'),
      tracks: unavailable('读取曲目'),
      scan: unavailable('扫描音乐目录'),
      addFolder: unavailable('添加目录'),
      removeFolder: unavailable('移除目录'),
      pickFolders: unavailable('选择目录'),
      artwork: unavailable('读取封面'),
      reveal: unavailable('在文件夹中显示'),
      handleDrop: unavailable('处理拖入的文件'),
      onScanProgress: noop,
      onWatchUpdate: noop,
      onWatchError: noop
    },
    lyrics: { load: unavailable('读取歌词') },
    online: {
      lyrics: unavailable('在线歌词'),
      cover: unavailable('在线封面'),
      clearCache: unavailable('清理在线缓存'),
      stats: unavailable('在线缓存统计')
    },
    paths: { fromFiles: () => [] },
    window: {
      minimize: noop,
      toggleMaximize: noop,
      close: noop,
      state: unavailable('窗口状态'),
      onMaximizedChange: noop
    },
    media: { onCommand: noop },
    player: { reportState: () => {} },
    theme: { onChanged: noop },
    shell: { openExternal: noop }
  }
}

export const remote = bridge || createStub()

/** 把 IPC 返回的二进制（Uint8Array）转成 Blob URL */
export function bytesToBlobUrl (bytes, mime) {
  const blob = new Blob([bytes], { type: mime || 'image/jpeg' })
  return URL.createObjectURL(blob)
}
