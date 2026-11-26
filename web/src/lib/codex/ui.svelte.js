// Codex 分页的弹层：同一时间只开一个（权限、项目、模型、额度、账号、线程菜单……）。
// 每个弹层是一个 <Popover id="…">，谁打开谁传锚点；点空白、按 Esc、再点一次锚点都收起。

export const cxPop = $state({ id: '', anchor: null, data: null });

/** 打开 id 这个弹层；它已经开着、而且是同一个锚点点的 = 收起（再点一次就关）。 */
export function togglePop(id, anchor, data = null) {
  if (cxPop.id === id && cxPop.anchor === anchor) { closePop(); return false; }
  cxPop.id = id;
  cxPop.anchor = anchor || null;
  cxPop.data = data;
  return true;
}

export function openPop(id, anchor, data = null) {
  cxPop.id = id;
  cxPop.anchor = anchor || null;
  cxPop.data = data;
}

export function closePop(id) {
  if (id && cxPop.id !== id) return;
  cxPop.id = '';
  cxPop.anchor = null;
  cxPop.data = null;
}

/** 把节点挪到 .cx 根下（弹层按 .cx 定位，不能被中间某层的 overflow / transform 裁掉）。 */
export function portal(node, target) {
  const host = target || node.closest?.('.cx') || document.querySelector('.cx');
  if (host && node.parentNode !== host) host.appendChild(node);
  return {
    destroy() { node.remove(); },
  };
}
