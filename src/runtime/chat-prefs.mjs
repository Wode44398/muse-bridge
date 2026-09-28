// Claude 分页会话级模型偏好（sidecar）。
//
// 背景：模型/effort/fast 的选择器一直是纯内存态——杀后台重进全部重置（用户 08-11
// 点名）。transcript（SDK 的 jsonl）只记 assistant 消息用的 model，不记 effort/fast，
// 也轮不到我们去改写；所以「这个对话上次用什么跑的」单独落一个小 JSON。
//
// 语义：每次 /api/chat 发送时按会话记录（见 agents/claude.mjs 的 recordPrefs 注入点，
// 新会话等 init 拿到 id 再记）；/api/session 把该会话的偏好回给前端恢复选择器；
// /api/sessions 附带 last（最近一次的选择）给「新对话」当默认。按身份数据目录
// （ctx.dataDir）隔离，多用户互不可见；条目上限防无限膨胀。
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CAP = 400;           // 只留最近 N 个会话的偏好
const cache = new Map();   // file -> data（bridge 单进程，读写都走这份内存，磁盘只是持久化）

const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-chat-prefs.json');

function load(file) {
  if (cache.has(file)) return cache.get(file);
  let data = null;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (!data || typeof data !== 'object') data = {};
  if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {};
  cache.set(file, data);
  return data;
}

function persist(file, data) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch {}
}

// 只存显式选择：model/effort 为 null = 用服务端默认（前端选择器的「默认」态）。
const norm = (p) => ({
  model: p && typeof p.model === 'string' && p.model ? p.model : null,
  effort: p && typeof p.effort === 'string' && p.effort ? p.effort : null,
  fast: !!(p && p.fast),
});

export function recordChatPrefs(ctx, sessionId, prefs) {
  if (!ctx?.dataDir || !sessionId) return;
  const file = fileFor(ctx);
  const data = load(file);
  const entry = { ...norm(prefs), at: Date.now() };
  data.sessions[sessionId] = entry;
  data.last = entry;
  const ids = Object.keys(data.sessions);
  if (ids.length > CAP) {
    ids.sort((a, b) => (data.sessions[a]?.at || 0) - (data.sessions[b]?.at || 0));
    for (const id of ids.slice(0, ids.length - CAP)) delete data.sessions[id];
  }
  persist(file, data);
}

export function chatPrefsFor(ctx, sessionId) {
  if (!ctx?.dataDir || !sessionId) return null;
  return load(fileFor(ctx)).sessions[sessionId] || null;
}

export function lastChatPrefs(ctx) {
  if (!ctx?.dataDir) return null;
  return load(fileFor(ctx)).last || null;
}

// 模型安全栅门把会话模型切到回退模型（model_refusal_fallback / model_consent_fallback，scope:'session'）：
// 官方语义是「本会话此后都用回退模型，用户手动切回」。bridge 每轮都显式传 --model，CLI 的 latch 不跨
// 进程保持，所以由我们把 sidecar 里记忆的 model 改掉：重开会话时选择器直接落在回退模型上（当轮前端靠
// session{swapped} 事件切）。只改本会话的条目，不动 last——切换是会话级的，新对话的默认不受影响。
export function swapChatPrefsModel(ctx, sessionId, model, from) {
  if (!ctx?.dataDir || !sessionId || !model) return;
  const file = fileFor(ctx);
  const data = load(file);
  const cur = data.sessions[sessionId] || norm(null);
  data.sessions[sessionId] = { ...cur, model, swappedFrom: from || cur.swappedFrom || null, swappedAt: Date.now(), at: Date.now() };
  persist(file, data);
}

// 会话删除时的卫生清理（留着也只是占条目，但能清就清）。
export function dropChatPrefs(ctx, sessionId) {
  if (!ctx?.dataDir || !sessionId) return;
  const file = fileFor(ctx);
  const data = load(file);
  if (data.sessions[sessionId]) {
    delete data.sessions[sessionId];
    persist(file, data);
  }
}
