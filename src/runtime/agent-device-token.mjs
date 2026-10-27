// 同机 agent 子进程的「按人设备凭据」：给注册用户的 dimensio 实例（每人一个 harness 进程）用。
//
// 主机密钥（host-secret.mjs）能操作管理员名下的全部设备，只能给管理员实例；注册用户的实例要的是
// 「只能操作他自己的电脑」——所以发一把由主机密钥派生、绑死账号的令牌：
//   dvt1.<agent>.<base64url(账号 id)>.<HMAC-SHA256(主机密钥, 'bridge-agent-device-v1\n<agent>\n<账号 id>')>
// 无状态：bridge 重启照认；主机密钥一换全部作废（子进程重启才拿到新的）。
// 认的时候现查账号库：账号删了 / 停用了 / 不再授权这个 agent，令牌当场失效，不用等进程被回收。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { ensureHostSecret } from './host-secret.mjs';
import { userIdentity, contextFor } from './identity.mjs';

const PREFIX = 'dvt1';
const AGENTS = new Set(['dimensio']);
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = (s) => { try { return Buffer.from(String(s), 'base64url').toString('utf8'); } catch { return ''; } };
const mac = (agent, userId) => createHmac('sha256', ensureHostSecret()).update(`bridge-agent-device-v1\n${agent}\n${userId}`).digest('base64url');

/** 给某个注册用户的 agent 实例铸设备令牌。userId = 账号 id（ctx.user）。 */
export function mintAgentDeviceToken(userId, agent = 'dimensio') {
  const id = String(userId || '');
  if (!id || !AGENTS.has(agent)) throw new Error('agent device token: bad user / agent');
  return `${PREFIX}.${agent}.${b64(id)}.${mac(agent, id)}`;
}

/** 形状像不像（不验签）：路由先用它分流「主机密钥 / 按人令牌」。 */
export const looksLikeAgentDeviceToken = (t) => typeof t === 'string' && t.startsWith(PREFIX + '.');

/**
 * 验令牌并现拼调用者的 ctx。返回 { ctx, agent } 或 null（签名不对、账号没了 / 停用、不再授权该 agent）。
 */
export function agentDeviceTokenCtx(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX || !AGENTS.has(parts[1])) return null;
  const [, agent, idPart, sig] = parts;
  const userId = unb64(idPart);
  if (!userId) return null;
  const want = Buffer.from(mac(agent, userId));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const ident = userIdentity(userId);
  if (!ident) return null;
  // 看的是按人授权（管理员给这个人勾没勾 dimensio）：收回授权当场失效。全局关掉 dimensio 时 bridge 本来就不再代理、
  // 也不再拉起他的实例，这里不另看全局开关（那还牵涉扩展装没装的探测，与这把令牌无关）。
  if (!(ident.agents || []).includes(agent)) return null;
  return { ctx: contextFor(ident), agent };
}
