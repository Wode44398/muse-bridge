// 扩展中心「功能扩展」的装 / 卸契约：离线包只排进 .pending，【下次启动】才换上；打包号对不上拒装；
// 卸载同样等重启。每一步起一个子进程 = 一次「重启」（applyPending 在注册表导入时做）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-modmgr-'));
const dataRoot = path.join(tmp, 'data');
mkdirSync(dataRoot, { recursive: true });
const ENV = { ...process.env, BRIDGE_DATA_ROOT: dataRoot, BRIDGE_MODULES_BUILTIN: '0', BRIDGE_BUILD_ID: 'b-123', BRIDGE_CLAUDE_IN_CHROME: '0' };
delete ENV.DIMENSIO_DATA_DIR;   // dimensio 旧版的迁移目标按默认 <数据根>/dimensio 算

// 造一个离线包：<name>.zip，内容 = 清单 + 入口（可选多包一层目录）
function makePackage(name, manifest, { nested = false } = {}) {
  const src = path.join(tmp, 'pkg-' + name);
  const root = nested ? path.join(src, 'inner') : src;
  mkdirSync(path.join(root, 'server'), { recursive: true });
  mkdirSync(path.join(root, 'web', 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'bridge-module.json'), JSON.stringify(manifest));
  writeFileSync(path.join(root, 'server', 'index.mjs'), 'export const runnable = () => true;\n');
  writeFileSync(path.join(root, 'web', 'assets', 'mod-' + name + '.js'), 'export default 1;\n');
  const zip = path.join(tmp, name + '.zip');
  execFileSync(TAR, ['-a', '-cf', zip, '-C', src, '.']);
  return zip;
}

function run(body) {
  const script = `
    const r = await import(${url('modules/registry.mjs')});
    await r.loadModules();
    const m = await import(${url('modules/manage.mjs')});
    const out = {};
    ${body}
    console.log('@@' + JSON.stringify(out));`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: ENV, encoding: 'utf8' });
  return JSON.parse(stdout.split('@@').pop());
}

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('装：排进待生效，重启后才加载；打包号不对 / 不认识的 id 拒装', () => {
  const good = makePackage('codex', { id: 'codex', version: '2026.10.18', buildId: 'b-123', entry: 'server/index.mjs' }, { nested: true });
  const stale = makePackage('vertex', { id: 'vertex', version: 'old', buildId: 'b-OLD' });
  const alien = makePackage('nope', { id: 'nope', buildId: 'b-123' });
  const r1 = run(`
    out.install = await m.installModuleArchive(${JSON.stringify(good)});
    out.before = m.modulesOverview().modules.find((x) => x.id === 'codex');
    try { await m.installModuleArchive(${JSON.stringify(stale)}); } catch (e) { out.stale = e.status; }
    try { await m.installModuleArchive(${JSON.stringify(alien)}); } catch (e) { out.alien = e.status; }`);
  assert.equal(r1.install.id, 'codex');
  assert.equal(r1.before.loaded, false);
  assert.deepEqual(r1.before.pending, { action: 'install', version: '2026.10.18' });
  assert.equal(r1.stale, 409);
  assert.equal(r1.alien, 400);

  // 「重启」：换上并加载；静态回落目录里有它的 web/
  const r2 = run(`
    out.st = m.modulesOverview().modules.find((x) => x.id === 'codex');
    out.web = r.moduleWebDirs().length;`);
  assert.equal(r2.st.loaded, true);
  assert.equal(r2.st.source, 'installed');
  assert.equal(r2.st.version, '2026.10.18');
  assert.equal(r2.st.pending, null);
  assert.equal(r2.web, 1);
});

test('卸：排待卸载标记，重启后才删；没装的报 404', () => {
  const r1 = run(`
    out.un = m.uninstallModule('codex');
    out.still = m.modulesOverview().modules.find((x) => x.id === 'codex');
    try { m.uninstallModule('dimensio'); } catch (e) { out.missing = e.status; }`);
  assert.equal(r1.un.restartNeeded, true);
  assert.equal(r1.still.loaded, true);
  assert.deepEqual(r1.still.pending, { action: 'remove' });
  assert.equal(r1.missing, 404);

  const r2 = run(`out.st = m.modulesOverview().modules.find((x) => x.id === 'codex');`);
  assert.equal(r2.st.installed, false);
  assert.equal(existsSync(path.join(dataRoot, 'modules', 'codex')), false);
  // 本次刚换下来的旧版留在 .trash 里（dimensio 要从这里救数据），下一次启动才删
  const trash = path.join(dataRoot, 'modules', '.trash');
  assert.deepEqual(readdirSync(trash).map((n) => n.replace(/\d+$/, '')), ['codex-']);
  run(`out.ok = 1;`);
  assert.deepEqual(readdirSync(trash), []);
});

test('打包号对不上的已装扩展：不加载，原因写进状态', () => {
  const dir = path.join(dataRoot, 'modules', 'vertex');
  mkdirSync(path.join(dir, 'server'), { recursive: true });
  writeFileSync(path.join(dir, 'bridge-module.json'), JSON.stringify({ id: 'vertex', buildId: 'b-OLD' }));
  writeFileSync(path.join(dir, 'server', 'index.mjs'), 'export const runnable = () => true;\n');
  const r = run(`out.st = m.modulesOverview().modules.find((x) => x.id === 'vertex');`);
  assert.equal(r.st.loaded, false);
  assert.match(r.st.error, /版本不匹配/);
});

test('待装版本是给另一版主程序的（自动更新先下好了、主程序还没装上）：先不换，留在待生效里', () => {
  const next = path.join(dataRoot, 'modules', '.pending', 'dimensio');
  mkdirSync(path.join(next, 'server'), { recursive: true });
  writeFileSync(path.join(next, 'bridge-module.json'), JSON.stringify({ id: 'dimensio', buildId: 'b-NEXT' }));
  writeFileSync(path.join(next, 'server', 'index.mjs'), 'export const runnable = () => true;\n');
  const r = run(`out.st = m.modulesOverview().modules.find((x) => x.id === 'dimensio');`);
  assert.equal(r.st.installed, false);
  assert.equal(r.st.pending?.action, 'install');
  assert.equal(existsSync(next), true);
});

test('dimensio 换下来的旧版：数据没救完就一直留着（复制失败 / 搬到一半），救完或目标已有数据才删；没救完的最多留 3 份', async () => {
  const trash = path.join(dataRoot, 'modules', '.trash');
  const target = path.join(dataRoot, 'dimensio');
  const put = (p, s = 'x') => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); };
  const h = (ts, ...rest) => path.join(trash, 'dimensio-' + ts, 'harness', ...rest);
  // A：custom-providers 这次没复制成（没记 .migrated、目标空着——本轮 harness 直接用着这里的原件）
  put(h(1000, 'custom-providers', 'connector-secrets.json'));
  // B：sessions 复制成了、记进了 .migrated；源码目录不算数据
  put(h(2000, 'sessions', 's.json'));
  put(h(2000, '.migrated'), JSON.stringify({ v: 1, items: { sessions: { to: path.join(target, 'sessions') } } }));
  put(h(2000, 'server', 'index.ts'));
  // C：projects.json 已就位、没来得及写 .migrated 进程就被结束——目标已有数据，这份用不上了
  put(h(3000, 'projects.json'), '{}');
  put(path.join(target, 'projects.json'), '{"p":1}');
  // D：空 .env、空目录不算数据（入口脚本预建的占位同理）
  put(h(4000, '.env'), '');
  mkdirSync(h(4000, 'memory'), { recursive: true });
  // 别的扩展照旧：下一次启动就删
  put(path.join(trash, 'codex-5000', 'x'));

  const r = run(`out.rescue = r.TRASH_RESCUE.dimensio;`);
  assert.deepEqual(readdirSync(trash).sort(), ['dimensio-1000']);
  // 下一次启动目标还空着（复制还是没成）：照留
  run(`out.ok = 1;`);
  assert.deepEqual(readdirSync(trash), ['dimensio-1000']);
  // 搬过去了（目标那一项有了数据）：再下一次启动删掉
  put(path.join(target, 'custom-providers', 'connector-secrets.json'));
  run(`out.ok = 1;`);
  assert.deepEqual(readdirSync(trash), []);

  // 上限：没救完的最多留 3 份，较早的删掉
  for (const ts of [6001, 6002, 6003, 6004]) put(h(ts, 'knowledge', 'k.md'));
  run(`out.ok = 1;`);
  assert.deepEqual(readdirSync(trash).sort(), ['dimensio-6002', 'dimensio-6003', 'dimensio-6004']);
  rmSync(trash, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });

  // 与 dimensio 的迁移清单对拍（公开仓库没带 dimensio 扩展时跳过）
  const hd = path.resolve(SRC, '..', 'modules', 'dimensio', 'server', 'runtime', 'harness-data.mjs');
  if (existsSync(hd)) {
    const { HARNESS_DATA_ITEMS, MIGRATED_MARKER } = await import(pathToFileURL(hd).href);
    assert.deepEqual(r.rescue.items, HARNESS_DATA_ITEMS.map((i) => i.name));
    assert.equal(r.rescue.marker, MIGRATED_MARKER);
  }
});
