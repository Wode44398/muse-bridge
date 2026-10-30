// 模型性价比快照：把服主自己维护的「模型性价比图谱」库压成 src/config/model-ratings.json，给子 agent 调度阶梯用
//（src/runtime/model-ratings.mjs）。库在本机另一个目录、随时在改；bridge 只认发版那一刻的快照——
// scripts/public/export.mjs 导出前自动跑一次并单独提交这个文件，平时想手动刷新也可以直接跑：
//
//   node scripts/model-ratings-sync.mjs --src <库目录>
//
// 读三份：
//   aa_data/aa_models.json   每个模型 × 推理档位一条（slug、智力指数 ii、官方 API 下的每任务美元成本 c.total……）
//   api_value_points.csv     图表上的官方 API 每任务成本（有就以它为准：含库里的计价修正）
//   plan_value_points.csv    订阅 plan 的每任务等效成本（只取 Anthropic 的 Pro / Max 5x / Max 20x：订阅会话里的 Claude 子 agent 走它）
// 汇率取库里 build_plan_chart.py 的 FX（与图表同一口径），读不到用 6.7154。
// 输出只留阶梯要用的字段（约 30KB），不写库的路径与任何个人信息（公开版也带这份快照）。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DEFAULT = path.resolve(HERE, '..', 'src', 'config', 'model-ratings.json');

// slug 末尾的档位后缀 → 同一个模型（family）的 base
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max|non-reasoning|reasoning|adaptive|thinking)$/;
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Anthropic 订阅 plan 名 → 快照里的键
const PLAN_KEYS = { 'Claude Pro': 'pro', 'Claude Max 5x': 'max5', 'Claude Max 20x': 'max20' };

/** short 名括号里的档位：「(max with fallback)」→ max；「(non-reasoning)」→ off；没有括号 / 认不出 → ''（模型默认档）。 */
export function effortOf(short) {
  const m = /\(([^)]*)\)\s*$/.exec(String(short || ''));
  if (!m) return '';
  const t = m[1].trim().toLowerCase();
  if (/^non-reasoning\b/.test(t)) return 'off';
  const w = t.split(/[\s,]+/)[0];
  return LEVELS.includes(w) ? w : '';
}

export function baseOf(slug) {
  let s = String(slug || '').toLowerCase();
  while (EFFORT_SUFFIX.test(s)) s = s.replace(EFFORT_SUFFIX, '');
  return s;
}

const sig = (x, n = 3) => (x > 0 ? +x.toPrecision(n) : 0);

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

  const models = [];
  const byShort = new Map();
  for (const x of aa) {
    if (!x || typeof x.slug !== 'string' || !(x.ii > 0)) continue;
    const usd = x.c && typeof x.c.total === 'number' ? x.c.total : 0;
    const e = {
      slug: x.slug, base: baseOf(x.slug), effort: effortOf(x.short || x.name), name: String(x.short || x.name || x.slug),
      creator: String(x.creator || ''), ii: +x.ii.toFixed(1), cost: sig(usd * fx), rel: String(x.rel || ''),
      ...(x.dep ? { dep: true } : {}), ...(x.est ? { est: true } : {}),
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
  models.sort((a, b) => b.ii - a.ii || a.slug.localeCompare(b.slug));
  return {
    version: 1, generated: today, fx,
    source: 'Artificial Analysis 智力指数 + 官方 API / 订阅 plan 的每任务成本（服主自己维护的模型性价比库）',
    models, plans,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (k, d = '') => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const src = arg('src') || process.env.MODEL_RATINGS_DIR || '';
  if (!src) throw new Error('要 --src <模型性价比库目录>（或设 MODEL_RATINGS_DIR）');
  const out = path.resolve(arg('out', OUT_DEFAULT));
  const snap = buildSnapshot(path.resolve(src));
  let prev = null;
  try { prev = JSON.parse(readFileSync(out, 'utf8')); } catch { /* 第一次 */ }
  // 内容没变就不动文件（只有日期不同不算变）：发版时不必为同一份数据多一个提交
  const same = prev && JSON.stringify({ ...prev, generated: '' }) === JSON.stringify({ ...snap, generated: '' });
  if (same) { console.log(`[model-ratings] 没有变化（${prev.generated}，${snap.models.length} 条）`); process.exit(0); }
  writeFileSync(out, JSON.stringify(snap, null, 0).replace(/\},\{/g, '},\n{') + '\n');
  const plansN = Object.values(snap.plans).reduce((n, p) => n + Object.keys(p).length, 0);
  console.log(`[model-ratings] 已写 ${path.relative(process.cwd(), out)}：${snap.models.length} 条评分、${plansN} 条订阅等效成本、汇率 ${snap.fx}`);
}
