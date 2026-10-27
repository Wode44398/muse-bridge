// 第三方插件的全流程：登记本机目录 → 改代码热重载（含相对 import）→ zip 安装 / 覆盖 / 卸载 → 给 Claude 的工具组装。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugins-test-'));
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'installed');
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');

const { createKernel, memoryStore } = await import('../kernel/kernel.mjs');
const { linkLocal, unlinkLocal, reloadPlugin, installFromArchive, uninstallPlugin, readPluginDir, INSTALLED_PLUGINS_DIR } = await import('./discover.mjs');
const { installCoreResolver } = await import('../modules/core-resolve.mjs');
installCoreResolver();

const quiet = { log() {}, warn() {}, error() {} };
const mk = () => createKernel({ store: memoryStore(), logger: quiet });

function writePlugin(dir, { id, version = '1', extraFiles = {}, index } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'bridge-plugin.json'), JSON.stringify({ id, name: id + ' 名', version, config: { word: { type: 'string', default: 'hi' } } }));
  writeFileSync(path.join(dir, 'index.mjs'), index);
  for (const [f, c] of Object.entries(extraFiles)) writeFileSync(path.join(dir, f), c);
}

test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('清单校验：缺文件、坏 id、入口越界都报人话', () => {
  const d = path.join(tmp, 'bad');
  mkdirSync(d, { recursive: true });
  assert.throws(() => readPluginDir(d), /缺 bridge-plugin\.json/);
  writeFileSync(path.join(d, 'bridge-plugin.json'), JSON.stringify({ id: 'Bad_Id' }));
  assert.throws(() => readPluginDir(d), /id 不合法/);
  writeFileSync(path.join(d, 'bridge-plugin.json'), JSON.stringify({ id: 'ok', entry: '../x.mjs' }));
  assert.throws(() => readPluginDir(d), /越出/);
  writeFileSync(path.join(d, 'bridge-plugin.json'), JSON.stringify({ id: 'ok' }));
  assert.throws(() => readPluginDir(d), /缺入口文件/);
});

test('登记本机目录 → 启用；改代码（连相对 import 一起）重新加载即换新', async () => {
  const k = mk();
  const dir = path.join(tmp, 'dev-a');
  const seen = [];
  globalThis.__pluginSeen = seen;
  writePlugin(dir, {
    id: 'dev-a',
    extraFiles: { 'lib.mjs': "export const v = 'lib-1';\n" },
    index: "import { v } from './lib.mjs';\nexport function apply(ctx, cfg) { globalThis.__pluginSeen.push(v + ':' + cfg.word); ctx.provide('dev-a', { v }); }\n",
  });
  const p = await linkLocal(k, dir);
  assert.equal(p.source, 'local');
  await k.start();
  assert.deepEqual(seen, ['lib-1:hi']);
  assert.equal(k.service('dev-a').v, 'lib-1');
  assert.deepEqual(k.readState().local.map((x) => path.resolve(x)), [path.resolve(dir)]);

  writeFileSync(path.join(dir, 'lib.mjs'), "export const v = 'lib-2';\n");
  const r = await reloadPlugin(k, 'dev-a');
  assert.equal(r.status, 'active', r.error || '');
  assert.deepEqual(seen, ['lib-1:hi', 'lib-2:hi']);
  assert.equal(k.service('dev-a').v, 'lib-2');

  // 语法错：重载后记 error，不炸进程；修好再重载恢复
  writeFileSync(path.join(dir, 'index.mjs'), 'export function apply( {');
  const broken = await reloadPlugin(k, 'dev-a');
  assert.equal(broken.status, 'error');
  assert.match(broken.error, /加载失败/);
  assert.equal(k.hasService('dev-a'), false);
  writeFileSync(path.join(dir, 'index.mjs'), "export function apply(ctx) { ctx.provide('dev-a', { v: 'fixed' }); }\n");
  const fixed = await reloadPlugin(k, 'dev-a');
  assert.equal(fixed.status, 'active');
  assert.equal(k.service('dev-a').v, 'fixed');

  await unlinkLocal(k, 'dev-a');
  assert.equal(k.has('dev-a'), false);
  assert.equal(k.readState().local.length, 0);
  assert.ok(existsSync(dir), '取消登记不删用户的文件');
});

test('zip 安装（包外多套一层目录也认）→ 覆盖安装换新代码 → 卸载进回收区', async () => {
  const k = mk();
  await k.start();
  const build = path.join(tmp, 'build');
  const src = path.join(build, 'zipped-main');   // 模拟 GitHub 打包多出来的一层
  writePlugin(src, { id: 'zipped', index: "export function apply(ctx) { ctx.provide('zipped', 'v1'); }\n" });
  const zip = path.join(tmp, 'zipped.zip');
  const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';
  execFileSync(tar, ['-a', '-cf', zip, '-C', build, 'zipped-main']);
  const { readFileSync } = await import('node:fs');
  const p = await installFromArchive(k, readFileSync(zip));
  assert.equal(p.source, 'installed');
  assert.equal(p.status, 'active', p.error || '');
  assert.equal(k.service('zipped'), 'v1');
  assert.ok(existsSync(path.join(INSTALLED_PLUGINS_DIR, 'zipped', 'bridge-plugin.json')));

  writePlugin(src, { id: 'zipped', version: '2', index: "export function apply(ctx) { ctx.provide('zipped', 'v2'); }\n" });
  rmSync(zip, { force: true });
  execFileSync(tar, ['-a', '-cf', zip, '-C', build, 'zipped-main']);
  const p2 = await installFromArchive(k, readFileSync(zip));
  assert.equal(p2.version, '2');
  assert.equal(k.service('zipped'), 'v2');

  await uninstallPlugin(k, 'zipped');
  assert.equal(k.has('zipped'), false);
  assert.equal(existsSync(path.join(INSTALLED_PLUGINS_DIR, 'zipped')), false);
  assert.ok(readdirSync(path.join(INSTALLED_PLUGINS_DIR, '.trash')).some((n) => n.startsWith('zipped-')));
});

test('zip 里没有清单 / 不是 zip：拒装', async () => {
  const k = mk();
  await assert.rejects(() => installFromArchive(k, Buffer.from('not a zip at all')), /解不开|找不到/);
});

test('给 Claude 的工具：按插件合成 MCP、只读工具进 allowedTools、身份过滤、签名带插件版本', async () => {
  const { kernel } = await import('./state.mjs');
  const { installMixins } = await import('./host.mjs');
  const { pluginClaudeTurn } = await import('./claude-tools.mjs');
  installMixins();
  kernel.register({
    id: 'toolbox',
    load: async () => ({
      apply(ctx) {
        ctx.claude.tool({ name: 'echo', description: '回声', access: 'read', params: { text: { type: 'string', required: true } }, handler: ({ text }) => 'echo:' + text });
        ctx.claude.tool({ name: 'members_only', description: '成员也能用', who: 'members', handler: () => 'ok' });
        ctx.claude.prompt('工具箱插件的提示');
        ctx.claude.prompt((turn) => (turn.kind === 'routine' ? '定时任务专用提示' : ''));
      },
    }),
  });
  await kernel.start();
  const host = pluginClaudeTurn({ kind: 'chat', ctx: { kind: 'admin', sandbox: false } });
  assert.deepEqual(Object.keys(host.mcpServers), ['toolbox']);
  assert.deepEqual(host.allowedTools, ['mcp__toolbox__echo']);
  assert.match(host.prompt, /工具箱插件的提示/);
  assert.doesNotMatch(host.prompt, /定时任务专用/);
  assert.deepEqual(host.sig, [['toolbox', 0, ['echo:read', 'members_only:write'], []]]);

  const member = pluginClaudeTurn({ kind: 'chat', ctx: { kind: 'user', sandbox: true } });
  assert.deepEqual(member.sig, [['toolbox', 0, ['members_only:write'], []]]);
  assert.equal(member.prompt, '');   // 提示段缺省只给主机

  const snap = pluginClaudeTurn({ kind: 'chat', ctx: { kind: 'admin' }, snap: { token: 'x' } });
  assert.deepEqual(Object.keys(snap.mcpServers), []);

  const routine = pluginClaudeTurn({ kind: 'routine', ctx: { kind: 'admin', sandbox: false } });
  assert.match(routine.prompt, /定时任务专用提示/);

  // 停用后什么都不给
  await kernel.setEnabled('toolbox', false);
  const off = pluginClaudeTurn({ kind: 'chat', ctx: { kind: 'admin', sandbox: false } });
  assert.deepEqual(off, { mcpServers: {}, prompt: '', allowedTools: [], sig: [] });
});
