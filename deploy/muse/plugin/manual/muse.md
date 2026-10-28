# Muse 部署

这台 bridge 是 **Muse Bridge**：装在 Muse（muse.ai）agent VM 上的 bridge 发行版，由 Muse 用 `deploy/muse/bootstrap.sh` 部署和维护。本手册其余各章讲的是 bridge 的通用功能，本章只讲这台服务器因为跑在 Muse VM 上而不同的地方：怎么改配置、怎么更新、网络限制、安卓 App 和桌面客户端。

## 运维都经 bootstrap.sh

部署、改配置、更新都由 Muse 在 VM 上跑 `bash /home/hatch/bridge-ops/bootstrap.sh <子命令>`（路径以装机结果块为准），不要直接改 systemd 单元或 config.json：

| 要做的事 | 子命令 |
|---|---|
| 换 agent（只要 Claude / 只要 dimensio / 都要） | `set-agents claude,dimensio` |
| 只自己用 / 多人用（开关注册和邀请码） | `set-users solo` / `set-users multi` |
| 绑自己的域名（固定地址） | `set-domain <主机名> <Cloudflare 隧道令牌>` |
| 退回临时地址 | `use-quick-tunnel` |
| 换 Claude 订阅令牌 / dimensio 的 API key | `set-claude-token` / `set-api-key` |
| 查更新 / 更新到最新版 / 回退 | `check-update` / `update` / `rollback` |
| 看状态 / 重置管理员令牌 | `status` / `reset-token` |

- 用户在网页里问「怎么改成多人用」「怎么更新」时，告诉他在 Muse 里说一句（例如「把 bridge 改成多人用」），由 Muse 去跑；控制台里对应的开关是只读的。
- 配置改完、新版本就位后，脚本会请服务端「空闲时重启」：等在跑的对话都结束再重启，不会打断正在干的活。

## 网络

- VM 没有公网 IP、没有入站：对外经 Cloudflare 隧道。没绑域名时用临时地址（`*.trycloudflare.com`），VM 重启后地址会变。
- 出站只能走 Muse 的代理（`hatch-egress-proxy`）：访问新的网站时 Muse 可能弹出权限申请，要用户在 Muse 里允许一次。模型服务一律经这个代理访问，设置里没有「直连」的选项。
- 临时地址会缓冲 GET 流式响应：终端、dimensio 的流式回复可能要等一整段才出来；绑了自己的域名就正常。

## 浏览器

VM 上的 Chromium 没有沙箱、起不来：dimensio 在这台服务器上没有浏览器工具。要用浏览器类能力，连上 bridge 的 Windows 桌面客户端（见下）或在 Claude Code 里用别的方式。

## 安卓 App 与桌面客户端

- **安卓 App**：在线 WebView 壳，界面就是这个网页、随服务器更新；记得住服务器地址，临时地址变了能在 App 里直接换。下载在 设置 ›「安卓 App」（服务器自带安装包，地址 `/download/MuseBridge.apk`），也挂在 GitHub 发布页。没有 iPhone App：在 Safari 里「添加到主屏幕」。
- **Windows 桌面客户端**：bridge 的桌面客户端可以连这台服务器。**只在绑了自己域名（固定地址）时提供完整的桌面体验**（标题栏、快问浮窗、把电脑登记成设备让 Claude 操作、客户端里的浏览器）；临时地址下客户端只当网页窗口用。

## 版本与反馈

- Muse Bridge 有自己的版本号（`deploy/muse/VERSION`），和 bridge 本体的版本号不是一回事；`bootstrap.sh status` 里两个都有。
- 问题反馈（设置里的「提交反馈」、`feedback.*` 操作）：本机反馈库总是存一份。**在这台服务器上，发出去 = 提交成 Muse Bridge 仓库（GitHub `Wode44398/muse-bridge`）的公开 Issue**（部署声明 `distro.feedback` 写了这个去向，`feedback.status` 回的 destination、界面上的勾选项都照它说）：反馈中继按发行版分流，Muse Bridge 的反馈不进 bridge 开发者的私有收件箱，而是公开；文字会去掉账号名、服务器地址并脱敏（令牌、邮箱、网址、路径、IP），**图片不公开**（只在 Issue 里记个数）。跟用户确认去向时照这个说：「会存在这台服务器上；管理员开着推送的话，还会在 Muse Bridge 的 GitHub 仓库开一个公开的 Issue，图片不会公开」。推送开关默认关，管理员自己决定。
- 用户也可以在 Muse 里说「报告一个 bridge 的问题」，由 Muse 用 `bootstrap.sh report` 出草稿、经用户同意后提交（同一个 GitHub 仓库，报告里带 Muse 那边的服务状态）。同一件事报一次就够。
- 服务意外重启（VM 被平台重启、看门狗重启服务）会打断正在跑的对话；「服务意外重启时 › 自动继续被中断的对话」默认开，服务起来后自动接着做。VM 每隔几小时就会被平台整机重启一次，这在 Muse 上很常见。
