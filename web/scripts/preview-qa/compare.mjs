#!/usr/bin/env node
// 改版前后对比：两份 run.mjs 的 report.json（或其所在目录）按「档 / 场景 id / 指标名」对齐。
//   node web/scripts/preview-qa/compare.mjs <基线 report.json 或目录> <新 report.json 或目录> [--out <对比.md>] [--all]
// 输出：每个两边都跑过的场景一行（结果、goal 达成、问题数、主指标 基线→新），再列出翻转了的断言、只在一边出现的场景。
// 缺省只列有变化的行；--all 全列。--out 不给时写到新报告目录下的 compare.md，并在控制台打印同样内容。
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib/paths.mjs';
import { scalars } from './lib/digest.mjs';

const a = parseArgs(process.argv.slice(2));
const [pa, pb] = a._;
if (!pa || !pb) { console.error('用法：compare.mjs <基线 report.json|目录> <新 report.json|目录> [--out x.md] [--all]'); process.exit(2); }
const load = (p) => {
  const f = existsSync(p) && statSync(p).isDirectory() ? path.join(p, 'report.json') : p;
  return { file: path.resolve(f), r: JSON.parse(readFileSync(f, 'utf8')) };
};
const A = load(pa), B = load(pb);

// 主指标：越小越好的耗时类 & 计数类；其余标量只在 --all 或变化时列
const LOWER_BETTER = /(Ms|Frames|longestFrame)(\.|$)|\.median$|\.max$/;
const fmt = (v) => (v == null ? '—' : typeof v === 'boolean' ? (v ? '是' : '否') : String(v));
const statusOf = (x) => (!x ? '—' : x.error ? '出错' : x.ok ? '通过' : '不过');
const goalsOf = (x) => { const g = (x?.asserts || []).filter((y) => y.level === 'goal'); return g.length ? `${g.filter((y) => y.ok).length}/${g.length}` : ''; };

const L = ['# 预览场景对比', '', `基线：\`${A.file}\`（${A.r.code?.frontend || ''}，${A.r.at}）`, `新版：\`${B.file}\`（${B.r.code?.frontend || ''}，${B.r.at}）`, ''];
if (B.r.code?.dirty?.length) L.push('新版工作区 web/src 未提交改动：' + B.r.code.dirty.length + ' 个文件', '');
L.push('| 档 | 场景 | 结果 | 目标 | 问题数 | 指标（基线 → 新） |', '|---|---|---|---|---|---|');
const flips = [], onlyA = [], onlyB = [];
let rows = 0, better = 0, worse = 0;
const profs = [...new Set([...Object.keys(A.r.results || {}), ...Object.keys(B.r.results || {})])];
for (const p of profs) {
  const ra = Object.fromEntries((A.r.results?.[p] || []).map((x) => [x.id, x]));
  const rb = Object.fromEntries((B.r.results?.[p] || []).map((x) => [x.id, x]));
  // 只在一边有的：整档缺就记一条「整档」，否则逐项列
  const oa = Object.keys(ra).filter((id) => !rb[id]), ob = Object.keys(rb).filter((id) => !ra[id]);
  if (oa.length) onlyA.push(!Object.keys(rb).length ? `${p}（整档 ${oa.length} 项）` : oa.map((id) => p + '/' + id).join('、'));
  if (ob.length) onlyB.push(!Object.keys(ra).length ? `${p}（整档 ${ob.length} 项）` : ob.map((id) => p + '/' + id).join('、'));
  for (const id of Object.keys(ra).filter((k) => rb[k])) {
    const x = ra[id], y = rb[id];
    const sa = scalars(x), sb = scalars(y);
    const parts = [];
    for (const k of [...new Set([...Object.keys(sa), ...Object.keys(sb)])]) {
      const va = sa[k], vb = sb[k];
      if (va === vb && !a.all) continue;
      if (/^quietBefore\./.test(k) && !a.all) continue;   // 量前等安静的内部数，不是产品指标
      let mark = '';
      const num = typeof va === 'number' && typeof vb === 'number';
      if (num && LOWER_BETTER.test(k)) {
        const d = vb - va, rel = va ? Math.abs(d) / va : 1;
        // 抖动阈值：差 < 15% 且 < 30ms 不算变化（计数类差 ≥ 3 也算）
        if (rel >= 0.15 && (Math.abs(d) >= 30 || (!/Ms(\.|$)/.test(k) && Math.abs(d) >= 3))) { mark = d < 0 ? ' ↓' : ' ↑'; d < 0 ? better++ : worse++; }
        else if (!a.all) continue;
      } else if (num && !a.all && Math.abs(vb - va) <= Math.max(Math.abs(va), Math.abs(vb)) * 0.15) continue;   // 其它数值：抖动不列
      parts.push(`${k} ${fmt(va)}→${fmt(vb)}${mark}`);
    }
    // 断言翻转
    const am = Object.fromEntries((x.asserts || []).map((q) => [q.name, q]));
    for (const q of y.asserts || []) { const o = am[q.name]; if (o && o.ok !== q.ok) flips.push(`${p}/${id}：${q.level === 'goal' ? '目标' : q.level === 'info' ? '记录' : '断言'}「${q.name}」${o.ok ? '过' : '不过'} → ${q.ok ? '过' : '不过'}（${fmt(typeof q.value === 'object' ? JSON.stringify(q.value)?.slice(0, 60) : q.value)}）`); }
    const changed = statusOf(x) !== statusOf(y) || goalsOf(x) !== goalsOf(y) || (x.issues || []).length !== (y.issues || []).length || parts.length;
    if (!changed && !a.all) continue;
    rows++;
    const st = statusOf(x) === statusOf(y) ? statusOf(y) : `${statusOf(x)} → **${statusOf(y)}**`;
    const gl = goalsOf(x) === goalsOf(y) ? goalsOf(y) : `${goalsOf(x)} → ${goalsOf(y)}`;
    const is = (x.issues || []).length === (y.issues || []).length ? String((y.issues || []).length || '') : `${(x.issues || []).length} → ${(y.issues || []).length}`;
    L.push(`| ${p} | ${id} | ${st} | ${gl} | ${is} | ${parts.join('；').replace(/\|/g, '/').slice(0, 400)} |`);
  }
}
if (!rows) L.push('| | （没有变化） | | | | |');
L.push('', `耗时 / 计数类指标：变好 ${better} 项（↓），变差 ${worse} 项（↑）；阈值：相对差 ≥15% 且绝对差 耗时 ≥30ms、计数 ≥3；--all 列出全部数值。`, '');
if (flips.length) L.push('## 翻转了的断言', '', ...flips.map((f) => '- ' + f), '');
if (onlyA.length) L.push('## 只在基线里有', '', onlyA.join('、'), '');
if (onlyB.length) L.push('## 只在新版里有', '', onlyB.join('、'), '');
const out = path.resolve(String(a.out || path.join(path.dirname(B.file), 'compare.md')));
writeFileSync(out, L.join('\n'));
console.log(L.join('\n'));
console.log('\n对比已写到：' + out);
