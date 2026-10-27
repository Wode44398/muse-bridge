// 场景三最小预留（开源路线 5.3）接进现有代码之后，现有行为不变的证明：
//   contextFor 补的 actor / scope / groups；项目路径授权与工具围栏改走 allowedRoots；终端 / 浏览器池按（属主, 路径）；
//   会话可见性预留（_system，不进属主的会话库）；号池账号的未知字段（groups）读写不丢；数据布局版本与它在 import 阶段最先跑；
//   审计与用量 JSONL（含额度策略字段、号池加号的 id）；浏览器面板 state 带 desktop；子进程与凭据的统一入口。
//   数据根改道到临时目录：别碰仓库里（或正式服）的 config.json / 账号库。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bridge-s3-')));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
// 号池：一个号带了将来才用的字段（groups 与一个认不出的字段），看改动之后读写一圈还在不在
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  port: 18999, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'),
  features: { multiUser: true },   // 与正式服一致：多用户开着（发邀请码那条审计要它）
  claudeAccounts: [
    { id: 'a-1', label: '一号', token: '', groups: ['team-a'], futureField: { x: 1 } },
    { id: 'a-2', label: '二号', token: '' },
  ],
  claudeActiveAccount: 'a-1',
}, null, 2));
mkdirSync(path.join(tmp, 'vault'), { recursive: true });

await (await import('./modules/registry.mjs')).loadModules();
const { contextFor } = await import('./runtime/identity.mjs');
const { authorizeProjectPath, projectLocations } = await import('./project-paths.mjs');
const { sandboxViolation, makeSandboxPreToolUse } = await import('./agents/claude.mjs');
const { allowedRoots, fenceViolation, poolRef, sessionRef } = await import('./runtime/principal.mjs');
const { getLibrary, _resetLibraryCache } = await import('./runtime/session-library.mjs');
const { sessionVisibility, setSessionVisibility, SESSION_VISIBILITY_FILE, _resetSessionVisibilityCache } = await import('./runtime/session-visibility.mjs');
const claudeAccounts = await import('./runtime/claude-account.mjs');
const { credentialFor, accountGroups, spawnFor, spawnOptionsFor } = await import('./runtime/run-as.mjs');
const { migrateLayout, readLayout, LAYOUT_VERSION, groupRoot, GROUPS_ROOT } = await import('./runtime/layout.mjs');
const { appendAudit, appendUsageEvent, noteTurnUsage, readAudit, readUsageEvents, safeMeta, AUDIT_DIR } = await import('./runtime/audit-log.mjs');
const { SYSTEM_DIR, NATIVE_ROOT } = await import('./config/index.mjs');
const { _browserKey } = await import('./runtime/claude-browser.mjs');

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const userRootOf = (n) => path.join(NATIVE_ROOT, n);

test('contextFor：各类身份都补上 actor / scope / groups，今天都等于 key，其余字段不变', () => {
  const admin = contextFor({ kind: 'admin' });
  assert.equal(admin.key, 'admin');
  assert.equal(admin.actor, 'admin');
  assert.equal(admin.scope, 'admin');
  assert.deepEqual(admin.groups, []);
  const u = contextFor({ kind: 'user', user: 'alice', tier: 'pro' });
  assert.equal(u.key, 'u:alice');
  assert.equal(u.actor, 'u:alice');
  assert.equal(u.scope, 'u:alice');
  assert.equal(u.cwd, userRootOf('alice'));
  const snap = contextFor({ kind: 'snap', token: 'tk', dir: path.join(tmp, 'snapdir') });
  assert.equal(snap.key, 'c:tk');
  assert.equal(snap.scope, 'c:tk');
  const share = contextFor({ kind: 'share', token: 'st', dir: path.join(tmp, 'sharedir') });
  assert.equal(share.scope, 's:st');
  // 代聊：actor 记主机，数据目录与 key 仍是被代的那个人
  const proxied = contextFor({ kind: 'user', user: 'alice', tier: 'pro', actor: 'admin' });
  assert.equal(proxied.actor, 'admin');
  assert.equal(proxied.scope, 'u:alice');
  assert.equal(proxied.key, 'u:alice');
  assert.equal(proxied.cwd, u.cwd);
  assert.equal(proxied.dataDir, u.dataDir);
});

test('项目路径授权走 allowedRoots：主机任意目录、沙箱身份只在自己空间内（同改动前）', () => {
  const alice = contextFor({ kind: 'user', user: 'alice', tier: 'pro' });
  const inside = path.join(alice.cwd, 'proj');
  mkdirSync(inside, { recursive: true });
  const outside = path.join(tmp, 'elsewhere');
  mkdirSync(outside, { recursive: true });
  assert.equal(authorizeProjectPath(alice, inside), realpathSync(inside));
  assert.throws(() => authorizeProjectPath(alice, outside), (e) => e.status === 403);
  mkdirSync(userRootOf('bob'), { recursive: true });
  assert.throws(() => authorizeProjectPath(alice, userRootOf('bob')), (e) => e.status === 403, '邻居的空间');
  const admin = contextFor({ kind: 'admin' });
  assert.equal(authorizeProjectPath(admin, outside), realpathSync(outside));
  // 「位置」列表：沙箱身份只拿到自己的工作空间一条
  const locs = projectLocations(alice, [{ id: 'x', name: 'x', path: outside }]);
  assert.deepEqual(locs.map((l) => l.id), ['ws']);
  assert.ok(projectLocations(admin, [{ id: 'x', name: 'x', path: outside }]).some((l) => l.id === 'x'));
});

test('工具围栏走 allowedRoots + fenceViolation：与直接按 ctx.cwd 判逐字一致', async () => {
  const alice = contextFor({ kind: 'user', user: 'alice', tier: 'pro' });
  const cases = [
    ['Read', { file_path: path.join(alice.cwd, 'a.txt') }],
    ['Read', { file_path: path.join(tmp, 'config.json') }],
    ['Write', { file_path: path.join(userRootOf('bob'), 'x.txt') }],
    ['Glob', { path: '..' }],
    ['Bash', { command: 'ls' }],
    ['Bash', { command: 'cat ../bob/x' }],
    ['Bash', { command: 'type ' + path.join(tmp, 'config.json') }],
    ['WebSearch', { query: 'x' }],
  ];
  for (const [name, input] of cases) {
    assert.equal(fenceViolation(allowedRoots(alice), (r) => sandboxViolation(name, input, r)), sandboxViolation(name, input, alice.cwd), name + ' ' + JSON.stringify(input));
  }
  // PreToolUse 主闸：区内放行、区外拒绝（同改动前）
  const hook = makeSandboxPreToolUse(alice);
  assert.deepEqual(await hook({ tool_name: 'Read', tool_input: { file_path: path.join(alice.cwd, 'a.txt') } }), { continue: true });
  const denied = await hook({ tool_name: 'Read', tool_input: { file_path: path.join(tmp, 'config.json') } });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  // 预留：将来多一个根（组空间）时，落在任意一个根内即放行，别人的空间仍拒
  const team = path.join(NATIVE_ROOT, '_groups', 'team-a');
  const roots = [alice.cwd, team];
  assert.equal(fenceViolation(roots, (r) => sandboxViolation('Read', { file_path: path.join(team, 'doc.md') }, r)), null);
  assert.match(fenceViolation(roots, (r) => sandboxViolation('Read', { file_path: path.join(userRootOf('bob'), 'x') }, r)) || '', /私有空间之外/);
});

test('浏览器池键：主机与只给路径的调用方键不变；成员带属主前缀，面板与 agent 同一把键', () => {
  const ws = path.join(tmp, 'shared');
  const legacy = (process.platform === 'win32' ? path.resolve(ws).toLowerCase() : path.resolve(ws));
  assert.equal(_browserKey(ws), legacy);
  const admin = contextFor({ kind: 'admin' });
  assert.equal(_browserKey(poolRef(admin, ws)), legacy);
  const alice = contextFor({ kind: 'user', user: 'alice', tier: 'pro' });
  const bob = contextFor({ kind: 'user', user: 'bob', tier: 'pro' });
  assert.notEqual(_browserKey(poolRef(alice, ws)), _browserKey(poolRef(bob, ws)));
  assert.notEqual(_browserKey(poolRef(alice, ws)), legacy);
  // claude.mjs（agent 侧）传 owner = scopeOf(ctx)、dock（面板侧）传 poolRef(ctx, ws)：同一把键
  assert.equal(_browserKey(poolRef('u:alice', ws)), _browserKey(poolRef(alice, ws)));
});

// 真 PTY 放进一次性的子进程里跑：node-pty 的句柄（Windows 上还有 conpty 的辅助进程）会把测试进程拖住不退出。
// 子进程自己收尸、显式退出；父进程再确认那几个 shell 的 pid 都没了（不留孤儿进程）。
let ptyOk = true;
try { (await import('node:module')).createRequire(import.meta.url)('node-pty'); } catch { ptyOk = false; }
test('终端池：主机 / 老调用方按路径共用一个 PTY；两个成员进同一个目录各拿一份；回收按池项走；killTermsOf 只收那个人的',{ skip: !ptyOk && '没有 node-pty', timeout: 90_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const ws = path.join(tmp, 'term-ws');
  mkdirSync(ws, { recursive: true });
  mkdirSync(ws + '-2', { recursive: true });   // 同一个人的第二个目录（killTermsOf 要一并收）
  const termUrl = pathToFileURL(path.join(import.meta.dirname, 'runtime', 'claude-term.mjs')).href;
  const prinUrl = pathToFileURL(path.join(import.meta.dirname, 'runtime', 'principal.mjs')).href;
  const script = `
    const term = await import(${JSON.stringify(termUrl)});
    const { poolRef } = await import(${JSON.stringify(prinUrl)});
    const ws = process.env.S3_WS;
    const out = {}; const pids = [];
    const refs = [poolRef('admin', ws), poolRef('u:alice', ws), poolRef('u:bob', ws)];
    try {
      const tAdmin = term.ensureTerm(refs[0], 80, 24); pids.push(tAdmin.pty.pid);
      out.pathIsAdmin = term.getTerm(ws) === tAdmin;
      const tA = term.ensureTerm(refs[1], 80, 24); pids.push(tA.pty.pid);
      const tB = term.ensureTerm(refs[2], 80, 24); pids.push(tB.pty.pid);
      out.memberNotAdmin = tA !== tAdmin;
      out.membersApart = tA !== tB;
      out.sameAgain = term.ensureTerm(poolRef('u:alice', ws), 80, 24) === tA;
      out.resized = term.resizeTerm(refs[1], 100, 30) && tA.cols === 100 && tB.cols === 80;
      out.killed = term.killTerm(refs[1]) === true && term.getTerm(refs[1]) === null;
      out.bobRemains = term.getTerm(refs[2]) === tB;
      // 按属主收（删号 / 停用）：只收他自己的，连他开着的直播流一起断；主机和别的成员不动
      const tA2 = term.ensureTerm(refs[1], 80, 24); pids.push(tA2.pty.pid);
      const tA3 = term.ensureTerm(poolRef('u:alice', ws + '-2'), 80, 24); pids.push(tA3.pty.pid);
      const sse = { writableEnded: false, ended: false, frames: '', write(s) { this.frames += s; return true; }, end() { this.ended = true; this.writableEnded = true; }, on() {} };
      term.subscribeTerm(tA2, sse);
      out.killedOf = term.killTermsOf('u:alice');
      out.sseEnded = sse.ended && /"type":"exit"/.test(sse.frames);
      out.aliceGone = term.getTerm(refs[1]) === null && term.getTerm(poolRef('u:alice', ws + '-2')) === null;
      out.othersStay = term.getTerm(ws) === tAdmin && term.getTerm(refs[2]) === tB;
      out.emptyOwner = term.killTermsOf('') === 0 && term.killTermsOf('u:nobody') === 0;
    } catch (e) { out.error = String(e && e.message || e); }
    for (const r of refs) { try { term.killTerm(r); } catch {} }
    out.pids = pids;
    process.stdout.write(JSON.stringify(out));
    setTimeout(() => process.exit(0), 300);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, S3_WS: ws }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  const killer = setTimeout(() => { try { child.kill(); } catch {} }, 60_000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(killer);
  const out = JSON.parse(buf || '{}');
  assert.equal(out.error, undefined);
  assert.equal(out.pathIsAdmin, true, '只给路径 = 主机那一份（Codex 等老通道照旧共用）');
  assert.equal(out.memberNotAdmin, true);
  assert.equal(out.membersApart, true, '两个人进同一个目录各拿一份');
  assert.equal(out.sameAgain, true, '同一个人再取仍是同一个壳');
  assert.equal(out.resized, true, '别人的壳不受影响');
  assert.equal(out.killed, true);
  assert.equal(out.bobRemains, true);
  assert.equal(out.killedOf, 2, '他名下两个目录的终端都收掉');
  assert.equal(out.sseEnded, true, '他开着的直播流收到 exit 并被断开');
  assert.equal(out.aliceGone, true);
  assert.equal(out.othersStay, true, '主机和别的成员的终端不动');
  assert.equal(out.emptyOwner, true);
  // 不留孤儿 shell：子进程退出后，那几个 pid 都应已不在（给系统一点时间收尾）
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 20 && out.pids.some(alive); i++) await new Promise((r) => setTimeout(r, 250));
  const left = out.pids.filter(alive);
  for (const pid of left) { try { process.kill(pid); } catch {} }
  assert.deepEqual(left, [], '终端 shell 没有被收掉');
});

test('号池：认不出的字段（groups 等）读写一圈不丢；credentialFor 今天 = 全服激活号', () => {
  assert.equal(claudeAccounts.setActive('a-2').ok, true);
  const saved = JSON.parse(readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  const one = saved.claudeAccounts.find((a) => a.id === 'a-1');
  assert.deepEqual(one.groups, ['team-a']);
  assert.deepEqual(one.futureField, { x: 1 });
  assert.equal(saved.claudeActiveAccount, 'a-2');
  assert.deepEqual(credentialFor('u:alice', 'u:alice'), { accountId: 'a-2', token: '' });
  assert.deepEqual(credentialFor('admin', 'g:team-a'), credentialFor('u:bob', 'u:bob'), 'actor / scope 今天不参与选号');
  // 安全视图不带任何新字段
  assert.deepEqual(Object.keys(claudeAccounts.listAccounts()[0]).sort(), ['active', 'hasToken', 'id', 'label', 'tokenTail']);
  assert.deepEqual(accountGroups(one), ['team-a']);
  assert.deepEqual(accountGroups({ groups: ['ok', '../bad', '_x'] }), ['ok']);
  assert.deepEqual(accountGroups({}), []);
  claudeAccounts.setActive('a-1');
});

test('spawnFor / spawnOptionsFor 今天原样透传', async () => {
  const opts = { cwd: tmp, env: { ...process.env, S3_PROBE: 'ok' } };
  assert.equal(spawnOptionsFor({ kind: 'user' }, opts), opts);
  const child = spawnFor({ kind: 'user', key: 'u:a' }, process.execPath, ['-e', 'process.stdout.write(process.env.S3_PROBE + "|" + process.cwd())'], opts);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('close', r));
  assert.equal(code, 0);
  assert.equal(out.split('|')[0], 'ok');
  assert.equal(path.resolve(out.split('|')[1]).toLowerCase(), path.resolve(tmp).toLowerCase());
});

test('数据布局：v0 → v1 只落版本号；再跑不写盘；装回旧版本（磁盘更新）不动；失败停在原版本；冻结前补的同版本步骤按名字补跑', () => {
  const sys = path.join(tmp, 'layout-sys');
  mkdirSync(sys, { recursive: true });
  writeFileSync(path.join(sys, 'users.json'), '{"x":1}');
  assert.equal(readLayout(sys).version, 0);
  const r1 = migrateLayout({ systemDir: sys });
  assert.deepEqual({ from: r1.from, version: r1.version, ran: r1.ran }, { from: 0, version: LAYOUT_VERSION, ran: ['v1-baseline'] });
  assert.equal(readFileSync(path.join(sys, 'users.json'), 'utf8'), '{"x":1}', 'v1 不碰任何数据');
  const file = path.join(sys, 'layout.json');
  const m1 = statSync(file).mtimeMs;
  const body1 = readFileSync(file, 'utf8');
  const r2 = migrateLayout({ systemDir: sys });
  assert.deepEqual(r2.ran, []);
  assert.equal(readFileSync(file, 'utf8'), body1, '已是最新：不重写');
  assert.equal(statSync(file).mtimeMs, m1);
  // 磁盘更新（装回旧版本）：只报不动，新版本写的字段原样留着
  writeFileSync(file, JSON.stringify({ version: 7, applied: ['v1-baseline', 'v7-x'], extra: 'keep' }));
  const r3 = migrateLayout({ systemDir: sys });
  assert.equal(r3.newer, true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 7, applied: ['v1-baseline', 'v7-x'], extra: 'keep' });
  // 失败：停在失败前的版本，下次重试
  const sys2 = path.join(tmp, 'layout-sys2');
  const steps = [{ to: 1, name: 'v1-baseline', up() {} }, { to: 2, name: 'v2-boom', up() { throw new Error('boom'); } }];
  const r4 = migrateLayout({ systemDir: sys2, migrations: steps, target: 2 });
  assert.equal(r4.version, 1);
  assert.match(r4.error, /boom/);
  assert.equal(readLayout(sys2).version, 1);
  let ran = 0;
  const fixed = [steps[0], { to: 2, name: 'v2-boom', up() { ran++; } }];
  assert.equal(migrateLayout({ systemDir: sys2, migrations: fixed, target: 2 }).version, 2);
  assert.equal(ran, 1);
  // 冻结前补进 v1 的步骤（例如账号 id 回填）：已落 v1 的数据也会按名字补跑一次，之后不再跑
  let backfill = 0;
  const late = [...fixed, { to: 1, name: 'v1-late-step', up() { backfill++; } }];
  migrateLayout({ systemDir: sys2, migrations: late, target: 2 });
  migrateLayout({ systemDir: sys2, migrations: late, target: 2 });
  assert.equal(backfill, 1);
  assert.equal(readLayout(sys2).version, 2);
  // 组空间路径预留：今天不创建
  assert.equal(groupRoot('team-a'), path.join(GROUPS_ROOT, 'team-a'));
  assert.equal(existsSync(GROUPS_ROOT), false);
  assert.throws(() => groupRoot('../x'));
});

test('真实启动路径：SYSTEM_DIR 下第一次跑落 v1', () => {
  const r = migrateLayout();
  assert.equal(r.version, LAYOUT_VERSION);
  assert.equal(readLayout(SYSTEM_DIR).version, LAYOUT_VERSION);
});

test('审计与用量 JSONL：落 _system、白名单外的字段（令牌 / 密码）不进文件、读出来新的在前', async () => {
  assert.ok(AUDIT_DIR.startsWith(SYSTEM_DIR));
  await appendAudit({ actor: 'admin', action: 'user/tier', target: 'u:alice', meta: { tier: 'user', password: 'hunter2', token: 'sk-x', quota: { dayTurns: 3 } } });
  await appendAudit({ actor: 'admin', via: 'master', action: 'user/chat', target: 'u:alice', scope: 'u:alice', meta: { agent: 'claude' } });
  assert.equal(await appendAudit({ actor: 'admin' }), false, '没有 action 不记');
  const rows = await readAudit({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, 'user/chat');
  assert.equal(rows[0].via, 'master');
  assert.deepEqual(rows[1].meta, { tier: 'user', quota: { dayTurns: 3 } });
  const raw = readFileSync(path.join(AUDIT_DIR, (await import('node:fs')).readdirSync(AUDIT_DIR)[0]), 'utf8');
  assert.equal(/hunter2|sk-x/.test(raw), false);
  assert.equal(safeMeta({ label: 'x', token: 't' }), undefined);
  await appendUsageEvent({ actor: 'admin', scope: 'u:alice', workspace: '/w', accountId: 'a-1', model: 'm', tokens: 12, cost: 0.5, source: 'chat' });
  const ev = await readUsageEvents({ limit: 1 });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].scope, 'u:alice');
  assert.equal(ev[0].tokens, 12);
  assert.equal(ev[0].billedTo, '', '没给计费人就是空（管理员自己的轮）');
});

test('审计：目录在运行中被删会重建；multiUser / hidden 进白名单；邀请码只留哈希前缀；用量事件的计费人与 scope 分开', async () => {
  assert.equal(await appendAudit({ actor: 'admin', action: 'access', meta: { multiUser: true } }), true);
  rmSync(AUDIT_DIR, { recursive: true, force: true });
  assert.equal(await appendAudit({ actor: 'admin', action: 'invite/revoke', meta: { code: 'SECRETCODE12' } }), true, '删了目录照样写得进去');
  assert.equal(existsSync(AUDIT_DIR), true);
  assert.equal(await appendAudit({ actor: 'admin', action: 'invite', meta: { tier: 'user', code: 'SECRETCODE12' } }), true);
  const rows = await readAudit({ limit: 5 });
  assert.equal(rows.length, 2, '删目录之前那条随目录一起没了，之后两条都在');
  assert.match(rows[0].meta.codeHash, /^[0-9a-f]{10}$/);
  assert.equal(rows[0].meta.codeHash, rows[1].meta.codeHash, '发码与作废对得上');
  assert.equal(JSON.stringify(rows).includes('SECRETCODE12'), false, '码本身不进文件');
  assert.deepEqual(safeMeta({ multiUser: false, hidden: true, what: 'routines' }), { multiUser: false, hidden: true, what: 'routines' });
  // 用量事件：快照访客那一轮 scope 是快照令牌，账记给铸造者
  const { USAGE_EVENT_DIR } = await import('./runtime/audit-log.mjs');
  rmSync(USAGE_EVENT_DIR, { recursive: true, force: true });
  assert.equal(await appendUsageEvent({ actor: 'c:tk', scope: 'c:tk', billedTo: 'u:alice', tokens: 3, cost: 0.1, source: 'snap' }), true);
  const ev = await readUsageEvents({ limit: 1 });
  assert.equal(ev[0].scope, 'c:tk');
  assert.equal(ev[0].billedTo, 'u:alice');
});

test('noteTurnUsage（对话 / 定时任务收尾时调）：actor / scope 取自 ctx，计费人按账号 id 拼 owner 键；代聊时 actor 是主机；坏输入不抛', async () => {
  const alice = contextFor({ kind: 'user', user: 'alice', tier: 'pro' });
  assert.equal(await noteTurnUsage(alice, { billTo: 'alice', accountId: 'a-1', model: 'claude-x', tokens: 7, cost: 0.25, source: 'chat' }), true);
  let ev = (await readUsageEvents({ limit: 1 }))[0];
  assert.deepEqual(
    { actor: ev.actor, scope: ev.scope, billedTo: ev.billedTo, workspace: ev.workspace, accountId: ev.accountId, model: ev.model, tokens: ev.tokens, cost: ev.cost, source: ev.source },
    { actor: 'u:alice', scope: 'u:alice', billedTo: 'u:alice', workspace: alice.cwd, accountId: 'a-1', model: 'claude-x', tokens: 7, cost: 0.25, source: 'chat' });
  const proxied = contextFor({ kind: 'user', user: 'alice', tier: 'pro', actor: 'admin' });
  await noteTurnUsage(proxied, { billTo: 'alice', tokens: 1, source: 'proxy' });
  ev = (await readUsageEvents({ limit: 1 }))[0];
  assert.equal(ev.actor, 'admin');
  assert.equal(ev.scope, 'u:alice');
  assert.equal(ev.billedTo, 'u:alice', '代聊的轮记被代那个人的账（与 usage.json 一致）');
  await noteTurnUsage(contextFor({ kind: 'admin' }), { tokens: 2 });
  assert.equal((await readUsageEvents({ limit: 1 }))[0].billedTo, '');
  assert.equal(typeof noteTurnUsage(null).then, 'function', '没有 ctx 也只回一个 Promise，不抛');
  // contextFor 的 owner 键改由 principal.ownerKey 生成之后格式逐字不变
  assert.equal(contextFor({ kind: 'share', token: 'st', dir: tmp }).key, 's:st');
  assert.equal(contextFor({ kind: 'snap', token: 'tk', dir: tmp }).key, 'c:tk');
  assert.equal(contextFor(null).key, 'admin');
});

test('浏览器：只有主机身份开进桌面壳，其他属主无头（成员持久配置档、快照访客临时 profile）；closeBrowsersOf 只收那个人的，启动途中被收也不留孤儿', async () => {
  const { CdpSession } = await import('./runtime/cdp.mjs');
  const br = await import('./runtime/claude-browser.mjs');
  const origLaunch = CdpSession.prototype.launch;
  const origClose = CdpSession.prototype.close;
  const calls = [];
  const profiles = [];
  const closed = [];
  let gate = null;
  // 不起真浏览器：launch 只记下「让不让进壳」，造一个活着的假会话
  CdpSession.prototype.launch = async function (url, opts = {}) {
    calls.push(opts.desktop);
    profiles.push(opts.profileDir);
    if (gate) await gate;
    this.external = true;
    this.ws = { readyState: 1, close() {} };
  };
  CdpSession.prototype.close = function () { closed.push(this); this.dead = true; this.ws = null; };
  try {
    const ws = path.join(tmp, 'br-ws');
    assert.equal(br._desktopAllowed(ws), true, '只给路径的老调用方（Codex 通道）照旧');
    assert.equal(br._desktopAllowed(poolRef('admin', ws)), true);
    assert.equal(br._desktopAllowed(poolRef('u:alice', ws)), false);
    assert.equal(br._desktopAllowed(poolRef('c:tk', ws)), false, '快照访客也不进壳');
    const proxied = contextFor({ kind: 'user', user: 'alice', tier: 'pro', actor: 'admin' });
    assert.equal(br._desktopAllowed(poolRef(proxied, ws)), false, '管理员代聊时用的是被代那个人的浏览器');
    const a = await br.getBrowser(poolRef('admin', ws));
    assert.equal(await br.getBrowser(ws), a, '只给路径 = 主机那一份');
    const m = await br.getBrowser(poolRef('u:alice', ws));
    const s = await br.getBrowser(poolRef('c:tk', ws));
    assert.deepEqual(calls, [true, false, false]);
    assert.deepEqual(profiles, [br.profileDirFor('admin'), br.profileDirFor('u:alice'), ''], '主机 / 成员持久，快照访客临时');
    assert.match(profiles[1], /alice[\\/]\.bridge[\\/]browser-profile$/);
    assert.notEqual(m, a);
    assert.equal(br.closeBrowsersOf('u:alice'), 1);
    assert.equal(br.existingBrowser(poolRef('u:alice', ws)), null);
    assert.ok(closed.includes(m));
    assert.equal(br.existingBrowser(ws), a, '主机的不动');
    assert.equal(br.existingBrowser(poolRef('c:tk', ws)), s, '别人的不动');
    assert.equal(br.closeBrowsersOf(''), 0);
    // 启动途中被收：刚起来的进程当场关掉，不留在池外没人管
    let open;
    gate = new Promise((r) => { open = r; });
    const p = br.getBrowser(poolRef('u:bob', ws));
    assert.equal(br.closeBrowsersOf('u:bob'), 1);
    open();
    await assert.rejects(p);
    assert.equal(closed.length, 2);
    assert.equal(br.existingBrowser(poolRef('u:bob', ws)), null);
  } finally {
    gate = null;
    br.closeAllBrowsers();
    CdpSession.prototype.launch = origLaunch;
    CdpSession.prototype.close = origClose;
  }
});

test('控制台查看他人数据：同意检查通过、真交出数据之后才记 user/view，带凭据来源；被拒的不记', async () => {
  const users = await import('./users.mjs');
  const acc = await import('./runtime/admin-access.mjs');
  const { registerAdminRoutes } = await import('./routes/admin.mjs');
  const { Readable } = await import('node:stream');
  await users.createUser('vera', 'password123', 'user');
  const h = {};
  registerAdminRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; } }, { authOk: () => true, adminCredential: () => ({ via: 'master' }) });
  const call = (url) => new Promise((resolve) => {
    const u = new URL(url, 'http://x');
    const req = Readable.from([]);
    Object.assign(req, { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0;
    const res = { headersSent: false, writableEnded: false, writeHead(st) { status = st; return this; }, setHeader() {}, write() { return true }, end() { resolve(status); }, on() {}, once() {} };
    h['GET ' + u.pathname](req, res, u);
  });
  const views = async () => (await readAudit({ limit: 50, filter: (e) => e.action === 'user/view' && e.target === 'u:' + users.accountIdOf('vera') }));
  await new Promise((r) => setTimeout(r, 50));
  const before = (await views()).length;
  assert.equal(await call('/api/admin/user/media?name=vera'), 403, '没允许看内容');
  assert.equal(await call('/api/admin/user/vertex-session?name=vera&id=x'), 403);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await views()).length, before, '被拒的不记成查看');
  assert.equal(await call('/api/admin/user/routines?name=vera'), 200);
  await new Promise((r) => setTimeout(r, 50));
  let rows = await views();
  assert.equal(rows.length, before + 1);
  assert.deepEqual(rows[0].meta, { what: 'routines', hidden: true }, '只拿到元数据要标出来');
  assert.equal(rows[0].via, 'master', '记下是哪一张凭据');
  acc.setConsents('vera', { view: true });
  assert.equal(await call('/api/admin/user/media?name=vera'), 200);
  await new Promise((r) => setTimeout(r, 50));
  rows = await views();
  assert.deepEqual(rows[0].meta, { what: 'media', kind: 'image' });
  assert.equal(await call('/api/admin/user/media-file?name=vera&id=nope'), 404);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await views()).length, rows.length, '单张取图不逐张记');
});

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('会话可见性：授权数据落 _system、按（属主, sessionId）键控、缺省 private；属主会话库里写的不算数；改动写审计', async () => {
  const A = 'aaaaaaaa-1111-2222-3333-444444444444';
  const B = 'bbbbbbbb-1111-2222-3333-444444444444';
  assert.ok(SESSION_VISIBILITY_FILE.startsWith(SYSTEM_DIR + path.sep), '放在 _system 下，不在任何人的工作空间里');
  assert.equal(existsSync(SESSION_VISIBILITY_FILE), false, '没放宽过任何会话就没有这个文件');
  assert.equal(sessionVisibility(sessionRef('u:alice', A)), 'private');
  assert.equal(sessionVisibility(A), 'private', '只给裸 sessionId（不知道属主）一律 private');
  // 属主工作空间 .bridge 里的会话库（agent 改得到）写了 visibility：不读它，下发快照的形状也不变
  const dir = path.join(tmp, 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'claude-session-library.json'), JSON.stringify({ rev: 3, stars: [A], titles: { [A]: '标题' }, visibility: { [A]: 'org' } }));
  _resetLibraryCache();
  assert.deepEqual(getLibrary({ dataDir: dir }), { rev: 3, stars: [A], titles: { [A]: '标题' } });
  assert.equal(sessionVisibility(sessionRef('u:alice', A)), 'private', '.bridge 里写的不算数');
  // 唯一的写入口：落 _system、按属主分开、写审计
  assert.deepEqual(setSessionVisibility(sessionRef('u:alice', A), 'org', { actor: 'u:alice' }), { ok: true, visibility: 'org', changed: true });
  assert.equal(sessionVisibility(sessionRef('u:alice', A)), 'org');
  assert.equal(sessionVisibility(sessionRef('u:bob', A)), 'private', '同一个 sessionId 换个属主是另一条');
  assert.deepEqual(JSON.parse(readFileSync(SESSION_VISIBILITY_FILE, 'utf8')), { 'u:alice': { [A]: 'org' } });
  await tick();
  const row = (await readAudit({ limit: 5, filter: (e) => e.action === 'session/visibility' }))[0];
  assert.deepEqual({ actor: row.actor, target: row.target, meta: row.meta }, { actor: 'u:alice', target: 'u:alice', meta: { sessionId: A, visibility: 'org' } });
  assert.equal(setSessionVisibility(sessionRef('u:alice', B), 'weird').changed, false, '认不出的取值当 private，没变就不写');
  assert.ok(setSessionVisibility(A, 'org').error, '不带属主的引用不收');
  // 改回 private = 删掉这一条，属主下没有条目了整个桶也删
  setSessionVisibility(sessionRef('u:alice', A), 'private');
  assert.deepEqual(JSON.parse(readFileSync(SESSION_VISIBILITY_FILE, 'utf8')), {});
  // 重启（丢掉内存）后从磁盘读回
  setSessionVisibility(sessionRef('u:alice', B), 'group');
  _resetSessionVisibilityCache();
  assert.equal(sessionVisibility(sessionRef('u:alice', B)), 'group');
});

test('审计：额度策略的新字段、邀请码有效期、号池加号的 id 都记得下（令牌与名字不进文件）', async () => {
  assert.deepEqual(
    safeMeta({ maxParallelPerUser: 3, maxRoutinesPerUser: 5, member: { ultracode: true, fast: false }, preset: 'recommended', days: 7, token: 'x', label: 'y' }),
    { maxParallelPerUser: 3, maxRoutinesPerUser: 5, member: { ultracode: true, fast: false }, preset: 'recommended', days: 7 });
  const { registerAdminRoutes } = await import('./routes/admin.mjs');
  const { Readable } = await import('node:stream');
  const h = {};
  registerAdminRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; } }, { authOk: () => true, adminCredential: () => ({ via: 'master' }) });
  const post = (url, body) => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0;
    const res = { headersSent: false, writableEnded: false, writeHead(st) { status = st; return this; }, setHeader() {}, write() { return true; }, end(s) { resolve({ status, body: String(s || '') }); }, on() {}, once() {} };
    h['POST ' + url](req, res, new URL(url, 'http://x'));
  });
  const last = async (action) => (await readAudit({ limit: 50, filter: (e) => e.action === action }))[0];
  let r = await post('/api/admin/policy', { maxParallelPerUser: 3, maxRoutinesPerUser: 5, member: { ultracode: true } });
  assert.equal(r.status, 200, r.body);
  await tick();
  let row = await last('policy');
  assert.equal(row.via, 'master');
  assert.deepEqual(row.meta, { maxParallelPerUser: 3, maxRoutinesPerUser: 5, member: { ultracode: true } }, '改了什么、改成多少都在');
  r = await post('/api/admin/policy', { preset: 'recommended' });
  assert.equal(r.status, 200, r.body);
  await tick();
  assert.deepEqual((await last('policy')).meta, { preset: 'recommended' });
  // 号池加号：id 是服务端生成的，从结果补进审计，和之后 update / move / delete 的 meta.id 对得上
  r = await post('/api/admin/claude-account/add', { label: '三号', token: 'sk-ant-oat-test-not-real' });
  assert.equal(r.status, 200, r.body);
  const id = JSON.parse(r.body).id;
  assert.ok(id);
  await tick();
  row = await last('claude-account/add');
  assert.deepEqual(row.meta, { id });
  assert.equal(/sk-ant-oat-test-not-real|三号/.test(JSON.stringify(row)), false, '令牌和名字不进审计');
  r = await post('/api/admin/claude-account/delete', { id });
  assert.equal(r.status, 200, r.body);
  await tick();
  assert.equal((await last('claude-account/delete')).meta.id, id);
  // 邀请码的有效期（测试配置开着多用户，同正式服）
  r = await post('/api/admin/invite', { tier: 'user', days: 7 });
  assert.equal(r.status, 200, r.body);
  await tick();
  row = await last('invite');
  assert.equal(row.meta.days, 7);
  assert.match(row.meta.codeHash, /^[0-9a-f]{10}$/);
  assert.equal(JSON.stringify(row).includes(JSON.parse(r.body).code), false, '码本身不进文件');
});

test('数据布局迁移在 import 阶段最先跑：server.mjs 紧跟 config 之后 import layout-boot，它的导入链里没有任何台账模块', async () => {
  const { fileURLToPath } = await import('node:url');
  const src = path.dirname(fileURLToPath(import.meta.url));
  // 静态 import / export … from（模块求值顺序只看这些；动态 import 不算）
  const importsOf = (file) => [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const closure = (file, seen = new Set()) => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const spec of importsOf(file)) if (spec.startsWith('.')) closure(path.resolve(path.dirname(file), spec), seen);
    return seen;
  };
  const rel = (f) => path.relative(src, f).split(path.sep).join('/');
  const deps = [...closure(path.join(src, 'runtime', 'layout-boot.mjs'))].map(rel);
  for (const bad of ['users.mjs', 'runtime/policy.mjs', 'runtime/claude-account.mjs', 'runtime/identity.mjs', 'runtime/session-library.mjs', 'runtime/audit-log.mjs', 'jsonfile.mjs']) {
    assert.equal(deps.includes(bad), false, 'layout-boot 的导入链里不能有 ' + bad);
  }
  assert.deepEqual(deps.filter((f) => !f.startsWith('config/') && f !== 'runtime/paths.mjs').sort(), ['runtime/layout-boot.mjs', 'runtime/layout.mjs', 'runtime/principal.mjs']);
  const server = importsOf(path.join(src, 'server.mjs'));
  const at = server.indexOf('./runtime/layout-boot.mjs');
  assert.ok(at > 0, 'server.mjs 要 import layout-boot');
  assert.deepEqual(server.slice(0, at).filter((s) => s.startsWith('.')), ['./config/index.mjs'], '在它之前只有 node 内置与 config');
  assert.equal(server.includes('./runtime/layout.mjs'), false, 'server.mjs 不再在函数体里自己调 migrateLayout');
  const { bootLayout } = await import('./runtime/layout-boot.mjs');
  assert.equal(bootLayout.version, LAYOUT_VERSION);
});

test('浏览器面板：state 带 desktop——主机的开在桌面壳里，成员的是无头（本机桌面客户端据此回落帧流）', async () => {
  const { CdpSession } = await import('./runtime/cdp.mjs');
  const br = await import('./runtime/claude-browser.mjs');
  const { registerClaudeDockRoutes } = await import('./routes/claude-dock.mjs');
  const { EventEmitter } = await import('node:events');
  const origLaunch = CdpSession.prototype.launch;
  const origClose = CdpSession.prototype.close;
  // 不起真浏览器：让进壳的就当成开在壳里（external），其余是无头
  CdpSession.prototype.launch = async function (url, opts = {}) { this.external = opts.desktop !== false; this.ws = { readyState: 1, close() {} }; };
  CdpSession.prototype.close = function () { this.dead = true; this.ws = null; };
  let who = { kind: 'admin' };
  const h = {};
  registerClaudeDockRoutes({ on: (m, p, fn) => { h[m + ' ' + p] = fn; } }, { identify: () => who });
  const call = (url) => new Promise((resolve) => {
    const u = new URL(url, 'http://x');
    const req = Object.assign(new EventEmitter(), { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0;
    const chunks = [];
    const res = Object.assign(new EventEmitter(), {
      headersSent: false, writableEnded: false,
      writeHead(st) { status = st; return this; }, setHeader() {},
      write(s) { chunks.push(String(s)); if (String(s).includes('"type":"state"')) resolve({ status, sse: chunks.join(''), close: () => req.emit('close') }); return true; },
      end(s) { this.writableEnded = true; resolve({ status, body: String(s || '') }); },
    });
    h['GET ' + u.pathname](req, res, u);
  });
  try {
    const memberWs = userRootOf('dora');
    mkdirSync(memberWs, { recursive: true });
    who = { kind: 'user', user: 'dora', tier: 'pro' };
    await br.getBrowser(poolRef(contextFor(who), memberWs));
    let r = await call('/api/claude/browser/state?ws=' + encodeURIComponent(memberWs));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual([JSON.parse(r.body).alive, JSON.parse(r.body).desktop], [true, false]);
    r = await call('/api/claude/browser/stream?native=1&ws=' + encodeURIComponent(memberWs));
    assert.match(r.sse, /"type":"state"[^\n]*"desktop":false/, 'native=1 的连接也能从 state 事件得知要换帧流');
    const memberBrowser = br.existingBrowser(poolRef(contextFor(who), memberWs));
    assert.deepEqual([...memberBrowser.viewers.values()].map((v) => v.kind), ['native'], '直播连接登记为观众（agent 据此知道用户看不看得到）');
    r.close();
    assert.equal(memberBrowser.viewers.size, 0, '断开即撤');
    who = { kind: 'admin' };
    const hostWs = path.join(tmp, 'host-ws');
    mkdirSync(hostWs, { recursive: true });
    await br.getBrowser(poolRef('admin', hostWs));
    r = await call('/api/claude/browser/state?ws=' + encodeURIComponent(hostWs));
    assert.equal(JSON.parse(r.body).desktop, true, '主机的照旧走原生视图');
  } finally {
    br.closeAllBrowsers();
    CdpSession.prototype.launch = origLaunch;
    CdpSession.prototype.close = origClose;
  }
});
