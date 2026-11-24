// 工作区插槽（plugins/workspace.mjs）：ctx.ui.workspaceDecor / workspaceAction / refreshDecor 的登记校验、外观视图
// （规范化、限额、audience、agents 过滤、出错与超时、排序）、uiView 的 workspaceActions、确认框与执行（values 过滤、结果规范化）、
// Target 规范化、refreshDecor 推总线；ctx.claude.memoryDir / memoryInfo。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-plugin-workspace-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_PLUGINS_STATE = path.join(tmp, 'plugins.json');
process.env.BRIDGE_PLUGINS_DIR = path.join(tmp, 'plugins');

const { kernel } = await import('./state.mjs');
const { installMixins } = await import('./host.mjs');
const { uiView, runUi, decorView } = await import('./ui.mjs');
const { normTarget, WORKSPACE_LIMITS, cleanAbsPath } = await import('./workspace.mjs');
const { busSubscribe } = await import('../runtime/bus.mjs');
const { PLUGIN_FEATURES } = await import('./engines.mjs');

installMixins();
kernel.provide('router', { on: () => () => {}, use: () => () => {}, prefix: () => () => {}, has: () => false });
const HOST = { kind: 'admin', sandbox: false, key: 'admin' };
const MEMBER = { kind: 'user', user: 'u1', name: 'alice', key: 'u:u1' };

const WIN = process.platform === 'win32';
const P1 = WIN ? 'E:\\Work\\Proj' : '/work/proj';
const P1b = WIN ? 'e:/work/proj/' : '/work/proj/';
const P2 = WIN ? 'E:\\Other' : '/other';

const seenHandler = [];
let failList = false;
let hangList = false;
let failDialog = false;

test.before(async () => {
  await kernel.start();
  await kernel.register({
    id: 'ws-b', name: '协作', source: 'local', dir: tmp, pluginApi: 3,
    extra: { i18n: { en: { ui: { workspaceAction: { 'collab-on': { label: 'Share this folder' } } } } } },
    load: async () => ({ apply: (ctx) => {
      ctx.ui.workspaceDecor({
        id: 'collab',
        list: (who, { agent }) => {
          if (failList) throw new Error('炸了');
          if (hangList) return new Promise(() => {});
          return [
            {
              path: P1, peers: ['agy', 'claude', 'codex'], busy: ['claude', 'claude'], note: '与 Antigravity 共用\n记忆 214 篇' + 'x'.repeat(100),
              status: { agent: 'claude', text: '正在出 apk', since: 1763900000000, open: { action: 'collab-edit' } },
              footer: { icon: 'book', text: '共用记忆', open: { url: 'javascript:alert(1)' } },
              card: {
                title: '与 Claude 共用', subtitle: P1,
                sections: Array.from({ length: 6 }, (_, i) => ({ label: '节' + i, link: { label: '打开', open: { file: { rel: 'memory/MEMORY.md' } } },
                  rows: Array.from({ length: 12 }, (_, j) => ({ icon: 'Bad Icon', agent: j % 2 ? 'agy' : 'x', live: 1, text: '行' + j, since: -5, mono: true, open: { session: { agent: 'agy', id: 's' + j } } })) })),
                foot: { text: '往来不用你批', link: { label: '协作设置', open: { action: 'Bad Id' } } },
              },
              sessions: [...Array.from({ length: 250 }, (_, i) => ({ agent: 'agy', id: 'a' + i, by: 'claude' })), { agent: 'agy', id: '../x', by: 'claude' }],
              peerSessions: [{ agent: 'agy', items: Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, title: '会话' + i, live: i === 0 })) }, { agent: 'agy', items: [] }],
              agentSeen: agent,
            },
            { path: P1b, note: '重复的路径' },
            { path: 'relative/dir' },
            ...Array.from({ length: 60 }, (_, i) => ({ path: (WIN ? 'D:\\p' : '/p') + i })),
          ];
        },
      });
      ctx.ui.workspaceAction({
        id: 'collab-on', label: '设为协作空间', icon: 'claude', agents: ['agy'], when: 'plain',
        dialog: (who, { path: p, agent }) => {
          if (failDialog) throw new Error('对话框坏了');
          return {
            title: '和 Claude 共用这个文件夹', subtitle: p + ' · ' + agent, hero: { peers: ['agy', 'claude', 'nope'] },
            sections: [{ label: '会做', items: [{ icon: 'book', agent: 'claude', title: '先读记忆', desc: '…', chip: { ok: true, code: 'memory\\MEMORY.md', text: '自动找到' } }, { title: '' }] }],
            fields: [{ id: 'askFirst', type: 'switch', label: '先问我', value: true }, { id: 'quiet', type: 'switch', label: '安静' }, { id: 'name', type: 'text' }, { id: 'askFirst', type: 'switch' }],
            ok: '设为协作空间', cancel: '取消', extra: { label: '取消协作', action: 'collab-off', danger: true },
          };
        },
        handler: (who, view) => { seenHandler.push(view); return { toast: '好了', decorChanged: true, undo: { label: '撤销', action: 'collab-off' }, open: { session: { agent: 'claude', id: 'abc' } } }; },
      });
      ctx.ui.workspaceAction({ id: 'collab-off', label: '取消协作', when: 'decorated', danger: true, handler: () => '取消了' });
      ctx.ui.workspaceAction({ id: 'member-op', label: '成员也能用', who: 'members', handler: (who, v) => ({ open: '/x', values: v.values }) });
      ctx.ui.workspaceAction({ id: 'boom', label: '会炸', handler: () => { throw new Error('handler 坏了'); } });
    } }),
  });
  await kernel.register({
    id: 'ws-a', name: '另一个', source: 'local', dir: tmp, pluginApi: 3,
    load: async () => ({ apply: (ctx) => {
      ctx.ui.workspaceDecor({ id: 'only-claude', agents: ['claude'], who: 'members', list: () => [{ path: P2, panel: false }] });
    } }),
  });
});
test.after(async () => { await kernel.stop(); try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('能力名登记了', () => {
  for (const n of ['ui.workspaceDecor', 'ui.workspaceAction', 'ui.refreshDecor', 'claude.memory', 'events.agy', 'prompt.agy.cwd']) assert.ok(PLUGIN_FEATURES.includes(n), n);
});

test('登记校验', () => {
  const c = kernel.contextOf('ws-b');
  assert.throws(() => c.ui.workspaceDecor({ id: 'Bad', list: () => [] }), /要有 id/);
  assert.throws(() => c.ui.workspaceDecor({ id: 'x' }), /list/);
  assert.throws(() => c.ui.workspaceDecor({ id: 'x', agents: ['codex'], list: () => [] }), /agents 只认/);
  assert.throws(() => c.ui.workspaceDecor({ id: 'x', agents: [], list: () => [] }), /agents 只认/);
  assert.throws(() => c.ui.workspaceDecor({ id: 'x', who: 'all', list: () => [] }), /who/);
  assert.throws(() => c.ui.workspaceAction({ id: 'x', label: 'x' }), /handler/);
  assert.throws(() => c.ui.workspaceAction({ id: 'x', handler: () => 1, when: 'sometimes' }), /when/);
  assert.throws(() => c.ui.workspaceAction({ id: 'x', handler: () => 1, dialog: {} }), /dialog/);
  assert.throws(() => c.ui.workspaceAction({ id: 'x', handler: () => 1, decor: 'Bad' }), /decor/);
  assert.throws(() => c.ui.refreshDecor('Bad Id'), /refreshDecor/);
});

test('Target 的 folder：到那个 agent 分页的这个文件夹；agent / 路径不合格丢掉', () => {
  assert.deepEqual(normTarget({ folder: { agent: 'agy', path: P1 } }), { folder: { agent: 'agy', path: P1 } });
  assert.equal(normTarget({ folder: { agent: 'codex', path: P1 } }), undefined);
  assert.equal(normTarget({ folder: { agent: 'claude', path: 'rel/x' } }), undefined);
  assert.equal(normTarget({ folder: 'x' }), undefined);
});

test('Target 规范化：只认四种', () => {
  assert.deepEqual(normTarget({ action: 'collab-on' }), { action: 'collab-on' });
  assert.equal(normTarget({ action: 'Bad' }), undefined);
  assert.deepEqual(normTarget({ session: { agent: 'agy', id: 'abc-1' } }), { session: { agent: 'agy', id: 'abc-1' } });
  assert.equal(normTarget({ session: { agent: 'codex', id: 'abc' } }), undefined);
  assert.equal(normTarget({ session: { agent: 'agy', id: '../x' } }), undefined);
  assert.deepEqual(normTarget({ file: { rel: 'a/b.md', ws: P1 } }), { file: { rel: 'a/b.md', ws: P1 } });
  assert.equal(normTarget({ file: { rel: '' } }), undefined);
  assert.deepEqual(normTarget({ url: 'https://x.y' }), { url: 'https://x.y' });
  assert.deepEqual(normTarget({ url: '/app' }), { url: '/app' });
  assert.equal(normTarget({ url: '//evil' }), undefined);
  assert.equal(normTarget({ url: 'javascript:1' }), undefined);
  assert.equal(normTarget('panel'), undefined);
  assert.equal(normTarget({ app: 'x' }), undefined);
  assert.equal(cleanAbsPath('rel/x'), '');
  assert.equal(cleanAbsPath('/a\u0000b'), '');
});

test('外观：按分页过滤 agents、按身份过滤 who；规范化、限额、去重、排序', async () => {
  const agy = await decorView(HOST, 'agy');
  assert.deepEqual(agy.decor.map((d) => [d.plugin, d.id]), [['ws-b', 'collab']], 'only-claude 不给 agy');
  const claude = await decorView(HOST, 'claude');
  assert.deepEqual(claude.decor.map((d) => [d.plugin, d.id]), [['ws-a', 'only-claude'], ['ws-b', 'collab']], '按插件 id 排');
  assert.equal(claude.decor[0].items[0].panel, false);
  const items = agy.decor[0].items;
  assert.equal(items.length, 50, '每个 decor 最多 50 个路径');
  assert.ok(!items.some((x) => x.note === '重复的路径'), '同一路径（大小写 / 尾斜杠不同）只留第一条');
  assert.ok(!items.some((x) => x.path === 'relative/dir'), '相对路径丢掉');
  const it = items[0];
  assert.equal(it.path, P1);
  assert.deepEqual(it.peers, ['agy', 'claude']);
  assert.deepEqual(it.busy, ['claude']);
  assert.equal(it.note.length, 60);
  assert.ok(!it.note.includes('\n'));
  assert.deepEqual(it.status, { agent: 'claude', text: '正在出 apk', since: 1763900000000, open: { action: 'collab-edit' } });
  assert.deepEqual(it.footer, { icon: 'book', text: '共用记忆' }, '坏的 open 丢掉');
  assert.equal(it.card.sections.length, 4);
  assert.equal(it.card.sections[0].rows.length, 8);
  assert.deepEqual(it.card.sections[0].link, { label: '打开', open: { file: { rel: 'memory/MEMORY.md' } } });
  assert.deepEqual(it.card.sections[0].rows[1], { icon: '', agent: 'agy', live: false, text: '行1', meta: '', since: 0, mono: true, open: { session: { agent: 'agy', id: 's1' } } });
  assert.equal(it.card.sections[0].rows[0].agent, '');
  assert.deepEqual(it.card.foot, { text: '往来不用你批' }, '链接目标不对就整个链接丢掉');
  assert.equal(it.sessions.length, 200);
  assert.ok(it.sessions.every((s) => s.id !== '../x'));
  assert.equal(it.peerSessions.length, 1, '同一 agent 只留一组');
  assert.equal(it.peerSessions[0].items.length, 20);
  assert.deepEqual(it.peerSessions[0].items[0], { id: 'p0', title: '会话0', meta: '', live: true });
  assert.equal(it.agentSeen, undefined, '未知字段不透传');
  const m = await decorView(MEMBER, 'claude');
  assert.deepEqual(m.decor.map((d) => d.id), ['only-claude'], '成员只看到 who:members 的');
  await assert.rejects(decorView(HOST, 'codex'), (e) => e.status === 400);
});

test('外观：list 出错 / 超时只写日志、这个外观当作空，别的照常', async () => {
  const old = WORKSPACE_LIMITS.listMs;
  WORKSPACE_LIMITS.listMs = 60;
  try {
    failList = true;
    let v = await decorView(HOST, 'claude');
    assert.deepEqual(v.decor.map((d) => [d.id, d.items.length]), [['only-claude', 1], ['collab', 0]]);
    failList = false; hangList = true;
    const t0 = Date.now();
    v = await decorView(HOST, 'claude');
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(v.decor.find((d) => d.id === 'collab').items.length, 0);
  } finally { failList = false; hangList = false; WORKSPACE_LIMITS.listMs = old; }
});

test('uiView 的 workspaceActions：字段、缺省 decor、成员过滤、英文词条', async () => {
  const v = await uiView(HOST, 'zh');
  const on = v.workspaceActions.find((a) => a.id === 'collab-on');
  assert.deepEqual(on, { plugin: 'ws-b', pluginName: '协作', id: 'collab-on', label: '设为协作空间', icon: 'claude', agents: ['agy'], when: 'plain', decor: 'collab', danger: false, hasDialog: true });
  const off = v.workspaceActions.find((a) => a.id === 'collab-off');
  assert.deepEqual([off.agents, off.when, off.decor, off.danger, off.hasDialog], [['agy', 'claude'], 'decorated', 'collab', true, false]);
  const m = await uiView(MEMBER, 'zh');
  assert.deepEqual(m.workspaceActions.map((a) => a.id), ['member-op']);
  const en = await uiView(HOST, 'en');
  assert.equal(en.workspaceActions.find((a) => a.id === 'collab-on').label, 'Share this folder');
});

test('确认框：规范化；没有 dialog → null；路径不对 400；出错 500', async () => {
  const r = await runUi(HOST, { plugin: 'ws-b', kind: 'workspaceDialog', id: 'collab-on', args: { path: P1, agent: 'agy' } });
  const d = r.dialog;
  assert.equal(d.title, '和 Claude 共用这个文件夹');
  assert.equal(d.subtitle, P1 + ' · agy');
  assert.deepEqual(d.hero, { peers: ['agy', 'claude'] });
  assert.equal(d.sections[0].items.length, 1, '没标题的项丢掉');
  assert.deepEqual(d.sections[0].items[0].chip, { ok: true, code: 'memory\\MEMORY.md', text: '自动找到' });
  assert.deepEqual(d.fields.map((f) => [f.id, f.value]), [['askFirst', true], ['quiet', false]], '只有 switch、id 去重');
  assert.deepEqual(d.extra, { label: '取消协作', action: 'collab-off', danger: true });
  assert.deepEqual(await runUi(HOST, { plugin: 'ws-b', kind: 'workspaceDialog', id: 'collab-off', args: { path: P1 } }), { dialog: null });
  await assert.rejects(runUi(HOST, { plugin: 'ws-b', kind: 'workspaceDialog', id: 'collab-on', args: { path: 'rel' } }), (e) => e.status === 400);
  await assert.rejects(runUi(HOST, { plugin: 'ws-b', kind: 'workspaceDialog', id: 'nope', args: { path: P1 } }), (e) => e.status === 404);
  failDialog = true;
  try {
    await assert.rejects(runUi(HOST, { plugin: 'ws-b', kind: 'workspaceDialog', id: 'collab-on', args: { path: P1 } }), (e) => e.status === 500);
    // 对话框算不出来，动作也不执行
    const n = seenHandler.length;
    await assert.rejects(runUi(HOST, { plugin: 'ws-b', kind: 'workspaceAction', id: 'collab-on', args: { path: P1, values: { askFirst: true } } }), (e) => e.status === 500);
    assert.equal(seenHandler.length, n);
  } finally { failDialog = false; }
});

test('执行：values 只收声明过的布尔开关、缺的取缺省；结果规范化；身份与出错', async () => {
  const r = await runUi(HOST, { plugin: 'ws-b', kind: 'workspaceAction', id: 'collab-on', args: { path: P1, projectId: 'proj-1', agent: 'agy', values: { askFirst: false, quiet: 'yes', evil: true } } });
  assert.deepEqual(r, { toast: '好了', open: { session: { agent: 'claude', id: 'abc' } }, decorChanged: true, undo: { label: '撤销', action: 'collab-off' } });
  assert.deepEqual(seenHandler.at(-1), { path: P1, projectId: 'proj-1', agent: 'agy', values: { askFirst: false, quiet: false } });
  assert.deepEqual(await runUi(HOST, { plugin: 'ws-b', kind: 'workspaceAction', id: 'collab-off', args: { path: P1 } }), { toast: '取消了' });
  // 没有 dialog：values 是 {}；open 字符串按网址认
  assert.deepEqual(await runUi(MEMBER, { plugin: 'ws-b', kind: 'workspaceAction', id: 'member-op', args: { path: P1, values: { a: true } } }), { open: '/x' });
  await assert.rejects(runUi(MEMBER, { plugin: 'ws-b', kind: 'workspaceAction', id: 'collab-off', args: { path: P1 } }), (e) => e.status === 404);
  await assert.rejects(runUi(HOST, { plugin: 'ws-b', kind: 'workspaceAction', id: 'boom', args: { path: P1 } }), (e) => e.status === 500 && /handler 坏了/.test(e.message));
  // 老的 kind 不受影响
  await assert.rejects(runUi(HOST, { plugin: 'ws-b', kind: 'command', id: 'x', args: {} }), /没有这个界面动作/);
});

test('refreshDecor 推总线；执行成功后给这个人推一声', async () => {
  const sink = () => {
    const seen = [];
    return { seen, res: {
      writableEnded: false,
      write(chunk) { const m = /^data: (.*)\n\n$/s.exec(String(chunk)); if (m) { const ev = JSON.parse(m[1]); if (ev.type === 'plugins.ui.decor') seen.push(ev); } return true; },
      end() { this.writableEnded = true; },
    } };
  };
  const a = sink();
  const u = sink();
  const offA = busSubscribe('admin', a.res);
  const offU = busSubscribe('u:u1', u.res);
  try {
    const c = kernel.contextOf('ws-b');
    c.ui.refreshDecor('collab');
    assert.deepEqual(a.seen, [{ type: 'plugins.ui.decor', plugin: 'ws-b', id: 'collab' }]);
    assert.equal(u.seen.length, 1);
    c.ui.refreshDecor(undefined, { who: MEMBER });
    assert.deepEqual(u.seen.at(-1), { type: 'plugins.ui.decor', plugin: 'ws-b', id: '' });
    assert.equal(a.seen.length, 1);
    await runUi(HOST, { plugin: 'ws-b', kind: 'workspaceAction', id: 'collab-off', args: { path: P1 } });
    assert.equal(a.seen.length, 2);
    assert.equal(u.seen.length, 2);
  } finally { offA(); offU(); }
});

test('ctx.claude.memoryDir / memoryInfo：settings 改道、计数、相对路径给 null', async () => {
  const c = kernel.contextOf('ws-b');
  const ws = path.join(tmp, 'proj');
  const mem = path.join(tmp, 'mem');
  mkdirSync(path.join(ws, '.claude'), { recursive: true });
  mkdirSync(path.join(mem, 'sub'), { recursive: true });
  writeFileSync(path.join(ws, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: mem }));
  assert.equal(await c.claude.memoryDir(ws), path.resolve(mem));
  let info = await c.claude.memoryInfo(ws);
  assert.deepEqual(info, { dir: path.resolve(mem), exists: true, index: false, files: 0 });
  writeFileSync(path.join(mem, 'MEMORY.md'), '# x');
  writeFileSync(path.join(mem, 'a.md'), 'a');
  writeFileSync(path.join(mem, 'b.txt'), 'b');
  writeFileSync(path.join(mem, 'sub', 'c.md'), 'c');
  info = await c.claude.memoryInfo(ws);
  assert.deepEqual(info, { dir: path.resolve(mem), exists: true, index: true, files: 2 }, '只数第一层 .md');
  assert.equal(await c.claude.memoryDir('relative/x'), null);
  assert.equal(await c.claude.memoryInfo(''), null);
  // 没改道：默认目录（不存在也给路径）
  const plain = path.join(tmp, 'plain');
  mkdirSync(plain, { recursive: true });
  const d = await c.claude.memoryDir(plain, { who: { kind: 'admin', configDir: path.join(tmp, 'cfg') } });
  assert.ok(d && d.startsWith(path.join(tmp, 'cfg')) && d.endsWith('memory'), d);
  assert.deepEqual(await c.claude.memoryInfo(plain, { who: { kind: 'admin', configDir: path.join(tmp, 'cfg') } }), { dir: d, exists: false, index: false, files: 0 });
});
