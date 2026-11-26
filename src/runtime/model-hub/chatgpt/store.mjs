// ChatGPT 订阅账号的凭据：<模型中心数据目录>/chatgpt/ 下单独一份 extension-secrets 密文（AES-GCM + DPAPI），
// 不和「地址 + Key」那张表放一起——令牌每小时刷新一次要写盘，别拿全部服务的 Key 陪着它反复重写。
//
//   { host: 'urn:uuid:…'（这台服务器的 ext_agent_host_id，生成一次长期不变）,
//     lines: { '<服务 id>/<线路 id>': 凭据 } }
//   凭据：{ email, subject, clientId（签发的 oaiapp_…）, idToken, accessToken, refreshToken, scopes, planOk,
//          expiresAt, earliestRefreshAt, savedAt, refreshedAt, needsLogin?, needsLoginWhy? }
//
// 读不出来（密钥丢了 / 文件坏了）时读的一方当作没有凭据，写的一方一律拒绝：拿空表覆盖会把所有账号一起登出。
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSecrets, writeSecrets } from '../../../extension-secrets.mjs';

let rootOf = () => '';
/** registry 注入模型中心的数据目录（测试换目录时一起换）。 */
export function setChatgptRoot(fn) { rootOf = typeof fn === 'function' ? fn : () => ''; }
const root = () => path.join(rootOf() || '.', 'chatgpt');

const UNREADABLE = 'ChatGPT 账号的凭据存储读不出来（密钥文件损坏或解不开，详情见服务器日志）：为免把已登录的账号一起清掉，这次没有保存';

function readOrNull() {
  try { return readSecrets(root()); } catch (e) { console.error('[model-hub/chatgpt] 凭据存储读不出来：', e?.message || e); return null; }
}
function mutate(fn) {
  const cur = readOrNull();
  if (!cur) throw Object.assign(new Error(UNREADABLE), { status: 500 });
  const next = { ...cur, lines: { ...(cur.lines || {}) } };
  const out = fn(next);
  writeSecrets(root(), next);
  return out;
}

/** 这台服务器的 ext_agent_host_id（第一次登录前定下，之后每次登录都带同一个）。 */
export function hostId() {
  const cur = readOrNull();
  if (cur?.host) return cur.host;
  return mutate((m) => { if (!m.host) m.host = `urn:uuid:${randomUUID()}`; return m.host; });
}

const k = (sid, lid) => `${sid}/${lid}`;
export function getCred(sid, lid) { const c = readOrNull()?.lines?.[k(sid, lid)]; return c && typeof c === 'object' ? { ...c } : null; }
/** 这个服务的全部凭据：线路 id → 凭据。 */
export function credsOf(sid) {
  const out = {};
  for (const [key, c] of Object.entries(readOrNull()?.lines || {})) if (key.startsWith(sid + '/') && c && typeof c === 'object') out[key.slice(sid.length + 1)] = { ...c };
  return out;
}
export function allCreds() {
  return Object.entries(readOrNull()?.lines || {}).filter(([, c]) => c && typeof c === 'object').map(([key, c]) => {
    const i = key.indexOf('/');
    return { sid: key.slice(0, i), lid: key.slice(i + 1), cred: { ...c } };
  });
}
export function putCred(sid, lid, cred) { mutate((m) => { m.lines[k(sid, lid)] = { ...cred }; }); }
/** 只在这条线路的凭据还在时合并进去（刷新回来时线路可能已经被删了：别把删掉的账号写回来）。 */
export function patchCred(sid, lid, patch) {
  return mutate((m) => {
    const cur = m.lines[k(sid, lid)];
    if (!cur) return false;
    m.lines[k(sid, lid)] = { ...cur, ...patch };
    return true;
  });
}
/** 删掉这些线路的凭据（lids 不给 = 整个服务），返回删掉的凭据（调用方拿去吊销）。 */
export function dropCreds(sid, lids = null) {
  const cur = readOrNull();
  const hit = Object.keys(cur?.lines || {}).filter((key) => key.startsWith(sid + '/') && (!lids || lids.includes(key.slice(sid.length + 1))));
  if (!hit.length) return [];
  return mutate((m) => hit.map((key) => { const c = m.lines[key]; delete m.lines[key]; return c; }).filter(Boolean));
}

/** 给界面看的账号状态（不带令牌）。 */
export function accountView(line, cred) {
  const base = { lineId: line.id, label: line.label, enabled: line.enabled !== false };
  if (!cred) return { ...base, email: '', status: 'missing', statusText: '这个账号的登录凭据不见了，请重新登录', expiresAt: 0, refreshedAt: 0 };
  const status = cred.needsLogin ? 'relogin' : cred.planOk === false ? 'no_plan' : 'ok';
  const statusText = status === 'relogin' ? cred.needsLoginWhy || '登录已失效，请重新登录'
    : status === 'no_plan' ? '这个账号没有授权使用 ChatGPT 套餐额度，请重新登录并同意'
      : '';
  return { ...base, email: cred.email || '', status, statusText, expiresAt: cred.expiresAt || 0, refreshedAt: cred.refreshedAt || cred.savedAt || 0 };
}
