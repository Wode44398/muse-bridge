# dimensio 品牌资产

**概念**：标志就是 bridge 的「月桥」——一道拱横跨水面，倒影在水下补成整圆；拱 7.4 / 水面 2.2（贯穿圆心、两头出头）/ 倒影 2.8、
缺口 11°、渐隐 0.58 → 0.12、瓦片与像素版，逐数同 bridge 仓库 `scripts/brand/mark.cjs` / `small.cjs`（两边改数要一起改）。
这套粗笔画是给小图标的；展示尺寸（App 图标 ≥48、组合字标、首页）用 `FINE` 精绘版：拱外沿正圆、拱顶 6.8 向拱脚收到 4.9，
水面中段 2.2 两头收到 1.15，倒影最低处 3 两端收到 1.4——与宋体字标同一种笔势。
「换一个维度」写在出场动画里：以水面线为参照，整枚先竖着一笔绕出整圆、线从圆心贯穿，再三笔一起转过 90° 落成月桥（`Mark.svelte` 的 `intro`，逐帧由 `src/lib/mark-motion.ts` 驱动）。
字标是思源宋体 600 的「dimensio」，与 bridge 官网字标「bridge」同一款字、同一字重。设计语言叫「纸墨」。
完整说明见品牌手册 `kit/dimensio-brand.html`（整页预览 `kit/dimensio-brand.png`）。

## 单一真相源

| 文件 | 作用 |
|---|---|
| `geometry.mjs` | 全部几何：色板、标志（`MARK` 月桥原样 / `FINE` 精绘版）、16–32px 像素版、字标轮廓的拼排 |
| `serif-600.json` | 字标用到的思源宋体（wght 600，SIL OFL，许可证 `OFL-NotoSerifSC.txt`）字形轮廓与字距；`extract-serif.py` 可从字体文件重取 |
| `svg.mjs` | 由几何拼出各种 SVG（标志、字标、App 图标、单色图标、组合） |
| `build.mjs` | 重出全部产物：`src/lib/brand.ts`（界面组件用）、`public/` 的 favicon 与触屏图标、bridge 入口图标、`kit/` |
| `serif-font.py` | 界面展示用宋体子集 `src/assets/fonts/dimensio-serif-600.woff2`（问候、连接页标题；改了这些字要重跑） |
| `sheet.mjs` / `cover.mjs` | 品牌手册页（`--png <高>` 出整页图）/ 分享封面图 |

改任何比例：只改 `geometry.mjs`，然后 `node harness/web/brand/build.mjs && node harness/web/brand/sheet.mjs && node harness/web/brand/cover.mjs`。

## 资产包 `kit/`

| 路径 | 用途 |
|---|---|
| `svg/mark.svg` · `-reverse` · `-flat` | 标志：墨 / 深底象牙 / 倒影不渐变（单一不透明度） |
| `svg/wordmark.svg` · `-reverse` | 字标 |
| `svg/lockup.svg` · `-reverse` · `-tile` | 组合：标志 + 字标（整圆撑满字标的升部线到基线）/ 图标瓦片 + 字标 |
| `svg/app-icon.svg` | App 图标母版（暖墨圆角瓦片，与月桥同一块） |
| `svg/app-icon-maskable.svg` | 安卓自适应 / PWA maskable（满幅，标志在安全圆内） |
| `svg/app-icon-monochrome.svg` | 安卓 13 主题图标（纯形状，系统上色） |
| `svg/favicon.svg` · `favicon.ico`（16/20/24/32/48/64） | 网页图标（≤32 用像素版） |
| `png/app-icon-{1024…48}.png` · `png/app-icon-{32,24,20,16}.png` | 各尺寸 App 图标；≤32px 为逐像素重画的像素版 |
| `png/app-icon-maskable-512.png` | maskable 位图 |
| `png/wordmark@2x.png` · `lockup@2x.png` · `lockup-tile@2x.png`（含反白） | 透明底位图 |
| `png/cover.png` · `cover-dark.png` | 1600×900 分享封面（纸 / 夜） |
| `dimensio-brand.html` · `.png` | 品牌手册 |

## 色板（与 bridge 同源）

| 名 | 值 | 用在 |
|---|---|---|
| 纸 | `#F4F1EA` | 浅色画布 |
| 墨 | `#171614` | 字标、标志、正文 |
| 朱 | `#C8412B`（深底 `#E4553A`） | 只给「正在发生」：实时节点、倒计时、焦点（标志本身永远只用墨 / 象牙） |
| 夜 | `#131210` | 深色画布 |
| 象牙 | `#F3EEE4` | 深底上的标志 |
| 瓦片 | `#282521 → #0F0E0C` | App 图标底（上亮下暗） |

## 用法

- 四周至少留两个拱的笔画宽；标志最小 16px（用像素版），字标最小高 12px。
- 只用墨或象牙；倒影保持渐隐（不支持渐变时用单一不透明度 0.4），别画实；别拉伸。
- 竖着的线只属于出场的中间态，静态图形里水面永远是横的。
- 界面里在跑 / 加载的指示一律用在动的标志（`src/components/brand/Mark.svelte` 的 `live`：沉进水面 → 水面线转半圈 → 重新升起），不另造转圈。
