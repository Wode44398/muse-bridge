#!/usr/bin/env bash
# Muse Bridge 服务端更新（配合 install.sh 装的 systemd 形态）：拉最新代码 → 装依赖 → 重建前端 → 重启服务。
#
#   sudo bash scripts/server/update.sh              更新完立即重启（在跑的对话会被打断，记录保留）
#   sudo bash scripts/server/update.sh --no-restart 只更新，不重启：再到控制台「服务控制」点「空闲时重启」，
#                                                   等所有人的对话跑完再换新代码
#
# 适用于 git clone 部署的普通 Linux 服务器（Muse VM 上用 deploy/muse/bootstrap.sh update）。
set -euo pipefail

RESTART=1
[ "${1:-}" = "--no-restart" ] && RESTART=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$(id -u)" = 0 ]; then
  SVC_USER="$(systemctl show -p User --value bridge.service 2>/dev/null || true)"
  SVC_USER="${SVC_USER:-bridge}"
  SVC_HOME="$(getent passwd "$SVC_USER" | cut -d: -f6)"
  # 服务环境里的代理（出站只能走代理的机器）顺带给 git / npm 用
  PROXY_ENV=()
  if [ -f /etc/bridge/bridge.env ]; then
    while IFS= read -r line; do
      case "$line" in HTTPS_PROXY=*|HTTP_PROXY=*|NO_PROXY=*|https_proxy=*|http_proxy=*|no_proxy=*) PROXY_ENV+=("$line") ;; esac
    done < /etc/bridge/bridge.env
  fi
  as_svc() { runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" "${PROXY_ENV[@]}" "$@"; }
else
  # 服务用户自己跑（控制台「服务控制 → 更新」就是这样调的）：代码本来就归它，环境里已有代理；
  # 没有权限 systemctl，重启交给控制台的「空闲时重启」。
  as_svc() { "$@"; }
  RESTART=0
fi

cd "$REPO"
before="$(as_svc git rev-parse HEAD)"
echo "==> git pull（$SVC_USER）"
as_svc git pull --ff-only
after="$(as_svc git rev-parse HEAD)"
if [ "$before" = "$after" ]; then
  echo "已经是最新（$(as_svc git log -1 --format='%h %s')）"
  # 最后一行给控制台看（「服务控制 → 更新」据此决定要不要接着重启）
  [ "$RESTART" = 1 ] || { echo "BRIDGE_UPDATE_RESULT=unchanged $after"; exit 0; }
fi

echo "==> 依赖与前端"
as_svc npm ci --omit=dev --no-audit --no-fund
as_svc npm --prefix harness/web ci --no-audit --no-fund
# dimensio 的运行依赖只在装过时更新（没选 dimensio 的部署里没有 harness/node_modules）
if [ -d harness/node_modules ]; then
  as_svc npm --prefix harness ci --omit=dev --no-audit --no-fund
  as_svc npm --prefix harness/web run build
fi
as_svc npm --prefix web ci --no-audit --no-fund
as_svc npm --prefix web run build

echo "==> 现在是 $(as_svc git log -1 --format='%h %s')"
if [ "$RESTART" = 1 ]; then
  systemctl restart bridge.service
  echo "已重启：systemctl status bridge · journalctl -u bridge -f"
else
  echo "没有重启：到控制台「服务控制」点「空闲时重启」（或 systemctl restart bridge）"
fi
echo "BRIDGE_UPDATE_RESULT=updated $after"
