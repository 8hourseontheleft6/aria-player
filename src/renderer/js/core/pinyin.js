/**
 * 中文拼音排序与首字母。
 *
 * 为什么需要它：默认排序从「专辑/艺人」改成「标题字母顺序」之后，
 * 中文标题必须按**拼音**排，否则会退化成按 Unicode 码点排（乱序），
 * 而且列表右边的首字母索引也没法把「爱」「安」归到 A。
 *
 * 实现只用浏览器自带的能力，不引第三方词典：
 *   · 排序：Intl.Collator('zh-Hans-u-co-pinyin') —— Chromium 自带完整 ICU，
 *     这个 collation 就是按拼音比较的；
 *   · 首字母：拼音是按字母分段的，用一段「段首汉字」表做二分比较即可
 *     （阿八擦搭蛾发噶哈击喀垃妈拿哦怕期然撒塌挖昔压匝 → A..Z），
 *     汉字与这些段首字比大小，落在哪两段之间就是哪个字母。
 *     这套办法不需要逐字拼音表，覆盖常用字足够准确。
 */

const collator = new Intl.Collator('zh-Hans-u-co-pinyin', {
  sensitivity: 'base',
  numeric: true,
  ignorePunctuation: true
})

/** 段首汉字：下标 0 是 A，1 是 B……25 是 Z（没有 I/U/V 开头的拼音，跳过） */
const BOUNDARIES = [
  '阿', '八', '擦', '搭', '蛾', '发', '噶', '哈', '击', '喀',
  '垃', '妈', '拿', '哦', '怕', '期', '然', '撒', '塌', '挖',
  '昔', '压', '匝'
]
/** 与 BOUNDARIES 对应的字母（拼音里没有 I / U / V 开头） */
const BOUNDARY_LETTERS = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K',
  'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'W',
  'X', 'Y', 'Z'
]

const isHan = (char) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char)

/**
 * 取一段文本的排序首字母：英文取字母、中文取拼音首字母、其它归到 '#'。
 * @param {string} text
 * @returns {string} 'A'..'Z' 或 '#'
 */
export function initialOf (text) {
  const source = String(text || '').trim()
  if (!source) return '#'
  const char = source[0]

  const latin = char.toUpperCase()
  if (latin >= 'A' && latin <= 'Z') return latin

  if (isHan(char)) {
    // 比段首字小 → 落在第一段之前，归 A
    if (collator.compare(char, BOUNDARIES[0]) < 0) return 'A'
    for (let i = BOUNDARIES.length - 1; i >= 0; i--) {
      if (collator.compare(char, BOUNDARIES[i]) >= 0) return BOUNDARY_LETTERS[i]
    }
    return 'A'
  }

  // 数字、假名、emoji 等统一丢到 '#' 组
  return '#'
}

/** 标题排序（拼音，忽略大小写与标点） */
export function compareByTitle (a, b) {
  return collator.compare(String(a || ''), String(b || ''))
}

/**
 * 列表排序用的比较器：**先按首字母分组、组内再按拼音**。
 *
 * 为什么要分组在前：右侧的首字母旋钮靠的是「同一字母的歌曲连续排列」，
 * 只按拼音排的话 A 组的「阿刁」和 B 组的「八号风球」会按拼音交错，
 * 字母段就不连续了。分组之后：拉丁标题与中文标题也会按同一个字母挨在一起
 * （Bad Blood 紧挨八号风球），'#' 组（数字/符号）排最后。
 */
export function compareByInitialThenTitle (a, b) {
  const left = String(a || '')
  const right = String(b || '')
  const initialA = initialOf(left)
  const initialB = initialOf(right)
  if (initialA !== initialB) {
    if (initialA === '#') return 1
    if (initialB === '#') return -1
    return initialA < initialB ? -1 : 1
  }
  return collator.compare(left, right)
}

/** 给任意字段用的比较器（专辑、艺人等处复用） */
export function compareText (a, b) {
  return collator.compare(String(a || ''), String(b || ''))
}

export { collator }
