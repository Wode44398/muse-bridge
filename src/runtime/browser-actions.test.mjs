import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession } from './cdp.mjs';
import { handlePageMessage } from './cdp-events.mjs';
import { runBrowserAction } from './browser-actions.mjs';

// 动作层的回执文案：不起真浏览器，用桩池 + 假实例（只实现用到的方法）走 runBrowserAction。
// 真浏览器上的端到端见 bridge build/.scratch/browser-e2e.mjs。

function fakeBrowser(extra = {}) {
  const b = {
    url: 'about:blank', netOrder: [], tabs: [{ id: 't1', url: 'about:blank', title: '', active: true }],
    viewport: { width: 1280, height: 900 }, emu: { mobile: false, scheme: 'auto', dpr: 1 }, dprExplicit: false,
    adopted: new Set(),
    async navigate(u) { b.url = u; b.tabs[0].url = u; return { ms: 1200, settled: true }; },
    async title() { return 'T'; },
    async setViewport(w, h, o = {}) {
      b.viewport = { width: w, height: h };
      b.emu = { ...b.emu, mobile: o.mobile ?? b.emu.mobile, scheme: o.scheme ?? b.emu.scheme };
      return { viewport: b.viewport, emu: b.emu };
    },
    async closeTab(id) { b.tabs = b.tabs.filter((t) => t.id !== id); if (!b.tabs.length) b.alive = false; },
    alive: true,
    ...extra,
  };
  return b;
}

function stubPool(make, { webBridge = false } = {}) {
  let sess = null;
  const pool = {
    getBrowser: async () => (sess && sess.alive ? sess : (sess = make())),
    existingBrowser: () => (sess?.alive ? sess : null),
    touchBrowser() {}, closeBrowser: async () => '已关闭',
    viewerReport: async () => ({ text: '用户看得到：桩' }),
  };
  if (webBridge) pool.tabsNote = async () => '';
  return pool;
}

const say = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// 11-07 会话 400f421e：Web Bridge 会话标签组空着时 tab_new / 关最后一个标签，回执照搬「浏览器原本没开 / 随之断开」，
// agent 就跟用户说 Edge 被重启了、连接没了。
test('Web Bridge：标签组空着 tab_new、关掉最后一个标签，回执说的是标签组，不是浏览器', async () => {
  const pool = stubPool(() => fakeBrowser({ webBridge: { connected: true } }), { webBridge: true });
  const opened = await runBrowserAction('k', { action: 'tab_new', url: 'https://example.com' }, null, { pool });
  assert.match(say(opened), /^你在这个浏览器里原本没有标签，已在你的会话标签组里新开一个并打开（浏览器本来就开着，没有启动它）。/);
  assert.doesNotMatch(say(opened), /浏览器原本没开/);
  const closed = await runBrowserAction('k', { action: 'tab_close', tab: 1 }, null, { pool });
  assert.equal(closed.isError, undefined);
  assert.match(say(closed), /会话标签组空了.*浏览器和 Web Bridge 扩展仍在线/);
  assert.doesNotMatch(say(closed), /随之断开/);

  // 服务器 / 客户端自己起的浏览器：原文案不变
  const own = stubPool(() => fakeBrowser());
  assert.match(say(await runBrowserAction('k', { action: 'tab_new', url: 'https://example.com' }, null, { pool: own })), /^浏览器原本没开，已启动/);
  assert.match(say(await runBrowserAction('k', { action: 'tab_close', tab: 1 }, null, { pool: own })), /浏览器随之退出/);
});

// 11-07：一个对话 resize 成手机档，另一个对话接着 navigate，回执里一个字没提视口，它截到手机图还以为是桌面。
test('navigate：视口不是默认桌面档就写出来，并说清是谁设的', async () => {
  const pool = stubPool(() => fakeBrowser());
  const A = { pool, caller: 'conv-a' };
  const B = { pool, caller: 'conv-b' };
  const plain = await runBrowserAction('k', { action: 'navigate', url: 'https://example.com' }, null, A);
  assert.doesNotMatch(say(plain), /视口/, '默认桌面档不多一句');

  await runBrowserAction('k', { action: 'resize', preset: 'mobile' }, null, A);
  const self = say(await runBrowserAction('k', { action: 'navigate', url: 'https://example.com/a' }, null, A));
  assert.match(self, /当前视口：viewport 375×812 · 触屏（你之前 resize 设的）/);
  assert.doesNotMatch(self, /⚠/);

  const other = say(await runBrowserAction('k', { action: 'navigate', url: 'https://example.com/b' }, null, B));
  assert.match(other, /⚠ 视口不是默认桌面档：viewport 375×812 · 触屏（是同一工作空间的另一个对话设的，这个浏览器各对话共用）；要桌面默认先 resize\(preset:"desktop"\)。/);
  assert.match(other, /另一个对话刚刚（\d+ 秒前）也在操作这个浏览器/, 'A 刚用过 → B 收到提醒');
  // 同一对话接着用：不再提醒
  assert.doesNotMatch(say(await runBrowserAction('k', { action: 'navigate', url: 'https://example.com/c' }, null, B)), /另一个对话刚刚/);

  // resize 之后又被面板 / 别处改过（签名对不上）：认不出是谁，按「沿用之前的设置」说
  pool.existingBrowser('k').viewport = { width: 1670, height: 719 };
  assert.match(say(await runBrowserAction('k', { action: 'navigate', url: 'https://example.com/d' }, null, A)), /⚠ 视口不是默认桌面档：viewport 1670×719 · 触屏（沿用了之前的设置——这个浏览器与同一工作空间的其他对话、浏览器面板共用）/);

  // 认不出调用方（Codex / 远程客户端）：只报视口，不做「别的对话」提醒
  const anon = say(await runBrowserAction('k', { action: 'navigate', url: 'https://example.com/e' }, null, { pool }));
  assert.match(anon, /沿用了之前的设置/);
  assert.doesNotMatch(anon, /另一个对话刚刚/);

  // Web Bridge 是用户自己的窗口，视口不归我们管：不报
  const wb = stubPool(() => fakeBrowser({ webBridge: { connected: true }, viewport: { width: 1600, height: 800 } }), { webBridge: true });
  assert.doesNotMatch(say(await runBrowserAction('k', { action: 'navigate', url: 'https://example.com' }, null, { pool: wb, caller: 'conv-a' })), /视口/);
});

// 11-07 会话 9e77cfb8：console 把同工作空间别的对话看过的 awwwards 报错一起交了出来，agent 当成自己页面的 bug 查了两轮。
test('console：默认只列当前文档的，之前页面 / 标签的只报个数；filter:"all" 全列并标出来处', async () => {
  const s = new CdpSession();
  s.url = 'https://www.awwwards.com/';
  s.pushConsole('error', "Uncaught TypeError: Cannot read properties of null (reading 'style')");
  s.pushConsole('console.warn', 'VIDEOJS: WARN qualityLevels');
  // 主框架换了文档（导航 / 刷新）
  handlePageMessage(s, JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'f1', url: 'file:///demo/index.html' } } }));
  s.pushConsole('console.log', 'todo ready');
  // SPA 页内跳转不换纪元
  handlePageMessage(s, JSON.stringify({ method: 'Page.navigatedWithinDocument', params: { url: 'file:///demo/index.html#done' } }));
  s.pushConsole('error', 'mine failed');

  const pool = { existingBrowser: () => s, touchBrowser() {}, viewerReport: async () => ({ text: '' }) };
  const def = say(await runBrowserAction('k', { action: 'console' }, null, { pool }));
  assert.match(def, /\[console\.log\] todo ready\n\[error\] mine failed/);
  assert.doesNotMatch(def, /awwwards|VIDEOJS|reading 'style'/);
  assert.match(def, /另有 2 条来自之前的页面 \/ 标签，没列出；要看传 filter:"all"/);

  const errs = say(await runBrowserAction('k', { action: 'console', errors_only: true }, null, { pool }));
  assert.match(errs, /\[error\] mine failed/);
  assert.match(errs, /另有 1 条来自之前的页面/, '个数也按同样的过滤算');

  const all = say(await runBrowserAction('k', { action: 'console', filter: 'all' }, null, { pool }));
  assert.match(all, /\[error\] Uncaught TypeError.*← 之前的页面 https:\/\/www\.awwwards\.com\//);
  assert.match(all, /\[console\.log\] todo ready$/m, '当前文档的不带标注');
  assert.doesNotMatch(all, /另有/);

  // 当前文档还没有日志
  handlePageMessage(s, JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'f1', url: 'file:///demo/index.html' } } }));
  assert.match(say(await runBrowserAction('k', { action: 'console' }, null, { pool })), /^\(当前页面的 console 为空\)\n（另有 4 条来自之前的页面/);
});

// 给不经 MCP 的调用方（dimensio 的内部接口）的可选能力：structured 的 data、tab_switch / tab_close 缺省当前、截图的等待与元素截图。
// 不传这些 opts 的调用方（Claude / Codex）结果形状不变。
test('structured：eval 的值类型与异常类别挂在 data 上；不传 structured 时结果里没有 data', async () => {
  let script = () => true;
  const pool = stubPool(() => fakeBrowser({ async eval(js) { return script(js); } }));
  await runBrowserAction('k', { action: 'navigate', url: 'https://example.com' }, null, { pool });
  const plain = await runBrowserAction('k', { action: 'eval', js: 'true' }, null, { pool });
  assert.equal('data' in plain, false, 'MCP 通道的结果形状不变');
  const yes = await runBrowserAction('k', { action: 'eval', js: 'true' }, null, { pool, structured: true });
  assert.deepEqual(yes.data, { eval: { threw: false, type: 'boolean', value: true } });
  script = () => ({ a: 1 });
  assert.deepEqual((await runBrowserAction('k', { action: 'eval', js: 'x' }, null, { pool, structured: true })).data, { eval: { threw: false, type: 'object' } });
  script = () => { throw new Error('Error: count was 3'); };
  const threw = await runBrowserAction('k', { action: 'eval', js: 'x' }, null, { pool, structured: true });
  assert.equal(threw.isError, true);
  assert.deepEqual(threw.data, { eval: { threw: true, exception: 'Error' } });
  script = () => { throw new Error('SyntaxError: Unexpected token'); };
  assert.equal((await runBrowserAction('k', { action: 'eval', js: 'x' }, null, { pool, structured: true })).data.eval.exception, 'SyntaxError');
  script = () => { throw new Error('eval 30 秒没有返回，已终止。'); };
  assert.equal((await runBrowserAction('k', { action: 'eval', js: 'x' }, null, { pool, structured: true })).data.eval.exception, '', '超时不是页面的结论');
});

test('urlDenied：eval 前也验当前页，越界先退回空白页、不跑脚本', async () => {
  let ran = 0;
  const pool = stubPool(() => fakeBrowser({ async eval() { ran++; return 1; } }));
  await runBrowserAction('k', { action: 'navigate', url: 'https://example.com' }, null, { pool });
  pool.existingBrowser('k').url = 'file:///C:/secret.txt';   // 页面自己跳过去的
  const urlDenied = async (u) => (/^file:/.test(u) ? '只能打开你自己工作空间里的文件' : null);
  const r = await runBrowserAction('k', { action: 'eval', js: 'document.body.innerText' }, null, { pool, urlDenied });
  assert.equal(r.isError, true);
  assert.match(say(r), /不允许的地址/);
  assert.equal(ran, 0);
  assert.equal(pool.existingBrowser('k').url, 'about:blank');
});

test('tab_switch 是 tab_select 的别名；tab_close 不给 tab：缺省报错，tabCloseCurrent 时关当前', async () => {
  const two = () => fakeBrowser({
    tabs: [{ id: 't1', url: 'https://a/', title: 'A', active: false }, { id: 't2', url: 'https://b/', title: 'B', active: true }],
    async activateTab(id) { for (const t of this.tabs) t.active = t.id === id; },
  });
  const pool = stubPool(two);
  await runBrowserAction('k', { action: 'navigate', url: 'https://b/' }, null, { pool });
  const sw = await runBrowserAction('k', { action: 'tab_switch', tab: 1 }, null, { pool });
  assert.equal(sw.isError, undefined, say(sw));
  assert.equal(pool.existingBrowser('k').tabs[0].active, true);
  const noTab = await runBrowserAction('k', { action: 'tab_close' }, null, { pool });
  assert.equal(noTab.isError, true, 'Claude / Codex：不给 tab 仍是报错');
  const cur = await runBrowserAction('k', { action: 'tab_close' }, null, { pool, tabCloseCurrent: true });
  assert.equal(cur.isError, undefined, say(cur));
  assert.deepEqual(pool.existingBrowser('k').tabs.map((t) => t.id), ['t2'], '关掉的是当前那个（t1）');
});

test('network structured：列表那几条带 id / 状态挂在 data 上（取响应体时不挂）', async () => {
  const net = [
    { id: '1', url: 'https://x/api/a', method: 'GET', status: 200, state: 'done', mime: 'application/json', size: 10, t: 1 },
    { id: '2', url: 'https://x/api/b', method: 'POST', status: 500, state: 'done', mime: 'application/json', size: 10, t: 2 },
    { id: '3', url: 'https://x/app.js', method: 'GET', status: null, state: 'failed', error: 'net::ERR', size: 0, t: 3 },
  ];
  const pool = stubPool(() => fakeBrowser({ networkEntries: () => net }));
  await runBrowserAction('k', { action: 'navigate', url: 'https://x/' }, null, { pool });
  const r = await runBrowserAction('k', { action: 'network', query: '/api' }, null, { pool, structured: true });
  assert.deepEqual(r.data.network.map((e) => [e.id, e.status, e.state]), [['1', 200, 'done'], ['2', 500, 'done']]);
  const all = await runBrowserAction('k', { action: 'network' }, null, { pool, structured: true });
  assert.deepEqual(all.data.network.at(-1), { id: '3', url: 'https://x/app.js', method: 'GET', status: null, state: 'failed', error: 'net::ERR' });
});

test('screenshot：settle 先等动画、wait_ms:0 立刻截；element_ref / element_selector 只截那个元素', async () => {
  const calls = [];
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000002000000020806000000', 'hex');
  const pool = stubPool(() => fakeBrowser({
    async settleAnimations() { calls.push('settle'); return { waitedMs: 120, stillRunning: 0 }; },
    async elementShot(t) { calls.push(['element', t]); return { buf: png, element: { css: [1, 2, 30, 40], clamped: false, width: 30, height: 40 } }; },
    async screenshot() { calls.push('full'); return { buf: png, frame: { imgW: 1280, imgH: 900, k: 1 } }; },
    measured: null,
  }));
  await runBrowserAction('k', { action: 'navigate', url: 'https://x/' }, null, { pool });
  const plain = await runBrowserAction('k', { action: 'screenshot' }, null, { pool });
  assert.deepEqual(calls, ['full'], '不带新参数：和以前一样立刻整屏截');
  assert.equal(plain.content[0].type, 'image');
  calls.length = 0;
  const settled = await runBrowserAction('k', { action: 'screenshot', settle: true }, null, { pool, structured: true });
  assert.deepEqual(calls, ['settle', 'full']);
  assert.deepEqual(settled.data, { settle: { waitedMs: 120, stillRunning: 0 } });
  calls.length = 0;
  await runBrowserAction('k', { action: 'screenshot', settle: true, wait_ms: 0 }, null, { pool });
  assert.deepEqual(calls, ['full'], 'wait_ms:0 = 就要这一帧');
  calls.length = 0;
  const el = await runBrowserAction('k', { action: 'screenshot', element_ref: 3, settle: true }, null, { pool, structured: true });
  assert.deepEqual(calls, ['settle', ['element', { ref: 3 }]]);
  assert.equal(el.content[0].type, 'image');
  assert.match(say(el), /ref3 的截图 30×40/);
  assert.deepEqual(el.data.element.css, [1, 2, 30, 40]);
  calls.length = 0;
  await runBrowserAction('k', { action: 'screenshot', element_selector: '.card' }, null, { pool });
  assert.deepEqual(calls, [['element', { selector: '.card' }]]);
});

test('dprprobe 判定：停手后还在长、超 Chromium 上限、比值乘了不止一次、页面高度失控；健康的放行', async () => {
  const { judgeCanvasProbe } = await import('./browser-dprprobe.mjs');
  const c = (id, attrW, attrH, rectW = 400, rectH = 300) => ({ id, attrW, attrH, rectW, rectH });
  assert.deepEqual(judgeCanvasProbe({ docH: 2000, canvases: [c('a', 800, 600)] }, { docH: 2000, canvases: [c('a', 800, 600)] }, 2), { passed: true, problems: [] });
  assert.match(judgeCanvasProbe({ docH: 2000, canvases: [c('a', 800, 600)] }, { docH: 2000, canvases: [c('a', 1600, 1200)] }, 2).problems[0], /grew with NO input/);
  assert.match(judgeCanvasProbe({ docH: 0, canvases: [] }, { docH: 2000, canvases: [c('a', 40000, 10)] }, 2).problems[0], /exceeds Chromium's limit/);
  assert.match(judgeCanvasProbe({ docH: 0, canvases: [] }, { docH: 2000, canvases: [c('a', 9000, 9000, 1000, 1000)] }, 2).problems[0], /applied more than once/);
  assert.match(judgeCanvasProbe({ docH: 2000, canvases: [] }, { docH: 3_000_000, canvases: [] }, 2).problems[0], /runaway/);
  const pool = stubPool(() => fakeBrowser({ webBridge: { connected: true } }), { webBridge: true });
  await runBrowserAction('k', { action: 'navigate', url: 'https://x/' }, null, { pool });
  assert.match(say(await runBrowserAction('k', { action: 'dprprobe' }, null, { pool })), /用户自己的浏览器/);
  const own = stubPool(() => fakeBrowser());
  await runBrowserAction('k', { action: 'navigate', url: 'https://x/' }, null, { pool: own });
  assert.match(say(await runBrowserAction('k', { action: 'dprprobe', dpr: 1 }, null, { pool: own })), /dpr 要大于 1/);
});
