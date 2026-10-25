// 身份与总览：我是谁、能用什么、现在在跑什么、额度还剩多少。

import { defineGroup, defineOp, OpError, allOps, whyNot } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { getLiveGens } from '../../runtime/gen.mjs';
import { sessionQuestions } from '../../runtime/questions.mjs';
import { programVersion } from '../../feedback/report.mjs';
import { PUBLIC_ORIGIN, FEATURES } from '../../config/index.mjs';
import { AGENT_BY_ID } from '../../config/agents.mjs';
import * as routines from '../../routines.mjs';
import { routineRunning } from '../../runtime/routines-runner.mjs';
import { getUiState } from '../../runtime/ui-state.mjs';
import { pendingOf } from './chat.mjs';

defineGroup('core', '身份与总览', '我是谁、能用什么、现在在跑什么。');

const TIER_LABEL = { admin: '服务器主机（管理员）', pro: 'Pro 账号（完全信任，有命令行）', user: '普通账号（没有命令行）' };

defineOp({
  name: 'whoami', title: '我是谁、能用什么',
  desc: '返回调用者身份、档位、对他开着的 agent（Muse Bridge 只有 claude 与 dimensio）、服务器版本与地址，以及能用的操作数。第一次接入先调它。',
  handler: async (ctx, args, env) => {
    const ops = allOps();
    const usable = ops.filter((op) => !whyNot(ctx, op)).length;
    return {
      server: { name: 'Muse Bridge', version: programVersion(), origin: env.origin || PUBLIC_ORIGIN || '', multiUser: !!FEATURES.multiUser },
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
  desc: '一眼看全：正在跑的 Claude 对话、在等人回答的提问与审批、定时任务、用户此刻开着哪些 Muse Bridge 界面。用户问「现在哪个 AI 在干活 / 任务跑完没」就看这个。dimensio 的对话不在这里。',
  handler: async (ctx) => {
    const runs = getLiveGens(ctx.key).filter((g) => g.sessionId).map((g) => ({
      sessionId: g.sessionId, startedAt: g.startedAt || 0, prompt: String(g.userText || '').slice(0, 200), ...(g.source ? { source: g.source } : {}),
    }));
    const pending = [...sessionQuestions.keysFor(ctx.key)].flatMap((sid) => pendingOf(ctx, sid)).map((p) => ({ id: p.id, sessionId: p.sessionId, kind: p.kind, summary: p.title || p.question || p.questions?.[0]?.question || '' }));
    let rs = [];
    try { rs = routines.list(ctx.dataDir); } catch {}
    return {
      claude: { running: runs, pending },
      routines: {
        total: rs.length, enabled: rs.filter((r) => r.enabled).length,
        running: rs.filter((r) => routineRunning.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
        next: rs.filter((r) => r.enabled && r.nextRun).sort((a, b) => a.nextRun - b.nextRun).slice(0, 3).map((r) => ({ id: r.id, name: r.name, at: r.nextRun })),
      },
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
