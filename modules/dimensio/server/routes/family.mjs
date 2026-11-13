// 会话协作的同机接口（dimensio harness → bridge，harness/server/session-family.ts 的 familyBridge.call）：
//   POST /agent/family/spawn   dimensio 会话开一个 Claude 子会话
//   POST /agent/family/send    dimensio 会话给 Claude 会话发消息 / 子会话（dimensio）给 Claude 父会话汇报
//   POST /agent/family/state   dimensio 子会话（父会话是 Claude 的）开工 / 收工
//   POST /agent/family/info    问几个 Claude 会话的标题 / 状态 / 最新回答（只答跟 dimensio 会话有父子关系的）
// 鉴权 = 同机实例凭据（核心 agent-api/instance-auth.mjs instanceCaller）：只认本机直连；管理员实例的主机密钥 → 管理员，
// 成员实例的按人令牌 → 他本人——碰得到的只有这个身份自己的 Claude 会话（父子台账、会话都按身份分）。只给 dimensio 实例
//（按人令牌里签着 agent；主机密钥看它自报的 X-Bridge-Agent），而且这个身份要有 Claude。
// 运行时在核心 runtime/session-family.mjs（spawnFromForeign / deliverFromForeign / foreignState / foreignInfo）。
import { instanceCaller } from '@bridge/core/agent-api/instance-auth.mjs';
import { readBody } from '@bridge/core/runtime/body.mjs';
import { spawnFromForeign, deliverFromForeign, foreignState, foreignInfo } from '@bridge/core/runtime/session-family.mjs';

const bearer = (req) => { const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); return m ? m[1].trim() : ''; };
const reply = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const str = (v, n) => String(v ?? '').slice(0, n);
export const FAMILY_PATHS = ['spawn', 'send', 'state', 'info'].map((op) => '/agent/family/' + op);

export async function handleFamily(op, req, res) {
  const who = instanceCaller(req, bearer(req));
  if (!who) return reply(res, who === null ? 403 : 401, { ok: false, error: who === null ? 'forbidden' : 'unauthorized' });
  if (who.instance !== 'dimensio') return reply(res, 403, { ok: false, error: '会话协作接口只给 dimensio 实例' });
  if (!who.ctx || !who.ctx.allowClaude) return reply(res, 403, { ok: false, error: '这个账号没有 Claude' });
  let b;
  try { b = JSON.parse((await readBody(req, 256 * 1024)) || '{}'); } catch { return reply(res, 400, { ok: false, error: 'bad json' }); }
  if (!b || typeof b !== 'object') b = {};
  try {
    if (op === 'spawn') {
      const r = await spawnFromForeign(who.ctx, who.identity, {
        parent: str(b.parent, 100), parentTitle: str(b.parentTitle, 120), parentName: str(b.parentName, 40),
        title: str(b.title, 60), prompt: str(b.prompt, 32_000), background: str(b.background, 32_000),
        ...(b.project ? { project: str(b.project, 300) } : {}), ...(b.name ? { name: str(b.name, 24) } : {}),
      });
      return reply(res, 200, r.ok ? r : { ok: false, code: r.code, error: r.reason });
    }
    if (op === 'send') {
      const r = await deliverFromForeign(who.ctx, who.identity, {
        from: str(b.from, 100), fromName: str(b.fromName, 40), fromTitle: str(b.fromTitle, 120), to: str(b.to, 100),
        kind: b.kind === 'note' ? 'note' : 'message', text: str(b.text, 20_000), status: str(b.status, 20),
      });
      return reply(res, 200, r.ok ? r : { ok: false, error: r.reason });
    }
    if (op === 'state') return reply(res, 200, { ok: foreignState(who.ctx, { sid: str(b.sid, 100), working: b.working === true }) });
    if (op === 'info') return reply(res, 200, { ok: true, sessions: await foreignInfo(who.ctx, Array.isArray(b.ids) ? b.ids.map((x) => str(x, 100)) : []) });
    return reply(res, 404, { ok: false, error: 'unknown op' });
  } catch (e) {
    return reply(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

export function registerFamilyRoutes(router) {
  for (const op of ['spawn', 'send', 'state', 'info']) router.on('POST', '/agent/family/' + op, (req, res) => handleFamily(op, req, res));
}
