// agent 的统一 id 与各子系统叫法的对照表——前后端共用的【纯数据】（前端编译期直接 import，
// 同 capabilities.mjs），这里不许 import 任何 node 模块。
//
// 统一 id：claude / gemini / codex / dimensio。历史上各处叫法不一：
//   页面 ui.screen      claude / vertex / chatgpt / harness
//   聊天 agent 字段      claude / vertex / codex
//   扩展中心的勾选列     claude / codex / dimensio
// 新代码一律用统一 id；要落到某个子系统时查这张表，别再各写一份。
//
// multiUser：这个 agent 能不能开给注册用户（多租户隔离做没做完）。false 的只给管理员——
//   codex 的工具调用在进程内部执行，绕过 bridge 的沙箱守卫，且共用主机上的登录与会话目录。
//   dimensio 是每人一个进程、锁在自己文件夹里的租户实例，所以可以。

// 前后端各处按这张表认 agent：表里没有的 id（含名单 / 配置里残留的旧 id）处处不存在。
export const AGENTS = Object.freeze([
  { id: 'claude', label: 'Claude', screen: 'claude', chat: 'claude', multiUser: true },
  { id: 'gemini', label: 'Gemini', screen: 'vertex', chat: 'vertex', multiUser: true },
  { id: 'codex', label: 'ChatGPT · Codex', screen: 'chatgpt', chat: 'codex', multiUser: false },
  // dimensio：2026-09-28 起每个注册用户一个 harness 进程（routes/harness.mjs 实例池 + harness 租户模式），可以按人放行。
  { id: 'dimensio', label: 'dimensio', screen: 'harness', chat: null, multiUser: true },
]);

export const AGENT_IDS = Object.freeze(AGENTS.map((a) => a.id));
export const AGENT_BY_ID = Object.freeze(Object.fromEntries(AGENTS.map((a) => [a.id, a])));

// 注册用户没被单独设置过名单时的默认（2026-09-23 维护者定：注册用户只有 Claude 与 Gemini）。
export const USER_DEFAULT_AGENTS = Object.freeze(['claude', 'gemini']);

// 名单归一：只留认识的 id、去重、按表内顺序。
export function normAgentList(list) {
  const want = new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()));
  return AGENT_IDS.filter((id) => want.has(id));
}

// 某个页面（ui.screen）由哪些 agent 撑着：任一可用，这一页就该出现。
export function screenAgents(screen) {
  const s = screen === 'antigravity' ? 'harness' : screen;
  return AGENTS.filter((a) => a.screen === s).map((a) => a.id);
}

// 聊天请求里的 agent 字段 → 统一 id。
export function agentOfChat(chat) {
  const hit = AGENTS.find((a) => a.chat === chat);
  return hit ? hit.id : null;
}
