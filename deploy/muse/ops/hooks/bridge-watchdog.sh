#!/usr/bin/env bash
# bridge-watchdog：Muse 平台 hook，平台每 60 秒在 VM 上执行一次（VM 上没有 cron / 用户级 systemd，开机自愈只能靠它）。
#   1. 先跑 bridge-ops/heal.sh：重启后补回 systemd 单元、/etc/bridge/bridge.env、目录权限，拉起服务
#   2. 查 4 个服务 + 本地 / 公网 /healthz；刚挂的先重启一次，还不行就 wake worker 排查（kind=incident）
#   3. 临时地址（trycloudflare）每次重启都会变：新地址能通、且跟上次告诉用户的不一样 → wake（kind=url_changed）；
#      用自己域名（TUNNEL_MODE=named）时地址固定，不会通知
#   4. 换版本跟踪：切过去且健康 → update_done；切过去 5 分钟还不健康 → 自动退回旧版本 + update_failed；
#      40 分钟等不到空闲 → update_waiting
#   5. 每 6 小时读一次发布频道：有新版本 → update_available（先问用户），或者开了自动更新就直接后台更新
# 由 bootstrap.sh 装到 ~/hooks/scripts/（@OPS@ 在安装时替换成 bridge-ops 的绝对路径）。
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

OPS="@OPS@"
. "$OPS/muse.env"
# 这台 VM 只能经代理出站：探公网地址、读更新频道都要走它（hook 的执行环境不一定带代理变量）
if [ -n "${PROXY:-}" ]; then
  export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" https_proxy="$PROXY" http_proxy="$PROXY"
  export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
fi
STATE_FILE="$HOME/hooks/state/bridge-watchdog.json"
DRY="${HATCH_HOOK_DRY_RUN:-0}"
mkdir -p "$HOME/hooks/state"

[ "$DRY" = 1 ] || bash "$OPS/heal.sh" >/dev/null 2>&1 || true

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
local_ok() { curl --noproxy '*' --fail --silent --max-time 10 -o /dev/null "http://127.0.0.1:$PORT/healthz"; }
# 更新失败时：用户事先同意过自动上报，就顺手报给开发者（bootstrap.sh report --auto 自己会看开关、一天只报一次）。
# 回 sent / off / dup / queued / failed，放进 wake 的 payload，Muse 据此告诉用户「已自动报告」或问他要不要报。
auto_report_update_failed() {
  local out; out="$(timeout 60 bash "$OPS/bootstrap.sh" report --auto --kind update_failed --title "Update to ${1:-new version} failed" 2>&1 || true)"
  printf '%s' "$out" | grep -oE '^AUTO=[a-z]+' | tail -1 | cut -d= -f2 | grep . || echo failed
}
# bootstrap.sh 的安装 / 更新正在后台跑（它登记在 install.pid）
busy() { local p; p="$(cat "$OPS/install.pid" 2>/dev/null || true)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

# --- 后台自动更新在下载 / 构建阶段就失败了（还没切换，旧版本照常在跑）---
if [ -f "$OPS/update-error" ] && [ "$DRY" != 1 ]; then
  rm -f "$OPS/update-error"
  rep="$(auto_report_update_failed "$(cat "$OPS/update-notified" 2>/dev/null)")"
  wake "bridge 自动更新失败" "$(jq -n --arg old "$(head -1 "$RELS/current/deploy/muse/VERSION" 2>/dev/null)"     --arg logs "$(tail -40 "$OPS/install-progress.log" 2>/dev/null | sed -E 's/\x1b\[[0-9;]*m//g')" --arg rep "$rep" '{kind:"update_failed", version:"", rolled_back_to:$old, recent_logs:$logs, auto_reported:$rep}')"
  exit 0
fi

# --- 换版本跟踪（bootstrap.sh 把新版本就位、发了「空闲时重启」后写 pending-switch.json）---
PS="$OPS/pending-switch.json"
if [ -f "$PS" ] && [ "$DRY" != 1 ]; then
  to="$(jq -r .to "$PS")"; from="$(jq -r .from "$PS")"; ver="$(jq -r .version "$PS")"
  at="$(jq -r .at "$PS")"; fails="$(jq -r '.fails // 0' "$PS")"; run="$(running_dir)"
  if [ "$run" = "$to" ] && local_ok; then
    notes="$(jq -r '.notes // ""' "$PS")"
    rm -f "$PS"
    wake "bridge 已更新" "$(jq -n --arg v "$ver" --arg notes "$notes" '{kind:"update_done", version:$v, notes:$notes}')"
    exit 0
  elif [ "$run" = "$to" ] || { [ -z "$run" ] && [ "$(readlink -f "$RELS/current")" = "$to" ]; }; then
    # 已经切到新版本但不健康：连续 5 分钟不好就退回旧版本
    fails=$((fails + 1))
    if [ "$fails" -ge 5 ] && [ -f "$from/src/server.mjs" ]; then
      logs="$(journalctl -u bridge.service --no-pager -n 60 2>/dev/null | tail -60)"
      ln -sfn "$from" "$RELS/.current.tmp" && mv -Tf "$RELS/.current.tmp" "$RELS/current"
      systemctl reset-failed bridge.service 2>/dev/null || true
      systemctl restart bridge.service || true
      rm -f "$PS"
      rep="$(auto_report_update_failed "$ver")"
      wake "bridge 更新失败，已退回旧版本" "$(jq -n --arg v "$ver" --arg old "$(head -1 "$from/deploy/muse/VERSION" 2>/dev/null)" --arg logs "$logs" --arg rep "$rep" '{kind:"update_failed", version:$v, rolled_back_to:$old, recent_logs:$logs, auto_reported:$rep}')"
      exit 0
    fi
    jq --argjson f "$fails" '.fails = $f' "$PS" > "$PS.tmp" && mv "$PS.tmp" "$PS"
    silent "等新版本起来" "{\"fails\":$fails}"
    exit 0
  fi
  # 还跑在旧版本：每轮重发一次「空闲时重启」（bridge 那边重复收到不会叠加；它只等 30 分钟就放弃，这里接着续上）
  [ "$run" = "$from" ] && systemctl kill -s SIGUSR2 --kill-whom=main bridge.service 2>/dev/null || true
  if [ "$run" = "$from" ] && [ $(( $(date +%s) - at )) -gt 2400 ] && [ "$(jq -r '.warned // false' "$PS")" != true ]; then
    # 40 分钟还没等到空闲（bridge 自己只等 30 分钟就放弃）：问用户要不要现在就切
    jq '.warned = true' "$PS" > "$PS.tmp" && mv "$PS.tmp" "$PS"
    wake "bridge 新版本一直等不到空闲" "$(jq -n --arg v "$ver" '{kind:"update_waiting", version:$v}')"
    exit 0
  fi
fi

# --- 新版本检查：每 6 小时读一次发布频道 ---
STAMP="$OPS/update-check.stamp"
if [ -n "${CHANNEL:-}" ] && [ ! -f "$PS" ] && [ "$DRY" != 1 ] && ! busy && \
   { [ ! -f "$STAMP" ] || [ $(( $(date +%s) - $(stat -c %Y "$STAMP") )) -gt 21600 ]; }; then
  touch "$STAMP"
  # -L 必须有：GitHub 的 releases/latest/download/… 先 302 到具体标签，不跟跳就只拿到空 body，永远「没有新版本」
  if m="$(curl -fsSL --max-time 20 "$CHANNEL" 2>/dev/null)" && latest="$(jq -r '.commit // empty' <<<"$m")" && [ -n "$latest" ]; then
    installed="$(head -1 "$RELS/current/deploy/muse/VERSION" 2>/dev/null | cut -d' ' -f1)"
    # 已知问题：存一份给 bootstrap.sh known-issues、结果块用（老频道没有这个字段就不动旧缓存）
    if jq -e '.known_issues' >/dev/null 2>&1 <<<"$m"; then
      jq -c '.known_issues' <<<"$m" > "$OPS/known-issues.json.new" && mv -f "$OPS/known-issues.json.new" "$OPS/known-issues.json"
    fi
    # 某个版本（提交短哈希，按前缀比）受不受某条已知问题影响
    KI_HIT='def hit($h): ($h != "") and any(.commits[]?; . as $c | ($h | startswith($c)) or ($c | startswith($h)));'
    if [ "$latest" != "$installed" ] && [ "$latest" != "$(cat "$OPS/update-notified" 2>/dev/null)" ]; then
      echo "$latest" > "$OPS/update-notified"
      if [ "${AUTO_UPDATE:-0}" = 1 ]; then
        rm -f "$OPS/update-error"
        : > "$OPS/install-progress.log"; chmod 0600 "$OPS/install-progress.log"
        # MB_DETACHED=1：直接在这个后台进程里跑，并登记到 install.pid，Muse 用 bootstrap.sh wait 也能跟上进度
        MB_DETACHED=1 setsid nohup bash -c 'bash "$0" update >> "$1" 2>&1 || echo "$?" > "$2"' \
          "$OPS/bootstrap.sh" "$OPS/install-progress.log" "$OPS/update-error" < /dev/null > /dev/null 2>&1 &
        log "自动更新已开始" "{\"latest\":\"$latest\"}"
      else
        # 这台机器报告过、新版本里修好了的问题（latest.json 的 fixed = 这个版本修掉的 Issue 编号）
        fixed="$(jq -r --argjson f "$(jq -c '.fixed // []' <<<"$m" 2>/dev/null || echo '[]')" \
          '[.[] | select(.issue != null and ((.issue.number) as $n | $f | index($n)))] | unique_by(.issue.number) | map("#\(.issue.number) \(.title)") | join("; ")' \
          "$DATA/feedback/sent.json" 2>/dev/null || true)"
        # 影响当前版本、新版本里已经没有了的已知问题：更新的理由之一
        kfix="$(jq -r --arg a "$installed" --arg b "$latest" "$KI_HIT"' [.[]? | select(hit($a) and (hit($b) | not)) | .title] | join("; ")' \
          "$OPS/known-issues.json" 2>/dev/null || true)"
        wake "bridge 有新版本" "$(jq -n --arg cur "$(head -1 "$RELS/current/deploy/muse/VERSION" 2>/dev/null)" \
          --arg v "$(jq -r '.version // ""' <<<"$m")" --arg notes "$(jq -r '.notes // ""' <<<"$m")" --arg fixed "$fixed" --arg kfix "$kfix" \
          '{kind:"update_available", installed:$cur, latest:$v, notes:$notes, your_reports_fixed:$fixed, fixes_known_issues:$kfix}')"
        exit 0
      fi
    fi
    # 影响当前版本、而且维护者标了「要主动告诉用户」（notify）的已知问题：每条只说一次
    if [ -f "$OPS/known-issues.json" ] && [ -n "$installed" ]; then
      told="$(cat "$OPS/known-issues-notified" 2>/dev/null || true)"
      new_ki="$(jq -c --arg h "$installed" --arg told "$told" "$KI_HIT"' [.[]? | select(.notify == true and hit($h) and ((.id) as $i | ($told | split("\n") | index($i)) | not))]' \
        "$OPS/known-issues.json" 2>/dev/null || echo '[]')"
      if [ "$(jq 'length' <<<"$new_ki" 2>/dev/null || echo 0)" -gt 0 ]; then
        jq -r '.[].id' <<<"$new_ki" >> "$OPS/known-issues-notified"
        wake "bridge 已知问题" "$(jq -n --argjson issues "$(jq -c '[.[] | {title, symptom, workaround, fixed, fixed_in, issue}]' <<<"$new_ki")" \
          '{kind:"known_issue", issues:$issues}')"
        exit 0
      fi
    fi
  else
    # 没读到（代理刚起来、GitHub 抽风）：半小时后再试，别白等 6 小时
    touch -d "@$(( $(date +%s) - 21600 + 1800 ))" "$STAMP"
  fi
fi

# --- bridge 账号不在（heal.sh 按数据目录属主补建也没成）：服务必然起不来，不算故障，等下一轮 ---
if ! getent passwd "$SVC_USER" >/dev/null 2>&1; then
  silent "还在恢复中" '{"waiting":"平台还没写回服务账号"}'
  exit 0
fi

# --- 当前状态 ---
declare -A cur
for s in $SERVICES; do
  if systemctl is-active --quiet "$s.service" 2>/dev/null; then cur[$s]=ok; else cur[$s]=down; fi
done
# 服务启动了多少秒（没在跑 = 很大）。刚起来的服务给宽限：bridge 1 分钟，隧道 3 分钟——临时地址要过一会儿才生效，
# 这段时间里探不通不算故障，更不能重启隧道（重启 = 又换一个地址，VM 每次重启都会平白多换一次、多报一次）。
active_age() {
  local t now; t="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$1.service" 2>/dev/null || echo 0)"
  now="$(awk '{printf "%d", $1 * 1000000}' /proc/uptime)"
  if [ "${t:-0}" -gt 0 ] 2>/dev/null; then echo $(( (now - t) / 1000000 )); else echo 999999; fi
}
if curl --noproxy '*' --fail --silent --max-time 10 -o /dev/null "http://127.0.0.1:$PORT/healthz"; then
  cur[local_healthz]=ok
elif [ "${cur[bridge]}" = ok ] && [ "$(active_age bridge)" -lt 60 ]; then
  cur[local_healthz]=starting
else
  cur[local_healthz]=down
fi
pub_url() {
  if [ "${TUNNEL_MODE:-quick}" = named ] && [ -n "${PUBLIC_HOSTNAME:-}" ]; then echo "https://$PUBLIC_HOSTNAME"; return; fi
  # 只看隧道这一次运行的日志：这次注册失败时，别拿上一次运行留下的旧地址冒充
  local inv; inv="$(systemctl show -p InvocationID --value muse-tunnel.service 2>/dev/null || true)"
  journalctl -u muse-tunnel.service ${inv:+_SYSTEMD_INVOCATION_ID=$inv} --no-pager 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | tail -1 || true
}
PUB_URL="$(pub_url)"
if [ -n "$PUB_URL" ] && curl --fail --silent --max-time 20 -o /dev/null "$PUB_URL/healthz"; then
  cur[public_healthz]=ok
elif [ "${cur[muse-tunnel]}" = ok ] && [ "$(active_age muse-tunnel)" -lt 180 ]; then
  cur[public_healthz]=starting
else
  cur[public_healthz]=down
fi

# --- 上次状态 ---
prev_json="{}"
[ -f "$STATE_FILE" ] && prev_json="$(cat "$STATE_FILE")"
prev_of() { echo "$prev_json" | jq -r --arg k "$1" '.[$k] // "unknown"'; }

incidents=()
restart_log=()
try_restart() {
  local svc="$1"
  if [ "$DRY" = 1 ]; then restart_log+=("$svc: dry-run，跳过重启"); return 0; fi
  systemctl reset-failed "$svc.service" 2>/dev/null || true
  if systemctl restart "$svc.service" 2>/dev/null; then
    sleep 12
    if systemctl is-active --quiet "$svc.service"; then restart_log+=("$svc: 重启后恢复 active"); return 0; fi
    restart_log+=("$svc: 重启了但仍不是 active"); return 1
  fi
  restart_log+=("$svc: systemctl restart 失败"); return 1
}

for comp in $SERVICES local_healthz public_healthz; do
  if [ "${cur[$comp]}" = down ] && [ "$(prev_of "$comp")" != down ]; then
    sleep 15   # 刚挂：先给 Restart=always 一点时间，避免误报
    case "$comp" in
      local_healthz) systemctl is-active --quiet bridge.service && try_restart bridge || true ;;
      public_healthz) try_restart muse-tunnel || true ;;
      *) systemctl is-active --quiet "$comp.service" || try_restart "$comp" || true ;;
    esac
    recheck=ok
    case "$comp" in
      local_healthz) curl --noproxy '*' --fail --silent --max-time 10 -o /dev/null "http://127.0.0.1:$PORT/healthz" || recheck=down ;;
      public_healthz)
        PUB_URL="$(pub_url)"
        [ -n "$PUB_URL" ] && curl --fail --silent --max-time 20 -o /dev/null "$PUB_URL/healthz" || recheck=down ;;
      *) systemctl is-active --quiet "$comp.service" || recheck=down ;;
    esac
    cur[$comp]="$recheck"
    if [ "$recheck" = down ]; then incidents+=("$comp"); else log "自愈/重启恢复" "{\"component\":\"$comp\"}"; fi
  fi
done

if [ "$DRY" != 1 ]; then
  {
    echo "{"; first=1
    for comp in $SERVICES local_healthz public_healthz; do
      [ $first = 0 ] && echo ","
      printf '  "%s": "%s"' "$comp" "${cur[$comp]}"; first=0
    done
    echo; echo "}"
  } > "$STATE_FILE"
fi

# --- 公网地址变了：能通了才通知，只通知一次（自己的域名不会变，不通知）---
if [ "${TUNNEL_MODE:-quick}" != named ] && [ "${cur[public_healthz]}" = ok ] && [ -n "$PUB_URL" ]; then
  last_url="$(cat "$OPS/public-url" 2>/dev/null || true)"
  if [ "$PUB_URL" != "$last_url" ] && [ "$DRY" != 1 ]; then
    echo "$PUB_URL" > "$OPS/public-url"
    if [ -n "$last_url" ]; then
      wake "bridge 公网地址变了" "$(jq -n --arg old "$last_url" --arg new "$PUB_URL" '{kind:"url_changed", old_url:$old, new_url:$new}')"
      exit 0
    fi
  fi
fi

all_ok=1; for comp in $SERVICES local_healthz public_healthz; do [ "${cur[$comp]}" = ok ] || all_ok=0; done
if [ ${#incidents[@]} -eq 0 ]; then
  silent "$( [ "$all_ok" = 1 ] && echo 全部正常 || echo 还在恢复中 )" "$(printf '{"services":"%s"}' "$(for s in $SERVICES; do echo -n "$s=${cur[$s]} "; done)local=${cur[local_healthz]} public=${cur[public_healthz]}")"
else
  logs=""
  for c in "${incidents[@]}"; do
    case "$c" in
      local_healthz|public_healthz) ;;
      *) logs+="--- journalctl $c（近 50 行）---"$'\n'"$(journalctl -u "$c.service" --no-pager -n 50 2>/dev/null | tail -50)"$'\n' ;;
    esac
  done
  wake "bridge 部署组件故障" "$(jq -n \
    --arg incidents "$(IFS=,; echo "${incidents[*]}")" \
    --arg restarts "$(IFS='; '; echo "${restart_log[*]}")" \
    --arg puburl "$PUB_URL" --arg logs "$logs" \
    '{kind:"incident", incidents:$incidents, restart_attempts:$restarts, public_url:$puburl, recent_logs:$logs}')"
fi
