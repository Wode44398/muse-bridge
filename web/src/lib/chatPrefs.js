// Claude 分页会话级选择器记忆（model / effort / fast）的本地镜像。
//
// 双源：服务端 sidecar（src/runtime/chat-prefs.mjs，随 /api/session 和 /api/sessions
// 下发，跨设备一致）+ 这里的 localStorage 镜像（杀后台冷启动/离线也能立刻恢复，
// 不用等隧道往返）。合并规则：谁的 at 新听谁的。
//
// 纯存储模块——不 import 任何 state（state.svelte.js 反过来要 import 它取启动默认，
// 别造环）。快照页（IS_CSNAP）由调用方负责不写不读。
const KEY = 'bridge-claude-prefs';
const CAP = 300;

let store = null;
function load() {
  if (store) return store;
  try { store = JSON.parse(localStorage.getItem(KEY) || 'null') || {}; } catch { store = {}; }
  if (!store.sessions || typeof store.sessions !== 'object') store.sessions = {};
  return store;
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {}
}
const norm = (p) => (p ? { model: p.model || null, effort: p.effort || null, fast: !!p.fast, at: p.at || 0 } : null);

// 该会话上次用的选择（无记录 = null → 选择器回「默认」态）。
export function prefsFor(id) {
  return id ? norm(load().sessions[id]) : null;
}

// 最近一次的选择——新对话的默认。
export function lastPrefs() {
  return norm(load().last);
}

// 本地记一笔（选择器变更 / 发送时）。id 为空 = 只更新 last（新会话 id 还没回来）。
export function notePrefs(id, p) {
  const s = load();
  const entry = { model: p?.model || null, effort: p?.effort || null, fast: !!p?.fast, at: Date.now() };
  if (id) s.sessions[id] = entry;
  s.last = entry;
  const ids = Object.keys(s.sessions);
  if (ids.length > CAP) {
    ids.sort((a, b) => (s.sessions[a]?.at || 0) - (s.sessions[b]?.at || 0));
    for (const drop of ids.slice(0, ids.length - CAP)) delete s.sessions[drop];
  }
  save();
}

// 服务端下发的该会话偏好并入本地（服务端 at 更新才覆盖——本机刚改过的选择不被旧值顶掉）。
export function absorbServerPrefs(id, p) {
  if (!id || !p) return;
  const s = load();
  const cur = s.sessions[id];
  if (!cur || (p.at || 0) >= (cur.at || 0)) { s.sessions[id] = norm(p); save(); }
}

// 服务端下发的 last 并入（别的设备上最近的选择也能当本机新对话默认）。
export function absorbLastPrefs(p) {
  if (!p) return;
  const s = load();
  if (!s.last || (p.at || 0) > (s.last.at || 0)) { s.last = norm(p); save(); }
}
