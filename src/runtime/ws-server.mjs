// 通用 WebSocket 服务端（RFC 6455）：文本 + 二进制帧、分片、ping/pong、close、积压量。
//
// 和 web-bridge.mjs 里那份最小实现的区别：那份只服务扩展回环、只收发文本；这份给要推二进制流的功能用
// （安卓画面经隧道到手机），所以多了 sendBinary、bufferedAmount（看 socket 写缓冲判断要不要丢帧）、
// 服务端心跳（Cloudflare 隧道约 100 秒没数据就断）。不协商 permessage-deflate：视频本来就压过了。
//
// 升级请求的分流：bridge 的 HTTP 服务上挂着好几个 'upgrade' 监听（预览域名转发等），谁认领谁处理，
// 没人认领的才由预览那边销毁——功能在这里登记路径前缀，preview-host 先问 upgradeClaimed(req)。

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const claimed = new Set();

/** 登记一个由别的监听自己处理的升级路径前缀（如 '/api/android/'）。返回注销函数。 */
export function claimUpgradePath(prefix) {
  claimed.add(prefix);
  return () => claimed.delete(prefix);
}

/** 这个升级请求有没有功能认领（预览域名转发据此决定要不要销毁 socket）。 */
export function upgradeClaimed(req) {
  const url = String(req?.url || '');
  for (const p of claimed) if (url.startsWith(p)) return true;
  return false;
}

/**
 * 完成握手，返回连接对象；握手不合法时回 400 并返回 null。
 *   onText(str) / onBinary(buf) / onClose(code)
 *   send(text) / sendBinary(buf) / close(code, reason) / bufferedAmount / open
 * opts.maxMessage：单条消息上限（默认 1 MB，安卓卡上行只有控制消息和剪贴板）
 * opts.pingMs：服务端心跳间隔（默认 20 秒；0 = 不发）
 */
export function acceptWebSocket(req, socket, head, { maxMessage = 1 << 20, pingMs = 20_000 } = {}) {
  const key = String(req.headers['sec-websocket-key'] || '');
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay?.(true);
  let open = true;
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let fragLen = 0;
  let fragOp = 0;
  let pongDue = 0;

  const write = (op, payload) => {
    if (!open) return false;
    try { return socket.write(frame(op, payload)); } catch { return false; }
  };
  const ws = {
    get open() { return open; },
    /** socket 还没写出去的字节数（含内核缓冲之外 Node 攒着的部分）。 */
    get bufferedAmount() { return socket.writableLength || 0; },
    onText: () => {},
    onBinary: () => {},
    onClose: () => {},
    send(text) { return write(0x1, Buffer.from(String(text), 'utf8')); },
    sendBinary(data) { return write(0x2, Buffer.isBuffer(data) ? data : Buffer.from(data)); },
    close(code = 1000, reason = '') {
      if (!open) return;
      const r = Buffer.from(String(reason), 'utf8').subarray(0, 120);
      const body = Buffer.alloc(2 + r.length);
      body.writeUInt16BE(code, 0);
      r.copy(body, 2);
      try { socket.write(frame(0x8, body)); } catch { /* 对端已断 */ }
      finish(code);
      socket.end();
      setTimeout(() => { try { socket.destroy(); } catch {} }, 2000).unref?.();
    },
  };
  const finish = (code = 1006) => {
    if (!open) return;
    open = false;
    clearInterval(timer);
    try { ws.onClose(code); } catch { /* listener's problem */ }
  };
  // 心跳：发 ping，下一拍还没收到 pong 就当连接死了（手机切后台、隧道半开）。
  const timer = pingMs > 0 ? setInterval(() => {
    if (!open) return;
    if (pongDue && Date.now() > pongDue) { finish(1006); try { socket.destroy(); } catch {} return; }
    if (!pongDue) pongDue = Date.now() + pingMs * 2;
    write(0x9, Buffer.alloc(0));
  }, pingMs) : null;
  timer?.unref?.();

  const pump = () => {
    for (;;) {
      if (!open || buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxMessage)) return ws.close(1009, 'message too big');
        len = Number(big); off = 10;
      }
      if (len > maxMessage) return ws.close(1009, 'message too big');
      if (!masked) return ws.close(1002, 'unmasked client frame');   // RFC 6455 §5.1
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) { ws.close(1000); return; }
      if (op === 0x9) { write(0xa, payload); continue; }
      if (op === 0xa) { pongDue = 0; continue; }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) fragOp = op;
        fragments.push(payload);
        fragLen += payload.length;
        if (fragLen > maxMessage) return ws.close(1009, 'message too big');
        if (!fin) continue;
        const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
        const kind = fragOp;
        fragments = []; fragLen = 0; fragOp = 0;
        pongDue = 0;   // 收到任何数据都算活着
        try {
          if (kind === 0x2) ws.onBinary(whole);
          else ws.onText(whole.toString('utf8'));
        } catch (e) { console.error('[ws] handler threw:', e?.message || e); }
        continue;
      }
      return ws.close(1002, 'bad opcode');
    }
  };
  socket.on('data', (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; pump(); });
  socket.on('close', () => finish(1006));
  socket.on('error', () => finish(1006));
  // 对端直接断开（没发 close 帧）：升级后的 socket 是半开的，不主动关就一直挂着（server.close 也等不完）
  socket.on('end', () => { finish(1006); try { socket.destroy(); } catch {} });
  if (buf.length) queueMicrotask(pump);
  return ws;
}

function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
