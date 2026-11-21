// Antigravity 功能扩展入口：只做钩子编排与具名能力导出，具体实现在 acp/、agents/、routes/ 等子模块。

import { agentEnabled } from '@bridge/core/runtime/agent-status.mjs';
import { getLiveGens, listGens } from '@bridge/core/runtime/gen.mjs';
import {
  agyInstalled, agyCredentialsPresent, warmupAgy, restartAgy, shutdownAgy, getAgyDaemonStatus, getAcpClient,
} from './acp/index.mjs';
import { handleAgyChat } from './agents/agy.mjs';
import { registerAgyRoutes } from './routes/agy.mjs';
import { agyLive } from './presence.mjs';
import { rejectDeletedChat } from './session-purge.mjs';
import { agyAgentOps } from './agent-ops.mjs';
import { ensureAgyUpstream, hasNonLocalAccounts } from './pool/index.mjs';
import { accountEvents } from '@bridge/core/runtime/account-lifecycle.mjs';
import { endTenantByKey, tenantStats } from './tenants.mjs';
import { agyGenKey } from './presence.mjs';
import { stopAllMonitorsForKey, stopAllSubagentMonitors } from './subagent-monitor.mjs';

export { warmupAgy, restartAgy, shutdownAgy, getAgyDaemonStatus };

export function adminStatus() {
  const st = getAgyDaemonStatus();
  return {
    enabled: agentEnabled('agy'),
    installed: Boolean(st.cliInstalled),
    running: Boolean(st.running),
    state: st.state || 'idle',
    pid: st.pid || null,
    uptimeSec: st.uptimeMs ? Math.floor(st.uptimeMs / 1000) : 0,
    activeTurns: Array.isArray(st.activeTurns) ? st.activeTurns.length : 0,
    mountedSessions: Array.isArray(st.mountedSessions) ? st.mountedSessions.length : 0,
    stoppedAfterCrashes: Boolean(st.stoppedAfterCrashes),
    // 注册成员各自的进程（每人一个，闲置自动退出）
    tenants: tenantStats(),
  };
}

// 账号停用 / 删除 / 降成普通档：他在跑的 agy 轮当场中止、他的 agy 进程收掉；删号且选的是「数据一并删除」时连 agy 数据一起清
//（选归档的留在 <数据根>/agy/tenants/ 下原处，不动）。
// 核心的账号生命周期只管 Claude 那一侧的轮（键是 u:<id>），agy 的轮记在 agy:u:<id> 下、进程在这个扩展里，得自己接。
export function endAgyForAccount({ key = '', id = '' } = {}, { purge = false } = {}) {
  if (!key) return { aborted: 0, stopped: false, purged: false };
  stopAllMonitorsForKey(key);
  let aborted = 0;
  for (const live of getLiveGens(agyGenKey(key))) {
    try { live.abort.abort(); aborted++; } catch {}
  }
  return { aborted, ...endTenantByKey(key, { userId: id, purge }) };
}
accountEvents.on('ended', (e) => { try { endAgyForAccount(e, { purge: e?.reason === 'deleted' && e?.data !== 'archive' }); } catch (err) { console.error('[agy] 收尾账号失败：', err?.message || err); } });
accountEvents.on('downgraded', (e) => { try { endAgyForAccount(e); } catch (err) { console.error('[agy] 收尾账号失败：', err?.message || err); } });

export function killDaemon() {
  stopAllSubagentMonitors();
  for (const item of listGens()) {
    if (String(item.key || '').startsWith('agy:')) {
      for (const live of getLiveGens(item.key)) {
        try { live.abort.abort(); } catch {}
      }
    }
  }
  shutdownAgy();
  return adminStatus();
}

export function runnable() {
  return agyInstalled();
}

export function agyAuthed() {
  if (hasNonLocalAccounts()) return true;
  const client = getAcpClient();
  if (client.authState === 'logged_out') return false;
  if (client.authState === 'authed' || client.lastTier) return true;
  return agyCredentialsPresent();
}

export function register(router, { authOk, identify }) {
  registerAgyRoutes(router, { authOk, identify });
}

export function startup() {
  if (process.env.AGY_NO_WARMUP === '1') return;
  if (agentEnabled('agy')) {
    ensureAgyUpstream().catch(() => {});
    warmupAgy().catch((err) => {
      const m = String(err?.message || err);
      if (/ENOENT/.test(m)) console.log('[agy] 未找到 Antigravity CLI，分页不可用');
      else console.warn('[agy] ACP 预热失败，将在首条对话时重试：', m);
    });
  }
}

export const chat = {
  agy: rejectDeletedChat(handleAgyChat),
};

// bridge 的 agent 操作（sessions.* / chat.* 带 agent:'agy'）落到这里，见 src/modules/registry.mjs 的 agentOps
export const agentOps = {
  agy: agyAgentOps,
};

// 这个身份眼下在跑的 agy 轮与在等人的卡（GET /api/active 与总线 hello 的 ext）
export function live(ctx) {
  if (!ctx?.allowAgy) return null;
  return agyLive(ctx);
}

// agy 的「在等你 / 完成 / 出错」由服务端发会话消息通知（presence.mjs），前端不用再自己凑
export const notices = true;
