#!/bin/bash
# 开机 / /etc 被平台还原之后的自愈，可以随时重复跑（看门狗每分钟调一次，bootstrap 收尾也调一次）。
# Muse VM 重启时，平台只重写它自己管的 /etc 文件；它不认识的东西（我们的 systemd 单元、/etc/bridge/）会丢。
# 这里把它们从持久目录 bridge-ops/ 补回来，再把没在跑的服务拉起。
# 注意：bridge 账号由平台重写 /etc/passwd 时保留，但开机后不会马上写好（实测往往要等 Muse 下一次干活）。
# 服务全靠这个账号运行（没有它 systemd 报 217/USER，连数字 UID 都不认），所以不等平台：按数据目录属主当场补建。
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

# 管理员令牌的明文暂存（bootstrap.sh 结果块用）：用户用它登录成功（出现了比它新的管理员会话）就删掉
P="$OPS/admin-token.pending"; S="$DATA/users/_system/sessions.json"
if [ -f "$P" ] && [ -f "$S" ] && command -v jq >/dev/null; then
  since=$(( $(stat -c %Y "$P") * 1000 ))
  if jq -e --argjson t "$since" '[.[] | select(.admin == true and (.created // 0) >= $t)] | length > 0' "$S" >/dev/null 2>&1; then
    rm -f "$P"
  fi
fi

# bridge 账号不在：按数据目录的属主 UID/GID 当场补建。跟平台之后写回的是同一个 UID，不冲突；
# 数据目录属主是 root（推不出原来的 UID）或还没有数据目录（第一次安装前）就不动，交给平台 / install.sh
if ! getent passwd "$SVC_USER" >/dev/null 2>&1 && [ -d "$DATA" ]; then
  uid="$(stat -c %u "$DATA")"; gid="$(stat -c %g "$DATA")"
  if [ "$uid" != 0 ] && [ "$gid" != 0 ]; then
    getent group "$SVC_USER" >/dev/null 2>&1 || groupadd --system -g "$gid" "$SVC_USER" 2>/dev/null || true
    useradd --system -u "$uid" -g "$gid" --home-dir "$DATA/home" --shell /bin/bash "$SVC_USER" 2>/dev/null \
      && echo "已按数据目录属主补回 $SVC_USER 账号（uid $uid / gid $gid）"
  fi
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
