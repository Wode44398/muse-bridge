import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub, normalizeMessage, ownFrames, errorFingerprint } from './scrub.mjs';
import { cleanReport } from './schema.mjs';
import { issueBody, issueTitle, readFpMarker, plusOneBody } from './render.mjs';

test('scrub: 各家令牌 / key 一律打码', () => {
  const cases = [
    'sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-proj-abcdefghijklmnop1234567890',
    'sk-kimi-ABCDEFGH12345678abcdefgh',
    'tp-0123456789abcdefABCDEF',
    'ghp_0123456789abcdefABCDEF0123456789abcd',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    'eyJhIjoiYWJjZGVmIiwidCI6IjEyMzQ1Njc4OSJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz',
  ];
  for (const c of cases) {
    const out = scrub(`token is ${c} ok`);
    assert.ok(!out.includes(c.slice(4, 20)), `${c} 没被打码：${out}`);
    assert.match(out, /<secret>/);
  }
  assert.match(scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'), /<secret>/);
  assert.match(scrub('api_key=hunter2hunter2'), /<secret>/);
  assert.match(scrub('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'), /^<secret>$/);
});

test('scrub: 地址、邮箱、路径、IP', () => {
  const s = scrub('打不开 https://foo-bar-baz.trycloudflare.com/api/x?token=1，联系 me@example.com，文件 /home/hatch/bridge-srv/users/alice/notes.md，机器 10.1.2.3');
  assert.ok(!s.includes('foo-bar-baz'));
  assert.ok(!s.includes('me@example.com'));
  assert.ok(!s.includes('alice'));
  assert.ok(!s.includes('10.1.2.3'));
  assert.match(s, /<tunnel-url>/);
  assert.match(s, /<email>/);
  assert.match(s, /<path>/);
  assert.match(s, /<ip>/);
  // 网址 / 路径后面紧跟的中文不能被一起吞掉
  assert.equal(s, '打不开 <tunnel-url>，联系 <email>，文件 <path>，机器 <ip>');
  assert.equal(scrub('文件 /home/a/笔记.md。'), '文件 <path>。');
  // 公共接口站点保留主机名，私人网址打码
  assert.match(scrub('connect https://api.anthropic.com/v1/messages failed'), /https:\/\/api\.anthropic\.com\/…/);
  assert.equal(scrub('see https://my-private-host.example.org/a'), 'see <url>');
  // 自己的域名（字面值）在哪都抹
  assert.equal(scrub('bridge.mydomain.com is down', { literals: ['bridge.mydomain.com'] }), '<redacted> is down');
  // Windows 路径
  assert.match(scrub('C:\\Users\\someone\\secret.txt'), /<path>/);
});

test('scrub: 我们自己代码的路径留成仓库内相对路径', () => {
  const s = scrub('at handle (/home/hatch/bridge-releases/20261008-120000/bridge/src/routes/files.mjs:12:5)');
  assert.equal(s, 'at handle (src/routes/files.mjs:12:5)');
});

test('scrub: 普通文字、短哈希、中文不受影响', () => {
  const t = '点了「发送」之后一直转圈，版本 5ca7a68 2026-10-07，页面 claude';
  assert.equal(scrub(t), t);
});

test('normalizeMessage / ownFrames / 指纹跨机器稳定', async () => {
  const m1 = normalizeMessage("Cannot read properties of undefined (reading 'foo') at 12:34 in /home/a/b.txt");
  const m2 = normalizeMessage("Cannot read properties of undefined (reading 'bar') at 99:1 in /root/x.txt");
  assert.equal(m1, m2);
  const stack = [
    'TypeError: x is not a function',
    '    at doThing (/home/hatch/bridge-releases/20261001-000000/bridge/src/routes/chat.mjs:10:3)',
    '    at async Server.<anonymous> (/home/hatch/bridge-releases/20261001-000000/bridge/src/runtime/router.mjs:30:9)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at x (/home/hatch/bridge-releases/20261001-000000/bridge/node_modules/undici/lib/a.js:1:1)',
  ].join('\n');
  const frames = ownFrames(stack);
  assert.deepEqual(frames, ['doThing (src/routes/chat.mjs)', 'Server.<anonymous> (src/runtime/router.mjs)']);
  const other = stack.replace(/20261001-000000/g, '20261008-090909').replace(/:10:3/, ':11:7');
  assert.deepEqual(ownFrames(other), frames);
  const a = await errorFingerprint({ type: 'TypeError', message: 'x is not a function', frames });
  const b = await errorFingerprint({ type: 'TypeError', message: 'x is not a function', frames: ownFrames(other) });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
  // 浏览器帧：去掉打包 hash
  assert.deepEqual(ownFrames('Error: x\n    at Bn (https://h.trycloudflare.com/app/assets/index-B3x9kQ_a.js:1:200)'), ['Bn (web/index.js)']);
});

test('cleanReport: 白名单——没列的字段、不认识的值都进不去', () => {
  const r = cleanReport({
    install: 'abcdef12-3456-7890-abcd-ef1234567890', kind: 'bug', source: 'web',
    description: '上传卡在 0%，我的 key 是 sk-ant-api03-SECRETSECRETSECRET12345',
    env: { version: '5ca7a68 2026-10-07', agents: ['claude', 'evil'], users: 'multi', tunnel: 'quick', node: 'v24.1.0', arch: 'x64', page: 'claude' },
    services: { bridge: 'active', 'muse-tunnel': 'failed', sshd: 'active' },
    sites: [{ host: 'api.anthropic.com', state: 'ok' }, { host: 'my-llm.internal.example', state: 'pending' }],
    chats: ['不该出现'], token: 'nope',
  });
  assert.equal(r.chats, undefined);
  assert.equal(r.token, undefined);
  assert.ok(!r.description.includes('SECRET'));
  assert.deepEqual(r.env.agents, ['claude']);
  assert.deepEqual(r.services, { bridge: 'active', 'muse-tunnel': 'failed' });
  assert.deepEqual(r.sites, [{ host: 'api.anthropic.com', state: 'ok' }, { host: 'custom', state: 'pending' }]);
  assert.equal(r.title, '上传卡在 0%，我的 key 是 <secret>');
  assert.throws(() => cleanReport({ install: 'abcdef12', kind: 'hack' }), /bad kind/);
  assert.throws(() => cleanReport({ install: 'x', kind: 'bug', description: 'a' }), /install/);
  assert.throws(() => cleanReport({ install: 'abcdef12', kind: 'bug' }), /empty/);
});

test('render: 标题、指纹标记、@提及被打断、+1', () => {
  const r = cleanReport({
    install: 'abcdef12-0000', kind: 'crash', source: 'auto', fp: '0123456789ab',
    errors: [{ fp: '0123456789ab', where: 'server', type: 'TypeError', message: 'x is not a function', frames: ['f (src/a.mjs)'], count: 3 }],
    description: 'ping @someone <script>',
    env: { version: 'abc1234 2026-10-08' },
  });
  assert.equal(issueTitle(r), '[Crash] TypeError: x is not a function');
  const body = issueBody(r);
  assert.equal(readFpMarker(body), '0123456789ab');
  assert.ok(!/@someone/.test(body));
  assert.ok(!body.includes('<script>'));
  assert.match(body, /sent automatically/);
  assert.match(plusOneBody(r), /^\+1/);
});

test('docs：说明书缺口单独一类，打 documentation 标签', async () => {
  const { issueLabels } = await import('./render.mjs');
  const r = cleanReport({ install: 'abcdef12-0000', kind: 'docs', description: '用户问怎么导出对话，说明书里没写' });
  assert.equal(issueTitle(r), '[Docs] 用户问怎么导出对话，说明书里没写');
  assert.deepEqual(issueLabels(r), ['from-muse', 'documentation']);
});

test('cleanReport: 系统版本只认「名字 + 数字版本」', () => {
  const mk = (osv) => cleanReport({ install: 'abcdef12-0000', kind: 'bug', description: 'x', env: { os: osv } }).env.os;
  assert.equal(mk('Linux 6.10.14'), 'Linux 6.10.14');
  assert.equal(mk('Windows_NT 10.0.26200'), 'Windows_NT 10.0.26200');
  assert.equal(mk('Linux 6.10.14-linuxkit sk-ant-oat01-AAAA'), undefined);
});
