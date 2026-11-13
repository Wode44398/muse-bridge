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
