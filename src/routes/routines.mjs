// Scheduled routine endpoints: list / create / update / duplicate / delete / run-now — each
// scoped to the CALLER's own routines (admin -> ROOT; user -> their .bridge). The
// runner + scheduler interval live in runtime/routines-runner.mjs.

import path from 'node:path';
import { execFile } from 'node:child_process';
import { readBody } from '../runtime/body.mjs';
import * as routines from '../routines.mjs';
import { runRoutine, routineRunning, liveRoutines } from '../runtime/routines-runner.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { routineCapFor, billingUser, quotaBlock } from '../runtime/quota.mjs';
import { permissionModesFor } from '../runtime/claude-settings.mjs';
import { gitInvocation } from '../runtime/member-boundary.mjs';
import { authorizeProjectPath } from '../project-paths.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS, ULTRACODE } from '../config/capabilities.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// Validate the engine selection against the whitelists; unknown values fall through to undefined so the
// routine stores null = "server default". 引擎只剩 Claude（Gemini 2026-11-04 下线）。
function engineFields(body) {
  const agent = 'claude';
  return { agent, model: CLAUDE_MODELS.has(body.model) ? body.model : undefined, effort: CLAUDE_EFFORTS.has(body.effort) ? body.effort : undefined, search: false };
}

// Code 侧设置（只对 Claude 引擎有意义）：工作文件夹过路径授权（成员只能选自己空间内的）、权限模式夹到这个身份能选的。
// 只校验传了的字段；返回要写进去的字段，或抛 { status, message }。
function codeFields(ctx, body, agent) {
  const out = {};
  if ('description' in body) out.description = body.description;
  if ('notify' in body) out.notify = body.notify === true;
  if ('cwd' in body) {
    const raw = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    out.cwd = raw ? authorizeProjectPath(ctx, raw) : null;
  }
  if ('worktree' in body) out.worktree = body.worktree === true;
  if ('branch' in body) {
    const b = typeof body.branch === 'string' ? body.branch.trim() : '';
    if (b && (b.startsWith('-') || /[\s~^:?*[\\]/.test(b))) throw Object.assign(new Error('分支名不合法'), { status: 400 });
    out.branch = b || null;
  }
  if ('permissionMode' in body) {
    const m = body.permissionMode ? String(body.permissionMode) : '';
    if (m && !permissionModesFor(ctx).includes(m)) throw Object.assign(new Error('你的账号不能选这个权限模式'), { status: 400 });
    out.permissionMode = m || null;
  }
  if ('fast' in body) out.fast = body.fast === true;
  if ('sessionMode' in body) out.sessionMode = body.sessionMode === 'continue' ? 'continue' : 'new';
  // 以项目对话运行（运行档位 › 项目）：协调者收到任务指令后自己派讨论串。要会话工具：管理员 / 有 shell 的身份
  if ('shape' in body) {
    if (body.shape === 'project' && !(ctx.kind === 'admin' || ctx.shell)) throw Object.assign(new Error('你的账号不能用项目对话'), { status: 400 });
    out.shape = body.shape === 'project' ? 'project' : null;
  }
  return out;
}

// Ultracode（xhigh + 常驻动态工作流）不给无人值守的定时任务：Workflow 会派一群子 agent，成本没有上限、
// 也没人在看；保存时就拒绝（runner 侧 claudeEffortOptions 仍兜底翻译旧数据，不会把非法值塞给 SDK）。
const ULTRACODE_MSG = '定时任务不支持 Ultracode（无人值守跑动态工作流，成本不可控）。请改选 Extra 或 Max。';
function rejectUltracode(body, res) {
  if (body.effort !== ULTRACODE && body.ultracode !== true) return false;
  json(res, 400, { ok: false, error: ULTRACODE_MSG });
  return true;
}

// 定时任务的引擎（只剩 Claude）对这个身份开着吗——全局开关 ∩ 按人授权，与聊天同口径。老客户端选 Gemini 引擎：410。
function rejectAgent(ctx, body, res) {
  if (body.agent === 'vertex') { json(res, 410, { ok: false, error: 'Gemini 对话已下线，定时任务只能用 Claude 跑' }); return true; }
  if (ctx.allowClaude) return false;
  json(res, 403, { ok: false, error: 'Claude 未启用，或你的账号没有使用权限' });
  return true;
}

// 成员启用中的定时任务有上限（runtime/quota.mjs routineCapFor）；exceptId = 正在改的那条（它本来就算在里面）。
function rejectRoutineCap(ctx, res, exceptId = '') {
  const cap = routineCapFor(ctx);
  if (!Number.isFinite(cap)) return false;
  const on = routines.list(ctx.dataDir).filter((r) => r.enabled && r.id !== exceptId).length;
  if (on < cap) return false;
  json(res, 400, { ok: false, error: `每人最多 ${cap} 条启用中的定时任务。先停用或删掉一条再加。` });
  return true;
}

// 频率：严格校验（cron 写错、一次性没给时间当场报）。一次性的时间已经过了也拒——存进去也永远不会跑。
function checkSchedule(s) {
  const n = routines.normSchedule(s, { strict: true });
  if (n.type === 'once' && n.at <= Date.now()) throw Object.assign(new Error('一次性运行的时间已经过了，请选一个以后的时间'), { status: 400 });
  return n;
}

// 服务器时区（频率都按它算）：名字 + 当前偏移分钟，界面写「服务器时区 GMT+8」
function serverTz() {
  let name = '';
  try { name = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  return { name, offset: -new Date().getTimezoneOffset() };
}

function git(cwd, args) {
  const inv = gitInvocation(cwd, args, { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });
  return new Promise((resolve) => {
    execFile('git', inv.args, { cwd, env: inv.env, timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

async function readJsonBody(req, res) {
  try { return JSON.parse(await readBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad json'); return null; }
}

export function registerRoutineRoutes(router, { authOk, identify }) {
  // Auth + per-identity context resolution is shared in requireCtx (runtime/identity.mjs).

  router.on('GET', '/api/routines', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const running = [...routineRunning];
    json(res, 200, {
      routines: routines.list(ctx.dataDir), running, live: liveRoutines(running),
      // 表单要的环境：默认工作空间（没选文件夹时跑在哪）、这个身份能选的权限模式、服务器时区
      home: ctx.cwd, permissionModes: ctx.allowClaude ? permissionModesFor(ctx) : [], tz: serverTz(),
    });
  });

  // 选好的工作文件夹是不是 git 仓库、当前分支、本地分支列表（表单的「分支 / worktree」用）
  router.on('GET', '/api/routines/git', async (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    let ws;
    try { ws = authorizeProjectPath(ctx, url.searchParams.get('ws') || ctx.cwd); }
    catch (e) { json(res, e.status || 400, { ok: false, error: e.message }); return; }
    const top = await git(ws, ['rev-parse', '--show-toplevel']);
    if (top == null) { json(res, 200, { ok: true, path: ws, git: false }); return; }
    const [head, refs, gitDir, common] = await Promise.all([
      git(ws, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(ws, ['for-each-ref', '--sort=-committerdate', '--count=60', '--format=%(refname:short)', 'refs/heads']),
      git(ws, ['rev-parse', '--absolute-git-dir']),
      git(ws, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ]);
    const linked = !!gitDir && !!common && path.resolve(gitDir.trim()) !== path.resolve(common.trim());
    json(res, 200, {
      ok: true, path: ws, git: true, root: top.trim(),
      branch: (head || '').trim() || null,
      branches: String(refs || '').split('\n').map((s) => s.trim()).filter(Boolean),
      // 本身已经是 linked worktree 的目录不再往里套 worktree（与输入栏 wtNew 同口径）
      worktreeOk: !linked,
    });
  });

  router.on('POST', '/api/routines', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const body = await readJsonBody(req, res); if (!body) return;
    const prompt = String(body.prompt || '').trim();
    if (!prompt) { json(res, 400, { ok: false, error: '指令不能为空' }); return; }
    if (rejectUltracode(body, res)) return;
    if (rejectAgent(ctx, body, res)) return;
    if (body.enabled !== false && rejectRoutineCap(ctx, res)) return;
    const eng = engineFields(body);
    let schedule, code;
    try { schedule = checkSchedule(body.schedule); code = codeFields(ctx, { ...body, agent: eng.agent }, eng.agent); }
    catch (e) { json(res, e.status || 400, { ok: false, error: e.message }); return; }
    const r = routines.create(ctx.dataDir, { name: String(body.name || '').trim(), prompt, schedule, enabled: body.enabled, ...eng, ...code });
    json(res, 200, { ok: true, routine: r });
  });

  router.on('POST', '/api/routines/update', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const body = await readJsonBody(req, res); if (!body) return;
    const id = String(body.id || '');
    const cur = routines.get(ctx.dataDir, id);
    if (!cur) { json(res, 404, { ok: false, error: 'not found' }); return; }
    if (rejectUltracode(body, res)) return;
    if ('agent' in body && rejectAgent(ctx, body, res)) return;
    if (body.enabled === true && !cur.enabled && rejectRoutineCap(ctx, res, id)) return;
    const patch = {};
    for (const k of ['name', 'prompt', 'enabled']) if (k in body) patch[k] = body[k];
    if ('agent' in body || 'model' in body || 'effort' in body || 'search' in body) Object.assign(patch, engineFields(body));
    try {
      if ('schedule' in body) patch.schedule = checkSchedule(body.schedule);
      Object.assign(patch, codeFields(ctx, body, patch.agent || cur.agent));
    } catch (e) { json(res, e.status || 400, { ok: false, error: e.message }); return; }
    if ('prompt' in patch && !String(patch.prompt || '').trim()) { json(res, 400, { ok: false, error: '指令不能为空' }); return; }
    const r = routines.update(ctx.dataDir, id, patch);
    json(res, r ? 200 : 404, r ? { ok: true, routine: r } : { ok: false, error: 'not found' });
  });

  router.on('POST', '/api/routines/duplicate', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const body = await readJsonBody(req, res); if (!body) return;
    const r = routines.duplicate(ctx.dataDir, String(body.id || ''));
    json(res, r ? 200 : 404, r ? { ok: true, routine: r } : { ok: false, error: 'not found' });
  });

  router.on('POST', '/api/routines/delete', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const body = await readJsonBody(req, res); if (!body) return;
    const ok = routines.remove(ctx.dataDir, String(body.id || ''));
    json(res, ok ? 200 : 404, { ok });
  });

  router.on('POST', '/api/routines/run', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const body = await readJsonBody(req, res); if (!body) return;
    const id = String(body.id || '');
    if (!routines.get(ctx.dataDir, id)) { json(res, 404, { ok: false, error: 'not found' }); return; }
    if (routineRunning.has(id)) { json(res, 200, { ok: true, already: true }); return; }
    // 「立即运行」同样走额度闸（runRoutine 里还会再查一次），超了当场说清楚
    const owner = billingUser(ctx);
    const block = owner ? quotaBlock(owner) : null;
    if (block) { json(res, 429, { ok: false, error: block.message, title: block.title }); return; }
    runRoutine(ctx, id, 'manual'); // fire-and-forget; progress/status visible via GET /api/routines
    json(res, 200, { ok: true });
  });
}
