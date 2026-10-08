#!/usr/bin/env bash
# Muse Bridge · Muse VM 一键部署与运维。给 Muse 的 agent 用，说明书见同目录 MUSE.md。
#
# 安装 / 修复（可以重复跑；不给的选项沿用上次的选择）：
#   bash deploy/muse/bootstrap.sh install [--agents claude|dimensio|claude,dimensio] [--solo|--multi]
#                                         [--domain 主机名 --tunnel-token 令牌] [--claude-token 令牌] [--lang en|zh]
#                                         [--auto-report on|off]
#   --lang：结果块用哪种语言打印（用户不说中文就给 en）；不给沿用上次，默认 zh
#   install / update / set-agents 要跑几分钟：它们自己转到后台（命令工具超时也打断不了），前台最多等 4 分半、
#   只打印进度，完了打印结果块；没等完就运行：
#   wait                            接着等正在跑的安装 / 更新，结束时打印结果块
# 日常：
#   status [--local]                公网地址、版本、各服务与健康状态（--local 不访问公网地址）
#   set-claude-token T              写入 Claude 订阅令牌（claude setup-token 生成）并重启 bridge
#   set-api-key 变量名 值            给 dimensio 填一家模型厂商的 key（如 ANTHROPIC_API_KEY sk-…），顺带放行这家的接口网站
#   allow-sites [网站或地址…]         预先放行要用到的网站（不给参数 = 按现在的配置算）：Muse 弹审核时选「总是允许此站点」
#   set-agents LIST                 改启用的 agent（claude / dimensio / claude,dimensio）
#   set-users solo|multi            只自己用（关注册）/ 多人用（开注册与邀请码）
#   set-domain 主机名 隧道令牌       换成自己域名的固定地址（Cloudflare 命名隧道）
#   use-quick-tunnel                换回 trycloudflare 临时地址
#   reset-token                     重新生成管理员访问令牌（旧令牌作废）
#   set-lang en|zh                  结果块改用英文 / 中文打印
# 更新：
#   check-update                    看发布频道上有没有新版本
#   update [--now] [地址 sha256]     下载新版本、构建好，等没人在聊时再切换（--now 立即切）
#   switch-now                      新版本已装好但在等空闲：不等了，立即切换
#   rollback                        退回上一个版本（立即重启）
#   auto-update on|off              发现新版本时自动更新（默认 off：先问用户）
# 问题反馈（经项目方的反馈服务提交到 GitHub Issues；不含对话、文件、key、地址）：
#   report [描述] [--kind bug|idea|security|docs]   出草稿给用户看（不发）；描述也可以从标准输入给（docs = 说明书没写 / 写错了）
#   report --send 草稿编号            用户同意后发送         report --list   发过的报告
#   feedback-auto on|off|status       出错时自动上报（用户同意过才开）
# 已知问题（更新频道下发，看门狗每 6 小时更新一次）：
#   known-issues [--all]              影响当前版本的已知问题：现象、绕过办法、哪个版本修好了
#
# 这个脚本包住的全是 Muse VM 独有的坑（通用的部分交给 scripts/server/install.sh）：
#   · 出站只能走 hatch-egress-proxy：代理变量自动带上，并带进服务环境
#   · apt 源里有经代理不可达的镜像（会卡住 apt 半小时，且每次开机被平台还原）：先探测，删掉不通的
#   · cloudflared 不认代理、/etc/hosts 只读：两条 socat 中继 + mount namespace 盖 hosts，再起隧道
#   · 重启后平台只保留它自己管的 /etc 文件：单元、env 都在持久目录留规范副本，由看门狗 hook 每分钟自愈
#   · 浏览器沙箱在这里起不来（apparmor 禁了非特权 userns）：不装浏览器，绝不加 --no-sandbox
#
# 版本布局：每个版本解压在 bridge-releases/<时间戳>/bridge，服务单元的 WorkingDirectory 指向 bridge-releases/current
# 这个符号链接。换版本 = 新目录里装好依赖、构建好 → 改链接 → 让 bridge「空闲时重启」（SIGUSR2，等在跑的对话结束）。
# 旧目录留着当回滚点；新版本起不来，看门狗会自动把链接改回去。数据目录（bridge-srv）各版本共用。
set -euo pipefail

PERSIST="${MUSE_PERSIST:-/home/hatch}"
OPS="$PERSIST/bridge-ops"
RELS="$PERSIST/bridge-releases"
DATA="${MUSE_DATA:-$PERSIST/bridge-srv}"
PORT=8787
SVC_USER=bridge
PROXY="${MUSE_PROXY:-http://hatch-egress-proxy:3128}"
EDGE=region1.v2.argotunnel.com
SERVICES="bridge cf-relay-api cf-relay-edge muse-tunnel"
HOOK_DIR="$PERSIST/hooks/scripts"

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m[!] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 跑（Muse 的 shell 一般就是 root；不是的话前面加 sudo -E）"

# 代理：socat 单元要拆成主机 + 端口；本脚本里的 curl / apt / npm 也都走它
PROXY_HOSTPORT="${PROXY#*://}"; PROXY_HOSTPORT="${PROXY_HOSTPORT%%/*}"
PROXY_HOST="${PROXY_HOSTPORT%:*}"; PROXY_PORT="${PROXY_HOSTPORT##*:}"
export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" https_proxy="$PROXY" http_proxy="$PROXY"
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

# 上次的选择存在 muse.env 里；没装过就是空
prev() { ( [ -f "$OPS/muse.env" ] && . "$OPS/muse.env" 2>/dev/null; eval "echo \"\${$1:-}\"" ) || true; }
# 发布频道：一个 latest.json 的地址。包里的 CHANNEL 文件（发版时写入）给默认值，已装过的以 muse.env 为准。
pkg_channel() { grep -vE '^\s*(#|$)' "$HERE/CHANNEL" 2>/dev/null | head -1 | tr -d ' \r' || true; }
CHANNEL="${MUSE_CHANNEL:-$(prev CHANNEL)}"; [ -n "$CHANNEL" ] || CHANNEL="$(pkg_channel)"
AUTO_UPDATE="$(prev AUTO_UPDATE)"; AUTO_UPDATE="${AUTO_UPDATE:-0}"
AGENTS="$(prev AGENTS)"
USERS_MODE="$(prev USERS_MODE)"
TUNNEL_MODE="$(prev TUNNEL_MODE)"; TUNNEL_MODE="${TUNNEL_MODE:-quick}"
PUBLIC_HOSTNAME="$(prev PUBLIC_HOSTNAME)"
UI_LANG="$(prev UI_LANG)"; UI_LANG="${UI_LANG:-zh}"
HOOK_NOTE=""

http_code() { local c; c="$(curl -s -o /dev/null -w '%{http_code}' "$@" || true)"; echo "${c:-000}"; }
public_url() {
  if [ "$TUNNEL_MODE" = named ] && [ -n "$PUBLIC_HOSTNAME" ]; then echo "https://$PUBLIC_HOSTNAME"; return; fi
  # 排除 api.trycloudflare.com：注册失败时它会出现在报错里，不是隧道地址
  # 只看隧道这一次运行的日志：这次注册失败时，别拿上一次运行留下的旧地址冒充
  local inv; inv="$(systemctl show -p InvocationID --value muse-tunnel.service 2>/dev/null || true)"
  journalctl -u muse-tunnel.service ${inv:+_SYSTEMD_INVOCATION_ID=$inv} --no-pager 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -1 || true
}
local_code() { http_code --noproxy '*' --max-time 5 "http://127.0.0.1:$PORT/healthz"; }
# LOCAL_ONLY=1（status --local）：不经代理访问公网地址。Muse 的 worker 经代理访问网站要用户批准网络权限，
# 夜里没人批就超时——看门狗唤醒来排查时只用本机检查，公网结果看门狗事件里已经带了
LOCAL_ONLY=0
public_code() { local u; [ "$LOCAL_ONLY" = 1 ] && { echo "未查（--local）"; return; }; u="$(public_url)"; if [ -n "$u" ]; then http_code --max-time 20 "$u/healthz"; else echo 000; fi; }
version_of() { head -1 "$1/deploy/muse/VERSION" 2>/dev/null || echo unknown; }
svc_states() { local s o=""; for s in $SERVICES; do o+="$s=$(systemctl is-active "$s.service" 2>/dev/null || true) "; done; echo "${o% }"; }
# bridge 进程此刻实际跑在哪个目录（链接改了但还没重启时，跟 current 不一样）。
# 先读 /proc/<pid>/cwd；读不到就用单元启动时 ExecStartPre 记下的「InvocationID + 当时 current 指向的目录」，
# ID 跟 bridge 这一次启动对得上才算数。Muse 的命令环境是没有 CAP_SYS_PTRACE 的 root，读不了别的用户进程的
# /proc/<pid>/cwd（进程本身看得见）——只靠 /proc 的话这里永远是空的，空闲切换、失败回退、rollback 全都失灵。
running_dir() {
  local pid d="" inv line
  pid="$(systemctl show -p MainPID --value bridge.service 2>/dev/null || echo 0)"
  [ "${pid:-0}" -gt 0 ] || return 0
  d="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [ -z "$d" ]; then
    inv="$(systemctl show -p InvocationID --value bridge.service 2>/dev/null || true)"
    line="$(cat "$OPS/running-dir" 2>/dev/null || true)"
    if [ -n "$inv" ] && [ "${line%% *}" = "$inv" ]; then d="${line#* }"; fi
  fi
  [ -z "$d" ] || echo "$d"
}
agents_label() {
  if [ "$UI_LANG" = en ]; then case "$1" in claude) echo 'Claude Code only' ;; dimensio) echo 'dimensio only' ;; *) echo 'Claude Code + dimensio' ;; esac; return; fi
  case "$1" in claude) echo '只有 Claude Code' ;; dimensio) echo '只有 dimensio' ;; *) echo 'Claude Code + dimensio' ;; esac
}
# 服务端自己报告的 agent 名单（验收用：跟用户选的对得上才算装对）
served_agents() { curl -s --noproxy '*' --max-time 5 "http://127.0.0.1:$PORT/api/auth" 2>/dev/null | jq -r '(.agents // []) | join(",")' 2>/dev/null || true; }
# 管理员令牌只在第一次安装 / reset-token 时生成一次。明文暂存在这里（root 0600），直到用户用它登录成功
# （heal.sh 看到管理员会话就删）——免得 Muse 的命令工具超时、没看见结果块，令牌就永远丢了。
TOKEN_PENDING="$OPS/admin-token.pending"

# 放行网站的结果（allow_sites 记下，结果块报没放行的；一行一个「站点 ok|denied|pending」）
SITES_STATUS="$OPS/sites-status"
sites_summary() {   # 没放行 / 被拒的站点，空格分隔；文件不存在（旧版本装的）就什么都不输出
  [ -f "$SITES_STATUS" ] || return 0
  awk '$2 != "ok" { printf "%s%s(%s)", (n++ ? " " : ""), $1, $2 }' "$SITES_STATUS"
}

# 已知问题：发布频道 latest.json 的 known_issues（看门狗读频道时存一份在这里）。每条带受影响版本的提交短哈希（commits），
# 跟装好的版本（VERSION 第一段）按前缀比对。清单的来源和格式见 deploy/muse/known-issues.json
KNOWN="$OPS/known-issues.json"
installed_commit() { version_of "$(readlink -f "$RELS/current" 2>/dev/null || echo /nonexistent)" | cut -d' ' -f1; }
known_affecting() {   # 影响 $1（默认：装好的版本）的已知问题，JSON 数组
  local h="${1:-$(installed_commit)}"
  if [ ! -f "$KNOWN" ] || [ -z "$h" ] || [ "$h" = unknown ]; then echo '[]'; return 0; fi
  jq -c --arg h "$h" '[.[]? | select(any(.commits[]?; . as $c | ($h | startswith($c)) or ($c | startswith($h))))]' "$KNOWN" 2>/dev/null || echo '[]'
}
known_count() { jq 'length' <<<"$(known_affecting)" 2>/dev/null || echo 0; }

# 安卓 app：每个版本的安装包里都带一份（downloads/，服务器自己提供下载），GitHub Release 上也有
APK_GITHUB="https://github.com/Wode44398/muse-bridge/releases/latest/download/MuseBridge.apk"

# 统一的结果块：Muse 原样转给用户；管理员令牌在用户用它登录成功之前一直显示。UI_LANG=en 时整块英文
result_block() {
  local token="${1:-}" url lc pc st run cur served sites claude_ok=0 ok=1 kc=-1
  [ -f "$KNOWN" ] && kc="$(known_count)"
  [ -n "$token" ] || token="$(cat "$TOKEN_PENDING" 2>/dev/null || true)"
  url="$(public_url)"; lc="$(local_code)"; pc="$(public_code)"; served="$(served_agents)"
  run="$(running_dir)"; cur="$(readlink -f "$RELS/current" 2>/dev/null || true)"
  sites="$(sites_summary)"
  { [ "$lc" = 200 ] && { [ "$pc" = 200 ] || [ "$LOCAL_ONLY" = 1 ]; }; } || ok=0
  grep -qE '^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)=.' /etc/bridge/bridge.env 2>/dev/null && claude_ok=1
  if [ "$UI_LANG" = en ]; then
    st="OK"; [ "$ok" = 1 ] || st="PROBLEM (check the lines below against Troubleshooting in MUSE.md)"
    cat <<EOF

==================== MUSE-BRIDGE RESULT ====================
Status          $st
Public URL      ${url:-(not available yet)}$( [ "$TUNNEL_MODE" = named ] && echo ' (your own domain, permanent)' || echo ' (temporary; changes when the VM restarts)')
Admin token     ${token:-(already used to sign in, so it is no longer shown; run reset-token if it is lost)}$( [ -n "$token" ] && echo ' (give it to the user to keep safe; hidden after the first sign-in)')
Agents          $(agents_label "${AGENTS:-claude,dimensio}") (server reports: ${served:-not up yet})
Users           $( [ "$USERS_MODE" = solo ] && echo 'just me (sign-up off)' || echo 'multi-user (invite codes on)')
Android app     $( [ -f "${run:-$cur}/downloads/MuseBridge.apk" ] && echo 'open the public URL in the phone browser -> Settings -> Android app' || echo "download from GitHub: $APK_GITHUB") (tell the user about it)
Version         $( [ -n "$run" ] && version_of "$run" || echo 'not running')$( [ -n "$run" ] && [ -n "$cur" ] && [ "$run" != "$cur" ] && echo " ($(version_of "$cur") is installed; switches when nobody is chatting)")
Services        $(svc_states)
Local health    $lc
Public health   $pc
Claude token    $( [ "$claude_ok" = 1 ] && echo set || echo 'not set (or added in the admin console under Claude accounts)')
Sites           $( [ -f "$SITES_STATUS" ] || echo 'not checked yet (with the user present, run allow-sites once)')$( [ -f "$SITES_STATUS" ] && echo "${sites:-all approved}")$( [ -n "$sites" ] && echo ' -> not approved yet: with the user present, run allow-sites and have them choose "Always allow this site"')
Update channel  ${CHANNEL:-not set (manual updates only)}; auto-update $( [ "$AUTO_UPDATE" = 1 ] && echo on || echo off)
Feedback        $(feedback_auto_label)
Known issues    $(case "$kc" in -1) echo 'not checked yet (the watchdog reads the update channel every 6 hours)' ;; 0) echo 'none affect this version' ;; *) echo "$kc affect this version (run known-issues for symptoms and workarounds)" ;; esac)
Watchdog hook   ${HOOK_NOTE:-script $( [ -f "$HOOK_DIR/bridge-watchdog.sh" ] && echo 'in place' || echo missing)}
============================================================
EOF
    return
  fi
  st="正常"; [ "$ok" = 1 ] || st="有问题（看下面各项，对照 MUSE.md「故障排查」）"
  cat <<EOF

==================== MUSE-BRIDGE 结果 ====================
状态        $st
公网地址    ${url:-（还没拿到）}$( [ "$TUNNEL_MODE" = named ] && echo '（自己的域名，固定不变）' || echo '（临时地址，VM 重启会变）')
管理员令牌  ${token:-（用户已经用它登录过了，这里不再显示；忘了就跑 reset-token）}$( [ -n "$token" ] && echo '（交给用户存好；他用它登录成功后，这里就不再显示）')
agent       $(agents_label "${AGENTS:-claude,dimensio}")（服务端报告：${served:-还没起来}）
使用方式    $( [ "$USERS_MODE" = solo ] && echo '只自己用（注册关闭）' || echo '多人用（可发邀请码）')
安卓 app    $( [ -f "${run:-$cur}/downloads/MuseBridge.apk" ] && echo '手机浏览器打开公网地址 → 设置 → 安卓 app 下载安装' || echo "从 GitHub 下载：$APK_GITHUB")（记得告诉用户有这个）
运行版本    $( [ -n "$run" ] && version_of "$run" || echo 未运行)$( [ -n "$run" ] && [ -n "$cur" ] && [ "$run" != "$cur" ] && echo "（已装好 $(version_of "$cur")，等没人在聊时切换）")
服务        $(svc_states)
本地健康    $lc
公网健康    $pc
Claude 令牌 $( [ "$claude_ok" = 1 ] && echo 已配置 || echo '未配置（也可能已在控制台「Claude 账号」里加过）')
网站放行    $( [ -f "$SITES_STATUS" ] || echo '还没检查过（用户在场时跑一次 allow-sites）')$( [ -f "$SITES_STATUS" ] && echo "${sites:-全部已放行}")$( [ -n "$sites" ] && echo '（还没放行：用户在场时跑 allow-sites，让他选「总是允许此站点」）')
更新频道    ${CHANNEL:-未设置（只能手动给地址更新）}；自动更新 $( [ "$AUTO_UPDATE" = 1 ] && echo 开 || echo 关)
问题反馈    $(feedback_auto_label)
已知问题    $(case "$kc" in -1) echo '还没读到（看门狗每 6 小时读一次更新频道）' ;; 0) echo '没有影响这个版本的' ;; *) echo "$kc 条影响这个版本（跑 known-issues 看现象和绕过办法）" ;; esac)
看门狗 hook ${HOOK_NOTE:-脚本 $( [ -f "$HOOK_DIR/bridge-watchdog.sh" ] && echo 已就位 || echo 缺失)}
==========================================================
EOF
}

# apt：探测每个源地址，删掉经代理不通的（平台每次开机会还原 ubuntu.sources，所以每次装都要做）
# apt 锁被占（开机时平台自己在跑 apt-get update）就排队等：隔 10 秒重试，最多 10 分钟。
# 光靠 DPkg::Lock::Timeout 不行——它管不到 update 用的 lists/lock（实测照样秒失败）
apt_wait() {
  local out rc i
  for i in $(seq 1 60); do
    rc=0; out="$(apt-get "$@" 2>&1)" || rc=$?
    printf '%s\n' "$out"
    [ $rc -eq 0 ] && return 0
    printf '%s' "$out" | grep -q 'Could not get lock\|Unable to lock\|Unable to acquire the dpkg frontend lock' || return $rc
    [ "$i" = 1 ] && say "apt 正被别的进程占着（多半是开机时平台自己在更新），排队等它"
    sleep 10
  done
  return $rc
}

fix_apt_sources() {
  install -d /etc/apt/apt.conf.d
  # DPkg::Lock::Timeout：install 阶段 dpkg 锁被占时排队等（最多 10 分钟）；update 的 lists/lock 它管不到，交给 apt_wait
  printf 'Acquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAcquire::Retries "2";\nDPkg::Lock::Timeout "600";\n' > /etc/apt/apt.conf.d/80bridge-muse
  local f line u alive dead
  for f in /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    while IFS= read -r line; do
      alive=""; dead=""
      for u in ${line#URIs:}; do
        # 000 = 连不上；5xx 多半是代理替不通的上游回的错
        case "$(http_code --max-time 10 "$u")" in [234]??) alive+=" $u" ;; *) dead+=" $u" ;; esac
      done
      if [ -n "$dead" ] && [ -n "$alive" ]; then
        install -d "$OPS/apt-backup"; cp -n "$f" "$OPS/apt-backup/" || true
        sed -i "s|^$line\$|URIs:$alive|" "$f"
        warn "apt 源 $(basename "$f") 删掉了不通的镜像：$dead"
      elif [ -n "$dead" ]; then
        warn "apt 源 $(basename "$f") 的镜像全都不通：$dead（先不动它，apt 可能会慢）"
      fi
    done < <(grep -E '^URIs:' "$f" || true)
  done
}

render() { # 模板里的 @XXX@ 换成真实值
  sed -e "s|@OPS@|$OPS|g" -e "s|@PORT@|$PORT|g" -e "s|@EDGE@|$EDGE|g" \
      -e "s|@PROXY_HOST@|$PROXY_HOST|g" -e "s|@PROXY_PORT@|$PROXY_PORT|g" "$1"
}

write_muse_env() {
  install -d -m 0770 "$OPS"
  cat > "$OPS/muse.env" <<EOF
# bootstrap.sh 生成，heal.sh / cf-wrap.sh / 看门狗都读它（下次 install 会按这里的选择重写）
PERSIST=$PERSIST
OPS=$OPS
RELS=$RELS
DATA=$DATA
PORT=$PORT
SVC_USER=$SVC_USER
EDGE=$EDGE
PROXY=$PROXY
CLOUDFLARED=$(command -v cloudflared || echo /usr/bin/cloudflared)
SERVICES="$SERVICES"
AGENTS=$AGENTS
USERS_MODE=$USERS_MODE
TUNNEL_MODE=$TUNNEL_MODE
PUBLIC_HOSTNAME=$PUBLIC_HOSTNAME
CHANNEL=$CHANNEL
AUTO_UPDATE=$AUTO_UPDATE
UI_LANG=$UI_LANG
EOF
}

# /etc/bridge/bridge.env 里改一个键（值为空 = 删掉这个键），同步持久副本
set_bridge_env() {
  local key="$1" val="$2"
  install -d -m 0750 /etc/bridge; touch /etc/bridge/bridge.env
  { grep -vE "^(# *)?$key=" /etc/bridge/bridge.env || true; if [ -n "$val" ]; then echo "$key=$val"; fi; } > /etc/bridge/bridge.env.new
  install -m 0600 /etc/bridge/bridge.env.new /etc/bridge/bridge.env; rm -f /etc/bridge/bridge.env.new
  install -d -m 0770 "$OPS"; install -m 0600 /etc/bridge/bridge.env "$OPS/bridge.env"
}

# config.json 改一个键（jq 表达式），以服务用户身份写回
edit_config() {
  local expr="$1" f="$DATA/config.json"
  [ -f "$f" ] || die "还没装过（找不到 $f）"
  jq "$expr" "$f" > "$f.new" && chown "$SVC_USER:$SVC_USER" "$f.new" && chmod 600 "$f.new" && mv "$f.new" "$f"
}

# 只保留 current 与上一个版本，更早的解压目录删掉（只动 bridge-releases/<时间戳> 这种目录）
prune_releases() {
  local keep1 keep2 d
  keep1="$(readlink -f "$RELS/current" 2>/dev/null || true)"; keep2="$(cat "$OPS/previous" 2>/dev/null || true)"
  for d in "$RELS"/*/; do
    d="${d%/}"
    [[ "$(basename "$d")" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
    case "$keep1/" in "$d"/*) continue ;; esac
    case "$keep2/" in "$d"/*) continue ;; esac
    rm -rf "$d" && echo "清理旧版本目录 $d"
  done
}

wait_healthy() { # $1 = 期望运行的目录，$2 = 最多等几秒
  local i
  for i in $(seq 1 "$2"); do
    if [ "$(running_dir)" = "$1" ] && [ "$(local_code)" = 200 ]; then return 0; fi
    sleep 1
  done
  return 1
}

# VM 开机后，平台不会马上把 bridge 账号写回 /etc/passwd（实测往往要等 Muse 下一次干活）。不等它：按数据目录的
# 属主 UID/GID 当场补建——UID 跟数据目录对得上，平台之后写回的也是同一个账号。别用新的 UID 建（数据目录会读不了）。
wait_for_account() {
  getent passwd "$SVC_USER" >/dev/null && return 0
  [ -d "$DATA" ] || return 0          # 第一次安装：还没有数据目录，交给 install.sh 新建账号
  local uid gid
  uid="$(stat -c %u "$DATA")"; gid="$(stat -c %g "$DATA")"
  [ "$uid" != 0 ] && [ "$gid" != 0 ] || die "$SVC_USER 账号不在，而且 $DATA 属主是 root、推不出原来的 UID。过几分钟再跑一次 install"
  say "$SVC_USER 账号还没被平台写回来，按数据目录的属主（uid $uid / gid $gid）补建"
  getent group "$SVC_USER" >/dev/null || groupadd --system -g "$gid" "$SVC_USER"
  useradd --system -u "$uid" -g "$gid" --home-dir "$DATA/home" --shell /bin/bash "$SVC_USER"
}

# 让 bridge 用上新配置：now = 立即重启；idle = 等在跑的对话都结束再重启（SIGUSR2）
restart_bridge() {
  if [ "${1:-idle}" = now ] || ! systemctl is-active --quiet bridge.service; then
    systemctl reset-failed bridge.service 2>/dev/null || true
    systemctl restart bridge.service
    printf '等 bridge 起来'; local i; for i in $(seq 1 60); do [ "$(local_code)" = 200 ] && { echo ' ✓'; return 0; }; printf '.'; sleep 1; done
    echo; warn "60 秒内没起来，看日志：journalctl -u bridge -n 100 --no-pager"
  else
    systemctl kill -s SIGUSR2 --kill-whom=main bridge.service
    echo "已通知 bridge：等正在进行的对话结束后自动重启生效（没人在聊的话几秒内就好）。"
  fi
}

# 把 current 链接指向 $1，然后按 $2 切换：now = 立即重启；idle = 通知 bridge 等在跑的对话结束再重启
switch_to() {
  local new="$1" mode="$2" run was
  run="$(running_dir)"
  was="$(readlink -f "$RELS/current" 2>/dev/null || true)"
  ln -sfn "$new" "$RELS/.current.tmp" && mv -Tf "$RELS/.current.tmp" "$RELS/current"
  if [ -n "$run" ] && [ "$run" != "$new" ]; then echo "$run" > "$OPS/previous"
  # 读不到在跑的目录（从还没有 running-dir 记录的旧版本升上来）：按切换前 current 的指向记回退点
  elif [ -z "$run" ] && [ -n "$was" ] && [ "$was" != "$new" ] && [ -f "$was/src/server.mjs" ] \
       && systemctl is-active --quiet bridge.service; then echo "$was" > "$OPS/previous"; fi
  systemctl daemon-reload
  if [ "$mode" = now ] || [ -z "$run" ] || ! systemctl is-active --quiet bridge.service; then
    rm -f "$OPS/pending-switch.json"
    systemctl reset-failed bridge.service 2>/dev/null || true
    systemctl restart bridge.service
    printf '等 bridge 起来'
    if wait_healthy "$new" 60; then echo ' ✓'; prune_releases; return 0; fi
    echo
    # 换版本时起不来，而旧版本还在：当场退回（首次安装没有旧版本可退，只能看日志）
    if [ -n "$run" ] && [ "$run" != "$new" ] && [ -f "$run/src/server.mjs" ]; then
      warn "新版本 60 秒内没起来，退回原来的版本。日志：journalctl -u bridge -n 100 --no-pager"
      journalctl -u bridge.service --no-pager -n 20 2>/dev/null | tail -20 || true
      ln -sfn "$run" "$RELS/.current.tmp" && mv -Tf "$RELS/.current.tmp" "$RELS/current"
      systemctl reset-failed bridge.service 2>/dev/null || true
      systemctl restart bridge.service
      wait_healthy "$run" 60 || true
      die "更新失败，已退回 $(version_of "$run")。把上面的日志给发布者看"
    fi
    warn "60 秒内没起来，看日志：journalctl -u bridge -n 100 --no-pager"
    return 0
  fi
  if [ "$run" = "$new" ]; then restart_bridge idle; return 0; fi   # 同一版本重装：配置/依赖变了，空闲时重启
  jq -n --arg from "$run" --arg to "$new" --arg v "$(version_of "$new")" --arg notes "${UPDATE_NOTES:-}" \
    --argjson at "$(date +%s)" '{from:$from, to:$to, version:$v, notes:$notes, at:$at, fails:0}' > "$OPS/pending-switch.json"
  systemctl kill -s SIGUSR2 --kill-whom=main bridge.service
  printf '新版本已就位，等没人在聊时切换'
  if wait_healthy "$new" 90; then
    echo ' ✓ 已切换'; rm -f "$OPS/pending-switch.json"; prune_releases
  elif [ "$(running_dir)" = "$run" ] && [ "$(local_code)" = 200 ]; then
    echo; echo "还有对话在跑，暂时没切。bridge 会在对话都结束后自己重启到新版本，看门狗会盯着：切换成功、失败自动回滚、或等太久，都会告诉你。"
  else
    # 旧进程已经退了、新版本却起不来：别等看门狗，当场退回
    echo; warn "新版本起不来，退回原来的版本。日志："
    journalctl -u bridge.service --no-pager -n 20 2>/dev/null | tail -20 || true
    rm -f "$OPS/pending-switch.json"
    ln -sfn "$run" "$RELS/.current.tmp" && mv -Tf "$RELS/.current.tmp" "$RELS/current"
    systemctl reset-failed bridge.service 2>/dev/null || true
    systemctl restart bridge.service
    wait_healthy "$run" 60 || true
    die "更新失败，已退回 $(version_of "$run")。把上面的日志给发布者看"
  fi
}

# 隧道单元：隧道通着就不重启——快速隧道一重启就换地址，单元内容的改动等它下次自然重启（VM 重启 / 掉线）再生效；
# force = 一定重启（换了隧道模式、换了令牌）。两条中继可以随时重启：cloudflared 会重连，地址不变。
apply_tunnel() {
  local force="${1:-}" tunnel_ok=0 s changed=""
  [ "$(public_code)" = 200 ] && tunnel_ok=1
  install -d -m 0770 "$OPS/systemd"
  for s in cf-relay-api cf-relay-edge muse-tunnel; do
    render "$HERE/ops/systemd/$s.service" > "$OPS/systemd/$s.service"
    cmp -s "$OPS/systemd/$s.service" "/etc/systemd/system/$s.service" || { cp "$OPS/systemd/$s.service" "/etc/systemd/system/$s.service"; changed+=" $s"; }
  done
  chmod 0660 "$OPS"/systemd/*.service
  # 旧布局（trycloudflare.service）留下的隧道：停掉删掉，免得两条隧道同时跑
  if [ -f /etc/systemd/system/trycloudflare.service ] || [ -f "$OPS/systemd/trycloudflare.service" ]; then
    systemctl disable --now trycloudflare.service >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/trycloudflare.service "$OPS/systemd/trycloudflare.service"
    force=force
  fi
  systemctl daemon-reload
  for s in cf-relay-api cf-relay-edge muse-tunnel; do systemctl enable "$s.service" >/dev/null 2>&1; done
  for s in cf-relay-api cf-relay-edge; do
    case "$changed " in *" $s "*) systemctl restart "$s.service" ;; *) systemctl start "$s.service" ;; esac
  done
  if [ -n "$force" ] || [ "$tunnel_ok" = 0 ]; then systemctl reset-failed muse-tunnel.service 2>/dev/null || true; systemctl restart muse-tunnel.service
  else systemctl start muse-tunnel.service
  fi
}

wait_public() {
  printf '等公网地址'
  local i url=""
  for i in $(seq 1 90); do
    url="$(public_url)"
    if [ -n "$url" ] && [ "$(http_code --max-time 10 "$url/healthz")" = 200 ]; then echo ' ✓'; break; fi
    printf '.'; sleep 2
  done
  echo
  if [ -n "$url" ]; then echo "$url" > "$OPS/public-url"; fi
  return 0
}

# 长活转到后台跑：Muse 的命令工具一超时，前台命令会被整个杀掉，装到一半就烂在那里；让它每半分钟看一次日志，
# 又会给用户弹一串权限申请。所以 install / update / set-agents 把真正的活交给一个脱离终端的子进程（MB_DETACHED=1），
# 前台只等着、只打印进度，超时了再 wait 就能接上。
INSTALL_LOG="$OPS/install-progress.log"
INSTALL_PID="$OPS/install.pid"
INSTALL_RC="$OPS/install.rc"
install_running() { local p; p="$(cat "$INSTALL_PID" 2>/dev/null || true)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
run_detached() {   # 参数 = 要在后台跑的子命令及其参数
  install -d -m 0770 "$OPS"
  if install_running; then echo "已经有一次安装 / 更新在跑了，接着等它："; cmd_wait; return; fi
  rm -f "$INSTALL_RC" "$INSTALL_PID"
  : > "$INSTALL_LOG"; chmod 0600 "$INSTALL_LOG"
  # 第一次安装时运维入口还不存在，先指到这份脚本，提示里的 wait 命令才跑得通（装完会改指 current）
  [ -e "$OPS/bootstrap.sh" ] || ln -sfn "$HERE/bootstrap.sh" "$OPS/bootstrap.sh"
  MB_DETACHED=1 setsid nohup bash "$HERE/bootstrap.sh" "$@" >> "$INSTALL_LOG" 2>&1 < /dev/null &
  local i; for i in $(seq 1 40); do [ -s "$INSTALL_PID" ] && break; sleep 0.25; done
  if [ ! -s "$INSTALL_PID" ]; then echo "后台没能起来。日志："; sed -E 's/\x1b\[[0-9;]*m//g' "$INSTALL_LOG" | tail -30; return 1; fi
  echo "已在后台开始（完整日志 $INSTALL_LOG）。下面最多等 4 分半，只打印进度："
  WAIT_FRESH=1 cmd_wait
}
# 提示用户「接着等」时给哪条命令：运维入口指的就是这份脚本时用短路径；否则（比如从旧版本直接跑新版本的 install，
# 入口还指着不认识 wait 的旧版本）给这份脚本自己的完整路径
self_cmd() {
  if [ "$(readlink -f "$OPS/bootstrap.sh" 2>/dev/null)" = "$HERE/bootstrap.sh" ]; then echo "bash $OPS/bootstrap.sh"
  else echo "bash $HERE/bootstrap.sh"; fi
}
# 后台子进程开头调：登记自己的 PID，退出时留下退出码给 wait
detached_start() { echo "$$" > "$INSTALL_PID"; trap 'echo $? > "$INSTALL_RC"' EXIT; }

cmd_install() {
  # 带 --switch 的是 update / set-agents 在调新版本的 install（它们自己已经在后台了），直接跑
  FROM_SWITCH=0
  case " $* " in
    *" --switch "*) FROM_SWITCH=1 ;;
    *) if [ "${MB_DETACHED:-}" = 1 ]; then detached_start; else run_detached install "$@"; return; fi ;;
  esac
  local claude_token="" mode=now tunnel_token="" domain="" auto_report=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --agents) AGENTS="$2"; shift 2 ;;
      --solo) USERS_MODE=solo; shift ;;
      --multi) USERS_MODE=multi; shift ;;
      --domain) domain="$2"; shift 2 ;;
      --tunnel-token) tunnel_token="$2"; shift 2 ;;
      --claude-token) claude_token="$2"; shift 2 ;;
      --port) PORT="$2"; shift 2 ;;
      --lang) case "$2" in en|zh) UI_LANG="$2" ;; *) die "--lang 只认 en 或 zh" ;; esac; shift 2 ;;
      --auto-report) case "$2" in on|off) auto_report="$2" ;; *) die "--auto-report 只认 on 或 off" ;; esac; shift 2 ;;
      --switch) mode="$2"; shift 2 ;;
      *) die "install 不认识的选项：$1" ;;
    esac
  done
  AGENTS="${AGENTS:-claude,dimensio}"
  USERS_MODE="${USERS_MODE:-multi}"
  if [ -n "$domain" ] || [ -n "$tunnel_token" ]; then
    [ -n "$domain" ] && [ -n "$tunnel_token" ] || die "--domain 和 --tunnel-token 要一起给"
    TUNNEL_MODE=named; PUBLIC_HOSTNAME="${domain#https://}"; PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME%%/*}"
  fi

  say "检查环境"
  grep -q hatch-egress-proxy /etc/hosts || die "这台机器不像 Muse VM（/etc/hosts 里没有 hatch-egress-proxy）。普通 Linux 请直接用 scripts/server/install.sh"
  command -v systemctl >/dev/null || die "没有 systemd"
  [ -d "$PERSIST" ] || die "持久目录 $PERSIST 不存在（可用环境变量 MUSE_PERSIST 指定）"
  case "$REPO/" in "$PERSIST"/*) ;; *) die "代码目录 $REPO 不在持久目录 $PERSIST 下，重启就没了。请解压到 $RELS/ 底下再跑" ;; esac
  curl -s -o /dev/null --max-time 15 https://registry.npmjs.org/ || die "经代理 $PROXY 连不上外网（npm registry），先确认出站代理"
  echo "代码 $REPO（版本 $(version_of "$REPO")）· 数据 $DATA · agent：$(agents_label "$AGENTS") · $( [ "$USERS_MODE" = solo ] && echo 只自己用 || echo 多人用) · 隧道：$( [ "$TUNNEL_MODE" = named ] && echo "自己的域名 $PUBLIC_HOSTNAME" || echo 临时地址)"

  install -d -m 0770 "$OPS" "$OPS/systemd" "$OPS/hooks"
  install -d -m 0755 "$RELS"
  chmod o+x "$PERSIST"
  # 代码目录的上级要能让服务用户穿过去
  local d="$REPO"; while [ "$d" != "$PERSIST" ] && [ "$d" != / ]; do d="$(dirname "$d")"; [ "$d" = "$PERSIST" ] || chmod o+x "$d"; done
  if [ -n "$tunnel_token" ]; then (umask 077; printf 'TUNNEL_TOKEN=%s\n' "$tunnel_token" > "$OPS/tunnel.env"); fi
  if [ "$TUNNEL_MODE" = named ] && [ ! -s "$OPS/tunnel.env" ]; then die "固定域名模式缺隧道令牌：请用 --domain 和 --tunnel-token 一起重跑"; fi

  say "修 apt 源（删掉经代理不通的镜像）"
  fix_apt_sources

  say "装 socat / cloudflared / jq（镜像里一般已经有了）"
  local need=()
  command -v socat >/dev/null || need+=(socat)
  command -v jq >/dev/null || need+=(jq)
  { command -v unshare >/dev/null && command -v setpriv >/dev/null; } || need+=(util-linux)
  if [ ${#need[@]} -gt 0 ]; then apt_wait update -y && DEBIAN_FRONTEND=noninteractive apt_wait install -y --no-install-recommends "${need[@]}"; fi
  if ! command -v cloudflared >/dev/null; then
    local tmp; tmp="$(mktemp -d)"
    curl -fsSL -o "$tmp/cloudflared.deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"
    dpkg -i "$tmp/cloudflared.deb"; rm -rf "$tmp"
  fi

  wait_for_account

  say "跑通用安装脚本 scripts/server/install.sh（装依赖、构建前端，第一次要几分钟；正在跑的服务不动）"
  local raw; raw="$(mktemp /run/bridge-install.XXXXXX)"
  local args=(--port "$PORT" --data "$DATA" --user "$SVC_USER" --agents "$AGENTS" "--$USERS_MODE" --no-restart)
  [ -n "$claude_token" ] && args+=(--claude-token "$claude_token")
  set +e
  # 屏幕 / 进度日志上的访问令牌当场打码（令牌只经结果块交付）。别事后 sed -i 进度日志：那会换掉文件，
  # 后台进程之后的输出就全写进已删除的旧文件里了
  bash "$REPO/scripts/server/install.sh" "${args[@]}" 2>&1 | tee "$raw" | sed -u -E 's/(访问令牌 +)[A-Za-z0-9_-]{16,}/\1<已打码>/'
  local rc=${PIPESTATUS[0]}
  set -e
  local token; token="$(grep -oP '访问令牌\s+\K\S+' "$raw" || true)"
  if [ -n "$token" ]; then (umask 077; printf '%s\n' "$token" > "$TOKEN_PENDING"); fi
  sed -E 's/(访问令牌 +)[A-Za-z0-9_-]{16,}/\1<已打码>/' "$raw" > "$OPS/install-last.log"; rm -f "$raw"
  [ "$rc" = 0 ] || die "install.sh 失败（退出码 $rc），日志 $OPS/install-last.log。正在跑的服务没受影响"

  say "服务单元改成指向 $RELS/current"
  local hint="这台是 Muse 部署：在 Muse 里说「更新 bridge」，或运行 bash $OPS/bootstrap.sh update"
  sed -i -e "s|^WorkingDirectory=.*|WorkingDirectory=$RELS/current|" \
         -e '/^Environment=BRIDGE_UPDATE_HINT=/d' \
         -e "/^Environment=BRIDGE_SUPERVISED=/a Environment=BRIDGE_UPDATE_HINT=$hint" /etc/systemd/system/bridge.service
  # 每次启动（含 bridge 空闲自重启后 systemd 拉起）都记一笔「这次启动的 InvocationID + 当时 current 指向的目录」，
  # 给 running_dir 在读不了 /proc/<pid>/cwd 的环境里用。「+」= 以 root 跑（写 bridge-ops）；「$$」= 交给 sh 的字面 $
  local pre="ExecStartPre=+/bin/sh -c 'echo \"\$\$INVOCATION_ID \$\$(readlink -f $RELS/current)\" > $OPS/running-dir'"
  sed -i '/^ExecStartPre=.*running-dir/d' /etc/systemd/system/bridge.service
  PRE="$pre" awk '{ print } /^WorkingDirectory=/ { print ENVIRON["PRE"] }' /etc/systemd/system/bridge.service > /etc/systemd/system/bridge.service.new
  mv -f /etc/systemd/system/bridge.service.new /etc/systemd/system/bridge.service
  cp /etc/systemd/system/bridge.service "$OPS/systemd/bridge.service"
  # 固定域名：分享链接用完整地址；临时地址：不写（前端按当前地址拼）
  if [ "$TUNNEL_MODE" = named ]; then set_bridge_env BRIDGE_PUBLIC_ORIGIN "https://$PUBLIC_HOSTNAME"; else set_bridge_env BRIDGE_PUBLIC_ORIGIN ""; fi
  # Claude Code 的遥测 / 错误上报（datadoghq.com、sentry 等）在这台 VM 上每个站点都要用户批一次审核卡，
  # 用户看到「允许 Muse 与 http-intake.logs…datadoghq.com 分享信息？」只会困惑。关掉这些非必要流量
  set_bridge_env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 1

  say "装隧道与运维件到 $OPS"
  write_muse_env
  install -m 0770 "$HERE/ops/cf-wrap.sh" "$OPS/cf-wrap.sh"
  install -m 0770 "$HERE/ops/heal.sh" "$OPS/heal.sh"
  ln -sfn "$RELS/current/deploy/muse/bootstrap.sh" "$OPS/bootstrap.sh"   # 永远跟着当前版本
  cp "$HERE/MUSE.md" "$OPS/MUSE.md"
  # 使用说明书（Muse 回答「怎么用」的依据）：整份换新，旧版本的章节不留
  if [ -d "$HERE/guide" ]; then
    rm -rf "$OPS/guide.new" && cp -r "$HERE/guide" "$OPS/guide.new" && rm -rf "$OPS/guide" && mv "$OPS/guide.new" "$OPS/guide"
  fi
  # hosts：以平台当前的 /etc/hosts 为底，把 cloudflare 的域名指到本机中继
  { grep -vE 'trycloudflare\.com|argotunnel\.com|bridge-muse' /etc/hosts
    echo "# --- bridge-muse：cloudflared 经本机 socat 中继出站 ---"
    echo "127.0.0.1 api.trycloudflare.com"
    echo "127.0.0.1 region1.v2.argotunnel.com region2.v2.argotunnel.com"; } > "$OPS/hosts"
  chmod 0644 "$OPS/hosts"
  apply_tunnel "$( [ -n "$tunnel_token" ] && echo force )"

  say "装看门狗 hook 脚本（注册在 Muse 里做，见 MUSE.md）"
  install -d "$HOOK_DIR"
  render "$HERE/ops/hooks/bridge-watchdog.sh" > "$HOOK_DIR/bridge-watchdog.sh"; chmod 0770 "$HOOK_DIR/bridge-watchdog.sh"
  cp "$HOOK_DIR/bridge-watchdog.sh" "$OPS/hooks/"
  local hj="$OPS/hooks/bridge-watchdog.json" new_hj; new_hj="$(render "$HERE/ops/hooks/bridge-watchdog.json")"
  if [ "$UI_LANG" = en ]; then
    if [ ! -f "$hj" ]; then HOOK_NOTE="new install: register and enable it with the hooks tool, using $hj"
    elif [ "$new_hj" != "$(cat "$hj")" ]; then HOOK_NOTE="definition changed: update bridge-watchdog with the hooks tool, using $hj (the script is already replaced)"
    else HOOK_NOTE="definition unchanged, script replaced, nothing to do"; fi
  elif [ ! -f "$hj" ]; then HOOK_NOTE="新装：请用 hooks 工具按 $hj 注册并启用"
  elif [ "$new_hj" != "$(cat "$hj")" ]; then HOOK_NOTE="定义变了：请用 hooks 工具按 $hj 更新 bridge-watchdog（脚本已自动换新）"
  else HOOK_NOTE="定义没变，脚本已换新，不用动"; fi
  printf '%s\n' "$new_hj" > "$hj"
  printf '%s\n' "$HOOK_NOTE" > "$OPS/last-hook-note"
  bash "$OPS/heal.sh" >/dev/null || true

  say "切换到这个版本（$( [ "$mode" = idle ] && echo 等没人在聊时 || echo 立即)）"
  switch_to "$REPO" "$mode"
  wait_public
  # 用户自己跑的安装（不是 update / set-agents 调进来的）才放行：自动更新多在夜里，没人批，白等
  # 用户在开工前答过「出错时要不要自动上报」：记进服务端的反馈设置（网页设置 → 反馈里也能改）
  if [ -n "$auto_report" ]; then feedback_cli auto "$auto_report" || warn "自动上报的设置没写成，之后可以用 feedback-auto $auto_report 再设"; fi
  [ "$FROM_SWITCH" = 1 ] || ALLOW_WAIT=120 allow_sites || true
  say "完成"
}

cmd_status() { [ "${1:-}" = --local ] && LOCAL_ONLY=1; result_block ""; }

# 等后台的安装 / 更新结束：只打印进度（每一步一行），最多等 $1 秒（默认 270），结束时打印结果块
cmd_wait() {
  local max="${1:-270}" start=$SECONDS shown=0
  steps() {   # 把还没打印过的步骤打出来
    local all n; all="$(grep -a '==> ' "$INSTALL_LOG" 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g; s/^==> //' || true)"
    n="$(printf '%s' "$all" | grep -c '' || true)"
    if [ "${n:-0}" -gt "$shown" ]; then
      printf '%s\n' "$all" | tail -n +"$((shown + 1))" | sed "s/^/[$((SECONDS - start)) 秒] /"
      shown="$n"
    fi
  }
  if ! install_running && [ ! -f "$INSTALL_RC" ]; then echo "现在没有在跑的安装 / 更新。"; result_block ""; return 0; fi
  # 接着等上一次没等完的：之前打印过的步骤不再重复，只说现在做到哪一步
  if [ -z "${WAIT_FRESH:-}" ]; then shown="$(grep -ac '==> ' "$INSTALL_LOG" 2>/dev/null || true)"; shown="${shown:-0}"; fi
  if [ -z "${WAIT_FRESH:-}" ] && [ "$shown" -gt 0 ] && install_running; then
    echo "（接着上次等）现在在：$(grep -a '==> ' "$INSTALL_LOG" | tail -1 | sed -E 's/\x1b\[[0-9;]*m//g; s/^==> //')"
  fi
  while install_running; do
    steps
    if [ $((SECONDS - start)) -ge "$max" ]; then
      echo "还在后台跑，没出错（已经等了 $((SECONDS - start)) 秒）。接着等就运行：$(self_cmd) wait"
      return 0
    fi
    sleep 5
  done
  steps
  local rc; rc="$(cat "$INSTALL_RC" 2>/dev/null || echo 1)"
  rm -f "$INSTALL_PID"
  if [ "$rc" = 0 ]; then
    HOOK_NOTE="$(cat "$OPS/last-hook-note" 2>/dev/null || true)"
    # 第一次安装时本进程启动那会儿 muse.env 还不存在：后台装完后重读一遍用户的选择，结果块才不会按默认值乱报
    AGENTS="$(prev AGENTS)"; USERS_MODE="$(prev USERS_MODE)"; UI_LANG="$(prev UI_LANG)"; UI_LANG="${UI_LANG:-zh}"
    TUNNEL_MODE="$(prev TUNNEL_MODE)"; TUNNEL_MODE="${TUNNEL_MODE:-quick}"; PUBLIC_HOSTNAME="$(prev PUBLIC_HOSTNAME)"
    result_block ""
  else
    echo "安装失败（退出码 $rc）。日志最后 40 行："
    tail -40 "$INSTALL_LOG" | sed -E 's/\x1b\[[0-9;]*m//g'
    return "$rc"
  fi
}

# 以当前版本重跑 install（换 agent / 装 dimensio 依赖用），完了空闲时重启
reinstall_current() {
  local cur; cur="$(readlink -f "$RELS/current" 2>/dev/null || true)"
  [ -n "$cur" ] && [ -f "$cur/deploy/muse/bootstrap.sh" ] || die "还没装过，先跑 install"
  bash "$cur/deploy/muse/bootstrap.sh" install --switch idle "$@"
}

cmd_set_agents() {
  case "${1:-}" in claude|dimensio|claude,dimensio|dimensio,claude) ;; *) die "用法：set-agents claude | dimensio | claude,dimensio" ;; esac
  if [ "${MB_DETACHED:-}" != 1 ]; then run_detached set-agents "$@"; return; fi
  detached_start
  say "改装 agent：$(agents_label "$1")"
  reinstall_current --agents "$1"
}

cmd_set_users() {
  case "${1:-}" in solo|multi) ;; *) die "用法：set-users solo | multi" ;; esac
  USERS_MODE="$1"; write_muse_env
  edit_config ".features = ((.features // {}) + {multiUser: $( [ "$1" = multi ] && echo true || echo false )})"
  echo "已改成：$( [ "$1" = solo ] && echo '只自己用（注册与邀请码关闭）' || echo '多人用（可以发邀请码、开放注册）')"
  restart_bridge idle
}

# —— 预先放行要用到的网站 ——
# Muse 的出站代理按网站要用户批准（卡片「允许 Muse 与 X 分享信息？」）。服务在后台第一次访问某家模型接口时弹卡、
# 没人批就一直卡着（对话停在「等待模型回复」）。平台不许预先声明白名单，Muse 自己也没有权限替用户批；
# 唯一办法是用户在卡片上选「总是允许此站点」（覆盖该域名及全部子域，之后服务的请求也不再问——实测过）。
# 所以在用户在场的时候（配置 key、装完、换域名）由这里挨个访问一遍，把卡片一张一张弹出来让他批掉。
site_of() { local u="${1#*://}"; u="${u%%/*}"; u="${u%%:*}"; echo "$u"; }
# 某个 key 对应的接口站点（跟 harness/server/config.ts 的默认地址一致；.env 里写了 *_BASE_URL 就用它）
key_site() {
  local name="$1" val="${2:-}" env="$DATA/dimensio/.env" base=""
  env_get() { { grep -E "^$1=" "$env" 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }   # 没写这项不算错（pipefail）
  case "$name" in
    ANTHROPIC_API_KEY) echo api.anthropic.com ;;
    OPENAI_API_KEY|DEEPSEEK_API_KEY) base="$(env_get OPENAI_BASE_URL)"; site_of "${base:-https://api.deepseek.com}" ;;
    QWEN_API_KEY) base="$(env_get QWEN_BASE_URL)"; site_of "${base:-https://dashscope.aliyuncs.com}" ;;
    ZHIPU_API_KEY) base="$(env_get ZHIPU_BASE_URL)"; site_of "${base:-https://open.bigmodel.cn}" ;;
    KIMI_API_KEY) base="$(env_get KIMI_BASE_URL)"; site_of "${base:-https://api.kimi.com}" ;;
    GEMINI_API_KEY) base="$(env_get GEMINI_BASE_URL)"; site_of "${base:-https://generativelanguage.googleapis.com}" ;;
    MIMO_API_KEY) base="$(env_get MIMO_BASE_URL)"
      if [ -n "$base" ]; then site_of "$base"
      elif [ "${val#tp-}" != "$val" ]; then echo token-plan-cn.xiaomimimo.com
      else echo api.xiaomimimo.com; fi ;;
    MIMO_SEARCH_API_KEY) base="$(env_get MIMO_SEARCH_BASE_URL)"; site_of "${base:-https://api.xiaomimimo.com}" ;;
  esac
}
# 按现在的配置算出要放行的站点：启用的 agent、已填的 key、自定义模型服务
configured_sites() {
  local env="$DATA/dimensio/.env" line name val cp="$DATA/dimensio/custom-providers/providers.json"
  case ",${AGENTS:-claude,dimensio}," in *,claude,*) echo api.anthropic.com ;; esac
  case ",${AGENTS:-claude,dimensio}," in *,dimensio,*) echo html.duckduckgo.com ;; esac   # dimensio 的联网搜索兜底
  # 问题反馈的提交通道：装的时候就放行，用户报问题时才不用再批一张卡
  [ -z "$FEEDBACK_HOST_DEFAULT" ] || echo "$FEEDBACK_HOST_DEFAULT"
  if [ -f "$env" ]; then
    while IFS= read -r line; do
      name="${line%%=*}"; val="${line#*=}"
      [ -n "$val" ] && [[ "$name" =~ _API_KEY$ ]] && key_site "$name" "$val"
    done < "$env"
  fi
  [ -f "$cp" ] && jq -r '.providers[]?.baseUrl // empty' "$cp" 2>/dev/null | while IFS= read -r u; do site_of "$u"; done
  return 0
}
# $@ = 站点或网址；不给就按配置算。每个站点经代理访问一次：已放行的立刻过，没放行的会停住等用户在 Muse 里批
allow_sites() {
  local wait="${ALLOW_WAIT:-180}" s r conn code sites=()
  if [ $# -gt 0 ]; then for s in "$@"; do sites+=("$(site_of "$s")"); done
  else mapfile -t sites < <(configured_sites); fi
  mapfile -t sites < <(printf '%s\n' "${sites[@]}" | grep -v '^$' | awk '!seen[$0]++')
  [ ${#sites[@]} -gt 0 ] || { echo "没有要放行的网站。"; return 0; }
  # 卡片可能出现在输入框上方，也可能在右侧「待审核 / Needs review」面板里（后台跑的安装触发的多半在那里）
  say "放行要用到的网站（${#sites[@]} 个）：Muse 弹出「允许 Muse 与 … 分享信息？」时（输入框上方或右侧「待审核」面板），请选下拉里的「总是允许此站点」"
  for s in "${sites[@]}"; do
    r="$(curl -s -o /dev/null -x "$PROXY" --max-time "$wait" -w '%{http_connect} %{http_code}' "https://$s/" 2>/dev/null || true)"
    conn="${r%% *}"; code="${r##* }"
    # 以代理对 CONNECT 的答复为准：200 = 放行了（之后网站本身回不回、证书对不对是另一回事），403 = 拒绝，没答复 = 在等审核
    if [ "$conn" = 200 ] && [ -n "$code" ] && [ "$code" != 000 ]; then echo "  ✓ $s 已放行"; site_mark "$s" ok
    elif [ "$conn" = 200 ]; then echo "  ✓ $s 已放行（但网站本身没正常响应，检查一下地址对不对）"; site_mark "$s" ok
    elif [ "$conn" = 403 ]; then echo "  ✗ $s 被拒绝（之后用到它的功能会失败；想放行就在 Muse 设置 → 权限 → 网站里改，或重跑这条命令再批）"; site_mark "$s" denied
    else echo "  … $s 没等到批准（${wait} 秒）。之后第一次用到时还会弹审核、对话会停在「等待模型回复」；用户在场时重跑：bash $OPS/bootstrap.sh allow-sites $s"; site_mark "$s" pending; fi
  done
}
# 记下某站点的放行结果（同一站点只留最新一条），给结果块的「网站放行」一行用
site_mark() {
  install -d -m 0770 "$OPS"
  { grep -v "^$1 " "$SITES_STATUS" 2>/dev/null || true; echo "$1 $2"; } > "$SITES_STATUS.new"
  mv -f "$SITES_STATUS.new" "$SITES_STATUS"
}
cmd_allow_sites() { allow_sites "$@"; }
cmd_set_lang() {
  case "${1:-}" in en|zh) UI_LANG="$1" ;; *) die "用法：set-lang en|zh" ;; esac
  [ -f "$OPS/muse.env" ] || die "还没装过，先跑 install"
  write_muse_env; result_block ""
}

cmd_set_api_key() {
  local key="${1:-}" val="${2:-}" f="$DATA/dimensio/.env"
  # MIMO_SEARCH_API_KEY：小米搜索专用的按量付费 key（Token Plan 的 tp- key 用不了联网插件）
  [[ "$key" =~ ^(ANTHROPIC|OPENAI|GEMINI|ZHIPU|KIMI|QWEN|MIMO|MIMO_SEARCH|DEEPSEEK)_API_KEY$ ]] || die "用法：set-api-key <ANTHROPIC|OPENAI|GEMINI|ZHIPU|KIMI|QWEN|MIMO|MIMO_SEARCH|DEEPSEEK>_API_KEY <值>（值为空 = 删掉）"
  # dimensio 里 DeepSeek 这一家读的是 OPENAI_API_KEY（目录里 id=openai、地址 api.deepseek.com），DEEPSEEK_API_KEY 它不认
  [ "$key" = DEEPSEEK_API_KEY ] && key=OPENAI_API_KEY
  install -d -o "$SVC_USER" -g "$SVC_USER" "$DATA/dimensio"; touch "$f"
  { grep -vE "^$key=" "$f" || true; if [ -n "$val" ]; then echo "$key=$val"; fi; } > "$f.new"
  install -m 0600 -o "$SVC_USER" -g "$SVC_USER" "$f.new" "$f"; rm -f "$f.new"
  if [ -n "$val" ]; then echo "已写入 $key（末 4 位 …${val: -4}）"; else echo "已删除 $key"; fi
  restart_bridge idle
  [ -z "$val" ] || allow_sites "$(key_site "$key" "$val")"
}

cmd_set_domain() {
  local host="${1:-}" tok="${2:-}"
  [ -n "$host" ] && [ -n "$tok" ] || die "用法：set-domain <主机名，如 bridge.example.com> <Cloudflare 隧道令牌>"
  [ -f "$OPS/muse.env" ] || die "还没装过，先跑 install"
  TUNNEL_MODE=named; PUBLIC_HOSTNAME="${host#https://}"; PUBLIC_HOSTNAME="${PUBLIC_HOSTNAME%%/*}"
  (umask 077; printf 'TUNNEL_TOKEN=%s\n' "$tok" > "$OPS/tunnel.env")
  write_muse_env
  set_bridge_env BRIDGE_PUBLIC_ORIGIN "https://$PUBLIC_HOSTNAME"
  apply_tunnel force
  restart_bridge idle
  wait_public
  result_block ""
}

cmd_use_quick_tunnel() {
  [ -f "$OPS/muse.env" ] || die "还没装过，先跑 install"
  TUNNEL_MODE=quick; PUBLIC_HOSTNAME=""
  rm -f "$OPS/tunnel.env"
  write_muse_env
  set_bridge_env BRIDGE_PUBLIC_ORIGIN ""
  apply_tunnel force
  restart_bridge idle
  wait_public
  result_block ""
}

# 读发布频道：latest.json 放进全局 MJ，字段用 mf '.commit' 这样取
MJ=""
fetch_channel() {
  [ -n "$CHANNEL" ] || die "没有设置更新频道：请让用户提供新版本的下载地址和 sha256，用 update <地址> <sha256>"
  MJ="$(curl -fsSL --max-time 30 "$CHANNEL")" || die "读不到更新频道 $CHANNEL"
  jq -e '.commit and .url and .sha256' >/dev/null <<<"$MJ" || die "更新频道的内容不对（缺 commit / url / sha256）"
}
mf() { jq -r "$1 // \"\"" <<<"$MJ"; }

cmd_check_update() {
  local cur; cur="$(version_of "$(readlink -f "$RELS/current" 2>/dev/null || running_dir)")"
  fetch_channel
  echo "当前版本  $cur"
  echo "最新版本  $(mf .version)"
  if [ "${cur%% *}" = "$(mf .commit)" ]; then echo "已经是最新"; else printf '更新内容\n%s\n' "$(mf .notes)"; fi
}

cmd_update() {
  if [ "${MB_DETACHED:-}" != 1 ]; then run_detached update "$@"; return; fi
  detached_start
  local mode=idle url="" sum=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --now) mode=now; shift ;;
      *) if [ -z "$url" ]; then url="$1"; else sum="$1"; fi; shift ;;
    esac
  done
  if [ -z "$url" ]; then
    fetch_channel
    local cur; cur="$(version_of "$(readlink -f "$RELS/current" 2>/dev/null || true)")"
    if [ "${cur%% *}" = "$(mf .commit)" ]; then
      say "已经是最新（$(mf .version)）"
      if [ "$mode" = now ] && [ "$(running_dir)" != "$(readlink -f "$RELS/current")" ]; then switch_to "$(readlink -f "$RELS/current")" now; fi
      return
    fi
    url="$(mf .url)"; sum="$(mf .sha256)"; UPDATE_NOTES="$(mf .notes)"; export UPDATE_NOTES
    say "更新 $cur → $(mf .version)"
    # 更新说明打出来：Muse 切换完成后据此告诉用户变了什么、问要不要带他试新功能
    [ -z "$UPDATE_NOTES" ] || printf '更新内容：\n%s\n' "$UPDATE_NOTES"
  fi
  [ -n "$sum" ] || die "用法：update [--now] [<下载地址> <sha256>]"
  local name tmp new
  name="$(date +%Y%m%d-%H%M%S)"
  install -d -m 0755 "$RELS"; tmp="$RELS/.$name.tgz"
  say "下载 $url"
  curl -fL --retry 3 -o "$tmp" "$url"
  echo "$sum  $tmp" | sha256sum -c - || { rm -f "$tmp"; die "sha256 对不上，已删除下载的文件"; }
  install -d -m 0755 "$RELS/$name"
  tar -xzf "$tmp" -C "$RELS/$name"; rm -f "$tmp"
  new="$(find "$RELS/$name" -maxdepth 4 -path '*/deploy/muse/bootstrap.sh' | head -1)"
  [ -n "$new" ] || { rm -rf "${RELS:?}/$name"; die "包里找不到 deploy/muse/bootstrap.sh"; }
  new="$(cd "$(dirname "$new")/../.." && pwd)"
  say "用新版本自己的 bootstrap 安装：$new（沿用现在的 agent、使用方式与隧道设置）"
  bash "$new/deploy/muse/bootstrap.sh" install --switch "$mode"
}

# 新版本已装好、还在等空闲：不等了，立即切（会打断在跑的对话）
cmd_switch_now() {
  local cur; cur="$(readlink -f "$RELS/current" 2>/dev/null || true)"
  [ -n "$cur" ] || die "还没装过"
  if [ "$(running_dir)" = "$cur" ]; then echo "已经在跑 $(version_of "$cur")，不用切"; result_block ""; return; fi
  echo "立即切换到 $(version_of "$cur")"
  switch_to "$cur" now
  result_block ""
}

cmd_rollback() {
  local prev run; prev="$(cat "$OPS/previous" 2>/dev/null || true)"; run="$(running_dir)"
  [ -n "$prev" ] && [ -f "$prev/src/server.mjs" ] || die "没有可回退的上一个版本（$OPS/previous 为空或目录已删）"
  echo "回退 $(version_of "${run:-$(readlink -f "$RELS/current")}") → $(version_of "$prev")"
  switch_to "$prev" now
  result_block ""
}

cmd_auto_update() {
  case "${1:-}" in on) AUTO_UPDATE=1 ;; off) AUTO_UPDATE=0 ;; *) die "用法：auto-update on|off" ;; esac
  [ -f "$OPS/muse.env" ] || die "还没装过，先跑 install"
  write_muse_env
  if [ "$AUTO_UPDATE" = 1 ]; then echo "自动更新已打开：看门狗发现新版本会自己下载构建，等没人在聊时切换，完成后告诉用户"
  else echo "自动更新已关闭：发现新版本时先问用户"; fi
}

cmd_set_claude_token() {
  local t="${1:-}"; [ -n "$t" ] || die "用法：bootstrap.sh set-claude-token <claude setup-token 生成的令牌>"
  set_bridge_env CLAUDE_CODE_OAUTH_TOKEN "$t"
  # 控制台「Claude 账号」里的当前账号要是存了令牌，它会盖过上面这个环境变量（每次对话都按当前账号注入）——
  # 比如装的时候带过 --claude-token，那个令牌就被存进了默认账号。一并换成新令牌，免得这条命令白跑
  local f="$DATA/config.json"
  if [ -f "$f" ] && jq -e '[(.claudeAccounts // [])[] | select((.token // "") != "")] | length > 0' "$f" >/dev/null 2>&1; then
    jq --arg t "$t" '(.claudeActiveAccount // .claudeAccounts[0].id) as $a
      | .claudeAccounts |= map(if .id == $a and (.token // "") != "" then .token = $t else . end)' "$f" > "$f.new" \
      && chown "$SVC_USER:$SVC_USER" "$f.new" && chmod 600 "$f.new" && mv "$f.new" "$f" \
      && echo "控制台「Claude 账号」里的当前账号也换成了这个令牌"
  fi
  echo "已写入（令牌末 4 位 …${t: -4}）"
  restart_bridge now
  result_block ""
}

cmd_reset_token() {
  local out code
  code="$(running_dir)"; [ -n "$code" ] || code="$(readlink -f "$RELS/current")"
  out="$(runuser -u "$SVC_USER" -- env HOME="$DATA/home" BRIDGE_DATA_ROOT="$DATA" "$(command -v node)" "$code/src/gen-token.mjs" --hash)"
  restart_bridge now
  (umask 077; echo "$out" | sed -n 2p > "$TOKEN_PENDING")
  echo "已生成新的管理员访问令牌，旧令牌和所有已登录的管理员会话都作废了。"
  result_block ""
}

# —— 问题反馈 ——
# 报告由服务端的 src/feedback/cli.mjs 出草稿、发送（跟网页里的「报告问题」同一套：白名单收集、脱敏、
# 经项目方的反馈服务提交到 GitHub）。这里只负责把 Muse 这边才知道的东西（服务状态、网站放行、隧道模式、
# 更新日志）交给它，并以服务用户身份跑（跟服务进程共用数据目录）。
FEEDBACK_HOST_DEFAULT="$(grep -ohE 'https://[a-z0-9.-]+\.workers\.dev' "$REPO/src/feedback/report.mjs" 2>/dev/null | head -1 | sed 's|https://||' || true)"
feedback_cli() {
  local code origin
  code="$(readlink -f "$RELS/current" 2>/dev/null || true)"
  [ -f "$code/src/feedback/cli.mjs" ] || code="$REPO"
  [ -f "$code/src/feedback/cli.mjs" ] || die "这个版本还没有问题反馈功能（找不到 src/feedback/cli.mjs），先更新"
  origin="$(grep -E '^BRIDGE_PUBLIC_ORIGIN=' /etc/bridge/bridge.env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  runuser -u "$SVC_USER" -- env HOME="$DATA/home" BRIDGE_DATA_ROOT="$DATA" UI_LANG="$UI_LANG" \
    HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" NO_PROXY=127.0.0.1,localhost BRIDGE_PUBLIC_ORIGIN="$origin" \
    MB_OPS_CMD="bash $OPS/bootstrap.sh" ${MUSE_FEEDBACK_URL:+MUSE_FEEDBACK_URL="$MUSE_FEEDBACK_URL"} \
    "$(command -v node)" "$code/src/feedback/cli.mjs" "$@"
}
feedback_auto_label() {
  local a; a="$(jq -r 'if .auto == true then "on" elif .auto == false then "off" else "unset" end' "$DATA/feedback/settings.json" 2>/dev/null || echo unset)"
  if [ "$UI_LANG" = en ]; then case "$a" in on) echo 'auto-report on' ;; off) echo 'auto-report off' ;; *) echo 'auto-report not asked yet (off)' ;; esac; return; fi
  case "$a" in on) echo '自动上报 开' ;; off) echo '自动上报 关' ;; *) echo '自动上报 还没问过用户（按关处理）' ;; esac
}

# report [描述…] [--kind bug|idea|security] [--title 标题]   出草稿（不发），打印预览和草稿编号
#   描述里有引号、$ 之类时用标准输入给：bootstrap.sh report <<'EOF' … EOF
# report --send 编号      用户同意后发送
# report --list           发过的报告
# report --auto --kind update_failed --title …   看门狗用：用户事先同意过自动上报才发
cmd_report() {
  local kind=bug desc="" send="" auto=0 title="" a
  while [ $# -gt 0 ]; do
    case "$1" in
      --send) send="${2:-}"; shift 2 || shift ;;
      --kind) kind="${2:-}"; shift 2 || shift ;;
      --title) title="${2:-}"; shift 2 || shift ;;
      --auto) auto=1; shift ;;
      --list) feedback_cli list; return ;;
      *) desc+="${desc:+ }$1"; shift ;;
    esac
  done
  [ -f "$OPS/muse.env" ] || die "还没装过，先跑 install"
  if [ -n "$send" ]; then feedback_cli send "$send"; return; fi
  case "$kind" in bug|idea|security|docs|update_failed|crash) ;; *) die "--kind 只认 bug / idea / security / docs / update_failed" ;; esac
  if [ -z "$desc" ] && [ ! -t 0 ] && [ "$auto" = 0 ]; then desc="$(cat)"; fi
  # 服务状态：本机能查的都查（公网健康不经代理访问——那要用户批网络权限；用看门狗上一轮记下的结果）
  local svc="{}" s st pub
  for s in $SERVICES; do svc="$(jq -c --arg k "$s" --arg v "$(systemctl is-active "$s.service" 2>/dev/null || true)" '.[$k] = $v' <<<"$svc")"; done
  svc="$(jq -c --arg v "$( [ "$(local_code)" = 200 ] && echo ok || echo "http $(local_code)")" '.local_health = $v' <<<"$svc")"
  pub="$(jq -r '.public_healthz // empty' "$PERSIST/hooks/state/bridge-watchdog.json" 2>/dev/null || true)"
  [ -z "$pub" ] || svc="$(jq -c --arg v "$pub" '.public_health = $v' <<<"$svc")"
  local sites="[]"
  [ -f "$SITES_STATUS" ] && sites="$(awk '{ printf "%s{\"host\":\"%s\",\"state\":\"%s\"}", (n++ ? "," : "["), $1, $2 } END { if (!n) printf "["; printf "]" }' "$SITES_STATUS")"
  # 更新失败：附上安装 / 服务日志里像报错的行（再由命令行脱敏、截短）
  local logs="[]"
  if [ "$kind" = update_failed ]; then
    logs="$( { sed -E 's/\x1b\[[0-9;]*m//g' "$INSTALL_LOG" 2>/dev/null | tail -200; journalctl -u bridge.service --no-pager -n 120 2>/dev/null; } \
      | grep -aE 'Error|ERR!|error:|failed|FAIL|\[x\]|exit code|status=' | tail -20 | jq -R . | jq -sc . || echo '[]')"
  fi
  local input; input="$(mktemp /tmp/mb-report.XXXXXX)"
  jq -n --arg kind "$kind" --arg desc "$desc" --arg title "$title" --arg src "$( [ "$auto" = 1 ] && echo auto || echo muse)" \
    --arg lang "$UI_LANG" --arg agents "${AGENTS:-claude,dimensio}" --arg users "${USERS_MODE:-multi}" --arg tunnel "$TUNNEL_MODE" \
    --argjson au "$( [ "$AUTO_UPDATE" = 1 ] && echo true || echo false )" --argjson svc "$svc" --argjson sites "$sites" --argjson logs "$logs" \
    '{kind:$kind, source:$src, description:$desc, title:$title, lang:$lang, services:$svc, sites:$sites, logs:$logs,
      env:{agents:($agents|split(",")), users:$users, tunnel:$tunnel, autoUpdate:$au, uiLang:$lang}}' > "$input"
  chmod 0644 "$input"
  a=0; feedback_cli draft "$input" || a=$?
  rm -f "$input"
  return $a
}

# known-issues [--all]：影响当前版本的已知问题（--all 列出全部）。缓存超过 6 小时就顺手读一次更新频道
cmd_known_issues() {
  local all=0 list n m
  [ "${1:-}" = --all ] && all=1
  [ -f "$OPS/muse.env" ] || die "还没装过，先跑 install"
  if [ -n "$CHANNEL" ] && { [ ! -f "$KNOWN" ] || [ $(( $(date +%s) - $(stat -c %Y "$KNOWN") )) -gt 21600 ]; }; then
    if m="$(curl -fsSL --max-time 20 "$CHANNEL" 2>/dev/null)" && jq -e '.known_issues' >/dev/null 2>&1 <<<"$m"; then
      jq -c '.known_issues' <<<"$m" > "$KNOWN.new" && mv -f "$KNOWN.new" "$KNOWN"
    fi
  fi
  if [ ! -f "$KNOWN" ]; then
    if [ "$UI_LANG" = en ]; then echo "No known-issues list yet (the update channel has none, or it could not be read)."
    else echo "还没有已知问题清单（更新频道里还没有这一项，或者读不到）。"; fi
    return 0
  fi
  if [ "$all" = 1 ]; then list="$(jq -c '.' "$KNOWN")"; else list="$(known_affecting)"; fi
  n="$(jq 'length' <<<"$list")"
  if [ "$n" = 0 ]; then
    if [ "$UI_LANG" = en ]; then echo "No known issues affect the installed version ($(installed_commit))."
    else echo "当前版本（$(installed_commit)）没有已知问题。"; fi
    return 0
  fi
  jq -r --arg en "$UI_LANG" '.[] |
    if $en == "en" then
      "• \(if .title_en != "" then .title_en else .title end)\n  Workaround: \(if .workaround_en != "" then .workaround_en else .workaround end)\n  \(if .fixed then "Fixed in \(.fixed_in): updating fixes it (bootstrap.sh update)." elif .fixed_in then "Will be fixed in \(.fixed_in) (not released yet)." else "Not fixed yet." end)\(if .issue then "\n  https://github.com/Wode44398/muse-bridge/issues/\(.issue)" else "" end)"
    else
      "• \(.title)\n  现象：\(.symptom)\n  绕过：\(.workaround)\n  \(if .fixed then "已在 \(.fixed_in) 修好：更新就好（bootstrap.sh update）。" elif .fixed_in then "会在 \(.fixed_in) 修好（还没发布）。" else "还没修好。" end)\(if .issue then "\n  https://github.com/Wode44398/muse-bridge/issues/\(.issue)" else "" end)"
    end' <<<"$list"
}

cmd_feedback_auto() {
  case "${1:-status}" in on|off|status) ;; *) die "用法：feedback-auto on|off|status" ;; esac
  [ -f "$OPS/muse.env" ] || die "还没装过，先跑 install"
  feedback_cli auto "${1:-status}"
}

sub="${1:-install}"; [ $# -gt 0 ] && shift
case "$sub" in
  install) cmd_install "$@" ;;
  wait) cmd_wait "$@" ;;
  status) cmd_status "$@" ;;
  set-claude-token) cmd_set_claude_token "$@" ;;
  set-api-key) cmd_set_api_key "$@" ;;
  allow-sites) cmd_allow_sites "$@" ;;
  set-lang) cmd_set_lang "$@" ;;
  set-agents) cmd_set_agents "$@" ;;
  set-users) cmd_set_users "$@" ;;
  set-domain) cmd_set_domain "$@" ;;
  use-quick-tunnel) cmd_use_quick_tunnel ;;
  reset-token) cmd_reset_token ;;
  check-update) cmd_check_update ;;
  update) cmd_update "$@" ;;
  switch-now) cmd_switch_now ;;
  rollback) cmd_rollback ;;
  auto-update) cmd_auto_update "$@" ;;
  report) cmd_report "$@" ;;
  feedback-auto) cmd_feedback_auto "$@" ;;
  known-issues) cmd_known_issues "$@" ;;
  -h|--help|help) sed -n '2,35p' "$0" ;;
  *) die "不认识的子命令：$sub（help 看用法）" ;;
esac
