// 页面分层：哪些子树「在 DOM 里、无障碍树也认，但人眼看不见」，哪些是此刻浮在最上面的弹窗。
// page_text 与 read_page 共用（11-22 agy 反馈：阿里云控制台顶栏常驻一个几千字的「产品与服务」抽屉，
// read_page(interactive) 前 359 行全是它的「加入收藏」，page_text 整屏也是它，真正弹在最前的「创建 Bucket」弹窗反而被截在后面）。
//
// 实测阿里云那个抽屉：本身挂着 role=main 和 role=dialog aria-modal=true，position:fixed + overflow:hidden，收起时 0×1 大小；
// display / visibility / opacity / aria-hidden 全是正常值，checkVisibility() 也说它可见——所以只能按几何判断。
// 看不见的三类（都不往下钻）：
//   collapsed  宽或高不到 2px、又 overflow 不可见（收起的抽屉 / 手风琴）
//   offscreen  整个在视口左边 / 右边 / 文档顶上，且是定位或变换出去的（侧滑菜单）；静态排版的宽表格、轮播里的项不算
//   transparent opacity:0 的定位层（淡出的浮层）；静态元素的 opacity:0 多是「滚到再淡入」的动画，不算
// 窗口最小化时视口是 0×0，几何全不可信，这时不判（返回空）。
//
// 只能用自己的局部变量：pageTextExpression / layersExpression 会把它 toString() 后注入页面。w = window（单测传桩）。
export function pageLayersInPage(w = window, opts = {}) {
  const doc = w.document;
  const out = { junk: [], dialogs: [] };
  const vw = Number(w.innerWidth) || 0, vh = Number(w.innerHeight) || 0;
  if (!doc || !doc.body || vw <= 0 || vh <= 0) return out;
  const sy = Number(w.scrollY) || 0;
  const max = Number(opts.maxVisit) > 0 ? Number(opts.maxVisit) : 8000;
  const rectOf = (el) => { try { return el.getBoundingClientRect(); } catch { return null; } };
  const styleOf = (el) => { try { return w.getComputedStyle(el); } catch { return null; } };
  const hiddenKind = (el, r, cs) => {
    if (!r || !cs || r.width == null || r.height == null) return '';
    const positioned = cs.position === 'fixed' || cs.position === 'absolute';
    const clips = (cs.overflowX && cs.overflowX !== 'visible') || (cs.overflowY && cs.overflowY !== 'visible');
    if ((r.width < 2 || r.height < 2) && clips) return 'collapsed';
    if (r.width >= 2 && r.height >= 2 && (positioned || (cs.transform && cs.transform !== 'none'))
      && (r.right <= 0 || r.left >= vw || r.bottom + sy <= 0)) return 'offscreen';
    if (positioned && cs.opacity === '0') return 'transparent';
    return '';
  };
  // 广度优先，只走到 maxVisit 个元素；看不见的子树整个跳过
  let seen = 0;
  const queue = [doc.body];
  for (let i = 0; i < queue.length && seen < max; i++) {
    const el = queue[i];
    seen++;
    const cs = styleOf(el);
    if (cs && cs.display === 'none') continue;
    if (el !== doc.body) {
      const kind = hiddenKind(el, rectOf(el), cs);
      if (kind) {
        if (String(el.textContent || '').trim().length >= 20) out.junk.push(el);
        continue;
      }
    }
    const kids = el.children || [];
    for (let k = 0; k < kids.length; k++) queue.push(kids[k]);
  }

  // 弹窗：语义上是对话框的，或类名像 dialog / modal / drawer 的定位层；要真有面积、在视口里、看得见、有字
  const inJunk = (el) => out.junk.some((j) => j === el || (j.contains && j.contains(el)));
  const sels = ['dialog[open]', '[role=dialog]', '[role=alertdialog]', '[aria-modal=true]'];
  const cands = [];
  const pushAll = (sel, semantic) => {
    let list = [];
    try { list = doc.querySelectorAll(sel); } catch { return; }
    for (let i = 0; i < list.length; i++) cands.push({ el: list[i], semantic });
  };
  for (const s of sels) pushAll(s, true);
  pushAll('[class*=dialog i],[class*=modal i],[class*=drawer i],[class*=popup i]', false);
  const picked = [];
  for (const { el, semantic } of cands) {
    if (el === doc.body || el === doc.documentElement || picked.includes(el) || inJunk(el)) continue;
    const r = rectOf(el), cs = styleOf(el);
    if (!r || !cs || r.width < 40 || r.height < 40) continue;
    if (r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh) continue;
    if (!semantic && cs.position !== 'fixed' && cs.position !== 'absolute') continue;
    try { if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue; } catch { /* 老内核没有 */ }
    if (String(el.innerText || '').trim().length < 2) continue;   // 纯遮罩
    picked.push(el);
  }
  // 嵌套的只留最外层；最多 3 个
  out.dialogs = picked.filter((el) => !picked.some((o) => o !== el && o.contains && o.contains(el))).slice(0, 3);
  return out;
}

/**
 * 经 CDP 求出分层，换成 backendNodeId（read_page 拿它对无障碍树）：{ junk: number[], dialogs: number[] }。
 * 任何一步失败都返回 null——分层只是让结果更好读，不能挡住 read_page。
 */
export async function pageLayerIds(send) {
  const group = 'bridge-layers';
  try {
    const ev = await send('Runtime.evaluate', {
      expression: `(${pageLayersInPage.toString()})(window)`,
      objectGroup: group,
    });
    const objectId = ev?.result?.objectId;
    if (!objectId || ev?.exceptionDetails) return null;
    const ids = async (arrName) => {
      const props = await send('Runtime.getProperties', { objectId, ownProperties: true });
      const arr = (props?.result || []).find((p) => p.name === arrName)?.value?.objectId;
      if (!arr) return [];
      const items = await send('Runtime.getProperties', { objectId: arr, ownProperties: true });
      const out = [];
      for (const it of items?.result || []) {
        if (!/^\d+$/.test(it.name) || !it.value?.objectId) continue;
        const d = await send('DOM.describeNode', { objectId: it.value.objectId });
        if (d?.node?.backendNodeId != null) out.push(d.node.backendNodeId);
      }
      return out;
    };
    const junk = await ids('junk');
    const dialogs = await ids('dialogs');
    return junk.length || dialogs.length ? { junk, dialogs } : null;
  } catch {
    return null;
  } finally {
    send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
}
