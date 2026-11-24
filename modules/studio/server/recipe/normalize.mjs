// 配方的形状与校验。配方 = 用配置描述一个 HTTP 媒体接口怎么调（提交 → 轮询 → 取结果），让不标准的中转站不用写适配器也能接。
// 存在模型配置层（model-config/store.mjs），按「服务 id/模型 id」一份；地址与 Key 仍用服务自己的（配方里拿不到 Key）。
//
// {
//   submit:  { method: GET|POST|PUT, path: '/videos'（接在服务地址后）| url: 'https://同一个域名/…', query?: {…}, headers?: {…},
//              body?: JSON 模板, bodyType?: json|multipart, timeoutSec?: 10–600 },
//   poll?:   { method?, path? | url?（可以是 {{submit.$.status_url}}，运行时也只许同一个域名）, query?, headers?, body?,
//              intervalSec?: 1–60（默认 5）, timeoutMin?: 1–120（默认 30）,
//              status: '$.路径', done: [值…], failed?: [值…], error?: '$.路径', progress?: '$.路径'（0–1 或 0–100） },
//   result:  { from?: submit|poll（默认有 poll 就 poll）, url?: '$.路径' | b64?: '$.路径' | binary?: true（响应本身就是文件）
//              | download?: { method?, path? | url?, query?, headers? }, mime?: 'video/mp4' },
//   params?: [{ key, label?, type: enum|number|bool|text|json, options?, min?, max?, step?, default?, desc?, group? }],
//   inputs?: { images?: { max, roles: [edit|ref|first|last] }, audio?: { max }, video?: { max } },
//   auth?:   { header?: 'X-Token', prefix?: 'Bearer ' } | { query: 'key' } | { none: true }（不写 = 用服务的鉴权方式）,
//   etaSec?, note?
// }
// 模板写法见 template.mjs。请求只发到服务自己的域名（path 接在服务地址后；写成 url 的必须同一个协议、主机、端口），
// 结果文件的下载地址可以是别的域名（CDN），但只有同域名的才带 Key。

import { checkTemplate } from './template.mjs';
import { parsePath } from './path.mjs';

const MAX_BYTES = 20_000;
const MAX_PARAMS = 30;
const METHODS = ['GET', 'POST', 'PUT'];
const PARAM_TYPES = ['enum', 'number', 'bool', 'text', 'json'];
const IMAGE_ROLES = ['edit', 'ref', 'first', 'last'];
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 同 providers.mjs 的 HEADER_RE / RESERVED_HEADERS：鉴权头由服务的鉴权方式或配方的 auth 管，不许在 headers 里写死
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'authorization', 'x-api-key', 'x-goog-api-key', 'xi-api-key', 'content-type', 'accept-encoding', 'cookie']);
const ROOTS_SUBMIT = ['prompt', 'negative', 'model', 'kind', 'uuid', 'now', 'params', 'inputs'];
const ROOTS_POLL = ['model', 'kind', 'uuid', 'now', 'params', 'submit'];
const ROOTS_DL = ['model', 'kind', 'params', 'submit', 'poll'];
const ROOTS_HEAD = ['model', 'kind', 'uuid', 'now', 'params'];

const bad = (msg) => Object.assign(new Error('配方：' + msg), { status: 400 });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const num = (v, lo, hi, what) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${what}要在 ${lo}–${hi} 之间`);
  return n;
};
const noProto = (o, where) => {
  const s = JSON.stringify(o);
  if (/"(__proto__|constructor|prototype)"\s*:/.test(s)) throw bad(`${where}里有不允许的键`);
};
function only(o, keys, where) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`${where}不认识「${k}」（只有 ${keys.join(' / ')}）`);
}

function cleanPath(v, where) {
  const s = String(v ?? '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) throw bad(`${where}.path 要以 / 开头，接在服务地址后面（例如 /videos）`);
  if (s.length > 300) throw bad(`${where}.path 太长`);
  if (/:\/\//.test(s) || /(^|\/)\.\.(\/|$)/.test(s.split('?')[0])) throw bad(`${where}.path 不能写别的地址或 ..`);
  checkTemplate(s, { roots: where === 'submit' ? ROOTS_HEAD : where === 'poll' ? ROOTS_POLL : ROOTS_DL, where: `${where}.path：` });
  return s;
}
function cleanUrl(v, where, roots) {
  const s = String(v ?? '').trim();
  if (s.length > 500) throw bad(`${where}.url 太长`);
  if (!/^\{\{[^{}]+\}\}$/.test(s) && !/^https?:\/\//i.test(s)) throw bad(`${where}.url 要是完整地址（https://…），或者整个写成一个占位符（{{submit.$.status_url}}）`);
  checkTemplate(s, { roots, where: `${where}.url：` });
  return s;
}
function cleanHeaders(h, where, roots) {
  if (h === undefined) return undefined;
  if (!isObj(h)) throw bad(`${where}.headers 要是对象`);
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!HEADER_RE.test(k)) throw bad(`${where}.headers 里的「${k}」不是合法的请求头名`);
    if (RESERVED.has(k.toLowerCase())) throw bad(`${where}.headers 不能写「${k}」：鉴权用配方的 auth 或服务的鉴权方式，其余由 bridge 自己管`);
    if (typeof v !== 'string') throw bad(`${where}.headers 的值要是字符串`);
    checkTemplate(v, { roots, where: `${where}.headers.${k}：` });
    out[k] = v.slice(0, 2000);
  }
  if (Object.keys(out).length > 16) throw bad(`${where}.headers 最多 16 个`);
  return out;
}
function cleanQuery(q, where, roots) {
  if (q === undefined) return undefined;
  if (!isObj(q)) throw bad(`${where}.query 要是对象`);
  for (const [k, v] of Object.entries(q)) {
    if (!/^[\w.[\]-]{1,64}$/.test(k)) throw bad(`${where}.query 的键「${k}」不合法`);
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw bad(`${where}.query 的值要是字符串、数字或布尔`);
  }
  checkTemplate(q, { roots, where: `${where}.query：` });
  return { ...q };
}
function cleanJsonPath(v, where) {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw bad(`${where} 要是取值路径字符串（$.…）`);
  try { parsePath(v); } catch (e) { throw bad(`${where}：${e.message}`); }
  return v.trim();
}
const scalarList = (v, where) => {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > 20 || !list.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) throw bad(`${where} 要是 1–20 个字符串 / 数字`);
  return list;
};

// 一个请求步（submit / poll / download）的公共部分
function cleanStep(o, where, { roots, needPath = true }) {
  if (!isObj(o)) throw bad(`${where} 要是对象`);
  const method = String(o.method || (where === 'submit' ? 'POST' : 'GET')).toUpperCase();
  if (!METHODS.includes(method)) throw bad(`${where}.method 只能是 ${METHODS.join(' / ')}`);
  const out = { method };
  if (o.path !== undefined && o.url !== undefined) throw bad(`${where} 的 path 和 url 只写一个`);
  if (o.path !== undefined) out.path = cleanPath(o.path, where);
  else if (o.url !== undefined) out.url = cleanUrl(o.url, where, roots);
  else if (needPath) throw bad(`${where} 要写 path（接在服务地址后）或 url`);
  const q = cleanQuery(o.query, where, roots); if (q) out.query = q;
  const h = cleanHeaders(o.headers, where, ROOTS_HEAD.filter((r) => roots.includes(r)).concat(roots.includes('submit') ? ['submit'] : [])); if (h) out.headers = h;
  if (o.body !== undefined) {
    if (method === 'GET') throw bad(`${where} 是 GET，不能带 body`);
    checkTemplate(o.body, { roots, where: `${where}.body：` });
    out.body = o.body;
  }
  return out;
}

function cleanParam(p, i, seen) {
  if (!isObj(p)) throw bad(`params[${i}] 要是对象`);
  only(p, ['key', 'label', 'type', 'options', 'min', 'max', 'step', 'default', 'desc', 'group'], `params[${i}]`);
  const key = String(p.key ?? '');
  if (!KEY_RE.test(key)) throw bad(`params[${i}].key 只能是字母数字 _ -（最长 64）`);
  if (seen.has(key)) throw bad(`params 里「${key}」重复了`);
  seen.add(key);
  const type = String(p.type || 'text');
  if (!PARAM_TYPES.includes(type)) throw bad(`参数「${key}」的 type 只能是 ${PARAM_TYPES.join(' / ')}`);
  const out = { key, type, label: str(p.label, 40) || key };
  if (p.desc) out.desc = str(p.desc, 200);
  out.group = p.group === 'basic' || p.group === 'advanced' ? p.group : (type === 'enum' ? 'basic' : 'advanced');
  if (type === 'enum') {
    const list = Array.isArray(p.options) ? p.options : [];
    if (!list.length || list.length > 50) throw bad(`参数「${key}」是 enum，要给 1–50 个 options`);
    out.options = list.map((o) => {
      const value = isObj(o) ? o.value : o;
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw bad(`参数「${key}」的选项要是字符串 / 数字 / 布尔，或 { value, label }`);
      return { value, label: isObj(o) && o.label ? str(o.label, 40) : String(value) };
    });
  }
  if (type === 'number') {
    const min = num(p.min, -1e12, 1e12, `参数「${key}」的 min`), max = num(p.max, -1e12, 1e12, `参数「${key}」的 max`);
    if (min !== undefined) out.min = min;
    if (max !== undefined) out.max = max;
    if (min !== undefined && max !== undefined && min > max) throw bad(`参数「${key}」的 min 比 max 大`);
    const step = num(p.step, 0, 1e9, `参数「${key}」的 step`); if (step) out.step = step;
  }
  if (p.default !== undefined && p.default !== null) {
    if (type === 'json') { if (!isObj(p.default)) throw bad(`参数「${key}」的默认值要是对象`); }
    else if (!['string', 'number', 'boolean'].includes(typeof p.default)) throw bad(`参数「${key}」的默认值要是字符串 / 数字 / 布尔`);
    if (type === 'enum' && !out.options.some((o) => o.value === p.default)) throw bad(`参数「${key}」的默认值不在 options 里`);
    out.default = p.default;
  }
  return out;
}

function cleanInputs(v) {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw bad('inputs 要是对象');
  only(v, ['images', 'audio', 'video'], 'inputs');
  const out = {};
  if (v.images !== undefined) {
    if (!isObj(v.images)) throw bad('inputs.images 要是 { max, roles }');
    const roles = (Array.isArray(v.images.roles) ? v.images.roles : ['ref']).map(String);
    if (!roles.length || !roles.every((r) => IMAGE_ROLES.includes(r))) throw bad(`inputs.images.roles 只能是 ${IMAGE_ROLES.join(' / ')}`);
    out.images = { max: num(v.images.max ?? 1, 1, 16, 'inputs.images.max'), roles: [...new Set(roles)] };
  }
  for (const k of ['audio', 'video']) if (v[k] !== undefined) out[k] = { max: num(isObj(v[k]) ? v[k].max ?? 1 : v[k], 1, 8, `inputs.${k}.max`) };
  return out;
}

function cleanAuth(v) {
  if (v === undefined) return undefined;
  if (!isObj(v)) throw bad('auth 要是对象');
  only(v, ['header', 'prefix', 'query', 'none'], 'auth');
  if (v.none === true) return { none: true };
  if (v.query !== undefined) {
    if (v.header !== undefined) throw bad('auth 的 header 和 query 只写一个');
    if (!/^[\w-]{1,40}$/.test(String(v.query))) throw bad('auth.query 要是查询参数名');
    return { query: String(v.query) };
  }
  if (!HEADER_RE.test(String(v.header ?? '')) || ['host', 'content-length', 'cookie'].includes(String(v.header).toLowerCase())) throw bad('auth.header 要是合法的请求头名');
  return { header: String(v.header), prefix: String(v.prefix ?? '').replace(/[\r\n]/g, '').slice(0, 40) };
}

/** 校验并整理一份配方；坏的抛 400（「配方：…」人话）。null / undefined 回 null（= 不用配方）。 */
export function normalizeRecipe(r) {
  if (r === null || r === undefined) return null;
  if (!isObj(r)) throw bad('要是 JSON 对象');
  const size = JSON.stringify(r).length;
  if (size > MAX_BYTES) throw bad(`太大了（${size} 字符，上限 ${MAX_BYTES}）`);
  noProto(r, '配方');
  only(r, ['submit', 'poll', 'result', 'params', 'inputs', 'auth', 'etaSec', 'note'], '顶层');
  if (!r.submit) throw bad('缺 submit（怎么提交）');
  if (!r.result) throw bad('缺 result（结果在哪）');
  const out = {};
  out.submit = cleanStep(r.submit, 'submit', { roots: ROOTS_SUBMIT });
  only(r.submit, ['method', 'path', 'url', 'query', 'headers', 'body', 'bodyType', 'timeoutSec'], 'submit');
  const bodyType = r.submit.bodyType ?? 'json';
  if (!['json', 'multipart'].includes(bodyType)) throw bad('submit.bodyType 只能是 json / multipart');
  if (bodyType === 'multipart') {
    if (!isObj(r.submit.body)) throw bad('multipart 的 body 要是 { 字段名: 值 } 对象');
    out.submit.bodyType = 'multipart';
  }
  const ts = num(r.submit.timeoutSec, 10, 600, 'submit.timeoutSec'); if (ts) out.submit.timeoutSec = ts;

  if (r.poll !== undefined && r.poll !== null) {
    const p = r.poll;
    only(p, ['method', 'path', 'url', 'query', 'headers', 'body', 'intervalSec', 'timeoutMin', 'status', 'done', 'failed', 'error', 'progress'], 'poll');
    out.poll = cleanStep(p, 'poll', { roots: ROOTS_POLL });
    out.poll.status = cleanJsonPath(p.status, 'poll.status');
    if (!out.poll.status) throw bad('poll 要写 status（状态字段的路径，例如 $.status）');
    out.poll.done = scalarList(p.done, 'poll.done');
    if (!out.poll.done) throw bad('poll 要写 done（完成时状态字段的值，例如 ["succeeded"]）');
    const failed = scalarList(p.failed, 'poll.failed'); if (failed) out.poll.failed = failed;
    for (const k of ['error', 'progress']) { const v = cleanJsonPath(p[k], `poll.${k}`); if (v) out.poll[k] = v; }
    const iv = num(p.intervalSec, 1, 60, 'poll.intervalSec'); if (iv) out.poll.intervalSec = iv;
    const tm = num(p.timeoutMin, 1, 120, 'poll.timeoutMin'); if (tm) out.poll.timeoutMin = tm;
  }

  const res = r.result;
  if (!isObj(res)) throw bad('result 要是对象');
  only(res, ['from', 'url', 'b64', 'binary', 'download', 'mime'], 'result');
  out.result = {};
  const from = res.from ?? (out.poll ? 'poll' : 'submit');
  if (!['submit', 'poll'].includes(from)) throw bad('result.from 只能是 submit / poll');
  if (from === 'poll' && !out.poll) throw bad('result.from 是 poll，但没写 poll');
  out.result.from = from;
  const ways = ['url', 'b64', 'binary', 'download'].filter((k) => res[k] !== undefined && res[k] !== false && res[k] !== null);
  if (ways.length !== 1) throw bad('result 里 url / b64 / binary / download 要恰好写一个');
  if (res.url !== undefined) out.result.url = cleanJsonPath(res.url, 'result.url');
  if (res.b64 !== undefined) out.result.b64 = cleanJsonPath(res.b64, 'result.b64');
  if (res.binary === true) {
    if (from !== 'submit' || out.poll) throw bad('result.binary 只用在没有 poll、提交的响应本身就是文件的接口');
    out.result.binary = true;
  }
  if (res.download !== undefined) {
    only(res.download, ['method', 'path', 'url', 'query', 'headers', 'body'], 'result.download');
    out.result.download = cleanStep(res.download, 'download', { roots: ROOTS_DL });
  }
  if (res.mime !== undefined) {
    if (!/^(image|video|audio)\/[\w.+-]{1,40}$/.test(String(res.mime))) throw bad('result.mime 要是 image/… video/… audio/…');
    out.result.mime = String(res.mime);
  }

  if (r.params !== undefined) {
    if (!Array.isArray(r.params)) throw bad('params 要是数组');
    if (r.params.length > MAX_PARAMS) throw bad(`params 最多 ${MAX_PARAMS} 个`);
    const seen = new Set();
    out.params = r.params.map((p, i) => cleanParam(p, i, seen));
  }
  const ins = cleanInputs(r.inputs); if (ins) out.inputs = ins;
  const auth = cleanAuth(r.auth); if (auth) out.auth = auth;
  const eta = num(r.etaSec, 1, 7200, 'etaSec'); if (eta) out.etaSec = eta;
  if (r.note) out.note = str(r.note, 300);
  return out;
}
