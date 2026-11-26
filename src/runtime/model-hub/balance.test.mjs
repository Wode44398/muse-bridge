import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceSupported, readServiceBalance, _resetBalanceForTests } from './balance.mjs';

// 余额接口都是固定的官方地址：换掉全局 fetch，按地址回假数据，顺手记下请求头
function fakeFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.authorization });
    const r = routes[String(url)];
    if (!r) return new Response('{"error":{"message":"not found"}}', { status: 404 });
    const [status, body] = typeof r === 'function' ? r() : r;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const svc = (baseUrl, extra = {}) => ({ id: 'h-1', name: 'x', kind: 'openai', baseUrl, useProxy: false, ...extra });
const line = (id = 'l-1', extra = {}) => ({ id, label: 'Key 1', baseUrl: '', enabled: true, ...extra });

test('能查余额的服务商按地址认；ChatGPT 订阅、认不出的、Kimi Code 都不查', () => {
  assert.equal(balanceSupported(svc('https://api.deepseek.com/anthropic')), true);
  assert.equal(balanceSupported(svc('https://openrouter.ai/api/v1')), true);
  assert.equal(balanceSupported(svc('https://api.siliconflow.com/v1')), true);
  assert.equal(balanceSupported(svc('https://api.moonshot.ai/v1')), true);
  assert.equal(balanceSupported(svc('https://ai-gateway.vercel.sh/v1')), true);
  assert.equal(balanceSupported(svc('https://api.poe.com/v1')), true);
  assert.equal(balanceSupported(svc('https://api.kimi.com/coding/v1')), false);
  assert.equal(balanceSupported(svc('https://api.anthropic.com')), false);
  assert.equal(balanceSupported(svc('http://10.0.0.2:30001/v1')), false);
  assert.equal(balanceSupported(svc('https://api.openai.com/v1', { kind: 'chatgpt' })), false);
});

test('DeepSeek：带 Bearer 去查，拆出充值与赠送', async () => {
  _resetBalanceForTests();
  const f = fakeFetch({ 'https://api.deepseek.com/user/balance': [200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '17.47', granted_balance: '1.00', topped_up_balance: '16.47' }] }] });
  try {
    const { balance } = await readServiceBalance([{ service: svc('https://api.deepseek.com/anthropic'), line: line(), key: 'sk-abc123' }]);
    assert.equal(f.calls[0].auth, 'Bearer sk-abc123');
    assert.equal(balance[0].ok, true);
    assert.deepEqual(balance[0].items[0], { kind: 'balance', amount: 17.47, currency: 'CNY', parts: [{ kind: 'topup', amount: 16.47 }, { kind: 'granted', amount: 1 }] });
  } finally { f.restore(); }
});

test('OpenRouter：账户余额 + 这把 Key 的限额；/credits 不让查时只报限额', async () => {
  _resetBalanceForTests();
  const f = fakeFetch({
    'https://openrouter.ai/api/v1/credits': [200, { data: { total_credits: 40, total_usage: 34.634 } }],
    'https://openrouter.ai/api/v1/key': [200, { data: { limit: 100, limit_remaining: 66.97, limit_reset: 'monthly' } }],
  });
  try {
    const { balance } = await readServiceBalance([{ service: svc('https://openrouter.ai/api/v1'), line: line(), key: 'k' }]);
    assert.deepEqual(balance[0].items.map((i) => [i.kind, i.amount]), [['balance', 5.37], ['keyLimit', 66.97]]);
    assert.equal(balance[0].items[1].reset, 'monthly');
  } finally { f.restore(); }
  _resetBalanceForTests();
  const g = fakeFetch({
    'https://openrouter.ai/api/v1/credits': [403, { error: { message: 'forbidden' } }],
    'https://openrouter.ai/api/v1/key': [200, { data: { limit: null, limit_remaining: null } }],
  });
  try {
    const { balance } = await readServiceBalance([{ service: svc('https://openrouter.ai/api/v1'), line: line(), key: 'k' }]);
    assert.equal(balance[0].ok, false);
    assert.match(balance[0].error, /HTTP 403/);
  } finally { g.restore(); }
});

test('国际站按美元、国内站按人民币；线路自己填的地址优先', async () => {
  _resetBalanceForTests();
  const f = fakeFetch({
    'https://api.siliconflow.cn/v1/user/info': [200, { code: 20000, data: { balance: '0.88', chargeBalance: '88.00', totalBalance: '88.88' } }],
    'https://api.moonshot.ai/v1/users/me/balance': [200, { code: 0, data: { available_balance: 49.5, voucher_balance: 46.5, cash_balance: 3 } }],
  });
  try {
    const { balance } = await readServiceBalance([
      { service: svc('https://api.siliconflow.cn/v1'), line: line('a'), key: 'k1' },
      { service: { ...svc('https://api.moonshot.cn/anthropic'), id: 'h-2' }, line: line('b', { baseUrl: 'https://api.moonshot.ai/anthropic' }), key: 'k2' },
    ]);
    assert.deepEqual(balance.map((b) => [b.items[0].amount, b.items[0].currency]), [[88.88, 'CNY'], [49.5, 'USD']]);
  } finally { f.restore(); }
});

test('Vercel 与 Poe', async () => {
  _resetBalanceForTests();
  const f = fakeFetch({
    'https://ai-gateway.vercel.sh/v1/credits': [200, { balance: '95.50', total_used: '4.50' }],
    'https://api.poe.com/usage/current_balance': [200, { current_point_balance: 295932 }],
  });
  try {
    const { balance } = await readServiceBalance([
      { service: svc('https://ai-gateway.vercel.sh/v1'), line: line('a'), key: 'k1' },
      { service: { ...svc('https://api.poe.com/v1'), id: 'h-2' }, line: line('b'), key: 'k2' },
    ]);
    assert.deepEqual(balance[0].items[0], { kind: 'balance', amount: 95.5, currency: 'USD', parts: [{ kind: 'used', amount: 4.5 }] });
    assert.deepEqual(balance[1].items[0], { kind: 'points', amount: 295932, currency: '' });
  } finally { f.restore(); }
});

test('报错里回显的 Key 抹掉；60 秒内走缓存，force 和换 Key 都重查', async () => {
  _resetBalanceForTests();
  let n = 0;
  const key = 'sk-secret-should-not-leak';
  const f = fakeFetch({ 'https://api.deepseek.com/user/balance': () => { n += 1; return n === 1 ? [401, { error: { message: `bad key ${key}` } }] : [200, { balance_infos: [{ currency: 'CNY', total_balance: '1' }] }]; } });
  let t = 1000;
  const now = () => t;
  const e = (k = key) => [{ service: svc('https://api.deepseek.com'), line: line(), key: k }];
  try {
    const a = await readServiceBalance(e(), { now });
    assert.equal(a.balance[0].ok, false);
    assert.ok(!a.balance[0].error.includes(key), a.balance[0].error);
    assert.match(a.balance[0].error, /Key 无效/);
    t += 30_000;
    assert.equal((await readServiceBalance(e(), { now })).balance[0].ok, false);
    assert.equal(n, 1);
    assert.equal((await readServiceBalance(e(), { now, force: true })).balance[0].ok, true);
    await readServiceBalance(e('sk-another-key-xyz'), { now });
    assert.equal(n, 3);
  } finally { f.restore(); }
});
