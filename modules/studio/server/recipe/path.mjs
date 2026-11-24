// 配方里取值用的路径：JSONPath 的一个小子集，只读不算。
//   $                根
//   $.a.b            对象键（字母数字、_、-）
//   $['a b']         带空格 / 点的键
//   $.data[0]        数组下标（负数从尾数）
//   $.data[*].url    展开数组，结果是数组
// 不支持过滤、递归下降、表达式：配方是给 AI 和人照文档填的，能取到字段就够了，多一种写法就多一种出错方式。

const SEG_RE = /^(?:\.([A-Za-z0-9_$-]+)|\[(-?\d+)\]|\[\*\]|\['((?:[^'\\]|\\.)*)'\]|\["((?:[^"\\]|\\.)*)"\])/;
const MAX_PATH = 300;

/** 路径 → 段列表 [{ key } | { index } | { all: true }]；写法不对抛（带人话）。 */
export function parsePath(p) {
  const s = String(p ?? '').trim();
  if (!s.startsWith('$')) throw new Error(`取值路径要以 $ 开头（例如 $.data[0].url）：${s.slice(0, 60)}`);
  if (s.length > MAX_PATH) throw new Error('取值路径太长');
  const segs = [];
  let rest = s.slice(1);
  while (rest) {
    const m = SEG_RE.exec(rest);
    if (!m) throw new Error(`取值路径写法不对（只认 .键、[下标]、[*]、['键']）：${s.slice(0, 60)}`);
    if (m[1] !== undefined) segs.push({ key: m[1] });
    else if (m[2] !== undefined) segs.push({ index: Number(m[2]) });
    else if (m[3] !== undefined || m[4] !== undefined) segs.push({ key: (m[3] ?? m[4]).replace(/\\(.)/g, '$1') });
    else segs.push({ all: true });
    rest = rest.slice(m[0].length);
  }
  return segs;
}

const own = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function walk(v, segs, i) {
  if (i >= segs.length) return v;
  const s = segs[i];
  if (s.all) {
    if (!Array.isArray(v)) return undefined;
    const out = [];
    for (const x of v) {
      const r = walk(x, segs, i + 1);
      if (r === undefined) continue;
      if (Array.isArray(r) && segs.slice(i + 1).some((z) => z.all)) out.push(...r); else out.push(r);
    }
    return out;
  }
  if (s.index !== undefined) {
    if (!Array.isArray(v)) return undefined;
    const j = s.index < 0 ? v.length + s.index : s.index;
    return walk(v[j], segs, i + 1);
  }
  // 原型链上的键（__proto__、constructor…）一律当没有
  if (!own(v, s.key)) return undefined;
  return walk(v[s.key], segs, i + 1);
}

/** 按路径取值；取不到回 undefined（不抛）。路径本身写错才抛。 */
export function getPath(root, p) {
  return walk(root, typeof p === 'string' ? parsePath(p) : p, 0);
}
