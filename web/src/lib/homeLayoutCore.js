// 主页入口布局的纯函数（插件应用上主页）。有状态的那层在 lib/homeLayout.svelte.js。
//
// 布局只存「用户动过的」两张表：order（用户排的顺序）与 hidden（藏掉的键）。可用入口每次现算（内置按 screenOn、
// 应用按 /api/plugins/ui 下发），所以：
//   - order 里认不得的键（插件停了 / 卸了）不报错、也先不删——插件重新开起来时还能回到原来的相对位置；
//   - 新冒出来的键（刚装的应用）不在 order 里，按默认顺序接在后面，不会插队到用户排好的前面。
// 主页最多摆 HOME_CAP 格：恰好放得下就全摆；放不下时前 cap-1 格照摆、最后一格换成「更多」，其余收进去。

export const HOME_CAP = 8;
const MAX_KEYS = 64;
const MAX_KEY_LEN = 120;   // 应用键 'app:<插件 48>:<应用 32>' 最长约 85，留点余量；更长的必是脏数据

function cleanList(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const k of v) {
    if (typeof k !== 'string' || !k || k.length > MAX_KEY_LEN || k === 'more') continue;   // 'more' 是占位格，不是入口
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= MAX_KEYS) break;
  }
  return out;
}

/** 清洗存档里的布局（localStorage 里什么都可能有）：去重、丢非字符串、各最多 64 项。 */
export function normalizeLayout(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return { order: cleanList(o.order), hidden: cleanList(o.hidden) };
}

/**
 * 按布局排主页入口。available = 默认顺序的可用键。
 * 回 { ordered（全部可用键按用户顺序，含隐藏的）, visible（去掉隐藏）, shown（主页上那几格，可能以 'more' 收尾）, overflow（收进「更多」的） }
 */
export function arrangeHome(available, layout, cap = HOME_CAP) {
  const avail = cleanList(available);
  const have = new Set(avail);
  const l = normalizeLayout(layout);
  const ordered = l.order.filter((k) => have.has(k));
  const placed = new Set(ordered);
  for (const k of avail) if (!placed.has(k)) ordered.push(k);
  const hid = new Set(l.hidden);
  const visible = ordered.filter((k) => !hid.has(k));
  const n = Math.max(1, Math.floor(Number(cap) || HOME_CAP));
  const shown = visible.length <= n ? visible.slice() : [...visible.slice(0, n - 1), 'more'];
  const overflow = visible.length <= n ? [] : visible.slice(n - 1);
  return { ordered, visible, shown, overflow };
}

/** 把 key 在完整顺序里挪 delta 位（夹在两端）。order 写成完整的 ordered；认不得的旧键接在最后留着。 */
export function moveKey(layout, available, key, delta) {
  const l = normalizeLayout(layout);
  const { ordered } = arrangeHome(available, l);
  const i = ordered.indexOf(key);
  if (i < 0) return l;
  const d = Math.trunc(Number(delta) || 0);
  const j = Math.min(ordered.length - 1, Math.max(0, i + d));
  if (j !== i) { ordered.splice(i, 1); ordered.splice(j, 0, key); }
  const known = new Set(ordered);
  const order = [...ordered, ...l.order.filter((k) => !known.has(k))].slice(0, MAX_KEYS);
  return { order, hidden: l.hidden };
}

/** 藏 / 显示一个入口。 */
export function setHidden(layout, key, hidden) {
  const l = normalizeLayout(layout);
  if (typeof key !== 'string' || !key || key === 'more') return l;
  const rest = l.hidden.filter((k) => k !== key);
  return { order: l.order, hidden: hidden ? [...rest, key].slice(-MAX_KEYS) : rest };
}

/**
 * 「更多」那一格的角标：收进去的应用有角标时，「更多」也得露出来，不然人点开之前看不到有未读。
 * 全是数字的加起来（同 iOS 文件夹）；有角标但不是数字（「新」之类）没法加，就给一个圆点，只示意「里面有」。
 */
export function moreBadge(badges) {
  let sum = 0, other = false, over = false;
  for (const b of badges || []) {
    const s = String(b ?? '').trim();
    if (!s) continue;
    const m = /^(\d+)(\+?)$/.exec(s);   // 服务端把超过三位的数字写成 999+，这里认得它
    if (m) { sum += Number(m[1]); if (m[2]) over = true; }
    else other = true;
  }
  if (sum > 0) return over || sum > 999 ? '999+' : String(sum);
  return other ? '•' : '';
}
