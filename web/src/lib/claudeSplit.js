// Claude 分页侧栏拖放的纯逻辑（不依赖 Svelte，node --test 直接跑；claudeSplit.test.js 钉着）：
//   · 项目排序：侧栏显示顺序 = 用户拖出来的 order（服务端 claude-projects.json 的 order 字段），
//     没排过的（新建的）项目排最前——刚建的项目一眼能看见；
//   · 分屏：会话块拖进正文区，落在左/右半边会发生什么。
//
// 分屏是【不对称】的两格：一格是本页自己（chat.svelte.js 那个单例内核，session.id），另一格是
// 同源 iframe 里的一份独立聊天页（?solo=<id>&pane=1，自带一套内核）。所以「两格对调」不用挪
// 任何会话，只是把 iframe 那一格换到另一边（paneSide 翻面）。
import { t, tc } from './i18n.js';

// —— 项目显示顺序 ——
// projects：服务端返回顺序（[0] 恒为默认项目，其余按最近更新）；order：用户排过的 id 序列。
export function applyProjectOrder(projects, order) {
  const list = Array.isArray(projects) ? projects : [];
  if (!Array.isArray(order) || !order.length) return list.slice();
  const rank = new Map(order.map((id, i) => [id, i]));
  const fresh = list.filter((p) => !rank.has(p.id));
  const ranked = list.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return [...fresh, ...ranked];
}

// 把 id 挪到 toIndex（以【挪动前】的列表计：插在原第 toIndex 项之前，= 长度即放最后）。
// 位置没变返回 null（调用方据此不发请求）。
export function moveId(ids, id, toIndex) {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(ids.length, toIndex));
  if (to === from || to === from + 1) return null;
  const out = ids.slice();
  out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, id);
  return out;
}

// —— 分屏 ——
export const MIN_PANE = 380;          // 一格最窄多宽（再窄输入框和工具行都挤不下）
export const DOCK_PUSH_MIN = 1000;    // 一格至少这么宽，工作台才「挤开」正文；否则盖在正文上

export const canSplitWidth = (w) => w >= MIN_PANE * 2;
export const dockOverlayFor = (paneW) => paneW < DOCK_PUSH_MIN;

// 拖着会话悬在正文区 side（'left' | 'right'）那一半时，松手会怎样。
//   split     —— 没分屏：本页当前对话与它左右并排，它在 side 那边
//   open      —— 没分屏且本页是空白新对话：直接在本页打开，不分屏
//   replace   —— 分屏中：换掉 side 那一格（target = 'main' 本页那格 | 'pane' iframe 那格）
//   swap      —— 分屏中：拖的是另一格正开着的会话 = 两格对调
//   none      —— 不接：拖的就是这一格已经开着的会话
export function splitDropPlan({ split, paneSide, blank, mainId, paneId, draggedId, side }) {
  if (!split) {
    if (blank) return { kind: 'open' };
    if (draggedId === mainId) return { kind: 'none' };
    return { kind: 'split', side };
  }
  const target = side === paneSide ? 'pane' : 'main';
  const here = target === 'pane' ? paneId : mainId;
  const there = target === 'pane' ? mainId : paneId;
  if (draggedId === here) return { kind: 'none' };
  if (draggedId === there) return { kind: 'swap' };
  return { kind: 'replace', target, side };
}

export function splitDropLabel(plan, side) {
  switch (plan.kind) {
    case 'open': return tc('claude', '打开这个对话');
    case 'split': return plan.side === 'left' ? t('在左边分屏打开') : t('在右边分屏打开');
    case 'replace': return (side || plan.side) === 'left' ? t('在左格打开') : t('在右格打开');
    case 'swap': return t('左右对调');
    default: return t('已经开着');
  }
}
