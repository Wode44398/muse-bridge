// Small helpers for the SSE responses scattered across the route + agent files.
// All branches (chat, veo, music, attach) share the same response headers and
// the same heartbeat shape — keep them here so a tweak only happens in one place.

export function writeSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

export function sseWrite(res, obj) {
  if (res && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// 心跳间隔：所有 SSE（对话 / attach / 事件总线 bus.mjs / dock 终端）共用这一个数。
// 前端看门狗按「多久没收到任何字节」判半开（web/src/lib/sse.js：回前台 20s、平时 40s），
// 阈值必须盖过至少一个完整心跳再留余量。2026-10-21 从 15s 降到 10s（回归 FR4）：老 apk 里的前端
// 回前台阈值还是 12s，小于 15s 心跳时窗口一获得焦点就可能把健康的直播流掐掉、整轮重放。
// 10s 只是【大幅降低】老 apk 的误杀概率，不是消除：12s 窗口对 10s 心跳只剩 2s 余量，事件循环一卡
// （开 Claude 页、拉会话列表实测卡 0.1–2.4s）把某一拍 ping 推迟 2s 以上，回前台那一下照样会误判。
// 彻底消除靠升级到新 apk（前端回前台 20s、不再挂 focus），以及把服务端那几处卡顿修掉。
// 没取 5s（老 12s 窗口里稳有两拍）：总线是常驻长连接，5s 一拍会让手机射频几乎没有空闲的时候，
// 为一个过渡期的残余风险常年多耗电不划算。每条连接多出的只是每 10s 八个字节。
export const HEARTBEAT_MS = 10_000;

// Fires a `: ping\n\n` comment every HEARTBEAT_MS so a long tool run doesn't look dead
// to the client and Cloudflare's tunnel doesn't idle-close the connection.
export function startHeartbeat(res) {
  return setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, HEARTBEAT_MS);
}

// Heartbeat variant for multi-subscriber buffered generations (Claude).
export function startMultiHeartbeat(subscribers) {
  return setInterval(() => {
    for (const r of subscribers) { if (!r.writableEnded) r.write(': ping\n\n'); }
  }, HEARTBEAT_MS);
}
