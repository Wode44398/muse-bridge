// 插件应用（服务端）：清单 ui.apps 与 ctx.ui.app 的规范化（同一套 app-spec.mjs）、纯页面插件（没有 index.mjs）的登记启用、
// /api/plugins/ui 的 apps（清单 + 动态合并、动态盖清单、按身份过滤、角标 3 秒封顶、英文标题、图标地址）、findApp、
// 应用票据（which:'app'；身份解不出时一律 403）与 resolveTicketInfo、svg 带光秃秃的 sandbox、登记变化推 plugins.ui。
// 起一个真 HTTP 服务走签票与静态文件；测试账号建在临时目录（BRIDGE_USERS_ROOT），不碰真账号库。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-apps-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
mkdirSync(process.env.VAULT_PATH, { recursive: true });

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { normUi, readPluginDir, linkLocal } = await import('./discover.mjs');
const { FALLBACK_ICON } = await import('./app-spec.mjs');
const { uiView, findApp, watchUi, UI_SLOT } = await import('./ui.mjs');
const { pluginLogs } = await import('./logs.mjs');
const { EXAMPLES_DIR } = await import('./scaffold.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { registerPluginRoutes } = await import('../routes/plugins.mjs');
const { mintTicket, resolveTicket, resolveTicketInfo } = await import('./tickets.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');
const users = await import('../users.mjs');
const { userIdentity } = await import('../runtime/identity.mjs');

installMixins();
const router = createRouter();
let memberIdentity = null;
// 测试身份：x-test 头 admin / member（账号库里真有）/ ghost（账号库里没有：identityOfCtx 解出 null）/ 无
const identify = (req) => {
  const k = req.headers['x-test'];
  if (k === 'admin') return { kind: 'admin', user: null };
  if (k === 'member') return memberIdentity;
  if (k === 'ghost') return { kind: 'user', user: 'ghost1', name: 'ghost1', tier: 'user', agents: ['claude'] };
  return { kind: 'none', user: null };
};
kernel.provide('router', router);
kernel.provide('auth', { identify, authOk: () => false });
registerPluginRoutes(router, { identify });
const server = http.createServer((req, res) => router.dispatch(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;

const HOST = { kind: 'admin', sandbox: false, key: 'admin' };
const MEMBER = { kind: 'user', user: 'u1', name: 'alice', key: 'u:u1' };
const GUEST = { kind: 'share', key: 'share:x' };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>';

// 在临时目录里建一个插件目录：files = { 相对路径: 内容 }
function makeDir(name, manifest, files = {}) {
  const d = path.join(tmp, 'src-' + name);
  mkdirSync(path.join(d, 'web'), { recursive: true });
  if (manifest) writeFileSync(path.join(d, 'bridge-plugin.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    writeFileSync(path.join(d, rel), body);
  }
  return d;
}

const DEMO = 'apps-demo';
const demoManifest = {
  id: DEMO, name: '演示应用',
  ui: {
    apps: [
      { id: 'board', title: '看板', page: 'web/board.html', icon: { light: 'web/b-light.svg', dark: 'web/b-dark.svg' }, order: 2 },
      { id: 'notes', title: '笔记', titleEn: 'Notes', page: 'web/notes.html', icon: 'web/my icon.svg', who: 'members', order: 1 },
      { id: 'stale', title: '旧版', page: 'web/old.html', who: 'members', order: 3 },
    ],
  },
};
const demoDir = makeDir('demo', null, {
  'web/board.html': '<!doctype html><p>board</p>', 'web/new.html': '<!doctype html><p>new</p>',
  'web/b-light.svg': SVG, 'web/b-dark.svg': SVG, 'web/my icon.svg': SVG,
});

test.before(async () => {
  await kernel.start();
  const r = await users.createUser('appmember', 'pw-appmember-123', 'user');
  assert.ok(r.ok, r.error);
  memberIdentity = userIdentity(r.id);
  assert.ok(memberIdentity);
  await kernel.register({
    id: DEMO, name: demoManifest.name, source: 'local', dir: demoDir, pluginApi: 3,
    extra: { ui: normUi(demoManifest, demoDir), i18n: { en: { name: 'Apps demo', ui: { app: { board: { title: ' Board ' }, stale: { title: 'Settings' } } } } } },
    load: async () => ({ apply: (ctx) => {
      // 与清单里的 stale 同 id：动态的盖掉清单的
      ctx.ui.app({ id: 'stale', title: '新版', page: 'web/new.html', who: 'members', icon: 'sun', order: 3, badge: 12345 });
      ctx.ui.app({ id: 'inbox', title: '收件箱', page: 'web/inbox.html', who: 'members', order: 5, badge: () => new Promise(() => {}) });
      ctx.ui.app({ id: 'oops', title: '出错', page: 'web/oops.html', order: 6, badge: () => { throw new Error('炸了'); } });
      ctx.ui.app({ id: 'zero', title: '零', page: 'web/zero.html', order: 7, badge: 0 });
      ctx.ui.app({ id: 'mail', title: '邮件', page: 'web/mail.html', order: 8, badge: async (who) => (who.kind === 'admin' ? ' 新\n邮件啊 ' : 3) });
    } }),
  });
  assert.ok(kernel.isActive(DEMO), kernel.get(DEMO)?.error || '');
});
test.after(async () => { server.closeAllConnections?.(); server.close(); await kernel.stop(); });
// 临时数据目录在进程退出时再删：运行中删掉会让文件监视卡住进程（Windows）
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const mine = (list, plugin = DEMO) => list.filter((a) => a.plugin === plugin);
const post = (h, b) => fetch(base + '/api/plugins/ticket', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });

test('清单 ui.apps：合法的规范化；撞保留名 / page 不合法 / id 或标题不对的丢掉并写进体检；图标缺失、超限、格式不对退回内置图标', () => {
  const d = makeDir('norm', null, { 'web/l.svg': SVG, 'web/d.svg': SVG, 'web/big.png': Buffer.alloc(200 * 1024 + 1) });
  const lint = [];
  const apps = normUi({ id: 'n', ui: { apps: [
    { id: 'ok', title: ' 看板 ', titleEn: ' Board ', page: 'web\\board.html', icon: { light: 'web/l.svg', dark: 'web/d.svg' }, who: 'members', order: '3' },
    { id: 'one', title: '单图标', page: 'web/one.html', icon: 'web/l.svg' },
    { id: 'named', title: '内置图标', page: 'web/n.html', icon: 'sun' },
    { id: 'noicon', title: '没图标', page: 'web/x.html' },
    { id: 'missing', title: '缺图标', page: 'web/x.html', icon: { light: 'web/l.svg', dark: 'web/nope.svg' } },
    { id: 'big', title: '大图标', page: 'web/x.html', icon: 'web/big.png' },
    { id: 'gif', title: '动图', page: 'web/x.html', icon: 'web/a.gif' },
    { id: 'claude', title: 'Claude', page: 'web/x.html' },
    { id: 'home', title: ' home ', page: 'web/x.html' },
    { id: 'up', title: '越界', page: 'web/../../x.html' },
    { id: 'q', title: '带参数', page: 'web/a.html?x=1' },
    { id: 'out', title: '不在 web 下', page: 'x.html' },
    { id: 'Bad', title: '坏 id', page: 'web/x.html' },
    { id: 'long', title: '一二三四五六七八九十一二三四五六七八九十一', page: 'web/x.html' },
    { id: 'ok', title: '重复', page: 'web/x.html' },
    { id: 'enres', title: '英文撞名', titleEn: 'Settings', page: 'web/x.html', who: 'everyone' },
  ] } }, d, lint).apps;
  assert.deepEqual(apps.map((a) => a.id), ['ok', 'one', 'named', 'noicon', 'missing', 'big', 'gif', 'enres']);
  assert.deepEqual(apps[0], { id: 'ok', title: '看板', titleEn: 'Board', page: 'web/board.html', icon: { light: 'web/l.svg', dark: 'web/d.svg' }, who: 'members', order: 3 });
  assert.deepEqual(apps[1].icon, { light: 'web/l.svg', dark: 'web/l.svg' }, '只给一个路径：深浅共用');
  assert.equal(apps[1].who, 'host');
  assert.deepEqual(apps[2].icon, { name: 'sun' });
  for (const i of [3, 4, 5, 6]) assert.deepEqual(apps[i].icon, FALLBACK_ICON, apps[i].id);
  assert.equal('titleEn' in apps[7], false, '英文标题撞保留名：不带');
  assert.equal(apps[7].who, 'host');
  const has = (re) => lint.some((l) => re.test(l));
  assert.ok(has(/图标文件 web\/nope\.svg 不存在，用了默认图标/));
  assert.ok(has(/图标文件 web\/big\.png 超过 200 KB/));
  assert.ok(has(/「web\/a\.gif」要是插件 web\/ 下的 svg \/ png \/ webp/));
  assert.ok(has(/标题「Claude」和 bridge 自带的入口重名.*没登记/));
  assert.ok(has(/标题「home」和 bridge 自带的入口重名/), '保留名不分大小写、去掉首尾空白');
  assert.equal(lint.filter((l) => /page 要是插件 web\/ 下的页面.*没登记/.test(l)).length, 3);
  assert.ok(has(/应用 id「Bad」不对/));
  assert.ok(has(/应用「long」的标题要 1～20 字/));
  assert.ok(has(/应用 id「ok」重复/));
  assert.ok(has(/英文标题「Settings」/));
  assert.ok(has(/who 只能是 host \/ members/));
  assert.equal(has(/noicon/), false, '没给图标不算问题');

  // 超过 8 个：只收前 8 个，其余写进体检
  const many = [];
  const nine = normUi({ id: 'n', ui: { apps: Array.from({ length: 9 }, (_, i) => ({ id: 'a' + i, title: '应用' + i, page: 'web/a.html' })) } }, null, many).apps;
  assert.deepEqual(nine.map((a) => a.id), ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
  assert.match(many.join('\n'), /最多 8 个应用，「a8」没登记/);
  // 不是列表；没给 dir 不查图标文件（readPluginDir 判「有没有页面」时就是这样）
  const l2 = [];
  assert.deepEqual(normUi({ id: 'n', ui: { apps: { id: 'x' } } }, null, l2).apps, []);
  assert.match(l2.join(''), /ui\.apps 应为应用声明的列表/);
  assert.deepEqual(normUi({ id: 'n', ui: { apps: [{ id: 'x', title: 'X', page: 'web/x.html', icon: 'web/nope.svg' }] } }).apps[0].icon, { light: 'web/nope.svg', dark: 'web/nope.svg' });
  assert.deepEqual(normUi({ id: 'n' }).apps, []);
});

test('纯页面插件：没有 index.mjs 也能登记启用（体检里写着图标问题）；什么页面都没有的拒；明确写了 entry 但文件缺照旧报错', async () => {
  const d = makeDir('page-only', {
    id: 'page-only', name: '纯页面', engines: { pluginApi: 3 },
    ui: { who: 'members', panel: { page: 'web/app.html' }, apps: [{ id: 'main', title: '主应用', page: 'web/app.html', who: 'members', icon: { light: 'web/icon.svg', dark: 'web/missing.svg' } }] },
  }, { 'web/app.html': '<!doctype html><p>app</p>', 'web/icon.svg': SVG });
  assert.equal(readPluginDir(d).entryPath, null);
  await linkLocal(kernel, d);
  assert.equal(kernel.isActive('page-only'), true, kernel.get('page-only')?.error || '');
  const p = kernel.get('page-only');
  assert.deepEqual(p.extra.ui.apps[0].icon, FALLBACK_ICON);
  assert.ok(p.extra.lint.some((l) => /图标文件 web\/missing\.svg 不存在/.test(l)), p.extra.lint.join('\n'));
  assert.deepEqual(findApp(MEMBER, 'page-only', 'main'), { plugin: 'page-only', id: 'main', kind: 'page', page: 'web/app.html', title: '主应用', who: 'members' });

  const empty = makeDir('empty', { id: 'empty', engines: { pluginApi: 3 }, ui: { apps: [{ id: 'x', title: 'Claude', page: 'web/x.html' }] } });
  assert.throws(() => readPluginDir(empty), /既没有入口文件也没有页面/, '应用全被丢掉也算没有页面');
  await assert.rejects(linkLocal(kernel, empty), /既没有入口文件也没有页面/);
  const named = makeDir('named-entry', { id: 'named-entry', entry: 'main.mjs', ui: { apps: [{ id: 'x', title: 'X', page: 'web/x.html' }] } });
  assert.throws(() => readPluginDir(named), /缺入口文件 main\.mjs/);
  assert.equal(kernel.has('empty') || kernel.has('named-entry'), false);

  // 自带的示例 hello-app：登记上来没有应用相关的体检提示，英文界面用 locales/en.json 的标题
  await linkLocal(kernel, path.join(EXAMPLES_DIR, 'hello-app'));
  assert.equal(kernel.isActive('hello-app'), true, kernel.get('hello-app')?.error || '');
  assert.deepEqual(kernel.get('hello-app').extra.lint || [], []);
  assert.equal(findApp(MEMBER, 'hello-app', 'hello').page, 'web/app.html');
});

test('ctx.ui.app 登记校验：标题撞保留名、page / id / who / badge 不对直接抛；图标文件缺失只 warn 并退回内置图标；清单 + 动态合起来最多 8 个', () => {
  const c = kernel.contextOf(DEMO);
  assert.throws(() => c.ui.app('x'), /要一个对象/);
  assert.throws(() => c.ui.app({ id: 'x', title: 'Claude', page: 'web/x.html' }), /ctx\.ui\.app：.*重名/);
  assert.throws(() => c.ui.app({ id: 'x', title: 'X', page: '../x.html' }), /page/);
  assert.throws(() => c.ui.app({ id: 'Bad', title: 'X', page: 'web/x.html' }), /应用 id/);
  assert.throws(() => c.ui.app({ id: 'x', title: '', page: 'web/x.html' }), /标题要/);
  assert.throws(() => c.ui.app({ id: 'x', title: 'X', page: 'web/x.html', who: 'all' }), /who/);
  assert.throws(() => c.ui.app({ id: 'x', title: 'X', page: 'web/x.html', badge: {} }), /badge/);
  const off = c.ui.app({ id: 'pic', title: '缺图', page: 'web/x.html', icon: 'web/nope.svg' });
  const hit = kernel.slot(UI_SLOT).entries().find(({ item, owner }) => owner === DEMO && item.kind === 'app' && item.spec.id === 'pic');
  assert.deepEqual(hit.item.spec.icon, FALLBACK_ICON);
  assert.ok(pluginLogs(DEMO).some((l) => /图标文件 web\/nope\.svg 不存在/.test(l.text)));
  off();
  assert.equal(findApp(HOST, DEMO, 'pic'), null, '撤掉了');
  // 清单 3 个（board / notes / stale）+ 动态（stale 同 id 不另算、inbox / oops / zero / mail）= 7 个不同 id，还能再登记 1 个
  const offs = [c.ui.app({ id: 'eight', title: '第八', page: 'web/8.html' })];
  assert.throws(() => c.ui.app({ id: 'nine', title: '第九', page: 'web/9.html' }), /最多 8 个应用，「nine」登记不了/);
  offs.push(c.ui.app({ id: 'eight', title: '第八 新', page: 'web/8.html' }), c.ui.app({ id: 'board', title: '看板 新', page: 'web/board.html' }));
  assert.equal(findApp(HOST, DEMO, 'eight').title, '第八 新', '同 id 再登记：后登记的赢');
  for (const f of offs) f();
  assert.equal(findApp(HOST, DEMO, 'board').title, '看板', '动态撤掉，清单的又露出来');
});

test('uiView 的 apps：清单 + 动态合并、动态盖清单、按身份过滤、按 order 排；角标现算（截 4 字、0 不显示、卡住 3 秒封顶、出错写日志）；图标地址；英文标题', async () => {
  const t0 = Date.now();
  // 几个视图一起算（每个都要等卡住的那个角标 3 秒）
  const [v, mv, gv, ev] = await Promise.all([uiView(HOST, 'zh'), uiView(MEMBER, 'zh'), uiView(GUEST, 'zh'), uiView(HOST, 'en')]);
  assert.ok(Date.now() - t0 < 5000, '卡住的角标 3 秒封顶');
  const apps = mine(v.apps);
  assert.deepEqual(apps.map((a) => a.id), ['notes', 'board', 'stale', 'inbox', 'oops', 'zero', 'mail']);
  const by = Object.fromEntries(apps.map((a) => [a.id, a]));
  assert.deepEqual(by.board, {
    key: 'app:apps-demo:board', plugin: DEMO, pluginName: '演示应用', id: 'board', title: '看板', kind: 'page', page: 'web/board.html',
    icon: { light: '/plugins/apps-demo/web/b-light.svg', dark: '/plugins/apps-demo/web/b-dark.svg' }, order: 2, badge: '', who: 'host', perms: [],
  });
  assert.deepEqual(by.notes.icon, { light: '/plugins/apps-demo/web/my%20icon.svg', dark: '/plugins/apps-demo/web/my%20icon.svg' }, '路径逐段编码');
  assert.equal(by.stale.title, '新版');
  assert.equal(by.stale.page, 'web/new.html', '动态盖清单');
  assert.deepEqual(by.stale.icon, { name: 'sun' });
  assert.equal(by.stale.badge, '999+', '数字超过三位写成 999+（不截成看着像真数的 1234）');
  assert.equal(by.inbox.badge, '');
  assert.equal(by.oops.badge, '');
  assert.ok(pluginLogs(DEMO).some((l) => /应用角标出错：炸了/.test(l.text)));
  assert.equal(by.zero.badge, '', '0 不显示');
  assert.equal(by.mail.badge, '新 邮件', '函数拿到身份；换行压成空格、去首尾空白再截');
  assert.equal(apps.filter((a) => a.id === 'stale').length, 1, '同 id 只出一个');
  // 成员只看得到 who:members 的；分享访客一个也看不到
  assert.deepEqual(mine(mv.apps).map((a) => [a.id, a.badge]), [['notes', ''], ['stale', '999+'], ['inbox', '']]);
  assert.deepEqual(gv.apps, []);
  // 英文：locales/en.json 的 ui.app.<id>.title 优先（去空白），其次清单 titleEn；en.json 撞保留名的不用；插件名也换英文
  const en = Object.fromEntries(mine(ev.apps).map((a) => [a.id, a]));
  assert.equal(en.board.title, 'Board');
  assert.equal(en.notes.title, 'Notes');
  assert.equal(en.stale.title, '新版');
  assert.equal(en.board.pluginName, 'Apps demo');
  // 自带示例 hello-app：英文标题、插件名来自它的 locales/en.json；图标是 /plugins/<id>/web/… 的绝对地址
  const hello = ev.apps.find((a) => a.key === 'app:hello-app:hello');
  assert.equal(hello.title, 'Hello app');
  assert.equal(hello.pluginName, 'Hello app (example)');
  assert.deepEqual(hello.icon, { light: '/plugins/hello-app/web/icon-light.svg', dark: '/plugins/hello-app/web/icon-dark.svg' });
  // 其它种类的列表里不混进应用
  assert.equal(v.homeCards.length + v.workbench.length + v.commands.length, 0);
});

test('findApp：看得到才给（动态优先）；没有的应用 / 插件、坏 id、没身份都给 null', () => {
  assert.deepEqual(findApp(HOST, DEMO, 'board'), { plugin: DEMO, id: 'board', kind: 'page', page: 'web/board.html', title: '看板', who: 'host' });
  assert.equal(findApp(MEMBER, DEMO, 'board'), null, '成员看不到主机专用的');
  assert.equal(findApp(MEMBER, DEMO, 'stale').page, 'web/new.html');
  assert.equal(findApp(GUEST, DEMO, 'notes'), null);
  assert.equal(findApp(null, DEMO, 'board'), null);
  assert.equal(findApp(HOST, DEMO, 'nope'), null);
  assert.equal(findApp(HOST, DEMO, 'Board'), null);
  assert.equal(findApp(HOST, 'nope', 'board'), null);
});

test('签票 which:\'app\'：看得到的应用签得出（票里带应用 id）；看不到、没有的 403；身份解不出（账号库里没有）时一律 403', async () => {
  const ok = await post({ 'x-test': 'admin' }, { id: DEMO, which: 'app', app: 'board' });
  assert.equal(ok.status, 200);
  const r = await ok.json();
  assert.match(r.ticket, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(r.page, '/plugins/apps-demo/web/board.html');
  assert.deepEqual(resolveTicketInfo(r.ticket, DEMO), { identity: { kind: 'admin', user: null }, app: 'board' });
  assert.equal(resolveTicketInfo(r.ticket, 'page-only'), null, '别的插件不认');
  assert.equal(resolveTicket(r.ticket, DEMO).kind, 'admin');

  const m = await post({ 'x-test': 'member' }, { id: DEMO, which: 'app', app: 'stale' });
  assert.equal(m.status, 200);
  const mr = await m.json();
  assert.equal(mr.page, '/plugins/apps-demo/web/new.html', '动态盖清单，票签给动态的页面');
  const info = resolveTicketInfo(mr.ticket, DEMO);
  assert.equal(info.app, 'stale');
  assert.equal(info.identity.user, memberIdentity.user);

  const deny = await post({ 'x-test': 'member' }, { id: DEMO, which: 'app', app: 'board' });
  assert.equal(deny.status, 403);
  assert.match((await deny.json()).error, /打不开这个应用/);
  assert.equal((await post({ 'x-test': 'admin' }, { id: DEMO, which: 'app', app: 'nope' })).status, 403);
  assert.equal((await post({ 'x-test': 'admin' }, { id: 'nope', which: 'app', app: 'board' })).status, 403);
  assert.equal((await post({ 'x-test': 'admin' }, { id: DEMO, which: 'app' })).status, 403);
  // 账号库里没有的成员：应用、面板都不签（签出来也是张废票）
  assert.equal((await post({ 'x-test': 'ghost' }, { id: DEMO, which: 'app', app: 'stale' })).status, 403);
  const gp = await post({ 'x-test': 'ghost' }, { id: 'page-only' });
  assert.equal(gp.status, 403);
  assert.match((await gp.json()).error, /打不开这个插件的页面/);
  assert.equal((await post({}, { id: DEMO, which: 'app', app: 'stale' })).status, 401);
  // 真成员签面板票：照旧能签，票里不带应用
  const panel = await post({ 'x-test': 'member' }, { id: 'page-only' });
  assert.equal(panel.status, 200);
  const pr = await panel.json();
  assert.equal(pr.page, '/plugins/page-only/web/app.html');
  assert.equal(resolveTicketInfo(pr.ticket, 'page-only').app, null);
  assert.equal(resolveTicketInfo(mintTicket(DEMO, { kind: 'admin', user: null }, { app: '' }).ticket, DEMO).app, null);
});

test('静态文件：svg 带光秃秃的 sandbox（不许跑脚本），html 维持原来的 sandbox allow-scripts…；图标地址（含空格）取得到', async () => {
  const svg = await fetch(base + '/plugins/page-only/web/icon.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.equal(svg.headers.get('content-security-policy'), 'sandbox');
  const html = await fetch(base + '/plugins/page-only/web/app.html');
  assert.match(html.headers.get('content-security-policy') || '', /^sandbox allow-scripts allow-forms/);
  assert.doesNotMatch(html.headers.get('content-security-policy') || '', /allow-same-origin/);
  // uiView 给的图标地址（上面验过逐段编码）原样取得到
  const icon = await fetch(base + '/plugins/apps-demo/web/my%20icon.svg');
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-security-policy'), 'sandbox');
  assert.match(await icon.text(), /<svg/);
});

test('登记变化推 plugins.ui：开 / 关带应用的插件要推（去抖），开个没应用的插件不推', async () => {
  watchUi();
  const seen = [];
  const res = {
    writableEnded: false,
    write(chunk) { const mm = /^data: (.*)\n\n$/s.exec(String(chunk)); if (mm) { const ev = JSON.parse(mm[1]); if (ev.type === 'plugins.ui') seen.push(ev); } return true; },
    end() { this.writableEnded = true; },
  };
  const off = busSubscribe('admin', res);
  const until = async (n, ms = 2000) => { const t0 = Date.now(); while (seen.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); };
  try {
    const d = makeDir('late-app', { id: 'late-app', engines: { pluginApi: 3 }, ui: { apps: [{ id: 'late', title: '后来的', page: 'web/late.html' }] } }, { 'web/late.html': '<p>late</p>' });
    await linkLocal(kernel, d);
    await until(1);
    assert.equal(seen.length, 1, '清单应用不经插槽：靠内核 change 推');
    await kernel.register({ id: 'plain', name: 'plain', source: 'local', dir: tmp, pluginApi: 3, load: async () => ({ apply() {} }) });
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(seen.length, 1, '没应用的插件开关不推');
    await kernel.setEnabled('late-app', false);
    await until(2);
    assert.equal(seen.length, 2);
    // 动态登记经插槽，当场推
    const offApp = kernel.contextOf(DEMO).ui.app({ id: 'quick', title: '快', page: 'web/q.html' });
    assert.equal(seen.length, 3);
    offApp();
  } finally { off(); }
});

test('插件停用：清单应用与动态应用一起消失，签票 403', async () => {
  await kernel.setEnabled(DEMO, false);
  try {
    assert.equal(findApp(HOST, DEMO, 'board'), null);
    assert.equal(findApp(HOST, DEMO, 'stale'), null);
    assert.deepEqual(mine((await uiView(HOST, 'zh')).apps), []);
    assert.equal((await post({ 'x-test': 'admin' }, { id: DEMO, which: 'app', app: 'board' })).status, 403);
    assert.equal((await fetch(base + '/plugins/apps-demo/web/b-light.svg')).status, 404);
  } finally { await kernel.setEnabled(DEMO, true); }
  assert.equal(findApp(HOST, DEMO, 'stale').page, 'web/new.html', '重新开起来，动态应用跟着 apply 回来');
});
