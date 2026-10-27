# Muse Bridge — 给编码 agent 的说明

这个仓库是 Muse Bridge：在 Muse（muse.ai）的 agent VM 上一键部署的 Claude Code / dimensio 网页工作台。
用户侧的说明见 `README.md`；Muse 部署时读的说明书是 `deploy/muse/MUSE.md`。

## 结构：bridge 公开版 + Muse 专属目录

代码主体就是 **bridge 公开版**，用 `deploy/muse/sync/sync-from-bridge.mjs` 从公开版的导出树整体同步过来
（上一次同步的 bridge 提交记在 `deploy/muse/sync/LAST_SYNC`）：

- `src/`（服务端，Node 24 ESM，零构建）、`web/`（前端，Vite + Svelte 5，产物进 `public/app/`）、
  `harness/` 与 `modules/dimensio/`（dimensio）、`scripts/`、`docs/` 等，**一律以 bridge 公开版为准**。
  不要在这里改它们：下次同步会整体覆盖。要改就改 bridge 本体，再同步过来。
- Muse 专属、同步时原样保留的只有脚本里 `KEEP` 列出的位置：
  - `deploy/muse/`：
    - `bootstrap.sh`（Muse 上的一键部署与运维入口）、`install.sh`（装机）、`ops/`（隧道、看门狗等运维件模板）；
    - `plugin/`（Muse 插件：设置里「插件 › 安卓 App」面板、apk 下载、项目手册的「Muse 部署」一章）；
    - `feedback/`（`bootstrap.sh report` 与看门狗用的问题报告：白名单收集、脱敏、出草稿、发送、补发、自动上报）；
    - `sync/`（同步脚本）；
    - `MUSE.md`（给 Muse 看的部署运维说明书）、`guide/`（使用说明书：Muse 回答「怎么用」、带用户上手的依据）、
      `known-issues.json`（已知问题，随更新频道下发）、`NOTES.md`（Muse VM 平台笔记）、`test/`；
  - `feedback-worker/`：反馈中继（Cloudflare Worker，以 GitHub App 身份开 Issue），和 `deploy/muse/feedback/` 共用格式与脱敏代码，改那边要两边都测；
  - `android/`：Muse 自己的安卓 App（在线 WebView 壳）；
  - `.github/`、`README*.md`、`LICENSE`、`AGENTS.md`、`CLAUDE.md`。
- 同步时还会剔除公开版里 Muse 不带的部分（脚本里的 `DROP`：Windows 客户端源码、bridge 的离线 apk 工程、Vertex 扩展、Docker 件等）。

## Muse 和 bridge 的差别只经声明表达

不改公开版的代码，而是由 `deploy/muse/bootstrap.sh` 的 `apply_bridge_declarations` 在装机 / 更新时写：

- `config.json` 的 `distro`：品牌 Muse Bridge、没选过语言时跟浏览器；
- 服务单元的环境变量：`BRIDGE_AUDIENCE_HINT`（控制台的多人开关只读，提示在 Muse 里说）、`BRIDGE_PROXY_FORCED`（模型服务一律走出站代理）、
  `BRIDGE_MODULES_HIDE=vertex,codex`、`DIMENSIO_BROWSER=off`、`BRIDGE_UPDATE_HINT`、小内存旋钮等；
- `plugins.json`：登记 Muse 插件，第一次对齐时关掉 VM 上用不了的内置功能（phone-control、phone-files、browser、edge、keep-awake）；
- Muse 插件 `deploy/muse/plugin/`。

需要新的差别时，优先在 bridge 本体里加一个声明（环境变量 / config 字段 / 插件接口），再在 `bootstrap.sh` 里写它，不要 fork 公开版的代码。

## 约定

- **改了界面（bridge 同步带来的也算），同一个提交里改 `deploy/muse/guide/` 对应的章节**；界面名字用 **「中文」**（English）写，
  `deploy/muse/test/guide.test.mjs` 会核对中文在前端源码里、英文在英文字典里（Muse 插件页的文案在 `deploy/muse/plugin/web/`，英文在页面脚本的 `EN` 对象里，也算），
  设置根页（`web/src/components/Settings.svelte`）的每个分组和每一行，设置那一章都要讲到。说明书只写这台 Muse 上真有的东西。
- Muse 上的 agent 只有 `claude` 与 `dimensio`（bridge 的 Gemini / Vertex、Codex 扩展不带）。
- 部署目标是 Linux 服务端形态，数据目录与程序目录分开（`BRIDGE_DATA_ROOT`）。
- Muse VM 的限制（只能经 HTTP CONNECT 代理出站、`/etc` 重启不保留、没有浏览器沙箱、不能跑 Docker）都包在 `deploy/muse/bootstrap.sh` 里；
  通用修复去 bridge 本体做，不要写进 Muse 专用脚本。
- 在 Linux 上执行的脚本和单元文件必须是 LF（见 `.gitattributes`）。
- 文档、注释、提交信息用中文；不要在代码、注释或测试里写任何个人信息（真实姓名、邮箱、个人路径、私有域名、账号）。
- 问题报告只收 `deploy/muse/feedback/schema.mjs` 白名单里的字段；要往报告里加东西，先加进白名单并想清楚它会不会带出隐私（报告是公开的 GitHub Issue）。
  网页里 bridge 自带的「提交反馈」在 Muse 上只留在服务器本地，不走这条通道。

## 界面多语言（简体中文 / English）

界面文字的写法（`t('中文原文')` + 英文分区字典、`tr()`、`i18n-check.mjs`）见 `web/src/i18n/GUIDE.md`，那是 bridge 公开版的规矩，改前端去 bridge 本体改。
Muse 自己的界面只有插件面板 `deploy/muse/plugin/web/index.html`：中文写在页面里，英文写在同一页脚本的 `EN` 对象里，两份一起改。
默认语言跟浏览器；设置 → 通用 → 语言 可以切换。

## 测试

```bash
node --test deploy/muse/test/guide.test.mjs                 # 使用说明书的静态检查（界面名字、设置分区、子命令、链接；发版前必过）
node deploy/muse/test/guide-qa/run.mjs                      # 说明书问答测试（用本机 claude -p，发版前跑一次）
node --test deploy/muse/feedback/*.test.mjs                 # Muse 的问题报告
npm --prefix feedback-worker test                           # 反馈中继（不联网）
node web/scripts/i18n-check.mjs                             # 同步后核对字典（bridge 自带）
node deploy/muse/sync/sync-from-bridge.mjs --from <公开版导出树> --check   # 看一次同步会动哪些文件
```

服务端、前端、dimensio 的测试（`src/**/*.test.mjs`、`harness/`、`web/`）随 bridge 公开版一起来，改动和测试都在 bridge 本体里做。
