// agent 密钥：看自己有哪些、吊销。铸新密钥只在设置页（人在场时）做，接口不给——拿着一把密钥的 agent
// 不该能给自己续命或多铸几把。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { listAgentKeys, revokeAgentKey } from '../../users.mjs';
import { busPublish } from '../../runtime/bus.mjs';

defineGroup('keys', 'agent 密钥', '调用这套接口用的密钥（在设置 › Agent 接入里生成）。');

let adminGen = '';
export function setAdminGen(gen) { adminGen = String(gen || ''); }
// 这个身份名下的密钥属主：主机身份按主令牌指纹（换令牌即全部作废），账号按账号 id。
export function keyOwnerOf(ctx) {
  if (!ctx) return null;
  if (ctx.kind === 'admin') return { admin: true, gen: adminGen };
  if (ctx.kind === 'user') return { user: ctx.user };
  return null;
}

defineOp({
  name: 'keys.list', title: '列出我的 agent 密钥',
  desc: '名字、创建时间、最近使用、到期时间（90 天）。看不到明文——明文只在生成那一刻显示一次。',
  handler: async (ctx, args, env) => ({
    keys: listAgentKeys(keyOwnerOf(ctx)).map((k) => ({ ...k, ...(env.keyId && env.keyId === k.id ? { current: true } : {}) })),
  }),
});

defineOp({
  name: 'keys.revoke', title: '吊销一把 agent 密钥',
  desc: 'id 来自 keys.list。吊销正在用的这把，之后的调用会 401。',
  access: 'danger',
  params: { id: { type: 'string', required: true } },
  handler: async (ctx, args) => {
    const n = revokeAgentKey(keyOwnerOf(ctx), args.id);
    if (!n) throw new OpError('not_found', '没有这把密钥');
    busPublish(ctx.key, { type: 'agent.keys' });
    return { revoked: n };
  },
});
