// 登录流程和模型中心注册表之间的胶水（路由 model-hub-chatgpt 调这里）：
//   new     登录成功后拉这个账号能用的模型，等界面勾完模型再建服务（createFromLogin）
//   add     给已有的订阅服务再挂一个账号（同一个账号再登一次 = 换掉它的凭据）
//   relogin 某个账号重新登录（必须是原来那个账号）
import { startLogin, finishLogin, getLogin, cancelLogin, consumeLogin } from './oauth.mjs';
import { hostId, getCred, putCred, credsOf } from './store.mjs';
import { listPlanModels } from './accounts.mjs';
import { KIND } from './const.mjs';
import { createHubChatgpt, addHubChatgptLine, hubServiceKind, getHubService, touchHubLine } from '../registry.mjs';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });

/** 给界面看的登录状态（不带任何令牌）。 */
export function loginView(a) {
  const done = a.status === 'done';
  return {
    id: a.id, mode: a.mode, ...(a.serviceId ? { serviceId: a.serviceId } : {}), ...(a.lineId ? { lineId: a.lineId } : {}),
    status: a.status, authUrl: a.authUrl, redirectUri: a.redirectUri, expiresAt: a.expiresAt,
    ...(a.error ? { error: a.error, errorCode: a.errorCode || 'exchange' } : {}),
    ...(a.account ? { account: { ...a.account } } : {}),
    ...(done && a.mode === 'new' && a.models ? { models: a.models } : {}),
    ...(done && a.service ? { service: a.service } : {}),
  };
}

function attachTo(a) {
  const sid = a.serviceId;
  if (hubServiceKind(sid) !== KIND) throw bad('这个 ChatGPT 订阅服务已经被删掉了', 404);
  if (a.mode === 'relogin') {
    if (!getHubService(sid)?.lines.some((l) => l.id === a.lineId)) throw bad('这个账号已经从服务里删掉了', 404);
    putCred(sid, a.lineId, a.cred);
    a.service = touchHubLine(sid, a.lineId);
    return;
  }
  // add：同一个账号已经挂在这个服务上了 → 换掉它的凭据，不另加一条
  const same = Object.entries(credsOf(sid)).find(([, c]) => c.subject && c.subject === a.cred.subject);
  if (same) { putCred(sid, same[0], a.cred); a.service = touchHubLine(sid, same[0]); return; }
  a.service = addHubChatgptLine(sid, { label: a.cred.email, attach: (s, lid) => putCred(s, lid, a.cred) }).service;
}

export async function startChatgptLogin({ serviceId = '', lineId = '' } = {}) {
  let mode = 'new', saved = null;
  if (serviceId) {
    if (hubServiceKind(serviceId) !== KIND) throw bad('没有这个 ChatGPT 订阅服务', 404);
    if (lineId) {
      if (!getHubService(serviceId)?.lines.some((l) => l.id === lineId)) throw bad('这个服务里没有这个账号', 404);
      mode = 'relogin';
      saved = getCred(serviceId, lineId);
    } else mode = 'add';
  }
  const a = await startLogin({
    mode, serviceId, lineId, saved, hostId: hostId(),
    // 每种都先拉一次模型目录：不能用套餐额度的账号在这一步就会被拒（比真聊天时才发现好）
    afterExchange: async (x) => { const models = await listPlanModels(x.cred.accessToken); if (x.mode === 'new') x.models = models; },
    onDone: async (x) => { if (x.mode !== 'new') { attachTo(x); x.cred = null; } },
  });
  return loginView(a);
}

const need = (loginId) => {
  const a = getLogin(String(loginId || ''));
  if (!a) throw bad('没有这次登录（可能已过期），请重新开始', 404);
  return a;
};
export function chatgptLoginStatus(loginId) { return loginView(need(loginId)); }
export async function finishChatgptLogin(loginId, url) { need(loginId); return loginView(await finishLogin(String(loginId), url)); }
export function cancelChatgptLogin(loginId) { cancelLogin(String(loginId || '')); }

/** 登录成功（new）之后按勾好的模型建服务 → { service, warnings }。 */
export function createFromLogin({ loginId, name, assign, defaultModel }) {
  const a = need(loginId);
  if (a.mode !== 'new') throw bad('这次登录是给已有服务加账号的，不能用来新建服务');
  if (a.status !== 'done' || !a.cred) throw bad(a.status === 'error' ? a.error || '这次登录失败了' : '还没登录完成');
  const r = createHubChatgpt({
    name, label: a.cred.email, catalog: a.models || [], assign, defaultModel,
    attach: (sid, lid) => putCred(sid, lid, a.cred),
  });
  consumeLogin(a.id);
  return { service: r.service, warnings: r.warnings };
}
