// 插件接口 v3：沙箱身份、chat 结果码 / 通知分离 / 单轮工具 / 用量上限、文件读写、配置热更新与自写、previousVersion、
// 健康检查、定时任务、通知、插件日志、清单体检。执行器换成假的，不真起 Claude。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-api3-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const chat = await import('./chat.mjs');
const { panelView, refreshStatuses } = await import('./panel.mjs');
const { pluginLogs } = await import('./logs.mjs');
const { parseCron, nextCron, compileWhen, parseEvery } = await import('./schedule.mjs');
const { inspectManifest } = await import('./discover.mjs');
const { pluginClaudeTurn } = await import('./claude-tools.mjs');
const { PLUGIN_API_VERSION } = await import('./engines.mjs');
const push = await import('../runtime/push-notices.mjs');
const { HOST_OWNER } = await import('../runtime/principal.mjs');

installMixins();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); } return false; };

kernel.provide('router', { on: () => () => {}, use: () => () => {}, prefix: () => () => {}, has: () => false });

let n = 0;
async function addPlugin(apply, extra = {}) {
  const id = 'v3-' + (++n);
  await kernel.register({ id, name: id, source: 'local', dir: tmp, pluginApi: 3, load: async () => ({ apply }), ...extra });
  return id;
}

test.before(async () => { await kernel.start(); });
test.after(async () => { await kernel.stop(); chat._setTestRunner(null); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('契约：ctx.api / ctx.has / meta.pluginApi', async () => {
  let c;
  await addPlugin((ctx) => { c = ctx; });
  assert.equal(c.api, PLUGIN_API_VERSION);
  assert.equal(c.has('chat.sandbox'), true);
  assert.equal(c.has('teleport'), false);
  assert.equal(c.meta.pluginApi, 3);
});

test('沙箱：不用授权账号就能跑；结果码、通知与正文分开、format / tools / fast 传到执行器；会话续写', async () => {
  const seen = [];
  chat._setTestRunner(async (uctx, o) => {
    seen.push({ uctx, o });
    if (o.prompt === 'boom') return { sessionId: null, text: '炸了', isError: true, files: [] };
    return { sessionId: o.resume || 'sess-1', text: '⚠ 换了模型\n\n答：' + o.prompt, answer: '答：' + o.prompt, notes: ['换了模型'], isError: false, files: [], costUsd: 0.012 };
  });
  let c;
  const id = await addPlugin((ctx) => { c = ctx; });
  const ws = c.sandbox('g123');
  assert.equal(ws.name, 'g123');
  assert.ok(ws.dir.startsWith(path.join(tmp, 'plugin-data', id, 'sandboxes')));
  assert.throws(() => c.sandbox('../x'), /不合法/);

  const tools = [{ name: 'send_image', description: '发图', params: { path: { type: 'string', required: true } }, handler: async (a, t) => `${a.path}@${t.session}@${t.from.name}` }];
  const r1 = await c.chat.run({ as: ws, message: '你好', format: 'plain', fast: true, tools, from: { id: '42', name: '小明' } }).result;
  assert.equal(r1.ok, true);
  assert.equal(r1.code, 'ok');
  assert.equal(r1.text, '答：你好');
  assert.deepEqual(r1.notes, ['换了模型']);
  assert.equal(r1.usage.costUsd, 0.012);
  const o1 = seen[0].o;
  assert.equal(seen[0].uctx.kind, 'snap');
  assert.equal(seen[0].uctx.shell, false);
  assert.match(o1.append, /不渲染 Markdown/);
  assert.equal(o1.fast, true);
  assert.equal(o1.runTools.owner, id);
  // 单轮工具：经 pluginClaudeTurn 合进插件自己的 server（沙箱身份也给），handler 拿到这一轮的信息
  const plug = pluginClaudeTurn({ kind: 'plugin', ctx: seen[0].uctx, snap: null }, o1.runTools);
  assert.ok(plug.mcpServers[id], '单轮工具挂上了');
  assert.equal(await o1.runTools.tools[0].handler({ path: 'a.png' }), 'a.png@default@小明');

  // 第二轮续写同一会话
  await c.chat.run({ as: { sandbox: 'g123' }, message: '再来' }).result;
  assert.equal(seen[1].o.resume, 'sess-1');
  assert.equal(c.chat.sessionOf(ws, 'default'), 'sess-1');
  // 关联网
  await c.chat.run({ as: c.sandbox('nonet', { web: false }), message: 'x' }).result;
  assert.deepEqual(seen[2].o.disallowedTools, ['WebSearch', 'WebFetch']);
  // 出错 → engine
  const r2 = await c.chat.run({ as: ws, session: 's2', message: 'boom' }).result;
  assert.equal(r2.code, 'engine');
  assert.equal(r2.ok, false);
  // 用量记账：4 轮
  assert.equal(c.chat.usage().today.turns, 4);
  await refreshStatuses([id]);
  assert.equal(panelView(id).usage.today.turns, 4, '详情页自动有用量块');
  // 重置
  assert.equal(c.chat.reset(ws, 'default'), true);
  assert.equal(c.chat.sessionOf(ws), null);
});

test('chat：取消返回 cancelled；用量上限返回 budget', async () => {
  chat._setTestRunner(async (uctx, o) => {
    await new Promise((r) => { const t = setTimeout(r, 2000); o.signal?.addEventListener('abort', () => { clearTimeout(t); r(); }); });
    return { sessionId: 's', text: o.signal?.aborted ? '已停止' : 'ok', isError: !!o.signal?.aborted, aborted: !!o.signal?.aborted, files: [] };
  });
  let c;
  await addPlugin((ctx) => { c = ctx; });
  const t = c.chat.run({ as: { sandbox: 'a' }, message: 'x' });
  await sleep(50);
  t.stop();
  assert.equal((await t.result).code, 'cancelled');
  chat._setTestRunner(async () => ({ sessionId: 's', text: 'ok', isError: false, files: [] }));
  c.chat.configure({ daily: { turns: 2 } });
  assert.equal((await c.chat.run({ as: { sandbox: 'a' }, message: 'x' }).result).code, 'ok');
  const r = await c.chat.run({ as: { sandbox: 'a' }, message: 'x' }).result;
  assert.equal(r.code, 'budget');
  assert.match(r.text, /上限/);
});

test('ctx.files / 沙箱句柄：读写列删，越界和写 .bridge 都拒；v3 的 put 返回 Promise', async () => {
  let c;
  await addPlugin((ctx) => { c = ctx; });
  const ws = c.sandbox('files');
  await ws.write('群聊记录/2026-10-31.txt', '第一行\n');
  await ws.append('群聊记录/2026-10-31.txt', '第二行\n');
  assert.equal(await ws.read('群聊记录/2026-10-31.txt', { encoding: 'utf8' }), '第一行\n第二行\n');
  const ls = await ws.list('');
  assert.deepEqual(ls.map((x) => x.name), ['群聊记录']);
  await assert.rejects(ws.write('../evil.txt', 'x'), /越出/);
  await assert.rejects(ws.write('.bridge/claude/x', 'x'), /不能写/);
  const p = c.files.put(ws, Buffer.from('img'), 'a.png');
  assert.ok(p instanceof Promise);
  assert.ok(existsSync(await p));
  await ws.remove('群聊记录');
  assert.deepEqual(await ws.list(''), []);
});

test('配置热更新：登记 onConfig 不重启（进行中的东西不断）；返回 false 整个重启；插件 setConfig 改自己', async () => {
  let applies = 0, seenNext = null, accept = true, c;
  const id = await addPlugin((ctx) => {
    applies++;
    c = ctx;
    ctx.onConfig((next, prev) => { seenNext = { next, prev }; return accept; });
  }, { config: { paused: { type: 'boolean', default: false }, port: { type: 'integer', default: 1 } } });
  assert.equal(applies, 1);
  await kernel.setConfig(id, { paused: true });
  assert.equal(applies, 1, '没重启');
  assert.equal(c.config.paused, true);
  assert.equal(seenNext.prev.paused, false);
  accept = false;
  await kernel.setConfig(id, { paused: true, port: 2 });
  assert.equal(applies, 2, '返回 false 就整个重启');
  accept = true;
  const cfg = await c.setConfig({ paused: false });
  assert.equal(cfg.paused, false);
  assert.equal(cfg.port, 2, '没给的字段沿用');
  assert.equal(applies, 2);
  // apply 里调 setConfig 直接报错（会等自己）
  const bad = await addPlugin(async (ctx) => { await ctx.setConfig({}); });
  assert.equal(kernel.get(bad).status, 'error');
  assert.match(kernel.get(bad).error, /apply \/ onConfig 里不能改/);
});

test('meta.previousVersion：第一次 null，换版本后是上一版', async () => {
  let seen = [];
  const id = 'v3-ver';
  await kernel.register({ id, name: id, source: 'local', dir: tmp, version: '1.0.0', load: async () => ({ apply(ctx) { seen.push(ctx.meta.previousVersion); } }) });
  kernel.update(id, { version: '1.1.0' });
  await kernel.reload(id);
  assert.deepEqual(seen, [null, '1.0.0']);
});

test('ctx.process 健康检查：连续不过就重启，重启够了停在 unhealthy 并发事件', async () => {
  let healthy = false, h;
  const events = [];
  const id = await addPlugin((ctx) => {
    h = ctx.process.spawn('svc', {
      command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], maxRestarts: 1,
      health: { check: () => healthy, every: 5_000, failAfter: 1, grace: 0 },
    });
    h.on('unhealthy', (e) => events.push(e));
  });
  // every 最短 5 秒：直接调内部节拍太绕，这里缩短等待——用 until 等两次判定（约 10 秒）
  assert.ok(await until(() => h.state === 'running'));
  const pid1 = h.pid;
  assert.ok(await until(() => events.length >= 1, 9000), '第一次不健康');
  assert.equal(events[0].givenUp, false);
  assert.ok(await until(() => h.state === 'running' && h.pid && h.pid !== pid1, 8000), '重启了');
  assert.ok(await until(() => events.some((e) => e.givenUp), 9000), '重启一次还不行就放弃');
  assert.equal(h.state, 'unhealthy');
  assert.equal(h.info().health.ok, false);
  healthy = true;
  assert.ok(await until(() => h.state === 'running', 9000), '恢复了回到 running');
  await kernel.setEnabled(id, false);
});

test('ctx.schedule：cron / daily / every 的下次时间；dev 任务到点就跑并记结果', async () => {
  const c = parseCron('30 4 * * 1-5');
  const from = new Date(2026, 9, 31, 12, 0).getTime();   // 周六
  const nx = new Date(nextCron(c, from));
  assert.equal(nx.getDay(), 1);
  assert.equal(nx.getHours(), 4);
  assert.equal(nx.getMinutes(), 30);
  assert.throws(() => parseCron('* * *'), /五段/);
  assert.equal(parseEvery('2h'), 7_200_000);
  assert.equal(parseEvery(5), 10_000, '最短 10 秒');
  const d = compileWhen({ daily: '04:00' });
  assert.equal(new Date(d.next(new Date(2026, 9, 31, 3, 59).getTime())).getHours(), 4);
  assert.throws(() => compileWhen({ daily: '25:00' }), /写法不对/);

  let runs = 0, c2, job;
  const id = await addPlugin((ctx) => {
    c2 = ctx;
    job = ctx.schedule('tick', { every: 10_000, dev: true, immediate: true, label: '清理' }, () => { runs++; if (runs === 2) throw new Error('第二次失败'); });
  });
  assert.ok(await until(() => runs === 1));
  await refreshStatuses([id]);
  const s = panelView(id).schedules[0];
  assert.equal(s.label, '清理');
  assert.ok(s.lastRun);
  assert.equal(s.lastOk, true);
  // 再跑一次：失败记进状态与插件日志，不影响下次
  await job.runNow();
  assert.equal(job.info().lastOk, false);
  assert.equal(job.info().lastError, '第二次失败');
  assert.ok(pluginLogs(id, { level: 'warn' }).some((l) => /第二次失败/.test(l.text)));
  assert.throws(() => c2.schedule('tick', { every: '1m' }, () => {}), /重复/);
  // 不是 dev 的任务在非正式实例不跑
  let prodRuns = 0;
  await addPlugin((ctx) => { ctx.schedule('p', { every: 10_000, immediate: true }, () => { prodRuns++; }); });
  await sleep(100);
  assert.equal(prodRuns, 0);
  await kernel.setEnabled(id, false);
});

test('ctx.notify：进手机通知与界面提示，10 分钟内同一条去重', async () => {
  let c;
  await addPlugin((ctx) => { c = ctx; });
  const before = push.recentPushes(HOST_OWNER).length;
  assert.equal(c.notify({ title: 'QQ 掉线了', body: '请扫码' }).sent, true);
  assert.equal(c.notify({ title: 'QQ 掉线了', body: '请扫码' }).sent, false);
  const after = push.recentPushes(HOST_OWNER);
  assert.equal(after.length, before + 1);
  assert.match(after[after.length - 1].message, /QQ 掉线了 — 请扫码/);
});

test('插件日志：ctx.log / warn / error 进插件自己的环形日志', async () => {
  const id = await addPlugin((ctx) => { ctx.log('你好', { a: 1 }); ctx.warn('小心'); });
  const all = pluginLogs(id);
  assert.ok(all.some((l) => l.level === 'info' && /你好 \{ a: 1 \}/.test(l.text)));
  assert.deepEqual(pluginLogs(id, { level: 'warn' }).map((l) => l.text), ['小心']);
  assert.ok(existsSync(path.join(tmp, 'plugin-data', id, 'logs', 'plugin.log')));
  // 启用失败也记在插件名下
  const bad = await addPlugin(() => { throw new Error('起不来'); });
  assert.ok(pluginLogs(bad).some((l) => /起不来/.test(l.text)));
});

test('清单体检：不认识的字段、控件、能力；内部接口；没写 pluginApi；英文词条', () => {
  const dir = path.join(tmp, 'lintme');
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  mkdirSync(path.join(dir, 'locales'), { recursive: true });
  writeFileSync(path.join(dir, 'lib', 'x.mjs'), "import { contextFor } from '@bridge/core/runtime/identity.mjs';\n");
  writeFileSync(path.join(dir, 'locales', 'en.json'), JSON.stringify({ name: 'Lint me' }));
  const m = { id: 'lintme', nmae: 'typo', config: { a: { type: 'string', widget: 'knob' } }, permissions: ['chat', 'teleport'] };
  const r = inspectManifest(m, dir, 'local');
  assert.ok(r.lint.some((x) => /nmae/.test(x)));
  assert.ok(r.lint.some((x) => /knob/.test(x)));
  assert.ok(r.lint.some((x) => /teleport/.test(x)));
  assert.ok(r.lint.some((x) => /pluginApi/.test(x)));
  assert.ok(r.lint.some((x) => /内部接口/.test(x)));
  assert.deepEqual(r.internal, ['runtime/identity.mjs']);
  assert.deepEqual(r.permissions.map((p) => p.id), ['chat']);
  assert.equal(r.i18n.en.name, 'Lint me');
});

test('沙箱只读资料目录：能读、不能写；隐藏项、像密钥的文件、含隐藏项的整目录搜索都拒', async () => {
  const { sandboxFence, makeSandboxPreToolUse } = await import('../agents/claude.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const kb = path.join(tmp, 'kb');
  mkdirSync(path.join(kb, 'docs'), { recursive: true });
  mkdirSync(path.join(kb, 'memory'), { recursive: true });
  writeFileSync(path.join(kb, 'docs', 'faq.md'), 'q');
  writeFileSync(path.join(kb, 'memory', 'secret.md'), 's');
  let seen = null;
  chat._setTestRunner(async (uctx, o) => { seen = { uctx, o }; return { sessionId: 's', text: 'ok', isError: false, files: [] }; });
  let c;
  await addPlugin((ctx) => { c = ctx; });
  const ws = c.sandbox('kbtest', { readDirs: [{ dir: kb, hide: ['memory'] }, path.join(tmp, 'nope-not-exist')] });
  assert.deepEqual(ws.options.readDirs, [{ dir: kb, hide: ['memory'] }], '不存在的目录跳过');
  await c.chat.run({ as: ws, message: 'x' }).result;
  const u = seen.uctx;
  assert.deepEqual(u.readRoots, [{ root: kb, hide: ['memory'] }]);
  assert.match(seen.o.append, /资料目录（只读）/);
  const f = (name, input) => sandboxFence(u, name, input);
  assert.equal(f('Read', { file_path: path.join(kb, 'docs', 'faq.md') }), null, '能读');
  assert.equal(f('Grep', { path: path.join(kb, 'docs'), pattern: 'q' }), null, '子目录能搜');
  assert.match(f('Read', { file_path: path.join(kb, 'memory', 'secret.md') }), /不对外开放/);
  assert.match(f('Grep', { path: kb, pattern: 'q' }), /不能整个搜/);
  assert.match(f('Read', { file_path: path.join(kb, 'docs', 'config.json') }), /不对外开放/);
  assert.ok(f('Write', { file_path: path.join(kb, 'docs', 'faq.md'), content: 'x' }), '写照拦');
  assert.ok(f('Read', { file_path: path.join(tmp, 'plugins.json') }), '资料目录外照拦');
  const hook = makeSandboxPreToolUse(u);
  const r = await hook({ tool_name: 'Read', tool_input: { file_path: path.join(kb, 'docs', 'faq.md') } });
  assert.equal(r.continue, true);
});
