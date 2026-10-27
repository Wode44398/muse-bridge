// POST /api/chat — dispatches to the per-agent runner based on `agent`.
// POST /api/answer — the AskUserQuestion bridge (Claude branch).
// Claude 的入参夹紧（模型白名单、附件路径守卫）在这里做；其余 agent（vertex / antigravity / codex）
// 属于功能扩展，准入在这里判，入参夹紧在扩展自己的 chat 钩子里（见 modules/registry.mjs）。

import { readBody } from '../runtime/body.mjs';
import { filterAttachmentPaths } from '../runtime/attachment-guard.mjs';
import { handleAnswer } from '../runtime/questions.mjs';
import { handlePhoneResult } from '../runtime/phone-bridge.mjs';
import { deviceIdFromReq } from '../runtime/phone-control.mjs';
import { runClaudeChat } from '../agents/claude.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import { createSessionWorktree } from '../claude-worktrees.mjs';
import { claudeSetting } from '../runtime/claude-settings.mjs';
import { CLAUDE_MODELS, CLAUDE_EFFORTS, ULTRACODE } from '../config/capabilities.mjs';
import { isCustomModelId, customEffortOk, customOwner } from '../runtime/claude-providers.mjs';
// 官方型号 + 自定义 API 的 custom:<服务>:<模型>（存在与否、谁能用由 runClaudeChat 判，给人话报错）
const claudeModelOk = (m) => CLAUDE_MODELS.has(m) || isCustomModelId(m);
import { AGENT_BY_ID, agentOfChat } from '../config/agents.mjs';
import { moduleChat } from '../modules/registry.mjs';
import { billingUser, quotaBlock } from '../runtime/quota.mjs';
import { noteTurnStart } from '../users.mjs';
import { writeSseHeaders, sseWrite } from '../runtime/sse.mjs';
import { UPLOADS, MODEL } from '../config/index.mjs';
import { contextFor, replayHeadersOf } from '../runtime/identity.mjs';
import { findExternalHolder } from '../runtime/external-holder.mjs';
import { findGenBySession } from '../runtime/gen.mjs';
import { setQueueReplayer, fakeRequest, fakeResponse, listQueue, enqueue, enqueueFront, removeItem, moveItem, clearQueue, drain as drainQueue } from '../runtime/claude-queue.mjs';
import { touchSnap, SNAP_MAX_TURNS, snapAllowsFable } from './chat-snapshot.mjs';
import { getLimitResume, setLimitAutoContinue } from '../runtime/limit-resume.mjs';
import { FAMILY_REQ } from '../runtime/session-family.mjs';
import { registerPermissionRoutes } from '../runtime/permissions.mjs';
import { supersedeOffer } from '../runtime/session-proposals.mjs';
import { startTurnTiming, markTurn, handedTurn } from '../runtime/turn-timing.mjs';

export function registerChatRoutes(router, { authOk, identify }) {
  // 排队消息的内部重放（claude-queue.mjs）：一轮收尾后把合并好的排队消息当成一条新 POST 走本路由。
  // 成功的状态码在 SSE 头写出那一刻就定了（200 = 已开跑），不必等这一轮跑完；失败的等响应写完，带回正文进日志。
  // rq.family（会话派生 / 会话间消息，session-family.mjs）挂在假请求的对象属性上——客户端发来的 JSON 伪造不了它。
  // 回传 res：发起方要盯着这条流看它到底开跑了没有（SSE 头 200 之后也可能紧跟一个错误帧就收了）。
  setQueueReplayer((rq) => new Promise((resolve) => {
    const fr = fakeRequest(rq);
    if (rq.queuedAt) startTurnTiming(fr, rq.queuedAt);   // 排队重放：计时从入队算起，等上一轮的时间也记进去
    if (rq.family) fr[FAMILY_REQ] = rq.family;
    const fs = fakeResponse();
    const wh = fs.writeHead;
    fs.writeHead = (code, ...rest) => { wh(code, ...rest); if (code < 400) resolve({ status: code, res: fs }); return fs; };
    fs.on('close', () => resolve({ status: fs.statusCode, detail: (fs.chunks || []).join('') }));
    chatHandler(fr, fs).catch(() => resolve({ status: 500 }));
  }));

  // —— 排队消息管理：列出 / 删除 / 放回输入框（take）/ 排序 / 立即发送（promote）/ 全部清除 ——
  router.on('GET', '/api/claude/queue', (req, res, url) => {
    const id = identify(req);
    if (id.kind === 'none' || id.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(id);
    const sid = String(url.searchParams.get('session') || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: sid ? listQueue(ctx.key, sid) : [] }));
  });
  router.on('POST', '/api/claude/queue', async (req, res) => {
    const id = identify(req);
    if (id.kind === 'none' || id.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(id);
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const sid = String(b.session || '');
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) return reply(400, { error: 'bad session' });
    const op = String(b.op || '');
    if (op === 'remove' || op === 'take') {
      const r = removeItem(ctx.key, sid, String(b.id || ''));
      return reply(200, { items: r.items, ...(op === 'take' ? { item: r.item } : {}) });
    }
    if (op === 'move') return reply(200, { items: moveItem(ctx.key, sid, String(b.id || ''), b.to) });
    if (op === 'clear') return reply(200, { items: clearQueue(ctx.key, sid) });
    if (op === 'promote') {
      // 立即发送（官方 promoteQueuedMessage）：这一轮还在跑 → 从队列取出、改成插话推进去，不打断；
      // 没在跑 → 直接把这一条发出去开新一轮。
      const itemId = String(b.id || '');
      const live = findGenBySession(ctx.key, sid);
      if (live && !live.done && typeof live.steer === 'function') {
        const r = removeItem(ctx.key, sid, itemId);
        if (!r.raw) return reply(404, { error: '这条排队消息已经不在了', items: r.items });
        const uuid = live.steer({ message: r.raw.text, attachments: r.raw.attachments });
        if (uuid) return reply(200, { items: r.items, steered: true, uuid });
        // 插不进（这一轮恰好在收尾 / 挂起等后台任务）：放回队首，收尾后第一个发
        enqueueFront(ctx.key, sid, r.raw);
        return reply(200, { items: listQueue(ctx.key, sid), deferred: true });
      }
      const ok = await drainQueue(ctx.key, sid, [itemId]);
      return reply(ok ? 200 : 409, { items: listQueue(ctx.key, sid), sent: ok });
    }
    return reply(400, { error: 'unknown op' });
  });

  // —— 5 小时限额「重置后自动继续」（limit-resume.mjs）：卡片读状态 / 勾选框开关 ——
  router.on('GET', '/api/claude/limit-resume', (req, res, url) => {
    const id = identify(req);
    if (id.kind === 'none' || id.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(id);
    const sid = String(url.searchParams.get('session') || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: sid ? getLimitResume(ctx.key, sid) : null }));
  });
  router.on('POST', '/api/claude/limit-resume', async (req, res) => {
    const id = identify(req);
    if (id.kind === 'none' || id.kind === 'share' || id.kind === 'snap') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(id);
    let b; try { b = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const sid = String(b.session || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: setLimitAutoContinue(ctx.key, sid, b.on === true) }));
  });

  // 权限模式：GET/POST /api/claude/permission-mode（会话中切模式 / 新会话草稿记文件夹默认，见 runtime/permissions.mjs）
  registerPermissionRoutes(router, { identify });

  router.on('POST', '/api/chat', (req, res) => chatHandler(req, res));
  // 新会话预热（claude.mjs 的 SPARE_MS）：「新对话」输入框获得焦点/开始打字时，前端带上与发送【完全相同】
  // 的选项（模型/effort/项目/开关…，只是没有 message）打这里。选项解析与 /api/chat 同一段代码，
  // 预热进程的启动参数才和随后那条真消息对得上。立即回 202，预热在后台进行；不适用的情形回 204。
  router.on('POST', '/api/chat/prewarm', (req, res) => chatHandler(req, res, { prewarm: true }));
  async function chatHandler(req, res, { prewarm = false } = {}) {
    if (!prewarm) startTurnTiming(req);
    const id = identify(req);
    // share = 公开只读分享身份：任何 agent 都不给（以前只拦 none，/w/ 链接的访客能在分享的文件夹里跑 Claude、还能写）。
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
    markTurn(req, 'body');

    const message = prewarm ? '' : String(parsed.message ?? '').trim();
    const sessionId = parsed.sessionId ? String(parsed.sessionId) : undefined;
    // 预热只给主机 admin 的新会话 Claude 对话：续聊已有停放的 CLI；快照/沙箱/注册用户不预热（每个约 300MB）；
    // worktree 新会话要先切出新目录，cwd 事先不知道。
    if (prewarm && (sessionId || ctx.kind !== 'admin' || ctx.sandbox || parsed.worktree === true
      || (typeof parsed.agent === 'string' && ![null, 'claude'].includes(agentOfChat(parsed.agent))))) {
      res.writeHead(204);
      res.end();
      return;
    }
    // 快照身份（?ct=）：只许 Claude 分支（agent/research 强制归位，防止拿公开链接
    // 白嫖 vertex 等其他 agent）；全部快照合计的并行轮有独立小上限（额度保护）。
    const isSnap = ctx.kind === 'snap';
    if (isSnap) {
      parsed.agent = 'claude';
      parsed.research = false;
      touchSnap(ctx.snap.token);   // 用户消息 → 续 1 小时销毁倒计时
    }
    // 悬浮胶囊（原生 ClaudeStream）发起的轮带 source:'capsule'——记到 gen 并经 /api/active
    // 透出，手机网页端的镜像轮询据此不挂载（挂载预热/胶囊指令不该把 claude 分页拽进对话）。
    const source = parsed.source === 'capsule' ? 'capsule' : undefined;
    // 发起客户端是不是手机 App（离线 apk WebView / 原生胶囊）——决定要不要给 Claude 注入
    // 手机文件/手机操控能力（电脑网页端注了也用不了，Claude 只会误宣称能操作手机）。
    // 新前端显式带 client:'apk'|'web'（有原生桥=apk）；旧 apk 的本地 bundle 没这字段 →
    // 用 Android WebView UA 的 "; wv)" 标记兜底；原生胶囊轮（source:capsule）必是手机。
    // QQ bot / Routines / 管理台代聊都不带 client 且非 WebView UA → 一律按网页端处理。
    const fromPhone = parsed.client === 'apk' || source === 'capsule'
      || (parsed.client === undefined && /;\s?wv\)/.test(String(req.headers['user-agent'] || '')));
    // 发起这轮的是【哪一台】手机（同账号多台手机都开着操控时，手机操控默认操作它）：新 apk 的 WebView UA
    // 带 BridgeDevice/<id>、胶囊请求带 X-Bridge-Device 头；旧 apk 退到 UA 里的机型号。与操控长轮询同一套算法。
    const originDeviceId = fromPhone ? deviceIdFromReq(req) : 'legacy';
    const originDevice = originDeviceId === 'legacy' ? undefined : originDeviceId;
    // 发起这轮的【桌面客户端】（瘦客户端里的网页带上壳登记的设备 id）：新会话默认连它——对标官方
    // 「从这台电脑发起的云会话」。归属在 claude.mjs 里核对（只认本账号自己的设备）。
    const fromComputer = typeof parsed.fromComputer === 'string' && /^d-[0-9a-f]{6,24}$/.test(parsed.fromComputer) ? parsed.fromComputer : undefined;
    // 窄屏网页（手机浏览器）：内嵌图表按手机宽度出图（mcp/visualize.mjs vizPlatform）。
    const narrow = parsed.narrow === true;
    // agent 准入统一看 ctx.agents（= ctx.allow*）：全局开关（设置「Agent」页）∩ 按人授权（控制台「用户」页）∩
    // 是否支持多用户（agy / codex 的工具调用在进程内部执行、绕过沙箱守卫，只给管理员）。
    const denied = (label) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: label + ' 未启用，或你的账号没有使用权限' }));
    };
    // Antigravity 已下线：老客户端仍可能发 agent:'antigravity'，显式回 410，别落进下面「认不出的按 Claude 跑」。
    if (parsed.agent === 'antigravity' || parsed.agent === 'agy') {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Antigravity 已下线' }));
      return;
    }
    // 功能扩展的 agent（vertex / antigravity / codex）：扩展没装 = 这个 agent 不可用，同样回 403。
    const extAgent = typeof parsed.agent === 'string' ? agentOfChat(parsed.agent) : null;   // 认不出的一律按 Claude（同旧行为）
    if (extAgent && extAgent !== 'claude') {
      const handler = moduleChat(parsed.agent);
      if (!handler || !ctx.agents.includes(extAgent)) return denied(AGENT_BY_ID[extAgent].label);
      // 附件守卫（attachment-guard.mjs）同 Claude 分支；扩展可追加自己的根（Codex 的项目目录）。
      const attachments = (extraRoots = []) => filterAttachmentPaths(parsed.attachments, {
        allowAnywhere: ctx.kind === 'admin',
        roots: [ctx.uploads, ctx.cwd, ...extraRoots],
      });
      // 额度（开源路线 S2-6，runtime/quota.mjs）：扩展 agent（Gemini）的对话轮和 Claude 同一道闸、同一个账本，开跑即记。
      const billTo = (message || (Array.isArray(parsed.attachments) && parsed.attachments.length)) ? billingUser(ctx) : null;
      if (billTo) {
        const block = quotaBlock(billTo);
        if (block) { writeSseHeaders(res); sseWrite(res, { type: 'error', kind: 'quota', title: block.title, message: block.message }); res.end(); return; }
        try { noteTurnStart(billTo); } catch {}
      }
      return handler(req, res, { parsed, message, sessionId, ctx, attachments });
    }
    let model = claudeModelOk(parsed.model) ? parsed.model : (MODEL || undefined);
    // 快照（公开链接）禁用 Fable 时（分群设置 fable5，覆盖整个 Fable 5.x 档），把 Fable 请求
    // 降级到默认模型——前端选择器已隐藏该项，这里再拦一道，防抓包直接指定
    // claude-fable-5 / claude-fable-5-1 / 其 [1m] 兄弟档。
    if (isSnap && !snapAllowsFable(ctx.snap.token) && /^claude-fable-5(-1)?(\[1m\])?$/.test(model || '')) {
      model = MODEL || undefined;
    }
    // 自定义 API 的模型：推理强度是它自己的档位表（设置 › Claude › 模型服务，档位 id 自由起名），按那张表收
    const effortOk = (e) => CLAUDE_EFFORTS.has(e) || (isCustomModelId(model) && customEffortOk(model, e, customOwner(ctx)));
    let effort = effortOk(parsed.effort) ? parsed.effort : undefined;
    // Ultracode = xhigh + 常驻动态工作流（Workflow 派一群子 agent，成本倍增器）：快照访客降到 xhigh
    //（claude.mjs 对无 shell 的沙箱用户再拦一道；Workflow 工具对快照已 disallow）。
    if (isSnap && effort === ULTRACODE) effort = 'xhigh';
    const fast = parsed.fast === true && !isSnap;   // fast mode 消耗额外用量，快照访客不给
    // 会话级选择器记忆：记「用户显式选了什么」而非 clamp 后的回落值——没选就存 null，
    // 恢复时选择器回到「默认」态，服务端默认将来变了也跟着走。快照访客不记。
    const chatPrefs = isSnap ? null : {
      model: claudeModelOk(parsed.model) ? parsed.model : null,
      effort: effortOk(parsed.effort) ? parsed.effort : null,
      fast,
      // 会话级输出风格（新会话在发第一条前从加号菜单选的；续聊的覆盖存在 chat-prefs 里，这里不带）。
      // 只收像风格名的字符串，claude-turn-settings 再按可选清单下发。带 sessionId 的一律不收：请求随带的风格
      // 优先级高于 chat-prefs 里的会话覆盖，限额续跑 / 排队重放的旧请求体会把用户后来改的覆盖悄悄撤回去。
      ...(!sessionId && typeof parsed.outputStyle === 'string' && /^[\w .()-]{1,80}$/.test(parsed.outputStyle) ? { outputStyle: parsed.outputStyle } : {}),
      // 新会话在输入框下方的设备芯片里选的设备（设备 id / 'none'）。同理只收新会话：续聊改设备走 /api/devices/link。
      ...(!sessionId && typeof parsed.computer === 'string' && /^(none|d-[0-9a-f]{6,24})$/.test(parsed.computer) ? { computer: parsed.computer } : {}),
    };
    const CHAT_STYLES = new Set(['learning', 'concise', 'explanatory', 'formal']);
    const style = CHAT_STYLES.has(parsed.style) ? parsed.style : undefined; // normal/未知 → 无额外风格
    // 自定义风格：前端把用户自建风格的指令文本随请求带上（仅在未命中预设时生效）。
    // 只进自己会话的 systemPrompt append，无注入面；限长防滥用。
    const styleText = !style && typeof parsed.styleText === 'string' ? parsed.styleText.trim().slice(0, 4000) : '';
    const research = parsed.research === true; // 深度研究模式
    // 输入建议（官方 prompt suggestion）：新前端开着开关才带 suggest:true——老 apk 不带就不生成，
    // 免得白挂进程、白花额度去算一条没人看得见的建议。快照访客不给。
    const suggest = parsed.suggest === true && !isSnap;
    // 号池智能路由的无缝重发：新前端带 autoRetry:true 表示「撞额度墙被自动换号时，我会自己重发这条」——
    // 服务端这才把失败那条从上下文里分叉掉。老 apk 不带：照旧报错，用户手动重试，上下文不动。
    const autoRetry = parsed.autoRetry === true;
    // 自动压缩点（用量弹层滑块）：占模型窗口的比例，(0,1) 之外 = 默认。快照访客不给。
    const compactFrac = !isSnap && typeof parsed.compactFrac === 'number' && parsed.compactFrac > 0 && parsed.compactFrac < 1 ? parsed.compactFrac : undefined;
    // 权限模式：新会话草稿里选的（续聊用会话自己的记忆，前端不带）。取值与夹紧在 runtime/permissions.mjs，快照访客恒 default。
    // 只认新会话：限额自动续跑 / 会话唤醒会把首条请求的 body 原样重放、只补上 sessionId，草稿里选的模式（比如计划）
    // 不能跟着它压过会话自己的记忆。
    const permissionMode = !isSnap && !sessionId && typeof parsed.permissionMode === 'string' ? parsed.permissionMode.slice(0, 40) : undefined;
    // Claude 项目制（与 codex 同构，项目=工作空间路径=运行 cwd）：
    // 新会话按 claudeProjectId 选项目（缺省=「工作空间」默认项目，胶囊/旧客户端零改动）；
    // 续聊按 transcript 所在目录反查项目——会话的 cwd 一经建立不可改，忽略客户端传值。
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
    // 会话派生（服务端内部重放才有 family，见 session-family.mjs）：新开的子会话就在父会话的工作目录里跑
    //（同一个检出、同一个项目；父会话在 worktree 里就同一个 worktree）；start_session 带 project 时是那个项目的目录。
    // 路径照样过一遍授权。
    const family = req[FAMILY_REQ] && req[FAMILY_REQ].origin ? req[FAMILY_REQ] : null;
    if (family && !sessionId && family.cwd) {
      // 子会话开了自己的 worktree（start_session use_worktree）：带上 name / root / 所属项目，worktree 会话帧与工作台都完整
      const fw = family.worktree && family.worktree.branch ? family.worktree : null;
      const pid = (fw && fw.projectId) || family.projectId || '';
      claudeProject = { ...(pid ? { id: pid } : {}), path: family.cwd, ...(fw ? { worktree: { branch: fw.branch, ...(fw.name ? { name: fw.name } : {}), ...(fw.root ? { root: fw.root } : {}) } } : {}) };
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
          // 分支前缀与起点跟设置走（Git 与拉取请求：branchPrefix / worktreeBaseRef）
          const wt = await createSessionWorktree(ctx.claudeProjects, base, { prefix: claudeSetting(ctx, 'branchPrefix'), baseRef: claudeSetting(ctx, 'worktreeBaseRef') });
          claudeProject = { ...base, path: claudeProjects.authorizeProjectPath(ctx, wt.cwd), worktree: { name: wt.name, branch: wt.branch, root: wt.root } };
        } catch (e) {
          res.writeHead(e?.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e?.message || '创建 worktree 失败' }));
          return;
        }
      }
    }
    // 附件守卫（attachment-guard.mjs）：沙箱身份只收本人 uploads / 工作空间（cwd）/
    // 已授权项目内的路径；admin（桌面壳/主机本人）放行任意存在的绝对路径——
    // 桌面拖拽零拷贝引用（拖 20GB 目录进聊天不复制字节，agent 拿原路径按需读）。
    const attachments = filterAttachmentPaths(parsed.attachments, {
      allowAnywhere: ctx.kind === 'admin',
      roots: [ctx.uploads, ctx.cwd, claudeProject?.path],
    });
    if (!message && !attachments.length && !prewarm) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('empty message');
      return;
    }

    if (!ctx.allowClaude) return denied('Claude');
    // 插话 / 稍后发送（官方 Code 页：Claude 工作中按回车 = 插话，Ctrl+Enter = 排队）。
    // 只在这个会话正有一轮在跑时生效。没在跑（恰好刚收尾）回 409 not_running，由前端改走普通发送——
    // 官方是宿主内直接落成普通发送；这里请求方按 JSON 收，不能半路换成直播流。
    if (sessionId && (parsed.priority === 'next' || parsed.priority === 'later')) {
      const live = findGenBySession(ctx.key, sessionId);
      const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      // 「新会话 / 在这里做」卡还在等、用户没点卡直接发了新消息：卡作废，工具调用照官方告诉 Claude 先处理这条新消息
      if (live && !live.done) supersedeOffer(live);
      if (parsed.priority === 'next' && live && !live.done && typeof live.steer === 'function') {
        const uuid = live.steer({ message, attachments });
        if (uuid) { handedTurn(req, sessionId, 'steer'); return reply(200, { ok: true, steered: true, uuid }); }
      }
      if (parsed.priority === 'later' && live && !live.done) {
        const headers = replayHeadersOf(req);
        try {
          const r = enqueue(ctx.key, sessionId, { message, attachments, body: parsed, headers, url: req.url });
          return reply(200, { ok: true, queued: true, item: r.item, items: r.items });
        } catch (e) {
          return reply(e?.status || 400, { error: e?.message || '排队失败' });
        }
      }
      return reply(409, { code: 'not_running', error: '这一轮已经结束' });
    }
    // 单写者：这个会话正开在 Desktop / 终端 CLI 里（进程活着）就不 resume，免得 jsonl 分叉、
    // 这一轮在对方下一轮之后从历史里消失（external-holder.mjs）。
    if (sessionId) {
      const holder = findExternalHolder(sessionId);
      if (holder) {
        const doing = holder.status === 'busy' ? '正在生成' : '正开着';
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 'held_elsewhere',
          holder,
          error: `这个会话在 ${holder.label} 里${doing}，两边同时续聊会让对话分叉。请先在 ${holder.label} 里关掉它（或退出），再回来继续。`,
        }));
        return;
      }
    }
    // 项目 cwd 生效方式：覆写 ctx.cwd 传入——runClaudeChat 的 query cwd / resume 清理 /
    // 沙箱围栏全部吃 ctx.cwd，一处覆写全链路一致。默认项目 path === ctx.cwd，等价原行为。
    // homeRoot 保留身份原本的文件根（覆写前的 cwd）：产物文件夹卡要靠它算「在文件页里的位置」。
    // worktree 会话另带 worktree:{cwd,branch}——session 帧透给前端，工作台当场切到 worktree。
    const claudeCtx = claudeProject
      ? { ...ctx, cwd: claudeProject.path, homeRoot: ctx.cwd, ...(claudeProject.worktree ? { worktree: { cwd: claudeProject.path, branch: claudeProject.worktree.branch, ...(claudeProject.worktree.name ? { name: claudeProject.worktree.name, root: claudeProject.worktree.root } : {}) } } : {}) }
      : ctx;
    if (prewarm) {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      runClaudeChat(req, null, {
        message: '', sessionId: undefined, model, effort, fast, chatPrefs, attachments: [], style, styleText, research, suggest, compactFrac, source, fromPhone, narrow, originDevice, fromComputer, autoRetry,
        ctx: claudeCtx, prewarm: true, permissionMode,
      }).catch((e) => console.log('[claude] prewarm failed:', e && e.message));
      return;
    }
    // 5 小时限额重置后自动继续（limit-resume.mjs）：撞墙时要把这条请求原样留着，到点在服务端重放
    //（身份头同 claude-queue 的排队消息）。快照访客不给——一次性公开链接，没人等它续。
    // limitResume = 这一轮本身就是自动续跑发的（重放时 body 带上），不当成「人接手了」。
    const limitReplay = isSnap ? null : {
      headers: replayHeadersOf(req),
      url: req.url,
      body: parsed,
    };
    return runClaudeChat(req, res, {
      message, sessionId, model, effort, fast, chatPrefs, attachments, style, styleText, research, suggest, compactFrac, source, fromPhone, narrow, originDevice, fromComputer, autoRetry,
      limitReplay, limitResume: parsed.limitResume === true && !isSnap,
      globalMax: isSnap ? SNAP_MAX_TURNS : undefined,
      ctx: claudeCtx,
      family: isSnap ? null : family,
      permissionMode,
    });
  }

  router.on('POST', '/api/answer', (req, res) => handleAnswer(req, res, { identify }));
  // 档 2 手机文件桥：手机执行 phone_cmd 后回传结果（仿 /api/answer）。
  router.on('POST', '/api/phone-result', (req, res) => handlePhoneResult(req, res, { identify }));
}
