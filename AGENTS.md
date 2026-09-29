# Muse Bridge — 给编码 agent 的说明

这个仓库是 Muse Bridge：在 Muse（muse.ai）的 agent VM 上一键部署的 Claude Code / dimensio 网页工作台。
用户侧的说明见 `README.md`；Muse 部署时读的说明书是 `deploy/muse/MUSE.md`。

## 结构

- `src/`：服务端（Node 24 ESM，零构建）。入口 `src/server.mjs`，路由在 `src/routes/`，Claude 驱动在 `src/agents/claude.mjs`。
- `web/`：前端（Vite + Svelte 5）。构建产物输出到 `public/app/`，由服务端直接托管。
- `harness/`：dimensio（TypeScript，Node 原生运行 `.ts`）。服务端按用户各起一个 dimensio 进程并反代到 `/api/harness/*`；前端经 `@hx` 别名直接编译 `harness/web/src`。
- `scripts/server/`：通用 Linux 安装 / 更新脚本（systemd）。
- `deploy/muse/`：Muse 专用的一键部署（`bootstrap.sh`）、运维件模板（`ops/`）和给 Muse 看的说明书（`MUSE.md`）。

## 约定

- agent 只有两个：`claude` 与 `dimensio`（`src/config/agents.mjs` 是单一真相，前后端共用）。
- Claude 的模型表与默认值只改 `src/config/capabilities.mjs`。
- 部署目标是 Linux 服务端形态（`BRIDGE_EDITION=server`），数据目录与程序目录分开（`BRIDGE_DATA_ROOT`）。
- Muse VM 的限制（只能经 HTTP CONNECT 代理出站、`/etc` 重启不保留、没有浏览器沙箱、不能跑 Docker）都包在 `deploy/muse/bootstrap.sh` 里；通用修复放进 `src/` 或 `scripts/server/`，不要写进 Muse 专用脚本。
- 在 Linux 上执行的脚本和单元文件必须是 LF（见 `.gitattributes`）。
- 界面文案与注释用中文；不要在代码、注释或测试里写任何个人信息（真实姓名、邮箱、个人路径、私有域名、账号）。

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
```
