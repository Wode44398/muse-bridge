// PDF 书签（大纲）：getOutline 的树 → 平铺成带层级的条目，并在后台把每条的目标解析成页码，
// 用来在侧栏里高亮「当前所在的那一节」（页码 ≤ 当前页的最后一条）。点击交给 PDFLinkService.goToDestination。

/**
 * @returns {Promise<{ items: Array<{ id:number, title:string, depth:number, dest:any, url:string, page:number, parent:number, kids:number }>, resolve: Promise<void> }>}
 *   items 立即可用（page 先是 0）；resolve 结束时 page 都填上了（就地写，调用方解析完再整体换一次数组触发更新）。
 */
export async function loadOutline(pdf) {
  let tree = null;
  try { tree = await pdf.getOutline(); } catch { tree = null; }
  const items = [];
  const walk = (nodes, depth, parent) => {
    for (const n of nodes || []) {
      const id = items.length;
      const it = { id, title: clean(n.title), depth, dest: n.dest ?? null, url: n.url || '', page: 0, parent, kids: (n.items || []).length, bold: !!n.bold, italic: !!n.italic };
      items.push(it);
      if (n.items?.length) walk(n.items, depth + 1, id);
    }
  };
  walk(tree, 0, -1);
  const resolve = (async () => {
    for (const it of items) {
      if (!it.dest) continue;
      try { it.page = await destPage(pdf, it.dest); } catch { it.page = 0; }
    }
  })();
  return { items, resolve };
}

function clean(s) {
  return String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 目标 → 页码（1 起）；解析不了返回 0 */
export async function destPage(pdf, dest) {
  let explicit = dest;
  if (typeof dest === 'string') explicit = await pdf.getDestination(dest);
  if (!Array.isArray(explicit) || !explicit.length) return 0;
  const ref = explicit[0];
  if (Number.isInteger(ref)) return ref + 1;
  if (ref && typeof ref === 'object') return (await pdf.getPageIndex(ref)) + 1;
  return 0;
}

/** 当前页对应的书签：页码 ≤ 当前页的最后一条（同页多条取最深的那条） */
export function activeOutline(items, page) {
  let best = -1, bestPage = 0;
  for (const it of items) {
    if (!it.page || it.page > page) continue;
    if (it.page >= bestPage) { best = it.id; bestPage = it.page; }
  }
  return best;
}
