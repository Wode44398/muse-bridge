#!/usr/bin/env bash
# Muse Bridge 服务端安装（Linux + systemd，Debian / Ubuntu）。
# 在 Muse 的 VM 上请用 deploy/muse/bootstrap.sh（它会处理代理、隧道、重启自愈，再调用本脚本）；
# 普通 Linux 服务器可以直接用本脚本。
#
#   sudo bash scripts/server/install.sh [选项]
#
# 做的事（可以重复执行：已有的数据、令牌、账号一概不动，只补齐依赖、重建前端、刷新服务单元）：
#   1. 装系统依赖与 Node 24（缺才装）
#   2. 建系统用户 bridge，数据目录 /var/lib/bridge（config.json、账号、工作空间、Claude 会话都在这里）
#   3. 以服务用户装 npm 依赖、构建前端
#   4. 第一次安装时生成访问令牌：config.json 只存它的哈希，明文只在这里显示一次——请当场存好
#   5. 写 systemd 单元 bridge.service（Restart=always：控制台「服务控制 → 重启」靠它拉起）并启动
#
# 选项：
#   --agents LIST       要启用的 agent：claude / dimensio / claude,dimensio（默认 claude,dimensio）。
#                       没选 dimensio 就不装它的运行依赖（省时间和磁盘；以后可以重跑本脚本加上）
#   --solo              只自己用：关掉注册和邀请码（只有管理员令牌能登录）
#   --multi             多人用：打开注册和邀请码（默认）
#   --port N            监听端口（默认 8787）
#   --public            监听 0.0.0.0（默认只听 127.0.0.1：对外请走隧道或反代，别把明文端口直接暴露到公网）
#   --data DIR          数据目录（默认 /var/lib/bridge）
#   --user NAME         运行服务的系统用户（默认 bridge）
#   --claude-token T    Claude 订阅令牌（claude setup-token 生成）；也可以之后写进 /etc/bridge/bridge.env 再重启
#   --tunnel-token T    Cloudflare 命名隧道的令牌：顺带装 cloudflared、起 bridge-tunnel.service（出站能直连的机器用）
#   --no-restart        只装依赖、构建、写单元，不重启正在跑的服务（由调用方决定什么时候切换，比如等空闲）
#
# 出站只能走代理的机器：先 export HTTPS_PROXY=http://代理:端口 再跑，脚本会把代理带进服务环境。
set -euo pipefail

PORT=8787
HOST=127.0.0.1
DATA=/var/lib/bridge
SVC_USER=bridge
AGENTS=""
USERS_MODE=""
CLAUDE_TOKEN=""
TUNNEL_TOKEN=""
RESTART=1

while [ $# -gt 0 ]; do
  case "$1" in
    --agents) AGENTS="$2"; shift 2 ;;
    --solo) USERS_MODE=solo; shift ;;
    --multi) USERS_MODE=multi; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --public) HOST=0.0.0.0; shift ;;
    --data) DATA="$2"; shift 2 ;;
    --user) SVC_USER="$2"; shift 2 ;;
    --no-browser) shift ;;   # 旧选项：本产品不装浏览器，留着只为兼容旧命令
    --claude-token) CLAUDE_TOKEN="$2"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="$2"; shift 2 ;;
    --no-restart) RESTART=0; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "不认识的选项：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 跑：sudo bash $0"
command -v systemctl >/dev/null || die "这台机器没有 systemd。"
command -v apt-get >/dev/null || die "目前只支持 Debian / Ubuntu（apt）。"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$REPO/src/server.mjs" ] || die "找不到 $REPO/src/server.mjs——请在仓库里运行本脚本"
ARCH="$(dpkg --print-architecture)"

# agent 选择：没给就沿用上次装的（config.json 的 agents 键），第一次装默认两个都要
agents_from_config() {
  [ -f "$DATA/config.json" ] || return 0
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=c.agents||{};const on=["claude","dimensio"].filter(id=>a[id]!==false);process.stdout.write(on.join(","))' "$DATA/config.json" 2>/dev/null || true
}
if [ -z "$AGENTS" ] && command -v node >/dev/null; then AGENTS="$(agents_from_config)"; fi
AGENTS="${AGENTS:-claude,dimensio}"
WANT_CLAUDE=0; WANT_DIMENSIO=0
for a in ${AGENTS//,/ }; do
  case "$a" in claude) WANT_CLAUDE=1 ;; dimensio) WANT_DIMENSIO=1 ;; *) die "--agents 只认 claude / dimensio，收到：$a" ;; esac
done
[ "$WANT_CLAUDE$WANT_DIMENSIO" != 00 ] || die "--agents 至少要选一个"

# 代理：安装时的代理原样带进服务环境（net-proxy 读 HTTPS_PROXY）
PROXY_LINES=""
for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
  [ -n "${!v:-}" ] && PROXY_LINES+="$v=${!v}"$'\n'
done

# ── 1. 系统依赖 ────────────────────────────────────────────────────────────────
say "装系统依赖"
export DEBIAN_FRONTEND=noninteractive
# 开机时系统自己的 apt（unattended-upgrades / 平台的 apt-get update）可能正占着锁：排队等，别直接失败。
# （apt 自带的 DPkg::Lock::Timeout 管不到 update 用的 lists/lock，实测照样秒失败）——锁错就自己隔 10 秒重试，最多 10 分钟
apt_wait() {
  local out rc i
  for i in $(seq 1 60); do
    rc=0; out="$(apt-get "$@" 2>&1)" || rc=$?
    printf '%s\n' "$out"
    [ $rc -eq 0 ] && return 0
    printf '%s' "$out" | grep -q 'Could not get lock\|Unable to lock\|Unable to acquire the dpkg frontend lock' || return $rc
    [ "$i" = 1 ] && echo "apt 正被别的进程占着（开机时系统自己的更新），排队等它……"
    sleep 10
  done
  return $rc
}
apt_wait update -y
# git / ripgrep：Claude Code 自己要用；python3 make g++：node-pty 现场编译；ffmpeg：视频缩略图与转码；
# 7z / bsdtar / unzip：解压；fonts-noto-cjk：中文文档预览不出豆腐块；jq：部署脚本改配置
apt_wait install -y --no-install-recommends \
  ca-certificates curl gnupg git ripgrep python3 make g++ jq \
  ffmpeg p7zip-full libarchive-tools unzip fonts-noto-cjk fonts-noto-color-emoji

node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 24 ]; then
  say "装 Node 24（NodeSource）"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt_wait install -y nodejs
fi
[ "$(node_major)" -ge 24 ] || die "Node 24 没装上（现在是 $(node -v 2>/dev/null || echo 无)）"
NODE_BIN="$(command -v node)"

# ── 2. 用户与数据目录 ──────────────────────────────────────────────────────────
say "服务用户 $SVC_USER，数据目录 $DATA"
if ! id -u "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA/home" --create-home --shell /bin/bash "$SVC_USER"
fi
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA"
install -d -o "$SVC_USER" -g "$SVC_USER" "$DATA/home" "$DATA/dimensio" \
  "$DATA/dimensio/sessions" "$DATA/dimensio/memory" "$DATA/dimensio/knowledge" "$DATA/dimensio/workspace"
[ -f "$DATA/dimensio/.env" ] || install -m 0600 -o "$SVC_USER" -g "$SVC_USER" /dev/null "$DATA/dimensio/.env"

# 代码归服务用户：以它的身份装依赖 / 构建，root 不在仓库里留文件
chown -R "$SVC_USER:$SVC_USER" "$REPO"
runuser -u "$SVC_USER" -- test -r "$REPO/src/server.mjs" \
  || die "服务用户读不到 $REPO（放在 /root 底下了？）——请把代码放到 /opt/muse-bridge 这类位置再跑"

as_svc() { runuser -u "$SVC_USER" -- env HOME="$DATA/home" ${PROXY_LINES:+$(printf '%s' "$PROXY_LINES" | tr '\n' ' ')} "$@"; }

# ── 3. 依赖与前端 ──────────────────────────────────────────────────────────────
say "装 npm 依赖、构建前端（第一次要几分钟）"
cd "$REPO"
as_svc npm ci --omit=dev --no-audit --no-fund
# 前端会把 dimensio 的界面源码一起编进去，所以它的前端依赖总是要装；运行依赖只在选了 dimensio 时装
as_svc npm --prefix harness/web ci --no-audit --no-fund
if [ "$WANT_DIMENSIO" = 1 ]; then
  as_svc npm --prefix harness ci --omit=dev --no-audit --no-fund
  as_svc npm --prefix harness/web run build
else
  rm -rf "$REPO/harness/node_modules"   # dimensio 的「能跑」判定看它：没选就别留着
fi
as_svc npm --prefix web ci --no-audit --no-fund
as_svc npm --prefix web run build

# ── 4. 配置与访问令牌 ──────────────────────────────────────────────────────────
TOKEN_OUT=""
if [ ! -f "$DATA/config.json" ]; then
  say "生成访问令牌（config.json 只存哈希）"
  TOKEN_OUT="$(as_svc env BRIDGE_DATA_ROOT="$DATA" "$NODE_BIN" src/gen-token.mjs --hash | tail -n 2 | head -n 1)"
fi
# agent 开关与多用户开关写进 config.json（只改这两个键）
as_svc "$NODE_BIN" -e '
const fs = require("fs"); const [file, claude, dimensio, mode] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(file, "utf8"));
c.agents = { ...(c.agents || {}), claude: claude === "1", dimensio: dimensio === "1" };
if (mode) c.features = { ...(c.features || {}), multiUser: mode === "multi" };
fs.writeFileSync(file, JSON.stringify(c, null, 2));
' "$DATA/config.json" "$WANT_CLAUDE" "$WANT_DIMENSIO" "$USERS_MODE"

install -d -m 0750 /etc/bridge
if [ ! -f /etc/bridge/bridge.env ] || [ -n "$CLAUDE_TOKEN" ] || [ -n "$PROXY_LINES" ]; then
  {
    echo "# Muse Bridge 服务环境（只有 root 可读）。改完：systemctl restart bridge"
    if [ -n "$CLAUDE_TOKEN" ]; then echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_TOKEN"
    elif [ -f /etc/bridge/bridge.env ]; then grep -E '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=' /etc/bridge/bridge.env || true
    else echo "# CLAUDE_CODE_OAUTH_TOKEN=（claude setup-token 生成的订阅令牌；也可以在控制台「Claude 账号」里加）"; fi
    [ -f /etc/bridge/bridge.env ] && grep -E '^BRIDGE_PUBLIC_ORIGIN=' /etc/bridge/bridge.env || true
    printf '%s' "$PROXY_LINES"
  } > /etc/bridge/bridge.env.new
  install -m 0600 /etc/bridge/bridge.env.new /etc/bridge/bridge.env
  rm -f /etc/bridge/bridge.env.new
fi

# ── 5. systemd 单元 ────────────────────────────────────────────────────────────
say "写 systemd 单元并启动"
cat > /etc/systemd/system/bridge.service <<UNIT
[Unit]
Description=Muse Bridge server
After=network-online.target
Wants=network-online.target
# 不设启动频率上限：崩溃重启已由 RestartSec 限速；撞上上限会被锁成 failed，之后看门狗的重启也全被拒
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$REPO
Environment=NODE_ENV=production
Environment=BRIDGE_EDITION=server
Environment=BRIDGE_SUPERVISED=systemd
Environment=BRIDGE_DATA_ROOT=$DATA
Environment=HOME=$DATA/home
Environment=PORT=$PORT
Environment=BRIDGE_HOST=$HOST
Environment=SESSIONS_DIR=$DATA/dimensio/sessions
Environment=MEMORY_DIR=$DATA/dimensio/memory
Environment=KNOWLEDGE_DIR=$DATA/dimensio/knowledge
Environment=DIMENSIO_CONFIG_FILE=$DATA/dimensio/runtime-config.json
Environment=DIMENSIO_QUICK_FILE=$DATA/dimensio/quick.json
Environment=PROJECTS_FILE=$DATA/dimensio/projects.json
Environment=WORKSPACE_DIR=$DATA/dimensio/workspace
Environment=HARNESS_ENV_FILE=$DATA/dimensio/.env
Environment=DIMENSIO_CUSTOM_PROVIDERS_DIR=$DATA/dimensio/custom-providers
EnvironmentFile=-/etc/bridge/bridge.env
ExecStart=$NODE_BIN src/server.mjs
Restart=always
RestartSec=3
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT

if [ -n "$TUNNEL_TOKEN" ]; then
  say "装 cloudflared，起 bridge-tunnel.service"
  if ! command -v cloudflared >/dev/null; then
    tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/cloudflared.deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"
    dpkg -i "$tmp/cloudflared.deb"; rm -rf "$tmp"
  fi
  install -m 0600 /dev/null /etc/bridge/tunnel.env
  { echo "TUNNEL_TOKEN=$TUNNEL_TOKEN"; printf '%s' "$PROXY_LINES"; } > /etc/bridge/tunnel.env
  cat > /etc/systemd/system/bridge-tunnel.service <<UNIT
[Unit]
Description=Muse Bridge Cloudflare tunnel
After=network-online.target bridge.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/bridge/tunnel.env
ExecStart=$(command -v cloudflared) --no-autoupdate tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
fi

systemctl daemon-reload
systemctl enable bridge.service >/dev/null
[ -n "$TUNNEL_TOKEN" ] && systemctl enable bridge-tunnel.service >/dev/null
if [ "$RESTART" = 1 ]; then
  systemctl restart bridge.service
  [ -n "$TUNNEL_TOKEN" ] && systemctl restart bridge-tunnel.service

  printf '等服务起来'
  for _ in $(seq 1 60); do
    if curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then echo ' ✓'; UP=1; break; fi
    printf '.'; sleep 1
  done
  [ "${UP:-0}" = 1 ] || { echo; warn "60 秒内没起来，看日志：journalctl -u bridge -n 100 --no-pager"; }
else
  say "--no-restart：新单元已写好，正在跑的服务没动；下次重启时切到这份代码"
fi

cat <<DONE

────────────────────────────────────────────────────────────────────
 Muse Bridge 已安装
   地址      http://$HOST:$PORT$( [ "$HOST" = 127.0.0.1 ] && echo '（只听本机：对外请配隧道或反代）' )
   agent     $AGENTS
   数据      $DATA
   服务      systemctl status bridge · 日志 journalctl -u bridge -f
DONE
if [ -n "$TOKEN_OUT" ]; then
cat <<DONE
   访问令牌  $TOKEN_OUT
             ↑ 只显示这一次（config.json 里只存哈希）。用它在网页里「用访问令牌登录」成为管理员。
DONE
fi
cat <<DONE
 下一步
   · Claude 认证：/etc/bridge/bridge.env 写 CLAUDE_CODE_OAUTH_TOKEN，或登录后在控制台「Claude 账号」里添加
   · dimensio 的模型 key：写进 $DATA/dimensio/.env（如 ANTHROPIC_API_KEY=…），再 systemctl restart bridge
   · 给朋友开账号：控制台「用户」页发邀请码 / 直接建号；额度在「额度与注册」
────────────────────────────────────────────────────────────────────
DONE
