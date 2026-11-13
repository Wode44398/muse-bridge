// HsKit.js 里不依赖组件状态的纯逻辑：去向改动的计算、Claude 收不收某个模型、粘贴 Key 的清洗、连接改动的判断、置顶排序。
// 跑法：node --test web/src/components/modelhub/HsKit.test.js（不碰数据根、不起浏览器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_MIN_CTX, claudeBlock, ordAgents, planAssign, pinFirst, cleanKey, pasteKey, connMoved, sameSet,
} from './HsKit.js';

const TEXT = ['claude', 'dimensio'];
const row = (id, agents = [], block = '') => ({ id, agents, block });
// 与 HubService 的 blockOf 同形：去向整体用不了（off）优先，其次 Claude 按行的规则
const blockOf = (off = {}) => (a, r) => off[a] || (a === 'claude' && r.block ? 'claude:' + r.block : '');

test('claudeBlock：ID 规则与上下文窗口下限', () => {
  assert.equal(CLAUDE_MIN_CTX, 4096);
  assert.equal(claudeBlock('openai/gpt-5', 400000), '');
  assert.equal(claudeBlock('anthropic/claude-fable-5.2:batch', 0), '', '没报窗口的不拦');
  assert.equal(claudeBlock('a/b', undefined), '');
  assert.equal(claudeBlock('~anthropic/claude-sonnet-latest', 200000), 'id');
  assert.equal(claudeBlock('模型#1', 200000), 'id');
  assert.equal(claudeBlock('x'.repeat(201), 200000), 'id');
  assert.equal(claudeBlock('', 200000), 'id');
  assert.equal(claudeBlock('openai/gpt-3.5-turbo-instruct', 4095), 'ctx');
  assert.equal(claudeBlock('openai/gpt-3.5-turbo-instruct', 4096), '');
  assert.equal(claudeBlock('local/tiny', 1024), 'ctx');
  assert.equal(claudeBlock('~bad', 1024), 'id', 'ID 不合优先报 ID');
});

test('ordAgents：去重、固定顺序、丢掉不认识的', () => {
  assert.deepEqual(ordAgents(['studio', 'dimensio', 'claude', 'claude', 'x']), ['claude', 'dimensio', 'studio']);
  assert.deepEqual(ordAgents(null), []);
});

test('planAssign：一致的勾选——去向改成点亮的；取消点亮 = 批量取消添加', () => {
  const rows = [row('a', ['claude']), row('b', ['claude'])];
  // 再点亮 dimensio
  let p = planAssign(rows, TEXT, ['claude', 'dimensio'], true, blockOf());
  assert.deepEqual(p.changes, [{ id: 'a', agents: ['claude', 'dimensio'] }, { id: 'b', agents: ['claude', 'dimensio'] }]);
  assert.deepEqual(p.skipped, {});
  // 全部取消
  p = planAssign(rows, TEXT, [], true, blockOf());
  assert.deepEqual(p.changes, [{ id: 'a', agents: [] }, { id: 'b', agents: [] }]);
  // 没动：没有改动
  p = planAssign(rows, TEXT, ['claude'], true, blockOf());
  assert.deepEqual(p.changes, []);
});

test('planAssign：一致时只动这一栏的去向，别栏的去向原样留着', () => {
  const p = planAssign([row('img', ['studio'])], ['studio'], [], true, blockOf());
  assert.deepEqual(p.changes, [{ id: 'img', agents: [] }]);
  // 假想一行同时带别栏的去向：只拿掉本栏的
  const q = planAssign([row('m', ['claude', 'studio'])], TEXT, ['dimensio'], true, blockOf());
  assert.deepEqual(q.changes, [{ id: 'm', agents: ['dimensio', 'studio'] }]);
});

test('planAssign：不一致的勾选——只把点亮的加上去，不动已有的', () => {
  const rows = [row('a', ['claude']), row('b', ['dimensio']), row('c', [])];
  const p = planAssign(rows, TEXT, ['dimensio'], false, blockOf());
  assert.deepEqual(p.changes, [{ id: 'a', agents: ['claude', 'dimensio'] }, { id: 'c', agents: ['dimensio'] }]);
  // 什么都没点亮：不改
  assert.deepEqual(planAssign(rows, TEXT, [], false, blockOf()).changes, []);
});

test('planAssign：点亮 Claude 之后勾进来一个 Claude 不收的——跳过它，不连累整批（两种勾选顺序算出来一样）', () => {
  const A = row('openai/gpt-5'), B = row('~anthropic/claude-sonnet-latest', [], 'id');
  // 先 A、点亮 Claude、再 B —— 与 —— 先 B、再 A、点亮 Claude：到这里的输入相同，结果自然相同
  for (const rows of [[A, B], [B, A]]) {
    const p = planAssign(rows, TEXT, ['claude'], true, blockOf());
    assert.deepEqual(p.changes, [{ id: 'openai/gpt-5', agents: ['claude'] }]);
    assert.deepEqual(p.skipped, { claude: { n: 1, why: 'claude:id' } });
  }
  // 两个去向都点亮：B 只进 dimensio
  const p = planAssign([A, B], TEXT, ['claude', 'dimensio'], true, blockOf());
  assert.deepEqual(p.changes, [
    { id: 'openai/gpt-5', agents: ['claude', 'dimensio'] },
    { id: '~anthropic/claude-sonnet-latest', agents: ['dimensio'] },
  ]);
  assert.equal(p.skipped.claude.n, 1);
  // 勾中的全都不收：没有改动（保存按钮点不了），skipped 记着原因（操作条上写出来）
  const q = planAssign([B, row('tiny', [], 'ctx')], TEXT, ['claude'], true, blockOf());
  assert.deepEqual(q.changes, []);
  assert.deepEqual(q.skipped, { claude: { n: 2, why: 'claude:id' } });
});

test('planAssign：上下文窗口太小的文本模型不进 Claude，照样能进 dimensio', () => {
  const small = row('openai/gpt-3.5-turbo-instruct', [], claudeBlock('openai/gpt-3.5-turbo-instruct', 4095));
  assert.equal(small.block, 'ctx');
  const p = planAssign([small], TEXT, ['claude', 'dimensio'], true, blockOf());
  assert.deepEqual(p.changes, [{ id: small.id, agents: ['dimensio'] }]);
  assert.deepEqual(p.skipped, { claude: { n: 1, why: 'claude:ctx' } });
});

test('planAssign：已经在这个去向里的行不因为「加不进去」被悄悄拿掉', () => {
  // 老数据：一个现在不合规的模型已经在 Claude 里。一致的勾选、片预填着 Claude、用户什么都没动 → 不该冒出一条「移除」
  const old = row('~legacy', ['claude'], 'id');
  let p = planAssign([old], TEXT, ['claude'], true, blockOf());
  assert.deepEqual(p.changes, []);
  assert.deepEqual(p.skipped, {});
  // 用户自己取消点亮才移除
  p = planAssign([old], TEXT, [], true, blockOf());
  assert.deepEqual(p.changes, [{ id: '~legacy', agents: [] }]);
});

test('planAssign：去向整体用不了（dimensio 没开）——开着的片不拦着改别的去向', () => {
  const off = blockOf({ dimensio: 'dimensio 未开启' });
  // 两行都已在 claude + dimensio（一致，片都预填着），用户只取消 Claude：dimensio 原样留着，保存得了
  const rows = [row('a', ['claude', 'dimensio']), row('b', ['claude', 'dimensio'])];
  let p = planAssign(rows, TEXT, ['dimensio'], true, off);
  assert.deepEqual(p.changes, [{ id: 'a', agents: ['dimensio'] }, { id: 'b', agents: ['dimensio'] }]);
  assert.deepEqual(p.skipped, {});
  // 没在 dimensio 里的行加不进去：跳过并记下
  p = planAssign([row('c', [])], TEXT, ['claude', 'dimensio'], true, off);
  assert.deepEqual(p.changes, [{ id: 'c', agents: ['claude'] }]);
  assert.deepEqual(p.skipped, { dimensio: { n: 1, why: 'dimensio 未开启' } });
});

test('pinFirst：快照里的置顶、tail 的垫底、其余原序；都没有时原样返回', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, other: id === 'b' }));
  const ids = (l) => l.map((r) => r.id).join('');
  assert.equal(ids(pinFirst(list, new Set(['d', 'c']), (r) => r.other)), 'cdaeb');
  assert.equal(ids(pinFirst(list, new Set(), (r) => r.other)), 'acdeb');
  assert.equal(ids(pinFirst(list, new Set(['e']), null)), 'eabcd');
  assert.equal(pinFirst(list, new Set(), null), list, '没有要挪的：同一个数组');
  assert.equal(pinFirst(list, new Set(['zz']), null), list);
});

test('cleanKey：去掉全部空白与控制字符，不只是首尾', () => {
  const key = 'sk-ant-api03-' + 'A'.repeat(40) + 'B'.repeat(54);
  assert.equal(cleanKey('  ' + key + '\n'), key);
  assert.equal(cleanKey('sk-ant-api03-' + 'A'.repeat(40) + '\n' + 'B'.repeat(54)), key, '夹在中间的换行');
  assert.equal(cleanKey('sk-\r\nab\tcd ef'), 'sk-abcdef');
  assert.equal(cleanKey('sk-\u0000a\u007fb\u0085c'), 'sk-abc', 'NUL、DEL、C1 控制字符');
  assert.equal(cleanKey('sk- a　b​c⁠d﻿e f'), 'sk-abcdef', '不间断 / 全角空格、零宽字符、行分隔符');
  assert.equal(cleanKey(null), '');
  assert.equal(cleanKey('sk-正常_.-/+=:'), 'sk-正常_.-/+=:', '可见字符一律不动（合不合法由服务端判）');
});

test('pasteKey：插到选区处，整串清洗；返回的 value 就是该同时写进状态和输入框的那一串', () => {
  // 空框粘贴带换行的 Key
  let r = pasteKey('', 0, 0, ' sk-abc\ndef \n');
  assert.deepEqual(r, { value: 'sk-abcdef', caret: 9 });
  // 光标在中间插入
  r = pasteKey('sk-XX', 3, 3, 'a b');
  assert.deepEqual(r, { value: 'sk-abXX', caret: 5 });
  // 替换选区
  r = pasteKey('sk-OLD-tail', 3, 6, '\tNEW\r\n');
  assert.deepEqual(r, { value: 'sk-NEW-tail', caret: 6 });
  // 框里原有的空白（打字带进来的）也一并去掉，光标按清洗后的位置算
  r = pasteKey(' sk- ', 5, 5, 'x y');
  assert.deepEqual(r, { value: 'sk-xy', caret: 5 });
  // 选区越界 / 缺省：按末尾追加
  r = pasteKey('sk-', undefined, undefined, 'z');
  assert.deepEqual(r, { value: 'sk-z', caret: 4 });
  r = pasteKey('sk-', 99, 2, 'z');
  assert.deepEqual(r, { value: 'sk-z', caret: 4 });
  // 只粘了空白：值不变
  assert.equal(pasteKey('sk-abc', 6, 6, ' \n\t').value, 'sk-abc');
  // 结果里不会再有空白 / 控制字符
  assert.equal(/[\s\u0000-\u001f\u007f]/.test(pasteKey('a b', 1, 1, 'c\nd\u0000').value), false);
});

test('connMoved：保存连接时，识别要用的那一段变没变', () => {
  const svc = { baseUrl: 'https://openrouter.ai/api/v1', lines: [{ id: 'l1', enabled: true, hasKey: true }, { id: 'l2', enabled: true, hasKey: true }] };
  const ed = (over = {}, lines = null) => ({
    baseUrl: svc.baseUrl,
    lines: lines || svc.lines.map((l) => ({ ...l, key: '' })),
    ...over,
  });
  assert.equal(connMoved(ed(), svc), '');
  assert.equal(connMoved(ed({ baseUrl: 'openrouter.ai/api/v1/' }), svc), '', '只是写法不同（没写 https、多个斜杠）');
  assert.equal(connMoved(ed({ baseUrl: 'https://api.deepseek.com/v1' }), svc), 'url');
  // 地址和 Key 都改了：按地址算（要自动重新识别）
  assert.equal(connMoved(ed({ baseUrl: 'https://api.deepseek.com/v1' }, [{ id: 'l1', enabled: true, hasKey: true, key: 'sk-new' }]), svc), 'url');
  // 更换了某一把 Key
  assert.equal(connMoved(ed({}, [{ id: 'l1', enabled: true, hasKey: true, key: ' sk-new ' }, { id: 'l2', enabled: true, hasKey: true, key: '' }]), svc), 'key');
  // 新加了一把 Key
  assert.equal(connMoved(ed({}, [...svc.lines.map((l) => ({ ...l, key: '' })), { id: '', enabled: true, hasKey: false, key: 'sk-3' }]), svc), 'key');
  // 新加了一行但没填 Key：不算（保存时也不提交它）
  assert.equal(connMoved(ed({}, [...svc.lines.map((l) => ({ ...l, key: '' })), { id: '', enabled: true, hasKey: false, key: '  ' }]), svc), '');
  // 停用 / 移除了识别用的第一条线路：识别会换一把 Key
  assert.equal(connMoved(ed({}, [{ id: 'l1', enabled: false, hasKey: true, key: '' }, { id: 'l2', enabled: true, hasKey: true, key: '' }]), svc), 'key');
  assert.equal(connMoved(ed({}, [{ id: 'l2', enabled: true, hasKey: true, key: '' }]), svc), 'key');
  // 停用的是后面那条：识别用的还是第一条
  assert.equal(connMoved(ed({}, [{ id: 'l1', enabled: true, hasKey: true, key: '' }, { id: 'l2', enabled: false, hasKey: true, key: '' }]), svc), '');
  assert.equal(connMoved(null, svc), '');
  assert.equal(connMoved(ed(), null), '');
});

test('sameSet：顺序无关', () => {
  assert.equal(sameSet(['claude', 'dimensio'], ['dimensio', 'claude']), true);
  assert.equal(sameSet(['claude'], ['claude', 'dimensio']), false);
  assert.equal(sameSet([], []), true);
});
