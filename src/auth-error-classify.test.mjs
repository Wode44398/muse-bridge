// Claude 认证失败的两种报法：服务端从没配过认证 →「还没配置」；配过（环境变量，或控制台「Claude 账号」里加的令牌）
// 但被拒 →「登录已失效」。控制台加的令牌不进环境变量、每次 query 现注，以前只看环境变量，令牌被撤销时会误报「还没配置」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-authcls-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ token: 'x'.repeat(32), claudeAccounts: [{ id: 'a-1', label: '默认账号', token: '' }] }));

const acct = await import('./runtime/claude-account.mjs');
const { classifyError } = await import('./runtime/status.mjs');

test('没有任何令牌：报「还没配置」', () => {
  assert.equal(classifyError('401 Unauthorized', 'authentication_failed').title, '服务端还没配置 Claude 认证');
});

test('控制台账号里有令牌（环境变量里没有）：报「登录已失效」', () => {
  acct.updateAccount('a-1', { label: '默认账号', token: 'sk-ant-oat01-revoked' });
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(classifyError('OAuth access token has been revoked', 'authentication_failed').title, '登录已失效');
});
