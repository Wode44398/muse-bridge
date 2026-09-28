// 侧栏项目块拖动排序的两个纯函数（好在 Node 里测）：手指在哪个位置插入、插完之后这一区的次序。
// 置顶区与非置顶区各排各的——置顶的拖不到非置顶里、反过来也一样（换区用「置顶 / 取消置顶」），所以插入位置夹在本区之内。

export interface ReorderItem {
  id: string;
  pinned: boolean;
}

// 插入位置：heads 是各项目块标题行的上下边（与列表同序）；手指在某一行中线以上 = 插在它前面，都不是 = 插在最后。
// 结果夹到被拖那一项所在的区里。
export function insertionIndex(heads: { top: number; bottom: number }[], y: number, items: ReorderItem[], dragId: string): number {
  let at = heads.length;
  for (let i = 0; i < heads.length; i++) {
    if (y < (heads[i].top + heads[i].bottom) / 2) {
      at = i;
      break;
    }
  }
  const self = items.find((it) => it.id === dragId);
  if (!self) return at;
  const pinnedCount = items.filter((it) => it.pinned).length;
  const [lo, hi] = self.pinned ? [0, pinnedCount] : [pinnedCount, items.length];
  return Math.min(hi, Math.max(lo, at));
}

// 把 dragId 挪到 at（「插在原列表第 at 项之前」的语义），返回挪完之后它所在那一区的 id 次序（交给服务端写位次）；
// 位置没变返回 null。
export function reorderZone(items: ReorderItem[], dragId: string, at: number): string[] | null {
  const from = items.findIndex((it) => it.id === dragId);
  if (from < 0) return null;
  if (at === from || at === from + 1) return null; // 插在自己前后 = 没动
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(at > from ? at - 1 : at, 0, moved);
  return next.filter((it) => it.pinned === moved.pinned).map((it) => it.id);
}
