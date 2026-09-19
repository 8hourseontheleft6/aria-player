# Aria 设计语言

这份文档是渲染层唯一的「长什么样」说明书。改界面之前先读它，改完跑
`npm run check:styles` —— 规则能被机器检查的部分都写成了脚本，不靠自觉。

设计目标只有一句：**看起来像原生 macOS / iOS 应用，而不是像网页**。
所有取舍都服从这一条。

---

## 一、三把尺子

界面上任何尺寸、颜色、动效都只能来自 `src/renderer/styles/tokens.css`。

| 尺子 | 令牌 | 说明 |
| --- | --- | --- |
| 间距 | `--space-1 … --space-6`（4 / 8 / 12 / 16 / 20 / 24） | 内边距、外边距、栅格间隙 |
| 圆角 | `--radius-2xs / xs / sm / md / lg / xl / 2xl / pill` | 4 / 6 / 8 / 10 / 14 / 18 / 24 / 999 |
| 高度 | `--elev-1 / 2 / 3` | 阴影层级，见下 |
| 动效 | `--dur-instant / fast / dur / slow` + `--ease-ios / out` | 时长与缓动 |

字号走 iOS 阶梯（`--text-caption … --text-large-title`），字体走
`--font-ui / --font-display / --font-mono`。

**为什么必须用令牌**：亮暗两套主题各维护一份值，写裸 `rgba(0,0,0,.28)`
等于只把当前主题调好，另一个主题必然失配；圆角写裸 px 则会在缩放、
不同组件之间慢慢长出十几种「差不多」的圆角。

### 高度层级（阴影）

| 令牌 | 用在哪 |
| --- | --- |
| `--elev-1` | 贴住内容：歌曲行悬停、封面缩略图、分段控件滑块、灵动岛的滑块 |
| `--elev-2` | 浮在内容之上：悬浮控件、封面卡右侧浮出的播放键、灵动岛本体 |
| `--elev-3` | 浮在整个界面之上：弹层、菜单、队列面板、封面卡悬停 |
| `--shadow-artwork` | 独立的大画布投影，只给「正在播放」的巨型封面用 |

旧名字 `--shadow-popover / --shadow-thumb` 保留为别名
（`--elev-3` / `--elev-1`），新代码直接用 `--elev-*`。

允许的例外，只有三类：

1. **细环** `0 0 0 0.5px var(--separator)`、`0 0 0 1px …` —— 描边不是投影；
2. **取色发光** `0 6px 18px color-mix(in srgb, var(--accent) 40%, transparent)`
   —— 颜色跟着封面色走，无法预先定义；
3. **方向性边缘阴影**（如队列面板的 `-18px 0 40px`）—— 只在必要时用。

---

## 二、材料与层次

- **毛玻璃**只给三类表面：侧边栏、播放条、标题栏。玻璃后面必须是滚动或
  有图像的内容，否则只是白烧一次 `backdrop-filter`。
- **弹层**（菜单、选择器、队列）用 `--bg-popover` + `--shadow-popover`；
  内容卡片用 `--bg-elevated`。
- **分隔线**一律 `0.5px`（`0.5px solid var(--separator)`），1px 在
  高分屏上会显得比原生重。
- 深度优先靠**材料与投影**区分，不靠边框颜色深浅。

---

## 三、动效

三条硬规则：

1. **动的是位置和透明度，不是布局**。`transform` / `opacity` 走合成层，
   `width` / `top` 会触发布局。列表虚拟滚动靠 `top` 定位，所以绝不能在
   行上做 `top` 过渡。
2. **缓动只用 `--ease-ios`**（`cubic-bezier(0.32, 0.72, 0, 1)`）：起步快、
   收尾稳，是 iOS 的手感。需要「弹出」感时用 `--ease-out`。
3. **时长分级**：`--dur-fast`(150ms) 悬停反馈，`--dur`(260ms) 面板/滑块，
   `--dur-slow`(420ms) 整页切换。

### 悬停语言

悬停有统一的三件套：**底色 + 轻轻浮起 + 抬起阴影**。

```css
.row:hover {
  background: var(--bg-hover);
  transform: translateY(var(--lift));   /* -1.5px */
  box-shadow: var(--elev-1);
}
```

- 列表行用 `--lift`（-1.5px），封面卡用 `-3px scale(1.015)`，媒体墙格子
  不位移（会打乱网格对齐）。
- 浮起的行**不要自己的分隔线**（`::after { opacity: 0 }`），否则线会跟着飘。

### 减少动画

`减少动画` 设置会把 `html[data-reduce-motion="true"]` 写到根节点，并让所有
过渡时长变成 0.001ms。**但时长归零不等于效果消失**：`transform`、阴影这类
「静态」差异仍然会照常出现。所以凡是新增位移/阴影/缩放，都要同时补一条：

```css
html[data-reduce-motion='true'] .row:hover {
  transform: none;
  box-shadow: none;
}
```

保留底色变化即可 —— 它不产生运动。

---

## 四、组件约定

- **灵动岛**（`.island`）：标题栏正中的视图切换器。平时只显示当前视图的
  文字，鼠标移上去展开全部文字；滑块位置靠实测 `offsetLeft` 计算，不写死
  宽度。当前视图不属于这四个（如设置页）时整条淡出。
- **侧边栏**：`Ctrl+B` 或标题栏左侧按钮切换。收起时整列宽度归零（`.app`
  的 grid 过渡）+ 内容向左淡出。
- **列表**：虚拟滚动，行绝对定位在 `index * --row-h` 处，行高固定。
- **分段控件 / 灵动岛**：同心圆角 —— 外圆角 = 内圆角 + padding，
  例如容器 `--radius-md` + 2px padding → 滑块 `--radius-sm`。

---

## 五、怎么检查

```bash
npm run check:styles   # 圆角/阴影是否走令牌、var() 是否都有定义
npm run check          # 上面这条 + 未使用 import + 注入脚本语法
npm run shots          # 重新生成 docs/screenshots（人工看）
npm run smoke          # 交互是否仍然可用
```

`check:styles` 能挡住的是「令牌用错」，挡不住「用得不好看」——
审美部分仍然要靠截图。

写令牌找不到合适的值时，**先想是不是层级判断错了**，实在没有才加新令牌，
并且**亮暗两套一起加**。
