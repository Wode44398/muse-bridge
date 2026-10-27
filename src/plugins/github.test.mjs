// P5：清单 engines 兼容校验；从 GitHub 装插件（最新 Release 的 zip 资产 / 没 Release 用默认分支 / 钉 ref）、检查更新、只认 GitHub 域。
// 本地 http 服务假扮 api.github.com 与 codeload（_setTestHooks 放行它的 origin）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-gh-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'installed');

const { createKernel, memoryStore } = await import('../kernel/kernel.mjs');
const { readPluginDir } = await import('./discover.mjs');
const { satisfies, compareVersions, enginesProblem, BRIDGE_VERSION } = await import('./engines.mjs');
const gh = await import('./github.mjs');
const { installCoreResolver } = await import('../modules/core-resolve.mjs');
installCoreResolver();
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const quiet = { log() {}, warn() {}, error() {} };
const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';
function zipOf(id, version, extra = {}) {
  const build = path.join(tmp, 'b-' + id + '-' + version);
  const src = path.join(build, id + '-main');
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, 'bridge-plugin.json'), JSON.stringify({ id, name: id, version, ...extra }));
  writeFileSync(path.join(src, 'index.mjs'), `export function apply(ctx) { ctx.provide('${id}', '${version}'); }\n`);
  const z = path.join(tmp, id + '-' + version + '.zip');
  execFileSync(tar, ['-a', '-cf', z, '-C', build, id + '-main']);
  return readFileSync(z);
}

test('engines：版本范围的几种写法', () => {
  assert.equal(compareVersions('6.68', '6.7'), 1);
  assert.equal(satisfies('6.68', '>=6.60'), true);
  assert.equal(satisfies('6.68', '>=6.70'), false);
  assert.equal(satisfies('6.68', '^6.60'), true);
  assert.equal(satisfies('7.1', '^6.60'), false);
  assert.equal(satisfies('6.68.2', '~6.68'), true);
  assert.equal(satisfies('6.68', '>=6.60 <6.68'), false);
  assert.equal(satisfies('6.68', '6.50 || >=6.66'), true);
  assert.equal(satisfies('6.68', '*'), true);
  assert.equal(enginesProblem({ engines: { bridge: '>=99' } }).includes('99'), true);
  assert.equal(enginesProblem({ engines: { pluginApi: 99 } }).includes('v99'), true);
  assert.equal(enginesProblem({ engines: { bridge: '>=' + BRIDGE_VERSION, pluginApi: 2 } }), '');
  const d = path.join(tmp, 'eng');
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'bridge-plugin.json'), JSON.stringify({ id: 'eng', engines: { bridge: '>=99' } }));
  writeFileSync(path.join(d, 'index.mjs'), 'export function apply() {}');
  assert.throws(() => readPluginDir(d), /要 bridge >=99/);
});

test('地址解析', () => {
  assert.deepEqual(gh.parseRepo('a/b'), { owner: 'a', repo: 'b', ref: '' });
  assert.deepEqual(gh.parseRepo('a/b@v1.2'), { owner: 'a', repo: 'b', ref: 'v1.2' });
  assert.deepEqual(gh.parseRepo('https://github.com/a/b.git'), { owner: 'a', repo: 'b', ref: '' });
  assert.deepEqual(gh.parseRepo('https://github.com/a/b/tree/dev'), { owner: 'a', repo: 'b', ref: 'dev' });
  assert.throws(() => gh.parseRepo('a/b/c'), /看不懂/);
  assert.throws(() => gh.parseRepo('../x'), /看不懂/);
  assert.equal(gh.trusted('https://codeload.github.com/a/b/zip/main'), true);
  assert.equal(gh.trusted('http://codeload.github.com/a/b'), false);
  assert.equal(gh.trusted('https://evil.example/x.zip'), false);
});

test('从 GitHub 装：最新 Release 的 zip 资产 → 检查更新 → 升级；没 Release 用默认分支；重定向到外域拒下', async () => {
  let latest = { tag: 'v1.0.0', zip: zipOf('ghp', '1.0.0') };
  const branchZip = zipOf('ghq', '0.1.0');
  const srv = http.createServer((req, res) => {
    const u = req.url;
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (u === '/repos/me/ghp/releases/latest') return send(200, JSON.stringify({ tag_name: latest.tag, assets: [{ name: 'ghp-plugin.zip', browser_download_url: base + '/dl/ghp.zip' }] }));
    if (u === '/dl/ghp.zip') { res.writeHead(302, { Location: base + '/blob/ghp.zip' }); return res.end(); }
    if (u === '/blob/ghp.zip') return send(200, latest.zip, 'application/zip');
    if (u === '/repos/me/ghq/releases/latest') return send(404, '{}');
    if (u === '/repos/me/ghq') return send(200, JSON.stringify({ default_branch: 'trunk' }));
    if (u === '/me/ghq/zip/refs/heads/trunk') return send(200, branchZip, 'application/zip');
    if (u === '/repos/me/evil/releases/latest') return send(200, JSON.stringify({ tag_name: 'v1', assets: [{ name: 'x.zip', browser_download_url: base + '/dl/evil.zip' }] }));
    if (u === '/dl/evil.zip') { res.writeHead(302, { Location: 'https://evil.example/x.zip' }); return res.end(); }
    send(404, '{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  gh._setTestHooks({ origins: [base], api: base, codeload: base });
  const k = createKernel({ store: memoryStore(), logger: quiet });
  await k.start();
  try {
    const p = await gh.installFromGithub(k, 'me/ghp');
    assert.equal(p.id, 'ghp');
    assert.equal(k.service('ghp'), '1.0.0');
    assert.equal(gh.sourceOf(k, 'ghp').github, 'me/ghp');
    assert.deepEqual(await gh.checkUpdate(k, 'ghp'), { current: '1.0.0', latest: '1.0.0', tag: 'v1.0.0', newer: false });
    latest = { tag: 'v1.1.0', zip: zipOf('ghp', '1.1.0') };
    assert.equal((await gh.checkUpdate(k, 'ghp')).newer, true);
    await gh.installFromGithub(k, 'me/ghp');
    assert.equal(k.service('ghp'), '1.1.0');

    const q = await gh.installFromGithub(k, 'https://github.com/me/ghq');
    assert.equal(q.version, '0.1.0');

    await assert.rejects(() => gh.installFromGithub(k, 'me/evil'), /不是 GitHub 的地址/);
    await assert.rejects(() => gh.installFromGithub(k, 'me/nothere'), /找不到/);
  } finally {
    gh._setTestHooks({});
    srv.closeAllConnections?.(); srv.close();
    await k.stop();
  }
});
