// 工作记录写成人话：时长、收起后那一行、合并的「查看了」、bridge 工具与 MCP、子智能体、审批后缀、
// 生成的媒体、自动审查、换号。只出字和小结构，不碰 DOM（组件照着画；有单测）。

import { t, isEn } from '../../i18n.js';

const sep = () => (isEn() ? ', ' : '，');

/* ---------------- 时长 ---------------- */

/** 1 分 12 秒 / 12 秒（不足 1 秒按 1 秒）。 */
export function fmtDur(ms) {
  const s = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return t('{n} 秒', { n: s });
  return t('{m} 分 {s} 秒', { m: Math.floor(s / 60), s: s % 60 });
}

/** 命令耗时：0.8s / 12.4s / 2m 5s（只有数字和单位，不走字典）。 */
export function fmtSecs(ms) {
  if (ms == null || ms === '') return '';
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 60_000) return (v / 1000).toFixed(1) + 's';
  const s = Math.round(v / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** 顶行在跑时的计时：0:12 / 1:05 / 1:02:03。 */
export function clock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** 恢复时刻（limit.until 可能是秒、毫秒或 ISO）→ 16:20；跨天带上日期。 */
export function fmtUntil(until, now = Date.now()) {
  if (until == null || until === '') return '';
  let ms = typeof until === 'number' ? until : Number(until);
  if (!Number.isFinite(ms)) ms = Date.parse(until);
  if (!Number.isFinite(ms)) return '';
  if (ms < 1e12) ms *= 1000;
  const d = new Date(ms), n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === n.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/* ---------------- 收起后的那一行 ---------------- */

/**
 * turnSummary(turn) 的结果 → 收起那一行：{ text, a, d }（a / d 有改动时才给，组件上色）。
 * 「工作了 1 分 12 秒 · 4 条命令 · 改了 3 个文件」；停了、出错时开头换成「已停止」「出错了」。
 */
export function summaryLine(status, sum) {
  const parts = [];
  const dur = sum.ms != null && sum.ms >= 0 ? fmtDur(sum.ms) : '';
  if (status === 'stopped') { parts.push(t('已停止')); if (dur) parts.push(t('用时 {d}', { d: dur })); }
  else if (status === 'error') { parts.push(t('出错了')); if (dur) parts.push(t('用时 {d}', { d: dur })); }
  else if (dur) parts.push(t('工作了 {d}', { d: dur }));
  if (sum.commands) parts.push(t('{n} 条命令', { n: sum.commands }));
  if (sum.files.length) parts.push(t('改了 {n} 个文件', { n: sum.files.length }));
  else if (!sum.commands && sum.explored) parts.push(t('查看了 {n} 个文件', { n: sum.explored }));
  if (!parts.length) parts.push(t('工作记录'));
  const changed = sum.files.length > 0 && (sum.a || sum.d);
  return { text: parts.join(' · '), a: changed ? sum.a : null, d: changed ? sum.d : null };
}

/* ---------------- 查看（读文件 / 列目录 / 搜代码合并成的一行） ---------------- */

export function exploreCounts(items) {
  const files = new Set();
  let searches = 0, lists = 0;
  for (const it of items || []) {
    if (it.type === 'read') files.add(it.path || it.name);
    else if (it.type === 'search') searches++;
    else if (it.type === 'list') lists++;
  }
  return { files: files.size, searches, lists };
}

/** 「3 个文件，1 次搜索」：同类合并时只有数字变，组件逐位滚它。 */
export function exploreText(items) {
  const c = exploreCounts(items);
  const parts = [];
  if (c.files) parts.push(t('{n} 个文件', { n: c.files }));
  if (c.searches) parts.push(t('{n} 次搜索', { n: c.searches }));
  if (c.lists) parts.push(t('{n} 个目录', { n: c.lists }));
  return parts.join(sep());
}

/* ---------------- 命令 ---------------- */

/** 批准过的命令后面那一小段。 */
export function approvalTag(a) {
  switch (a) {
    case 'once': return t('你允许了一次');
    case 'always': return t('这个对话里都允许了');
    case 'rule': return t('已按规则始终允许');
    case 'accept': return t('已允许');
    case 'deny': return t('你拒绝了');
    default: return '';
  }
}

/** 顶行「正在运行 npm test」只取命令的头两个词。 */
export const cmdHead = (cmd) => String(cmd || '').trim().split(/\s+/).slice(0, 2).join(' ');

/** 命令输出只留最后 max 行（展开的小窗口限高，太长的旧输出不进 DOM）。 */
export function outLines(out, max = 300) {
  const s = String(out || '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (!s) return { lines: [], cut: 0 };
  const all = s.split('\n');
  return all.length > max ? { lines: all.slice(-max), cut: all.length - max } : { lines: all, cut: 0 };
}

/* ---------------- bridge 工具 / MCP ---------------- */

const clip = (s, n = 80) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n) + '…' : v;
};
const shortUrl = (u) => clip(String(u || '').replace(/^https?:\/\//i, '').replace(/\/$/, ''), 60);

/** bridge 的命名空间去掉前缀：bridge_browser → browser；bridge（call / manual）→ bridge。 */
export const nsKey = (ns) => String(ns || '').replace(/^bridge(?:[_-]|$)/i, '') || (/^bridge$/i.test(String(ns || '')) ? 'bridge' : '');
const isBridge = (ns) => /^bridge(?:[_-]|$)/i.test(String(ns || ''));

const MEDIA_TOOL = { generate_image: 'image', generate_video: 'video', generate_speech: 'audio', generate_music: 'music' };
export const mediaKindOf = (row) => (row?.kind === 'tool' && /media/i.test(nsKey(row.ns)) ? MEDIA_TOOL[row.tool] || null : null);
export const isWidgetRow = (row) => row?.kind === 'tool' && /visualize/i.test(nsKey(row.ns)) && /show_widget$/.test(row.tool || '') && typeof row.args?.widget_code === 'string';

function mediaVerb(kind, n, running) {
  if (running) {
    return kind === 'image' ? t('正在生成图片') : kind === 'video' ? t('正在生成视频') : kind === 'audio' ? t('正在生成语音') : t('正在生成音乐');
  }
  return kind === 'image' ? t('生成了 {n} 张图', { n })
    : kind === 'video' ? t('生成了 {n} 段视频', { n })
      : kind === 'audio' ? t('生成了 {n} 段语音', { n })
        : t('生成了 {n} 段音乐', { n });
}

function browserObj(a, tool) {
  const act = String(a.action || a.op || (tool !== 'browser' ? tool : '') || '').toLowerCase();
  const url = a.url || a.href || '';
  if (url && (!act || /nav|open|goto|go_to|new_tab|tab/.test(act))) return { obj: shortUrl(url), pre: t('打开了') };
  if (/screenshot|shot|capture/.test(act)) return { obj: '', pre: t('截了一张图') };
  if (/click|tap|press/.test(act)) return { obj: clip(a.selector || a.ref || a.text || a.element || '', 40), pre: t('点了') };
  if (/type|fill|input|key/.test(act)) return { obj: '', pre: t('输入了文字') };
  if (/snapshot|read|text|content|extract|find/.test(act)) return { obj: '', pre: t('读了页面') };
  if (/scroll/.test(act)) return { obj: '', pre: t('滚动了页面') };
  if (url) return { obj: shortUrl(url), pre: act };
  return { obj: act, pre: '' };
}

/**
 * tool / mcp 行 → { ico, verb, pre, obj, mono, link }：
 *   pre 是宾语前面的淡字（「打开」），link 是行尾那个跳到工作区卡片的小键（{ label, view }）。
 * 认不出的命名空间照原名写「调用了 ns.tool」。
 */
export function toolView(row) {
  const ns = row.kind === 'mcp' ? row.server : row.ns;
  const tool = String(row.tool || '');
  const a = row.args && typeof row.args === 'object' ? row.args : {};
  const running = row.status === 'run';
  const key = isBridge(ns) ? nsKey(ns).toLowerCase() : '';
  const v = { ico: 'bolt', verb: '', pre: '', obj: '', mono: false, link: null };
  switch (key) {
    case 'browser': {
      const b = browserObj(a, tool);
      Object.assign(v, { ico: 'globe', verb: t('用了浏览器'), pre: b.pre, obj: b.obj, link: { label: t('在工作区看'), view: 'browser' } });
      if (row.images) v.post = t('截了 {n} 张图', { n: row.images });
      return v;
    }
    case 'terminal':
      return Object.assign(v, { ico: 'term', verb: t('用了终端'), obj: clip(a.command || a.input || a.text || a.keys || a.action || tool, 80), mono: !!(a.command || a.input || a.text), link: { label: t('在终端里看'), view: 'term' } });
    case 'workspace':
      return Object.assign(v, { ico: 'panel', verb: t('看了你的工作区'), obj: clip(a.action || a.view || (tool !== 'workspace' ? tool : ''), 40) });
    case 'device':
    case 'local_pc':
      if (/^(devices|status)$/.test(tool)) return Object.assign(v, { ico: 'laptop', verb: t('查看了在线的电脑') });
      return Object.assign(v, { ico: 'laptop', verb: t('操作了你的电脑'), obj: clip(a.action || a.command || tool, 60), mono: !!a.command });
    case 'phone':
      return Object.assign(v, { ico: 'folder', verb: t('用了手机里的文件'), obj: clip(a.path || a.folder || tool, 60), mono: !!(a.path || a.folder) });
    case 'phonecontrol':
      return Object.assign(v, { ico: 'laptop', verb: t('操作了你的手机'), obj: clip(a.app || a.text || a.url || tool.replace(/^phone_/, ''), 50) });
    case 'pr':
      return Object.assign(v, { ico: 'pr', verb: t('处理了拉取请求'), obj: clip(a.title || a.number || tool, 60) });
    case 'sessions':
      return Object.assign(v, { ico: 'msg', verb: t('联系了别的会话'), obj: clip(a.title || a.name || a.session || tool, 60) });
    case 'project':
      return Object.assign(v, { ico: 'folder', verb: t('查看了项目'), obj: clip(a.name || a.path || tool, 60) });
    case 'plugins':
      return Object.assign(v, { ico: 'slash', verb: t('用了插件'), obj: clip(a.name || a.plugin || tool, 60) });
    case 'media': {
      const kind = MEDIA_TOOL[tool];
      if (!kind) return Object.assign(v, { ico: 'image', verb: t('查看了媒体模型') });
      return Object.assign(v, { ico: 'image', verb: mediaVerb(kind, Math.max(1, mediaCount(row)), running), pre: '', obj: clip(a.prompt || a.text || '', 60) });
    }
    case 'visualize':
      if (/show_widget$/.test(tool)) return Object.assign(v, { ico: 'chart', verb: running ? t('正在画图表') : t('画了一张图表'), obj: clip(a.title || '', 60) });
      return Object.assign(v, { ico: 'chart', verb: t('读了作图说明') });
    case 'bridge':
      if (tool === 'manual') return Object.assign(v, { ico: 'bridge', verb: t('查了 bridge 手册'), obj: clip(a.topic || a.name || '', 40) });
      return Object.assign(v, { ico: 'bridge', verb: t('用了 bridge'), obj: clip(a.op || a.name || tool, 60), mono: true });
    default:
      return Object.assign(v, { ico: 'bolt', verb: t('调用了'), obj: [ns, tool].filter(Boolean).join('.'), mono: true });
  }
}

/* ---------------- 生成的媒体 ---------------- */

// 媒体库的文件名就是作品 id（uuid.扩展名），Claude 页的 ChatMediaImage / Video / Audio 按 id 取图
const MEDIA_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{2,5})\b/gi;

/** 回执文字里的作品（一次可能出多件），顺序照出现顺序、去重。形状同 Claude 页的媒体段。 */
export function mediaFromText(kind, text, prompt = '') {
  const seen = new Set(), out = [];
  for (const [, id, ext] of String(text || '').matchAll(MEDIA_ID_RE)) {
    const k = id.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: 'media', id, mediaKind: kind, status: 'ready', elapsed: 0, error: null, prompt: String(prompt || ''), dataUrl: null, ext: ext.toLowerCase() });
  }
  return out;
}

export function mediaCount(row) {
  const kind = mediaKindOf(row);
  return kind ? mediaFromText(kind, row.text).length : 0;
}

/* ---------------- 子智能体 ---------------- */

export function agentVerb(tool) {
  const k = String(tool || '').replace(/[_-]/g, '').toLowerCase();
  if (k === 'sendinput' || k === 'send') return t('给子智能体发了话');
  if (k === 'wait') return t('等子智能体回报');
  if (k === 'closeagent' || k === 'close') return t('收回了子智能体');
  if (k === 'resumeagent' || k === 'resume') return t('叫回了子智能体');
  return t('派出子智能体');
}

/* ---------------- 自动审查 ---------------- */

/** approval-review 事件的 review（Codex 原样参数，字段名不稳）→ { verdict:'allow'|'deny'|'', reason }。 */
export function reviewOf(review) {
  const r = review && typeof review === 'object' ? review : {};
  const inner = r.review && typeof r.review === 'object' ? r.review : r;
  const raw = String(inner.decision ?? inner.outcome ?? inner.status ?? inner.verdict ?? r.decision ?? r.status ?? '').toLowerCase();
  const verdict = /deny|denied|block|reject|declin/.test(raw) ? 'deny' : /approv|allow|accept|pass/.test(raw) ? 'allow' : '';
  const reason = String(inner.rationale ?? inner.reason ?? inner.explanation ?? inner.summary ?? r.rationale ?? r.reason ?? '').trim();
  return { verdict, reason };
}

/* ---------------- 换号 ---------------- */

/** 额度用完时能换到哪个号：没停用、登录好了、不在冷却、不是刚撞线的那个。先按号池里的顺序。 */
export function pickAccount(pool, fromId, now = Date.now()) {
  const list = Array.isArray(pool?.accounts) ? pool.accounts : [];
  return list.find((a) => a && a.id && a.id !== fromId && a.id !== 'hub' && !a.disabled && !a.pending && a.loggedIn !== false
    && !(a.cooling && (!a.cooling.until || toMs(a.cooling.until) > now))) || null;
}

const toMs = (v) => {
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0;
};

/** 一段原文的第一行（提醒里只露一行，其余在「查看原文」里）。 */
export function firstLine(s, n = 160) {
  const line = String(s || '').trim().split(/\r?\n/)[0] || '';
  return line.length > n ? line.slice(0, n) + '…' : line;
}

export const isMultiline = (s, n = 160) => { const v = String(s || '').trim(); return v.includes('\n') || v.length > n; };

/** 带占位的译文拆成段（占位那几段组件加粗）：fillParts('{from} 暂不可用', { from:'X' }) → [{ text:'X', key:'from' }, { text:' 暂不可用' }]。 */
export function fillParts(tpl, vals = {}) {
  const out = [];
  for (const part of String(tpl || '').split(/(\{\w+\})/)) {
    if (!part) continue;
    const m = /^\{(\w+)\}$/.exec(part);
    if (m && vals[m[1]] != null) out.push({ text: String(vals[m[1]]), key: m[1] });
    else out.push({ text: part });
  }
  return out;
}

/** 文件大小：12 KB / 3.4 MB（单位不走字典）。 */
export function fmtSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return Math.round(v / 1024) + ' KB';
  return (v / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
}

// 回执里认不出作品 id 时（工具把文件写到了 outputPath 之类），退一步找绝对路径的媒体文件，走 Codex 产物接口取
const MEDIA_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s"'<>|*?]+?\.(?:png|jpe?g|webp|gif|bmp|avif|mp4|webm|mov|m4v|wav|mp3|m4a|ogg|flac|aac)\b/gi;
export function mediaPaths(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MEDIA_PATH_RE)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}
