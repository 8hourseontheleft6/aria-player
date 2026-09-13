/**
 * 播放队列。
 *
 * 关键概念：
 *   queue —— 用户看到的顺序（曲目 id 数组）
 *   order —— 实际播放顺序（queue 的下标序列）；顺序播放时就是 [0,1,2,...]，
 *            随机播放时是打乱后的序列
 *   cursor —— 当前在 order 中的位置
 *
 * 「随机播放」在这里只是一个顺序策略，与「单曲循环 / 列表循环」正交，
 * 因此后续想加「随机 + 不重复」之类的模式不用改这里。
 */

export function createPlaylist ({ random = Math.random } = {}) {
  /** @type {string[]} */
  let queue = []
  /** @type {number[]} */
  let order = []
  let cursor = -1
  let shuffleEnabled = false

  function identityOrder () {
    return queue.map((_, index) => index)
  }

  function shuffledOrder (anchorId) {
    const indices = queue.map((_, index) => index)
    // Fisher-Yates
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      const tmp = indices[i]
      indices[i] = indices[j]
      indices[j] = tmp
    }
    if (anchorId) {
      const anchorIndex = queue.indexOf(anchorId)
      if (anchorIndex >= 0) {
        const at = indices.indexOf(anchorIndex)
        if (at > 0) {
          indices.splice(at, 1)
          indices.unshift(anchorIndex)
        }
      }
    }
    return indices
  }

  function rebuildOrder (anchorId) {
    order = shuffleEnabled ? shuffledOrder(anchorId) : identityOrder()
  }

  function currentId () {
    if (cursor < 0 || cursor >= order.length) return null
    return queue[order[cursor]] ?? null
  }

  function positionOf (id) {
    if (!id) return -1
    for (let i = 0; i < order.length; i++) {
      if (queue[order[i]] === id) return i
    }
    return -1
  }

  return {
    /** 用新的曲目列表替换队列；keepId 指定的曲目会尽力保留在当前位置 */
    sync (ids, { keepId = null } = {}) {
      const anchor = keepId || currentId()
      queue = Array.isArray(ids) ? ids.slice() : []
      rebuildOrder(anchor)
      cursor = anchor ? positionOf(anchor) : (order.length ? 0 : -1)
      if (!queue.length) cursor = -1
      return this
    },

    setShuffle (enabled, { anchorId = null } = {}) {
      const next = Boolean(enabled)
      if (next === shuffleEnabled) return this
      const anchor = anchorId || currentId()
      shuffleEnabled = next
      rebuildOrder(anchor)
      cursor = anchor ? positionOf(anchor) : (order.length ? 0 : -1)
      return this
    },

    get shuffle () {
      return shuffleEnabled
    },

    get queue () {
      return queue
    },

    get order () {
      return order
    },

    /** 队列长度 */
    get length () {
      return queue.length
    },

    /** 当前游标（order 中的位置） */
    get index () {
      return cursor
    },

    currentId,

    currentTrackId: currentId,

    positionOf,

    /** 取 order 中第 position 个位置的曲目 id */
    idAt (position) {
      if (position < 0 || position >= order.length) return null
      return queue[order[position]] ?? null
    },

    moveTo (position) {
      if (position < 0 || position >= order.length) return null
      cursor = position
      return currentId()
    },

    moveToId (id) {
      const position = positionOf(id)
      if (position < 0) return null
      cursor = position
      return currentId()
    },

    hasNext () {
      return cursor + 1 < order.length
    },

    hasPrev () {
      return cursor - 1 >= 0
    },

    /** 前进一格，返回新的曲目 id（到头返回 null） */
    advance () {
      if (!this.hasNext()) return null
      cursor += 1
      return currentId()
    },

    /** 后退一格 */
    rewind () {
      if (!this.hasPrev()) return null
      cursor -= 1
      return currentId()
    },

    first () {
      if (!order.length) return null
      cursor = 0
      return currentId()
    },

    last () {
      if (!order.length) return null
      cursor = order.length - 1
      return currentId()
    },

    /** 把一批曲目插到当前曲目之后 */
    insertNext (ids) {
      const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean)
      if (!list.length) return this
      const insertAt = cursor < 0 ? queue.length : order[cursor] + 1
      queue.splice(insertAt, 0, ...list)
      order = order.map((index) => (index >= insertAt ? index + list.length : index))
      const newPositions = list.map((_, offset) => insertAt + offset)
      order.splice(cursor + 1, 0, ...newPositions)
      return this
    },

    /** 从队列中移除曲目 */
    remove (id) {
      const removed = queue.indexOf(id)
      if (removed < 0) return this
      const wasCurrent = currentId() === id
      queue.splice(removed, 1)
      order = order
        .filter((index) => index !== removed)
        .map((index) => (index > removed ? index - 1 : index))
      if (wasCurrent) cursor = Math.min(cursor, order.length - 1)
      if (!queue.length) cursor = -1
      return this
    },

    clear () {
      queue = []
      order = []
      cursor = -1
      return this
    },

    /** 调试/序列化用 */
    snapshot () {
      return { queue: queue.slice(), order: order.slice(), cursor, shuffleEnabled }
    }
  }
}
