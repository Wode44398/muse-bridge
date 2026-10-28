# Muse Bridge · 部署与上手说明书（写给 Muse）

> 读者：Muse 的 agent（你）。用户想在你这台 VM 上装 Muse Bridge，请你装好，再带他学会使用、回答他的使用问题。
> 本文件管「装、运维、出问题怎么办」；**界面怎么用**写在同目录的使用说明书 `guide/` 里（先看 `guide/INDEX.md`）。
> 装好后两样都会复制到 `/home/hatch/bridge-ops/`（`MUSE.md` 和 `guide/`），每次更新换成新版本的。以后查 Muse Bridge 的用法和运维办法，看那里的版本。
> 这份说明里的每一步都是在用户知情的情况下做的：要跑什么命令、会访问哪些网站、会存什么，都照实告诉用户；你觉得哪一步不妥，先停下来问他。

**Muse Bridge 是什么**：一个装在这台 VM 上的网页工作台。用户用手机或电脑的浏览器打开一个网址，就能用：

- **Claude Code**：Anthropic 的编程 / 通用 agent，用用户自己的 Claude 订阅（Pro 或 Max）。
- **dimensio**：一个可以接各家模型 API（Anthropic、OpenAI、Gemini、DeepSeek、Kimi、智谱、Qwen、MiMo…）的 agent 工作台，用用户自己的 API key。

两个 agent 都能读写文件、跑命令、做项目；还可以给朋友开账号。

## 0. 几条约束（先读完再动手）

1. **每一步都把命令输出原样贴给用户看**，尤其是最后的「MUSE-BRIDGE 结果」块。只说「成功了」不算数。
2. **不要在这台 VM 上跑 `claude login` / `claude setup-token`，也不要去试探 `platform.claude.com` 的 token 接口。** 这台 VM 的出口 IP 一试就会被限流近一小时，连真的授权码也会被一起拒掉。Claude 令牌一律由用户在自己的电脑上生成（见 4.4）。
3. **不要给浏览器加 `--no-sandbox`，不要改 sysctl、防火墙等宿主安全设置。** 这台 VM 起不了浏览器沙箱是已知限制，Muse Bridge 本来就不装浏览器。
4. **不要试 Docker。** 这里 runc 起不了容器（`unable to join session keyring`），已经确认无解。
5. **不要改代码目录里的文件。** 要调整行为，一律用 `bootstrap.sh` 的子命令。
6. **管理员访问令牌、Claude 令牌、各家 API key、Cloudflare 隧道令牌、agent 密钥（4.8），都不要写进你的长期记忆或任何笔记。** 管理员令牌装完会出现在结果块里，原样交给用户并提醒他当场存好；他用它登录成功一次之后，结果块就不再显示它。丢了就用 `reset-token` 重新生成。
7. **用用户平时跟你说话的语言交流。** 对用户讲人话，命令和输出放在代码块里给他看。
8. **命令尽量少而清楚。** 用户在开场时说过每条命令都要他批准、希望少跑命令，所以：
   - 不用轮询。`install`、`update`、`set-agents` 自己会转到后台，前台等着、只打印进度，完了打印结果块；没等完就跑一次 `bash /home/hatch/bridge-ops/bootstrap.sh wait`（还是没完就再跑一次）。不需要用 `tail`、`ps`、`sleep`、`curl` 另外看进度。
   - 结果块已经包含验收要看的全部信息（服务状态、本地 / 公网健康、实际生效的 agent），不需要为了确认再单独跑命令。
   - 相关的几步可以用 `&&` 写进一条命令；整条命令照样完整给用户看，让他知道批准的是什么。
   - 平台的审批卡（命令审批、网站审核）怎么选由用户自己决定：你可以照实说明各个选项的后果，不替他做主，也不催。
9. **给开发者的问题报告，一律先给用户看草稿、他同意了才发**（见第 8 节）。唯一的例外是用户事先同意过的「自动上报」，那由看门狗脚本自己发，你不用、也不要替它发。
10. **用户问「怎么用 / 在哪里 / 能不能」，先查说明书再回答**（`/home/hatch/bridge-ops/guide/INDEX.md` → 对应章节），别凭印象：界面会随版本变，说明书跟着版本走。说明书里没写的，就直说「说明书里没写」，别编按钮和功能；回答完可以问他要不要告诉开发者补上（第 8 节 `--kind docs`）。读说明书尽量一次读完要用的章节，少跑几条命令。

## 1. 开工前：一次问清四件事

先用一条消息把下面四个问题一起问用户，拿到回答再装。回答记下来，装的时候要用：

1. **你想装什么？**
   - A. 只要 **Claude Code**（最常见；需要你有 Claude Pro 或 Max 订阅）
   - B. 只要 **dimensio**（可接各家模型 API 的 agent 工作台；需要至少一家模型厂商的 API key）
   - C. **两个都要**

   只选一个时，打开网址直接就是那个 agent，没有主页；两个都要时有一个主页，上面两个入口。
2. **你有自己的域名吗？（域名托管在 Cloudflare 上）**
   - 没有 → 用免费的临时地址（`https://xxxx.trycloudflare.com`），零配置；缺点是这台 VM 每隔几个小时会被平台重启一次，**地址会跟着变**，变了我会主动告诉你新地址。
   - 有 → 可以换成**固定地址**（比如 `bridge.你的域名.com`），要在 Cloudflare 后台建一条隧道，我一步步带你（第 5 节）。
3. **自己用，还是也给别人用？**
   - 只自己用 → 关掉注册和邀请码，只有你的管理员令牌能登录。
   - 多人用 → 你可以在控制台给朋友发邀请码开账号。
4. **出了故障，要不要自动把错误报告发给开发者？**
   - 要 → 服务崩溃、更新失败这类故障，会自动发一份报告给 Muse Bridge 的开发者，帮他们更快修好。报告只有版本、服务状态和程序自己的报错位置，**不含对话、文件、key、地址**；同一个错误每个版本只报一次。
   - 不要 → 不会自动发。遇到问题时我会先问你要不要报告、给你看内容，你同意了才发。

   （这一问只管故障时的自动报告。网页里「提交反馈」和 Claude 诊断后的上报要不要发给开发者，是网页设置里另一个开关，默认关，由他自己在网页里决定，见 `guide/07-settings.md`「提交反馈」。）

用户拿不准时的建议：选 A、先用临时地址、只自己用、自动上报看他自己的意愿（两种都行）。这些以后都能改（第 6 节）。

## 2. 部署（约 5–10 分钟）

### 2.0 网站审核卡（装之前先跟用户说明）

这台 VM 只能经平台的出站代理上网，每访问一个新网站，Muse 都会弹一张审核卡「允许 Muse 与 <网站> 分享信息？」，可能在输入框上方，也可能在右侧「待审核 / Needs review」面板里（后台跑的安装触发的多半在面板里）。你自己看不到也批不了这些卡。

开始安装前，把下面的事实告诉用户，**怎么选由他自己决定**，你不替他选、也不催：

- 「允许一次」：这一次放行。服务以后在后台再访问这个网站时会再弹卡；当时没人在场批，用到它的功能就会停住（比如对话一直停在「等待模型回复」、夜里的自动更新装不上依赖而失败）。
- 「允许一次」旁边下拉里的「总是允许此站点」：这个网站及其子域名以后不再问，服务在后台访问也直接放行；相应地，以后对这个网站的访问都不再经过他逐次确认。批过的可以在 Muse 的设置 → 权限里撤销。
- 拒绝：用到这个网站的功能用不了，其余照常。

Muse Bridge 会访问的网站和用途（`allow-sites` 不带参数时按当前配置算出这份名单，逐个访问一次；结果块的「网站放行」一行记着每个网站批没批）：

| 网站 | 用途 |
|---|---|
| `api.anthropic.com` | Claude（装了 Claude Code 才有） |
| `html.duckduckgo.com` | dimensio 联网搜索的备用搜索（装了 dimensio 才有） |
| `github.com`、`release-assets.githubusercontent.com` | 下载发布包、看门狗每 6 小时查一次新版本、bridge 的插件市场 |
| `registry.npmjs.org` | 安装和更新时下载 npm 依赖 |
| `muse-bridge-feedback.huole8610.workers.dev` | Muse Bridge 项目自己的反馈中继（源码在仓库的 `feedback-worker/`），收问题报告并转成本项目的 GitHub Issue（第 8 节，用户同意了才发） |
| 各家模型的接口网站（如 `api.deepseek.com`） | dimensio 配了哪家的 key 才有（4.5） |
| 自定义模型服务的地址 | 用户自己加的才有（第 6 节） |

### 2.1 下载并解压

如果用户在开场提示词里已经让你下载、解压过，跳到 2.2。否则执行：

```bash
export HTTPS_PROXY=http://hatch-egress-proxy:3128 HTTP_PROXY=http://hatch-egress-proxy:3128
REL=/home/hatch/bridge-releases/$(date +%Y%m%d-%H%M%S) && mkdir -p "$REL" && chmod 755 /home/hatch/bridge-releases "$REL"
cd /tmp && curl -fLO --retry 3 https://github.com/Wode44398/muse-bridge/releases/latest/download/muse-bridge.tgz \
  && curl -fLO --retry 3 https://github.com/Wode44398/muse-bridge/releases/latest/download/muse-bridge.tgz.sha256 \
  && sha256sum -c muse-bridge.tgz.sha256 && tar -xzf muse-bridge.tgz -C "$REL" && echo "解压到 $REL/bridge"
```

`sha256sum -c` 必须输出 `OK`，不是 OK 就停下来告诉用户。代码**必须**放在 `/home/hatch/` 底下：VM 重启后只有这个目录还在。

### 2.2 一条命令安装

按用户在第 1 节的回答拼参数：

| 用户的回答 | 参数 |
|---|---|
| 只要 Claude Code | `--agents claude` |
| 只要 dimensio | `--agents dimensio` |
| 两个都要 | `--agents claude,dimensio` |
| 只自己用 / 多人用 | `--solo` / `--multi` |
| 用户跟你说的不是中文 | 加 `--lang en`（结果块整块用英文打印；以后也可以用 `set-lang en` 改） |
| 自动上报：要 / 不要 | `--auto-report on` / `--auto-report off` |

**先一律用临时地址装**（域名放到装好之后再换，第 5 节），这样用户马上就能用上，出问题也好排查：

```bash
bash "$REL/bridge/deploy/muse/bootstrap.sh" install --agents claude --solo --auto-report off
```

安装会对这台 VM 做这些事（跑之前可以照这个清单告诉用户）：用 apt 装 socat、cloudflared、jq 等，并从 apt 源里删掉经代理连不上的镜像；建一个叫 `bridge` 的系统账号，服务以它的身份运行（为了让它进得去 `/home/hatch` 底下的程序目录，安装和看门狗会给 `/home/hatch` 及程序所在的上级目录加上 o+x：只能穿过、不能列目录）；没有 Node 24 时装上，装 npm 依赖、构建前端；在 `/etc/systemd/system/` 写 4 个服务单元（bridge、cf-relay-api、cf-relay-edge、muse-tunnel）、在 `/etc/bridge/` 写服务的环境变量并启动；起一条 Cloudflare 隧道，把本机 8787 端口的网页工作台发布到一个公网地址（要令牌或账号才能登录）；运维件放在 `/home/hatch/bridge-ops/`，数据放在 `/home/hatch/bridge-srv/`，看门狗脚本放在 `~/hooks/scripts/`。

- 依赖从 npm 源（`registry.npmjs.org`）经代理下载，第一次会弹这个网站的审核卡（选项的含义见 2.0；以后的更新也要从这里下载依赖）。里面最大的是 Claude Agent SDK（这一版 0.3.311）的 Linux 平台包，自带 Claude Code 程序，解开约 250MB，所以不用另装 Claude CLI；代理慢时这一步要多等一会儿。
- 整个安装要 5–10 分钟（装 npm 依赖、构建前端）。直接在前台跑这一条就行，不需要自己加 `nohup` / `&`：脚本自己会在后台继续跑（所以命令工具超时也不会中断安装），前台最多等 4 分半，每完成一步打印一行进度。
- 前台等到头还没装完，会提示「还在后台跑」。这时跑一次 `bash /home/hatch/bridge-ops/bootstrap.sh wait`，它接着等、接着打印进度；还没完就再跑一次。
- 如果 VM 刚重启过、服务账号还没被平台写回来，脚本会按数据目录的属主自己补回来（输出里有一行说明）。
- 装到最后会把要用到的网站挨个访问一遍（「放行要用到的网站」那一步），Muse 会为还没批过的网站弹审核卡。安装在后台跑，卡片**常常出现在右侧的「待审核 / Needs review」面板里**，不一定在输入框上方。所以**开始安装前就告诉用户**：会弹哪些网站的卡（2.0 的表）、两个地方都留意、各个选项的后果（2.0），由他自己选。每张卡最多等 3 分钟，没批的会在结果块里列出来。
- 脚本可以重复跑。中途失败（网络抖动、VM 重启）就原样再跑一次，已有的数据和令牌都不会动。
- 最后打印「MUSE-BRIDGE 结果」块。**状态**是「正常」，并且**公网健康**是 200，才算装好。**管理员令牌**那一行会一直显示，直到用户用它登录成功一次。

### 2.3 注册看门狗 hook（重启后自愈靠它）

这台 VM 每隔几个小时会被平台整机重启一次，重启后我们的服务会丢、临时地址会变。VM 上没有 cron，也没有用户级 systemd，只能靠 Muse 的 hook 定时把服务拉回来。

- 脚本已经放在 `~/hooks/scripts/bridge-watchdog.sh`（副本在 `/home/hatch/bridge-ops/hooks/`），定义在 `/home/hatch/bridge-ops/hooks/bridge-watchdog.json`。
- 它每分钟：补回丢失的服务和配置 → 检查健康 → 挂了先重启 → 还不行就唤醒一个 worker 排查 → 临时地址变了就唤醒你告诉用户 → 发现新版本 / 更新完成 / 更新失败自动回退时通知你。json 里的 `prompt` 是被唤醒的 worker 读到的说明（每种事件怎么处理、要告诉用户什么）。
- 注册之前，用几句话告诉用户这个 hook 做什么、多久跑一次；他想看脚本或 `prompt` 原文，就给他看。他同意后，用你的 hooks 工具创建 id 为 `bridge-watchdog` 的 hook（已经有了就更新它），各字段照 json 填：`id`、`script_path`、`poll_interval_secs`=60、`script_timeout_secs`=600、`delivery`、`prompt`，然后启用。
- 你的工具支持 dry-run 的话，先 dry-run 一次，把结果贴出来。
- 以后每次安装或更新，结果块里「看门狗 hook」那一行会说定义有没有变；变了就告诉用户变了什么（新旧 json 的差别），他同意后按新的 json 更新这个 hook。

### 2.4 验收（看结果块，不用另跑命令）

对照安装打出来的结果块（没有就跑一次 `status`），必须满足：4 个服务（bridge、cf-relay-api、cf-relay-edge、muse-tunnel）都是 `active`；本地健康、公网健康都是 200；「agent」那一行括号里「服务端报告」的名单跟用户选的一致；hook 已注册并启用。

「网站放行」（英文块里是 Sites）那一行如果不是「全部已放行」，说明有网站的审核卡还没批（多半是卡片出在右侧面板里被错过了）。告诉用户是哪几个网站、各自做什么用（2.0 的表），以及没放行的后果：比如 `api.anthropic.com` 没放行，用户配好令牌后第一次跟 Claude 说话就会一直转圈。他想现在处理，就在前台跑一次 `bash /home/hatch/bridge-ops/bootstrap.sh allow-sites`，卡片会再弹出来，怎么选由他定。

### 2.5 记下部署信息

你有长期记忆的话，记下这些事实（令牌与密钥除外，见第 0 节第 6 条）：

- 这台 VM 上部署了 Muse Bridge。部署运维说明书在 `/home/hatch/bridge-ops/MUSE.md`，使用说明书在 `/home/hatch/bridge-ops/guide/`（先看 `INDEX.md`）；处理相关的事、回答使用问题之前先查它们。
- 用户的四个选择（装了哪些 agent、临时地址还是自己的域名、自己用还是多人用、出故障要不要自动上报），以及他选的更新方式（每次先问，还是自动更新）。
- 用户说哪里坏了：先按说明书第 8 节判断是不是 bug；要报告给开发者，一律先出草稿给他看，他同意了才发。
- 运维入口是 `bash /home/hatch/bridge-ops/bootstrap.sh <子命令>`，子命令见说明书第 6 节。数据目录是 `/home/hatch/bridge-srv`（各版本共用）。
- 临时地址每次 VM 重启都会变。用户问地址时跑 `status` 拿当前地址，别用记忆里的旧地址。
- 看门狗 hook 的 id 是 `bridge-watchdog`。新版本提醒（update_available）是装的时候就开着的功能，转告给用户；用户明确说过不要提醒更新的话，记下他的这句话。看门狗已经在定时查新版本。
- 不在 VM 上跑 Claude 登录；不加 `--no-sandbox`；不试 Docker。
- 每次更新完，`/home/hatch/bridge-ops/MUSE.md` 和 `guide/` 会换成新版本的，查用法和运维办法时看新版本；新版本要你做的事跟以前不一样时，先告诉用户。
- 用户说哪里不对劲：先跑 `known-issues` 看是不是已知问题（第 8 节）。

## 3. 交付给用户

把结果块里的**公网地址**和**管理员令牌**给他，并提醒：

- 令牌就是管理员密码，请马上存进密码管理器或备忘录。他用它登录成功一次之后，你这边就再也看不到它了；丢了可以找你重置，重置后旧令牌作废。
- 用临时地址时：地址大约每几个小时变一次（VM 重启导致），变了你会主动告诉他，他也可以随时问你「地址是多少」。**令牌不会变，但换了地址要重新用令牌登录一次**（浏览器的登录状态是跟着网址存的）。嫌麻烦可以换成自己的域名（第 5 节）。
- 这个地址谁拿到都能打开登录页，但没有令牌或账号进不去。
- **顺带告诉他有安卓 app**（结果块里「安卓 app」那一行）：用安卓手机的浏览器打开地址并登录，进设置根页「插件」分组里的「安卓 App」就能下载安装；也可以直接从 GitHub 下载 `https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk`。app 跟网页版界面一样、随服务器自动更新，好处是桌面上有图标、记得住地址，临时地址变了能在 app 里直接换。iPhone 目前没有 app，用 Safari 的「添加到主屏幕」。

交付完，接着第 4 节：问他要不要你带他上手。

## 4. 带用户上手、回答使用问题

### 4.1 先问要不要入门讲解
装好、交付完（第 3 节），用一条消息问用户要不要你带他上手，给他挑（没装的 agent 相关的档不提）：

- **5 分钟快速上手**（推荐第一次用的人）：登录、配好 Claude / 模型 key、发第一句话、认识界面。
- **Claude Code 深入**：项目、历史对话、工作台（终端 / 文件 / 审阅）、附件、定时任务……
- **dimensio 深入**：换模型、加别家服务、联网搜索、记忆、权限……
- **管理员与多人使用**：给朋友开账号、邀请码、服务端控制台。
- **手机上用**：安卓 app、iPhone 添加到主屏幕。

他选了哪档，就按 `guide/onboarding.md` 里那一档的步骤带：每步说清楚点哪里、会看到什么，等他确认做完再往下。他说不用，就告诉他以后随时可以问你「这个怎么用」。以后遇到这些时机也可以问一句要不要讲解：他明显是第一次用某个功能、更新带来了他用得上的新功能（你跑完 `update` 时，或者看门狗的 update_done 事件提醒你时）。

### 4.2 回答使用问题
用户问怎么用、在哪里、能不能做到：先读 `guide/INDEX.md`，按它找到对应章节读完再回答（第 0 节第 10 条）。回答给出界面上的名字和点击路径——用户界面是中文还是英文，就用哪种（说明书里两种都写了）。说明书里没写的，如实说没写。

### 4.3 第一次登录
让他用浏览器（手机、电脑都行）打开公网地址，用管理员令牌登录。登录、扫码登录另一台设备、换了地址怎么办、装安卓 app，都在 `guide/01-access.md`。

### 4.4 配 Claude（装了 Claude Code 才需要）
Claude 需要用户自己的 Claude 订阅（Pro 或 Max）。令牌**只能在他自己的电脑上生成**，不能在这台 VM 上生成（原因见第 0 节第 2 条）：
1. 在他自己的电脑上装 Claude Code（官方安装方式，或者 `npm install -g @anthropic-ai/claude-code`）。
2. 在终端运行 `claude setup-token`，浏览器里登录 Claude 账号并授权，终端会打印一串以 `sk-ant-oat` 开头的长期令牌。
3. **推荐做法**：回到 Muse Bridge，打开「设置 → Claude」（设置根页「Agent」分组里），在「订阅号池」里点「添加账号」，把令牌粘进去（服务端控制台的「Claude 账号」页也一样）。这样令牌不经过聊天记录。
4. 他更想让你代配的话：先说明令牌发在聊天里会留在聊天记录中；他把令牌发给你后，你执行 `bash /home/hatch/bridge-ops/bootstrap.sh set-claude-token <令牌>`，然后提醒他删掉聊天里那条消息。控制台「Claude 账号」里的当前账号如果存着旧令牌，这条命令会一并换掉它（输出里会说）。

配好之后，让他在 Claude 页发一句「你好，介绍一下你能做什么」，有回复就说明通了。

### 4.5 配 dimensio 的模型 key（装了 dimensio 才需要）
问他打算用哪一家（可以多家）。key 有两种配法，说明各自的特点、让他选：

- **他自己在网页里填**：dimensio 页侧栏底部「设置」的「API Key」（加密存盘，重启不丢），key 不经过聊天。
- **发给你，你写进服务器**（每家一条命令）：key 会留在聊天记录里，写完提醒他删掉那条消息；好处是命令会顺带把这家接口网站的审核卡提前弹出来（见本节最后）。

```bash
bash /home/hatch/bridge-ops/bootstrap.sh set-api-key ANTHROPIC_API_KEY <key>
```

`set-api-key` 可用的名字：`ANTHROPIC_API_KEY`（Claude）、`DEEPSEEK_API_KEY`（DeepSeek；写进去会存成 `OPENAI_API_KEY`，dimensio 里叫 DeepSeek 的那一家读的就是它，所以两个名字等价）、`GEMINI_API_KEY`、`KIMI_API_KEY`（Kimi for Coding 订阅 key，`sk-kimi-` 开头）、`ZHIPU_API_KEY`、`QWEN_API_KEY`、`MIMO_API_KEY`（`tp-` 开头的 Token Plan key 也行）。

两种方式别混用：网页里存过的 key 优先于 `set-api-key` 写的，而且界面上清不掉，所以同一家只用一种方式配；他在网页里填过的那家，换 key 也让他在网页里换。

**联网搜索**：dimensio 的联网搜索用的是所配厂商自带的搜索（同一把 key，不用另外申请）：当前对话用哪家，就先用哪家的；其余配了 key 的厂商依次备用，都没有时退回免费但不太稳的 DuckDuckGo。智谱、Kimi（`sk-kimi-` 订阅 key）、DeepSeek、通义、Gemini、Claude 配上 key 就能搜；**小米要多一步**：联网搜索是小米控制台「插件管理」里的「联网搜索」插件（按次计费，约 ¥16 / 千次，从账户余额扣），而且**只在按量付费的 key 上能用**。用户填的如果是 Token Plan 订阅的 key（`tp-` 开头），这把 key 搜不了（小米的 Token Plan 接口不开放插件，控制台开了也没用）：想用小米搜索，就让他在控制台再建一把按量付费的 API key，用 `set-api-key MIMO_SEARCH_API_KEY <那把 key>` 单独配给搜索，聊天照旧用 Token Plan。不配也行，小米搜不了会自动退回别家，搜索结果里会提醒。

**网络审核（重要）**：这台 VM 访问外部网站要用户在 Muse 里批准，卡片是「允许 Muse 与 <网站> 分享信息？」。dimensio 在后台第一次调某家模型时如果弹这张卡、而用户不在场，对话会一直停在「等待模型回复」。所以 `set-api-key` 写完 key 会马上访问一次这家的接口网站，趁用户在场把卡片弹出来。跑这条命令之前先告诉用户：马上会弹一张这家接口网站的审核卡；选「允许一次」的话，以后 dimensio 在后台调这家时还会再弹，没人批就会卡住，选「总是允许此站点」就不再问（各选项见 2.0），由他决定。你看不到卡片，命令会停在那里等他批（最多 3 分钟）；输出里 ✓ 表示放行了。然后让他在 dimensio 页选对应的模型发一句话试试。

### 4.6 给朋友开账号（选了「多人用」才需要）
在服务端控制台里发邀请码，朋友用邀请码注册；新账号默认只能用 Claude，要让他用 dimensio 得在控制台里给他勾上；「完全信任邀请码」给的账号带命令行、等同管理员，只发给完全信任的人。具体点哪里见 `guide/06-users-admin.md`。用户想从「只自己用」改成「多人用」（或者反过来），跑 `set-users multi` / `set-users solo`。

### 4.7 需要知道的限制
- **没有浏览器工具**：这台 VM 起不了浏览器，agent 用不了「打开网页、截图」这类功能（联网搜索、抓网页内容照常可用）。
- **这是 Muse 的 VM，不是正式服务器**：平台随时可能调整网络，长期对外提供服务也可能违反平台条款。别放重要数据，也别当生产环境用。
- **更新**：有新版本时我会告诉你更新了什么，你说「更新」我就更新。更新会等没人在聊天时才切换，不打断对话；新版本起不来会自动退回旧版本。你也可以让我开「自动更新」（开了之后，看门狗发现新版本会在后台自己下载安装，不再先问你）。
- 更多常见问题（费用、数据放在哪、为什么老弹审核卡……）见 `guide/08-faq.md`。

### 4.8 用 agent 密钥帮用户操作 Muse Bridge（可选）
Muse Bridge 自带一套给 agent 用的 HTTP 接口（入口 `/agent`，项目手册 `/agent/manual`）：用户给你一把密钥后，你能在 VM 本机查用法、看谁在跑、给 Claude 派活、建定时任务、找历史会话、把用户的界面带到某页。装、更新、回滚、换域名这类运维事不在里面，照旧用 `bootstrap.sh`。这是可选的：用户不想给，就不用。

- **密钥由用户自己生成**：请他打开 **「设置 → Agent 接入」**（Settings → Agent access），名字写「Muse」，点 **「生成」**（Generate），再点 **「复制给 agent 的说明」**（Copy instructions for the agent）粘给你。密钥只显示一次，以 `bak_` 开头，带用户本人的权限，90 天过期；在同一页点 **「吊销」**（Revoke）随时作废。改密码或重置访问令牌（`reset-token`）会让全部密钥立即失效，到时请他重新生成。
- **怎么调**：在 VM 本机访问 `http://127.0.0.1:8787/agent/...`，每个请求带请求头 `Authorization: Bearer <密钥>`。这是本机回环地址，请求不出这台 VM（所以不经出站代理，临时地址变了也不受影响）。先读 `/agent` 和 `/agent/manual`（不带密钥也能看）。
- **会改东西的操作先问用户**：给 Claude 派活、建定时任务、改设置之前，先告诉用户要做什么，他同意再做。
- **别把密钥写进长期记忆或任何笔记**（同第 0 节第 6 条），只放在环境变量或权限 600 的文件里；丢了就请用户吊销再生成一把。
- 用户问「这个设置页是干什么的」，说明书见 `guide/07-settings.md`「Agent 接入」。

## 5. 用自己的域名（固定地址）

用户在第 1 节说有域名、或者后来嫌临时地址老变时，带他做下面几步。前提：域名已经托管在 Cloudflare（在 Cloudflare 后台「网站」列表里能看到它）。

1. 登录 Cloudflare 后台，进入 **Zero Trust**（左侧栏）→ **网络 / Networks** → **Tunnels** → **创建隧道 / Create a tunnel**，类型选 **Cloudflared**，名字随便起（比如 `muse-bridge`）。
2. 在「安装并运行连接器」那一步，页面会给出一条带 `--token` 的安装命令。**只需要把 `--token` 后面那一长串复制出来**，不用在任何电脑上运行那条命令。
3. 下一步「路由流量 / Public hostname」：子域名填比如 `bridge`，域名选他的域名；**服务类型选 HTTP，URL 填 `localhost:8787`**。保存。
4. 让他把两样东西发给你：完整主机名（比如 `bridge.example.com`）和第 2 步复制的令牌。你执行：

   ```bash
   bash /home/hatch/bridge-ops/bootstrap.sh set-domain bridge.example.com <隧道令牌>
   ```

5. 结果块里公网地址变成他的域名、公网健康 200 就成功了。提醒他删掉聊天里含隧道令牌的那条消息，并把书签换成新地址。以后 VM 重启，地址也不会再变。

想换回临时地址：`bash /home/hatch/bridge-ops/bootstrap.sh use-quick-tunnel`。

## 6. 日常运维对照

运维入口：`bash /home/hatch/bridge-ops/bootstrap.sh <子命令>`

| 用户说 | 你做 |
|---|---|
| 「地址是多少」「打不开了」 | `status`，把**公网地址**和**状态**告诉他 |
| 「令牌忘了」 | 先说明旧令牌和所有已登录的管理员设备都会失效，他同意后执行 `reset-token`，把新令牌交给他 |
| 「换 Claude 令牌」 | 首选让他自己在控制台「Claude 账号」里改；否则 `set-claude-token <令牌>` |
| 「给 dimensio 加 / 换 / 删一家模型的 key」 | `set-api-key <名字> <key>`（key 留空 = 删掉；写入时会弹这家接口网站的审核卡，先告诉用户，选项见 2.0） |
| 「我要在 dimensio 里加一个自定义模型服务」（OpenAI 兼容地址） | 先问他接口地址，告诉他会弹这个地址的审核卡（选项见 2.0），跑 `allow-sites <地址>`，放行后**再**让他去 dimensio 模型胶囊菜单的「切换模型服务…」里点「添加自定义服务」——否则添加时会卡在「连接中」。要接到 Claude 页的，同样先放行，再让他在「设置 → Claude → 自定义 API」里加 |
| 「对话一直在等待模型回复」「模型没反应」 | 多半是有网站的审核卡没人批：让他看 Muse 里有没有待审核的卡片（输入框上方或右侧面板）；或者用户在场时跑 `allow-sites`（按现在的配置把要用的网站挨个访问一遍，卡片会再弹出来，选项见 2.0） |
| 「我也想用 dimensio」「不要 dimensio 了」等 | `set-agents claude` / `set-agents dimensio` / `set-agents claude,dimensio`（要重新装依赖、构建，几分钟；跟 `install` 一样自己转后台，没等完就 `wait`；完了等没人在聊时自动切换） |
| 「让朋友也能用」「只给我自己用」 | `set-users multi` / `set-users solo` |
| 结果块要换语言 | `set-lang en` / `set-lang zh` |
| 「想要固定地址」 | 按第 5 节带他做 |
| 「有手机 app 吗」「怎么装到手机上」 | 安卓：手机浏览器打开地址并登录 → 设置根页「插件」分组里的「安卓 App」下载安装，或者给他 GitHub 链接 `https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk`；iPhone：Safari「分享 → 添加到主屏幕」 |
| 「app 打不开了」「app 连不上」 | 多半是临时地址换了：`status` 拿到新地址告诉他，让他在 app 弹出的面板里点「更换地址」粘进去 |
| 「有新版本吗」 | `check-update`，把当前版本、最新版本、更新内容告诉他 |
| 「更新」 | `update`（自己转后台、前台打印进度，完了贴结果块；没等完就 `wait`）。切换完成后：结果块说 hook 定义变了，就告诉用户变了什么，他同意后按新 json 更新 hook；更新说明里有他用得上的新功能，问一句要不要带他试一下（`guide/onboarding.md` 最后一节）——当场切换完成时看门狗不会再发 update_done，这一步只能在这里做 |
| 「装到哪一步了」「好了没」 | `wait` |
| 「现在就切到新版本」（新版本已装好，在等空闲） | 先说明会打断正在进行的对话（记录不会丢），他同意后执行 `switch-now` |
| 「退回旧版本」「更新后有问题」 | `rollback`（立即重启到上一个版本） |
| 「开 / 关自动更新」 | `auto-update on` / `auto-update off` |
| 「怎么用 X」「X 在哪里」「能不能 X」 | 先读 `guide/INDEX.md` 和对应章节再回答（4.2） |
| 「带我熟悉一下」「我是新手」 | 问他要哪一档，按 `guide/onboarding.md` 带（4.1） |
| 「这是不是已知问题」，或者用户说的现象你没把握 | `known-issues`（影响当前版本的已知问题：现象、绕过办法、哪个版本修好了）；`known-issues --all` 看全部 |
| 「有 bug」「这个功能坏了」「想给开发者提建议」 | 按第 8 节：先判断，要报就出草稿给他看，同意了再发 |
| 「我报的问题怎么样了」 | `report --list`，把编号和 Issue 地址告诉他；修好的版本发布时我会主动告诉他 |
| 「开 / 关自动上报」 | `feedback-auto on` / `feedback-auto off`（网页里没有这个开关） |
| 看门狗唤醒你 | 照 hook 提示里对应 kind 的说明办。排查故障时只用本机命令（`status --local`、`journalctl`），别去访问公网地址：那要用户批准网络权限，没人在场会超时 |
| 「卸载」 | 先确认。然后 `systemctl disable --now bridge cf-relay-api cf-relay-edge muse-tunnel`，删掉 `bridge-watchdog` hook，再删 `/home/hatch/bridge-ops`、`/home/hatch/bridge-releases`；`/home/hatch/bridge-srv` 是用户的数据，问过他再删 |

### 更新是怎么进行的

1. `update` 把新版本下载到 `bridge-releases/<时间戳>/`，核对 sha256，再用**新版本自己的** `bootstrap.sh install --switch idle` 安装（沿用用户现在的选择）。装依赖、构建前端都在新目录里做，正在跑的服务不受影响。
2. 装好后把 `bridge-releases/current` 指向新目录，给 bridge 发「空闲时重启」。bridge 等所有在跑的对话结束后自己重启，重启后就跑在新版本上。
3. 看门狗每分钟跟踪一次：新版本跑起来且健康 → 通知「已更新」；切过去 5 分钟还不健康 → 自动退回旧版本并通知「更新失败」；40 分钟都等不到空闲 → 问用户要不要现在切。
4. 只保留最近两个版本当回滚点。用户的数据在 `bridge-srv`，更新不会动它。
5. 从 v0.3.0 以前的版本更新上来：后台要访问的网站多了几个（`github.com`、`release-assets.githubusercontent.com`：查新版本、bridge 的插件市场；`registry.npmjs.org`：以后的更新装依赖）。更新本身不会逐个弹卡，结果块的「网站放行」一行会列出还没批的；告诉用户这几个网站做什么用、不放行会怎样（比如查不到新版本、插件市场拉不下来），他想处理就在他在场时跑一次 `allow-sites`（不带参数，按配置全部过一遍），卡片怎么选由他定（2.0）。

### 服务重启后对话会自动接上

bridge 服务被意外打断时（VM 被平台重启、看门狗重启了服务、`switch-now`、`rollback`），正在跑的 Claude 对话会停在一半；服务起来约 15 秒后，bridge 会自动让 Claude 从中断的地方接着做，用户什么都不用做（每个账号在「设置 → Claude → 服务意外重启时」里能关，默认开；同一件事最多连续续 3 次，中断超过 12 小时或用户先发了消息就不续）。所以：

- 你重启服务时（`systemctl restart bridge`、`switch-now`、`rollback`），也告诉用户：正在跑的 Claude 对话会在服务起来后自动接着做，他不用发「继续」；不想要可以关掉上面那个开关。看门狗在 VM 重启后拉起服务，也会这样接上。
- 用户说「它刚才自己又开始干活了」「对话自己接着跑了」：就是这个，正常现象；想关就告诉他上面那个开关（`guide/07-settings.md`）。
- 「空闲时重启」（`update`、看门狗的更新切换）等没人在聊才重启，不会打断对话，也就不会触发自动继续。

## 7. 故障排查

先跑 `status`，再看对应服务的日志：`journalctl -u <服务名> -n 80 --no-pager`。

| 现象 | 原因 | 处理 |
|---|---|---|
| apt 卡在某个镜像上重试（如 `mirror.cogentco.com … Connection failed`） | 镜像源里有经代理不通的镜像，而且平台每次开机都会把它还原 | `install` 会自动探测并删掉不通的镜像；还卡就看 `/etc/apt/sources.list.d/ubuntu.sources` 的 `URIs:` 那一行 |
| npm `socket hang up`、`ETIMEDOUT` | 经代理的网络偶尔不稳 | 原样重跑 `install` |
| 本地 200，公网不是 200，或者地址打开是 530 | 隧道断了，或者 VM 重启后临时地址换了 | 跑 `status` 拿到新地址；还不通就 `systemctl restart muse-tunnel`，等 30 秒再看（临时地址**会换**，记得告诉用户） |
| muse-tunnel 日志里有 `failed to request quick Tunnel` / `Client.Timeout exceeded` | 出站代理冷启动慢，申请临时地址超时 | 隧道会自己重试，启动前也会先把代理热起来，一般一两分钟内就好；5 分钟还不行再 `systemctl restart muse-tunnel` |
| muse-tunnel 日志里反复有 `quick tunnel provisioning failed with status 403` | Cloudflare 申请临时地址的接口拒绝了这台 VM 的出口 IP（拒绝或限流，代理已经放行） | 部署脚本这边修不了（已知问题 `quick-tunnel-403`）。告诉用户，可以换成自己的域名（第 5 节，不经过这个接口），或者过一段时间再 `systemctl restart muse-tunnel` 试试 |
| muse-tunnel 日志里有 `tls: first record does not look like a TLS handshake` | cloudflared 在直连，没走本机中继 | 查 `cf-relay-api`、`cf-relay-edge` 是否 active，`/home/hatch/bridge-ops/hosts` 是否存在；然后重跑 `install` |
| 日志里有 `server misbehaving`（在查 `_v2-origintunneld` 的 SRV 记录） | VM 上的 DNS 查不了 SRV 记录 | 我们用 `--edge` 直接指定了节点，正常不会走到这一步；出现了就重跑 `install` |
| 用自己的域名，muse-tunnel 日志报令牌无效（`Unauthorized` / `invalid token`） | 隧道令牌复制错了，或那条隧道在 Cloudflare 后台被删了 | 让用户重新复制令牌（第 5 节第 2 步），再 `set-domain` |
| 用自己的域名，隧道连上了但打开是 Cloudflare 错误页（502 / 1033） | Public hostname 的服务地址没填对 | 让用户在 Cloudflare 后台把服务改成 `HTTP` + `localhost:8787` |
| cloudflared 一直报 `Failed to refresh DNS local resolver … unable to parse IP` | 已知的无害噪音 | 不用管 |
| 重启后服务单元没了（`Unit … not found`） | 平台重启时会清掉 `/etc` 里它不认识的文件 | `bash /home/hatch/bridge-ops/heal.sh`；看门狗每分钟也会自动做 |
| bridge 报 `status=217/USER`，或者找不到 bridge 用户 | VM 重启后，平台不会马上把 `/etc/passwd` 里的 bridge 账号写回来 | 什么都不用做：看门狗下一轮（1 分钟内）会按数据目录的属主把同一个账号补回来、拉起服务；`install` 也会自己补 |
| bridge 报 `status=200/CHDIR` | `/home/hatch` 丢了 o+x 权限 | `heal.sh` 会自动补上 |
| Claude 页提示「还没配置 Claude 认证」 | 还没配令牌 | 见 4.4 |
| dimensio 发消息报没有可用的模型 / key | 还没填 key | 见 4.5 |
| token 接口返回 429 `rate_limit_error` | 在 VM 上做了 OAuth 登录 | 别在 VM 上登录，改用 4.4 的方法；出口 IP 大约一小时后恢复 |
| `update` 报 sha256 对不上 | 包没下载完整，或者发布者还在上传 | 过一会儿再跑；一直对不上就告诉用户 |
| `update` 在装依赖或构建时失败 | 网络问题，或新版本本身有问题 | 旧版本照常在跑。原样重跑一次；还失败就把 `wait` 打出来的日志末尾给用户（完整日志在 `/home/hatch/bridge-ops/install-progress.log`） |
| 更新后用户说哪里不对 | 新版本的问题 | 先 `rollback` 让他能接着用，再按第 8 节问他要不要报告（描述里写明是从哪个版本开始的） |

处理不了的，把 `status` 的输出和相关日志贴给用户，说清楚卡在哪、需要他做什么决定。

## 8. 用户遇到问题：先判断，再报告

用户说「坏了 / 报错 / 用不了」，或者你排查时发现像是 Muse Bridge 自己的毛病，按下面做。

### 8.1 先判断是不是 bug（多数不是）

0. **先查已知问题**：跑一次 `bash /home/hatch/bridge-ops/bootstrap.sh known-issues`。用户说的现象在里面，就把绕过办法告诉他；已经修好的，问他要不要更新。已知问题不用再报。
1. **配置问题**：按 4.4、4.5 和第 7 节处理，不用报告。比如没配 Claude 令牌、没填模型 key、网络审核卡没批（对话一直停在「等待模型回复」）、临时地址换了要重新登录。
2. **平台限制**：如实告诉用户，不用报告。比如没有浏览器工具、VM 每隔几小时重启、只能经代理出站。
3. **刚更新完就出的问题**：先 `rollback` 让他能接着用，再往下走第 4 条。
4. 排除了上面几种，而且能复现，或者 `status` / `journalctl -u bridge` 里有程序自己的报错（`route error`、`fatal-guard`、`TypeError`、`Cannot read properties` 之类），就是 bug，问用户要不要报告。用户只是想要个新功能，也可以帮他报（`--kind idea`）。

### 8.2 报告（必须用户同意）

1. 先问一句，比如：「这看起来是 Muse Bridge 自己的问题，要我帮你报告给开发者吗？只会附上版本、服务状态和程序自己的报错，不含你的对话、文件、key 和地址。」
2. 他说好，就出草稿（**这一步不会发出去**）。描述用标准输入给，免得引号、`$` 出问题：

   ```bash
   bash /home/hatch/bridge-ops/bootstrap.sh report <<'EOF'
   用户在做什么、看到了什么、从什么时候开始的（一两句，尽量用用户的原话）
   EOF
   ```

   - 描述只写事实，别把你的猜测写成结论；不要写进任何 key、令牌、网址、邮箱、文件内容（脚本会再打一遍码，但别指望它）。
   - 安全问题（比如普通账号看到了别人的文件、没登录也能打开某个页面）加 `--kind security`：会私下发给维护者，不公开。功能建议加 `--kind idea`。
   - 说明书没写到、写错了（用户问的事 `guide/` 里查不到，或者照说明书做却对不上界面）加 `--kind docs`：描述里写用户问了什么、说明书哪一章缺了或错了。同样要先问用户。
3. 把输出的草稿**原样**贴给用户，问「就这样发吗？」。他要改，就改描述重新出一份；他同意了再发：

   ```bash
   bash /home/hatch/bridge-ops/bootstrap.sh report --send <草稿编号>
   ```

4. 把结果告诉他：
   - 「已提交」：给他 Issue 地址。
   - 「已经有人报告过，已 +1」：说明别人也遇到了，修好时会知道。
   - 「暂时发不出去，已存好」：服务会自动补发，不用再操作；他想马上提交，可以自己打开输出里那条预填好的 GitHub 链接（要有 GitHub 账号）。
5. 第一次发送时，Muse 可能弹一张审核卡（网站是 `muse-bridge-feedback.huole8610.workers.dev`，Muse Bridge 的反馈服务），先告诉他这张卡是做什么的，怎么选由他定（2.0）。

### 8.3 网页里提交的反馈、Claude 上报的 bug

**你自己报问题只用上面的 `report`，这是你唯一的上报路径。** 不要用 agent 密钥去调网页那套反馈接口（`feedback.report` 之类，那是给网页里的 Claude 用的），也不要替用户在网页里点提交。

网页那边用户有自己的两条路（说明书 `guide/07-settings.md`「提交反馈」）：设置里的「提交反馈」，和在 Claude 对话里说「是不是出 bug 了」、Claude 诊断后经用户同意上报。它们的去向：

- 每条都先存在 VM 上的反馈库 `/home/hatch/bridge-srv/feedback/reports/`（每条一个 .md，你能直接读；Claude 上报的那几条 frontmatter 里有 `via: claude`）。
- 只有管理员在网页里打开了「把用户反馈同时发给 Muse Bridge 项目的公开 GitHub Issue」、提交人也同意了那一条，才会同时提交成 Muse Bridge 仓库的公开 GitHub Issue（经同一个反馈服务；图片不公开）。这个开关默认关，你不要替用户去开，也不要用 `bootstrap.sh` 改它。
- 跟 `report` 用的不是同一份数据：`/home/hatch/bridge-srv/muse-feedback/` 是 `report` 的草稿、发送记录和自动上报设置，`feedback/` 是网页的反馈库，两边互不相干，别挪、别删。

用户提到他在网页里提交过反馈或让 Claude 报过：去反馈库读那一条，按 8.1 判断。他说当时已经勾了「也发给开发者」（或 Claude 说已经发出去了），就别再用 `report` 重报；没发出去、而他想报给开发者，按 8.2 出草稿、他同意再发。

### 8.4 不要做的事

- 没问用户、或者用户没看过草稿就发。
- 用 agent 密钥调网页的反馈接口上报，或者替用户打开网页里「发给开发者」的开关。
- 在看门狗唤醒的 worker 里出草稿、发报告（自动上报由看门狗脚本自己处理，它会先看用户有没有同意过）。
- 自己去 GitHub 网页开 Issue、或者让用户把 GitHub 账号密码给你。
- 同一个问题反复报：`report --list` 能看到发过的。

