# 本地测试用：模拟 Muse 的 hatch-egress-proxy（只放行 HTTP CONNECT 的出站代理，任意端口）。
# 另外把直连的 80/443/7844 出站在测试容器里用 iptables 挡掉，才能验证「只能经代理出站」。
import asyncio, os, sys

# 模拟 Muse 的网络审核：/etc/fake-egress/deny 里的站点回 403（用户点了拒绝），
# /etc/fake-egress/hold 里的站点不答复（审核卡没人批）。一行一个主机名，改完不用重启代理。
def listed(name, host):
    try:
        with open(f'/etc/fake-egress/{name}') as f:
            return host in {l.strip() for l in f if l.strip()}
    except OSError:
        return False

async def pipe(r, w):
    try:
        while True:
            b = await r.read(65536)
            if not b:
                break
            w.write(b)
            await w.drain()
    except Exception:
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass

async def handle(cr, cw):
    try:
        head = await cr.readuntil(b'\r\n\r\n')
    except Exception:
        cw.close(); return
    line = head.split(b'\r\n', 1)[0].decode('latin1')
    parts = line.split()
    if len(parts) < 2:
        cw.close(); return
    method, target = parts[0], parts[1]
    if method == 'CONNECT':
        host, _, port = target.rpartition(':')
        if listed('deny', host):
            cw.write(b'HTTP/1.1 403 Forbidden\r\n\r\n'); await cw.drain(); cw.close(); return
        if listed('hold', host):
            await asyncio.sleep(3600); cw.close(); return
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(host, int(port)), 20)
        except Exception as e:
            cw.write(b'HTTP/1.1 502 Bad Gateway\r\n\r\n'); await cw.drain(); cw.close(); return
        cw.write(b'HTTP/1.1 200 Connection established\r\n\r\n'); await cw.drain()
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
        return
    # 普通 HTTP 代理请求（apt 的 http:// 源会这样走）
    if target.startswith('http://'):
        rest = target[7:]
        hostport, _, path = rest.partition('/')
        host, _, port = hostport.partition(':')
        port = int(port or 80)
        try:
            ur, uw = await asyncio.wait_for(asyncio.open_connection(host, port), 20)
        except Exception:
            cw.write(b'HTTP/1.1 502 Bad Gateway\r\n\r\n'); await cw.drain(); cw.close(); return
        lines = head.decode('latin1').split('\r\n')
        lines[0] = f'{method} /{path} {parts[2] if len(parts) > 2 else "HTTP/1.1"}'
        lines = [l for l in lines if not l.lower().startswith('proxy-connection')]
        uw.write('\r\n'.join(lines).encode('latin1')); await uw.drain()
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
        return
    cw.write(b'HTTP/1.1 400 Bad Request\r\n\r\n'); await cw.drain(); cw.close()

async def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3128
    srv = await asyncio.start_server(handle, '0.0.0.0', port)
    async with srv:
        await srv.serve_forever()

asyncio.run(main())
