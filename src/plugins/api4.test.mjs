// 插件接口四期第一批：事件订阅、Claude 钩子分发、审批策略、消息改写、每轮参数、给 dimensio 的工具 / 提示与 MCP 端点、
// ctx.net、ctx.oauth、模型请求中间件、工具结果卡片。不真起 Claude：直接调 pluginClaudeTurn 拿到的分发钩子与各个入口函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-api4-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const CT = await import('./claude-tools.mjs');
const { emitBridgeEvent, EVENT_NAMES } = await import('./events.mjs');
const { dimensioContributions, registerAgentMcpRoute, AGENT_MCP_PATH } = await import('./agent-mcp.mjs');
const MS = await import('../runtime/model-services.mjs');
const { ensureHostSecret } = await import('../runtime/host-secret.mjs');
const { createRouter } = await import('../runtime/router.mjs');

installMixins();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真路由器（MCP 端点与 OAuth 回调要真的收请求）
const router = createRouter();
kernel.provide('router', router);
let server, base;

let n = 0;
async function addPlugin(apply, extra = {}) {
  const id = 'v4-' + (++n);
  await kernel.register({ id, name: id, source: 'local', dir: tmp, pluginApi: 3, load: async () => ({ apply }), ...extra });
  return id;
}

const HOST = { kind: 'admin', sandbox: false, cwd: tmp, key: 'admin' };
const MEMBER = { kind: 'user', user: 'u1', name: 'alice', sandbox: true, cwd: tmp, key: 'u:u1' };
const SANDBOX = { kind: 'snap', sandbox: true, snap: { token: 'plugin-x-g1' }, cwd: tmp, key: 'c:plugin-x-g1' };
const turnOf = (ctx, extra = {}) => ({ kind: 'chat', ctx, snap: null, sessionId: 's1', ...extra });

test.before(async () => {
  await kernel.start();
  registerAgentMcpRoute(router);
  server = http.createServer((req, res) => router.dispatch(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();   // 测试收尾时别让它挂住进程
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server?.closeAllConnections?.(); await new Promise((r) => server ? server.close(() => r()) : r()); await kernel.stop(); try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  // 兜底：起过 HTTP 服务器 + 真路由器的这份测试在 Windows 上收尾后偶尔不退（活跃资源列表是空的，查不出是谁），结果都已输出，直接退
  setTimeout(() => process.exit(process.exitCode || 0), 500);
});

test('能力名都登记了', async () => {
  let c;
  await addPlugin((ctx) => { c = ctx; });
  for (const f of ['events', 'claude.hook', 'claude.permission', 'claude.input', 'claude.options', 'tools.agents', 'net', 'oauth', 'models.middleware']) assert.equal(c.has(f), true, f);
});

test('事件：按名订阅与 *，payload 是副本，处理出错不影响别人；停用后不再收', async () => {
  const got = [];
  let c;
  const id = await addPlugin((ctx) => {
    c = ctx;
    ctx.events.on('turn.end', (p) => { p.mutated = true; got.push(['end', p]); });
    ctx.events.on('*', (p, name) => { got.push(['*', name]); });
    ctx.events.on('turn.start', () => { throw new Error('炸'); });
  });
  assert.throws(() => c.events.on('bad name', () => {}), /事件名/);
  const payload = { sessionId: 's1', result: 'hi' };
  emitBridgeEvent('turn.start', { a: 1 });
  emitBridgeEvent('turn.end', payload);
  await sleep(20);
  assert.equal(payload.mutated, undefined, '插件改的是副本');
  assert.deepEqual(got.filter((g) => g[0] === '*').map((g) => g[1]), ['turn.start', 'turn.end']);
  const end = got.find((g) => g[0] === 'end')[1];
  assert.equal(end.event, 'turn.end');
  assert.equal(end.result, 'hi');
  assert.ok(EVENT_NAMES.includes('model.request'));
  await kernel.setEnabled(id, false);
  got.length = 0;
  emitBridgeEvent('turn.end', payload);
  await sleep(20);
  assert.equal(got.length, 0);
});

test('钩子：PreToolUse 拦截 / 改参数 / matcher，context 拼接，who 过滤，挂了哪些事件进签名', async () => {
  const id = await addPlugin((ctx) => {
    ctx.claude.hook('PreToolUse', (input) => (String(input.tool_input?.command || '').includes('rm -rf') ? { decision: 'deny', reason: '危险命令' } : undefined), { matcher: 'Bash' });
    ctx.claude.hook('PreToolUse', (input) => ({ input: { ...input.tool_input, file_path: '/safe/' + input.tool_input.file_path }, context: '改了路径' }), { matcher: 'Write|Edit' });
    ctx.claude.hook('UserPromptSubmit', (input, turn) => ({ context: `今天是好日子 · ${turn.owner.login}` }));
    ctx.claude.hook('Stop', () => ({ block: true, reason: '再检查一遍' }), { who: 'members' });
  });
  assert.throws(() => kernel.contextOf(id).claude.hook('Nope', () => {}), /不认识/);

  const plug = CT.pluginClaudeTurn(turnOf(HOST));
  assert.deepEqual(Object.keys(plug.hooks).sort(), ['PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.ok(plug.sig.some((x) => x[0] === 'hook' && x[1] === 'PreToolUse'));
  const pre = plug.hooks.PreToolUse[0].hooks[0];

  const deny = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, 't1', {});
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(deny.hookSpecificOutput.permissionDecisionReason, '危险命令');

  const okBash = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, 't2', {});
  assert.deepEqual(okBash, {});

  const w = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.txt' } }, 't3', {});
  assert.equal(w.hookSpecificOutput.updatedInput.file_path, '/safe/a.txt');
  assert.equal(w.hookSpecificOutput.additionalContext, '改了路径');

  const ups = await plug.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }, '', {});
  assert.equal(ups.hookSpecificOutput.additionalContext, '今天是好日子 · host');

  const stop = await plug.hooks.Stop[0].hooks[0]({ hook_event_name: 'Stop' }, '', {});
  assert.equal(stop.decision, 'block');

  // 成员：host 的钩子不给，members 的给
  const pm = CT.pluginClaudeTurn(turnOf(MEMBER));
  assert.deepEqual(Object.keys(pm.hooks), ['Stop']);
  // 快照访客：什么都不给
  assert.deepEqual(Object.keys(CT.pluginClaudeTurn({ kind: 'chat', ctx: { kind: 'snap', snap: { token: 'abc' } }, snap: { token: 'abc' } }).hooks), []);
  await kernel.setEnabled(id, false);
});

test('钩子：超时与抛错当没表态，不拖垮这一轮', async () => {
  const id = await addPlugin((ctx) => {
    ctx.claude.hook('PostToolUse', () => { throw new Error('炸'); });
    ctx.claude.hook('PostToolUse', () => new Promise(() => {}), { timeout: 50 });
    ctx.claude.hook('PostToolUse', () => ({ context: '第三个照样说话' }));
  });
  const plug = CT.pluginClaudeTurn(turnOf(HOST));
  const r = await plug.hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {} }, '', {});
  assert.equal(r.hookSpecificOutput.additionalContext, '第三个照样说话');
  await kernel.setEnabled(id, false);
});

test('审批策略：第一个表态的说了算；没表态回 null；who 过滤', async () => {
  const id = await addPlugin((ctx) => {
    ctx.claude.permission(({ tool }) => (tool === 'Read' ? undefined : undefined));
    ctx.claude.permission(({ tool, input }) => (tool === 'Bash' && /^git status/.test(input.command) ? 'allow' : tool === 'Bash' && /curl/.test(input.command) ? { deny: true, message: '别联网' } : undefined));
  });
  assert.equal((await CT.pluginPermission(turnOf(HOST), { tool: 'Bash', input: { command: 'git status' } })).behavior, 'allow');
  const d = await CT.pluginPermission(turnOf(HOST), { tool: 'Bash', input: { command: 'curl x' } });
  assert.equal(d.behavior, 'deny');
  assert.equal(d.message, '别联网');
  assert.equal(await CT.pluginPermission(turnOf(HOST), { tool: 'Write', input: {} }), null);
  assert.equal(await CT.pluginPermission(turnOf(MEMBER), { tool: 'Bash', input: { command: 'git status' } }), null, 'host 的策略不管成员');
  await kernel.setEnabled(id, false);
});

test('消息改写：依次叠、附件追加；每轮参数：合并、坏 env 跳过、子 agent 校验', async () => {
  const id = await addPlugin((ctx) => {
    ctx.claude.input(({ message }) => ({ message: message.replace('机密', '***') }));
    ctx.claude.input(() => ({ prepend: '[来自插件]', attachments: ['/tmp/a.png'] }));
    ctx.claude.options(() => ({ model: 'claude-opus-5-5', env: { MY_FLAG: '1', ANTHROPIC_API_KEY: 'x', HTTPS_PROXY: 'y' }, append: '多说一句', agents: { reviewer: { description: '审代码', prompt: '你是审稿人' }, Bad: { description: 'x', prompt: 'y' } } }));
    ctx.claude.options(() => ({ effort: 'high', settings: { foo: 1 }, additionalDirectories: ['D:/kb'] }), { who: 'all' });
  });
  const r = await CT.pluginInput(turnOf(HOST), { message: '这是机密', attachments: ['/tmp/b.txt'] });
  assert.equal(r.message, '[来自插件]\n\n这是***');
  assert.deepEqual(r.attachments, ['/tmp/b.txt', '/tmp/a.png']);
  assert.equal(r.changed, true);

  const o = await CT.pluginOptions(turnOf(HOST));
  assert.equal(o.model, 'claude-opus-5-5');
  assert.equal(o.effort, 'high');
  assert.deepEqual(o.env, { MY_FLAG: '1' });
  assert.deepEqual(Object.keys(o.agents), ['reviewer']);
  assert.deepEqual(o.additionalDirectories, ['D:/kb']);
  assert.deepEqual(o.append, ['多说一句']);
  assert.deepEqual(o.settings, { foo: 1 });
  // 插件沙箱只拿到 who:'all' 的那份
  const os2 = await CT.pluginOptions(turnOf(SANDBOX));
  assert.equal(os2.model, undefined);
  assert.equal(os2.effort, 'high');
  await kernel.setEnabled(id, false);
});

test('工具 agents 与卡片：只给 dimensio 的不进 Claude；ctx.tools.add 两边都给；render card 结果带标记', async () => {
  const id = await addPlugin((ctx) => {
    ctx.claude.tool({ name: 'only_claude', handler: () => 'c' });
    ctx.claude.tool({ name: 'only_dim', agents: ['dimensio'], access: 'read', handler: () => 'd' });
    ctx.tools.add({ name: 'both', description: '查天气', params: { city: { type: 'string', required: true } }, handler: ({ city }, turn) => ({ card: { title: city + ' 晴', fields: [{ label: '温度', value: '23°' }], image: 'javascript:alert(1)' } }) });
    ctx.claude.prompt('给 dimensio 的说明', { agents: ['dimensio'] });
  });
  assert.throws(() => kernel.contextOf(id).tools.add({ name: 'x', agents: ['codex'], handler: () => 1 }), /不认识/);
  const plug = CT.pluginClaudeTurn(turnOf(HOST));
  const key = CT.serverKeyOf(id);
  assert.ok(plug.mcpServers[key]);
  assert.ok(!plug.prompt.includes('给 dimensio 的说明'));
  const dim = dimensioContributions(turnOf(HOST));
  assert.deepEqual(dim.tools.map((t) => t.spec.name).sort(), ['both', 'only_dim']);
  assert.deepEqual(dim.prompts, ['给 dimensio 的说明']);

  const res = CT.toResult({ card: { title: '上海 晴', fields: [{ label: '温度', value: '23°' }], image: 'javascript:alert(1)' } });
  assert.equal(res.content[0].text, '上海 晴\n温度：23°');
  assert.ok(res.content[1].text.startsWith(CT.CARD_MARK));
  assert.equal(JSON.parse(res.content[1].text.slice(CT.CARD_MARK.length)).image, '', '只收 http(s) 与站内地址');
  await kernel.setEnabled(id, false);
});

test('MCP 端点：实例凭据才认；列出 dimensio 工具并能调用（只读带 readOnlyHint）', async () => {
  const id = await addPlugin((ctx) => {
    ctx.tools.add({ name: 'weather', access: 'read', params: { city: { type: 'string', required: true } }, handler: ({ city }, turn) => `${city}:${turn.agent}:${turn.ctx.kind}` });
  });
  const call = (body, tok) => fetch(base + AGENT_MCP_PATH, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body) });
  assert.equal((await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  const tok = ensureHostSecret();
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, tok);
  assert.equal(init.status, 200);
  const list = await (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tok)).json();
  const t = list.result.tools.find((x) => x.name === `${id.replace(/-/g, '_')}__weather`);
  assert.ok(t, JSON.stringify(list).slice(0, 300));
  assert.equal(t.annotations.readOnlyHint, true);
  const out = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: t.name, arguments: { city: '杭州' } } }, tok)).json();
  assert.equal(out.result.content[0].text, '杭州:dimensio:admin');
  // dimensio 回合回报 → 插件事件
  const got = [];
  const id2 = await addPlugin((ctx) => { ctx.events.on('turn.end', (p) => got.push(p)); });
  const ev = await fetch(base + '/agent/events', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: JSON.stringify({ event: 'turn.end', payload: { sessionId: 'd1', ok: true, agent: 'claude' } }) });
  assert.equal(ev.status, 200);
  await sleep(20);
  assert.equal(got[0].agent, 'dimensio', '来源不由回报方说了算');
  assert.equal(got[0].owner.kind, 'admin');
  await kernel.setEnabled(id, false);
  await kernel.setEnabled(id2, false);
});

test('ctx.net：proxy / fetch 时限', async () => {
  let c;
  await addPlugin((ctx) => { c = ctx; });
  assert.equal(typeof c.net.proxy(), 'string');
  const slow = http.createServer((req, res) => setTimeout(() => res.end('late'), 2000));
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  await assert.rejects(c.net.fetch('http://127.0.0.1:' + slow.address().port, { timeoutMs: 1000 }), /abort|timeout/i);
  slow.close();
});

test('ctx.oauth：start 跳转带 PKCE，callback 换令牌加密存，token 快过期自动刷新', async () => {
  const seen = [];
  const prov = http.createServer(async (req, res) => {
    let b = ''; for await (const ch of req) b += ch;
    const q = new URLSearchParams(b);
    seen.push(Object.fromEntries(q));
    res.setHeader('content-type', 'application/json');
    if (q.get('grant_type') === 'authorization_code') res.end(JSON.stringify({ access_token: 'A1', refresh_token: 'R1', expires_in: 30 }));
    else res.end(JSON.stringify({ access_token: 'A2', expires_in: 3600 }));
  });
  await new Promise((r) => prov.listen(0, '127.0.0.1', r));
  const pb = 'http://127.0.0.1:' + prov.address().port;
  let cl;
  const id = await addPlugin((ctx) => { cl = ctx.oauth.client('svc', { authorizeUrl: pb + '/auth', tokenUrl: pb + '/token', clientId: 'cid', scopes: ['a', 'b'], redirectOrigin: base }); });
  assert.equal(cl.status().connected, false);
  assert.equal(cl.redirectUri(), base + `/api/plugin-oauth/${id}/svc/callback`);
  const start = cl.startUrl(base);
  const r1 = await fetch(start, { redirect: 'manual' });
  assert.equal(r1.status, 302);
  const loc = new URL(r1.headers.get('location'));
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('scope'), 'a b');
  assert.equal((await fetch(start, { redirect: 'manual' })).status, 400, '启动链接只能用一次');
  const cb = await fetch(base + `/api/plugin-oauth/${id}/svc/callback?code=C1&state=` + loc.searchParams.get('state'));
  assert.equal(cb.status, 200);
  assert.equal(seen[0].code, 'C1');
  assert.ok(seen[0].code_verifier);
  assert.equal(cl.status().connected, true);
  // expires_in 30 秒 < 60 秒余量：取令牌时自动刷新
  assert.equal(await cl.token(), 'A2');
  assert.equal(seen[1].grant_type, 'refresh_token');
  assert.equal(seen[1].refresh_token, 'R1');
  cl.logout();
  assert.equal(cl.status().connected, false);
  prov.close();
  await kernel.setEnabled(id, false);
});

test('模型请求中间件：依次改、only own 只管自己的服务、出错不改', async () => {
  const id = await addPlugin((ctx) => {
    ctx.models.middleware(({ body }) => ({ ...body, temperature: 0.1 }));
    ctx.models.middleware(({ body }) => ({ ...body, mine: true }), { only: 'own' });
    ctx.models.middleware(() => { throw new Error('炸'); });
  });
  const out = await MS.applyModelMiddleware({ provider: { id: 'p-1', plugin: { id } }, model: { id: 'm' }, owner: 'admin', body: { a: 1 } });
  assert.deepEqual(out, { a: 1, temperature: 0.1, mine: true });
  const other = await MS.applyModelMiddleware({ provider: { id: 'p-2' }, model: { id: 'm' }, owner: 'admin', body: { a: 1 } });
  assert.deepEqual(other, { a: 1, temperature: 0.1 });
  await kernel.setEnabled(id, false);
  assert.equal(MS.hasModelMiddleware(), false, '停用后撤掉');
});
