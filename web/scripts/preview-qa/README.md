# 文件预览验证（preview-qa）

改 `web/src/components/preview/**` 和查看器相关的 lib 之前先跑一遍基线，改完再跑一遍对比。全部只在本机 `127.0.0.1`、临时目录（`%TEMP%\bridge-preview-qa\`，可用环境变量 `PREVIEW_QA_ROOT` 改）里跑，不碰 8787、不碰正式数据，也不附着你的浏览器或桌面壳。命令在仓库根执行，Git Bash 与 PowerShell 写法相同。

## 三条常用命令

```bash
# 1. 生成样张（一次就够，已有的跳过；首次约 1 分钟、约 470MB；缺省输出到 %TEMP%\bridge-preview-qa\vault\预览样张）
python web/scripts/preview-qa/make-samples.py

# 2. 起隔离的免鉴权后端 + vite（自动找空闲端口，--ttl 分钟后自己退，缺省 60）；用完按 PID 收掉
node web/scripts/preview-qa/dev.mjs start --name a
node web/scripts/preview-qa/dev.mjs stop --name a

# 3. 跑场景（输出 report.json、summary.md（含数值摘要）、JPEG 截图；缺省输出到 %TEMP%\bridge-preview-qa\runs\<时间戳>\）
node web/scripts/preview-qa/run.mjs --name a --profiles p393,d1440 --scenarios open-,swipe-
```

## 改版前后对比

```bash
node web/scripts/preview-qa/dev.mjs start --name base --ref e890b324 --fresh   # 前端用该提交的 git 快照（不受工作区半成品影响）
node web/scripts/preview-qa/dev.mjs start --name new --fresh                   # 前端用当前工作区
node web/scripts/preview-qa/run.mjs --name base --out runs-base                 # --out 相对路径按当前目录算；建议给 %TEMP% 下的绝对路径
node web/scripts/preview-qa/run.mjs --name new  --out runs-new
node web/scripts/preview-qa/compare.mjs runs-base runs-new                     # 对齐「档 / 场景 / 指标」，写 runs-new/compare.md
node web/scripts/preview-qa/dev.mjs stop --name base
node web/scripts/preview-qa/dev.mjs stop --name new
```

- `--ref <提交>`：前端 `git archive` 到 `%TEMP%\bridge-preview-qa\snap-<sha>\`（导出一次复用；`node_modules` 用 junction 指回主树；老提交缺 dev 用的 isOffline 开关时自动补这一行测试设施，补了什么会记进 pid.json 与报告）。后端始终用当前树。
- `--web <目录>`：前端用任意一份 `web/` 源码树（比如另一个 worktree）。
- `--fresh`：起之前清掉该实例的数据根（服务端 Office 转 PDF 缓存、缩略图缓存都在里面），第一档的 docx / pptx 打开耗时才是「冷」的。
- 长跑中途断了：同一个 `--out` 加 `--resume` 重跑，跑完过的档直接沿用，只补没跑完的档（前端来源或场景筛选对不上会拒绝拼接）。
- 多实例并存：`--name` 各起各的（数据根各自独立、共用样张 vault），端口自动错开；`stop --name x` 只收 x，`stop --all` 会收全部实例（别人在用时不要用）。

## 要点

- 视口档：`p393`（393×873、DPR 2.75、触摸、WebView UA、安全区 40/20）、`p360`、`fold720`、`d1440`、`d1440-dark`、`d1440-125`。见 `gestures.mjs` 的 `PROFILES`；缺省跑前五档。
- 场景在 `scenarios/*.mjs`，模板是 `scenarios/_template.mjs`（`_` 开头的文件不加载）。断言分三级：`must` 不过就算场景不过；`goal` 是改版目标，基线上不过是正常的；`info` 只做记录。`run.mjs --list` 列出全部场景。
- 手机「本地」分页：场景写 `mode: 'apk'` 就会装本地桩（`localstub.mjs`）。桩会注入 AndroidStore，拦截 `/__localfile`（Range 回 206，`thumb=` 缩略图现用 sharp / ffmpeg 生成并缓存），并打开 `web/src/lib/server.js` 里只在 dev 下生效的 isOffline 开关（`?offlinemock` 或 `window.__BRIDGE_DEV_OFFLINE__ = true`）。写 `mode: 'apk:150'` 时每个请求额外慢 150ms，模拟 SAF 慢路径；全局可用 `run.mjs --local-delay 150`。
- 查看器根元素认 `[data-pv-root]` 或 `.mv-root`（新外框请挂 `data-pv-root`）。场景只靠 `window.__pvqa`（`lib/page.mjs`）和通用判定（`lib/checks.mjs`）取数，不绑组件类名。
- 手势库自检：`run.mjs --name a --scenarios selftest- --profiles p393,d1440 --no-shots`。
- 坑：worktree 和快照的 `node_modules` 是指回主树的 junction，vite 按真实路径核对 `fs.allow`；`lib/vite-boot.mjs` 已把两个 `node_modules` 的真实路径补进 allow，否则 pdf.js worker 回 403，所有 PDF 与转 PDF 的 Office 都会「加载失败」。不要绕开 `dev.mjs` 直接用 `npx vite` 起来做检测。
- 进程纪律：两个进程都带 `--qa-name` 与 `--ttl` 自杀定时器；`stop` 先用 Win32_Process 核对命令行再 `taskkill /T /F`，收干净后删掉实例独占的临时目录（soffice 的 `lo-prof-*`）。每档一个新的无头 Edge（临时 profile），跑完按 user-data-dir 找到进程收掉。
