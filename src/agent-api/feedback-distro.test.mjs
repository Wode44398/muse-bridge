// 发行版声明了反馈去向（config.json 的 distro.feedback，见 config/distro.mjs）：feedback.* 的说明与 note、
// /api/feedback/upstream 回给界面的 dest 都说声明的去向；public:true 时多一句「会公开、别写隐私、截图不公开」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-feedback-distro-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
mkdirSync(process.env.VAULT_PATH, { recursive: true });
const FEEDBACK = { to: 'Muse Bridge 项目的公开 GitHub Issue', toEn: 'the public Muse Bridge GitHub issues', public: true };
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  port: 8787, token: 'x'.repeat(32), feedbackRelay: 'https://relay.example',
  distro: { id: 'muse', brand: 'Muse Bridge', feedback: FEEDBACK },
}, null, 2));

const { callOp } = await import('./registry.mjs');
await import('./ops/index.mjs');
const { getOp } = await import('./registry.mjs');
const { shareInfo, PUBLIC_NOTE } = await import('./ops/feedback.mjs');
const { createFeedbackUpstream } = await import('../runtime/feedback-upstream.mjs');
const { resolveDistro } = await import('../config/distro.mjs');

const ws = path.join(tmp, 'ws'); mkdirSync(ws, { recursive: true });
const admin = { kind: 'admin', user: null, tier: 'admin', cwd: ws, uploads: path.join(tmp, 'up'), agents: ['claude'] };
const env = { via: 'mcp', identity: { kind: 'admin', user: null, tier: 'admin' } };

test('feedback.status：说声明的去向，不再说「bridge 开发者」', async () => {
  const s = await callOp(admin, 'feedback.status', {}, env);
  assert.equal(s.destination, FEEDBACK.to);
  assert.equal(s.destinationPublic, true);
  assert.doesNotMatch(JSON.stringify(s), /bridge 开发者/);
  assert.match(getOp('feedback.status').desc, /Muse Bridge 项目的公开 GitHub Issue/);
  assert.doesNotMatch(getOp('feedback.status').desc, /bridge 开发者/);
});

test('shareInfo：推送开着时写明去向 + 公开提醒（会公开、别写隐私、截图不公开）', () => {
  const n = shareInfo({ mode: 'push' }, false).note;
  assert.ok(n.startsWith('上报会同时发给 Muse Bridge 项目的公开 GitHub Issue（经反馈中继，不带用户名）。'));
  assert.ok(n.includes(PUBLIC_NOTE));
  assert.match(PUBLIC_NOTE, /公开/);
  assert.match(PUBLIC_NOTE, /隐私/);
  assert.match(PUBLIC_NOTE, /截图不会公开/);
  // 管理员那句「现在关着」也带上去向与公开提醒（打开前就要知情）
  const off = shareInfo({ mode: 'off' }, true).note;
  assert.ok(off.includes('「把用户反馈同时发给 Muse Bridge 项目的公开 GitHub Issue」现在关着'));
  assert.ok(off.includes(PUBLIC_NOTE));
  assert.ok(shareInfo({ mode: 'off' }, false).note.includes('「发给 Muse Bridge 项目的公开 GitHub Issue」'));
  assert.doesNotMatch(shareInfo({ mode: 'inbox' }, false).note, /开发者/);
});

test('shareInfo：声明了去向但不公开 = 不加公开提醒', () => {
  const dest = resolveDistro({ feedback: { to: 'Foo 团队' } }).feedback;
  const n = shareInfo({ mode: 'push' }, false, dest).note;
  assert.equal(n, '上报会同时发给 Foo 团队（经反馈中继，不带用户名）。');
});

test('feedback.report 的说明与参数描述用声明的去向，并要求跟用户说清会公开', () => {
  const op = getOp('feedback.report');
  assert.match(op.desc, /发给 Muse Bridge 项目的公开 GitHub Issue/);
  assert.ok(op.desc.includes(PUBLIC_NOTE));
  assert.doesNotMatch(op.desc, /发给 bridge 开发者/);
  assert.equal(op.params.share.desc, '也发给 Muse Bridge 项目的公开 GitHub Issue（用户同意了才 true；false = 只进本机反馈库）');
});

test('feedback.report：没发出去时的 note 不再说「开发者」', async () => {
  const r = await callOp(admin, 'feedback.report', { title: 't', details: 'd', share: true }, env);
  assert.match(r.note, /^已存进本机反馈库，没有发出去。原因：/);
});

test('upstream.state()：声明了才带 dest，界面据此换文案', () => {
  const mk = (distro) => createFeedbackUpstream({ dataRoot: tmp, configPath: path.join(tmp, 'config.json'), feedbackDir: path.join(tmp, 'fb'), relayUrl: 'https://relay.example', instanceOk: true, distro });
  assert.deepEqual(mk(resolveDistro({ feedback: FEEDBACK })).state().dest, FEEDBACK);
  assert.equal('dest' in mk(resolveDistro({})).state(), false);
});
