import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agyAccLabel,
  agyPlanPill,
  agyPlanChoices,
  agyUsageTone,
  agyPoolResetIn,
  agyPoolResetAt,
  agyRouteStrategies,
  agyWhyText,
  agyRouteLogTitle,
  agyRouteLogSub,
  agySwitchToastText,
} from './pool-logic.js';

test('agyAccLabel 与 agyPlanPill：默认命名本地化、自定义名原样、档位徽标归一化', () => {
  assert.equal(agyAccLabel('默认账号'), '默认账号');
  assert.equal(agyAccLabel('账号 3'), '账号 3');
  assert.equal(agyAccLabel('主号 Ultra'), '主号 Ultra');

  assert.equal(agyPlanPill('ultra'), 'Ultra');
  assert.equal(agyPlanPill('PRO'), 'Pro');
  assert.equal(agyPlanPill('free'), 'Free');
  assert.equal(agyPlanPill(''), '');
  assert.equal(agyPlanChoices().length, 4);
});

test('agyUsageTone 与重置时间格式化', () => {
  assert.equal(agyUsageTone({ usedPct: 40 }), 'ok');
  assert.equal(agyUsageTone({ usedPct: 80 }), 'amber');
  assert.equal(agyUsageTone({ usedPct: 100 }), 'red');

  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(agyPoolResetIn(now + 15 * 60_000, now), '15 分钟后重置');
  assert.equal(agyPoolResetIn(now + 4 * 3600_000, now), '4 小时后重置');
  assert.equal(agyPoolResetIn(now + 72 * 3600_000, now), '3 天后重置');
  assert.equal(agyPoolResetIn(now - 1000, now), '');

  assert.equal(agyPoolResetAt(now + 20 * 60_000, now), '20 分钟后重置');
  assert.match(agyPoolResetAt(now + 3 * 3600_000, now), /^\d{2}:\d{2} 重置$/);
  assert.match(agyPoolResetAt(now + 30 * 3600_000, now), /^周[日一二三四五六] \d{2}:\d{2} 重置$/);
});

test('路由理由、分派日志与切号 Toast 文案', () => {
  assert.equal(agyRouteStrategies().map((s) => s.value).join(','), 'smart,fill,primary');
  assert.equal(agyWhyText('gemini_5h'), 'Gemini 5 小时额度已满');
  assert.equal(agyWhyText('near:tp_weekly'), 'Claude / GPT 每周额度快满了');
  assert.equal(agyWhyText('primary_back'), '首选号额度已恢复');

  const logEntry = {
    kind: 'move',
    sid: '12345678-abcd',
    label: '重构代理层',
    group: '3p',
    from: 'ag-1',
    to: 'ag-2',
    fromLabel: '主号',
    toLabel: '备号',
    reason: 'tp_5h',
  };
  assert.equal(agyRouteLogTitle(logEntry), '重构代理层');
  assert.equal(agyRouteLogSub(logEntry, (_id, fb) => fb), 'Claude / GPT · 主号 → 备号 · Claude / GPT 5 小时额度已满');
  assert.equal(agySwitchToastText({ toLabel: '备号', reason: 'tp_5h' }), '已自动切到「备号」（Claude / GPT 5 小时额度已满）');
});
