// Claude 分页会话级模型偏好（sidecar）。
//
// 背景：模型/effort/fast 的选择器一直是纯内存态——杀后台重进全部重置（维护者 08-11
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
  // 会话表按会话 id 做键：用无原型对象，键名是 __proto__ / constructor 也只是普通键（10-21 审查）
  data.sessions = Object.assign(Object.create(null), data.sessions && typeof data.sessions === 'object' ? data.sessions : {});
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
// 会话级输出风格覆盖（2026-10-20，官方会话菜单「Output style」同款）：只挂在会话条目上，不进 last——
// 新会话从设置里的默认风格起步（官方语义），不沿用上一个会话单独选的。null = 跟随默认。
const styleOf = (p) => (p && typeof p.outputStyle === 'string' && p.outputStyle ? p.outputStyle : null);

export function recordChatPrefs(ctx, sessionId, prefs) {
  if (!ctx?.dataDir || !sessionId) return;
  const file = fileFor(ctx);
  const data = load(file);
  // 会话条目上挂两样会话级覆盖，每轮记选择器时都要保住：
  //  · outputStyle（会话菜单选的输出风格）：请求没带（老客户端 / 没改过）就保留原有的；
  //  · permissionMode（runtime/permissions.mjs 经 setChatPrefsPermissionMode 写）：原样带上。
  // 两者都不进 last——新对话的默认风格 / 模式另有来源（设置默认、按文件夹记忆）。
  const prev = data.sessions[sessionId];
  const style = prefs && prefs.outputStyle !== undefined ? styleOf(prefs) : styleOf(prev);
  const prevMode = prev?.permissionMode;
  //  · computer（会话连接的设备，setDeviceLink 写；新会话的第一轮可由请求带来）：同上，不进 last。
  const link = linkOf(prev?.computer) || linkOf(prefs?.computer);
  const entry = { ...norm(prefs), ...(style ? { outputStyle: style } : {}), ...(prevMode ? { permissionMode: prevMode } : {}), ...(link ? { computer: link } : {}), at: Date.now() };
  data.sessions[sessionId] = entry;
  data.last = { ...norm(prefs), at: entry.at };
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

// 会话菜单里给单个会话选输出风格（null = 回到设置里的默认）。下一轮起生效：风格进了启动参数签名，
// 停放的 CLI 判「options changed」冷起。不动 at——这不是选择器记忆，别让它顶掉别的设备上刚选的模型。
export function setChatPrefsOutputStyle(ctx, sessionId, style) {
  if (!ctx?.dataDir || !sessionId) return;
  const file = fileFor(ctx);
  const data = load(file);
  const cur = data.sessions[sessionId] || { ...norm(null), at: 0 };
  const next = { ...cur };
  if (style) next.outputStyle = style; else delete next.outputStyle;
  data.sessions[sessionId] = next;
  persist(file, data);
}

// 会话级权限模式（runtime/permissions.mjs）：会话里切模式、CLI 自己报来的模式变化（计划批准 / 模型自行进入计划）
// 都记在该会话的条目上，下一轮 spawn 时按它显式传 permissionMode。只改这一个字段。
export function setChatPrefsPermissionMode(ctx, sessionId, mode) {
  if (!ctx?.dataDir || !sessionId || !mode) return;
  const file = fileFor(ctx);
  const data = load(file);
  // 还没有条目（Desktop / 终端开的会话、被 CAP 淘汰的）：占位条目的 at 记 0——前端按 at 合并选择器记忆，
  // 占位的 null 模型 / effort 不能盖掉本机给这个会话记的选择
  const cur = data.sessions[sessionId] || { ...norm(null), at: 0 };
  if (cur.permissionMode === mode) return;
  // at 不动：它是选择器（model/effort/fast）跨设备合并的时间戳，模式变化不该让服务端那份「更新」盖掉本机刚选的模型
  data.sessions[sessionId] = { ...cur, permissionMode: mode };
  persist(file, data);
}

// 会话连接的设备（mcp/device-tools.mjs）：设备 id，或 'none' = 明确不连接；没有条目 = 还没定（自动）。
// 输入框下方的设备芯片与 agent 的 devices(use=…) 都经这里改，工具每次调用现读——改了立刻生效，不用冷起 CLI。
function linkOf(v) {
  return typeof v === 'string' && (v === 'none' || /^d-[0-9a-f]{6,24}$/.test(v)) ? v : null;
}

export function deviceLinkFor(ctx, sessionId) {
  if (!ctx?.dataDir || !sessionId) return null;
  return linkOf(load(fileFor(ctx)).sessions[sessionId]?.computer);
}

export function setDeviceLink(ctx, sessionId, link) {
  if (!ctx?.dataDir || !sessionId) return false;
  const file = fileFor(ctx);
  const data = load(file);
  // 占位条目的 at 记 0（同 setChatPrefsPermissionMode）：不让它在跨设备合并时盖掉本机的选择器记忆
  const cur = data.sessions[sessionId] || { ...norm(null), at: 0 };
  const next = { ...cur };
  const v = linkOf(link);
  if (v) next.computer = v; else delete next.computer;
  data.sessions[sessionId] = next;
  persist(file, data);
  return true;
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
