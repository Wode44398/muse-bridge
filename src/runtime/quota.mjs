// 额度检查（三端拆分 P4）：注册用户的 Claude 轮受「每天 / 最近 7 天」的轮数与花费上限约束，
// 全服注册用户合计同时在跑的轮数也可以设上限。管理员不受限；快照访客另有自己的全局通道上限。
// 默认额度在策略（runtime/policy.mjs，控制台「额度与注册」），个人覆盖在账号上（users.setQuota）。
// Gemini / dimensio 等不走这里——共享的是 Claude 订阅，额度只管它。
import { getPolicy, LIMIT_KEYS } from './policy.mjs';
import { getUser, usageWindow } from '../users.mjs';

// 这个人实际生效的额度：默认打底，个人覆盖里写了的键覆盖（0 = 这一项对他不限）。
export function limitsFor(name) {
  const out = { ...getPolicy().quota };
  const own = getUser(name)?.quota;
  if (own && typeof own === 'object') {
    for (const k of LIMIT_KEYS) {
      if (!(k in own)) continue;
      const v = Number(own[k]);
      if (v > 0) out[k] = v; else delete out[k];
    }
  }
  return out;
}

export function quotaState(name) {
  const { today, week } = usageWindow(name);
  return { limits: limitsFor(name), today, week, timezone: getPolicy().timezone };
}

const money = (v) => '$' + (Math.round(v * 100) / 100).toFixed(2);

// 开跑前查一次：超了返回 { title, message }（直接给人看），没超返回 null。
export function quotaBlock(name) {
  const { limits: l, today, week } = quotaState(name);
  const tail = '需要更多额度请联系管理员。';
  if (l.dayTurns && today.turns >= l.dayTurns) {
    return { title: '今天的额度用完了', message: `今天已经跑了 ${today.turns} 轮，每天上限 ${l.dayTurns} 轮，明天 0 点恢复。${tail}` };
  }
  if (l.dayCostUsd && today.costUsd >= l.dayCostUsd) {
    return { title: '今天的额度用完了', message: `今天已用 ${money(today.costUsd)}，每天上限 ${money(l.dayCostUsd)}，明天 0 点恢复。${tail}` };
  }
  if (l.weekTurns && week.turns >= l.weekTurns) {
    return { title: '这 7 天的额度用完了', message: `最近 7 天已经跑了 ${week.turns} 轮，上限 ${l.weekTurns} 轮；最早那天的用量滑出 7 天窗口后逐步恢复。${tail}` };
  }
  if (l.weekCostUsd && week.costUsd >= l.weekCostUsd) {
    return { title: '这 7 天的额度用完了', message: `最近 7 天已用 ${money(week.costUsd)}，上限 ${money(l.weekCostUsd)}；最早那天的用量滑出 7 天窗口后逐步恢复。${tail}` };
  }
  return null;
}
