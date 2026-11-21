// agy 的 ui_open 打开文件 / 文件夹（页面、会话、插件应用仍直接走核心 ui.open）。
//
// 核心 ui.open 的 file / folder 是「相对身份文件根」的路径，前端打开的是 App 级全屏查看器 / 文件页——对 agy 不对：
// agy 嘴里的相对路径是它会话的工作目录，而且用户就在 agy 页上时该在右侧工作区文件卡里打开，不该整屏盖住对话。
// 这里按发起调用的那一轮（resolveCallingAgyGen 认领）解析路径、过路径授权，再调同一个 ui.open，
// 只在 env.uiFrom 里带上来源（agent / 会话 / 目录）：前端 agentUi.js 见 from.agent === 'agy' 且人在 agy 页时交给 agy 工作区。
// 走的仍是账号总线的 ui.cmd：按 id 去重、60 秒时效，不进 agy 的事件流，所以断线重连重放这一轮时不会再拉开文件卡。

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { callOp, OpError } from '@bridge/core/agent-api/registry.mjs';
import { authorizeProjectPath } from '../projects.mjs';

const fold = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
function relInside(base, target) {
  if (!base) return null;
  const rel = path.relative(fold(base), fold(target));
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
  // 大小写按原样取（fold 只用来判断包含关系）
  return path.relative(base, target).split(path.sep).join('/');
}

/**
 * 把 agy 给的 file / folder 解析成 { ws, rel, abs, rootRel }。
 * ws = 文件卡 / 预览的根（在会话目录里就是会话目录，否则是它自己所在的文件夹），rel = 相对 ws 的路径（posix）；
 * rootRel = 相对身份文件根（文件页的根，dock/meta 同口径），在根外为 null。
 * 相对路径按会话目录解析；绝对路径（以及 .. 跳出会话目录的）照常过 authorizeProjectPath。出错抛带 status 的 Error。
 */
export function resolveAgyUiPath(ctx, { kind, raw, sessionCwd }) {
  const s = String(raw ?? '').trim();
  if (!s) throw Object.assign(new Error(kind === 'folder' ? '缺少文件夹路径' : '缺少文件路径'), { status: 400 });
  if (!path.isAbsolute(s) && !sessionCwd) throw Object.assign(new Error('这一轮没有工作目录，相对路径无从解析：请给绝对路径'), { status: 400 });
  const abs = path.resolve(sessionCwd || '', s);
  const dirAbs = kind === 'folder' ? abs : path.dirname(abs);
  const dirReal = authorizeProjectPath(ctx, dirAbs);   // 不存在 404、不是文件夹 400、越界 403
  const real = kind === 'folder' ? dirReal : path.join(dirReal, path.basename(abs));
  if (kind === 'file') {
    let st = null;
    try { st = existsSync(real) ? statSync(real) : null; } catch {}
    if (!st) throw Object.assign(new Error('文件不存在：' + real), { status: 404 });
    if (st.isDirectory()) throw Object.assign(new Error('这是文件夹，请用 folder 参数'), { status: 400 });
  }
  const inWs = relInside(sessionCwd, real);
  const ws = inWs != null ? sessionCwd : (kind === 'folder' ? real : dirReal);
  const rel = inWs != null ? inWs : (kind === 'folder' ? '' : path.basename(real));
  return { ws, rel, abs: real, rootRel: relInside(path.resolve(ctx.cwd || ''), real) };
}

export function registerAgyUiOpenRoute(router, { parseJsonBody, sendJson, verifyInternalAdmin, checkCategoryAllowed, loadSettings, resolveCallingAgyGen, resolveSessionRoot }) {
  router.on('POST', '/api/agy/internal/ui-open', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const denyReason = checkCategoryAllowed(loadSettings(ctx.agyDir), 'ui');
    if (denyReason) { sendJson(res, 403, { ok: false, error: denyReason }); return; }

    const hasFile = typeof body.file === 'string' && body.file.trim();
    const hasFolder = typeof body.folder === 'string' && body.folder.trim();
    if (!hasFile === !hasFolder || body.page || body.session) {
      sendJson(res, 400, { ok: false, error: 'page / session / file / folder 要且只要给一个' });
      return;
    }
    const kind = hasFile ? 'file' : 'folder';

    const { gen, error: genErr } = await resolveCallingAgyGen(ctx, ['ui_open'], body);
    if (!gen) { sendJson(res, 409, { ok: false, error: genErr }); return; }
    const sessionCwd = await resolveSessionRoot(ctx, gen);

    let r;
    try { r = resolveAgyUiPath(ctx, { kind, raw: hasFile ? body.file : body.folder, sessionCwd }); }
    catch (e) { sendJson(res, e?.status || 400, { ok: false, error: e?.message || String(e) }); return; }

    // ui.open 的 folder 不收空串：会话目录本身用 '.'（前端两头都按「根」处理）
    const args = { [kind]: r.rel || '.' };
    if (typeof body.client === 'string' && body.client) args.client = body.client;
    if (typeof body.device === 'string' && body.device) args.device = body.device;
    try {
      const data = await callOp(ctx, 'ui.open', args, {
        via: 'mcp', instance: 'agy', sessionId: gen.sessionId || '',
        uiFrom: { agent: 'agy', session: gen.sessionId || '', ws: r.ws, rootRel: r.rootRel },
      });
      sendJson(res, 200, { ok: true, data: { ...data, path: r.abs } });
    } catch (e) {
      const msg = e instanceof OpError ? `${e.code}：${e.message}${e.hint ? '（' + e.hint + '）' : ''}` : (e?.message || String(e));
      sendJson(res, e instanceof OpError ? (e.status || 400) : 500, { ok: false, error: msg });
    }
  });
}
