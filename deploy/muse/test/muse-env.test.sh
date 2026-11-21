#!/bin/bash
# muse.env 回写规则的单测（ops/muse-env-lib.sh 里的纯函数；不需要 root、systemd、jq）：
#   bash deploy/muse/test/muse-env.test.sh
# 另外把 bootstrap.sh 的 write_muse_env 原样抠出来，在临时目录里跑一遍「上次的 muse.env → 回写」，核对整条路径。
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUSE="$(cd "$HERE/.." && pwd)"
# shellcheck source=../ops/muse-env-lib.sh
. "$MUSE/ops/muse-env-lib.sh"

pass=0 fail=0
eq() { # $1 = 说明  $2 = 实际  $3 = 期望
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL %s\n  实际：%s\n  期望：%s\n' "$1" "$2" "$3"; fi
}
has() { # $1 = 说明  $2 = 实际  $3 = 应包含的片段
  case "$2" in *"$3"*) pass=$((pass + 1)) ;; *) fail=$((fail + 1)); printf 'FAIL %s\n  实际：%s\n  应包含：%s\n' "$1" "$2" "$3" ;; esac
}

B="bridge cf-relay-api cf-relay-edge muse-tunnel"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# —— merge_services ——
eq "新装：只有内置" "$(merge_services "$B" "")" "$B"
eq "上次跟内置一样" "$(merge_services "$B" "$B")" "$B"
eq "保留自己加的服务" "$(merge_services "$B" "$B claude-relay")" "$B claude-relay"
eq "自有服务保持原顺序" "$(merge_services "$B" "bridge my-b cf-relay-api my-a")" "$B my-b my-a"
eq "去重" "$(merge_services "$B" "$B x x bridge")" "$B x"
eq "新版本新增的内置服务不会被旧清单漏掉" "$(merge_services "$B new-builtin" "$B claude-relay")" "$B new-builtin claude-relay"
eq "人工删掉的内置服务回来（内置的总在）" "$(merge_services "$B" "bridge muse-tunnel")" "$B"
eq "退役的内置服务不当成自有服务留下" "$(merge_services "bridge muse-tunnel" "$B mine" "cf-relay-api cf-relay-edge")" "bridge muse-tunnel mine"
eq "不合法的名字丢掉" "$(merge_services "$B" 'ok.service $(touch /tmp/x) a;b *')" "$B ok.service"
eq "多余空白" "$(merge_services "$B" "  bridge    extra  ")" "$B extra"

# —— pick_cloudflared ——
printf '#!/bin/sh\n' > "$TMP/cf-persist"; chmod +x "$TMP/cf-persist"
printf 'x\n' > "$TMP/cf-noexec"; chmod -x "$TMP/cf-noexec"
mkdir -p "$TMP/bin" "$TMP/dir-not-file"; printf '#!/bin/sh\n' > "$TMP/bin/cloudflared"; chmod +x "$TMP/bin/cloudflared"
eq "上次的路径还能执行：沿用" "$(pick_cloudflared "$TMP/cf-persist")" "$TMP/cf-persist"
eq "上次的路径没了：按 PATH 现找" "$(PATH="$TMP/bin:/usr/bin:/bin" pick_cloudflared "$TMP/gone")" "$TMP/bin/cloudflared"
eq "上次的不可执行：按 PATH 现找" "$(PATH="$TMP/bin:/usr/bin:/bin" pick_cloudflared "$TMP/cf-noexec")" "$TMP/bin/cloudflared"
eq "上次的是目录：按 PATH 现找" "$(PATH="$TMP/bin:/usr/bin:/bin" pick_cloudflared "$TMP/dir-not-file")" "$TMP/bin/cloudflared"
eq "上次为空：按 PATH 现找" "$(PATH="$TMP/bin:/usr/bin:/bin" pick_cloudflared "")" "$TMP/bin/cloudflared"
eq "哪都找不到：deb 默认位置" "$(PATH="$TMP/empty" pick_cloudflared "")" "/usr/bin/cloudflared"

# —— env_change_note ——
eq "新装不提示" "$(env_change_note SERVICES "" "$B")" ""
eq "没变不提示" "$(env_change_note SERVICES "$B x" "$B x")" ""
has "新增内置服务时提示" "$(env_change_note SERVICES "$B" "$B y")" "新增：y"
has "去掉时提示" "$(env_change_note SERVICES "$B bad;name" "$B")" "去掉：bad;name"
has "只是顺序变了也提示" "$(env_change_note SERVICES "muse-tunnel bridge cf-relay-api cf-relay-edge" "$B")" "顺序"
has "CLOUDFLARED 变了提示新旧路径" "$(env_change_note CLOUDFLARED "/old/cf" "/usr/bin/cloudflared")" "/old/cf 已经不存在或不能执行，改用 /usr/bin/cloudflared"
eq "CLOUDFLARED 没变不提示" "$(env_change_note CLOUDFLARED "/usr/bin/cloudflared" "/usr/bin/cloudflared")" ""

# —— 整条路径：bootstrap.sh 的 prev() + write_muse_env，按上次的 muse.env 回写 ——
BOOT="$MUSE/bootstrap.sh"
fn() { sed -n "/^$1() {/,/^}/p" "$BOOT"; }
prev_def="$(grep -E '^prev\(\) \{' "$BOOT")"
wme_def="$(fn write_muse_env)"
[ -n "$prev_def" ] && [ -n "$wme_def" ] || { echo "FAIL 在 bootstrap.sh 里找不到 prev / write_muse_env"; exit 1; }
SERVICES_LINE="$(grep -E '^SERVICES=' "$BOOT" | head -1)"
run_write() { # 在子 shell 里模拟一次回写；$1 = 预置的 muse.env 内容（空 = 新装）
  (
    OPS="$TMP/ops"; rm -rf "$OPS"; mkdir -p "$OPS"
    [ -z "$1" ] || printf '%s\n' "$1" > "$OPS/muse.env"
    PERSIST=/home/hatch RELS=/home/hatch/bridge-releases DATA=/home/hatch/bridge-srv PORT=8787 SVC_USER=bridge EDGE=e PROXY=p
    AGENTS=claude USERS_MODE=solo TUNNEL_MODE=quick PUBLIC_HOSTNAME="" CHANNEL="" AUTO_UPDATE=0 UI_LANG=zh
    SERVICES_RETIRED=""
    eval "$SERVICES_LINE"
    install() { mkdir -p "${@: -1}"; }   # write_muse_env 里只用 install -d 建目录
    warn() { printf 'WARN %s\n' "$*"; }
    eval "$prev_def"; eval "$wme_def"
    PATH="$TMP/bin:/usr/bin:/bin" write_muse_env
    printf -- '---\n'; cat "$OPS/muse.env"
  )
}
out="$(run_write "")"
has "新装：SERVICES 是内置清单" "$out" "SERVICES=\"$B\""
has "新装：CLOUDFLARED 按 PATH 找" "$out" "CLOUDFLARED=$TMP/bin/cloudflared"
eq "新装：不打提示" "$(grep -c '^WARN' <<<"$out")" "0"

out="$(run_write "SERVICES=\"$B claude-relay\"
CLOUDFLARED=$TMP/cf-persist")"
has "更新：保留自有服务" "$out" "SERVICES=\"$B claude-relay\""
has "更新：沿用还能执行的 cloudflared" "$out" "CLOUDFLARED=$TMP/cf-persist"
eq "更新：值没变不打提示" "$(grep -c '^WARN' <<<"$out")" "0"

out="$(run_write "SERVICES=\"bridge claude-relay\"
CLOUDFLARED=$TMP/gone")"
has "更新：补回内置服务、自有服务接在后面" "$out" "SERVICES=\"$B claude-relay\""
has "更新：旧 cloudflared 没了就现找" "$out" "CLOUDFLARED=$TMP/bin/cloudflared"
has "更新：CLOUDFLARED 变了打提示" "$out" "WARN muse.env 的 CLOUDFLARED 变了"
has "更新：SERVICES 变了打提示" "$out" "WARN muse.env 的 SERVICES 变了"
has "文件头写清回写规则" "$out" "这里多出来的服务"

# 回写出来的 muse.env 能被 heal.sh / 看门狗 source
( . "$TMP/ops/muse.env" && [ "$SERVICES" = "$B claude-relay" ] ) && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL 回写的 muse.env source 后 SERVICES 不对"; }

# —— cloudflared 持久副本（#9：VM 重启清掉 /usr/bin/cloudflared）——
CF="$TMP/cf/usr/bin/cloudflared" BK="$TMP/cf/ops/cloudflared"; mkdir -p "$TMP/cf/ops" "$(dirname "$CF")"
printf '#!/bin/sh\necho v1\n' > "$CF"; chmod +x "$CF"
keep_cloudflared "$CF" "$BK"
eq "keep：存了副本" "$(cat "$BK" 2>/dev/null)" "$(cat "$CF")"
[ -x "$BK" ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL keep：副本不可执行"; }
# 软链两条只在真 Linux 上测（Git Bash 的 ln -s 是复制）
mkdir -p "$TMP/cf/usr/local/bin"; ln -sf "$CF" "$TMP/cf/usr/local/bin/cloudflared" 2>/dev/null
[ -L "$TMP/cf/usr/local/bin/cloudflared" ] && LINKS=1 || LINKS=0
printf '#!/bin/sh\necho v2\n' > "$CF"; chmod +x "$CF"
if [ "$LINKS" = 1 ]; then keep_cloudflared "$TMP/cf/usr/local/bin/cloudflared" "$BK"; else keep_cloudflared "$CF" "$BK"; fi
has "keep：原件更新了副本也更新（Linux 上经软链）" "$(cat "$BK")" "v2"
keep_cloudflared "$TMP/cf/gone" "$BK"
has "keep：原件不在不碰副本" "$(cat "$BK")" "v2"
eq "restore：原件还在什么都不做" "$(restore_cloudflared "$CF" "$BK"; echo "rc=$?")" "rc=0"
rm -rf "$TMP/cf/usr"   # 模拟 VM 重启：/usr 下的原件和软链都没了
out="$(restore_cloudflared "$CF" "$BK"; echo "rc=$?")"
has "restore：从副本补回并说一声" "$out" "已从 $BK 补回 $CF"
has "restore：补回成功" "$out" "rc=0"
[ -x "$CF" ] && [ "$(cat "$CF")" = "$(cat "$BK")" ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL restore：补回的文件不对"; }
if [ "$LINKS" = 1 ]; then
  mkdir -p "$TMP/cf/usr/local/bin"; ln -sf "$TMP/cf/nowhere" "$TMP/cf/usr/local/bin/cloudflared"
  restore_cloudflared "$TMP/cf/usr/local/bin/cloudflared" "$BK" >/dev/null
  [ -x "$TMP/cf/usr/local/bin/cloudflared" ] && [ ! -L "$TMP/cf/usr/local/bin/cloudflared" ] && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL restore：断链没换成真文件"; }
fi
rm -f "$CF"
eq "restore：没有副本 = 1" "$(restore_cloudflared "$CF" "$TMP/cf/ops/none"; echo "rc=$?")" "rc=1"
eq "restore：路径为空 = 1" "$(restore_cloudflared "" "$BK"; echo "rc=$?")" "rc=1"
# 三处都接上了：安装存副本、heal.sh 和 cf-wrap.sh 补回
has "bootstrap 把函数库装进 bridge-ops" "$(cat "$BOOT")" 'ops/muse-env-lib.sh" "$OPS/muse-env-lib.sh"'
has "bootstrap 存副本" "$(cat "$BOOT")" 'keep_cloudflared "$(prev CLOUDFLARED)" "$OPS/cloudflared"'
has "bootstrap 下载前先试副本" "$(cat "$BOOT")" 'restore_cloudflared "$(prev CLOUDFLARED)" "$OPS/cloudflared"'
has "heal.sh 补回" "$(cat "$MUSE/ops/heal.sh")" 'restore_cloudflared "$CLOUDFLARED" "$OPS/cloudflared"'
has "cf-wrap.sh 启动前补回" "$(cat "$MUSE/ops/cf-wrap.sh")" 'restore_cloudflared "$CLOUDFLARED" "$OPS/cloudflared"'

# —— 选了哪些 agent：Antigravity（agy）可选、默认不开 ——
eq "norm：只有 claude" "$(norm_agents claude)" "claude"
eq "norm：顺序规范" "$(norm_agents dimensio,claude)" "claude,dimensio"
eq "norm：三个都要" "$(norm_agents claude,dimensio,agy)" "claude,dimensio,agy"
eq "norm：agy 排在最后" "$(norm_agents agy,claude)" "claude,agy"
eq "norm：antigravity 当 agy、大小写不敏感" "$(norm_agents Antigravity,DIMENSIO)" "dimensio,agy"
eq "norm：空格分隔也认、去重" "$(norm_agents 'claude agy claude')" "claude,agy"
eq "norm：agy 不能单独选" "$(norm_agents agy; echo "rc=$?")" "rc=1"
eq "norm：空的不行" "$(norm_agents ''; echo "rc=$?")" "rc=1"
eq "norm：codex 不认" "$(norm_agents claude,codex; echo "rc=$?")" "rc=1"
eq "norm：怪字符不认" "$(norm_agents 'claude;touch'; echo "rc=$?")" "rc=1"
agents_has claude,dimensio,agy agy && pass=$((pass + 1)) || { fail=$((fail + 1)); echo "FAIL agents_has 认不出 agy"; }
agents_has claude,dimensio agy && { fail=$((fail + 1)); echo "FAIL agents_has 误认 agy"; } || pass=$((pass + 1))
agents_has claude,agy2 agy && { fail=$((fail + 1)); echo "FAIL agents_has 按前缀误认"; } || pass=$((pass + 1))
eq "hide：老部署（没选 agy）也藏起 Antigravity" "$(modules_hide_for claude,dimensio)" "codex,agy"
eq "hide：选了 agy 才列出来" "$(modules_hide_for claude,dimensio,agy)" "codex"
eq "hide：没装过（空）按没选" "$(modules_hide_for '')" "codex,agy"

# 结果块里的 agent 名称（bootstrap.sh 的 agents_label 原样抠出来）
eval "$(fn agents_label)"
eq "label：老三样不变（中）" "$(UI_LANG=zh agents_label claude,dimensio)" "Claude Code + dimensio"
eq "label：只有 claude（中）" "$(UI_LANG=zh agents_label claude)" "只有 Claude Code"
eq "label：加 agy（中）" "$(UI_LANG=zh agents_label claude,dimensio,agy)" "Claude Code + dimensio + Antigravity（实验性）"
eq "label：claude + agy（中）" "$(UI_LANG=zh agents_label claude,agy)" "Claude Code + Antigravity（实验性）"
eq "label：dimensio + agy（英）" "$(UI_LANG=en agents_label dimensio,agy)" "dimensio + Antigravity (experimental)"
eq "label：老三样不变（英）" "$(UI_LANG=en agents_label dimensio)" "dimensio only"

# set-agents：先规范再交给后台；agy 单独选、写错名字当场报错（bootstrap.sh 的 cmd_set_agents 原样抠出来）
sa() { # $@ = set-agents 的参数；输出它会做什么
  ( eval "$(fn cmd_set_agents)"; UI_LANG=zh
    die() { echo "DIE $*"; exit 1; }
    run_detached() { echo "DETACH $*"; }
    detached_start() { :; }; say() { :; }
    reinstall_current() { echo "REINSTALL $*"; }
    cmd_set_agents "$@" )
}
eq "set-agents：前台转后台时已规范" "$(sa agy,claude)" "DETACH set-agents claude,agy"
eq "set-agents：后台里重装带上 agy" "$(MB_DETACHED=1 sa claude,dimensio,agy)" "REINSTALL --agents claude,dimensio,agy"
eq "set-agents：去掉 agy" "$(MB_DETACHED=1 sa claude,dimensio)" "REINSTALL --agents claude,dimensio"
has "set-agents：只选 agy 报错" "$(sa agy)" "DIE 用法：set-agents"
has "set-agents：没给参数报错" "$(sa)" "DIE 用法：set-agents"

# update：老 muse.env 的 AGENTS 没有 agy → 沿用、不自动加，Antigravity 照旧藏着
out="$( OPS="$TMP/ops-up"; mkdir -p "$OPS"; printf 'AGENTS=claude,dimensio\n' > "$OPS/muse.env"
  eval "$prev_def"; a="$(norm_agents "$(prev AGENTS)")"; echo "$a $(modules_hide_for "$a")" )"
eq "update：老名单原样沿用" "$out" "claude,dimensio codex,agy"
out="$( OPS="$TMP/ops-none"; eval "$prev_def"; a="$(prev AGENTS)"; norm_agents "${a:-claude,dimensio}" )"
eq "新装：默认两个、不带 agy" "$out" "claude,dimensio"

# 放行网站：选了 agy 才带上 Antigravity 的站点（bootstrap.sh 的 configured_sites / agy_sites 原样抠出来）
cs() { # $1 = AGENTS
  ( eval "$(fn configured_sites)"; eval "$(fn agy_sites)"
    vertex_sites() { :; }; key_site() { :; }; site_of() { :; }
    DATA="$TMP/no-data" FEEDBACK_HOST_DEFAULT="" AGENTS="$1" configured_sites )
}
has "sites：选了 agy 放行 Cloud Code 接口" "$(cs claude,agy)" "daily-cloudcode-pa.googleapis.com"
has "sites：选了 agy 放行 CLI 安装源" "$(cs claude,agy)" "antigravity.google"
has "sites：选了 agy 放行令牌续期" "$(cs claude,agy)" "oauth2.googleapis.com"
eq "sites：没选 agy 不带它的站点" "$(cs claude,dimensio | grep -c 'antigravity\|cloudcode')" "0"

# install.sh：agy 的解析、默认关、没选就当没装（BRIDGE_MODULES_SKIP）
INST="$MUSE/install.sh"
afc() { # $1 = config.json 内容；输出 install.sh 的 agents_from_config 读出来的名单
  ( DATA="$TMP/afc"; mkdir -p "$DATA"; printf '%s' "$1" > "$DATA/config.json"
    eval "$(sed -n '/^agents_from_config() {/,/^}/p' "$INST")"; agents_from_config )
}
if command -v node >/dev/null; then
  eq "install：老配置（没有 agy 键）不带 agy" "$(afc '{"agents":{"claude":true,"dimensio":true}}')" "claude,dimensio"
  eq "install：agy 写明开着才算" "$(afc '{"agents":{"claude":true,"dimensio":false,"agy":true}}')" "claude,agy"
  eq "install：agy=false 不算" "$(afc '{"agents":{"agy":false}}')" "claude,dimensio"
fi
skip_of() { # $1 = WANT_DIMENSIO  $2 = WANT_AGY；输出 install.sh 写进单元的那一行
  ( WANT_DIMENSIO="$1" WANT_AGY="$2"
    eval "$(sed -n '/^SKIP_LIST=""/,/^\[ -z "\$SKIP_LIST" \]/p' "$INST")"; echo "$MODULES_SKIP_LINE" )
}
eq "install：两个都选、不选 agy" "$(skip_of 1 0)" "Environment=BRIDGE_MODULES_SKIP=agy"
eq "install：没选 dimensio、也没选 agy" "$(skip_of 0 0)" "Environment=BRIDGE_MODULES_SKIP=dimensio,agy"
eq "install：都选了" "$(skip_of 1 1)" ""
eq "install：没选 dimensio、选了 agy" "$(skip_of 0 1)" "Environment=BRIDGE_MODULES_SKIP=dimensio"
has "install：--agents 认 agy" "$(cat "$INST")" 'agy|antigravity) WANT_AGY=1'
has "install：config.json 写 agents.agy" "$(cat "$INST")" 'agy: agy === "1"'
has "install：CLI 装在服务用户家目录（随数据目录持久）" "$(cat "$INST")" '[ -x "$DATA/home/.local/bin/agy" ]'
has "bootstrap：HIDE 按选择算" "$(cat "$BOOT")" 'set_bridge_env BRIDGE_MODULES_HIDE "$(modules_hide_for "$AGENTS")"'

printf '%d 通过，%d 失败\n' "$pass" "$fail"
[ "$fail" = 0 ]
