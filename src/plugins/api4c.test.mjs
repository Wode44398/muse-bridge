// 插件接口四期第三批（服务端）：ctx.ui.* 登记、/api/plugins/ui 的视图（按身份过滤、英文词条、主题变量过滤、主页卡片数据现算）、
// 界面动作执行（返回值收敛成 toast / insert / send / open）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-api4c-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { uiView, runUi } = await import('./ui.mjs');

installMixins();
kernel.provide('router', { on: () => () => {}, use: () => () => {}, prefix: () => () => {}, has: () => false });
const HOST = { kind: 'admin', sandbox: false, key: 'admin' };
const MEMBER = { kind: 'user', user: 'u1', name: 'alice', key: 'u:u1' };

let id;
test.before(async () => {
  await kernel.start();
  id = 'ui-demo';
  await kernel.register({
    id, name: '演示', source: 'local', dir: tmp, pluginApi: 3,
    extra: { i18n: { en: { ui: { homeCard: { weather: { title: 'Weather' } }, command: { standup: { description: 'Daily standup' } } } } } },
    load: async () => ({ apply: (ctx) => {
      ctx.ui.homeCard({ id: 'weather', title: '天气', icon: 'sun', order: 2, data: async () => ({ text: '上海 晴', tone: 'ok', items: [{ label: '温度', value: '23°' }] }), open: 'panel' });
      ctx.ui.homeCard({ id: 'slow', title: '慢卡片', who: 'members', data: () => new Promise(() => {}) });
      ctx.ui.workbench({ id: 'board', title: '看板', page: 'web/board.html' });
      ctx.ui.command({ name: 'standup', description: '写站会', template: '总结一下今天做了什么：' });
      ctx.ui.command({ name: 'ticket', description: '开工单', who: 'members', handler: (who, { args, sessionId }) => ({ insert: `工单：${args}（${who.kind}，${sessionId}）`, send: true }) });
      ctx.ui.messageAction({ id: 'save', label: '存到笔记', handler: (who, { text, role }) => `已存 ${role}：${text.length} 字` });
      ctx.ui.sessionAction({ id: 'export', label: '导出', handler: () => ({ open: 'javascript:alert(1)', toast: '好了' }) });
      ctx.ui.composerAction({ id: 'tmpl', label: '模板', handler: () => ({ insert: '模板正文' }) });
      ctx.ui.theme({ vars: { '--accent': '#ff6600', '--bg': 'url(http://evil)', 'color': 'red', '--x': 'a;b' } });
    } }),
  });
});
test.after(async () => { await kernel.stop(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('登记校验', async () => {
  const c = kernel.contextOf(id);
  assert.throws(() => c.ui.command({ name: 'Bad Name', template: 'x' }), /命令名/);
  assert.throws(() => c.ui.workbench({ id: 'x', title: 'x', page: '../etc' }), /page/);
  assert.throws(() => c.ui.messageAction({ id: 'x', label: 'x' }), /handler/);
});

test('视图：主机看全，成员只看 members；卡片数据现算、慢的 3 秒封顶；主题变量过滤；英文词条', async () => {
  const t0 = Date.now();
  const v = await uiView(HOST, 'zh');
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(v.homeCards.map((c) => c.id), ['slow', 'weather'], '主机也看得到给成员的；按 order 排');
  const w = v.homeCards.find((c) => c.id === 'weather');
  assert.equal(w.data.text, '上海 晴');
  assert.deepEqual(w.open, { panel: true });
  assert.equal(v.workbench[0].page, 'web/board.html');
  assert.deepEqual(v.commands.map((c) => [c.name, c.mode]), [['standup', 'template'], ['ticket', 'action']]);
  assert.deepEqual(v.theme, { '--accent': '#ff6600' });
  const m = await uiView(MEMBER, 'zh');
  assert.deepEqual(m.homeCards.map((c) => c.id), ['slow']);
  assert.equal(m.homeCards[0].data, null, '数据没回来就是 null');
  assert.deepEqual(m.commands.map((c) => c.name), ['ticket']);
  assert.equal(m.workbench.length, 0);
  const en = await uiView(HOST, 'en');
  assert.equal(en.homeCards.find((c) => c.id === 'weather').title, 'Weather');
  assert.equal(en.commands[0].description, 'Daily standup');
});

test('动作：返回值收敛，非 http 的 open 丢掉，没权限的拒', async () => {
  assert.deepEqual(await runUi(MEMBER, { plugin: id, kind: 'command', id: 'ticket', args: { args: '打印机坏了', sessionId: 's1' } }), { insert: '工单：打印机坏了（user，s1）', send: true });
  assert.deepEqual(await runUi(HOST, { plugin: id, kind: 'messageAction', id: 'save', args: { text: '你好', role: 'assistant' } }), { toast: '已存 assistant：2 字' });
  assert.deepEqual(await runUi(HOST, { plugin: id, kind: 'sessionAction', id: 'export', args: {} }), { toast: '好了' });
  await assert.rejects(runUi(MEMBER, { plugin: id, kind: 'composerAction', id: 'tmpl', args: {} }), /没有这个界面动作/);
  await assert.rejects(runUi(HOST, { plugin: 'nope', kind: 'command', id: 'x', args: {} }), /插件没开/);
});
