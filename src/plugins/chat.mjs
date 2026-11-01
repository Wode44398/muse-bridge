// 插件的「以某个身份做事」服务：ctx.chat（跑一轮 Claude）、ctx.sandbox（插件自管的隔离工作区）、
// ctx.files（读写身份的工作区）、ctx.share（公开只读分享 / 快照对话页）。
//
// 身份 as（所有接口同一套写法）：
//   · 账号：管理员在插件设置里用 { type:'user', grant:'chat' } 字段选过的登录名，或 '@host'（选中即授权；pro 档 / 主机本人设置页要二次确认）。
//   · 沙箱：ctx.sandbox(key) 返回的句柄，或简写 { sandbox: key }。每个 key 一个独立工作区 <插件数据目录>/sandboxes/<key>/，
//     无命令行、只能读写自己的目录、碰不到主机文件和别的 key；不用建账号、不用开多用户（与聊天快照同一套沙箱身份 kind:'snap'）。
//     沙箱不记任何账号的额度——插件自己的用量由这里记账（ctx.chat.usage），上限用 ctx.chat.configure({ daily }) 设。
//     ctx.sandbox(key, { readDirs: [绝对路径 | { dir, hide }] }) 再挂几个只读资料目录（主机上的文档、知识库）：只能 Read / Glob / Grep，
//     像密钥的文件名和 hide 里的子路径不给读（围栏见 agents/claude.mjs readRootDecision）。
//
// ctx.chat.run({ as, session?, message, attachments?, model?, effort?, fast?, prompt?, format?, tools?, from?, label? }) → turn
//   turn.events   异步可迭代：queued / start { sessionId } / text / tool / note / done（同 result）
//   turn.result   Promise<{ ok, code, text, notes, files, sessionId, usage: { costUsd, durationMs }, isError }>
//                 code：ok / cancelled / quota（账号额度）/ budget（插件用量上限）/ session_lost / engine / disabled
//   turn.stop()   停掉（排队中的直接取消）
// 执行器是 runtime/headless-turn.mjs（与定时任务同一份）：无人值守、不出审批卡、不顶掉该账号在前端进行中的对话。
// 排队：同一个 (身份, session) 串行；同一账号最多 maxParallel 路并行，所有沙箱合用一个 maxParallel（缺省 2，configure 可调 1–4）。
// 会话：session 是插件自己的键（如 'qq:774176839'，缺省 'default'）；核心记下对应的真实 sessionId
//       （plugin-data/<id>/chat-sessions.json），下次同键续写；ctx.chat.reset(as, session) 忘掉它 = 下次开新对话。

import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, stat, rm, appendFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { kernel } from './state.mjs';
import { readJson, writeJson } from '../jsonfile.mjs';
import { getUser, accountId, noteTurnStart } from '../users.mjs';
import { userIdentity, contextFor } from '../runtime/identity.mjs';
import { FEATURES } from '../config/index.mjs';
import { billingUser, quotaBlock } from '../runtime/quota.mjs';
import { holdKeepAwake } from '../runtime/keep-awake.mjs';
import { markPluginSession } from '../runtime/gen.mjs';
import { runHeadlessTurn } from '../runtime/headless-turn.mjs';
import { sessionPaths } from '../runtime/paths.mjs';
import { internalRequest, setInternalRouter } from '../agent-api/internal.mjs';
import { checkTool } from './claude-tools.mjs';
import { setUsageProvider } from './panel.mjs';

export const HOST_ACCOUNT = '@host';
// 单测换掉执行器（不真起 Claude）
let runner = runHeadlessTurn;
export function _setTestRunner(fn) { runner = fn || runHeadlessTurn; }
const MAX_UPLOAD = 50 * 1024 * 1024;
const SANDBOX_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

// format:'plain' 的统一提示（QQ / 微信 / 飞书这类聊天软件都不渲染 Markdown）
export const PLAIN_GUIDE = '【回复格式】你的回复会原样发进不渲染 Markdown 的聊天软件：聊天文字用纯文本，不要 # 标题、**加粗**、`反引号`、代码块围栏、- 列表符、表格；'
  + '分点用 1. 2. 3. 换行。这只约束聊天文字——写进文件的内容照常用 Markdown / 代码。';

// ── 授权 ─────────────────────────────────────────────────────────────────
// 账号引用（登录名或账号 id）→ 规范化的账号 id；'@host' 原样。不存在 → ''。
export function normAccount(ref) {
  const r = String(ref || '').trim();
  if (!r) return '';
  if (r === HOST_ACCOUNT) return HOST_ACCOUNT;
  return accountId(getUser(r));
}

// schema 里所有授权字段（type:'user' + grant:'chat'，或 array 且 items 是这样的）
export function grantFields(schema) {
  const out = [];
  for (const [k, s] of Object.entries(schema || {})) {
    if (s.type === 'user' && s.grant === 'chat') out.push({ key: k, spec: s, multi: false });
    else if (s.type === 'array' && s.items && s.items.type === 'user' && s.items.grant === 'chat') out.push({ key: k, spec: s.items, multi: true });
  }
  return out;
}

// 某份配置里授权了哪些账号（规范化后的 id）。
export function grantedIn(schema, config) {
  const set = new Set();
  for (const f of grantFields(schema)) {
    const v = config ? config[f.key] : undefined;
    for (const ref of f.multi ? (Array.isArray(v) ? v : []) : [v]) { const a = normAccount(ref); if (a) set.add(a); }
  }
  return set;
}

// 这个账号要不要二次确认（主机本人 / pro 档：有命令行，权限大）
export function grantNeedsConfirm(acct) {
  if (acct === HOST_ACCOUNT) return true;
  const u = getUser(acct);
  return !!u && u.tier !== 'user';
}

export function accountLabel(acct) {
  if (acct === HOST_ACCOUNT) return '服务器主机';
  const u = getUser(acct);
  return u ? u.name : acct;
}

// 插件此刻能不能以这个账号做事：返回身份；不行抛人话错误。
export function identityFor(pluginId, as) {
  const acct = normAccount(as);
  if (!acct) throw new Error(`没有账号「${as}」`);
  const schema = kernel.schemaOf(pluginId);
  const config = kernel.configOf(pluginId);
  if (!grantedIn(schema, config).has(acct)) {
    throw new Error(`账号「${accountLabel(acct)}」没有授权给插件「${pluginId}」——在设置 › 扩展 › 功能扩展 › 插件详情里选它`);
  }
  if (acct === HOST_ACCOUNT) return { kind: 'admin', user: null };
  const u = getUser(acct);
  if (!u || u.disabled) throw new Error(`账号「${accountLabel(acct)}」已停用`);
  // 多用户关着（主机形态）时普通账号登不进来，代跑也只认服务账号——同定时任务（routines-runner ownerContexts）。
  if (!FEATURES.multiUser && !u.service) throw new Error(`多用户模式关着，插件只能用服务账号（「${u.name}」不是）`);
  const id = userIdentity(acct);
  if (!id) throw new Error(`账号「${accountLabel(acct)}」不可用`);
  return id;
}

// ── 身份解析：as → { kind, key（会话映射与用量的身份键）, name, lane（并行池）, identity, uctx, label, web } ──────────
function sandboxRef(ctx, key, opts = {}) {
  const k = String(key ?? '');
  if (!SANDBOX_KEY.test(k) || k.includes('..')) throw new Error(`沙箱名「${k}」不合法（字母或数字开头，只用字母、数字、_ . -，≤80 字）`);
  const dir = path.join(ctx.dataDir, 'sandboxes', k);
  mkdirSync(dir, { recursive: true });
  const readRoots = normReadDirs(opts.readDirs);
  const identity = { kind: 'snap', user: null, token: `plugin-${ctx.id}-${k}`, dir, readRoots };
  return { kind: 'sandbox', key: 'sbx:' + k, name: k, lane: '@sandbox', identity, uctx: contextFor(identity), label: '沙箱 ' + k, web: opts.web !== false, readRoots };
}

// readDirs：[绝对路径 | { dir, hide?: [相对路径…] }] → [{ root, hide }]。只读挂给沙箱里的 Claude（Read / Glob / Grep），写不放行；
// 像密钥的文件名（config.json、*.pem、token…）一律不给读，hide 里的子路径也不给。不存在的目录跳过。
function normReadDirs(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const d = typeof x === 'string' ? x : x && typeof x === 'object' ? x.dir : '';
    if (!d || !path.isAbsolute(String(d))) continue;
    const root = path.resolve(String(d));
    try { if (!statSync(root).isDirectory()) continue; } catch { continue; }
    const hide = (x && typeof x === 'object' && Array.isArray(x.hide) ? x.hide : []).map((h) => String(h).trim()).filter((h) => h && !h.includes('..'));
    if (!out.some((r) => r.root === root)) out.push({ root, hide });
    if (out.length >= 8) break;
  }
  return out;
}

export function resolveAs(ctx, as) {
  if (as && typeof as === 'object') {
    if (as.kind === 'sandbox' && typeof as.name === 'string') return sandboxRef(ctx, as.name, as.options || {});
    if (typeof as.sandbox === 'string') return sandboxRef(ctx, as.sandbox, as);
    throw new Error('as 要么是授权的账号名，要么是 ctx.sandbox(名字) 的返回值');
  }
  const identity = identityFor(ctx.id, as);
  const acct = normAccount(as);
  return { kind: 'account', key: acct, name: acct, lane: acct, identity, uctx: contextFor(identity), label: accountLabel(acct), web: true };
}

// ── 小工具 ───────────────────────────────────────────────────────────────
// 简单的异步通道：生产方 push / close，消费方 for await。没人读时最多攒 500 帧（丢最旧的）。
function channel() {
  const buf = [];
  let waiter = null;
  let closed = false;
  return {
    push(v) {
      if (closed) return;
      if (waiter) { const w = waiter; waiter = null; w({ value: v, done: false }); return; }
      buf.push(v);
      if (buf.length > 500) buf.shift();
    },
    close() { closed = true; if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => { waiter = r; });
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}

const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/^\.+/, '').slice(-120) || 'file';
const pad = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const round4 = (x) => Math.round((Number(x) || 0) * 10000) / 10000;

// ── 用量账本（每个插件一份：plugin-data/<id>/chat-usage.json）────────────────
function makeUsage(ctx) {
  const file = () => path.join(ctx.dataDir, 'chat-usage.json');
  let data = null;
  const load = () => {
    if (data) return data;
    const j = readJson(file(), null);
    data = j && typeof j === 'object' ? j : {};
    data.days = data.days && typeof data.days === 'object' ? data.days : {};
    data.total = data.total && typeof data.total === 'object' ? data.total : { turns: 0, costUsd: 0 };
    data.keys = data.keys && typeof data.keys === 'object' ? data.keys : { day: '', by: {} };
    return data;
  };
  const save = () => {
    const d = load();
    const days = Object.keys(d.days).sort();
    for (const k of days.slice(0, Math.max(0, days.length - 60))) delete d.days[k];
    try { mkdirSync(ctx.dataDir, { recursive: true }); writeJson(file(), d, 1); } catch (e) { ctx.warn('用量账本写不进去：', e?.message || e); }
  };
  const bump = (key, turns, cost) => {
    const d = load();
    const day = today();
    const t = (d.days[day] ||= { turns: 0, costUsd: 0 });
    t.turns += turns; t.costUsd = round4(t.costUsd + cost);
    d.total.turns += turns; d.total.costUsd = round4(d.total.costUsd + cost);
    if (d.keys.day !== day) d.keys = { day, by: {} };
    const k = (d.keys.by[key] ||= { turns: 0, costUsd: 0 });
    k.turns += turns; k.costUsd = round4(k.costUsd + cost);
    save();
  };
  return {
    start: (key) => bump(key, 1, 0),
    cost: (key, usd) => { if (usd > 0) bump(key, 0, usd); },
    today: () => { const d = load(); return { turns: 0, costUsd: 0, ...(d.days[today()] || {}) }; },
    view: () => {
      const d = load();
      const day = today();
      const days = Object.keys(d.days).sort().slice(-30).map((k) => ({ day: k, ...d.days[k] }));
      return { today: { turns: 0, costUsd: 0, ...(d.days[day] || {}) }, total: { ...d.total }, days, byKey: d.keys.day === day ? { ...d.keys.by } : {} };
    },
  };
}

// ── 每个插件一份 ─────────────────────────────────────────────────────────
export function makeChatService(ctx) {
  const lanes = new Map();          // 'key\0session' → 尾巴 Promise（同键串行）
  const slots = new Map();          // lane → { running, waiters: [] }
  const live = new Set();           // 正在跑 / 排队的 turn 句柄
  const usage = makeUsage(ctx);
  let maxParallel = 2;
  let daily = { turns: 0, costUsd: 0 };   // 0 = 不限
  let disposed = false;
  let used = false;
  const mapFile = () => path.join(ctx.dataDir, 'chat-sessions.json');
  const readMap = () => readJson(mapFile(), {}) || {};
  const writeMap = (m) => { try { mkdirSync(ctx.dataDir, { recursive: true }); writeJson(mapFile(), m, 1); } catch (e) { ctx.warn('会话映射写不进去：', e?.message || e); } };
  const mkey = (key, session) => key + '\u0000' + session;
  const sessionKey = (s) => String(s ?? '').slice(0, 200) || 'default';

  // 用过 ctx.chat 的插件，详情页自动多一块「用量」（核心记账，插件不用配合）
  const markUsed = () => { if (!used) { used = true; setUsageProvider(ctx.id, () => usage.view()); } };
  if (existsSync(path.join(ctx.dataDir, 'chat-usage.json'))) markUsed();
  ctx.onDispose(() => {
    disposed = true;
    for (const t of live) t.stop();
    setUsageProvider(ctx.id, null);
  });

  const acquire = (lane, signal) => new Promise((resolve) => {
    let s = slots.get(lane);
    if (!s) { s = { running: 0, waiters: [] }; slots.set(lane, s); }
    if (s.running < maxParallel) { s.running++; resolve(true); return; }
    const w = () => resolve(true);
    s.waiters.push(w);
    signal?.addEventListener('abort', () => { const i = s.waiters.indexOf(w); if (i >= 0) { s.waiters.splice(i, 1); resolve(false); } }, { once: true });
  });
  const release = (lane) => {
    const s = slots.get(lane);
    if (!s) return;
    const next = s.waiters.shift();
    if (next) next(); else s.running = Math.max(0, s.running - 1);
  };

  const overBudget = () => {
    const t = usage.today();
    if (daily.turns > 0 && t.turns >= daily.turns) return `今天已经回答了 ${t.turns} 轮，到了插件设的上限（${daily.turns} 轮 / 天）`;
    if (daily.costUsd > 0 && t.costUsd >= daily.costUsd) return `今天已经花了 $${t.costUsd.toFixed(2)}，到了插件设的上限（$${daily.costUsd} / 天）`;
    return '';
  };

  function run(opts = {}) {
    if (disposed || !ctx.alive) throw new Error('插件已停用');
    const who = resolveAs(ctx, opts.as);   // 没授权 / 沙箱名不对当场抛
    const session = sessionKey(opts.session);
    const message = String(opts.message ?? '');
    const attachments = Array.isArray(opts.attachments) ? opts.attachments.filter((p) => typeof p === 'string' && p) : [];
    if (!message.trim() && !attachments.length) throw new Error('ctx.chat.run 要 message');
    const tools = Array.isArray(opts.tools) ? opts.tools : [];
    const names = new Set();
    for (const t of tools) { checkTool(t); if (names.has(t.name)) throw new Error('工具名重复：' + t.name); names.add(t.name); }
    if (opts.format != null && opts.format !== 'plain' && opts.format !== 'markdown') throw new Error("format 只能是 'plain' 或 'markdown'");
    markUsed();

    const events = channel();
    const ac = new AbortController();
    let settle;
    const result = new Promise((r) => { settle = r; });
    let sid = null;
    const turn = {
      id: crypto.randomBytes(6).toString('hex'),
      events,
      result,
      stop() { try { ac.abort(); } catch {} },
    };
    live.add(turn);
    const key = mkey(who.key, session);
    const startedAt = Date.now();
    const finish = (code, out = {}) => {
      const r = {
        ok: code === 'ok', code,
        text: String(out.text ?? ''), notes: out.notes || [], files: out.files || [],
        sessionId: out.sessionId || null,
        usage: { costUsd: round4(out.costUsd || 0), durationMs: Date.now() - startedAt },
        isError: code !== 'ok',
      };
      events.push({ type: 'done', ...r }); events.close(); live.delete(turn); settle(r);
      try { ctx.status?.refresh?.(); } catch {}   // 详情页的「用量」跟着刷新
    };
    const cancelled = () => finish('cancelled', { text: '已取消' });

    // 给工具 handler 的这一轮信息
    const turnInfo = {
      kind: 'plugin', plugin: ctx.id, as: who.kind === 'sandbox' ? { sandbox: who.name } : who.name, session,
      from: opts.from && typeof opts.from === 'object' ? { ...opts.from } : null,
      get sessionId() { return sid; },
    };

    const job = async () => {
      if (ac.signal.aborted) return cancelled();
      if (disposed) return finish('disabled', { text: '插件已停用' });
      if (!(await acquire(who.lane, ac.signal))) return cancelled();
      try {
        if (ac.signal.aborted) return cancelled();
        if (disposed) return finish('disabled', { text: '插件已停用' });
        // 插件自己的用量上限（沙箱和账号都算）
        const over = overBudget();
        if (over) return finish('budget', { text: over });
        // 账号额度：与定时任务、聊天同一道闸，一次代跑算一轮、开跑即记。主机、沙箱不走这道闸。
        if (who.kind === 'account') {
          const billTo = billingUser(who.uctx);
          if (billTo) {
            const block = quotaBlock(billTo);
            if (block) return finish('quota', { text: block.title + '：' + block.message });
            try { noteTurnStart(billTo); } catch {}
          }
        }
        usage.start(who.key + ' ' + session);
        const label = String(opts.label || ctx.meta.name || ctx.id).slice(0, 60);
        const append = `\n\n【运行环境：这一轮由插件「${ctx.meta.name || ctx.id}」代为发起，提问的人不在 bridge 界面上，看不到工具过程，也没法点审批或回答提问。不要提问；需要决策时按最合理的默认判断推进，最后直接给出能原样转达给对方的结果。】`
          + (who.kind === 'sandbox' ? '\n\n【工作目录】你在这个对话专属的隔离目录里：只能读写这个目录里的文件，没有命令行' + (who.web ? '，可以联网查资料（WebSearch / WebFetch）' : '') + '。' : '')
          + (who.readRoots && who.readRoots.length ? '\n\n【资料目录（只读）】下面这些目录可以用 Read / Glob / Grep 查阅（用绝对路径；不能改）：\n'
            + who.readRoots.map((r) => '- ' + r.root + (r.hide.length ? `（其中 ${r.hide.join('、')} 不开放）` : '')).join('\n')
            + '\n回答前按需查，先 Glob / Grep 找到相关文件再 Read，不要凭印象编。里面有些位置会被拒绝访问，属正常，换别处找。' : '')
          + (opts.format === 'plain' ? '\n\n' + PLAIN_GUIDE : '')
          + (opts.prompt ? '\n\n' + String(opts.prompt) : '');
        const runTools = tools.length ? {
          owner: ctx.id,
          tools: tools.map((t) => ({ ...t, handler: (args) => t.handler(args, turnInfo) })),
        } : null;
        const attempt = (resume) => runner(who.uctx, {
          prompt: message,
          attachments,
          resume,
          model: opts.model || null,
          effort: opts.effort || undefined,
          fast: !!opts.fast,
          append,
          runTools,
          disallowedTools: who.web ? [] : ['WebSearch', 'WebFetch'],
          turn: { kind: 'plugin', plugin: ctx.id },
          source: 'plugin:' + ctx.id,
          label: 'plugin:' + ctx.id,
          signal: ac.signal,
          onInit: (s) => { sid = s; markPluginSession(s, { plugin: ctx.id, label }); events.push({ type: 'start', sessionId: s }); },
          onEvent: (ev) => events.push(ev),
        });
        const unhold = holdKeepAwake();
        let out;
        let lost = false;
        try {
          const prev = readMap()[key];
          out = await attempt(prev && prev.sid ? prev.sid : null);
          // 记着的会话被删了（换机器、清了历史）：忘掉它，开新对话重来一次
          if (out.isError && prev && prev.sid && /no conversation found/i.test(out.text || '') && !ac.signal.aborted) {
            ctx.warn(`会话 ${prev.sid} 找不到了，开新对话重试`);
            const m = readMap(); delete m[key]; writeMap(m);
            out = await attempt(null);
            lost = !!out.isError && /no conversation found/i.test(out.text || '');
          }
        } finally { unhold(); }
        usage.cost(who.key + ' ' + session, Number(out.costUsd) || 0);
        if (out.sessionId && !out.isError) { const m = readMap(); m[key] = { sid: out.sessionId, at: Date.now() }; writeMap(m); }
        const text = out.answer != null ? out.answer : out.text;
        const code = !out.isError ? 'ok' : (ac.signal.aborted || out.aborted) ? 'cancelled' : lost ? 'session_lost' : 'engine';
        finish(code, { text, notes: Array.isArray(out.notes) ? out.notes : [], files: out.files || [], sessionId: out.sessionId, costUsd: out.costUsd });
      } catch (e) {
        finish(ac.signal.aborted ? 'cancelled' : 'engine', { text: String(e?.message || e) });
      } finally { release(who.lane); }
    };
    events.push({ type: 'queued' });
    const tail = (lanes.get(key) || Promise.resolve()).then(job, job);
    lanes.set(key, tail);
    tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
    return turn;
  }

  // 这段会话的转录（最近 limit 条）：user { role, text, ts, attachments? } / assistant { role, text, ts, tools? }
  async function history(as, session, { limit = 50 } = {}) {
    const who = resolveAs(ctx, as);
    const rec = readMap()[mkey(who.key, sessionKey(session))];
    if (!rec || !rec.sid) return [];
    const p = sessionPaths(rec.sid, who.uctx.cwd, who.uctx.configDir);
    if (!p || !existsSync(p.file)) return [];
    const { readSessionMessages } = await import('../routes/sessions.mjs');
    const msgs = await readSessionMessages(p.file);
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    return msgs.slice(-n).map((m) => {
      if (m.role === 'user') {
        const atts = Array.isArray(m.attachments) ? m.attachments.map((a) => a && a.name).filter(Boolean) : [];
        return { role: 'user', text: String(m.text || ''), ts: m.ts || null, ...(atts.length ? { attachments: atts } : {}) };
      }
      const tools = [];
      for (const s of Array.isArray(m.segments) ? m.segments : []) if (s && s.kind === 'tools') for (const t of s.tools || []) if (t && t.name) tools.push(t.name);
      return { role: 'assistant', text: String(m.text || ''), ts: m.ts || null, ...(tools.length ? { tools } : {}) };
    });
  }

  return {
    run,
    history,
    configure({ maxParallel: n, daily: d } = {}) {
      if (n != null) maxParallel = Math.max(1, Math.min(4, Math.floor(Number(n)) || 2));
      if (d && typeof d === 'object') {
        daily = { turns: Math.max(0, Math.floor(Number(d.turns) || 0)), costUsd: Math.max(0, Number(d.costUsd) || 0) };
      }
      return { maxParallel, daily: { ...daily } };
    },
    usage: () => usage.view(),
    reset(as, session) {
      const who = resolveAs(ctx, as);
      const m = readMap(); const k = mkey(who.key, sessionKey(session)); const had = !!m[k]; delete m[k]; writeMap(m); return had;
    },
    sessionOf(as, session) { return readMap()[mkey(resolveAs(ctx, as).key, sessionKey(session))]?.sid || null; },
    get running() { return live.size; },
  };
}

// ── 工作区文件 ───────────────────────────────────────────────────────────
// 相对工作区根的路径 → 绝对路径；越界、写进 .bridge（身份的配置目录）报错。
function within(root, rel, { write = false } = {}) {
  const r = path.resolve(root);
  const abs = path.resolve(r, String(rel ?? ''));
  const back = path.relative(r, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) throw new Error('路径越出工作区：' + rel);
  if (write && (back === '' || back.split(path.sep)[0] === '.bridge')) throw new Error('这个位置不能写：' + rel);
  return abs;
}

export function makeFilesService(ctx) {
  const v3 = (ctx.meta.pluginApi || 2) >= 3;
  const putSync = (as, data, name = 'file') => {
    const who = resolveAs(ctx, as);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > MAX_UPLOAD) throw new Error(`文件太大（上限 ${MAX_UPLOAD / 1024 / 1024}MB）`);
    const dir = who.uctx.uploads;
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName(name)}`);
    writeFileSync(file, buf);
    return file;
  };
  const rootOf = (as) => resolveAs(ctx, as).uctx.cwd;
  return {
    // 把一份字节存进这个身份的上传目录，返回绝对路径（能直接当 ctx.chat.run 的 attachments）。pluginApi 3 起返回 Promise。
    put: v3 ? async (as, data, name) => putSync(as, data, name) : putSync,
    // 工作区根目录（Claude 在这里干活）
    root: rootOf,
    // 工作区里某个相对路径的绝对路径（越界报错）
    path: (as, rel) => within(rootOf(as), rel),
    async write(as, rel, data) {
      const abs = within(rootOf(as), rel, { write: true });
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      if (buf.length > MAX_UPLOAD) throw new Error(`文件太大（上限 ${MAX_UPLOAD / 1024 / 1024}MB）`);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      return abs;
    },
    async append(as, rel, text) {
      const abs = within(rootOf(as), rel, { write: true });
      await mkdir(path.dirname(abs), { recursive: true });
      await appendFile(abs, String(text));
      return abs;
    },
    async read(as, rel, { encoding } = {}) {
      const abs = within(rootOf(as), rel);
      return encoding ? readFile(abs, encoding) : readFile(abs);
    },
    async list(as, rel = '') {
      const abs = within(rootOf(as), rel);
      let ents = [];
      try { ents = await readdir(abs, { withFileTypes: true }); } catch (e) { if (e?.code === 'ENOENT') return []; throw e; }
      const out = [];
      for (const e of ents) {
        if (path.resolve(abs) === path.resolve(rootOf(as)) && e.name === '.bridge') continue;
        let st = null;
        try { st = await stat(path.join(abs, e.name)); } catch {}
        out.push({ name: e.name, dir: e.isDirectory(), size: st && !e.isDirectory() ? st.size : null, mtime: st ? st.mtimeMs : null });
      }
      return out;
    },
    async remove(as, rel) {
      const abs = within(rootOf(as), rel, { write: true });
      await rm(abs, { recursive: true, force: true });
      return true;
    },
  };
}

// ctx.sandbox(key, { web, readDirs }) → 句柄：既能当 as 用，也带上文件方法（省得每次写 ctx.files.xxx(ws, …)）。
export function makeSandboxFactory(ctx) {
  const fn = (key, options = {}) => {
    const ref = sandboxRef(ctx, key, options);
    const h = { kind: 'sandbox', name: ref.name, options: { web: ref.web, readDirs: ref.readRoots.map((r) => ({ dir: r.root, hide: r.hide })) }, dir: ref.uctx.cwd };
    h.put = async (data, name) => ctx.files.put(h, data, name);
    h.write = (rel, data) => ctx.files.write(h, rel, data);
    h.append = (rel, text) => ctx.files.append(h, rel, text);
    h.read = (rel, o) => ctx.files.read(h, rel, o);
    h.list = (rel) => ctx.files.list(h, rel);
    h.remove = (rel) => ctx.files.remove(h, rel);
    h.path = (rel) => ctx.files.path(h, rel);
    // 清空这个沙箱（文件连同里面的会话记录 = 彻底重来）；只忘掉对话用 ctx.chat.reset
    h.wipe = async () => { await rm(ref.uctx.cwd, { recursive: true, force: true }); mkdirSync(ref.uctx.cwd, { recursive: true }); return true; };
    return Object.freeze(h);
  };
  // 已经建过的沙箱名
  fn.list = () => { try { return readdirSync(path.join(ctx.dataDir, 'sandboxes'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };
  return fn;
}

// ── 分享 ─────────────────────────────────────────────────────────────────
export function makeShareService(ctx) {
  const snapFile = () => path.join(ctx.dataDir, 'chat-snapshots.json');
  const archDir = () => path.join(ctx.dataDir, 'chat-snapshots');
  const archOf = (token) => path.join(archDir(), String(token).replace(/[^\w-]/g, '_') + '.json');
  const readSnaps = () => readJson(snapFile(), {}) || {};
  const writeSnaps = (m) => { try { mkdirSync(ctx.dataDir, { recursive: true }); writeJson(snapFile(), m, 1); } catch {} };
  const router = () => { if (kernel.hasService('router')) setInternalRouter(kernel.service('router')); };
  const HOST = { kind: 'admin', user: null };

  // 快照的公开元数据（活着才有）
  async function snapMeta(token) {
    router();
    const r = await internalRequest(HOST, 'GET', '/api/csnap/meta?ct=' + encodeURIComponent(token), null, { timeoutMs: 15_000 }).catch(() => null);
    return r && r.status === 200 && r.json ? r.json : null;
  }

  return {
    // 把这个身份工作区里的一批文件 / 文件夹做成公开只读在线工作空间。返回 { url, path, token, expiresAt }。
    async space(as, paths, { ttlHours } = {}) {
      const who = resolveAs(ctx, as);
      if (!kernel.isActive('share')) throw new Error('「分享链接」功能关着，开不了公开链接');
      const root = path.resolve(who.uctx.cwd);
      const rel = (Array.isArray(paths) ? paths : [paths]).map((p) => {
        const s = String(p && typeof p === 'object' ? p.path : p || '');
        if (!s) return '';
        if (!path.isAbsolute(s)) return s;
        const r = path.relative(root, path.resolve(s));
        return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : '';
      }).filter(Boolean);
      if (!rel.length) throw new Error('没有能分享的文件（要在这个身份的工作区里）');
      router();
      const r = await internalRequest(who.identity, 'POST', '/api/share-space', { paths: rel, ...(ttlHours ? { ttlHours } : {}) }, { timeoutMs: 60_000 });
      if (r.status !== 200 || !r.json?.ok) throw new Error((r.json && r.json.error) || r.text || ('分享失败 HTTP ' + r.status));
      return { url: r.json.url || null, path: r.json.path, token: r.json.token, expiresAt: r.json.expiresAt };
    },

    // 铸一个公开的快照对话页（/c/<token>）：拿到链接的人在网页上和 Claude 单独聊（隔离工作区、无命令行，闲置一段时间自动销毁）。
    // 用服务器主机的额度，沿用快照功能的同时活跃数上限。note 记进插件的登记簿（控制台显示「谁要的」）。
    async chat({ note = '' } = {}) {
      if (!kernel.isActive('chat-snapshot')) throw new Error('「快照对话」功能关着，铸不了快照链接');
      router();
      const r = await internalRequest(HOST, 'POST', '/api/chat-snapshot', { note: String(note).slice(0, 120) }, { timeoutMs: 30_000 });
      if (r.status !== 200 || !r.json?.ok) throw new Error((r.json && r.json.error) || r.text || ('铸快照失败 HTTP ' + r.status));
      const m = readSnaps();
      m[r.json.token] = { note: String(note).slice(0, 120), createdAt: Date.now(), path: r.json.path };
      writeSnaps(m);
      return { url: r.json.url || null, path: r.json.path, token: r.json.token, idleMs: r.json.idleMs || null };
    },

    // 这个插件铸过的快照：[{ token, note, createdAt, path, live }]（最近的在前）
    async chats() {
      const m = readSnaps();
      const out = await Promise.all(Object.entries(m).map(async ([token, rec]) => {
        const meta = await snapMeta(token);
        return { token, ...rec, live: !!(meta && !meta.closed && !meta.expired && meta.ok !== false) };
      }));
      return out.sort((a, b) => b.createdAt - a.createdAt);
    },

    // 快照的对话转录：活着时现读并归档；桶被清掉后读归档。返回 { live, messages: [{ role, text, ts }] }
    async chatLog(token) {
      const t = String(token || '');
      if (!readSnaps()[t]) throw new Error('不是这个插件铸的快照');
      const meta = await snapMeta(t);
      const sid = meta && meta.sessionId;
      if (sid) {
        router();
        const r = await internalRequest(HOST, 'GET', `/api/session?id=${encodeURIComponent(sid)}&ct=${encodeURIComponent(t)}`, null, { timeoutMs: 20_000 }).catch(() => null);
        const list = r && r.status === 200 && r.json && Array.isArray(r.json.messages) ? r.json.messages : null;
        if (list) {
          const messages = list.map((x) => ({ role: x.role, text: String(x.text || ''), ts: x.ts || null }));
          try { mkdirSync(archDir(), { recursive: true }); writeJson(archOf(t), { at: Date.now(), messages }, 1); } catch {}
          return { live: true, messages };
        }
      }
      const a = readJson(archOf(t), null);
      return { live: false, messages: a && Array.isArray(a.messages) ? a.messages : [] };
    },

    // 从登记簿里删掉（连同归档）；不动快照本身
    forgetChat(token) {
      const m = readSnaps();
      const had = !!m[token];
      delete m[token];
      writeSnaps(m);
      try { rmSync(archOf(token), { force: true }); } catch {}
      return had;
    },
  };
}

export const _test = { channel, safeName, within };
