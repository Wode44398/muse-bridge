# 把 bridge 服务端搬到新机器

适用于换机器：自己的电脑 → VPS、旧 VPS → 新 VPS、Windows → Linux 都行。服务端只有一个版本，差别只在部署配置；
搬完后手机 App 与桌面客户端照旧连同一个地址，原来那台电脑可以装桌面客户端、登录同一账号，作为一台**设备**接回来。

搬的是数据，不是程序：新机器上照常装一份服务端，再用 `scripts/server/migrate/` 里的两个脚本把老机器的数据导出、落地，
落地时把路径改成新机器的（换盘符、换目录、Windows → Linux 都能改）。

体积参考：大头通常是 Claude 会话记录 `~/.claude/projects`，用久了能到几个 GB；上传与生成的媒体另算，`--media` 才带。

## 0. 准备新机器

1. 按平台装好服务端，导入之前先别让它跑着：
   - Linux：`scripts/server/install.sh`，见 [deploy-linux.md](deploy-linux.md)。装完它会自己启动，导入前先停掉
     （系统服务 `sudo systemctl stop bridge`，用户服务 `systemctl --user stop bridge`）。
   - Docker：照 [deploy-docker.md](deploy-docker.md) 第 1 节准备好 `.env`，只 `docker compose build`，先不 `up`。
   - Windows：`scripts/server/install-windows.ps1`（开机即起、不依赖登录），见 [deploy-windows.md](deploy-windows.md)。
     装完它会自己启动，导入前在数据根建一个 `bridge-service.stop` 文件让它停下。
2. 新机器要能连上 Anthropic（以及你在用的其他服务）。所在网络连不上时，照旧配出站代理。
3. 想好工作区（`vaultPath`）在新机器上的位置。不另外指定时是 `<数据根>/workspace`：Linux 系统服务是 `/var/lib/bridge/workspace`，
   Docker 是 `/data/workspace`。系统服务的 agent 只碰得到数据目录，Docker 重建后只有数据卷 `/data` 里的东西还在，这两种就用默认位置。

## 1. 老机器：停服务、导出

先停掉老服务端，状态文件才是一致的：

| 老机器怎么跑的 | 怎么停 |
|---|---|
| Linux 系统服务（`sudo bash install.sh` 装的） | `sudo systemctl stop bridge` |
| Linux 用户服务（不带 sudo 装的） | `systemctl --user stop bridge` |
| Windows 计划任务 | 在数据根建一个 `bridge-service.stop` 文件（优雅停止），或 `Stop-ScheduledTask -TaskName BridgeServer` |
| Docker | `docker compose stop` |
| 桌面客户端的本机服务端 | 托盘「退出」，在确认框里选「退出并停止服务端」 |
| 源码直接跑（`node src/server.mjs`） | 结束那个进程 |

**导出脚本从哪读**：数据根先看 `--data-root`，没给就用环境变量 `BRIDGE_DATA_ROOT`，再没有就是脚本所在的程序目录；
`~/.claude`、`~/.codex` 先看 `--claude-home` / `--codex-home`，没给就是**运行脚本的那个用户**主目录下的。
只有「数据就在程序目录、服务用你自己的账号跑」这一种布局能直接用默认值。别的布局要么以服务的身份、带上服务的环境跑，
要么把这几个参数显式给全，不然读到的是别处，导出来是空的或缺一块。按老机器的部署方式选一种：

**Linux 系统服务**：以服务用户 `bridge`、带上它的 HOME 跑。下面写的是默认位置，装的时候用 `--data` / `--dir` 改过的换成你的；
`node` 不在 PATH 上就写 `bridge.service` 里 `ExecStart` 用的全路径。别直接用 root 跑，那样 `~/.claude` 会读成 root 的。

```bash
sudo install -d -o bridge -g bridge -m 700 /var/tmp/bridge-export
cd /opt/bridge
sudo -u bridge env HOME=/var/lib/bridge/home node scripts/server/migrate/export.mjs \
  --out /var/tmp/bridge-export --data-root /var/lib/bridge
```

**Linux 用户服务**：用你自己的账号跑：

```bash
cd ~/.local/share/bridge/app      # 程序目录；自己克隆的就是克隆的那个目录
node scripts/server/migrate/export.mjs --out ~/bridge-export --data-root ~/.local/share/bridge/data
```

**Docker**：起一个一次性容器跑导出。容器里已经是 `BRIDGE_DATA_ROOT=/data`、`HOME=/data/home`，不用另给参数；
把宿主机上的一个空目录挂进去接收结果（容器以 uid 1000 运行，目录要它写得进去）。别在宿主机上直接跑导出脚本：
宿主机上没有数据卷里的东西，导出来基本是空的。

```bash
cd <compose 所在目录>
mkdir -p "$HOME/bridge-export" && sudo chown 1000:1000 "$HOME/bridge-export"
docker compose run --rm -v "$HOME/bridge-export:/export" bridge \
  node scripts/server/migrate/export.mjs --out /export
```

**Windows 计划任务（install-windows.ps1 装的）**：用任务里的那个账号（装的时候输密码的那个），在程序目录里跑。
`--data-root` 写装的时候 `-DataRoot` 给的目录，没给过就去掉这个参数：

```powershell
cd C:\bridge
node scripts\server\migrate\export.mjs --out D:\bridge-export --data-root D:\bridge-data
```

**源码直接跑、数据就在程序目录**：在程序目录里、用跑服务端的那个账号：

```bash
node scripts/server/migrate/export.mjs --out <导出目录>
```

**桌面客户端的本机服务端**：安装包里的服务端组件只带运行所需的文件，没有 `scripts/`，数据也不在程序目录，
所以导出要借一份源码来跑，并显式给数据根：

1. 在这台电脑上取一份同版本的源码（`git clone` 后切到对应版本的 tag，或下载发布页的源码包）。导出脚本只用 Node 自带模块，
   不用 `npm install`，装有 Node 20+ 即可。
2. 在源码目录里运行（Windows PowerShell）：

   ```powershell
   node scripts/server/migrate/export.mjs --out <导出目录> --data-root "$env:LOCALAPPDATA\bridge-client\data"
   ```

   - 便携版（程序目录里有 `portable.flag`）的数据根是 `<便携版目录>\data\data`，把 `--data-root` 换成它。
   - 设过 `BRIDGE_CLIENT_HOME` 的，数据根是 `<BRIDGE_CLIENT_HOME>\data`。

各种部署通用：

- 先加 `--dry-run` 看一遍会带什么、多大。数据根不对时，脚本会提示找不到可读的 `config.json`。
- 媒体与上传（uploads、genmedia、Gemini 记录、分享空间、dimensio 工作区文件……）加 `--media` 才带。
- 以前用独立中继登记过设备的，加 `--relay-devices <中继的 devices.json>`，已登记的老客户端不用重配。
- 输出末尾会列出**有未提交改动**和**没有远端**的工作区仓库：先提交、推到远端，否则新机器上 clone 不到。

导出目录里有 `config.json`（访问令牌、Claude 账号、各家 API key）等真凭据：**当密码一样传输与保管，导入完就删**。

## 2. 传到新机器

任选：`scp -r` / `rsync -a` / `robocopy /MIR` / 打成压缩包。别走明文共享。
系统服务和 Docker 导出的目录可能只有服务用户读得了，用 `sudo` 打包或改属主之后再传。

## 3. 新机器：导入

**导入脚本落到哪**：规则和导出一样。数据根先看 `--data-root`，再看 `BRIDGE_DATA_ROOT`，最后是程序目录；
`~/.claude`、`~/.codex` 先看 `--claude-home` / `--codex-home`，再落到运行脚本的那个用户的主目录。所以同样要以服务的身份、
带上服务的环境跑，或者把参数给全。不然数据会落进程序目录和你自己的主目录，而服务读的是另一处，启动后什么都看不到；
用 root 跑还会让落地的文件归 root，服务用户读不了。

每种部署都先带 `--dry-run` 演练（看路径映射、会落地多少、哪些文件已存在不会覆盖），没问题再去掉 `--dry-run` 正式跑。

**Linux 系统服务**：

```bash
sudo systemctl stop bridge
sudo chown -R bridge:bridge /var/tmp/bridge-export    # 传过来的导出目录，服务用户要读得到
cd /opt/bridge
sudo -u bridge env HOME=/var/lib/bridge/home node scripts/server/migrate/import.mjs \
  --from /var/tmp/bridge-export --vault /var/lib/bridge/workspace --data-root /var/lib/bridge --dry-run
# 演练没问题：去掉 --dry-run、加 --force 再跑一遍，然后 sudo systemctl start bridge
```

install.sh 装的时候已经生成过 `config.json`。要沿用老机器的令牌、账号与各家 key，正式导入时加 `--force`（见下面「落地只增不删」）。

**Linux 用户服务**：

```bash
systemctl --user stop bridge
cd ~/.local/share/bridge/app
node scripts/server/migrate/import.mjs --from ~/bridge-export --vault <工作区> \
  --data-root ~/.local/share/bridge/data --dry-run
# 演练没问题：去掉 --dry-run、加 --force 再跑一遍，然后 systemctl --user start bridge
```

**Docker**：同样起一个一次性容器。`--vault` 写容器里的路径，而且要在数据卷 `/data` 里面（默认 `/data/workspace`），
放在卷外的话，重建容器就没了。

```bash
cd <compose 所在目录>
sudo chown -R 1000:1000 "$HOME/bridge-export"         # 容器以 uid 1000 运行
docker compose run --rm -v "$HOME/bridge-export:/export" bridge \
  node scripts/server/migrate/import.mjs --from /export --vault /data/workspace --dry-run
# 演练没问题：去掉 --dry-run 再跑一遍，然后 docker compose up -d
```

这个卷已经 `up` 过、生成过 `config.json` 的，正式导入时也要加 `--force`。

**Windows 计划任务**：用任务里的那个账号，在程序目录里跑：

```powershell
New-Item -ItemType File D:\bridge-data\bridge-service.stop     # 先让服务停下
cd C:\bridge
node scripts\server\migrate\import.mjs --from D:\bridge-export --vault D:\bridge-data\workspace --data-root D:\bridge-data --dry-run
# 演练没问题：去掉 --dry-run、加 --force 再跑一遍，然后 Start-ScheduledTask -TaskName BridgeServer
```

**源码直接跑、数据就在程序目录**：在程序目录里、用跑服务端的那个账号：

```bash
node scripts/server/migrate/import.mjs --from <导出目录> --vault <工作区> --dry-run
```

导入的规则：

- 默认映射：老数据根 → 这台的数据根，老 `usersRoot` → `<数据根>/users`（`--users-root` 改），老 `vaultPath` → `--vault`，
  老 `~/.claude` / `~/.codex` → 这台的，老用户主目录 → 这台运行脚本的用户的主目录。别的位置用 `--map 旧前缀=新前缀` 补。
- 落地只增不删，已有文件不覆盖。`config.json` 若是安装或首次启动生成的那份，加 `--force` 用老的（令牌、账号、各家 key 都沿用），
  或手动把需要的字段合过去。
- 改写：状态文件与会话记录里「整串就是路径」的值按映射改；Claude 会话目录按新路径换名，续聊照常。
  句子中间夹带的路径（工具输出、命令）不改，只影响显示。
- 结尾会提示 `config.json` 里指向不存在路径的项（例如只在 Windows 上有的可执行文件路径）——在新机器上改掉或删掉。
- 老机器是 Windows 时：扩展中心的连接器凭据和自定义 API 服务的密钥，是用那台机器上的 Windows 账户加密的（DPAPI），
  换了机器就解不开，到新机器上重新填一遍。

## 4. 工作区

导入输出末尾有每个仓库的 `git clone` 命令，照着拉到 `--vault` 下。没有远端的仓库手动拷过去。
系统服务与 Docker 下要以服务的身份 clone（同上一节的 `sudo -u bridge …` / `docker compose run …`），文件属主才对。

## 5. 地址与隧道

- **地址不变，手机和客户端就不用改**：用自己域名的，把域名指到新机器（命名隧道在新机器上装连接器、老机器上停掉；
  反向代理改上游地址）。在控制台「服务控制 › 公网访问」里配隧道最省事。
- 临时地址（trycloudflare）每次重启都会变：已连上的 App 会自己跟上新地址；离线的 App 回到和服务端同一个局域网时也能找回来。
- 用了端口转发与预览子域（`pvPublicDomain`）的，把那个通配子域同样指到新机器。

## 6. 桌面客户端的发版目录（只有自己发客户端的才需要）

服务端从 `config.json` 的 `clientDist`（默认 `<数据根>/client-dist`）读 `latest.json` 与安装包，发给设备做在线更新；
没有这个目录时，设备按公开发布清单更新。自己出包的，把安装包与 `latest.json` 放进去即可，不用重启。

## 7. 验收

- 手机：会话列表齐、能续聊老会话、Routines 在跑、分享链接能开。
- 控制台 › 设备：迁过来的设备都在；老电脑装上桌面客户端、登录后出现在列表里并在线。
- 在会话里让 Claude 看一眼那台电脑的屏幕（输入框上方的电脑芯片选它），终端面板切到「我的电脑」能开终端。

## 8. 老机器退役

1. 去掉老机器上的服务端启动方式：`sudo systemctl disable --now bridge`（用户服务 `systemctl --user disable --now bridge`）；
   Windows 上删掉 `BridgeServer` 计划任务（`Unregister-ScheduledTask BridgeServer`）；Docker `docker compose down`；
   桌面客户端的本机服务端：退出并停止服务端，再在设置 › 通用里关掉开机自启。
2. 要把它当设备接回来：装桌面客户端，首次打开填新服务端的地址，登录同一账号。
3. 确认新服务端稳定运行一段时间后，再清理老机器上的数据目录。
