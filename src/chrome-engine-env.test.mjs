// Claude in Chrome 轮的 env（agents/claude.mjs chromeEngineEnv）：只有配置目录里真有 claude login 凭据（claudeAiOauth）
// 时才去掉号池注入的 token、改用登录态。10-28 用户 VPS：.credentials.json 里只有 CLI 存的 MCP OAuth 状态（mcpOAuth，
// 装了 context7），旧判据「文件非空」照样把 token 去掉，主机身份每轮都是「Not logged in · Please run /login」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromeEngineEnv, hasClaudeLogin } from './agents/claude.mjs';

const dir = mkdtempSync(path.join(os.tmpdir(), 'chrome-env-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const cred = (o) => writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify(o));
const base = { CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-pool' };

test('没有凭据文件：保留号池 token，补 SCOPES', () => {
  const env = chromeEngineEnv(base);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-pool');
  assert.match(env.CLAUDE_CODE_OAUTH_SCOPES, /user:profile/);
});

test('凭据文件里只有 mcpOAuth：不算登录，号池 token 照留', () => {
  cred({ mcpOAuth: { 'context7|x': { serverName: 'context7', accessToken: '' } } });
  assert.equal(hasClaudeLogin(dir), false);
  assert.equal(chromeEngineEnv(base).CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat01-pool');
});

test('真有 claudeAiOauth：去掉注入的 token，改用登录态', () => {
  cred({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' }, mcpOAuth: {} });
  assert.equal(hasClaudeLogin(dir), true);
  const env = chromeEngineEnv(base);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_SCOPES, undefined);
});

test('文件坏了 / 空对象：不算登录', () => {
  writeFileSync(path.join(dir, '.credentials.json'), '{not json');
  assert.equal(hasClaudeLogin(dir), false);
  cred({});
  assert.equal(hasClaudeLogin(dir), false);
});
