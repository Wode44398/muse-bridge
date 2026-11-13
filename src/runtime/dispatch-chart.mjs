// 子 agent 调用策略的图谱数据（2026-11-11）：把「订阅 plan 性价比图」（模型性价比库导出的单页 HTML，线上版见 CHART_URL）
// 导进来，压成与内置快照 src/config/model-ratings.json 同构（version 2）的一份，放在 <数据根>/dispatch-chart/，所有身份共用
// （只有管理员能导入，权限在路由那层管）。
//
//   ratings.json  以内置快照为底合并，不是替换：图表里的官方 API 点（src==='api'）按 slug 覆盖 / 新增 models[]，
//                 底里有而图表没有的行原样保留（分项 subs、旧分都还在）；plans.pro / max5 / max20 换成图表里 Anthropic 的
//                 Claude Pro / Claude Max / Claude Ultra；另带 planPoints（各家订阅 plan 每任务成本，第三方服务按 plan 计价用）
//                 与 imported（导入来源）。
//   points.json   「显示全图」用的精简点表：{ generated, points: [[vkey, plan, slug, family, effort, score, cost, src], …], vendors }。
//
// 解析只取页面里 `const DATA = ` 那一行的 JSON，绝不执行页面脚本。
// runtime/model-ratings.mjs 的 loadRatings 有导入的就用导入的：importedRatings() 返回的对象只在导入 / 清除 / 换根之后才换，
// 调用方按对象身份判断要不要重建索引（这里不反向依赖 model-ratings.mjs，免得循环引用）。
//
// 服务地址 → plan（planOfBaseUrl）：只认把握高的套餐专属端点（PLAN_ENDPOINTS），其余一律按官方 API 价。
// URL 只能认出「哪家、是不是套餐」，认不出档位（Lite / Pro / Max），所以 plan 成本取这家各现行 plan 的均值（planCost）。

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../config/index.mjs';
import { readJson } from '../jsonfile.mjs';
import { baseOf } from '../model-knowledge/ratings.mjs';
import { providerOf } from '../model-knowledge/brands.mjs';

export const CHART_URL = 'https://model-plan-chart.pages.dev/';
/** 上传 / 拉取的 HTML 体积上限（路由超限回 413） */
export const CHART_MAX_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const MIN_POINTS = 50;
const NOT_CHART = '这不是订阅 plan 性价比图';
const BUILTIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'model-ratings.json');
const RATINGS_FILE = 'ratings.json';
const POINTS_FILE = 'points.json';

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const sig = (x, n = 3) => (x > 0 ? +x.toPrecision(n) : 0);
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

// 图表的档位写法 → 快照的：非推理 → off、默认 → ''（这个型号只有一种配置），其余（low…max）原样
function effortOfPoint(e) {
  const t = String(e ?? '').trim();
  if (t === '非推理') return 'off';
  if (t === '默认') return '';
  return t.toLowerCase();
}
// 图表里的 slug / vkey / plan 会被拿来当对象键：原型链上的名字一律不收（vkey '__proto__' 会把整张 plan 表写到 Object.prototype 上）
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// 收进来的点：slug 是正常的键名；智力分在 0–100；每任务成本 > 0（对数轴，0 和负数画不出来，也会在选档里白占「最便宜」）。
// 越界的点整个丢掉，底表里同 slug 的行原样保留——内存里的结果和落盘再读回来的完全一样（Infinity 落盘会变成 null）
const okPoint = (p) => !!p && typeof p === 'object' && typeof p.slug === 'string' && p.slug !== '' && !BAD_KEYS.has(p.slug)
  && !BAD_KEYS.has(p.vkey) && !BAD_KEYS.has(p.plan)
  && num(p.score) && p.score >= 0 && p.score <= 100 && num(p.cost) && p.cost > 0;
const okKey = (s) => typeof s === 'string' && s !== '' && !BAD_KEYS.has(s);
// 键名来自外部数据的表：拼的时候不带原型（'toString' 这类名字也只是普通的键，不会读到原型上的函数），
// 拼完再转回普通对象（Object.fromEntries 只建自有属性）——和落盘再读回来的形状一致
const dict = () => Object.create(null);
const toPlain = (x) => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toPlain(v)])) : x);

// Anthropic 订阅 plan → 快照 plans 的键。图表现在的显示名是 Pro / Max / Ultra，planFull 还是旧名 Max 5x / 20x，两种都认
const SUB_PLAN_KEYS = Object.freeze({ 'Claude Pro': 'pro', 'Claude Max': 'max5', 'Claude Ultra': 'max20', 'Claude Max 5x': 'max5', 'Claude Max 20x': 'max20' });
const subPlanOf = (s) => { const k = String(s ?? '').trim(); return Object.hasOwn(SUB_PLAN_KEYS, k) ? SUB_PLAN_KEYS[k] : undefined; };
const subPlanKey = (p) => subPlanOf(p.plan) ?? subPlanOf(p.planFull);

// 图表 source 里写的智力指数版本（「Artificial Analysis Intelligence Index v5.0（…）」）
function indexVersionOf(D) {
  const m = /Intelligence Index\s+(v\d+(?:\.\d+)*)/i.exec(String(D?.source ?? ''));
  return m ? m[1] : '';
}

/** 性价比图 HTML → DATA 对象。只取 `const DATA = ` 那一行第一个 { 到最后一个 }；不合规抛 { status:400 }（太大 413）。 */
export function parseChartHtml(html) {
  const s = Buffer.isBuffer(html) ? html.toString('utf8') : typeof html === 'string' ? html : '';
  if (Buffer.byteLength(s) > CHART_MAX_BYTES) throw fail('文件太大：性价比图上限 12MB', 413);
  const at = s.indexOf('const DATA = ');
  if (at < 0) throw fail(NOT_CHART);
  const nl = s.indexOf('\n', at);
  const line = s.slice(at, nl < 0 ? s.length : nl);
  const a = line.indexOf('{'), b = line.lastIndexOf('}');
  if (a < 0 || b <= a) throw fail(NOT_CHART);
  let D;
  try { D = JSON.parse(line.slice(a, b + 1)); } catch { throw fail(NOT_CHART); }
  if (!D || typeof D !== 'object' || !Array.isArray(D.points) || D.points.length < MIN_POINTS) throw fail(NOT_CHART);
  if (!D.points.some((p) => okPoint(p) && p.src === 'api' && p.vkey === 'anthropic')) throw fail(NOT_CHART);
  return D;
}

/**
 * DATA + 内置快照 → 合并后的 ratings 对象（纯函数）。
 * models：图表的 API 点按 slug 覆盖 / 新增（ii 一位小数、cost 三位有效数字、分时段的取贵的；base 用知识层 baseOf，
 * 分项与 est 从底里同一 slug 继承），底里其余的行原样保留——只有图表换了智力指数版本时，留下来的现行行改标旧分（和新版不可比）。
 */
export function chartToSnapshot(D, base) {
  const b = base && typeof base === 'object' && Array.isArray(base.models) ? base : { models: [], plans: {} };
  const pts = (Array.isArray(D?.points) ? D.points : []).filter(okPoint);

  const api = new Map();
  for (const p of pts) {
    if (p.src !== 'api') continue;
    const cur = api.get(p.slug);
    if (!cur || p.cost > cur.cost) api.set(p.slug, p);
  }
  const rows = b.models.filter((m) => m && typeof m.slug === 'string');
  const was = new Map(rows.map((m) => [m.slug, m]));
  const slugs = [...new Set([...was.keys(), ...api.keys()])];
  const baseIndex = String(b.index ?? '');
  const index = indexVersionOf(D) || baseIndex;
  const bump = !!(baseIndex && index !== baseIndex);

  const models = [];
  for (const m of rows) {
    if (api.has(m.slug)) continue;
    models.push(bump && !m.old ? { ...m, old: true, ver: baseIndex } : m);
  }
  for (const [slug, p] of api) {
    const prev = was.get(slug);
    const ii = round1(p.score);
    const dep = p.dep ?? prev?.dep;
    models.push({
      slug, base: baseOf(slug, slugs), effort: effortOfPoint(p.effort),
      name: String(p.aaName || prev?.name || slug), creator: String(p.creator || prev?.creator || ''),
      ii, cost: sig(p.cost), rel: String(p.rel || prev?.rel || ''),
      ...(dep ? { dep: true } : {}),
      ...(prev?.est && !prev.old && prev.ii === ii ? { est: true } : {}),
      ...(prev?.subs ? { subs: prev.subs } : {}),
    });
  }
  // 和快照生成脚本同一排法：现行版本在前、旧分在后，各自按分数排
  models.sort((x, y) => Number(!!x.old) - Number(!!y.old) || y.ii - x.ii || x.slug.localeCompare(y.slug));

  const plans = { ...(b.plans && typeof b.plans === 'object' ? b.plans : {}) };
  const subs = dict();
  const meta = new Map((Array.isArray(D?.plans) ? D.plans : []).filter((x) => x && x.vkey && x.plan).map((x) => [x.vkey + '|' + x.plan, x]));
  const planPoints = dict();
  const okPrice = (x) => num(x) && x >= 0 && Number.isFinite(round2(x));
  for (const p of pts) {
    if (p.src !== 'plan' || !okKey(p.vkey) || !okKey(p.plan)) continue;
    const c = sig(p.cost);
    const k = p.vkey === 'anthropic' ? subPlanKey(p) : null;
    if (k) { const m = (subs[k] ||= dict()); m[p.slug] = Math.max(m[p.slug] || 0, c); }
    const pm = meta.get(p.vkey + '|' + p.plan) || {};
    const price = okPrice(pm.price) ? pm.price : okPrice(p.price) ? p.price : 0;
    const v = (planPoints[p.vkey] ||= dict());
    const e = (v[p.plan] ||= { legacy: !!(pm.legacy ?? p.legacy), price: round2(price), costs: dict() });
    e.costs[p.slug] = Math.max(e.costs[p.slug] || 0, c);
  }
  Object.assign(plans, toPlain(subs));

  return {
    version: 2, generated: String(D?.generated || b.generated || ''), index, fx: num(D?.fx) ? D.fx : b.fx,
    source: '订阅 plan 性价比图（导入）：Artificial Analysis 智力指数 + 官方 API / 订阅 plan 的每任务成本',
    models, plans, planPoints: toPlain(planPoints),
  };
}

/** DATA → 「显示全图」的精简点表（纯函数）。同一 厂商 × plan × slug 多个时段的取贵的。 */
export function chartPoints(D) {
  const seen = new Map();
  for (const p of (Array.isArray(D?.points) ? D.points : []).filter(okPoint)) {
    if (p.src !== 'api' && p.src !== 'plan') continue;
    const k = `${p.vkey}|${p.plan}|${p.slug}`;
    const cur = seen.get(k);
    if (!cur || p.cost > cur.cost) seen.set(k, p);
  }
  const points = [...seen.values()].map((p) => [
    String(p.vkey ?? ''), String(p.plan ?? ''), p.slug, String(p.family ?? ''), effortOfPoint(p.effort), round1(p.score), sig(p.cost), p.src,
  ]);
  const vendors = (Array.isArray(D?.vendors) ? D.vendors : []).filter((v) => v && v.key)
    .map((v) => ({ key: String(v.key), name: String(v.name || v.key), cn: !!v.cn, tp: !!v.tp }));
  return { generated: String(D?.generated ?? ''), points, vendors };
}

// ── 落盘 ────────────────────────────────────────────────────────────────────
let rootFn = () => ROOT;
let ratingsCache;   // undefined = 还没读；null = 没导入过；对象 = 导入的 ratings
let pointsCache;
const chartDir = () => path.join(rootFn(), 'dispatch-chart');

/** 测试用：换数据根（传函数或目录；不传 = 回到真实数据根），顺带清掉内存缓存。 */
export function setChartRoot(fn) {
  rootFn = typeof fn === 'function' ? fn : typeof fn === 'string' && fn ? () => fn : () => ROOT;
  ratingsCache = undefined;
  pointsCache = undefined;
}

let builtin;
function builtinSnapshot() {
  if (builtin === undefined) {
    try { builtin = JSON.parse(readFileSync(BUILTIN, 'utf8')); } catch { builtin = null; }
  }
  return builtin;
}

// 原子写（tmp + rename）；jsonfile 的 writeJson 失败只记日志，导入要把失败如实报给界面，所以这里自己写、失败就抛
function writeAtomic(file, text) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    throw fail('图谱数据写盘失败：' + String(e?.message || e), 500);
  }
}

/** 导入的 ratings 对象（与内置快照同构）；没导入过 / 文件坏了 → null。带内存缓存。 */
export function importedRatings() {
  if (ratingsCache === undefined) {
    const j = readJson(path.join(chartDir(), RATINGS_FILE), null);
    ratingsCache = j && Array.isArray(j.models) && j.models.length ? j : null;
  }
  return ratingsCache;
}

/** 「显示全图」的点表；没导入过 → null。 */
export function chartAllPoints() {
  if (pointsCache === undefined) {
    const j = importedRatings() ? readJson(path.join(chartDir(), POINTS_FILE), null) : null;
    pointsCache = j && Array.isArray(j.points) ? j : null;
  }
  return pointsCache;
}

/** 现在生效的图谱数据是哪份：{ source:'imported'|'builtin', generated, at?, from?, points?, name?, hasPlanPoints }。 */
export function chartMeta() {
  const j = importedRatings();
  const hasPP = (x) => !!(x && x.planPoints && typeof x.planPoints === 'object' && Object.keys(x.planPoints).length);
  if (j) {
    const im = j.imported && typeof j.imported === 'object' ? j.imported : {};
    return {
      source: 'imported', generated: String(j.generated ?? ''),
      ...(im.at != null ? { at: im.at } : {}), ...(im.from ? { from: im.from } : {}), ...(num(im.points) ? { points: im.points } : {}),
      ...(im.name ? { name: im.name } : {}), hasPlanPoints: hasPP(j),
    };
  }
  const b = builtinSnapshot();
  return { source: 'builtin', generated: String(b?.generated ?? ''), hasPlanPoints: hasPP(b) };
}

const cleanName = (name, from) => {
  let s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (from === 'file') s = s.split(/[\\/]/).pop().trim();
  return s.slice(0, 200);
};

/** 解析 + 落盘（覆盖现有）+ 换掉内存里的 ratings（loadRatings 按对象身份重建索引）→ chartMeta()。 */
export function importChartHtml(html, { from = 'file', name } = {}) {
  const D = parseChartHtml(html);
  const src = from === 'url' ? 'url' : 'file';
  const snap = chartToSnapshot(D, builtinSnapshot());
  const nm = cleanName(name, src);
  snap.imported = { at: Date.now(), from: src, generated: snap.generated, points: D.points.length, ...(nm ? { name: nm } : {}) };
  const pts = chartPoints(D);
  const dir = chartDir();
  writeAtomic(path.join(dir, POINTS_FILE), JSON.stringify(pts));
  writeAtomic(path.join(dir, RATINGS_FILE), JSON.stringify(snap));   // ratings 最后写：它在就算导入过
  ratingsCache = snap;
  pointsCache = pts;
  return chartMeta();
}

// 读响应体，超过上限就掐断（不整份读进内存再判）
async function readCapped(r, max) {
  const len = Number(r.headers?.get?.('content-length'));
  if (len > max) throw fail('线上的性价比图超过 12MB 上限', 502);
  if (!r.body || typeof r.body.getReader !== 'function') {
    const t = await r.text();
    if (Buffer.byteLength(t) > max) throw fail('线上的性价比图超过 12MB 上限', 502);
    return t;
  }
  const reader = r.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      throw fail('线上的性价比图超过 12MB 上限', 502);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 从线上拉最新的性价比图并导入（覆盖现有）→ chartMeta()。走进程内 fetch，即全局出站代理（net-proxy 的 setGlobalDispatcher）；
 * 30 秒超时（含读响应体）、上限 12MB。fetchImpl 只给测试换假的。
 */
export async function fetchChart({ url = CHART_URL, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
  let html;
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow', headers: { accept: 'text/html' } });
    if (!r.ok) throw fail(`拉取性价比图失败：HTTP ${r.status}`, 502);
    html = await readCapped(r, CHART_MAX_BYTES);
  } catch (e) {
    if (e && e.status) throw e;
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw fail('拉取性价比图超时（30 秒）', 504);
    throw fail('拉取性价比图失败：' + String(e?.cause?.message || e?.message || e), 502);
  }
  return importChartHtml(html, { from: 'url', name: url });
}

/** 删掉导入的数据，回到随版本内置的快照 → chartMeta()。 */
export function clearChart() {
  const dir = chartDir();
  for (const f of [RATINGS_FILE, POINTS_FILE]) {   // ratings 先删：中途失败也只会落到内置快照
    try { rmSync(path.join(dir, f), { force: true }); } catch (e) { throw fail('清除图谱数据失败：' + String(e?.message || e), 500); }
  }
  ratingsCache = null;
  pointsCache = null;
  return chartMeta();
}

// ── 服务地址 → plan ──────────────────────────────────────────────────────────
// 套餐专属端点（只收把握高的；以后加一行就行）。host / path 都要对上；path 不写 = 主机本身就是套餐专用的。
// vkey = 性价比图里的厂商键。providerOf 只用来带出知识层的提供商键，不当闸门：opencode.ai、api.stepfun.ai 知识层还不认识，
// 以后知识层补上了也不该让这里失灵。
const PLAN_ENDPOINTS = Object.freeze([
  { vkey: 'mimo', host: /^token-plan-[a-z0-9-]+\.xiaomimimo\.com$/ },
  { vkey: 'kimi', host: /^api\.kimi\.(?:com|ai)$/, path: /(?:^|\/)coding(?:\/|$)/ },
  { vkey: 'zhipu', host: /^(?:open\.bigmodel\.cn|api\.z\.ai)$/, path: /(?:^|\/)api\/coding(?:\/|$)/ },
  { vkey: 'stepfun', host: /^api\.stepfun\.(?:com|ai)$/, path: /(?:^|\/)step_plan(?:\/|$)/ },
  { vkey: 'qwen', host: /^token-plan\.[a-z0-9-]+\.maas\.aliyuncs\.com$/ },
  { vkey: 'tp_volcengine', host: /^ark\.[a-z0-9-]+\.volces\.com$/, path: /(?:^|\/)api\/coding(?:\/|$)/ },
  { vkey: 'tp_comate', host: /^qianfan\.baidubce\.com$/, path: /(?:^|\/)tokenplan(?:\/|$)/ },
  { vkey: 'tp_opencode', host: /^opencode\.ai$/, path: /(?:^|\/)(?:zen|inference)\/go(?:\/|$)/ },
]);

function parseUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
}

/** 服务的真实地址 → { vkey, basis:'plan', provider? }；不是认得出的套餐端点 → null（按官方 API 价）。 */
export function planOfBaseUrl(baseUrl) {
  const u = parseUrl(baseUrl);
  if (!u) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const p = u.pathname.toLowerCase();
  const rule = PLAN_ENDPOINTS.find((r) => r.host.test(host) && (!r.path || r.path.test(p)));
  if (!rule) return null;
  const pk = providerOf(baseUrl)?.key;
  return { vkey: rule.vkey, basis: 'plan', ...(pk ? { provider: pk } : {}) };
}

/** 这家（vkey）各现行（非老档）plan 里有这个 slug 的每任务成本的算术平均（三位有效数字）；一个都没有 → null。R = 索引后的 ratings。 */
export function planCost(R, vkey, slug) {
  const v = R && R.planPoints && vkey ? R.planPoints[vkey] : null;
  if (!v || typeof v !== 'object' || !slug) return null;
  const xs = [];
  for (const p of Object.values(v)) {
    if (!p || p.legacy) continue;
    const c = p.costs && p.costs[slug];
    if (num(c) && c > 0) xs.push(c);
  }
  return xs.length ? sig(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
