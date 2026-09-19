/**
 * 最小化 / 收进托盘时的后台释放（渲染层这一半）。
 *
 * 主进程负责「什么时候」释放（见 src/main/services/background.js），这里负责
 * 「释放什么」。原则只有一条：**丢掉能重建的，留住正在用的**。
 *
 *   丢掉：媒体墙的格子 DOM、封面 blob 缓存、在线搜索与歌词结果、后台预热
 *   留住：音频本身（最小化还在放歌是播放器的本分）、曲目元数据（重建要全盘扫描）、
 *         正在播放的封面（已经解码在 <img> 里，revoke URL 也不会让它消失）
 */

export function createBackgroundRelease ({ store, prewarmer, artwork, mediaWall, nowPlaying }) {
  let released = false
  const stats = { releases: 0, resumes: 0, lastRelease: null, lastResume: null }

  function release () {
    if (released) return stats.lastRelease
    released = true

    const before = {
      wallTiles: mediaWall ? mediaWall.tileCount : 0,
      nodes: document.getElementsByTagName('*').length,
      wallNodes: document.querySelectorAll('.wall-tile').length
    }

    /*
     * 顺序有讲究：先做会触发 store 变更的清理（在线搜索结果等），最后才拆媒体墙。
     * 反过来的话，清 store 引起的那一次 refresh() 会把刚拆掉的墙立刻重建回来
     * —— 实测就是这么复发的：墙上的 474 个节点一个没少。
     */
    // ① 在线搜索 / 歌词深搜的结果：体积不大，但都是纯冗余，回来重搜即可
    const state = store.get()
    const hadSearch = Boolean(state.ui.onlineSearch || state.ui.searchLyrics)
    store.set((current) => ({
      ...current,
      ui: { ...current.ui, onlineSearch: null, searchLyrics: null, downloads: {} }
    }))
    // ② 后台预热：最小化时没人看封面，停下来
    if (prewarmer) prewarmer.suspend()
    // ③ 封面 blob 缓存：最多 120 张解码后的位图
    const covers = artwork ? artwork.releaseMemory() : { urls: 0, revoked: 0 }
    // ④ 媒体墙：最大的一块（474 个格子 / 数千节点）
    const wall = mediaWall ? mediaWall.release() : { tiles: 0, nodes: 0 }
    // ⑤ 让 V8 真的回收（需要启动时的 --js-flags=--expose-gc）
    const gcAvailable = typeof window.gc === 'function'
    if (gcAvailable) window.gc()

    stats.releases++
    stats.lastRelease = {
      at: Date.now(),
      wallTiles: wall.tiles,
      wallNodes: wall.nodes,
      covers: covers.urls,
      revoked: covers.revoked,
      droppedSearch: hadSearch,
      gc: gcAvailable,
      nodesBefore: before.nodes,
      nodesAfter: document.getElementsByTagName('*').length
    }
    return stats.lastRelease
  }

  function resume () {
    if (!released) return null
    released = false

    // 预热接着做（已经预热过的专辑不会重来）
    if (prewarmer) prewarmer.resume()
    // 媒体墙现在是空的：如果正在看媒体墙，立刻重建
    if (mediaWall && store.get().ui.view === 'wall') mediaWall.refresh({ focus: true, focusAnimate: false })    // 迷你歌词之类跟着当前曲目走的节点也刷新一下
    if (nowPlaying && typeof nowPlaying.refresh === 'function') nowPlaying.refresh()
    if (typeof window.gc === 'function') window.gc()

    stats.resumes++
    stats.lastResume = { at: Date.now() }
    return stats.lastResume
  }

  return {
    release,
    resume,
    get state () {
      return { released, ...stats }
    }
  }
}
