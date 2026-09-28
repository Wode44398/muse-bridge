// In-process MCP：让 Claude 分页的 agent「看得见用户的工作区」并与之协同。
// 三条通道拼成闭环：
//   ① 视图感知 —— 前端防抖上报（POST /api/ui/state → runtime/ui-state.mjs），
//      view 动作读「用户此刻在看什么」：dock 状态 / 文件面板目录 / 预览中的文件
//      （PDF 页码、md 编辑态、未保存草稿标记…）。
//   ② 下行指令 —— 经本轮 gen 的 SSE 发 {type:'wsx', …}：给用户弹开文件预览
//      （preview）、把文件面板带到某目录（goto）、让面板刷新（fs）。
//   ③ 请求-应答 —— makeUiRequest 挂起等前端交货：截图用户正看到的画面
//      （capture：网页按类型用 canvas 截图）、
//      拉取编辑器里未保存的草稿全文（draft）。
// 文件内容/路径修改：内容用你本来的 Read/Write/Edit；改路径用这里的 move（无 shell
// 的沙箱身份也能用），改完面板自动刷新（claude.mjs 的 PostToolUse 钩子 + move 自广播）。

import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getCurrentGen, genEmit } from '../runtime/gen.mjs';
import { getUiState, makeUiRequest } from '../runtime/ui-state.mjs';
import { moveWorkspaceFile } from '../routes/files.mjs';
import { VAULT } from '../config/index.mjs';

const ACTIONS = ['view', 'preview', 'goto', 'move', 'refresh', 'screenshot', 'draft'];

const DESC = `See and drive the user's workspace UI (the right-hand 工作台 panel and file previews on THEIR screen).
Actions:
- view(): what the user is looking at right now — which tool panel is open, which folder their file panel shows, which file they have open in preview (with PDF page / markdown edit-mode / unsaved-draft info). Always start here when the user says 「这个文件 / 我正在看的 / 帮我改这里」.
- preview(path): pop the file open in the user's preview viewer (use it to SHOW your work: 改完文档给用户当场看). path is workspace-relative.
- goto(path): navigate the user's file panel to a folder.
- move(from, to): move/rename a file or folder (both workspace-relative; to = full new path incl. name). The user's panel refreshes automatically.
- refresh(): force the user's file panel to reload (normally automatic after your edits — only needed after out-of-band changes).
- screenshot(): capture EXACTLY what the user sees in the app right now (their current preview/page) as an image — pixel truth for 「你看我屏幕上这个」moments. Needs the user's client online; may be unsupported on plain web browsers.
- draft(): fetch the user's UNSAVED editor draft (they may have typed things not yet on disk — the file on disk can be stale; check view() first, it flags dirty:true).
Reads/edits of file CONTENT use your normal Read/Write/Edit tools — view() gives you the absolute path to feed them.`;

export const WORKSPACE_NUDGE = '\n\n【工作区协同】你有一个 MCP 工具 `mcp__workspace__workspace`：能看见并操作用户界面里的工作区。用户说「我正在看的这个文件 / 帮我改这里 / 你看我屏幕上」时，先 view() 拿到用户此刻打开的文件（含绝对路径、PDF 页码、编辑态），再用普通 Read/Edit 去改——改之前注意 view() 里的 dirty 标记：为 true 说明用户编辑器里有【未保存草稿】，磁盘上的是旧的，先 draft() 拿草稿全文再动手，别把用户没存的字改丢了。做完值得展示的东西（写好的文档、改好的文件）用 preview(path) 直接弹到用户眼前，比让用户自己找强得多。你用 Write/Edit/Bash 改过工作区后，用户的文件面板会自动刷新，不用提醒用户手动刷新。';

export const makeWorkspaceMcp = ({ getGen, ws, ctxKey } = {}) => createSdkMcpServer({
  name: 'workspace',
  version: '1.0.0',
  tools: [
    tool(
      'workspace',
      DESC,
      {
        action: z.enum(ACTIONS),
        path: z.string().optional().describe('preview/goto 的目标（工作空间相对路径）'),
        from: z.string().optional().describe('move 的源（工作空间相对路径）'),
        to: z.string().optional().describe('move 的目标完整相对路径（含新名字）'),
      },
      async (args) => {
        const gen = (getGen && getGen()) || getCurrentGen();
        const a = String(args?.action || '');
        const text = (t) => ({ content: [{ type: 'text', text: t }] });
        const err = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
        try {
          if (a === 'view') {
            const reports = getUiState(ctxKey);
            if (!reports.length) return text('还没有收到用户界面的视图上报（用户端可能不在线，或 App 版本较旧）。');
            // 上报里的相对路径语义：files.path 与（ws 为空时的）preview.rel 都相对【身份文件根】
            //（admin=vault）；preview.ws 非空时 rel 相对该工作空间；artifacts 的 rel 本身是绝对路径。
            const homeRoot = ctxKey === 'admin' ? VAULT : null;
            const absOf = (rel, ws2) => {
              if (!rel) return null;
              if (path.isAbsolute(rel)) return rel;
              if (ws2) return path.join(ws2, rel);
              return homeRoot ? path.join(homeRoot, rel) : null;
            };
            const fmt = (r) => {
              const s = r.state || {};
              const age = Math.round((Date.now() - r.at) / 1000);
              const out = [`[${r.client}${r.fresh ? '' : '·可能已离开'}] ${age}s 前上报`];
              if (s.page) out.push(`所在页面: ${s.page}`);
              if (s.dock) out.push(`工作台: ${s.dock.open ? `展开，当前工具=${s.dock.view}` : '收起'}`);
              if (s.files) {
                const fabs = absOf(s.files.path, s.files.ws);
                out.push(`文件面板: ${s.files.path || '（根目录）'}${fabs ? `（${fabs}）` : ''}${s.files.query ? `（搜索"${s.files.query}"）` : ''}`);
              }
              if (s.preview && s.preview.open) {
                const p = s.preview;
                const abs = absOf(p.rel, p.ws);
                out.push(`正在预览: ${p.name || p.rel || '?'}（${p.kind || '?'}）${abs ? `\n  绝对路径: ${abs}` : p.rel ? `\n  相对文件根: ${p.rel}` : ''}${p.count > 1 ? `\n  画廊第 ${p.index + 1}/${p.count} 项` : ''}`);
                const d = p.detail || {};
                if (d.page) out.push(`  PDF 页码: 第 ${d.page}${d.pages ? '/' + d.pages : ''} 页`);
                if (d.mode) out.push(`  编辑器模式: ${d.mode}${d.dirty ? '，⚠ 有未保存草稿（磁盘上的内容是旧的，用 draft() 拿最新）' : ''}`);
              } else if (s.preview && !s.preview.open) out.push('没有打开预览');
              return out.join('\n');
            };
            return text(reports.map(fmt).join('\n\n') + '\n\n（多设备同时在线时以最上面最新鲜的一份为准）');
          }
          if (a === 'preview' || a === 'goto') {
            const rel = String(args?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
            if (!rel && a === 'preview') return err(`${a} 需要 path`);
            if (a === 'preview') {
              const abs = path.resolve(ws, rel);
              if (abs !== path.resolve(ws) && !abs.startsWith(path.resolve(ws) + path.sep)) return err('路径越界');
              try { const { statSync } = await import('node:fs'); if (!statSync(abs).isFile()) return err('这不是一个文件'); } catch { return err('文件不存在：' + rel); }
            }
            if (!gen) return err('当前不在对话轮里，发不出界面指令');
            genEmit(gen, { type: 'wsx', op: a === 'preview' ? 'preview' : 'goto', rel, ws, at: Date.now() });
            return text(a === 'preview' ? `已把 ${rel} 推到用户的预览里（用户端在线即弹出）。` : `已把用户的文件面板带到 ${rel || '根目录'}。`);
          }
          if (a === 'move') {
            if (!args?.from || !args?.to) return err('move 需要 from 和 to');
            const r = moveWorkspaceFile(ws, String(args.from), String(args.to));
            if (r.error) return err(r.error);
            if (gen) genEmit(gen, { type: 'wsx', op: 'fs', rel: r.to, at: Date.now() });
            return text(`已移动：${r.from} → ${r.to}（用户的文件面板已同步刷新）`);
          }
          if (a === 'refresh') {
            if (!gen) return err('当前不在对话轮里，发不出界面指令');
            genEmit(gen, { type: 'wsx', op: 'fs', at: Date.now() });
            return text('已让用户的文件面板刷新。');
          }
          if (a === 'screenshot' || a === 'draft') {
            if (!gen) return err('当前不在对话轮里，发不出界面指令');
            const op = a === 'screenshot' ? 'capture' : 'draft';
            const r = await makeUiRequest(gen, ctxKey, op, {}, { timeoutMs: a === 'screenshot' ? 30_000 : 15_000 });
            if (r.error) return err(String(r.error));
            if (a === 'draft') {
              if (r.text == null) return err('用户端没有正在编辑的草稿。');
              return text(`用户编辑器里的当前内容（${r.rel || '?'}${r.dirty ? '，未保存' : '，与磁盘一致'}）：\n\n${String(r.text).slice(0, 100_000)}`);
            }
            const m = /^data:(image\/\w+);base64,(.+)$/s.exec(String(r.image || ''));
            if (!m) return err('用户端没有返回有效截图（该环境可能不支持截图）。');
            return {
              content: [
                { type: 'image', data: m[2], mimeType: m[1] },
                { type: 'text', text: `用户屏幕当前画面${r.note ? `（${r.note}）` : ''}${r.w ? ` · ${r.w}×${r.h}` : ''}` },
              ],
            };
          }
          return err(`未知 action: ${a}`);
        } catch (e) {
          return err(`工作区操作失败：${String(e?.message || e)}`);
        }
      },
    ),
  ],
});
