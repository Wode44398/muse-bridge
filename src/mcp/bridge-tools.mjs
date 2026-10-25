// In-process MCP「bridge」：Muse Bridge 自己的 Claude 会话用的「项目手册 + 操作」两件工具。
// 与外部 agent 走 HTTP 的 /agent/v1/<操作> 是同一张操作表（src/agent-api/registry.mjs），这里只是换个入口：
// 身份就是这一轮的身份（不需要密钥），参数与返回完全一样。
//
// 审批（runtime/permissions.mjs）：manual 与只读操作免审批；会改东西的操作在手动模式下照常弹卡。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PUBLIC_ORIGIN } from '../config/index.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { callOp, allOps, OpError } from '../agent-api/registry.mjs';
import { identityOfCtx } from '../agent-api/internal.mjs';
import { manualToc, manualChapter, manualSearch, tocMarkdown, searchMarkdown } from '../agent-api/manual.mjs';
import '../agent-api/ops/index.mjs';   // 登记操作（服务端里 http.mjs 也会 import，模块只求值一次）

const MAX_TEXT = 60_000;

function opList() {
  return allOps().map((op) => `${op.name}（${op.title}${op.access === 'danger' ? '，⚠' : op.access === 'write' ? '，改动' : ''}）`).join('；');
}

export function makeBridgeMcp({ ctx, getGen }) {
  const text = (t) => ({ content: [{ type: 'text', text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '\n…（太长，已截断）' : t }] });
  const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  // 项目会话里 ctx.cwd 是项目目录；操作一律按身份的家目录算（与外部 agent 拿同一把密钥时看到的一致）
  const identity = identityOfCtx(ctx);
  const opCtx = identity ? contextFor(identity) : null;

  return createSdkMcpServer({
    name: 'bridge',
    version: '1.0.0',
    tools: [
      tool(
        'manual',
        `查 Muse Bridge（用户正在用的这个 app 本身）的项目手册：界面在哪、功能怎么用、有没有某功能、各操作的参数。
不带参数 = 目录；topic = 整章（如 claude、workspace、settings、routines、api）；q = 关键词检索，返回最相关的几个小节。
用户问「这个 app 怎么 / 在哪 / 能不能……」先查这里；手册里没有的功能就当没有，别编。`,
        {
          topic: z.string().max(40).optional().describe('章 id'),
          q: z.string().max(200).optional().describe('关键词，空格分隔'),
        },
        async (args) => {
          const origin = PUBLIC_ORIGIN || '';
          if (args.topic) {
            const c = manualChapter(args.topic, opCtx, origin);
            return c ? text(c.markdown) : err('没有这一章：' + args.topic + '。目录：' + manualToc(opCtx, origin).map((x) => x.id).join('、'));
          }
          if (args.q) return text(searchMarkdown(args.q, manualSearch(args.q, opCtx, origin, { limit: 4 })));
          return text(tocMarkdown(opCtx, origin));
        },
      ),
      tool(
        'call',
        `替用户操作 Muse Bridge 本身：调它的一个操作（和外部 agent 经 HTTP 调的同一套）。参数格式与说明见 manual topic=api（或 q=操作名）。
可用操作：${opList()}。
会改东西的操作在手动审批模式下会先请用户批准；标 ⚠ 的（删除、不可撤回）先在对话里征得同意再调。
另开并行会话优先用 mcp__sessions__start_session。`,
        {
          op: z.string().max(60).describe('操作名，如 routines.list'),
          args: z.record(z.string(), z.any()).optional().describe('操作的参数（对象）'),
        },
        async ({ op, args }) => {
          if (!opCtx) return err('这一轮的身份不能用 Muse Bridge 的操作');
          try {
            const g = getGen && getGen();
            const data = await callOp(opCtx, op, args || {}, {
              via: 'mcp', origin: PUBLIC_ORIGIN || '', identity, sessionId: (g && g.sessionId) || '',
              signal: g && g.abort ? g.abort.signal : null,
            });
            return text(JSON.stringify(data, null, 1));
          } catch (e) {
            const m = e instanceof OpError ? `${e.code}：${e.message}${e.hint ? '（' + e.hint + '）' : ''}` : String(e?.message || e);
            return err(m);
          }
        },
      ),
    ],
  });
}

// 系统提示附加段（claude.mjs appendText）：什么时候想起这两件工具。
export const BRIDGE_NUDGE = `

【Muse Bridge 本身】用户问这个 app（Muse Bridge）怎么用、某功能在哪、有没有某功能，或者要你替他操作 Muse Bridge 本身（查 / 建 / 停定时任务、找历史会话、看现在谁在跑、把他的界面带到某页或某个会话、往别的会话里发消息、管 agent 密钥……）时：先用 mcp__bridge__manual 查项目手册（手册里没有的功能就当没有，别编），再用 mcp__bridge__call 调对应操作。删除、花钱、不可撤回的先问用户。`;
