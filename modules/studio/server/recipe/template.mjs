// 配方里的模板：请求路径、查询参数、请求头、请求体里的 {{…}} 占位符。只替换取值，不执行任何代码。
//
// 占位符：{{ 取值 [?? 缺省值] [| 过滤器]… }}
//   取值：prompt / negative / model / kind / uuid / now
//         params.<键>                      按卡规范化过的参数（没给 = 没有）
//         inputs.<角色>.<字段>             这个角色的第一个素材；字段 dataUrl | b64 | mime | name | file（只用在 multipart）
//         inputs.<角色>[1].<字段>          第 2 个；inputs.<角色>[*].<字段> = 全部（数组）；inputs.<角色>.count = 个数
//         submit.$…  /  poll.$…           提交 / 轮询的响应 JSON，按 path.mjs 的路径取
//   缺省值：JSON 字面量，取不到时用它，例如 {{params.size ?? "1024x1024"}}
//   过滤器：string number int bool json lower upper
// 整个字符串就是一个占位符（"{{params.duration}}"）时保留原类型（数字还是数字、对象还是对象）；取不到 = 这个键 / 数组元素整个不发
// （「没设置就不传」）。夹在文字里时转成字符串拼进去，取不到拼空串。

import { randomUUID } from 'node:crypto';
import { parsePath, getPath } from './path.mjs';

export const DROP = Symbol('recipe-drop');
const WHOLE_RE = /^\{\{([^{}]*)\}\}$/;
const ANY_RE = /\{\{([^{}]*)\}\}/g;
const ROLES = ['edit', 'ref', 'first', 'last', 'audio', 'video'];
const FIELDS = ['dataUrl', 'b64', 'mime', 'name', 'file'];
const FILTERS = {
  string: (v) => (v == null ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)),
  number: (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? undefined : n; },
  int: (v) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? undefined : Math.trunc(n); },
  bool: (v) => (v == null ? v : v === true || v === 'true' || v === 1 || v === '1'),
  json: (v) => (v === undefined ? v : JSON.stringify(v)),
  lower: (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  upper: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
};

// —— 解析一个占位符（保存配方时就全部解析一遍，写错当场报）——
const cache = new Map();
/** '{{…}}' 里面那段 → { root, path?, role?, index?, field?, all?, fallback?, filters }；写法不对抛。 */
export function parseExpr(src) {
  const raw = String(src).trim();
  if (cache.has(raw)) return cache.get(raw);
  const [main, ...pipes] = raw.split('|').map((s) => s.trim());
  let body = main, fallback;
  const q = main.indexOf('??');
  if (q >= 0) {
    body = main.slice(0, q).trim();
    const lit = main.slice(q + 2).trim();
    try { fallback = JSON.parse(lit); } catch { throw new Error(`缺省值要写成 JSON（字符串带双引号）：{{${raw}}}`); }
  }
  for (const f of pipes) if (!FILTERS[f]) throw new Error(`不认识的过滤器「${f}」（只有 ${Object.keys(FILTERS).join(' ')}）：{{${raw}}}`);
  let e;
  if (['prompt', 'negative', 'model', 'kind', 'uuid', 'now'].includes(body)) e = { root: body };
  else if (/^params\.[A-Za-z0-9_-]{1,64}$/.test(body)) e = { root: 'params', key: body.slice(7) };
  else if (body.startsWith('submit.$') || body.startsWith('poll.$')) {
    const root = body.startsWith('submit') ? 'submit' : 'poll';
    e = { root, path: parsePath(body.slice(root.length + 1)) };
  } else if (body.startsWith('inputs.')) {
    const m = /^inputs\.([a-z]+)(?:\[(\*|\d{1,2})\])?\.([A-Za-z0-9]+)$/.exec(body);
    if (!m || !ROLES.includes(m[1])) throw new Error(`素材占位符写成 inputs.<角色>.<字段>，角色是 ${ROLES.join(' / ')}：{{${raw}}}`);
    if (m[3] === 'count') { if (m[2]) throw new Error(`count 不带下标：{{${raw}}}`); e = { root: 'inputs', role: m[1], count: true }; }
    else {
      if (!FIELDS.includes(m[3])) throw new Error(`素材字段只有 ${FIELDS.join(' / ')} / count：{{${raw}}}`);
      e = { root: 'inputs', role: m[1], field: m[3], ...(m[2] === '*' ? { all: true } : { index: m[2] ? Number(m[2]) : 0 }) };
    }
  } else throw new Error(`不认识的占位符 {{${raw}}}（能用 prompt / negative / model / kind / uuid / now / params.<键> / inputs.<角色>.<字段> / submit.$… / poll.$…）`);
  e.filters = pipes;
  if (fallback !== undefined) e.fallback = fallback;
  if (cache.size > 2000) cache.clear();
  cache.set(raw, e);
  return e;
}

function inputField(x, field) {
  if (!x) return undefined;
  switch (field) {
    case 'dataUrl': return `data:${x.mime || 'application/octet-stream'};base64,${Buffer.from(x.data).toString('base64')}`;
    case 'b64': return Buffer.from(x.data).toString('base64');
    case 'mime': return x.mime;
    case 'name': return x.name || 'file';
    case 'file': return { __file: true, data: x.data, mime: x.mime, name: x.name || 'file' };
    default: return undefined;
  }
}

/** 按解析好的占位符取值（ctx 见文件头）。 */
export function evalExpr(e, ctx) {
  let v;
  switch (e.root) {
    case 'uuid': v = randomUUID(); break;
    case 'now': v = Date.now(); break;
    case 'params': v = ctx.params ? (Object.prototype.hasOwnProperty.call(ctx.params, e.key) ? ctx.params[e.key] : undefined) : undefined; break;
    case 'submit': case 'poll': v = ctx[e.root] === undefined ? undefined : getPath(ctx[e.root], e.path); break;
    case 'inputs': {
      const list = (ctx.inputs || []).filter((x) => x.role === e.role);
      if (e.count) v = list.length;
      else if (e.all) v = list.length ? list.map((x) => inputField(x, e.field)) : undefined;
      else v = inputField(list[e.index], e.field);
      break;
    }
    default: v = ctx[e.root];
  }
  if ((v === undefined || v === null || v === '') && e.fallback !== undefined) v = e.fallback;
  for (const f of e.filters) v = FILTERS[f](v);
  return v;
}

const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** 渲染一个字符串模板。整串一个占位符保留类型（取不到回 DROP）；混排回字符串。enc：给拼进去的值转义（路径用）。 */
export function renderString(s, ctx, { enc } = {}) {
  const whole = WHOLE_RE.exec(s);
  if (whole && !enc) {
    const v = evalExpr(parseExpr(whole[1]), ctx);
    return v === undefined || v === null || v === '' ? DROP : v;
  }
  return s.replace(ANY_RE, (_, x) => { const t = asText(evalExpr(parseExpr(x), ctx)); return enc ? enc(t) : t; });
}

/** 递归渲染 JSON 模板：对象里取不到的键删掉，数组里取不到的元素删掉。 */
export function renderValue(t, ctx) {
  if (typeof t === 'string') return renderString(t, ctx);
  if (Array.isArray(t)) return t.map((x) => renderValue(x, ctx)).filter((x) => x !== DROP);
  if (t && typeof t === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(t)) { const r = renderValue(v, ctx); if (r !== DROP) out[k] = r; }
    return out;
  }
  return t;
}

/** 把模板里所有占位符解析一遍（保存时校验用）；roots 限定这里能用哪些根（例如请求头里不许取 inputs）。写错抛。 */
export function checkTemplate(t, { roots = null, where = '' } = {}) {
  const visit = (x) => {
    if (typeof x === 'string') {
      for (const m of x.matchAll(ANY_RE)) {
        let e;
        try { e = parseExpr(m[1]); } catch (err) { throw new Error(`${where}${err.message}`); }
        if (roots && !roots.includes(e.root)) throw new Error(`${where}这里不能用 {{${m[1].trim()}}}（只能用 ${roots.join(' / ')}）`);
      }
      if (/\{\{/.test(x.replace(ANY_RE, ''))) throw new Error(`${where}占位符没配对：${x.slice(0, 80)}`);
    } else if (Array.isArray(x)) x.forEach(visit);
    else if (x && typeof x === 'object') Object.values(x).forEach(visit);
  };
  visit(t);
}
