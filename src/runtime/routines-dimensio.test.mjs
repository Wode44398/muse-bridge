// 定时任务用 dimensio 跑（11-14，routines-runner.mjs 的 dimensio 引擎）：到点经 dimensio 扩展的 familyCall 在属主自己的 dimensio
// 实例里开 / 续会话起一轮，长轮询等结局，记进运行记录（带 agent:'dimensio'，界面据此跳 dimensio 页）。familyCall 这一层用
// _setRoutineDimCall 换成假的 dimensio 端点（不拉起 harness、不碰正式服）。另测路由的字段校验与数据层换引擎时的清理。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-rt-dim-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18997, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users') }, null, 2));
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const routines = await import('../routines.mjs');
const { runRoutine, liveRoutines, dimensioRoutineOk, _setRoutineDimCall, _setRoutineDimTiming } = await import('./routines-runner.mjs');
const { recentNotices } = await import('./notices.mjs');
const { registerRoutineRoutes, _routineFields, dimModesFor } = await import('../routes/routines.mjs');

const D1 = 'dddddddd-0000-4000-8000-0000000000d1';
const D2 = 'dddddddd-0000-4000-8000-0000000000d2';
const SCHED = { type: 'daily', hour: 9, minute: 0 };

let dir, ctx, calls, script;
let n = 0;
beforeEach(() => {
  dir = path.join(tmp, 'owner-' + (++n));
  mkdirSync(dir, { recursive: true });
  // 任务属主的身份（runner 只看这几项；familyCall 按 ctx.key 选属主自己的 dimensio 实例）
  ctx = { kind: 'user', user: 'u' + n, key: 'u:u' + n, dataDir: dir, cwd: dir, allowClaude: true, allowDimensio: true, shell: true };
  calls = [];
  script = { start: [], status: [] };
  _setRoutineDimTiming({ retryMs: 5 });
  // 假的 dimensio 端点：按脚本依次答；没排脚本的 routine 回一个新会话，routine-status 回「做完了」
  _setRoutineDimCall(async (c, op, body, timeoutMs) => {
    calls.push({ key: c.key, op, body, timeoutMs });
    const next = (op === 'routine' ? script.start : script.status).shift();
    if (typeof next === 'function') return next(body);
    if (next instanceof Error) throw next;
    if (next) return next;
    if (op === 'routine') return { ok: true, id: body.sessionId || D1, runId: 'run-' + calls.length };
    return { ok: true, running: false, outcome: 'done', text: 'DEFAULT DONE', endedAt: Date.now() };
  });
});

const mk = (extra = {}) => routines.create(dir, { name: '每日回顾', prompt: '看看昨天的提交', schedule: SCHED, agent: 'dimensio', ...extra });
const lastRun = (id) => routines.get(dir, id).runs[0];

test('到点：经 familyCall 在属主的实例里开新会话（带厂商 / 型号 / 深度 / 档位 / 文件夹），长轮询等到结局，记进运行记录', async () => {
  const r = mk({ provider: 'openai', model: 'deepseek-v4', effort: 'high', permissionMode: 'auto', cwd: path.join(dir, 'proj'), notify: true });
  let seenLive = null;
  script.status.push(
    () => { seenLive = liveRoutines([r.id])[r.id]; return { ok: true, running: true, waiting: true }; },
    () => { seenLive = { ...liveRoutines([r.id])[r.id], second: true }; return { ok: true, running: true, waiting: false }; },
    { ok: true, running: false, outcome: 'done', text: '查了 3 个提交，一切正常', endedAt: Date.now() },
  );
  await runRoutine(ctx, r.id, 'manual');
  assert.equal(calls[0].op, 'routine');
  assert.equal(calls[0].key, ctx.key, '用属主自己的身份（成员 → 他的租户实例）');
  assert.deepEqual(calls[0].body, {
    title: '每日回顾', prompt: '看看昨天的提交',
    config: { provider: 'openai', model: 'deepseek-v4', thinking: 'high', permissionMode: 'auto', workspace: path.join(dir, 'proj') },
  });
  const polls = calls.filter((c) => c.op === 'routine-status');
  assert.equal(polls.length, 3);
  assert.deepEqual(polls[0].body, { id: D1, runId: 'run-1', waitMs: 20_000 });
  assert.ok(polls[0].timeoutMs > 20_000, '长轮询的请求时限要比等待时长宽');
  assert.deepEqual(seenLive, { sessionId: D1, waiting: true, agent: 'dimensio', second: true }, '上一问答了 waiting，live 跟着亮「等你处理」');
  const run = lastRun(r.id);
  assert.deepEqual([run.status, run.sessionId, run.agent, run.preview, run.trigger], ['ok', D1, 'dimensio', '查了 3 个提交，一切正常', 'manual']);
  const cur = routines.get(dir, r.id);
  assert.deepEqual([cur.lastStatus, cur.lastSessionId], ['ok', D1]);
  assert.equal(cur.threadSessionId, null, '每次新会话：不记「接着用」的会话');
  // 跑完通知：dimensio 的会话不带会话 id（点开落到定时任务页，免得打开一个不存在的 Claude 会话）
  const note = recentNotices(ctx.key).at(-1);
  assert.deepEqual([note.kind, note.sub, note.sessionId, note.title], ['done', 'routine', null, '每日回顾']);
  assert.deepEqual(liveRoutines([r.id]), {}, '收尾后不在 live 里');
});

test('等的时候问到 waiting：live 里报「等你处理」', async () => {
  const r = mk();
  let mid = null;
  script.status.push(
    { ok: true, running: true, waiting: true },
    () => { mid = liveRoutines([r.id])[r.id]; return { ok: true, running: false, outcome: 'done', text: 'ok', endedAt: Date.now() }; },
  );
  await runRoutine(ctx, r.id, 'schedule');
  assert.deepEqual(mid, { sessionId: D1, waiting: true, agent: 'dimensio' });
  assert.deepEqual(calls[0].body.config, {}, '都没选 = 交给 dimensio 设置里的默认（工作区也是它的默认）');
});

test('接着上次的会话：第一次记下会话，之后续它（不再给工作区）；它正在跑就跳过；会话没了改开新的', async () => {
  const r = mk({ sessionMode: 'continue', cwd: path.join(dir, 'p') });
  await runRoutine(ctx, r.id, 'schedule');
  assert.equal(routines.get(dir, r.id).threadSessionId, D1);
  await runRoutine(ctx, r.id, 'schedule');
  const second = calls.filter((c) => c.op === 'routine')[1];
  assert.equal(second.body.sessionId, D1);
  assert.equal(second.body.config.workspace, undefined, '续会话时工作区由会话自己定');
  script.start.push({ ok: false, code: 'busy', error: '接着用的那个会话正在进行中' });
  await runRoutine(ctx, r.id, 'schedule');
  assert.deepEqual([lastRun(r.id).status, lastRun(r.id).preview], ['skipped', '接着用的那个会话正在进行中，这次没有打断它。']);
  script.start.push({ ok: false, code: 'gone', error: '接着用的那个会话已经不在了' }, { ok: true, id: D2, runId: 'run-x' });
  await runRoutine(ctx, r.id, 'schedule');
  const starts = calls.filter((c) => c.op === 'routine').slice(-2);
  assert.deepEqual([starts[0].body.sessionId, starts[1].body.sessionId, starts[1].body.config.workspace], [D1, undefined, path.join(dir, 'p')]);
  assert.deepEqual([lastRun(r.id).status, lastRun(r.id).sessionId], ['ok', D2]);
  assert.equal(routines.get(dir, r.id).threadSessionId, D2, '下次续新开的那个');
});

test('失败处理：开不了（设置不认 / 连不上）记 error；结局 error / 停止 / 重启切断 / 记不清各有说法', async () => {
  const r = mk({ notify: true });
  script.start.push({ ok: false, code: 'config', error: 'unknown provider: nope' });
  await runRoutine(ctx, r.id, 'manual');
  assert.equal(lastRun(r.id).status, 'error');
  assert.match(lastRun(r.id).preview, /^dimensio 不认这条任务的设置：unknown provider: nope/);
  assert.equal(recentNotices(ctx.key).at(-1).kind, 'error', '失败也通知（同 Claude）');

  script.start.push(new Error('dimensio 没起来'));
  await runRoutine(ctx, r.id, 'manual');
  assert.deepEqual([lastRun(r.id).status, lastRun(r.id).preview], ['error', 'dimensio 没能开跑：dimensio 没起来']);

  const cases = [
    [{ outcome: 'error', text: 'provider 429' }, 'error', 'provider 429'],
    [{ outcome: 'aborted', by: 'user', text: '' }, 'stopped', '已停止'],
    [{ outcome: 'aborted', by: 'restart', text: '' }, 'stopped', /dimensio 重启，这次运行被中断/],
    [{ outcome: 'unknown', text: 'x' }, 'stopped', /结局没记下/],
  ];
  for (const [res, status, preview] of cases) {
    script.status.push({ ok: true, running: false, endedAt: Date.now(), ...res });
    await runRoutine(ctx, r.id, 'manual');
    assert.equal(lastRun(r.id).status, status, JSON.stringify(res));
    if (preview instanceof RegExp) assert.match(lastRun(r.id).preview, preview); else assert.equal(lastRun(r.id).preview, preview);
  }
  script.status.push({ ok: false, code: 'gone', error: '这个会话已经不在了' });
  await runRoutine(ctx, r.id, 'manual');
  assert.deepEqual([lastRun(r.id).status, lastRun(r.id).preview], ['error', 'dimensio 里的这个会话已经不在了。']);
});

test('等结局时问不到（dimensio 在重启）：隔一会儿接着问，问到了照常收尾', async () => {
  const r = mk();
  script.status.push(new Error('dimensio 没答（连不上）'), new Error('dimensio 没答（连不上）'), { ok: true, running: false, outcome: 'done', text: 'back', endedAt: Date.now() });
  await runRoutine(ctx, r.id, 'manual');
  assert.deepEqual([lastRun(r.id).status, lastRun(r.id).preview], ['ok', 'back']);
  assert.equal(calls.filter((c) => c.op === 'routine-status').length, 3);
});

test('这个身份没有 dimensio：不调 dimensio，记一条说明', async () => {
  const r = mk();
  await runRoutine({ ...ctx, allowDimensio: false }, r.id, 'manual');
  assert.equal(calls.length, 0);
  assert.deepEqual([lastRun(r.id).status, lastRun(r.id).agent, lastRun(r.id).preview], ['error', 'dimensio', 'dimensio 未启用或没有权限，这次没有运行。']);
  assert.equal(dimensioRoutineOk({ ...ctx, allowDimensio: false }), false);
  assert.equal(dimensioRoutineOk(ctx), true);
});

test('数据层：建 / 改 / 换引擎——换引擎作废接着用的会话、清掉另一边才有的设置；复制带上引擎与厂商', () => {
  const r = mk({ provider: 'kimi', model: 'k3', worktree: true, fast: true, shape: 'project', sessionMode: 'continue' });
  assert.deepEqual([r.agent, r.provider, r.model], ['dimensio', 'kimi', 'k3']);
  routines.update(dir, r.id, { threadSessionId: D1 });
  const same = routines.update(dir, r.id, { agent: 'dimensio', provider: 'openai', model: 'deepseek-v4' });
  assert.equal(same.threadSessionId, D1, '同一个引擎里换型号：接着用的会话照样续');
  const toClaude = routines.update(dir, r.id, { agent: 'claude', provider: undefined, model: null });
  assert.deepEqual([toClaude.agent, toClaude.provider, toClaude.threadSessionId, toClaude.permissionMode], ['claude', null, null, null]);
  routines.update(dir, r.id, { worktree: true, fast: true, permissionMode: 'acceptEdits' });
  const back = routines.update(dir, r.id, { agent: 'dimensio', permissionMode: 'plan' });
  assert.deepEqual([back.agent, back.worktree, back.fast, back.shape, back.permissionMode], ['dimensio', false, false, null, 'plan']);
  const dup = routines.duplicate(dir, r.id);
  assert.deepEqual([dup.agent, dup.enabled], ['dimensio', false]);
  const claude = routines.create(dir, { name: 'c', prompt: 'x', schedule: SCHED, provider: 'kimi' });
  assert.deepEqual([claude.agent, claude.provider], ['claude', null], 'Claude 任务不存厂商');
});

test('路由字段：dimensio 只查形状、型号跟着厂商走；运行档位按身份裁（全权只给主机身份）；Claude 那几项不收', () => {
  const { engineFields, codeFields } = _routineFields;
  assert.deepEqual(engineFields({ agent: 'dimensio', provider: 'custom-abc', model: 'accounts/x/models/y', effort: 'max' }),
    { agent: 'dimensio', provider: 'custom-abc', model: 'accounts/x/models/y', effort: 'max', search: false });
  assert.deepEqual(engineFields({ agent: 'dimensio', model: 'orphan', effort: 'ultra-high' }),
    { agent: 'dimensio', provider: undefined, model: undefined, effort: undefined, search: false }, '没厂商的型号不收；认不出的深度回默认');
  assert.equal(engineFields({ agent: 'dimensio', provider: 'has space' }).provider, undefined);
  // 只改 model：沿用任务现在的引擎与厂商（不能把 dimensio 任务翻回 Claude）
  assert.deepEqual(engineFields({ model: 'v5' }, { agent: 'dimensio', provider: 'openai' }), { agent: 'dimensio', provider: 'openai', model: 'v5', effort: undefined, search: false });
  assert.equal(engineFields({ model: 'x' }, { agent: 'claude' }).agent, 'claude');

  const admin = { kind: 'admin', key: 'admin', cwd: tmp, dataDir: tmp, shell: true };
  const member = { kind: 'user', user: 'm', key: 'u:m', cwd: tmp, dataDir: tmp, shell: true };
  assert.deepEqual(dimModesFor(admin), ['auto', 'read-only', 'plan', 'bypass']);
  assert.deepEqual(dimModesFor(member), ['auto', 'read-only', 'plan']);
  assert.equal(codeFields(admin, { permissionMode: 'bypass' }, 'dimensio').permissionMode, 'bypass');
  assert.throws(() => codeFields(member, { permissionMode: 'bypass' }, 'dimensio'), /你的账号不能选这个运行档位/);
  assert.throws(() => codeFields(admin, { permissionMode: 'acceptEdits' }, 'dimensio'), /运行档位/, 'Claude 的模式不是 dimensio 的档位');
  const out = codeFields(admin, { worktree: true, branch: 'main', fast: true, shape: 'project', sessionMode: 'continue', notify: true }, 'dimensio');
  assert.deepEqual(out, { sessionMode: 'continue', notify: true });
});

// —— 路由：GET 报能选的引擎；没开 dimensio 的身份建 dimensio 任务 403，老客户端的 Gemini 410 ——
function call(h, method, url, body) {
  return new Promise((resolve) => {
    const req = Readable.from(body != null ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0, chunks = '';
    const res = {
      headersSent: false, writableEnded: false,
      writeHead(s) { status = s; this.headersSent = true; return this; },
      setHeader() {}, write(c) { chunks += c; return true; },
      end(c) { if (c) chunks += c; this.writableEnded = true; let j = null; try { j = JSON.parse(chunks); } catch {} resolve({ status, body: j }); },
      on() {}, once() {},
    };
    h(req, res, new URL(url, 'http://x'));
  });
}

test('路由：测试环境没装 dimensio 扩展 → 身份上 allowDimensio 为假：GET 不列 dimensio，建 dimensio 任务 403；Gemini 410', async () => {
  const exact = {};
  registerRoutineRoutes({ on: (m, p, fn) => { exact[m + ' ' + p] = fn; } }, { identify: () => ({ kind: 'admin' }) });
  const g = await call(exact['GET /api/routines'], 'GET', '/api/routines');
  assert.equal(g.status, 200);
  assert.equal(g.body.engines.includes('dimensio'), false);
  assert.deepEqual(g.body.dimModes, []);
  const d = await call(exact['POST /api/routines'], 'POST', '/api/routines', { prompt: 'x', schedule: SCHED, agent: 'dimensio' });
  assert.deepEqual([d.status, d.body.error], [403, 'dimensio 未启用，或你的账号没有使用权限']);
  const v = await call(exact['POST /api/routines'], 'POST', '/api/routines', { prompt: 'x', schedule: SCHED, agent: 'vertex' });
  assert.equal(v.status, 410);
});
