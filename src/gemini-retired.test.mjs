// Gemini 对话 2026-11-04 下线（维护者：「不保留gemini对话了」）：老 apk / 老控制台还会打的对话接口一律 410 + 中文说明，
// 不落进 404 或「认不出的按 Claude 跑」；残留的 Gemini 定时任务读到时停用并写原因（不删）；名单 / 开关里的 gemini 换成 studio。
// 原来这里是「管理员代聊 Gemini」的测试（git mv 自 admin-proxy-gemini.test.mjs）。数据根改道到临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-proxygem-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_NO_AUTH = '';
mkdirSync(path.join(tmp, 'vault'), { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 18998, token: 'test-token-not-real', vaultPath: path.join(tmp, 'vault'), usersRoot: path.join(tmp, 'users'), features: { multiUser: true } }, null, 2));

const users = await import('./users.mjs');
const { registerAdminRoutes } = await import('./routes/admin.mjs');
const { registerGeminiRetiredRoutes, GEMINI_RETIRED } = await import('./routes/gemini-retired.mjs');
const routines = await import('./routines.mjs');
const { normAgentList, AGENT_IDS } = await import('./config/agents.mjs');

await users.createUser('olga', 'password123', 'user');

function call(h, method, url, body) {
  return new Promise((resolve) => {
    const u = new URL(url, 'http://x');
    const req = Readable.from(body != null ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0, chunks = '';
    const res = {
      headersSent: false, writableEnded: false,
      writeHead(s) { status = s; this.headersSent = true; return this; },
      setHeader() {}, write(c) { chunks += c; return true; },
      end(c) { if (c) chunks += c; this.writableEnded = true; let j = null; try { j = JSON.parse(chunks); } catch {} resolve({ status, body: j }); },
      on() {}, once() {},
    };
    h(req, res, u);
  });
}

test('对话接口：会话列表 / 详情 / 删除与控制台代聊、查看 Gemini 对话一律 410，带中文说明', async () => {
  const exact = {}, prefixes = [];
  const router = { on: (m, p, fn) => { exact[m + ' ' + p] = fn; }, prefix: (m, p, fn) => prefixes.push({ m: [].concat(m), p, fn }) };
  registerGeminiRetiredRoutes(router);
  registerAdminRoutes(router, { authOk: () => true });
  const find = (m, url) => exact[m + ' ' + new URL(url, 'http://x').pathname] || prefixes.find((x) => x.m.includes(m) && new URL(url, 'http://x').pathname.startsWith(x.p))?.fn;
  for (const [m, url, body] of [
    ['GET', '/api/vertex/sessions'], ['GET', '/api/vertex/session?id=x'], ['POST', '/api/vertex/session/delete', { id: 'x' }],
    ['GET', '/api/admin/user/vertex?name=olga'], ['GET', '/api/admin/user/vertex-session?name=olga&id=x'],
    ['POST', '/api/admin/user/chat', { name: 'olga', agent: 'vertex', message: 'hi' }],
  ]) {
    const r = await call(find(m, url), m, url, body);
    assert.equal(r.status, 410, url);
    assert.equal(r.body.error, GEMINI_RETIRED);
  }
  assert.match(GEMINI_RETIRED, /Media Studio/);
});

test('名单里的 gemini 换成 studio；表里没有 gemini 这个 agent', () => {
  assert.equal(AGENT_IDS.includes('gemini'), false);
  assert.deepEqual(normAgentList(['gemini', 'claude']), ['claude', 'studio']);
  assert.deepEqual(users.userGrants({ agents: ['gemini'] }).agents, ['studio']);
});

test('残留的 Gemini 定时任务：读到时停用并写明原因，不删；编辑后转成 Claude', () => {
  const dir = path.join(tmp, 'rt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'routines.json'), JSON.stringify([{ id: 'r1', name: '早报', prompt: 'x', agent: 'vertex', enabled: true, schedule: { type: 'daily', hour: 8, minute: 0 }, nextRun: Date.now() + 1000 }]));
  const r = routines.get(dir, 'r1');
  assert.equal(r.enabled, false);
  assert.equal(r.nextRun, null);
  assert.equal(r.retired, 'gemini');
  assert.match(r.lastPreview, /Gemini 对话已下线/);
  assert.equal(routines.list(dir).length, 1, '不删');
  const u = routines.update(dir, 'r1', { enabled: true });
  assert.equal(u.agent, 'claude');
  assert.equal(u.retired, undefined);
});
