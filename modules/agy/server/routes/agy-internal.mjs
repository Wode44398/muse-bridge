// Antigravity 同机 MCP 内部回调路由：严格校验回环直连与主机密钥，负责实时工具门禁复核、
// 将 Media Studio 产物落盘到当前活跃会话授权工作目录、以及桥接当前活跃会话的手机文件命令。

import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { instanceCaller } from '@bridge/core/agent-api/instance-auth.mjs';
import { fileFor } from '@bridge/core/vertex-media.mjs';
import { isPathInside, safeJoin } from '@bridge/core/runtime/http-file.mjs';
import { protectedTarget, uniquePath } from '@bridge/core/routes/file-core.mjs';
import { requestPhone } from '@bridge/core/runtime/phone-bridge.mjs';
import { getLiveGens } from '@bridge/core/runtime/gen.mjs';
import { pluginOn } from '@bridge/core/plugins/state.mjs';
import { agyGenKey } from '../agents/agy.mjs';
import { loadAgySettings } from '../settings.mjs';
import { getSessionMeta, resolveVerifiedSessionCwd } from '../sessions.mjs';
import { authorizeProjectPath } from '../projects.mjs';
import { listHubTools, resolveHubTool, callHubTool, hubToolUnavailableReason } from '../mcp/hub.mjs';
import { effectiveBridgeToolCategories } from '../mcp/config.mjs';
import { recordToolOutput, toolResultText } from '../tool-outputs.mjs';
import { registerAgyUiOpenRoute } from './agy-ui-open.mjs';

const ALLOWED_PHONE_OPS = new Set(['list', 'read', 'write', 'scan', 'delete']);
// 媒体库里的作品文件名：<作品 id>.<扩展名>
const MEDIA_ID_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]{2,5}$/i;
const VALID_MEDIA_TOOLS = new Set(['media_image', 'media_video', 'media_speech', 'media_music', 'media_result']);
const MEDIA_KIND_TO_TOOL = Object.freeze({
  image: 'media_image',
  video: 'media_video',
  speech: 'media_speech',
  music: 'media_music',
});

function verifyInternalAdmin(req, res, sendJson) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
  const tok = m ? m[1].trim() : '';
  const caller = instanceCaller(req, tok);
  if (!caller) {
    sendJson(res, caller === null ? 403 : 401, {
      ok: false,
      error: caller === null ? '内部接口仅接受本机直连调用' : '缺少有效的同机实例凭据',
    });
    return null;
  }
  // 两种来路：管理员那个常驻进程的工具服务出示主机密钥；注册成员自己那个进程的工具服务出示他的按人令牌
  //（只认铸给 agy 的那种——铸给别的 agent 实例的令牌不能拿来冒充 agy 的工具服务）。之后一切按这个身份办：
  // 认会话只在他自己的轮次里找，落盘只落他自己的目录，媒体与额度记在他名下。
  const ok = caller.ctx?.allowAgy && (caller.ctx.kind === 'admin' || (caller.ctx.kind === 'user' && caller.instance === 'agy'));
  if (!ok) {
    sendJson(res, 403, { ok: false, error: '当前身份无权调用 Antigravity 内部工具接口' });
    return null;
  }
  return caller.ctx;
}

function checkCategoryAllowed(settings, category) {
  const bt = settings?.bridgeTools || {};
  if (bt.enabled === false) {
    return '已在 Antigravity 设置中关闭「允许使用 Bridge 工具」';
  }
  if (category === 'media' && bt.media === false) {
    return '已在 Antigravity 设置中关闭「媒体生成」工具';
  }
  if (category === 'ui' && bt.ui === false) {
    return '已在 Antigravity 设置中关闭「界面协同」工具';
  }
  if (category === 'phone') {
    if (!pluginOn('phone-files')) return '尚未在扩展中心开启「手机文件」插件';
    if (bt.phoneFiles === false) return '已在 Antigravity 设置中关闭「手机文件收发」工具';
  }
  return null;
}

function extractBridgeToolSuffix(rawName) {
  const m = /^mcp_+bridge_+([a-z0-9_]+)$/i.exec(String(rawName || '').trim());
  return m ? m[1].toLowerCase() : '';
}

// 从单轮 ACP 事件流提取此刻正在执行中的 mcp_bridge_* 工具调用（排除尚未获批的挂起权限项与已结束项）
function activeBridgeToolsOfGen(gen) {
  const byId = new Map();
  const pendingPermByReq = new Map();
  for (const ev of (gen?.events || [])) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'tool' || ev.type === 'tool-update') {
      const t = ev.tool && typeof ev.tool === 'object' ? ev.tool : ev;
      const id = String(t.toolCallId || '');
      if (!id) continue;
      const prev = byId.get(id) || { toolCallId: id, suffix: '', status: 'in_progress' };
      if (t.name) prev.suffix = extractBridgeToolSuffix(t.name);
      if (t.status) prev.status = String(t.status);
      byId.set(id, prev);
    } else if (ev.type === 'permission') {
      const reqId = String(ev.requestId || '');
      const tcId = String(ev.toolCall?.toolCallId || '');
      if (reqId && tcId) pendingPermByReq.set(reqId, tcId);
    } else if (ev.type === 'permission-resolved') {
      const reqId = String(ev.requestId || '');
      const tcId = pendingPermByReq.get(reqId);
      pendingPermByReq.delete(reqId);
      if (tcId && byId.has(tcId)) {
        const item = byId.get(tcId);
        const denied = ev.outcome === 'cancelled' || /^(?:deny|reject)/i.test(String(ev.optionId || ''));
        // 审批通过后 agy 直接执行 MCP 工具而未必补发 in_progress 更新，在此恢复为执行态直至收到 completed/failed
        item.status = denied ? 'cancelled' : 'in_progress';
      }
    }
  }

  const blockedToolIds = new Set(pendingPermByReq.values());
  if (gen?.pendingPermission?.toolCall?.toolCallId) {
    blockedToolIds.add(String(gen.pendingPermission.toolCall.toolCallId));
  }

  const out = [];
  for (const item of byId.values()) {
    if (!item.suffix) continue;
    if (item.status !== 'in_progress') continue;
    if (blockedToolIds.has(item.toolCallId)) continue;
    out.push(item);
  }
  return out;
}

// agy 会跨会话池化复用 stdio MCP 子进程，子进程的环境变量永远是第一个会话的，不能用。
// 认领依据是 agy 每次工具调用自带的会话 id（_meta，子进程原样转来），且只认此刻在跑、属于本身份的那一轮；
// 旧版 agy 不带 id 时才退回：「唯一在跑的一轮」或「ACP 事件流中唯一在执行该 mcp_bridge_* 工具的一轮」，判不出回 409。
async function resolveCallingAgyGen(ctx, expectedTools = [], body = null) {
  const agyKey = agyGenKey(ctx.key);
  // 精确认领：agy 在每次工具调用里带着会话 id（子进程转来的 rootConversationId / conversationId）。
  // 只认此刻确实在跑、且属于这个身份的那一轮；带了 id 却对不上就直接拒，不退回猜测（宁可报错也不把操作做到别的会话上）。
  const ids = [body?.rootConversationId, body?.conversationId].map((v) => String(v || '').trim()).filter(Boolean);
  if (ids.length) {
    const live = getLiveGens(agyKey).filter((g) => g && !g.done);
    for (const id of ids) {
      const hit = live.find((g) => g.sessionId === id);
      if (hit) return { gen: hit, error: null };
    }
    return { gen: null, error: '发起这次调用的 Antigravity 会话当前没有正在运行的轮次' };
  }
  // 旧版 agy（调用里不带会话 id）：退回按「唯一在跑的一轮 / 事件流里唯一在执行这个工具的一轮」判定
  const expectedSet = new Set(expectedTools.map((s) => String(s || '').toLowerCase()).filter(Boolean));

  const tryPick = () => {
    const liveAll = getLiveGens(agyKey).filter((g) => g && !g.done);
    if (liveAll.length === 0) return { state: 'none' };
    if (liveAll.length === 1) return { state: 'unique', gen: liveAll[0] };

    const matched = liveAll.filter((g) =>
      activeBridgeToolsOfGen(g).some((t) => expectedSet.size === 0 || expectedSet.has(t.suffix))
    );
    if (matched.length === 1) return { state: 'unique', gen: matched[0] };
    if (matched.length > 1) return { state: 'ambiguous_multi' };
    return { state: 'waiting_stream' };
  };

  let pick = tryPick();
  if (pick.state === 'waiting_stream') {
    // 兼顾管道调度微秒差（MCP 回环 HTTP 比 agy stdout 的 tool_call 行先到事件循环）
    for (let i = 0; i < 8 && pick.state === 'waiting_stream'; i++) {
      await new Promise((resolve) => { const t = setTimeout(resolve, 15); t.unref?.(); });
      pick = tryPick();
    }
  }

  if (pick.state === 'unique') return { gen: pick.gen, error: null };
  if (pick.state === 'none') {
    return { gen: null, error: '当前没有正在运行的 Antigravity 会话，无法确定 Bridge 工具归属' };
  }
  if (pick.state === 'ambiguous_multi') {
    return { gen: null, error: '检测到多个并发 Antigravity 会话正在同时调用同一 Bridge 工具，无法安全区分归属会话，请待另一会话完成后重试' };
  }
  return { gen: null, error: '当前有多个并发 Antigravity 会话在运行，但无法从事件流唯一确认发起本次 Bridge 工具调用的会话' };
}

// 落盘根目录只认服务端已登记的会话记录与活跃轮，不接受请求体自报的 cwd
async function resolveSessionSaveRoot(ctx, gen) {
  const candidates = [];
  const sid = String(gen?.sessionId || '').trim();
  if (sid) {
    const meta = getSessionMeta(ctx.agyDir, sid);
    if (meta?.cwd) candidates.push(meta.cwd);
    const verified = await resolveVerifiedSessionCwd(ctx, sid);
    if (verified) candidates.push(verified);
  }
  if (gen?.cwd) candidates.push(gen.cwd);

  for (const raw of candidates) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      return authorizeProjectPath(ctx, raw);
    } catch {}
  }
  return '';
}

function nearestAncestorInside(targetPath, realRoot) {
  let cur = path.resolve(targetPath);
  for (;;) {
    let lst = null;
    try { lst = lstatSync(cur); } catch {}
    if (lst) {
      return isPathInside(cur, realRoot);
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

// encodeURI 不转义括号与 #/?，重名文件（如 x (1).png）不转成 %28/%29 会截断 Markdown 链接导致交付物卡片丢失
export function toDeliverableFileUri(absPath) {
  const slash = String(absPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return 'file:///' + encodeURI(slash)
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
}

export function registerAgyInternalRoutes(router, { parseJsonBody, sendJson }) {
  // 供常驻复用的 stdio MCP 在执行前复核最新开关状态，确保用户在设置中关闭工具后立即生效
  router.on('POST', '/api/agy/internal/gate', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const settings = loadAgySettings(ctx.agyDir);
    const denyReason = checkCategoryAllowed(settings, String(body.category || ''));
    if (denyReason) {
      sendJson(res, 403, { ok: false, error: denyReason });
      return;
    }
    sendJson(res, 200, { ok: true });
  });

  router.on('POST', '/api/agy/internal/save-media', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const settings = loadAgySettings(ctx.agyDir);
    const denyReason = checkCategoryAllowed(settings, 'media');
    if (denyReason) {
      sendJson(res, 403, { ok: false, error: denyReason });
      return;
    }

    const mediaId = String(body.mediaId || '').trim();
    if (!mediaId) {
      sendJson(res, 400, { ok: false, error: '缺少 mediaId' });
      return;
    }
    const srcFile = fileFor(mediaId, ctx.media);
    if (!srcFile || !existsSync(srcFile)) {
      sendJson(res, 404, { ok: false, error: '未找到生成的媒体文件' });
      return;
    }

    const rawTool = String(body.toolName || '').trim().toLowerCase();
    const mappedTool = MEDIA_KIND_TO_TOOL[String(body.kind || '').trim().toLowerCase()] || '';
    const expectedTools = VALID_MEDIA_TOOLS.has(rawTool)
      ? [rawTool]
      : (mappedTool ? [mappedTool] : [...VALID_MEDIA_TOOLS]);

    const { gen, error: genErr } = await resolveCallingAgyGen(ctx, expectedTools, body);
    if (!gen) {
      sendJson(res, 409, { ok: false, error: genErr });
      return;
    }

    const workDir = await resolveSessionSaveRoot(ctx, gen);
    if (!workDir) {
      sendJson(res, 409, { ok: false, error: '无法确认当前活跃会话的授权工作目录' });
      return;
    }

    let realWorkDir;
    try {
      realWorkDir = realpathSync(workDir);
    } catch {
      sendJson(res, 403, { ok: false, error: '当前会话工作目录不存在或无法访问' });
      return;
    }

    const rawSaveTo = typeof body.saveTo === 'string' && body.saveTo.trim()
      ? body.saveTo.trim().replace(/\\/g, '/')
      : 'generated-media/';
    let dest = safeJoin(realWorkDir, rawSaveTo.replace(/\/+$/, ''));
    if (!dest || protectedTarget(realWorkDir, dest, ctx)) {
      sendJson(res, 403, { ok: false, error: '保存路径越界或指向受保护目录' });
      return;
    }

    // mkdir 前先检查最近已存在的祖先目录真实路径，防止借工作区内的符号链接或目录联接点到外部建目录
    if (!nearestAncestorInside(dest, realWorkDir)) {
      sendJson(res, 403, { ok: false, error: '保存路径指向工作目录外的链接，已拒绝写入' });
      return;
    }

    let asDir = rawSaveTo.endsWith('/');
    if (!asDir && existsSync(dest)) {
      try { asDir = statSync(dest).isDirectory(); } catch {}
    }
    const parentDir = asDir ? dest : path.dirname(dest);
    mkdirSync(parentDir, { recursive: true });

    // mkdir 后再次对父目录取 realpath 与会话 cwd 的 realpath 比对，越界立即拒绝
    let realParent;
    try {
      realParent = realpathSync(parentDir);
    } catch {
      sendJson(res, 403, { ok: false, error: '无法解析保存目录的真实路径' });
      return;
    }
    if (!isPathInside(realParent, realWorkDir)) {
      sendJson(res, 403, { ok: false, error: '保存目录解析链接后越出当前会话工作目录' });
      return;
    }

    const targetFile = asDir
      ? path.join(realParent, path.basename(srcFile))
      : path.join(realParent, path.basename(dest));
    if (protectedTarget(realWorkDir, targetFile, ctx)) {
      sendJson(res, 403, { ok: false, error: '保存路径指向受保护目录' });
      return;
    }
    dest = uniquePath(targetFile);
    try {
      if (lstatSync(dest).isSymbolicLink()) {
        sendJson(res, 403, { ok: false, error: '目标文件为符号链接，已拒绝覆盖' });
        return;
      }
    } catch {}
    copyFileSync(srcFile, dest);

    const fileName = path.basename(dest);
    const relativePath = path.relative(realWorkDir, dest).split(path.sep).join('/');
    const fileUri = toDeliverableFileUri(dest);
    sendJson(res, 200, {
      ok: true,
      sessionId: gen.sessionId || null,
      savedPath: dest,
      relativePath,
      fileName,
      markdownLink: `[${fileName}](${fileUri})`,
    });
  });

  // 媒体工具的素材（改图 / 参考图 / 首尾帧 / 参考音视频）：agy 手里多是会话目录里的绝对路径，这里换成 Studio 认的写法——
  // 媒体库里的作品文件 → asset（作品 id，血缘接得上）；上传目录里的 → upload；会话工作目录 / 已授权附加目录 /
  // 身份文件根里的 → 拷一份进上传目录再用。别处的文件一律拒（与 Claude 媒体工具同一取舍，只是根按 agy 会话算）。
  router.on('POST', '/api/agy/internal/media-inputs', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const settings = loadAgySettings(ctx.agyDir);
    const denyReason = checkCategoryAllowed(settings, 'media');
    if (denyReason) { sendJson(res, 403, { ok: false, error: denyReason }); return; }
    const list = Array.isArray(body.inputs) ? body.inputs.slice(0, 12) : [];
    const rawTool = String(body.toolName || '').trim().toLowerCase();
    const { gen, error: genErr } = await resolveCallingAgyGen(ctx, VALID_MEDIA_TOOLS.has(rawTool) ? [rawTool] : [...VALID_MEDIA_TOOLS], body);
    if (!gen) { sendJson(res, 409, { ok: false, error: genErr }); return; }
    const workDir = await resolveSessionSaveRoot(ctx, gen);
    const meta = gen.sessionId ? getSessionMeta(ctx.agyDir, gen.sessionId) : null;
    const roots = [];
    for (const raw of [workDir, ...(Array.isArray(meta?.additionalDirectories) ? meta.additionalDirectories : []), ctx.cwd]) {
      if (!raw) continue;
      try { roots.push(realpathSync(raw)); } catch {}
    }
    const realOf = (p) => { try { return realpathSync(p); } catch { return ''; } };
    const mediaRoot = ctx.media ? realOf(ctx.media) : '';
    const uploadsRoot = ctx.uploads ? realOf(ctx.uploads) : '';
    const out = [];
    try {
      for (const [i, x] of list.entries()) {
        const role = typeof x?.role === 'string' ? x.role.trim() : '';
        if (!role) throw new Error(`inputs[${i}] 缺 role`);
        if (x.asset) { out.push({ role, asset: String(x.asset).trim() }); continue; }
        const raw = typeof x.path === 'string' ? x.path.trim() : '';
        if (!raw) throw new Error(`inputs[${i}] 要给 path 或 asset`);
        const abs = path.isAbsolute(raw) || path.win32.isAbsolute(raw) ? path.resolve(raw) : (workDir ? path.resolve(workDir, raw) : '');
        const real = abs ? realOf(abs) : '';
        let st = null;
        try { st = real ? statSync(real) : null; } catch {}
        if (!st) throw new Error('素材文件不存在：' + raw);
        if (!st.isFile()) throw new Error('素材不是文件：' + raw);
        const idHit = MEDIA_ID_FILE_RE.exec(path.basename(real));
        if (mediaRoot && idHit && path.dirname(real).toLowerCase() === mediaRoot.toLowerCase()) { out.push({ role, asset: idHit[1].toLowerCase() }); continue; }
        if (uploadsRoot && isPathInside(real, uploadsRoot)) { out.push({ role, upload: real }); continue; }
        if (!uploadsRoot || !roots.some((r) => isPathInside(real, r))) {
          throw new Error('素材不在当前会话的工作目录、已授权的附加目录、上传目录或媒体库里：' + raw);
        }
        const dir = path.join(uploadsRoot, 'agy-inputs');
        mkdirSync(dir, { recursive: true });
        const dest = uniquePath(path.join(dir, Date.now().toString(36) + '-' + path.basename(real)));
        copyFileSync(real, dest);
        out.push({ role, upload: dest });
      }
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err?.message || String(err) });
      return;
    }
    sendJson(res, 200, { ok: true, inputs: out });
  });

  // 工具中枢：浏览器 / 终端 / 工作区 / bridge 操作 / 设备 / 图表（mcp/hub.mjs）。
  // 清单按当前设置与身份现算——stdio 子进程在 tools/list 时来取，关掉的组不出现。
  router.on('POST', '/api/agy/internal/hub/tools', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const settings = loadAgySettings(ctx.agyDir);
    try {
      // categories：子进程本地那几组（媒体 / 界面 / 手机文件）此刻该不该列出来。类别不再写进子进程的环境变量——
      // agy 按「服务名 + 配置」复用子进程，环境变量一变就另起一个并把工具改名成 mcp_bridge_<哈希>_*。
      const categories = effectiveBridgeToolCategories(settings, { ctx });
      const tools = categories.includes('hub') ? await listHubTools(ctx, settings) : [];
      sendJson(res, 200, { ok: true, tools, categories });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });

  router.on('POST', '/api/agy/internal/hub/call', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const settings = loadAgySettings(ctx.agyDir);
    const name = String(body.name || '').trim();
    const target = await resolveHubTool(ctx, settings, name);
    if (!target) {
      const why = hubToolUnavailableReason(ctx, settings, name);
      // 这一步在界面上也要看得到原因（agy 自己的工具事件不带 MCP 返回）
      try { const { gen: g0 } = await resolveCallingAgyGen(ctx, [name], body); if (g0) recordToolOutput(ctx, g0, { name, args: body.args, text: why, isError: true }); } catch {}
      sendJson(res, 403, { ok: false, error: why });
      return;
    }
    const { gen, error: genErr } = await resolveCallingAgyGen(ctx, [name], body);
    if (!gen) {
      sendJson(res, 409, { ok: false, error: genErr });
      return;
    }
    // 池键（浏览器 / 终端）必须和右侧面板一致：面板用的是这一轮推给前端的 cwd（gen.cwd）
    const cwd = gen.cwd || await resolveSessionSaveRoot(ctx, gen);
    if (!cwd) {
      sendJson(res, 409, { ok: false, error: '无法确认当前活跃会话的工作目录' });
      return;
    }
    // 这一轮被停止、或 agy 那头放弃了这次调用（子进程断开连接）：把取消传给工具，别让终端 wait 之类的接着挂到超时
    const ac = new AbortController();
    const onGenAbort = () => ac.abort();
    const genSignal = gen.abort?.signal;
    if (genSignal?.aborted) ac.abort();
    else genSignal?.addEventListener?.('abort', onGenAbort, { once: true });
    const onClose = () => { if (!res.writableEnded) ac.abort(); };
    res.on('close', onClose);
    try {
      const result = await callHubTool(ctx, gen, target, body.args, { cwd, signal: ac.signal });
      try { recordToolOutput(ctx, gen, { name, args: body.args, text: toolResultText(result), isError: result?.isError === true }); } catch {}
      sendJson(res, 200, { ok: true, result });
    } catch (err) {
      const msg = ac.signal.aborted ? '调用已取消' : (err?.message || String(err));
      try { recordToolOutput(ctx, gen, { name, args: body.args, text: msg, isError: true }); } catch {}
      if (!res.writableEnded && !res.destroyed) sendJson(res, 502, { ok: false, error: msg });
    } finally {
      genSignal?.removeEventListener?.('abort', onGenAbort);
      res.off('close', onClose);
    }
  });

  // 子进程本地执行的工具（媒体 / 界面 / 手机文件）把返回内容报回来，补进这一轮的步骤记录（中枢工具在上面那条路由里直接记）
  router.on('POST', '/api/agy/internal/tool-result', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const name = String(body.name || '').trim();
    const { gen } = await resolveCallingAgyGen(ctx, [name], body);
    if (!gen) { sendJson(res, 200, { ok: true, recorded: false }); return; }
    let id = '';
    try { id = recordToolOutput(ctx, gen, { name, args: body.args, text: String(body.text || ''), isError: body.isError === true }); } catch {}
    sendJson(res, 200, { ok: true, recorded: !!id });
  });

  router.on('POST', '/api/agy/internal/phone', async (req, res) => {
    const ctx = verifyInternalAdmin(req, res, sendJson); if (!ctx) return;
    const body = await parseJsonBody(req, res); if (!body) return;
    const settings = loadAgySettings(ctx.agyDir);
    const denyReason = checkCategoryAllowed(settings, 'phone');
    if (denyReason) {
      sendJson(res, 403, { ok: false, error: denyReason });
      return;
    }

    const op = String(body.op || '').trim();
    if (!ALLOWED_PHONE_OPS.has(op)) {
      sendJson(res, 400, { ok: false, error: `不支持的手机文件操作：${op}` });
      return;
    }

    const { gen, error: genErr } = await resolveCallingAgyGen(ctx, [`phone_${op}`], body);
    if (!gen || gen.done) {
      sendJson(res, 409, { ok: false, error: genErr || '当前没有活跃的 Antigravity 对话流，无法向手机下发文件命令' });
      return;
    }

    try {
      const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 60_000, 5_000), 200_000);
      const result = await requestPhone({
        genKey: ctx.key,
        gen,
        op,
        args: body.args && typeof body.args === 'object' ? body.args : {},
        timeoutMs,
      });
      sendJson(res, 200, { ok: true, ...(result && typeof result === 'object' ? result : { result }) });
    } catch (err) {
      sendJson(res, 502, { ok: false, error: err?.message || String(err) });
    }
  });

  // ui_open 的文件 / 文件夹：按发起调用那一轮的会话目录解析（实现见 agy-ui-open.mjs）
  registerAgyUiOpenRoute(router, {
    parseJsonBody, sendJson, verifyInternalAdmin, checkCategoryAllowed,
    loadSettings: loadAgySettings, resolveCallingAgyGen, resolveSessionRoot: resolveSessionSaveRoot,
  });
}
