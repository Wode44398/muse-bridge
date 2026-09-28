# Muse VM 平台笔记（给维护者）

这些是 Muse agent VM 上实测过的行为，`bootstrap.sh` 的每一个绕行都源自这里。平台随时可能调整，改脚本前先在真机上复核。

## 画像

| 项 | 情况 |
|---|---|
| 系统 | Ubuntu 24.04，2 核，约 8G 内存 |
| 入站 | 没有公网 IP，只能反向建隧道 |
| 出站 | 只能走 `hatch-egress-proxy:3128`（HTTP CONNECT，不需要认证，端口不限，7844 也能过）；直连会被透明代理截住 |
| 权限 | 命令以 root 跑，但没有 NET_ADMIN，也没有 SYS_PTRACE（看得见别的用户的进程，却读不了它的 `/proc/<pid>/cwd`）；`/etc/hosts` 是 squashfs 只读挂载 |
| 容器 | Docker 起不来：runc 报 `unable to join session keyring: operation not permitted`，无解 |
| 浏览器 | Ubuntu 的 chromium 是 snap 空壳；平台自带的 Chrome 报 `No usable sandbox!`（`kernel.apparmor_restrict_unprivileged_userns=1`，容器里改不了） |
| DNS | 查不了 SRV 记录（`server misbehaving`） |

## 持久性与重启

- 只有 `/home/hatch`（btrfs）持久。`/` 是 overlay。
- 平台大约每 6–15 小时整机重启一次（关机后全新启动，不是挂起）；闲置本身不会让 VM 停机。
- 重启时平台重写它自己管的 `/etc` 文件：`/etc/passwd`、`/etc/group`（保留我们建的 `bridge` 账号，但开机后不会马上写好：观察到的几次都要等好几分钟，而且都是在有人找 Muse 之后一分钟内才出现。服务全靠这个账号，所以 `heal.sh` 不等它，按数据目录的属主当场补建同一个 UID；千万别用新 UID 建，数据目录会读不了）、`/etc/apt/sources.list.d/ubuntu.sources`（被还原）。
- 平台不认识的 `/etc` 文件会丢：我们的 systemd 单元、整个 `/etc/bridge/`。
- `/usr` 下装的包（node、cloudflared、socat）实测重启后还在，但机制不明，脚本按「可能丢」处理，所有安装步骤都要幂等。
- `/var/log/journal` 与 wtmp 也在 overlay 上，重启即清空。
- VM 上没有 cron，也没有用户级 systemd；开机自愈只能靠 Muse 平台的 hook（每 60 秒在 VM 上跑一次脚本）。hook 只能由 Muse 在对话里用它的 hooks 工具注册，脚本注册不了。

## 各个坑与对策

| 坑 | 对策（在哪） |
|---|---|
| apt 源里的 `mirror.cogentco.com` 经代理不通，apt 会卡半小时，而且每次开机被还原 | 每次 install 先探测每个镜像，删掉不通的，并给 apt 加超时（`bootstrap.sh` `fix_apt_sources`） |
| cloudflared 是静态二进制，不读 `HTTPS_PROXY`，直连报 `tls: first record does not look like a TLS handshake` | 两条 socat 中继经代理 CONNECT：`127.0.0.1:443 → api.trycloudflare.com:443`、`127.0.0.1:7844 → region1.v2.argotunnel.com:7844`（`ops/systemd/cf-relay-*.service`） |
| `/etc/hosts` 只读，没法把 cloudflare 域名指到本机中继 | `unshare --mount` 开私有挂载命名空间，bind 一份自建 hosts 盖上去，再 `setpriv` 降权跑 cloudflared（`ops/cf-wrap.sh`） |
| 查不了 edge 的 SRV 记录 | `--edge region1.v2.argotunnel.com:7844` 直接指定，`--protocol http2` 走 TCP |
| 快速隧道的地址每次重启都变 | 看门狗发现新地址能通就唤醒 Muse 通知用户；想要固定地址就换命名隧道（`set-domain`） |
| 重启后单元、`/etc/bridge/bridge.env` 丢失；`/home/hatch` 偶尔丢 o+x（服务报 `status=200/CHDIR`） | 规范副本放 `bridge-ops/`，`ops/heal.sh` 每分钟补回（看门狗 hook 调用） |
| 在 VM 上跑 `claude setup-token`：喂 code 后卡死；token 端点对出口 IP 限流（429，近一小时），拿假 code 试探也算次数 | Claude 令牌只在用户自己的电脑上生成；说明书里写成硬规矩 |
| npm audit 阶段经代理容易 `socket hang up` | `npm ci --no-audit --no-fund` |
| cloudflared 一直报 `Failed to refresh DNS local resolver … unable to parse IP` | 无害噪音，不用管 |
| root 没有 SYS_PTRACE，读不出 bridge 进程跑在哪个版本目录；只靠 `/proc/<pid>/cwd` 的话「运行版本」永远是「未运行」，空闲切换、失败回退、`rollback` 全部失灵 | 单元加一行 `ExecStartPre=+…`，每次启动记下「InvocationID + 当时 current 指向的目录」到 `bridge-ops/running-dir`；读的时候 ID 对得上才采信（`bootstrap.sh` / 看门狗的 `running_dir`） |

## 本地模拟

`bootstrap.sh` 靠 `/etc/hosts` 里有没有 `hatch-egress-proxy` 判断是不是 Muse VM。本地可以用一个带 systemd 的 Ubuntu 24.04 容器，加一条 `127.0.0.1 hatch-egress-proxy`，在 3128 起一个只放行 CONNECT 的代理，再把 `/home/hatch` 建出来，就能把 `install` 完整跑一遍（隧道会是真的 trycloudflare 地址）。
