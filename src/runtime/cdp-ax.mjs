const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'switch', 'slider', 'spinbutton', 'textfield', 'togglebutton',
]);
const SKIP_ROLES = new Set(['inlinetextbox', 'linebreak']);
const PROMOTE_ROLES = new Set([
  'generic', 'genericcontainer', 'group', 'section', 'div', 'none', 'presentation',
]);

export async function snapshotAccessibility(send, refs, opts = {}) {
  const filter = opts.filter ?? 'all';
  const maxChars = Math.max(2000, Math.min(80_000, opts.maxChars ?? 20_000));
  const result = await send('Accessibility.getFullAXTree', {});
  const nodes = result?.nodes ?? [];
  const byId = new Map();
  for (const node of nodes) byId.set(String(node.nodeId), node);
  // rootBackendId：只列这个 DOM 节点的子树（read_page(ref)）；depth：从根往下最多展开几层
  const root = opts.rootBackendId != null
    ? nodes.find((node) => node.backendDOMNodeId === opts.rootBackendId)
    : nodes.find((node) => !node.parentId) ?? nodes[0];
  if (!root) {
    if (opts.rootBackendId != null) throw new Error('那个元素已不在无障碍树里（页面变了）——重新 read_page 拿 ref');
    return { text: '(empty accessibility tree)', refCount: 0, lineCount: 0, truncated: false };
  }
  const maxDepth = Number(opts.depth) > 0 ? Number(opts.depth) : Infinity;

  // 链接行尾带上地址（11-07 反馈 42 / 46：只有链接文字，要地址就得另跑 eval querySelectorAll）。
  // 与页面同源的只写路径，免得每行重复域名；javascript: 不写；太长截到 120 字符。
  const urlOf = (node) => {
    const property = (node.properties ?? []).find((p) => p.name === 'url');
    return typeof property?.value?.value === 'string' ? property.value.value : '';
  };
  const pageRoot = nodes.find((node) => String(node.role?.value ?? '') === 'RootWebArea' && urlOf(node))
    ?? nodes.find((node) => !node.parentId);
  let origin = '';
  try { origin = new URL(urlOf(pageRoot ?? {})).origin; } catch { /* 根上没地址：链接照写完整地址 */ }
  const linkUrl = (node, name) => {
    const url = urlOf(node);
    if (!url || /^javascript:/i.test(url)) return '';
    let shown = url;
    try {
      const u = new URL(url);
      if (origin && origin !== 'null' && u.origin === origin) shown = u.pathname + u.search + u.hash;
    } catch { /* 不是合法地址就原样写 */ }
    if (shown === name || url === name) return '';
    return ` → ${shown.length > 120 ? `${shown.slice(0, 119)}…` : shown}`;
  };

  refs.clear();
  let refN = 0;
  const lines = [];

  // 分层（page-layers.mjs，由调用方按 backendNodeId 传进来）：看不见的抽屉 / 菜单折成一行；可见弹窗挪到最前。
  // 只在看整页、不带 query 时用——带 query 是在找东西，看不见的也要能找到；read_page(ref) 是点名看某块。
  const useLayers = opts.layers && !opts.query && opts.rootBackendId == null;
  const junkIds = new Set(useLayers ? opts.layers.junk || [] : []);
  const dialogIds = new Set(useLayers ? opts.layers.dialogs || [] : []);
  let folded = 0;
  const countInteractive = (node) => {
    let n = 0;
    const stack = [node];
    while (stack.length) {
      const x = stack.pop();
      if (INTERACTIVE_ROLES.has(String(x.role?.value ?? '').toLowerCase())) n++;
      for (const id of x.childIds ?? []) { const c = byId.get(String(id)); if (c) stack.push(c); }
    }
    return n;
  };
  let inDialogPass = false;

  const emit = (node, depth) => {
    if (junkIds.has(node.backendDOMNodeId)) {
      folded++;
      const n = countInteractive(node);
      lines.push(`${filter === 'interactive' ? '' : '  '.repeat(depth)}- （看不见的菜单 / 抽屉，已折叠${n ? `：里面 ${n} 个可交互元素` : ''}——要用里面的东西先把它打开，或 find / read_page(query) 搜）`);
      return;
    }
    if (!inDialogPass && dialogIds.has(node.backendDOMNodeId)) {
      lines.push(`${filter === 'interactive' ? '' : '  '.repeat(depth)}- （当前弹窗，已列在最前）`);
      return;
    }
    const role = String(node.role?.value ?? '').toLowerCase();
    const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const children = (node.childIds ?? [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean);

    if (SKIP_ROLES.has(role)) return;
    if (node.ignored || (PROMOTE_ROLES.has(role) && !name)) {
      for (const child of children) emit(child, depth);
      return;
    }

    const states = [];
    for (const property of node.properties ?? []) {
      const propertyName = String(property.name ?? '');
      const propertyValue = property.value?.value;
      if (propertyName === 'focusable' || propertyName === 'readonly'
          || propertyValue === false || propertyValue == null) continue;
      if ([
        'focused', 'disabled', 'required', 'expanded', 'selected', 'pressed',
        'checked', 'invalid', 'multiline', 'editable', 'autocomplete', 'haspopup', 'level',
      ].includes(propertyName)) {
        states.push(propertyValue === true ? propertyName : `${propertyName}=${propertyValue}`);
      }
    }
    const value = node.value?.value != null && String(node.value.value).trim() !== ''
      ? ` value="${String(node.value.value).replace(/\s+/g, ' ').slice(0, 80)}"` : '';

    let refTag = '';
    const editable = (node.properties ?? [])
      .some((property) => property.name === 'editable' && property.value?.value);
    if ((INTERACTIVE_ROLES.has(role) || editable) && node.backendDOMNodeId != null) {
      refN++;
      refs.set(refN, { backendId: node.backendDOMNodeId, role, name });
      refTag = ` [ref${refN}]`;
    }

    const displayRole = role === 'statictext' ? 'text' : role;
    const href = role === 'link' ? linkUrl(node, name) : '';
    const line = `${'  '.repeat(depth)}- ${displayRole}${name ? ` "${name}"` : ''}${refTag}${value}${states.length ? ` (${states.join(', ')})` : ''}${href}`;
    if (filter === 'all' || refTag) {
      lines.push(filter === 'interactive' ? line.trimStart() : line);
    }

    if (depth + 1 > maxDepth) return;
    for (const child of children) {
      const childRole = String(child.role?.value ?? '').toLowerCase();
      const childName = String(child.name?.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (childRole === 'statictext' && childName && childName === name) continue;
      emit(child, depth + 1);
    }
  };
  // 可见弹窗先列：它浮在最上面，是用户眼前的东西
  if (dialogIds.size) {
    const dlgNodes = nodes.filter((node) => dialogIds.has(node.backendDOMNodeId));
    if (dlgNodes.length) {
      inDialogPass = true;
      for (const d of dlgNodes) {
        lines.push('- 【当前弹窗】');
        emit(d, 1);
      }
      inDialogPass = false;
      lines.push('- 【弹窗底下的页面】');
    } else dialogIds.clear();
  }
  emit(root, 0);
  if (folded) lines.push(`(另有 ${folded} 处看不见的菜单 / 抽屉已折叠)`);

  let output = lines;
  if (opts.query) {
    const query = opts.query.toLowerCase();
    output = lines
      .filter((line) => line.toLowerCase().includes(query))
      .map((line) => line.trimStart());
  }

  const total = output.length;
  let text = output.join('\n');
  let truncated = false;
  if (text.length > maxChars) {
    truncated = true;
    text = text.slice(0, maxChars);
    const cut = text.lastIndexOf('\n');
    if (cut > 0) text = text.slice(0, cut);
    const kept = text.split('\n').length;
    text += `\n… (truncated: showing ${kept} of ${total} lines — narrow with query or filter:"interactive")`;
  }
  if (!text.trim()) {
    text = opts.query ? `(no nodes matching "${opts.query}")` : '(empty accessibility tree)';
  }
  return { text, refCount: refN, lineCount: total, truncated };
}
