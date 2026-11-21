// 身份与总览：我是谁、能用什么、现在在跑什么、额度还剩多少。

import { defineGroup, defineOp, OpError, allOps, whyNot } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { getLiveGens } from '../../runtime/gen.mjs';
import { sessionQuestions } from '../../runtime/questions.mjs';
import { APP_VERSION_NAME, APP_VERSION_CODE } from '../../config/versions.mjs';
import { PUBLIC_ORIGIN, FEATURES, DEPLOY } from '../../config/index.mjs';
import { localOrigin } from '../local-origin.mjs';
import { DISTRO } from '../../config/distro.mjs';
import { AGENT_BY_ID } from '../../config/agents.mjs';
import { interruptedRunsOf } from '../../runtime/inflight.mjs';
import * as routines from '../../routines.mjs';
import { routineRunning } from '../../runtime/routines-runner.mjs';
import { devicesEnabled, ownDevices } from '../../runtime/devices.mjs';
import { getUiState } from '../../runtime/ui-state.mjs';
import { pendingOf } from './chat.mjs';
import { moduleAgentOps, moduleAgentOpsAgents } from '../../modules/registry.mjs';

defineGroup('core', '身份与总览', '我是谁、能用什么、现在在跑什么。');

// 扩展 agent（Antigravity）眼下在跑的轮与在等你的卡：只列对调用者开着、且确有东西的
async function agentOverviews(ctx) {
  const out = [];
  for (const agent of moduleAgentOpsAgents()) {
    if (!(ctx.agents || []).includes(agent)) continue;
    const ops = moduleAgentOps(agent);
    if (!ops || typeof ops.overview !== 'function') continue;
    try {
      const v = await ops.overview(ctx);
      const running = Array.isArray(v?.running) ? v.running : [];
      const pending = Array.isArray(v?.pending) ? v.pending : [];
      if (running.length || pending.length) out.push({ agent, label: String(v.label || agent), running, pending });
    } catch (e) {
      console.warn('[agent-api] ' + agent + ' overview 出错：', e?.message || e);
    }
  }
  return out;
}

const TIER_LABEL = { admin: '服务器主机（管理员）', pro: '完全信任成员（有命令行）', user: '普通成员（没有命令行）' };

defineOp({
  name: 'whoami', title: '我是谁、能用什么',
  desc: '返回调用者身份、档位、对他开着的 agent、服务器版本与地址，以及能用的操作数。第一次接入先调它。'
    + 'server.hosting：host = 服务端跑在用户自己的电脑上，server = 跑在服务器 / 云主机 / 容器里（跟用户说「电脑」还是「服务器」照它）；'
    + 'server.brand / distro：发行版（如 Muse Bridge）的产品名与标识，bridge 本体不带 distro。'
    + 'server.origin 是对外地址（没配公网地址、又是从本机 MCP 调的时候为空）；server.local 是服务端在本机监听的地址，'
    + '和服务端在同一台机器上（bridge 拉起的 Claude 就是）自测接口、插件、应用页面用它，别去扫端口猜。',
  handler: async (ctx, args, env) => {
    const ops = allOps();
    const usable = ops.filter((op) => !whyNot(ctx, op)).length;
    return {
      server: {
        name: 'bridge', brand: DISTRO.brand, ...(DISTRO.id !== 'bridge' ? { distro: DISTRO.id } : {}),
        version: APP_VERSION_NAME, versionCode: APP_VERSION_CODE, origin: env.origin || PUBLIC_ORIGIN || '', local: localOrigin(),
        hosting: (DEPLOY && DEPLOY.hosting) || 'host', platform: process.platform, multiUser: !!FEATURES.multiUser,
      },
      you: {
        kind: ctx.kind === 'admin' ? 'host' : 'member',
        ...(ctx.kind === 'user' ? { account: ctx.name || ctx.user } : {}),
        tier: ctx.tier, tierLabel: TIER_LABEL[ctx.tier] || ctx.tier,
        shell: !!ctx.shell,
        agents: (ctx.agents || []).map((id) => ({ id, name: AGENT_BY_ID[id]?.label || id })),
        ...(env.keyLabel ? { via: 'agent 密钥「' + env.keyLabel + '」' } : {}),
      },
      ops: { usable, total: ops.length },
      next: '先读 GET /agent/manual（手册目录）；操作目录见 GET /agent',
    };
  },
});

defineOp({
  name: 'overview', title: '现在在跑什么',
  desc: '一眼看全：正在跑的 Claude 对话、在等人回答的提问与审批、定时任务、在线的设备、用户此刻开着哪些 bridge 界面。用户问「现在哪个 AI 在干活 / 任务跑完没」就看这个。'
    + 'claude.interrupted：被 bridge 服务中途退出（崩溃、重启）打断、还没人打开看过的会话；autoResume=true 表示服务端马上会自动让 Claude 接着做'
    + '（设置 › Claude ›「服务意外重启时」），否则要接着做就 chat.send 在那个会话里说一句「继续」。'
    + 'agents：别的 agent（如 Antigravity，agent=agy）眼下在跑的轮与在等你的审批 / 提问，只在有东西时出现；'
    + '要接着看或回答，sessions.* / chat.* 带上同一个 agent 参数。',
  handler: async (ctx) => {
    const runs = getLiveGens(ctx.key).filter((g) => g.sessionId).map((g) => ({
      sessionId: g.sessionId, startedAt: g.startedAt || 0, prompt: String(g.userText || '').slice(0, 200), ...(g.source ? { source: g.source } : {}),
    }));
    const pending = [...sessionQuestions.keysFor(ctx.key)].flatMap((sid) => pendingOf(ctx, sid)).map((p) => ({ id: p.id, sessionId: p.sessionId, kind: p.kind, summary: p.title || p.question || p.questions?.[0]?.question || '' }));
    let rs = [];
    try { rs = routines.list(ctx.dataDir); } catch {}
    const devs = devicesEnabled() ? ownDevices(ctx) : [];
    const live = new Set(runs.map((r) => r.sessionId));
    const interrupted = interruptedRunsOf(ctx.key).filter((r) => !live.has(r.sessionId)).map((r) => ({
      sessionId: r.sessionId, at: r.at || 0, prompt: String(r.userText || '').slice(0, 200), ...(r.resuming ? { autoResume: true } : {}),
    }));
    const others = await agentOverviews(ctx);
    return {
      claude: { running: runs, pending, ...(interrupted.length ? { interrupted } : {}) },
      ...(others.length ? { agents: others } : {}),
      routines: {
        total: rs.length, enabled: rs.filter((r) => r.enabled).length,
        running: rs.filter((r) => routineRunning.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
        next: rs.filter((r) => r.enabled && r.nextRun).sort((a, b) => a.nextRun - b.nextRun).slice(0, 3).map((r) => ({ id: r.id, name: r.name, at: r.nextRun })),
      },
      devices: devs.map((d) => ({ id: d.id, name: d.name, online: !!d.online })),
      ui: getUiState(ctx.key).filter((s) => s.fresh).map((s) => ({ client: s.client, page: s.state?.page || '' })),
    };
  },
});

defineOp({
  name: 'usage', title: '我的额度用量',
  desc: '成员：今天 / 本周已用多少、上限多少、哪些功能对他开着。主机身份不限额（unlimited=true）。',
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'GET', '/api/me/usage');
    if (r.status !== 200 || !r.json) throw new OpError('failed', routeError(r));
    return r.json;
  },
});
