#!/usr/bin/env node
// 说明书问答测试：只给模型看 Muse 读的那两份东西（deploy/muse/MUSE.md + deploy/muse/guide/），让它回答一批
// 典型的用户问题，再逐条对照要点判分。发版前跑一次：说明书过时了、漏写了、写得让人误会，这里会先露出来。
//
//   node deploy/muse/test/guide-qa/run.mjs [--model sonnet] [--only id,id] [--out 报告.md] [--threshold 0.85]
//
// 用本机的 Claude Code 命令行（claude -p）跑，用的是你登录 Claude Code 的账号，不需要 API key。
// 默认用中档模型：Muse 自己用的不是最强的模型，中档模型只看说明书答得上来，Muse 才稳。想更严就 --model haiku。
// 一共三次调用（每次都把全部问题一起问，不是一题一次）：
//   ① 路由：只给 INDEX.md，看每个问题会去翻哪一章（跟题目里写的章节有交集就算对）
//   ② 回答：给 MUSE.md + 整份说明书，像在聊天里回复用户一样答
//   ③ 判分：对照每题的要点（facts，意思到了就算）和禁区（forbid，说了就算错）；加分要点（extra）
//      讲到更好、没讲到不算错——考的是说明书写得对不对、全不全，不是回答长不长
// 通过率低于 --threshold（默认 0.85）退出码为 1。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MUSE_DIR = path.resolve(HERE, '..', '..');
const GUIDE = path.join(MUSE_DIR, 'guide');

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const MODEL = opt('--model', 'sonnet');
const ONLY = (opt('--only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = opt('--out', path.join(os.tmpdir(), 'muse-guide-qa-report.md'));
const THRESHOLD = Number(opt('--threshold', '0.85'));

const guideFiles = readdirSync(GUIDE).filter((f) => f.endsWith('.md'))
  .sort((a, b) => (a === 'INDEX.md' ? -1 : b === 'INDEX.md' ? 1 : a.localeCompare(b)));
const doc = (name, text) => `<document path="${name}">\n${text.trim()}\n</document>`;
const guideBundle = [
  doc('MUSE.md', readFileSync(path.join(MUSE_DIR, 'MUSE.md'), 'utf8')),
  ...guideFiles.map((f) => doc(`guide/${f}`, readFileSync(path.join(GUIDE, f), 'utf8'))),
].join('\n\n');
const indexOnly = doc('guide/INDEX.md', readFileSync(path.join(GUIDE, 'INDEX.md'), 'utf8'));

let questions = JSON.parse(readFileSync(path.join(HERE, 'questions.json'), 'utf8')).questions;
if (ONLY.length) questions = questions.filter((q) => ONLY.includes(q.id));
if (!questions.length) { console.error('没有要测的题目'); process.exit(2); }
const qList = questions.map((q) => `- [${q.id}] ${q.q}`).join('\n');

// —— 调 claude -p：不给任何工具、不读 CLAUDE.md / 插件 / MCP，内容走标准输入（说明书有几十 KB，命令行放不下）——
function claude(prompt, schema, system) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--model', MODEL, '--system-prompt', system];
    const p = spawn('claude', args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('claude -p 超过 15 分钟没回来')); }, 15 * 60_000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`起不来 claude 命令行（装了 Claude Code 吗？）：${e.message}`)); });
    p.on('close', () => {
      clearTimeout(timer);
      let j;
      try { j = JSON.parse(out); } catch { return reject(new Error(`claude -p 的输出不是 JSON：${(err || out).slice(0, 400)}`)); }
      if (j.is_error || !j.structured_output) return reject(new Error(`claude -p 出错：${j.subtype || ''} ${String(j.result || '').slice(0, 400)}`));
      resolve({ data: j.structured_output, cost: j.total_cost_usd || 0 });
    });
    p.stdin.end(prompt);
  });
}

const arrOf = (props, req) => ({ type: 'array', items: { type: 'object', properties: props, required: req, additionalProperties: false } });
const obj = (key, items) => ({ type: 'object', properties: { [key]: items }, required: [key], additionalProperties: false });

const MUSE_SYSTEM = [
  '你是 Muse：用户的 AI 助手，在你自己的 VM 上替用户装好了 Muse Bridge（一个用浏览器打开的 Claude Code / dimensio 工作台），现在负责回答用户关于它的使用问题。',
  '你手里只有下面给你的文档（部署说明书 MUSE.md 和使用说明书 guide/）。只根据这些文档回答：文档没写的就直说没写、不要猜，也不要编造界面上没有的按钮或功能。',
  '回答像在聊天里回复用户：用提问者的语言，先给结论，再给具体做法（界面上叫什么、在哪里点）。需要你在 VM 上跑命令的，说明你会跑哪条命令；涉及密钥、令牌的，按文档里的安全做法来。',
].join('\n');

async function main() {
  let cost = 0;
  const t0 = Date.now();
  process.stderr.write(`模型 ${MODEL}，${questions.length} 道题。① 路由…\n`);
  const routing = await claude(
    `下面只有说明书的目录页 INDEX.md。对每个问题，说你会打开 guide/ 里的哪一个或几个文件来回答（只写文件名，比如 02-claude-code.md；该看 MUSE.md 的写 MUSE.md）。\n\n${indexOnly}\n\n问题：\n${qList}`,
    obj('routes', arrOf({ id: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, ['id', 'files'])),
    MUSE_SYSTEM);
  cost += routing.cost;

  process.stderr.write('② 回答…\n');
  const answering = await claude(
    `${guideBundle}\n\n用户陆续问了下面这些问题。每个问题单独回答（互相独立，不要引用别的回答）：\n${qList}`,
    obj('answers', arrOf({ id: { type: 'string' }, answer: { type: 'string' } }, ['id', 'answer'])),
    MUSE_SYSTEM);
  cost += answering.cost;
  const answers = Object.fromEntries(answering.data.answers.map((a) => [a.id, a.answer]));

  process.stderr.write('③ 判分…\n');
  const rubric = questions.map((q) => [
    `## [${q.id}] ${q.q}`,
    `必须讲到的要点（意思到了就算，措辞、语言不限）：\n${q.facts.map((f) => `- ${f}`).join('\n')}`,
    q.extra?.length ? `加分要点（讲到更好；没讲到不影响 pass）：\n${q.extra.map((f) => `- ${f}`).join('\n')}` : '',
    q.forbid?.length ? `不能出现的说法（出现任何一条就判错）：\n${q.forbid.map((f) => `- ${f}`).join('\n')}` : '',
    `回答：\n${answers[q.id] || '（没有回答）'}`,
  ].filter(Boolean).join('\n\n')).join('\n\n---\n\n');
  const judging = await claude(
    `逐题判分。pass = 每条「必须讲到的要点」都讲到了，而且没有出现任何禁区说法（加分要点不影响 pass）。事实要严格（菜单路径、命令、数字、能不能做到），措辞要宽松。missing 列出没讲到的必须要点原文，extra_missing 列出没讲到的加分要点原文，violations 列出踩到的禁区原文。\n\n${rubric}`,
    obj('results', arrOf({
      id: { type: 'string' }, pass: { type: 'boolean' },
      missing: { type: 'array', items: { type: 'string' } }, extra_missing: { type: 'array', items: { type: 'string' } },
      violations: { type: 'array', items: { type: 'string' } },
      note: { type: 'string' },
    }, ['id', 'pass', 'missing', 'extra_missing', 'violations', 'note'])),
    '你是严格但公正的阅卷人，只看回答有没有讲到要点、有没有踩禁区，不评文采。');
  cost += judging.cost;

  const routes = Object.fromEntries(routing.data.routes.map((r) => [r.id, r.files.map((f) => path.basename(f))]));
  const results = Object.fromEntries(judging.data.results.map((r) => [r.id, r]));
  const rows = questions.map((q) => {
    const want = q.chapters || [];
    const got = routes[q.id] || [];
    const routeOk = !want.length || want.some((c) => got.includes(c));
    const r = results[q.id] || { pass: false, missing: ['（判分里没有这一题）'], extra_missing: [], violations: [], note: '' };
    const extraMissed = Math.min(q.extra?.length || 0, (r.extra_missing || []).length);
    return { q, routeOk, got, r, extraMissed };
  });
  const passN = rows.filter((x) => x.r.pass).length;
  const routeN = rows.filter((x) => x.routeOk).length;
  const passRate = passN / rows.length;
  const routeRate = routeN / rows.length;
  const extraN = rows.reduce((n, x) => n + (x.q.extra?.length || 0), 0);
  const extraHit = extraN - rows.reduce((n, x) => n + x.extraMissed, 0);

  const md = [
    `# 说明书问答测试`,
    '',
    `模型 ${MODEL} · ${rows.length} 题 · 回答通过 ${passN}（${Math.round(passRate * 100)}%）· 路由正确 ${routeN}（${Math.round(routeRate * 100)}%）` +
      (extraN ? ` · 加分要点讲到 ${extraHit}/${extraN}` : '') + ` · 用时 ${Math.round((Date.now() - t0) / 1000)} 秒 · 约 $${cost.toFixed(2)}`,
    '',
    '| 题 | 回答 | 路由 | 说明 |',
    '|---|---|---|---|',
    ...rows.map((x) => `| ${x.q.id} | ${x.r.pass ? '✓' : '✗'} | ${x.routeOk ? '✓' : `✗（翻了 ${x.got.join(', ') || '无'}，应为 ${(x.q.chapters || []).join(' / ')}）`} | ${String(x.r.note || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
    ...rows.filter((x) => !x.r.pass).flatMap((x) => [
      `## ✗ ${x.q.id}：${x.q.q}`,
      x.r.missing.length ? `没讲到：\n${x.r.missing.map((m) => `- ${m}`).join('\n')}` : '',
      x.r.violations.length ? `踩了禁区：\n${x.r.violations.map((m) => `- ${m}`).join('\n')}` : '',
      `回答：\n\n> ${String(answers[x.q.id] || '（没有回答）').replace(/\n/g, '\n> ')}`,
      '',
    ]),
    ...(rows.some((x) => x.extraMissed) ? ['## 没讲到的加分要点', ...rows.filter((x) => x.extraMissed).flatMap((x) => x.r.extra_missing.map((m) => `- ${x.q.id}：${m}`))] : []),
  ].filter((l) => l !== '').join('\n');
  writeFileSync(OUT, md + '\n');
  console.log(md.split('\n').slice(0, 3).join('\n'));
  console.log(`完整报告：${OUT}`);
  for (const x of rows.filter((y) => !y.r.pass || !y.routeOk)) console.log(`  ✗ ${x.q.id}${x.r.pass ? '' : '（回答）'}${x.routeOk ? '' : '（路由）'}`);
  process.exitCode = passRate >= THRESHOLD && routeRate >= THRESHOLD ? 0 : 1;
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 2; });
