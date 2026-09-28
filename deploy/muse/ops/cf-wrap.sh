#!/bin/bash
# cloudflared 启动包装（muse-tunnel.service 的 ExecStart），由 bootstrap.sh 装到 bridge-ops/，配置读同目录的 muse.env。
#
# Muse VM 上 cloudflared 直连出不去：它是静态二进制，不认 HTTPS_PROXY；/etc/hosts 又是只读挂载。
# 做法：开一个私有 mount namespace，把 bridge-ops/hosts（api.trycloudflare.com 与 edge 域名 → 127.0.0.1，
# 由 cf-relay-api / cf-relay-edge 两条 socat 经出站代理转发）bind 到 /etc/hosts 上，再降权跑 cloudflared。
#
# 两种模式（muse.env 的 TUNNEL_MODE）：
#   quick —— trycloudflare 临时地址（不用账号；VM 重启就换地址）
#   named —— 用户自己域名的命名隧道：令牌在 bridge-ops/tunnel.env（0600），经环境变量 TUNNEL_TOKEN 交给 cloudflared，
#            不出现在进程参数里。路由（主机名 → http://localhost:8787）在用户的 Cloudflare 后台配好。
set -e
DIR="$(dirname "$(readlink -f "$0")")"
set -a
. "$DIR/muse.env"
if [ "${TUNNEL_MODE:-quick}" = named ]; then . "$DIR/tunnel.env"; fi
set +a
# 快速隧道申请地址只给 15 秒，而出站代理冷启动的第一个请求要 16 秒以上——先经代理把 api.trycloudflare.com
# 碰一下，让代理热起来，申请就不会超时。失败无所谓，cloudflared 自己还会重试。
if [ "${TUNNEL_MODE:-quick}" != named ] && [ -n "${PROXY:-}" ]; then
  curl -s -o /dev/null --max-time 40 -x "$PROXY" https://api.trycloudflare.com/ || true
fi
exec unshare --mount --propagation private bash -c '
mount --bind "$OPS/hosts" /etc/hosts
common=(--no-autoupdate --protocol http2 --edge "$EDGE:7844")
if [ "${TUNNEL_MODE:-quick}" = named ]; then
  exec setpriv --reuid="$SVC_USER" --regid="$SVC_USER" --clear-groups "$CLOUDFLARED" tunnel "${common[@]}" run
else
  exec setpriv --reuid="$SVC_USER" --regid="$SVC_USER" --clear-groups "$CLOUDFLARED" tunnel "${common[@]}" --url "http://127.0.0.1:$PORT"
fi
'
