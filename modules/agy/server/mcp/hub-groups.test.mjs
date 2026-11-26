// 工具中枢新增的六组（会话协作 / 手机操控 / 拉取请求 / 项目记忆 / 插件工具 / 远程连接器）：
// 清单预算、审批口径、180 秒上限、工具指纹、确认卡、投递口、手机设备锁定、远程连接器代连与鉴权。用假 agy（fake-acp-agent）与假手机跑。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.resolve(HERE, '..', 'testing', 'fake-acp-agent.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-groups-'));
const dataRoot = path.join(tmp, 'data');
const usersRoot = path.join(tmp, 'users');
const vaultDir = path.join(tmp, 'vault');
const agyHome = path.join(tmp, 'agy-home');
const stateFile = path.join(tmp, 'fake-acp-state.json');
for (const d of [path.join(dataRoot, 'agy'), usersRoot, vaultDir, path.join(agyHome, '.gemini', 'antigravity-cli')]) mkdirSync(d, { recursive: true });
const MASTER = 'agy-groups-master-token-1234567890';
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ port: 18997, token: MASTER, vaultPath: vaultDir, usersRoot, phoneControl: true, features: { multiUser: true } }, null, 2));
process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = usersRoot;
process.env.VAULT_PATH = vaultDir;
process.env.AGY_HOME_DIR = agyHome;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';
process.env.AGY_BIN = FAKE_AGENT;
process.env.AGY_NO_WARMUP = '1';
process.env.FAKE_ACP_STATE_FILE = stateFile;

const { loadModules, registerModuleRoutes } = await import('@bridge/core/modules/registry.mjs');
await loadModules();
const { createRouter } = await import('@bridge/core/runtime/router.mjs');
const { registerChatRoutes } = await import('@bridge/core/routes/chat.mjs');
const { createAuth } = await import('@bridge/core/auth.mjs');
const { makeIdentify, contextFor } = await import('@bridge/core/runtime/identity.mjs');
const { findGenBySession } = await import('@bridge/core/runtime/gen.mjs');
const users = await import('@bridge/core/users.mjs');
const { AcpClient, setAcpClientForTest, shutdownAgy } = await import('../acp/index.mjs');
const hub = await import('./hub.mjs');
const { bridgeToolAutoAllow } = await import('./approval.mjs');
const { setReadOnlyTools, _resetAutoAllowForTest } = await import('./auto-allow.mjs');
const { askAgyUser, answerBridgeQuestion, takeManualApproval } = await import('./ask.mjs');
const { deliverToAgy, RELAY_NOTE } = await import('./deliver.mjs');
const { agyGenKey } = await import('../presence.mjs');
const { listQueue, _resetQueuesForTest } = await import('../queue.mjs');
const { buildAgySessionTooling } = await import('./config.mjs');
const { agyMemoryProjectId } = await import('./groups/project.mjs');
const { _setTokenReaderForTest, authHeaders, _resetRemoteCacheForTest } = await import('./groups/remote.mjs');
const { _resetPhoneCacheForTest } = await import('./groups/phone.mjs');

setAcpClientForTest(new AcpClient({ daemonCwd: path.join(dataRoot, 'agy', 'daemon-cwd'), logFile: path.join(dataRoot, 'agy', 'acp.log'), env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile, AGY_HOME_DIR: agyHome } }));
const auth = createAuth(MASTER, false, { isAdminSession: (t, g) => users.isAdminSession(t, g), isUserSession: (t) => !!users.getSession(t) });
const identify = makeIdentify({ authOk: auth.authOk, getCookie: auth.getCookie, bearerToken: auth.bearerToken, queryToken: auth.queryToken });
const router = createRouter();
registerChatRoutes(router, { authOk: auth.authOk, identify });
registerModuleRoutes(router, { authOk: auth.authOk, identify });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
server.unref();
const BASE = `http://127.0.0.1:${server.address().port}`;
const HEADERS = { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json', connection: 'close' };
const ctx = contextFor({ kind: 'admin' });
const cost = (t) => hub.agyTokenEstimate(t.description) + hub.agyTokenEstimate(t.inputSchema);
const textOf = (r) => (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeGen = (sid, extra = {}) => ({ agent: 'agy', sessionId: sid, cwd: vaultDir, events: [], subscribers: new Set(), abort: new AbortController(), done: false, userText: 'hi', ...extra });

// 一轮 agy 对话（假 agy）：返回会话 id，wait=true 时等它跑完
async function agyChat(message, { cwd = vaultDir, sessionId } = {}) {
  const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ agent: 'agy', message, cwd, ...(sessionId ? { sessionId } : {}) }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let sid = '';
  const done = (async () => {
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const m = /"type":"session","sessionId":"([^"]+)"/.exec(buf);
      if (m) sid = m[1];
    }
  })();
  for (let i = 0; i < 200 && !sid; i++) await sleep(20);
  return { sid, done };
}

after(async () => {
  shutdownAgy();
  server.closeAllConnections?.();
  await new Promise((r) => server.close(() => r()));
  // 同 agy-bridge.test.mjs：users/_system 下的账号库句柄还开着，整个删会卡住进程，只清里面的东西
  try {
    for (const top of readdirSync(tmp)) {
      const full = path.join(tmp, top);
      if (top !== 'users') { rmSync(full, { recursive: true, force: true }); continue; }
      for (const e of readdirSync(full)) {
        const f = path.join(full, e);
        if (e === '_system') { for (const sub of readdirSync(f)) rmSync(path.join(f, sub), { recursive: true, force: true }); } else rmSync(f, { recursive: true, force: true });
      }
    }
  } catch {}
});

test('清单预算：六组都挂上后中枢总量仍压在 8000 以内，大工具给精简定义、名字都是 agy 认得的小写下划线', async () => {
  hub._clearHubCacheForTest();
  const tools = await hub.listHubTools(ctx, {});
  const names = tools.map((t) => t.name);
  // 拉取请求六样、项目记忆三样各合并成一个按 action 分派的工具（catalog.mjs），原名不再单独列出
  for (const want of ['start_session', 'send_message', 'list_sessions', 'read_session', 'dismiss_task', 'phone_control', 'pr', 'project_memory']) {
    assert.ok(names.includes(want), `应列出 ${want}，实际：${names.join(' ')}`);
  }
  for (const gone of ['pr_status', 'pr_bind', 'pr_set_auto_merge', 'project_memory_read', 'project_memory_delete']) assert.equal(names.includes(gone), false, gone);
  const pr = tools.find((t) => t.name === 'pr');
  assert.deepEqual(pr.inputSchema.properties.action.enum, ['status', 'bind', 'unbind', 'sync_base', 'set_monitor', 'set_auto_merge']);
  // 成员的参数一个都不能少（agy 把 properties 当封闭表）
  for (const k of ['url', 'base', 'abort', 'auto_fix', 'enabled', 'merge_method']) assert.ok(pr.inputSchema.properties[k], `pr 缺参数 ${k}`);
  assert.deepEqual(pr.inputSchema.required, ['action']);
  assert.deepEqual(tools.find((t) => t.name === 'project_memory').inputSchema.properties.action.enum, ['read', 'write', 'delete']);
  for (const n of names) assert.match(n, /^[a-z0-9_]+$/, n);
  const total = tools.reduce((a, t) => a + cost(t), 0);
  assert.ok(total < 8000, `中枢工具总量 ${total} 太大`);
  const fresh = new Set(['start_session', 'send_message', 'list_sessions', 'read_session', 'dismiss_task', 'phone_control', 'pr', 'project_memory']);
  const added = tools.filter((t) => fresh.has(t.name)).reduce((a, t) => a + cost(t), 0);
  for (const t of tools) if (fresh.has(t.name)) assert.ok(cost(t) <= 600, `${t.name} 精简后还有 ${cost(t)}`);
  assert.ok(added < 2000, `新增六组共 ${added}`);
  // 合并工具的完整说明：按 action 分节给原工具的说明与参数
  const prDocs = textOf(await hub.callHubTool(ctx, null, await hub.resolveHubTool(ctx, {}, 'tool_docs'), { name: 'pr' }));
  assert.match(prDocs, /## action: "set_auto_merge"/);
  assert.match(prDocs, /merge_method/);
  // action 不认识：直接回错，不落到别的工具上
  const bad = await hub.callHubTool(ctx, fakeGen('s-bad'), await hub.resolveHubTool(ctx, {}, 'project_memory'), { action: 'nuke', name: 'x.md' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /read \/ write \/ delete/);
  const phone = tools.find((t) => t.name === 'phone_control');
  assert.match(phone.description, /tool_docs/);
  assert.ok(phone.inputSchema.properties.action.enum.includes('send_sms'));
  // 说明与返回里不该有 Claude 才有的名字
  for (const t of tools) assert.ok(!/mcp__|AskUserQuestion/.test(t.description), `${t.name}：${t.description.slice(0, 80)}`);
  const docs = await hub.callHubTool(ctx, null, await hub.resolveHubTool(ctx, {}, 'tool_docs'), { name: 'phone_control' });
  assert.match(textOf(docs), /send_sms：/);
  assert.ok(!/AskUserQuestion|mcp__/.test(textOf(docs)));
  // 关掉开关的组不列
  const off = (await hub.listHubTools(ctx, { bridgeTools: { sessions: false, phoneControl: false, pr: false, projectMemory: false } })).map((t) => t.name);
  for (const n of ['start_session', 'phone_control', 'pr', 'project_memory']) assert.equal(off.includes(n), false, n);
  assert.equal(await hub.resolveHubTool(ctx, { bridgeTools: { pr: false } }, 'pr'), null);
  assert.match(hub.hubToolUnavailableReason(ctx, { bridgeTools: { phoneControl: false } }, 'phone_control'), /Bridge 工具 里打开/);
  assert.match(hub.hubToolUnavailableReason(ctx, { bridgeTools: { pr: false } }, 'pr'), /Bridge 工具 里打开/);
  assert.match(hub.hubToolUnavailableReason(ctx, { bridgeTools: { projectMemory: false } }, 'project_memory'), /Bridge 工具 里打开/);
  assert.match(hub.hubToolUnavailableReason(ctx, { bridgeTools: { sessions: false } }, 'start_session'), /Bridge 工具 里打开/);
});

test('整份清单：本地工具与中枢工具一起精简、合并、夹进份额；手机文件合成 phone_files，tool_docs 也查得到本地工具', async () => {
  hub._clearHubCacheForTest();
  const { AGY_BRIDGE_SHARE, agyDeclUnits } = await import('./catalog.mjs');
  const r = await hub.listAgyBridgeCatalog(ctx, {}, { categories: ['media', 'ui', 'phone', 'hub'] });
  const localNames = r.local.map((t) => t.name);
  assert.ok(localNames.includes('phone_files'), localNames.join(' '));
  assert.equal(localNames.some((n) => /^phone_(list|read|write|scan|delete)$/.test(n)), false);
  assert.deepEqual(r.withheld, []);
  assert.ok(r.total <= AGY_BRIDGE_SHARE && r.total === [...r.local, ...r.hub].reduce((a, t) => a + agyDeclUnits(t), 0));
  // 本地大工具也是精简版（以前只精简中枢工具，媒体工具原样进清单）
  assert.match(r.local.find((t) => t.name === 'media_image').description, /tool_docs/);
  const docs = textOf(await hub.callHubTool(ctx, null, await hub.resolveHubTool(ctx, {}, 'tool_docs'), { name: 'phone_files' }));
  assert.match(docs, /## action: "delete"/);
  assert.match(textOf(await hub.callHubTool(ctx, null, await hub.resolveHubTool(ctx, {}, 'tool_docs'), { name: 'media_image' })), /## 参数/);
  // 只开中枢：本地一样都不列
  assert.deepEqual((await hub.listAgyBridgeCatalog(ctx, {}, { categories: ['hub'] })).local, []);
});

test('审批口径：只看 / 只问的免卡；开会话、发消息、动手机、改 PR、远程连接器、插件写工具照常问；只认 name 字段', () => {
  const allow = (name, args = {}) => bridgeToolAutoAllow({ name: 'mcp_bridge_' + name, args });
  for (const n of ['list_sessions', 'read_session', 'dismiss_task', 'pr_status', 'project_memory_read', 'project_memory_write']) assert.equal(allow(n), true, n);
  for (const n of ['start_session', 'send_message', 'pr_bind', 'pr_unbind', 'pr_sync_base', 'pr_set_monitor', 'pr_set_auto_merge', 'ext_github_create_issue', 'plugin_x_write']) assert.equal(allow(n), false, n);
  for (const a of ['devices', 'screen', 'recall', 'wait', 'confirm']) assert.equal(allow('phone_control', { action: a }), true, a);
  for (const a of ['tap', 'input', 'send_sms', 'call', 'open_app', 'clipboard_set', '']) assert.equal(allow('phone_control', { action: a }), false, a);
  // 合并工具按 action 换回原工具判：口径与合并前一样，action 不认识就要审批
  assert.equal(allow('pr', { action: 'status' }), true);
  for (const a of ['bind', 'sync_base', 'set_auto_merge', 'nuke', '']) assert.equal(allow('pr', { action: a }), false, a);
  for (const a of ['read', 'write', 'delete']) assert.equal(allow('project_memory', { action: a }), true, a);
  for (const a of ['list', 'read', 'scan']) assert.equal(allow('phone_files', { action: a }), true, a);
  for (const a of ['write', 'delete', '']) assert.equal(allow('phone_files', { action: a }), false, a);
  // 标题里带工具名不算
  assert.equal(bridgeToolAutoAllow({ name: '', title: 'Run mcp_bridge_list_sessions', args: {} }), false);
  assert.equal(bridgeToolAutoAllow({ name: 'mcp_bridge_1a2b3c4d_pr_status', args: {} }), false);
  _resetAutoAllowForTest();
  setReadOnlyTools('plugins', ['plugin_demo_read']);
  assert.equal(allow('plugin_demo_read'), true);
  assert.equal(allow('plugin_demo_write'), false);
  _resetAutoAllowForTest();
});

test('180 秒上限：会等的组整次调用夹在 150 秒内，到点回「还没好」而不是让 agy 判超时', async () => {
  for (const key of ['phone', 'pr']) assert.ok(hub.hubGroupOf(key).budgetMs <= hub.AGY_CALL_BUDGET_SEC * 1000, key);
  const r = await hub.withinBudget(new Promise(() => {}), 30, 'phone_control');
  assert.equal(r.isError, true);
  assert.match(textOf(r), /上限还没结束/);
  const ok = await hub.withinBudget(Promise.resolve({ content: [{ type: 'text', text: 'done' }] }), 1000, 'x');
  assert.equal(textOf(ok), 'done');
});

test('确认卡：照 agy 的提问卡格式发进这一轮、经 /api/agy/question 答；120 秒封顶；审批卡上手动允许过的不再问', async () => {
  const gen = fakeGen('sess-ask-1');
  const p = askAgyUser(ctx, gen, { message: '要发短信吗', detail: '给 10086' });
  const q = gen.events.find((e) => e.type === 'question');
  assert.ok(q && q.requestId.startsWith('bq-') && q.fields[0].kind === 'single');
  assert.equal(gen.pendingQuestion, q);
  const r = await fetch(`${BASE}/api/agy/question`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ requestId: q.requestId, action: 'accept', content: { decision: 'allow' } }) });
  assert.equal(r.status, 200);
  assert.equal(await p, 'allow');
  assert.ok(gen.events.some((e) => e.type === 'question-resolved' && e.requestId === q.requestId && e.action === 'accept'));
  assert.equal(gen.pendingQuestion, null);
  // 取消 = 不允许；超时 = timeout；这一轮停了 = gone
  const p2 = askAgyUser(ctx, gen, { message: 'x' });
  answerBridgeQuestion(ctx, gen.events.filter((e) => e.type === 'question').at(-1).requestId, { action: 'cancel' });
  assert.equal(await p2, 'deny');
  assert.equal(await askAgyUser(ctx, gen, { message: 'x', timeoutMs: 1_000 }), 'timeout');
  const p3 = askAgyUser(ctx, gen, { message: 'x' });
  gen.abort.abort();
  assert.equal(await p3, 'gone');
  // 等多久都夹在 120 秒内（agy 单次调用 180 秒硬上限）
  const { ASK_MAX_MS } = await import('./ask.mjs');
  assert.ok(ASK_MAX_MS <= 120_000);
  // 不是 bridge 的卡：交回 ACP
  assert.equal(answerBridgeQuestion(ctx, 'acp-123', {}), null);

  // 审批卡上手动允许（非自动）且参数对得上：认一次；自动放行的、拒绝的不算
  const g2 = fakeGen('sess-ask-2', { events: [
    { type: 'permission', requestId: 'r1', toolCall: { name: 'mcp_bridge_phone_control', args: { action: 'send_sms', to: '1' } } },
    { type: 'permission-resolved', requestId: 'r1', outcome: 'selected', optionId: 'allow_once' },
    { type: 'permission', requestId: 'r2', toolCall: { name: 'mcp_bridge_pr_set_auto_merge', args: { enabled: true } } },
    { type: 'permission-resolved', requestId: 'r2', outcome: 'selected', optionId: 'reject_once' },
    { type: 'permission-resolved', requestId: 'r3', outcome: 'selected', optionId: 'allow_once', auto: true },
    // 合并后的 pr 工具：审批卡上是 mcp_bridge_pr + action，按 action 认回原工具
    { type: 'permission', requestId: 'r4', toolCall: { name: 'mcp_bridge_pr', args: { action: 'set_monitor', auto_fix: true } } },
    { type: 'permission-resolved', requestId: 'r4', outcome: 'selected', optionId: 'allow_once' },
  ] });
  assert.equal(takeManualApproval(g2, 'phone_control', { action: 'call' }), false);
  assert.equal(takeManualApproval(g2, 'phone_control', { action: 'send_sms' }), true);
  assert.equal(takeManualApproval(g2, 'phone_control', { action: 'send_sms' }), false, '同一张审批只认一次');
  assert.equal(takeManualApproval(g2, 'pr_set_auto_merge', { enabled: true }), false);
  assert.equal(takeManualApproval(g2, 'pr_set_auto_merge', { auto_fix: true }), false, '别的 action 不算');
  assert.equal(takeManualApproval(g2, 'pr_set_monitor', { auto_fix: true }), true);
});

test('投递口：会话空闲时无头开一轮（标明是 bridge 转来的），在跑时排进它的队或回 busy', async () => {
  _resetQueuesForTest();
  const first = await agyChat('第一句');
  assert.ok(first.sid);
  await first.done;
  const genKey = agyGenKey(ctx.key);
  const r = await deliverToAgy(ctx, first.sid, '<side-sessions-event>汇报</side-sessions-event>');
  assert.deepEqual(r, { ok: true, how: 'woke' });
  const g = findGenBySession(genKey, first.sid);
  assert.ok(g && String(g.userText).startsWith(RELAY_NOTE) && g.userText.includes('side-sessions-event'));
  await g.settled;

  const slow = await agyChat('[SLOW] 慢慢做', { sessionId: first.sid });
  await sleep(50);
  assert.deepEqual(await deliverToAgy(ctx, first.sid, 'CI 失败了', { ifBusy: 'busy' }), { ok: false, busy: true, reason: '那个会话正在跑' });
  assert.deepEqual(await deliverToAgy(ctx, first.sid, '子会话的消息'), { ok: true, how: 'queued' });
  assert.equal(listQueue(genKey, first.sid).length, 1);
  assert.match(listQueue(genKey, first.sid)[0].text, /bridge 自动转来/);
  await fetch(`${BASE}/api/agy/stop`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ sessionId: first.sid }) });
  await slow.done;
  _resetQueuesForTest();
  assert.deepEqual(await deliverToAgy(ctx, 'no-such-session', 'x'), { ok: false, gone: true, reason: '找不到这个 Antigravity 会话（可能已删除）' });
});

test('会话协作：父会话是 agy 时，状态 / 标题 / 汇报 / 唤醒都走 agy 的口，转去的话里不再有 Claude 的工具名', async () => {
  const fam = await import('@bridge/core/runtime/session-family.mjs');
  const parent = 'aaaaaaaa-1111-2222-3333-444444444444';
  const child = 'bbbbbbbb-1111-2222-3333-444444444444';
  fam.addLink(ctx, child, { parent, parentTitle: 'agy 会话', title: '子任务', name: 'sub', kind: 'fresh', parentAgent: 'agy' });
  assert.equal(fam.familyLink(ctx, child).parentAgent, 'agy');
  const f = await fam.linkedSessions(ctx, child, { reports: true });
  assert.equal(f.parent.agent, 'agy');
  assert.equal(f.parent.state, 'idle');
  // 子会话发给父会话：没有这个 agy 会话的元数据 → 投递失败如实回报（不会拿 agy 的会话 id 去续一个 Claude 会话）
  const r = await fam.sendToSession(ctx, child, 'parent', '我做完了');
  assert.equal(r.ok, false);
  assert.match(r.reason, /找不到这个 Antigravity 会话/);
  // 开子会话：参数不全照实拒；agy 的工具不出卡片，等用户点卡的那两种在「先问我」档下不开
  const sessions = hub.hubGroupOf('sessions');
  const gen = fakeGen(parent, { userText: `${RELAY_NOTE}\n\n<side-sessions-event>` });
  const target = await hub.resolveHubTool(ctx, {}, 'start_session');
  const relay = await hub.callHubTool(ctx, gen, target, { title: 't', prompt: 'p', background: 'b'.repeat(90) });
  assert.match(textOf(relay), /不是用户发起的/);
  const human = fakeGen(parent);
  const offer = await hub.callHubTool(ctx, human, target, { title: 't', prompt: 'p', background: 'b'.repeat(90), initiation: 'offer' });
  assert.match(textOf(offer), /先在对话里问一句/);
  const short = await hub.callHubTool(ctx, human, target, { title: 't', prompt: 'p', background: '短' });
  assert.match(textOf(short), /background 至少 80/);
  assert.ok(sessions.bare);
  const listed = await hub.callHubTool(ctx, human, await hub.resolveHubTool(ctx, {}, 'list_sessions'), {});
  assert.match(textOf(listed), /子任务 — id: bbbbbbbb/);
});

test('会话协作：Claude 子会话收工 → 汇报转进 agy 父会话并无头开一轮；agy 在跑时子会话的消息排进它的队', async () => {
  const fam = await import('@bridge/core/runtime/session-family.mjs');
  _resetQueuesForTest();
  const parent = await agyChat('开个子会话');
  await parent.done;
  const child = 'dddddddd-1111-2222-3333-444444444444';
  fam.addLink(ctx, child, { parent: parent.sid, parentTitle: 'agy', title: '查资料', name: 'research', kind: 'fresh', parentAgent: 'agy' });
  // 子会话这一轮是父会话派的：收尾时给父会话放一条汇报，1.5 秒后唤醒
  fam.familyTurnEnded(ctx, { sessionId: child, family: { origin: { kind: 'spawn', from: [parent.sid] } }, events: [{ type: 'done', result: '查完了，结论是 42' }] });
  const genKey = agyGenKey(ctx.key);
  let g = null;
  for (let i = 0; i < 100; i++) { g = findGenBySession(genKey, parent.sid); if (g && !g.done && String(g.userText).includes('结论是 42')) break; await sleep(50); }
  assert.ok(g && String(g.userText).includes('结论是 42'), '汇报应作为新一轮送进 agy 会话');
  assert.ok(String(g.userText).startsWith(RELAY_NOTE));
  assert.ok(!/mcp__sessions__/.test(g.userText), '转给 agy 的信封里不该有 Claude 的工具名');
  assert.match(g.userText, /read_session/);
  // 这一轮还在跑（假 agy 很快跑完；用慢轮验排队）
  await g.settled;
  const slow = await agyChat('[SLOW] 忙着', { sessionId: parent.sid });
  await sleep(50);
  const r = await fam.sendToSession(ctx, child, 'parent', '我还有个问题');
  assert.deepEqual([r.ok, r.how], [true, 'queued']);
  assert.match(listQueue(genKey, parent.sid)[0].text, /我还有个问题/);
  await fetch(`${BASE}/api/agy/stop`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ sessionId: parent.sid }) });
  await slow.done;
  _resetQueuesForTest();
});

test('项目记忆：按 agy 项目或规整后的目录给稳定 id，读写走 bridge 自己的数据目录', async () => {
  assert.equal(agyMemoryProjectId(ctx, { sessionId: '', projectId: 'p-123' }), 'agy-p-123');
  const a = agyMemoryProjectId(ctx, { sessionId: '', cwd: 'C:\\Work\\Proj\\' });
  const b = agyMemoryProjectId(ctx, { sessionId: '', cwd: 'c:/work/proj' });
  if (process.platform === 'win32') assert.equal(a, b);
  assert.match(a, /^agy-cwd-[0-9a-f]{16}$/);
  const gen = fakeGen('sess-mem', { cwd: path.join(vaultDir, 'mem-proj') });
  // agy 看到的是合并工具 project_memory，按 action 落到原工具
  const target = await hub.resolveHubTool(ctx, {}, 'project_memory');
  assert.ok(target?.family);
  const w = await hub.callHubTool(ctx, gen, target, { action: 'write', name: 'MEMORY.md', content: '- decisions.md — 定下的事' });
  assert.match(textOf(w), /已写入/);
  const rd = await hub.callHubTool(ctx, gen, target, { action: 'read' });
  assert.match(textOf(rd), /定下的事/);
});

// —— 假手机（同 src/mcp/phone-control-tools.test.mjs 的写法）——
const { handleControlNext, handleControlResult, __resetForTest } = await import('@bridge/core/runtime/phone-control.mjs');
function mkReq(url, body) {
  const req = new EventEmitter();
  req.url = url; req.headers = { 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 17; SM-F9760 Build/X)' };
  if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}
function mkRes() { const r = { ended: false }; r.writeHead = (s) => { r.status = s; return r; }; r.end = (b) => { r.body = b || ''; r.ended = true; }; return r; }
function fakePhone(devId, name, reply, log) {
  let stopped = false;
  const id = () => ({ kind: 'admin' });
  (async () => {
    while (!stopped) {
      const res = mkRes();
      await handleControlNext(mkReq('/api/phone-control/next?wait=200&device=' + devId + '&name=' + encodeURIComponent(name)), res, { identify: id });
      while (!res.ended) await sleep(5);
      if (res.status !== 200) continue;
      const cmd = JSON.parse(res.body);
      log.push(devId + ':' + cmd.op);
      let out;
      try { out = { ok: true, result: await reply(cmd.op, cmd.args) }; } catch (e) { out = { ok: false, error: e.message }; }
      await handleControlResult(mkReq('/api/phone-control/result?device=' + devId, { cmdId: cmd.cmdId, ...out }), mkRes(), { identify: id });
    }
  })();
  return () => { stopped = true; };
}
const obs = (pkg) => ({ package: pkg, screenW: 1080, screenH: 2400, elements: [{ i: 0, label: '搜索', clickable: true, bounds: [0, 0, 100, 100] }], windows: [{ i: 0, type: 1, pkg, active: true }], screenshot: 'AAAA', som: true });

test('手机操控：一个 phone_control 跨调用记住锁定的手机；截图返回给模型；发短信先确认、没人答就不发', async () => {
  __resetForTest();
  _resetPhoneCacheForTest();
  const log = [];
  let confirmReply = null;   // 悬浮窗确认的回包：null = 这台不支持（旧 app），走对话里的卡
  const reply = async (op) => {
    if (op === 'confirm') { if (confirmReply === null) throw new Error('未知操作'); return confirmReply; }
    if (op === 'send_sms') return { ok: true };
    return obs('com.' + op);
  };
  const stopA = fakePhone('fold0001', 'Z Fold7', reply, log);
  const stopB = fakePhone('sphone02', 'Galaxy S', reply, log);
  await sleep(40);
  try {
    const target = await hub.resolveHubTool(ctx, {}, 'phone_control');
    const gen = fakeGen('sess-phone-1');
    const ambiguous = await hub.callHubTool(ctx, gen, target, { action: 'screen' });
    assert.match(textOf(ambiguous), /2 台手机开着操控/);
    const shot = await hub.callHubTool(ctx, gen, target, { action: 'screen', device: 'fold' });
    assert.ok(shot.content.some((c) => c.type === 'image' && c.data === 'AAAA'), '截图照常返回给模型');
    assert.ok(!gen.events.some((e) => e.type === 'gen_media' || e.type === 'gen_media_start'), '不往 agy 对话里发它不认的 gen_media 帧');
    // 下一次调用（中枢现建一份新的 MCP）不传 device：仍锁在 Fold
    await hub.callHubTool(ctx, gen, target, { action: 'tap', index: 0 });
    assert.deepEqual(log.slice(-2), ['fold0001:screen', 'fold0001:tap']);
    // 别的会话不受这个锁影响
    const other = await hub.callHubTool(ctx, fakeGen('sess-phone-2'), target, { action: 'screen' });
    assert.match(textOf(other), /2 台手机开着操控/);
    // 参数不对：照实报，并指向 tool_docs
    const bad = await hub.callHubTool(ctx, gen, target, { action: 'swipe' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /tool_docs/);

    // 发短信：悬浮窗不可用 → 对话里弹卡；用户拒绝 → 不发
    const n0 = log.length;
    const p1 = hub.callHubTool(ctx, gen, target, { action: 'send_sms', to: '10086', body: 'hi' });
    for (let i = 0; i < 100 && !gen.events.some((e) => e.type === 'question' && e.status === 'pending'); i++) await sleep(10);
    const q1 = gen.events.filter((e) => e.type === 'question').at(-1);
    assert.match(q1.message, /10086/);
    answerBridgeQuestion(ctx, q1.requestId, { action: 'accept', content: { decision: 'deny' } });
    assert.match(textOf(await p1), /没有确认发送/);
    assert.ok(!log.slice(n0).includes('fold0001:send_sms'));
    // 悬浮窗上点了确认：发出去，并撤掉对话里那张卡
    confirmReply = { confirmed: true };
    const sent = await hub.callHubTool(ctx, gen, target, { action: 'send_sms', to: '10086', body: 'hi' });
    assert.match(textOf(sent), /已发出短信/);
    const q2 = gen.events.filter((e) => e.type === 'question').at(-1);
    assert.ok(gen.events.some((e) => e.type === 'question-resolved' && e.requestId === q2.requestId));
    // 审批卡上手动允许过这一条：不再问
    confirmReply = { confirmed: false };
    gen.events.push({ type: 'permission', requestId: 'p9', toolCall: { name: 'mcp_bridge_phone_control', args: { action: 'send_sms', to: '10010', body: 'yo', toolSummary: '发短信' } } });
    gen.events.push({ type: 'permission-resolved', requestId: 'p9', outcome: 'selected', optionId: 'allow_once' });
    gen.events.push({ type: 'permission', requestId: 'p8', toolCall: { name: 'mcp_bridge_phone_control', args: { action: 'send_sms', to: '99999', body: 'yo' } } });
    gen.events.push({ type: 'permission-resolved', requestId: 'p8', outcome: 'selected', optionId: 'allow_once' });
    const approved = await hub.callHubTool(ctx, gen, target, { action: 'send_sms', to: '10010', body: 'yo' });
    assert.match(textOf(approved), /已发出短信给 10010/);
  } finally {
    stopA(); stopB();
    await sleep(250);
    __resetForTest();
  }
});

test('拉取请求：开自动修复 / 自动合并要用户点头，CI 叫醒的那一轮里不许开；绑定记成 agy:<会话>', async () => {
  const target = await hub.resolveHubTool(ctx, {}, 'pr_set_monitor');
  const ci = fakeGen('cccccccc-1111-2222-3333-444444444444', { userText: `${RELAY_NOTE}\n\n<ci-monitor-event kind="ci_failed">` });
  const r1 = await hub.callHubTool(ctx, ci, target, { auto_fix: true });
  assert.match(textOf(r1), /不能开自动修复/);
  const gen = fakeGen('cccccccc-1111-2222-3333-444444444444');
  const p = hub.callHubTool(ctx, gen, target, { auto_fix: true });
  for (let i = 0; i < 100 && !gen.events.some((e) => e.type === 'question'); i++) await sleep(10);
  const q = gen.events.find((e) => e.type === 'question');
  assert.match(q.message, /自动修复/);
  answerBridgeQuestion(ctx, q.requestId, { action: 'cancel' });
  assert.match(textOf(await p), /保持关闭/);
  const { _slot } = await import('@bridge/core/runtime/pr-monitor.mjs');
  assert.ok(!_slot(ctx, 'agy:cccccccc-1111-2222-3333-444444444444')?.autoFix, '没同意就不开');
  // 关掉不用问
  const off = await hub.callHubTool(ctx, gen, target, { auto_fix: false });
  assert.match(textOf(off), /自动修复已关/);
  assert.equal(_slot(ctx, 'agy:cccccccc-1111-2222-3333-444444444444').agent, 'agy');
});

test('工具指纹：远程连接器的增减、改动、授权会改 toolingSig；代连远程 MCP，静态头 / 令牌 / 过期 / 401 各有说法', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { z } = await import('zod');
  const seen = [];
  const remote = http.createServer(async (req, res) => {
    seen.push(String(req.headers.authorization || req.headers['x-key'] || ''));
    if (req.url.startsWith('/locked') && req.headers.authorization !== 'Bearer good-token') { res.writeHead(401); res.end('unauthorized'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const mcp = new McpServer({ name: 'echo', version: '1' });
    mcp.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: 'echo:' + text }] }));
    const tr = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { tr.close().catch(() => {}); mcp.close().catch(() => {}); });
    await mcp.connect(tr);
    await tr.handleRequest(req, res, body);
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  const port = remote.address().port;
  try {
    const ext = await import('@bridge/core/extensions.mjs');
    const settings = {};
    const sig0 = buildAgySessionTooling({ ctx, settings }).toolingSig;
    const open = ext.saveConnector({ name: 'Echo Open', transport: 'http', url: `http://127.0.0.1:${port}/open` });
    assert.equal(ext.agyRemoteConnectors().length, 0, '远程连接器默认不勾 Antigravity');
    ext.updateExtension(open.id, { agents: { agy: true } });
    const sig1 = buildAgySessionTooling({ ctx, settings }).toolingSig;
    assert.notEqual(sig1, sig0);
    hub._clearHubCacheForTest();
    _resetRemoteCacheForTest();
    const names = (await hub.listHubTools(ctx, settings)).map((t) => t.name);
    assert.ok(names.includes('ext_echo_open_echo'), names.join(' '));
    const call = await hub.callHubTool(ctx, fakeGen('sess-ext'), await hub.resolveHubTool(ctx, settings, 'ext_echo_open_echo'), { text: 'hi' });
    assert.equal(textOf(call), 'echo:hi');
    assert.equal(bridgeToolAutoAllow({ name: 'mcp_bridge_ext_echo_open_echo', args: {} }), false, '远程连接器不许自动放行');

    // 要登录的：没令牌 → 明确说去扩展中心授权；有令牌 → 带上；过期 → 说重新授权
    const locked = ext.saveConnector({ name: 'Echo Locked', transport: 'http', url: `http://127.0.0.1:${port}/locked` });
    ext.updateExtension(locked.id, { agents: { agy: true } });
    const conn = ext.agyRemoteConnectors().find((c) => c.id === locked.id);
    _setTokenReaderForTest(() => null);
    hub._clearHubCacheForTest(); _resetRemoteCacheForTest();
    const callLocked = async () => hub.callHubTool(ctx, fakeGen('sess-ext'), { group: hub.hubGroupOf('remote'), toolName: 'ext_echo_locked_echo' }, { text: 'x' });
    // 没令牌时连清单都取不到：调用照实说没有 / 要登录
    assert.match(textOf(await callLocked()), /没有叫 ext_echo_locked_echo|要求登录/);
    const sigNoTok = buildAgySessionTooling({ ctx, settings }).toolingSig;
    _setTokenReaderForTest(() => ({ accessToken: 'good-token', expiresAt: Date.now() + 3600_000 }));
    assert.notEqual(buildAgySessionTooling({ ctx, settings }).toolingSig, sigNoTok, '刚授权完要让 agy 重新取清单');
    hub._clearHubCacheForTest(); _resetRemoteCacheForTest();
    assert.equal(textOf(await callLocked()), 'echo:x');
    assert.ok(seen.includes('Bearer good-token'));
    _setTokenReaderForTest(() => ({ accessToken: 'old', expiresAt: Date.now() - 1000 }));
    assert.match(authHeaders(ctx, conn).error, /已过期.*重新授权/);
    _setTokenReaderForTest(() => ({ accessToken: 'wrong', expiresAt: Date.now() + 3600_000 }));
    _resetRemoteCacheForTest();
    // 直接走远程组的调用（清单缓存里还有它）：令牌被拒 → 要求登录
    const { callRemoteTool } = await import('./groups/remote.mjs');
    _setTokenReaderForTest(() => ({ accessToken: 'good-token', expiresAt: Date.now() + 3600_000 }));
    await hub.listHubTools(ctx, settings);
    _setTokenReaderForTest(() => ({ accessToken: 'wrong', expiresAt: Date.now() + 3600_000 }));
    const rejected = await callRemoteTool(ctx, 'ext_echo_locked_echo', { text: 'x' });
    assert.equal(rejected.isError, true);
    assert.match(textOf(rejected), /要求登录|没有叫/);
    // 静态请求头原样带上
    assert.deepEqual(Object.keys(authHeaders(ctx, { ...conn, config: { ...conn.config, headers: { Authorization: 'Bearer static' } } }).headers), ['Authorization']);
    ext.deleteExtension(open.id);
    ext.deleteExtension(locked.id);
    assert.notEqual(buildAgySessionTooling({ ctx, settings }).toolingSig, sig1);
  } finally {
    _setTokenReaderForTest(null);
    _resetRemoteCacheForTest();
    hub._clearHubCacheForTest();
    remote.closeAllConnections?.();
    await new Promise((r) => remote.close(() => r()));
  }
});
