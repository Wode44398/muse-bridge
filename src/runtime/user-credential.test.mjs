// 注册用户自带 Claude 凭据：存取、校验、只回脱敏视图，以及跑 Claude 时的 env 注入——
// 填了的人只拿到自己的那一份，共用的订阅令牌绝不漏进去；策略要求自带凭据时没填的人什么认证都拿不到。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-usercred-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
delete process.env.ANTHROPIC_API_KEY;
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-shared-server-token';
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ token: 'x'.repeat(32), claudeAccounts: [{ id: 'a-1', label: '默认账号', token: 'sk-ant-oat01-shared-console-token' }] }));

const cred = await import('./user-credential.mjs');
const { claudeEngineEnv } = await import('./claude-account.mjs');
const { setPolicy } = await import('./policy.mjs');

const OAUTH = 'sk-ant-oat01-' + 'a'.repeat(40);
const KEY = 'sk-ant-api03-' + 'b'.repeat(40);
const userCtx = (user) => ({ kind: 'user', user, configDir: path.join(tmp, 'users', user, '.bridge', 'claude') });

test('校验：空的、太短的、带空格的都不收', () => {
  assert.ok(cred.setCredential('alice', { token: '' }).error);
  assert.ok(cred.setCredential('alice', { token: 'short' }).error);
  assert.ok(cred.setCredential('alice', { token: 'sk-ant-api03 ' + 'b'.repeat(30) }).error);
  assert.equal(cred.hasCredential('alice'), false);
});

test('自动识别订阅令牌与 API Key；对外只给尾 4 位', () => {
  assert.equal(cred.guessKind(OAUTH), 'oauth');
  assert.equal(cred.guessKind(KEY), 'apikey');
  const r = cred.setCredential('Alice', { token: OAUTH });
  assert.equal(r.ok, true);
  assert.deepEqual({ ...r.credential, updated: 0 }, { configured: true, kind: 'oauth', tail: 'aaaa', baseUrl: '', updated: 0 });
  assert.equal(JSON.stringify(cred.publicView('alice')).includes(OAUTH), false);
});

test('自定义接口地址：只收 https 域名，订阅令牌忽略它', () => {
  assert.ok(cred.setCredential('bob', { token: KEY, baseUrl: 'http://api.example.com' }).error);
  assert.ok(cred.setCredential('bob', { token: KEY, baseUrl: 'https://127.0.0.1:8787' }).error);
  assert.ok(cred.setCredential('bob', { token: KEY, baseUrl: 'https://localhost' }).error);
  assert.ok(cred.setCredential('bob', { token: KEY, baseUrl: 'https://[::1]/' }).error);
  assert.equal(cred.setCredential('bob', { token: KEY, baseUrl: 'https://api.example.com/v1/' }).credential.baseUrl, 'https://api.example.com/v1');
  assert.equal(cred.setCredential('carol', { token: OAUTH, baseUrl: 'https://api.example.com' }).credential.baseUrl, '');
});

test('填了凭据的人：env 里只有他自己的，共用令牌被摘掉', () => {
  const a = claudeEngineEnv(userCtx('alice'));
  assert.equal(a.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
  assert.equal(a.ANTHROPIC_API_KEY, undefined);
  const b = claudeEngineEnv(userCtx('bob'));
  assert.equal(b.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(b.ANTHROPIC_API_KEY, KEY);
  assert.equal(b.ANTHROPIC_BASE_URL, 'https://api.example.com/v1');
  assert.equal(b.CLAUDE_CONFIG_DIR, userCtx('bob').configDir);
});

test('没填的人：策略没开时回落共用账号；开了就什么认证都没有', () => {
  setPolicy({ userOwnKey: false });
  assert.equal(claudeEngineEnv(userCtx('dave')).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-shared-console-token');
  setPolicy({ userOwnKey: true });
  const e = claudeEngineEnv(userCtx('dave'));
  assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(e.ANTHROPIC_API_KEY, undefined);
  assert.equal(e.CLAUDE_CONFIG_DIR, userCtx('dave').configDir);
  setPolicy({ userOwnKey: false });
});

test('管理员不受影响：仍用共用账号', () => {
  assert.equal(claudeEngineEnv({ kind: 'admin', configDir: null }).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-shared-console-token');
});

test('删掉凭据后回到没填的状态', () => {
  cred.clearCredential('alice');
  assert.equal(cred.publicView('alice').configured, false);
  assert.equal(cred.getCredential('alice'), null);
});
