# 本地模拟 Muse VM（给维护者）

在装了 Docker 的机器上，用一个带 systemd 的 Ubuntu 24.04 容器模拟 Muse VM：只能经 `hatch-egress-proxy:3128` 出站，
然后把 `bootstrap.sh install` 完整跑一遍。平台行为的来龙去脉见 `../NOTES.md`。

```bash
docker run -d --name mb-muse --hostname htch-runtime --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock jrei/systemd-ubuntu:24.04
docker exec mb-muse bash -c 'apt-get update && apt-get install -y curl ca-certificates iptables python3'
docker cp deploy/muse/test/fake_egress_proxy.py mb-muse:/opt/
docker exec mb-muse bash -c '
  useradd --system egressproxy
  cat > /etc/systemd/system/fake-egress.service <<UNIT
[Service]
User=egressproxy
ExecStart=/usr/bin/python3 /opt/fake_egress_proxy.py 3128
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload && systemctl enable --now fake-egress
  echo "127.0.0.1 hatch-egress-proxy" >> /etc/hosts
  mkdir -p /home/hatch && chmod 771 /home/hatch
  # 只放行代理进程自己的出站 + 回环 + DNS，别的直连一律挡掉（跟 Muse 一样）
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m owner --uid-owner $(id -u egressproxy) -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -j REJECT'
```

然后把 `git archive --prefix=bridge/ HEAD` 打的包解到容器的 `/home/hatch/bridge-releases/<时间戳>/`，
按 `MUSE.md` 第 2 节执行 `bootstrap.sh install`。
**Muse 的 root 没有 SYS_PTRACE**，容器里的 root 有：要照真机测，命令前面加 `setpriv --bounding-set=-sys_ptrace`（看门狗同理），否则「运行版本」这类读 `/proc/<pid>/cwd` 的逻辑在本地永远是好的、到了真机才坏。

看门狗 hook 可以用一个假的运行时手动跑：

```bash
printf 'log(){ echo "[log] $*"; }\nsilent(){ echo "[silent] $*"; }\nwake(){ echo "[WAKE] $*"; }\n' > /tmp/hook-runtime.sh
HATCH_HOOK_RUNTIME=/tmp/hook-runtime.sh HOME=/home/hatch bash /home/hatch/hooks/scripts/bridge-watchdog.sh
```

模拟 VM 重启：停掉四个服务，删掉 `/etc/systemd/system/{bridge,muse-tunnel,cf-relay-api,cf-relay-edge}.service` 和 `/etc/bridge/`，
再每隔一分钟跑一次看门狗，应该依次看到「还在恢复中」→「公网地址变了」→「全部正常」，隧道只启动一次。

模拟平台晚写回账号（真机上实测 3–7 分钟）：先把 `/etc/{passwd,group,shadow,gshadow}` 里 `bridge:` 那一行存起来再删掉。
这时看门狗应该只报 `[silent] 还在恢复中`（不 wake）；`bootstrap.sh install` 应该打印「先等它」并一直等，把那几行写回去之后接着装完，
账号的 UID 跟数据目录的属主一致（不能自己 `useradd` 出一个新 UID）。

`install` / `update` / `set-agents` 会自己转后台：前台最多等 4 分半，只打印 `==>` 步骤；没装完就 `bootstrap.sh wait` 接着等，
第二次 wait 不重复打印已经打过的步骤。结果块里的管理员令牌在用它登录一次（`POST /api/login`）后，下一分钟看门狗跑完就不再显示。
