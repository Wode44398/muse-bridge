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

// Fires a `: ping\n\n` comment every 15s so a long tool run doesn't look dead
// to the client and Cloudflare's tunnel doesn't idle-close the connection.
export function startHeartbeat(res) {
  return setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
}

// Heartbeat variant for multi-subscriber buffered generations (Claude).
export function startMultiHeartbeat(subscribers) {
  return setInterval(() => {
    for (const r of subscribers) { if (!r.writableEnded) r.write(': ping\n\n'); }
  }, 15000);
}
