# Media Studio 真机条件检测（studio-qa）

**改 Studio（`web/src/components/studio/**`、`web/src/modules/studio/**`、ios27 的 Sheet / Menu / Segmented / Toggle）时按改动范围跑，0 问题才算完：**

| 改动 | 跑什么 |
|---|---|
| 一个创作页或单个组件 | `--states` 只跑受影响的状态，`--only` 挑一两档（至少一档手机） |
| 共用构件（Sheet / Menu / Segmented / Toggle、外壳、侧栏） | 受影响的状态跑全部档 |
| 复核意见修完 | 只重跑被改到的状态 |
| 大改版、对外发版 | 全矩阵，再加下面的独立复核 |

已经按上表验过的改动，发布前不再补跑一轮全矩阵。

这套脚本模拟真机条件（触摸、DPR、放大字号、打开的浮层、真实素材来源）。只在桌面无头浏览器里截空态，看不出这些问题。

## 它模拟什么

| 档 | 视口 | DPR | 其它 |
|---|---|---|---|
| `p393` | 393×873 | 2.75 | 维护者的手机（1080×2520）；触摸、安卓 WebView UA、`--sat 40 / --sab 20` |
| `p393-115` / `p393-130` | 同上 | 2.75 | 系统字号 115% / 130% |
| `p360` / `p360-115` / `p360-130` | 360×780 | 3 | 窄屏安卓 |
| `fold720` | 720×900 | 2.5 | 折叠屏展开（medium 档） |
| `t820` | 820×1180 | 2 | 平板 |
| `d1440` | 1440×900 | 1 | 桌面，无触摸 |
| `p393-en` / `d1440-en` | | | 英文界面抽测 |
| `p393-dark` | | | 暗色 |
| `d1440-desk` | | | 桌面壳那套设置外壳（`?fdmock`），只跑 `set-*` |
| `d1440-dark` | 1440×900 | 1 | 桌面暗色（v3 起：纸墨亮暗两套都要看） |

- **字号放大**：apk 没调 `setTextZoom`，WebView 跟随系统字号，走的是 Blink 的 TextZoomFactor（所有 font-size 和 px 行高乘系数，宽高内距不变）。CDP 没有这个开关，`textzoom.mjs` 改写 CSSOM 来模拟（见文件头注释）。
- **安全区**：和 apk 原生注入一样，在根元素 inline style 上写 `--sat` / `--sab`。
- **键盘弹起**：`image-longprompt-kb` 临时把视口压到 520 高、`--sab` 归零（apk 键盘弹起时 WebView 用 bottomMargin 收缩）。
- **动画**：全部关掉（截图那一刻 CSS 动画才起跑会截到半透明的第 0 帧）。

## 它检查什么（`detect.mjs`，每类只报根因那一个元素）

`viewport` 超出视口左右 · `layer` 浮层 / 菜单 / sheet 超出视口 · `spill` 内容顶出所属卡片 / 按钮 / 浮层 · `clip` 文字被裁却没有省略号 ·
`textspill` 文字比所在块宽 · `cover` 可点控件被盖住 · `tap` 触屏点按区 < 32（算上 ::before / ::after 的命中扩展）· `hscroll` 意外横向滚动 ·
`safe` 控件压在手势条 / 状态栏里、滚动区滚到底最后一项仍被裁 · `squeeze` 画布被挤到 < 22% 视口、输入框 > 45% 视口 · `overlap` 两段文字压在一起。
v4：输入栏浮在作品墙 / 焦点上面——墙里被输入栏盖住、但还能往下滚出来的不算 `cover`；墙 / 焦点滚到底，最后一项要露在输入栏上面（`safe`）；`squeeze` 量的是顶栏和输入栏之间露出来的那截墙。

外加一道**截图健全性**（`shotcheck.mjs`，依赖 sharp）：截图和 DOM 对不上（底色实心的元素颜色不对、露着的文字那块是一片纯色、顶栏在画面下方原样平铺）
就强制重新合成重拍，最多再拍两次，还坏记 `shot` 类问题；坏的首拍另存 `*.shotfail-N.jpg`，`summary.md` 里列出首拍坏过的状态。
无头 Edge 软件光栅化、机器一忙时偶发把还没画完的瓦片截下来（约 0.4%，手机档和桌面档都有）——DOM 是好的，坏的是截图，**不核对就会把坏图当通过、当对比图**。

有意的横向滑动区标 `data-hscroll`（或加进 `detect.mjs` 的 `HSCROLL_OK`）；有意的省略号要真写 `text-overflow: ellipsis`。

## 状态清单（`scenarios.mjs`）

v4「作品台」（方案 §12，2026-11-26 重写）。墙的底子是隔离后端里的真实作品（`__qa.init()` 拉四面墙 + 素材架拍下来，`__qa.reset()` 每个状态放回去），
要极端内容的状态再往上叠造出来的（`__qa.asset` / `__qa.clone` 真作品换 id）。
- **作品墙**：四页 × 真实作品 / 空墙 / 生成中取景框（`__qa.runJob`，按比例参数画框）/ 失败卡（`__qa.failJob`）；失败卡点开详情；任务完成原地显影成格子；
  极端比例与超长时长；配音并卡切音色、点开全文、超长文字；顶栏种类上在跑的墨描。
- **焦点**（`__qa.focus(作品, { chain, at, dev, err })`）：横图 / 竖图 / 续改链版本条 / 续改中 / 续改失败 / 超长提示词 / 视频 / 「…」菜单 / 「接着做」菜单 / 焦点开着时的素材行。
- **托盘与单项卡**：四页托盘（宽屏先收起参数坞）、改过的段、十几个参数、自定义尺寸、开关段；点比例 / 档位 / 16 项比例 / 尺寸取景框 / 张数 / 时长 / 长枚举 / 音色段。
- **输入栏**：发送键胀出、长文 + 改图素材（及键盘弹起）、4 份素材 + 血缘、首尾帧、参考音频、Lyria 2 中文、超长模型名。
- **全部参数**（手机表单 / 平板居中卡 / 宽屏参数坞）四页及滚到底；**模型选择器**四页（同名合一行）+ 超长名；**＋ 添加素材**：用处 / 来源 / 作品（手机格子表单、宽屏挑选态）/ 工作空间。
- **素材架**：打开（宽屏展开、平板手机抽屉）/ 搜索无结果 / 文件 / 挑选态 / 空 / 宽屏收着 / 格子菜单；**作品菜单**：墙上、最下面一格、配音行；**落点托盘**；**设置入口**（齿轮）+ 设置各页。
- v3（`v3-*`，2026-11-06）：自动识别出来的模型与参数——十几个参数的 schema 模型（`__qa.bigModel()`：42 项长枚举、超长英文标签、desc / unit / hint / when）、长枚举菜单与搜索、
后端会话真跑出来的样例目录（`catalog-v3.sample.json`，`__qa.v3(页, 模型 id 正则)` 换进 `studio.catalog`，收尾 `__qa.restoreCatalog()`）：选择器（分组 / 厂商小组 / 新模型朱点 / 参数来源 / 搜索含备选）、继承卡、通用卡、Seedance 参考视频音频。**加了新构件 / 浮层就在这里补一项**——检测只看得见被打开过的状态。

## 怎么跑

1. 起一个**隔离的** NO_AUTH 后端（worktree 拷来的 `config.json` 指着正式工作空间和账号库，必须改道，见记忆 `project_bridge_dev_backend_ports`）：
   数据根、`VAULT_PATH`、`BRIDGE_USERS_ROOT` 全指临时目录，`BRIDGE_MODULES_SKIP=dimensio,codex`、`BRIDGE_CLAUDE_IN_CHROME=0`、`BRIDGE_NO_ROUTINES=1`。
   想要真实的模型目录（参数矩阵）就把 `vertexProject / vertexLocation / vertexMediaLocation / geminiApiKey / openrouterApiKey` 几个键拷进临时数据根的 `config.json`（别打印值），首次启动会自动导入成服务。
2. `BRIDGE_API=http://127.0.0.1:<后端端口> npx vite --config scripts/studio-qa/vite.qa.mjs --port <端口> --strictPort --host 127.0.0.1`（在 `web/` 里）。
   `vite.qa.mjs` 只把依赖缓存挪到系统临时目录：worktree 和主树共用 `web/node_modules/.vite`，两个 vite 同时启动会互相覆盖、整轮作废。
   改了很多轮热更新后先重启 vite 再跑（冷模块图）。
3. 检测：
   ```
   node web/scripts/studio-qa/run.mjs --url http://127.0.0.1:<vite 端口>/ --out <输出目录>
   #   --only p393,p360-130   只跑这几档      --states image-,ov-params   只跑 id 以这些开头的状态      --no-shots 不截图
   ```
   输出：每档一个目录（`<状态>.jpg`，有问题再多一张 `<状态>.marked.jpg` 把问题框出来）、`report.json`、`summary.md`（每档计数 + 问题清单）。全矩阵约 40 分钟。
4. 真实操作流（真后端、真触摸、真上传；默认不花钱）：
   ```
   node web/scripts/studio-qa/flows.mjs --url http://127.0.0.1:<vite 端口>/ --out <目录> --files <放了 jpg / png 的目录> [--gen]
   ```
   相册上传（系统选择器真塞文件）、粘贴、工作空间选图、＋ → 作品格子、左缘右滑拉出素材架按住拖进输入框、文件里按住拖进输入框、焦点「接着做」、
   返回键逐层关（表单 → 焦点 → 挑选态 → 抽屉）、桌面从系统拖入、桌面 ＋ → 作品进素材架挑选态；
   每种上传都核对「发给后端的 `upload` 是 uploads 相对名、`/api/upload/raw` 能取回」。`--gen` 才真生成（图像 Lite 1K，最多 3 次）：
   墙上发一张核对「取景框那一格原地换成作品格子（同一节点）」，打开它接着改核对「版本条多一格、焦点跟到新一版」，截图逐段存下。
   工作空间那两步要数据根的 `VAULT_PATH` 里有 `素材/` 文件夹（放一张叫「海边小屋」的图）；文件用复制的，别硬链接。
   `--model <模型 id> --provider <服务名片段>` 换出图的模型 / 指定走哪家；`--token <令牌>` 给令牌模式的后端用（先写进 localStorage）。
   隔离 NO_AUTH 实例的数据根里没有 `secrets/vertex-credentials.json`（Vertex 回 403、Gemini API 的托管密钥也 403），要真出图就另起一个
   令牌模式实例（数据根用副本、把那份凭据**复制**进它的 `secrets/`，用完删掉），再起一个指向它的 vite；vite 代理只改 Host 不改 Origin，
   令牌模式后端的 CSRF 守卫会把写请求拒成 `403 cross-origin forbidden`——给这个 vite 的代理加 `configure: (p) => p.on('proxyReq', (r) => r.removeHeader('origin'))`。

## 局域网直连下的媒体（`lanshell.mjs`）

`run.mjs` 走 vite 同源，媒体一定加载得出来；维护者在家走的是**离线 apk 壳 + 局域网直连**（页面在 `https://appassets.androidplatform.net`，
API 和媒体前缀是学到的 `http://<局域网>:<端口>`，媒体带 `?token=`），2026-11-06 那次「最近的图像全是灰块」只有这条路上才看得见。
`lanshell.mjs` 用构建产物模拟这个壳（本地 HTTPS 出静态前端、`tunnel.test` 反代隔离实例、`--allow-running-insecure-content` ≈ WebView 的 MIXED_CONTENT_ALWAYS_ALLOW），
逐页数媒体元素（v4：作品墙、图像 / 视频焦点、全屏视频播放器、配音 / 音乐点播放后的 `<audio>`、左缘右滑拉出的素材架）加载成没成、走的哪条线：
```
cd web && BRIDGE_APK_OUT=<临时目录> npx vite build          # 别往主树 public/app 构建
node web/scripts/studio-qa/lanshell.mjs --app <临时目录> --api http://127.0.0.1:<令牌模式实例端口> --config <实例数据根>/config.json --out <目录> --mode lan
#   --mode lan      局域网地址是主机名（Chromium 会把 https 页上的 http 图片 / 音视频自动升级成 https → 失败，能复现灰块）
#   --lan-ip <IP>   局域网地址用 IP 字面量（真机学到的就是 IP；用只在本机可见的虚拟网卡地址，别暴露到物理局域网）
#   --mode tunnel   不走局域网     --break   一半作品的媒体请求强制连不上，看失败态（可点「重新加载」，不是灰块）
#   --settings      量设置 › Media Studio 的条目数 / 说明小字字数 / 手机高几屏，和服务编辑器各区说明字数
```
实例要开令牌鉴权（不能 NO_AUTH，`?token=` 这条路才走得到）。修前 `--mode lan` 111 个媒体元素 111 个坏，修后 0 个坏、API 仍走局域网。

## 改版前后对比图（`compare.mjs`）

两份 `run.mjs` 输出（旧版用冻结在旧提交的 worktree 跑它自己那份脚本）按「档 / 状态」左右并排：
```
node web/scripts/studio-qa/compare.mjs --a <旧输出> --b <新输出> --out <目录> --la v2 --lb v3 d1440/image-chain p393/ov-params-image p393-dark/drawer
```
发出去之前逐张看一遍（截图会坏）。

## 大改版：检测 0 问题之后派一个独立复核

检测器只认几何（越界、裁切、遮挡、点按区……），认不出「语义」上的粗糙：省略号截掉的正好是区分词（「Nano Banana …」丢了 Pro）、
菜单从「…」钮下沿开把自己那一行切成半截、整页没有一个勾看不出当前选的是哪个、单字孤行。2026-11-05 这一轮就是检测清零之后，
复核子 agent（最难档）只拿截图目录和维护者原话、扮挑剔维护者，又挑出二十多条。做法：等截图目录稳定（别在它看的时候重跑覆盖）再派，
不给它 `*.marked.jpg` / `report.json`，修完再请它用新图复审一遍。`contact.mjs` 拼对照图给它用。

## 坑

- **`__qa` 要拿应用自己那一份模块**：热更新过的模块地址带 `?t=<时间戳>`，import 裸路径会拿到另一份实例（状态对不上、「等不到模型目录」）。
  `__qa.imp()` 按页面实际请求过的地址（performance 资源记录，已把缓冲放到 50000 条）去 import。
- **截图超时 / 截图和页面对不上、单独重跑又好的**：先看控制台有没有 Svelte 抛错——v4 托盘段离场动画的负 delay 让 `element.animate` 抛错，
  整棵 Studio 停止更新，之后合成器还在、页面却「冻住」，表现成一串截图超时和坏图（2026-11-26，已修）。
- **连跑二三十个状态后 rAF 半秒一帧**（截图干等、浮层弹出卡在第 0 帧、抽屉弹簧落不了地、返回键关不掉层）：主线程是闲的，是无头 Edge 那点光栅内存
  被还没回收的离屏画布 / 解码过的图占满了。2026-11-26 两处处理：显影引擎 `ink.js` 加 `dispose()`，取景框 / 焦点卸载时把画布宽高归零（真机也省内存）；
  脚手架起 Edge 带 `--js-flags=--expose-gc`，`__qa.reset` / flows 的复位先 `gc()`。`capture` 拍前还会挂一帧 `translateZ(0)` 逼合成器出帧，`settle` 等不完的动画直接 `finish()`。
  判断是不是它：页面里量 rAF（flows 的 back-layers 没过时会带上 `raf300`）。
- **触摸仿真里左缘右滑会触发 Chromium 的「滑动后退」**，整页退回 about:blank（WebView 没有这个手势）：`cdp.mjs` 用 `--overscroll-history-navigation=0` +
  `--disable-features=…,OverscrollHistoryNavigation` 关掉。同一个手势在作品墙上起手要靠墙的滚动区 `touch-action: pan-y`，否则浏览器一见横向移动就接管、发 `pointercancel`。
- **flows 启动别在 navigate 之后马上求值**：那一下可能还落在旧文档（about:blank 的 readyState 早就是 complete），`__qa.init()` 跑在旧页里，新页里 `__qa.m` 是空的。

- `Runtime.evaluate` 别开 `replMode`：异步 IIFE 会直接回 `{}`，所有等待都失效。
- `Page.addScriptToEvaluateOnNewDocument` 跑的时候 `<html>` 还没建，往根元素写东西要等 `readystatechange`。
- 触摸仿真会在最后的指针位置画一个灰色圆点，截图前把指针挪出视口（`run.mjs` 的 `settle` 已做）。
- 每一档起一个全新的 Edge 进程；收尾按 user-data-dir 找根进程按 PID 收，不按命令行通配杀。
- 检测跑着的时候别改 `web/src`：vite 热更新会把正在跑的页面搅乱，结果作废。
