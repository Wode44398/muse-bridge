// 设置页两套外壳（手机 / 网页的 components/Settings.svelte、桌面壳的 desktop/settings/SettingsDesktop.svelte）共用的纯函数与常量。
// 两边各写过一份、逐字相同的放这里；带状态的共用部分在同目录 common.svelte.js。
import { t, tc, tr } from '../i18n.js';
import { wpDef } from '../wallpaper.svelte.js';
import { ags } from '../agentSettings.svelte.js';

// —— Agent 页：头图下的状态、没认证时的指引 ——
export const AG_AUTH_HINT = {
  claude: () => t('在下面「订阅号池」里添加账号。'),
  codex: () => t('在服务器上运行一次 codex login。'),
  dimensio: () => t('在下面「API Key」里给一家厂商填 Key，或接一个自定义模型服务。'),
};
export function agStatus(a) {
  if (!a || a.local) return '';
  if (!a.runnable) return tr(a.note) || t('这台机器上不可用');
  if (!a.switch) return tc('开关', '关闭');
  if (!a.authed) return t('还没配认证');
  return a.multiUser ? t('可用') : t('可用 · 仅管理员');
}
// 头图下面只在不正常时写一句状态（不可用 / 已关闭），正常开着不写口号（2026-11-06 维护者：设置页小字太多）
export function studioStatus(a) {
  if (!a) return '';
  if (!a.runnable) return tr(a.note) || t('这台机器上不可用');
  if (!a.switch) return tc('开关', '关闭');
  return '';
}

// —— 额度与注册（多用户形态）：quota 整体替换，改一项带上其余 ——
export const POLICY_FIELDS = [
  { k: 'dayTurns', label: () => t('每天最多几轮'), unit: () => tc('admin', '轮') },
  { k: 'weekTurns', label: () => t('最近 7 天最多几轮'), unit: () => tc('admin', '轮') },
  { k: 'dayCostUsd', label: () => t('每天最多花多少'), unit: () => t('美元') },
  { k: 'weekCostUsd', label: () => t('最近 7 天最多花多少'), unit: () => t('美元') },
  { k: 'maxUserTurns', label: () => t('全服同时最多几轮（注册用户合计）'), unit: () => tc('admin', '轮') },
];
export const policyVal = (k) => (k === 'maxUserTurns' ? ags.policy?.maxUserTurns : ags.policy?.quota?.[k]) || 0;

// 「思考动画」：Claude 回复进行中那颗标记——新版 Claude Code 活动标记（默认）/ 原来的 claude.ai 星标。
// 三套都是原版动画。
export const MARKS = [{ value: 'clay', label: () => t('新版 Claude Code') }, { value: 'sprite', label: () => t('新版聊天页') }, { value: 'classic', label: () => t('经典星标') }];

// tier 'pro' = 「完全信任」档（S2-2 改名，存储值不变）
export const roleLabelOf = (me) => (me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' ? t('完全信任用户') : t('普通用户')) : t('未登录'));

// 后端跑了多久
export function fmtUptime(s) {
  s = Math.floor(Number(s) || 0);
  if (s < 60) return t('{n} 秒', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('{n} 分钟', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? t('{h} 小时 {m} 分钟', { h, m: m % 60 }) : t('{n} 小时', { n: h });
  const d = Math.floor(h / 24);
  return h % 24 ? t('{n} 天 {h} 小时', { n: d, h: h % 24 }) : t('{n} 天', { n: d });
}

// 壁纸缩略图 / 预览的背景
export function bgStyle(id) {
  const d = wpDef(id);
  if (d.css) return `background:${d.css}`;
  return `background-image:url("${d.url}");background-size:cover;background-position:center 30%`;
}

// 上传前把图片降采样到 ≤1600（反馈附件、壁纸都用；省流量和工作空间体积）。GIF 与非图片原样返回，压了反而更大也原样返回
export async function compressImage(file) {
  if (!(file.type || '').startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size < 600 * 1024) { bmp.close && bmp.close(); return file; }
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const cvs = document.createElement('canvas'); cvs.width = w; cvs.height = h;
    cvs.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
    const blob = await new Promise((res) => cvs.toBlob(res, 'image/jpeg', 0.82));
    if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    return file;
  } catch { return file; }
}
