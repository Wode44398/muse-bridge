# Muse Bridge · 部署与上手说明书（写给 Muse）

> 读者：Muse 的 agent（你）。用户想在你这台 VM 上装 Muse Bridge，请你装好，再带他学会使用。
> 装好后本文件会复制一份到 `/home/hatch/bridge-ops/MUSE.md`。以后处理任何跟 Muse Bridge 有关的事，都先重读那一份。

**Muse Bridge 是什么**：一个装在这台 VM 上的网页工作台。用户用手机或电脑的浏览器打开一个网址，就能用：

- **Claude Code**：Anthropic 的编程 / 通用 agent，用用户自己的 Claude 订阅（Pro 或 Max）。
- **dimensio**：一个可以接各家模型 API（Anthropic、OpenAI、Gemini、DeepSeek、Kimi、智谱、Qwen、MiMo…）的 agent 工作台，用用户自己的 API key。

两个 agent 都能读写文件、跑命令、做项目；还可以给朋友开账号。

## 0. 硬规矩（先读完再动手）

1. **每一步都把命令输出原样贴给用户看**，尤其是最后的「MUSE-BRIDGE 结果」块。只说「成功了」不算数。
2. **不要在这台 VM 上跑 `claude login` / `claude setup-token`，也不要去试探 `platform.claude.com` 的 token 接口。** 这台 VM 的出口 IP 一试就会被限流近一小时，连真的授权码也会被一起拒掉。Claude 令牌一律由用户在自己的电脑上生成（见 4.4）。
3. **不要给浏览器加 `--no-sandbox`，不要改 sysctl、防火墙等宿主安全设置。** 这台 VM 起不了浏览器沙箱是已知限制，Muse Bridge 本来就不装浏览器。
4. **不要试 Docker。** 这里 runc 起不了容器（`unable to join session keyring`），已经确认无解。
5. **不要改代码目录里的文件。** 要调整行为，一律用 `bootstrap.sh` 的子命令。
6. **管理员访问令牌、Claude 令牌、各家 API key、Cloudflare 隧道令牌，都不要写进你的长期记忆或任何笔记。** 管理员令牌装完会出现在结果块里，原样交给用户并提醒他当场存好；他用它登录成功一次之后，结果块就不再显示它。丢了就用 `reset-token` 重新生成。
7. **用用户平时跟你说话的语言交流。** 对用户讲人话，命令和输出放在代码块里给他看。
8. **能少跑一条命令就少跑一条。** 你每跑一条命令，用户都要点一次「允许」；一口气发一串，他根本点不过来。所以：
   - 不要轮询。`install`、`update`、`set-agents` 自己会转到后台，前台等着、只打印进度，完了打印结果块；没等完就跑一次 `bash /home/hatch/bridge-ops/bootstrap.sh wait`（还是没完就再跑一次）。**别用 `tail`、`ps`、`sleep`、`curl` 去看进度。**
   - 结果块已经包含验收要看的全部信息（服务状态、本地 / 公网健康、实际生效的 agent）。不要再为了确认去单独跑命令。
   - 能合并的步骤写进一条命令（用 `&&` 串起来）。
   - 平台弹的命令审批里如果有「长期允许」这类选项，可以告诉用户有这个选项、由他自己决定；不要替他做主，也不要催。

## 1. 开工前：一次问清三件事

先用一条消息把下面三个问题一起问用户，拿到回答再装。回答记下来，装的时候要用：

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

用户拿不准时的建议：选 A、先用临时地址、只自己用。这些以后都能改（第 6 节）。

## 2. 部署（约 5–10 分钟）

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

**先一律用临时地址装**（域名放到装好之后再换，第 5 节），这样用户马上就能用上，出问题也好排查：

```bash
bash "$REL/bridge/deploy/muse/bootstrap.sh" install --agents claude --solo
```

- 整个安装要 5–10 分钟（装 npm 依赖、构建前端）。**直接在前台跑这一条就行，不要自己加 `nohup` / `&`**：脚本会把活转到后台（你的命令工具超时也打断不了它），前台最多等 4 分半，每完成一步打印一行进度。
- 前台等到头还没装完，会提示「还在后台跑」。这时跑一次 `bash /home/hatch/bridge-ops/bootstrap.sh wait`，它接着等、接着打印进度；还没完就再跑一次。中间不要用别的命令看进度。
- 如果 VM 刚重启过、服务账号还没被平台写回来，脚本会按数据目录的属主自己补回来，不用管。
- 装到最后会把要用到的网站挨个访问一遍（「放行要用到的网站」那一步），Muse 可能弹出几张「允许 Muse 与 … 分享信息？」的审核卡片。安装在后台跑，卡片**常常出现在右侧的「待审核 / Needs review」面板里**，不一定在输入框上方。**开始安装前就告诉用户**：看到这种卡片（两个地方都留意），点「允许一次」旁边的下拉，选「总是允许此站点」。批过的网站以后服务在后台访问也不会再问；没批的，之后第一次用到时对话会卡在「等待模型回复」。
- 脚本可以重复跑。中途失败（网络抖动、VM 重启）就原样再跑一次，已有的数据和令牌都不会动。
- 最后打印「MUSE-BRIDGE 结果」块。**状态**是「正常」，并且**公网健康**是 200，才算装好。**管理员令牌**那一行会一直显示，直到用户用它登录成功一次。

### 2.3 注册看门狗 hook（必做）

这台 VM 每隔几个小时会被平台整机重启一次，重启后我们的服务会丢、临时地址会变。VM 上没有 cron，也没有用户级 systemd，**只有你的 hook 能把它救回来**。

- 脚本已经放在 `~/hooks/scripts/bridge-watchdog.sh`。
- 用你的 hooks 工具创建 id 为 `bridge-watchdog` 的 hook（已经有了就更新它）。各字段照抄 `/home/hatch/bridge-ops/hooks/bridge-watchdog.json`：`id`、`script_path`、`poll_interval_secs`=60、`script_timeout_secs`=600、`delivery`、`prompt`。然后启用它。
- 你的工具支持 dry-run 的话，先 dry-run 一次，把结果贴出来。
- 它每分钟：补回丢失的服务和配置 → 检查健康 → 挂了先重启 → 还不行就唤醒一个 worker 排查 → 临时地址变了就唤醒你告诉用户 → 发现新版本 / 更新完成 / 更新失败自动回退时通知你。
- 以后每次安装或更新，结果块里「看门狗 hook」那一行会告诉你定义有没有变；变了就按同一个 json 更新这个 hook。

### 2.4 验收（看结果块，不用另跑命令）

对照安装打出来的结果块（没有就跑一次 `status`），必须满足：4 个服务（bridge、cf-relay-api、cf-relay-edge、muse-tunnel）都是 `active`；本地健康、公网健康都是 200；「agent」那一行括号里「服务端报告」的名单跟用户选的一致；hook 已注册并启用。

「网站放行」（英文块里是 Sites）那一行如果不是「全部已放行」，说明有网站的审核卡没人批（多半是卡片出在右侧面板里被错过了）。趁用户还在，告诉他马上会弹卡片、选「总是允许此站点」，然后在前台跑一次 `bash /home/hatch/bridge-ops/bootstrap.sh allow-sites`。不处理的话，比如 `api.anthropic.com` 没放行，用户配好令牌后第一次跟 Claude 说话就会一直转圈。

### 2.5 写进你的长期记忆

记下这些（令牌与密钥除外，见硬规矩 6）：

- 这台 VM 上部署了 Muse Bridge。说明书在 `/home/hatch/bridge-ops/MUSE.md`，处理相关的事之前先重读。
- 用户的三个选择（装了哪些 agent、临时地址还是自己的域名、自己用还是多人用），以及他选的更新方式（每次先问，还是自动更新）。
- 运维入口是 `bash /home/hatch/bridge-ops/bootstrap.sh <子命令>`，子命令见说明书第 6 节。数据目录是 `/home/hatch/bridge-srv`（各版本共用）。
- 临时地址每次 VM 重启都会变。用户问地址时跑 `status` 拿当前地址，别用记忆里的旧地址。
- 看门狗 hook 的 id 是 `bridge-watchdog`。
- 不在 VM 上跑 Claude 登录；不加 `--no-sandbox`；不试 Docker。
- 每次更新完，重读一遍 `/home/hatch/bridge-ops/MUSE.md`：新版本的说明书可能有变化，以它为准。

## 3. 交付给用户

把结果块里的**公网地址**和**管理员令牌**给他，并提醒：

- 令牌就是管理员密码，请马上存进密码管理器或备忘录。他用它登录成功一次之后，你这边就再也看不到它了；丢了可以找你重置，重置后旧令牌作废。
- 用临时地址时：地址大约每几个小时变一次（VM 重启导致），变了你会主动告诉他，他也可以随时问你「地址是多少」。**令牌不会变，但换了地址要重新用令牌登录一次**（浏览器的登录状态是跟着网址存的）。嫌麻烦可以换成自己的域名（第 5 节）。
- 这个地址谁拿到都能打开登录页，但没有令牌或账号进不去。
- **顺带告诉他有安卓 app**（结果块里「安卓 app」那一行）：用安卓手机的浏览器打开地址，进「设置 → 安卓 app」就能下载安装；也可以直接从 GitHub 下载 `https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk`。app 跟网页版界面一样、随服务器自动更新，好处是桌面上有图标、记得住地址，临时地址变了能在 app 里直接换。iPhone 目前没有 app，用 Safari 的「添加到主屏幕」。

## 4. 带用户上手

按下面的顺序一步一步带。每步说清楚要做什么，等用户确认做完了再往下走。没装的 agent 相关的步骤跳过。

### 4.1 登录
让他用浏览器（手机、电脑都行）打开地址，点「用访问令牌登录」，粘贴令牌。进到界面就成功了。手机上可以把页面加进书签或添加到主屏幕。

**安卓手机建议装 app**：登录后进「设置 → 安卓 app」点「下载」，装好后回到这一页点「在 app 里打开」，app 会自动填好地址；再用令牌登录一次就行。手机提示「禁止安装未知来源应用」时，按提示允许浏览器安装应用。app 里换地址：「设置 → 安卓 app → 服务器地址 → 更换」，或者连不上时 app 自己弹出的「更换地址」。

### 4.2 （可选）扫码登录另一台设备
已经登录的手机，可以在另一台电脑的登录页选「扫码登录」，用手机扫一下就登上了。

### 4.3 界面怎么用
- **Claude Code 页**：中间是对话；左侧栏是项目和历史对话；右侧可以唤出「工作台」：终端、文件、任务、改动审阅。
- **dimensio 页**：同样是对话 + 侧栏；右上角能选用哪家模型。
- 两个都装了时，页面里的「主页」回到入口页。
- 界面语言跟着浏览器走（浏览器语言里有中文就是中文，否则英文）；「设置 → 通用 → 语言」可以手动改。
- 「设置」（点左下角的账户卡）里有：通用、账户、Agent（各 agent 的开关与状态）、连接（服务器地址、**服务端控制台**入口：管用户、看运行状态、配 Claude 账号）、安卓 app（下载、在 app 里打开）、关于；下面的「自定义」是给 agent 装技能 / 连接器 / 插件的地方。

### 4.4 配 Claude（装了 Claude Code 才需要）
Claude 需要用户自己的 Claude 订阅（Pro 或 Max）。令牌**只能在他自己的电脑上生成**，不能在这台 VM 上生成（原因见硬规矩 2）：
1. 在他自己的电脑上装 Claude Code（官方安装方式，或者 `npm install -g @anthropic-ai/claude-code`）。
2. 在终端运行 `claude setup-token`，浏览器里登录 Claude 账号并授权，终端会打印一串以 `sk-ant-oat` 开头的长期令牌。
3. **推荐做法**：回到 Muse Bridge，打开「设置 → 连接 → 服务端控制台 → Claude 账号」，添加一个账号，把令牌粘进去。这样令牌不经过聊天记录。
4. 他想让你代配也行：让他把令牌发给你，你执行 `bash /home/hatch/bridge-ops/bootstrap.sh set-claude-token <令牌>`，然后提醒他删掉聊天里那条消息。

配好之后，让他在 Claude 页发一句「你好，介绍一下你能做什么」，有回复就说明通了。

### 4.5 配 dimensio 的模型 key（装了 dimensio 才需要）
问他打算用哪一家（可以多家），把对应的 key 写进去（每家一条命令）：

```bash
bash /home/hatch/bridge-ops/bootstrap.sh set-api-key ANTHROPIC_API_KEY <key>
```

可用的名字：`ANTHROPIC_API_KEY`（Claude）、`DEEPSEEK_API_KEY`（DeepSeek）、`GEMINI_API_KEY`、`KIMI_API_KEY`（Kimi for Coding 订阅 key，`sk-kimi-` 开头）、`ZHIPU_API_KEY`、`QWEN_API_KEY`、`MIMO_API_KEY`（`tp-` 开头的 Token Plan key 也行）。写完提醒他删掉聊天里含 key 的那条消息。

**联网搜索**：dimensio 的联网搜索用的是所配厂商自带的搜索（同一把 key，不用另外申请）：当前对话用哪家，就先用哪家的；其余配了 key 的厂商依次备用，都没有时退回免费但不太稳的 DuckDuckGo。智谱、Kimi（`sk-kimi-` 订阅 key）、DeepSeek、通义、Gemini、Claude 配上 key 就能搜；**小米要多一步**：联网搜索是小米控制台「插件管理」里的「联网搜索」插件（按次计费，约 ¥16 / 千次，从账户余额扣），而且**只在按量付费的 key 上能用**。用户填的如果是 Token Plan 订阅的 key（`tp-` 开头），这把 key 搜不了（小米的 Token Plan 接口不开放插件，控制台开了也没用）：想用小米搜索，就让他在控制台再建一把按量付费的 API key，用 `set-api-key MIMO_SEARCH_API_KEY <那把 key>` 单独配给搜索，聊天照旧用 Token Plan。不配也行，小米搜不了会自动退回别家，搜索结果里会提醒。

**网络审核（重要）**：这台 VM 访问外部网站要用户在 Muse 里批准，卡片是「允许 Muse 与 <网站> 分享信息？」。dimensio 在后台第一次调某家模型时如果弹这张卡、而用户不在场，对话会一直停在「等待模型回复」。所以 `set-api-key` 写完 key 会马上访问一次这家的接口网站，**把卡片提前弹出来**。跑这条命令之前先告诉用户：「马上会弹一张审核卡片，请点『允许一次』旁边的下拉，选『总是允许此站点』」——这样以后这家就不会再卡。你看不到卡片，命令会停在那里等他批（最多 3 分钟）；输出里 ✓ 表示放行了。然后让他在 dimensio 页选对应的模型发一句话试试。

### 4.6 给朋友开账号（选了「多人用」才需要）
「设置 → 连接 → 服务端控制台 → 用户」里点「＋ 普通邀请码」（只自己用模式下这一页叫「服务账号」，没有邀请码）。朋友打开同一个地址，点「注册新账号」，填上邀请码即可。新账号默认只能用 Claude；要让他用 dimensio，在「用户」页给他勾上。提醒用户：「Pro 邀请码」给的账号带命令行，只发给完全信任的人。

### 4.7 需要知道的限制
- **没有浏览器工具**：这台 VM 起不了浏览器，agent 用不了「打开网页、截图」这类功能（联网搜索、抓网页内容照常可用）。
- **这是 Muse 的 VM，不是正式服务器**：平台随时可能调整网络，长期对外提供服务也可能违反平台条款。别放重要数据，也别当生产环境用。
- **更新**：有新版本时我会告诉你更新了什么，你说「更新」我就更新。更新会等没人在聊天时才切换，不打断对话；新版本起不来会自动退回旧版本。你也可以让我开「自动更新」。

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
| 「给 dimensio 加 / 换 / 删一家模型的 key」 | `set-api-key <名字> <key>`（key 留空 = 删掉；写入时会弹审核，先提醒用户选「总是允许此站点」） |
| 「我要在 dimensio 里加一个自定义模型服务」（OpenAI 兼容地址） | 先问他接口地址，跑 `allow-sites <地址>` 并提醒他把弹出的审核选「总是允许此站点」，**然后**再让他去 dimensio 的模型服务面板点「＋」添加——否则添加时会卡在「连接中」 |
| 「对话一直在等待模型回复」「模型没反应」 | 多半是网络审核没人批：让他看 Muse 里有没有待审核的卡片，选「总是允许此站点」；或者跑 `allow-sites`（按现在的配置把要用的网站挨个放行一遍） |
| 「我也想用 dimensio」「不要 dimensio 了」等 | `set-agents claude` / `set-agents dimensio` / `set-agents claude,dimensio`（要重新装依赖、构建，几分钟；跟 `install` 一样自己转后台，没等完就 `wait`；完了等没人在聊时自动切换） |
| 「让朋友也能用」「只给我自己用」 | `set-users multi` / `set-users solo` |
| 结果块要换语言 | `set-lang en` / `set-lang zh` |
| 「想要固定地址」 | 按第 5 节带他做 |
| 「有手机 app 吗」「怎么装到手机上」 | 安卓：手机浏览器打开地址 →「设置 → 安卓 app」下载安装，或者给他 GitHub 链接 `https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk`；iPhone：Safari「分享 → 添加到主屏幕」 |
| 「app 打不开了」「app 连不上」 | 多半是临时地址换了：`status` 拿到新地址告诉他，让他在 app 弹出的面板里点「更换地址」粘进去 |
| 「有新版本吗」 | `check-update`，把当前版本、最新版本、更新内容告诉他 |
| 「更新」 | `update`（自己转后台、前台打印进度，完了贴结果块；没等完就 `wait`） |
| 「装到哪一步了」「好了没」 | `wait` |
| 「现在就切到新版本」（新版本已装好，在等空闲） | 先说明会打断正在进行的对话（记录不会丢），他同意后执行 `switch-now` |
| 「退回旧版本」「更新后有问题」 | `rollback`（立即重启到上一个版本） |
| 「开 / 关自动更新」 | `auto-update on` / `auto-update off` |
| 看门狗唤醒你 | 照 hook 提示里对应 kind 的说明办。排查故障时只用本机命令（`status --local`、`journalctl`），别去访问公网地址：那要用户批准网络权限，没人在场会超时 |
| 「卸载」 | 先确认。然后 `systemctl disable --now bridge cf-relay-api cf-relay-edge muse-tunnel`，删掉 `bridge-watchdog` hook，再删 `/home/hatch/bridge-ops`、`/home/hatch/bridge-releases`；`/home/hatch/bridge-srv` 是用户的数据，问过他再删 |

### 更新是怎么进行的（给你自己看的）

1. `update` 把新版本下载到 `bridge-releases/<时间戳>/`，核对 sha256，再用**新版本自己的** `bootstrap.sh install --switch idle` 安装（沿用用户现在的三个选择）。装依赖、构建前端都在新目录里做，正在跑的服务不受影响。
2. 装好后把 `bridge-releases/current` 指向新目录，给 bridge 发「空闲时重启」。bridge 等所有在跑的对话结束后自己重启，重启后就跑在新版本上。
3. 看门狗每分钟跟踪一次：新版本跑起来且健康 → 通知「已更新」；切过去 5 分钟还不健康 → 自动退回旧版本并通知「更新失败」；40 分钟都等不到空闲 → 问用户要不要现在切。
4. 只保留最近两个版本当回滚点。用户的数据在 `bridge-srv`，更新不会动它。

## 7. 故障排查

先跑 `status`，再看对应服务的日志：`journalctl -u <服务名> -n 80 --no-pager`。

| 现象 | 原因 | 处理 |
|---|---|---|
| apt 卡在某个镜像上重试（如 `mirror.cogentco.com … Connection failed`） | 镜像源里有经代理不通的镜像，而且平台每次开机都会把它还原 | `install` 会自动探测并删掉不通的镜像；还卡就看 `/etc/apt/sources.list.d/ubuntu.sources` 的 `URIs:` 那一行 |
| npm `socket hang up`、`ETIMEDOUT` | 经代理的网络偶尔不稳 | 原样重跑 `install` |
| 本地 200，公网不是 200，或者地址打开是 530 | 隧道断了，或者 VM 重启后临时地址换了 | 跑 `status` 拿到新地址；还不通就 `systemctl restart muse-tunnel`，等 30 秒再看（临时地址**会换**，记得告诉用户） |
| muse-tunnel 日志里有 `failed to request quick Tunnel` / `Client.Timeout exceeded` | 出站代理冷启动慢，申请临时地址超时 | 隧道会自己重试，启动前也会先把代理热起来，一般一两分钟内就好；5 分钟还不行再 `systemctl restart muse-tunnel` |
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
| 更新后用户说哪里不对 | 新版本的问题 | 先 `rollback`，再把现象告诉用户，请他到 GitHub 仓库提 Issue |

处理不了的，把 `status` 的输出和相关日志贴给用户，说清楚卡在哪、需要他做什么决定。
