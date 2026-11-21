// fetch 版 SSE 读取器（EventSource 带不了 Authorization 头）——终端、浏览器面板的直播流共用。
// onEvent 收 JSON 对象；返回 abort 函数。断流不自动重连——重连策略由各面板自己定。
// onBeat：每收到一块字节就调（含服务端 10 秒一次的心跳注释）——面板拿它判断流是不是悄悄死了：
// 手机切后台再回来，连接常常已被系统或隧道掐断，fetch 却既不报错也不结束，不看心跳就永远等下去。
import { apiUrl } from '../server.js';
import { authHeaders } from '../api.js';

export function readDockSse(path, onEvent, { onDead, onClose, onBeat } = {}) {
  const ctrl = new AbortController();
  (async () => {
    let res;
    try {
      res = await fetch(apiUrl(path), { headers: authHeaders(), credentials: 'same-origin', signal: ctrl.signal });
    } catch { if (!ctrl.signal.aborted) onClose?.(); return; }
    // 第二个参数：服务端回的 JSON（{error}），面板据此给出具体原因（如设备离线、客户端太老）
    if (!res.ok || !res.body) { onDead?.(res?.status || 0, res ? await res.json().catch(() => null) : null); return; }
    const dec = new TextDecoder();
    const reader = res.body.getReader();
    let buf = '';
    const drain = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* malformed frame */ }
        }
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onBeat?.();
        drain(dec.decode(value, { stream: true }));
      }
    } catch { /* aborted / network */ }
    if (!ctrl.signal.aborted) onClose?.();
  })();
  return () => ctrl.abort();
}
