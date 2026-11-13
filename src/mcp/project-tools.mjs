// In-process MCP「项目」（运行档位 › 项目，runtime/project-mode.mjs）：项目记忆的读写。
// 协调者没有写文件工具、讨论串的工作目录也不在记忆目录里，两边都经这三个工具读写同一份记忆
//（<dataDir>/project-memory/<项目对话 id>/，MEMORY.md 是索引）。用户在概览面板里能看能改。
// projectId() = 这一轮属于哪个项目：协调者是它自己的会话 id（新会话要等 init 才有），讨论串是它的父会话 id。
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { busPublish } from '../runtime/bus.mjs';
import { memoryList, memoryRead, memoryWrite, MEMORY_INDEX, isPaused } from '../runtime/project-mode.mjs';

const out = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

const READ_DESC = `Read this project's shared memory (requirements, decisions, preferences, pitfalls) that the coordinator and every thread share. Without \`name\`: list the notes and return ${MEMORY_INDEX} (the index, one line per note). With \`name\`: return that note.`;
const WRITE_DESC = `Write a note into this project's shared memory (replaces the whole note). Keep each note to one topic and add or update its line in ${MEMORY_INDEX} — "- file.md — one sentence" — in the same turn. Write what stays true for the project (decisions, conventions, the user's standing preferences, pitfalls), not progress logs.`;
const DELETE_DESC = `Delete a note from this project's shared memory (and remove its line from ${MEMORY_INDEX}) when it turned out wrong or no longer applies.`;

export const makeProjectMcp = ({ ctx, projectId }) => {
  const pid = () => { try { return projectId() || ''; } catch { return ''; } };
  const changed = (sid) => { try { busPublish(ctx.key, { type: 'project', sessionId: sid, memory: true, at: Date.now() }); } catch {} };
  return createSdkMcpServer({
    name: 'project',
    version: '1.0.0',
    tools: [
      tool('memory_read', READ_DESC, {
        name: z.string().optional().describe(`A note's file name, e.g. "decisions.md". Omit to list the notes and read ${MEMORY_INDEX}.`),
      }, async (a) => {
        const sid = pid();
        if (!sid) return out('这一轮还没有项目对话的 id，下一轮再读。', true);
        if (a.name) {
          const t = memoryRead(ctx, sid, String(a.name).trim());
          return t === null ? out(`项目记忆里没有「${a.name}」。不带 name 再调一次看有哪些。`, true) : out(t || '（这篇是空的）');
        }
        const list = memoryList(ctx, sid);
        if (!list.length) return out('项目记忆还是空的。');
        const idx = memoryRead(ctx, sid, MEMORY_INDEX);
        return out(`共 ${list.length} 篇：${list.map((f) => f.name).join('、')}` + (idx ? `\n\n${MEMORY_INDEX}：\n${idx}` : `\n\n还没有 ${MEMORY_INDEX} 索引，写记忆时顺手建一个。`));
      }),
      tool('memory_write', WRITE_DESC, {
        name: z.string().describe(`File name ending in .md (letters, digits, . _ -), e.g. "decisions.md" or "${MEMORY_INDEX}".`),
        content: z.string().describe('The whole note in markdown.'),
      }, async (a) => {
        const sid = pid();
        if (!sid) return out('这一轮还没有项目对话的 id，下一轮再写。', true);
        if (isPaused(ctx, sid)) return out('项目已暂停：用户恢复之前不改项目记忆。', true);
        const r = memoryWrite(ctx, sid, String(a.name || '').trim(), String(a.content ?? ''));
        if (!r.ok) return out('没写进去：' + r.error, true);
        changed(sid);
        return out(`已写入项目记忆「${a.name}」。` + (a.name !== MEMORY_INDEX ? `别忘了在 ${MEMORY_INDEX} 里给它留一行。` : ''));
      }),
      tool('memory_delete', DELETE_DESC, {
        name: z.string().describe('The note to delete.'),
      }, async (a) => {
        const sid = pid();
        if (!sid) return out('这一轮还没有项目对话的 id。', true);
        const name = String(a.name || '').trim();
        if (memoryRead(ctx, sid, name) === null) return out(`项目记忆里没有「${name}」。`, true);
        memoryWrite(ctx, sid, name, null);
        changed(sid);
        return out(`已删掉「${name}」。` + (name !== MEMORY_INDEX ? `把 ${MEMORY_INDEX} 里那一行也删掉。` : ''));
      }),
    ],
  });
};
