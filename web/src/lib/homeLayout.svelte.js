// 主页入口（手机主页的方块网格、桌面主页的 Dock、设置「主页」分区）共用的有状态那层：
// 可用入口 = 内置入口（按 screenOn 过滤）+ 插件应用（pluginUi.apps）；排序与隐藏存在 prefs.homeLayout（只存本机）。
// 纯逻辑在 lib/homeLayoutCore.js（有测试）。这里的函数都在调用时现读 state，放进 $derived 里就跟着变。
import { prefs, savePrefs, screenOn } from './state.svelte.js';
import { pluginUi } from './pluginUi.svelte.js';
// Claude 入口的小人是原版资源（web/src/visuals/，直接 import）
import mascotStand from '../visuals/assets/mascot/claude-小人-正面站立.svg';
import mascotFlag from '../visuals/assets/mascot/claude-小人-举旗.svg';
import { arrangeHome, moveKey, setHidden, normalizeLayout, moreBadge, HOME_CAP } from './homeLayoutCore.js';

const BASE = import.meta.env.BASE_URL;

export const BUILTIN_HOME = [{ key: 'claude', label: 'Claude' }, { key: 'chatgpt', label: 'ChatGPT' },
  { key: 'agy', label: 'Antigravity' }, { key: 'harness', label: 'dimensio' }, { key: 'studio', label: 'Media Studio' }];

/**
 * 内置入口的图标（与 Home.svelte 原来的 ENTRIES 一致）：claude 是吉祥物小人（原版资源；举旗 = 有任务完成还没看）；
 * 其余是自有素材，light（主页明亮主题 glassMode B）用 -dark 那枚——素材按「图标本身的颜色」命名，深色图标放浅色底上。
 */
export function builtinHomeIcon(key, { light, taskDone = false } = {}) {
  if (key === 'claude') return taskDone ? mascotFlag : mascotStand;
  if (key === 'agy') return `${BASE}assets/icons/antigravity.svg`;   // 只有一枚，深浅主页共用
  const name = key === 'harness' ? 'dimensio' : key;
  return `${BASE}assets/icons/${name}-${light ? 'dark' : 'light'}.svg`;
}

// 内置入口图标的逐枚光学校正。几张图的画板留白各不相同，统一塞进「方块一半」的框里按画板居中，结果是：小人的
// 画板上方给举旗留了空，身体整个偏低；Antigravity 顶满画板，显得最大；两枚水平线标笔画细，显得最轻。
// 这里按「墨迹」而不是画板来定：k = 图片框边长 / 方块边长，x、y = 位移 / 方块边长（都跟着方块边长 --ts 等比缩放）。
// 124 的方块上，墨迹大小依次是：小人 57×38、结 57、拱 61×57、水平线 66——实心的收一点、细线的放一点，
// 看上去才一样重。位置上：小人按身体居中（略低 1px，腿比身子疏）；拱的重量在顶部，下沉 1px；
// 两枚水平线标上实下虚，水平线同落在中线下 2px（两枚是一家，线必须齐）。
// 数是用 sharp 把每张图栅格化量出来的（墨迹边界与重心），换了图标素材要重量，别凭眼睛改。
const ICON_FIT = {
  claude:  { k: .563, y: -.067 },
  chatgpt: { k: .555 },
  agy:     { k: .495, y: .008 },
  harness: { k: .55, y: .016 },
  studio:  { k: .55, y: .016 },
};
// 举旗那张画板不同（140×146，站立是 158×128）：按同一像素比例摆，身体和脚落在站立时的原位，
// 只多出一面旗——任务完成时小人不会跳一下、也不会忽大忽小。
const MASCOT_FLAG_FIT = { k: .52, x: .021, y: -.099 };

/** 内置入口图标的大小与位置（{ k?, x?, y? }，没有的项用默认：方块一半、居中）。插件应用的图标不校正。 */
export function builtinIconFit(key, { taskDone = false } = {}) {
  return (key === 'claude' && taskDone ? MASCOT_FLAG_FIT : ICON_FIT[key]) || {};
}

/** 默认顺序的全部可用入口：[{ key, kind: 'builtin' | 'app', label, app? }]。 */
export function homeItems() {
  const items = BUILTIN_HOME.filter((e) => screenOn(e.key)).map((e) => ({ key: e.key, kind: 'builtin', label: e.label }));
  const seen = new Set(items.map((e) => e.key));
  for (const a of pluginUi.apps) {
    const key = a.key || 'app:' + a.plugin + ':' + a.id;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, kind: 'app', label: a.title || a.id, app: a });
  }
  return items;
}

/** 主页该怎么摆：ordered（全部，含隐藏的，设置页用）、shown（主页 / Dock 上那几格，可能以 { key: 'more', kind: 'more', badge } 收尾）、overflow（收进「更多」的）、hidden（隐藏的键）。 */
export function homeView() {
  const items = homeItems();
  const byKey = new Map(items.map((e) => [e.key, e]));
  const layout = normalizeLayout(prefs.homeLayout);
  const r = arrangeHome(items.map((e) => e.key), layout, HOME_CAP);
  const overflow = r.overflow.map((k) => byKey.get(k));
  const more = { key: 'more', kind: 'more', badge: moreBadge(overflow.map((e) => (e.kind === 'app' ? e.app?.badge : ''))) };
  return {
    ordered: r.ordered.map((k) => byKey.get(k)),
    shown: r.shown.map((k) => (k === 'more' ? more : byKey.get(k))),
    overflow,
    hidden: new Set(layout.hidden),
  };
}

function commit(next) { prefs.homeLayout = next; savePrefs(); }
const availKeys = () => homeItems().map((e) => e.key);

export function moveHomeEntry(key, delta) { commit(moveKey(prefs.homeLayout, availKeys(), key, delta)); }
export function setHomeHidden(key, hidden) { commit(setHidden(prefs.homeLayout, key, !!hidden)); }
export function resetHomeLayout() { commit(normalizeLayout(null)); }
