// Muse 插件（deploy/muse/plugin）：安卓 App 改用 bridge 的 apk 之后的几条路由与旧版 Muse App 的迁移页。
//   node --test deploy/muse/test/plugin.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { installCoreResolver } from '../../../src/modules/core-resolve.mjs';

installCoreResolver();
const P = await import('../plugin/index.mjs');

const OLD_UA = 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 MuseBridgeApp/0.3.6 (412)';
const NEW_UA = 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 BridgeDevice/dev_x';
const req = (path, ua, extra = {}) => ({ method: 'GET', url: path, headers: { 'user-agent': ua, host: 'muse.example.com', ...extra } });

// 假的插件上下文：收下中间件与路由，按 bridge 路由器的规则（中间件先跑、回 false 就停）分派
function mount() {
  const mws = [], routes = new Map();
  const ctx = {
    router: { use: (fn) => mws.push(fn) },
    route: (m, p, h) => routes.set(m + ' ' + p, h),
    http: { user: () => ({ kind: 'admin' }), json: (res, s, o) => { res.writeHead(s, {}); res.end(JSON.stringify(o)); } },
    manual: () => {},
  };
  P.apply(ctx);
  return async (r) => {
    const out = { status: 0, headers: {}, body: '' };
    const res = { writeHead: (s, h) => { out.status = s; out.headers = h || {}; }, end: (b = '') => { out.body = String(b); }, get writableEnded() { return !!out.status; } };
    const url = new URL(r.url, 'http://x');
    for (const m of mws) if ((await m(r, res, url)) === false) return out;
    const h = routes.get(r.method + ' ' + url.pathname);
    if (!h) return { status: 404, headers: {}, body: 'core' };
    await h(r, res, url);
    return out;
  };
}

test('androidInfo：本体 apk 信息换成面板 / 旧接口的形状；下载一律走本体的 /download/android', () => {
  assert.deepEqual(P.androidInfo({ available: true, code: 497, name: '6.84', size: 6652034 }),
    { available: true, versionName: '6.84', versionCode: 497, size: 6652034, url: '/download/android', github: P.GITHUB_APK });
  const none = P.androidInfo({ available: false, code: 497, name: '6.84', size: 0 });
  assert.equal(none.available, false);
  assert.equal(none.url, '');
  assert.equal(none.versionCode, 0);
});

test('旧版 Muse App 打开首页 → 迁移页；新 App、浏览器、别的路径都不拦', async () => {
  const go = mount();
  const old = await go(req('/', OLD_UA, { 'accept-language': 'zh-CN,zh;q=0.9' }));
  assert.equal(old.status, 200);
  assert.match(old.body, /请换装新版 Muse Bridge App/);
  assert.match(old.body, /href="\/\?legacy=1"/);
  const oldEn = await go(req('/', OLD_UA, { 'accept-language': 'en-US' }));
  assert.match(oldEn.body, /Get the new Muse Bridge app/);
  for (const r of [req('/', NEW_UA), req('/', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130'), req('/api/auth', OLD_UA), req('/app/x.js', OLD_UA)]) {
    assert.equal((await go(r)).body, 'core', r.url + ' ' + r.headers['user-agent']);
  }
});

test('「先继续用旧版」记 7 天：带 cookie 不再拦，?legacy=1 落 cookie 后回首页', async () => {
  const go = mount();
  const skip = await go(req('/?legacy=1', OLD_UA));
  assert.equal(skip.status, 302);
  assert.equal(skip.headers.Location, '/');
  assert.match(skip.headers['Set-Cookie'], /^mb_legacy_ok=1; Max-Age=604800; Path=\//);
  assert.equal((await go(req('/', OLD_UA, { cookie: 'a=b; mb_legacy_ok=1' }))).body, 'core');
});

test('旧下载链接 /download/MuseBridge.apk → 本体的 /download/android', async () => {
  const go = mount();
  for (const method of ['GET', 'HEAD']) {
    const r = await go({ ...req('/download/MuseBridge.apk', NEW_UA), method });
    assert.equal(r.status, 302);
    assert.equal(r.headers.Location, '/download/android');
  }
});

test('迁移页：没有安装包时给 GitHub 地址；文案转义', () => {
  const html = P.legacyPage({ available: false });
  assert.ok(html.includes(P.GITHUB_APK));
  assert.ok(!P.legacyPage({ download: '"><script>' }).includes('"><script>'));
});
