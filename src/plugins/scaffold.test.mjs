// 插件骨架生成（src/plugins/scaffold.mjs）与 agent 操作 plugins.scaffold：最小骨架、带面板、从示例起步（id 替换）、各种拒绝；
// 建好经 plugins.scaffold 直接登记后能真正启用（路由、Claude 工具、agent 操作、状态块都挂上）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-scaffold-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { scaffoldPlugin, EXAMPLES, EXAMPLES_DIR } = await import('./scaffold.mjs');
const { readPluginDir, normUi } = await import('./discover.mjs');
const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { callOp } = await import('../agent-api/registry.mjs');
const { contextFor } = await import('../runtime/identity.mjs');
const { installCoreResolver } = await import('../modules/core-resolve.mjs');
await import('../agent-api/ops/index.mjs');
installCoreResolver();
installMixins();
const router = createRouter();
kernel.provide('router', router);
kernel.provide('auth', { identify: () => ({ kind: 'admin', user: null }), authOk: () => true });

test.before(async () => { await kernel.start(); });
test.after(async () => { await kernel.stop(); });
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const json = (f) => JSON.parse(readFileSync(f, 'utf8'));

test('最小骨架：清单合法、文件齐；panel 再带控制面板页面', () => {
  const a = scaffoldPlugin({ id: 'weather', dir: path.join(tmp, 'a'), name: '天气' });
  assert.deepEqual(a.files, ['README.md', 'bridge-plugin.json', 'index.mjs']);
  const { manifest } = readPluginDir(a.dir);
  assert.equal(manifest.id, 'weather');
  assert.equal(manifest.name, '天气');
  assert.equal(manifest.ui, undefined);
  const b = scaffoldPlugin({ id: 'my-panel', dir: path.join(tmp, 'b'), panel: true });
  assert.ok(b.files.includes('web/index.html'));
  assert.equal(normUi(json(path.join(b.dir, 'bridge-plugin.json'))).panel.page, 'web/index.html');
  assert.match(readFileSync(path.join(b.dir, 'web', 'index.html'), 'utf8'), /\/plugins\/_sdk\/bridge-plugin\.js/);
});

test('从示例起步：整个拷过来，示例 id（含下划线形式）换成新 id，示例本身不动', () => {
  assert.deepEqual(Object.keys(EXAMPLES).sort(), ['hello-world', 'qq-onebot']);
  const h = scaffoldPlugin({ id: 'greeter', dir: path.join(tmp, 'h'), from: 'hello-world' });
  const idx = readFileSync(path.join(h.dir, 'index.mjs'), 'utf8');
  assert.match(idx, /\/api\/plugin\/greeter\/greet/);
  assert.doesNotMatch(idx, /hello-world|hello_world/);
  assert.equal(json(path.join(h.dir, 'bridge-plugin.json')).id, 'greeter');
  assert.equal(json(path.join(h.dir, 'bridge-plugin.json')).name, 'greeter');
  assert.match(readFileSync(path.join(h.dir, 'web', 'index.html'), 'utf8'), /\/plugins\/_sdk\/bridge-plugin\.js/);
  assert.equal(json(path.join(EXAMPLES_DIR, 'hello-world', 'bridge-plugin.json')).id, 'hello-world');
  const q = scaffoldPlugin({ id: 'wx-bot', dir: path.join(tmp, 'q'), from: 'qq-onebot', name: '微信机器人', description: '把微信接到 Claude' });
  const qm = json(path.join(q.dir, 'bridge-plugin.json'));
  assert.equal(qm.id, 'wx-bot');
  assert.equal(qm.name, '微信机器人');
  assert.equal(qm.description, '把微信接到 Claude');
  readPluginDir(q.dir);
});

test('拒绝：坏 id、相对路径、非空目录、没有的示例', () => {
  assert.throws(() => scaffoldPlugin({ id: 'Bad_Id', dir: path.join(tmp, 'x') }), /id 不合法/);
  assert.throws(() => scaffoldPlugin({ id: 'ok', dir: 'rel/dir' }), /绝对路径/);
  const d = path.join(tmp, 'busy');
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'keep.txt'), 'x');
  assert.throws(() => scaffoldPlugin({ id: 'ok', dir: d }), /不是空的/);
  assert.equal(readFileSync(path.join(d, 'keep.txt'), 'utf8'), 'x');
  assert.throws(() => scaffoldPlugin({ id: 'ok', dir: path.join(tmp, 'y'), from: 'nope' }), /没有示例/);
  assert.equal(existsSync(path.join(tmp, 'y')), false);
});

test('agent 操作 plugins.scaffold：缺省建在工作空间 plugins-dev/<id>/ 并登记启用，路由、Claude 工具、agent 操作、状态块都挂上', async () => {
  const host = contextFor({ kind: 'admin' });
  const r = await callOp(host, 'plugins.scaffold', { id: 'demo-tool', panel: true, name: '演示' });
  assert.equal(r.dir, path.join(host.cwd, 'plugins-dev', 'demo-tool'));
  assert.equal(r.linked, true);
  assert.equal(r.plugin.status, 'active', r.plugin.error || '');
  assert.equal(r.plugin.name, '演示');
  assert.ok(router.has('GET', '/api/plugin/demo-tool/hello'));
  assert.ok(r.plugin.hasPage);
  const st = await callOp(host, 'plugins.status', { id: 'demo-tool' });
  assert.equal(st.status.text, '运行中');
  const op = await callOp(host, 'demo_tool.status', {});
  assert.equal(op.message, '你好');
  // 再建同名目录：拒
  await assert.rejects(() => callOp(host, 'plugins.scaffold', { id: 'demo-tool' }), /不是空的/);
  // 成员不能建
  const member = contextFor({ kind: 'user', user: 'm1', name: 'm1', tier: 'user', agents: ['claude'] });
  await assert.rejects(() => callOp(member, 'plugins.scaffold', { id: 'nope' }));
  // link:false 只建不登记
  const r2 = await callOp(host, 'plugins.scaffold', { id: 'later', link: false });
  assert.equal(r2.linked, false);
  assert.equal(kernel.has('later'), false);
});
