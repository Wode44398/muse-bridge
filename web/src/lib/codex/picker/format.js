// 选择器与额度卡的纯函数：上下文大小、token 数、额度窗口、重置时间、模型列表的过滤与收起。
// 没有 DOM，单测见 format.test.js。

import { t } from '../../i18n.js';

/** 模型的上下文窗口：400K / 1M / 1.5M；猜出来的前面带 ≈。 */
export function fmtCtx(n, guess = false) {
  const v = Number(n);
  if (!(v > 0)) return '';
  let s;
  if (v >= 1e6) s = (Math.round(v / 1e5) / 10).toString().replace(/\.0$/, '') + 'M';
  else if (v >= 1000) s = Math.round(v / 1000) + 'K';
  else s = String(Math.round(v));
  return (guess ? '≈' : '') + s;
}

/** 已用 / 共多少 token：98k、1.2M、850。 */
export function fmtTok(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1e6) return (Math.round(v / 1e5) / 10).toString().replace(/\.0$/, '') + 'M';
  if (v >= 1000) return Math.round(v / 1000) + 'k';
  return String(Math.round(v));
}

/** 额度窗口的名字：按时长叫，不认识的写成「N 小时 / N 天」。 */
export function windowLabel(mins, id = '') {
  const m = Number(mins) || 0;
  if (m === 10080) return t('每周');
  if (m === 1440) return t('每天');
  if (m > 0 && m % 1440 === 0) return t('{n} 天', { n: m / 1440 });
  if (m > 0 && m % 60 === 0) return t('{n} 小时', { n: m / 60 });
  if (m > 0) return t('{n} 分钟', { n: m });
  return id === 'secondary' ? t('每周') : t('5 小时');
}

const WEEK = () => [t('周日'), t('周一'), t('周二'), t('周三'), t('周四'), t('周五'), t('周六')];
const pad = (n) => String(n).padStart(2, '0');

/**
 * 重置时间：一天以内写「2 小时 10 分后重置」，再远写「周四 09:00 重置」（超过一周写日期）。
 * resetsAt 是秒级时间戳（服务端原样转来的）。
 */
export function resetText(resetsAt, now = Date.now()) {
  const at = Number(resetsAt) * 1000;
  if (!(at > 0)) return '';
  const left = at - now;
  if (left <= 60e3) return t('马上重置');
  const mins = Math.round(left / 60e3);
  if (mins < 60) return t('{m} 分后重置', { m: mins });
  if (left < 24 * 3600e3) {
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? t('{h} 小时 {m} 分后重置', { h, m }) : t('{h} 小时后重置', { h });
  }
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (left < 7 * 24 * 3600e3) return t('{w} {hm} 重置', { w: WEEK()[d.getDay()], hm });
  return t('{mo} 月 {d} 日重置', { mo: d.getMonth() + 1, d: d.getDate() });
}

/**
 * 额度卡里的几行：每个额度窗口一行（剩余百分比、重置时间）。
 * 多个额度桶时（某些型号单独限额），第一个桶之外的行名前加上桶名。
 */
export function quotaRows(usage, now = Date.now()) {
  const buckets = Array.isArray(usage?.buckets) ? usage.buckets : [];
  const rows = [];
  buckets.forEach((b, bi) => {
    for (const w of b.windows || []) {
      if (w.remainingPercent == null && w.usedPercent == null) continue;
      const left = w.remainingPercent != null ? w.remainingPercent : 100 - w.usedPercent;
      const label = windowLabel(w.durationMins, w.id);
      rows.push({
        key: `${b.id}:${w.id}`,
        label: bi ? `${b.name} · ${label}` : label,
        left: Math.max(0, Math.min(100, Math.round(left))),
        reset: resetText(w.resetsAt, now),
      });
    }
  });
  return rows;
}

/** 5 小时窗口还剩多少（账号菜单每行右边那个数）；不知道 = null。 */
export function fiveHourLeft(view) {
  const buckets = Array.isArray(view?.buckets) ? view.buckets : [];
  const b = buckets.find((x) => x.id === 'codex') || buckets[0];
  if (!b) return null;
  const w = (b.windows || []).find((x) => x.durationMins === 300) || (b.windows || []).find((x) => x.id === 'primary');
  if (!w) return null;
  const left = w.remainingPercent != null ? w.remainingPercent : w.usedPercent != null ? 100 - w.usedPercent : null;
  return left == null ? null : Math.max(0, Math.min(100, Math.round(left)));
}

/** 条目多到要出搜索框了没有。 */
export const needSearch = (groups, min = 9) => groups.reduce((n, g) => n + g.items.length, 0) >= min;

/**
 * 选择器列表：按关键字过滤（型号名、id、服务名都算），每组默认模型排第一，
 * 超过 limit 个就只露前 cap 个、余下收成一行「还有 N 个」——选中的那个就算排在后面也露出来。
 * expanded 是已展开的组 key 集合（Set 或数组）。
 */
export function pickerGroups(groups, { q = '', expanded = [], selected = '', limit = 8, cap = 6 } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const open = expanded instanceof Set ? expanded : new Set(expanded);
  const out = [];
  for (const g of groups) {
    const groupHit = query && String(g.name || '').toLowerCase().includes(query);
    let items = g.items.filter((m) => !query || groupHit
      || String(m.name || '').toLowerCase().includes(query)
      || String(m.id || '').toLowerCase().includes(query));
    if (!items.length) continue;
    items = [...items].sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0));
    let shown = items, more = 0;
    if (!query && !open.has(g.key) && items.length > limit) {
      shown = items.slice(0, cap);
      const sel = items.findIndex((m) => m.id === selected);
      if (sel >= cap) shown = [...shown, items[sel]];
      more = items.length - shown.length;
    }
    out.push({ ...g, shown, more });
  }
  return out;
}

/** 一个模型在号池里哪些号上有（多号时才标）：号 id → 名字，用「、」连起来。 */
export function accountsText(ids, accounts, labelOf = (a) => a.label || a.id) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (list.length < 2 || !Array.isArray(ids) || !ids.length) return '';
  return ids.map((id) => {
    const a = list.find((x) => x.id === id);
    return a ? labelOf(a) : '';
  }).filter(Boolean).join(t('、'));
}

// 按型号名认品牌（BrandLogo 的 logoKey）。服务没带标（自定义服务、转发站）时拿它补；认不出回空串。
const MODEL_BRANDS = [
  [/\b(gpt|o\d|codex|openai)/i, 'openai'], [/claude|anthropic/i, 'claude-color'], [/gemini|gemma/i, 'gemini-color'],
  [/deepseek/i, 'deepseek-color'], [/qwen|qwq/i, 'qwen-color'], [/kimi|moonshot/i, 'kimi-color'], [/glm|zhipu|chatglm/i, 'zhipu-color'],
  [/grok|xai/i, 'grok'], [/mistral|magistral|codestral/i, 'mistral-color'], [/llama|muse/i, 'meta-color'], [/minimax|abab/i, 'minimax-color'],
  [/doubao|seed/i, 'doubao-color'], [/hunyuan|\bhy\d/i, 'hunyuan-color'], [/ernie|wenxin/i, 'wenxin-color'], [/mimo/i, 'xiaomimimo'],
  [/step-?\d|stepfun/i, 'stepfun-color'], [/nova/i, 'nova-color'], [/command-?r|cohere/i, 'cohere-color'],
];
export function brandOfModel(...names) {
  for (const n of names) {
    const s = String(n || '');
    if (!s) continue;
    for (const [re, k] of MODEL_BRANDS) if (re.test(s)) return k;
  }
  return '';
}

/** 一组的标：服务自己的标优先；没有就取组里认得出的型号里最多的那家。 */
export function groupBrand(g) {
  if (g?.logo) return g.logo;
  const count = new Map();
  for (const m of g?.items || []) {
    const k = brandOfModel(m.name, m.id);
    if (k) count.set(k, (count.get(k) || 0) + 1);
  }
  let best = '', n = 0;
  for (const [k, c] of count) if (c > n) { best = k; n = c; }
  return best;
}
