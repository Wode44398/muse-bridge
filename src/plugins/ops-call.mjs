// ctx.ops.call(name, args?, { who }?)：插件服务端以某个身份调 bridge 的【只读】agent 操作（sessions.list / sessions.read / projects.list …），
// 和 agent 经 HTTP / bridge_call 调的是同一张操作表（agent-api/registry.mjs）：参数校验、按身份判权限、要哪个 agent 开着，全照原样。
//
// 为什么只读：会改东西的操作（chat.send、routines.create……）要用户批准或至少对用户可见；插件替人发消息另有 ctx.chat。
// who：list / handler 收到的身份上下文；缺省 = 服务器主机。快照访客、分享访客、插件沙箱这类非登录身份一律拒（同 agent 接口）。
// 能力名 ops.call。
import { callOp, getOp, OpError, apiAllowed } from '../agent-api/registry.mjs';
import { identityOfCtx } from '../agent-api/internal.mjs';
import { contextFor } from '../runtime/identity.mjs';

const HOST = Object.freeze({ kind: 'admin', user: null });
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

function identityOf(who) {
  if (who == null) return HOST;
  if (typeof who !== 'object' || typeof who.kind !== 'string') throw new OpError('bad_args', 'ctx.ops.call 的 who 要是身份上下文（list / handler 收到的那个）');
  const id = identityOfCtx(who);
  if (!id) throw new OpError('forbidden', '这个身份不能用 bridge 操作（需要服务器主机或账号）');
  return id;
}

/** → 操作返回的数据（普通 JSON）。出错抛 OpError（code / message / hint），插件自己 catch。 */
export async function pluginOpsCall(plugin, name, args = {}, { who, signal } = {}) {
  const n = String(name || '');
  if (!NAME_RE.test(n)) throw new OpError('bad_args', `操作名「${n.slice(0, 60)}」不对（形如 sessions.list）`);
  const op = getOp(n);
  if (!op) throw new OpError('not_found', `没有操作「${n}」`, { hint: '这台 bridge 的操作目录见手册的接口参考；对应功能关着时它的操作也不在' });
  if (op.access !== 'read') throw new OpError('forbidden', `ctx.ops.call 只能调只读操作（${n} 会改东西）`, { hint: '替人发消息用 ctx.chat；要用户能看见、能批准的写操作交给 agent 去调' });
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) throw new OpError('bad_args', 'ctx.ops.call 的 args 要是对象');
  const identity = identityOf(who);
  const opCtx = contextFor(identity);
  if (!apiAllowed(opCtx)) throw new OpError('forbidden', '这个身份不能用 bridge 操作');
  const data = await callOp(opCtx, n, args || {}, { via: 'plugin', plugin, origin: '', identity, signal: signal || null });
  // 给插件的是副本：操作里可能直接回了内部对象
  return JSON.parse(JSON.stringify(data ?? {}));
}

export function makeOps(ctx) {
  return {
    call: (name, args, opts) => pluginOpsCall(ctx.id, name, args, opts),
  };
}
