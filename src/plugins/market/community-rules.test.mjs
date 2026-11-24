import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSubmission, skipForPublish, validRange, formatReport } from './community-rules.mjs';

const f = (path, content) => { const data = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)); return { path, size: data.length, data }; };
const manifest = (over = {}) => ({ id: 'todo-lite', name: '待办', version: '1.0.0', description: '一个待办', engines: { pluginApi: 3 }, ...over });
const marketJson = (v = '1.0.0') => ({ notes: { [v]: '第一版' }, nameEn: 'Todo' });
const pagePlugin = (over = {}) => [
  f('bridge-plugin.json', manifest({ ui: { apps: [{ id: 'main', title: '待办', page: 'web/app.html' }] }, ...over })),
  f('market.json', marketJson(over.version || '1.0.0')),
  f('README.md', '# 待办'),
  f('web/app.html', '<html></html>'),
];
const serverPlugin = (code, over = {}) => [
  f('bridge-plugin.json', manifest(over)),
  f('market.json', marketJson(over.version || '1.0.0')),
  f('README.md', '# x'),
  f('index.mjs', code),
];
const codes = (r) => r.errors.map((e) => e.code);

test('纯页面插件：通过、种类 page、没有能力标注', () => {
  const r = checkSubmission({ id: 'todo-lite', files: pagePlugin(), author: 'octocat' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.kind, 'page');
  assert.deepEqual(r.caps, []);
  assert.equal(r.version, '1.0.0');
});

test('没声明页面的纯页面插件不通过', () => {
  const files = pagePlugin().map((x) => (x.path === 'bridge-plugin.json' ? f('bridge-plugin.json', manifest()) : x));
  const r = checkSubmission({ id: 'todo-lite', files, author: 'a' });
  assert.ok(codes(r).includes('entry'));
});

test('服务端插件：能力按引用检测，普通字符串不算', () => {
  const code = [
    "import fs from 'node:fs';",
    "import { spawn } from 'child_process';",
    "const proto = 'https';  // 只是个字符串",
    "export function apply(ctx) { fetch('https://x'); return process.env.HOME; }",
  ].join('\n');
  const r = checkSubmission({ id: 'todo-lite', files: serverPlugin(code), author: 'a' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.kind, 'server');
  assert.deepEqual(r.caps, ['process', 'network', 'files', 'env']);
  assert.match(r.capsAt.process[0], /^index\.mjs:2$/);
});

test('动态执行一律不通过', () => {
  for (const code of [
    'eval("1")',
    'const f = new Function("return 1")',
    "import vm from 'node:vm';",
    'const m = await import(url);',
    'const m = await import(`./${name}.mjs`);',
    'const x = require(name);',
    "import { createRequire } from 'node:module';",
    'WebAssembly.instantiate(buf)',
    "new Worker(src, { eval: true })",
    // 转手与绕路的写法
    'const e = eval; e(code);',
    'globalThis.eval(code)',
    "globalThis['ev' + 'al'](code)",
    "(() => {}).constructor('return 1')()",
    'const F = Object.getPrototypeOf(async function () {}).constructor;',
    "import { register } from 'node:module';",
    "const m = await import('data:text/javascript,export default 1');",
    'module.require(name)',
    'process.mainModule.require("x")',
  ]) {
    const r = checkSubmission({ id: 'todo-lite', files: serverPlugin(code), author: 'a' });
    assert.ok(codes(r).includes('dynamic-code'), code + ' 应被拦');
  }
  // 字面量的动态 import / require 可以；别的对象的 import 方法、小写的 {function} 类型注释、evaluate 这类词可以
  const ok = checkSubmission({ id: 'todo-lite', files: serverPlugin("/** @param {function} cb */\nconst a = await import('./a.mjs'); const b = await import(`./b.mjs`); x.import(y); evaluate(1); module.require('./c.cjs');"), author: 'a' });
  assert.ok(!codes(ok).includes('dynamic-code'), JSON.stringify(ok.errors));
});

test('压缩、内嵌数据块不通过；web/ 下的前端文件不查', () => {
  const long = 'const a = 1;'.repeat(100);
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: serverPlugin(long), author: 'a' })).includes('unreadable'));
  const blob = `const b = "${'A'.repeat(2100)}";`;
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: serverPlugin(blob), author: 'a' })).includes('blob'));
  const files = [...serverPlugin('export function apply() {}'), f('web/vendor.min.js', 'eval(1);' + 'x'.repeat(3000))];
  assert.equal(checkSubmission({ id: 'todo-lite', files, author: 'a' }).ok, true);
});

test('路径与文件类型', () => {
  for (const bad of ['.env', 'a/../b.js', 'node_modules/x/index.js', 'tool.exe', 'a\\b.js', 'lib/.hidden/x.js']) {
    const r = checkSubmission({ id: 'todo-lite', files: [...pagePlugin(), f(bad, 'x')], author: 'a' });
    assert.equal(r.ok, false, bad + ' 应被拦');
  }
  const dup = checkSubmission({ id: 'todo-lite', files: [...pagePlugin(), f('web/A.css', ''), f('web/a.css', '')], author: 'a' });
  assert.ok(codes(dup).includes('path'));
});

test('清单：id 对不上、replaces、builtin、缺更新说明', () => {
  assert.ok(codes(checkSubmission({ id: 'other', files: pagePlugin(), author: 'a' })).includes('manifest'));
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: pagePlugin({ replaces: 'claude' }), author: 'a' })).includes('replaces'));
  const bi = pagePlugin().map((x) => (x.path === 'market.json' ? f('market.json', { builtin: true, notes: { '1.0.0': 'x' } }) : x));
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: bi, author: 'a' })).includes('market'));
  const nn = pagePlugin().map((x) => (x.path === 'market.json' ? f('market.json', { notes: {} }) : x));
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: nn, author: 'a' })).includes('market'));
});

test('归属：先到先得、只有本人能发新版、版本要变大、保留名与封禁', () => {
  const ledger = { owners: { 'todo-lite': 'Alice' }, plugins: { 'todo-lite': { versions: [{ version: '1.0.0' }] } } };
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: pagePlugin({ version: '1.0.1' }), author: 'bob', ledger })).includes('owner'));
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: pagePlugin(), author: 'alice', ledger })).includes('version'));
  assert.equal(checkSubmission({ id: 'todo-lite', files: pagePlugin({ version: '1.0.1' }), author: 'ALICE', ledger }).ok, true);
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: pagePlugin(), author: 'a', reserved: ['todo-lite'] })).includes('reserved'));
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: pagePlugin(), author: 'a', official: ['todo-lite'] })).includes('reserved'));
  const pre = pagePlugin().map((x) => (x.path === 'bridge-plugin.json' ? f('bridge-plugin.json', manifest({ id: 'bridge-x', ui: { panel: 'web/app.html' } })) : x));
  assert.ok(codes(checkSubmission({ id: 'bridge-x', files: pre, author: 'a' })).includes('reserved'));
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: pagePlugin(), author: 'evil', moderation: { blockedAuthors: ['Evil'] } })).includes('author'));
  assert.ok(codes(checkSubmission({ id: 'todo-lite', files: pagePlugin(), author: 'a', moderation: { revoked: [{ id: 'todo-lite', versions: '*' }] } })).includes('revoked'));
});

test('发布时略过的文件、engines 范围写法、报告', () => {
  for (const p of ['.git/config', 'node_modules/a.js', 'market.json', 'a.test.mjs', 'test/x.mjs', 'debug.log']) assert.equal(skipForPublish(p), true, p);
  for (const p of ['index.mjs', 'web/app.html', 'lib/test-utils.mjs']) assert.equal(skipForPublish(p), false, p);
  for (const r of ['>=8.50', '>=6.74 <7', '^8.1', '>=8 || ~7.9', '*']) assert.equal(validRange(r), true, r);
  for (const r of ['', 'latest', '>=a']) assert.equal(validRange(r), false, r);
  const r = checkSubmission({ id: 'todo-lite', files: serverPlugin("import fs from 'fs';"), author: 'a' });
  assert.match(formatReport(r, { id: 'todo-lite', author: 'a' }), /读写服务器上的文件/);
});
