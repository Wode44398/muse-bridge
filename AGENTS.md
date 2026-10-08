# Muse Bridge — 给编码 agent 的说明

这个仓库是 Muse Bridge：在 Muse（muse.ai）的 agent VM 上一键部署的 Claude Code / dimensio 网页工作台。
用户侧的说明见 `README.md`；Muse 部署时读的说明书是 `deploy/muse/MUSE.md`。

## 结构

- `src/`：服务端（Node 24 ESM，零构建）。入口 `src/server.mjs`，路由在 `src/routes/`，Claude 驱动在 `src/agents/claude.mjs`。
- `web/`：前端（Vite + Svelte 5）。构建产物输出到 `public/app/`，由服务端直接托管。
- `harness/`：dimensio（TypeScript，Node 原生运行 `.ts`）。服务端按用户各起一个 dimensio 进程并反代到 `/api/harness/*`；前端经 `@hx` 别名直接编译 `harness/web/src`。
- `scripts/server/`：通用 Linux 安装 / 更新脚本（systemd）。
- `deploy/muse/`：Muse 专用的一键部署（`bootstrap.sh`）、运维件模板（`ops/`）、给 Muse 看的部署运维说明书（`MUSE.md`）、
  使用说明书（`guide/`：Muse 回答「怎么用」、带用户上手的依据）和已知问题清单（`known-issues.json`，随更新频道下发）。
  **改了界面（按钮名、菜单路径、设置项），同一个提交里改 `guide/` 对应的章节**；界面名字用 **「中文」**（English）写，静态检查会核对。
- `src/feedback/`：问题反馈（白名单收集、脱敏、出草稿、发送、补发、自动上报）；网页、`bootstrap.sh report`、看门狗三个入口共用。
- `feedback-worker/`：反馈中继（Cloudflare Worker，以 GitHub App 身份开 Issue）。跟服务端共用 `src/feedback/` 的格式与脱敏代码，改那边要两边都测。

## 约定

- agent 只有两个：`claude` 与 `dimensio`（`src/config/agents.mjs` 是单一真相，前后端共用）。
- Claude 的模型表与默认值只改 `src/config/capabilities.mjs`。
- 部署目标是 Linux 服务端形态（`BRIDGE_EDITION=server`），数据目录与程序目录分开（`BRIDGE_DATA_ROOT`）。
- Muse VM 的限制（只能经 HTTP CONNECT 代理出站、`/etc` 重启不保留、没有浏览器沙箱、不能跑 Docker）都包在 `deploy/muse/bootstrap.sh` 里；通用修复放进 `src/` 或 `scripts/server/`，不要写进 Muse 专用脚本。
- 在 Linux 上执行的脚本和单元文件必须是 LF（见 `.gitattributes`）。
- 界面文案与注释用中文；不要在代码、注释或测试里写任何个人信息（真实姓名、邮箱、个人路径、私有域名、账号）。
- 问题报告只收 `src/feedback/schema.mjs` 白名单里的字段；要往报告里加东西，先加进白名单并想清楚它会不会带出隐私（报告是公开的 GitHub Issue）。

## 界面多语言（简体中文 / English）

前端（`web/src`、`harness/web/src`）的界面文字**一律包 `t('中文原文')`**，英文写进对应的分区字典
（`web/src/i18n/en/` 下的 `.js`，dimensio 用 `harness/web/src/i18n/en/` 下的 `.ts`）；服务端发来的文案在显示处包 `tr()`。
写法见 `web/src/i18n/GUIDE.md`，术语与文风见同目录 `GLOSSARY.md`。
改完跑 `node web/scripts/i18n-check.mjs <改过的文件>`，LEFTOVER / MISSING / SHADOW 必须为 0。
局部变量别叫 `t`（会遮住翻译函数）。默认中文；设置 → 通用 → 语言 切英文，地址加 `?lang=en` 可临时预览。

## 测试

```bash
npm install && node --test "src/**/*.test.mjs"      # 服务端
npm --prefix harness install && npm --prefix harness test   # dimensio
npm --prefix web install && npm --prefix web run build      # 前端构建
npm --prefix feedback-worker test                           # 反馈中继（不联网）
node --test deploy/muse/test/guide.test.mjs                 # 使用说明书的静态检查（界面名字、子命令、链接；发版前必过）
node deploy/muse/test/guide-qa/run.mjs                      # 说明书问答测试（用本机 claude -p，发版前跑一次）
```
