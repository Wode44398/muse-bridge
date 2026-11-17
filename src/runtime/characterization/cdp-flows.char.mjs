// bridge 浏览器驱动（src/runtime/cdp.mjs）的特征基准：拆分前后，CdpSession 的行为逐字不变。
// CB01 真起本机 Edge / Chrome 的无头实例（launch 时 desktop:false，不进桌面壳、不开窗口）打本地靶页，逐个调公开方法记结果；
// CB02 沿用现有测试（cdp-viewport.test.mjs 等）的桩写法：send 换成记录调用的假实现，钉住无头与桌面壳两种模式下
// 视口 / 仿真 / 对话框 / 控制台 / 网络等分支发出的 CDP 命令序列。截图只记尺寸。没有浏览器的机器跳过 CB01。
//
// 不进全量测试（文件名不是 *.test.mjs）。拆分前后这样跑（在仓库根）：
//   node --import ./src/modules/register.mjs --test src/runtime/characterization/cdp-flows.char.mjs
// 有意改行为时在未改动的代码上加 UPDATE_CHAR_BASELINE=1 重新生成基准。
//
// 本文件不能静态 import bridge 的运行时模块：环境变量要先于它们设好。
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineStore, Normalizer } from '../../routes/characterization/normalize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = baselineStore(path.join(here, 'cdp-flows.baseline.json'), {
  update: process.env.UPDATE_CHAR_BASELINE === '1',
  actualDir: process.env.CHAR_ACTUAL_DIR,
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dimensio-char-cdp-'));
const dirs = { data: path.join(tmp, 'data'), vault: path.join(tmp, 'vault'), users: path.join(tmp, 'users'), claude: path.join(tmp, 'claude') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|_CLAUDE_|CLAUDE|BRIDGE_|VERTEX_|GEMINI_|OPENROUTER_|GIT_)/i.test(k) || ['PORT', 'VAULT_PATH', 'PYTHONIOENCODING', 'CODEX_BIN', 'PV_PUBLIC_DOMAIN'].includes(k)) delete process.env[k];
}
Object.assign(process.env, {
  BRIDGE_DATA_ROOT: dirs.data, VAULT_PATH: dirs.vault, BRIDGE_USERS_ROOT: dirs.users, CLAUDE_CONFIG_DIR: dirs.claude,
  // 家目录与 APPDATA / LOCALAPPDATA 不改：Edge 改了它们就起不来（调试端口等不到）；带临时配置档启动，它自己的数据落在配置档里
  BRIDGE_MODULES_SKIP: 'all', BRIDGE_CLAUDE_IN_CHROME: '0', BRIDGE_NO_ROUTINES: '1', BRIDGE_DESKTOP_MIRROR: '0',
});
const { CdpSession, findBrowser } = await import('../cdp.mjs');

const PAGE = `<!doctype html><meta name=viewport content="width=device-width"><title>target</title>
<style>body{font:16px sans-serif;margin:0;padding:20px}button{margin:4px;padding:8px}.spacer{height:2000px}</style>
<h1>Char page</h1>
<button id=menu onclick="document.getElementById('msg').textContent='menu clicked'">Menu</button>
<label><input type=checkbox id=cb> Agree</label>
<input id=q placeholder=Search>
<select id=sel><option value=1>One</option><option value=2>Two</option></select>
<button id=al onclick="alert('hello from alert');document.getElementById('msg').textContent='after alert'">Alert me</button>
<button id=log onclick="console.log('char-console-line');fetch('/api/x').then(r=>r.text())">Log</button>
<a id=next href="/page2">Next page</a>
<div id=msg></div>
<input type=file id=fi>
<div class=spacer></div>`;
const server = http.createServer((req, res) => {
  if (req.url === '/api/x') { res.setHeader('content-type', 'application/json'); res.end('{"ok":"api"}'); return; }
  if (req.url === '/page2') { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end('<title>second</title><h1>second page</h1>'); return; }
  res.setHeader('content-type', 'text/html;charset=utf-8');
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
fs.writeFileSync(path.join(tmp, 'up.txt'), 'upload me\n');

const skip = process.platform !== 'win32' || !findBrowser() ? '需要 Windows + 本机 Chrome/Edge' : false;
const norm = () => new Normalizer([
  [new RegExp(base.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g'), '<base>'],
  [new RegExp(base.replace(/^http:\/\//, '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g'), '<host>'],
  [/\b[0-9A-F]{32}\b/g, '<target>'],
  [/\b\d+\.\d+(?= ?ms\b)/g, '<t>'],
  [/\b\d+ ?ms\b/g, '<n>ms'],
], /^(t|ts|timestamp|requestId|wallTime|settledMs|tookMs|loadingSince|navSeq|docSeq|doc)$/);

test('CB01 真无头浏览器：启动、导航、读页、点击、输入、填值、上传、对话框、控制台与网络、视口、新标签、历史、关闭', { skip, timeout: 180_000 }, async () => {
  const n = norm();
  const steps = [];
  const s = new CdpSession();
  const rec = async (label, fn) => {
    try { steps.push({ label, ok: true, value: n.value(await fn()) }); } catch (e) { steps.push({ label, ok: false, error: n.str(String(e?.message || e)) }); }
  };
  try {
    await rec('launch', async () => { await s.launch(base + '/', { desktop: false }); return { alive: s.alive, url: s.url, viewport: s.viewport }; });
    await rec('settle', () => s.settle({}).then(() => 'settled'));
    await rec('title', () => s.title());
    await rec('eval', () => s.eval('document.title + " / " + document.querySelectorAll("button").length'));
    await rec('eval-throw', () => s.eval('throw new Error("char boom")'));
    // 还没设配色仿真时 dark 跟的是系统主题（环境值），抹掉
    await rec('measure', async () => ({ ...(await s.measure()), dark: '<os-theme>' }));
    await rec('viewportReport', () => s.viewportReport());
    await rec('ax', async () => { const a = await s.axSnapshot({}); return { keys: Object.keys(a || {}).sort(), text: a?.text }; });
    await rec('refInfo-1', () => s.refInfo(1));
    await rec('findTextPoint', () => s.findTextPoint('Agree'));
    await rec('clickText', () => s.clickText('Menu'));
    await rec('msg-after-click', () => s.eval('document.getElementById("msg").textContent'));
    await rec('clickCoord', () => s.clickCoord(30, 30));
    await rec('hoverCoord', () => s.hoverCoord(40, 40, 'user'));
    await rec('setValue-q', () => s.setValue({ selector: '#q' }, 'hello'));
    await rec('setValue-sel', () => s.setValue({ selector: '#sel' }, 'Two'));
    await rec('setValue-bad', () => s.setValue({ selector: '#nope' }, 'x'));
    await rec('focus-and-type', async () => { await s.focusTarget({ selector: '#q' }); await s.typeText('!'); return s.eval('document.getElementById("q").value'); });
    await rec('pressKey', () => s.pressKey('ctrl+a'));
    await rec('upload', () => s.setInputFiles([path.join(tmp, 'up.txt')], { selector: '#fi' }));
    await rec('dialog', async () => { const mark = s.dialogSeq; await s.clickText('Alert me'); await new Promise((r) => setTimeout(r, 300)); return s.dialogsSince(mark).map((d) => ({ ...d, t: undefined })); });
    await rec('log-and-fetch', async () => { await s.clickText('Log'); await new Promise((r) => setTimeout(r, 500)); return { console: s.consoleEntries().map((e) => ({ ...e, t: undefined })), net: s.networkEntries().filter((e) => /api/.test(e.url || '')).map((e) => ({ url: e.url, method: e.method, status: e.status })) }; });
    await rec('scrollBy', async () => { await s.scrollBy(300); return s.eval('Math.round(window.scrollY)'); });
    await rec('wheel', async () => { await s.wheel(100, 100, -300); await new Promise((r) => setTimeout(r, 200)); return s.eval('Math.round(window.scrollY)'); });
    await rec('pageText', () => s.pageText());
    await rec('screenshot', async () => { const r = await s.screenshot({}); return { keys: Object.keys(r || {}).sort(), width: r?.width, height: r?.height, frame: r?.frame }; });
    await rec('setViewport-mobile', () => s.setViewport(390, 844, { mobile: true }));
    await rec('measure-mobile', async () => ({ ...(await s.measure()), dark: '<os-theme>' }));
    await rec('setViewport-desktop', () => s.setViewport(1280, 800, { mobile: false, scheme: 'dark' }));
    await rec('setColorScheme', () => s.setColorScheme('light'));
    await rec('newTab', async () => { await s.newTab(base + '/page2'); await new Promise((r) => setTimeout(r, 500)); return s.tabs.map((t) => ({ url: t.url, active: t.active })); });
    await rec('activateTab', async () => { const other = s.tabs.find((t) => !t.active); await s.activateTab(other.id); return s.tabs.map((t) => ({ url: t.url, active: t.active })); });
    await rec('closeTab', async () => { const other = s.tabs.find((t) => !t.active); await s.closeTab(other.id); await new Promise((r) => setTimeout(r, 300)); return s.tabs.map((t) => ({ url: t.url, active: t.active })); });
    await rec('navigate-next', async () => { const r = await s.navigate(base + '/page2'); return { ...r, ms: undefined }; });
    await rec('history-back', async () => { await s.history(-1); return s.url; });
    await rec('history-forward', async () => { await s.history(1); return s.url; });
    await rec('reload', async () => { await s.reload(); return s.url; });
    await rec('viewers', () => { const off = s.addViewer({ kind: 'stream', where: 'char' }); const list = [...s.viewers.values()]; off?.(); return { list, after: s.viewers.size }; });
  } finally {
    await rec('close', async () => { await s.close(); return { alive: s.alive }; });
  }
  store.check('CB01-headless', steps);
});

// 现有测试的写法：send 记录调用、按方法回固定值
function stub({ desktop = false, measured = null } = {}) {
  const s = new CdpSession();
  const sent = [];
  s.send = async (method, params) => {
    sent.push([method, params]);
    if (method === 'Browser.getVersion') return { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' };
    if (method === 'Runtime.evaluate') return { result: { value: null } };
    return {};
  };
  s.measure = async () => measured;
  const shell = [];
  if (desktop) {
    s.desktopBroker = 'http://127.0.0.1:1/secret';
    s.activeTargetId = 'ABC';
    s.desktopViewport = async (w, h) => { shell.push([w, h]); return { ok: true, via: 'shell', mounted: false, zoom: 1 }; };
  }
  const views = [];
  s.subscribeViewport((v) => views.push(v));
  const ptrs = [];
  s.subscribePointer((p) => ptrs.push(p));
  return { s, sent, shell, views, ptrs };
}

test('CB02 桩：无头 / 桌面壳两种模式的视口与仿真、触屏、按键、点击、对话框、控制台、网络、投屏订阅', { timeout: 60_000 }, async () => {
  const n = norm();
  const out = [];
  const run = async (label, opts, fn) => {
    const st = stub(opts);
    let value, error;
    try { value = await fn(st.s); } catch (e) { error = String(e?.message || e); }
    out.push({ label, value: n.value(value ?? null), error: error ? n.str(error) : null, sent: n.value(st.sent), shell: st.shell, views: n.value(st.views), ptrs: n.value(st.ptrs), state: n.value({ viewport: st.s.viewport, emu: st.s.emu, applied: st.s.applied }) });
  };
  const m = (o) => ({ w: 375, h: 812, dpr: 1, touch: 5, coarse: true, dark: false, meta: true, ...o });
  await run('headless-mobile', { measured: m() }, (s) => s.setViewport(375, 812, { mobile: true, scheme: 'dark' }));
  await run('headless-mobile-then-desktop', { measured: m({ w: 1280, h: 900, touch: 0, coarse: false }) }, async (s) => { await s.setViewport(375, 812, { mobile: true }); return s.setViewport(1280, 900, { mobile: false }); });
  await run('headless-dpr', { measured: m({ w: 800, h: 600, dpr: 2 }) }, (s) => s.setViewport(800, 600, { dpr: 2 }));
  await run('headless-bad-size', { measured: m() }, (s) => s.setViewport(0, 10, {}));
  await run('desktop-shell', { desktop: true, measured: m({ w: 1024, h: 768, touch: 0, coarse: false }) }, (s) => s.setViewport(1024, 768, { mobile: false }));
  await run('desktop-shell-mobile', { desktop: true, measured: m() }, (s) => s.setViewport(375, 812, { mobile: true }));
  await run('color-scheme', {}, (s) => s.setColorScheme('dark'));
  await run('keys', {}, async (s) => { await s.pressKey('ctrl+shift+K'); await s.pressKey('Enter'); return 'ok'; });
  await run('type', {}, (s) => s.typeText('hi'));
  await run('click-coord', {}, (s) => s.clickCoord(10, 20, { button: 'right', clickCount: 2, source: 'user' }));
  await run('hover-coord', {}, (s) => s.hoverCoord(5, 6));
  await run('wheel', {}, (s) => s.wheel(1, 2, 30, 4));
  await run('scroll', {}, (s) => s.scrollBy(50));
  await run('dialog', {}, (s) => { s.onDialog({ type: 'confirm', message: 'really?' }); s.onDialog({ type: 'alert', message: 'hi' }); return s.dialogsSince(0).map((d) => ({ ...d, t: undefined })); });
  await run('console', {}, (s) => { s.pushConsole('log', 'one'); s.pushConsole('error', 'two'); const a = s.consoleEntries().map((e) => ({ ...e, t: undefined })); s.clearConsole(); return { a, after: s.consoleEntries().length }; });
  await run('messages', {}, (s) => {
    s.onMessage(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'from page' }] } }));
    s.onMessage(JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: '1.1', request: { url: 'http://x/a', method: 'GET' }, type: 'Fetch' } }));
    s.onMessage(JSON.stringify({ method: 'Network.responseReceived', params: { requestId: '1.1', response: { status: 200, mimeType: 'application/json', url: 'http://x/a' }, type: 'Fetch' } }));
    s.onMessage(JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: '1.1', encodedDataLength: 12 } }));
    s.onMessage(JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: 'popup' } }));
    s.onMessage(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'F', url: 'http://x/next' } } }));
    return { console: s.consoleEntries().map((e) => ({ ...e, t: undefined })), net: s.networkEntries().map((e) => ({ ...e, t: undefined, ts: undefined })), url: s.url, dialogs: s.dialogsSince(0).map((d) => ({ ...d, t: undefined })) };
  });
  await run('cast', {}, async (s) => { const frames = []; const off = await s.subscribeCast((f) => frames.push(f)); s.onMessage(JSON.stringify({ method: 'Page.screencastFrame', params: { data: 'AAAA', sessionId: 7, metadata: { deviceWidth: 10, deviceHeight: 20 } } })); off?.(); return { frames: frames.length }; });
  await run('viewers', {}, (s) => { const a = s.addViewer({ kind: 'native', where: 'pc' }); const b = s.addViewer({ kind: 'stream', where: 'phone' }); const list = [...s.viewers.values()]; a?.(); return { list, after: [...s.viewers.values()] }; });
  await run('frame-to-css', {}, (s) => { s.frame = { scale: 2, ox: 10, oy: 20, w: 200, h: 100 }; return [s.frameToCss(10, 20), s.frameToCss(110, 70)]; });
  await run('pending-requests', {}, (s) => s.pendingRequests(0));
  await run('require-target', {}, (s) => s.requireTargetDomain());
  await run('tabs', {}, (s) => { const seen = []; const off = s.subscribeTabs((t) => seen.push(t)); s.seedTabs([{ id: 'T1', url: 'http://x/1', title: 'one', type: 'page' }, { id: 'T2', url: 'http://x/2', title: 'two', type: 'page' }]); s.upsertTab({ id: 'T3', url: 'http://x/3', title: 'three' }); s.onTargetGone('T2'); off?.(); return { seen, tabs: s.tabs }; });
  store.check('CB02-stubbed', out);
});

test.after(() => {
  store.flush();
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  setTimeout(() => process.exit(process.exitCode || 0), 300);
});
