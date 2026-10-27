// 2026-10-22：两个嵌入页（deepseek / zhipu）删掉后，/api/harness/* 不再有免鉴权路径——原来放行的 /deepseek/、/zhipu/
// 静态页和其它路径一样，没登录就 401，绝不拉起 / 反代到 harness。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离：数据根放临时目录（不读正式服的 agent 开关），只加载 dimensio 这一个扩展
const tmp = mkdtempSync(path.join(os.tmpdir(), 'harness-auth-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.VAULT_PATH = tmp;
process.env.BRIDGE_MODULES_SKIP = 'codex,vertex';

const { loadModules } = await import('../../../../src/modules/registry.mjs');
await loadModules();
const { agentEnabled } = await import('../../../../src/runtime/agent-status.mjs');
const { registerHarnessRoutes } = await import('./harness.mjs');

function route() {
  let mw = null;
  registerHarnessRoutes({ use: (fn) => { mw = fn; } }, { identify: () => null });
  return async (pathname, method = 'GET') => {
    const res = { code: 0, writeHead(c) { this.code = c; }, end() {}, headersSent: false };
    const out = await mw({ method, headers: {}, url: pathname }, res, new URL('http://127.0.0.1:8787' + pathname));
    return { handled: out === false, code: res.code };
  };
}

test('原嵌入页路径没登录一律 401（不再免鉴权放行）', async () => {
  assert.equal(agentEnabled('dimensio'), true, '前提：dimensio 已加载且开着，才走到登录判断');
  const hit = route();
  for (const p of ['/api/harness/deepseek/', '/api/harness/deepseek/index.html', '/api/harness/deepseek/assets/app.css',
    '/api/harness/zhipu/', '/api/harness/zhipu/zhipu.css', '/api/harness/api/sessions']) {
    const r = await hit(p);
    assert.equal(r.handled, true, p);
    assert.equal(r.code, 401, p);
  }
});

test('不是 /api/harness 前缀的请求不归它管', async () => {
  const hit = route();
  const r = await hit('/deepseek/index.html');
  assert.equal(r.handled, false);
  assert.equal(r.code, 0);
});
