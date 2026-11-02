// 工作台「记忆」卡的树工具：服务端给的图（runtime/memory-graph.mjs）→ 前端要的索引、标签、配色、搜索。
// 导图（MemoryMap）和逐层视图（MemoryOutline）共用这一份，两边看到的标签、颜色、篇数必须一致。
import { tc } from './i18n.js';

// 主枝配色（OKLCH 色相）：根的每个直接子枝一个颜色，往下整枝沿用——导图的老规矩，一眼分得清哪一片。
// 挑的是和 Claude 页赭石 / 象牙底调和的一组：陶土、鼠尾草、雾蓝、琥珀、藕紫、青、玫、橄榄。
export const HUES = [38, 150, 245, 80, 305, 195, 0, 115];

// → { info: Map<id, { n, parent, depth, hue, count }>, order: 文件节点（导图顺序）, byRef: Map<rel, id>, rootId }
// hue = null 表示中性色（根、未索引那一枝）；count = 这一枝底下的文件数（不含自己）。
export function buildIndex(graph) {
  const info = new Map(), order = [];
  if (!graph) return { info, order, byRef: new Map(), rootId: '' };
  let ci = 0;
  const walk = (n, parent, depth, hue) => {
    const rec = { n, parent, depth, hue, count: 0 };
    info.set(n.id, rec);
    if (n.kind === 'file') order.push(n);
    for (const c of n.children) {
      const h = depth === 0 ? (c.kind === 'unindexed' ? null : HUES[ci++ % HUES.length]) : hue;
      walk(c, n.id, depth + 1, h);
      rec.count += info.get(c.id).count + (c.kind === 'file' ? 1 : 0);
    }
  };
  walk(graph.tree, null, 0, null);
  return { info, order, byRef: new Map(order.map((n) => [n.ref, n.id])), rootId: graph.tree.id };
}

export function ancestors(index, id) {
  const out = [];
  for (let p = index.info.get(id)?.parent; p; p = index.info.get(p)?.parent) out.unshift(p);
  return out;
}

// 根就叫项目名（MEMORY.md 的一级标题多半是「Memory Index」这种通用词，不如项目名认得出来）
export function nodeLabel(n, files, index, rootName) {
  if (n.id === index.rootId) return rootName || n.label || files[n.ref]?.label || 'MEMORY';
  if (n.kind === 'group') return n.label;
  if (n.kind === 'unindexed') return tc('claude', '未索引');
  return files[n.ref]?.label || n.ref;
}

// 副标题：索引里那行的「— 钩子」，没有就用 frontmatter 的 description
export function nodeSub(n, files) {
  if (n.kind === 'unindexed') return tc('claude', '没有被任何索引链接到的记忆');
  if (n.kind !== 'file') return '';
  const m = files[n.ref];
  return m?.hook || m?.description || '';
}

const TYPES = () => ({ user: tc('memory', '用户'), feedback: tc('memory', '反馈'), project: tc('memory', '项目'), reference: tc('memory', '参考') });
export function typeLabel(type) { return TYPES()[type] || type || ''; }

// 这一枝里最近一次改动（文件 mtime 取最大）
export function branchMtime(n, files) {
  let t = n.kind === 'file' ? files[n.ref]?.mtime || 0 : 0;
  for (const c of n.children) t = Math.max(t, branchMtime(c, files));
  return t;
}

// 搜索：标签打头 > 标签含 > 标题 / name / 文件名含 > 说明 / 钩子含。filter：'dead' 只看有死链的，'loose' 只看未索引的。
// 空查询 = 最近改过的在前。
export function searchNotes(q, index, files, filter = '') {
  const s = q.trim().toLowerCase();
  const out = [];
  for (const n of index.order) {
    const m = files[n.ref];
    if (!m) continue;
    if (filter === 'dead' && !m.dead.length) continue;
    if (filter === 'loose' && index.info.get(n.id)?.parent !== 'unindexed') continue;
    let score = 1;
    if (s) {
      const has = (x) => !!x && x.toLowerCase().includes(s);
      const lab = (m.label || '').toLowerCase();
      if (lab.startsWith(s)) score = 100;
      else if (lab.includes(s)) score = 80;
      else if (has(m.title) || has(m.name) || has(n.ref)) score = 60;
      else if (has(m.description) || has(m.hook)) score = 40;
      else continue;
    }
    out.push({ n, score, mtime: m.mtime || 0 });
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  return out.slice(0, 100).map((x) => x.n);
}

// 「分区索引 › Claude 分页」：节点所在的位置（不含根、不含自己）
export function pathText(index, id, files, rootName) {
  return ancestors(index, id).slice(1).map((p) => nodeLabel(index.info.get(p).n, files, index, rootName)).join(' › ');
}
