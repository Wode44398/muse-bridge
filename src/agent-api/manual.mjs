// 项目手册：给运行中的 agent 查的 Muse Bridge 使用手册。
//
// 正文是 manual/<章>.md（中文 markdown，每章一个 # 标题、若干能独立看懂的 ## 小节）；
// 会变的东西不写死，用占位符在返回时现填——模型表从 config/capabilities.mjs、版本从 deploy/muse/VERSION
// （feedback/report.mjs 的 programVersion）、接口参考从操作注册表（registry.mjs）。所以发版改模型、加操作都不用
// 回来改手册；改了用户可见功能才要改对应章节（同时改 deploy/muse/guide/ 里给 Muse 看的使用说明书）。
//
// 占位符：{{version}} {{origin}} {{models}} {{ops}} {{ops.brief}} {{ops:<组>}} {{you}}
// 查法：目录（manualToc）、整章（manualChapter）、按小节检索（manualSearch，关键词打分）。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { programVersion } from '../feedback/report.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { AGENT_BY_ID } from '../config/agents.mjs';
import { allOps, allGroups, whyNot } from './registry.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manual');

// 章节顺序；不在表里的 .md 排在后面（按文件名）。
const ORDER = ['api', 'overview', 'claude', 'workspace', 'routines', 'dimensio', 'settings', 'accounts', 'recipes', 'missing'];

let cache = { mtime: 0, chapters: [] };
function load() {
  let files = [];
  try { files = readdirSync(DIR).filter((f) => f.endsWith('.md')); } catch { return []; }
  let mtime = 0;
  for (const f of files) { try { mtime = Math.max(mtime, statSync(path.join(DIR, f)).mtimeMs); } catch {} }
  mtime += files.length;   // 删了 / 加了文件也算变
  if (mtime === cache.mtime) return cache.chapters;
  const rank = (id) => { const i = ORDER.indexOf(id); return i < 0 ? 1000 : i; };
  const chapters = files.map((f) => {
    const id = f.slice(0, -3);
    const raw = readFileSync(path.join(DIR, f), 'utf8').replace(/\r\n/g, '\n');
    const title = (/^#\s+(.+)$/m.exec(raw) || [, id])[1].trim();
    // 摘要 = 标题后第一段正文
    const afterTitle = raw.replace(/^[\s\S]*?^#\s+.+$/m, '');
    const summary = (afterTitle.split(/\n\s*\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#')) || '').replace(/\s+/g, ' ').slice(0, 200);
    return { id, title, summary, raw };
  }).sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  cache = { mtime, chapters };
  return chapters;
}

// ---- 占位符 ----
const names = (arr) => (arr || []).map((m) => `${m.name}（\`${m.id}\`）`).join('、');
function modelsMd() {
  const c = CAPABILITIES;
  const lines = [];
  if (c.claude) {
    lines.push(`- **Claude Code**：${names(c.claude.models)}。默认 \`${c.claude.defaults?.model || ''}\`（不传 model 就用它）。思考强度：${(c.claude.efforts || []).map((e) => `${e.name}（\`${e.id}\`）`).join('、')}。管理员还可能在「模型服务」里接了自定义模型，id 形如 \`custom:<服务>:<模型>\`。`);
  }
  lines.push('- **dimensio**：模型由用户自己配的各家 API key 决定（Anthropic、OpenAI、Gemini、DeepSeek、Kimi、智谱、通义、小米 MiMo 或任何 OpenAI 兼容服务），在 dimensio 页的模型胶囊里选；这套接口不驱动 dimensio。');
  return lines.join('\n') + '\n\n（某个 agent 对这个身份是否可用，要看服务器装没装、管理员开没开、给没给他勾；以 `whoami` 返回的 agents 为准。）';
}

const ACCESS_MARK = { read: '', write: '（改动）', danger: '（⚠ 删除 / 花钱 / 不可撤回，先征得用户同意）' };
function paramLine(k, s) {
  const bits = [s.type + (s.required ? '，必填' : '')];
  if (s.enum) bits.push(s.enum.join(' | '));
  if (s.default !== undefined && s.default !== '') bits.push('默认 ' + JSON.stringify(s.default));
  return `  - \`${k}\`（${bits.join('；')}）${s.desc ? '：' + s.desc : ''}`;
}
function opsMd(ctx, group = null, { brief = false } = {}) {
  const groups = allGroups();
  const out = [];
  for (const g of groups) {
    if (group && g.id !== group) continue;
    const ops = allOps().filter((op) => op.group === g.id);
    if (!ops.length) continue;
    if (!group) out.push(`### ${g.title}（${g.id}）${g.desc ? '\n' + g.desc : ''}`);
    for (const op of ops) {
      const why = ctx ? whyNot(ctx, op) : null;
      const head = `- **\`${op.name}\`** — ${op.title}${ACCESS_MARK[op.access] || ''}${op.slow ? '（可能较慢）' : ''}${why ? `　〔你现在用不了：${why}〕` : ''}`;
      if (brief) { out.push(head); continue; }
      out.push(head);
      if (op.desc) out.push('  ' + op.desc);
      const ps = Object.entries(op.params || {});
      if (ps.length) { out.push('  参数：'); for (const [k, s] of ps) out.push(paramLine(k, s)); }
      if (op.returns) out.push('  返回：' + op.returns);
      if (op.example) out.push('  例：`' + JSON.stringify(op.example) + '`');
    }
    out.push('');
  }
  return out.join('\n').trim();
}
function youMd(ctx) {
  if (!ctx) return '（未登录：只能看手册。）';
  const agents = (ctx.agents || []).map((id) => AGENT_BY_ID[id]?.label || id).join('、') || '（没有）';
  const who = ctx.kind === 'admin' ? '服务器主机（管理员）' : `成员「${ctx.name || ctx.user}」（${ctx.shell ? '完全信任，有命令行' : '普通档，没有命令行'}）`;
  return `你现在的身份：${who}。对你开着的 agent：${agents}。`;
}

function render(raw, ctx, origin) {
  return raw.replace(/\{\{\s*([a-z.:_-]+)\s*\}\}/gi, (m, key) => {
    if (key === 'version') { const v = programVersion(); return v === 'dev' ? '开发版（源码直跑）' : v; }
    if (key === 'origin') return origin || '（服务器地址）';
    if (key === 'models') return modelsMd();
    if (key === 'ops') return opsMd(ctx);
    if (key === 'ops.brief') return opsMd(ctx, null, { brief: true });
    if (key.startsWith('ops:')) return opsMd(ctx, key.slice(4));
    if (key === 'you') return youMd(ctx);
    return m;
  });
}

// ---- 对外 ----
export function manualToc(ctx, origin) {
  return load().map((c) => ({
    id: c.id, title: c.title, summary: render(c.summary, ctx, origin),
    sections: [...c.raw.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()),
  }));
}
export function manualChapter(id, ctx, origin) {
  const c = load().find((x) => x.id === id);
  return c ? { id: c.id, title: c.title, markdown: render(c.raw, ctx, origin) } : null;
}

function sectionsOf(c, ctx, origin) {
  const md = render(c.raw, ctx, origin);
  const parts = md.split(/^(?=##\s)/m);
  const out = [];
  for (const p of parts) {
    const m = /^##\s+(.+)$/m.exec(p);
    if (!m) continue;   // 章首（# 标题与摘要）
    out.push({ chapter: c.id, chapterTitle: c.title, title: m[1].trim(), text: p.trim() });
  }
  return out;
}
// 两字片段里的虚词（怎么、什么、能不能、帮我……）：拆句检索时不算词。
const STOP_BIGRAMS = /^(?:.?[怎么什哪吗呢吧啊的了是我你他她它这那个能不可以如何一下帮请有没要给把在去到用让]{2})$/;
// 关键词检索：按空白切词（中文没有空格时整句当一个词，再退一步拆成两字片段），标题命中权重高。
export function manualSearch(q, ctx, origin, { limit = 5 } = {}) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  let terms = query.split(/\s+/).filter(Boolean);
  const all = load().flatMap((c) => sectionsOf(c, ctx, origin)).map((s) => ({ ...s, lt: s.title.toLowerCase(), lx: s.text.toLowerCase(), lc: s.chapterTitle.toLowerCase() }));
  // 稀有词更重（逆文档频率）：「定时任务 频率」里「频率」比满手册都是的「定时任务」更能定位
  const idf = (t) => { const df = all.filter((s) => s.lx.includes(t)).length; return Math.log(1 + all.length / (1 + df)); };
  const score = (s, ts, w) => {
    let n = 0, hit = 0;
    ts.forEach((t, i) => {
      const inTitle = s.lt.includes(t) || s.lc.includes(t);
      const cnt = Math.min(s.lx.split(t).length - 1, 8);
      if (inTitle || cnt) hit++;
      n += w[i] * ((inTitle ? 6 : 0) + cnt);
    });
    return hit ? n * (hit / ts.length) ** 2 : 0;
  };
  const rank = (ts) => { const w = ts.map(idf); return all.map((s) => ({ s, n: score(s, ts, w) })).filter((x) => x.n > 0); };
  let ranked = rank(terms);
  if (!ranked.length && terms.length === 1 && /[一-鿿]/.test(query) && query.length > 2) {
    // 整句没命中：拆成相邻两字片段再打分（「怎么改主题」→ 改主 / 主题），丢掉虚词片段
    terms = [];
    for (let i = 0; i < query.length - 1; i++) { const b = query.slice(i, i + 2); if (!STOP_BIGRAMS.test(b)) terms.push(b); }
    if (terms.length) ranked = rank(terms);
  }
  ranked.sort((a, b) => b.n - a.n);
  return ranked.slice(0, limit).map(({ s, n }) => ({ chapter: s.chapter, chapterTitle: s.chapterTitle, section: s.title, score: Math.round(n * 10) / 10, markdown: s.text.length > 6000 ? s.text.slice(0, 6000) + '\n…（本节太长，整章见 manual topic=' + s.chapter + '）' : s.text }));
}

export function tocMarkdown(ctx, origin) {
  const toc = manualToc(ctx, origin);
  const lines = ['# Muse Bridge 项目手册', '', '给 agent 查的 Muse Bridge 使用手册：界面在哪、功能怎么用、接口怎么调。', ''];
  lines.push('查法：整章 `GET /agent/manual/<章 id>`；关键词检索 `GET /agent/manual?q=关键词`（返回最相关的几个小节）；工具里用 `manual` 操作（topic / q）。', '');
  for (const c of toc) {
    lines.push(`## ${c.title}（\`${c.id}\`）`, c.summary, '');
    if (c.sections.length) lines.push('小节：' + c.sections.join(' · '), '');
  }
  return lines.join('\n');
}
export function searchMarkdown(q, results) {
  if (!results.length) return `# 检索「${q}」\n\n没有命中。换个说法，或看目录 GET /agent/manual。`;
  return [`# 检索「${q}」`, '', ...results.map((r) => `> 来自 ${r.chapterTitle}（${r.chapter}）\n\n${r.markdown}\n`)].join('\n');
}
