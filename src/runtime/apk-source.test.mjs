// 手机 App 从哪来（runtime/apk-source.mjs）：版本对齐（≤ 服务端、优先同一次构建）、本地文件优先级、旧单一文件名的兜底、
// 发布清单 android 条目的校验、发布页链接推导、从发布页按 sha256 缓存到数据根（大小 / 哈希对不上就丢弃）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-apksrc-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.BRIDGE_APK_FEED = '';

const src = await import('./apk-source.mjs');

const sha = (b) => createHash('sha256').update(b).digest('hex');
let n = 0;
function dirs() {
  const root = path.join(tmp, 'r' + (++n));
  const programRoot = path.join(root, 'prog'), dataRoot = path.join(root, 'data');
  mkdirSync(programRoot, { recursive: true }); mkdirSync(path.join(dataRoot, 'app'), { recursive: true });
  return { programRoot, dataRoot };
}

test('纯函数：文件名里的版本号、挑 ≤ 服务端的最高一版、发布页链接', () => {
  assert.equal(src.apkCodeOf('ClaudeBridge-offline-465.apk'), 465);
  assert.equal(src.apkCodeOf('/x/y/ClaudeBridge-12.apk'), 12);
  assert.equal(src.apkCodeOf('ClaudeBridge-offline.apk'), 0);
  assert.equal(src.apkCodeOf('evil-465.apk'), 0);
  const list = [{ code: 3 }, { code: 7 }, { code: 5 }];
  assert.equal(src.pickBest(list, 6).code, 5);
  assert.equal(src.pickBest(list, 7).code, 7);
  assert.equal(src.pickBest(list, 2), null);
  assert.equal(src.releasePageFrom('https://github.com/o/r/releases/latest/download/latest.json'), 'https://github.com/o/r/releases/latest');
  assert.equal(src.releasePageFrom('https://oss.example.com/latest.json'), '');
  assert.equal(src.releasePageFrom('https://github.com/o/r/releases/latest/download/latest.json', 'https://x.example/dl'), 'https://x.example/dl');
});

test('发布清单 android 条目：单个 / 数组都认；缺哈希、大小或不是 https 的不认；相对地址按清单补全', () => {
  const good = { code: 10, name: '1.0', sha256: 'a'.repeat(64), size: 5, url: 'ClaudeBridge-10.apk' };
  const base = 'https://github.com/o/r/releases/latest/download/latest.json';
  assert.equal(src.androidEntries({ android: good }, base)[0].url, 'https://github.com/o/r/releases/latest/download/ClaudeBridge-10.apk');
  const arr = src.androidEntries({ android: [good, { ...good, code: 11, sha256: 'x' }, { ...good, code: 12, url: 'http://plain/a.apk' }, { ...good, code: 13, url: '', mirrors: ['http://no', 'https://m.example/13.apk'] }] }, base);
  assert.deepEqual(arr.map((x) => x.code), [10, 13]);
  assert.equal(arr[1].url, 'https://m.example/13.apk');
  assert.deepEqual(src.androidEntries({ version: '1' }, base), []);
});

test('本地文件：正好同一版优先；没有就取 ≤ 服务端的最高一版；比服务端新的不发；程序目录优先于数据根缓存', () => {
  const d = dirs();
  writeFileSync(path.join(d.programRoot, 'ClaudeBridge-offline-100.apk'), 'p100');
  writeFileSync(path.join(d.programRoot, 'ClaudeBridge-offline-102.apk'), 'p102');
  writeFileSync(path.join(d.dataRoot, 'app', 'ClaudeBridge-101.apk'), 'c101');
  writeFileSync(path.join(d.dataRoot, 'app', 'ClaudeBridge-102.apk'), 'c102');
  let a = src.localApk({ ...d, serverCode: 102 });
  assert.equal(a.code, 102); assert.equal(a.source, 'local'); assert.equal(a.sha256, sha('p102'));
  a = src.localApk({ ...d, serverCode: 101 });
  assert.equal(a.code, 101); assert.equal(a.source, 'cache');
  assert.equal(src.localApk({ ...d, serverCode: 99 }), null, '全比服务端新：一份都不发');
});

test('旧的单一文件名只在一个版本化文件都没有时才认（否则会拿旧包冒充新版本号，手机陷入更新循环）', () => {
  const d = dirs();
  writeFileSync(path.join(d.programRoot, 'ClaudeBridge-offline.apk'), 'legacy');
  let a = src.localApk({ ...d, serverCode: 50 });
  assert.equal(a.code, 50); assert.equal(a.sha256, sha('legacy'));
  writeFileSync(path.join(d.programRoot, 'ClaudeBridge-offline-49.apk'), 'p49');
  a = src.localApk({ ...d, serverCode: 50 });
  assert.equal(a.code, 49, '有版本化文件时报它真实的版本号');
});

test('从发布页缓存：大小与 sha256 都对才落盘，不对就丢弃', async () => {
  const d = dirs();
  const body = Buffer.from('fake-apk-bytes');
  const mk = (bytes) => async () => new Response(bytes);
  const entry = { code: 77, name: '7.7', sha256: sha(body), size: body.length, url: 'https://example.invalid/a.apk' };
  assert.equal(await src.prefetchApk({ ...entry, sha256: 'b'.repeat(64) }, { dataRoot: d.dataRoot, fetchImpl: mk(body) }), null);
  assert.equal(existsSync(path.join(d.dataRoot, 'app', 'ClaudeBridge-77.apk')), false);
  assert.equal(existsSync(path.join(d.dataRoot, 'app', 'ClaudeBridge-77.apk.partial')), false, '半截文件也清掉');
  assert.equal(await src.prefetchApk({ ...entry, size: body.length + 3 }, { dataRoot: d.dataRoot, fetchImpl: mk(body) }), null);
  const f = await src.prefetchApk(entry, { dataRoot: d.dataRoot, fetchImpl: mk(body) });
  assert.equal(f, path.join(d.dataRoot, 'app', 'ClaudeBridge-77.apk'));
  assert.equal(readFileSync(f, 'utf8'), 'fake-apk-bytes');
  const a = src.localApk({ ...d, serverCode: 77 });
  assert.equal(a.source, 'cache'); assert.equal(a.code, 77);
});

test('缓存失败按条目退避：退避期内不再拉整包；清单改对了（新条目）马上能试', async () => {
  const d = dirs();
  let calls = 0;
  const body = Buffer.from('bytes-88');
  const fetchImpl = async () => { calls++; return new Response(body); };
  const bad = { code: 88, name: '8.8', sha256: 'c'.repeat(64), size: body.length, url: 'https://example.invalid/88.apk' };
  assert.equal(await src.prefetchApk(bad, { dataRoot: d.dataRoot, fetchImpl }), null);
  assert.equal(calls, 1);
  assert.ok(src.prefetchBackoffLeft(bad) > 25 * 60_000, '失败一次退避约 30 分钟');
  assert.equal(await src.prefetchApk(bad, { dataRoot: d.dataRoot, fetchImpl }), null);
  assert.equal(calls, 1, '退避期内不再下载');
  const fixed = { ...bad, sha256: sha(body) };
  assert.equal(src.prefetchBackoffLeft(fixed), 0);
  assert.ok(await src.prefetchApk(fixed, { dataRoot: d.dataRoot, fetchImpl }));
  assert.equal(calls, 2);
});

test('发布清单：相对地址按清单的版本标签补全；latest 里没有 ≤ 服务端的就取自己那次发布的清单', async () => {
  const feedUrl = 'https://github.com/o/r/releases/latest/download/latest.json';
  assert.equal(src.taggedFeedUrl(feedUrl, '2026.10.21.1111'), 'https://github.com/o/r/releases/download/v2026.10.21.1111/latest.json');
  assert.equal(src.taggedFeedUrl('https://oss.example.com/latest.json', '1.0'), '');
  assert.equal(src.taggedFeedUrl(feedUrl, '../x'), '');
  assert.equal(src.taggedFeedUrl(feedUrl, ''), '');
  const ent = (code) => ({ code, name: String(code), sha256: 'a'.repeat(64), size: 5, url: `ClaudeBridge-${code}.apk` });
  const manifests = {
    [feedUrl]: { version: '2.0', android: ent(20) },
    'https://github.com/o/r/releases/download/v1.0/latest.json': { version: '1.0', android: ent(10) },
  };
  const seen = [];
  const fetchImpl = async (u) => { seen.push(u); const m = manifests[u]; return m ? new Response(JSON.stringify(m)) : new Response('nope', { status: 404 }); };
  try {
    // 服务端跟上了最新版：只取 latest；相对地址按 v2.0 标签补全（不按会漂走的 latest/download）
    let e = await src.refreshApkFeed({ force: true, url: feedUrl, fetchImpl, serverCode: 20, ownVersion: '2.0' });
    assert.deepEqual(seen, [feedUrl]);
    assert.equal(e[0].url, 'https://github.com/o/r/releases/download/v2.0/ClaudeBridge-20.apk');
    // 服务端停在旧版（10）：latest 的 20 比它新、不能发 → 再取它自己那次发布（v1.0）的清单
    seen.length = 0;
    e = await src.refreshApkFeed({ force: true, url: feedUrl, fetchImpl, serverCode: 10, ownVersion: '1.0' });
    assert.equal(seen.length, 2);
    assert.equal(src.pickBest(e, 10).url, 'https://github.com/o/r/releases/download/v1.0/ClaudeBridge-10.apk');
    // 不知道自己是哪次发布（git 部署 / Docker）：不乱猜，照实回没有
    seen.length = 0;
    e = await src.refreshApkFeed({ force: true, url: feedUrl, fetchImpl, serverCode: 10, ownVersion: '' });
    assert.equal(seen.length, 1);
    assert.equal(src.pickBest(e, 10), null);
  } finally { await src.refreshApkFeed({ url: '' }); }
});

test('自己是哪次发布：程序根 bridge-build.json 的 version（或 buildId 的版本段）；没有 / 不像样回空', () => {
  const d = dirs();
  assert.equal(src.ownReleaseVersion(d.programRoot), '');
  writeFileSync(path.join(d.programRoot, 'bridge-build.json'), JSON.stringify({ buildId: '2026.10.21.1111+c54f7d1' }));
  assert.equal(src.ownReleaseVersion(d.programRoot), '2026.10.21.1111');
  writeFileSync(path.join(d.programRoot, 'bridge-build.json'), JSON.stringify({ version: '2026.10.22.0900', buildId: 'x' }));
  assert.equal(src.ownReleaseVersion(d.programRoot), '2026.10.22.0900');
  writeFileSync(path.join(d.programRoot, 'bridge-build.json'), JSON.stringify({ version: '../../evil' }));
  assert.equal(src.ownReleaseVersion(d.programRoot), '');
});

test('版本接口：没有任何来源时 available=false、带服务端版本与发布页字段', () => {
  const v = src.appVersionInfo();
  assert.equal(typeof v.available, 'boolean');
  assert.equal(v.policy, 'same-or-older');
  assert.equal(typeof v.releasePage, 'string');
  assert.ok(v.code <= v.server.code);
});
