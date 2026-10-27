#!/usr/bin/env bash
# The Bridge 服务端更新（配合 install.sh 装的 systemd 形态）：拉最新代码 → 装依赖 → 重建前端 → 重启服务。
#
#   sudo bridgectl update                           系统服务（推荐）：以服务用户跑本脚本的 --no-restart 模式，有新代码再由
#                                                   root 重启（在跑的对话会被打断，记录保留）
#   sudo bridgectl update --no-restart              只更新，不重启：再到控制台「服务控制」点「空闲时重启」，
#                                                   等所有人的对话跑完再换新代码
#   bash scripts/server/update.sh [--no-restart]    用户服务（不带 sudo 装的）：同上，重启走 systemctl --user
#   sudo bash scripts/server/update.sh [--no-restart]  老办法，仍然可用；但本脚本在程序目录里、归服务用户（agent 就以它的
#                                                   身份跑、改得动它），以 root 执行它等于让服务用户的改动拿到 root——
#                                                   系统服务请用 sudo bridgectl update（root 不执行程序目录里的代码）
#
# 代码从仓库的 origin 拉（公开仓库不用任何凭据）。自己的 fork / 私有远端：服务用户要能 git pull
# （给它配一把只读的部署密钥：~bridge/.ssh/，或用带令牌的 https 远端）。
# 控制台「服务控制 → 更新」以服务用户的身份调本脚本的 --no-restart 模式，看最后一行 BRIDGE_UPDATE_RESULT。
set -euo pipefail

RESTART=1
[ "${1:-}" = "--no-restart" ] && RESTART=0

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCTL=(systemctl)
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
  # 不是 root：要么是服务用户自己（控制台「服务控制 → 更新」就是这样调的，代码本来就归它，环境里已有代理），
  # 要么是用户服务（install.sh 不带 sudo 装的）的主人在终端里跑。
  as_svc() { "$@"; }
  SVC_USER="$(id -un)"
  if [ -n "${BRIDGE_SUPERVISED:-}" ]; then
    # 在服务进程里被调起（单元里写着 BRIDGE_SUPERVISED，子进程继承）：不该自己重启，重启交给控制台的「空闲时重启」
    RESTART=0
  elif systemctl --user cat bridge.service >/dev/null 2>&1; then
    SCTL=(systemctl --user)
  else
    RESTART=0
  fi
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
as_svc npm --prefix harness ci --omit=dev --no-audit --no-fund
as_svc npm --prefix harness/web ci --no-audit --no-fund
as_svc npm --prefix web ci --no-audit --no-fund
as_svc npm --prefix harness/web run build
as_svc npm --prefix web run build

echo "==> 现在是 $(as_svc git log -1 --format='%h %s')"
if [ "$RESTART" = 1 ]; then
  "${SCTL[@]}" restart bridge.service
  echo "已重启：${SCTL[*]} status bridge"
else
  echo "没有重启：到控制台「服务控制」点「空闲时重启」（或 ${SCTL[*]} restart bridge）"
fi
echo "BRIDGE_UPDATE_RESULT=updated $after"
