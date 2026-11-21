// 工具中枢 · 拉取请求：Antigravity 会话与它的 PR 绑在一起（看 CI / 评审、同步基线、自动修复、自动合并）。
//
// 台账、后台扫描、GitHub 操作全在核心 runtime/pr-monitor.mjs，与 Claude 的 PR 卡、dimensio 同一份；
// agy 会话在台账里记成 'agy:<会话 id>'，工作目录每次调用时报一下（noteAgentSession），自动修复叫醒走这里登记的投递口
// （deliver.mjs：只在会话空闲时开一轮，正在跑就回 busy，下次扫描再来）。
// 一轮跑完从回复里认 <pr-created>链接</pr-created> 自动绑定；真人发话清零连续唤醒计数（turn-hooks.mjs）。
// 开自动修复 / 自动合并是长期授权：先认 agy 审批卡上的手动允许，没有就在对话里弹卡问（120 秒没人答 = 不开）；
// 自动修复叫醒的那一轮（输入里有第三方写的评论）里不许开。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { pluginOn } from '@bridge/core/plugins/state.mjs';
import {
  prView, prOp, prCapable, identityCtx, noteAgentSession, bindReported, notePrTurnStart, registerPrAgent,
} from '@bridge/core/runtime/pr-monitor.mjs';
import { statusPayload } from '@bridge/core/mcp/pr-tools.mjs';
import { getSessionMeta } from '../../sessions.mjs';
import { onAgyUserTurn, onAgyTurnEnd } from '../../turn-hooks.mjs';
import { deliverToAgy, RELAY_NOTE } from '../deliver.mjs';
import { askAgyUser, takeManualApproval } from '../ask.mjs';
import { agyWording } from '../wording.mjs';

const PR_CREATED_RE = /<pr-created>\s*(https?:\/\/[^\s<]+)\s*<\/pr-created>/g;
const keyOf = (sid) => `agy:${sid}`;
const out = (t, isError = false) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], ...(isError ? { isError: true } : {}) });
// 自动修复叫醒的轮：deliver.mjs 开的、正文是 <ci-monitor-event>
const ciTurn = (gen) => { const t = String(gen?.userText || ''); return t.startsWith(RELAY_NOTE) && t.includes('<ci-monitor-event'); };

function note(ctx, sid, cwd) {
  noteAgentSession(ctx, keyOf(sid), { cwd: cwd || getSessionMeta(ctx.agyDir, sid)?.cwd || '', prefs: { autoFix: false, attribution: true } });
}

registerPrAgent('agy', {
  deliver: (ctx, sid, text) => deliverToAgy(ctx, sid, agyWording(text), { ifBusy: 'busy' }),
});
onAgyUserTurn((ctx, sid) => { if (prCapable(ctx) && pluginOn('pr')) notePrTurnStart(ctx, keyOf(sid)); });
onAgyTurnEnd(async (ctx, gen, { text }) => {
  if (!text || !text.includes('<pr-created>') || !prCapable(ctx) || !pluginOn('pr')) return;
  note(ctx, gen.sessionId, gen.cwd);
  for (const m of text.matchAll(PR_CREATED_RE)) await bindReported(ctx, keyOf(gen.sessionId), m[1], { source: 'tag' });
});

async function userOk(ctx, gen, tool, args, message, detail) {
  if (takeManualApproval(gen, tool, args)) return true;
  return (await askAgyUser(ctx, gen, { message, detail })) === 'allow';
}

export function makeAgyPrMcp({ ctx, getGen }) {
  const base = identityCtx(ctx);
  const run = async (fn) => {
    const gen = getGen && getGen();
    const sid = gen && gen.sessionId;
    if (!sid) return out('当前会话还没有 id，先回复用户一句，下一轮再调。', true);
    note(base, sid, gen.cwd);
    try { return await fn(sid, gen); } catch (e) { return out(e && e.message ? e.message : String(e), true); }
  };
  return createSdkMcpServer({
    name: 'agy-pr',
    version: '1.0.0',
    tools: [
      tool('pr_status', 'Read the pull request bound to this session: number, url, state, branches, CI check counts and failing checks, review decision, mergeability, auto_fix / auto_merge. Served from bridge\'s cache — use it after `gh pr create` instead of polling `gh pr checks`.', {}, async () => run(async (sid) => out(statusPayload(await prView(base, keyOf(sid)))))),
      tool('pr_bind', 'Bind an existing GitHub pull request (one of this checkout\'s remotes) to this session. bridge already binds one you report as <pr-created>URL</pr-created> in your reply.', {
        url: z.string().describe('https://github.com/owner/repo/pull/123'),
      }, async (a) => run(async (sid) => {
        const r = await prOp(base, keyOf(sid), 'bind', { url: a.url }, { fromTool: true });
        return out(r.outcome === 'exists' ? '已经绑在这个会话上了。' : `已把 ${a.url} 绑到这个会话。`);
      })),
      tool('pr_unbind', 'Stop tracking a pull request for this session (auto-fix / auto-merge watching stop with it).', {
        url: z.string().describe('The pull request URL'),
      }, async (a) => run(async (sid) => {
        const r = await prOp(base, keyOf(sid), 'unbind', { url: a.url }, { fromTool: true });
        return out(r.ok ? `已不再跟踪 ${a.url}。` : '这个会话没绑这个拉取请求（或早就移出了）。');
      })),
      tool('pr_sync_base', 'Merge the base branch into this session\'s branch on the host (fetch + merge, no push). Result: merged / up_to_date / conflicts (resolve, git add, git commit --no-edit; or call again with abort:true) / refused / failed. Use it instead of git pull.', {
        base: z.string().optional().describe('Base branch; defaults to the PR\'s base.'),
        abort: z.boolean().optional().describe('Abort a merge this tool left in progress.'),
      }, async (a) => run(async (sid) => out(await prOp(base, keyOf(sid), 'syncBase', { base: a.base, abort: !!a.abort }, { fromTool: true })))),
      tool('pr_set_monitor', 'Turn Auto-fix on or off: bridge wakes this session with a <ci-monitor-event> message when CI fails, merge conflicts appear or new review comments arrive. Only when the user asked; turning it on asks the user first.', {
        auto_fix: z.boolean(),
      }, async (a) => run(async (sid, gen) => {
        if (a.auto_fix) {
          if (ciTurn(gen)) return out('自动修复叫醒的这一轮里不能开自动修复：请用户自己在对话里说要开。', true);
          const ok = await userOk(base, gen, 'pr_set_monitor', { auto_fix: true }, 'Antigravity 想为这个会话打开「自动修复拉取请求」，允许吗？', 'CI 失败、合并冲突或有新评审意见时，bridge 会叫醒这个会话去修，并推送到拉取请求的分支');
          if (!ok) return out('用户没有同意（拒绝或 120 秒内没回应），自动修复保持关闭。用户没再提就别再问。', true);
        }
        await prOp(base, keyOf(sid), 'monitor', { autoFix: !!a.auto_fix }, { fromTool: true });
        return out(a.auto_fix ? '自动修复已开：CI 失败、合并冲突、新评审意见时 bridge 会叫醒这个会话，不用自己轮询 CI。' : '自动修复已关。');
      })),
      tool('pr_set_auto_merge', 'Turn auto-merge on or off for the bound pull request: it merges as soon as required checks pass and reviews allow. Never enable it unless the user asked; turning it on asks the user first.', {
        enabled: z.boolean(),
        merge_method: z.enum(['squash', 'merge', 'rebase']).optional(),
        url: z.string().optional().describe('PR URL (optional with one open PR).'),
      }, async (a) => run(async (sid, gen) => {
        const fromCiTurn = ciTurn(gen);
        if (a.enabled && !fromCiTurn) {
          const p = statusPayload(await prView(base, keyOf(sid)));
          const num = (/\/pull\/(\d+)/.exec(String(a.url || '')) || [])[1] || (p.pr ? String(p.pr.number) : '');
          const ok = await userOk(base, gen, 'pr_set_auto_merge', { enabled: true }, num ? `Antigravity 想为拉取请求 #${num} 开启「就绪后自动合并」，允许吗？` : 'Antigravity 想为这个会话的拉取请求开启「就绪后自动合并」，允许吗？', '必需的检查和评审通过后直接合进基线分支，不再逐次确认');
          if (!ok) return out('用户没有同意（拒绝或 120 秒内没回应），自动合并保持关闭。用户没再提就别再问。', true);
        }
        const r = await prOp(base, keyOf(sid), 'autoMerge', { url: a.url, enabled: a.enabled, method: a.merge_method }, { fromTool: true, fromCiTurn });
        if (!a.enabled) return out('自动合并已关。');
        return out(r.by === 'github' ? '自动合并已开：必需的检查通过、评审允许后 GitHub 会自动合并。' : '自动合并已开：这个仓库没开 GitHub 原生自动合并，检查通过后由 bridge 代为合并（这台电脑在线时）。');
      })),
    ],
  });
}

export const PR_GROUP = Object.freeze({
  key: 'pr',
  setting: 'pr',
  bare: true,
  owns: (name) => name.startsWith('pr_'),
  budgetMs: 150_000,
  available: (ctx) => pluginOn('pr') && prCapable(ctx),
  build: ({ ctx, getGen }) => makeAgyPrMcp({ ctx, getGen }),
});
