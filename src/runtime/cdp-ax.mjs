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

  refs.clear();
  let refN = 0;
  const lines = [];

  const emit = (node, depth) => {
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
    const line = `${'  '.repeat(depth)}- ${displayRole}${name ? ` "${name}"` : ''}${refTag}${value}${states.length ? ` (${states.join(', ')})` : ''}`;
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
  emit(root, 0);

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
