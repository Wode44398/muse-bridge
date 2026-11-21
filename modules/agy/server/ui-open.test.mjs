import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-uiopen-'));
const dataRoot = path.join(tmp, 'data');
const vault = path.join(tmp, 'vault');
mkdirSync(path.join(dataRoot, 'agy'), { recursive: true });
mkdirSync(path.join(tmp, 'users'), { recursive: true });
mkdirSync(vault, { recursive: true });
writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ port: 18998, token: 'agy-uiopen-test-token-0123456789', vaultPath: vault, usersRoot: path.join(tmp, 'users') }));
process.env.BRIDGE_DATA_ROOT = dataRoot;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = vault;
process.env.BRIDGE_MODULES_SKIP = 'studio,codex,dimensio';

const { resolveAgyUiPath } = await import('./routes/agy-ui-open.mjs');
const { contextFor } = await import('@bridge/core/runtime/identity.mjs');
await import('@bridge/core/agent-api/ops/ui.mjs');
const { callOp } = await import('@bridge/core/agent-api/registry.mjs');
const { busSubscribe } = await import('@bridge/core/runtime/bus.mjs');
const { noteUiState, answerUiRequest } = await import('@bridge/core/runtime/ui-state.mjs');

after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const R = (p) => realpathSync(p);
// 会话目录放在文件根（vault）里，另一个目录在根外
const proj = path.join(vault, 'proj');
const outside = path.join(tmp, 'outside');
mkdirSync(path.join(proj, 'src'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(path.join(proj, 'src', 'a.js'), '1');
writeFileSync(path.join(outside, 'b.md'), '2');

test('ui_open 路径：相对路径按会话目录解析，结果相对会话目录', () => {
  const ctx = contextFor({ kind: 'admin' });
  const cwd = R(proj);
  const f = resolveAgyUiPath(ctx, { kind: 'file', raw: 'src/a.js', sessionCwd: cwd });
  assert.equal(f.ws, cwd);
  assert.equal(f.rel, 'src/a.js');
  assert.equal(f.abs, path.join(cwd, 'src', 'a.js'));
  const d = resolveAgyUiPath(ctx, { kind: 'folder', raw: '.', sessionCwd: cwd });
  assert.deepEqual([d.ws, d.rel], [cwd, '']);
  assert.equal(resolveAgyUiPath(ctx, { kind: 'folder', raw: 'src', sessionCwd: cwd }).rel, 'src');
  // 会话目录在文件根里：文件页能去，rootRel 相对文件根
  assert.equal(d.rootRel, 'proj');
});

test('ui_open 路径：绝对路径与跳出会话目录的照常过授权，以自己所在目录为根；文件根之外 rootRel 为 null', () => {
  const ctx = contextFor({ kind: 'admin' });
  const cwd = R(proj);
  const f = resolveAgyUiPath(ctx, { kind: 'file', raw: path.join(outside, 'b.md'), sessionCwd: cwd });
  assert.deepEqual([f.ws, f.rel], [R(outside), 'b.md']);
  assert.equal(f.rootRel, null);
  const up = resolveAgyUiPath(ctx, { kind: 'folder', raw: '../../outside', sessionCwd: cwd });
  assert.deepEqual([up.ws, up.rel], [R(outside), '']);
});

test('ui_open 路径：不存在 / 类型不对 / 没有会话目录给相对路径都报错', () => {
  const ctx = contextFor({ kind: 'admin' });
  const cwd = R(proj);
  assert.throws(() => resolveAgyUiPath(ctx, { kind: 'file', raw: 'src/nope.js', sessionCwd: cwd }), (e) => e.status === 404);
  assert.throws(() => resolveAgyUiPath(ctx, { kind: 'folder', raw: 'nope', sessionCwd: cwd }), (e) => e.status === 404);
  assert.throws(() => resolveAgyUiPath(ctx, { kind: 'file', raw: 'src', sessionCwd: cwd }), (e) => e.status === 400);
  assert.throws(() => resolveAgyUiPath(ctx, { kind: 'file', raw: 'src/a.js', sessionCwd: '' }), (e) => e.status === 400);
  assert.throws(() => resolveAgyUiPath(ctx, { kind: 'file', raw: '  ', sessionCwd: cwd }), (e) => e.status === 400);
});

test('ui.open：只有服务端内部调用方塞进 env.uiFrom 时 ui.cmd 才带 from（别的 agent 照旧）', async () => {
  const ctx = contextFor({ kind: 'admin' });
  const sent = [];
  const res = { writableEnded: false, write(chunk) { const m = /^data: (.*)$/m.exec(String(chunk)); if (m) { try { sent.push(JSON.parse(m[1])); } catch {} } return true; }, end() {} };
  const off = busSubscribe(ctx.key, res);
  noteUiState(ctx.key, 'c1', 'web', { screen: 'agy' }, { visible: true });
  const run = async (env) => {
    const p = callOp(ctx, 'ui.open', { file: 'src/a.js' }, env);
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
    const ev = sent.shift();
    answerUiRequest(ctx.key, ev.id, { ok: true });
    await p;
    return ev;
  };
  try {
    const plain = await run({ via: 'mcp' });
    assert.equal(plain.type, 'ui.cmd');
    assert.deepEqual(plain.target, { file: 'src/a.js' });
    assert.equal('from' in plain, false);
    const from = { agent: 'agy', session: 's1', ws: 'C:\\proj', rootRel: null };
    const tagged = await run({ via: 'mcp', uiFrom: from });
    assert.deepEqual(tagged.from, from);
    assert.deepEqual(tagged.target, { file: 'src/a.js' });
  } finally { off(); }
});
