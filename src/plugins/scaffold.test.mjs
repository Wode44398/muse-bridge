// 插件骨架生成（src/plugins/scaffold.mjs）与 agent 操作 plugins.scaffold：最小骨架、带面板、从示例起步（id 替换）、各种拒绝；
// 建好经 plugins.scaffold 直接登记后能真正启用（路由、Claude 工具、agent 操作、状态块都挂上）。
// 应用模板（TEMPLATES：app-page / app-view / app-chat）：生成的清单体检干净、图标与英文词条齐；与 from / panel 互斥；声明式模板登记后真能出界面、按动作。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-scaffold-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { scaffoldPlugin, EXAMPLES, EXAMPLES_DIR, TEMPLATES } = await import('./scaffold.mjs');
const { readPluginDir, normUi, inspectManifest } = await import('./discover.mjs');
const { viewApp, runUi, findApp } = await import('./ui.mjs');
const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { createRouter } = await import('../runtime/router.mjs');
const { callOp } = await import('../agent-api/registry.mjs');
const { contextFor } = await import('../runtime/identity.mjs');
const { installCoreResolver } = await import('../modules/core-resolve.mjs');
await import('../agent-api/ops/index.mjs');
installCoreResolver();
installMixins();
const router = createRouter();
kernel.provide('router', router);
kernel.provide('auth', { identify: () => ({ kind: 'admin', user: null }), authOk: () => true });

test.before(async () => { await kernel.start(); });
test.after(async () => { await kernel.stop(); });
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const json = (f) => JSON.parse(readFileSync(f, 'utf8'));

// 在假 DOM 里跑 app-chat 模板的页面脚本：会话记在 kv、history 回给定消息，订阅后按顺序推 replay 事件，回对话区里各条「角色:文字」
async function runChatPage(html, { history, replay }) {
  class El {
    constructor() { this.children = []; this.parent = null; this.className = ''; this.textContent = ''; this.hidden = true; this.value = ''; }
    append(...cs) { for (const c of cs) { c.parent = this; this.children.push(c); } }
    remove() { if (this.parent) { const a = this.parent.children; a.splice(a.indexOf(this), 1); this.parent = null; } }
    get nextSibling() { const a = this.parent?.children; return a ? a[a.indexOf(this) + 1] || null : null; }
    querySelectorAll(sel) { const want = sel.split('.').filter(Boolean); return this.children.filter((c) => want.every((k) => c.className.split(' ').includes(k))); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    set innerHTML(_) { this.children = []; }
  }
  const els = new Map();
  const document = { getElementById: (id) => els.get(id) || els.set(id, new El()).get(id), createElement: () => new El() };
  let onEv = null;
  const bridge = {
    ready: async () => {}, can: () => true, toast: () => {},
    kv: { get: async () => 'S1', set: async () => {} },
    chat: { history: async () => ({ messages: history }), on: (_sid, cb) => { onEv = cb; return () => {}; } },
  };
  const code = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*$/m, '');
  await new (Object.getPrototypeOf(async () => {}).constructor)('bridge', 'document', code)(bridge, document);
  for (const ev of replay) onEv(ev);
  return document.getElementById('log').children.filter((d) => d.body).map((d) => d.className.replace('msg ', '') + ':' + d.body.textContent);
}

test('最小骨架：清单合法、文件齐；panel 再带控制面板页面', () => {
  const a = scaffoldPlugin({ id: 'weather', dir: path.join(tmp, 'a'), name: '天气' });
  assert.deepEqual(a.files, ['README.md', 'bridge-plugin.json', 'index.mjs']);
  const { manifest } = readPluginDir(a.dir);
  assert.equal(manifest.id, 'weather');
  assert.equal(manifest.name, '天气');
  assert.equal(manifest.ui, undefined);
  const b = scaffoldPlugin({ id: 'my-panel', dir: path.join(tmp, 'b'), panel: true });
  assert.ok(b.files.includes('web/index.html'));
  assert.equal(normUi(json(path.join(b.dir, 'bridge-plugin.json'))).panel.page, 'web/index.html');
  assert.match(readFileSync(path.join(b.dir, 'web', 'index.html'), 'utf8'), /\/plugins\/_sdk\/bridge-plugin\.js/);
});

test('从示例起步：整个拷过来，示例 id（含下划线形式）换成新 id，示例本身不动', () => {
  assert.deepEqual(Object.keys(EXAMPLES).sort(), ['hello-app', 'hello-view', 'hello-world', 'power-tools', 'qq-onebot']);
  const h = scaffoldPlugin({ id: 'greeter', dir: path.join(tmp, 'h'), from: 'hello-world' });
  const idx = readFileSync(path.join(h.dir, 'index.mjs'), 'utf8');
  assert.match(idx, /\/api\/plugin\/greeter\/greet/);
  assert.doesNotMatch(idx, /hello-world|hello_world/);
  assert.equal(json(path.join(h.dir, 'bridge-plugin.json')).id, 'greeter');
  assert.equal(json(path.join(h.dir, 'bridge-plugin.json')).name, 'greeter');
  assert.match(readFileSync(path.join(h.dir, 'web', 'index.html'), 'utf8'), /\/plugins\/_sdk\/bridge-plugin\.js/);
  assert.equal(json(path.join(EXAMPLES_DIR, 'hello-world', 'bridge-plugin.json')).id, 'hello-world');
  const q = scaffoldPlugin({ id: 'wx-bot', dir: path.join(tmp, 'q'), from: 'qq-onebot', name: '微信机器人', description: '把微信接到 Claude' });
  const qm = json(path.join(q.dir, 'bridge-plugin.json'));
  assert.equal(qm.id, 'wx-bot');
  assert.equal(qm.name, '微信机器人');
  assert.equal(qm.description, '把微信接到 Claude');
  readPluginDir(q.dir);
  // 纯页面插件示例：没有 index.mjs 也读得出来，应用与两枚图标跟着拷过去
  const a = scaffoldPlugin({ id: 'my-app', dir: path.join(tmp, 'app'), from: 'hello-app' });
  assert.equal(a.files.includes('index.mjs'), false);
  const ra = readPluginDir(a.dir);
  assert.equal(ra.entryPath, null);
  assert.equal(ra.manifest.id, 'my-app');
  const apps = normUi(ra.manifest, a.dir).apps;
  assert.deepEqual(apps.map((x) => [x.id, x.page, x.who]), [['hello', 'web/app.html', 'members']]);
  assert.deepEqual(apps[0].icon, { light: 'web/icon-light.svg', dark: 'web/icon-dark.svg' });
  assert.match(readFileSync(path.join(a.dir, 'README.md'), 'utf8'), /my-app:hello/);
});

test('拒绝：坏 id、相对路径、非空目录、没有的示例', () => {
  assert.throws(() => scaffoldPlugin({ id: 'Bad_Id', dir: path.join(tmp, 'x') }), /id 不合法/);
  assert.throws(() => scaffoldPlugin({ id: 'ok', dir: 'rel/dir' }), /绝对路径/);
  const d = path.join(tmp, 'busy');
  mkdirSync(d, { recursive: true });
  writeFileSync(path.join(d, 'keep.txt'), 'x');
  assert.throws(() => scaffoldPlugin({ id: 'ok', dir: d }), /不是空的/);
  assert.equal(readFileSync(path.join(d, 'keep.txt'), 'utf8'), 'x');
  assert.throws(() => scaffoldPlugin({ id: 'ok', dir: path.join(tmp, 'y'), from: 'nope' }), /没有示例/);
  assert.equal(existsSync(path.join(tmp, 'y')), false);
});

test('agent 操作 plugins.scaffold：缺省建在工作空间 plugins-dev/<id>/ 并登记启用，路由、Claude 工具、agent 操作、状态块都挂上', async () => {
  const host = contextFor({ kind: 'admin' });
  const r = await callOp(host, 'plugins.scaffold', { id: 'demo-tool', panel: true, name: '演示' });
  assert.equal(r.dir, path.join(host.cwd, 'plugins-dev', 'demo-tool'));
  assert.equal(r.linked, true);
  assert.equal(r.plugin.status, 'active', r.plugin.error || '');
  assert.equal(r.plugin.name, '演示');
  assert.ok(router.has('GET', '/api/plugin/demo-tool/hello'));
  assert.ok(r.plugin.hasPage);
  const st = await callOp(host, 'plugins.status', { id: 'demo-tool' });
  assert.equal(st.status.text, '运行中');
  const op = await callOp(host, 'demo_tool.status', {});
  assert.equal(op.message, '你好');
  // 再建同名目录：拒
  await assert.rejects(() => callOp(host, 'plugins.scaffold', { id: 'demo-tool' }), /不是空的/);
  // 成员不能建
  const member = contextFor({ kind: 'user', user: 'm1', name: 'm1', tier: 'user', agents: ['claude'] });
  await assert.rejects(() => callOp(member, 'plugins.scaffold', { id: 'nope' }));
  // link:false 只建不登记
  const r2 = await callOp(host, 'plugins.scaffold', { id: 'later', link: false });
  assert.equal(r2.linked, false);
  assert.equal(kernel.has('later'), false);
});

test('应用模板：三个模板各自生成齐全（图标、locales/en.json、README），清单体检干净；标题用 name、应用 id 固定为 main', async () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), ['app-chat', 'app-page', 'app-view']);
  const lintOf = (dir) => {
    const { manifest } = readPluginDir(dir);
    const ins = inspectManifest(manifest, dir, 'local');
    const ui = normUi(manifest, dir, ins.lint);
    return { manifest, ui, lint: ins.lint, en: ins.i18n.en };
  };
  const pg = scaffoldPlugin({ id: 'my-page', dir: path.join(tmp, 't-page'), template: 'app-page', name: '我的页面' });
  assert.deepEqual(pg.files, ['README.md', 'bridge-plugin.json', 'locales/en.json', 'web/app.html', 'web/icon-dark.svg', 'web/icon-light.svg']);
  const a = lintOf(pg.dir);
  assert.deepEqual(a.lint, []);
  assert.equal(readPluginDir(pg.dir).entryPath, null, '页面应用是纯页面插件');
  assert.equal(a.manifest.name, '我的页面');
  assert.deepEqual(a.ui.apps.map((x) => [x.id, x.title, x.page, x.who]), [['main', '我的页面', 'web/app.html', 'host']]);
  assert.deepEqual(a.ui.apps[0].icon, { light: 'web/icon-light.svg', dark: 'web/icon-dark.svg' });
  assert.equal(a.en.ui.app.main.title, 'My page');
  assert.match(readFileSync(path.join(pg.dir, 'web', 'app.html'), 'utf8'), /<title>我的页面<\/title>[\s\S]*\/plugins\/_sdk\/bridge-plugin\.js/);
  assert.match(readFileSync(path.join(pg.dir, 'README.md'), 'utf8'), /my-page:main/);

  const ch = scaffoldPlugin({ id: 'my-chat', dir: path.join(tmp, 't-chat'), template: 'app-chat', description: '聊天' });
  const c = lintOf(ch.dir);
  assert.deepEqual(c.lint, []);
  assert.deepEqual(c.manifest.permissions, ['ui', 'page.chat']);
  assert.equal(c.manifest.name, 'my-chat', '没给 name：显示名用 id');
  assert.equal(c.manifest.description, '聊天');
  assert.equal(c.ui.apps[0].title, 'my-chat');
  const chatHtml = readFileSync(path.join(ch.dir, 'web', 'app.html'), 'utf8');
  for (const fn of ['start', 'send', 'on', 'stop', 'history']) assert.ok(chatHtml.includes('bridge.chat.' + fn + '('), fn);
  // 刷新页面接着聊：历史里已有正在跑的那一轮，订阅一连上服务端又补发它（turn + 已有增量），不能画两遍
  const log = await runChatPage(chatHtml, {
    history: [{ role: 'user', text: '早' }, { role: 'assistant', text: '早上好' }, { role: 'user', text: '问' }, { role: 'assistant', text: '半截' }],
    replay: [{ type: 'turn', userText: '问' }, { type: 'text', text: '半截' }],
  });
  assert.deepEqual(log, ['user:早', 'assistant:早上好', 'user:问', 'assistant:半截']);

  const vw = scaffoldPlugin({ id: 'my-view', dir: path.join(tmp, 't-view'), template: 'app-view', name: '待办 <b>' });
  assert.deepEqual(vw.files, ['README.md', 'bridge-plugin.json', 'index.mjs', 'locales/en.json', 'web/icon-dark.svg', 'web/icon-light.svg']);
  const v = lintOf(vw.dir);
  assert.deepEqual(v.lint, []);
  assert.deepEqual(v.ui.apps, [], '声明式应用在 index.mjs 里登记，清单里没有');
  const idx = readFileSync(path.join(vw.dir, 'index.mjs'), 'utf8');
  assert.match(idx, /title: "待办 <b>"/, '标题按 JS 字符串写进去');
  assert.match(idx, /ctx\.ui\.app\(/);
  assert.doesNotMatch(idx, /__[A-Z_]+__/, '占位都替换掉了');
  for (const f of vw.files) assert.doesNotMatch(readFileSync(path.join(vw.dir, f), 'utf8'), /__(ID|TITLE[A-Z_]*)__/, f);
});

test('应用模板拒绝：与 from / panel 一起给、没有的模板、标题撞 bridge 自带入口；拒了不动盘。basic = 最小骨架', () => {
  const d = (n) => path.join(tmp, 'tr-' + n);
  assert.throws(() => scaffoldPlugin({ id: 'x1', dir: d(1), template: 'app-view', from: 'hello-app' }), /template 和 from 只给一个/);
  assert.throws(() => scaffoldPlugin({ id: 'x2', dir: d(2), template: 'app-page', panel: true }), /panel 只给 basic/);
  assert.throws(() => scaffoldPlugin({ id: 'x3', dir: d(3), template: 'nope' }), /没有模板「nope」/);
  assert.throws(() => scaffoldPlugin({ id: 'x4', dir: d(4), template: 'app-page', name: 'Claude' }), /和 bridge 自带的入口重名/);
  for (const i of [1, 2, 3, 4]) assert.equal(existsSync(d(i)), false);
  const b = scaffoldPlugin({ id: 'x5', dir: d(5), template: 'basic' });
  assert.deepEqual(b.files, ['README.md', 'bridge-plugin.json', 'index.mjs']);
});

test('示例 hello-view：拷过来 id 换掉，登记后声明式应用真能出界面', async () => {
  const r = scaffoldPlugin({ id: 'my-ledger', dir: path.join(tmp, 'hv'), from: 'hello-view' });
  assert.ok(r.files.includes('index.mjs') && r.files.includes('web/icon-light.svg') && r.files.includes('locales/en.json'));
  const host = contextFor({ kind: 'admin' });
  const op = await callOp(host, 'plugins.link', { path: r.dir });
  assert.ok(op);
  assert.equal(kernel.isActive('my-ledger'), true, kernel.get('my-ledger')?.error || '');
  assert.deepEqual(kernel.get('my-ledger').extra.lint || [], []);
  const app = findApp(host, 'my-ledger', 'ledger');
  assert.equal(app.kind, 'view');
  const v = await viewApp(host, { plugin: 'my-ledger', id: 'ledger' });
  assert.deepEqual(v.state, { tab: 'overview' });
  assert.equal(v.tree[0].type, 'tabs');
  assert.equal(v.tree[1].type, 'empty', '还没记账：概览是空状态');
  const added = await runUi(host, { plugin: 'my-ledger', kind: 'app', id: 'ledger', args: { action: 'add', args: { values: { amount: 12.5, cat: '交通' } }, state: { tab: 'add' } } });
  assert.match(added.toast, /交通 12\.50/);
  assert.deepEqual(added.state, { tab: 'overview' });
  assert.deepEqual(added.tree.map((b) => b.type), ['tabs', 'stat', 'chart', 'section']);
  assert.equal(added.tree[1].items[0].value, '12.50');
  const list = await runUi(host, { plugin: 'my-ledger', kind: 'app', id: 'ledger', args: { action: 'tab', args: { tab: 'list' }, state: added.state } });
  assert.equal(list.tree[1].type, 'list');
  assert.equal(list.tree[1].items.length, 1);
  assert.equal(list.tree[1].items[0].trailing.action.name, 'remove');
  const add = await runUi(host, { plugin: 'my-ledger', kind: 'app', id: 'ledger', args: { action: 'tab', args: { tab: 'add' }, state: list.state } });
  const form = add.tree[1].children[0];
  assert.equal(form.type, 'form');
  assert.deepEqual(Object.keys(form.fields), ['amount', 'cat', 'note']);
  assert.deepEqual(form.cancel, { label: '清空' });
});

test('plugins.scaffold 的 template：建好登记，回 app 键与下一步；与 from 一起给是 bad_args；声明式模板登记后能出界面、能按动作', async () => {
  const host = contextFor({ kind: 'admin' });
  const r = await callOp(host, 'plugins.scaffold', { id: 'todo-app', template: 'app-view', name: '待办' });
  assert.equal(r.linked, true);
  assert.equal(r.plugin.status, 'active', r.plugin.error || '');
  assert.equal(r.app, 'todo-app:main');
  assert.match(r.next, /plugins\.reload[\s\S]*ui\.open[\s\S]*todo-app:main/);
  // 自测地址：本机监听地址，next 里给的是主页（服务端认 / 与 /app，不认 /app/）
  assert.match(r.local, /^http:\/\/[^/]+:\d+$/);
  assert.ok(r.next.includes(r.local + '/（'), '自测指引给的是 <local>/');
  assert.ok(!r.next.includes('/app/'), '不能给 /app/（服务端回 404）');
  const v = await viewApp(host, { plugin: 'todo-app', id: 'main' });
  assert.deepEqual(v.state, { tab: 'open' });
  assert.deepEqual(v.tree.map((b) => b.type), ['stat', 'tabs', 'list', 'form', 'button']);
  const added = await runUi(host, { plugin: 'todo-app', kind: 'app', id: 'main', args: { action: 'add', args: { values: { text: '买牛奶' } }, state: v.state } });
  assert.equal(added.toast, '已添加');
  assert.equal(added.tree[2].items[0].title, '买牛奶');
  assert.equal(added.tree[0].items[0].value, '1');

  const p = await callOp(host, 'plugins.scaffold', { id: 'page-app', template: 'app-page', link: false });
  assert.equal(p.linked, false);
  assert.equal(p.app, 'page-app:main');
  assert.match(p.next, /plugins\.link[\s\S]*plugins\.reload/);
  await assert.rejects(() => callOp(host, 'plugins.scaffold', { id: 'both', template: 'app-page', from: 'hello-app' }), /template 和 from 只给一个/);
  const basic = await callOp(host, 'plugins.scaffold', { id: 'plain-one', template: 'basic', link: false });
  assert.equal(basic.app, undefined);
});
