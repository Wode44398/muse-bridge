// 声明式应用（服务端）：app-spec 的 view / page 二选一与 pin、ui-blocks 的积木规范化（层数 / 总数上限、
// 不认识的丢、截断、图片地址改写、动作引用校验与丢弃策略、chat 要 page.chat）、viewApp 与 runUi kind:'app'
// （初始 state、state 上限、404 / 400、view 出错与超时画错误树并写日志、动作回字符串 / 对象、nav 规范化、动作出错 500 / 超时 504）、
// ctx.ui.refresh 推总线、ctx.ui.fileHandler 校验与 uiView.fileHandlers / findFileHandler、命令 palette、应用 pin / perms / kind、能力名。
// 不起 HTTP 服务：直接调 ui.mjs 的导出；路由（/api/plugins/ui/view）在路由测试里测。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-views-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
mkdirSync(process.env.VAULT_PATH, { recursive: true });
mkdirSync(path.join(tmp, 'pdir', 'web'), { recursive: true });

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { normApp, normApps, STATE_MAX } = await import('./app-spec.mjs');
const { normalizeBlocks, BLOCK_LIMITS, BLOCK_TYPES } = await import('./ui-blocks.mjs');
const { uiView, findApp, findFileHandler, viewApp, runUi, APP_LIMITS } = await import('./ui.mjs');
const { pluginLogs } = await import('./logs.mjs');
const { PLUGIN_FEATURES } = await import('./engines.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');

installMixins();
const HOST = { kind: 'admin', sandbox: false, key: 'admin' };
const MEMBER = { kind: 'user', user: 'u1', name: 'alice', key: 'u:u1' };
const GUEST = { kind: 'share', key: 'share:x' };
const dir = path.join(tmp, 'pdir');
const perms = (...ids) => ids.map((id) => ({ id, label: id }));

async function addPlugin(id, apply, permissions = null) {
  await kernel.register({ id, name: id, source: 'local', dir, pluginApi: 3, extra: { permissions }, load: async () => ({ apply }) });
  assert.ok(kernel.isActive(id), kernel.get(id)?.error || '');
}

const APP = 'view-demo';
let appCtx = null;
const seenWho = [];

test.before(async () => {
  await kernel.start();
  await addPlugin(APP, (ctx) => {
    appCtx = ctx;
    ctx.ui.app({
      id: 'main', title: '计数器', who: 'members', pin: 'sidebar', state: { n: 0 },
      view: (who, { state }) => {
        seenWho.push(who.kind);
        return [
          { type: 'text', text: '计数 ' + state.n },
          { type: 'button', label: '加一', action: 'inc' },
          { type: 'button', label: '没登记的动作', action: 'nope' },
        ];
      },
      actions: {
        inc: (who, { args, state }) => ({ state: { ...state, n: state.n + (Number(args.by) || 1) }, toast: '加好了' }),
        say: () => '只回一句话',
        silent: () => {},
        boom: () => { throw new Error('动作炸了'); },
        slow: () => new Promise(() => {}),
        huge: () => ({ state: { blob: 'x'.repeat(STATE_MAX + 10) } }),
        cyc: () => { const o = {}; o.o = o; return { state: o }; },
        navApp: () => ({ nav: { app: 'other' } }),
        navFull: () => ({ nav: { app: 'some-plugin:board' } }),
        navBack: () => ({ nav: 'back' }),
        navFile: () => ({ nav: { file: { rel: ' notes/a.md ', ws: 'w1' } } }),
        navUrl: () => ({ nav: { url: '//evil.example' } }),
        navJs: () => ({ nav: { url: 'javascript:alert(1)' } }),
        navSession: () => ({ nav: { session: 's-1' } }),
        echo: (who, { args }) => ({ toast: JSON.stringify(args) }),
      },
    });
    ctx.ui.app({ id: 'secret', title: '只给主机', state: {}, view: () => [{ type: 'text', text: '主机的' }], actions: {} });
    // 初始 state 里有 JSON 表达不了的东西：按 JSON 规则登记（函数丢掉、Date 变字符串），不抛 structuredClone 的英文错
    ctx.ui.app({ id: 'odd', title: '怪状态', state: { fmt: () => 1, at: new Date(0) }, view: (who, { state }) => [{ type: 'text', text: typeof state.at + ' ' + ('fmt' in state) }] });
    ctx.ui.app({ id: 'crash', title: '会出错', view: () => { throw new Error('view 炸了'); } });
    ctx.ui.app({ id: 'hang', title: '会卡住', view: () => new Promise(() => {}) });
    ctx.ui.app({ id: 'pg', title: '表格', page: 'web/pg.html', who: 'members' });
    ctx.ui.app({ id: 'pgh', title: '主机表格', page: 'web/pgh.html' });
    ctx.ui.fileHandler({ id: 'csv', title: '表格', exts: ['CSV', '.tsv', 'csv'], app: 'pg', who: 'members' });
    ctx.ui.fileHandler({ id: 'raw', title: '原始', match: { ext: 'bin' }, app: APP + ':pgh', who: 'members' });
    ctx.ui.command({ name: 'pal', description: '在命令面板里', handler: () => 'ok', palette: true });
    ctx.ui.command({ name: 'nopal', description: '不在面板', handler: () => 'ok' });
  }, perms('ui', 'page.files'));
});
test.after(async () => { await kernel.stop(); });
// 临时数据目录在进程退出时再删：运行中删掉会让文件监视卡住进程（Windows）
process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

const run = (c, id, action, extra = {}) => runUi(c, { plugin: APP, kind: 'app', id, args: { action, ...extra } });

test('能力名：声明式应用与插槽的 7 个都登记了', () => {
  for (const f of ['ui.app.view', 'ui.refresh', 'ui.blocks', 'ui.fileHandler', 'ui.command.palette', 'ui.app.pin', 'market.app']) {
    assert.ok(PLUGIN_FEATURES.includes(f), f);
    assert.equal(appCtx.has(f), true, f);
  }
});

test('app-spec：view 与 page 二选一；清单里不许 view；动作名与初始 state 校验；pin 只认 sidebar；页面型的形状不变', () => {
  const v = normApp({ id: 'a', title: '甲', view: () => [] }, { allowView: true });
  assert.equal(v.app.kind, 'view');
  assert.equal(v.app.page, undefined);
  assert.match(normApp({ id: 'a', title: '甲', view: () => [] }).fatal, /清单 ui\.apps 只能声明页面型应用/);
  assert.match(normApp({ id: 'a', title: '甲', view: () => [], page: 'web/a.html' }, { allowView: true }).fatal, /page|view/);
  assert.ok(normApp({ id: 'a', title: '甲', view: 'nope' }, { allowView: true }).fatal);
  assert.ok(normApp({ id: 'a', title: '甲', view: () => [], actions: { 'bad name': () => {} } }, { allowView: true }).fatal);
  assert.ok(normApp({ id: 'a', title: '甲', view: () => [], actions: { ok: 'not fn' } }, { allowView: true }).fatal);
  assert.match(normApp({ id: 'a', title: '甲', view: () => [], state: { s: 'x'.repeat(STATE_MAX) } }, { allowView: true }).fatal, /256/);
  const cyc = {}; cyc.c = cyc;
  assert.ok(normApp({ id: 'a', title: '甲', view: () => [], state: cyc }, { allowView: true }).fatal);
  assert.match(normApp({ id: 'a', title: '甲' }, { allowView: true }).fatal, /或者给 view 函数/);

  const pinned = normApp({ id: 'a', title: '甲', page: 'web/a.html', pin: 'sidebar' });
  assert.equal(pinned.app.pin, 'sidebar');
  const odd = normApp({ id: 'a', title: '甲', page: 'web/a.html', pin: 'dock' });
  assert.equal(odd.app.pin, undefined);
  assert.ok(odd.warn.some((w) => /pin/.test(w)));
  const pg = normApp({ id: 'a', title: '甲', page: 'web/a.html' });
  assert.equal(pg.app.kind, undefined, '页面型的规范化结果不加 kind（清单应用的整形比对不变）');
  assert.equal(pg.app.page, 'web/a.html');
  assert.equal(pg.app.pin, undefined);
  // 清单里写 view 的那条整个丢、记 lint，别的照收
  const lint = [];
  const list = normApps([{ id: 'a', title: '甲', view: 'x' }, { id: 'b', title: '乙', page: 'web/b.html' }], { lint });
  assert.deepEqual(list.map((x) => x.id), ['b']);
  assert.ok(lint.length >= 1);
});

test('积木：不认识的丢、截断、层数与总数上限', () => {
  assert.deepEqual(BLOCK_TYPES.length, 15);
  const out = normalizeBlocks([{ type: 'text', text: '好' }, { type: 'mystery' }, null, 'str', { type: 'divider' }]);
  assert.deepEqual(out, [{ type: 'text', text: '好' }, { type: 'divider' }]);
  assert.deepEqual(normalizeBlocks({ blocks: [{ type: 'divider' }] }), [{ type: 'divider' }]);
  assert.deepEqual(normalizeBlocks({ type: 'divider' }), [{ type: 'divider' }]);
  assert.deepEqual(normalizeBlocks('x'), []);
  assert.equal(normalizeBlocks([{ type: 'text', text: '字'.repeat(5000) }])[0].text.length, 4000);
  // markdown 的 100 KB 是 UTF-8 字节：中文按字符截会放大三倍；截断处不劈字（表情是 4 字节）
  const md = normalizeBlocks([{ type: 'markdown', text: '中'.repeat(60000) }])[0].text;
  assert.equal(Buffer.byteLength(md), 102399);
  assert.equal(md.length, 34133);
  const emo = normalizeBlocks([{ type: 'markdown', text: 'a' + '😀'.repeat(30000) }])[0].text;
  assert.ok(Buffer.byteLength(emo) <= 102400 && !/[\uD800-\uDBFF]$/.test(emo));
  assert.equal(normalizeBlocks([{ type: 'markdown', text: 'x'.repeat(200 * 1024) }])[0].text.length, 102400);
  assert.equal(normalizeBlocks([{ type: 'section', title: '标\n题'.repeat(50) }])[0].title.length, 80);
  // 7 层嵌套：第 6 层的 section 还在，它的孩子丢
  let deep = { type: 'text', text: '最深' };
  for (let i = 0; i < 6; i++) deep = { type: 'section', children: [deep] };
  let cur = normalizeBlocks([deep])[0];
  let depth = 1;
  while (cur.children && cur.children.length) { cur = cur.children[0]; depth++; }
  assert.equal(depth, BLOCK_LIMITS.depth);
  assert.equal(cur.type, 'section');
  // 总数 400 封顶（嵌套的也算）
  const many = Array.from({ length: 300 }, () => ({ type: 'section', children: [{ type: 'divider' }] }));
  let count = 0;
  const walk = (l) => { for (const b of l) { count++; if (b.children) walk(b.children); } };
  walk(normalizeBlocks(many));
  assert.equal(count, BLOCK_LIMITS.total);
});

test('积木：动作引用规范化与丢弃策略', () => {
  const opts = { plugin: 'p', actions: ['go', 'del'] };
  const [b1, ...rest] = normalizeBlocks([
    { type: 'button', label: '走', action: { name: 'go', args: { a: 1 }, confirm: '确定？' } },
    { type: 'button', label: '没登记', action: 'nope' },
    { type: 'button', label: '名字坏', action: '1bad' },
    { type: 'button', label: 'args 太大', action: { name: 'go', args: { s: 'x'.repeat(17 * 1024) } } },
    { type: 'button', label: 'args 是数组', action: { name: 'go', args: [1] } },
  ], opts);
  assert.deepEqual(b1, { type: 'button', label: '走', action: { name: 'go', args: { a: 1 }, confirm: '确定？' } });
  assert.deepEqual(rest, [], '按钮的动作不合格整个丢');
  const [bs] = normalizeBlocks([{ type: 'buttons', items: [{ label: '甲', action: 'go' }, { label: '乙', action: 'x' }] }], opts);
  assert.deepEqual(bs.items.map((x) => x.label), ['甲']);
  assert.deepEqual(normalizeBlocks([{ type: 'buttons', items: [{ label: '乙', action: 'x' }] }], opts), []);
  assert.deepEqual(normalizeBlocks([{ type: 'tabs', action: 'x', items: [{ id: 'a' }] }], opts), [], '标签页动作不合格整个丢');
  const [tabs] = normalizeBlocks([{ type: 'tabs', action: 'go', value: 'zzz', items: [{ id: 'a', label: '甲' }, { id: 'a' }, { id: 'b' }] }], opts);
  assert.deepEqual(tabs, { type: 'tabs', value: 'a', items: [{ id: 'a', label: '甲' }, { id: 'b', label: 'b' }], action: { name: 'go' } });
  assert.deepEqual(normalizeBlocks([{ type: 'form', fields: { a: {} }, submit: { label: '交', action: 'x' } }], opts), [], '表单提交动作不合格整个丢');
  const [list] = normalizeBlocks([{ type: 'list', items: [
    { id: 1, title: '行', action: 'nope', trailing: { type: 'button', label: '删', action: 'del' } },
    { title: '开关', trailing: { type: 'switch', value: true, action: 'go' } },
    { title: '坏尾巴', action: 'go', trailing: { type: 'button', label: '删', action: 'nope' } },
    { desc: '没标题的丢' },
  ] }], opts);
  assert.deepEqual(list.items, [
    { id: 1, title: '行', trailing: { type: 'button', label: '删', action: { name: 'del' } } },
    { title: '开关', trailing: { type: 'switch', value: true, action: { name: 'go' } } },
    { title: '坏尾巴', action: { name: 'go' } },
  ], '行点击 / 行尾动作不合格只去掉动作，行还在');
  const [tb] = normalizeBlocks([{ type: 'table', columns: [{ key: 'a' }], rows: [{ a: 1 }], rowAction: 'nope' }], opts);
  assert.equal(tb.rowAction, undefined);
  // 不给 actions：只查名字格式
  assert.equal(normalizeBlocks([{ type: 'button', label: '甲', action: 'whatever' }]).length, 1);
  assert.equal(normalizeBlocks([{ type: 'button', label: '甲', action: '-bad' }]).length, 0);
});

test('积木：图片地址只认插件 web/ 下的图片；chat 要 page.chat；高度夹住', () => {
  const img = (src) => normalizeBlocks([{ type: 'image', src, height: 9999 }], { plugin: 'p' })[0];
  assert.deepEqual(img('web/a b/图.png'), { type: 'image', src: '/plugins/p/web/a%20b/%E5%9B%BE.png', height: 600 });
  assert.equal(img('./web/x.svg').src, '/plugins/p/web/x.svg');
  for (const bad of ['web/../x.png', 'https://x/y.png', 'web/x.html', 'web\\x.png', 'web//x.png', 'x.png', 'web/x.png?a=1', '/etc/x.png']) {
    assert.equal(img(bad), undefined, bad);
  }
  assert.deepEqual(normalizeBlocks([{ type: 'chat', height: 10 }], { plugin: 'p', perms: ['ui'] }), [
    { type: 'empty', title: '对话积木用不了', desc: '插件要在清单 permissions 里声明 page.chat 才能放对话积木' },
  ]);
  assert.deepEqual(normalizeBlocks([{ type: 'chat', height: 10, session: ' s1 ', onSession: 'bind' }], { plugin: 'p', perms: ['page.chat'], actions: ['bind'] }), [
    { type: 'chat', session: 's1', onSession: 'bind', height: 240 },
  ]);
  assert.equal(normalizeBlocks([{ type: 'chart', height: 1, series: [{ points: [[1, 2]] }] }])[0].height, 120);
});

test('积木：表单、表格、图表的形状', () => {
  const [f] = normalizeBlocks([{
    type: 'form', id: 'bad id!',
    fields: { amount: { type: 'number', min: 0, max: 'x', required: true }, 'bad key': { type: 'string' }, cat: { enum: ['a', 1, {}], widget: 'segmented', junk: 1 }, on: { type: 'boolean', enum: [true] } },
    value: { amount: 3, cat: 'a', other: 1, on: { x: 1 } },
    submit: { label: '交', action: 'go' },
    cancel: { label: '算了', action: 'nope' },
  }]);
  assert.deepEqual(f, {
    type: 'form', id: 'form',
    fields: {
      amount: { type: 'number', label: 'amount', min: 0, required: true },
      cat: { type: 'string', label: 'cat', enum: ['a', '1'], widget: 'segmented' },
      on: { type: 'boolean', label: 'on' },
    },
    value: { amount: 3, cat: 'a' },
    submit: { label: '交', action: { name: 'go' } },
    cancel: { label: '算了', action: { name: 'nope' } },
  });
  const cancelOf = (cancel) => normalizeBlocks([{ type: 'form', fields: { a: {} }, submit: { label: '交', action: 'go' }, cancel }], { actions: ['go'] })[0].cancel;
  assert.deepEqual(cancelOf('清空'), { label: '清空' });
  assert.deepEqual(cancelOf(true), { label: '' });
  assert.deepEqual(cancelOf({ label: '撤', action: 'nope' }), { label: '撤' }, '取消的动作不合格只去掉动作');
  assert.equal(cancelOf(undefined), undefined);
  assert.equal(normalizeBlocks([{ type: 'form', fields: {}, submit: { label: '交', action: 'go' } }]).length, 0, '没有字段的表单丢');

  const cols = Array.from({ length: 15 }, (_, i) => ({ key: 'c' + i }));
  const [t] = normalizeBlocks([{ type: 'table', columns: [...cols, { key: 'c0' }], rows: [{ id: 7, c0: { a: 1 }, c1: 'x'.repeat(300), c2: null }, 'bad'], rowAction: 'open' }]);
  assert.equal(t.columns.length, 12);
  assert.deepEqual(t.columns[0], { key: 'c0', label: 'c0' });
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].id, 7, '数字行 id 保留类型：插件拿 args.row.id === x.id 比较');
  const [ls] = normalizeBlocks([{ type: 'list', items: [{ id: ' a\nb ', title: '甲' }, { id: { x: 1 }, title: '乙' }, { id: Infinity, title: '丙' }] }]);
  assert.deepEqual(ls.items.map((it) => it.id), ['a b', undefined, 'Infinity'], '非数字 id 照旧压成单行字符串');
  assert.equal(t.rows[0].c0, '{"a":1}');
  assert.equal(t.rows[0].c1.length, 200);
  assert.equal(t.rows[0].c2, '');
  assert.deepEqual(t.rowAction, { name: 'open' });
  assert.equal(normalizeBlocks([{ type: 'table', rows: [] }]).length, 0, '没有列的表格丢');
  const many = normalizeBlocks([{ type: 'table', columns: [{ key: 'a' }], rows: Array.from({ length: 600 }, (_, i) => ({ a: i })) }])[0];
  assert.equal(many.rows.length, 500);

  const [c] = normalizeBlocks([{ type: 'chart', kind: 'pie', x: { type: 'time', junk: 1 }, y: {}, series: [
    { name: '甲', points: [[1, 2], ['1-01', 3], [1, NaN], [{}, 1], [1], 'x', [null, 1]] },
    ...Array.from({ length: 9 }, () => ({ points: [] })),
  ] }]);
  assert.equal(c.kind, 'line');
  assert.deepEqual(c.x, { type: 'time' });
  assert.equal(c.y, undefined);
  assert.equal(c.series.length, 8);
  assert.deepEqual(c.series[0], { name: '甲', points: [[1, 2], ['1-01', 3]] });
  assert.equal(c.series[1].name, '系列 2');
  assert.equal(normalizeBlocks([{ type: 'chart', series: [] }]).length, 0);
});

test('viewApp：初始 state、按身份可见、动作名过滤、state 上限、页面型应用与没开的插件', async () => {
  const v = await viewApp(MEMBER, { plugin: APP, id: 'main' });
  assert.deepEqual(v.state, { n: 0 });
  assert.deepEqual(v.tree, [{ type: 'text', text: '计数 0' }, { type: 'button', label: '加一', action: { name: 'inc' } }], '没登记的动作按钮丢掉');
  assert.equal(seenWho.at(-1), 'user', 'view 拿到调用者的身份上下文');
  const w = await viewApp(HOST, { plugin: APP, id: 'main', state: { n: 5 } });
  assert.equal(w.tree[0].text, '计数 5');
  const err = async (p, status, re) => {
    await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return true; });
  };
  await err(viewApp(HOST, { plugin: APP, id: 'main', state: { s: 'x'.repeat(STATE_MAX) } }), 413, /256 KB/);
  const cyc = {}; cyc.c = cyc;
  await err(viewApp(HOST, { plugin: APP, id: 'main', state: cyc }), 400);
  await err(viewApp(MEMBER, { plugin: APP, id: 'secret' }), 404, /没有这个应用/);
  await err(viewApp(GUEST, { plugin: APP, id: 'main' }), 404);
  await err(viewApp(HOST, { plugin: APP, id: 'missing' }), 404);
  await err(viewApp(HOST, { plugin: 'no-such', id: 'main' }), 404, /插件没开/);
  await err(viewApp(HOST, { plugin: APP, id: 'pg' }), 400, /不是声明式应用/);
  assert.deepEqual((await viewApp(HOST, { plugin: APP, id: 'secret' })).tree, [{ type: 'text', text: '主机的' }]);
  // 初始 state 是拷贝：view 拿到的对象改了，下次新开的还是初始值
  const a = await viewApp(HOST, { plugin: APP, id: 'main' });
  a.state.n = 99;
  assert.deepEqual((await viewApp(HOST, { plugin: APP, id: 'main' })).state, { n: 0 });
  const o = await viewApp(HOST, { plugin: APP, id: 'odd' });
  assert.deepEqual(o.state, { at: '1970-01-01T00:00:00.000Z' });
  assert.equal(o.tree[0].text, 'string false', '第一次 view 看到的初始 state 与之后随请求回来的同形状');
});

test('viewApp：view 出错 / 超时画「应用出错了」并写插件日志', async () => {
  const c = await viewApp(HOST, { plugin: APP, id: 'crash' });
  assert.deepEqual(c.tree, [{ type: 'empty', title: '应用出错了', desc: 'view 炸了' }]);
  assert.ok(pluginLogs(APP).some((l) => /应用「crash」的 view 出错：view 炸了/.test(l.text)));
  const old = APP_LIMITS.viewMs;
  APP_LIMITS.viewMs = 80;
  try {
    const h = await viewApp(HOST, { plugin: APP, id: 'hang' });
    assert.equal(h.tree[0].title, '应用出错了');
    assert.match(h.tree[0].desc, /秒没回/);
    assert.ok(pluginLogs(APP).some((l) => /应用「hang」的 view 出错/.test(l.text)));
  } finally { APP_LIMITS.viewMs = old; }
});

test('runUi kind:app：动作回对象 / 字符串 / 什么都不回，用新 state 重画', async () => {
  const r = await run(MEMBER, 'main', 'inc', { args: { by: 2 }, state: { n: 3 } });
  assert.deepEqual(r, { state: { n: 5 }, tree: [{ type: 'text', text: '计数 5' }, { type: 'button', label: '加一', action: { name: 'inc' } }], toast: '加好了' });
  const s = await run(HOST, 'main', 'say', { state: { n: 1 } });
  assert.equal(s.toast, '只回一句话');
  assert.deepEqual(s.state, { n: 1 });
  const q = await run(HOST, 'main', 'silent');
  assert.deepEqual(Object.keys(q).sort(), ['state', 'tree']);
  assert.deepEqual(q.state, { n: 0 }, '没带 state 用初始 state');
  // args 不是对象 → 空对象
  assert.equal((await run(HOST, 'main', 'echo', { args: [1, 2] })).toast, '{}');
});

test('runUi kind:app：nav 规范化，不认识的丢', async () => {
  assert.deepEqual((await run(HOST, 'main', 'navApp')).nav, { app: APP + ':other' });
  assert.deepEqual((await run(HOST, 'main', 'navFull')).nav, { app: 'some-plugin:board' });
  assert.equal((await run(HOST, 'main', 'navBack')).nav, 'back');
  assert.deepEqual((await run(HOST, 'main', 'navFile')).nav, { file: { rel: 'notes/a.md', ws: 'w1' } });
  assert.deepEqual((await run(HOST, 'main', 'navSession')).nav, { session: 's-1' });
  assert.equal('nav' in (await run(HOST, 'main', 'navUrl')), false, '// 开头的地址不跳');
  assert.equal('nav' in (await run(HOST, 'main', 'navJs')), false);
});

test('runUi kind:app：没有的动作 404、出错 500、超时 504、回的 state 太大 413 / 不能 JSON 化 500、看不到的应用 404', async () => {
  const err = async (p, status, re) => {
    await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (re) assert.match(e.message, re); return true; });
  };
  await err(run(HOST, 'main', 'nope'), 404, /应用没有「nope」这个动作/);
  await err(run(HOST, 'main', 'toString'), 404);   // 原型上的名字不算动作
  await err(run(HOST, 'main', undefined), 404);
  await err(run(HOST, 'main', 'boom'), 500, /动作炸了/);
  assert.ok(pluginLogs(APP).some((l) => /应用「main」的动作出错：动作炸了/.test(l.text)));
  await err(run(HOST, 'main', 'huge'), 413, /256 KB/);
  await err(run(HOST, 'main', 'cyc'), 500, /JSON/);
  await err(run(HOST, 'main', 'echo', { args: { s: 'x'.repeat(256 * 1024 + 1) } }), 413, /动作参数/);
  await err(run(HOST, 'main', 'inc', { state: { s: 'x'.repeat(STATE_MAX) } }), 413);
  await err(run(MEMBER, 'secret', 'any'), 404, /没有这个应用/);
  await err(runUi(HOST, { plugin: 'no-such', kind: 'app', id: 'main', args: { action: 'inc' } }), 404, /插件没开/);
  const old = APP_LIMITS.actionMs;
  APP_LIMITS.actionMs = 80;
  try { await err(run(HOST, 'main', 'slow'), 504, /秒没回/); } finally { APP_LIMITS.actionMs = old; }
  // 老的 kind 不受影响
  assert.deepEqual(await runUi(HOST, { plugin: APP, kind: 'command', id: 'pal', args: {} }), { toast: 'ok' });
});

test('ctx.ui.refresh：不给 who 推给所有在线页面，给 who 只推那个人；id 不对就抛', async () => {
  const sink = () => {
    const seen = [];
    return { seen, res: {
      writableEnded: false,
      write(chunk) { const m = /^data: (.*)\n\n$/s.exec(String(chunk)); if (m) { const ev = JSON.parse(m[1]); if (ev.type === 'plugins.app.refresh') seen.push(ev); } return true; },
      end() { this.writableEnded = true; },
    } };
  };
  const a = sink();
  const u = sink();
  const offA = busSubscribe('admin', a.res);
  const offU = busSubscribe('u:u1', u.res);
  try {
    appCtx.ui.refresh('main');
    assert.deepEqual(a.seen, [{ type: 'plugins.app.refresh', plugin: APP, id: 'main' }]);
    assert.deepEqual(u.seen, [{ type: 'plugins.app.refresh', plugin: APP, id: 'main' }]);
    appCtx.ui.refresh('main', { who: MEMBER });
    assert.equal(a.seen.length, 1);
    assert.equal(u.seen.length, 2);
    assert.throws(() => appCtx.ui.refresh('Bad Id'), /ctx\.ui\.refresh 的应用 id/);
    assert.throws(() => appCtx.ui.refresh(), /ctx\.ui\.refresh/);
  } finally { offA(); offU(); }
});

test('uiView：应用带 kind / pin / perms；命令 palette；fileHandlers 按身份与目标应用过滤', async () => {
  const host = await uiView(HOST);
  const apps = Object.fromEntries(host.apps.filter((x) => x.plugin === APP).map((x) => [x.id, x]));
  assert.equal(apps.main.kind, 'view');
  assert.equal(apps.main.page, undefined);
  assert.equal(apps.main.pin, 'sidebar');
  assert.deepEqual(apps.main.perms, ['page.files']);
  assert.equal(apps.pg.kind, 'page');
  assert.equal(apps.pg.page, 'web/pg.html');
  assert.equal('pin' in apps.pg, false);
  const cmds = Object.fromEntries(host.commands.filter((x) => x.plugin === APP).map((x) => [x.name, x]));
  assert.equal(cmds.pal.palette, true);
  assert.equal('palette' in cmds.nopal, false);
  assert.deepEqual(host.fileHandlers.filter((x) => x.plugin === APP).map((x) => [x.id, x.title, x.exts, x.app]), [
    ['csv', '表格', ['csv', 'tsv'], 'app:' + APP + ':pg'],
    ['raw', '原始', ['bin'], 'app:' + APP + ':pgh'],
  ]);
  // 成员：raw 自己开给成员，但它指向的 pgh 只给主机 → 不给
  const mem = await uiView(MEMBER);
  assert.deepEqual(mem.fileHandlers.filter((x) => x.plugin === APP).map((x) => x.id), ['csv']);
  assert.deepEqual(mem.apps.filter((x) => x.plugin === APP).map((x) => x.id).sort(), ['main', 'pg']);
  assert.deepEqual((await uiView(GUEST)).fileHandlers, []);

  assert.deepEqual(findApp(MEMBER, APP, 'main'), { plugin: APP, id: 'main', kind: 'view', title: '计数器', who: 'members' });
  assert.equal(findApp(HOST, APP, 'pg').kind, 'page');
  assert.deepEqual(findFileHandler(MEMBER, APP, 'csv'), { plugin: APP, id: 'csv', title: '表格', exts: ['csv', 'tsv'], app: 'app:' + APP + ':pg' });
  assert.equal(findFileHandler(MEMBER, APP, 'raw'), null);
  assert.equal(findFileHandler(HOST, APP, 'raw').app, 'app:' + APP + ':pgh');
  assert.equal(findFileHandler(HOST, APP, 'nope'), null);
  assert.equal(findFileHandler(HOST, 'no-such', 'csv'), null);
  assert.equal(findFileHandler(GUEST, APP, 'csv'), null);
});

test('ctx.ui.fileHandler 校验：要 page.files、只指向本插件已登记的页面型应用、扩展名与标题', async () => {
  const errs = {};
  await addPlugin('fh-check', (ctx) => {
    ctx.ui.app({ id: 'pg', title: '页', page: 'web/p.html' });
    ctx.ui.app({ id: 'vw', title: '积木', view: () => [] });
    const tryIt = (k, spec) => { try { ctx.ui.fileHandler(spec); errs[k] = null; } catch (e) { errs[k] = e.message; } };
    tryIt('ok', { id: 'ok', title: '好', exts: ['md'], app: 'pg' });
    tryIt('view', { id: 'v', title: '好', exts: ['md'], app: 'vw' });
    tryIt('missing', { id: 'm', title: '好', exts: ['md'], app: 'nope' });
    tryIt('cross', { id: 'c', title: '好', exts: ['md'], app: 'other-plugin:pg' });
    tryIt('ext', { id: 'e', title: '好', exts: ['m d'], app: 'pg' });
    tryIt('noext', { id: 'n', title: '好', app: 'pg' });
    tryIt('many', { id: 'y', title: '好', exts: Array.from({ length: 21 }, (_, i) => 'e' + i), app: 'pg' });
    tryIt('title', { id: 't', title: '字'.repeat(21), exts: ['md'], app: 'pg' });
    tryIt('id', { id: 'Bad', title: '好', exts: ['md'], app: 'pg' });
    tryIt('who', { id: 'w', title: '好', exts: ['md'], app: 'pg', who: 'all' });
  }, perms('page.files'));
  assert.equal(errs.ok, null);
  assert.match(errs.view, /是声明式应用/);
  assert.match(errs.missing, /没登记/);
  assert.match(errs.cross, /只能指向本插件的应用/);
  assert.match(errs.ext, /扩展名「m d」不对/);
  assert.match(errs.noext, /要给 exts/);
  assert.match(errs.many, /最多 20 个扩展名/);
  assert.match(errs.title, /1～20 字/);
  assert.match(errs.id, /要有 id/);
  assert.match(errs.who, /who 只能是/);

  let noPerm = null;
  await addPlugin('fh-noperm', (ctx) => {
    ctx.ui.app({ id: 'pg', title: '页', page: 'web/p.html' });
    try { ctx.ui.fileHandler({ id: 'x', title: '好', exts: ['md'], app: 'pg' }); } catch (e) { noPerm = e.message; }
  }, perms('ui'));
  assert.match(noPerm, /page\.files/);
  // 插件停了：处理器跟着撤
  await kernel.setEnabled('fh-check', false);
  assert.equal(findFileHandler(HOST, 'fh-check', 'ok'), null);
  assert.equal((await uiView(HOST)).fileHandlers.some((x) => x.plugin === 'fh-check'), false);
});

test('声明式应用：积木里的 chat 按插件 page.chat 声明放行；图片按插件 id 改写', async () => {
  const view = () => [{ type: 'chat' }, { type: 'image', src: 'web/a.png' }];
  await addPlugin('chat-yes', (ctx) => { ctx.ui.app({ id: 'c', title: '聊', view }); }, perms('page.chat'));
  await addPlugin('chat-no', (ctx) => { ctx.ui.app({ id: 'c', title: '聊', view }); }, perms('ui'));
  const yes = await viewApp(HOST, { plugin: 'chat-yes', id: 'c' });
  assert.deepEqual(yes.tree, [{ type: 'chat', session: null }, { type: 'image', src: '/plugins/chat-yes/web/a.png' }]);
  const no = await viewApp(HOST, { plugin: 'chat-no', id: 'c' });
  assert.equal(no.tree[0].type, 'empty');
  assert.match(no.tree[0].desc, /page\.chat/);
  assert.deepEqual((await uiView(HOST)).apps.find((x) => x.plugin === 'chat-yes').perms, ['page.chat']);
  assert.deepEqual((await uiView(HOST)).apps.find((x) => x.plugin === 'chat-no').perms, [], '没声明页面权限也给空数组');
});
