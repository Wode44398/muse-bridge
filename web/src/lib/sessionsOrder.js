// 会话列表的排序不变量：恒按 mtime 倒序（与 /api/sessions 同序），位置只由 mtime 决定，
// 不由总线事件的【到达顺序】决定。
//
// 以前 session.touch 一到就把那一行搬到列表最前——乱序 / 重复 / 迟到的事件（Windows 目录
// 事件不等于内容变化；断线重连后一串补播；两台设备同时在写）会把 mtime 很旧的会话顶到
// 最上面，手机端看着就是「顺序是乱的」（09-13）。这里把 touch 变成「按 mtime 插回正确位置」：
//   · mtime 没有变大 → 原地不动（返回同一个数组引用，调用方据此知道不必重渲染）；
//   · mtime 变大   → 从原位取出，插到第一个比它旧的条目前面（同 mtime 保持原相对顺序）。
// 纯函数，不依赖 Svelte，方便 node:test 直接验。
export function placeTouched(list, id, mtime) {
  const i = list.findIndex((s) => s && s.id === id);
  if (i < 0) return null;                      // 列表里没有这个 id：交给调用方全量刷新
  const cur = list[i];
  const m = Number(mtime) || 0;
  if (!(m > (Number(cur.mtime) || 0))) return list;   // 没有更新 → 不动
  const row = { ...cur, mtime: m };
  const rest = list.slice(0, i).concat(list.slice(i + 1));
  let at = rest.findIndex((s) => (Number(s && s.mtime) || 0) < m);
  if (at < 0) at = rest.length;
  rest.splice(at, 0, row);
  return rest;
}

// 整表重排（服务端列表 / 缓存列表进来时兜底）：稳定地按 mtime 倒序。已经有序时返回原引用。
export function sortByMtime(list) {
  let sorted = true;
  for (let k = 1; k < list.length; k++) {
    if ((Number(list[k - 1].mtime) || 0) < (Number(list[k].mtime) || 0)) { sorted = false; break; }
  }
  if (sorted) return list;
  return list.map((s, idx) => ({ s, idx }))
    .sort((a, b) => ((Number(b.s.mtime) || 0) - (Number(a.s.mtime) || 0)) || (a.idx - b.idx))
    .map((x) => x.s);
}
