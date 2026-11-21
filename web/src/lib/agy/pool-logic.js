// Antigravity 多号池纯格式化与文案辅助函数（无 DOM / Svelte 依赖，供单测与桌面 / iOS 视图共用）。

import { t } from '../i18n.js';

const AUTO_LABEL_RE = /^(?:默认账号|账号 (\d+))$/; // i18n-ignore 匹配服务端默认命名

export function agyAccLabel(label) {
  const m = AUTO_LABEL_RE.exec(String(label || ''));
  if (!m) return String(label || '');
  return m[1] ? t('账号 {n}', { n: m[1] }) : t('默认账号');
}

export function agyPlanPill(plan) {
  return ({ ultra: 'Ultra', pro: 'Pro', free: 'Free' })[String(plan || '').toLowerCase()] || '';
}

export function agyPlanChoices() {
  return [
    { value: '', label: t('自动') },
    { value: 'free', label: 'Free' },
    { value: 'pro', label: 'Pro' },
    { value: 'ultra', label: 'Ultra' },
  ];
}

export function agyUsageTone(bucket) {
  if (!bucket || typeof bucket.usedPct !== 'number') return 'ok';
  if (bucket.usedPct >= 100) return 'red';
  if (bucket.usedPct >= 80) return 'amber';
  return 'ok';
}

export function agyHhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function agyPoolResetIn(ms, now = Date.now()) {
  const diff = (Number(ms) || 0) - now;
  if (diff <= 0) return '';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return t('{n} 分钟后重置', { n: Math.max(1, mins) });
  if (mins < 48 * 60) return t('{n} 小时后重置', { n: Math.round(mins / 60) });
  return t('{n} 天后重置', { n: Math.round(mins / 1440) });
}

export function agyPoolResetAt(ms, now = Date.now()) {
  const diff = (Number(ms) || 0) - now;
  if (diff <= 0) return '';
  if (diff < 60 * 60_000) return t('{n} 分钟后重置', { n: Math.max(1, Math.round(diff / 60_000)) });
  if (diff < 24 * 3600_000) return t('{time} 重置', { time: agyHhmm(ms) });
  const days = [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')];
  return t('{day} {time} 重置', { day: days[new Date(ms).getDay()], time: agyHhmm(ms) });
}

export function agyRouteStrategies() {
  return [
    {
      value: 'smart',
      label: t('智能分派'),
      desc: t('按 Gemini 与 Claude/GPT 两组独立额度、并行任务数与重置时间选号，并行对话自动分到不同账号'),
    },
    {
      value: 'fill',
      label: t('用满再换'),
      desc: t('所有对话共用当前号，用满才一起换到余量最多的号'),
    },
    {
      value: 'primary',
      label: t('回到首选号'),
      desc: t('所有对话共用列表里最靠前的可用号：主号一恢复就切回，备用号只在主号用满时顶上'),
    },
  ];
}

export function agyGroupLabel(group) {
  if (group === '3p') return 'Claude / GPT';
  if (group === 'gemini') return 'Gemini';
  return '';
}

export function agyWhyText(reason) {
  const map = {
    gemini_5h: () => t('Gemini 5 小时额度已满'),
    gemini_weekly: () => t('Gemini 每周额度已满'),
    tp_5h: () => t('Claude / GPT 5 小时额度已满'),
    tp_weekly: () => t('Claude / GPT 每周额度已满'),
    'near:gemini_5h': () => t('Gemini 5 小时额度快满了'),
    'near:gemini_weekly': () => t('Gemini 每周额度快满了'),
    'near:tp_5h': () => t('Claude / GPT 5 小时额度快满了'),
    'near:tp_weekly': () => t('Claude / GPT 每周额度快满了'),
    auth: () => t('Google 授权失效'),
    validation: () => t('账号需要验证'),
    capacity: () => t('模型容量紧张'),
    primary_back: () => t('首选号额度已恢复'),
    spread: () => t('和在跑的任务分开，各用各的号'),
    expiring: () => t('这个号的额度快重置了，先用掉'),
    room: () => t('这个号剩的额度最多'),
    fallback: () => t('各号都快满了，挑了最空的'),
    only: () => t('只有这个号能用'),
    limit: () => t('额度已满'),
  };
  return (map[reason] || map.limit)();
}

export function agyRouteLogTitle(entry) {
  if (!entry?.kind) return '';
  return entry.label || t('对话 {id}', { id: String(entry.sid || '').slice(0, 8) });
}

export function agyRouteLogSub(entry, labelOf) {
  const grp = agyGroupLabel(entry?.group);
  const to = labelOf(entry?.to, entry?.toLabel || '');
  const where = entry?.from ? `${labelOf(entry.from, entry.fromLabel || '')} → ${to}` : `→ ${to}`;
  return [grp, where, agyWhyText(entry?.reason)].filter(Boolean).join(' · ');
}

export function agySwitchToastText(ev) {
  const to = agyAccLabel(ev?.toLabel || ev?.to || '');
  const why = agyWhyText(ev?.reason);
  return t('已自动切到「{to}」（{why}）', { to, why });
}
