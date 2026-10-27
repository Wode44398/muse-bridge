// 用户自助（三端拆分 P4）：自己的额度 / 用量、改自己的密码。
// 三处共用这份数据层：手机 / 网页主页右上的账户卡（LoginCard）、iOS 风设置 › 账户（Settings.svelte）、
// 桌面壳设置（SettingsDesktop）；单 agent 模式也走后两套设置。管理员没有额度，也没有密码可改。
import { api } from './api.js';
import { t } from './i18n.js';

/** { unlimited:true }（管理员）| { unlimited:false, limits, today, week, timezone, totals } */
export const fetchMyUsage = () => api.get('/api/me/usage');

/** 原密码对了才改；成功后本机保留登录，别的设备全部下线。失败抛错（e.body.error 是给人看的原因）。 */
export const changeMyPassword = (old, password) => api.post('/api/me/password', { old, password });

const money = (v) => '$' + (Math.round((v || 0) * 100) / 100).toFixed(2);

// 一个窗口（今天 / 最近 7 天）的一句话：「3 / 20 轮 · $0.52 / $2.00」；没设上限的维度只报用量。
function windowLine(used, limits, turnsKey, costKey) {
  const turns = limits[turnsKey] ? t('{used} / {n} 轮', { used: used.turns, n: limits[turnsKey] }) : t('{n} 轮', { n: used.turns });
  const c = limits[costKey] ? `${money(used.costUsd)} / ${money(limits[costKey])}` : (used.costUsd ? money(used.costUsd) : '');
  return c ? `${turns} · ${c}` : turns;
}

/** 给界面用的两行：[{ label, value, hot }]；hot = 这个窗口有一项已经到上限。 */
export function quotaRows(u) {
  if (!u || u.unlimited) return [];
  const l = u.limits || {};
  const hot = (used, tk, ck) => !!((l[tk] && used.turns >= l[tk]) || (l[ck] && used.costUsd >= l[ck]));
  const rows = [
    { label: t('今天'), value: windowLine(u.today, l, 'dayTurns', 'dayCostUsd'), hot: hot(u.today, 'dayTurns', 'dayCostUsd') },
    { label: t('最近 7 天'), value: windowLine(u.week, l, 'weekTurns', 'weekCostUsd'), hot: hot(u.week, 'weekTurns', 'weekCostUsd') },
  ];
  // 按次计的（开源路线 S2-6）：设了上限才显示一行「今天 3 / 20」
  const f = u.features || {};
  for (const [k, key, label, off] of [
    ['media', 'dayMedia', t('今天的图片、语音、音乐'), f.media === false],
    ['video', 'dayVideo', t('今天的视频'), f.video === false],
  ]) {
    if (off) { rows.push({ label, value: t('未开放'), hot: false }); continue; }
    if (!l[key]) continue;
    const used = (u.today && u.today[k]) || 0;
    rows.push({ label, value: t('{used} / {n} 次', { used, n: l[key] }), hot: used >= l[key] });
  }
  return rows;
}

/** 花费是怎么算的（订阅号池下不是真花出去的钱）：界面在额度旁边带这一句。 */
export const costNote = () => t('花费按 API 价估算：大家共用订阅号池时，它反映用了多少，不是真花出去的钱。');

/** 这个人有没有被设上限（没有的话界面上只说「不限」就行）。 */
export const hasLimits = (u) => !!u && !u.unlimited && (Object.keys(u.limits || {}).length > 0 || Object.values(u.features || {}).some((v) => v === false));
