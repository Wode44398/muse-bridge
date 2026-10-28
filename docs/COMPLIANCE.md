# 合规、隐私与外联说明

> 不是法律意见。条款以各服务的官方最新版本为准。English summary at the end.

## 项目身份

- 本项目是独立的开源软件，与 Anthropic、OpenAI、Google 没有隶属关系，也未获得它们的认可或赞助。
- Claude、Claude Code 是 Anthropic 的商标；ChatGPT、Codex 是 OpenAI 的商标；Gemini 是 Google 的商标。界面里出现的服务名称与标志只用于标识对应服务。
- 代码以 Apache-2.0 授权（见 `LICENSE`、`NOTICE`），只覆盖本项目自己的代码。随附的第三方字体、图标等见 `THIRD_PARTY_NOTICES.md`。
- Claude Agent SDK 与 Claude Code 是 Anthropic 的专有软件，不在本仓库里：SDK 随 npm 依赖安装；Claude Code 运行组件优先用本机已装的同版本，没有时首次启动从官方 npm 源下载（见下文），不做任何修改。

**使用者需自行遵守所用服务的条款。** 你通过本项目使用的每个 AI 服务（Anthropic、Google、OpenAI 等），都受该服务自己的条款与使用政策约束。

## 数据留在你的服务器上

对话、文件、预览、分享链接、账号与配置都存在服务端的数据目录里（`BRIDGE_DATA_ROOT`，Docker 是 `bridge-data` 卷，Windows 安装包是 `%LOCALAPPDATA%\bridge-client\data`）。项目方不运营任何收集数据的服务，代码里**没有遥测、没有外发的错误自动上报**。

## 用户反馈默认不外发

设置里的「反馈」页把反馈存在本机：默认在数据根 `feedback/reports`，可用 `config.json` 的 `feedbackDir` 改到别处（绝对路径，或相对工作空间——放进工作空间就能在文件面板里翻看）。

要把反馈同时发给开发者，必须**三道门同时打开**：

1. **这台服务器配了中继地址**：环境变量 `BRIDGE_FEEDBACK_RELAY` > `config.json` 的 `feedbackRelay` > 官方安装包打包时写入的渠道地址（维护者的 `stage.ps1` 默认写官方中继，`-NoFeedbackRelay` 不写，写进程序根的 `bridge-build.json`）。源码里没有默认值，自己编译或 fork 的版本没配就整条通道不存在，设置页连开关都不显示。
2. **开服管理员主动打开**「把用户反馈同时发给开发者」（`config.json` 的 `feedbackUpstream: true`，默认关）。
3. **提交人同意**：在提交表单上勾选发给开发者；或者在对话里让 Claude 代报时，Claude 先说明报告内容和去向，提交人同意后才调 `feedback.report`（管理员本人同意时 Claude 也可以顺手打开第 2 道门）。

测试实例（`BRIDGE_NO_AUTH=1`、`BRIDGE_NO_ROUTINES=1`）一律不推不拉；`BRIDGE_FEEDBACK_UPSTREAM=0` 强制关闭。

汇总端（接收各服务器转来的反馈的那一台）要同时配 `feedbackInbox.token` 与 `feedbackRelay`。

## 服务端会主动连接的地方

除了你在界面里使用的 AI 服务本身（Claude Code 用你配置的凭据访问 Anthropic；Gemini / Vertex、dimensio 的各厂商同理），服务端只在下面这些情况下联网，都可以关：

| 什么时候 | 连哪里 | 怎么关 / 改 |
|---|---|---|
| 首次启动、本机没有同版本的 Claude Code | 官方 npm 源 `registry.npmjs.org`，慢或不通时换 `registry.npmmirror.com` | `BRIDGE_CLAUDE_CLI_DOWNLOAD=0` 或 `"claudeCliDownload": false`；自己的源用 `claudeCliRegistry` / `BRIDGE_CLAUDE_CLI_REGISTRY`（排在最前）；离线放二进制用 `claudeCliPath` / `BRIDGE_CLAUDE_CLI` |
| 打开「公网访问」且本机没有 cloudflared | 官方 GitHub Release 下载固定版本（校验 SHA-256） | 不开公网访问，或自己装好 cloudflared 放进 PATH |
| 公网访问选「临时地址」或 Cloudflare 隧道 | Cloudflare 隧道网络 | 关掉公网访问 |
| 检查桌面客户端 / 手机 App 有没有新版本 | 发布清单 `latest.json`（`clientUpdateFeed`、`apkFeed`） | `clientUpdateFeed: false`、`apkFeed: false`；`apkPrefetch: false` 不把安装包缓存到数据根 |
| 管理员打开了反馈外发（见上一节） | 配置的中继地址 | 默认关 |

## Claude 认证与额度

服务端用你提供的凭据运行 Claude Code：订阅令牌（`claude setup-token` 生成）或 Anthropic API Key，可以在「设置 › Claude › 订阅号池」里放多个账号并切换。界面上的额度信息来自 Claude Code 真实请求带回的数据；闲置的号显示的是它上次使用时的额度。本项目不另外拼请求去探测额度。

---

## English summary

- Independent open-source project, not affiliated with or endorsed by Anthropic, OpenAI or Google. Claude and Claude Code are trademarks of Anthropic, PBC. Code is Apache-2.0; third-party assets are listed in `THIRD_PARTY_NOTICES.md`. The Claude Agent SDK and Claude Code are proprietary to Anthropic and are not included.
- **You are responsible for complying with the terms of every service you use through this project.**
- All data stays on your server. There is no telemetry and no automatic error reporting.
- Feedback is stored locally (`feedback/reports` under the data root, or `feedbackDir`). It is sent to the developers only when all three are true: a relay is configured (`BRIDGE_FEEDBACK_RELAY`, `feedbackRelay`, or the build-time channel from `stage.ps1 -FeedbackRelay`), the admin turned on `feedbackUpstream`, and the person submitting ticks the box.
- Outbound connections besides the AI services you use: the Claude Code runtime download from npm on first start (`BRIDGE_CLAUDE_CLI_DOWNLOAD=0` / `claudeCliDownload: false` to disable), cloudflared from GitHub when public access is turned on, Cloudflare when a tunnel is active, and the release manifest for app updates (`clientUpdateFeed: false`, `apkFeed: false`).
