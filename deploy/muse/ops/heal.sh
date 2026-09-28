#!/bin/bash
# 开机 / /etc 被平台还原之后的自愈，可以随时重复跑（看门狗每分钟调一次，bootstrap 收尾也调一次）。
# Muse VM 重启时，平台只重写它自己管的 /etc 文件；它不认识的东西（我们的 systemd 单元、/etc/bridge/）会丢。
# 这里把它们从持久目录 bridge-ops/ 补回来，再把没在跑的服务拉起。
# 注意：bridge 账号由平台重写 /etc/passwd 时保留，但开机后约 3 分钟才写好——那之前 start 会失败，下一轮再试。
set -u
. "$(dirname "$(readlink -f "$0")")/muse.env"

restored=0
for s in $SERVICES; do
  if [ ! -f "/etc/systemd/system/$s.service" ] && [ -f "$OPS/systemd/$s.service" ]; then
    cp "$OPS/systemd/$s.service" "/etc/systemd/system/$s.service" && restored=1
  fi
done
if [ "$restored" = 1 ]; then
  systemctl daemon-reload
  for s in $SERVICES; do systemctl enable "$s.service" >/dev/null 2>&1 || true; done
  echo "已从 $OPS/systemd 补回服务单元"
fi

# /etc/bridge/bridge.env（含 Claude 令牌与代理）双向同步：在就备份到持久副本，丢了就从副本恢复
if [ -f /etc/bridge/bridge.env ]; then
  cmp -s /etc/bridge/bridge.env "$OPS/bridge.env" 2>/dev/null || install -m 0600 /etc/bridge/bridge.env "$OPS/bridge.env"
elif [ -f "$OPS/bridge.env" ]; then
  install -d -m 0750 /etc/bridge
  install -m 0600 "$OPS/bridge.env" /etc/bridge/bridge.env
  echo "已从 $OPS/bridge.env 恢复 /etc/bridge/bridge.env"
fi

# 服务用户要能穿过持久目录，否则 bridge.service 报 status=200/CHDIR
[ $(( 8#$(stat -c %a "$PERSIST") & 8#001 )) -ne 0 ] || chmod o+x "$PERSIST"

for s in $SERVICES; do
  if ! systemctl is-active --quiet "$s.service"; then
    systemctl reset-failed "$s.service" 2>/dev/null || true   # 撞过启动上限的会被锁成 failed，不清掉就起不来
    systemctl start "$s.service" 2>/dev/null || true
  fi
done
exit 0
