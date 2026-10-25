// 权限模式 / 逐次审批卡 / 计划审批卡（runtime/permissions.mjs）的契约：
// 模式取值顺序与夹紧、按文件夹记忆的键、「始终允许」的 suggestions 过滤、闸门的等待与答复映射、
// 同一会话多张卡互不覆盖、待回答表按身份过滤、历史重建里的计划卡与被拒工具行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-perm-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';

const P = await import('./runtime/permissions.mjs');
const S = await import('./runtime/claude-settings.mjs');
const Q = await import('./runtime/questions.mjs');
const { setChatPrefsPermissionMode, chatPrefsFor, recordChatPrefs } = await import('./runtime/chat-prefs.mjs');

const admin = { kind: 'admin', key: 'admin', dataDir: path.join(tmp, 'admin'), shell: true, sandbox: false, cwd: path.join(tmp, 'vault') };
const user = { kind: 'user', key: 'u:dora', user: 'dora', dataDir: path.join(tmp, 'dora', '.bridge'), shell: true, sandbox: true, cwd: path.join(tmp, 'dora') };

test('folderKey：worktree 只剥中间那段（子目录项目的键 = 项目路径），Windows 不分大小写', () => {
  const root = path.join(tmp, 'Repo');
  assert.equal(P.folderKey(path.join(root, '.claude', 'worktrees', 'brave-otter-1a2b3c')), P.folderKey(root));
  // 子目录项目：worktree 会话 cwd = <根>/.claude/worktrees/<名>/<子目录>，键要等于草稿视图用的 <根>/<子目录>
  assert.equal(P.folderKey(path.join(root, '.claude', 'worktrees', 'x', 'sub')), P.folderKey(path.join(root, 'sub')));
  assert.notEqual(P.folderKey(path.join(root, '.claude', 'worktrees', 'x', 'sub')), P.folderKey(root));
  if (process.platform === 'win32') assert.equal(P.folderKey(root.toUpperCase()), P.folderKey(root));
  assert.equal(P.folderKey(''), '');
});

test('resolveTurnMode：无人值守固定 default；请求 > 会话 > 父会话 > 文件夹 > 设置默认；最后夹紧', () => {
  S._resetClaudeSettingsCache(); P._resetPermissions();
  assert.deepEqual(P.resolveTurnMode(admin, { policy: 'host', requested: 'bypassPermissions' }), { mode: 'default', source: 'host' });
  assert.equal(P.resolveTurnMode({ ...user, snap: { token: 't' } }, {}).mode, 'default');
  // 设置默认 auto（admin、主机允许自动模式）
  assert.deepEqual(P.resolveTurnMode(admin, {}), { mode: 'auto', source: 'settings' });
  // 文件夹记忆
  S.setClaudeSettings(admin, {});   // 建目录
  assert.equal(P.resolveTurnMode(admin, { requested: 'plan' }).mode, 'plan');
  setChatPrefsPermissionMode(admin, 'sess-a', 'acceptEdits');
  assert.deepEqual(P.resolveTurnMode(admin, { sessionId: 'sess-a' }), { mode: 'acceptEdits', source: 'session' });
  assert.equal(P.resolveTurnMode(admin, { sessionId: 'sess-a', requested: 'default' }).mode, 'default');
  // 子会话继承父会话（父在计划模式就不跟）
  assert.deepEqual(P.resolveTurnMode(admin, { inheritFrom: 'sess-a' }), { mode: 'acceptEdits', source: 'parent' });
  setChatPrefsPermissionMode(admin, 'sess-p', 'plan');
  assert.equal(P.resolveTurnMode(admin, { inheritFrom: 'sess-p' }).source, 'settings');
  // 绕过权限：主机没开 allowBypass → 夹到接受编辑
  assert.equal(P.resolveTurnMode(admin, { requested: 'bypassPermissions' }).mode, 'acceptEdits');
  assert.equal(P.allowSkipFor(admin), false);
  S.setClaudeSettings(admin, { allowBypass: true });
  assert.equal(P.resolveTurnMode(admin, { requested: 'bypassPermissions' }).mode, 'bypassPermissions');
  assert.equal(P.allowSkipFor(admin), true);
  // 沙箱身份永远拿不到 bypass / auto（主机开着也不行），也不带 allowDangerouslySkipPermissions
  assert.equal(P.resolveTurnMode(user, { requested: 'bypassPermissions' }).mode, 'acceptEdits');
  assert.equal(P.resolveTurnMode(user, { requested: 'auto' }).mode, 'acceptEdits');
  assert.equal(P.resolveTurnMode(user, {}).mode, 'acceptEdits');   // 设置默认 auto → 夹紧
  assert.equal(P.allowSkipFor(user), false);
  S.setClaudeSettings(admin, { allowBypass: null });
});

test('快照对话的一次性桶共用 scratch: 键；存成工作空间的不算', () => {
  const bucket = path.join(user.dataDir, 'quickchat', 'b1');
  assert.equal(P.folderKeyFor(user, bucket), 'scratch:');
  assert.equal(P.folderKeyFor(user, path.join(user.dataDir, 'quickchat', 'b2', 'sub')), 'scratch:');
  assert.equal(P.folderKeyFor(user, user.cwd), P.folderKey(user.cwd));
  const projFile = path.join(tmp, 'dora-projects.json');
  writeFileSync(projFile, JSON.stringify({ projects: [{ id: 'p1', path: bucket }] }));
  assert.equal(P.folderKeyFor({ ...user, claudeProjects: projFile }, bucket), P.folderKey(bucket));
  // 快照访客 / 分享身份没有快照桶的概念
  assert.equal(P.folderKeyFor({ kind: 'share', key: 's' }, bucket), P.folderKey(bucket));
});

test('deferredModeFor：干活时选的绕过权限，定局停放前切过去；一致 / 无记忆 / 快照不切；沙箱夹紧', () => {
  S._resetClaudeSettingsCache(); P._resetPermissions();
  S.setClaudeSettings(admin, { allowBypass: true });
  setChatPrefsPermissionMode(admin, 'sess-d', 'bypassPermissions');
  assert.equal(P.deferredModeFor(admin, 'sess-d', 'acceptEdits'), 'bypassPermissions');
  assert.equal(P.deferredModeFor(admin, 'sess-d', 'bypassPermissions'), null);
  assert.equal(P.deferredModeFor(admin, 'sess-none', 'default'), null);
  assert.equal(P.deferredModeFor({ ...admin, snap: { token: 't' } }, 'sess-d', 'default'), null);
  // 主机后来关了绕过权限：夹到接受编辑
  S.setClaudeSettings(admin, { allowBypass: null });
  assert.equal(P.deferredModeFor(admin, 'sess-d', 'default'), 'acceptEdits');
  assert.equal(P.deferredModeFor(admin, 'sess-d', 'acceptEdits'), null);
  // 沙箱身份的会话记忆不可能越权（夹紧兜底）
  setChatPrefsPermissionMode(user, 'sess-u', 'auto');
  assert.equal(P.deferredModeFor(user, 'sess-u', 'default'), 'acceptEdits');
});

test('init 帧只在会话没记过模式时落（ifUnset）；待生效的只有绕过权限', () => {
  S._resetClaudeSettingsCache(); P._resetPermissions();
  S.setClaudeSettings(admin, { allowBypass: true });
  // 新会话首轮：还没记过 → init 落一笔
  P.noteSessionMode(admin, 'sess-init', 'acceptEdits', { ifUnset: true });
  assert.equal(chatPrefsFor(admin, 'sess-init').permissionMode, 'acceptEdits');
  // 干活时选了绕过权限（会话记忆 = bypass，进程还是 default）：挂起后的续轮 init（default）不许冲掉它
  P.noteSessionMode(admin, 'sess-init', 'bypassPermissions');
  P.noteSessionMode(admin, 'sess-init', 'default', { ifUnset: true });
  assert.equal(chatPrefsFor(admin, 'sess-init').permissionMode, 'bypassPermissions');
  assert.equal(P.pendingModeFor(admin, 'sess-init', 'default'), 'bypassPermissions', 'init 事件带上待生效点');
  assert.equal(P.deferredModeFor(admin, 'sess-init', 'default'), 'bypassPermissions', '定局停放前照样切');
  assert.equal(P.pendingModeFor(admin, 'sess-init', 'bypassPermissions'), null);
  // 冷启动期间刚选的普通模式：不算「待生效」（init 时当场切，见 claude.mjs），但 deferredModeFor 认得出要切
  P.noteSessionMode(admin, 'sess-init', 'acceptEdits');
  assert.equal(P.pendingModeFor(admin, 'sess-init', 'default'), null);
  assert.equal(P.deferredModeFor(admin, 'sess-init', 'default'), 'acceptEdits');
  S.setClaudeSettings(admin, { allowBypass: null });
  // 主机关了绕过权限：会话记忆里的 bypass 夹到接受编辑，也就不再挂待生效点
  P.noteSessionMode(admin, 'sess-init', 'bypassPermissions');
  assert.equal(P.pendingModeFor(admin, 'sess-init', 'acceptEdits'), null);
});

test('没有条目的会话切模式：占位条目 at=0，不盖掉本机记的选择器', () => {
  setChatPrefsPermissionMode(admin, 'sess-ext', 'acceptEdits');
  const e = chatPrefsFor(admin, 'sess-ext');
  assert.equal(e.permissionMode, 'acceptEdits');
  assert.equal(e.at, 0);
  assert.equal(e.model, null);
  // 之后正常记一次选择器：at 正常、模式原样带着
  recordChatPrefs(admin, 'sess-ext', { model: 'claude-opus-5-5', effort: null, fast: false });
  assert.ok(chatPrefsFor(admin, 'sess-ext').at > 0);
  assert.equal(chatPrefsFor(admin, 'sess-ext').permissionMode, 'acceptEdits');
});

test('会话级模式不被每轮记选择器冲掉；last 不带模式', () => {
  setChatPrefsPermissionMode(admin, 'sess-k', 'plan');
  recordChatPrefs(admin, 'sess-k', { model: 'claude-opus-5-5', effort: null, fast: false });
  assert.equal(chatPrefsFor(admin, 'sess-k').permissionMode, 'plan');
  assert.equal(chatPrefsFor(admin, 'sess-k').model, 'claude-opus-5-5');
});

test('filterSuggestions：只留指向这个工具的 allow 规则；setMode 只留安全档且强制 session；沙箱一律 session、不给加目录', () => {
  const sugg = [
    { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }, { toolName: 'Write' }, { toolName: 'Bash', ruleContent: '非ASCII' }] },
    { type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Bash' }] },
    { type: 'replaceRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash' }] },
    { type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'localSettings' },
    { type: 'addDirectories', directories: ['D:/x'], destination: 'localSettings' },
  ];
  const a = P.filterSuggestions('Bash', sugg, { sandbox: false });
  assert.deepEqual(a, [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addDirectories', directories: ['D:/x'], destination: 'session' },
  ]);
  const u = P.filterSuggestions('Bash', sugg, { sandbox: true });
  assert.ok(u.every((x) => x.destination === 'session'));
  assert.ok(!u.some((x) => x.type === 'addDirectories'));
  // MCP：服务器前缀的规则算同一个工具族
  const m = P.filterSuggestions('mcp__terminal__run', [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'mcp__terminal' }, { toolName: 'mcp__other__x' }] }]);
  assert.deepEqual(m[0].rules, [{ toolName: 'mcp__terminal' }]);
});

// —— 闸门 ——
function harness(ctx, extra = {}) {
  const events = [];
  let interrupted = 0, activity = 0;
  const gate = P.makePermissionGate({
    ctx, send: (ev) => events.push(ev), sid: () => extra.sid || 'sess-1', currentMode: () => extra.mode || 'default',
    guard: extra.guard || null, onInterrupt: () => { interrupted++; }, onActivity: () => { activity++; },
    limitReplay: extra.limitReplay === undefined ? null : extra.limitReplay, policy: extra.policy,
    turnOrigin: extra.turnOrigin ? () => extra.turnOrigin : undefined,
    unattended: extra.unattended ? () => true : undefined,
  });
  return { gate, events, interrupted: () => interrupted, activity: () => activity };
}
const answer = (qid, payload) => { const e = Q.pendingQuestions.get(qid); assert.ok(e, 'no pending ' + qid); e.settle(payload); };
const flush = () => new Promise((r) => setImmediate(r));
const optsFor = (extra = {}) => ({ signal: new AbortController().signal, toolUseID: 'tu-' + Math.random().toString(16).slice(2), ...extra });

test('逐次审批：发卡、待回答点按身份、允许一次 / 始终允许 / 允许并切自动', async () => {
  Q.sessionQuestions.clear();
  const { gate, events } = harness(admin);
  const sugg = [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }];
  const p1 = gate.canUseTool('Bash', { command: 'npm test', description: 'run tests' }, optsFor({ suggestions: sugg, title: 'Claude wants to run npm test', displayName: 'Bash command' }));
  await flush();
  const req = events.find((e) => e.type === 'perm_request');
  assert.ok(req && req.qid.startsWith('perm-'));
  assert.equal(req.preview.kind, 'command');
  assert.equal(req.preview.command, 'npm test');
  assert.equal(req.canAlways, true);
  assert.equal(req.always.persistent, true);
  assert.equal(req.canAuto, true);
  assert.equal(gate.pending(), 1);
  assert.ok(Q.sessionQuestions.hasFor('sess-1', 'admin'));
  assert.ok(!Q.sessionQuestions.hasFor('sess-1', 'u:dora'), '别的身份看不到这张卡');
  assert.equal(Q.sessionQuestions.get('sess-1').questions[0].question, 'Claude wants to run npm test');
  answer(req.qid, { decision: 'always' });
  const r1 = await p1;
  assert.equal(r1.behavior, 'allow');
  assert.deepEqual(r1.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }]);
  assert.equal(r1.decisionClassification, 'user_permanent');
  assert.ok(events.some((e) => e.type === 'perm_answer' && e.qid === req.qid && e.decision === 'always'));
  assert.ok(!Q.sessionQuestions.has('sess-1'));
  assert.equal(gate.pending(), 0);

  const p2 = gate.canUseTool('Write', { file_path: 'a.txt', content: 'hi' }, optsFor());
  await flush();
  const req2 = events.filter((e) => e.type === 'perm_request').pop();
  assert.equal(req2.preview.kind, 'write');
  answer(req2.qid, { decision: 'auto' });
  const r2 = await p2;
  assert.deepEqual(r2.updatedPermissions, [{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  const ledgerFile = path.join(admin.dataDir, 'claude-permission-modes.json');
  const consented = () => { try { return JSON.parse(readFileSync(ledgerFile, 'utf8')).autoConsented === true; } catch { return false; } };
  assert.equal(consented(), false, '没带首次确认（老前端）：照样切，但不记「已同意」');
  // 卡片上弹了首次确认、点了「启用」：answer 带 ack，与模式芯片那条路一样记下
  const p2b = gate.canUseTool('Write', { file_path: 'b.txt', content: 'hi' }, optsFor());
  await flush();
  answer(events.filter((e) => e.type === 'perm_request').pop().qid, { decision: 'auto', ack: true });
  assert.deepEqual((await p2b).updatedPermissions, [{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  assert.equal(consented(), true);

  const p3 = gate.canUseTool('Write', { file_path: 'a.txt', content: 'hi' }, optsFor());
  await flush();
  answer(events.filter((e) => e.type === 'perm_request').pop().qid, { decision: 'once' });
  const r3 = await p3;
  assert.equal(r3.behavior, 'allow');
  assert.equal(r3.updatedPermissions, undefined);
});

test('拒绝：不带反馈 = 停下这一轮（interrupt）；带反馈 = 官方前缀、不中断；子 agent 的不中断', async () => {
  const { gate, events, interrupted } = harness(admin);
  const p = gate.canUseTool('Bash', { command: 'rm -rf x' }, optsFor());
  await flush();
  answer(events.at(-1).qid, { decision: 'deny' });
  const r = await p;
  assert.equal(r.behavior, 'deny');
  assert.equal(r.interrupt, true);
  assert.equal(interrupted(), 1);
  const p2 = gate.canUseTool('Bash', { command: 'rm -rf x' }, optsFor());
  await flush();
  answer(events.at(-1).qid, { decision: 'deny', feedback: '别删，先备份' });
  const r2 = await p2;
  assert.equal(r2.interrupt, false);
  assert.ok(r2.message.startsWith(P.REJECT_PREFIX) && r2.message.endsWith('别删，先备份'));
  const p3 = gate.canUseTool('Bash', { command: 'x' }, optsFor({ agentID: 'agent-1' }));
  await flush();
  assert.equal(events.at(-1).agentId, 'agent-1');
  answer(events.at(-1).qid, { decision: 'deny' });
  assert.equal((await p3).interrupt, false);
  assert.equal(interrupted(), 1);
});

test('同一会话多张卡互不覆盖：答掉一张，待回答点还亮着', async () => {
  Q.sessionQuestions.clear();
  const { gate, events } = harness(admin);
  const a = gate.canUseTool('Bash', { command: 'a' }, optsFor());
  const b = gate.canUseTool('Bash', { command: 'b' }, optsFor({ agentID: 'sub' }));
  await flush();
  const reqs = events.filter((e) => e.type === 'perm_request');
  assert.equal(reqs.length, 2);
  assert.equal(Q.sessionQuestions.list('sess-1').length, 2);
  answer(reqs[0].qid, { decision: 'once' });
  await a;
  assert.ok(Q.sessionQuestions.has('sess-1'));
  assert.equal(gate.pending(), 1);
  answer(reqs[1].qid, { decision: 'once' });
  await b;
  assert.ok(!Q.sessionQuestions.has('sess-1'));
});

test('停止 / 顶掉（abort）：卡作废、回 deny、发 cancelled', async () => {
  const { gate, events } = harness(admin);
  const ac = new AbortController();
  const p = gate.canUseTool('Bash', { command: 'x' }, { ...optsFor(), signal: ac.signal });
  await flush();
  ac.abort();
  const r = await p;
  assert.equal(r.behavior, 'deny');
  assert.ok(events.some((e) => e.type === 'perm_answer' && e.decision === 'cancelled' && e.by === 'abort'));
  assert.equal(gate.pending(), 0);
});

test('白名单 / 无人值守 / 沙箱复检', async () => {
  const { gate, events } = harness(admin);
  const own = await gate.canUseTool('mcp__workspace__move', { from: 'a', to: 'b' }, optsFor({ mcpServer: { name: 'workspace', source: 'sdk' } }));
  assert.equal(own.behavior, 'allow');
  assert.equal(events.length, 0, 'bridge 自带 MCP 不弹卡');
  // 同名但来自配置的服务器（不可信）照常弹卡
  const fake = gate.canUseTool('mcp__workspace__move', {}, optsFor({ mcpServer: { name: 'workspace', source: 'user' } }));
  await flush();
  assert.equal(events.at(-1).type, 'perm_request');
  answer(events.at(-1).qid, { decision: 'once' }); await fake;
  // 计划模式里的写请求：白名单也要人批，卡上标 planMode
  const pm = gate.canUseTool('mcp__workspace__move', {}, optsFor({ mcpServer: { name: 'workspace', source: 'sdk' }, decisionReasonType: 'mode', decisionReason: 'Cannot call mcp__workspace__move while in plan mode.' }));
  await flush();
  assert.equal(events.at(-1).planMode, true);
  assert.equal(events.at(-1).canAuto, false);
  answer(events.at(-1).qid, { decision: 'once' }); await pm;

  const host = harness(admin, { policy: 'host' });
  assert.equal((await host.gate.canUseTool('Bash', { command: 'x' }, optsFor())).behavior, 'allow');
  const hp = await host.gate.canUseTool('Write', {}, optsFor({ decisionReasonType: 'mode' }));
  assert.equal(hp.behavior, 'deny');
  assert.match(hp.message, /plan mode/);
  assert.equal(host.events.length, 0);

  const sb = harness(user, { guard: (n, i) => (n === 'Read' && String(i.file_path).startsWith('/etc') ? '该路径在你的私有空间之外，已拒绝' : null) });
  const v = await sb.gate.canUseTool('Read', { file_path: '/etc/passwd' }, optsFor());
  assert.equal(v.behavior, 'deny');
  assert.equal(sb.events.length, 0, '注定被拒的调用不弹卡');
});

test('bridge 自有 pr / visualize 免审；开自动合并 / 开 Auto-fix 照官方逐次审批（不给始终允许），批准按 tool_use_id 记账；无人值守直接拒', async () => {
  const TA = await import('./runtime/tool-approvals.mjs');
  TA._resetToolApprovals();
  const { gate, events } = harness(admin);
  const sdk = (name) => optsFor({ mcpServer: { name, source: 'sdk' } });
  assert.equal((await gate.canUseTool('mcp__pr__get_status', {}, sdk('pr'))).behavior, 'allow');
  assert.equal((await gate.canUseTool('mcp__pr__set_auto_merge', { enabled: false }, sdk('pr'))).behavior, 'allow', '关掉不用问');
  assert.equal((await gate.canUseTool('mcp__pr__set_monitor', { auto_archive_on_close: true }, sdk('pr'))).behavior, 'allow');
  assert.equal((await gate.canUseTool('mcp__visualize__show_widget', { widget_code: '<svg/>' }, sdk('visualize'))).behavior, 'allow');
  assert.equal(events.length, 0);
  const o = sdk('pr');
  const sugg = [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'mcp__pr__set_auto_merge' }] }];
  const p = gate.canUseTool('mcp__pr__set_auto_merge', { enabled: true }, { ...o, suggestions: sugg });
  await flush();
  const req = events.at(-1);
  assert.equal(req.type, 'perm_request');
  assert.equal(req.canAlways, false, '逐次批准的不给始终允许');
  answer(req.qid, { decision: 'once' });
  assert.equal((await p).behavior, 'allow');
  assert.equal(TA.takeToolApproval(o.toolUseID, 'mcp__pr__set_monitor', 'admin'), false, '工具名对不上不算');
  const o2 = sdk('pr');
  const p2 = gate.canUseTool('mcp__pr__set_monitor', { auto_fix: true }, o2);
  await flush();
  answer(events.at(-1).qid, { decision: 'once' });
  await p2;
  assert.equal(TA.takeToolApproval(o2.toolUseID, 'mcp__pr__set_monitor', 'u:dora'), false, '身份对不上不算');
  const o3 = sdk('pr');
  const p3 = gate.canUseTool('mcp__pr__set_monitor', { auto_fix: true }, o3);
  await flush();
  answer(events.at(-1).qid, { decision: 'once' });
  await p3;
  assert.equal(TA.takeToolApproval(o3.toolUseID, 'mcp__pr__set_monitor', 'admin'), true);
  assert.equal(TA.takeToolApproval(o3.toolUseID, 'mcp__pr__set_monitor', 'admin'), false, '一次批准只管一次调用');
  // 拒了不记账
  const o4 = sdk('pr');
  const p4 = gate.canUseTool('mcp__pr__set_auto_merge', { enabled: true }, o4);
  await flush();
  answer(events.at(-1).qid, { decision: 'deny', feedback: '先别开' });
  assert.equal((await p4).behavior, 'deny');
  assert.equal(TA.takeToolApproval(o4.toolUseID, 'mcp__pr__set_auto_merge', 'admin'), false);
  // Auto-fix 叫醒的轮（family origin 'ci'）：开长期授权直接拒、不弹卡（卡会把没人看的这一轮卡死）；别的 pr 工具照常
  const ci = harness(admin, { turnOrigin: 'ci' });
  const cd = await ci.gate.canUseTool('mcp__pr__set_monitor', { auto_fix: true }, sdk('pr'));
  assert.equal(cd.behavior, 'deny');
  assert.match(cd.message, /ci-monitor-event/);
  assert.equal((await ci.gate.canUseTool('mcp__pr__sync_with_base_branch', {}, sdk('pr'))).behavior, 'allow');
  assert.equal(ci.events.length, 0);
  // 无人值守（管理台代聊）：没人能批，直接拒；不弹卡
  const host = harness(admin, { policy: 'host' });
  const hd = await host.gate.canUseTool('mcp__pr__set_auto_merge', { enabled: true }, sdk('pr'));
  assert.equal(hd.behavior, 'deny');
  assert.match(hd.message, /requires user approval/);
  assert.equal((await host.gate.canUseTool('mcp__pr__get_status', {}, sdk('pr'))).behavior, 'allow');
  assert.equal(host.events.length, 0);
});

test('沙箱身份：始终允许的范围强制 session；没有「允许并切自动」', async () => {
  const { gate, events } = harness(user);
  const p = gate.canUseTool('Bash', { command: 'ls' }, optsFor({ suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'projectSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls' }] }] }));
  await flush();
  const req = events.at(-1);
  assert.equal(req.canAuto, false);
  assert.equal(req.always.persistent, false);
  answer(req.qid, { decision: 'always' });
  assert.equal((await p).updatedPermissions[0].destination, 'session');
});

test('计划审批：可选目标模式、批准 = allow + session setMode、修改 = deny 不中断、拒绝 = 中断、子 agent 直接放行', async () => {
  S._resetClaudeSettingsCache();
  S.setClaudeSettings(admin, { allowBypass: true });
  const { gate, events, interrupted } = harness(admin, { sid: 'sess-plan' });
  const input = { plan: '## 计划\n1. 写 hello.txt', planFilePath: 'C:/Users/x/.claude/plans/brave-otter.md' };
  const p = gate.canUseTool('ExitPlanMode', input, optsFor({ toolUseID: 'toolu_plan1' }));
  await flush();
  const req = events.at(-1);
  assert.equal(req.type, 'plan_request');
  assert.equal(req.qid, 'toolu_plan1', 'qid = tool_use id（历史重建的段同一个 qid）');
  assert.deepEqual(req.accept, ['acceptEdits', 'auto', 'bypassPermissions']);
  assert.equal(req.trust, 'auto');
  assert.equal(req.planFile, 'brave-otter.md', '只给文件名，不出服务器绝对路径');
  assert.equal(req.canClear, false);
  assert.equal(Q.sessionQuestions.get('sess-plan').kind, 'plan');
  answer(req.qid, { decision: 'accept', mode: 'acceptEdits' });
  const r = await p;
  assert.equal(r.behavior, 'allow');
  assert.deepEqual(r.updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.equal(chatPrefsFor(admin, 'sess-plan').permissionMode, 'acceptEdits', '批准后会话记忆跟着变');
  assert.ok(events.some((e) => e.type === 'plan_answer' && e.decision === 'accept' && e.mode === 'acceptEdits'));

  const p2 = gate.canUseTool('ExitPlanMode', input, optsFor({ toolUseID: 'toolu_plan2' }));
  await flush();
  answer('toolu_plan2', { decision: 'revise', feedback: 'On selected text:\n> 写 hello.txt\n改成 hi.txt' });
  const r2 = await p2;
  assert.equal(r2.behavior, 'deny');
  assert.equal(r2.interrupt, false);
  assert.ok(r2.message.includes('改成 hi.txt'));

  const p3 = gate.canUseTool('ExitPlanMode', input, optsFor({ toolUseID: 'toolu_plan3' }));
  await flush();
  answer('toolu_plan3', { decision: 'reject' });
  const r3 = await p3;
  assert.equal(r3.interrupt, true);
  assert.equal(interrupted(), 1);
  // 结论都记进台账（历史重建靠它）
  assert.deepEqual(P.planRecordFor(admin, 'toolu_plan1'), { mode: 'acceptEdits', decision: 'accept', newSessionId: '' });
  assert.equal(P.planRecordFor(admin, 'toolu_plan2').decision, 'revise');
  assert.equal(P.planRecordFor(admin, 'toolu_plan3').decision, 'reject');

  // 不在可选范围里的目标模式 → 回落主按钮那档
  const p4 = gate.canUseTool('ExitPlanMode', input, optsFor({ toolUseID: 'toolu_plan4' }));
  await flush();
  answer('toolu_plan4', { decision: 'accept', mode: 'dontAsk' });
  assert.equal((await p4).updatedPermissions[0].mode, 'auto');

  const sub = await gate.canUseTool('ExitPlanMode', input, optsFor({ agentID: 'a1' }));
  assert.equal(sub.behavior, 'allow');
  // suppressAlwaysAllowRule：只给「接受」（回手动）
  const p5 = gate.canUseTool('ExitPlanMode', input, optsFor({ toolUseID: 'toolu_plan5', suppressAlwaysAllowRule: true }));
  await flush();
  assert.deepEqual(events.at(-1).accept, []);
  assert.equal(events.at(-1).trust, 'default');
  answer('toolu_plan5', { decision: 'accept', mode: 'auto' });
  assert.equal((await p5).updatedPermissions[0].mode, 'default');
  S.setClaudeSettings(admin, { allowBypass: null });
});

test('作答 / 作废都算一次活动（挂起看门狗据此重算静默）', async () => {
  const { gate, events, activity } = harness(admin);
  const p = gate.canUseTool('Bash', { command: 'sleep 1' }, optsFor({ agentID: 'bg-1' }));
  await flush();
  assert.equal(activity(), 0, '等的时候不算');
  answer(events.at(-1).qid, { decision: 'once' });
  await p;
  assert.equal(activity(), 1);
  const ac = new AbortController();
  const p2 = gate.canUseTool('Bash', { command: 'x' }, { ...optsFor(), signal: ac.signal });
  await flush();
  ac.abort();
  await p2;
  assert.equal(activity(), 2);
});

test('清空上下文后执行：请求身份按取值函数现取（预热接管 / 停放复用后换成新请求的）', async () => {
  S._resetClaudeSettingsCache();
  S.setClaudeSettings(admin, { planClearContext: true });
  let cur;   // 预热进程起的时候没有请求身份
  const { gate, events } = harness(admin, { sid: 'sess-clear', limitReplay: () => cur });
  const input = { plan: '1. 写文件', planFilePath: 'C:/x/.claude/plans/p.md' };
  const p1 = gate.canUseTool('ExitPlanMode', input, optsFor({ toolUseID: 'toolu_c1' }));
  await flush();
  assert.equal(events.at(-1).canClear, false, '没有身份就不给这个选项');
  answer('toolu_c1', { decision: 'accept', mode: 'default' }); await p1;
  cur = { headers: { authorization: 'Bearer x' }, url: '/api/chat', body: {} };   // 接管时换上新请求的
  const p2 = gate.canUseTool('ExitPlanMode', input, optsFor({ toolUseID: 'toolu_c2' }));
  await flush();
  assert.equal(events.at(-1).canClear, true);
  answer('toolu_c2', { decision: 'accept', mode: 'default' }); await p2;
  S.setClaudeSettings(admin, { planClearContext: null });
});

test('原因行：去掉 ANSI；description 末尾拼着同一句原因的剥掉', async () => {
  const { gate, events } = harness(admin);
  const p = gate.canUseTool('Bash', { command: 'rm -rf build' }, optsFor({
    description: 'Remove build dir\n\x1b[33mCommand removes files outside the project\x1b[0m',
    decisionReason: '\x1b[33mCommand removes files outside the project\x1b[0m', decisionReasonType: 'safetyCheck',
  }));
  await flush();
  const req = events.at(-1);
  assert.equal(req.reason, 'Command removes files outside the project');
  assert.equal(req.description, 'Remove build dir');
  assert.equal(req.reasonType, 'safetyCheck');
  answer(req.qid, { decision: 'once' }); await p;
});

test('挂起接力换 gen：还在等的卡重发、待回答点重新亮', async () => {
  Q.sessionQuestions.clear();
  const { gate, events } = harness(admin);
  const p = gate.canUseTool('Bash', { command: 'x' }, optsFor());
  await flush();
  Q.sessionQuestions.delete('sess-1');   // retireTurn 清掉旧轮的
  assert.equal(gate.rehome(), 1);
  assert.equal(events.filter((e) => e.type === 'perm_request').length, 2);
  assert.ok(Q.sessionQuestions.has('sess-1'));
  answer(events.at(-1).qid, { decision: 'once' });
  await p;
});

test('待回答表按身份过滤（/api/stream hello、/api/sessions、/api/overview 的读点）', () => {
  Q.sessionQuestions.clear();
  Q.sessionQuestions.set('s-admin', { qid: 'q1', ownerKey: 'admin', questions: [{ header: 'h', question: 'q' }], ts: 1 });
  Q.sessionQuestions.set('s-dora', { qid: 'q2', ownerKey: 'u:dora', questions: [{ header: 'h2', question: 'secret' }], ts: 2 });
  Q.sessionQuestions.set('s-legacy', { qid: 'q3', questions: [], ts: 3 });
  assert.deepEqual([...Q.sessionQuestions.keysFor('u:dora')], ['s-dora']);
  assert.deepEqual([...Q.sessionQuestions.keysFor('admin')].sort(), ['s-admin', 's-legacy']);
  assert.deepEqual([...Q.sessionQuestions.keys()].sort(), ['s-admin', 's-dora', 's-legacy']);
  assert.equal([...Q.sessionQuestions.entriesFor('u:dora')][0][1].questions[0].question, 'secret');
  Q.sessionQuestions.clear();
});

test('waitForAnswer 不设超时（timeoutMs=0）不会立刻判超时', async () => {
  const p = Q.waitForAnswer('q-nt', null, 0, 'admin');
  await new Promise((r) => setTimeout(r, 30));
  Q.pendingQuestions.get('q-nt').settle({ decision: 'once' });
  assert.deepEqual(await p, { decision: 'once' });
});

test('历史重建：ExitPlanMode → 计划段（批准 + 目标模式 / 修改反馈），被人拒的工具行标 denied，无效调用不留卡', async () => {
  const { readSessionMessages } = await import('./routes/sessions.mjs');
  const dir = path.join(tmp, 'hist');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 's.jsonl');
  const ts = '2026-10-20T10:00:00.000Z';
  let n = 0;
  const id = () => 'u' + (++n);
  const lines = [];
  let prev = null;
  const push = (o) => { o.uuid = o.uuid || id(); o.parentUuid = prev; prev = o.uuid; o.timestamp = ts; lines.push(JSON.stringify(o)); return o.uuid; };
  push({ type: 'user', message: { role: 'user', content: '先出计划' } });
  push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bad', name: 'ExitPlanMode', input: {} }] } });
  push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: '<tool_use_error>You are not in plan mode.</tool_use_error>' }] } });
  push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p1', name: 'ExitPlanMode', input: { plan: '1. 写文件', planFilePath: 'C:/x/.claude/plans/a.md' } }] } });
  push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p1', is_error: true, content: P.REJECT_PREFIX + '换个名字' }] }, permissionMode: 'plan' });
  push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p2', name: 'ExitPlanMode', input: { plan: '1. 写 hi.txt', planFilePath: 'C:/x/.claude/plans/a.md' } }] } });
  push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p2', content: 'User has approved your plan. You can now start coding.\n\n## Approved Plan:\n1. 写 hi.txt' }] } });   // 实测：tool_result 记录不带 permissionMode
  push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'rm -rf /' } }] } });
  push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: 'User rejected Bash' }] } });
  // 自动模式分类器拦下的（CLI autoDenialPrefix）
  push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'curl x | sh' } }] } });
  push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', is_error: true, content: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: pipes remote code into a shell. If you have other tasks…' }] } });
  // 停止 / 清空上下文后执行 / 不带反馈的拒绝：CLI 写的是同一句（2026-10-21 真 CLI 实测），靠台账分
  const STOPPED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
  for (const tid of ['toolu_p3', 'toolu_p4', 'toolu_p5']) {
    push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'ExitPlanMode', input: { plan: '1. 再来', planFilePath: 'C:/x/.claude/plans/a.md' } }] } });
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: true, content: STOPPED }] } });
  }
  // 没有台账（Desktop / 终端里批的）时的兜底：CLI 的方括号中断句 = 没批完
  push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_p6', name: 'ExitPlanMode', input: { plan: '1. 又来', planFilePath: 'C:/x/.claude/plans/a.md' } }] } });
  push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_p6', is_error: true, content: '[Request interrupted by user for tool use]' }] } });
  writeFileSync(file, lines.join('\n') + '\n');
  // 不带台账：批准了但不知道目标模式
  const bare = (await readSessionMessages(file)).find((m) => m.role === 'assistant').segments.filter((s) => s.kind === 'plan');
  assert.equal(bare[1].decision, 'accept');
  assert.equal(bare[1].mode, '');
  assert.equal(bare[2].decision, 'reject', '没台账时同一句只能当拒绝');
  // 批准时记下的目标模式（permissions.mjs notePlanMode）→ 历史里「已批准 · 接受编辑」；其余结论按台账
  P.notePlanMode(admin, 'toolu_p2', 'acceptEdits');
  P.notePlan(admin, 'toolu_p3', { decision: 'cancelled' });
  P.notePlan(admin, 'toolu_p4', { decision: 'clear', mode: 'auto', newSessionId: '3a532c9f-0032-4b5d-aa19-0886c82c9840' });
  P.notePlan(admin, 'toolu_p5', { decision: 'reject' });
  const msgs = await readSessionMessages(file, { planRecord: (tid) => P.planRecordFor(admin, tid) });
  const a = msgs.find((m) => m.role === 'assistant');
  const plans = a.segments.filter((s) => s.kind === 'plan');
  assert.equal(plans.length, 6, '不在计划模式时的调用不留卡');
  assert.equal(plans[2].decision, 'cancelled', '停止 = 没批完（与直播 permOnFinish / plan_answer cancelled 同口径）');
  assert.equal(plans[3].decision, 'clear');
  assert.equal(plans[3].newSessionId, '3a532c9f-0032-4b5d-aa19-0886c82c9840', '历史里也能点「打开新会话」');
  assert.equal(plans[3].mode, 'auto');
  assert.equal(plans[4].decision, 'reject');
  assert.equal(plans[5].decision, 'cancelled', '没台账时方括号中断句兜底 = 没批完');
  assert.equal(plans[0].qid, 'toolu_p1');
  assert.equal(plans[0].decision, 'revise');
  assert.equal(plans[0].feedback, '换个名字');
  assert.equal(plans[0].planFile, 'a.md');
  assert.equal(plans[1].decision, 'accept');
  assert.equal(plans[1].mode, 'acceptEdits');
  assert.equal(plans[1].plan, '1. 写 hi.txt');
  const tools = a.segments.filter((s) => s.kind === 'tools').flatMap((s) => s.tools);
  assert.ok(!tools.some((t) => t.name === 'ExitPlanMode'), 'ExitPlanMode 不再是工具行');
  assert.equal(tools.find((t) => t.id === 'toolu_b').denied, 'user');
  assert.equal(tools.find((t) => t.id === 'toolu_a').denied, 'classifier');
});

test('stricterMode：切模式失败时，要的比眼下严就不能凑合跑', () => {
  assert.equal(P.stricterMode('default', 'bypassPermissions'), true);
  assert.equal(P.stricterMode('default', 'auto'), true);
  assert.equal(P.stricterMode('plan', 'default'), true);
  assert.equal(P.stricterMode('acceptEdits', 'default'), false);
  assert.equal(P.stricterMode('bypassPermissions', 'auto'), false);
  assert.equal(P.stricterMode('default', 'default'), false);
  assert.equal(P.stricterMode('default', undefined), true);   // 眼下的不知道：按最宽算
});

test('无人值守的轮（会话间 / Auto-fix / 自动续跑）：审批卡等 30 分钟没人答就拒掉并停下这一轮；真人的轮不设超时', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Q.sessionQuestions.clear();
  const { gate, interrupted } = harness(admin, { unattended: true, sid: 'sess-un' });
  const p = gate.canUseTool('Bash', { command: 'git push' }, optsFor());
  await flush();
  assert.equal(gate.pending(), 1);
  t.mock.timers.tick(30 * 60_000 + 10);
  const r = await p;
  assert.equal(r.behavior, 'deny');
  assert.equal(r.interrupt, true);
  assert.equal(interrupted(), 1);
  assert.equal(gate.pending(), 0);
  // 真人的轮：同样的时长过去也还在等
  const h2 = harness(admin, { sid: 'sess-at' });
  const ac = new AbortController();
  const p2 = h2.gate.canUseTool('Bash', { command: 'git push' }, optsFor({ signal: ac.signal }));
  await flush();
  t.mock.timers.tick(60 * 60_000);
  await flush();
  assert.equal(h2.gate.pending(), 1);
  ac.abort();   // 收掉，别把待回答留给后面的用例
  assert.equal((await p2).interrupt, false);
  t.mock.timers.reset();
});
