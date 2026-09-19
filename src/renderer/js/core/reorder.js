/**
 * FLIP 重排动画。
 *
 * 重排列表最省事也最容易做错：直接挪 DOM 节点会「啪」地跳过去。
 * FLIP（First-Last-Invert-Play）把这件事变成三步：
 *   1. 先记住每个节点现在的位置（First）；
 *   2. 真的去改 DOM（Last）；
 *   3. 算出位移，先把节点用 transform 摆回原位（Invert），
 *      再让它过渡回 0（Play）—— 于是「跳」变成了「滑」。
 *
 * 为什么不用 requestAnimationFrame 等下一帧再过渡：这个环境里 rAF 会被
 * 节流到 ~7fps，那样动画会晚 140ms 才开始。改成写一次 transform 之后
 * 立刻读一次布局（强制同步回流），起点就被固定住了，可以同步开始过渡。
 */

/**
 * @param {Element[]} nodes 参与重排的节点（顺序不重要，函数内部按位移算）
 * @param {() => void} mutate 真正修改 DOM 的回调（移动节点 / 插入 / 删除）
 */
export function flipReorder (nodes, mutate) {
  const before = new Map()
  for (const node of nodes) {
    const rect = node.getBoundingClientRect()
    before.set(node, { left: rect.left, top: rect.top })
  }

  mutate()

  for (const node of nodes) {
    const was = before.get(node)
    if (!was) continue
    const now = node.getBoundingClientRect()
    const dx = was.left - now.left
    const dy = was.top - now.top
    if (!dx && !dy) continue
    node.style.transition = 'none'
    node.style.transform = `translate(${dx}px, ${dy}px)`
    // 强制回流：把「起点」定下来，下一行清掉时才会有过渡
    void node.offsetWidth
    node.style.transition = ''
    node.style.transform = ''
  }
}
