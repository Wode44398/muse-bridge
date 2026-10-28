// In-process MCP「bridge」：bridge 自己的 Claude 会话用的「项目手册 + 操作」两件工具（取代旧的全局助手）。
// 与外部 agent 走 HTTP 的 /agent/v1/<操作> 是同一张操作表（src/agent-api/registry.mjs），这里只是换个入口：
// 身份就是这一轮的身份（不需要密钥），参数与返回完全一样。
//
// 审批（runtime/permissions.mjs）：manual 与只读操作免审批；会改东西的操作在手动模式下照常弹卡。
// 设备与媒体这两组不从这里给：会话里已经有专用的 mcp__device__ / mcp__media__ 工具（截图等大块二进制也不适合走文本）。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PUBLIC_ORIGIN } from '../config/index.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { callOp, allOps, OpError } from '../agent-api/registry.mjs';
import { identityOfCtx } from '../agent-api/internal.mjs';
import { manualToc, manualChapter, manualSearch, tocMarkdown, searchMarkdown } from '../agent-api/manual.mjs';
import '../agent-api/ops/index.mjs';   // 登记操作（服务端里 http.mjs 也会 import，模块只求值一次）

const EXCLUDED = (name) => name === 'devices.run' || name.startsWith('media.');
const MAX_TEXT = 60_000;

function opList() {
  return allOps().filter((op) => !EXCLUDED(op.name)).map((op) => `${op.name}（${op.title}${op.access === 'danger' ? '，⚠' : op.access === 'write' ? '，改动' : ''}）`).join('；');
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
        `查 bridge（用户正在用的这个 app 本身）的项目手册：界面在哪、功能怎么用、有没有某功能、各操作的参数。
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
        `替用户操作 bridge 本身：调 bridge 的一个操作（和外部 agent 经 HTTP 调的同一套）。参数格式与说明见 manual topic=api（或 q=操作名）。
可用操作：${opList()}。
会改东西的操作在手动审批模式下会先请用户批准；标 ⚠ 的（删除、不可撤回）先在对话里征得同意再调。
另开并行会话优先用 mcp__sessions__start_session；操作电脑用 mcp__device__*，生成媒体用 mcp__media__*。`,
        {
          op: z.string().max(60).describe('操作名，如 routines.list'),
          args: z.record(z.string(), z.any()).optional().describe('操作的参数（对象）'),
        },
        async ({ op, args }) => {
          if (!opCtx) return err('这一轮的身份不能用 bridge 操作');
          if (EXCLUDED(op)) return err(`${op} 不从这里调：操作电脑用 mcp__device__*，生成媒体用 mcp__media__*`);
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

【bridge 本身】用户问这个 app（bridge）怎么用、某功能在哪、有没有某功能，或者要你替他操作 bridge 本身（查 / 建 / 停定时任务、找历史会话、看现在谁在跑、把他的界面带到某页或某个会话、往别的会话里发消息、管 agent 密钥……）时：先用 mcp__bridge__manual 查项目手册（手册里没有的功能就当没有，别编），再用 mcp__bridge__call 调对应操作。删除、花钱、不可撤回的先问用户。

【bridge 的 bug】用户说「是不是出 bug 了 / 这里坏了 / 报个错」，或者你自己发现 bridge 本身行为不对时：① mcp__bridge__call 调 feedback.diagnose 看现场（版本、去向；管理员还能看最近的服务端报错日志和崩溃），结合用户描述、截图或你自己复现，判断是不是 bridge 的 bug——是用户操作或配置问题就直接帮他解决，不用报；② 认定是 bug，用 AskUserQuestion 跟用户确认：一两句话说清你认定的问题、会附上哪些日志摘录 / 截图、发到哪（照 diagnose 返回的 reporting.note 说：只进这台服务器的反馈库，还是也发给 bridge 开发者）；③ 用户同意后调 feedback.report（title + details 写现象、步骤、期望、你的诊断；evidence 只放相关的几行日志），把返回的 note 照实告诉用户。不要把用户的对话原文、文件内容、账号或密钥写进报告；用户没同意就不报。`;
