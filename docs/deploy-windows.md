# 在 Windows 上部署 bridge 服务端

适用于 Windows VPS（Windows Server 2019 / 2022 / 2025）和自己的电脑（Windows 10 / 11）。对标 Linux 上的 `scripts/server/install.sh` + systemd：

- **计划任务**托管，登录类型 Password（「不管用户是否登录都运行」）：开机就跑，没人登录也跑。
- **守护启动器** `scripts/server/win/bridge-service.mjs` 看着 `src/server.mjs`：崩了按退避重启；控制台点「重启」时服务端以 75 退出，它立即拉起；日志写进 `<数据根>\server.out.log`，超过 2MB 轮转、保留 5 代。
- 控制台「服务控制」能重启、能一键更新（`scripts/server/update.ps1`）。

> 只在自己电脑上用、又离不开真实桌面（操控桌面、桌面截图、用你正开着的浏览器）的，也可以装 Windows 桌面客户端、安装时选「服务端」：它随登录启动，跑在你的桌面会话里，**你不登录就不跑**。本文这套不依赖登录，适合 VPS 和要求开机即在线的电脑。

## 1. 装 Node.js 与 Git

管理员 PowerShell：

```powershell
winget install OpenJS.NodeJS.LTS      # Node ≥ 22.6，推荐 24
winget install Git.Git
```

没有 winget（部分 Windows Server）就到 nodejs.org、git-scm.com 下载安装包。装完**重开**一个 PowerShell，`node -v`、`git --version` 能出版本号再往下走。可选：ffmpeg（视频缩略图与转码）、7-Zip（解压）、LibreOffice（文档预览），装了放进 PATH 即可。

## 2. 拿代码、装依赖、构建前端

用**将来运行服务的那个账号**（一般就是你自己）在普通 PowerShell 里做，代码目录归它：

```powershell
git clone <仓库地址> C:\bridge
cd C:\bridge
npm ci --omit=dev
npm --prefix harness ci --omit=dev
npm --prefix harness/web ci; npm --prefix harness/web run build
npm --prefix web ci; npm --prefix web run build
```

私有仓库：在凭据管理器里存好凭据（第一次 `git pull` 时登录一次即可），或者用带令牌的 https 远端。以后控制台里点「更新」是在后台拉代码，没人能回答登录提示。

## 3. 首次运行：生成 config.json 与访问令牌

数据（`config.json`、账号、会话、工作空间、日志）放在**数据根**。默认就是程序目录；VPS 上建议放到程序目录外，升级、备份都清爽，下面用 `D:\bridge-data` 举例。

```powershell
cd C:\bridge
$env:BRIDGE_DATA_ROOT = 'D:\bridge-data'
mkdir $env:BRIDGE_DATA_ROOT -Force
node src\gen-token.mjs --hash        # 打印一次访问令牌——当场存好；config.json 只存它的哈希
```

再打开 `D:\bridge-data\config.json` 按需补几项：

- **多用户的 VPS**：加 `"features": { "multiUser": true }`。不写就是「只给我自己」（只有管理员与服务账号能登录）；服务端控制台的远程管理默认开（管理员令牌登录即可）。老配置里的 `"edition": "server"` 仍然认，等同于打开多用户。计划任务托管的服务端按「无界面服务器」形态定其余默认值（不带 Claude in Chrome），规则见 [deploy-linux.md](deploy-linux.md) 第 6 节。
- **Claude 认证**：`npm run set-auth -- <claude setup-token 生成的令牌>`（同一个窗口里，`BRIDGE_DATA_ROOT` 还在），或者登录后在控制台「Claude 账号」里加。
- 端口默认 8787，改 `"port"`。
- 监听地址改 `"bindHost"`：`"0.0.0.0"` 让同一局域网的手机直连（还要放行防火墙，见第 6 节），`"127.0.0.1"` 只听本机、对外走隧道。用 `gen-token` 生成的配置不写时听所有网卡；服务端自己第一次启动生成的配置（带 `"defaultsVersion": 2`）在计划任务托管下默认只听本机。

自己电脑上的单人主机不想用哈希令牌也行：跳过 `gen-token`，第一次启动会自动生成带明文令牌的 `config.json`，之后 `npm run -s show-token` 查看。

想先在前台试跑一下：`node src\server.mjs`，看到 `claude-bridge listening` 再 Ctrl+C 停掉。

手机接入：服务端跑起来以后，`node src\cli.mjs pair` 在终端里出一张配对二维码（手机 App 首屏「扫码连接」扫它），`node src\cli.mjs access` 列出本机 / 局域网 / 公网地址。config.json 只存哈希时要把令牌交给它：`$env:BRIDGE_TOKEN='<令牌>'; node src\cli.mjs pair`，用完 `Remove-Item Env:BRIDGE_TOKEN`。

## 4. 装成计划任务

**管理员** PowerShell（开机触发器只有管理员能建）：

```powershell
cd C:\bridge
powershell -ExecutionPolicy Bypass -File scripts\server\install-windows.ps1 -DataRoot D:\bridge-data -WhatIf   # 先看看要做什么
powershell -ExecutionPolicy Bypass -File scripts\server\install-windows.ps1 -DataRoot D:\bridge-data
```

脚本会弹窗让你输入**当前账号的 Windows 登录密码**（为什么见第 9 节），然后注册计划任务 `BridgeServer`、启动、等 `/healthz` 正常：

| 项 | 值 |
|---|---|
| 动作 | `node.exe "C:\bridge\scripts\server\win\bridge-service.mjs" --data-root "D:\bridge-data"`，工作目录 `C:\bridge` |
| 账号 | 你的账号，登录类型 Password，RunLevel Limited |
| 触发器 | 开机（延迟 30 秒等网络）；`-AtLogon` 再加一个登录时 |
| 设置 | 电池供电也启动、不因电池停止、执行时限无限、失败后每 1 分钟重试最多 999 次、已在运行则忽略新实例、错过了尽快补跑、优先级正常 |

数据根为什么用 `--data-root` 参数传：计划任务的动作带不了环境变量，启动器收到参数后把它设成服务端的 `BRIDGE_DATA_ROOT`。不另包一层 `.cmd`——少一个 cmd.exe 进程，也少一层路径里 `&`、`%` 之类的转义坑。

其它参数：`-TaskName`（默认 BridgeServer）、`-Node`（node.exe 路径）、`-Credential`（脚本化部署时传凭据，不弹窗）、`-NoStart`、`-Force`（已有同名任务时不再确认）。可以重复执行：数据、令牌、账号都不动。

## 5. 日常

| 做什么 | 怎么做 |
|---|---|
| 启动 | `Start-ScheduledTask -TaskName BridgeServer` |
| 停止（优雅） | `New-Item -ItemType File D:\bridge-data\bridge-service.stop`：启动器 2 秒内看到，收掉服务端整棵进程树、删掉这个文件后退出 |
| 停止（硬停） | `Stop-ScheduledTask -TaskName BridgeServer`：启动器被直接结束，服务端跟着没，但服务端 detached 起的孙进程可能留下 |
| 重启 | 控制台「服务控制 → 重启」（可选等对话跑完）；或 `New-Item -ItemType File D:\bridge-data\bridge-service.restart`（立即，在跑的对话会被打断） |
| 日志 | `D:\bridge-data\server.out.log`（`.1`…`.5` 是更早的）；`Get-Content D:\bridge-data\server.out.log -Tail 50 -Wait` 跟着看。控制台「最近日志」也能看最近几百行 |
| 状态 | `Get-ScheduledTask BridgeServer`；`D:\bridge-data\bridge-service.pid` 里有启动器和服务端的 pid |

停止之后到下次开机（或手动 `Start-ScheduledTask`）都不会再起来。启动器每次拉起服务端都会写一行 `[bridge-service] …` 到日志，崩溃、退避、重启的来龙去脉都在里面。

## 6. 从外网访问：隧道与防火墙

最省事：用访问令牌登录后，到控制台「服务控制 → 公网访问」里开，入站一个端口都不用开：

- **临时地址**：免注册，一键拿到 `https://….trycloudflare.com`；服务端每次重启地址会变（控制台里看当前地址），适合先试用。经临时地址远程连着时控制台不让重启 / 更新服务端（地址一换就连不回来），要在这台电脑上操作。本机开着 Clash 之类的 fake-ip / TUN 时，「从外网检查」可能显示打不开而手机照样能用，以手机实测为准。
- **Cloudflare 隧道**：域名托管在 Cloudflare 时用，地址固定。在 Cloudflare Zero Trust 面板建隧道、把令牌（整条安装命令也行）粘进来，再给隧道加一个公网主机名，服务填 `http://localhost:8787`。
- **自己的域名**：已有反向代理时只填对外地址。

cloudflared 由服务端自己托管：PATH 里有就用，没有就自动从官方 GitHub Release 下载固定版本到数据根（`<数据根>\.bin\cloudflared-<版本>\`，校验 SHA-256）；随服务端起停、崩了自动重拉、连不上 Cloudflare 自动重启隧道。令牌只存在 `<数据根>\public-access.json`。

也可以照旧用 cloudflared 自带的 Windows 服务（开机自启，跟服务端无关）——在**管理员** PowerShell 里：

```powershell
winget install Cloudflare.cloudflared
cloudflared service install <隧道令牌>
```

两种别对同一条隧道同时开（会多一份连接；控制台会提示这台机器另有 cloudflared 服务）。

防火墙：Windows 防火墙默认挡入站，走隧道就什么都不用开。想让局域网里的手机直连（自己电脑上常用），先确认服务端听着局域网——`node src\cli.mjs access` 能列出局域网地址就是在听；只列出 `127.0.0.1` 的，在 `config.json` 写 `"bindHost": "0.0.0.0"` 后重启任务（见下一段）——再放行端口（管理员）：

```powershell
New-NetFirewallRule -DisplayName 'The Bridge 8787' -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

VPS 上**别**把 8787 直接开到公网（明文 HTTP）。监听地址的默认值看 `config.json` 是怎么来的：用 `gen-token` 生成的（第 3 节的做法）默认听所有网卡；服务端自己第一次启动生成的（带 `"defaultsVersion": 2`）在计划任务托管下默认只听本机。不想靠默认值就在 `config.json` 里写明 `"bindHost"`：`"127.0.0.1"` 只听本机，`"0.0.0.0"` 听局域网，改完重启任务；`node src\cli.mjs access` 看实际在听哪些地址。也可以给运行账号设用户环境变量 `BRIDGE_HOST`（`[Environment]::SetEnvironmentVariable('BRIDGE_HOST', '127.0.0.1', 'User')`，它比 `bindHost` 优先），再重启任务——计划任务以这个账号启动时会带上它的用户环境变量，`HTTPS_PROXY` 之类只能走环境变量的设置也这样给。

## 7. 更新

```powershell
powershell -ExecutionPolicy Bypass -File C:\bridge\scripts\server\update.ps1              # 拉代码、按需装依赖、重建前端、立即重启
powershell -ExecutionPolicy Bypass -File C:\bridge\scripts\server\update.ps1 -NoRestart   # 只更新；再到控制台点「空闲时重启」，不打断正在跑的对话
```

或者直接在控制台「服务控制 → 检查并更新」（就是在后台跑 `update.ps1 -NoRestart`，有新代码就等所有人的对话跑完再重启）。

和 Linux 的 `update.sh` 不一样的一点：**跑着的服务端锁着 `node_modules`**（原生模块、SDK 自带的 `claude.exe`），在线 `npm ci` 会删到一半失败、把依赖弄残。所以根目录与 `harness` 的依赖有变化时，`update.ps1` 不当场装，而是写 `<数据根>\bridge-service.deps`，由启动器在下一次拉起服务端**之前**装（停服的那几十秒里）；`web`、`harness/web` 只是构建期依赖，照常当场装。依赖只在 `package.json` / `package-lock.json` 有变化或 `node_modules` 不在时才装；代码没变就直接收工，要强制重装重建加 `-Force`。

## 8. 卸载

```powershell
powershell -ExecutionPolicy Bypass -File C:\bridge\scripts\server\install-windows.ps1 -Uninstall    # 管理员
```

先写 stop 文件让启动器优雅退出，再删计划任务。数据根原样保留，要彻底清掉自己删目录。隧道另行 `cloudflared service uninstall`。

## 9. 常见问题

**为什么要输密码？为什么不用 S4U 或 SYSTEM？**
默认的 Interactive 登录类型只在你登录后才跑，VPS 重启后没人登录，服务就起不来，所以要「不管用户是否登录都运行」。这个模式有两种：

- **Password**（本脚本用的）：任务计划程序替你保存密码（Windows 自己加密存放），开机时以你的身份正常登录，DPAPI、网络共享都和你本人登录一样。
- **S4U**（「不存储密码」）：不用密码，但它的登录会话里没有由密码派生的 DPAPI 主密钥。bridge 的扩展中心凭据、自定义 API 的密钥都用 DPAPI（当前用户）加密，S4U 下解不开；也访问不了网络共享。

**SYSTEM（LocalSystem）** 也不行：它的家目录是 `C:\Windows\System32\config\systemprofile`，`~/.claude` 等全落到那里，你已有的 Claude 登录态、会话、配置一概看不到；agent 以 SYSTEM 身份跑也等于把整台机器交出去。

**微软账号登录的电脑填什么密码？** 微软账号的密码，不是 PIN。

**改了账号密码之后服务起不来？** 任务里存的还是旧密码。重跑 `install-windows.ps1 -DataRoot … -Force` 输入新密码即可。

**注册时报「登录失败：未授予用户在此计算机上的请求登录类型」（0x80070569）？** 账号缺「作为批处理作业登录」权限，多见于加了域、被组策略限制的机器：`secpol.msc` → 本地策略 → 用户权限分配 → 作为批处理作业登录，把账号加进去（域策略会盖掉本地设置，要找域管理员）。

**Windows Update 自动重启。** 重启后服务会自己起来（开机触发器），但在跑的对话会被打断。自己电脑：设置 → Windows 更新 → 高级选项 → 「活动时间」。VPS（没人登录，「有用户登录时不自动重启」那条策略管不到）：Server 上 `sconfig` 把更新改成「仅下载」，或在组策略（计算机配置 → 管理模板 → Windows 组件 → Windows 更新）里把「配置自动更新」设成 3（自动下载并通知安装），自己挑时间装、挑时间重启。

**不登录时跑在哪？** 这种任务跑在没有桌面的会话（session 0）里：无头浏览器、终端、文件这些都正常，但凡要你真实桌面的（操控桌面、桌面截图、用你正开着的浏览器）都用不了。自己电脑上离不开这些的，改用桌面客户端的本机服务端（安装时选「服务端」，随登录启动、跑在你的桌面会话里）。

**已有同名任务。** 机器上已经有叫 `BridgeServer` 的计划任务时，install-windows.ps1 会提示并要你确认覆盖（`-Force` 不再确认）。覆盖前先停掉原来那套启动方式（它自己的停止脚本、开机自启项、看门狗），免得两边抢同一个端口；原来的数据在程序目录里的，`-DataRoot` 不给即可沿用。

**端口被占、服务起不来。** `server.out.log` 里会有 `EADDRINUSE`。找出占端口的进程：`Get-NetTCPConnection -LocalPort 8787 -State Listen | Select OwningProcess`，停掉它之后写一个 `bridge-service.restart` 让服务端重来。服务端自己崩了退出时，启动器按 2 秒起翻倍、最长 60 秒的间隔重试，不用管。

**日志里出现「日志轮转失败」。** 有程序开着 `server.out.log` 且不允许改名（比如另一个窗口在 `Get-Content -Wait`）。启动器会接着写原文件、过一阵再试，关掉那个窗口就好。
