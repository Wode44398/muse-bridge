// POST /api/chat — a Claude turn (dimensio has its own chat API behind /api/harness/*).
// POST /api/answer — the AskUserQuestion bridge.
// All input clamping (model whitelists, attachment path guards) lives here so
// the agent file only sees already-validated args.

import { readBody } from '../runtime/body.mjs';
import { filterAttachmentPaths } from '../runtime/attachment-guard.mjs';
import { handleAnswer } from '../runtime/questions.mjs';
import { runClaudeChat } from '../agents/claude.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import { createSessionWorktree } from '../claude-worktrees.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS, ULTRACODE } from '../config/capabilities.mjs';
import { MODEL } from '../config/index.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { touchSnap, SNAP_MAX_TURNS, snapAllowsFable } from './chat-snapshot.mjs';

export function registerChatRoutes(router, { authOk, identify }) {
  router.on('POST', '/api/chat', async (req, res) => {
    const id = identify(req);
    // share = 公开只读分享身份：不给跑 agent。
    if (id.kind === 'none' || id.kind === 'share') {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('unauthorized');
      return;
    }
    const ctx = contextFor(id);

    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad json');
      return;
    }

    if (parsed.agent !== undefined && parsed.agent !== 'claude') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '不支持的 agent：' + String(parsed.agent) }));
      return;
    }

    const message = String(parsed.message ?? '').trim();
    const sessionId = parsed.sessionId ? String(parsed.sessionId) : undefined;
    // 快照身份（?ct=）：深度研究关掉；全部快照合计的并行轮有独立小上限（额度保护）。
    const isSnap = ctx.kind === 'snap';
    if (isSnap) {
      parsed.research = false;
      touchSnap(ctx.snap.token);   // 用户消息 → 续 1 小时销毁倒计时
    }
    let model = CLAUDE_MODELS.has(parsed.model) ? parsed.model : (MODEL || undefined);
    // 快照（公开链接）禁用 Fable 时（覆盖整个 Fable 5.x 档），把 Fable 请求降级到默认模型——
    // 前端选择器已隐藏该项，这里再拦一道，防抓包直接指定 claude-fable-5 / -5-1 / 其 [1m] 兄弟档。
    if (isSnap && !snapAllowsFable(ctx.snap.token) && /^claude-fable-5(-1)?(\[1m\])?$/.test(model || '')) {
      model = MODEL || undefined;
    }
    let effort = CLAUDE_EFFORTS.has(parsed.effort) ? parsed.effort : undefined;
    // Ultracode = xhigh + 常驻动态工作流（Workflow 派一群子 agent，成本倍增器）：快照访客降到 xhigh
    //（claude.mjs 对无 shell 的沙箱用户再拦一道；Workflow 工具对快照已 disallow）。
    if (isSnap && effort === ULTRACODE) effort = 'xhigh';
    const fast = parsed.fast === true && !isSnap;   // fast mode 消耗额外用量，快照访客不给
    // 会话级选择器记忆：记「用户显式选了什么」而非 clamp 后的回落值——没选就存 null，
    // 恢复时选择器回到「默认」态，服务端默认将来变了也跟着走。快照访客不记。
    const chatPrefs = isSnap ? null : {
      model: CLAUDE_MODELS.has(parsed.model) ? parsed.model : null,
      effort: CLAUDE_EFFORTS.has(parsed.effort) ? parsed.effort : null,
      fast,
    };
    const CHAT_STYLES = new Set(['learning', 'concise', 'explanatory', 'formal']);
    const style = CHAT_STYLES.has(parsed.style) ? parsed.style : undefined; // normal/未知 → 无额外风格
    // 自定义风格：前端把用户自建风格的指令文本随请求带上（仅在未命中预设时生效）。
    // 只进自己会话的 systemPrompt append，无注入面；限长防滥用。
    const styleText = !style && typeof parsed.styleText === 'string' ? parsed.styleText.trim().slice(0, 4000) : '';
    const research = parsed.research === true; // 深度研究模式
    // 输入建议（官方 prompt suggestion）：前端开着开关才带 suggest:true。快照访客不给。
    const suggest = parsed.suggest === true && !isSnap;

    // 项目制（项目=工作空间路径=运行 cwd）：新会话按 claudeProjectId 选项目（缺省=「工作空间」
    // 默认项目）；续聊按 transcript 所在目录反查项目——会话的 cwd 一经建立不可改，忽略客户端传值。
    let claudeProject = null;
    if (sessionId) {
      claudeProject = claudeProjects.locateSessionProject(ctx.claudeProjects, ctx, sessionId);
    } else if (parsed.claudeProjectId) {
      claudeProject = claudeProjects.getProject(ctx.claudeProjects, ctx, String(parsed.claudeProjectId));
      if (!claudeProject) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '项目不存在或无权访问' }));
        return;
      }
    }
    if (claudeProject) {
      try { claudeProject = { ...claudeProject, path: claudeProjects.authorizeProjectPath(ctx, claudeProject.path) }; }
      catch (e) {
        res.writeHead(e?.status || 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e?.message || '项目路径不可用' }));
        return;
      }
    }
    // worktree 勾选框（输入栏分支胶囊右半）：新会话先从项目当前 HEAD 切一个 git worktree，
    // 整轮以它为 cwd（claude-worktrees.mjs）。只认新会话——续聊的 cwd 由 transcript 定死；
    // 快照访客、快照桶不给（一次性空桶不是仓库）。没选项目 = 默认工作空间。
    if (!sessionId && parsed.worktree === true && !isSnap) {
      let base = claudeProject;
      if (!base) {
        const def = claudeProjects.listProjects(ctx.claudeProjects, ctx)[0];
        try { base = def ? { ...def, path: claudeProjects.authorizeProjectPath(ctx, def.path) } : null; } catch { base = null; }
      }
      if (base && !base.quick) {
        try {
          const wt = await createSessionWorktree(ctx.claudeProjects, base);
          claudeProject = { ...base, path: claudeProjects.authorizeProjectPath(ctx, wt.cwd), worktree: { name: wt.name, branch: wt.branch, root: wt.root } };
        } catch (e) {
          res.writeHead(e?.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || '创建 worktree 失败' }));
          return;
        }
      }
    }
    // 附件守卫（attachment-guard.mjs）：沙箱身份只收本人 uploads / 工作空间（cwd）/
    // 已授权项目内的路径；admin 放行任意存在的绝对路径。
    const attachments = filterAttachmentPaths(parsed.attachments, {
      allowAnywhere: ctx.kind === 'admin',
      roots: [ctx.uploads, ctx.cwd, claudeProject?.path],
    });
    if (!message && !attachments.length) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('empty message');
      return;
    }

    // 准入看 ctx.allowClaude：全局开关（设置「Agent」页）∩ 按人授权（控制台「用户」页）。
    if (!ctx.allowClaude) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Claude 未启用，或你的账号没有使用权限' }));
      return;
    }
    // 项目 cwd 生效方式：覆写 ctx.cwd 传入——runClaudeChat 的 query cwd / resume 清理 /
    // 沙箱围栏全部吃 ctx.cwd，一处覆写全链路一致。默认项目 path === ctx.cwd，等价原行为。
    // homeRoot 保留身份原本的文件根（覆写前的 cwd）：产物文件夹卡要靠它算「在文件页里的位置」。
    // worktree 会话另带 worktree:{cwd,branch}——session 帧透给前端，工作台当场切到 worktree。
    const claudeCtx = claudeProject
      ? { ...ctx, cwd: claudeProject.path, homeRoot: ctx.cwd, ...(claudeProject.worktree ? { worktree: { cwd: claudeProject.path, branch: claudeProject.worktree.branch } } : {}) }
      : ctx;
    return runClaudeChat(req, res, {
      message, sessionId, model, effort, fast, chatPrefs, attachments, style, styleText, research, suggest,
      globalMax: isSnap ? SNAP_MAX_TURNS : undefined,
      ctx: claudeCtx,
    });
  });

  router.on('POST', '/api/answer', (req, res) => handleAnswer(req, res, { identify }));
}
