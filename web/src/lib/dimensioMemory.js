// 工作台「记忆」卡的 dimensio 适配：把 dimensio 的结构化记忆（/api/harness/api/memory/overview 的桶与条目）映射成
// 记忆导图要的那张图（与 runtime/memory-graph.mjs 同形：{ tree, files, links, stats }），导图 / 逐层 / 搜索原样复用。
// 映射：根 = 项目；第一层 = 治理上的四类（待确认 / 被隔离 / 生效 / 已退场，与 dimensio 自己的记忆面板同一口径）；
// 一类里混着几种类型、条目又多时再按类型分一层；叶子 = 一条记忆（ref = 记忆 id）。supersedes / supersededBy = 跨枝关联。
// 纯函数、不碰 DOM 和翻译层（文案由调用方传 labels），web/src/lib/dimensioMemory.test.js 直接测。

export const LANES = ['proposed', 'held', 'active', 'retired'];

// 与 dimensio 的 memory-viz.ts laneOf 同一口径：写成 active、却因注入特征 / 外部内容会话被扣成待确认的，也在等你拍板
export function laneOf(m) {
  if (m.status === 'rejected' || m.declaredStatus === 'rejected') return 'retired';
  if (m.declaredStatus === 'proposed' || m.status === 'proposed') return 'proposed';
  if (m.status === 'active') return 'active';
  if (m.declaredStatus === 'active') return 'held';
  return 'retired';
}

const TYPE_ORDER = ['user', 'feedback', 'project', 'reference'];
const SPLIT_AT = 6;   // 一类里超过这么多条、且混着两种以上类型，才按类型再分一层

// items: MemoryMeta[]；labels: { root, lane: { proposed, held, active, retired }, type: { user, … } }
export function dimensioGraph(items, labels = {}) {
  const list = Array.isArray(items) ? items.filter((m) => m && m.id) : [];
  const ms = (m) => { const v = Date.parse(m.updated || ''); return Number.isFinite(v) ? v : 0; };
  const fileNode = (m) => ({ id: 'f:' + m.id, kind: 'file', ref: m.id, children: [] });
  const tree = { id: 'root', kind: 'root', label: labels.root || 'dimensio', children: [] };
  for (const lane of LANES) {
    const rows = list.filter((m) => laneOf(m) === lane).sort((a, b) => ms(b) - ms(a));
    if (!rows.length) continue;
    const g = { id: 'g:lane#' + lane, kind: 'group', label: labels.lane?.[lane] || lane, children: [] };
    const types = TYPE_ORDER.filter((t) => rows.some((m) => m.type === t));
    const other = rows.filter((m) => !TYPE_ORDER.includes(m.type));
    if (rows.length > SPLIT_AT && types.length + (other.length ? 1 : 0) >= 2) {
      for (const t of types) {
        g.children.push({ id: `g:${lane}#${t}`, kind: 'group', label: labels.type?.[t] || t, children: rows.filter((m) => m.type === t).map(fileNode) });
      }
      g.children.push(...other.map(fileNode));
    } else g.children.push(...rows.map(fileNode));
    tree.children.push(g);
  }

  const ids = new Set(list.map((m) => m.id));
  const links = [];
  const seen = new Set();
  const backs = new Map();
  const link = (from, to) => {
    if (!ids.has(to) || from === to) return;
    const k = from + '\n' + to;
    if (seen.has(k) || seen.has(to + '\n' + from)) return;
    seen.add(k);
    links.push({ from, to, kind: 'md' });
    backs.set(to, (backs.get(to) || 0) + 1);
  };
  for (const m of list) {
    if (m.supersedes) link(m.id, m.supersedes);
    if (m.supersededBy) link(m.supersededBy, m.id);
  }

  const files = {};
  for (const m of list) {
    files[m.id] = {
      label: m.title || m.id, title: m.title || '', name: m.id, description: m.description || '', type: m.type || '',
      hook: '', mtime: ms(m), size: 0,
      out: links.filter((l) => l.from === m.id).length, in: backs.get(m.id) || 0, dead: [],
      // dimensio 自己的字段（详情卡用）
      lane: laneOf(m), status: m.status, declaredStatus: m.declaredStatus, confidence: m.confidence, topic: m.topic || '',
      issues: Array.isArray(m.issues) ? m.issues : [],
    };
  }
  return {
    tree, files, links, rootRel: null,
    stats: { files: list.length, indexed: list.length, unindexed: 0, dead: 0, links: links.length },
  };
}

// 总览里的桶 → 切换列表的条目（与 Claude 记忆的 roots 同形：dir 当键，这里是 dimensio 的工作区或 '@global'）
export function dimensioRoots(overview) {
  const buckets = Array.isArray(overview?.buckets) ? overview.buckets : [];
  return buckets.filter((b) => b && b.ws && Array.isArray(b.items) && b.items.length).map((b) => ({
    dir: b.ws, name: b.name || '', kind: b.kind, current: !!b.current, count: b.items.length,
    project: b.kind === 'project' ? b.ws : '',
    mtime: Math.max(0, ...b.items.map((m) => Date.parse(m.updated || '') || 0)),
  }));
}

const fold = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// 这个工作区的那个桶（没有记忆的项目没有桶）
export function bucketFor(overview, ws) {
  const buckets = Array.isArray(overview?.buckets) ? overview.buckets : [];
  return buckets.find((b) => b && fold(b.ws) === fold(ws)) || null;
}
