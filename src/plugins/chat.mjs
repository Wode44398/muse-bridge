// 插件的「以账号身份做事」服务：ctx.chat（跑一轮 Claude）、ctx.files（往账号工作区放文件）、ctx.share（公开只读分享）。
//
// 身份不是插件自己说了算：只能用管理员在插件设置里用 { type:'user', grant:'chat' } 字段选过的账号（选中即授权）。
// 选 pro 档账号或主机本人（'@host'）在设置页要二次确认（routes/plugins.mjs）。插件拿不到账号密码，也不经 HTTP 登录。
//
// ctx.chat.run({ as, session, message, attachments?, model?, effort?, prompt?, label? }) → turn
//   turn.events   异步可迭代：{ type:'queued' } / { type:'start', sessionId? } / { type:'text', text } / { type:'tool', name, input } /
//                 { type:'note', text } / { type:'done', text, sessionId, isError, files }
//   turn.result   Promise<{ text, sessionId, isError, files }>（不想逐帧看就 await 它）
//   turn.stop()   停掉（排队中的直接取消）
// 执行器是 runtime/headless-turn.mjs（与定时任务同一份）：无人值守、不出审批卡、不顶掉该账号在前端进行中的对话。
// 排队：同一个 (账号, session) 串行；同一账号最多 maxParallel 路并行（缺省 2，ctx.chat.configure 可调 1–4）。
// 会话：插件给的 session 是它自己的键（如 'qq:774176839'）；核心记下对应的真实 sessionId（plugin-data/<id>/chat-sessions.json），
//       下次同键续写；ctx.chat.reset(as, session) 忘掉它 = 下次开新对话。

import { mkdirSync, writeFileSync } from 'node:fs';
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
import { internalRequest, setInternalRouter } from '../agent-api/internal.mjs';

export const HOST_ACCOUNT = '@host';
// 单测换掉执行器（不真起 Claude）
let runner = runHeadlessTurn;
export function _setTestRunner(fn) { runner = fn || runHeadlessTurn; }
const MAX_UPLOAD = 50 * 1024 * 1024;

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

// ── 每个插件一份 ─────────────────────────────────────────────────────────
export function makeChatService(ctx) {
  const lanes = new Map();          // 'acct\0session' → 尾巴 Promise（同键串行）
  const slots = new Map();          // acct → { running, waiters: [] }
  const live = new Set();           // 正在跑 / 排队的 turn 句柄
  let maxParallel = 2;
  let disposed = false;
  const mapFile = () => path.join(ctx.dataDir, 'chat-sessions.json');
  const readMap = () => readJson(mapFile(), {}) || {};
  const writeMap = (m) => { try { mkdirSync(ctx.dataDir, { recursive: true }); writeJson(mapFile(), m, 1); } catch (e) { ctx.warn('会话映射写不进去：', e?.message || e); } };
  const mkey = (acct, session) => acct + '\u0000' + session;

  ctx.onDispose(() => {
    disposed = true;
    for (const t of live) t.stop();
  });

  const acquire = (acct) => new Promise((resolve) => {
    let s = slots.get(acct);
    if (!s) { s = { running: 0, waiters: [] }; slots.set(acct, s); }
    if (s.running < maxParallel) { s.running++; resolve(); } else s.waiters.push(resolve);
  });
  const release = (acct) => {
    const s = slots.get(acct);
    if (!s) return;
    const next = s.waiters.shift();
    if (next) next(); else s.running = Math.max(0, s.running - 1);
  };

  function run(opts = {}) {
    if (disposed || !ctx.alive) throw new Error('插件已停用');
    const session = String(opts.session || '').slice(0, 200);
    if (!session) throw new Error('ctx.chat.run 要 session（插件自己起的会话键，如 "qq:12345"）');
    const message = String(opts.message ?? '');
    if (!message.trim() && !(opts.attachments || []).length) throw new Error('ctx.chat.run 要 message');
    const identity = identityFor(ctx.id, opts.as);   // 没授权当场抛
    const acct = normAccount(opts.as);
    const uctx = contextFor(identity);
    const events = channel();
    const ac = new AbortController();
    let settle;
    const result = new Promise((r) => { settle = r; });
    const turn = {
      id: crypto.randomBytes(6).toString('hex'),
      events,
      result,
      stop() { try { ac.abort(); } catch {} },
    };
    live.add(turn);
    const key = mkey(acct, session);
    const finish = (out) => { events.push({ type: 'done', ...out }); events.close(); live.delete(turn); settle(out); };

    const job = async () => {
      if (ac.signal.aborted || disposed) { finish({ text: '已取消', sessionId: null, isError: true, files: [] }); return; }
      await acquire(acct);
      try {
        if (ac.signal.aborted || disposed) { finish({ text: '已取消', sessionId: null, isError: true, files: [] }); return; }
        // 额度：与定时任务、聊天同一道闸，一次代跑算一轮、开跑即记。主机不限。
        const billTo = billingUser(uctx);
        if (billTo) {
          const block = quotaBlock(billTo);
          if (block) { finish({ text: block.title + '：' + block.message, sessionId: null, isError: true, files: [], quota: true }); return; }
          try { noteTurnStart(billTo); } catch {}
        }
        const label = String(opts.label || ctx.meta.name || ctx.id).slice(0, 60);
        const append = `\n\n【运行环境：这一轮由插件「${ctx.meta.name || ctx.id}」代为发起，提问的人不在 bridge 界面上，看不到工具过程，也没法点审批或回答提问。不要提问；需要决策时按最合理的默认判断推进，最后直接给出能原样转达给对方的结果。】`
          + (opts.prompt ? '\n\n' + String(opts.prompt) : '');
        const attempt = async (resume) => runner(uctx, {
          prompt: message,
          attachments: Array.isArray(opts.attachments) ? opts.attachments : [],
          resume,
          model: opts.model || null,
          effort: opts.effort || undefined,
          append,
          turn: { kind: 'plugin', plugin: ctx.id },
          source: 'plugin:' + ctx.id,
          label: 'plugin:' + ctx.id,
          signal: ac.signal,
          onInit: (sid) => { markPluginSession(sid, { plugin: ctx.id, label }); events.push({ type: 'start', sessionId: sid }); },
          onEvent: (ev) => events.push(ev),
        });
        const unhold = holdKeepAwake();
        let out;
        try {
          const prev = readMap()[key];
          out = await attempt(prev && prev.sid ? prev.sid : null);
          // 记着的会话被删了（换机器、清了历史）：忘掉它，开新对话重来一次
          if (out.isError && prev && prev.sid && /no conversation found/i.test(out.text || '') && !ac.signal.aborted) {
            ctx.warn(`会话 ${prev.sid} 找不到了，开新对话重试`);
            const m = readMap(); delete m[key]; writeMap(m);
            out = await attempt(null);
          }
        } finally { unhold(); }
        if (out.sessionId && !out.isError) { const m = readMap(); m[key] = { sid: out.sessionId, at: Date.now() }; writeMap(m); }
        finish({ text: out.text, sessionId: out.sessionId, isError: out.isError, files: out.files || [] });
      } catch (e) {
        finish({ text: String(e?.message || e), sessionId: null, isError: true, files: [] });
      } finally { release(acct); }
    };
    events.push({ type: 'queued' });
    const tail = (lanes.get(key) || Promise.resolve()).then(job, job);
    lanes.set(key, tail);
    tail.then(() => { if (lanes.get(key) === tail) lanes.delete(key); });
    return turn;
  }

  return {
    run,
    configure({ maxParallel: n } = {}) {
      if (n != null) maxParallel = Math.max(1, Math.min(4, Math.floor(Number(n)) || 2));
      return { maxParallel };
    },
    reset(as, session) { const m = readMap(); const k = mkey(normAccount(as), String(session || '')); const had = !!m[k]; delete m[k]; writeMap(m); return had; },
    sessionOf(as, session) { return readMap()[mkey(normAccount(as), String(session || ''))]?.sid || null; },
    get running() { return live.size; },
  };
}

export function makeFilesService(ctx) {
  return {
    // 把一份字节存进该账号工作区的上传目录，返回绝对路径（能直接当 ctx.chat.run 的 attachments）。
    put(as, data, name = 'file') {
      const id = identityFor(ctx.id, as);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length > MAX_UPLOAD) throw new Error(`文件太大（上限 ${MAX_UPLOAD / 1024 / 1024}MB）`);
      const dir = contextFor(id).uploads;
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safeName(name)}`);
      writeFileSync(file, buf);
      return file;
    },
    // 该账号的工作区根目录（Claude 在这里干活）
    root(as) { return contextFor(identityFor(ctx.id, as)).cwd; },
  };
}

export function makeShareService(ctx) {
  return {
    // 把该账号工作区里的一批文件 / 文件夹做成公开只读在线工作空间。返回 { url, path, token, expiresAt }。
    async space(as, paths, { ttlHours } = {}) {
      const id = identityFor(ctx.id, as);
      if (!kernel.isActive('share')) throw new Error('「分享链接」功能关着，开不了公开链接');
      const root = path.resolve(contextFor(id).cwd);
      const rel = (Array.isArray(paths) ? paths : [paths]).map((p) => {
        const s = String(p && typeof p === 'object' ? p.path : p || '');
        if (!s) return '';
        if (!path.isAbsolute(s)) return s;
        const r = path.relative(root, path.resolve(s));
        return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : '';
      }).filter(Boolean);
      if (!rel.length) throw new Error('没有能分享的文件（要在该账号的工作区里）');
      if (kernel.hasService('router')) setInternalRouter(kernel.service('router'));
      const r = await internalRequest(id, 'POST', '/api/share-space', { paths: rel, ...(ttlHours ? { ttlHours } : {}) }, { timeoutMs: 60_000 });
      if (r.status !== 200 || !r.json?.ok) throw new Error((r.json && r.json.error) || r.text || ('分享失败 HTTP ' + r.status));
      return { url: r.json.url || null, path: r.json.path, token: r.json.token, expiresAt: r.json.expiresAt };
    },
  };
}

export const _test = { channel, safeName };
