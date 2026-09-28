// 输入建议（2026-09-28，官方 Claude Code 的 prompt suggestion）：每轮收尾后 CLI 预测的「下一句」，
// 输入框空着时当占位文字显示，Tab 一键填入。来源是 SDK query 的 promptSuggestions 选项——
// result 之后再等几秒才吐一条 {type:'prompt_suggestion', suggestion}（见 agents/claude.mjs 的挂等段）。
//
// 这里只是按 caller key + sessionId 记最近一条，给总线 hello 帧交底（刷新页面 / 换设备 / 断线重连
// 后输入框照样有建议）；实时那条走 busPublish。纯内存、不落盘：建议是「这一刻」的东西，服务重启
// 丢了就丢了。会话开新一轮时清掉（run.start 那一刻它就过时了）。

const store = new Map();   // key|sid -> { text, at }
const MAX = 80;

const k = (key, sid) => key + '|' + sid;

export function setSuggestion(key, sid, text) {
  if (!key || !sid || !text) return null;
  const v = { text, at: Date.now() };
  const id = k(key, sid);
  store.delete(id);
  store.set(id, v);
  while (store.size > MAX) store.delete(store.keys().next().value);
  return v;
}

export function clearSuggestion(key, sid) {
  if (key && sid) store.delete(k(key, sid));
}

// 这个 key 名下全部会话的建议：{ [sid]: { text, at } }（hello 帧用）
export function listSuggestions(key) {
  const out = {};
  const pre = key + '|';
  for (const [id, v] of store) if (id.startsWith(pre)) out[id.slice(pre.length)] = v;
  return out;
}

// CLI 给的是模型原话：压成单行、去掉包裹引号、截长。空/纯标点当没有。
export function normalizeSuggestion(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '').trim();
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return '';
  return t.length > 300 ? t.slice(0, 300) : t;
}
