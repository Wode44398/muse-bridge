// Claude 分页：权限模式芯片 + 逐次工具审批卡 + 计划审批卡的前端状态（2026-10-20，对齐官方 Claude Desktop 3.1623）。
// 服务端：src/runtime/permissions.mjs（事件帧 perm_request / perm_answer / plan_request / plan_answer / perm_mode /
// perm_denied，接口 GET/POST /api/claude/permission-mode，答复走 POST /api/answer 的 decision / mode / feedback）。
//
// 数据落点：
//   · 逐次审批卡：perm.cards[sid]（只放还在等的；答了 / 别的设备答了 / 收轮就摘掉）——输入框上方的停靠卡（PermissionCard）；
//   · 计划审批卡：消息流里的 plan 段（与 ask 段同构，历史重建 sessions.mjs 落同形的已处理段）——PlanCard；
//   · 模式：perm.modes[sid] 是会话实况（init / status 帧、总线 perm_mode），perm.views 是 GET 回来的解析结果（含首次确认记录），
//     新会话草稿的选择在 perm.draft（发送首条消息时随 /api/chat 带上 permissionMode）。
// chat 内核（chat.svelte.js）只在 onEvent 里把这几种帧转给 onPermEvent，收轮 / attach 重放时调 permOnFinish / permOnAttach。
import { api } from './api.js';
import { busOn } from './bus.js';
import { session, ui } from './state.svelte.js';
import { cs } from './claudeSettings.svelte.js';
import { notifyKind } from './notify.js';
import { t, tc, tr } from './i18n.js';
import { PERMISSION_MODES } from '../../../src/config/claude-settings.mjs';

import { showToast as toast } from './toast.svelte.js';

// 官方顺序：Manual / Accept edits / Plan / Auto / Bypass（A1 §8.2）
export const MODE_ORDER = PERMISSION_MODES;
export function modeLabel(m) {
  switch (m) {
    case 'default': return t('手动');
    case 'acceptEdits': return t('接受编辑');
    case 'plan': return t('计划');
    case 'auto': return t('自动');
    case 'bypassPermissions': return t('绕过权限');
  }
  return m || '';
}
export function modeDesc(m) {
  switch (m) {
    case 'default': return t('做出更改前始终先询问');
    case 'acceptEdits': return t('自动接受所有文件编辑');
    case 'plan': return t('先制定计划再动手');
    case 'auto': return t('由 Claude 处理权限决策');
    case 'bypassPermissions': return t('接受所有权限请求');
  }
  return '';
}

export const perm = $state({
  modes: {},        // sid -> { mode, pendingMode?, at }：会话实况
  views: {},        // 's:'+sid | 'p:'+projectId -> GET 结果 { mode, source, modes, folderDefault, consent, folder?, pendingMode? }
  draft: { choice: null },   // 新会话草稿里显式选的模式（null = 跟文件夹默认 / 设置默认）
  cards: {},        // sid -> [卡]
  menu: 0,          // Ctrl+Shift+M 打开模式菜单的信号（自增，芯片订阅）
});

const viewKey = (sid, projectId) => (sid ? 's:' + sid : 'p:' + (projectId || ''));
export function modeView(sid = session.id, projectId = session.projectId) { return perm.views[viewKey(sid, projectId)] || null; }

// 夹到这个身份能选的（与服务端 clampMode 同口径；运行期以服务端为准）
export function clampModeLocal(m) {
  const modes = cs.permissionModes || [];
  if (modes.includes(m)) return m;
  if ((m === 'auto' || m === 'bypassPermissions') && modes.includes('acceptEdits')) return 'acceptEdits';
  return 'default';
}
// 芯片当前显示的模式
export function currentMode(sid = session.id) {
  if (sid) {
    const live = perm.modes[sid];
    if (live && live.mode) return live.mode;
    const v = perm.views['s:' + sid];
    if (v && v.mode) return v.mode;
    return null;
  }
  if (perm.draft.choice) return perm.draft.choice;
  const v = perm.views[viewKey(null, session.projectId)];
  return (v && v.mode) || clampModeLocal(cs.values.permissionMode);
}
// 新会话首条消息随 /api/chat 带的模式：只带草稿里显式选的（没选 = 服务端按文件夹 / 设置默认自己解析，结果一样）
export function draftPermissionMode() { return perm.draft.choice || null; }
export function resetPermDraft() { perm.draft.choice = null; }

export async function loadModeView(sid = session.id, projectId = session.projectId) {
  const q = sid ? 'session=' + encodeURIComponent(sid) : (projectId ? 'project=' + encodeURIComponent(projectId) : '');
  try {
    const v = await api.get('/api/claude/permission-mode' + (q ? '?' + q : ''));
    if (v && v.mode) perm.views[viewKey(sid, projectId)] = v;
    return v;
  } catch { return null; }
}

/**
 * 选模式。会话里选 = 只改这个会话（活着的 CLI 当场切）；新会话草稿里选 = 记成这个文件夹的默认（plan 不记）。
 * ack：这次选择带着首次确认（自动模式 / 绕过权限的确认框点了确认）。返回 { ok, applied }。
 */
export async function setMode(mode, { ack = false } = {}) {
  const sid = session.id;
  const body = { mode, ...(sid ? { sessionId: sid } : { projectId: session.projectId || undefined }), ...(ack ? { ack: true } : {}) };
  const prevLive = sid ? perm.modes[sid] : null;
  if (!sid) perm.draft.choice = mode;
  else if (mode !== 'bypassPermissions') perm.modes[sid] = { mode, at: Date.now() };   // 乐观；bypass 可能被延后，等回执
  try {
    const r = await api.post('/api/claude/permission-mode', body);
    if (r && r.mode) perm.views[viewKey(sid, session.projectId)] = r;
    if (sid && r) {
      if (r.applied === 'deferred') {
        perm.modes[sid] = { mode: r.mode, pendingMode: mode, at: Date.now() };
        toast(t('Claude 这一轮结束后开启绕过权限'));
      } else perm.modes[sid] = { mode, at: Date.now() };
    }
    return { ok: true, applied: r && r.applied };
  } catch (e) {
    if (sid) { if (prevLive) perm.modes[sid] = prevLive; else delete perm.modes[sid]; }
    // 认得的错误码给本地化的一句（服务端 / CLI 的原文是中文或英文，混在界面里不好看）；认不得的才拼原文
    const known = e && e.body && SET_ERR[e.body.code];
    const msg = (e && e.body && (e.body.error || e.body)) || '';
    toast(known ? t('权限模式没能切换：{detail}', { detail: known() })
      : typeof msg === 'string' && msg && !/^HTTP \d+$/.test(msg) ? t('权限模式没能切换：{detail}', { detail: tr(msg) }) : t('权限模式没能切换，可以重试。'), 'err');
    return { ok: false };
  }
}
const SET_ERR = {
  not_available: () => t('这个权限模式在这里不可用'),
  auto_unavailable: () => t('自动模式对这个模型不可用'),
  bypass_not_launched: () => t('这个会话启动时没开绕过权限，Claude 这一轮结束后再选一次'),
};

// ---- 事件（chat 内核的 onEvent 转来；attach 重放同一条路）--------------------------------
const sidOf = (ev) => ev.sessionId || session.id || '';
// 必须回读 perm.cards[sid]：赋值表达式的值是原始数组，往它里 push 绕开了 $state 代理（第一张卡出不来）
function cardsOf(sid) { if (!perm.cards[sid]) perm.cards[sid] = []; return perm.cards[sid]; }

export function onPermEvent(m, ev) {
  switch (ev.type) {
    case 'perm_request': {
      const sid = sidOf(ev);
      if (!sid) return;
      const list = cardsOf(sid);
      if (list.some((c) => c.qid === ev.qid)) return;
      list.push({ ...ev, sessionId: sid, submitting: false, error: '', shownAt: Date.now() });
      remind('permission', ev.qid, sid, () => permTitleText(ev));
      return;
    }
    case 'perm_answer': {
      const sid = sidOf(ev);
      const list = perm.cards[sid];
      if (list) perm.cards[sid] = list.filter((c) => c.qid !== ev.qid);
      return;
    }
    case 'plan_request': {
      if (!m || m.segments.some((s) => s.kind === 'plan' && s.qid === ev.qid)) return;
      m.segments.push({
        kind: 'plan', qid: ev.qid, plan: ev.plan || '', planFile: ev.planFile || '',
        accept: Array.isArray(ev.accept) ? ev.accept : [], trust: ev.trust || 'default', canClear: !!ev.canClear,
        answered: false, decision: '', mode: '', feedback: '', newSessionId: '', error: '',
        submitting: false, submitError: '', comments: [], shownAt: Date.now(),
      });
      pendingPlans.set(ev.qid, sidOf(ev));
      remind('plan', ev.qid, sidOf(ev), () => t('Claude 提出了一个计划，等你审批'));
      return;
    }
    case 'plan_answer': {
      const seg = m && findPlan(m, ev.qid);
      pendingPlans.delete(ev.qid);
      if (!seg) return;
      seg.answered = true;
      seg.submitting = false;
      seg.decision = ev.decision || '';
      seg.mode = ev.mode || '';
      seg.feedback = ev.feedback || '';
      if (ev.newSessionId) seg.newSessionId = ev.newSessionId;
      if (ev.error) seg.error = ev.error;
      return;   // 本机点的「清空上下文后执行」：PlanCard 等这一轮收住后自动打开新会话
    }
    case 'perm_mode': notePermMode(ev); return;
  }
}
// attach 重放窗口（chat 内核在 attach 帧时调 permOnAttach 打开）：一口气灌完的历史帧只更新状态、不弹提示
let replayUntil = 0;
const toasted = new Set();
export function notePermMode(ev) {
  const sid = sidOf(ev);
  if (!sid || !ev.mode) return;
  const prev = perm.modes[sid];
  perm.modes[sid] = { mode: ev.mode, ...(ev.pendingMode ? { pendingMode: ev.pendingMode } : {}), at: Date.now() };
  // 提示只给新鲜事件：attach 整轮重放（断线重连 / 刷新）会把这一轮开头的降级帧再灌一遍，别每次都弹；
  // 同一帧经 SSE 与总线各到一次也只弹一回（按 at 去重）
  const once = () => {
    if (Date.now() < replayUntil) return false;
    const k = sid + '|' + (ev.at || '') + '|' + (ev.trigger || '') + '|' + ev.mode;
    if (toasted.has(k)) return false;
    toasted.add(k);
    return true;
  };
  // 绕过权限待生效：这一轮定局后真切过去了，提示一次（官方「Bypass permissions is on now」）
  if (prev && prev.pendingMode === 'bypassPermissions' && ev.mode === 'bypassPermissions' && sid === session.id && once()) toast(t('绕过权限已开启。要关掉就选别的模式。'));
  // CLI 降级（auto 对这个模型不可用 → 手动）：官方同款提示
  if (ev.trigger === 'fallback' && sid === session.id && once()) toast(t('自动模式对这个模型不可用，已切到{mode}。', { mode: modeLabel(ev.mode) }));
}
function findPlan(m, qid) {
  for (let i = m.segments.length - 1; i >= 0; i--) { const s = m.segments[i]; if (s.kind === 'plan' && s.qid === qid) return s; }
  return null;
}
// attach 整轮重放：这个会话的审批卡清场，重放按顺序重建（仍在等的恢复可点）；重放期间的模式帧不弹提示
export function permOnAttach(sid) { if (sid) delete perm.cards[sid]; replayUntil = Date.now() + 1500; }
// 一轮收尾（停止 / 出错 / 正常定局）：还挂着的卡已无人在等；计划卡在流里标「没批完」（硬停止时服务端不再发 plan_answer）
export function permOnFinish(m, sid) {
  if (sid) delete perm.cards[sid];
  if (m && m.segments) for (const s of m.segments) if (s.kind === 'plan' && !s.answered) { s.answered = true; s.decision = 'cancelled'; s.submitting = false; pendingPlans.delete(s.qid); }
}
export const pendingCards = (sid) => (sid && perm.cards[sid]) || [];
export const hasPendingApproval = (m, sid) => pendingCards(sid).length > 0 || !!(m && m.segments && m.segments.some((s) => s.kind === 'plan' && !s.answered));

// 总线：别的设备切了模式 / 计划批准切了模式 → 芯片当场跟上
busOn((ev) => { if (ev && ev.type === 'perm_mode') notePermMode(ev); });

// ---- 作答 ---------------------------------------------------------------------------------
function errDetail(e) {
  const d = (e?.body && typeof e.body === 'object' ? (e.body.error || e.body.message) : e?.body) || e?.message || '';
  return d && !/^HTTP \d+$/.test(d) ? t('提交失败：{detail}', { detail: tr(d) }) : t('提交失败，请重试');
}
// decision：once | always | auto | deny（feedback 可选）。先锁 submitting；成功后由随后到达的 perm_answer 摘卡，这里也兜底摘。
export async function answerPermission(card, decision, { feedback, ack } = {}) {
  if (!card || card.submitting) return;
  card.submitting = true;
  card.error = '';
  try {
    await api.answer(card.qid, { decision, ...(feedback ? { feedback } : {}), ...(ack ? { ack: true } : {}) });
    // 卡片上确认过自动模式：本地视图也记上，之后从模式芯片再选自动不再弹首次确认
    if (ack && decision === 'auto') for (const v of Object.values(perm.views)) if (v && v.consent) v.consent.auto = true;
  } catch (e) {
    card.submitting = false;
    // 404 = 已经在别处处理了（别的设备先答 / 这一轮已收）——安静收起
    if (e && e.status === 404) { dropCard(card); return; }
    card.error = errDetail(e);
    return;
  }
  dropCard(card);
}
function dropCard(card) {
  const list = perm.cards[card.sessionId];
  if (list) perm.cards[card.sessionId] = list.filter((c) => c.qid !== card.qid);
}
// 计划：decision accept | clear（带 mode）| revise（feedback，可空 = 拒绝）| reject
export async function answerPlan(seg, decision, { mode, feedback } = {}) {
  if (!seg || seg.answered || seg.submitting) return false;
  seg.submitting = true;
  seg.submitError = '';
  seg.__mine = true;
  try {
    await api.answer(seg.qid, { decision, ...(mode ? { mode } : {}), ...(feedback ? { feedback } : {}) });
  } catch (e) {
    seg.submitting = false;
    if (e && e.status === 404) { seg.answered = true; seg.decision = seg.decision || 'cancelled'; return false; }
    seg.submitError = errDetail(e);
    return false;
  }
  return true;
}

// ---- 卡片标题句（「允许 Claude {动作} {对象}？」）-----------------------------------------
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const firstLine = (s, n = 80) => { const l = String(s || '').split('\n')[0].trim(); return l.length > n ? l.slice(0, n) + '…' : l; };
// { action, meta } —— 动作动词加粗、对象次要色（官方 7px6ACmQ5k 等四种句式）
export function permTitleParts(ev) {
  const p = ev.preview || {};
  switch (p.kind) {
    case 'command': return { action: tc('perm', '运行'), meta: p.description || firstLine(p.command) };
    case 'write': return { action: tc('perm', '写入'), meta: base(p.path) };
    case 'edit': return { action: tc('perm', '编辑'), meta: base(p.path) };
    case 'path': return { action: tc('perm', '读取'), meta: base(p.path) };
    case 'search': return { action: tc('perm', '搜索'), meta: p.pattern || '' };
    case 'fetch': return { action: tc('perm', '抓取'), meta: p.url || '' };
    case 'websearch': return { action: tc('perm', '搜索网页'), meta: p.query || '' };
    case 'skill': return { action: tc('perm', '运行技能'), meta: p.skill ? '/' + String(p.skill).replace(/^\//, '') : '' };
    case 'agent': return { action: tc('perm', '运行 agent'), meta: p.description || '' };
    case 'workflow': return { action: tc('perm', '运行工作流'), meta: p.name || '' };
  }
  if (ev.mcp) return { action: tc('perm', '使用 {tool}', { tool: ev.mcp.tool || ev.tool }), meta: ev.mcp.server ? t('（来自 {server}）', { server: ev.mcp.server }) : '' };
  return { action: tc('perm', '使用 {tool}', { tool: ev.displayName || ev.tool }), meta: '' };
}
export function permTitleText(ev) {
  const { action, meta } = permTitleParts(ev);
  return meta ? t('允许 Claude {action} {meta}？', { action, meta }) : t('允许 Claude {action}？', { action });
}

// ---- 提醒（系统通知）-----------------------------------------------------------------------
// 统一走 notify.js 的 notifyKind('permission', …)（计划审批也算权限请求，与官方 Desktop「Permission requests」同类）：
// 按本机设置「权限请求」开关门控；人正看着这个会话（在 Claude 页、页面可见、就是这个会话）不弹；tag=qid 去重。
// 延后 800ms 再判还在不在等：attach 重放会先建卡再标已答，别为早就答完的卡弹通知。
const reminded = new Set();
const pendingPlans = new Map();   // 还在等的计划卡 qid -> 会话 id（提醒前再核一次；插话提示也看它）
function remind(kind, qid, sid, bodyFn) {
  if (!qid || reminded.has(qid)) return;
  reminded.add(qid);
  if (reminded.size > 500) reminded.delete(reminded.values().next().value);
  setTimeout(() => {
    const still = kind === 'plan' ? pendingPlans.has(qid) : pendingCards(sid).some((c) => c.qid === qid);
    if (!still) return;
    const title = kind === 'plan' ? t('计划等你审批') : t('Claude 需要你批准');
    let body = '';
    try { body = bodyFn(); } catch {}
    const watching = ui.screen === 'claude' && typeof document !== 'undefined' && !document.hidden && session.id === sid;
    try { notifyKind('permission', { title, body, watching, tag: qid }); } catch {}
  }, 800);
}

// 这个会话眼下有审批卡 / 计划卡在等（不看消息对象）：别的卡片的快捷键据此让路（SessionStartCards 的 offer 卡 Esc / Ctrl+Enter）
export function approvalWaiting(sid) {
  return !!sid && (pendingCards(sid).length > 0 || [...pendingPlans.values()].includes(sid));
}

// 插话推进去了，但这个会话正卡在审批上：CLI 要等「手头这一步」做完才读插话，而这一步就是在等你批（B1 §4.5-4）
export function steerWhileWaiting(sid) {
  if (!approvalWaiting(sid)) return;
  toast(t('Claude 正等你批准，批完才会读到这条插话'));
}

// ---- 快捷键让路 ---------------------------------------------------------------------------------
// 审批卡 / 计划卡的 Esc、Ctrl+Enter 挂在 window 捕获阶段，比别的浮层自己的处理器（元素上 / window 冒泡）先跑，
// 光看 defaultPrevented 拦不住（审查 1020：模式芯片菜单开着按 Esc 关菜单，审批卡跟着把工具拒了、这一轮被停掉）。
// 让路的四种情形：① 别的处理器已认领这次按键；② 按键落在别的对话框 / 菜单里；③ 屏幕上开着别的菜单 / 对话框；
// ④ 视口正中被一层全屏浮层盖着（灯箱、媒体查看器、芯片菜单的透明遮罩这类没标 role 的）。own = 卡片自己的根元素。
const OVERLAY_AT = '[role="menu"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const OVERLAY_OPEN = '[role="menu"], [role="dialog"], [aria-modal="true"]';
export function keyYield(e, own) {
  if (!e || e.defaultPrevented) return true;
  if (typeof document === 'undefined') return false;
  const mine = (el) => !!own && (own === el || own.contains(el) || el.contains(own));
  const tg = e.target && e.target.nodeType === 1 ? e.target : null;
  const box = tg && tg.closest(OVERLAY_AT);
  if (box && !mine(box)) return true;
  for (const el of document.querySelectorAll(OVERLAY_OPEN)) if (!mine(el) && el.getClientRects().length) return true;
  return coveredByOverlay(own);
}
function coveredByOverlay(own) {
  const w = window.innerWidth, h = window.innerHeight;
  if (!w || !h) return false;
  for (let el = document.elementFromPoint(w / 2, h / 2); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (own && el.contains(own)) return false;   // 走到了卡片所在的页面本身
    if (getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width >= w * 0.9 && r.height >= h * 0.9) return true;
  }
  return false;
}

// ---- 卡片原因行 -----------------------------------------------------------------------------------
// CLI 的 decision_reason 是英文自由文本（rule / mode 类根本不带字）：按 decisionReasonType 给一句本地化的引子，
// 具体内容（哪条安全检查、哪个路径）原文跟在后面次要色；映射不到的类型只显示原文。
// CLI 给的原因原文是英文（decision_reason / description）。常见的几句认出来：只说「要批准」的套话不显示（卡片本身就在问），
// 有信息量的换成界面语言；认不出的照旧显示原文。
const CLI_REASON = {
  'This command requires approval': '',
  'Claude in Chrome requires permission.': '',
  'Agent tool requires permission to spawn subagents.': '',
  'Managed settings require approval': t('组织的托管设置要求这一步由你批准。'),
  'Your organization requires approval for this tool': t('你的组织要求这个工具由你批准。'),
  'This command uses shell operators that require approval for safety': t('这条命令用了需要批准的 shell 操作符。'),
  'Multiple directory changes in one command require approval for clarity': t('一条命令里切换了多次目录，需要你批准。'),
  'Compound commands with cd and git require permission checks for enhanced security': t('cd 和 git 连在一起的复合命令需要你批准。'),
};
export function permReason(card) {
  const raw0 = String((card && card.reason) || '').trim();
  const raw = Object.prototype.hasOwnProperty.call(CLI_REASON, raw0) ? CLI_REASON[raw0] : raw0;
  const shell = card && (card.tool === 'Bash' || card.tool === 'PowerShell');
  let lead = '';
  switch (card && card.reasonType) {
    case 'rule': lead = shell ? t('你的 Claude Code 设置里有针对 shell 命令的规则。') : t('你的 Claude Code 设置里有针对这个工具的规则。'); break;
    case 'workingDir': lead = t('要用到工作目录之外的路径。'); break;
    case 'safetyCheck': case 'subcommandResults': lead = t('这一步触发了安全检查。'); break;
    case 'classifier': lead = t('自动模式拿不准，交给你决定。'); break;
    case 'hook': lead = t('钩子要求这一步由你批准。'); break;
    case 'sandboxOverride': lead = card.preview && card.preview.unsandboxed ? '' : t('要在沙箱之外运行。'); break;
  }
  return { lead, detail: raw && raw !== lead ? raw : '' };
}

// ---- 快捷键：哪里在打字就别抢键（官方：composer 有草稿时批准快捷键被 withheld）---------------
export function typingInto(target) {
  const el = target && target.nodeType === 1 ? target : null;
  if (!el) return false;
  if (el.closest('.composer [contenteditable="true"]')) return !!(el.innerText || '').trim();
  return !!el.closest('input, textarea, select, [contenteditable="true"]');
}
// 计划批注 → 反馈文本（官方 ds()：按在计划里的位置排序，批注间空一行，与自由文本间空两行）
export function planFeedback(comments, free) {
  const parts = [...(comments || [])].sort((a, b) => (a.at || 0) - (b.at || 0)).map((c) =>
    'On selected text:\n' + String(c.quote || '').split('\n').map((l) => '> ' + l).join('\n') + '\n' + String(c.text || '').trim());
  const head = parts.join('\n\n');
  const tail = String(free || '').trim();
  return head && tail ? head + '\n\n\n' + tail : (head || tail);
}
