// 设置 › Codex 的纯文案与格式化（无 DOM / Svelte 依赖，桌面 / 手机设置与单测共用）。
// 选项名照 Codex 官方桌面版「设置 › 配置」的中文说法（批准策略 / 沙盒设置 / 网页搜索 / 输出详细程度 / 推理摘要）。

import { t } from '../i18n.js';

// —— 新对话的批准策略与沙盒（按身份：管理员三档全有；成员只有「按请求 / 不受信任」与「只读 / 工作空间写入」）——
const APPROVAL = {
  never: () => ({ label: t('从不请求审批'), desc: t('不弹审批卡，命令与改动直接执行') }),
  'on-request': () => ({ label: t('按请求'), desc: t('需要越出沙盒或提升权限时先问你') }),
  untrusted: () => ({ label: t('不受信任'), desc: t('除只读的常见命令外，每条命令都先问你') }),
};
const SANDBOX = {
  'read-only': () => ({ label: t('只读'), desc: t('只能读文件，不能改') }),
  'workspace-write': () => ({ label: t('工作空间写入'), desc: t('只能改项目文件夹里的文件') }),
  'danger-full-access': () => ({ label: t('完整访问权限'), desc: t('不进沙盒，能改整台电脑') }),
};

/** @param {string[]} [allowed] 这一档允许的值（来自 /api/codex/settings 的 choices）；不给 = 全部 */
export function approvalOptions(allowed) {
  return Object.keys(APPROVAL).filter((v) => !allowed || allowed.includes(v)).map((value) => ({ value, ...APPROVAL[value]() }));
}
export function sandboxOptions(allowed) {
  return Object.keys(SANDBOX).filter((v) => !allowed || allowed.includes(v)).map((value) => ({ value, ...SANDBOX[value]() }));
}
export const approvalLabel = (v) => (APPROVAL[v] ? APPROVAL[v]().label : String(v || '—'));
export const sandboxLabel = (v) => (SANDBOX[v] ? SANDBOX[v]().label : String(v || '—'));

// —— 新对话的 Codex 行为（空值 = 跟随 Codex 自己的默认）——
export function webSearchOptions() {
  return [
    { value: '', label: t('默认'), desc: t('跟随 Codex 的默认设置') },
    { value: 'live', label: t('实时'), desc: t('每次现查网页，结果最新') },
    { value: 'cached', label: t('缓存'), desc: t('查 OpenAI 维护的网页缓存，更快') },
    { value: 'indexed', label: t('索引'), desc: t('只查已建索引的网页') },
    { value: 'disabled', label: t('禁用'), desc: t('不给 Codex 网页搜索工具') },
  ];
}
export function verbosityOptions() {
  return [
    { value: '', label: t('模型默认') },
    { value: 'low', label: t('低') },
    { value: 'medium', label: t('中') },
    { value: 'high', label: t('高') },
  ];
}
// 推理摘要：Codex 默认就是「自动」，所以「自动」就是不覆盖（存空值）
export function summaryOptions() {
  return [
    { value: '', label: t('自动') },
    { value: 'concise', label: t('简洁') },
    { value: 'detailed', label: t('详细') },
    { value: 'none', label: t('无') },
  ];
}
export const summaryValue = (v) => (v === 'auto' ? '' : String(v || ''));
export const optionLabel = (opts, v) => (opts.find((o) => o.value === (v ?? ''))?.label ?? String(v ?? ''));

// —— 运行 ——
export function idleOptions() {
  return [
    { value: 15, label: t('{n} 分钟', { n: 15 }) },
    { value: 30, label: t('{n} 分钟', { n: 30 }) },
    { value: 60, label: t('1 小时') },
    { value: 120, label: t('{n} 小时', { n: 2 }) },
    { value: 240, label: t('{n} 小时', { n: 4 }) },
    { value: 0, label: t('从不') },
  ];
}
export function maxRunsOptions() {
  return [1, 2, 3, 4, 5].map((n) => ({ value: n, label: t('{n} 轮', { n }) }));
}
export function cliSourceLabel(source) {
  return ({
    desktop: t('Codex 桌面版'), bundled: t('扩展自带'), download: t('bridge 下载'), env: 'CODEX_BIN',
    plugin: t('Codex 插件目录'), npm: 'npm', path: 'PATH',
  })[source] || String(source || '');
}

// —— 号池 ——
const LOCAL_LABEL = '本机账号'; // i18n-ignore 服务端给本机账号的默认名，用来认出来再翻
export function accLabel(acc) {
  const label = String(acc?.label || acc?.id || '');
  return label === LOCAL_LABEL ? t('本机账号') : label;
}
export function kindLabel(kind) {
  return ({ local: t('本机'), chatgpt: 'ChatGPT', apikey: t('API 密钥') })[kind] || '';
}
// 套餐名照 ChatGPT 官方叫法；Team 已改名 Business
export function planLabel(plan) {
  const p = String(plan || '').toLowerCase();
  if (!p) return '';
  if (p === 'free') return t('免费版');
  const known = { go: 'Go', plus: 'Plus', pro: 'Pro', prolite: 'Pro', team: 'Business', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', education: 'Edu' };
  return known[p] || p.replace(/(^|[_-])(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
}
export function hostStateText(host) {
  return ({
    ready: t('运行中'), starting: t('启动中'), stopped: t('未运行'), stopping: t('正在停止'),
    backoff: t('启动失败，稍后重试'), error: t('出错'),
  })[host?.state] || '';
}
export function flowStateText(state) {
  return ({
    pending: t('等你在浏览器里输入验证码…'), finishing: t('已登录，正在读取账号信息…'), done: t('登录成功'),
    failed: t('登录失败'), cancelled: t('已取消'), expired: t('验证码已过期'), duplicate: t('这个账号已经在号池里了'),
  })[state] || '';
}

/** 额度窗口的名字（windowDurationMins）：5 小时、每周、30 天…… */
export function windowName(mins) {
  const n = Number(mins) || 0;
  if (!n) return t('额度');
  if (n === 10080) return t('每周');
  if (n % 1440 === 0) return t('{n} 天', { n: n / 1440 });
  if (n % 60 === 0) return t('{n} 小时', { n: n / 60 });
  return t('{n} 分钟', { n });
}
export function usageTone(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 'ok';
  return n >= 100 ? 'red' : n >= 80 ? 'amber' : 'ok';
}
export function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
/** Codex 给的重置时间是 Unix 秒。 */
export function resetText(seconds, now = Date.now()) {
  const ms = (Number(seconds) || 0) * 1000;
  const diff = ms - now;
  if (!ms || diff <= 0) return '';
  if (diff < 60 * 60_000) return t('{n} 分钟后重置', { n: Math.max(1, Math.round(diff / 60_000)) });
  if (diff < 24 * 3600_000) return t('{time} 重置', { time: hhmm(ms) });
  const d = new Date(ms);
  return t('{m} 月 {d} 日重置', { m: d.getMonth() + 1, d: d.getDate() });
}
/** 冷却中（撞线后等窗口重置）：until 是毫秒。 */
export function coolingText(cooling, now = Date.now()) {
  const until = Number(cooling?.until) || 0;
  if (until <= now) return '';
  return until - now < 24 * 3600_000 ? t('撞线冷却到 {time}', { time: hhmm(until) }) : t('撞线冷却中');
}

/** 一个号的额度窗口（展平成一行行，给用量条用）：[{ key, name, usedPercent, resetsAt }] */
export function usageRows(limits) {
  const out = [];
  const buckets = Array.isArray(limits?.buckets) ? limits.buckets : [];
  for (const b of buckets) {
    for (const w of b.windows || []) {
      const name = (buckets.length > 1 && b.id !== 'codex' ? b.name + ' · ' : '') + windowName(w.durationMins);
      out.push({ key: b.id + ':' + w.id, name, usedPercent: w.usedPercent, resetsAt: w.resetsAt });
    }
  }
  return out;
}

export function routeStrategies() {
  return [
    { value: 'smart', label: t('智能分派'), desc: t('每个新对话按各号剩余额度与重置时间挑一个') },
    { value: 'fill', label: t('用满再换'), desc: t('一直用当前的号，撞线了才换下一个') },
    { value: 'primary', label: t('按顺序优先'), desc: t('总是先用排在前面的号') },
  ];
}
