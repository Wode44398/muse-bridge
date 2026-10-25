// 临时对话（服务端 src/claude-quick.mjs，原「快照」）的前端小工具：到期天数、要不要提示、「新对话」落点、
// 新对话快捷键、冷启动默认落点。纯函数、不碰 Svelte 状态，单测见 quickChat.test.js。
//
// 回收策略的天数以服务端为准（/api/sessions 的 quickPolicy / quickExpires），这里的 DEFAULT_POLICY 只在
// 老服务端没回这些字段时兜底，数值与服务端 QUICK_* 常量一致。

export const DAY = 24 * 3600 * 1000;
export const DEFAULT_POLICY = Object.freeze({ ttlDays: 30, warnDays: 3, trashDays: 30 });

/** 服务端回的策略 → 补齐缺项 */
export function quickPolicy(p) {
  const ok = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return {
    ttlDays: ok(p?.ttlDays, DEFAULT_POLICY.ttlDays),
    warnDays: ok(p?.warnDays, DEFAULT_POLICY.warnDays),
    trashDays: ok(p?.trashDays, DEFAULT_POLICY.trashDays),
  };
}

/** 离 at 还剩几天（向上取整、最少 0）；没有时间 → null */
export function daysLeft(at, now = Date.now()) {
  if (!Number.isFinite(at) || at <= 0) return null;
  return Math.max(0, Math.ceil((at - now) / DAY));
}

/** 到期前 warnDays 天内才提示（界面上的「n 天后清理」角标与输入框上方横条） */
export function expiryWarn(expiresAt, policy, now = Date.now()) {
  const d = daysLeft(expiresAt, now);
  return d != null && d <= quickPolicy(policy).warnDays;
}

/**
 * 「新对话」落在哪个项目（审查 2.9：在临时对话里点「新对话」，落到最近用过的真实项目）：
 *   当前归属是真实项目 → 就在它里面开；
 *   当前在临时对话 / 没有归属 → 会话列表里最近用过的真实项目（列表按最近活动倒序）；
 *   都没有 → 默认工作空间。返回项目 id，或 null（项目列表还没到：交给服务端按默认工作空间开）。
 */
export function newChatTarget({ currentProjectId = null, projects = [], sessions = [] } = {}) {
  const real = new Map((projects || []).filter((p) => p && p.id && !p.quick).map((p) => [p.id, p]));
  if (currentProjectId && real.has(currentProjectId)) return currentProjectId;
  for (const s of sessions || []) if (s && s.projectId && real.has(s.projectId)) return s.projectId;
  const def = (projects || []).find((p) => p && p.def && !p.quick) || [...real.values()][0];
  return def ? def.id : null;
}

/**
 * 新对话快捷键（官方同款）：网页 Ctrl/⌘+Shift+O——浏览器把 Ctrl+N 留给「新窗口」，页面拦不住；
 * 桌面壳（Electron，没有占用 Ctrl+N）另认 Ctrl/⌘+N。Alt 组合一律不认（桌面壳全局快捷键 Ctrl+Alt+N 归主进程）。
 */
export function isNewChatKey(e, { desktop = false } = {}) {
  if (!e || e.altKey || !(e.ctrlKey || e.metaKey)) return false;
  const k = String(e.key || '').toLowerCase();
  if (e.shiftKey) return k === 'o' || e.code === 'KeyO';
  return !!desktop && (k === 'n' || e.code === 'KeyN');
}

/** 侧栏「新对话」行尾的快捷键提示 */
export function newChatKbd({ desktop = false, mac = false } = {}) {
  if (desktop) return mac ? '⌘N' : 'Ctrl N';
  return mac ? '⇧⌘O' : 'Ctrl ⇧ O';
}

/**
 * 冷启动、没有可恢复的会话时落在哪（审查 D10 选 b）：
 *   设置里明确选过 temp / workspace 就照它；
 *   否则管理员（主机本人）落临时对话（沿用一直以来的习惯），其他成员落自己的工作空间——
 *   临时对话 30 天没动会清理，生人第一次用不该默认落在会被清理的地方。
 */
export function landingFor({ setting = '', kind = '' } = {}) {
  if (setting === 'temp' || setting === 'workspace') return setting;
  return kind === 'admin' ? 'temp' : 'workspace';
}
