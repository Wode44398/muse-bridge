// 声明式应用的积木规范化。
//
// 插件的 view 函数回一棵积木树（Block[] / { blocks } / 单个积木），bridge 自己画——手机 App 不跑第三方代码。
// 树是插件给的、不可信：这里统一收口成前端能放心画的形状，前端不再自己做防御：
//   - 最深 6 层（顶层算第 1 层），整棵最多 400 块，超出的直接丢（插件写了个死循环生成也拖不垮界面）；
//   - 不认识的 type 丢掉（新前端认、老服务端不认的积木不会半截画出来）；
//   - 字符串按积木表截断；image 的 src 只认插件 web/ 下的图片，改写成 /plugins/<插件>/web/…；
//   - 动作引用（Act）规范成 { name, args?, confirm? }，名字要合规、且是这个应用登记过的动作。
//     只为了按动作而存在的控件（按钮、表单、标签页、行尾按钮 / 开关）动作不合格就整个丢；
//     动作可有可无的（列表行点击、表格行点击）只去掉动作。
//   - chat 积木要插件声明 page.chat，没声明换成一块提示（不给半个能用的对话区）。
//
// normalizeBlocks(tree, { plugin, actions?, perms? }) → Block[]
//   actions：这个应用的动作名（数组 / Set / 对象的键）；不给就只校验名字格式。
//   perms：插件清单 permissions 的名字列表；不给就不查 chat 的 page.chat。
import { ACTION_NAME_RE } from './app-spec.mjs';

export const BLOCK_LIMITS = Object.freeze({ depth: 6, total: 400 });
export const BLOCK_TYPES = Object.freeze(['text', 'markdown', 'section', 'stat', 'list', 'table', 'form', 'chart', 'button', 'buttons', 'tabs', 'empty', 'image', 'divider', 'chat']);

const ACT_ARGS_MAX = 16 * 1024;
const FORM_VALUE_MAX = 64 * 1024;
const ICON_RE = /^[a-z][a-z0-9-]{0,23}$/;
const KEY_RE = /^[a-zA-Z][\w-]{0,40}$/;
const IMG_RE = /^web\/[^?#]+\.(png|jpe?g|webp|svg|gif)$/i;
const TONES = ['muted', 'ok', 'warn', 'error'];

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const pick = (v, list) => (list.includes(v) ? v : undefined);
// 单行字符串：换行压成空格、去首尾空白，按字符（不是 UTF-16 单元）截断，免得把表情劈成半个
function line(v, n) {
  if (v == null || typeof v === 'object' || typeof v === 'function') return '';
  const s = String(v).replace(/[\r\n]+/g, ' ').trim();
  return s.length <= n ? s : [...s].slice(0, n).join('');
}
// 多行文本（text / markdown / desc）：保留换行
function text(v, n) {
  if (v == null || typeof v === 'object' || typeof v === 'function') return '';
  const s = String(v).replace(/\r\n?/g, '\n');
  return s.length <= n ? s : [...s.slice(0, n + 1)].slice(0, n).join('');
}
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// 行 id 会原样并回动作参数，插件多半直接 x.id === args.id 比较：数字 id 转成字符串就永远对不上，所以有限数字保留原类型
const rowId = (v) => (num(v) !== undefined ? v : line(v, 80));
// 按 UTF-8 字节截断（积木表的 KB 上限是体积上限，按字符截中文能放大三倍）；encodeInto 只写完整的字，不会劈半个
function bytes(s, max) {
  if (!s || Buffer.byteLength(s) <= max) return s;
  const { read } = new TextEncoder().encodeInto(s, new Uint8Array(max));
  return s.slice(0, read);
}
const clamp = (v, lo, hi) => { const n = num(v); return n === undefined ? undefined : Math.min(hi, Math.max(lo, Math.round(n))); };
// 只带有值的字段（undefined / '' 不出现在结果里，前端不用判一堆空）
function compact(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}
function jsonSize(v) {
  try { const s = JSON.stringify(v); return typeof s === 'string' ? Buffer.byteLength(s) : -1; } catch { return -1; }
}
// 普通 JSON 对象（拷一份：插件之后改自己的对象不影响已下发的树）
function plainObj(v, max) {
  if (!isObj(v)) return null;
  const n = jsonSize(v);
  if (n < 0 || n > max) return null;
  return JSON.parse(JSON.stringify(v));
}

// 插件资源地址：web/… → /plugins/<插件>/web/…（逐段编码，同 ui.mjs 的图标地址）
function imageUrl(plugin, src) {
  const rel = typeof src === 'string' ? src.trim().replace(/^\.?\/+/, '') : '';
  if (!plugin || !IMG_RE.test(rel) || rel.includes('\\') || rel.split('/').some((x) => x === '..' || x === '.' || x === '')) return null;
  return '/plugins/' + plugin + '/' + rel.split('/').map(encodeURIComponent).join('/');
}

function makeCtx({ plugin = '', actions = null, perms = null } = {}) {
  let names = null;
  if (actions instanceof Set) names = actions;
  else if (Array.isArray(actions)) names = new Set(actions);
  else if (isObj(actions)) names = new Set(Object.keys(actions));
  return { plugin: String(plugin || ''), names, perms: Array.isArray(perms) ? perms : null, count: 0 };
}

// Act = 动作名 | { name, args?, confirm? } → { name, args?, confirm? } | null
function act(v, cx) {
  let name;
  let args;
  let confirm;
  if (typeof v === 'string') name = v;
  else if (isObj(v)) {
    name = v.name;
    if (v.args != null) {
      args = plainObj(v.args, ACT_ARGS_MAX);
      if (!args) return null;   // args 坏了不猜，宁可不给按（按下去带错参数比按不了更糟）
    }
    confirm = line(v.confirm, 200) || undefined;
  } else return null;
  if (typeof name !== 'string' || !ACTION_NAME_RE.test(name)) return null;
  if (cx.names && !cx.names.has(name)) return null;
  return compact({ name, args, confirm });
}

function button(b, cx) {
  if (!isObj(b)) return null;
  const label = line(b.label, 20);
  const action = act(b.action, cx);
  if (!label || !action) return null;
  return compact({ type: 'button', label, action, style: pick(b.style, ['primary', 'secondary', 'danger']), confirm: line(b.confirm, 200) });
}

function formField(f) {
  if (!isObj(f)) return null;
  const type = pick(f.type, ['string', 'number', 'integer', 'boolean']) || 'string';
  const out = { type, label: line(f.label, 40), desc: line(f.desc, 200), placeholder: line(f.placeholder, 120) };
  if (Array.isArray(f.enum) && type !== 'boolean') {
    const list = f.enum.filter((x) => (type === 'string' ? typeof x === 'string' || typeof x === 'number' : num(x) !== undefined))
      .slice(0, 50).map((x) => (type === 'string' ? line(x, 80) : x));
    if (list.length) out.enum = list;
  }
  out.widget = pick(f.widget, ['textarea', 'password', 'segmented']);
  if (type === 'number' || type === 'integer') { out.min = num(f.min); out.max = num(f.max); }
  if (f.required === true) out.required = true;
  return compact(out);
}

function form(b, cx) {
  const submitAct = act(b.submit?.action, cx);
  const submitLabel = line(b.submit?.label, 20);
  if (!submitAct || !submitLabel) return null;
  const fields = {};
  let n = 0;
  if (isObj(b.fields)) {
    for (const [k, f] of Object.entries(b.fields)) {
      if (n >= 40) break;
      if (!KEY_RE.test(k)) continue;
      const nf = formField(f);
      if (!nf) continue;
      if (!nf.label) nf.label = k;
      fields[k] = nf;
      n++;
    }
  }
  if (!n) return null;
  // 初始值只收字段里有的键、且是标量（表单只会画这些）
  let value;
  const raw = plainObj(b.value, FORM_VALUE_MAX);
  if (raw) {
    value = {};
    for (const k of Object.keys(fields)) {
      const x = raw[k];
      if (typeof x === 'string') value[k] = x.slice(0, 20_000);
      else if (typeof x === 'number' || typeof x === 'boolean') value[k] = x;
    }
  }
  // cancel：字符串 = 只是个「取消」按钮（前端清回初始值）；{ label, action? } = 另带一个动作
  let cancel;
  if (typeof b.cancel === 'string' && line(b.cancel, 20)) cancel = { label: line(b.cancel, 20) };
  else if (b.cancel === true) cancel = { label: '' };
  else if (isObj(b.cancel)) {
    const a = b.cancel.action != null ? act(b.cancel.action, cx) : null;
    cancel = compact({ label: line(b.cancel.label, 20), action: a || undefined });
  }
  return compact({
    type: 'form', id: KEY_RE.test(b.id || '') ? b.id : 'form', fields, value,
    submit: { label: submitLabel, action: submitAct }, cancel,
  });
}

function chart(b) {
  const series = [];
  for (const s of Array.isArray(b.series) ? b.series : []) {
    if (series.length >= 8) break;
    if (!isObj(s)) continue;
    const points = [];
    for (const p of Array.isArray(s.points) ? s.points : []) {
      if (points.length >= 500) break;
      if (!Array.isArray(p) || p.length < 2) continue;
      const y = num(p[1]);
      const x = num(p[0]) !== undefined ? p[0] : typeof p[0] === 'string' ? line(p[0], 40) : undefined;
      if (y === undefined || x === undefined || x === '') continue;
      points.push([x, y]);
    }
    series.push({ name: line(s.name, 40) || `系列 ${series.length + 1}`, points });
  }
  if (!series.length) return null;
  const x = isObj(b.x) ? compact({ label: line(b.x.label, 40), type: pick(b.x.type, ['category', 'number', 'time']) }) : null;
  const y = isObj(b.y) ? compact({ label: line(b.y.label, 40), unit: line(b.y.unit, 12) }) : null;
  return compact({
    type: 'chart', kind: pick(b.kind, ['line', 'bar']) || 'line', series,
    x: x && Object.keys(x).length ? x : undefined, y: y && Object.keys(y).length ? y : undefined, height: clamp(b.height, 120, 480),
  });
}

function listItem(it, cx) {
  if (!isObj(it)) return null;
  const title = line(it.title, 120);
  if (!title) return null;
  let trailing;
  if (isObj(it.trailing)) {
    const a = act(it.trailing.action, cx);
    if (a && it.trailing.type === 'switch') trailing = { type: 'switch', value: it.trailing.value === true, action: a };
    else if (a && it.trailing.type === 'button' && line(it.trailing.label, 20)) {
      trailing = compact({ type: 'button', label: line(it.trailing.label, 20), action: a, style: pick(it.trailing.style, ['primary', 'secondary', 'danger']) });
    }
  }
  return compact({
    id: it.id == null ? undefined : rowId(it.id), title, desc: line(it.desc, 300), badge: line(it.badge, 16),
    icon: ICON_RE.test(it.icon || '') ? it.icon : undefined, tone: pick(it.tone, TONES),
    action: it.action != null ? act(it.action, cx) || undefined : undefined, trailing,
  });
}

function table(b, cx) {
  const columns = [];
  const keys = new Set();
  for (const c of Array.isArray(b.columns) ? b.columns : []) {
    if (columns.length >= 12) break;
    const key = isObj(c) ? line(c.key, 40) : '';
    if (!key || keys.has(key)) continue;
    keys.add(key);
    columns.push(compact({ key, label: line(c.label, 40) || key, align: pick(c.align, ['left', 'right', 'center']) }));
  }
  if (!columns.length) return null;
  const cell = (v) => (v == null ? '' : typeof v === 'object' ? line(jsonSize(v) >= 0 ? JSON.stringify(v) : '', 200) : line(v, 200));
  const rows = [];
  for (const r of Array.isArray(b.rows) ? b.rows : []) {
    if (rows.length >= 500) break;
    if (!isObj(r)) continue;
    const row = {};
    if (r.id != null && !keys.has('id')) row.id = rowId(r.id);
    for (const k of keys) row[k] = cell(r[k]);
    rows.push(row);
  }
  return compact({
    type: 'table', columns, rows,
    rowAction: b.rowAction != null ? act(b.rowAction, cx) || undefined : undefined, empty: line(b.empty, 200),
  });
}

function one(b, depth, cx) {
  if (!isObj(b) || typeof b.type !== 'string' || !BLOCK_TYPES.includes(b.type)) return null;
  if (cx.count >= BLOCK_LIMITS.total) return null;
  cx.count++;
  switch (b.type) {
    case 'text': {
      const t = text(b.text, 4000);
      return t ? compact({ type: 'text', text: t, tone: pick(b.tone, TONES), size: pick(b.size, ['sm', 'md', 'lg']) }) : null;
    }
    case 'markdown': {
      const t = bytes(text(b.text, 100 * 1024), 100 * 1024);
      return t ? { type: 'markdown', text: t } : null;
    }
    case 'section': {
      // 第 6 层的 section 还画，但它的孩子在第 7 层，丢
      const children = depth < BLOCK_LIMITS.depth ? many(b.children, depth + 1, cx) : [];
      return compact({ type: 'section', title: line(b.title, 80), desc: text(b.desc, 300), children });
    }
    case 'stat': {
      const items = (Array.isArray(b.items) ? b.items : []).filter(isObj).slice(0, 8)
        .map((x) => compact({ label: line(x.label, 30), value: line(x.value, 40), delta: line(x.delta, 20), tone: pick(x.tone, ['ok', 'warn', 'error']), hint: line(x.hint, 80) }))
        .filter((x) => x.label || x.value);
      return items.length ? { type: 'stat', items } : null;
    }
    case 'list': {
      const items = [];
      for (const it of Array.isArray(b.items) ? b.items : []) {
        if (items.length >= 200) break;
        const x = listItem(it, cx);
        if (x) items.push(x);
      }
      return compact({ type: 'list', items, empty: line(b.empty, 200) });
    }
    case 'table': return table(b, cx);
    case 'form': return form(b, cx);
    case 'chart': return chart(b);
    case 'button': return button(b, cx);
    case 'buttons': {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 6).map((x) => button(x, cx)).filter(Boolean);
      return items.length ? { type: 'buttons', items } : null;
    }
    case 'tabs': {
      const action = act(b.action, cx);
      const items = [];
      const seen = new Set();
      for (const x of Array.isArray(b.items) ? b.items : []) {
        if (items.length >= 8) break;
        const id = isObj(x) ? line(x.id, 40) : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, label: line(x.label, 20) || id });
      }
      if (!action || !items.length) return null;
      const value = line(b.value, 40);
      return { type: 'tabs', value: seen.has(value) ? value : items[0].id, items, action };
    }
    case 'empty':
      return compact({ type: 'empty', title: line(b.title, 80), desc: text(b.desc, 300), icon: ICON_RE.test(b.icon || '') ? b.icon : undefined });
    case 'image': {
      const src = imageUrl(cx.plugin, b.src);
      return src ? compact({ type: 'image', src, alt: line(b.alt, 200), height: clamp(b.height, 40, 600) }) : null;
    }
    case 'divider': return { type: 'divider' };
    case 'chat': {
      if (cx.perms && !cx.perms.includes('page.chat')) {
        return { type: 'empty', title: '对话积木用不了', desc: '插件要在清单 permissions 里声明 page.chat 才能放对话积木' };
      }
      const session = typeof b.session === 'string' && b.session.trim() ? line(b.session, 120) : null;
      const on = typeof b.onSession === 'string' && ACTION_NAME_RE.test(b.onSession) && (!cx.names || cx.names.has(b.onSession)) ? b.onSession : undefined;
      return compact({ type: 'chat', session, onSession: on, placeholder: line(b.placeholder, 120), height: clamp(b.height, 240, 800) });
    }
    default: return null;
  }
}

function many(list, depth, cx) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const b of list) {
    if (cx.count >= BLOCK_LIMITS.total) break;
    const x = one(b, depth, cx);
    if (x) out.push(x);
  }
  return out;
}

/** 插件 view 回的树 → 规范化的积木列表。认 Block[]、{ blocks: Block[] }、单个积木；别的回空列表。 */
export function normalizeBlocks(tree, opts = {}) {
  const cx = makeCtx(opts);
  const list = Array.isArray(tree) ? tree : isObj(tree) && Array.isArray(tree.blocks) ? tree.blocks : isObj(tree) && typeof tree.type === 'string' ? [tree] : [];
  return many(list, 1, cx);
}
