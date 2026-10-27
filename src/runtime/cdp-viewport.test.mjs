import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession, resolveViewportSpec, presetKeyFor, mobileUserAgent } from './cdp.mjs';
import { describeViewport } from './claude-browser.mjs';

// 视口的两条真相：谁把它变成像素，以及谁被告知。
//  - headless（自家 Edge）：CDP 设备指标模拟就是实现（mobile:true 连触屏 / UA / viewport-meta
//    一起仿）。
//  - 桌面壳（真 WebContentsView）：实现是壳按 contain 缩放摆位 + zoomFactor，逻辑视口经
//    broker PUT target/<id>/viewport 交给壳；这里再下一层设备指标模拟只会打架（override 比
//    控件大 → 画面钉在左上角被裁，撞 zoom → CSS 视口翻倍）。
//  两种模式都以页面实测（measure）为准回报，工具不靠「我发过命令了」说话。
function stub(desktop, measured = null) {
  const session = new CdpSession();
  const sent = [];
  session.send = async (method, params) => { sent.push([method, params]); return method === 'Browser.getVersion' ? { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' } : {}; };
  session.measure = async () => measured;
  const shellCalls = [];
  if (desktop) {
    session.desktopBroker = 'http://127.0.0.1:1/secret';
    session.activeTargetId = 'ABC';
    session.desktopViewport = async (w, h) => { shellCalls.push([w, h]); return { ok: true, via: 'shell', mounted: false, zoom: 1 }; };
  }
  const seen = [];
  session.subscribeViewport((v) => seen.push(v));
  return { session, sent, seen, shellCalls };
}
const methods = (sent) => sent.map(([m]) => m);

test('headless viewport switch emulates device metrics + touch + UA + color scheme', async () => {
  const { session, sent, seen } = stub(false, { w: 375, h: 812, dpr: 1, touch: 5, coarse: true, dark: false, meta: true });
  const r = await session.setViewport(375, 812, { mobile: true, scheme: 'dark' });
  const metrics = sent.find(([m]) => m === 'Emulation.setDeviceMetricsOverride')[1];
  assert.deepEqual(metrics, { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  assert.ok(methods(sent).includes('Emulation.setTouchEmulationEnabled'));
  const ua = sent.find(([m]) => m === 'Emulation.setUserAgentOverride')[1];
  assert.match(ua.userAgent, /Android 14; Pixel 8.*Chrome\/140\.0\.0\.0 Mobile Safari/, '移动端 UA 抄真实 Chrome 主版本');
  const media = sent.find(([m]) => m === 'Emulation.setEmulatedMedia')[1];
  assert.deepEqual(media.features, [{ name: 'prefers-color-scheme', value: 'dark' }]);
  assert.deepEqual(session.viewport, { width: 375, height: 812 });
  assert.deepEqual(session.emu, { mobile: true, scheme: 'dark', dpr: 1 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].viewport, { width: 375, height: 812 }, '广播的是完整 viewportReport');
  assert.equal(seen[0].measured.w, 375);
  assert.equal(r.preset, 'mobile');
});

test('leaving mobile restores the real UA instead of leaving a phone UA behind', async () => {
  const { session, sent } = stub(false, { w: 1280, h: 900, dpr: 1, touch: 0, coarse: false, dark: false, meta: true });
  await session.setViewport(375, 812, { mobile: true });
  sent.length = 0;
  await session.setViewport(1280, 900, { mobile: false });
  const ua = sent.find(([m]) => m === 'Emulation.setUserAgentOverride')[1];
  assert.match(ua.userAgent, /Windows NT 10\.0/);
  assert.equal(ua.platform, 'Win32');
  const touch = sent.find(([m]) => m === 'Emulation.setTouchEmulationEnabled')[1];
  assert.equal(touch.enabled, false);
});

test('desktop-shell viewport goes to the shell broker, never to device-metrics emulation', async () => {
  const { session, sent, seen, shellCalls } = stub(true, { w: 375, h: 812, dpr: 1.5, touch: 5, coarse: true, dark: false, meta: true });
  await session.setViewport(375, 812, { mobile: true });
  // 允许的只有「只覆盖 DSF」（width/height=0，几何不动）——那是 DPR 校正，见下面几条
  for (const [m, p] of sent) {
    if (m === 'Emulation.setDeviceMetricsOverride') {
      assert.deepEqual([p.width, p.height, p.mobile], [0, 0, false], '真 WebContentsView 上加带尺寸的设备指标模拟 = 画面被裁');
    }
  }
  assert.deepEqual(shellCalls, [[375, 812]], '逻辑视口交给壳');
  assert.ok(methods(sent).includes('Emulation.setTouchEmulationEnabled'), '触屏仿真与几何无关，壳模式也要');
  assert.deepEqual(seen[0].viewport, { width: 375, height: 812 }, '面板靠广播重新缩放摆位');
  assert.equal(seen[0].applied.ok, true);
});

// 壳里 devicePixelRatio = 显示器缩放 × 面板 zoom（实测 1.5 × 0.628 = 0.942）。只覆盖 DSF 与 zoom 相乘，
// 所以校正值 = 期望 DPR / zoom；zoom 靠先覆盖成 1 量出来。
function shellDprStub(display, zoom) {
  const s = stub(true);
  const { session } = s;
  let dsf = 0;
  const base = session.send;
  session.send = async (method, params) => {
    if (method === 'Emulation.setDeviceMetricsOverride') dsf = params.deviceScaleFactor;
    if (method === 'Emulation.clearDeviceMetricsOverride') dsf = 0;
    return base(method, params);
  };
  const dpr = () => Math.round((dsf || display) * zoom * 1000) / 1000;
  session.measure = async () => ({ w: session.viewport.width, h: session.viewport.height, dpr: dpr(), touch: 0, coarse: false, dark: false, meta: true });
  session.eval = async (e) => (e === 'devicePixelRatio' ? dpr() : null);
  return { ...s, setZoom: (z) => { zoom = z; } };
}

test('desktop shell: page DPR follows the monitor, not the panel zoom', async () => {
  const { session, setZoom } = shellDprStub(1.5, 0.628);
  const r = await session.setViewport(1280, 900);
  assert.equal(r.measured.dpr, 1.5, '没指定 = 显示器 DPR，面板缩多小都一样');
  assert.equal(session.displayDpr, 1.5);
  assert.equal(r.dprAuto, true);
  assert.match(describeViewport(r), /DPR 跟随显示器（1\.5）/);
  setZoom(0.4);   // 面板挂到更小的格子里
  const m = await session.syncShellMetrics();
  assert.ok(Math.abs(m.dpr - 1.5) < 0.005, `zoom 变了下一次校正就拨回来（实测 ${m.dpr}）`);
});

test('desktop shell: resize(dpr) really lands (no longer "follows the display, cannot change")', async () => {
  const { session } = shellDprStub(1.5, 0.628);
  const r = await session.setViewport(1280, 900, { dpr: 2 });
  assert.equal(r.measured.dpr, 2);
  assert.equal(r.dprAuto, false);
  assert.doesNotMatch(describeViewport(r), /没有落到期望值/);
});

test('desktop shell: a drifted CSS viewport (zoom shared per origin) is re-sent to the shell', async () => {
  const { session, shellCalls } = stub(true);
  let w = 2037;
  session.measure = async () => ({ w, h: 1432, dpr: 1, touch: 0, coarse: false, dark: false, meta: true });
  session.desktopViewport = async (ww, hh) => { shellCalls.push([ww, hh]); w = 1280; return { ok: true, via: 'shell' }; };
  session.eval = async () => 1;
  session.viewport = { width: 1280, height: 900 };
  await session.syncShellMetrics();
  assert.deepEqual(shellCalls, [[1280, 900]]);
});

test('desktop shell: a later resize without dpr keeps following the display (was pinned to 1)', async () => {
  const { session } = shellDprStub(1.5, 0.628);
  await session.setViewport(1280, 900);
  const spec = resolveViewportSpec({ preset: 'mobile' }, session);
  const r = await session.setViewport(spec.width, spec.height, spec);
  assert.equal(r.dprAuto, true, '没给 dpr 的 resize 不该把 DPR 改成「指定过」');
  assert.equal(r.measured.dpr, 1.5);
  assert.match(describeViewport(r), /DPR 跟随显示器（1\.5）/);
  const pinned = await session.setViewport(1280, 900, { dpr: 2 });
  assert.equal(pinned.measured.dpr, 2);
  const back = await session.setViewport(1280, 900, { dpr: 0 });
  assert.equal(back.dprAuto, true, 'dpr 0 撤回指定');
  assert.equal(back.measured.dpr, 1.5);
});

test('new desktop shell (metrics:true) owns geometry + DPR: no DSF override from here, dpr goes in the PUT', async () => {
  const { session, sent } = stub(true, { w: 375, h: 812, dpr: 2, touch: 5, coarse: true, dark: false, meta: true });
  const bodies = [];
  session.desktopViewport = async function (w, h) {
    bodies.push({ w, h, dpr: this.dprExplicit ? this.emu.dpr : 0 });
    this.shellMetrics = true;
    if (!this.dprExplicit) this.displayDpr = 2;
    return { ok: true, via: 'shell', mounted: true, metrics: true };
  };
  const r = await session.setViewport(375, 812, { mobile: true });
  assert.ok(!methods(sent).includes('Emulation.setDeviceMetricsOverride'), '新壳里一条设备指标覆盖都不发');
  assert.deepEqual(bodies[0], { w: 375, h: 812, dpr: 0 });
  assert.equal(r.dprWant, 2);
  assert.match(describeViewport(r), /✓ 视口已真实生效/);
  await session.setViewport(375, 812, { dpr: 3 });
  assert.equal(bodies.at(-1).dpr, 3, '指定的 DPR 交给壳');
});

test('describeViewport: one pixel off is not "✓" any more; an old shell gets the rounding explanation', () => {
  const base = { viewport: { width: 375, height: 812 }, emu: { mobile: true, scheme: 'auto', dpr: 1 }, preset: 'mobile' };
  const m = { w: 374, h: 812, dpr: 1.5, touch: 5, coarse: true, dark: false, meta: true };
  const old = describeViewport({ ...base, applied: { ok: true, via: 'shell' }, measured: m });
  assert.doesNotMatch(old, /✓/);
  assert.match(old, /差 1×0 px：这版桌面壳靠页面缩放/);
  const headless = describeViewport({ ...base, applied: { ok: true, via: 'emulation' }, measured: m });
  assert.match(headless, /⚠ 实测 ≠ 期望（差 1×0）/);
});

test('desktop mode hides the host touchscreen (maxTouchPoints 0); touch mode removes the override', async () => {
  const { session, sent } = stub(false, { w: 1280, h: 900, dpr: 1, touch: 0, coarse: false, dark: false, meta: true });
  const base = session.send;
  session.send = async (method, params) => (method === 'Page.addScriptToEvaluateOnNewDocument' ? (sent.push([method, params]), { identifier: '7' }) : base(method, params));
  session.activeTargetId = 'T1';
  await session.setViewport(1280, 900, { mobile: false });
  assert.match(sent.find(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument')[1].source, /maxTouchPoints/);
  await session.setViewport(375, 812, { mobile: true });
  assert.deepEqual(sent.find(([m]) => m === 'Page.removeScriptToEvaluateOnNewDocument')[1], { identifier: '7' });
});

test('describeViewport flags a DPR that did not land', () => {
  const r = { viewport: { width: 1280, height: 900 }, emu: { mobile: false, scheme: 'auto', dpr: 2 }, dprWant: 2, applied: { ok: true }, preset: 'desktop',
    measured: { w: 1280, h: 900, dpr: 0.942, touch: 0, coarse: false, dark: false, meta: true } };
  assert.match(describeViewport(r), /⚠ DPR 没有落到期望值：期望 2，页面实测 0\.942/);
});

test('headless desktop UA drops the HeadlessChrome marker', async () => {
  const { session, sent } = stub(false, { w: 1280, h: 900, dpr: 1, touch: 0, coarse: false, dark: false, meta: true });
  session.send = async (method, params) => { sent.push([method, params]); return method === 'Browser.getVersion' ? { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36' } : {}; };
  await session.setViewport(1280, 900);
  const ua = sent.find(([m]) => m === 'Emulation.setUserAgentOverride')[1];
  assert.match(ua.userAgent, / Chrome\/155\.0\.0\.0 Safari/);
  assert.doesNotMatch(ua.userAgent, /Headless/);
  assert.ok(!JSON.stringify(ua.userAgentMetadata.brands).includes('Headless'));
});

test('an old shell without the viewport endpoint is reported, not papered over', async () => {
  const { session } = stub(true, { w: 1280, h: 900, dpr: 1.5, touch: 10, coarse: false, dark: false, meta: true });
  session.desktopViewport = async () => ({ ok: false, via: 'shell', error: '桌面壳版本过旧' });
  const r = await session.setViewport(375, 812);
  assert.equal(r.applied.ok, false);
  assert.match(describeViewport(r), /没有真正落到页面上：桌面壳版本过旧/);
});

test('viewport subscribers can unsubscribe', async () => {
  const { session, seen } = stub(true);
  const off = session.subscribeViewport(() => { throw new Error('退订后不该再被调用'); });
  off();
  await session.setViewport(768, 1024);
  assert.equal(seen.length, 1);
});

test('resolveViewportSpec: presets, custom sizes, orientation and flag-only calls', () => {
  const cur = { viewport: { width: 1280, height: 900 }, emu: { mobile: false, scheme: 'auto', dpr: 1 } };
  assert.equal(resolveViewportSpec({}, cur), null, '什么都没给 = 查询');
  assert.deepEqual(resolveViewportSpec({ preset: 'mobile' }, cur), { width: 375, height: 812, mobile: true, scheme: 'auto', preset: 'mobile' }, '没给 dpr 就不进规格（保持当前）');
  assert.deepEqual(resolveViewportSpec({ preset: 'mobile', landscape: true }, cur), { width: 812, height: 375, mobile: true, scheme: 'auto', preset: 'mobile' });
  assert.deepEqual(resolveViewportSpec({ width: 1024, height: 600 }, cur), { width: 1024, height: 600, mobile: true, scheme: 'auto', preset: '' }, '自定义按短边判触屏');
  assert.equal(resolveViewportSpec({ width: 1440, height: 900 }, cur).mobile, false);
  assert.deepEqual(resolveViewportSpec({ scheme: 'dark' }, cur), { width: 1280, height: 900, mobile: false, scheme: 'dark', preset: 'desktop' }, '只给旗标 = 尺寸照旧');
  assert.equal(resolveViewportSpec({ dpr: 2 }, cur).dpr, 2);
  assert.equal(resolveViewportSpec({ dpr: 0 }, cur).dpr, 0, 'dpr 0 = 回到缺省');
  assert.deepEqual(resolveViewportSpec({ width: 500 }, cur).height, 900, '只给宽 = 高照旧');
  assert.equal(resolveViewportSpec({ width: 10, height: 99999 }, cur).width, 200, '钳在 200~4000');
  assert.equal(resolveViewportSpec({ width: 10, height: 99999 }, cur).height, 4000);
  assert.throws(() => resolveViewportSpec({ preset: 'watch' }, cur), /未知 preset/);
  assert.throws(() => resolveViewportSpec({ scheme: 'sepia' }, cur), /scheme/);
  assert.throws(() => resolveViewportSpec({ dpr: 9 }, cur), /dpr/);
  assert.equal(presetKeyFor(812, 375), 'mobile', '横屏也认同一档');
  assert.equal(presetKeyFor(800, 600), '');
});

test('describeViewport explains a missing viewport meta instead of blaming resize', () => {
  const base = { viewport: { width: 375, height: 812 }, emu: { mobile: true, scheme: 'auto', dpr: 1 }, applied: { ok: true }, preset: 'mobile' };
  const ok = describeViewport({ ...base, measured: { w: 375, h: 812, dpr: 1, touch: 5, coarse: true, dark: false, meta: true } });
  assert.match(ok, /✓ 视口已真实生效/);
  const noMeta = describeViewport({ ...base, measured: { w: 980, h: 2122, dpr: 1, touch: 5, coarse: true, dark: false, meta: false } });
  assert.match(noMeta, /没有 <meta name="viewport">/);
  assert.match(noMeta, /不是 resize 没生效/);
  assert.match(mobileUserAgent('… Chrome/131.0.6778.1 …', false), /SM-X910.*Chrome\/131/);
});
