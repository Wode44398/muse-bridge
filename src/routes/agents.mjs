// 设置「Agent」页的 REST 面（管理员）：看每个 agent 的状态（勾选 / 能跑 / 认证），开关它。
//
// 门禁同扩展中心：admin 身份（token / cookie），可远程——管理员在手机上也能勾选。
// 开关属于主机级设置（影响所有人），不下放注册用户。写操作受 server.mjs 全局 Origin 闸保护。
import { readBody } from '../runtime/body.mjs';
import { agentStatusList, setAgentSwitch } from '../runtime/agent-status.mjs';
import { EDITION, FEATURES } from '../config/index.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

export function registerAgentRoutes(router, { identify }) {
  const gate = (req, res) => {
    const id = identify(req);
    if (id && id.kind === 'admin') return true;
    json(res, id && id.kind !== 'none' ? 403 : 401, { ok: false, error: 'Agent 设置仅对管理员开放' });
    return false;
  };

  router.on('GET', '/api/agents', (req, res) => {
    if (!gate(req, res)) return;
    json(res, 200, { ok: true, edition: EDITION, features: FEATURES, agents: agentStatusList() });
  });

  // { id, enabled } —— 即时生效，并广播 agents.changed 让在线客户端刷新。
  router.on('POST', '/api/agents', async (req, res) => {
    if (!gate(req, res)) return;
    let b = {}; try { b = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    const r = setAgentSwitch(String(b.id || ''), b.enabled === true);
    if (r.error) return json(res, 400, { ok: false, ...r });
    json(res, 200, { ok: true, agents: agentStatusList() });
  });
}
