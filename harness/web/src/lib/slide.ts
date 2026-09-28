// 会滑的选中块（ui/Segmented 分段控件、工作区标签带 DockTabs 共用）的落位规则。纯函数，Node 测试直接跑。
//
//  · 第一次落位不带过渡——不然每次打开都从最左边那项滑过来（09-26 的问题：打开 effort 选择栏瞬间每次都是从不思考滑向
//    预设思考档位——弹层先排了一次版、块在 x = 0，量好之后连同「开过渡」一起落下，就从第一项滑了过去）。
//  · 量不到（还没排版、宽 0）就先不动，等下一次。
//  · 换到别的项才滑；同一项只是容器变宽窄（分栏拖动、字体晚到）直接落位，不滑。
//  · 滑向哪一项：按着的那项（按下就先滑过去，不等松手）> 刚点的那项（值还没回来）> 当前值。
export interface Slot {
  x: number;
  w: number;
}

export interface Ind extends Slot {
  key: string; // 现在停在哪一项
  shown: boolean;
  animate: boolean; // 这一次落位要不要过渡
}

export const IND_HIDDEN: Ind = { key: "", x: 0, w: 0, shown: false, animate: false };

export function slideTo(prev: Ind, next: Slot | null, key: string): Ind {
  if (!next || !(next.w > 0)) return prev;
  if (!prev.shown) return { key, x: next.x, w: next.w, shown: true, animate: false };
  if (prev.key !== key) return { key, x: next.x, w: next.w, shown: true, animate: true };
  if (prev.x === next.x && prev.w === next.w) return prev;
  return { key, x: next.x, w: next.w, shown: true, animate: false };
}

export function slideTarget<T>(pressed: T | null, picked: T | null, value: T): T {
  return pressed ?? picked ?? value;
}
