# Muse Bridge

[English](README.md) · **简体中文**

**在 [Muse](https://muse.ai) 的 agent VM 上一键部署 Claude Code**：装好之后，用手机或电脑的浏览器打开一个网址，就能用 Claude Code 写代码、处理文件、跑命令。也可以选装 **dimensio**，一个能接各家模型 API 的 agent 工作台，支持 Anthropic、OpenAI、Gemini、DeepSeek、Kimi、智谱、通义、小米 MiMo 等。

部署交给 Muse 自己做：你只要把一段话发给它，它会下载安装包、问你三个问题、装好、注册自愈看门狗，再一步步带你上手。整个过程不用碰命令行。

![dimensio：用小米 MiMo 自家的联网搜索查天气，回答附来源](docs/images/dimensio-web-search.png)

## 亮点

- **一句话部署**：把开场提示词发给 Muse，剩下的它来做，大约 5–10 分钟。
- **手机、电脑都能用**：打开网址就是完整的工作台，界面支持简体中文和 English，默认跟着浏览器语言。
- **安卓 app**：在「设置 → 安卓 app」里下载，或者[直接下载 apk](https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk)。记得住服务器地址，临时地址变了能在 app 里直接换；界面和网页版一样，随服务器自动更新。
- **Claude Code 完整体验**：由官方 Claude Agent SDK 驱动，支持工具调用、子 agent、工作流、上下文压缩和会话续接。右侧工作台有终端、文件、任务和改动审阅。
- **dimensio 多模型工作台**：一家一把 key，随时切换模型；也能接任意 OpenAI 兼容的自定义服务。自带工作区、记忆和子 agent。
- **各家原生联网搜索**：当前对话用哪家模型，就先用哪家自己的搜索，失败了自动换下一家，最后才退回 DuckDuckGo。
- **VM 重启自动恢复**：Muse 的 VM 会不定期重启，看门狗在 60 秒内把服务拉起来；临时地址变了，Muse 会主动告诉你新地址。
- **主动提醒更新**：有新版本时，Muse 会用一两句话告诉你更新了什么，问你要不要更新。更新会等没人在聊天时才切换，新版本起不来会自动退回。
- **可以多人用**：用邀请码注册，每个账号有独立的目录，可以按人分配 agent 和额度。

## 开始使用

把这段话**整段**发给你的 Muse：

````text
我想请你在这台 VM 上安装 Muse Bridge，装好后教我怎么用。这是我自己选的一个开源项目（MIT 协议）：一个能用浏览器打开的 Claude Code / AI agent 工作台。源码和发布包在 https://github.com/Wode44398/muse-bridge （项目比较新，搜索引擎可能还搜不到，直接打开这个链接就行）。

第一步，下载最新的发布包并核对校验和。这台 VM 出站要走 hatch-egress-proxy 代理：

```bash
export HTTPS_PROXY=http://hatch-egress-proxy:3128 HTTP_PROXY=http://hatch-egress-proxy:3128
REL=/home/hatch/bridge-releases/$(date +%Y%m%d-%H%M%S) && mkdir -p "$REL" && chmod 755 /home/hatch/bridge-releases "$REL"
cd /tmp && curl -fLO --retry 3 https://github.com/Wode44398/muse-bridge/releases/latest/download/muse-bridge.tgz && curl -fLO --retry 3 https://github.com/Wode44398/muse-bridge/releases/latest/download/muse-bridge.tgz.sha256 \
  && sha256sum -c muse-bridge.tgz.sha256 && tar -xzf muse-bridge.tgz -C "$REL" && echo "解压到 $REL/bridge"
```

第二步，读 `$REL/bridge/deploy/muse/MUSE.md`，这是项目专门写给你的安装指南。按它来：先按第 1 节用一条消息问我三个安装问题，然后安装、配好看门狗 hook、检查结果，再带我上手。里面如果有你觉得不对或不安全的地方，停下来问我。

每条命令都要我批准，所以请尽量少跑命令。安装脚本会自己打印进度，不用拿 tail、ps、sleep 去轮询。每一步都把真实输出给我看。
````

Muse 会下载安装包、读安装指南，然后一次问你三个问题：

1. **装什么**：只要 Claude Code、只要 dimensio，还是两个都要。只选一个时，打开网址直接就是那个 agent。
2. **有没有自己的域名**（托管在 Cloudflare）：没有就用免费的临时地址，VM 重启后地址会变，变了 Muse 会告诉你；有的话可以换成固定地址。
3. **自己用还是多人用**：选多人用，就可以给朋友发邀请码。

拿不准就选：只要 Claude Code、临时地址、自己用。这些以后都能改。

## 你需要准备

- 一个 Muse 账号。
- 用 Claude Code：一个 Claude Pro 或 Max 订阅。令牌要在**你自己的电脑上**运行 `claude setup-token` 生成（Muse 会带你做），不要在 Muse 的 VM 上登录 Claude。
- 用 dimensio：至少一家模型厂商的 API key。

## dimensio 支持哪些模型

![dimensio 的模型选择器（英文界面）](docs/images/dimensio-models.png)

| 厂商 | key 的名字 | 联网搜索 |
|---|---|---|
| Anthropic（Claude） | `ANTHROPIC_API_KEY` | ✓ 自家搜索 |
| DeepSeek | `DEEPSEEK_API_KEY` | ✓ 自家搜索 |
| Google Gemini | `GEMINI_API_KEY` | ✓ Google 搜索 |
| Kimi（Kimi for Coding 订阅，`sk-kimi-` 开头） | `KIMI_API_KEY` | ✓ 自家搜索 |
| 智谱 GLM | `ZHIPU_API_KEY` | ✓ 自家搜索 |
| 通义千问 | `QWEN_API_KEY` | ✓ 自家搜索 |
| 小米 MiMo（按量付费或 Token Plan） | `MIMO_API_KEY` | 见下 |
| 任意 OpenAI 兼容服务 | 在界面里点「＋」添加 | — |

key 可以让 Muse 帮你写进去（`set-api-key`），也可以直接在 dimensio 的模型面板里填。

**小米的联网搜索**是控制台「插件管理」里的一个插件，按次计费（约 ¥16 / 千次），钱从账户余额里扣，所以只有**按量付费**的 key 能用。如果你聊天用的是 Token Plan 订阅的 key（`tp-` 开头），可以再建一把按量付费的 key，单独配给搜索：`set-api-key MIMO_SEARCH_API_KEY <sk-…>`，聊天照旧用 Token Plan 的额度。不配也行，小米搜不了会自动换别家。

## 安卓 app

用手机浏览器打开你的 Muse Bridge 地址并登录，进「**设置 → 安卓 app → 下载**」。装好后回到这一页点「**在 app 里打开**」，app 会自动填好地址。也可以从 GitHub [直接下载 apk](https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk)，第一次打开时把地址粘进去。

app 只是把同一个网页界面装进独立窗口，新功能不用更新 app。连不上服务器时（比如 VM 重启后临时地址变了），app 会给出「更换地址」按钮，问 Muse 要现在的地址粘进去就行。手机拦着不让装时，按提示允许浏览器安装应用。iPhone 目前没有 app，可以用 Safari 的「分享 → 添加到主屏幕」。

## 常见问题

**Muse 老让我批「允许 Muse 与 … 分享信息？」，是怎么回事？**
Muse 的 VM 每访问一个新网站，都要你在 Muse 里批一次。安装和填 key 时，Muse Bridge 会趁你在场，把要用到的网站提前访问一遍，把审核卡片都弹出来。遇到这种卡片（可能在输入框上方，也可能在右侧的「待审核」面板里），选「允许一次」旁边下拉里的「**总是允许此站点**」，以后就不会再问。如果某个对话一直停在「等待模型回复」，多半是有一张卡片没人批。

**地址隔几个小时就变了？**
临时地址（`*.trycloudflare.com`）会随 VM 重启而变。变了 Muse 会主动告诉你新地址，登录令牌不变，换了地址重新登录一次就行。嫌麻烦就换成自己的域名，Muse 会带你配。

**怎么更新？**
什么都不用做。有新版本时 Muse 会来问你，你说「更新」就行。也可以随时问它「有新版本吗」，或者让它开自动更新。

**花钱吗？**
Muse Bridge 本身免费开源。Claude Code 用的是你自己的 Claude 订阅；dimensio 用的是你自己的模型 API key，费用由各家厂商按量收取。

## 限制

- Muse 的 VM 起不了浏览器沙箱，所以 agent 没有「打开网页、截图」这类浏览器工具；联网搜索和抓网页内容照常可用。
- 这是 Muse 平台的 VM，不是正式服务器：平台随时可能调整网络，长期对外提供服务也可能违反平台条款。别放重要数据，也别当生产环境用。

## 在普通 Linux 服务器上装

不在 Muse 上也能用。在 Debian / Ubuntu + systemd 的机器上：

```bash
git clone https://github.com/Wode44398/muse-bridge.git /opt/muse-bridge && cd /opt/muse-bridge
sudo bash scripts/server/install.sh --agents claude,dimensio
```

`install.sh --help` 查看全部选项。服务只听本机 127.0.0.1，对外访问需要你自己配隧道或反向代理（加 `--tunnel-token` 可以顺带起一条 Cloudflare 命名隧道）。更新用 `sudo bash scripts/server/update.sh`。

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 服务端（Node 24，零构建） |
| `web/` | 前端（Vite + Svelte 5） |
| `harness/` | dimensio（TypeScript，Node 原生运行） |
| `android/` | 安卓 app（WebView 壳，零依赖；发版流程负责构建） |
| `scripts/server/` | 通用 Linux 安装 / 更新脚本 |
| `deploy/muse/` | Muse 专用：一键部署脚本 `bootstrap.sh`、给 Muse 看的说明书 `MUSE.md`、运维件模板 |

## 发布新版本（维护者）

推一个 `v*` 标签。建议用带说明的标签，说明会作为更新内容展示给用户：

```bash
git tag -a v0.2.0 -m "这次更新了什么（给用户看的一两句）"
git push origin v0.2.0
```

GitHub Actions（`.github/workflows/release.yml`）会构建安卓 app（`MuseBridge.apk`，挂在 Release 上，也放进安装包的 `downloads/`），打包 `muse-bridge.tgz`，生成 `.sha256` 和更新频道 `latest.json`，并创建 Release。已经装好的 Muse 每 6 小时读一次 `latest.json`，发现新版本就问用户要不要更新。beta（如 `v0.2.0-beta.1`）也会推送。只有标签里带 `-test` 的（如 `v0.2.0-test.1`）会发成预发布版，不进更新频道，是给维护者在新 Muse 上试装用的。

apk 用仓库 Actions secrets 里的密钥签名（`ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD`）。没配（比如 fork）就退回 debug 签名：照样能装，但不能覆盖安装官方发布的包。

## 协议

[MIT](LICENSE)。Claude Code 与 Claude Agent SDK 的使用受 Anthropic 自己的条款约束；在 Muse 上部署，请同时遵守 Muse 的平台条款。
