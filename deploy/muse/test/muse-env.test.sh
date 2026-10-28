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

printf '%d 通过，%d 失败\n' "$pass" "$fail"
[ "$fail" = 0 ]
