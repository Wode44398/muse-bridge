import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, memoryStore } from './kernel.mjs';
import { MASK } from './schema.mjs';

const quiet = { log() {}, warn() {}, error() {} };
const mk = (state) => createKernel({ store: memoryStore(state), logger: quiet });

test('按依赖顺序启用，停用时逆序撤销', async () => {
  const k = mk();
  const log = [];
  k.register({ id: 'b', requires: ['a'], load: async () => ({ apply(ctx) { log.push('b+'); ctx.onDispose(() => log.push('b-')); } }) });
  k.register({ id: 'a', load: async () => ({ apply(ctx) { log.push('a+'); ctx.onDispose(() => log.push('a-')); } }) });
  await k.start();
  assert.deepEqual(log, ['a+', 'b+']);
  await k.setEnabled('a', false);
  assert.deepEqual(log, ['a+', 'b+', 'b-', 'a-']);
  assert.equal(k.get('b').status, 'blocked');
  assert.deepEqual(k.get('b').blockedBy, ['a']);
  await k.setEnabled('a', true);
  assert.deepEqual(log.slice(4), ['a+', 'b+']);
  assert.equal(k.get('b').status, 'active');
});

test('默认关的插件不加载代码，打开才 import', async () => {
  const k = mk();
  let loads = 0;
  k.register({ id: 'x', defaultEnabled: false, load: async () => { loads++; return { apply() {} }; } });
  await k.start();
  assert.equal(loads, 0);
  assert.equal(k.get('x').status, 'disabled');
  await k.setEnabled('x', true);
  assert.equal(loads, 1);
  assert.equal(k.isActive('x'), true);
});

test('配置：补默认值、严格校验、热插件改配置当场重启', async () => {
  const k = mk();
  const seen = [];
  k.register({
    id: 'c',
    config: { n: { type: 'integer', default: 3, min: 1 }, key: { type: 'string', secret: true }, mode: { type: 'string', enum: ['a', 'b'], default: 'a' } },
    load: async () => ({ apply(ctx, cfg) { seen.push({ ...cfg }); } }),
  });
  await k.start();
  assert.deepEqual(seen[0], { n: 3, mode: 'a' });
  await assert.rejects(() => k.setConfig('c', { n: 0 }), /不能小于 1/);
  await assert.rejects(() => k.setConfig('c', { mode: 'z' }), /只能是 a \/ b/);
  await k.setConfig('c', { n: '5', key: 'sk-1' });
  assert.deepEqual(seen[1], { n: 5, key: 'sk-1', mode: 'a' });
  assert.equal(k.get('c').config.key, MASK);
  // 回传打码值 = 沿用旧值
  await k.setConfig('c', { n: 6, key: MASK });
  assert.equal(seen[2].key, 'sk-1');
});

test('存着的坏配置退回默认值、记问题，不挡启用', async () => {
  const k = mk({ plugins: { c: { config: { n: 'abc' } } } });
  let got;
  k.register({ id: 'c', config: { n: { type: 'integer', default: 2 } }, load: async () => ({ apply(ctx, cfg) { got = cfg.n; } }) });
  await k.start();
  assert.equal(got, 2);
  assert.equal(k.get('c').problems.length, 1);
});

test('restart 插件运行中不热插拔，只标待重启', async () => {
  const k = mk();
  let applied = 0;
  k.register({ id: 'r', restart: true, load: async () => ({ apply() { applied++; } }) });
  await k.start();
  assert.equal(applied, 1);
  const s = await k.setEnabled('r', false);
  assert.equal(s.active, true);
  assert.equal(s.pendingRestart, true);
  const s2 = await k.setEnabled('r', true);
  assert.equal(s2.pendingRestart, false);
  assert.equal(applied, 1);
});

test('热插件依赖着 restart 插件时，关依赖也只标待重启', async () => {
  const k = mk();
  k.register({ id: 'base', load: async () => ({ apply() {} }) });
  k.register({ id: 'r', restart: true, requires: ['base'], load: async () => ({ apply() {} }) });
  await k.start();
  const s = await k.setEnabled('base', false);
  assert.equal(s.active, true);
  assert.equal(s.pendingRestart, true);
});

test('apply 抛错：已登记的东西撤掉，状态 error，不影响别的插件', async () => {
  const k = mk();
  const log = [];
  k.register({ id: 'bad', load: async () => ({ apply(ctx) { ctx.onDispose(() => log.push('cleaned')); throw new Error('boom'); } }) });
  k.register({ id: 'good', load: async () => ({ apply() { log.push('good'); } }) });
  await k.start();
  assert.equal(k.get('bad').status, 'error');
  assert.match(k.get('bad').error, /boom/);
  assert.deepEqual(log, ['cleaned', 'good']);
});

test('加载失败（模块坏了）记错误', async () => {
  const k = mk();
  k.register({ id: 'broken', load: async () => { throw new Error('SyntaxError: x'); } });
  k.register({ id: 'noapply', load: async () => ({ hello: 1 }) });
  await k.start();
  assert.match(k.get('broken').error, /加载失败/);
  assert.match(k.get('noapply').error, /apply/);
});

test('服务与扩展槽随插件撤销', async () => {
  const k = mk();
  k.register({ id: 'p', load: async () => ({ apply(ctx) { ctx.provide('greeter', { hi: () => 'hi' }); ctx.contribute('things', { name: 'late', order: 5 }); } }) });
  k.register({ id: 'q', requires: ['p'], load: async () => ({ apply(ctx) { ctx.contribute('things', { name: 'early', order: -1 }); assert.equal(ctx.service('greeter').hi(), 'hi'); } }) });
  await k.start();
  assert.deepEqual(k.slot('things').list().map((x) => x.name), ['early', 'late']);
  await k.setEnabled('p', false);
  assert.equal(k.hasService('greeter'), false);
  assert.equal(k.slot('things').size, 0);
  assert.throws(() => k.service('greeter'), /没有服务/);
});

test('同名服务冲突时后来者启用失败', async () => {
  const k = mk();
  k.provide('router', {});
  k.register({ id: 'p', load: async () => ({ apply(ctx) { ctx.provide('router', {}); } }) });
  await k.start();
  assert.equal(k.get('p').status, 'error');
});

test('阶段：未到时排队，到了当场调用；回调返回的撤销函数随插件撤掉', async () => {
  const k = mk();
  const log = [];
  k.register({ id: 'a', load: async () => ({ apply(ctx) { ctx.when('listening', () => { log.push('a@listening'); return () => log.push('a@off'); }); } }) });
  await k.start();
  assert.deepEqual(log, []);
  await k.enterPhase('ready');
  assert.deepEqual(log, []);
  await k.enterPhase('listening');
  assert.deepEqual(log, ['a@listening']);
  k.register({ id: 'late', defaultEnabled: false, load: async () => ({ apply(ctx) { ctx.when('listening', () => log.push('late@listening')); } }) });
  await k.setEnabled('late', true);
  assert.deepEqual(log, ['a@listening', 'late@listening']);
  await k.setEnabled('a', false);
  assert.ok(log.includes('a@off'));
});

test('混入给每个上下文加便捷方法', async () => {
  const k = mk();
  const routes = new Set();
  k.mixin('route', (ctx) => (path) => ctx.effect(() => { routes.add(path); return () => routes.delete(path); }));
  k.register({ id: 'w', load: async () => ({ apply(ctx) { ctx.route('/x'); } }) });
  await k.start();
  assert.deepEqual([...routes], ['/x']);
  await k.setEnabled('w', false);
  assert.deepEqual([...routes], []);
});

test('重载：rev 递增、重新 import、换新代码', async () => {
  const k = mk();
  const revs = [];
  let version = 'v1';
  const out = [];
  k.register({ id: 'dev', load: async (rev) => { revs.push(rev); const v = version; return { apply() { out.push(v); } }; } });
  await k.start();
  version = 'v2';
  await k.reload('dev');
  assert.deepEqual(revs, [0, 1]);
  assert.deepEqual(out, ['v1', 'v2']);
});

test('核心插件关不掉；定时器随插件清掉', async () => {
  const k = mk();
  let ticks = 0;
  k.register({ id: 'core-ish', locked: true, load: async () => ({ apply() {} }) });
  k.register({ id: 't', load: async () => ({ apply(ctx) { ctx.setInterval(() => ticks++, 5); } }) });
  await k.start();
  await assert.rejects(() => k.setEnabled('core-ish', false), /不能关/);
  await new Promise((r) => setTimeout(r, 30));
  await k.setEnabled('t', false);
  const at = ticks;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ticks, at);
  assert.ok(at > 0);
});

test('依赖成环的插件不启用', async () => {
  const k = mk();
  k.register({ id: 'x', requires: ['y'], load: async () => ({ apply() {} }) });
  k.register({ id: 'y', requires: ['x'], load: async () => ({ apply() {} }) });
  k.register({ id: 'z', load: async () => ({ apply() {} }) });
  await k.start();
  assert.equal(k.isActive('x'), false);
  assert.equal(k.isActive('y'), false);
  assert.equal(k.isActive('z'), true);
});

test('卸载：先停用自己和依赖它的', async () => {
  const k = mk();
  const log = [];
  k.register({ id: 'a', load: async () => ({ apply(ctx) { ctx.onDispose(() => log.push('a-')); } }) });
  k.register({ id: 'b', requires: ['a'], load: async () => ({ apply(ctx) { ctx.onDispose(() => log.push('b-')); } }) });
  await k.start();
  await k.unregister('a');
  assert.deepEqual(log, ['b-', 'a-']);
  assert.equal(k.has('a'), false);
  assert.equal(k.get('b').status, 'blocked');
});

test('export default 与具名导出两种写法都认', async () => {
  const k = mk();
  const hit = [];
  k.register({ id: 'd1', load: async () => ({ default: { config: { a: { type: 'boolean', default: true } }, apply(ctx, cfg) { hit.push(['d1', cfg.a]); } } }) });
  k.register({ id: 'd2', load: async () => ({ config: { b: { type: 'string', default: 'x' } }, apply(ctx, cfg) { hit.push(['d2', cfg.b]); } }) });
  await k.start();
  assert.deepEqual(hit, [['d1', true], ['d2', 'x']]);
  assert.deepEqual(Object.keys(k.get('d2').schema), ['b']);
});
