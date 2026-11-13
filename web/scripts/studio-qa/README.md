# Media Studio 真机条件检测（studio-qa）

**改 Studio（`web/src/components/studio/**`、`web/src/modules/studio/**`、ios27 的 Sheet / Menu / Segmented / Toggle）之前先跑一遍、改完再跑一遍，0 问题才算完。**
2026-11-05 v7.29 在维护者手机上翻车（上传全失败、输入框无限长高、sheet 被裁、标签压图），三轮验收全是「桌面无头浏览器 390 宽截空态」——没开触摸、没设 DPR、没放大字号、没打开浮层、没走真实素材来源。这套脚本就是为了不再靠肉眼截空态。

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

外加一道**截图健全性**（`shotcheck.mjs`，依赖 sharp）：截图和 DOM 对不上（底色实心的元素颜色不对、露着的文字那块是一片纯色、顶栏在画面下方原样平铺）
就强制重新合成重拍，最多再拍两次，还坏记 `shot` 类问题；坏的首拍另存 `*.shotfail-N.jpg`，`summary.md` 里列出首拍坏过的状态。
无头 Edge 软件光栅化、机器一忙时偶发把还没画完的瓦片截下来（约 0.4%，手机档和桌面档都有）——DOM 是好的，坏的是截图，**不核对就会把坏图当通过、当对比图**。

有意的横向滑动区标 `data-hscroll`（或加进 `detect.mjs` 的 `HSCROLL_OK`）；有意的省略号要真写 `text-overflow: ellipsis`。

## 状态清单（`scenarios.mjs`）

四个创作页 × 空态 / 有历史 / 生成中 / 出错 / 完成；图像续改链；维护者截图复现（多行长文 + 改图素材）及键盘弹起版；4 份素材 + 血缘 + 超长文件名；
首尾帧、参考音频、Lyria 2 中文提示；超长模型名 / 服务名；每页的模型选择器、参数（含滚到底）；chip 定位；＋ 选用处 / 选来源；工作空间选图；音色；
任务托盘（满 / 空）；侧栏（抽屉 / 推入 / 常驻）、搜索、筛选、文件；作品菜单（图像 / 配音）；落点托盘（系统拖文件 / 拖作品）；
设置 › Media Studio 首页、滚到底、默认模型、添加服务、服务编辑器四区、Google 云凭据。
v3（`v3-*`，2026-11-06）：自动识别出来的模型与参数——十几个参数的 schema 模型（`__qa.bigModel()`：42 项长枚举、超长英文标签、desc / unit / hint / when）、长枚举菜单与搜索、值芯片菜单、
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
   相册上传（系统选择器真塞文件）、粘贴、工作空间选图、抽屉里按住拖进输入框、接着做、返回键逐层关、桌面从系统拖入；
   每种上传都核对「发给后端的 `upload` 是 uploads 相对名、`/api/upload/raw` 能取回」。`--gen` 才真生成（图像 Lite 1K，最多 3 张）。

## 局域网直连下的媒体（`lanshell.mjs`）

`run.mjs` 走 vite 同源，媒体一定加载得出来；维护者在家走的是**离线 apk 壳 + 局域网直连**（页面在 `https://appassets.androidplatform.net`，
API 和媒体前缀是学到的 `http://<局域网>:<端口>`，媒体带 `?token=`），2026-11-06 那次「最近的图像全是灰块」只有这条路上才看得见。
`lanshell.mjs` 用构建产物模拟这个壳（本地 HTTPS 出静态前端、`tunnel.test` 反代隔离实例、`--allow-running-insecure-content` ≈ WebView 的 MIXED_CONTENT_ALWAYS_ALLOW），
逐页数媒体元素（作品流、最近、画布、全屏视频播放器、配音 / 音乐的 `<audio>`）加载成没成、走的哪条线：
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

## 检测 0 问题之后：派一个独立复核

检测器只认几何（越界、裁切、遮挡、点按区……），认不出「语义」上的粗糙：省略号截掉的正好是区分词（「Nano Banana …」丢了 Pro）、
菜单从「…」钮下沿开把自己那一行切成半截、整页没有一个勾看不出当前选的是哪个、单字孤行。2026-11-05 这一轮就是检测清零之后，
复核子 agent（最难档）只拿截图目录和维护者原话、扮挑剔维护者，又挑出二十多条。做法：等截图目录稳定（别在它看的时候重跑覆盖）再派，
不给它 `*.marked.jpg` / `report.json`，修完再请它用新图复审一遍。`contact.mjs` 拼对照图给它用。

## 坑

- `Runtime.evaluate` 别开 `replMode`：异步 IIFE 会直接回 `{}`，所有等待都失效。
- `Page.addScriptToEvaluateOnNewDocument` 跑的时候 `<html>` 还没建，往根元素写东西要等 `readystatechange`。
- 触摸仿真会在最后的指针位置画一个灰色圆点，截图前把指针挪出视口（`run.mjs` 的 `settle` 已做）。
- 每一档起一个全新的 Edge 进程；收尾按 user-data-dir 找根进程按 PID 收，不按命令行通配杀。
- 检测跑着的时候别改 `web/src`：vite 热更新会把正在跑的页面搅乱，结果作废。
