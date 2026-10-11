'use strict'
/*
 * 新内容⑤：搜索无结果时，把「匹配「X」的 0 张专辑」改成「没有匹配「X」的专辑」。
 *
 * 上一轮我量到「全库没有空状态文案」，修完艺人页副标题后重新核对：
 * 三个页面的计数文案其实都已经反映 0（歌曲页 / 专辑页 / 艺人页），缺的是措辞 ——
 * 「…的 0 张专辑」读起来像故障，而「没有匹配「X」的专辑」是一句回答。
 * 所以这里只改文案（不新增空状态组件）：零布局风险，用户也能立刻明白。
 */
const fs = require('node:fs')
const ROOT = 'C:/Users/fkdlz/Documents/Deepseek_Harness/aria-player'
const NL = String.fromCharCode(10)
let n = 0

/* ---------- 专辑页 ---------- */
{
  const file = ROOT + '/src/renderer/js/ui/views/browse-view.js'
  let s = fs.readFileSync(file, 'utf8')

  const oldAlbums = [
    '      albumsHeader.subtitleNode.textContent = state.ui.query',
    '        ? `匹配「${state.ui.query}」的 ${albums.length} 张专辑`',
    '        : `${albums.length} 张专辑 · ${state.library.tracks.length} 首歌曲`'
  ].join(NL)
  if (s.includes(oldAlbums)) {
    s = s.replace(oldAlbums, [
      '      // 命中 0 时给一句明确的回答，而不是「…的 0 张专辑」（读起来像故障）',
      '      albumsHeader.subtitleNode.textContent = state.ui.query',
      '        ? (albums.length',
      '            ? `匹配「${state.ui.query}」的 ${albums.length} 张专辑`',
      '            : `没有匹配「${state.ui.query}」的专辑`)',
      '        : `${albums.length} 张专辑 · ${state.library.tracks.length} 首歌曲`'
    ].join(NL))
    n++
  }

  const oldArtists = [
    '      artistsHeader.subtitleNode.textContent = state.ui.query',
    '        ? `匹配「${state.ui.query}」的 ${artists.length} 位艺人`',
    '        : `${artists.length} 位艺人`'
  ].join(NL)
  if (s.includes(oldArtists)) {
    s = s.replace(oldArtists, [
      '      artistsHeader.subtitleNode.textContent = state.ui.query',
      '        ? (artists.length',
      '            ? `匹配「${state.ui.query}」的 ${artists.length} 位艺人`',
      '            : `没有匹配「${state.ui.query}」的艺人`)',
      '        : `${artists.length} 位艺人`'
    ].join(NL))
    n++
  }

  fs.writeFileSync(file, s, 'utf8')
}

/* ---------- 歌曲页 ---------- */
{
  const file = ROOT + '/src/renderer/js/ui/views/library-view.js'
  let s = fs.readFileSync(file, 'utf8')
  const old = [
    '    headerSubtitle.textContent = parts.length',
    '      ? `匹配「${state.ui.query}」的 ${tracks.length} 首 · ${formatDurationLong(total)}`',
    '      : `${tracks.length} 首 · ${formatDurationLong(total)}`'
  ].join(NL)
  if (s.includes(old)) {
    s = s.replace(old, [
      '    headerSubtitle.textContent = parts.length',
      '      ? (tracks.length',
      '          ? `匹配「${state.ui.query}」的 ${tracks.length} 首 · ${formatDurationLong(total)}`',
      '          : `没有匹配「${state.ui.query}」的歌曲`)',
      '      : `${tracks.length} 首 · ${formatDurationLong(total)}`'
    ].join(NL))
    n++
  }
  fs.writeFileSync(file, s, 'utf8')
}

console.log('改了 ' + n + ' 处（应为 3）')
if (n !== 3) process.exit(1)
