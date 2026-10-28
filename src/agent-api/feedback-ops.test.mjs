// 让 Claude 诊断并上报 bug 的操作（agent-api/ops/feedback.mjs）：上报落本机库（带 via: claude）、附件只认自己的
// uploads 和工作空间、成员看不到服务端日志、只有管理员能顺手打开推送；测试实例不跟中继说话。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-feedback-ops-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
mkdirSync(process.env.VAULT_PATH, { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: 'x'.repeat(32), feedbackRelay: 'https://relay.example' }, null, 2));

const { installLogRing } = await import('../runtime/log-ring.mjs');
const { callOp, OpError } = await import('./registry.mjs');
await import('./ops/index.mjs');
const { FEEDBACK_DIR } = await import('../runtime/feedback-upstream.mjs');
const { saveLocalFeedback } = await import('../runtime/feedback-local.mjs');

const ws = path.join(tmp, 'ws'), up = path.join(tmp, 'up'), other = path.join(tmp, 'other');
for (const d of [ws, up, other]) mkdirSync(d, { recursive: true });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
writeFileSync(path.join(ws, 'shot.png'), PNG);
writeFileSync(path.join(other, 'secret.png'), PNG);
const admin = { kind: 'admin', user: null, tier: 'admin', cwd: ws, uploads: up, agents: ['claude'] };
const member = { kind: 'user', user: 'u1', name: 'alice', tier: 'user', cwd: ws, uploads: up, agents: ['claude'] };
const env = (ctx) => ({ via: 'mcp', identity: { kind: ctx.kind, user: ctx.user, tier: ctx.tier } });

test('反馈库在隔离的数据根里（不会写进真库）', () => {
  assert.ok(path.resolve(FEEDBACK_DIR).startsWith(path.resolve(tmp)), FEEDBACK_DIR);
});

test('report：落本机一份，标 via: claude、带标题和日志摘录；附件只认工作空间 / uploads 里的', async () => {
  const r = await callOp(admin, 'feedback.report', {
    title: '重命名中文文件夹报 500', details: '步骤：文件页右键重命名。期望改名成功，实际报错。',
    evidence: 'ERR rename failed', screen: '文件', attachments: [path.join(ws, 'shot.png'), path.join(other, 'secret.png')],
  }, env(admin));
  assert.equal(r.saved, true);
  assert.equal(r.attached, 1);
  assert.equal(r.skippedAttachments, 1);
  assert.equal(r.sentToDeveloper, false);          // node --test 里不是正式实例
  const md = readFileSync(r.file, 'utf8');
  assert.match(md, /^via: claude$/m);
  assert.match(md, /^title: "重命名中文文件夹报 500"$/m);
  assert.match(md, /【经 Claude 诊断后上报】重命名中文文件夹报 500/);
  assert.match(md, /ERR rename failed/);
  const atts = readdirSync(path.join(FEEDBACK_DIR, 'attachments'));
  assert.equal(atts.length, 1);
  assert.ok(atts[0].endsWith('shot.png'));
});

test('report：同机 dimensio 实例调来的标 via: dimensio', async () => {
  const r = await callOp(admin, 'feedback.report', { title: '换模型后卡住', details: 'd', share: false }, { ...env(admin), instance: 'dimensio' });
  const md = readFileSync(r.file, 'utf8');
  assert.match(md, /^via: dimensio$/m);
  assert.match(md, /【经 dimensio 诊断后上报】换模型后卡住/);
});

test('report：成员不回服务器上的文件路径；不能打开推送', async () => {
  const r = await callOp(member, 'feedback.report', { title: 't', details: 'd', share: false }, env(member));
  assert.equal(r.file, undefined);
  assert.match(r.note, /只存进了本机/);
  await assert.rejects(callOp(member, 'feedback.report', { title: 't', details: 'd', enableSharing: true }, env(member)),
    (e) => e instanceof OpError && e.code === 'forbidden');
});

test('report：标题、正文必填', async () => {
  await assert.rejects(callOp(admin, 'feedback.report', { details: 'd' }, env(admin)), (e) => e.code === 'bad_args');
});

test('diagnose：管理员看得到最近的报错日志，成员看不到；status 说明去向', async () => {
  installLogRing();
  console.error('boom-test-marker 某个报错');
  const a = await callOp(admin, 'feedback.diagnose', { grep: 'boom-test-marker' }, env(admin));
  assert.equal(a.logs.length, 1);
  assert.match(a.logs[0], /ERROR boom-test-marker/);
  assert.ok(Array.isArray(a.crashes));
  assert.equal(a.reporting.canShare, false);
  const m = await callOp(member, 'feedback.diagnose', {}, env(member));
  assert.equal(m.logs, null);
  assert.equal(m.crashes, undefined);
  const s = await callOp(member, 'feedback.status', {}, env(member));
  assert.equal(s.mode, 'off');
  assert.match(s.note, /测试/);
});

test('saveLocalFeedback：同一秒两条不互相覆盖', () => {
  const dir = path.join(tmp, 'lib2');
  const id = { kind: 'admin', user: null };
  const a = saveLocalFeedback({ id, ctx: admin, text: 'a', feedbackDir: dir });
  const b = saveLocalFeedback({ id, ctx: admin, text: 'b', feedbackDir: dir });
  assert.notEqual(a.file, b.file);
  assert.ok(existsSync(a.file) && existsSync(b.file));
});

// 没声明 distro.feedback（bridge 本体与公开版）：去向文案与加这个声明之前逐字相同
test('未声明反馈去向：feedback.* 的说明与 note 逐字保持「bridge 开发者」', async () => {
  const { shareInfo } = await import('./ops/feedback.mjs');
  const { getOp } = await import('./registry.mjs');
  assert.equal(shareInfo({ mode: 'push' }, false).note, '上报会同时发给 bridge 开发者（经反馈中继，不带用户名）。');
  assert.equal(shareInfo({ mode: 'inbox' }, false).note, '这台就是 bridge 开发者自己的服务器：上报只进本机反馈库。');
  assert.equal(shareInfo({ mode: 'off', reason: 'instance' }, false).note, '这是测试 / 开发实例，不跟反馈中继说话：上报只进本机反馈库。');
  assert.equal(shareInfo({ mode: 'off' }, true).note, '「把用户反馈同时发给 bridge 开发者」现在关着。你是管理员：用户明确同意的话，report 带 enableSharing=true 会顺手打开它（之后在设置 › 反馈里随时能关）。');
  assert.equal(shareInfo({ mode: 'off' }, false).note, '这台服务器的管理员没打开「发给 bridge 开发者」：上报只进本机反馈库，管理员能看到。');
  assert.equal(getOp('feedback.status').desc, '这台服务器上报 bug 的去向：只进本机反馈库，还是也会发给 bridge 开发者；不能发的原因。report 之前先看它，跟用户确认时照实说去向。');
  assert.ok(getOp('feedback.report').desc.startsWith('把确认过的 bug 报上去：本机反馈库总是落一份；share=true 且这台服务器开着「发给 bridge 开发者」时，再经反馈中继发给 bridge 开发者（发出去收不回）。\n调用前必须先跟用户确认'));
  assert.equal(getOp('feedback.report').params.share.desc, '也发给 bridge 开发者（用户同意了才 true；false = 只进本机反馈库）');
  assert.equal(getOp('feedback.report').params.enableSharing.desc, '仅管理员：这台服务器的「发给 bridge 开发者」关着时顺手打开（用户明确同意才传）');
  const r = await callOp(admin, 'feedback.report', { title: 'x', details: 'y', share: true }, env(admin));
  assert.equal(r.note, '已存进本机反馈库，没有发给开发者。原因：这是测试 / 开发实例，不跟反馈中继说话：上报只进本机反馈库。');
  const s = await callOp(member, 'feedback.status', {}, env(member));
  assert.equal('destination' in s, false);
});
