# 在 Linux 上部署 bridge 服务端（无界面）

适用于 Linux VPS、家里常开的 Linux 机器、自己的 Linux 电脑。一键脚本 `scripts/server/install.sh` 把服务端装成 systemd 服务：开机就跑、崩了自动拉起，控制台「服务控制」能重启、能一键更新。

- 支持：Debian 12 / Ubuntu 22.04 及以上（apt + systemd），x86_64 与 arm64。其它发行版用 Docker（[deploy-docker.md](deploy-docker.md)），或照第 9 节手动装。
- 机器配置：2 核 4G 起步；磁盘留 10 GB 以上（依赖、前端构建、Claude 会话记录）。
- 网络：要能连上 GitHub、npm 源与 Anthropic。出站只能走代理的，先 `export HTTPS_PROXY=http://代理:端口` 再跑脚本，代理会一并写进服务环境。

## 1. 两种装法

同一个脚本，按你用不用 `sudo` 自动选：

| | 系统服务（`sudo bash install.sh`） | 用户服务（`bash install.sh`，不带 sudo） |
|---|---|---|
| 适合 | VPS、专用服务器 | 自己的 Linux 电脑、家里的机器 |
| 以谁的身份跑 | 新建的系统用户 `bridge` | 你自己 |
| agent 能碰的文件 | 只有数据目录里的工作空间 | 你的文件、你的 Claude 登录（`~/.claude`） |
| 数据目录 | `/var/lib/bridge` | `~/.local/share/bridge/data` |
| 程序目录（脚本自己克隆时） | `/opt/bridge` | `~/.local/share/bridge/app` |
| 服务单元 | `/etc/systemd/system/bridge.service` | `~/.config/systemd/user/bridge.service` + `loginctl enable-linger`（不登录也跑） |
| 运维命令 | `sudo bridgectl …` | `bridgectl …`（在 `~/.local/bin`） |
| 默认监听 | `127.0.0.1`（对外走隧道 / 反代；装时会问要不要局域网直连） | 有图形界面：所有网卡（家里同一个 Wi-Fi 的手机直连）；没有：`127.0.0.1` |

用户服务要在你自己的登录会话里装（直接 ssh 登录这个用户，别用 `sudo -u` / `su`）；缺的系统包会用 `sudo` 装，届时问一次密码。

## 2. 安装

手上没有源码也行——脚本会先把公开仓库克隆下来，再用克隆里同一版本的脚本接着装：

```bash
curl -fsSL https://raw.githubusercontent.com/Wode44398/claude-bridge/main/scripts/server/install.sh | sudo bash
```

已经克隆了（别放在 `/root` 底下，服务用户读不到）：

```bash
git clone https://github.com/Wode44398/claude-bridge.git /opt/bridge
sudo bash /opt/bridge/scripts/server/install.sh
```

第一次安装会在终端里问两件事（`-y` 不问，按默认值）：

1. **这台服务器给谁用**：只给我自己（默认）/ 也给别人用。也可以直接给 `--solo` / `--shared`。
2. **手机怎么连**（系统服务）：只走公网隧道或反向代理（默认，VPS 选这个）/ 同一个 Wi-Fi 里直连（家里的机器选这个）。也可以直接给 `--local-only` / `--lan`。

装完会打印：

- **访问令牌**：只显示这一次（`config.json` 里只存它的哈希），请当场存好。它就是管理员身份，别外传。
- **访问信息**：本机 / 局域网 / 公网地址（同 `bridgectl access`）。
- **配对二维码**：手机 App 首屏点「扫码连接」扫它，就以管理员身份连上，不用抄地址和令牌；没装 App 用系统相机扫，直接在浏览器里打开。码 3 分钟内有效、只能用一次；`Ctrl+C` 跳过，以后随时 `sudo bridgectl pair` 再出一张。只听本机、又没开公网访问（VPS 选默认、也没给 `--quick-tunnel` / `--tunnel-token`）时手机连不上，脚本不出码，改为列出先做什么（加 `--quick-tunnel` 或 `--lan` 重跑，或经 `ssh -L` 登录控制台开公网访问）。

常用选项（`--help` 看全部）：

| 选项 | 作用 |
|---|---|
| `--solo` / `--shared` | 给谁用。重跑时不给就保持原样 |
| `--lan` / `--local-only` | 监听所有网卡 / 只听本机。重跑时不给就沿用上次的 |
| `--port N` | 端口（默认 8787） |
| `--quick-tunnel` | 公网访问用临时地址（trycloudflare，免注册；每次重启地址会变） |
| `--tunnel-token T` | 公网访问用 Cloudflare 命名隧道（地址固定，服务端自己托管 cloudflared） |
| `--claude-token T` | Claude 订阅令牌（`claude setup-token` 生成）；也可以装好后在「设置 › Claude › 订阅号池」里加 |
| `--data DIR` / `--dir DIR` | 数据目录 / 克隆到哪 |
| `--repo URL` / `--ref REF` | 从哪个仓库、哪个分支或标签克隆（也可用环境变量 `BRIDGE_REPO` / `BRIDGE_REF`） |
| `--no-browser` | 不装浏览器（agent 的浏览器工具、网页截图用不了） |
| `--no-pair` | 装完不出配对二维码 |
| `-y` | 不问任何问题 |

脚本可以重复执行：已有的数据、令牌、账号一概不动，只补齐依赖、重建前端、刷新服务单元与 `bridgectl`。

## 3. 连上它

- **手机**：`sudo bridgectl pair`，App 首屏「扫码连接」。没有相机就在 App 里填服务器地址和 8 位配对码。
- **浏览器**：打开 `bridgectl access` 列出的地址，选「用访问令牌登录」。服务器只听本机时，从自己电脑上用 `ssh -L 8787:127.0.0.1:8787 你的服务器` 转过来，再开 `http://127.0.0.1:8787`。
- **从外网**：登录后在「设置 › 服务端 › 服务控制 › 公网访问」里选临时地址、Cloudflare 隧道或自己的域名；反向代理的要求见 README「从外网访问」。
- **手机 App 安装包**：手机浏览器打开 `<你的地址>/download/android`。

`config.json` 里只存了令牌哈希也不影响配对：`bridgectl pair` 在服务器本机用主机密钥（`config.json` 的 `remotePcSecret`，只对本机回环有效）出码。要以访问令牌出码时用 `sudo bridgectl pair --token-stdin`，粘贴令牌后按 `Ctrl+D`。

没开公网访问、手机在同一个 Wi-Fi 里直连时，码里放的是服务器的局域网地址（要先 `--lan`）；想指定别的地址就加 `--origin=http://<地址>:<端口>`。服务只听本机、又没开公网访问时，手机扫了也连不上：`pair` 照样打出票面（App 里手填地址 + 配对码 3 分钟内仍可用），写明「手机连不上」和怎么改，然后直接退出、不占着终端干等；确实有别的路能连上（比如自己知道的地址），加 `--force-wait` 让它照样等手机。

## 4. bridgectl

| 命令 | 作用 |
|---|---|
| `access` | 部署形态、给谁用、本机 / 局域网 / 公网地址、令牌与配对的取法 |
| `pair [--once] [--json]` | 终端里出配对二维码 + 8 位配对码，等到手机连上（`--ascii` 终端不认方块字；`--invert` 浅色背景的终端；码里的地址手机连不上时只打印改法就退出，`--force-wait` 照等） |
| `show-token` | 打印访问令牌（只存哈希时没有明文可打） |
| `token` | 换一个新的访问令牌（旧的作废、管理员登录全部下线；`sudo bridgectl restart` 后生效）。沿用现在的存法：install.sh 装的只存哈希，换完仍只存哈希、明文只显示这一次；`--plain` / `--hash` 显式改存法 |
| `invite [--days=N]` / `users` | 普通档邀请码（默认 7 天有效）/ 账号列表（要先打开「也给别人用」）。这两条要访问令牌：`config.json` 只存哈希时加 `--token-stdin`，粘贴令牌后按 `Ctrl+D` |
| `invite full --ack` | 完全信任档的邀请码：有命令行，等同管理员（能读到服务器上所有人的数据和全部凭据），所以要加 `--ack` 表示知道这一点 |
| `status` / `logs` / `restart` / `stop` / `start` | 服务状态、跟日志、起停 |
| `update [--no-restart]` | 拉新代码、装依赖、重建前端，有新代码再重启（`--no-restart`：之后在控制台点「空闲时重启」，不打断在跑的对话） |

`bridgectl` 以服务用户的身份、带着服务的数据目录与端口去跑 `src/cli.mjs`；在源码目录里也可以直接 `BRIDGE_DATA_ROOT=<数据目录> node src/cli.mjs <命令>`。

**权限边界（系统服务）**：程序目录 `/opt/bridge` 归服务用户 `bridge`，agent（管理员的免确认会话、完全信任档用户的命令行）就以 `bridge` 的身份跑，改得动程序目录里的任何文件。所以 `sudo bridgectl`（它本身归 root，在 `/usr/local/bin`）从不以 root 执行程序目录里的代码：`access` / `pair` / `help` 这些都 `runuser` 到 `bridge` 去跑，`update` 也是以 `bridge` 拉代码、装依赖、构建，root 只做最后的 `systemctl restart`。反过来，**别**再 `sudo bash /opt/bridge/scripts/server/update.sh`——那是 root 直接执行一份 `bridge` 改得动的脚本。重跑 `install.sh` 同理要 root 执行程序目录里的脚本：重跑前先 `sudo -u bridge git -C /opt/bridge status` 看一眼有没有不认识的改动（或者删掉程序目录、用 `curl … | sudo bash` 重新克隆，数据目录不受影响）。

## 5. 给谁用：只给我自己 / 也给别人用

- **只给我自己**：只有管理员（访问令牌、扫码配对过的设备）和「服务账号」能登录；注册与邀请码关着。
- **也给别人用**：打开注册与邀请码，在控制台「用户」页发邀请码或直接建号，每个账号有自己的目录与对话，互相看不到。所有人共用你配的 Claude 认证与额度；使用者需自行遵守所用服务的条款。

安装时选的会写进 `config.json` 的 `"features": { "multiUser": true | false }`，之后在控制台「开放给其他人使用」里随时改（改完重启生效）。

## 6. 部署形态与默认值

服务端的几项默认值按**部署形态**定，而不是按操作系统（`src/config/deploy-profile.mjs`）：

| | 本机桌面 `desktop` | 无界面服务器 `server` | Docker `docker` |
|---|---|---|---|
| 怎么认出来 | 桌面客户端托管、Windows / macOS 上源码直跑、有图形界面的 Linux | systemd / Windows 计划任务启动器 / pm2 托管、没有图形界面的 Linux | 容器（镜像里写死） |
| 给谁用 | 只给我自己 | 只给我自己 | 只给我自己 |
| 监听地址 | 所有网卡 | `127.0.0.1` | 所有网卡（对外由端口映射决定） |
| Claude in Chrome | 开（仅 Windows） | 关 | 关 |
| 保持唤醒（有轮在跑时不让机器空闲睡眠） | Windows：系统唤醒请求；Linux：`systemd-inhibit` | Linux：`systemd-inhibit`（没有它就不做） | 不做 |
| 启动日志 | 简短 | 打印访问地址、令牌与配对的取法 | 同左 |

保持唤醒用的是 logind 的睡眠锁，要 polkit 点头：在图形桌面上登录着的用户能拿到；系统服务的 `bridge` 用户、退出登录后靠 linger 跑的用户服务一般拿不到——那时服务端在日志里说一句「没拿到睡眠锁」，十分钟后再试，不影响别的功能。VPS 本来就不睡眠，不用管。

install.sh 在单元里写明 `BRIDGE_DEPLOY=server`（用户服务在有图形界面时写 `desktop`，重跑时沿用上次写的）。显式设置一律优先：

| 想改 | 怎么改 |
|---|---|
| 形态 | 环境变量 `BRIDGE_DEPLOY=desktop\|server\|docker`，或 `config.json` 的 `"deploy"` |
| 给谁用 | `config.json` 的 `features.multiUser`（控制台开关写的就是它）；环境变量 `BRIDGE_AUDIENCE=self\|shared` 只定默认值 |
| 监听地址 | 环境变量 `BRIDGE_HOST`（install.sh 写在单元里，`--lan` / `--local-only` 改的就是它） |
| Claude in Chrome | `config.json` 的 `"claudeInChrome"`，或 `BRIDGE_CLAUDE_IN_CHROME=1\|0` |

**老部署升级不变**：这套默认值只用于新生成的 `config.json`（里面带 `"defaultsVersion": 2`）。之前生成的配置照旧按老规矩：Linux / Docker 默认开多用户、一律听所有网卡，Windows 默认单人。想换成新默认值，在 `config.json` 里加 `"defaultsVersion": 2`（或直接写明 `features.multiUser`）后重启；删掉这一行就回到老规矩。老版本 install.sh 写在单元里的 `BRIDGE_EDITION=server` 仍然认（等同于打开多用户）；重跑新版脚本时单元换成 `BRIDGE_DEPLOY`，原来的多用户开关写成 `config.json` 里的显式 `features.multiUser`（已经写过的不动），照旧开着。

## 7. 更新

```bash
sudo bridgectl update                # 以服务用户拉代码、装依赖、重建前端；有新代码再重启
sudo bridgectl update --no-restart   # 只更新；再到控制台「服务控制」点「空闲时重启」
```

系统服务别直接 `sudo bash scripts/server/update.sh`（见第 4 节「权限边界」）；用户服务就是 `bridgectl update`，或在程序目录里 `bash scripts/server/update.sh`。

控制台「服务控制 → 更新」做的是同一件事（`--no-restart` 模式 + 空闲时重启）。用户服务不带 `sudo`。

代码从仓库的 origin 拉，公开仓库不需要任何凭据；换成自己的 fork 或私有远端时，服务用户要能 `git pull`（给它配一把只读的部署密钥，或用带令牌的 https 远端）。

## 8. 目录与日志

```
<数据目录>/config.json        服务端配置（令牌哈希、端口、功能开关），可手改，改完重启
<数据目录>/workspace/         管理员的工作空间（Claude 的工作目录）
<数据目录>/users/             注册用户各自的目录与账号数据
<数据目录>/dimensio/          dimensio 的会话、记忆、工作区
<数据目录>/home/              系统服务用户的 HOME（~/.claude 会话记录等；用户服务用你自己的 HOME）
<数据目录>/.bin/              服务端自己下载的 cloudflared、Claude Code 运行组件
/etc/bridge/bridge.env        系统服务的环境变量（Claude 令牌、代理；只有 root 可读）
~/.config/bridge/bridge.env   用户服务的同一个文件
```

日志：`sudo bridgectl logs`（= `journalctl -u bridge -f`；用户服务是 `journalctl --user -u bridge -f`），控制台「服务控制 → 最近日志」也能看最近几百行。

备份：停服务后打包数据目录（`sudo systemctl stop bridge && sudo tar czf bridge-data.tgz -C /var/lib/bridge .`）。换机器见 [migrate-server.md](migrate-server.md)。

## 9. 不用脚本，手动装

需要 Node.js ≥ 22.6（推荐 24）、git，以及编译 node-pty 用的 `python3 make g++`。可选：chromium（agent 浏览器）、ffmpeg、7z、ripgrep。

```bash
npm ci --omit=dev
npm --prefix harness ci --omit=dev
npm --prefix harness/web ci && npm --prefix harness/web run build
npm --prefix web ci && npm --prefix web run build
BRIDGE_DATA_ROOT=$HOME/bridge-data BRIDGE_DEPLOY=server npm start
```

首次启动在数据目录生成 `config.json`（带明文令牌）；`BRIDGE_DATA_ROOT=… node src/cli.mjs show-token` 取令牌，`… node src/cli.mjs pair` 出配对码。在前台终端里第一次启动时，服务端自己会打一张配对二维码。长期运行请交给 systemd 之类的进程管理器，并以非 root 用户运行（Claude Code 不允许 root 跑免确认会话）。

## 10. 卸载

```bash
sudo systemctl disable --now bridge
sudo rm /etc/systemd/system/bridge.service /usr/local/bin/bridgectl && sudo systemctl daemon-reload
# 数据（令牌、账号、会话）在 /var/lib/bridge，确认不要了再删；程序在 /opt/bridge
```

用户服务：`systemctl --user disable --now bridge`，删 `~/.config/systemd/user/bridge.service` 与 `~/.local/bin/bridgectl`；数据在 `~/.local/share/bridge`。

## 11. 常见问题

- **90 秒内没起来**：`sudo bridgectl logs` 看原因。常见的是端口被占（`EADDRINUSE`，`--port` 换一个）、npm 源连不上（配代理再重跑）。
- **手机在同一个 Wi-Fi 也连不上**：服务只听本机（`bridgectl access` 会写明）。`sudo bash install.sh --lan` 重跑；再确认防火墙放行了端口（`sudo ufw allow 8787/tcp`）。局域网直连是明文 http，只在自己家里的网络用。
- **用户服务一退出登录就停**：没打开 linger。`sudo loginctl enable-linger $USER`。
- **Claude 不回话**：没配认证。登录后在「设置 › Claude › 订阅号池」里加订阅令牌，或在 `bridge.env` 里写 `ANTHROPIC_API_KEY` 后重启。Claude Code 运行组件随 `npm ci` 装好；状态在「设置 › Claude」。
- **/etc 重启后不保留的沙箱机器**：重启后重跑一次本脚本即可，数据在数据目录里不受影响。
