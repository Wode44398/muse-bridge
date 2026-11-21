// node --test web/src/lib/pluginFrameGate.test.js
// 插件页面宿主（PluginFrame）认消息、往里推的门：口令（nonce）、文档号（doc）、bye、load 之后的核实，以及确认框文字的收拾。
// 门是纯逻辑；PluginFrame 怎么接它（hello 换代收订阅、onDetach 同换代、所有推送经 gate.push）在最后一组里用同样的接法
// 模拟一遍，并核对组件源码确实是这么接的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFrameGate, createWatchHold, fromFrame, makeNonce, confirmParts, confirmDesc,
  CONFIRM_TITLE_MAX, CONFIRM_DESC_LINES, CONFIRM_DESC_MAX, CONFIRM_YES_MAX, WATCH_HOLD_MS, PROBE_ASK_MS, PROBE_MS,
} from './pluginFrameGate.js';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = makeNonce();
const D1 = 'a'.repeat(24);
const D2 = 'b'.repeat(24);

function rig(opts = {}) {
  const sent = [];
  const detached = [];
  // askMs 默认 0：load 之后当场发 probe，前面这些用例好直接断言；稍等再问的那段在「load 之后稍等再问」几条里单测
  const gate = createFrameGate({ nonce: N, send: (m, tr) => sent.push({ m, tr }), onDetach: (r) => detached.push(r), probeMs: 40, askMs: 0, ...opts });
  const msg = (type, extra = {}) => ({ bp: 1, type, doc: D1, nonce: N, ...extra });
  return { gate, sent, detached, msg };
}

test('makeNonce：crypto.getRandomValues 取够 16 字节以上，每次不同', () => {
  const orig = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let asked = 0;
  globalThis.crypto.getRandomValues = (b) => { asked = b.length; return orig(b); };
  try {
    const a = makeNonce();
    assert.ok(asked >= 16);
    assert.match(a, /^[0-9a-f]{32,}$/);
    assert.notEqual(a, makeNonce());
    makeNonce(4);
    assert.equal(asked, 16, '要的再少也取 16 字节');
  } finally { globalThis.crypto.getRandomValues = orig; }
  assert.throws(() => createFrameGate({ nonce: 'short', send() {} }));
});

test('口令：没带、带错、不是字符串的一律不认，hello 也一样；hello 之前别的消息不认', () => {
  const { gate, msg } = rig();
  assert.equal(gate.receive({ bp: 1, type: 'hello', doc: D1 }), 'drop', '没带口令的 hello');
  assert.equal(gate.receive(msg('hello', { nonce: N.slice(1) + '0' })), 'drop', '口令不对的 hello');
  assert.equal(gate.receive(msg('hello', { nonce: [N] })), 'drop');
  assert.equal(gate.receive(msg('hello', { bp: 2 })), 'drop');
  assert.equal(gate.receive(msg('hello', { doc: '' })), 'drop', 'hello 没有文档号');
  assert.equal(gate.receive(msg('hello', { doc: 'x/y' })), 'drop');
  assert.equal(gate.receive(null), 'drop');
  assert.equal(gate.receive(msg('fetch', { id: 1 })), 'drop', '还没 hello');
  assert.equal(gate.state, 'idle');
  assert.equal(gate.receive(msg('hello')), 'hello');
  assert.equal(gate.state, 'live');
  assert.equal(gate.doc, D1);
  assert.equal(gate.receive(msg('fetch', { id: 1 })), 'msg');
  assert.equal(gate.receive(msg('fetch', { id: 2, nonce: undefined })), 'drop', 'hello 之后照样每条都核口令');
  assert.equal(gate.receive(msg('fetch', { id: 3, doc: D2 })), 'drop', '不是在场文档的');
  assert.equal(gate.receive(msg('fetch', { id: 4, doc: undefined })), 'drop', '没带文档号的');
});

test('宿主发出去的消息一律不带口令（推送、回话、probe），都补上 bp: 1', async () => {
  const { gate, sent, msg } = rig();
  gate.receive(msg('hello'));
  gate.push({ type: 'init', caps: [] });
  gate.push({ type: 'reply', id: 1, value: 1, nonce: N }, ['tr']);
  gate.push({ type: 'event', event: 'x', payload: { nonce: 'p' } });
  gate.load(); gate.load();
  gate.receive(msg('here'));
  assert.ok(sent.length >= 4);
  for (const { m } of sent) {
    assert.equal(m.bp, 1);
    assert.ok(!('nonce' in m), JSON.stringify(m));
    assert.ok(!JSON.stringify(m).includes(N), '整条消息里都没有口令');
  }
  assert.deepEqual(sent[1].tr, ['tr'], 'transfer 原样交给 send');
  assert.ok(sent.some(({ m }) => m.type === 'probe'));
});

test('bye：文档号对得上才算；之后什么都不推、旧文档的消息不认，直到下一个有效 hello', () => {
  const { gate, sent, detached, msg } = rig();
  gate.receive(msg('hello'));
  assert.equal(gate.receive(msg('bye', { doc: D2 })), 'drop', '别的文档号的 bye');
  assert.equal(gate.receive(msg('bye', { nonce: 'x'.repeat(48) })), 'drop', '口令不对的 bye');
  assert.equal(gate.state, 'live');
  assert.deepEqual(detached, []);
  assert.equal(gate.receive(msg('bye')), 'bye');
  assert.deepEqual(detached, ['bye']);
  assert.equal(gate.state, 'idle');
  const n = sent.length;
  for (const type of ['chat.event', 'chat.end', 'event', 'context', 'theme', 'reply']) assert.equal(gate.push({ type }), false, type);
  assert.equal(sent.length, n, 'bye 之后一条都没推');
  assert.equal(gate.receive(msg('fetch', { id: 9 })), 'drop', '走了的文档再发什么都不认');
  assert.equal(gate.receive(msg('bye')), 'drop', '重复的 bye');
  assert.deepEqual(detached, ['bye']);
  // 下一个有效 hello 之后照常
  assert.equal(gate.receive(msg('hello', { doc: D2 })), 'hello');
  assert.equal(gate.push({ type: 'event' }), true);
  assert.equal(sent.length, n + 1);
});

test('文档换了（新 hello 先到、旧 bye 迟到）：旧文档迟到的 bye 和请求都不认，不会摘掉新文档', () => {
  const { gate, detached, msg } = rig();
  gate.receive(msg('hello'));
  assert.equal(gate.receive(msg('hello', { doc: D2 })), 'hello', '调用方据此换代、收旧订阅');
  assert.equal(gate.receive(msg('bye', { doc: D1 })), 'drop');
  assert.equal(gate.receive(msg('fetch', { doc: D1, id: 1 })), 'drop', '旧文档迟到的请求（请求号会和新文档的撞）');
  assert.equal(gate.receive(msg('fetch', { doc: D2, id: 1 })), 'msg');
  assert.equal(gate.state, 'live');
  assert.deepEqual(detached, []);
});

test('load：第一次不管；之后每次先停推、发 probe，在场文档答 here 才按原顺序补推', async () => {
  // SDK 是 load 之后才动态引进来的页面：第一次 load 先到、hello 后到，第二次 load 照样要问
  const late = rig();
  assert.equal(late.gate.load(), false, '还没 hello 时 load 什么都不做');
  late.gate.receive(late.msg('hello'));
  assert.equal(late.gate.load(), true);
  assert.equal(late.sent.at(-1).m.type, 'probe');
  late.gate.close();

  const { gate, sent, detached, msg } = rig();
  gate.receive(msg('hello'));
  assert.equal(gate.load(), false, '第一次 load（hello 之后到）不管');
  assert.equal(gate.state, 'live');
  assert.equal(gate.load(), true);
  assert.equal(gate.state, 'probing');
  assert.deepEqual(sent.map(({ m }) => m.type), ['probe']);
  assert.equal(gate.push({ type: 'chat.event', n: 1 }), true);
  assert.equal(gate.push({ type: 'reply', n: 2 }), true);
  assert.equal(sent.length, 1, '核实期间先排着');
  assert.equal(gate.receive(msg('here', { doc: D2 })), 'drop', '文档号不对的 here');
  assert.equal(gate.receive(msg('fetch', { id: 5, nonce: 'x'.repeat(48) })), 'drop', '口令不对的不算出声');
  assert.equal(gate.state, 'probing');
  assert.equal(gate.receive(msg('here')), 'here');
  assert.equal(gate.state, 'live');
  assert.deepEqual(sent.map(({ m }) => m.type + (m.n ? m.n : '')), ['probe', 'chat.event1', 'reply2']);
  await sleep(80);
  assert.equal(gate.state, 'live', '答过了，到点不摘');
  assert.deepEqual(detached, []);
});

test('核实中在场文档发来别的消息（不是 here）也算出声：当场恢复、按原顺序补推，到点不摘', async () => {
  const { gate, sent, detached, msg } = rig();
  gate.receive(msg('hello'));
  gate.load(); gate.load();
  gate.push({ type: 'chat.event', n: 1 });
  assert.equal(gate.receive(msg('fetch', { id: 5 })), 'msg', '照常办');
  assert.equal(gate.state, 'live');
  assert.deepEqual(sent.map(({ m }) => m.type + (m.n ? m.n : '')), ['probe', 'chat.event1']);
  // 这条请求的回话不用再排
  assert.equal(gate.push({ type: 'reply', n: 5 }), true);
  assert.equal(sent.at(-1).m.type, 'reply');
  assert.equal(gate.receive(msg('here')), 'here', '迟到的 here 照收，无事发生');
  await sleep(80);
  assert.equal(gate.state, 'live');
  assert.deepEqual(detached, []);
});

test('load 之后答不上（换成了不用 SDK 的页面 / 别的站点）：到点同 bye 一样摘掉，排着的一条不发', async () => {
  const { gate, sent, detached, msg } = rig();
  gate.receive(msg('hello'));
  gate.load();
  gate.load();
  gate.push({ type: 'chat.event', secret: 1 });
  gate.push({ type: 'context' });
  await sleep(80);
  assert.equal(gate.state, 'idle');
  assert.deepEqual(detached, ['load']);
  assert.deepEqual(sent.map(({ m }) => m.type), ['probe']);
  assert.equal(gate.push({ type: 'theme' }), false);
  assert.equal(sent.length, 1);
  // 别的文档号带对口令的（比如新页面的请求比 hello 先到）不认，也不叫 reset
  assert.equal(gate.receive(msg('fetch', { id: 1, doc: D2 })), 'drop');
  assert.equal(sent.length, 1);
});

test('摘错了（主线程被占满、here 晚于期限才到）：那份文档再出声回一次 reset，它重新 hello 后照新文档接上', async () => {
  const { gate, sent, detached, msg } = rig();
  gate.receive(msg('hello'));
  gate.load(); gate.load();
  gate.push({ type: 'chat.event', old: true });
  await sleep(80);
  assert.deepEqual(detached, ['load']);
  assert.equal(gate.receive(msg('here')), 'reset', '迟到的 here：叫它重来');
  assert.equal(gate.state, 'idle', '不当场恢复');
  assert.deepEqual(sent.map(({ m }) => m.type), ['probe', 'reset'], '排着的没补推，只发了 reset');
  assert.ok(!('nonce' in sent.at(-1).m) && sent.at(-1).m.bp === 1, 'reset 同样不带口令');
  // 只叫一次：它收到 reset 之前发来的照样不认、不再叫
  assert.equal(gate.receive(msg('fetch', { id: 7 })), 'drop');
  assert.equal(gate.receive(msg('here')), 'drop');
  assert.equal(sent.length, 2);
  // SDK 收到 reset 后重新 hello（同一个文档号）
  assert.equal(gate.receive(msg('hello')), 'hello');
  assert.equal(gate.state, 'live');
  assert.equal(gate.receive(msg('fetch', { id: 8 })), 'msg');
  assert.equal(gate.push({ type: 'reply', id: 8 }), true);
  assert.deepEqual(detached, ['load']);
});

test('摘错了的认回来：排满摘的同样能认回来，普通请求先到也只回 reset、这条不办', () => {
  const { gate, sent, msg } = rig({ queueMax: 1 });
  gate.receive(msg('hello'));
  gate.load(); gate.load();
  gate.push({ type: 'chat.event' });
  assert.equal(gate.push({ type: 'chat.event' }), false, '排满摘掉');
  // 不当 'msg' 交给调用方办：SDK 收到 reset 会把这条拒掉，办了就成了页面以为失败、其实做了
  assert.equal(gate.receive(msg('fetch', { id: 1 })), 'reset');
  assert.deepEqual(sent.map(({ m }) => m.type), ['probe', 'reset']);
});

test('不认回来的：摘掉之后它自己报了 bye（真走了）；文档自己报 bye 摘的；新文档 hello 过之后的旧文档', async () => {
  // 超时摘掉，之后它报 bye
  {
    const { gate, sent, msg } = rig();
    gate.receive(msg('hello'));
    gate.load(); gate.load();
    await sleep(80);
    assert.equal(gate.receive(msg('bye')), 'drop');
    assert.equal(gate.receive(msg('here')), 'drop', 'bye 之后不再认回来');
    assert.deepEqual(sent.map(({ m }) => m.type), ['probe']);
  }
  // 文档自己报 bye 摘的
  {
    const { gate, sent, msg } = rig();
    gate.receive(msg('hello'));
    gate.receive(msg('bye'));
    assert.equal(gate.receive(msg('fetch', { id: 1 })), 'drop');
    assert.equal(sent.length, 0);
  }
  // 超时摘了 D1，然后新文档 D2 hello 了：D1 再出声不叫 reset（D2 报 bye 之后也不叫）
  {
    const { gate, sent, msg } = rig();
    gate.receive(msg('hello'));
    gate.load(); gate.load();
    await sleep(80);
    assert.equal(gate.receive(msg('hello', { doc: D2 })), 'hello');
    assert.equal(gate.receive(msg('fetch', { id: 2 })), 'drop', '旧文档的');
    assert.equal(gate.receive(msg('bye', { doc: D2 })), 'bye');
    assert.equal(gate.receive(msg('here')), 'drop');
    assert.equal(gate.receive(msg('here', { doc: D2 })), 'drop', '报过 bye 的文档不认回来');
    assert.equal(sent.filter(({ m }) => m.type === 'reset').length, 0);
  }
});

test('load 之后新文档的 hello 才到：排着的（推给旧文档的）丢掉，新文档照常，不会到点被摘', async () => {
  const { gate, sent, detached, msg } = rig();
  gate.receive(msg('hello'));
  gate.load();
  gate.load();
  gate.push({ type: 'chat.event', old: true });
  assert.equal(gate.receive(msg('hello', { doc: D2 })), 'hello');
  assert.equal(gate.state, 'live');
  gate.push({ type: 'init' });
  await sleep(80);
  assert.equal(gate.state, 'live');
  assert.deepEqual(detached, []);
  assert.deepEqual(sent.map(({ m }) => m.type), ['probe', 'init'], '旧文档排着的没推给新文档');
});

test('核实期间排太多：当在场文档已经不在了，摘掉', () => {
  const { gate, detached, msg } = rig({ queueMax: 3 });
  gate.receive(msg('hello'));
  gate.load(); gate.load();
  for (let i = 0; i < 3; i++) assert.equal(gate.push({ type: 'chat.event' }), true);
  assert.equal(gate.push({ type: 'chat.event' }), false);
  assert.deepEqual(detached, ['overflow']);
  assert.equal(gate.state, 'idle');
});

test('close（宿主卸载）：不再推，也不叫 onDetach，挂着的核实不会到点再叫', async () => {
  const { gate, sent, detached, msg } = rig();
  gate.receive(msg('hello'));
  gate.load(); gate.load();
  gate.close();
  assert.equal(gate.push({ type: 'event' }), false);
  await sleep(80);
  assert.deepEqual(detached, []);
  assert.equal(sent.length, 1);
});

// —— PluginFrame 的接法 ——
// 同组件：hello → 换代、收旧订阅；onDetach → 换代、收订阅；推送一律 gate.push；回话只回给发请求的那一代
function frame() {
  const posted = [];
  const st = { gen: 0, subs: new Map(), modal: null };
  const gate = createFrameGate({
    nonce: N, probeMs: 40, askMs: 0,
    send: (m) => posted.push(m),
    onDetach: () => { st.gen += 1; st.subs.clear(); st.modal = null; },
  });
  const post = (m) => gate.push(m);
  const live = (g) => g === st.gen;
  function onMessage(m) {
    const kind = gate.receive(m);
    if (kind !== 'hello' && kind !== 'msg') return;
    const g = st.gen;
    if (m.type === 'hello') { st.gen += 1; st.subs.clear(); st.modal = null; post({ type: 'init' }); }
    else if (m.type === 'chat.sub') { st.subs.set(m.sub, g); }
    else if (m.type === 'grant') { st.modal = { g, id: m.id }; }
  }
  // 订阅那头来了一条事件：同 chatSub 的 mine()
  const streamEvent = (sub, ev) => { const g = st.subs.get(sub); if (g != null && live(g)) post({ type: 'chat.event', sub, event: ev }); };
  return { gate, posted, st, onMessage, streamEvent, post };
}
const fm = (type, doc, extra = {}) => ({ bp: 1, type, doc, nonce: N, ...extra });

test('接法：页面换了文档（新的 hello），旧文档的订阅和框收掉，旧订阅的事件不再推', () => {
  const f = frame();
  f.onMessage(fm('hello', D1));
  f.onMessage(fm('chat.sub', D1, { sub: 'c1' }));
  f.onMessage(fm('grant', D1, { id: 2 }));
  f.streamEvent('c1', { type: 'text' });
  assert.equal(f.posted.filter((m) => m.type === 'chat.event').length, 1);
  f.onMessage(fm('hello', D2));
  assert.equal(f.st.subs.size, 0, '旧订阅收掉');
  assert.equal(f.st.modal, null, '旧框收掉');
  f.streamEvent('c1', { type: 'text' });
  assert.equal(f.posted.filter((m) => m.type === 'chat.event').length, 1, '旧订阅的事件没推给新文档');
  // 旧文档迟到的订阅请求不认
  f.onMessage(fm('chat.sub', D1, { sub: 'c9' }));
  assert.ok(!f.st.subs.has('c9'));
});

test('接法：bye 之后订阅收掉、什么都不推（事件、主题、上下文），下一个 hello 才恢复', () => {
  const f = frame();
  f.onMessage(fm('hello', D1));
  f.onMessage(fm('chat.sub', D1, { sub: 'c1' }));
  const g0 = f.st.gen;
  f.onMessage(fm('bye', D1));
  assert.equal(f.st.subs.size, 0);
  assert.ok(f.st.gen > g0, '换代：还没回的请求作废');
  const n = f.posted.length;
  f.streamEvent('c1', { type: 'text' });
  f.post({ type: 'event', event: 'x' });
  f.post({ type: 'theme' });
  f.post({ type: 'context' });
  assert.equal(f.posted.length, n);
  // 没带口令的冒充 hello（比如 iframe 被导航到了别的站点）不能恢复推送
  f.onMessage({ bp: 1, type: 'hello', doc: D2 });
  f.post({ type: 'event' });
  assert.equal(f.posted.length, n);
  f.onMessage(fm('hello', D2));
  assert.equal(f.posted.at(-1).type, 'init');
  f.post({ type: 'event' });
  assert.equal(f.posted.at(-1).type, 'event');
});

test('接法：核实超时摘错了——订阅和框照样收掉；迟到的 here 只换来一条 reset（宿主不办它），SDK 重新 hello 后照新文档接上', async () => {
  const f = frame();
  f.onMessage(fm('hello', D1));
  f.onMessage(fm('chat.sub', D1, { sub: 'c1' }));
  f.gate.load(); f.gate.load();
  await sleep(80);
  assert.equal(f.st.subs.size, 0);
  const g0 = f.st.gen;
  f.onMessage(fm('chat.sub', D1, { sub: 'c2' }));   // 收到 reset 之前发的：只换来 reset，不办
  assert.ok(!f.st.subs.has('c2'));
  assert.equal(f.posted.at(-1).type, 'reset');
  f.onMessage(fm('hello', D1));
  assert.ok(f.st.gen > g0);
  assert.equal(f.posted.at(-1).type, 'init');
  f.onMessage(fm('chat.sub', D1, { sub: 'c3' }));
  assert.ok(f.st.subs.has('c3'));
});

test('PluginFrame.svelte 确实这么接：先过 gate.receive、推送只经 gate.push、地址 # 带 nonce、onDetach 收订阅和框、load 交给门', () => {
  const src = readFileSync(join(here, '..', 'components', 'ext', 'PluginFrame.svelte'), 'utf8');
  const onMsg = src.slice(src.indexOf('async function onMessage('), src.indexOf('switch (m.type)', src.indexOf('async function onMessage(')));
  assert.match(onMsg, /gate\.receive\(m\)/);
  assert.match(onMsg, /if \(kind !== 'hello' && kind !== 'msg'\) return;/);
  assert.ok(onMsg.indexOf('gate.receive') < onMsg.indexOf('FRONT_OPS'), '先核口令再干别的');
  assert.equal((src.match(/postMessage\(/g) || []).length, 1, '只有门的 send 一处直接 postMessage');
  assert.match(src, /const post = \(msg, transfer\) => \{ gate\.push\(msg, transfer\); \};/);
  assert.match(src, /onDetach: \(\) => \{ gen \+= 1; dropSubs\(\); dropModal\(\); \}/);
  assert.match(src, /platform: hostPlatform\(\), nonce \}\)/);
  assert.match(src, /const nonce = makeNonce\(\);/);
  assert.match(src.slice(src.indexOf('function onFrameLoad()'), src.indexOf('function onFrameLoad()') + 300), /gate\.load\(\);/);
  assert.match(src, /gate\.close\(\);/);
  // 确认框和选择器 / 授权框共用一把闩，能按 signal 收掉
  const conf = src.slice(src.indexOf("case 'confirm':"), src.indexOf("case 'open':"));
  assert.match(conf, /modalOp\(m, g, async \(signal\) => replyIf\(g, m\.id, !!\(await confirmBox\(.+, signal\)\)\)\);/);
  assert.ok(!/await uiConfirm\(/.test(conf), 'confirm 不再直接 await uiConfirm');
  assert.match(src, /uiConfirm\(message, \{ \.\.\.opts, signal \}\)/);
  // 宿主发的消息里没有口令字段
  assert.ok(!/nonce:\s*nonce|\.\.\.\{\s*nonce/.test(src.slice(src.indexOf('const gate = createFrameGate'))), '宿主自己拼的消息里不带 nonce');
  // e.source 那一关交给 fromFrame（跳页时旧文档的 bye e.source 是 null），在 gate.receive 之前
  assert.match(onMsg, /if \(!frame \|\| !fromFrame\(e, frame\.contentWindow\)\) return;/);
  assert.ok(!/e\.source !== frame\.contentWindow/.test(src), '不再只认 e.source === contentWindow');
  assert.ok(onMsg.indexOf('fromFrame(') < onMsg.indexOf('gate.receive'));
});

// —— e.source 那一关：跳页时旧文档的 bye ——
// Edge 里插件页点普通链接跳到同站不带 SDK 的页 / 外站，旧文档 pagehide 里发的 bye 到宿主时 e.source === null，
// 和 iframe 的 load 前后只差 1ms 上下（同站多半 bye 先到，外站 load 先到）。这条要是被 e.source 那一关丢掉，门一直挂着，
// load 之后的 probe 就会落进换上来的页面；所以让 bye 进门，load 之后又稍等一下（askMs）才问，load 先到的那种也赶得上。
const WIN = { tag: 'iframe 的 contentWindow' };
const OTHER = { tag: '别的窗口' };
const ev = (source, data) => ({ source, data });

test('fromFrame：出自这个窗口的都收；e.source 为 null 的只收 bye；别的窗口、没有 iframe 的一律不收', () => {
  const bye = { bp: 1, type: 'bye', doc: D1, nonce: N };
  assert.equal(fromFrame(ev(WIN, { bp: 1, type: 'fetch' }), WIN), true);
  assert.equal(fromFrame(ev(WIN, null), WIN), true, '出自这个窗口的交给 receive 去判');
  assert.equal(fromFrame(ev(null, bye), WIN), true);
  assert.equal(fromFrame(ev(undefined, bye), WIN), true);
  for (const type of ['hello', 'here', 'fetch', 'chat.sub', 'confirm', 'nav']) {
    assert.equal(fromFrame(ev(null, { ...bye, type }), WIN), false, type + ' 不放宽');
  }
  assert.equal(fromFrame(ev(null, null), WIN), false);
  assert.equal(fromFrame(ev(null, 'bye'), WIN), false);
  assert.equal(fromFrame(ev(OTHER, bye), WIN), false, '别的窗口发的 bye 不收（父页面、别的 iframe、弹出窗口）');
  assert.equal(fromFrame(ev(null, bye), null), false, 'iframe 没了');
  assert.equal(fromFrame(null, WIN), false);
});

test('接法：跳页时 e.source 为 null 的 bye 进门、门摘掉，换上来的页面 load 之后收不到 probe；口令 / 文档号不对的照样不认', () => {
  // 同 PluginFrame.onMessage 的前两关：fromFrame → gate.receive
  const on = (g, e) => (fromFrame(e, WIN) ? g.gate.receive(e.data) : 'blocked');
  const a = rig();
  a.gate.load();                                   // 第一次 load：插件页
  assert.equal(on(a, ev(WIN, a.msg('hello'))), 'hello');
  a.gate.push({ type: 'init' });
  assert.equal(a.sent.length, 1);
  // 点链接跳走：bye（e.source 已经是 null）比 load 早到
  assert.equal(on(a, ev(null, a.msg('bye', { doc: 'x'.repeat(24) }))), 'drop', '文档号不对');
  assert.equal(on(a, ev(null, a.msg('bye', { nonce: 'f'.repeat(48) }))), 'drop', '口令不对');
  assert.equal(a.detached.length, 0);
  assert.equal(on(a, ev(null, a.msg('bye'))), 'bye');
  assert.deepEqual(a.detached, ['bye']);
  a.gate.load();                                   // 换上来的页面 load
  a.gate.push({ type: 'theme' });
  assert.equal(a.sent.length, 1, '没有 probe，也不往换上来的页面推任何东西');
  assert.ok(!a.sent.some((x) => x.m.type === 'probe'));

  // 对照：bye 被 e.source 那一关丢掉时，load 之后 probe 就发进了换上来的页面
  const b = rig();
  b.gate.load();
  b.gate.receive(b.msg('hello'));
  const old = (e) => (e.source === WIN ? b.gate.receive(e.data) : 'blocked');
  assert.equal(old(ev(null, b.msg('bye'))), 'blocked');
  b.gate.load();
  assert.ok(b.sent.some((x) => x.m.type === 'probe'), '修之前的样子：probe 落进新页面');
  b.gate.close();
});

// —— load 之后稍等再问（askMs）：跳到外站时 load 比 bye 还早到 ——
test('load 之后稍等再问：load 先到、bye 在稍等期间进门——不发 probe，到点也不再问', async () => {
  const on = (g, e) => (fromFrame(e, WIN) ? g.gate.receive(e.data) : 'blocked');
  const a = rig({ askMs: 30, probeMs: 120 });
  a.gate.load();
  a.gate.receive(a.msg('hello'));
  a.gate.push({ type: 'init' });
  assert.equal(a.gate.load(), true);               // 外站页 load（比 bye 早约 1ms）
  assert.equal(a.gate.state, 'probing');
  assert.equal(a.sent.length, 1, '当场不问');
  a.gate.push({ type: 'theme' });                  // 稍等期间照样先排着
  assert.equal(on(a, ev(null, a.msg('bye'))), 'bye');
  assert.deepEqual(a.detached, ['bye']);
  await sleep(160);                                // 过了 askMs 和 probeMs
  assert.equal(a.sent.length, 1, '没有 probe，排着的也不发');
  assert.deepEqual(a.detached, ['bye'], '到点不会再摘一次');
});

test('load 之后稍等再问：稍等期间在场文档出声 / 新文档 hello / 宿主卸载，都不问', async () => {
  // 在场文档先出声（没跳走，只是 iframe 又 load 了一次）：当场恢复、补推，probe 不发
  const a = rig({ askMs: 30, probeMs: 120 });
  a.gate.load();
  a.gate.receive(a.msg('hello'));
  a.gate.load();
  a.gate.push({ type: 'theme', v: 1 });
  assert.equal(a.gate.receive(a.msg('here')), 'here');
  assert.equal(a.gate.state, 'live');
  // 新文档 hello（同站跳到另一个带 SDK 的页）
  const b = rig({ askMs: 30, probeMs: 120 });
  b.gate.load();
  b.gate.receive(b.msg('hello'));
  b.gate.load();
  assert.equal(b.gate.receive(b.msg('hello', { doc: D2 })), 'hello');
  // 宿主卸载
  const c = rig({ askMs: 30, probeMs: 120 });
  c.gate.load();
  c.gate.receive(c.msg('hello'));
  c.gate.load();
  c.gate.close();
  await sleep(160);
  assert.deepEqual(a.sent.map(({ m }) => m.type), ['theme']);
  assert.deepEqual(a.detached, []);
  assert.deepEqual(b.sent, []);
  assert.deepEqual(b.detached, []);
  assert.equal(b.gate.doc, D2);
  assert.deepEqual(c.sent, []);
  assert.deepEqual(c.detached, []);
});

test('load 之后稍等再问：一声不出——askMs 到点发 probe，还不答到 probeMs 照样摘；默认稍等比核实期限短得多', async () => {
  const a = rig({ askMs: 30, probeMs: 120 });
  a.gate.load();
  a.gate.receive(a.msg('hello'));
  a.gate.load();
  await sleep(10);
  assert.deepEqual(a.sent, []);
  await sleep(50);
  assert.deepEqual(a.sent.map(({ m }) => m), [{ type: 'probe', bp: 1 }]);
  assert.equal(a.gate.state, 'probing');
  await sleep(110);
  assert.deepEqual(a.detached, ['load']);
  // 不传 askMs 时用 PROBE_ASK_MS：load 当场不发
  const d = createFrameGate({ nonce: N, send: () => { throw new Error('不该当场发'); }, probeMs: 60_000 });
  d.receive({ bp: 1, type: 'hello', doc: D1, nonce: N });
  d.load();
  d.load();
  d.close();
  assert.ok(PROBE_ASK_MS > 0 && PROBE_ASK_MS * 10 <= PROBE_MS);
});

// —— 对话订阅断线重连的空档：「正看着」留着 ——
// 假的 notices：同 watchFromPage 的接法，pageWatching 判这个会话此刻有没有页面看着
function fakeNotices() {
  const set = new Set();
  return {
    watch(sid, visible) { const w = { sid, visible }; set.add(w); return () => { set.delete(w); }; },
    watching: (sid) => [...set].some((w) => w.sid === sid && w.visible()),
    count: (sid) => [...set].filter((w) => w.sid === sid).length,
    get size() { return set.size; },
  };
}
const S1 = 'sess-0001-aaaa';
const S2 = 'sess-0002-bbbb';

test('createWatchHold：按断掉的订阅号留一条登记；release / releaseSession / clear 撤，visible 照传', () => {
  assert.equal(WATCH_HOLD_MS, 30_000, '同 SDK 退避上限');
  assert.throws(() => createWatchHold({}));
  const n = fakeNotices();
  const h = createWatchHold({ watch: n.watch });
  let front = true;
  h.hold('c1', S1, () => front);
  assert.ok(h.has('c1'));
  assert.equal(n.count(S1), 1);
  assert.equal(n.watching(S1), true);
  front = false;
  assert.equal(n.watching(S1), false, '页面不在前台就不压横幅');
  front = true;
  // 同一订阅号再 hold：换掉，不叠
  h.hold('c1', S1, () => true);
  assert.equal(n.count(S1), 1);
  h.hold('c2', S1, () => true);
  h.hold('c3', S2, () => true);
  assert.equal(h.size, 3);
  assert.equal(h.release('nope'), false);
  assert.equal(h.release('c1'), true);
  assert.equal(n.count(S1), 1);
  assert.equal(h.releaseSession(S1), 1);
  assert.equal(n.count(S1), 0);
  assert.equal(n.count(S2), 1, '别的会话不动');
  h.clear();
  assert.equal(n.size, 0);
  assert.equal(h.size, 0);
  // 空的不登
  h.hold('', S1, () => true);
  h.hold('c9', '', () => true);
  assert.equal(n.size, 0);
});

test('createWatchHold：兜底计时到点自己撤；SDK 又来订阅（refresh）计时从头算', async () => {
  const n = fakeNotices();
  const h = createWatchHold({ watch: n.watch, holdMs: 100 });
  h.hold('c1', S1, () => true);
  h.hold('c2', S2, () => true);
  await sleep(55);
  h.refresh(S1);                                   // 重试了一次（这次没连上）：c1 改到 155ms 才到点
  await sleep(75);                                 // 130ms：c2 已过 100ms
  assert.ok(h.has('c1'), '续过的还在');
  assert.ok(!h.has('c2'), '没续的到点撤了');
  assert.equal(n.count(S2), 0);
  await sleep(70);                                 // 200ms
  assert.ok(!h.has('c1'));
  assert.equal(n.size, 0);
});

test('接法：流断了到重新订阅上，这个会话一直有登记（横幅不弹）；被收掉的不留；页面在空档里 off() 补的 unsub 撤掉留着的', () => {
  // 同 PluginFrame.chatSub：2xx → watch + releaseSession；流自己断了 → hold(sub) 再 unwatch；unsub / 换代收掉 → 只 unwatch
  const n = fakeNotices();
  const holds = createWatchHold({ watch: n.watch, holdMs: 10_000 });
  const live = { c1: true };
  const open = (sub, sid) => { const off = n.watch(sid, () => !!live[sub]); holds.releaseSession(sid); return off; };
  const endNatural = (sub, sid, off) => { if (live[sub]) holds.hold(sub, sid, () => true); delete live[sub]; off(); };
  const seen = [];
  let off = open('c1', S1);
  seen.push(n.watching(S1));
  endNatural('c1', S1, off);                       // 服务端收掉 / 网络断：SDK 退避中
  seen.push(n.watching(S1));                       // ← 这里得是 true：不然这时候完成通知到了横幅就弹
  holds.refresh(S1);                               // 重试 chat.sub 失败（5xx / 断网），还在空档
  seen.push(n.watching(S1));
  live.c2 = true;
  off = open('c2', S1);                            // 重新订阅上
  seen.push(n.watching(S1));
  assert.deepEqual(seen, [true, true, true, true]);
  assert.equal(n.count(S1), 1, '留着的撤了，只剩流上那条');
  assert.equal(holds.size, 0);

  // 被 chat.unsub / 换代收掉的：mine() 已经是假，不留
  delete live.c2;
  endNatural('c2', S1, off);
  assert.equal(n.count(S1), 0);
  assert.equal(holds.size, 0);

  // 流断了、空档里页面 off()：SDK 拿断掉的那个号补 chat.unsub → 撤
  live.c3 = true;
  off = open('c3', S1);
  endNatural('c3', S1, off);
  assert.equal(n.watching(S1), true);
  holds.release('c3');
  assert.equal(n.watching(S1), false);

  // 流断了、空档里页面换代 / 卸载：dropSubs → clear
  live.c4 = true;
  off = open('c4', S2);
  endNatural('c4', S2, off);
  assert.equal(n.count(S2), 1);
  holds.clear();
  assert.equal(n.size, 0);
});

test('PluginFrame.svelte / SDK 确实这么接：先登后撤、流自己断了才留、unsub 和 dropSubs 撤；SDK 空档里 close 补 unsub', () => {
  const src = readFileSync(join(here, '..', 'components', 'ext', 'PluginFrame.svelte'), 'utf8');
  assert.match(src, /const holds = createWatchHold\(\{ watch: watchFromPage \}\);/);
  const sub = src.slice(src.indexOf('async function chatSub('), src.indexOf('function chatUnsub('));
  assert.ok(sub.indexOf('holds.refresh(sid)') > 0 && sub.indexOf('holds.refresh(sid)') < sub.indexOf('await fetch('), '每次重试都续兜底计时');
  const w = sub.indexOf('const unwatch = watchFromPage(');
  assert.ok(w > 0 && sub.indexOf('holds.releaseSession(sid)') > w, '新登记在了才撤留着的');
  const fin = sub.slice(sub.indexOf('} finally {', w));
  assert.match(fin, /if \(mine\(\)\) holds\.hold\(sub, sid, \(\) => live\(g\) && foreground\(\)\);\s*unwatch\(\);/);
  const unsub = src.slice(src.indexOf('function chatUnsub('), src.indexOf('function dropSubs('));
  assert.ok(unsub.indexOf('holds.release(sub)') < unsub.indexOf('if (!ac) return;'), '没在订阅的号（断掉的）也撤');
  const drop = src.slice(src.indexOf('function dropSubs('), src.indexOf('function dropSubs(') + 300);
  assert.match(drop, /holds\.clear\(\);/);

  const sdk = readFileSync(join(here, '..', '..', '..', 'src', 'plugins', 'sdk', 'bridge-plugin.js'), 'utf8');
  // ChatSub.close()：从 chatSubs.delete(this) 到 hostEnded 之间
  const close = sdk.slice(sdk.indexOf('chatSubs.delete(this);'), sdk.indexOf('  hostEnded('));
  assert.ok(close.length > 0 && sdk.indexOf('chatSubs.delete(this);') > 0);
  assert.match(close, /else if \(this\.gapSub\) \{\s*post\(\{ type: 'chat\.unsub', sub: this\.gapSub \}\);/);
  const via = sdk.slice(sdk.indexOf('  async viaHost() {'), sdk.indexOf("addEventListener('online'"));
  assert.match(via, /up = true;\s*this\.gapSub = '';/);
  assert.match(via, /if \(up && !this\.closed\) this\.gapSub = sub;/);
});

// —— 确认框文字 ——
test('confirmParts：标题一行、≤120 字；按钮 ≤20 字；双向控制符一律去掉', () => {
  const c = confirmParts({ title: '清空\n全部\u202e数据' + 'x'.repeat(300), desc: '', yes: '好的'.repeat(30) });
  assert.ok(!c.message.includes('\n'));
  assert.ok(!c.message.includes('\u202e'));
  assert.ok(c.message.startsWith('清空 全部数据'));
  assert.equal(c.message.length, CONFIRM_TITLE_MAX);
  assert.ok(c.message.endsWith('…'));
  assert.equal(c.okLabel.length, CONFIRM_YES_MAX);
  assert.deepEqual(confirmParts(null), { message: '', detail: '', okLabel: '' });
  assert.deepEqual(confirmParts({ title: 3, desc: { toString() { throw new Error('x'); } }, yes: null }), { message: '3', detail: '', okLabel: '' });
});

test('confirmDesc：保留换行、连续空行并成一个、去首尾空行，最多 8 行、总共 500 字', () => {
  assert.equal(confirmDesc('\n\n第一段\r\n\r\n\r\n\n第二段\u2028\u2028第三段\n\n'), '第一段\n\n第二段\n\n第三段');
  assert.equal(confirmDesc('a\u202eb\u2066c\td'), 'abc d', '行内控制符、双向控制符');
  const many = Array.from({ length: 20 }, (_, i) => '行' + i).join('\n');
  const d = confirmDesc(many);
  assert.equal(d.split('\n').length, CONFIRM_DESC_LINES);
  assert.ok(d.endsWith('…'), '截掉了要有省略号');
  assert.ok(d.startsWith('行0\n行1'));
  // 第 8 行是空行：不留在末尾
  const blanky = ['1', '', '2', '', '3', '', '4', '', '5', '', '6'].join('\n');
  const b = confirmDesc(blanky);
  assert.ok(b.split('\n').length <= CONFIRM_DESC_LINES);
  assert.ok(b.endsWith('…'));
  assert.ok(b.split('\n').at(-1).replace('…', '').length > 0, '末行不是空行');
  const long = confirmDesc('字'.repeat(5000) + '\n' + '尾');
  assert.ok(long.length <= CONFIRM_DESC_MAX);
  assert.ok(long.endsWith('…'));
  const total = confirmDesc(Array.from({ length: 8 }, () => '长'.repeat(200)).join('\n'));
  assert.ok(total.length <= CONFIRM_DESC_MAX);
  assert.ok(total.endsWith('…'));
  // 代理对不劈开
  const emo = confirmDesc('😀'.repeat(400));
  assert.ok(emo.length <= CONFIRM_DESC_MAX);
  assert.ok(!/[\ud800-\udbff]…$/.test(emo));
  assert.equal(confirmDesc(undefined), '');
  assert.equal(confirmDesc('   \n  \n'), '');
});
