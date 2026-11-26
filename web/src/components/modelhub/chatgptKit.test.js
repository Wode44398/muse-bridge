// chatgptKit.js 的纯逻辑：登录阶段、报错人话、粘贴地址的粗检、账号摘要与提醒、账号操作 → update 的 lines。
// 跑法：node --test web/src/components/modelhub/chatgptKit.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loginPhase, loginLive, loginErrText, pasteProblem, minutesLeft, cgAccounts, accountNeed, accountNote, accountName,
  accountsText, accountTags, linesPatch, isCg, usageUrlOf, USAGE_URL,
} from './chatgptKit.js';

const NOW = 1_800_000_000_000;

test('loginPhase：服务端的状态 + 过期时间 → 界面阶段', () => {
  assert.equal(loginPhase(null, NOW), 'idle');
  assert.equal(loginPhase({ status: 'pending' }, NOW), 'idle', '没有 id 的不算');
  assert.equal(loginPhase({ id: 'a', status: 'pending', expiresAt: NOW + 1000 }, NOW), 'pending');
  assert.equal(loginPhase({ id: 'a', status: 'pending', expiresAt: NOW }, NOW), 'expired', '到点就算过期，不再等');
  assert.equal(loginPhase({ id: 'a', status: 'pending' }, NOW), 'pending', '没给过期时间的照旧等');
  assert.equal(loginPhase({ id: 'a', status: 'exchanging', expiresAt: NOW - 1 }, NOW), 'exchanging', '换令牌中不看过期');
  assert.equal(loginPhase({ id: 'a', status: 'done' }, NOW), 'done');
  assert.equal(loginPhase({ id: 'a', status: 'error', errorCode: 'denied' }, NOW), 'error');
  assert.equal(loginPhase({ id: 'a', status: 'error', errorCode: 'expired' }, NOW), 'expired');
  assert.equal(loginLive('pending') && loginLive('exchanging'), true);
  assert.equal(loginLive('done') || loginLive('error') || loginLive('expired') || loginLive('idle'), false);
});

test('loginErrText：认得的 errorCode 说人话，别的用服务端原文', () => {
  assert.equal(loginErrText({ errorCode: 'denied' }), '你在登录页拒绝了授权');
  assert.equal(loginErrText({ errorCode: 'no_plan' }), '这个账号没开通套餐额度授权');
  assert.equal(loginErrText({ errorCode: 'not_eligible' }), '这个账号不能用套餐额度（需要付费套餐）');
  assert.equal(loginErrText({ errorCode: 'expired' }), '登录已过期');
  assert.equal(loginErrText({ errorCode: 'state', error: '回调地址的 state 对不上' }), '回调地址的 state 对不上');
  assert.equal(loginErrText({ errorCode: 'network' }), '登录没有完成', '什么都没给也有一句');
});

test('pasteProblem：只挡明显粘错的', () => {
  assert.ok(pasteProblem(''));
  assert.ok(pasteProblem('   '));
  assert.ok(pasteProblem('code=abc'), '只粘了查询串');
  assert.ok(pasteProblem('http://127.0.0.1:1455/auth/callback'), '没带查询串（code / state 都在里面）');
  assert.ok(pasteProblem('http://127.0.0.1:1455/auth/callback?code=a b'), '中间有空白');
  assert.equal(pasteProblem('  http://127.0.0.1:1455/auth/callback?code=abc&state=xyz \n'), '');
  assert.equal(pasteProblem('http://localhost:1455/auth/callback?error=access_denied&state=x'), '', '拒绝授权的回调也交给服务端判');
});

test('minutesLeft：向上取整，过了是 0', () => {
  assert.equal(minutesLeft(NOW + 10 * 60000, NOW), 10);
  assert.equal(minutesLeft(NOW + 61000, NOW), 2);
  assert.equal(minutesLeft(NOW, NOW), 0);
  assert.equal(minutesLeft(undefined, NOW), 0);
});

const acc = (o) => ({ lineId: 'l1', email: 'a@x.com', label: 'a@x.com', enabled: true, status: 'ok', statusText: '', ...o });
const svcOf = (accounts, lines) => ({
  id: 'h-1', kind: 'chatgpt', baseUrl: 'https://api.openai.com/v1',
  lines: lines || accounts.map((a) => ({ id: a.lineId, label: a.label, baseUrl: '', enabled: a.enabled })),
  chatgpt: { usageUrl: 'https://chatgpt.com/settings/usage', accounts },
});

test('账号摘要：一个 = 邮箱；多个 =「邮箱 等 N 个账号」；没有账号也有一句', () => {
  assert.equal(accountsText(svcOf([acc()])), 'a@x.com');
  assert.equal(accountsText(svcOf([acc(), acc({ lineId: 'l2', email: 'b@x.com', label: 'b@x.com' })])), 'a@x.com 等 2 个账号');
  assert.equal(accountsText(svcOf([])), '还没有账号');
  // 总览旧、没带 chatgpt 段：退回线路标签
  assert.equal(accountsText({ kind: 'chatgpt', lines: [{ id: 'l1', label: 'c@x.com', enabled: true }] }), 'c@x.com');
  assert.equal(isCg(svcOf([])), true);
  assert.equal(isCg({ kind: 'openai' }), false);
  assert.equal(usageUrlOf(null), USAGE_URL);
});

test('首页提醒：要重新登录的优先；停用的账号不算；单账号不说个数', () => {
  assert.deepEqual(accountTags(svcOf([acc()])), []);
  assert.deepEqual(accountTags(svcOf([acc({ status: 'relogin' })])).map((x) => x.text), ['要重新登录']);
  assert.deepEqual(accountTags(svcOf([acc({ status: 'missing' })])).map((x) => x.text), ['要重新登录'], '凭据丢了也是重新登录');
  assert.deepEqual(accountTags(svcOf([acc({ status: 'no_plan' })])).map((x) => x.text), ['没授权套餐额度']);
  const two = svcOf([acc({ status: 'no_plan' }), acc({ lineId: 'l2', status: 'relogin' }), acc({ lineId: 'l3', status: 'relogin', enabled: false })]);
  assert.deepEqual(accountTags(two), [{ text: '1 个账号要重新登录', tone: 'warn' }]);
  assert.deepEqual(accountTags(svcOf([acc({ status: 'no_plan' }), acc({ lineId: 'l2' })])).map((x) => x.text), ['1 个账号没授权套餐额度']);
});

test('账号行：状态文字与显示名', () => {
  assert.equal(accountNote(acc()), '');
  assert.equal(accountNote(acc({ enabled: false, status: 'relogin' })), '已停用', '停用的不催登录');
  assert.equal(accountNote(acc({ status: 'relogin', statusText: '令牌被吊销了，要重新登录' })), '令牌被吊销了，要重新登录', '后端的人话优先');
  assert.equal(accountNote(acc({ status: 'relogin' })), '需要重新登录');
  assert.equal(accountNote(acc({ status: 'missing' })), '凭据丢失，需要重新登录');
  assert.equal(accountNote(acc({ status: 'no_plan' })), '没授权套餐额度');
  assert.equal(accountNeed(acc({ status: 'no_plan' })), 'plan');
  assert.equal(accountName(acc()), 'a@x.com');
  assert.equal(accountName(acc({ label: '工作号' })), '工作号 · a@x.com');
  assert.equal(accountName(acc({ email: '', label: '' })), 'ChatGPT 账号');
});

test('linesPatch：以服务视图的线路为准（顺序不变），不带 key，baseUrl 恒空', () => {
  const s = svcOf([acc(), acc({ lineId: 'l2', email: 'b@x.com', label: '工作号' })]);
  assert.deepEqual(linesPatch(s, { toggle: 'l2', on: false }), [
    { id: 'l1', label: 'a@x.com', baseUrl: '', enabled: true }, { id: 'l2', label: '工作号', baseUrl: '', enabled: false },
  ]);
  assert.deepEqual(linesPatch(s, { remove: 'l1' }), [{ id: 'l2', label: '工作号', baseUrl: '', enabled: true }]);
  for (const l of linesPatch(s, null)) assert.equal('key' in l, false);
  // 线路缺了（总览旧）：从账号段拼
  assert.deepEqual(linesPatch({ chatgpt: { accounts: [acc()] } }, { toggle: 'l1', on: false }), [{ id: 'l1', label: 'a@x.com', baseUrl: '', enabled: false }]);
  assert.deepEqual(cgAccounts(null), []);
});
