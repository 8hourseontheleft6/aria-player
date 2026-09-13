/**
 * 内置播放模式。
 *
 * 模式只是一组决策函数，返回「动作」，由 player-controller 执行：
 *   ctx = { hasNext, hasPrev, queueLength, index, shuffle }
 *   action ∈ 'next' | 'prev' | 'restart' | 'last' | 'replay' | 'reshuffle' | 'stop' | null
 *
 * 因为模式是通过扩展点注册的，第三方插件也能加自己的模式（例如「播放一次就停」）。
 */

export const BUILTIN_MODES = [
  {
    id: 'sequence',
    name: '顺序播放',
    short: '顺序',
    icon: 'arrowRight',
    description: '按顺序播完列表后停止',
    onEnded: ({ hasNext }) => (hasNext ? 'next' : 'stop'),
    onNext: ({ hasNext }) => (hasNext ? 'next' : null),
    onPrev: ({ hasPrev }) => (hasPrev ? 'prev' : null)
  },
  {
    id: 'loop-list',
    name: '列表循环',
    short: '循环',
    icon: 'repeat',
    description: '播完最后一首后回到第一首',
    onEnded: ({ hasNext }) => (hasNext ? 'next' : 'restart'),
    onNext: ({ hasNext }) => (hasNext ? 'next' : 'restart'),
    onPrev: ({ hasPrev }) => (hasPrev ? 'prev' : 'last')
  },
  {
    id: 'repeat-one',
    name: '单曲循环',
    short: '单曲',
    icon: 'repeatOne',
    description: '一直重复当前这首，手动切歌仍然生效',
    onEnded: () => 'replay',
    onNext: ({ hasNext }) => (hasNext ? 'next' : 'restart'),
    onPrev: ({ hasPrev }) => (hasPrev ? 'prev' : 'last')
  },
  {
    id: 'shuffle',
    name: '随机播放',
    short: '随机',
    icon: 'shuffle',
    description: '打乱队列顺序播放，循环不重复',
    shuffle: true,
    onEnded: ({ hasNext }) => (hasNext ? 'next' : 'reshuffle'),
    onNext: ({ hasNext }) => (hasNext ? 'next' : 'reshuffle'),
    onPrev: ({ hasPrev }) => (hasPrev ? 'prev' : null)
  }
]

export const DEFAULT_MODE = 'loop-list'

/** 把内置模式注册进插件宿主（内建模式走的是同一套扩展点） */
export function registerBuiltinModes (host) {
  for (const mode of BUILTIN_MODES) host.register('playbackMode', mode)
}
