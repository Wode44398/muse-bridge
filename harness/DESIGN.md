# dimensio 前端设计规格 ·「纸墨」

写给改前端的人和 agent。分两类：**机器守着的**（`npm test` 里会红）和**约定**（靠人和 agent 自觉，违反了评审时指出来）。
每条带出处；出处过期了（文件改名、删了）`server/instructions.test.ts` 会红——改这里，别删检查。
同一条规则只存一份：别的地方要用，引用这里。

## 0. 概念

dimensio 与 bridge 是一家：同一张纸、同一块墨、同一支笔。bridge 的图标「月桥」是横跨水面的一道拱，倒影在水下补成整圆；
dimensio 的标志**就是月桥**：小尺寸（< 40px）与 bridge 逐数相同；展示尺寸用精绘版（拱顶厚、拱脚收，水面与倒影两头收，与宋体字标同一种笔势）。
「换一个维度」写在出场里：以水面线为参照，整枚先竖着一笔绕出整圆、线从圆心贯穿，再三笔一起转过 90° 落成月桥（09-25 那版「转成小写 d」已于 09-27 废弃）。字标是思源宋体 600 的「dimensio」——与 bridge 官网字标同一款字。
品牌几何的唯一来源是 `web/brand/geometry.mjs`（重出产物：`node web/brand/build.mjs`，生成 `web/src/lib/brand.ts` 与各尺寸图标），
界面里用 `web/src/components/brand/Mark.svelte` 与 `web/src/components/brand/Wordmark.svelte` 画；品牌手册 `web/brand/kit/dimensio-brand.html`。

设计原则：
1. **克制。** 每个元素都要说得出为什么在；去掉之后没人想念的，就去掉。高级感靠排版与精确的线，不靠装饰。
2. **纸的层次。** 分区靠纸色的深浅与一根根细线：侧栏是深半档的纸、右缘一根细线；浮起的面（输入框、卡片、菜单）是更白的纸，
   一圈细线、上沿一道极淡的高光（`--sheen`，纸的厚度）、一道暖墨投影。
3. **纸与墨，一抹朱。** 暖白纸、墨色字；强调就是墨本身（选中、勾选、焦点外的强调、链接、主按钮）。唯一的彩色是一抹朱（`--live`），
   只留给「正在发生」的东西：在跑的光点、实时节点、倒计时、键盘焦点、光标——与 bridge 官网同一条规矩。成功是默认，不上色。
4. **动是连续的。** 东西不瞬移：出现是浮起，消失是退隐，尺寸变化是生长；跟手的手势松手后从当前位置接着走。
5. **精确。** 4px 网格、统一圆角阶梯、光学对齐、数字等宽。

## 1. 机器守着的

`server/design-guard.test.ts` 扫 `web/src` 下的 `.svelte` / `.ts` / `.css`，基线在 `web/design-baseline.json`：
某个文件的命中数比基线多就红；少了只提示「顺手把基线下调」——存量只减不增。
单行豁免写在该行或上一行：`// guard: <规则> ok — <理由>`，CSS 里 `/* guard: <规则> ok — <理由> */`，理由不许空。

| 规则 | 要求 | 为什么 |
|---|---|---|
| `bare-root` | 不写裸 `:root` | 样式随 `@hx` 别名打进 bridge 的全局包，裸 `:root` 与宿主 `:root` 同特异性、按源顺序覆盖宿主令牌（apk218 事故）。令牌挂在 `.hxroot` / `html[data-hx-standalone]` 上（`web/src/app.css`、`web/src/lib/theme.ts`） |
| `bare-color` | 组件里不写裸色值（`#hex`、`rgb()`、`hsl()` 字面量） | 深浅两套主题都来自 `web/src/lib/theme.ts`；调透明度用 `color-mix(in srgb, var(--err) 12%, transparent)`；颜色关键字（`black`、`white`、`transparent`）可以用在遮罩 / 混色里。单独一行的令牌定义（`--名字: 值;`）不算 |
| `unguarded-hover` | `:hover` 规则包进 `@media (hover: hover) { … }` | 触屏上点过的元素会一直停在 hover 态 |
| `request-header` | 请求头只许 `content-type` / `authorization` | 离线 apk 跨源访问 bridge，CORS 只放行这两个（M10）；要带信息走查询串 |
| `window-open` | 不直接 `window.open` | 在 bridge 的内置浏览器 / 桌面壳里它会把整个页面导走；打开产物走 `web/src/lib/open-artifact.ts` 的宿主回调，没有宿主时的兜底才用它（Q13） |

另外两道：`web/scripts/svelte-baseline.ts`（svelte-check 按文件计错误、只拦新增——新文件必须零错误，F7）；
`server/guards.test.ts` 的「前后端事件集合一致」（后端发的事件前端都要处理，Q9）。

## 2. 令牌（`web/src/lib/theme.ts` 写进主题根；`web/src/app.css` 只有首帧兜底）

**颜色**（语义名，深浅两档同名）：
- 画布：`--bg` 主画布 · `--rail` 侧栏 / 次级画布
- 面：`--surface` 浮起的面（输入框、卡片、菜单、sheet）· `--surface2` 色阶填充（悬停、选中、芯片、用户气泡）· `--surface3` 再深一阶（按下、分段轨道）
- 字：`--text` · `--text2` 次要 · `--text3` 辅助（时间、提示、占位）
- 线：`--border` 细线 · `--border2` 强细线
- 强调 = 墨：`--accent` · `--accent-hover` · `--on-accent` · `--accent-soft`（7–9% 的墨底）
- 正在发生 = 朱：`--live` · `--live-soft` · `--on-live`（只做点、线、光标，不做小字）
- 主操作：`--primary`（墨；深色档反相为象牙）· `--on-primary`
- 状态：`--ok` · `--warn` · `--err`（成功默认不上色；`--ok` 只给 diff 新增行、勾选完成这类）
- 其他：`--code-bg` · `--code-k`（代码关键字的石青：代码是内容不是界面）· `--scrim` 遮罩 · `--selection`（朱调）· `--user-bubble` / `--on-user-bubble`
- 阴影（暖墨）：`--shadow-1` 浮起 · `--shadow-2` 悬浮（菜单、弹层）· `--shadow-3` 模态（sheet、对话框）；浮起的面配 `0 0 0 1px var(--border)` 与 `inset 0 1px 0 var(--sheen)`。

**字**：`--font-ui`（Inter 拉丁子集 + 系统中文字体）· `--font-mono`（JetBrains Mono 子集）· `--font-serif`（思源宋体 600 的展示子集，
只给固定的展示文字：首屏问候、连接页标题；子集由 `web/brand/serif-font.py` 按这些字生成，改了文字要重跑）。数字、路径、代码、命令用 mono；中文正文不用等宽。
字号阶梯 `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 · `--fs-base` 14（界面默认）· `--fs-body` 15（对话正文）· `--fs-lg` 17（面板标题）·
`--fs-xl` 20 · `--fs-2xl` 26 · `--fs-3xl` 34（宋体问候）。行高 `--lh-tight` 1.3 · `--lh-ui` 1.45 · `--lh-body` 1.72（中文正文）。
字重只用 400 / 500 / 600。

**圆角**：`--r-xs` 6 · `--r-sm` 8 · `--r-md` 12 · `--r-lg` 16 · `--r-xl` 22 · `--r-pill`。按钮是胶囊；图标按钮是圆角方（边长 × 0.3）；
卡片 14–16；菜单 14；sheet 顶角 22 / 对话框 20；输入框 22。

**动效**：`--ease` 常规 · `--ease-out` 丝滑减速（进场、展开）· `--ease-in` 退场 · `--ease-in-out` 往返 ·
弹簧 `--spring-soft`（几乎不过冲：面板、抽屉、sheet、列表）/ `--spring`（≈4% 回弹：菜单、卡片、形变）/ `--spring-pop`（≈9%：徽标、勾、小点）/
`--spring-snap`（几乎不过冲、260ms 就停：跟手的选中块——分段控件、工作区标签带），
配套时长 `--t-spring-soft` / `--t-spring` / `--t-spring-pop` / `--t-spring-snap`；`--t-fast` 140 · `--t-med` 240 · `--t-slow` 420。
会滑的选中块照 `web/src/lib/slide.ts` 落位：第一次落位不滑、按下就先滑向按着的那项。
弹簧曲线由 `web/src/lib/motion.ts` 按阻尼谐振子的解析解算成 CSS `linear()`，JS 缓动同源。

**版式**：`--hx-band` 44px 顶栏带（侧栏头、对话顶栏、工作区面板头同一条中线，对齐桌面壳窗控）· `--hx-pane-r` / `--hx-hdr-r`（右缘让位钩子）·
`--sat` / `--sab` 安全边距（独立运行时自己声明；嵌入 bridge 时**绝不能**在 `.hxroot` 上重声明，会遮住宿主注入的真值）。

## 3. 组件库（先用它们，别自己再造）

基础件在 `web/src/components/ui/`，品牌件在 `web/src/components/brand/`：

| 组件 | 用途 · 要点 |
|---|---|
| `Icon` | 线稿图标（`web/src/lib/icons.ts`，Lucide 为底，键名是契约只增不改）；`fill` = 实心画法 |
| `Button` | 胶囊按钮：`primary` 墨（一屏最多一个）· `secondary` · `ghost` · `outline` · `accent`（也是墨：批准 / 开启）· `danger` 柔红 · `danger-solid`；`sm/md/lg`；`loading` 时换成在动的标志 |
| `IconButton` | 图标按钮，`label` 必填；`ghost/soft/solid`；`active` 开关态；`badge` 小点或数字 |
| `Chip` | 输入框底行、状态条上的胶囊：`plain/soft/accent/warn`，`chevron` 下拉 |
| `Popover` + `MenuItem` / `MenuLabel` / `MenuSep` | 一切菜单与弹出面板。fixed 定位 + 视口钳制 + 内容变高重新定位；挂到 `.hxroot`（#94）；登记浮层栈（返回键 / Esc 先关它）；从锚点方向弹出 |
| `Sheet` | 面板：手机底部抽屉（把手可拖关），桌面居中对话框；`size` sm/md/lg/xl，`footer` / `actions` 片段；`onback` = 面板里有层级（标题左边「‹」，Esc / 返回键先退一级，× 与遮罩照旧整个关） |
| `Segmented` | 二三选一的视图切换（滑动的选中块） |
| `Switch` · `TextField` | 开关 · 单行输入 |
| `Group` + `Row` | 设置 / 记忆 / 检查点这类列表：分组面 + 行（图标、标题、副标题、右侧内容） |
| `Measure` | 量度条：细线 + 走过的一段 + 停在末端的一粒点（剩余时间用 `tone="live"` 朱、上下文用量、进度） |
| `Empty` | 空态：说清楚为什么空、去哪看 |
| `Mark` | 标志；`live` = 正在发生（月桥沉进水面 → 水面线独自转半圈 → 月桥重新升起，一周 2.2s；只用墨不上朱；一屏几处同时在跑按全局时钟同相，停下时弹回静止）；`intro` = 出场（整枚竖着旋入、一笔绕出整圆 → 线射出贯穿 → 三笔一起转过 90°，带挤压拉伸、惯性甩尾与回摆）；两段动作由 `web/src/lib/mark-motion.ts` 按弹簧模拟逐帧驱动，别改回 CSS 关键帧。≥40px 自动用精绘版，小尺寸自动加粗细线。**在跑 / 加载的指示一律用它**，不要再造转圈 |
| `Wordmark` · `VendorLogo` | 字标 · 厂商官方标（`mono` 单色） |

浮层栈 `web/src/lib/layers.ts`：凡是「盖在上面、可以关」的东西都要登记（`pushLayer` 或 `use:layer`）——返回键和 Esc 只关最上面那层，
桌面壳的原生浏览器视图挂载期间让位。`Popover`、`Sheet` 已经自带，别重复登记。
本身就装着原生浏览器视图的浮层（手机上的工作区层）登记时传 `native: false`，否则它会把自己里面的视图也让下去。

## 4. 版式

- **三栏**（≥700px）：侧栏 272（`--rail` 底）| 对话 | 工作区（可拖宽，比例 0.26–0.72，双击复位）。1100 以下开着工作区时侧栏临时收起，
  侧栏钮改为以抽屉拉出（不改用户偏好）。手机单栏：侧栏是左侧抽屉（边缘右滑跟手拉出、左滑跟手收回），工作区是整屏底部层。
- **对话列**：正文最宽 760（含左右 20 内边距，手机 16），输入框与它同宽同中线。用户消息靠右、`--user-bubble` 底、圆角 18；
  助手正文不加底、不加框，直接排在画布上。
- **顶栏**不放返回 / 新对话 / 侧栏键（设计决定，2026-07-20）：返回在侧栏「主页」，新对话在侧栏；只有桌面侧栏收起时左上角才有展开钮。
- 浮层（sheet、抽屉、灯箱、提示、厂商面板）都渲染在 `.shell` 外、`.hxroot` 内（`web/src/App.svelte`）：三栏各自是层叠上下文，
  里面写 fixed 也会被兄弟栏盖住。
- 桌面壳顶部约 40px 是窗口拖拽区：按钮、输入框天然可点；自定义的可交互 div（拖拽手柄之类）要自己加 `-webkit-app-region: no-drag`。

## 5. 动效

- **只动 transform / opacity。** 布局属性不做逐帧动画（例外：侧栏收展动宽度，内层定宽，裁切滑出）。
  工作区宽度**永远不做动画**：桌面壳的原生浏览器视图按量出来的矩形落座，宽度一动它就逐帧重排。
- **进场用弹簧，退场用短促的 ease-in**（退场 120–220ms，让位要干脆）。可以被打断：新状态从当前位置出发，不回跳、不重播。
- 用 `web/src/lib/motion.ts` 的过渡：`rise`（浮起：列表条目、卡片、提示）· `pop`（从锚点弹出：菜单、徽标）· `fade` · `slide`（整块从边上进）·
  `collapse`（高度 0 ↔ 自然高：行内展开区、详情）；动作 `smoothHeight`（容器随内容平滑生长）· `press`（按下缩、松开弹回）。
  组件根上的过渡要写 `|global`，否则父级 `{#if}` 卸载它时不播。
  用 `element.animate()`（WAAPI）时 easing 传 `springEasing()` 的返回值——WAAPI 不解析 CSS 变量，写 `var(--spring)` 会直接报错。
- 流式文字：新到的字 0.42s 淡入（`web/src/lib/fade.ts`），只动尾巴，稳定的块不重渲。
- 「在做」的文字用 `.hx-shimmer` 微光（全局类，`web/src/app.css`）；「在跑」的图形用 `Mark live`。
- 品牌级的表演（标志出场、`Mark live`）要「润」：动作交叠不排队，弹簧带过冲与回摆，快的时候形变（挤压拉伸、惯性甩尾），静止时回到逐数原样。
- `prefers-reduced-motion`：只留透明度，时长压到最短（标志出场只淡入，`Mark live` 只做明暗呼吸）。

## 6. 交互文法

- **反馈**：可点的东西有按下反馈（`press` 动作或 `:active` 色阶）；有意义的点按（切换、确认、危险操作）调 `haptic()`（`web/src/lib/touch.ts`）。
- **悬停**只给精确指针，并包在 `@media (hover: hover)` 里（机器守着）；行内动作桌面上悬停才浮现（用透明度，占位不变不跳），触屏常显或靠左滑。
- **危险 / 不可逆**：两步确认，或者先拍现场、做完可找回——回滚、撤销文件、拒绝并停止、删会话都是这样。提示可以带一个动作（停 8 秒）。
- **交互卡一次一张**：停靠区（`web/src/components/cards/CardDock.svelte`）同一时刻只挂一张；卡片刚出现 400ms 内吞掉点击防误触（`web/src/components/cards/CardGuard.svelte`，P10）。
- **手机上回车是换行**，发送靠按钮。桌面回车发送、Shift+回车换行；输入法组字中（`isComposing`）的回车不发送。
- **两选一的视图切换**用分段控件；**开 / 关**用开关；**一次性动作**用按钮。
- **空态**说清楚为什么空、去哪看。**加载**只在「手里还什么都没有」时显示，有旧数据就先显示旧的、静默刷新。
- 触控目标：手机上不小于 40×40（菜单项 44 高）。

## 7. 稳定：运行中与完成态同高

- 卡片跑着和跑完一样高，结束时不收缩——结束一收，上方高度一变，读到一半的位置就跳（K39）。活动行常驻占位，不要时有时无。
  子 agent 卡（`web/src/components/feed/AgentCard.svelte`）与工作流卡（`web/src/components/feed/WorkflowCard.svelte`）从派出去起就在、
  跑完不收成一行：停在终态，只是微光停下、「此刻一行」换成结果。
- 流式正文只让尾块变：稳定块渲一次、按起点缓存（`web/src/lib/markdown.ts`，U7）。
- 时间线的显示分组（工具组只收只读探索、做完的轮收成一行、一批并行的子 agent 合成一张卡）都在纯函数 `web/src/lib/feed-units.ts`；最近这一轮不折（U8）。

## 8. 文案

- 中文、人话、只说结果：工具行第二行（U8）；出错 = 一句人话 + 这一轮已经执行过几次工具 + 原始报错折起来 + 「接着做」（U6）；权限卡先说为什么要问（P11）。
- 不以「失败了」收尾：给下一步（接着做、找回、切到别的视图）。
- 数字、路径、代码用 `--font-mono`；中文正文不用等宽。

## 9. Svelte 5 的坑（写了就会踩）

- 模板插值拼的类（`class="st-{x}"`）配 scoped 规则会被编译器当成没用到剪掉：写 `.stb:global(.st-A)`。
- 往 `$state` 数组 push 字面量之后，要改就改数组里那个代理元素，别改字面量（`web/src/lib/timeline-reducer.ts` 的 `pushItem`）。
- 类型谓词别放进模板条件：false 分支会把整个类型排除掉，svelte-check 报「比较无重叠」——改成返回 boolean（P10）。
- `{@const x = 某个状态}` 在按钮回调里清掉状态之后再读 `x` 会拿到 null（U9）。
- `$effect` 里读了自己要写的状态会自己触发自己：读写分开，或者把副作用包进 `untrack`。
- 界面要读的配置字段必须是 `$state`（`Chat.cfg`，09-05）。
- **别给属性或变量起名 `state`**：组件里一旦有叫 `state` 的变量，`$state(…)` 会被当成对这个变量的 store 订阅，运行时报 `store_invalid_shape`。
- 组件根元素上的过渡要 `|global`，否则父级 `{#if}` 卸载它时退场动画不播。
- 服务端测试会直接 import 的 `web/src/lib` 模块必须是纯 TS、不碰 DOM 类型——要 DOM 的拆到别的文件（`web/src/lib/copy-click.ts`，U7；`web/src/lib/i18n-boot.ts`：`i18n.ts` 只留纯的 `t / tc / tr`）。`npm test` 的 `tsc --noEmit` 不带 DOM lib，碰了就红。
- 宿主往 `.main` 上加 `hx-dnd-on` 类：挂 `chatDrop` 的节点只许静态 class + `class:` 指令，动态 `class={…}` 会把它冲掉。

## 10. 提交前自查

- [ ] `npm test` 绿（含设计守卫、svelte-check 基线）
- [ ] 深浅两套主题都看过；手机宽度（375px）、折叠屏（752px）、桌面（1280px）都看过
- [ ] 新功能按能力位出现，旧后端不报错
- [ ] 在浏览器里真点过（一次性预览实例：假 provider + DUMMY 令牌），控制台零报错
- [ ] 前端改动要在 bridge 里验证（经 `@hx` 别名编译）——独立构建通过不是交付终点（见 `AGENTS.md`）
