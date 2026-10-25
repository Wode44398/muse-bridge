// 模型主动推送 → 手机通知栏（2026-10-18）。
// CLI 的 PushNotification 工具在 SDK 宿主下没有投递通道（没开 Remote Control 时它只回
// 「Mobile push not sent」），bridge 用 PostToolUse 钩子接住它的 message 记在这里；
// GET /api/active 带给手机 App 的原生后台服务（AgentService 每 5s 轮询），由它弹进通知栏。
// 只存内存、按 caller key 隔离，30 分钟后自然过期——这是「提醒」，不是消息记录。

const KEEP_MS = 30 * 60_000;
const MAX_PER_KEY = 20;
const store = new Map();   // key -> [{ id, sessionId, message, at }]
let seq = 0;

export function notePush(key, { sessionId, message }) {
  const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!key || !text) return null;
  const now = Date.now();
  const list = (store.get(key) || []).filter((p) => now - p.at < KEEP_MS);
  const item = { id: `${now.toString(36)}-${(++seq).toString(36)}`, sessionId: sessionId || null, message: text, at: now };
  list.push(item);
  while (list.length > MAX_PER_KEY) list.shift();
  store.set(key, list);
  return item;
}

// 给轮询方：附 ageMs（服务端算好的「多久之前」）——手机与 PC 时钟不同步也不会误判新旧。
export function recentPushes(key) {
  const now = Date.now();
  return (store.get(key) || [])
    .filter((p) => now - p.at < KEEP_MS)
    .map((p) => ({ id: p.id, sessionId: p.sessionId, message: p.message, ageMs: now - p.at }));
}
