// 会话信息面板（官方 Desktop 2.37337 的 Session rail）开关与卡片折叠状态。
// 官方把「显示面板」存在 persisted.epitaxy.sessionRailShown，卡片展开/收起按会话存；
// 这里两者都按本机存（localStorage），卡片折叠全局一份——bridge 没有官方那张按会话的偏好表。
import { storeGet, storeSet } from './store.js';

const SHOWN_KEY = 'bridge-session-rail';
const FOLD_KEY = 'bridge-session-rail-fold';

function readFold() {
  try { const v = JSON.parse(storeGet(FOLD_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

// shown：宽屏停靠形态记住的开关；narrow：聊天区放不下停靠（面板自己量出来的）；
// pop：窄屏下点按钮弹出的临时弹层（不记，点外面 / Esc 就收）。官方同款分法。
export const rail = $state({ shown: storeGet(SHOWN_KEY) === '1', fold: readFold(), narrow: false, pop: false });

export function railVisible() { return rail.narrow ? rail.pop : rail.shown; }

export function toggleRail(force) {
  if (rail.narrow) { rail.pop = typeof force === 'boolean' ? force : !rail.pop; return; }
  rail.shown = typeof force === 'boolean' ? force : !rail.shown;
  try { storeSet(SHOWN_KEY, rail.shown ? '1' : '0'); } catch {}
}

// 默认：上下文、连接器收起（官方截图里这两张是收起态，只露摘要），其余展开
const DEFAULT_FOLD = { context: true, connectors: true };
export function isFolded(card) {
  return card in rail.fold ? !!rail.fold[card] : !!DEFAULT_FOLD[card];
}
export function toggleFold(card, all) {
  const next = !isFolded(card);
  if (all) for (const k of ['environment', 'context', 'connectors', 'outputs', 'pr', 'changes']) rail.fold[k] = next;
  else rail.fold[card] = next;
  try { storeSet(FOLD_KEY, JSON.stringify(rail.fold)); } catch {}
}
