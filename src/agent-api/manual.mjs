// 项目手册：给运行中的 agent 查的 bridge 使用手册。
//
// 正文是 manual/<章>.md（中文 markdown，每章一个 # 标题、若干能独立看懂的 ## 小节）；
// 会变的东西不写死，用占位符在返回时现填——模型表与参数从 config/capabilities.mjs、版本从 versions.mjs、
// 接口参考从操作注册表（registry.mjs）。所以发版改模型、加操作都不用回来改手册；改了用户可见功能才要改对应章节。
//
// 占位符：{{version}} {{origin}} {{models}} {{studio.params}}（老名 vertex.params 同义）{{ops}} {{ops:<组>}} {{you}}
// 查法：目录（manualToc）、整章（manualChapter，topic 填操作名时回该操作的参数表）、按小节检索（manualSearch，关键词打分；
// 查询里带操作名的，该操作的参数表直接从注册表取来置顶）、单个操作（manualOp）。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION_NAME, APP_VERSION_CODE } from '../config/versions.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { AGENT_BY_ID } from '../config/agents.mjs';
import { allOps, allGroups, getOp, whyNot } from './registry.mjs';
import { pluginOn } from '../plugins/state.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manual');

// 章节顺序；不在表里的 .md 排在后面（按文件名）。
const ORDER = ['api', 'overview', 'claude', 'workspace', 'routines', 'studio', 'codex', 'dimensio', 'devices', 'phone', 'settings', 'plugins', 'accounts', 'recipes', 'missing'];

// 插件带来的章节目录（ctx.manual(dir) 登记，插件停用时撤掉）。章 id 撞了核心章节的，核心优先。
const extraDirs = new Map();   // dir → 插件 id
export function addManualDir(dir, owner = '') {
  const key = path.resolve(dir);
  extraDirs.set(key, owner);
  cache = { mtime: 0, chapters: [] };
  return () => { if (extraDirs.get(key) === owner) extraDirs.delete(key); cache = { mtime: 0, chapters: [] }; };
}
// 内置功能对应的章节：功能（插件）关着时目录里注明，免得 agent 照着手册去调一个不存在的接口。
const CHAPTER_PLUGIN = { routines: 'routines', devices: 'devices', phone: 'phone-control' };

let cache = { mtime: 0, chapters: [] };
function load() {
  let files = [];
  try { files = readdirSync(DIR).filter((f) => f.endsWith('.md')).map((f) => [DIR, f]); } catch { return []; }
  const core = new Set(files.map(([, f]) => f));
  for (const d of extraDirs.keys()) {
    try { for (const f of readdirSync(d)) if (f.endsWith('.md') && !core.has(f)) files.push([d, f]); } catch {}
  }
  let mtime = 0;
  for (const [d, f] of files) { try { mtime = Math.max(mtime, statSync(path.join(d, f)).mtimeMs); } catch {} }
  mtime += files.length;   // 删了 / 加了文件也算变
  if (mtime === cache.mtime) return cache.chapters;
  const rank = (id) => { const i = ORDER.indexOf(id); return i < 0 ? 1000 : i; };
  const chapters = files.map(([d, f]) => {
    const id = f.slice(0, -3);
    const raw = readFileSync(path.join(d, f), 'utf8').replace(/\r\n/g, '\n');
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
    lines.push(`- **Claude**：${names(c.claude.models)}。默认 \`${c.claude.defaults?.model || ''}\`（不传 model 就用它）。思考强度：${(c.claude.efforts || []).map((e) => `${e.name}（\`${e.id}\`）`).join('、')}。另外每个身份（主机管理员与成员各一份）都可能在「模型服务」里接了自己的自定义模型，id 形如 \`custom:<服务>:<模型>\`，用 \`chat.models\` 列出。`);
  }
  if (c.codex) lines.push(`- **ChatGPT 分页（Codex）**：${names(c.codex.models)}。`);
  // Media Studio 的内置模型（裸 id）；各人在 Studio 里接的服务与模型用 GET /api/studio/catalog 看
  if (c.image) lines.push(`- **图像**（Media Studio 内置）：${names(c.image.models)}。`);
  if (c.veo) lines.push(`- **视频**（Media Studio 内置）：${names(c.veo.models)}。`);
  if (c.tts) lines.push(`- **配音**（Media Studio 内置）：${names(c.tts.models)}；音色 ${(c.tts.voices || []).length} 种。`);
  if (c.music) lines.push(`- **音乐**（Media Studio 内置）：${names(c.music.models)}。`);
  return lines.join('\n') + '\n\n（模型对某个身份是否可用还要看服务器装没装对应扩展、管理员给没给他开；以 `whoami` 返回的 agents 为准。）';
}

const IMG_HINT = {
  'gemini-3-pro-image': '质量与细节最好，默认首选',
  'gemini-nano-banana-2.1': '画质与文字渲染好，支持思考 / 联网 / 图搜，独有超宽比例',
  'gemini-3.1-flash-image': '快，支持思考 + 联网 + 图搜；要真实世界的新事物时用',
  'gemini-3.1-flash-lite-image': '最省、只出 1K；图标与小装饰',
};
function studioParamsMd() {
  const c = CAPABILITIES;
  if (!c.image) return '（这台服务器的能力表里没有媒体模型。）';
  const capsOf = (id) => {
    const t = [];
    if (c.image.thinkSupport?.includes(id)) t.push('思考');
    if (c.image.searchSupport?.includes(id)) t.push('联网');
    if (c.image.imageSearchSupport?.includes(id)) t.push('图搜');
    return t.length ? '支持 ' + t.join(' / ') : '无高级项';
  };
  const list = (arr) => (arr || []).map((x) => (typeof x === 'object' ? (x.name || x.id) : x)).join(' / ');
  const out = [];
  out.push('**图像（`media.image`）**');
  for (const m of c.image.models) out.push(`- ${m.name}（\`${m.id}\`）：${IMG_HINT[m.id] ? IMG_HINT[m.id] + '；' : ''}${capsOf(m.id)}`);
  out.push(`- 比例：${list(c.image.aspects)}；尺寸：${list(c.image.sizes)}（按模型夹紧）；思考档：${list(c.image.thinkLevels)}。`);
  if (c.veo) {
    out.push('', '**视频（`media.video`，按秒计费）**');
    for (const m of c.veo.models) out.push(`- ${m.name}（\`${m.id}\`）：分辨率 ${(c.veo.resSupport?.[m.id] || ['720p']).join(' / ')}`);
    out.push(`- 比例：${list(c.veo.aspects)}；时长：${list(c.veo.durations)}；任务：${(c.veo.tasks || []).map((t) => `${t.name}（${t.id}）`).join('、')}。`);
  }
  if (c.tts) out.push('', `**语音（\`media.speech\`）**：模型 ${names(c.tts.models)}；音色：${(c.tts.voices || []).map((v) => `\`${v.id}\`（${String(v.name).split('·').pop().trim()}）`).join('、')}。`);
  if (c.music) out.push('', `**音乐（\`media.music\`）**：${(c.music.models || []).map((m) => `${m.name}（\`${m.id}\`）${m.desc ? '：' + m.desc : ''}`).join('；')}。`);
  return out.join('\n');
}

const ACCESS_MARK = { read: '', write: '（改动）', danger: '（⚠ 删除 / 花钱 / 不可撤回，先征得用户同意）' };
function paramLine(k, s) {
  const bits = [s.type + (s.required ? '，必填' : '')];
  if (s.enum) bits.push(s.enum.join(' | '));
  if (s.default !== undefined && s.default !== '') bits.push('默认 ' + JSON.stringify(s.default));
  return `  - \`${k}\`（${bits.join('；')}）${s.desc ? '：' + s.desc : ''}`;
}
// 一个操作的条目：标题行（权限标记、这个调用者能不能用）+ 说明、参数、返回、例；brief 只要标题行。
function opEntryMd(ctx, op, brief = false) {
  const why = ctx ? whyNot(ctx, op) : null;
  const out = [`- **\`${op.name}\`** — ${op.title}${ACCESS_MARK[op.access] || ''}${op.slow ? '（可能较慢）' : ''}${why ? `　〔你现在用不了：${why}〕` : ''}`];
  if (brief) return out.join('\n');
  if (op.desc) out.push('  ' + op.desc);
  const ps = Object.entries(op.params || {});
  if (ps.length) { out.push('  参数：'); for (const [k, s] of ps) out.push(paramLine(k, s)); }
  if (op.returns) out.push('  返回：' + op.returns);
  if (op.example) out.push('  例：`' + JSON.stringify(op.example) + '`');
  return out.join('\n');
}
function opsMd(ctx, group = null, { brief = false } = {}) {
  const groups = allGroups();
  const out = [];
  for (const g of groups) {
    if (group && g.id !== group) continue;
    const ops = allOps().filter((op) => op.group === g.id);
    if (!ops.length) continue;
    if (!group) out.push(`### ${g.title}（${g.id}）${g.desc ? '\n' + g.desc : ''}`);
    for (const op of ops) out.push(opEntryMd(ctx, op, brief));
    out.push('');
  }
  return out.join('\n').trim();
}
// 单个操作的参数表（检索里按操作名置顶、topic 填操作名都回它）；没有这个操作回 null。
export function manualOp(name, ctx) {
  const op = getOp(String(name || '').trim());
  if (!op) return null;
  const g = allGroups().find((x) => x.id === op.group);
  return `## 操作 \`${op.name}\`（${g ? g.title : op.group}）\n\n${opEntryMd(ctx, op)}${Object.keys(op.params || {}).length ? '' : '\n  参数：无'}`;
}
function youMd(ctx) {
  if (!ctx) return '（未登录：只能看手册。）';
  const agents = (ctx.agents || []).map((id) => AGENT_BY_ID[id]?.label || id).join('、') || '（没有）';
  const who = ctx.kind === 'admin' ? '服务器主机（管理员）' : `成员「${ctx.name || ctx.user}」（${ctx.shell ? '完全信任，有命令行' : '普通档，没有命令行'}）`;
  return `你现在的身份：${who}。对你开着的 agent：${agents}。`;
}

function render(raw, ctx, origin) {
  return raw.replace(/\{\{\s*([a-z.:_-]+)\s*\}\}/gi, (m, key) => {
    if (key === 'version') return `v${APP_VERSION_NAME}（versionCode ${APP_VERSION_CODE}）`;
    if (key === 'origin') return origin || '（服务器地址）';
    if (key === 'models') return modelsMd();
    if (key === 'studio.params' || key === 'vertex.params') return studioParamsMd();
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
    id: c.id, title: c.title,
    summary: (CHAPTER_PLUGIN[c.id] && !pluginOn(CHAPTER_PLUGIN[c.id]) ? '〔这台服务器关着这项功能（设置 › 扩展 › 功能扩展）〕' : '') + render(c.summary, ctx, origin),
    sections: [...c.raw.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim()),
  }));
}
export function manualChapter(id, ctx, origin) {
  const c = load().find((x) => x.id === id);
  if (c) return { id: c.id, title: c.title, markdown: render(c.raw, ctx, origin) };
  // 不是章 id 而是操作名（topic=routines.create）：回该操作的参数表。章 id 与操作名撞了（overview）章优先。
  const op = manualOp(id, ctx);
  return op ? { id, title: '操作 ' + id, markdown: op } : null;
}

const SECTION_MAX = 6000;
function sectionsOf(c, ctx, origin) {
  const md = render(c.raw, ctx, origin);
  const parts = md.split(/^(?=##\s)/m);
  const out = [];
  const push = (title, text) => out.push({ chapter: c.id, chapterTitle: c.title, title, text });
  for (const p of parts) {
    const m = /^##\s+(.+)$/m.exec(p);
    if (!m) continue;   // 章首（# 标题与摘要）
    const title = m[1].trim(), text = p.trim();
    // 超长的小节（api「全部操作」两万多字、plugins「改到核心」）按 ### 再切成「父标题 › 子标题」的小段，
    // 各自打分、不被截断；前言（第一个 ### 之前有正文的话）沿用父标题。没有 ### 的照旧整节，靠下面的截断兜底。
    const subs = text.length > SECTION_MAX ? text.split(/^(?=###\s)/m) : [];
    if (subs.length < 2) { push(title, text); continue; }
    const intro = subs.shift().trim();
    if (intro.replace(/^##\s+.+$/m, '').trim()) push(title, intro);
    for (const s of subs) {
      const sub = /^###\s+(.+)$/m.exec(s)[1].trim();
      push(`${title} › ${sub}`, `## ${title} › ${s.trim().replace(/^###\s+/, '')}`);
    }
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
  // 查询里带操作名（routines.create、ui.open；整句就是 whoami 这类单字名也算）：该操作的参数表直接从注册表取来置顶，
  // 不靠打分——操作名在手册里到处被提到，按关键词排上来的常是整组甚至别的章，参数表反而不在前头。
  const opNames = new Set(query.match(/[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+/g) || []);
  if (/^[a-z][a-z0-9_]*$/.test(query)) opNames.add(query);
  const apiTitle = load().find((c) => c.id === 'api')?.title || '接口';
  const pinned = [...opNames].filter((n) => getOp(n)).slice(0, limit)
    .map((n) => ({ chapter: 'api', chapterTitle: apiTitle, section: '操作 ' + n, score: 999, markdown: manualOp(n, ctx) }));
  let ranked = rank(terms);
  if (!ranked.length && terms.length === 1 && /[一-鿿]/.test(query) && query.length > 2) {
    // 整句没命中：拆成相邻两字片段再打分（「怎么改壁纸」→ 改壁 / 壁纸），丢掉虚词片段
    terms = [];
    for (let i = 0; i < query.length - 1; i++) { const b = query.slice(i, i + 2); if (!STOP_BIGRAMS.test(b)) terms.push(b); }
    if (terms.length) ranked = rank(terms);
  }
  ranked.sort((a, b) => b.n - a.n);
  return [...pinned, ...ranked.slice(0, Math.max(0, limit - pinned.length)).map(({ s, n }) => ({ chapter: s.chapter, chapterTitle: s.chapterTitle, section: s.title, score: Math.round(n * 10) / 10, markdown: s.text.length > SECTION_MAX ? s.text.slice(0, SECTION_MAX) + '\n…（本节太长，整章见 manual topic=' + s.chapter + '）' : s.text }))];
}

export function tocMarkdown(ctx, origin) {
  const toc = manualToc(ctx, origin);
  const lines = ['# bridge 项目手册', '', '给 agent 查的 bridge 使用手册：界面在哪、功能怎么用、接口怎么调。', ''];
  lines.push('查法：整章 `GET /agent/manual/<章 id>`；关键词检索 `GET /agent/manual?q=关键词`（返回最相关的几个小节；带操作名如 `q=routines.create` 时该操作的参数表排第一）；工具里用 `manual` 操作（topic / q）。', '');
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
