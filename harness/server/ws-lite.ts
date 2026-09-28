import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// 最小 WebSocket 服务端（RFC 6455）：只给 Edge 扩展那一条回环连接用——文本帧、分片、ping/pong、close。
// harness 只有 express 一个运行时依赖，为一条连接引一个 ws 包不值当；客户端（扩展 service worker）是
// 标准浏览器 WebSocket，协议面就这么多。不支持扩展（permessage-deflate 等）：握手里不回，浏览器就不用。

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 64 * 1024 * 1024; // 截图 / 直播帧是 base64，给足余量

export interface LiteSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  readonly open: boolean;
  onMessage: (text: string) => void;
  onClose: () => void;
}

// 完成握手并返回套接字；请求不像 WebSocket 升级就回 400 并返回 null。
export function acceptWebSocket(req: IncomingMessage, socket: Duplex): LiteSocket | null {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  if (String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || !key) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  (socket as Duplex & { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);

  let open = true;
  let buf: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragLen = 0;

  const ws: LiteSocket = {
    get open() {
      return open;
    },
    onMessage: () => {},
    onClose: () => {},
    send(text: string) {
      if (!open) return;
      socket.write(frame(0x1, Buffer.from(text, "utf8")));
    },
    close(code = 1000, reason = "") {
      if (!open) return;
      const r = Buffer.from(reason, "utf8").subarray(0, 120);
      const body = Buffer.alloc(2 + r.length);
      body.writeUInt16BE(code, 0);
      r.copy(body, 2);
      try {
        socket.write(frame(0x8, body));
      } catch {
        /* 对端已断 */
      }
      finish();
      socket.end();
    },
  };

  const finish = () => {
    if (!open) return;
    open = false;
    try {
      ws.onClose();
    } catch {
      /* listener's problem */
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return ws.close(1009, "message too big");
        len = Number(big);
        off = 10;
      }
      // 客户端发来的帧必须带掩码（RFC 6455 §5.1）
      if (!masked) return ws.close(1002, "unmasked client frame");
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);

      if (op === 0x8) {
        ws.close(1000);
        return;
      }
      if (op === 0x9) {
        socket.write(frame(0xa, payload));
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        fragments.push(payload);
        fragLen += payload.length;
        if (fragLen > MAX_MESSAGE) return ws.close(1009, "message too big");
        if (!fin) continue;
        const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
        fragments = [];
        fragLen = 0;
        try {
          ws.onMessage(whole.toString("utf8"));
        } catch (e) {
          console.error("[ws-lite] handler threw:", (e as Error).message);
        }
      }
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);
  return ws;
}

function frame(op: number, payload: Buffer): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.from([0x80 | op, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}
