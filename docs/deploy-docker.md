# 用 Docker 部署 bridge 服务端

适用于任何装得了 Docker 的 Linux 服务器（x86_64 或 arm64，建议 2 核 4G 以上），也适合 Debian / Ubuntu 以外的发行版。没有 Docker、想装成 systemd 服务的见 [deploy-linux.md](deploy-linux.md)。

需要：[Docker Engine](https://docs.docker.com/engine/install/) 与 Compose 插件。所有可变数据都在一个卷（`bridge-data`）里，镜像随时可以重建替换。

## 1. 安装

```bash
git clone https://github.com/Wode44398/claude-bridge.git bridge && cd bridge
cp .env.example .env
nano .env                    # 至少看一眼第 0 段「给谁用」；Claude 认证也可以装好后在设置里加
docker compose up -d --build
docker compose exec bridge node src/cli.mjs pair --wait
```

第一次构建要几分钟。最后一条命令等服务端起来（新数据卷第一次启动要先生成 `config.json`，它会一并等），然后在终端里出一张**配对二维码**：手机 App 首屏点「扫码连接」扫它，就以管理员身份连上（没装 App 用系统相机扫，直接在浏览器里打开）。码 3 分钟内有效、只能用一次，过期了再跑一遍。码里的地址手机连不上时（默认的 `.env` 就是这样，见下面「二维码里的地址」），它打出票面和改法就退出，不占着终端干等。

其它常用命令（都在 `bridge` 目录里跑）：

```bash
docker compose exec bridge node src/cli.mjs access       # 访问地址、给谁用、令牌与配对的取法
docker compose exec bridge node src/cli.mjs show-token   # 访问令牌（网页「用访问令牌登录」填它；它就是管理员身份，别外传）
docker compose logs -f bridge                            # 日志：无界面服务端会在启动日志里写明怎么连
```

浏览器：服务默认只开在服务器本机 `http://127.0.0.1:8787`。从自己电脑上用 `ssh -L 8787:127.0.0.1:8787 你的服务器` 转过来再打开，或者先开公网访问（第 4 节）。

**二维码里的地址**：容器里的服务端看不到宿主机的局域网地址，也不知道你映射到了宿主机的哪个端口。没开公网访问、也没填 `BRIDGE_PUBLIC_ORIGIN` 时，码里只能写 `http://127.0.0.1:8787`，手机扫了打不开（终端会提示「手机连不上」）。两种办法：先开公网访问（第 4 节），或者家里同一个 Wi-Fi 直连——`.env` 里 `BRIDGE_BIND=0.0.0.0`，`docker compose up -d` 后出码时告诉它宿主机的局域网地址：

```bash
docker compose exec bridge node src/cli.mjs pair --origin=http://192.168.1.10:8787   # 换成这台机器的局域网 IP 与 BRIDGE_PUBLISH_PORT
```

另有别的路能连上（比如已经用自己的反向代理对外，只是没告诉服务端）：`--origin=https://<你的域名>` 把那个地址写进码里；或者加 `--force-wait`，码照出、照样等手机。

## 2. .env 里的选择

| 段 | 变量 | 说明 |
|---|---|---|
| 0 给谁用 | `BRIDGE_AUDIENCE` | 留空（或 `self`）= 只给我自己（默认）：只有管理员与配对过的设备能登录，注册与邀请码关着。`shared` = 也给别人用：打开注册与邀请码，给家人朋友各开账号，各自的数据互相看不到，共用你配的 Claude 认证与额度。只管默认值，之后以控制台「开放给其他人使用」的开关为准；留空时已有的老数据卷照旧按老规矩（第 6 节） |
| 1 Claude 认证 | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | 二选一，也可以留空、登录后在「设置 › Claude › 订阅号池」里加。订阅令牌在任意装了 Claude Code 的电脑上 `claude setup-token` 生成。使用者需自行遵守所用服务的条款 |
| 2 对外访问 | `BRIDGE_BIND` / `BRIDGE_PUBLISH_PORT` | 宿主机上监听的地址与端口，默认 `127.0.0.1:8787`。改成 `0.0.0.0` 同一个 Wi-Fi 的手机能直连（明文 http，只在自己的网络里用，记得看防火墙） |
| | `BRIDGE_PUBLIC_ORIGIN` | 你的公网地址（如 `https://bridge.example.com`），分享链接与配对二维码用它 |
| | `TUNNEL_TOKEN` | Cloudflare 隧道侧车容器用（第 4 节） |
| 3–4 可选功能 | dimensio 厂商 key、Vertex | 留空就是不开 |
| 构建 | `WITH_OFFICE` | `1` = 装 LibreOffice，Office 文档能在线预览（镜像约大 600MB） |
| | `WITH_CLAUDE_CLI` | 见第 3 节 |

改完 `.env` 运行 `docker compose up -d` 生效（构建选项要加 `--build`）。

## 3. Claude Code 运行组件

镜像默认**不预装** Claude Code 运行组件（Anthropic 的专有二进制，约 250MB，公开发布的镜像不带它）。服务端第一次启动时从官方 npm 源下载到数据卷 `/data/.bin/claude-code`，按 SDK 自带的 sha256 校验，只下一次；官方源慢时自动换到 npmmirror，进度在「设置 › Claude」里看。

- 服务器连不上 npm 源：`.env` 里设 `WITH_CLAUDE_CLI=1` 后 `docker compose up -d --build`，构建时就把它留在镜像里（自己构建、自己用）。
- 关掉自动下载：`config.json` 里 `"claudeCliDownload": false`，再用 `"claudeCliPath"` 指向你放进卷里的二进制。

## 4. 从外网访问

三选一（同一条隧道别两边同时开）：

- **控制台「服务控制 → 公网访问」（推荐）**：用令牌登录后打开「设置 › 服务端 › 服务控制」，选临时地址（trycloudflare，免注册，每次重启会换）、Cloudflare 命名隧道（地址固定；Public Hostname 的服务填 `http://localhost:8787`）或自己的域名。服务端在容器里自己托管 cloudflared。
- **Cloudflare Tunnel 侧车容器**：Cloudflare 控制台 Zero Trust → Networks → Tunnels 新建隧道，Public Hostname 的服务填 `http://bridge:8787`；`.env` 里填 `TUNNEL_TOKEN` 与 `BRIDGE_PUBLIC_ORIGIN`，然后 `docker compose --profile tunnel up -d`。
- **自己的反向代理**（Caddy / Nginx）转发到 `127.0.0.1:8787`：保留原始 `Host` 头、支持长连接（对话是 SSE 流；Nginx 要 `proxy_buffering off;`）。细节见 README「从外网访问」。

## 5. 给朋友开账号

先把「给谁用」切到「也给别人用」（新卷：`.env` 里 `BRIDGE_AUDIENCE=shared` 后 `docker compose up -d`；已有的卷：控制台里打开「开放给其他人使用」），然后：

```bash
docker compose exec bridge node src/cli.mjs invite      # 一次性普通档邀请码（默认 7 天有效），对方在登录页选「注册」填它
docker compose exec bridge node src/cli.mjs users       # 已有账号与未用的邀请码
```

也可以在控制台「用户」页发邀请码、直接建号、按人定额度。邀请与账号管理的命令只能在服务器本机执行。

普通档没有命令行，只能在自己的目录里读写。「完全信任」档有命令行、终端和浏览器，等同管理员——能读到服务器上所有人的对话、文件和全部凭据，只发给你完全信任的人：`… invite full --ack`（`--ack` 表示你知道这一点）。

## 6. 部署形态与老数据卷

镜像写死 `BRIDGE_DEPLOY=docker`（`src/config/deploy-profile.mjs`）：容器里听所有网卡（对外由端口映射决定）、不带 Claude in Chrome、不做保持唤醒，启动日志打印怎么连。

已有数据卷升级**不改行为**：卷里的 `config.json` 是这一版之前生成的（没有 `"defaultsVersion": 2`），照旧按老规矩——多用户默认开着。想换成新默认值（只给我自己），在 `config.json` 里写明 `"features": { "multiUser": false }`，或加 `"defaultsVersion": 2`，然后 `docker compose restart bridge`。

## 7. 日常维护

```bash
# 更新
git pull && docker compose up -d --build

# 备份：所有数据都在 bridge-data 这个卷里（配置、令牌、账号、会话、文件）
docker run --rm -v bridge_bridge-data:/data -v "$PWD":/backup busybox tar czf /backup/bridge-data.tgz -C /data .

# 换访问令牌（旧令牌立即失效，管理员登录全部下线）
docker compose exec bridge node src/cli.mjs token && docker compose restart bridge
```

数据卷里的布局：

```
/data/config.json        服务端配置（含访问令牌），可手改，改完重启
/data/workspace/         管理员的工作空间（Claude 的工作目录）
/data/users/             注册用户各自的目录与账号数据
/data/dimensio/          dimensio 的会话、记忆、工作区
/data/home/              容器用户的 HOME（~/.claude 会话记录等）
/data/.bin/              服务端下载的 Claude Code 运行组件、cloudflared
/data/uploads, media/    上传与生成的媒体
```

## 8. 常见问题

- **agent 的浏览器报「No usable sandbox」**：compose 文件已经挂上 `docker/seccomp-chromium.json`（Docker 官方默认规则 + 只多放行 `clone` / `unshare` / `setns`），别改成 `--no-sandbox`。Ubuntu 23.10+ 的宿主机若用 AppArmor 限制了非特权用户命名空间，可能仍会失败。
- **8787 被占用**：`.env` 里 `BRIDGE_PUBLISH_PORT=18787`。
- **改了 .env 没生效**：要 `docker compose up -d`（不是 `restart`）才会重新读环境变量。
- 以下功能依赖桌面系统，在容器里不可用：手机操控、本机 / 远程桌面操控、dimensio 的「本机模型」、删除进回收站。
