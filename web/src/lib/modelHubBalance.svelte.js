// 模型中心服务的余额 / 限额（POST /api/model-hub/balance）：按服务存一份，服务详情的 Key 列表与总览的副行共用。
// 服务端 60 秒内走缓存，这里不另设节流；用户点「刷新余额」才 force。
// 服务端只回代号与数字（kind / currency / parts），文案在这里出。
import { hubAsk } from './modelHub.svelte.js';
import { t } from './i18n.js';
import { recall, remember } from './lastKnown.js';

/** sid → { busy, err, lines: [{ lineId, label, enabled, ok, items?, error?, at }] } */
// 起始值是上次查到的余额（lib/lastKnown）：总览副行第一帧就带着「余额 ¥…」，不用等上游回来再改写一次
export const bal = $state(Object.fromEntries(Object.entries(recall('hub.balance') || {}).map(([sid, lines]) => [sid, { lines, err: '', busy: false }])));
const keep = () => remember('hub.balance', Object.fromEntries(Object.entries(bal).filter(([, v]) => v?.lines?.length).map(([sid, v]) => [sid, v.lines])));

export async function loadBalance(sid, { force = false } = {}) {
  const cur = bal[sid];
  if (!sid || cur?.busy) return;
  bal[sid] = { lines: cur?.lines || [], err: '', busy: true };
  try {
    const r = await hubAsk('balance', { id: sid, force });
    bal[sid] = { lines: Array.isArray(r.balance) ? r.balance : [], err: '', busy: false };
    keep();
  } catch (e) {
    bal[sid] = { lines: cur?.lines || [], err: e.message, busy: false };
  }
}

export const lineBalance = (sid, lid) => bal[sid]?.lines?.find((x) => x.lineId === lid) || null;

const SYM = { CNY: '¥', USD: '$' };
/** 金额：人民币 / 美元带符号两位小数；没有币种的是积分，取整加千分位。 */
export function money(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
  if (!currency) return Math.round(amount).toLocaleString('en-US');
  const sym = SYM[currency] ?? currency + ' ';
  return (amount < 0 ? '-' : '') + sym + Math.abs(amount).toFixed(2);
}

function partText(p, currency) {
  const v = money(p.amount, currency);
  switch (p.kind) {
    case 'topup': return t('充值 {v}', { v });
    case 'granted': return t('赠送 {v}', { v });
    case 'cash': return t('现金 {v}', { v });
    case 'voucher': return t('代金券 {v}', { v });
    case 'credits': return t('累计充值 {v}', { v });
    case 'used': return t('已用 {v}', { v });
    default: return '';
  }
}

/** 一项的主文字：「余额 ¥17.47」「Key 限额剩 $66.98 / $100.00」「295,932 积分」。 */
export function itemMain(it) {
  const v = money(it.amount, it.currency);
  if (it.kind === 'keyLimit') return it.total != null ? t('Key 限额剩 {v} / {total}', { v, total: money(it.total, it.currency) }) : t('Key 限额剩 {v}', { v });
  if (it.kind === 'points') return t('{v} 积分', { v });
  return t('余额 {v}', { v });
}
/** 一项的明细：0 和缺的不写（赠送 ¥0.00 只是噪音）。 */
export function itemParts(it) {
  return (it.parts || []).filter((p) => typeof p.amount === 'number' && p.amount !== 0).map((p) => partText(p, it.currency)).filter(Boolean).join(' · ');
}
export const isLow = (it) => typeof it?.amount === 'number' && it.amount <= 0;

/**
 * 总览副行用的一句：第一条启用且查到了的 Key 的第一项。
 * → { text, low } | null（还没查、查不到都是 null：副行不写，免得一排「查不到」）
 */
export function balanceBrief(sid) {
  const ls = bal[sid]?.lines || [];
  const hit = ls.find((l) => l.enabled && l.ok && l.items?.length) || ls.find((l) => l.ok && l.items?.length);
  if (!hit) return null;
  const it = hit.items[0];
  return { text: itemMain(it), low: hit.items.some(isLow) };
}
