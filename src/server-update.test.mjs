// 服务端更新（runtime/server-update.mjs）与客户端跟随服务器版本（runtime/client-release.mjs clientReleaseFor）。
// 10-28 服主反馈「点检查更新升不了」：手动检查要当场查 GitHub、查不到照实说；成员只拿与服务端同一次发布的客户端
// （服主还没升时不能让成员先升到新客户端）；设置里一键更新按部署形态走（安装包里的本机服务端交给那台电脑的桌面客户端）。
// GitHub 一律用注入的假 fetch，不碰真网络。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-srvupd-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
for (const k of ['BRIDGE_CLIENT_DIST', 'BRIDGE_CLIENT_UPDATE_FEED', 'BRIDGE_BUILD_ID', 'BRIDGE_SUPERVISED', 'BRIDGE_UPDATE_HINT']) delete process.env[k];

const cr = await import('./runtime/client-release.mjs');
const su = await import('./runtime/server-update.mjs');
const reg = await import('./runtime/device-registry.mjs');
const dc = await import('./runtime/device-control.mjs');
const { serverHostDevice } = await import('./runtime/devices.mjs');

const V_OLD = '2026.10.24.0534', V_NEW = '2026.10.28.0328';
const SHA_A = 'a'.repeat(64), SHA_B = 'b'.repeat(64);
const asset = (v) => `https://github.com/Wode44398/claude-bridge-releases/releases/download/v${v}/bridge-client-setup-${v}.exe`;
const man = (version, sha = SHA_A) => ({ version, file: `bridge-client-setup-${version}.exe`, size: 10, sha256: sha, mirrors: [asset(version)], notes: '说明 ' + version, buildId: version + '+abc1234' });
const TAG = (v) => `https://github.com/Wode44398/claude-bridge-releases/releases/download/v${v}/latest.json`;
// 假 GitHub：按地址回清单，没有的回 404；calls 记下问过哪些地址
function fakeGitHub(map) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = map[url];
    return hit ? { ok: true, status: 200, text: async () => JSON.stringify(hit) } : { ok: false, status: 404, text: async () => 'Not Found' };
  };
  return { impl, calls };
}
const dist = path.join(tmp, 'client-dist');
// 安装器（bridge-client.iss StageServerDist）写的那份：没有镜像、downloadPath 指本机，安装包就在旁边
function stageLocal(version, sha = SHA_A) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, 'latest.json'), JSON.stringify({ version, file: `bridge-client-setup-${version}.exe`, size: 0, sha256: sha, downloadPath: '/api/device/client/download', notes: '本机服务端安装器暂存的同版本安装包。' }));
  writeFileSync(path.join(dist, `bridge-client-setup-${version}.exe`), 'x'.repeat(10));
}
const setEnv = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };

test('同版本发布清单的地址按发版仓库拼；更新源关了 / 不是 GitHub 发布仓库就没有', () => {
  assert.equal(cr.taggedManifestUrl(V_OLD), TAG(V_OLD));
  assert.equal(cr.taggedManifestUrl('v1; rm -rf'), '');
  setEnv('BRIDGE_CLIENT_UPDATE_FEED', '');
  assert.equal(cr.taggedManifestUrl(V_OLD), '');
  setEnv('BRIDGE_CLIENT_UPDATE_FEED', 'https://mirror.example.com/latest.json');
  assert.equal(cr.taggedManifestUrl(V_OLD), '');
  setEnv('BRIDGE_CLIENT_UPDATE_FEED', null);
  assert.equal(cr.releasePageUrl(V_NEW), 'https://github.com/Wode44398/claude-bridge-releases/releases/tag/v' + V_NEW);
  assert.equal(cr.releasePageUrl(), 'https://github.com/Wode44398/claude-bridge-releases/releases/latest');
});

test('有人在等的检查：缓存旧了就当场重查 GitHub（以前只读 6 小时缓存，发新版后头一次检查说「已是最新」）；查不到照实报原因', async () => {
  const gh1 = fakeGitHub({ [cr.DEFAULT_CLIENT_FEED]: man(V_OLD) });
  await cr.refreshClientFeed({ force: true, fetchImpl: gh1.impl });
  assert.equal(cr.feedStatus().latest, V_OLD);
  // 缓存还新：不重查
  const gh2 = fakeGitHub({ [cr.DEFAULT_CLIENT_FEED]: man(V_NEW) });
  await cr.checkClientFeed({ maxAgeMs: 60_000, fetchImpl: gh2.impl });
  assert.equal(gh2.calls.length, 0);
  assert.equal(cr.feedStatus().latest, V_OLD);
  // 缓存旧了（这里用 maxAgeMs 0 模拟）：当场重查，拿到新版
  await cr.checkClientFeed({ maxAgeMs: 0, fetchImpl: gh2.impl });
  assert.equal(gh2.calls.length, 1);
  assert.equal(cr.feedStatus().latest, V_NEW);
  assert.equal(cr.feedStatus().ok, true);
  // GitHub 连不上：保留上次的清单，ok=false 带原因（界面说「暂时查不到」，不再装作已是最新）
  const down = async () => { throw new Error('fetch failed'); };
  const st = await cr.checkClientFeed({ maxAgeMs: 0, fetchImpl: down });
  assert.equal(st.ok, false);
  assert.match(st.error, /fetch failed/);
  assert.equal(st.latest, V_NEW);
  // 查得慢：最多等 waitMs 就先回（那次重查在后台接着跑完）
  let release;
  const slow = () => new Promise((r) => { release = () => r({ ok: true, status: 200, text: async () => JSON.stringify(man(V_NEW)) }); });
  const t0 = Date.now();
  await cr.checkClientFeed({ maxAgeMs: 0, waitMs: 50, fetchImpl: slow });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(cr.feedStatus().checking, true);
  release();
  await cr.refreshClientFeed();   // 等在途那次收尾
  assert.equal(cr.feedStatus().ok, true);
});

test('成员只拿与服务端同一次发布的客户端，服主那台拿 GitHub 最新；不是打包形态照旧取新', async () => {
  await cr.refreshClientFeed({ force: true, fetchImpl: fakeGitHub({ [cr.DEFAULT_CLIENT_FEED]: man(V_NEW) }).impl });
  setEnv('BRIDGE_BUILD_ID', V_OLD + '+abc1234');
  try {
    stageLocal(V_OLD);
    const gh = fakeGitHub({ [TAG(V_OLD)]: man(V_OLD) });
    // 成员：本地暂存的同版本安装包（服务端能兜底直发），镜像借 GitHub 同版本清单里的（sha256 一样才借）
    let { release } = await cr.clientReleaseForAsync({ hosting: false, fetchImpl: gh.impl });
    assert.equal(release.version, V_OLD);
    assert.equal(release.pinned, V_OLD);
    assert.ok(release.file.endsWith(`bridge-client-setup-${V_OLD}.exe`));
    assert.equal(release.downloadPath, '/api/device/client/download');
    // 第一次问就等同版本清单借到镜像：成员走 GitHub 下，不经服主家里的隧道下整个安装包
    assert.deepEqual(release.mirrors, [asset(V_OLD)]);
    assert.deepEqual(gh.calls, [TAG(V_OLD)]);
    // 拿到过就不再问
    await cr.clientReleaseForAsync({ hosting: false, fetchImpl: gh.impl });
    assert.equal(gh.calls.length, 1);
    // 服主那台：GitHub 最新（更新它 = 连同服务端一起更新）
    const host = await cr.clientReleaseForAsync({ hosting: true, fetchImpl: fakeGitHub({ [cr.DEFAULT_CLIENT_FEED]: man(V_NEW) }).impl });
    assert.equal(host.release.version, V_NEW);
    assert.equal(host.release.source, 'upstream');
    assert.equal(host.feed.ok, true);
    // 本地那份 sha256 和 GitHub 上的不同：不借镜像（只从服务端发）
    stageLocal(V_OLD, SHA_B);
    release = cr.clientReleaseFor({ hosting: false });
    assert.equal(release.mirrors, undefined);
    // 本地没有暂存：GitHub 上同一次发布的清单（只有镜像）
    rmSync(dist, { recursive: true, force: true });
    release = cr.clientReleaseFor({ hosting: false });
    assert.equal(release.version, V_OLD);
    assert.equal(release.source, 'release');
    assert.equal(release.downloadPath, '');
    // 同版本清单拿不到、本地也没有：宁可没有，也绝不发比服务端新的
    setEnv('BRIDGE_BUILD_ID', '2026.10.25.0000+def5678');
    const none = await cr.clientReleaseForAsync({ hosting: false, waitMs: 2000, fetchImpl: fakeGitHub({}).impl });
    assert.equal(none.release, null);
    // 本地比服务端旧（手工放的老包）：可以发（不比服务端新就行）
    stageLocal(V_OLD);
    assert.equal(cr.clientReleaseFor({ hosting: false }).version, V_OLD);
  } finally { setEnv('BRIDGE_BUILD_ID', null); rmSync(dist, { recursive: true, force: true }); }
  // 源码 / Docker 部署（没有打包号）：不知道自己对应哪次发布，照旧本地与上游取新
  assert.equal(cr.clientReleaseFor({ hosting: false }).version, V_NEW);
});

test('同版本发布清单：标签和清单里的版本对不上就不认', async () => {
  const v = '2026.10.26.0100';
  const got = await cr.refreshPinnedRelease(v, { force: true, fetchImpl: fakeGitHub({ [TAG(v)]: man(V_NEW) }).impl });
  assert.equal(got, null);
});

test('部署形态：发行版声明 > 桌面托管的打包形态 > Docker > git + 守护进程 > 其余', async () => {
  setEnv('BRIDGE_UPDATE_HINT', '由 Muse 部署方更新：在服务器上运行 muse-update');
  setEnv('BRIDGE_SUPERVISED', 'desktop');
  setEnv('BRIDGE_BUILD_ID', V_OLD + '+abc1234');
  try {
    assert.equal(su.serverUpdateForm(), 'distro');
    let st = await su.serverUpdateStatus();
    assert.equal(st.oneClick, false);
    assert.equal(st.how, '由 Muse 部署方更新：在服务器上运行 muse-update', '发行版的原话照搬，不越权');
    assert.equal((await su.startServerUpdate()).status, 400);
    setEnv('BRIDGE_UPDATE_HINT', null);
    assert.equal(su.serverUpdateForm(), 'desktop');
    setEnv('BRIDGE_BUILD_ID', null);
    assert.equal(su.serverUpdateForm(), 'manual', '壳托管却没有打包号（开发态）：不知道对哪次发布');
    setEnv('BRIDGE_SUPERVISED', 'docker');
    assert.equal(su.serverUpdateForm(), 'docker');
    st = await su.serverUpdateStatus();
    assert.match(st.how, /docker compose/);
    // git 部署 + 守护进程（仓库自带 .git 与更新脚本）：一键 = 跑更新脚本
    setEnv('BRIDGE_SUPERVISED', process.platform === 'win32' ? 'windows' : 'systemd');
    assert.equal(su.serverUpdateForm(), 'script');
    st = await su.serverUpdateStatus();
    assert.equal(st.oneClick, true);
    assert.equal(st.script.running, false);
  } finally { for (const k of ['BRIDGE_UPDATE_HINT', 'BRIDGE_SUPERVISED', 'BRIDGE_BUILD_ID']) setEnv(k, null); }
});

// 假的设备 SSE 连接：记下下推的 op
function fakeStream() {
  const res = new EventEmitter();
  res.sent = [];
  res.writeHead = () => res;
  res.write = (s) => { const m = /^data: (.*)\n\n$/s.exec(String(s)); if (m) res.sent.push(JSON.parse(m[1])); return true; };
  res.end = () => { res.emit('close'); };
  return res;
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('等超时'); await new Promise((r) => setTimeout(r, 10)); } };

test('桌面托管形态：查 GitHub 有新版；一键更新交给服务端所在电脑的桌面客户端（client.update），没连上时说清去哪更新', async () => {
  setEnv('BRIDGE_SUPERVISED', 'desktop');
  setEnv('BRIDGE_BUILD_ID', V_OLD + '+abc1234');
  su._resetServerUpdateJob();
  try {
    await cr.refreshClientFeed({ force: true, fetchImpl: fakeGitHub({ [cr.DEFAULT_CLIENT_FEED]: man(V_NEW) }).impl });
    let st = await su.serverUpdateStatus();
    assert.equal(st.form, 'desktop');
    assert.equal(st.current, V_OLD);
    assert.equal(st.latest, V_NEW);
    assert.equal(st.newer, true);
    assert.match(st.notes, new RegExp(V_NEW.replace(/\./g, '\\.')));
    assert.equal(st.page, 'https://github.com/Wode44398/claude-bridge-releases/releases/tag/v' + V_NEW);
    // 那台电脑的客户端没连上设备通道
    assert.equal(st.oneClick, false);
    assert.equal(st.how, su.HOW_DESKTOP_OFFLINE);
    const off = await su.startServerUpdate();
    assert.equal(off.status, 409);

    // 别的电脑上的客户端（成员 / 服主的笔记本）：不是托管服务端的那台，不会被拿去「更新服务端」
    const other = reg.registerDevice({ owner: 'u:someone', name: '成员的电脑', machineId: 'm-other' }).device;
    const otherRes = fakeStream();
    dc.attachDevice(other.id, otherRes, { info: { shell: 'desktop', update: true, local: false, machineId: 'm-other', version: V_OLD } });
    assert.equal(serverHostDevice(), null);

    // 服务端所在电脑上的客户端挂上来（本机直连）
    const pc = reg.registerDevice({ owner: 'admin', name: '服主的台式机', machineId: 'm-host' }).device;
    const res = fakeStream();
    dc.attachDevice(pc.id, res, { info: { shell: 'desktop', update: true, local: true, machineId: 'm-host', version: V_OLD } });
    assert.equal(serverHostDevice()?.id, pc.id);
    st = await su.serverUpdateStatus();
    assert.equal(st.oneClick, true);
    assert.equal(st.device.name, '服主的台式机');

    const run = su.startServerUpdate();
    await until(() => res.sent.length > 0);
    assert.equal(res.sent[0].op, 'client.update');
    assert.equal(otherRes.sent.length, 0, '没有推给别的电脑');
    dc.settleResult(pc.id, { opId: res.sent[0].opId, ok: true, result: { status: 'downloading', current: V_OLD, latest: V_NEW, idle: true } });
    const r = await run;
    assert.equal(r.ok, true);
    assert.equal(r.via, 'desktop');
    assert.equal(r.result.status, 'downloading');
    assert.equal(r.latest, V_NEW);
    st = await su.serverUpdateStatus();
    assert.equal(st.job.via, 'desktop');
    assert.equal(st.job.version, V_NEW);

    // 客户端拒绝（临时地址）：原因原样带回
    const run2 = su.startServerUpdate();
    await until(() => res.sent.length > 1);
    dc.settleResult(pc.id, { opId: res.sent[1].opId, ok: true, result: { status: 'refused', reason: '用的是临时地址' } });
    const r2 = await run2;
    assert.equal(r2.result.status, 'refused');
    assert.equal(r2.result.reason, '用的是临时地址');

    // 客户端断开：又回到「去那台电脑上更新」
    res.end();
    assert.equal(serverHostDevice(), null);
    otherRes.end();
  } finally { setEnv('BRIDGE_SUPERVISED', null); setEnv('BRIDGE_BUILD_ID', null); }
});

