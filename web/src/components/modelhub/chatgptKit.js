// 模型中心「ChatGPT 订阅」服务的纯逻辑：登录流程的阶段、报错的人话、账号状态、首页副行。
// 不碰组件状态、不发请求，有单测 chatgptKit.test.js。接口与字段照契约 design/ChatGPT订阅接入.md。
import { t, tr } from '../../lib/i18n.js';

export const CG_KIND = 'chatgpt';
// 服务视图没带 chatgpt.usageUrl 时（总览还是旧的）用这个：官方给的「管理用量」页
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
/** 轮询登录状态的间隔：用户在别的标签里登录，2 秒够跟手，又不至于把服务端问烦 */
export const POLL_MS = 2000;

export const isCg = (svc) => !!svc && svc.kind === CG_KIND;
export const usageUrlOf = (svc) => (svc && svc.chatgpt && svc.chatgpt.usageUrl) || USAGE_URL;

/**
 * 登录视图 → 界面阶段：
 *   'idle'       还没开始（或已取消）
 *   'pending'    等用户在浏览器里登录
 *   'exchanging' 服务端换令牌、拉模型中
 *   'done' | 'error'
 *   'expired'    服务端还写着 pending，但已经过了 expiresAt：别再等了，让人重来
 */
export function loginPhase(login, now = Date.now()) {
  if (!login || !login.id) return 'idle';
  const s = login.status;
  if (s === 'done' || s === 'exchanging') return s;
  if (s === 'error') return login.errorCode === 'expired' ? 'expired' : 'error';
  if (Number(login.expiresAt) > 0 && now >= Number(login.expiresAt)) return 'expired';
  return 'pending';
}
/** 还要不要接着问服务端 */
export const loginLive = (phase) => phase === 'pending' || phase === 'exchanging';

/** 登录出错的人话：认得的 errorCode 按场景说，别的用服务端给的原文 */
export function loginErrText(login) {
  const code = login && login.errorCode;
  if (code === 'denied') return t('你在登录页拒绝了授权');
  if (code === 'no_plan') return t('这个账号没开通套餐额度授权');
  if (code === 'not_eligible') return t('这个账号不能用套餐额度（需要付费套餐）');
  if (code === 'expired') return t('登录已过期');
  const e = login && login.error;
  return e ? tr(String(e)) : t('登录没有完成');
}

/**
 * 粘贴框里的字够不够格交给 finish：要是一整段 http(s) 地址、带查询串（code / state 或 error 在里面）。
 * 只挡明显粘错的（粘了一半、粘成了登录页地址以外的文字）；真假由服务端判。返回 '' = 可以提交，否则是提示。
 */
export function pasteProblem(s) {
  const v = String(s || '').trim();
  if (!v) return t('先把地址粘贴进来');
  if (!/^https?:\/\/[^\s?#]+\?\S+$/i.test(v)) return t('这不像登录后停住的那个地址：要从地址栏整段复制，以 http://127.0.0.1 开头');
  return '';
}

/** 剩下的有效时间（分钟，向上取整；过期了 = 0） */
export function minutesLeft(expiresAt, now = Date.now()) {
  const ms = Number(expiresAt) - now;
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

/** 服务视图里的账号列表（总览旧、没带 chatgpt 段时退回线路：标签当邮箱，状态当正常） */
export function cgAccounts(svc) {
  if (!svc) return [];
  const acc = svc.chatgpt && Array.isArray(svc.chatgpt.accounts) ? svc.chatgpt.accounts : null;
  if (acc) return acc.filter(Boolean);
  return (svc.lines || []).filter(Boolean).map((l) => ({ lineId: l.id, email: l.label || '', label: l.label || '', enabled: l.enabled !== false, status: 'ok', statusText: '' }));
}

/** 这个账号要用户处理的事：'' 正常；'login' 要重新登录（令牌失效 / 凭据丢了）；'plan' 没授权套餐额度 */
export function accountNeed(a) {
  const s = a && a.status;
  if (s === 'relogin' || s === 'missing') return 'login';
  if (s === 'no_plan') return 'plan';
  return '';
}

/** 账号行的状态文字：停用 > 后端给的人话 > 按状态的默认说法；正常的给 '' */
export function accountNote(a) {
  if (!a) return '';
  if (a.enabled === false) return t('已停用');
  if (!accountNeed(a)) return '';
  if (a.statusText) return tr(String(a.statusText));
  if (a.status === 'relogin') return t('需要重新登录');
  if (a.status === 'missing') return t('凭据丢失，需要重新登录');
  return t('没授权套餐额度');
}

/** 账号的显示名：标签改过（不是邮箱）时「标签 · 邮箱」，否则就是邮箱 */
export function accountName(a) {
  if (!a) return '';
  const email = a.email || '', label = (a.label || '').trim();
  if (!email) return label || t('ChatGPT 账号');
  return label && label !== email ? label + ' · ' + email : email;
}

/** 首页 / 顶栏副行的账号摘要：一个 = 邮箱；多个 = 「邮箱 等 N 个账号」；没有 = 「还没有账号」 */
export function accountsText(svc) {
  const list = cgAccounts(svc);
  if (!list.length) return t('还没有账号');
  const first = list[0].email || list[0].label || t('ChatGPT 账号');
  return list.length === 1 ? first : t('{email} 等 {n} 个账号', { email: first, n: list.length });
}

/**
 * 首页行上的提醒标签（只看启用的账号）：有要重新登录的优先说它，其次没授权套餐额度的。
 * 返回 [{ text, tone: 'warn' }]，没有就空数组。
 */
export function accountTags(svc) {
  const list = cgAccounts(svc).filter((a) => a.enabled !== false);
  const login = list.filter((a) => accountNeed(a) === 'login').length;
  const plan = list.filter((a) => accountNeed(a) === 'plan').length;
  const many = cgAccounts(svc).length > 1;
  if (login) return [{ text: many ? t('{n} 个账号要重新登录', { n: login }) : t('要重新登录'), tone: 'warn' }];
  if (plan) return [{ text: many ? t('{n} 个账号没授权套餐额度', { n: plan }) : t('没授权套餐额度'), tone: 'warn' }];
  return [];
}

/**
 * 账号操作 → update 的 lines（不带 key；契约：删掉的账号服务端顺手吊销令牌、清凭据）。
 * 以服务视图的 lines 为准（顺序就是取用顺序），账号段只补启停。
 *   op: { toggle: lineId, on } | { remove: lineId }
 */
export function linesPatch(svc, op) {
  const base = (svc && Array.isArray(svc.lines) && svc.lines.length ? svc.lines : cgAccounts(svc).map((a) => ({ id: a.lineId, label: a.label, enabled: a.enabled })))
    .filter((l) => l && l.id);
  const out = [];
  for (const l of base) {
    if (op && op.remove && l.id === op.remove) continue;
    const enabled = op && op.toggle === l.id ? !!op.on : l.enabled !== false;
    out.push({ id: l.id, label: l.label || '', baseUrl: '', enabled });
  }
  return out;
}
