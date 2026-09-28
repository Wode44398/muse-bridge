// agent 的统一 id 与各子系统叫法的对照表——前后端共用的【纯数据】（前端编译期直接 import，
// 同 capabilities.mjs），这里不许 import 任何 node 模块。
//
// 统一 id：claude / dimensio。
//   页面 ui.screen      claude / harness
//   聊天 agent 字段      claude（dimensio 有自己的聊天接口，经 /api/harness/* 反代）
//   扩展中心的勾选列     claude / dimensio
// 新代码一律用统一 id；要落到某个子系统时查这张表，别再各写一份。
//
// multiUser：这个 agent 能不能开给注册用户。dimensio 是每人一个进程、锁在自己文件夹里的
//   租户实例，所以可以。
export const AGENTS = Object.freeze([
  { id: 'claude', label: 'Claude', screen: 'claude', chat: 'claude', multiUser: true },
  { id: 'dimensio', label: 'dimensio', screen: 'harness', chat: null, multiUser: true },
]);

export const AGENT_IDS = Object.freeze(AGENTS.map((a) => a.id));
export const AGENT_BY_ID = Object.freeze(Object.fromEntries(AGENTS.map((a) => [a.id, a])));

// 注册用户没被单独设置过名单时的默认：只有 Claude（dimensio 要在「用户」页按人放行）。
export const USER_DEFAULT_AGENTS = Object.freeze(['claude']);

// 名单归一：只留认识的 id、去重、按表内顺序。
export function normAgentList(list) {
  const want = new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim().toLowerCase()));
  return AGENT_IDS.filter((id) => want.has(id));
}

// 某个页面（ui.screen）由哪些 agent 撑着：任一可用，这一页就该出现。
export function screenAgents(screen) {
  return AGENTS.filter((a) => a.screen === screen).map((a) => a.id);
}

// 聊天请求里的 agent 字段 → 统一 id。
export function agentOfChat(chat) {
  const hit = AGENTS.find((a) => a.chat === chat);
  return hit ? hit.id : null;
}
