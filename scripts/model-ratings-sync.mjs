// 模型性价比快照：把服主自己维护的「模型性价比图谱」库压成 src/config/model-ratings.json，给子 agent 调度阶梯用
//（src/runtime/model-ratings.mjs、harness 的 agent/dispatch-ladder.ts，匹配逻辑共用 src/model-knowledge/ratings.mjs）。
// 库在本机另一个目录、随时在改；bridge 只认发版那一刻的快照——scripts/public/export.mjs 导出前自动跑一次并单独提交这个文件，
// 平时想手动刷新也可以直接跑：
//
//   node scripts/model-ratings-sync.mjs --src <库目录> [--check] [--out <文件>]
//
// 读这几份：
//   aa_data/aa_models.json   每个模型 × 推理档位一条（slug、智力指数 ii、官方 API 下的每任务美元成本 c.total、评测组成 ev……）
//   api_value_points.csv     图表上的官方 API 每任务成本（有就以它为准：含库里的计价修正）
//   plan_value_points.csv    订阅 plan 的每任务等效成本（只取 Anthropic 的 Pro / Max 5x / Max 20x：订阅会话里的 Claude 子 agent 走它）
//   aa_data/aa_models_full.json + aa_data/snapshots/aa_leaderboard_<日期>.json（最新一份）
//                            分项（键见 src/model-knowledge/ratings.mjs 的 SUB_KEYS）：全量库优先、排行榜补缺；都是库里现成的，不联网
// 汇率取库里 build_plan_chart.py 的 FX（与图表同一口径），读不到用 6.7154。
// 输出只留阶梯与模型档案要用的字段，不写库的路径与任何个人信息（公开版也带这份快照）。
//
// 指数版本：AA 换智力指数版本（2026-10-28 v4.3.2 → v5.0，评测组成整体换了）时只重算在榜模型和部分弃用模型，没重算的仍是旧分，
// 和新版不可比（同一个 Qwen3.8 Max：旧版 40.2、v5 33.6）。判法和库里 build_plan_chart.py 一样：现行版本 = 未弃用、非估算条目里
// 最常见的评测组成（ev），对不上的是旧分。旧分不剔除，带 old:true + ver 留在快照里——单项评测（分项）不随指数版本变，模型档案
// 还能参考；但 old 条目不进 families，阶梯、排名、中位数一律不看它们（src/model-knowledge/ratings.mjs 的 loadRatings）。
//
//   --check   只算不写：打印和现有快照的差别，有变化退出码 1

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// slug → 族名、short 名 → 档位：和导入性价比图（src/runtime/dispatch-chart.mjs）共用一套，放在知识层
import { baseOf, effortOf } from '../src/model-knowledge/ratings.mjs';

export { baseOf, effortOf };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DEFAULT = path.resolve(HERE, '..', 'src', 'config', 'model-ratings.json');

// Anthropic 订阅 plan 名 → 快照里的键
const PLAN_KEYS = { 'Claude Pro': 'pro', 'Claude Max 5x': 'max5', 'Claude Max 20x': 'max20' };
// 已知的智力指数版本：评测组成（ev，排好序、逗号连接）→ 版本名。认不出的记成「ev<项数>」
const INDEX_VERSIONS = [
  ['v5.0', 'aa-briefcase,automationbench-aa,critpt-v2-hard,frontiercode-2-0,gdp-pdf,hle-diamond,omniscience,terminal-bench-science,terminalbench-4-0'],
  ['v4.3.2', 'aa-briefcase,artificial-analysis-long-context-reasoning,automationbench-aa,critpt,gdp-pdf,gdpval-aa,humanitys-last-exam,omniscience,scicode,terminalbench-4-0'],
];
// 分项：快照键 → [全量库字段, 排行榜 scores 的键]（库里是 0–1 的比例，快照里存百分数一位小数）
const SUBS = {
  tb40: ['terminalBench40', 'terminalbench-4-0'],
  lcr: ['lcr', 'artificial-analysis-long-context-reasoning'],
  mlcr: ['mlcrOverall', 'mlcr-aa'],
  scicode: ['scicode', 'scicode'],
  hleD: ['hleDiamond', 'hle-diamond'],
  fc2: ['frontierCode20', 'frontiercode-2-0'],
  tau3: ['tauBanking', 'tau3-banking'],
  ifbench: ['ifbench', 'ifbench'],
  tau2: ['tau2', 'tau2-bench'],
  tbh: ['terminalbenchHard', 'terminalbench-hard'],
};

const evKey = (x) => (Array.isArray(x && x.ev) ? x.ev.slice().sort().join(',') : '');

/** 现行版本的评测组成：未弃用、非估算条目里最常见的那种（和 build_plan_chart.py 同一判法）。 */
export function currentEv(aa) {
  const n = new Map();
  for (const x of aa) if (x && !x.dep && !x.est) n.set(evKey(x), (n.get(evKey(x)) || 0) + 1);
  let best = '', most = -1;
  for (const [k, c] of n) if (c > most) { best = k; most = c; }
  return best;
}
export function versionName(ev) {
  const hit = INDEX_VERSIONS.find(([, e]) => e === ev);
  return hit ? hit[0] : ev ? `ev${ev.split(',').length}` : '';
}

const sig = (x, n = 3) => (x > 0 ? +x.toPrecision(n) : 0);
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 10 : null);

// 分项：全量库（每个模型 × 档位一个对象）优先，最新一份排行榜快照补缺；两份都没有 → 不带分项
function readSubs(src) {
  const full = new Map(), board = new Map();
  try {
    for (const a of JSON.parse(readFileSync(path.join(src, 'aa_data', 'aa_models_full.json'), 'utf8'))) if (a && a.slug) full.set(a.slug, a);
  } catch { /* 没有全量库：只靠排行榜 */ }
  try {
    const dir = path.join(src, 'aa_data', 'snapshots');
    const last = readdirSync(dir).filter((f) => /^aa_leaderboard_\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().pop();
    if (last) for (const a of JSON.parse(readFileSync(path.join(dir, last), 'utf8'))) if (a && a.slug) board.set(a.slug, a.scores || {});
  } catch { /* 没有排行榜快照 */ }
  return (slug) => {
    const out = {};
    const f = full.get(slug) || {}, b = board.get(slug) || {};
    for (const [k, [fk, bk]] of Object.entries(SUBS)) {
      const v = pct(f[fk]) ?? pct(b[bk]);
      if (v !== null) out[k] = v;
    }
    return Object.keys(out).length ? out : null;
  };
}

// 最小 CSV 解析（带引号字段、引号转义），够读库里的导出表
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.replace(/^﻿/, '').trim());
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** 库目录 → 快照对象（纯函数，单测直接喂目录）。 */
export function buildSnapshot(src, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const aa = JSON.parse(readFileSync(path.join(src, 'aa_data', 'aa_models.json'), 'utf8'));
  if (!Array.isArray(aa) || !aa.length) throw new Error('aa_models.json 不是非空数组');
  let fx = 6.7154;
  try {
    const m = /^FX\s*=\s*([\d.]+)/m.exec(readFileSync(path.join(src, 'build_plan_chart.py'), 'utf8'));
    if (m) fx = +m[1];
  } catch { /* 没有图表脚本：用默认汇率 */ }

  const valid = aa.filter((x) => x && typeof x.slug === 'string' && x.ii > 0);
  const slugs = valid.map((x) => x.slug);
  const evNow = currentEv(valid);
  const subsOf = readSubs(src);
  const models = [];
  const byShort = new Map();
  for (const x of valid) {
    const usd = x.c && typeof x.c.total === 'number' ? x.c.total : 0;
    const old = !x.est && evKey(x) !== evNow;   // 没按现行指数版本重算（估算值不算旧：它本来就按现行公式估）
    const subs = subsOf(x.slug);
    const e = {
      slug: x.slug, base: baseOf(x.slug, slugs), effort: effortOf(x.short || x.name), name: String(x.short || x.name || x.slug),
      creator: String(x.creator || ''), ii: +x.ii.toFixed(1), cost: sig(usd * fx), rel: String(x.rel || ''),
      ...(x.dep ? { dep: true } : {}), ...(x.est ? { est: true } : {}),
      ...(old ? { old: true, ver: versionName(evKey(x)) || 'old' } : {}),
      ...(subs ? { subs } : {}),
    };
    models.push(e);
    byShort.set(e.name, e.slug);
  }

  // 图表口径的官方 API 每任务成本（含库里对个别模型的计价修正，比 c.total × 汇率准）；分时段计价的取贵的那段
  const apiCsv = path.join(src, 'api_value_points.csv');
  if (existsSync(apiCsv)) {
    const api = new Map();
    for (const r of parseCsv(readFileSync(apiCsv, 'utf8'))) {
      const slug = byShort.get(String(r['AA模型(档位)'] || '').trim());
      const cost = parseFloat(r['每任务成本_官方API_元']);
      if (slug && cost > 0) api.set(slug, Math.max(api.get(slug) || 0, cost));
    }
    for (const e of models) if (api.has(e.slug)) e.cost = sig(api.get(e.slug));
  }

  const plans = {};
  const csv = path.join(src, 'plan_value_points.csv');
  if (existsSync(csv)) {
    for (const r of parseCsv(readFileSync(csv, 'utf8'))) {
      const key = PLAN_KEYS[String(r['Plan'] || '').trim()];
      const slug = byShort.get(String(r['AA模型(档位)'] || '').trim());
      const cost = parseFloat(r['每任务成本_中_元']);
      if (!key || !slug || !(cost > 0)) continue;
      (plans[key] ||= {})[slug] = sig(cost);
    }
  }
  // 现行版本在前、旧分在后，各自按分数排
  models.sort((a, b) => Number(!!a.old) - Number(!!b.old) || b.ii - a.ii || a.slug.localeCompare(b.slug));
  return {
    version: 2, generated: today, index: versionName(evNow), fx,
    source: 'Artificial Analysis 智力指数 + 官方 API / 订阅 plan 的每任务成本（服主自己维护的模型性价比库）',
    models, plans,
  };
}

/** 快照对象 → 落盘文本（一条一行，方便看 diff）。 */
export function snapshotText(snap) {
  return JSON.stringify(snap, null, 0).replace(/\},\{"slug"/g, '},\n{"slug"') + '\n';
}

// 两份快照按 slug 比：分数 / 成本 / 族 / 新旧有变的逐条列出
export function snapshotDiff(prev, snap) {
  const was = new Map((prev?.models || []).map((m) => [m.slug, m]));
  const out = [];
  for (const m of snap.models) {
    const p = was.get(m.slug);
    was.delete(m.slug);
    if (!p) { out.push(`  + ${m.slug} ${m.ii}${m.old ? `（旧分 ${m.ver}）` : ''}`); continue; }
    const d = [];
    if (p.ii !== m.ii) d.push(`ii ${p.ii}→${m.ii}`);
    if (p.cost !== m.cost) d.push(`¥${p.cost}→${m.cost}`);
    if (p.base !== m.base) d.push(`族 ${p.base}→${m.base}`);
    if (!!p.old !== !!m.old) d.push(m.old ? `标为旧分 ${m.ver}` : '不再是旧分');
    if (d.length) out.push(`  ~ ${m.slug} ${d.join('，')}`);
  }
  for (const s of was.keys()) out.push(`  - ${s}`);
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (k, d = '') => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const check = process.argv.includes('--check');
  const src = arg('src') || process.env.MODEL_RATINGS_DIR || '';
  if (!src) throw new Error('要 --src <模型性价比库目录>（或设 MODEL_RATINGS_DIR）');
  const out = path.resolve(arg('out', OUT_DEFAULT));
  const snap = buildSnapshot(path.resolve(src));
  let prev = null;
  try { prev = JSON.parse(readFileSync(out, 'utf8')); } catch { /* 第一次 */ }
  const oldN = snap.models.filter((m) => m.old).length;
  const what = `${snap.models.length} 条评分（现行 ${snap.index} ${snap.models.length - oldN} 条、旧分 ${oldN} 条）`;
  // 内容没变就不动文件（只有日期不同不算变）：发版时不必为同一份数据多一个提交
  const same = prev && JSON.stringify({ ...prev, generated: '' }) === JSON.stringify({ ...snap, generated: '' });
  if (same) { console.log(`[model-ratings] 没有变化（${prev.generated}，${what}）`); process.exit(0); }
  const text = snapshotText(snap);
  if (check) {
    const diff = snapshotDiff(prev, snap);
    console.log(`[model-ratings] --check：有变化，${what}，${(Buffer.byteLength(text) / 1024).toFixed(1)}KB（现有 ${prev ? prev.models.length : 0} 条）`);
    if (diff.length) console.log(diff.slice(0, 80).join('\n') + (diff.length > 80 ? `\n  … 另 ${diff.length - 80} 处` : ''));
    process.exit(1);
  }
  writeFileSync(out, text);
  const plansN = Object.values(snap.plans).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`[model-ratings] 已写 ${path.relative(process.cwd(), out)}：${what}、${plansN} 条订阅等效成本、汇率 ${snap.fx}`);
}
