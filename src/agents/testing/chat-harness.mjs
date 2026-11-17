// runClaudeChat 特征测试的脚手架：假请求 / 假响应、时间线记录、不稳定字段归一、驱动方的等待原语。
//
// 用法见 ../claude-chat.test.mjs。本模块 import 了 bridge 的运行时模块，所以必须在测试入口把隔离用的
// 环境变量（数据根、工作空间、账号库、CLAUDE_CONFIG_DIR、家目录）设好之后再动态 import。
//
// 时间线：一个场景里按发生顺序记下
//   sse <响应>     发给前端的事件（一条 POST 一个假响应；心跳不记）
//   bus <身份>     账号级事件总线上的广播
//   sdk.query      调 SDK query() 时的 options 快照
//   cli<N> …       假 CLI 这一侧看到的：stdin 上的用户消息、控制请求、钩子与 canUseTool 的返回值
//   log            服务端日志行
//   >> …           驱动方的动作（发消息、停止、作答……）
//   state          场景末尾的落地状态（台账、会话偏好、待回答、gen 缓冲）
// 归一后的文本逐字比对基准文件。

import { mock } from 'node:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaudeChat, _setQueryForTest, releaseWarmClaude, releaseWarmOf, spareStatus } from '../claude.mjs';
import { pendingRewindAnchor } from '../claude-rewind.mjs';
import { makeFakeSdk } from './fake-claude-sdk.mjs';
import { findGenBySession, getCurrentGen, getGens, initSessionStores } from '../../runtime/gen.mjs';
import { busSubscribe } from '../../runtime/bus.mjs';
import { pendingQuestions, sessionQuestions } from '../../runtime/questions.mjs';
import { contextFor } from '../../runtime/identity.mjs';
import { startTurnTiming } from '../../runtime/turn-timing.mjs';
import { initStatus, getContext } from '../../runtime/status.mjs';
import { initCtxUsage, getContextUsage, getEffort } from '../../runtime/ctx-usage.mjs';
import { initInflight } from '../../runtime/inflight.mjs';
import { PROGRAM_ROOT, sessionPaths } from '../../runtime/paths.mjs';
import { chatPrefsFor } from '../../runtime/chat-prefs.mjs';
import { messageOrigins } from '../../runtime/client-origins.mjs';
import { listSuggestions } from '../../runtime/suggestions.mjs';
import { getLimitResume } from '../../runtime/limit-resume.mjs';
import { getUsage, usageWindow } from '../../users.mjs';
import { noteSessionMode } from '../../runtime/permissions.mjs';
import { setPolicy } from '../../runtime/policy.mjs';
import { liveQueryFor } from '../../runtime/mcp-oauth.mjs';

const tick = () => new Promise((r) => setImmediate(r));
const LONG_TEXT = 400;

// ---- 归一 ------------------------------------------------------------------------------------
// 时间戳、随机 id、临时目录换成占位符；随机 id 按首次出现的先后编号，同一个 id 处处同一个号。
function makeNormalizer({ roots, startedAt, known, clockEpoch = 0 }) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 每个根目录的几种写法：原样、正斜杠、SDK 的项目目录编码（非字母数字一律换成 -）
  const pathRules = [];
  for (const [label, dir] of [...roots].sort((a, b) => b[1].length - a[1].length)) {
    const fwd = dir.replace(/\\/g, '/');
    const enc = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const flags = process.platform === 'win32' ? 'gi' : 'g';
    const jsonEsc = dir.replace(/\\/g, '\\\\');   // 路径被 JSON 序列化进字符串里的样子（反斜杠成对）
    if (jsonEsc !== dir) pathRules.push([new RegExp(esc(jsonEsc), flags), label]);
    pathRules.push([new RegExp(esc(dir), flags), label]);
    if (fwd !== dir) pathRules.push([new RegExp(esc(fwd), flags), label]);
    pathRules.push([new RegExp(esc(enc), flags), label + '-ENC']);
  }
  const ids = new Map();       // 原值 → 占位符
  const counters = {};
  const idFor = (kind, raw) => {
    if (!ids.has(raw)) { counters[kind] = (counters[kind] || 0) + 1; ids.set(raw, `<${kind}:${counters[kind]}>`); }
    return ids.get(raw);
  };
  const short = new Map();     // uuid 前 8 位 → 占位符（日志里常只打前 8 位）
  const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const uuidOut = (u) => {
    const k = u.toLowerCase();
    const label = known.get(k);
    const out = label ? `<${label}>` : idFor('uuid', k);
    short.set(k.slice(0, 8), out.replace(/>$/, '~8>'));
    return out;
  };
  const str = (s) => {
    let t = s;
    for (const [re, label] of pathRules) t = t.replace(re, label);
    t = t.replace(UUID, uuidOut);
    t = t.replace(/\b[0-9a-f]{8}\b/g, (m) => short.get(m) || m);
    t = t.replace(/\b(perm|rf|q|plan)-[0-9a-f]{12}\b/g, (m, kind) => idFor('qid-' + kind, m));
    t = t.replace(/\ba-[0-9a-f]{8}\b/g, (m) => idFor('acct', m));
    // 自定义模型服务：服务 id 是随机的，本机代理的端口与令牌每次起都不同
    t = t.replace(/\bp-[0-9a-f]{8}\b/g, (m) => idFor('provider', m));
    t = t.replace(/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{6,}(?=\/p\/)/g, '127.0.0.1:<port>/<proxy-token>');
    t = t.replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>');
    t = t.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<iso>');
    t = t.replace(/约 \d\d:\d\d 恢复（[^）]*）/g, '约 <时刻> 恢复（<多久后>）');
    return t;
  };
  const lo = startedAt - 86400_000, hi = startedAt + 2 * 86400_000;
  const VOLATILE_MS = new Set(['ms', 'durationMs', 'elapsedMs']);
  const walk = (v, key) => {
    if (typeof v === 'string') return str(v);
    if (typeof v === 'number') {
      if (VOLATILE_MS.has(key)) return '<ms>';
      if (key === 'pid') return '<pid>';
      // 时钟被场景接管时，悬停的封顶时刻是确定的：记成距接管时刻的偏移，「从哪一刻起算」也进基准。
      // 只对这一个字段这么记——别的时间戳可能是接管之前按真实时间记下的（比如早先场景里的额度重置时刻）。
      if (clockEpoch && key === 'deadline' && v >= clockEpoch) return `<t+${(v - clockEpoch) / 1000}s>`;
      if (v >= lo && v <= hi) return '<ts>';
      if (v >= lo / 1000 && v <= hi / 1000) return '<ts:s>';
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') {
      // 通知 id = 36 进制的时刻 + 进程内序号（runtime/notices.mjs）
      const o = v.type === 'notice' && typeof v.id === 'string' ? { ...v, id: '<notice-id>' } : v;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [str(k), walk(x, k)]));
    }
    return v;
  };
  // 日志行里的耗时
  const log = (line) => str(line)
    .replace(/handed to CLI in \d+ms via (\w+) \(.*\)$/, 'handed to CLI in <n>ms via $1')
    .replace(/\b\d+ms\b/g, '<n>ms')
    .replace(/parked \d+s/g, 'parked <n>s');
  return { walk, log };
}

// ---- query() 的 options 快照 -----------------------------------------------------------------
// 函数、控制器、进程内 MCP 实例换成记号；env 只记与本进程环境不同的项（宿主机自己的环境变量不进基准）。
const ENV_PROBES = ['PATH', 'CHAR_PLAIN_CANARY', 'CHAR_SECRET_TOKEN', 'BRIDGE_CHAR_CANARY'];
function envSnapshot(env) {
  if (env === process.env) return '<process.env>';
  const set = {};
  for (const k of Object.keys(env).sort()) if (env[k] !== process.env[k]) set[k] = env[k];
  const upper = new Set(Object.keys(env).map((k) => k.toUpperCase()));
  const carried = Object.fromEntries(ENV_PROBES.map((k) => [k, upper.has(k)]));
  return { set, carried };
}
function plain(v, depth = 0) {
  if (typeof v === 'function') return '<fn>';
  if (v === undefined) return '<undefined>';
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof AbortController) return '<AbortController>';
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (v.type === 'sdk' && v.instance) return { type: 'sdk', name: v.name };
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return `<${(v.constructor && v.constructor.name) || 'object'}>`;
  if (depth > 12) return '<deep>';
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x, depth + 1)]));
}
export function snapshotOptions(options) {
  const out = {};
  for (const [k, v] of Object.entries(options)) {
    if (k === 'env') out.env = envSnapshot(v);
    else if (k === 'settings' && typeof v === 'string') { try { out.settings = { json: JSON.parse(v) }; } catch { out.settings = v; } }
    else if (k === 'pathToClaudeCodeExecutable') out[k] = '<cli>';
    else out[k] = plain(v);
  }
  return out;
}

// ---- 假请求 / 假响应 --------------------------------------------------------------------------
function makeRes(onFrame, onEnd) {
  const listeners = {};
  const res = {
    statusCode: 0,
    writableEnded: false,
    headersSent: false,
    writeHead(code) { res.statusCode = code; res.headersSent = true; return res; },
    setHeader() {},
    write(chunk) {
      for (const block of String(chunk).split('\n\n')) {
        if (!block.startsWith('data: ')) continue;   // 心跳（: ping）不记
        let obj; try { obj = JSON.parse(block.slice(6)); } catch { obj = { raw: block }; }
        onFrame(obj);
      }
      return true;
    },
    end(chunk) {
      if (res.writableEnded) return res;
      if (chunk) res.write(chunk);
      res.writableEnded = true;
      onEnd();
      for (const fn of listeners.close || []) { try { fn(); } catch {} }
      return res;
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return res; },
    once(ev, fn) { return res.on(ev, fn); },
    off() { return res; },
    removeListener() { return res; },
    emit() { return false; },
  };
  return res;
}

// 场景里的固定 id：由场景名 + 标签算出来（每个场景各用各的，进程里的会话级状态互不相干）。
function stableUuid(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * dirs：{ tmp, data, vault, users, claude, home }（绝对路径）。
 * 返回 { run(name, fn) → 归一后的场景文本, texts（长文本表）, shutdown() }。
 */
export function makeChatHarness({ dirs, verbose = false }) {
  // 额度策略定死：推荐值里「全服同时在跑的轮数」按本机内存算，会随机器变
  setPolicy({ preset: 'recommended', maxUserTurns: 3 });
  initStatus(dirs.data);
  initCtxUsage(dirs.data);
  initSessionStores(dirs.data);
  initInflight(dirs.data);

  const texts = new Map();   // 长文本去重：sha → 原文（归一后的）
  const options = new Map(); // query 的 options 快照去重：sha → JSON
  let cur = null;            // 当前场景
  const rec = (...entry) => { if (cur && !cur.sealed) cur.timeline.push(entry); };
  // 绑在某个场景上的记录函数：假 CLI、假响应一生都记进起它的那个场景，场景结束后的动静丢掉，不串进后面的场景
  const recOf = (sc) => (...entry) => { if (sc && !sc.sealed) sc.timeline.push(entry); };

  const sdk = makeFakeSdk({ recorder: () => recOf(cur), snapshotOptions });
  _setQueryForTest(sdk.query);

  // 服务端日志进时间线（node:test 自己的输出不经 console，不受影响）
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const level of Object.keys(orig)) {
    console[level] = (...args) => {
      const line = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(' ');
      rec('log', line);
      if (verbose) orig[level](...args);
    };
  }

  const roots = [
    ['<DATA>', dirs.data], ['<VAULT>', dirs.vault], ['<USERS>', dirs.users], ['<CLAUDE>', dirs.claude],
    ['<HOME>', dirs.home], ['<TMP>', dirs.tmp], ['<PROGRAM>', PROGRAM_ROOT], ['<OSTMP>', os.tmpdir()],
  ];

  async function run(name, fn) {
    const known = new Map();
    const startedAt = Date.now();
    const sc = { name, timeline: [], sealed: false, chats: 0, calls: [], busOff: [], keys: new Map(), gensBefore: new Map(), sids: new Map(), procsFrom: sdk.procs.length, unscriptedFrom: sdk.unscripted() };
    cur = sc;

    const h = {
      dirs,
      rec,
      tick,
      /** 本场景的固定会话 id（标签进基准，如 <sid:A>）。 */
      sid(label = 'A') {
        const id = stableUuid(name + '|' + label);
        known.set(id, 'sid:' + label);
        sc.sids.set(id, label);
        return id;
      },
      /** 固定的其它 id（消息 uuid、tool_use id 用不着这个——它们是剧本里的普通字符串）。 */
      uuid(label) { const id = stableUuid(name + '|uuid|' + label); known.set(id, 'uuid:' + label); return id; },
      /** 身份上下文；同时把该身份的总线挂上记录。 */
      ctx(identity = { kind: 'admin' }, patch = {}) {
        const c = { ...contextFor(identity), ...patch };
        if (!sc.keys.has(c.key)) {
          sc.keys.set(c.key, c);
          sc.gensBefore.set(c.key, new Set(getGens(c.key)));
          const mine = recOf(sc);
          const busRes = makeRes((obj) => mine('bus', c.key, obj), () => {});
          sc.busOff.push(busSubscribe(c.key, busRes));
        }
        return c;
      },
      script: (fn2, control) => sdk.script(fn2, control),
      /** 发一条消息（= 一次 POST /api/chat 落到 runClaudeChat）。返回 { res, done }。 */
      chat(args, { label, headers = {} } = {}) {
        const tag = label || 'r' + (++sc.chats);
        const req = { method: 'POST', url: '/api/chat', headers: { 'user-agent': 'char-test', ...headers } };
        startTurnTiming(req);
        const mine = recOf(sc);
        const res = args.prewarm ? null : makeRes((obj) => mine('sse', tag, obj), () => mine('sse', tag, '<end>'));
        rec('>>', 'chat', tag, { message: args.message, ...(args.sessionId ? { sessionId: args.sessionId } : {}), ...(args.prewarm ? { prewarm: true } : {}) });
        const call = { tag, res, settled: false, awaited: false, error: null };
        call.promise = Promise.resolve()
          .then(() => runClaudeChat(req, res, args))
          .then(() => { call.settled = true; }, (e) => { call.settled = true; call.error = e; });
        sc.calls.push(call);
        return call;
      },
      /** 等这次 runClaudeChat 调用返回（它的 CLI 进程收干净了，或这条消息被别的进程接走了）。迟迟不返回算场景失败。 */
      async done(call, ms = 20_000) {
        let timer;
        const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`场景「${name}」的调用 ${call.tag} 等了 ${ms / 1000}s 还没返回`)), ms); });
        try { await Promise.race([call.promise, late]); } finally { clearTimeout(timer); }
        call.awaited = true;
        // 等静下来再记：这次调用的 promise 落地与别的流程（接手的那个进程、上一轮的收尾）差几个微任务，
        // 谁先谁后不是系统的行为，不该进基准
        await h.idle();
        if (call.error) rec('>>', 'threw', call.tag, String((call.error && call.error.message) || call.error));
        else rec('>>', 'returned', call.tag);
      },
      /** 等条件成立（轮询事件循环，不靠定时器）；随后再让出几圈，把尾巴上的同步 / 微任务收干净。 */
      async until(pred, what = 'condition', ms = 15_000) {
        const deadline = performance.now() + ms;   // 不用 Date：场景可能把它拨快了（见 clock）
        while (!pred()) {
          if (performance.now() > deadline) {
            const tail = sc.timeline.slice(-12).map((e) => JSON.stringify(e).slice(0, 300)).join('\n  ');
            throw new Error(`场景「${name}」等不到：${what}\n  最近的时间线：\n  ${tail}`);
          }
          await tick();
        }
        await h.idle();
      },
      async idle(n = 4) { for (let i = 0; i < n; i++) await tick(); },
      /** 等某个假 CLI 走到具名的点（pause 名 / 'user#N' / 'interrupt'）。 */
      at(ref, point) { return h.until(() => ref.proc && ref.proc.state.at === point, `${ref.proc ? ref.proc.tag : 'cli'} 走到 ${point}`); },
      resume(ref, point) { rec('>>', 'resume', ref.proc.tag, point); ref.proc.resume(point); },
      /** 时间线里有没有某种事件（sse / bus）。 */
      seen(kind, pred) { return sc.timeline.some((e) => e[0] === kind && pred(e[2], e[1])); },
      events(kind, pred = () => true) { return sc.timeline.filter((e) => e[0] === kind && e[2] && typeof e[2] === 'object' && pred(e[2], e[1])).map((e) => e[2]); },
      gen: (key, sid) => findGenBySession(key, sid),
      /** POST /api/stop 的同款逻辑（routes/overview.mjs）。 */
      stop(key, sid, { release = false } = {}) {
        const g = sid ? findGenBySession(key, sid) : getCurrentGen(key);
        let released = false, held = false;
        if (g && !g.done) {
          if (release && typeof g.releaseHold === 'function') { try { released = g.releaseHold() === true; } catch {} }
          else if (!release && typeof g.interruptTurn === 'function') { try { held = g.interruptTurn() === true; } catch {} }
          if (!released && !held) {
            try { if (typeof g.hardStop === 'function') g.hardStop(); else g.abort.abort(); } catch {}
          }
        }
        rec('>>', 'stop', { release, released, held, found: !!g });
        return { released, held };
      },
      /** POST /api/answer 的同款逻辑：给最近一张还在等的卡作答。 */
      async answer(payload, { qid } = {}) {
        let id = qid;
        if (!id) {
          await h.until(() => pendingQuestions.size > 0, '有卡在等回答');
          id = [...pendingQuestions.keys()].pop();
        }
        const entry = pendingQuestions.get(id);
        if (!entry) throw new Error(`场景「${name}」没有在等的卡：${id}`);
        rec('>>', 'answer', id, payload);
        entry.settle(payload.cancelled ? { cancelled: true } : payload);
      },
      releaseWarm: async (key, sid) => { rec('>>', 'releaseWarm'); await releaseWarmClaude(key, sid); },
      releaseWarmOf: async (key) => { rec('>>', 'releaseWarmOf', await releaseWarmOf(key)); },
      spareStatus,
      /** 这一轮挂在 gen 上的控制口（插话 / 撤回 / 停单个后台任务），动作与返回值记进时间线。 */
      steer(key, sid, args) {
        const g = findGenBySession(key, sid);
        const uuid = g && typeof g.steer === 'function' ? g.steer(args) : null;
        rec('>>', 'steer', { message: args.message }, uuid);
        return uuid;
      },
      async unsteer(key, sid, uuid) {
        const g = findGenBySession(key, sid);
        const r = await g.unsteer(uuid);
        rec('>>', 'unsteer', uuid, r);
        return r;
      },
      async stopTask(key, sid, taskId) {
        const g = findGenBySession(key, sid);
        const r = await g.stopTask(taskId);
        rec('>>', 'stopTask', taskId, r);
        return r;
      },
      /**
       * 把时钟接管过来（Date 与 setInterval）：悬停看门狗每 15 秒看一次、按分钟到小时计的门槛判定，靠拨快时钟走到。
       * 要在发消息之前调（看门狗的定时器在一轮开头就挂上）；场景结束时自动还原。
       */
      clock() {
        sc.clockEpoch = Date.now();
        mock.timers.enable({ apis: ['setInterval', 'Date'], now: sc.clockEpoch });
        sc.clock = true;
        return {
          async advance(ms, step = 15_000) {
            rec('>>', 'advance', Math.round(ms / 1000) + 's');
            for (let t = 0; t < ms; t += step) { mock.timers.tick(step); await tick(); }
            await h.idle();
          },
        };
      },
      /** 会话记忆里的权限模式（= 用户在芯片上选了、CLI 这边还没切过去的那种状态）。 */
      setSessionMode(c, sid, mode) { rec('>>', 'session-mode', mode); noteSessionMode(c, sid, mode); },
      /** 改额度策略（场景自己改的自己改回去）。 */
      policy(patch) { rec('>>', 'policy', patch); setPolicy(patch); },
      /** 往 transcript 里追加记录（假 CLI 不写盘；要回滚锚点、思考块清理这些读盘的分支时由剧本代写）。 */
      transcript(c, sid) {
        const sp = sessionPaths(sid, c.cwd, c.configDir);
        mkdirSync(sp.dir, { recursive: true });
        return { file: sp.file, append: (...records) => appendFileSync(sp.file, records.map((r) => JSON.stringify(r)).join('\n') + '\n') };
      },
      /** 在某个目录下放一个文件（工作空间里的产物、附件）。 */
      mkfile(root, rel, content = '') {
        const file = path.join(root, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, content);
        return file;
      },
      /** 落地状态：gen 缓冲、会话偏好、待回答、上下文、发送端、限额续跑、在跑台账、按人记账。 */
      snapshot(note = '') {
        const state = {};
        for (const [key, c] of sc.keys) {
          const gens = getGens(key).filter((g) => !sc.gensBefore.get(key).has(g)).map((g) => ({
            sessionId: g.sessionId, done: !!g.done, userText: g.userText, source: g.source,
            atts: g.userAtts, events: g.events.map((e) => e.type).join(' '),
            finalizing: !!g.finalizing, stopping: !!g.stopping, autoTurn: !!g.autoTurn, family: g.family ? (g.family.origin && g.family.origin.kind) || true : null,
            controls: ['stopTask', 'releaseHold', 'interruptTurn', 'hardStop', 'handoff', 'steer', 'unsteer'].filter((k) => typeof g[k] === 'function').length,
          }));
          const perSid = {};
          for (const [sid, label] of sc.sids) {
            const sp = sessionPaths(sid, c.cwd, c.configDir);
            const cu = getContextUsage(key, sid);
            perSid[label] = {
              prefs: chatPrefsFor(c, sid) || null,
              questions: sessionQuestions.list(sid).map((q) => ({ qid: q.qid, kind: q.kind || null })),
              context: getContext(key, sid),
              contextUsage: cu ? { total: cu.total, max: cu.max, pct: cu.pct, cacheTtlMin: cu.cacheTtlMin } : null,
              effort: getEffort(key, sid),
              origins: messageOrigins(c, sid),
              limitResume: getLimitResume(key, sid),
              rewind: pendingRewindAnchor(sid),
              liveQuery: !!liveQueryFor(key, sid),
              transcript: sp && existsSync(sp.file) ? readFileSync(sp.file, 'utf8').split('\n').filter(Boolean).length : null,
            };
          }
          state[key] = {
            gens, sessions: perSid, suggestions: listSuggestions(key), spare: spareStatus(key),
            ...(c.kind === 'user' ? { usage: getUsage(c.user), today: usageWindow(c.user).today } : {}),
          };
        }
        let inflight = null;
        try { inflight = JSON.parse(readFileSync(path.join(dirs.data, 'inflight-runs.json'), 'utf8')); } catch {}
        if (Array.isArray(inflight)) inflight = inflight.map(({ beat, ...r }) => r);   // 心跳时刻不稳定，不进基准
        rec('state', ...(note ? [note] : []), { ...state, inflight, pendingQuestions: pendingQuestions.size });
      },
    };

    let failure = null;
    try { await fn(h); } catch (e) { failure = e; }
    if (sc.clock) mock.timers.reset();
    await h.idle();
    // 剧本自己出的错（不是故意 crash 的）算场景失败
    const broken = sdk.procs.slice(sc.procsFrom).find((p) => p.state.error);
    if (!failure && broken) failure = broken.state.error;
    if (!failure && sdk.pendingScripts()) failure = new Error(`场景「${name}」排了 ${sdk.pendingScripts()} 个没用上的剧本`);
    if (!failure && sdk.unscripted() > sc.unscriptedFrom) failure = new Error(`场景「${name}」里有没排剧本的 query()`);
    const loose = sc.calls.find((c) => !c.awaited);
    if (!failure && loose) failure = new Error(`场景「${name}」的调用 ${loose.tag} 没有用 h.done() 等它返回`);
    for (const off of sc.busOff) off();
    sc.sealed = true;
    cur = null;
    if (failure) throw failure;

    // 归一 + 成行
    const norm = makeNormalizer({ roots, startedAt, known, clockEpoch: sc.clockEpoch || 0 });
    const lines = [];
    const cut = (v) => {
      if (typeof v === 'string') {
        if (v.length <= LONG_TEXT) return v;
        const sha = createHash('sha256').update(v).digest('hex').slice(0, 12);
        texts.set(sha, v);
        return `<text:${sha}:${v.length}>`;
      }
      if (Array.isArray(v)) return v.map(cut);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cut(x)]));
      return v;
    };
    for (const entry of sc.timeline) {
      const [kind, ...rest] = entry;
      if (kind === 'log') { lines.push('log ' + norm.log(String(rest[0]))); continue; }
      const parts = rest.map((x) => {
        const n = cut(norm.walk(x));
        if (typeof n === 'string' && /^[\w.#<>:~-]+$/.test(n)) return n;
        const json = JSON.stringify(n);
        // query 的 options 快照同身份同参数的场景都一样：进长文本表，时间线上只留引用
        if (kind !== 'sdk.query') return json;
        const sha = createHash('sha256').update(json).digest('hex').slice(0, 12);
        options.set(sha, json);
        return `<options:${sha}>`;
      });
      lines.push([kind, ...parts].join(' '));
    }
    return lines.join('\n') + '\n';
  }

  return {
    run,
    texts,
    options,
    sdk,
    shutdown() {
      _setQueryForTest(null);
      for (const level of Object.keys(orig)) console[level] = orig[level];
    },
  };
}
