# Muse Bridge

**在 [Muse](https://muse.ai) 的 agent VM 上一键部署 Claude Code**：装好之后，你用手机或电脑的浏览器打开一个网址，就能用 Claude Code 写代码、处理文件、跑命令；也可以选装 **dimensio**——一个能接各家模型 API（Anthropic、OpenAI、Gemini、DeepSeek、Kimi、智谱、Qwen、MiMo…）的 agent 工作台。

部署这件事交给 Muse 自己做：把下面这段话发给你的 Muse，它会下载安装包、问你三个问题、装好、注册自愈看门狗，再一步步带你上手。

## 开始使用

把这段话**整段**发给你的 Muse：

````text
请帮我在你这台 VM 上部署 Muse Bridge（一个能用浏览器打开的 Claude Code / AI agent 工作台），装好后带我学会使用。

第一步，下载安装包并核对校验和（出站要走 hatch-egress-proxy 代理），把输出原样贴给我：

```bash
export HTTPS_PROXY=http://hatch-egress-proxy:3128 HTTP_PROXY=http://hatch-egress-proxy:3128
REL=/home/hatch/bridge-releases/$(date +%Y%m%d-%H%M%S) && mkdir -p "$REL" && chmod 755 /home/hatch/bridge-releases "$REL"
cd /tmp && curl -fLO --retry 3 https://github.com/Wode44398/muse-bridge/releases/latest/download/muse-bridge.tgz && curl -fLO --retry 3 https://github.com/Wode44398/muse-bridge/releases/latest/download/muse-bridge.tgz.sha256 \
  && sha256sum -c muse-bridge.tgz.sha256 && tar -xzf muse-bridge.tgz -C "$REL" && echo "解压到 $REL/bridge"
```

第二步，把 `$REL/bridge/deploy/muse/MUSE.md` 从头到尾完整读一遍，然后严格照着做：先按第 1 节问我三个问题，再部署、注册看门狗 hook、验收、写进你的长期记忆，最后一步一步带我上手。每一步都把命令输出原样贴给我看，别只说「成功了」。
````

Muse 会问你：

1. **装什么**：只要 Claude Code / 只要 dimensio / 两个都要。只选一个时，打开网址直接就是那个 agent。
2. **有没有自己的域名**（托管在 Cloudflare）：没有就用免费的临时地址（VM 重启会变，变了 Muse 会告诉你）；有的话可以换成固定地址。
3. **自己用还是多人用**：多人用可以给朋友发邀请码。

## 你需要准备

- 一个 Muse 账号。
- 用 Claude Code：一个 Claude Pro 或 Max 订阅。令牌要在**你自己的电脑上**运行 `claude setup-token` 生成（Muse 会带你做），不要在 Muse 的 VM 上登录 Claude。
- 用 dimensio：至少一家模型厂商的 API key。

## 能做什么

- **Claude Code**：官方 Claude Agent SDK 驱动，支持工具调用、子 agent、工作流、上下文压缩、会话续接；右侧工作台有终端、文件、任务和改动审阅。
- **dimensio**：多家模型可选的 agent 工作台，带工作区、记忆、子 agent。
- **工作空间**：文件浏览、预览（图片 / 视频 / PDF / Markdown / Office）、上传、分享链接。
- **多用户**：邀请码注册，每个账号独立目录，可以按人分配 agent 和额度。
- **自愈与更新**：Muse 的 VM 会不定期重启，看门狗 60 秒内把服务拉回来；发布新版本时 Muse 会问你要不要更新，更新会等没人在聊时才切换，新版本起不来会自动退回。

## 限制

- Muse 的 VM 起不了浏览器沙箱，所以 agent 没有「打开网页、截图」这类浏览器工具（联网搜索、抓网页内容照常可用）。
- 这是 Muse 平台的 VM，不是正式服务器：平台随时可能调整网络，长期对外提供服务也可能违反平台条款。别放重要数据，也别当生产环境用。

## 在普通 Linux 服务器上装

不在 Muse 上也能用：Debian / Ubuntu + systemd 的机器上，

```bash
git clone https://github.com/Wode44398/muse-bridge.git /opt/muse-bridge && cd /opt/muse-bridge
sudo bash scripts/server/install.sh --agents claude,dimensio
```

`install.sh --help` 查看全部选项。服务只听本机 127.0.0.1，对外请自己配隧道或反向代理（`--tunnel-token` 可以顺带起一条 Cloudflare 命名隧道）。更新：`sudo bash scripts/server/update.sh`。

## 目录

| 路径 | 内容 |
|---|---|
| `src/` | 服务端（Node 24，零构建） |
| `web/` | 前端（Vite + Svelte 5） |
| `harness/` | dimensio（TypeScript，Node 原生运行） |
| `scripts/server/` | 通用 Linux 安装 / 更新脚本 |
| `deploy/muse/` | Muse 专用：一键部署脚本 `bootstrap.sh`、给 Muse 看的说明书 `MUSE.md`、运维件模板 |

## 发布新版本（维护者）

推一个 `v*` 标签（建议用带说明的标签，说明会作为更新内容展示给用户）：

```bash
git tag -a v0.2.0 -m "这次更新了什么（给用户看的一两句）"
git push origin v0.2.0
```

GitHub Actions（`.github/workflows/release.yml`）会打包 `muse-bridge.tgz`、生成 `.sha256` 和更新频道 `latest.json`，并创建 Release。已经装好的 Muse 每 6 小时读一次 `latest.json`，发现新版本就问用户要不要更新。标签里带 `-`（如 `v0.2.0-beta.1`）会发成预发布版，不会推送给已装的用户。

## 协议

[MIT](LICENSE)。Claude Code 与 Claude Agent SDK 的使用受 Anthropic 自己的条款约束；在 Muse 上部署请同时遵守 Muse 的平台条款。
