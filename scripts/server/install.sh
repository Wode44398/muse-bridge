#!/usr/bin/env bash
# The Bridge 服务端一键安装：Linux 无界面服务端（Debian / Ubuntu + systemd）。有 Docker 的机器也可以用
# docker compose，见 docs/deploy-docker.md；完整说明见 docs/deploy-linux.md。
#
# 两种装法，按谁来跑自动选：
#   sudo bash install.sh …   系统服务（VPS / 专用服务器）：建系统用户 bridge，数据在 /var/lib/bridge，
#                            bridge.service 开机就跑、崩了自动拉起
#   bash install.sh …        用户服务（自己的 Linux 电脑 / 家里的机器）：以你自己的身份跑——agent 能用你的文件与
#                            你的 Claude 登录；数据在 ~/.local/share/bridge，systemd 用户单元 + loginctl enable-linger（不登录也跑）
#
# 手上没有源码也能装（脚本先把公开仓库克隆下来，再用克隆里同一版本的本脚本接着装）：
#   curl -fsSL https://raw.githubusercontent.com/Wode44398/claude-bridge/main/scripts/server/install.sh | sudo bash -s -- [选项]
# 已经克隆了：
#   sudo bash scripts/server/install.sh [选项]
#
# 做的事（可以重复执行：已有的数据、令牌、账号一概不动，只补齐依赖、重建前端、刷新服务单元）：
#   1. 装系统依赖与 Node 24（缺才装）
#   2. 建数据目录（系统服务另建系统用户 bridge）
#   3. 以服务用户装 npm 依赖、构建两套前端
#   4. 第一次安装：生成访问令牌（config.json 只存它的哈希，明文只在这里显示一次——请当场存好），问一句「给谁用」
#   5. 写 systemd 单元并启动（Restart=always：控制台「服务控制 → 重启」靠它拉起）
#   6. 装运维命令 bridgectl（sudo bridgectl access / pair / show-token / invite / logs / update …）
#   7. 打印访问地址，并在终端里出一张手机配对二维码（--no-pair 跳过）
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：sudo bash scripts/server/install.sh [选项]      （系统服务；不带 sudo 跑 = 装成你自己的用户服务）

给谁用（第一次安装时不给就在终端里问；重跑时不给就保持原样）：
  --solo              只给我自己（默认）：只有管理员（访问令牌 / 扫码配对的设备）能登录，注册与邀请码关着
  --shared            也给别人用：打开注册与邀请码，给家人朋友各开账号（各自的数据互相看不到）

网络：
  --port N            监听端口（默认 8787）
  --lan               监听所有网卡：同一个 Wi-Fi 里的手机直连 http://<局域网 IP>:端口（旧名 --public）
  --local-only        只听 127.0.0.1（系统服务的默认）：对外走隧道或反代，别把明文端口直接暴露到公网
  --quick-tunnel      公网访问用临时地址（trycloudflare，免注册；服务端每次重启地址会变）
  --tunnel-token T    公网访问用 Cloudflare 命名隧道（地址固定；服务端自己托管 cloudflared）
                      两个隧道选项都不给：公网访问保持原样（默认关），装好后随时在控制台里开

位置与身份：
  --data DIR          数据目录（系统服务默认 /var/lib/bridge；用户服务默认 ~/.local/share/bridge/data）
  --user NAME         系统服务的运行用户（默认 bridge）
  --dir DIR           不在仓库里运行（curl | bash）时把仓库克隆到哪（系统服务默认 /opt/bridge；用户服务默认 ~/.local/share/bridge/app）
  --repo URL          克隆来源（默认公开仓库；也可用环境变量 BRIDGE_REPO）
  --ref REF           克隆哪个分支 / 标签（默认 main；环境变量 BRIDGE_REF）

其它：
  --claude-token T    Claude 订阅令牌（claude setup-token 生成）；也可以装好后在「设置 › Claude › 订阅号池」里加
  --no-browser        不装浏览器（agent 的浏览器工具、网页截图用不了；用户服务从不装浏览器，用你机器上已有的）
  --no-pair           装完不在终端里出配对二维码
  -y, --yes           不问任何问题（「给谁用」按 --shared / --solo，都没给就是只给我自己）
  -h, --help          看这段说明

出站只能走代理的机器：先 export HTTPS_PROXY=http://代理:端口 再跑，脚本会把代理带进服务环境。
/etc 重启后不保留的沙箱机器：重启后重跑一次本脚本即可（数据在数据目录里，不受影响）。
USAGE
}

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# 能不能在终端里问问题（curl | bash 时标准输入是脚本本身，问题从 /dev/tty 读）
can_ask() { [ "$ASSUME_YES" = 0 ] && [ -t 1 ] && { : < /dev/tty; } 2>/dev/null; }
ask() {   # ask <提示> <默认值> → 回答写到标准输出
  local ans=""
  printf '%s' "$1" > /dev/tty
  IFS= read -r ans < /dev/tty || true
  printf '%s' "${ans:-$2}"
}

PUBLIC_REPO="https://github.com/Wode44398/claude-bridge.git"

main() {
  local ORIG_ARGS=("$@")
  PORT="" HOST="" DATA="" SVC_USER="" DIR="" AUDIENCE=""
  REPO_URL="${BRIDGE_REPO:-$PUBLIC_REPO}" REF="${BRIDGE_REF:-main}"
  WITH_BROWSER=1 CLAUDE_TOKEN="" TUNNEL_TOKEN="" QUICK_TUNNEL=0 NO_PAIR=0 ASSUME_YES=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --port) PORT="$2"; shift 2 ;;
      --lan|--public) HOST=0.0.0.0; shift ;;
      --local-only) HOST=127.0.0.1; shift ;;
      --data) DATA="$2"; shift 2 ;;
      --user) SVC_USER="$2"; shift 2 ;;
      --dir) DIR="$2"; shift 2 ;;
      --repo) REPO_URL="$2"; shift 2 ;;
      --ref) REF="$2"; shift 2 ;;
      --solo) AUDIENCE=self; shift ;;
      --shared) AUDIENCE=shared; shift ;;
      --no-browser) WITH_BROWSER=0; shift ;;
      --claude-token) CLAUDE_TOKEN="$2"; shift 2 ;;
      --tunnel-token) TUNNEL_TOKEN="$2"; shift 2 ;;
      --quick-tunnel) QUICK_TUNNEL=1; shift ;;
      --no-pair) NO_PAIR=1; shift ;;
      -y|--yes) ASSUME_YES=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "不认识的选项：$1（--help 看用法）" ;;
    esac
  done
  [ -z "$PORT" ] || [[ "$PORT" =~ ^[0-9]+$ ]] || die "--port 要是数字"

  # ── 0. 系统服务还是用户服务 ────────────────────────────────────────────────────
  if [ "$(id -u)" = 0 ]; then
    MODE=system
    SVC_USER="${SVC_USER:-bridge}"
    DATA="${DATA:-/var/lib/bridge}"
    DIR="${DIR:-/opt/bridge}"
    UNIT_FILE=/etc/systemd/system/bridge.service
    CTL_PATH=/usr/local/bin/bridgectl
    CTL_HINT="sudo bridgectl"
    ENV_FILE=/etc/bridge/bridge.env
  else
    MODE=user
    [ -z "$SVC_USER" ] || [ "$SVC_USER" = "$(id -un)" ] || die "--user 只用于系统服务（sudo 跑）；用户服务以你自己的身份运行"
    SVC_USER="$(id -un)"
    local share="${XDG_DATA_HOME:-$HOME/.local/share}/bridge"
    DATA="${DATA:-$share/data}"
    DIR="${DIR:-$share/app}"
    UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/bridge.service"
    CTL_PATH="$HOME/.local/bin/bridgectl"
    CTL_HINT="bridgectl"
    ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/bridge/bridge.env"
  fi

  # ── 0b. 不在仓库里（curl | bash）：先克隆公开仓库，再交给克隆里的同一个脚本 ──────────────
  local self="${BASH_SOURCE[0]:-}"
  REPO=""
  # 从管道读进来时 BASH_SOURCE 是 bash / main 之类的假名字：只认真的 install.sh 文件
  if [ -n "$self" ] && [ "${self##*/}" = install.sh ] && [ -f "$self" ]; then
    local cand
    cand="$(cd "$(dirname "$self")/../.." 2>/dev/null && pwd || true)"
    [ -n "$cand" ] && [ -f "$cand/src/server.mjs" ] && REPO="$cand"
  fi
  if [ -z "$REPO" ]; then
    [ -z "${BRIDGE_INSTALL_BOOTSTRAPPED:-}" ] || die "克隆下来的 $DIR 里没有 scripts/server/install.sh——仓库地址或分支不对？"
    say "取源码：$REPO_URL（$REF）→ $DIR"
    if ! command -v git >/dev/null; then
      if [ "$MODE" = system ] && command -v apt-get >/dev/null; then
        DEBIAN_FRONTEND=noninteractive apt-get update -y </dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ca-certificates </dev/null
      else
        die "需要 git：sudo apt-get install -y git（或你的发行版的同名包）"
      fi
    fi
    if [ -d "$DIR/.git" ]; then
      warn "$DIR 已经是一个 git 仓库：沿用它（不在这里切版本；更新用 scripts/server/update.sh）"
    elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
      die "$DIR 已存在且不是空目录：换一个 --dir，或先把它挪走"
    else
      mkdir -p "$(dirname "$DIR")"
      git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR" </dev/null || die "克隆失败：$REPO_URL（$REF）"
    fi
    [ -f "$DIR/scripts/server/install.sh" ] || die "$DIR 里没有 scripts/server/install.sh"
    exec env BRIDGE_INSTALL_BOOTSTRAPPED=1 bash "$DIR/scripts/server/install.sh" "${ORIG_ARGS[@]}"
  fi

  if [ "$MODE" = system ]; then
    command -v systemctl >/dev/null && [ -d /run/systemd/system ] || die "这台机器没有在跑 systemd。有 Docker 的话用 docker compose（docs/deploy-docker.md）。"
    command -v apt-get >/dev/null || die "目前只支持 Debian / Ubuntu（apt）。其它发行版请照 docs/deploy-linux.md 手动装依赖，或用 Docker。"
    case "$REPO" in /root|/root/*) die "仓库在 /root 底下，服务用户 $SVC_USER 读不到：请克隆到 /opt/bridge 这类位置再跑（或直接 curl | sudo bash，脚本自己克隆）" ;; esac
  else
    command -v systemctl >/dev/null || die "这台机器没有 systemd。有 Docker 的话用 docker compose（docs/deploy-docker.md）。"
    systemctl --user show-environment >/dev/null 2>&1 \
      || die "连不上你的 systemd 用户实例：请在你自己的登录会话里跑（直接 ssh 登录这个用户，别用 sudo -u / su）。要装成系统服务就用 sudo 跑。"
    if can_ask; then
      printf '\n将以 %s 的身份装成「用户服务」：agent 用你的文件与 Claude 登录，数据在 %s。\nVPS / 专用服务器请改用 sudo 跑（系统服务，专用用户 bridge）。\n' "$SVC_USER" "$DATA"
      case "$(ask '继续？[Y/n] ' y)" in [Nn]*) echo "没装。"; exit 0 ;; esac
    fi
  fi
  [ -f "$REPO/src/server.mjs" ] || die "找不到 $REPO/src/server.mjs——请在仓库里运行本脚本"

  # 重跑：没给的端口 / 监听地址 / 部署形态沿用现有单元里的（别把局域网部署悄悄改回只听本机，
  # 也别因为这回是从 ssh 里跑的、没有图形界面，就把本机桌面形态改成无界面服务器）
  local OLD_EDITION="" OLD_DEPLOY=""
  if [ -f "$UNIT_FILE" ]; then
    [ -n "$PORT" ] || PORT="$(sed -n 's/^Environment=PORT=\([0-9]*\)$/\1/p' "$UNIT_FILE" | head -n 1)"
    [ -n "$HOST" ] || HOST="$(sed -n 's/^Environment=BRIDGE_HOST=\(.*\)$/\1/p' "$UNIT_FILE" | head -n 1)"
    OLD_EDITION="$(sed -n 's/^Environment=BRIDGE_EDITION=\(.*\)$/\1/p' "$UNIT_FILE" | head -n 1)"
    OLD_DEPLOY="$(sed -n 's/^Environment=BRIDGE_DEPLOY=\(desktop\|server\)$/\1/p' "$UNIT_FILE" | head -n 1)"
  fi
  PORT="${PORT:-8787}"

  # 用户服务：有图形界面的会话就当「本机桌面」形态（默认听所有网卡，手机在家走局域网），否则当无界面服务器
  DEPLOY=server
  if [ -n "$OLD_DEPLOY" ]; then
    DEPLOY="$OLD_DEPLOY"
  elif [ "$MODE" = user ] && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ] || [ "${XDG_SESSION_TYPE:-}" = x11 ] || [ "${XDG_SESSION_TYPE:-}" = wayland ]; }; then
    DEPLOY=desktop
  fi
  if [ -z "$HOST" ]; then
    if [ "$DEPLOY" = desktop ]; then HOST=0.0.0.0
    elif [ ! -f "$UNIT_FILE" ] && can_ask; then
      printf '\n手机怎么连这台机器？\n  1) 只走公网隧道或反向代理（VPS 选这个，默认）\n  2) 同一个 Wi-Fi 里直连 http://<局域网 IP>:%s（家里的机器选这个）\n' "$PORT"
      case "$(ask '选 1 或 2 [1]: ' 1)" in 2) HOST=0.0.0.0 ;; *) HOST=127.0.0.1 ;; esac
    else
      HOST=127.0.0.1
    fi
  fi

  . /etc/os-release 2>/dev/null || true
  ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"

  # 代理：安装时的代理原样带进服务环境（net-proxy 读 HTTPS_PROXY）
  PROXY_LINES=""
  local v
  for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy; do
    [ -n "${!v:-}" ] && PROXY_LINES+="$v=${!v}"$'\n'
  done

  # ── 1. 系统依赖 ────────────────────────────────────────────────────────────────
  if [ "$MODE" = system ]; then install_deps_system; else install_deps_user; fi
  NODE_BIN="$(command -v node)"

  # ── 2. 数据目录 ────────────────────────────────────────────────────────────────
  say "服务用户 $SVC_USER，数据目录 $DATA"
  if [ "$MODE" = system ]; then
    if ! id -u "$SVC_USER" >/dev/null 2>&1; then
      useradd --system --home-dir "$DATA/home" --create-home --shell /bin/bash "$SVC_USER"
    fi
    install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA"
    install -d -o "$SVC_USER" -g "$SVC_USER" "$DATA/home" "$DATA/dimensio" \
      "$DATA/dimensio/sessions" "$DATA/dimensio/memory" "$DATA/dimensio/knowledge" "$DATA/dimensio/workspace"
    [ -f "$DATA/dimensio/.env" ] || install -m 0600 -o "$SVC_USER" -g "$SVC_USER" /dev/null "$DATA/dimensio/.env"
  else
    install -d -m 0750 "$DATA"
    install -d "$DATA/dimensio" "$DATA/dimensio/sessions" "$DATA/dimensio/memory" "$DATA/dimensio/knowledge" "$DATA/dimensio/workspace"
    [ -f "$DATA/dimensio/.env" ] || install -m 0600 /dev/null "$DATA/dimensio/.env"
  fi
  # dimensio 设置页填的厂商 key 与自定义服务（custom-providers）以前落在程序目录的 harness/ 里，现在随 DIMENSIO_DATA_DIR
  # 落进数据目录（见下面的单元）。重跑本脚本的老部署：数据目录里还没有就一次性复制过去（原件留着，不覆盖已有的）。
  if [ ! -e "$DATA/dimensio/custom-providers" ] && [ -d "$REPO/harness/custom-providers" ]; then
    cp -a "$REPO/harness/custom-providers" "$DATA/dimensio/custom-providers"
    [ "$MODE" = system ] && chown -R "$SVC_USER:$SVC_USER" "$DATA/dimensio/custom-providers"
    say "已把 dimensio 自定义服务（harness/custom-providers）复制到 $DATA/dimensio/custom-providers"
  fi
  if [ "$MODE" = system ]; then
    # 代码归服务用户：以它的身份装依赖 / 构建 / 以后 git pull，root 不在仓库里留文件
    chown -R "$SVC_USER:$SVC_USER" "$REPO"
    runuser -u "$SVC_USER" -- test -r "$REPO/src/server.mjs" \
      || die "服务用户读不到 $REPO（放在 /root 底下了？）——请把仓库克隆到 /opt/bridge 这类位置再跑"
    SVC_HOME="$DATA/home"
  else
    SVC_HOME="$HOME"
  fi

  # ── 3. 依赖与前端 ──────────────────────────────────────────────────────────────
  say "装 npm 依赖、构建前端（第一次要几分钟）"
  cd "$REPO"
  as_svc npm ci --omit=dev --no-audit --no-fund
  as_svc npm --prefix harness ci --omit=dev --no-audit --no-fund
  as_svc npm --prefix harness/web ci --no-audit --no-fund
  as_svc npm --prefix web ci --no-audit --no-fund
  as_svc npm --prefix harness/web run build
  as_svc npm --prefix web run build

  # ── 4. 配置与访问令牌、给谁用 ──────────────────────────────────────────────────
  TOKEN_OUT=""
  local FIRST=0
  if [ ! -f "$DATA/config.json" ]; then
    FIRST=1
    say "生成访问令牌（config.json 只存哈希）"
    TOKEN_OUT="$(as_svc env BRIDGE_DATA_ROOT="$DATA" "$NODE_BIN" src/gen-token.mjs --hash | tail -n 2 | head -n 1)"
    if [ -z "$AUDIENCE" ] && can_ask; then
      printf '\n这台服务器给谁用？\n  1) 只给我自己（默认）：只有你（访问令牌 / 扫码配对的设备）能登录\n  2) 也给别人用：打开注册与邀请码，给家人朋友各开账号（各自的数据互相看不到，共用你配的 Claude 认证与额度）\n'
      case "$(ask '选 1 或 2 [1]: ' 1)" in 2) AUDIENCE=shared ;; *) AUDIENCE=self ;; esac
    fi
    AUDIENCE="${AUDIENCE:-self}"
    # defaultsVersion 2：这份配置按部署形态定默认值（src/config/deploy-profile.mjs）；「给谁用」写成显式开关，控制台里随时能改
    cfg_set "defaultsVersion=2" "port=$PORT" "features.multiUser=$( [ "$AUDIENCE" = shared ] && echo true || echo false )"
  else
    # 已有配置：不给 --shared / --solo 就不改「给谁用」（老配置没有 defaultsVersion，照旧按老规矩算：Linux 默认开多用户）
    [ -z "$AUDIENCE" ] || cfg_set "features.multiUser=$( [ "$AUDIENCE" = shared ] && echo true || echo false )"
    if [ -n "$OLD_EDITION" ]; then
      # 老版本 install.sh 的单元写着 BRIDGE_EDITION（server = 开多用户，host = 关）；新单元不再写它。
      # 它原本决定的多用户开关落成 config.json 里的显式值（已经显式写过的不动），这样换单元前后一字不变。
      if [ -z "$AUDIENCE" ]; then
        case "$OLD_EDITION" in
          server) cfg_set "features.multiUser?=true" ;;
          host) cfg_set "features.multiUser?=false" ;;
        esac
      fi
      say "单元里的旧变量 BRIDGE_EDITION=$OLD_EDITION 已换成 BRIDGE_DEPLOY（「给谁用」不变，已写成 config.json 的 features.multiUser）"
    fi
  fi

  if [ "$MODE" = system ]; then install -d -m 0750 "$(dirname "$ENV_FILE")"; else install -d -m 0700 "$(dirname "$ENV_FILE")"; fi
  if [ ! -f "$ENV_FILE" ] || [ -n "$CLAUDE_TOKEN" ] || [ -n "$PROXY_LINES" ]; then
    # 重写时原有的行照旧保留（自己加过的变量不丢），只换掉这次给了新值的：Claude 令牌、代理
    local drop='^# The Bridge 服务环境'
    [ -z "$CLAUDE_TOKEN" ] || drop+='|^#? ?CLAUDE_CODE_OAUTH_TOKEN='
    [ -z "$PROXY_LINES" ] || drop+='|^(HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy)='
    {
      echo "# The Bridge 服务环境（只有你 / root 可读）。改完：$( [ "$MODE" = system ] && echo 'systemctl restart bridge' || echo 'systemctl --user restart bridge')"
      if [ -f "$ENV_FILE" ]; then grep -vE "$drop" "$ENV_FILE" || true
      elif [ -z "$CLAUDE_TOKEN" ]; then echo "# CLAUDE_CODE_OAUTH_TOKEN=（claude setup-token 生成的订阅令牌；也可以在控制台「设置 › Claude › 订阅号池」里加）"; fi
      [ -z "$CLAUDE_TOKEN" ] || echo "CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_TOKEN"
      printf '%s' "$PROXY_LINES"
    } > "$ENV_FILE.new"
    install -m 0600 "$ENV_FILE.new" "$ENV_FILE"
    rm -f "$ENV_FILE.new"
  fi

  # ── 5. systemd 单元 ────────────────────────────────────────────────────────────
  say "写 systemd 单元并启动"
  BROWSER="${BROWSER:-}"
  write_unit

  # 重跑时换 Claude 令牌：号池上线后服务端只认号池里的激活号（环境变量里的只在第一次启动时播种号池），
  # 所以已有配置时顺手写进号池（令牌经 stdin 交给 set-auth，不出现在进程参数里）。
  if [ -n "$CLAUDE_TOKEN" ] && [ "$FIRST" = 0 ]; then
    printf '%s' "$CLAUDE_TOKEN" | as_svc env BRIDGE_DATA_ROOT="$DATA" "$NODE_BIN" src/set-auth.mjs - || warn "写号池失败：装好后到「设置 › Claude › 订阅号池」里加"
  fi

  # ── 公网访问（服务端自己托管 cloudflared，见 src/runtime/public-access.mjs）────────────────
  [ -z "$TUNNEL_TOKEN" ] && [ "$QUICK_TUNNEL" = 0 ] || configure_tunnel

  # ── 6. 运维命令 bridgectl ─────────────────────────────────────────────────────
  write_bridgectl

  START_TS="$(date +%s)"
  if [ "$MODE" = system ]; then
    systemctl daemon-reload
    systemctl enable bridge.service >/dev/null
    systemctl restart bridge.service
  else
    systemctl --user daemon-reload
    systemctl --user enable bridge.service >/dev/null
    systemctl --user restart bridge.service
    # 不登录也跑：没有 linger 的话，你一退出登录，用户服务就跟着停
    if [ "$(loginctl show-user "$SVC_USER" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
      loginctl enable-linger "$SVC_USER" 2>/dev/null \
        || warn "没能打开 linger：你退出登录后服务会停。补救：sudo loginctl enable-linger $SVC_USER"
    fi
  fi

  printf '等服务起来'
  UP=0
  local _
  for _ in $(seq 1 90); do
    if "$NODE_BIN" -e "fetch('http://127.0.0.1:$PORT/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then echo ' ✓'; UP=1; break; fi
    printf '.'; sleep 1
  done
  [ "$UP" = 1 ] || { echo; warn "90 秒内没起来，看日志：$( [ "$MODE" = system ] && echo 'journalctl -u bridge -n 100 --no-pager' || echo 'journalctl --user -u bridge -n 100 --no-pager')"; }

  # ── 7. 结果、访问信息、配对 ────────────────────────────────────────────────────
  local quick_url=""
  [ "$QUICK_TUNNEL" = 1 ] && [ "$UP" = 1 ] && quick_url="$(wait_quick_url)"

  cat <<DONE

────────────────────────────────────────────────────────────────────
 The Bridge 已安装（$( [ "$MODE" = system ] && echo "系统服务，运行用户 $SVC_USER" || echo "用户服务，以 $SVC_USER 的身份运行")）
   程序      $REPO
   数据      $DATA
   服务      $( [ "$MODE" = system ] && echo 'systemctl status bridge · 日志 journalctl -u bridge -f' || echo 'systemctl --user status bridge · 日志 journalctl --user -u bridge -f')
   运维命令  $CTL_HINT（access 访问信息 · pair 手机配对 · show-token · invite · logs · update；$CTL_HINT help 看全部）
DONE
  if [ -n "$TOKEN_OUT" ]; then
    cat <<DONE
   访问令牌  $TOKEN_OUT
             ↑ 只显示这一次（config.json 里只存哈希）。用它在网页 / App 里「用访问令牌登录」成为管理员，请当场存好。
DONE
  fi
  if [ -n "$quick_url" ]; then echo "   公网      $quick_url（临时地址：服务端每次重启都会变，当前地址看控制台「服务控制 → 公网访问」）"
  elif [ "$QUICK_TUNNEL" = 1 ]; then echo '   公网      临时地址还在申请：稍后看控制台「服务控制 → 公网访问」'
  elif [ -n "$TUNNEL_TOKEN" ]; then echo "   公网      Cloudflare 命名隧道（服务端托管）：在 Cloudflare 后台给隧道加 Public Hostname，服务填 http://localhost:$PORT"
  fi
  echo "────────────────────────────────────────────────────────────────────"

  if [ "$UP" = 1 ]; then
    echo
    if [ -n "$TOKEN_OUT" ]; then printf '%s' "$TOKEN_OUT" | run_ctl access --token-stdin || true
    else run_ctl access </dev/null || true; fi
    if [ "$NO_PAIR" = 0 ] && [ -t 1 ]; then
      if [ -n "$TOKEN_OUT" ] && [ "$HOST" = 127.0.0.1 ] && ! public_access_on; then
        # 只听本机、又没开公网访问（VPS 的默认）：码里只能写 127.0.0.1，手机扫了也打不开——不出码、不占着终端，说清先做什么
        echo
        echo "手机暂时连不上：服务只听本机（127.0.0.1），也没开公网访问。任选其一，再运行 $CTL_HINT pair 出配对码："
        echo "  · 公网临时地址：重跑本脚本加 --quick-tunnel（或 --tunnel-token <Cloudflare 隧道令牌>，地址固定）"
        echo "  · 同一个 Wi-Fi 里直连：重跑本脚本加 --lan（明文 http，只在自己家里的网络用）"
        echo "  · 已有反向代理 / 域名：自己电脑上 ssh -L $PORT:127.0.0.1:$PORT 登录这台服务器，浏览器开 http://127.0.0.1:$PORT"
        echo "    用访问令牌登录，在「设置 › 服务端 › 服务控制 › 公网访问」里填对外地址"
        echo "  （重跑不动数据、令牌与账号。）"
      elif [ -n "$TOKEN_OUT" ]; then
        echo
        echo "手机扫下面的码连上它（Ctrl+C 跳过；以后随时 $CTL_HINT pair 再出一张）："
        printf '%s' "$TOKEN_OUT" | run_ctl pair --once --token-stdin || true
      else
        # 重跑（令牌早就生成过、这里没有明文）：不占着终端等人扫码，只提一句——bridgectl pair 在本机用主机密钥就能出码
        echo
        echo "手机配对：$CTL_HINT pair（终端里出二维码）；或用访问令牌登录网页后在「设置 › 连接」里出码。"
      fi
    fi
  fi
  if [ "$MODE" = user ] && ! printf '%s' ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
    warn "$HOME/.local/bin 不在 PATH 里：重新登录一次，或用完整路径 $CTL_PATH"
  fi
}

# 以服务用户的身份跑（系统服务：runuser 到 bridge，HOME 指到数据目录；用户服务：就是自己）
as_svc() {
  if [ "$MODE" = system ]; then
    runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" ${PROXY_LINES:+$(printf '%s' "$PROXY_LINES" | tr '\n' ' ')} "$@"
  else
    "$@"
  fi
}

# 改 config.json 里的几个键（其余原样保留）：cfg_set key=<JSON 值> …；features.multiUser 写进 features 对象；
# 写成 key?=<值> 的只在还没有这个键时才写（已有的显式值不动）
cfg_set() {
  as_svc env BRIDGE_DATA_ROOT="$DATA" "$NODE_BIN" -e '
    const fs = require("fs"), path = require("path");
    const f = path.join(process.env.BRIDGE_DATA_ROOT, "config.json");
    const c = JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
    for (const kv of process.argv.slice(1)) {
      const i = kv.indexOf("="), v = JSON.parse(kv.slice(i + 1));
      let k = kv.slice(0, i);
      const soft = k.endsWith("?");
      if (soft) k = k.slice(0, -1);
      if (k === "features.multiUser") {
        c.features = c.features && typeof c.features === "object" ? c.features : {};
        if (!soft || typeof c.features.multiUser !== "boolean") c.features.multiUser = v;
      } else if (!soft || !(k in c)) c[k] = v;
    }
    fs.writeFileSync(f, JSON.stringify(c, null, 2));
  ' "$@"
}

# 公网访问开着没有：数据目录 public-access.json 的 mode 是 quick / token / manual（服务端 runtime/public-access.mjs 的 MODES）
public_access_on() {
  [ -f "$DATA/public-access.json" ] || return 1
  "$NODE_BIN" -e '
    try {
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").replace(/^﻿/, "")).mode;
      process.exit(["quick", "token", "manual"].includes(m) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$DATA/public-access.json"
}

node_ok() {   # node ≥ 需要的主版本（系统服务装 24；用户服务只要满足 engines 的 22.6）
  command -v node >/dev/null || return 1
  node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>$1||(a===$1&&b>=$2)?0:1)" 2>/dev/null
}

install_deps_system() {
  say "装系统依赖"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y </dev/null
  # git / ripgrep：Claude Code 自己要用；python3 make g++：node-pty 现场编译；ffmpeg：视频缩略图与转码；
  # 7z / bsdtar / unzip：解压；fonts-noto-cjk：中文截图与文档预览不出豆腐块；policykit / systemd：保持唤醒用的 systemd-inhibit 自带
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git ripgrep python3 make g++ \
    ffmpeg p7zip-full libarchive-tools unzip fonts-noto-cjk fonts-noto-color-emoji </dev/null
  if ! node_ok 24 0; then
    say "装 Node 24（NodeSource）"
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
    apt-get install -y nodejs </dev/null
  fi
  node_ok 24 0 || die "Node 24 没装上（现在是 $(node -v 2>/dev/null || echo 无)）"

  BROWSER=""
  if [ "$WITH_BROWSER" = 1 ]; then
    say "装浏览器（agent 的浏览器工具与截图）"
    if [ "${ID:-}" = debian ]; then
      apt-get install -y --no-install-recommends chromium </dev/null && BROWSER=/usr/bin/chromium || warn "chromium 没装上，浏览器工具先不可用"
    elif [ "$ARCH" = amd64 ]; then
      # Ubuntu 的 chromium 是 snap 包，在服务里跑不起来——装 Google Chrome 的 deb
      install -d -m 0755 /etc/apt/keyrings
      if curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor --yes -o /etc/apt/keyrings/google-chrome.gpg; then
        echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
        apt-get update -y </dev/null && apt-get install -y google-chrome-stable </dev/null && BROWSER=/usr/bin/google-chrome || warn "Chrome 没装上，浏览器工具先不可用"
      else
        warn "拿不到 Google 的签名公钥，跳过浏览器"
      fi
    else
      warn "${ID:-?} / $ARCH 上没有现成的浏览器包，跳过（浏览器工具不可用）"
    fi
  fi
}

install_deps_user() {
  say "检查依赖（用户服务：缺的系统包用 sudo 装，会问你的密码）"
  local need=() c
  for c in git python3 make g++ rg ffmpeg 7z bsdtar unzip; do command -v "$c" >/dev/null || need+=("$c"); done
  if [ ${#need[@]} -gt 0 ]; then
    local pkgs=() p
    for c in "${need[@]}"; do
      case "$c" in rg) p=ripgrep ;; 7z) p=p7zip-full ;; bsdtar) p=libarchive-tools ;; *) p="$c" ;; esac
      pkgs+=("$p")
    done
    if command -v apt-get >/dev/null && command -v sudo >/dev/null; then
      { sudo env DEBIAN_FRONTEND=noninteractive apt-get update -y \
        && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${pkgs[@]}" fonts-noto-cjk; } \
        || warn "没装上：${pkgs[*]}"
    else
      warn "缺这些命令：${need[*]}——请用你的包管理器装上（git python3 make g++ 是必需的，其余是可选功能）"
    fi
  fi
  for c in git python3 make g++; do command -v "$c" >/dev/null || die "缺 $c（编译 node-pty、拉代码要用）"; done
  if ! node_ok 22 6; then
    if command -v apt-get >/dev/null && command -v sudo >/dev/null; then
      say "装 Node 24（NodeSource，要 sudo）"
      curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
      sudo apt-get install -y nodejs
    fi
    node_ok 22 6 || die "需要 Node ≥ 22.6（推荐 24），现在是 $(node -v 2>/dev/null || echo 无)：用发行版的包、NodeSource 或 nvm 装好再跑"
  fi
}

write_unit() {
  local dim="$DATA/dimensio"
  install -d "$(dirname "$UNIT_FILE")"
  if [ "$MODE" = system ]; then
    cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=The Bridge server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$REPO
Environment=NODE_ENV=production
Environment=BRIDGE_DEPLOY=$DEPLOY
Environment=BRIDGE_SUPERVISED=systemd
Environment="BRIDGE_CLI=$CTL_HINT"
Environment=BRIDGE_DATA_ROOT=$DATA
Environment=HOME=$DATA/home
Environment=PORT=$PORT
Environment=BRIDGE_HOST=$HOST
Environment=DIMENSIO_DATA_DIR=$dim
Environment=SESSIONS_DIR=$dim/sessions
Environment=MEMORY_DIR=$dim/memory
Environment=KNOWLEDGE_DIR=$dim/knowledge
Environment=DIMENSIO_CONFIG_FILE=$dim/runtime-config.json
Environment=DIMENSIO_QUICK_FILE=$dim/quick.json
Environment=PROJECTS_FILE=$dim/projects.json
Environment=WORKSPACE_DIR=$dim/workspace
Environment=HARNESS_ENV_FILE=$dim/.env
${BROWSER:+Environment=BRIDGE_BROWSER=$BROWSER}
${BROWSER:+Environment=HEADLESS_BROWSER=$BROWSER}
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN src/server.mjs
Restart=always
RestartSec=3
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT
  else
    cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=The Bridge server (user service)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=BRIDGE_DEPLOY=$DEPLOY
Environment=BRIDGE_SUPERVISED=systemd
Environment="BRIDGE_CLI=$CTL_HINT"
Environment=BRIDGE_DATA_ROOT=$DATA
Environment=PORT=$PORT
Environment=BRIDGE_HOST=$HOST
Environment=DIMENSIO_DATA_DIR=$dim
Environment=SESSIONS_DIR=$dim/sessions
Environment=MEMORY_DIR=$dim/memory
Environment=KNOWLEDGE_DIR=$dim/knowledge
Environment=DIMENSIO_CONFIG_FILE=$dim/runtime-config.json
Environment=DIMENSIO_QUICK_FILE=$dim/quick.json
Environment=PROJECTS_FILE=$dim/projects.json
Environment=WORKSPACE_DIR=$dim/workspace
Environment=HARNESS_ENV_FILE=$dim/.env
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN src/server.mjs
Restart=always
RestartSec=3
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
  fi
}

# bridgectl：sudo bridgectl access / pair / show-token / invite / users / token / status / logs / restart / update
# 系统服务：bridgectl 本身归 root（/usr/local/bin），程序目录归服务用户 bridge——agent（管理员的免确认会话、完全信任档
# 的命令行）就以 bridge 的身份跑、改得动程序目录。所以 root 一律不执行程序目录里的代码：src/cli.mjs（含 help）、update.sh
# 都 runuser 到服务用户去跑，root 只留 systemctl / journalctl（update 的「重启」那一步）。
write_bridgectl() {
  install -d "$(dirname "$CTL_PATH")"
  local sc jc
  if [ "$MODE" = system ]; then sc="systemctl"; jc="journalctl -u bridge"; else sc="systemctl --user"; jc="journalctl --user -u bridge"; fi
  cat > "$CTL_PATH.new" <<CTL
#!/bin/sh
# The Bridge 运维命令（scripts/server/install.sh 生成；重跑安装脚本会覆盖它）。$CTL_HINT help 看用法。
REPO='$REPO'
DATA='$DATA'
SVC_USER='$SVC_USER'
NODE='$NODE_BIN'
HELP=0
CTL
  if [ "$MODE" = system ]; then
    cat >> "$CTL_PATH.new" <<CTL
# 以服务用户的身份跑（root 不执行程序目录里服务用户改得动的代码）
as_svc() {
  if [ "\$(id -u)" = 0 ]; then cd "\$REPO" || exit 1; exec runuser -u "\$SVC_USER" -- env HOME="\$DATA/home" "\$@"; fi
  if [ "\$(id -un)" = "\$SVC_USER" ]; then cd "\$REPO" || exit 1; exec "\$@"; fi
  [ "\$HELP" = 1 ] && { echo "（这几条命令的参数：$CTL_HINT help）"; exit 0; }
  echo "请用 $CTL_HINT（要以服务用户 \$SVC_USER 的身份读数据目录）" >&2
  exit 1
}
# 更新：以服务用户拉代码、装依赖、构建（update.sh --no-restart），有新代码再由 root 重启服务
do_update() {
  [ "\$(id -u)" = 0 ] || { echo "请用 $CTL_HINT update" >&2; exit 1; }
  NR=0
  for a in "\$@"; do [ "\$a" = --no-restart ] && NR=1; done
  T="\$(mktemp -d)" || exit 1
  set -f
  # 服务环境里的代理（/etc/bridge 只有 root 读得了）顺带给 git / npm
  PX="\$(grep -E '^(HTTPS_PROXY|HTTP_PROXY|NO_PROXY|https_proxy|http_proxy|no_proxy)=' '$ENV_FILE' 2>/dev/null | tr '\n' ' ')"
  cd "\$REPO" || exit 1
  { runuser -u "\$SVC_USER" -- env HOME="\$DATA/home" \$PX bash "\$REPO/scripts/server/update.sh" --no-restart; echo \$? > "\$T/rc"; } 2>&1 | tee "\$T/log"
  RC="\$(cat "\$T/rc" 2>/dev/null || echo 1)"
  RES="\$(grep '^BRIDGE_UPDATE_RESULT=' "\$T/log" | tail -n 1)"
  rm -rf "\$T"
  [ "\$RC" = 0 ] || { echo "更新没成功（见上面的输出），服务没有重启。" >&2; exit "\$RC"; }
  case "\$RES" in *=unchanged*) echo "已经是最新，服务没有重启。"; exit 0 ;; esac
  if [ "\$NR" = 1 ]; then echo "没有重启：到控制台「服务控制」点「空闲时重启」（或 sudo bridgectl restart）"; exit 0; fi
  $sc restart bridge || exit 1
  echo "已重启：sudo bridgectl status"
  exit 0
}
CTL
  else
    cat >> "$CTL_PATH.new" <<CTL
as_svc() { cd "\$REPO" || exit 1; exec "\$@"; }
do_update() { exec bash "\$REPO/scripts/server/update.sh" "\$@"; }
CTL
  fi
  cat >> "$CTL_PATH.new" <<CTL
case "\${1:-help}" in
  status)  exec $sc status bridge --no-pager ;;
  logs)    shift; exec $jc -f "\$@" ;;
  start|stop|restart) exec $sc "\$1" bridge ;;
  update)  shift; do_update "\$@" ;;
  help|-h|--help)
    HELP=1
    echo "用法：$CTL_HINT <命令>"
    echo "  access | pair | show-token | token | invite | users   以服务用户身份、带上服务的数据目录与端口跑 src/cli.mjs"
    echo "  status | logs | start | stop | restart                  服务状态与日志"
    echo "  update [--no-restart]                                   拉新代码、装依赖、重建前端（有新代码再重启）"
    set -- help ;;
esac
as_svc env BRIDGE_DATA_ROOT="\$DATA" PORT='$PORT' BRIDGE_HOST='$HOST' BRIDGE_DEPLOY='$DEPLOY' BRIDGE_CLI='$CTL_HINT' "\$NODE" "\$REPO/src/cli.mjs" "\$@"
CTL
  install -m 0755 "$CTL_PATH.new" "$CTL_PATH"
  rm -f "$CTL_PATH.new"
}

run_ctl() { "$CTL_PATH" "$@"; }

configure_tunnel() {
  # 只在给了 --tunnel-token / --quick-tunnel 时动；令牌写进数据目录的 public-access.json（0600，归服务用户），
  # 服务端启动时按它拉起 cloudflared、探活、断了自愈，控制台「服务控制 → 公网访问」随时能改。
  local PA_MODE=quick PA_TOKEN=""
  if [ -n "$TUNNEL_TOKEN" ]; then
    PA_MODE=token
    # 整条「cloudflared service install eyJ…」粘进来也认：只取令牌本体
    PA_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | grep -oE 'eyJ[A-Za-z0-9+/=_-]{40,}' | head -n 1 || true)"
    [ -n "$PA_TOKEN" ] || PA_TOKEN="$(printf '%s' "$TUNNEL_TOKEN" | tr -d '[:space:]')"
    printf '%s' "$PA_TOKEN" | grep -qE '^[A-Za-z0-9+/=_-]{40,}$' || die "--tunnel-token 不像 Cloudflare 隧道令牌（eyJ 开头的一长串）"
  fi
  say "公网访问：$( [ "$PA_MODE" = token ] && echo 'Cloudflare 命名隧道' || echo '临时地址（trycloudflare）' )，由服务端托管 cloudflared"
  if [ "$MODE" = system ] && ! command -v cloudflared >/dev/null; then
    # 装不上也不要紧：服务端会自己下载固定版本到数据目录（要能连 GitHub）
    local tmp
    tmp="$(mktemp -d)"
    if curl -fsSL -o "$tmp/cloudflared.deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH.deb"; then
      dpkg -i "$tmp/cloudflared.deb" || warn "cloudflared 没装上，服务端启动时会自己下载"
    else warn "cloudflared 下载失败，服务端启动时会自己再试"; fi
    rm -rf "$tmp"
  fi
  # 保留以前在控制台里手填过的对外地址；带 --quick-tunnel 重跑时也保留以前存的命名隧道令牌
  # （同服务端的约定：令牌与手填地址跨模式保留，以后在控制台切回「Cloudflare 隧道」不用回 Cloudflare 后台重新复制）
  local PA_FILE="$DATA/public-access.json" PA_URL=""
  if [ -f "$PA_FILE" ]; then
    PA_URL="$(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PA_FILE" | head -n 1)"
    if [ -z "$PA_TOKEN" ]; then
      PA_TOKEN="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PA_FILE" | head -n 1)"
      printf '%s' "$PA_TOKEN" | grep -qE '^[A-Za-z0-9+/=_-]{40,}$' || PA_TOKEN=""
    fi
  fi
  if [ "$MODE" = system ]; then install -m 0600 -o "$SVC_USER" -g "$SVC_USER" /dev/null "$PA_FILE.new"; else install -m 0600 /dev/null "$PA_FILE.new"; fi
  printf '{\n  "mode": "%s",\n  "token": "%s",\n  "url": "%s"\n}\n' "$PA_MODE" "$PA_TOKEN" "$PA_URL" > "$PA_FILE.new"
  mv -f "$PA_FILE.new" "$PA_FILE"
  # 以前的版本另起过 bridge-tunnel.service：换成服务端托管，免得同一条隧道起两份
  if [ "$MODE" = system ] && [ -f /etc/systemd/system/bridge-tunnel.service ]; then
    systemctl disable --now bridge-tunnel.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/bridge-tunnel.service /etc/bridge/tunnel.env
    say "已停用旧的 bridge-tunnel.service（隧道改由服务端托管）"
  fi
}

# 临时地址要等 cloudflared 向 Cloudflare 申请（十几秒，第一次还可能要先下载 cloudflared）：从这次启动的日志里捞
wait_quick_url() {
  local url="" _ jc
  if [ "$MODE" = system ]; then jc="journalctl -u bridge"; else jc="journalctl --user -u bridge"; fi
  printf '等临时地址' >&2
  for _ in $(seq 1 90); do
    url="$($jc --since "@$START_TS" --no-pager -o cat 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '//api\.' | tail -n 1 || true)"
    [ -n "$url" ] && { echo ' ✓' >&2; break; }
    printf '.' >&2; sleep 1
  done
  [ -n "$url" ] || echo >&2
  printf '%s' "$url"
}

main "$@"
