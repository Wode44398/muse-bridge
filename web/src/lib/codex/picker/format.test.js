import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtCtx, fmtTok, windowLabel, resetText, quotaRows, fiveHourLeft, needSearch, pickerGroups, accountsText } from './format.js';

test('上下文大小：K / M，猜的带 ≈', () => {
  assert.equal(fmtCtx(400000), '400K');
  assert.equal(fmtCtx(272000), '272K');
  assert.equal(fmtCtx(1000000), '1M');
  assert.equal(fmtCtx(1048576), '1M');
  assert.equal(fmtCtx(1500000), '1.5M');
  assert.equal(fmtCtx(256000, true), '≈256K');
  assert.equal(fmtCtx(null), '');
});

test('token 数', () => {
  assert.equal(fmtTok(98123), '98k');
  assert.equal(fmtTok(258000), '258k');
  assert.equal(fmtTok(1240000), '1.2M');
  assert.equal(fmtTok(850), '850');
});

test('额度窗口名', () => {
  assert.equal(windowLabel(300), '5 小时');
  assert.equal(windowLabel(10080), '每周');
  assert.equal(windowLabel(1440), '每天');
  assert.equal(windowLabel(null, 'secondary'), '每周');
});

test('重置时间：一天内写相对，再远写星期几', () => {
  const now = new Date(2026, 10, 25, 10, 0, 0).getTime();   // 周三
  const sec = (ms) => Math.floor(ms / 1000);
  assert.equal(resetText(sec(now + 130 * 60e3), now), '2 小时 10 分后重置');
  assert.equal(resetText(sec(now + 35 * 60e3), now), '35 分后重置');
  assert.equal(resetText(sec(now + 3 * 3600e3), now), '3 小时后重置');
  assert.equal(resetText(sec(new Date(2026, 10, 26, 9, 0).getTime() + 86400e3), now), '周五 09:00 重置');
  assert.equal(resetText(0, now), '');
});

test('额度行：主窗口 5 小时、次窗口每周', () => {
  const now = Date.now();
  const rows = quotaRows({ available: true, buckets: [{ id: 'codex', name: 'Codex', windows: [
    { id: 'primary', usedPercent: 36, remainingPercent: 64, durationMins: 300, resetsAt: null },
    { id: 'secondary', usedPercent: 19, remainingPercent: 81, durationMins: 10080, resetsAt: null },
    { id: 'x', usedPercent: null, remainingPercent: null },
  ] }] }, now);
  assert.deepEqual(rows.map((r) => [r.label, r.left]), [['5 小时', 64], ['每周', 81]]);
  assert.equal(fiveHourLeft({ buckets: [{ id: 'codex', windows: [{ id: 'primary', durationMins: 300, remainingPercent: 64 }] }] }), 64);
  assert.equal(fiveHourLeft(null), null);
});

const G = [
  { key: 'pool', name: 'ChatGPT', items: [{ id: 'a', name: 'GPT-6 Luna' }, { id: 'b', name: 'GPT-5.6 Terra', isDefault: true }] },
  { key: 'hub:or', name: 'OpenRouter', items: Array.from({ length: 12 }, (_, i) => ({ id: 'or/' + i, name: 'Model ' + i, isDefault: i === 3 })) },
];

test('列表：默认排第一、超过 8 个收起、选中的露出来', () => {
  const out = pickerGroups(G, { selected: 'or/10' });
  assert.equal(out[0].shown[0].id, 'b');
  assert.equal(out[1].shown[0].id, 'or/3');
  assert.equal(out[1].shown.length, 7);
  assert.equal(out[1].shown[6].id, 'or/10');
  assert.equal(out[1].more, 5);
  const open = pickerGroups(G, { expanded: new Set(['hub:or']) });
  assert.equal(open[1].shown.length, 12);
  assert.equal(open[1].more, 0);
});

test('列表：搜型号名或服务名', () => {
  assert.deepEqual(pickerGroups(G, { q: 'luna' }).map((g) => g.shown.map((m) => m.id)), [['a']]);
  const svc = pickerGroups(G, { q: 'openrouter' });
  assert.equal(svc.length, 1);
  assert.equal(svc[0].shown.length, 12);   // 搜的时候不收起
  assert.equal(needSearch(G), true);
  assert.equal(needSearch([G[0]]), false);
});

test('模型在哪些号上：只有多号时才标', () => {
  const acc = [{ id: 'x', label: 'A 号' }, { id: 'y', label: 'B 号' }];
  assert.equal(accountsText(['x', 'y'], acc), 'A 号、B 号');
  assert.equal(accountsText(['x'], [acc[0]]), '');
  assert.equal(accountsText([], acc), '');
});
