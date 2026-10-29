// 同机 agent 实例（dimensio：每个成员一个 harness 进程）调 /agent/manual* 与 /agent/v1/<操作> 的凭据。
//
// 实例不拿 agent 密钥，出示的是 bridge 拉起它时经环境变量给的设备通道凭据（BRIDGE_DEVICE_SECRET，见
// modules/dimensio/server/routes/harness.mjs 的 deviceEnv）——同一把凭据，两处认法一致（src/routes/devices.mjs internalCtx）：
//   · 主机密钥（runtime/host-secret.mjs）→ 管理员身份（管理员实例）；
//   · 按人令牌 dvt1.…（runtime/agent-device-token.mjs）→ 那个成员本人。现查账号库：删号 / 停用 / 收回该 agent 的按人授权即失效；
//     令牌里的账号 id 被签名绑死，只能当它所属的那个人。
// 两种都只认本机直连（socket 是回环、不带任何代理 / 隧道转发头）：凭据万一漏出去，经公网也用不了。
//
// 操作范围照 bridge 里 Claude 的 mcp__bridge__call（mcp/bridge-tools.mjs）：设备组与媒体组不给——实例有自己的 Device* 工具，
// 截图 / 媒体这类大块二进制也不适合走文本。铸 agent 密钥只在设置页（/api/agent-keys/create 走 identify，不认这两种凭据），
// 操作表里也没有铸密钥的操作；控制台路由认 authOk，同样不认。

import { timingSafeEqual } from 'node:crypto';
import { ensureHostSecret, isLocalDirect } from '../runtime/host-secret.mjs';
import { looksLikeAgentDeviceToken, agentDeviceTokenCtx } from '../runtime/agent-device-token.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { identityOfCtx } from './internal.mjs';

/** 实例调不到的操作：设备组（操作电脑用实例自己的 Device* 工具）。媒体组由 设置 › Agent › Gemini 按实例放行（ops/media.mjs）。 */
export const instanceExcluded = (name) => /^devices\./.test(String(name || ''));

function isHostSecret(tok) {
  const want = ensureHostSecret();
  if (!want || !tok || tok.length !== want.length) return false;
  try { return timingSafeEqual(Buffer.from(tok), Buffer.from(want)); } catch { return false; }
}

// 挂在 ctx 上，registry.whyNot 据此把排除的操作判成不可用（目录、whoami 的计数、执行三处一致）
const opDeny = (op) => (instanceExcluded(op.name)
  ? `同机 agent 实例不从这里调「${op.group}」组：操作电脑用实例自己的 Device* 工具`
  : null);

/**
 * 认请求头里的凭据是不是同机实例的。
 *   undefined = 不是这两种凭据（交回原来的 identify：agent 密钥、主令牌……）；
 *   null      = 是实例凭据但不认（非本机直连、签名不对、账号停用 / 删了、收回了授权）；
 *   对象      = { identity, ctx, key: null, instance }。
 */
export function instanceCaller(req, tok) {
  if (!tok) return undefined;
  const scoped = looksLikeAgentDeviceToken(tok);
  if (!scoped && !isHostSecret(tok)) return undefined;
  if (!isLocalDirect(req)) return null;
  let identity, instance;
  if (scoped) {
    const hit = agentDeviceTokenCtx(tok);
    identity = hit ? identityOfCtx(hit.ctx) : null;
    if (!identity) return null;
    instance = hit.agent;
  } else {
    identity = { kind: 'admin', user: null };
    // 主机密钥也给 Codex 的 stdio MCP：是谁只看它自报的 X-Bridge-Agent（只用来标日志 / 上报来源，不影响权限）
    const said = String(req.headers['x-bridge-agent'] || '');
    instance = /^[a-z]{2,16}$/.test(said) ? said : 'host';
  }
  const ctx = contextFor(identity);
  ctx.opDeny = opDeny;
  ctx.agentCaller = instance;   // 'dimensio' / 'codex' / 'host'：媒体组按它查 设置 › Agent › Gemini
  return { identity, ctx, key: null, instance };
}
