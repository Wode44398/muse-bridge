// Claude 工作中「稍后发送」的排队消息（官方 Code 页 Ctrl+Enter，2026-10-14 对齐 Desktop 2.37337）。
//
// 官方做法照搬：排队消息【不交给 CLI】，由宿主（这里是 bridge 服务端）自己持有；这一轮出结果、
// 收尾之后把所有排队消息【合并成一条】发出去（官方 drainDeferredSends，日志 "coalesced to 1"）。
// 停止当前轮不清队列——收尾后照样发（官方同款）。放在服务端而不是前端：手机和电脑看见同一份队列、
// 都能改，页面关掉也照发。
//
// 发出 = 在服务端内部把排队时那条 /api/chat 请求【原样重放】一次（同一身份、同一套参数，正文换成
// 合并后的文字、附件取并集）：项目归属、单写者判活、并发上限、选择器记忆全走现成路由，不另起一套。
// 前端不用管——重放开出的新一轮照常在总线上广播 run.start，正看这个会话的设备自动挂上直播。
//
// 队列只在内存里（官方也是主进程内存）；服务重启即清空。
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { busPublish } from './bus.mjs';
import { findGenBySession } from './gen.mjs';
import { INTERNAL_IDENTITY, REPLAY_AS_HEADER, identityFromReplayTag } from './identity.mjs';

const MAX_ITEMS = 20;
const MAX_TEXT = 100_000;
const DRAIN_DELAY_MS = 400;     // run.end 之后稍等：挂起接力（handoff）也会先收旧轮，紧跟着就有新轮
const store = new Map();        // `${key}|${sessionId}` → { items: [...] }
let replayer = null;            // chat 路由注入：({ headers, url, body }) => Promise<{ status }>
const timers = new Map();

const k = (key, sid) => key + '|' + sid;

export function setQueueReplayer(fn) { replayer = fn; }
// 同一个重放口给别的服务端发起方用（limit-resume.mjs：5 小时限额重置后自动继续）
export function replayChat(rq) { return replayer ? replayer(rq) : Promise.resolve({ status: 0, detail: 'replayer not ready' }); }

// 给前端看的一份（不含身份头与原始请求体）
function view(items) {
  return items.map((it) => ({ id: it.id, text: it.text, files: it.files, at: it.at }));
}

function publish(key, sid, extra = {}) {
  const items = store.get(k(key, sid))?.items || [];
  busPublish(key, { type: 'queue', sessionId: sid, items: view(items), ...extra });
  return view(items);
}

export function listQueue(key, sid) {
  return view(store.get(k(key, sid))?.items || []);
}

// headers / url：重放时用的身份（authorization / cookie / user-agent / x-bridge-device 头；快照身份在 url 的 ?ct=）；body：原请求体
export function enqueue(key, sid, { message, attachments, body, headers, url }) {
  const slot = store.get(k(key, sid)) || { items: [] };
  if (slot.items.length >= MAX_ITEMS) { const e = new Error('排队消息太多了（最多 ' + MAX_ITEMS + ' 条），等 Claude 处理完再加'); e.status = 429; throw e; }
  const item = {
    id: randomUUID(),
    text: String(message || '').slice(0, MAX_TEXT),
    files: (attachments || []).map((p) => path.basename(p)),
    attachments: attachments || [],
    body: { ...body, priority: undefined },
    headers,
    url: url || '/api/chat',
    at: Date.now(),
  };
  slot.items.push(item);
  store.set(k(key, sid), slot);
  const items = publish(key, sid);
  // 排进来的那一刻这一轮恰好已经收尾了（竞态）：直接排一次发送
  if (!liveTurn(key, sid)) scheduleDrain(key, sid);
  return { item: view([item])[0], items };
}

// 移出（删除 / 放回输入框编辑共用）：返回被移出的那条（含附件路径，前端放回输入框要用）
export function removeItem(key, sid, id) {
  const slot = store.get(k(key, sid));
  const i = slot ? slot.items.findIndex((it) => it.id === id) : -1;
  if (i < 0) return { item: null, items: listQueue(key, sid) };
  const [it] = slot.items.splice(i, 1);
  if (!slot.items.length) store.delete(k(key, sid));
  return { item: { id: it.id, text: it.text, files: it.files, attachments: it.attachments }, items: publish(key, sid), raw: it };
}

// 原样放回队首（立即发送没插进去时用）
export function enqueueFront(key, sid, raw) {
  const slot = store.get(k(key, sid)) || { items: [] };
  slot.items.unshift(raw);
  store.set(k(key, sid), slot);
  return publish(key, sid);
}

export function moveItem(key, sid, id, to) {
  const slot = store.get(k(key, sid));
  const i = slot ? slot.items.findIndex((it) => it.id === id) : -1;
  if (i < 0) return listQueue(key, sid);
  const [it] = slot.items.splice(i, 1);
  const j = Math.max(0, Math.min(slot.items.length, Number(to) | 0));
  slot.items.splice(j, 0, it);
  return publish(key, sid);
}

export function clearQueue(key, sid) {
  store.delete(k(key, sid));
  return publish(key, sid);
}

function liveTurn(key, sid) {
  const g = findGenBySession(key, sid);
  return !!(g && !g.done);
}

// 合并规则（官方 coalesce）：正文按顺序空一行拼接，附件取并集；其余参数（模型、effort、项目……）
// 取最后一条的——那是用户最近一次的选择。
export function coalesce(items) {
  const last = items[items.length - 1];
  const seen = new Set();
  const attachments = [];
  for (const it of items) for (const p of it.attachments || []) if (!seen.has(p)) { seen.add(p); attachments.push(p); }
  const message = items.map((it) => it.text).filter((t) => t && t.trim()).join('\n\n');
  return { headers: last.headers, url: last.url, body: { ...last.body, message, attachments, priority: undefined } };
}

// 这个会话的一轮收尾了（claude.mjs retireTurn 调）
export function noteRunEnd(key, sid) {
  if (!key || !sid || !store.has(k(key, sid))) return;
  scheduleDrain(key, sid);
}

function scheduleDrain(key, sid) {
  const tk = k(key, sid);
  if (timers.has(tk)) return;
  timers.set(tk, setTimeout(() => { timers.delete(tk); drain(key, sid).catch(() => {}); }, DRAIN_DELAY_MS));
}

// 立即把队列（或其中一条）发出去。ids 缺省 = 全部。返回是否已发出。
export async function drain(key, sid, ids) {
  if (liveTurn(key, sid) || !replayer) return false;
  const slot = store.get(k(key, sid));
  if (!slot || !slot.items.length) return false;
  const take = ids ? slot.items.filter((it) => ids.includes(it.id)) : slot.items.slice();
  if (!take.length) return false;
  slot.items = slot.items.filter((it) => !take.includes(it));
  if (!slot.items.length) store.delete(k(key, sid));
  publish(key, sid, { sending: take.map((it) => it.id) });
  const { headers, url, body } = coalesce(take);
  const queuedAt = Math.min(...take.map((it) => it.at || Date.now()));
  console.log(`[claude-queue] ${sid.slice(0, 8)} drained ${take.length} queued message(s)${take.length > 1 ? ' (coalesced to 1)' : ''} after ${Math.round((Date.now() - queuedAt) / 1000)}s in queue`);
  let status = 0, detail = '';
  try { ({ status, detail = '' } = await replayer({ headers, url, body, queuedAt })); } catch { status = 500; }
  if (status >= 400 || status === 0) {
    // 没发出去（会话被别处占用 / 鉴权变了 / 上一轮还没退干净）：原样放回队首，告诉前端
    const back = store.get(k(key, sid)) || { items: [] };
    back.items.unshift(...take);
    store.set(k(key, sid), back);
    publish(key, sid, { error: '排队消息没能发出（状态 ' + (status || '未知') + '），已放回队列' });
    console.log(`[claude-queue] ${sid.slice(0, 8)} replay failed (status ${status}) — items put back ${String(detail).slice(0, 300)}`);
    return false;
  }
  return true;
}

// —— 内部重放用的假请求 / 假响应 ——
// 重放头里的进程内身份标记（agent 接口发起的轮，见 runtime/identity.mjs replayHeadersOf）换回身份：现查账号，停用了就不给。
export function fakeRequest({ headers, url, body }) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  const { [REPLAY_AS_HEADER]: as, ...rest } = headers || {};
  req.headers = { ...rest, 'content-type': 'application/json' };
  req.method = 'POST';
  req.url = url || '/api/chat';
  req.socket = { remoteAddress: '127.0.0.1' };
  if (as) { const id = identityFromReplayTag(as); if (id) req[INTERNAL_IDENTITY] = id; }
  return req;
}

export function fakeResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableEnded = false;
  res.headersSent = false;
  res.writeHead = (code) => { res.statusCode = code; res.headersSent = true; return res; };
  res.setHeader = () => {};
  res.getHeader = () => undefined;
  res.flushHeaders = () => { res.headersSent = true; };
  res.chunks = [];
  res.write = (c) => { if (res.chunks.length < 8 && c != null) res.chunks.push(String(c)); return true; };
  res.end = (c) => { if (c != null && res.chunks.length < 8) res.chunks.push(String(c)); if (!res.writableEnded) { res.writableEnded = true; res.emit('finish'); res.emit('close'); } };
  return res;
}
