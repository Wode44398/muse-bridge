# shellcheck shell=bash
# bootstrap.sh 回写 muse.env 时，两项「部署环境」值的合并规则。只定义函数、不做任何事，可以单独 source 来测
# （deploy/muse/test/muse-env.test.sh）。
#
# muse.env 每次 install / update / set-* 都整体重写。用户的选择（AGENTS、USERS_MODE…）走 prev() 沿用上次的值；
# 下面这两项以前直接取脚本内置值 / 现找的路径，会把运维者的人工修改冲掉（Issue #8），现在按这里的规则合并。

# 服务清单：这个版本的内置服务在前（按内置顺序），再接上次 muse.env 里多出来的服务（运维者自己加的，保持原顺序），去重。
# 不单纯沿用上次的值：以后的版本新增内置服务时，旧清单里没有它。
# 以后去掉某个内置服务时，把它写进第三个参数（退役名单），免得它被当成自有服务留下来。
# 名字只认 systemd 单元名用得到的字符，别的丢掉（muse.env 会被 source）。
merge_services() { # $1 = 内置清单  $2 = 上次的 SERVICES  $3 = 退役名单
  local s out="" retired=" ${3:-} " list=()
  read -ra list <<<"${1:-} ${2:-}"
  for s in "${list[@]}"; do
    [[ "$s" =~ ^[A-Za-z0-9@._:-]+$ ]] || continue
    case " $out " in *" $s "*) continue ;; esac
    case "$retired" in *" $s "*) continue ;; esac
    out+="${out:+ }$s"
  done
  printf '%s\n' "$out"
}

# cloudflared 的路径：上次的值仍是可执行文件就沿用（运维者可能把它挪到了 /home/hatch 底下：VM 重启时平台会清掉别处的文件），
# 否则按 PATH 现找，再找不到就用 deb 包的默认位置。
pick_cloudflared() { # $1 = 上次的 CLOUDFLARED
  if [ -n "${1:-}" ] && [ -f "$1" ] && [ -x "$1" ]; then printf '%s\n' "$1"; return 0; fi
  command -v cloudflared 2>/dev/null || echo /usr/bin/cloudflared
}

# 回写值跟上次不一样时给一行说明（上次没有这一项 = 新装，不说）；一样就什么都不输出。
env_change_note() { # $1 = 键  $2 = 上次的值  $3 = 这次写的值
  local key="$1" old="${2:-}" new="${3:-}" s added="" dropped="" list=()
  [ -n "$old" ] && [ "$old" != "$new" ] || return 0
  case "$key" in
    SERVICES)
      read -ra list <<<"$new"; for s in "${list[@]}"; do case " $old " in *" $s "*) ;; *) added+="${added:+ }$s" ;; esac; done
      read -ra list <<<"$old"; for s in "${list[@]}"; do case " $new " in *" $s "*) ;; *) dropped+="${dropped:+ }$s" ;; esac; done
      if [ -z "$added" ] && [ -z "$dropped" ]; then
        printf 'muse.env 的 SERVICES 调整了顺序：%s → %s\n' "$old" "$new"
      else
        printf 'muse.env 的 SERVICES 变了：%s → %s%s%s\n' "$old" "$new" \
          "${added:+（新增：$added）}" "${dropped:+（去掉：$dropped，退役的内置服务或名字不合法）}"
      fi ;;
    CLOUDFLARED)
      printf 'muse.env 的 CLOUDFLARED 变了：%s 已经不存在或不能执行，改用 %s\n' "$old" "$new" ;;
    *)
      printf 'muse.env 的 %s 变了：%s → %s\n' "$key" "$old" "$new" ;;
  esac
}
