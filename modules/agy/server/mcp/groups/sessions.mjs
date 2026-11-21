// 工具中枢 · 会话协作：Antigravity 会话开 Claude 子会话、和它们互发消息（运行时在核心 runtime/session-family.mjs）。
//
// 和 Claude 的 mcp__sessions__* 的区别：
//   · 只开 Claude 子会话、只开 fresh（agy 的对话 Claude 分叉不了），工作目录 = 这个 agy 会话的目录，或 project 指定的 Claude 项目；
//   · 没有卡片：agy 前端不认 offer / proposal / family_link 帧，而且 agy 单次工具调用 180 秒硬上限，等不了用户点卡。
//     用户设置是「直接开始」就照开；「先问我 / 只在我要求时」档下 offer / own_initiative 不开，回一句话让模型先在对话里问；
//   · 子会话收工的汇报、子会话发来的消息由 session-family 的收件箱照常攒着，唤醒时交给这里登记的 agy 投递口
//     （deliver.mjs：在跑就排队、没在跑就无头开一轮）。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { pluginOn } from '@bridge/core/plugins/state.mjs';
import { findGenBySession } from '@bridge/core/runtime/gen.mjs';
import { CLAUDE_MODELS } from '@bridge/core/config/capabilities.mjs';
import { isCustomModelId } from '@bridge/core/runtime/claude-providers.mjs';
import {
  registerFamilyAgent, spawnFromAgent, sendToSession, linkedSessions, reportOf, resolveTarget, projectChoices,
  familyForeignUserTurn, wakeSoon,
} from '@bridge/core/runtime/session-family.mjs';
import { getProposal, updateProposal, TASK_ID_RE } from '@bridge/core/runtime/session-proposals.mjs';
import { sessionPolicy } from '@bridge/core/mcp/session-tools.mjs';
import { agyGenKey } from '../../presence.mjs';
import { getSessionMeta } from '../../sessions.mjs';
import { onAgyUserTurn, onAgyTurnEnd } from '../../turn-hooks.mjs';
import { deliverToAgy, RELAY_NOTE } from '../deliver.mjs';
import { agyWording } from '../wording.mjs';

const MIN_BACKGROUND = 80;
const SESSION_TOOLS = new Set(['start_session', 'send_message', 'list_sessions', 'read_session', 'dismiss_task']);
const MAX_BRIEF = 32_000;
const STATE_TXT = { working: '正在干活', idle: '空闲' };
const out = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const agyTitle = (ctx, sid) => {
  const m = sid ? getSessionMeta(ctx?.agyDir, sid) : null;
  return String(m?.customTitle || m?.title || '').slice(0, 120);
};
// 这一轮是 bridge 转来的消息开的（子会话汇报、会话间消息、CI 事件），没有真人在场
const relayTurn = (gen) => String(gen?.userText || '').startsWith(RELAY_NOTE);

// —— session-family 的 agy 口 ——
registerFamilyAgent('agy', {
  state: (ctx, sid) => { const g = findGenBySession(agyGenKey(ctx.key), sid); return g && !g.done ? 'working' : 'idle'; },
  title: (ctx, sid) => agyTitle(ctx, sid),
  report: (ctx, sid, max) => {
    const g = findGenBySession(agyGenKey(ctx.key), sid);
    const evs = Array.isArray(g?.events) ? g.events : [];
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i];
      if (e && (e.type === 'done' || e.type === 'interrupted') && typeof e.result === 'string' && e.result.trim()) return e.result.slice(0, max);
    }
    return '';
  },
  deliver: (ctx, sid, text) => deliverToAgy(ctx, sid, agyWording(text), { ifBusy: 'queue' }),
});
onAgyUserTurn((ctx, sid) => familyForeignUserTurn(ctx, sid));
onAgyTurnEnd((ctx, gen) => { wakeSoon(ctx, gen.sessionId); });

const START_DESC = `Start a separate Claude session (shown in the Claude page sidebar; the user can open, talk to and stop it) for a piece of work, only when the user asks to run something separately / in parallel. No confirmation cards: the call starts it or says why not. It cannot see this conversation, so prompt + background must say everything. When its turn ends, its report arrives here as a new message and you continue — never poll or wait.`;

function startText(r, cwd) {
  const where = r.project ? `它在 Claude 项目「${r.project.name}」（${r.project.path}）里干活` : `它和你在同一个目录（${cwd}）里干活，只提交它自己改的文件`;
  return `已开出 Claude 子会话「${r.title}」（id: ${r.id}，name: ${r.name}），它正在后台干活，用户能在 Claude 分页的侧栏里点开它。${where}；它看不到这段对话和你没提交的改动。它这一轮结束时 bridge 会把它的汇报作为一条新消息转给你并让你接着干——别轮询、别等：用一句话告诉用户已经交给它了，然后结束这一轮或接着做别的。要追加指示用 send_message（to="${r.name}"）。`;
}

export function makeAgySessionsMcp({ ctx, getGen }) {
  const policy = sessionPolicy(ctx);
  const sidOf = () => { const g = getGen && getGen(); return g && g.sessionId; };
  return createSdkMcpServer({
    name: 'agy-sessions',
    version: '1.0.0',
    tools: [
      tool('start_session', START_DESC, {
        title: z.string().describe('Under 60 characters; names the task (shown in the sidebar).'),
        prompt: z.string().describe('The brief: the task, the files or area, what done looks like.'),
        background: z.string().describe(`At least ${MIN_BACKGROUND} characters: overall goal, decisions and constraints so far.`),
        initiation: z.enum(['user_asked', 'offer', 'own_initiative']).optional().describe('Who wants it; default "user_asked".'),
        project: z.string().optional().describe('A Claude project name or id (list_sessions lists them); omit to use this folder.'),
        name: z.string().optional().describe('Short handle ([a-z0-9-], ≤24).'),
        model: z.string().optional().describe('Optional Claude model id; omit for the default.'),
      }, async (a) => {
        const gen = getGen && getGen();
        const sid = gen && gen.sessionId;
        if (!sid) return out('当前会话还没建立好（没有会话 id），先回复用户一句，下一轮再开。', true);
        if (relayTurn(gen)) return out('没有开：这一轮是 bridge 转来的消息（子会话汇报、会话间消息或 CI 事件）开的，不是用户发起的，这种轮里不替用户开新会话。真值得单独做就在回复里提一句，等用户开口。', true);
        const initiation = a.initiation || 'user_asked';
        if (initiation !== 'user_asked' && policy !== 'direct') {
          return out(policy === 'onRequest'
            ? '没有开：用户的设置是只在他明说时才开新会话。这件事就在这里做，或者在回复里用一句话提议。'
            : initiation === 'offer'
              ? '没有开：用户的设置是新会话要先问他。先在对话里问一句「另开一个会话做，还是就在这里做」，用户选另开再带 initiation:"user_asked" 调一次；没选就在这里做。'
              : '没有开：用户的设置是新会话要先问他。在回复里用一句话提议这件后续工作，用户同意了再带 initiation:"user_asked" 调。', true);
        }
        const title = String(a.title || '').trim().slice(0, 60);
        const prompt = String(a.prompt || '').trim();
        const background = String(a.background || '').trim();
        if (!title) return out('title 要给：60 字以内的任务名。', true);
        if (!prompt) return out('要给 prompt：交给新会话的完整任务说明（任务、涉及的文件或范围、做到什么算完）。', true);
        if (background.length < MIN_BACKGROUND) return out(`新会话看不到这段对话，background 至少 ${MIN_BACKGROUND} 个字符：整体目标、已经定下的事和约束、这一块在整件事里的位置。`, true);
        if (prompt.length + background.length > MAX_BRIEF) return out(`任务说明加背景太长了（${prompt.length + background.length} > ${MAX_BRIEF} 个字符），精简一下，新会话自己会读文件。`, true);
        const model = typeof a.model === 'string' && (CLAUDE_MODELS.has(a.model) || isCustomModelId(a.model)) ? a.model : undefined;
        const cwd = gen.cwd || getSessionMeta(ctx.agyDir, sid)?.cwd || '';
        const r = await spawnFromAgent(ctx, { kind: 'admin', user: null }, {
          agent: 'agy', parent: sid, parentTitle: agyTitle(ctx, sid), cwd,
          title, prompt, background, name: a.name, model,
          ...(a.project ? { project: String(a.project).trim().slice(0, 300) } : {}),
        });
        if (!r.ok) return out('没能开出子会话：' + r.reason, true);
        return out(startText(r, cwd) + (a.model && !model ? `（model「${a.model}」不是 Claude 认的模型，按默认模型开的。）` : ''));
      }),
      tool('send_message', 'Send a message to a Claude session you started (or one of its siblings). "to" = its id or name from list_sessions. If it is working the message joins its current turn; if idle it is woken. Its reply comes back here as a new message, so do not poll. A message is not the user speaking.', {
        to: z.string().describe('Session id or name from list_sessions.'),
        message: z.string().describe('Self-contained text.'),
      }, async (a) => {
        const sid = sidOf();
        if (!sid) return out('当前会话还没有 id。', true);
        const text = String(a.message || '').trim();
        if (!text) return out('message 不能为空。', true);
        const r = await sendToSession(ctx, sid, String(a.to || '').trim(), text);
        if (!r.ok) return out('没送到：' + r.reason, true);
        const how = {
          inserted: '对方正在干活，消息已插进它当前这一轮。',
          woke: '对方原本空闲，已唤醒它开一轮来处理。',
          queued: '对方正在收尾，消息排在它的收件箱里，这一轮一结束就送到。',
          held: '对方已经连续自动跑了好几轮，这条先存着，等用户下次在那个会话里发话时一起送到。',
        }[r.how] || '已送达。';
        return out(how + '它的回复会作为一条新消息回到这里，不用轮询。');
      }),
      tool('list_sessions', 'List the Claude sessions started from this conversation (id, name, title, working or idle, start of the latest reply) and the user\'s Claude projects for start_session project.', {}, async () => {
        const sid = sidOf();
        if (!sid) return out('当前会话还没有 id。');
        const f = await linkedSessions(ctx, sid, { reports: true });
        const rows = [...f.children, ...f.siblings];
        const line = (s) => `- [${s.relation}] ${s.title || '（无标题）'} — id: ${s.id}${s.name ? `，name: ${s.name}` : ''}，${STATE_TXT[s.state] || s.state}${s.report ? `\n  最新回复开头：${s.report.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
        const projs = projectChoices(ctx);
        const ptail = projs.length ? `\n用户的 Claude 项目（start_session 的 project 填名字或 id）：\n${projs.map((p) => `- ${p.name} — id: ${p.id}，${p.path}${p.def ? '（默认工作空间）' : ''}`).join('\n')}` : '';
        return out((rows.length ? '你开的会话：\n' + rows.map(line).join('\n') : '这个会话还没开过子会话。') + ptail);
      }),
      tool('read_session', 'Read the latest reply (up to ~6000 characters) of a session you started — to check a result before telling the user it is done.', {
        to: z.string().describe('Session id or name from list_sessions.'),
      }, async (a) => {
        const sid = sidOf();
        if (!sid) return out('当前会话还没有 id。', true);
        const target = resolveTarget(ctx, sid, String(a.to || '').trim());
        if (!target) return out(`找不到你开的会话「${a.to}」，用 list_sessions 看 id 和 name。`, true);
        const text = await reportOf(ctx, target, 6000);
        return out(text ? `会话 ${target} 最新一条回复：\n\n${text}` : '这个会话还没有回复（可能刚开跑）。');
      }),
      tool('dismiss_task', 'Withdraw a session card by its task_id. Antigravity shows no cards (start_session starts or refuses at once), so normally there is nothing to withdraw.', {
        task_id: z.string().describe('task_xxxxxxxx'),
      }, async (a) => {
        const sid = sidOf();
        const id = String(a.task_id || '').trim();
        const p = sid && TASK_ID_RE.test(id) ? getProposal(ctx, id) : null;
        if (!p || p.parent !== sid) return out(`这个会话里没有 task_id 为 ${id || '(空)'} 的待开始任务：Antigravity 这边不出卡片，没有要撤回的。`);
        if (p.status === 'pending' || p.status === 'unanswered' || p.status === 'start_failed') {
          updateProposal(ctx, id, { status: 'dismissed', reason: 'withdrawn' });
          return out(`任务 ${id} 已撤回。`);
        }
        return out(`任务 ${id} 已经不在等待中（${p.status}），什么都没改。`);
      }),
    ],
  });
}

export const SESSIONS_GROUP = Object.freeze({
  key: 'sessions',
  setting: 'sessions',
  bare: true,
  owns: (name) => SESSION_TOOLS.has(name),
  available: (ctx) => pluginOn('session-tools') && ctx?.kind === 'admin',
  build: ({ ctx, getGen }) => makeAgySessionsMcp({ ctx, getGen }),
});
