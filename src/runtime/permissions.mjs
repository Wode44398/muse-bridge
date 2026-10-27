// Claude 分页的权限模式 + 逐次工具审批卡 + 计划审批卡（2026-10-20，对齐官方 Claude Desktop 3.1623）。
// 调研：bridge build/bridge前端设计/claude页面设计参考资源/桌面端对齐-1020/A1（官方 UI 与文案）、B1（bridge 现状与 SDK 核实）。
//
// 一、权限模式——每轮显式传给 SDK（以前不传，CLI 按 GrowthBook 闸自己挑 default / auto，服务端开关一翻全变）：
//   resolveTurnMode 取值顺序：无人值守（快照访客 / 管理台代聊）固定 default
//     → 这一轮请求里带的（新会话草稿里选的）→ 会话级记忆（chat-prefs 的 permissionMode）
//     → 父会话的（派生的子会话继承）→ 按文件夹记忆（folderKey；plan 不记）→ 设置默认 defaultPermissionModeFor
//     → clampMode 夹到这个身份能选的（permissionModesFor：沙箱身份永远没有 bypass / auto）。
//   会话中切模式：POST /api/claude/permission-mode → 对这个会话在跑 / 挂起 / 停放的 CLI 调 setPermissionMode()
//     （claude.mjs 经 bindModeControl 登记控制口）；绕过权限在 Claude 干活时不立刻开（官方同款），记下、下一轮开跑时生效。
//   CLI 自己报的模式变化（init / status 帧的 permissionMode：计划批准、模型自行进计划、auto 不可用降级）→ claude.mjs
//     发 perm_mode 事件并调 noteSessionMode 记进会话记忆，下一轮照它 spawn。
// 二、逐次工具审批卡（canUseTool；CLI 只在模式要求时才问）：沙箱复检 → 无人值守放行 → bridge 自带的进程内 MCP
//   白名单放行 → 发 perm_request 等人。等待通道复用 AskUserQuestion 那套（waitForAnswer / sessionQuestions 待回答点 /
//   POST /api/answer / 总线 question / attach 重放）；交互轮不设超时，停止 / 顶掉的 abort 收场。
// 三、计划审批卡（ExitPlanMode，任何模式下都会进 canUseTool）：批准 = allow + 一条 session 级 setMode；
//   修改 = deny + 反馈（不中断，模型留在计划模式改）；拒绝 = deny + 中断；清空上下文后执行（设置 planClearContext）=
//   deny + 中断 + 服务端另开一个新会话把计划送进去（CLI showClearContextOnPlanAccept 同语义：新上下文、带计划与原转录路径）。
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { readJson, writeJson, ID_RE } from '../jsonfile.mjs';
import { readBody } from './body.mjs';
import { busPublish } from './bus.mjs';
import { contextFor } from './identity.mjs';
import { sessionQuestions, waitForAnswer, pendingFor } from './questions.mjs';
import { needsUserApproval, noteToolApproval } from './tool-approvals.mjs';
import { getOp } from '../agent-api/registry.mjs';
import { permissionModesFor, defaultPermissionModeFor, claudeSetting } from './claude-settings.mjs';
import { chatPrefsFor, setChatPrefsPermissionMode } from './chat-prefs.mjs';
import { replayChat } from './claude-queue.mjs';
import { sessionPaths } from './paths.mjs';
import { clip, workflowNameFromInput } from './tool-summary.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import { isQuickDir } from '../claude-quick.mjs';
import { PERMISSION_MODES } from '../config/claude-settings.mjs';

// ---- 模式解析 -------------------------------------------------------------------------

// 按文件夹记忆的键（官方 epitaxy-folder-permission-mode 的 folderKey）：仓库根 / 原始 cwd，worktree 路径剥掉
// /.claude/worktrees/<名> 这一段——同一个仓库开出来的 worktree 会话共用一份默认。只剥中间这段、保留后面的子目录：
// 子目录项目的 worktree 会话 cwd 是 <根>/.claude/worktrees/<名>/<子目录>，键要等于项目路径 <根>/<子目录>（草稿视图按它记）。
export function folderKey(cwd) {
  if (!cwd) return '';
  let p = path.resolve(String(cwd)).replace(/\\/g, '/');
  p = p.replace(/\/\.claude\/worktrees\/[^/]+/i, '');
  if (process.platform === 'win32') p = p.toLowerCase();
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}
// 带身份的版本：快照对话的一次性桶共用一个「scratch:」键（官方 scratch 同款），别给每只桶各记一条
export const folderKeyFor = (ctx, cwd) => (isQuickDir(ctx, cwd) ? 'scratch:' : folderKey(cwd));

// 按身份的小台账（ctx.dataDir/claude-permission-modes.json）：
//   folders        { folderKey: mode }   新会话草稿里选的模式（plan 不记）
//   autoConsented  bool                  自动模式首次确认框点过「启用」（账号级，只问一次）
//   bypassAcks     [folderKey]           绕过权限首次确认（按文件夹，官方同款）
//   plans          { toolUseId: { m, d, n, at } }  计划卡的结论（d：accept / clear / revise / reject / cancelled）、
//                                          批准时选的目标模式 m、清空上下文后执行开出的新会话 n。transcript 里分不出来：
//                                          ExitPlanMode 的 tool_result 不带目标模式；拒绝、清空上下文后执行（都是 deny+interrupt）
//                                          和停止，CLI 写的是同一句「The user doesn't want to proceed … STOP …」（2026-10-21 实测）。
//                                          历史重建靠这里与直播同口径，见 routes/sessions.mjs
const FOLDER_CAP = 300;
const PLAN_CAP = 300;
const ledgerCache = new Map();
const ledgerFile = (ctx) => path.join(ctx.dataDir, 'claude-permission-modes.json');
function ledger(ctx) {
  const f = ledgerFile(ctx);
  if (ledgerCache.has(f)) return ledgerCache.get(f);
  const raw = readJson(f, {});
  const folders = {};
  if (raw.folders && typeof raw.folders === 'object') for (const [k, v] of Object.entries(raw.folders)) if (PERMISSION_MODES.includes(v) && v !== 'plan') folders[k] = v;
  const plans = {};
  if (raw.plans && typeof raw.plans === 'object') {
    for (const [k, v] of Object.entries(raw.plans)) {
      if (!v || !(PERMISSION_MODES.includes(v.m) || PLAN_DECISIONS.includes(v.d))) continue;
      plans[k] = { ...(PERMISSION_MODES.includes(v.m) ? { m: v.m } : {}), ...(PLAN_DECISIONS.includes(v.d) ? { d: v.d } : {}), ...(typeof v.n === 'string' && ID_RE.test(v.n) ? { n: v.n } : {}), at: Number(v.at) || 0 };
    }
  }
  const d = { folders, autoConsented: raw.autoConsented === true, bypassAcks: Array.isArray(raw.bypassAcks) ? raw.bypassAcks.filter((x) => typeof x === 'string').slice(-FOLDER_CAP) : [], plans };
  ledgerCache.set(f, d);
  return d;
}
function saveLedger(ctx) {
  const d = ledger(ctx);
  const keys = Object.keys(d.folders);
  if (keys.length > FOLDER_CAP) for (const k of keys.slice(0, keys.length - FOLDER_CAP)) delete d.folders[k];
  const pk = Object.keys(d.plans);
  if (pk.length > PLAN_CAP) for (const k of pk.slice(0, pk.length - PLAN_CAP)) delete d.plans[k];
  writeJson(ledgerFile(ctx), d, 2);
}

// 计划卡的结论：记一笔 / 历史重建时按 tool_use id 查（routes/sessions.mjs 的 planRecord 回调）
const PLAN_DECISIONS = ['accept', 'clear', 'revise', 'reject', 'cancelled'];
export function notePlan(ctx, toolUseId, { mode, decision, newSessionId } = {}) {
  if (!ctx || !ctx.dataDir || ctx.snap || !toolUseId) return;
  const rec = { ...(validMode(mode) ? { m: mode } : {}), ...(PLAN_DECISIONS.includes(decision) ? { d: decision } : {}), ...(newSessionId && ID_RE.test(newSessionId) ? { n: newSessionId } : {}), at: Date.now() };
  if (!rec.m && !rec.d) return;
  try { ledger(ctx).plans[String(toolUseId)] = rec; saveLedger(ctx); } catch {}
}
export const notePlanMode = (ctx, toolUseId, mode) => notePlan(ctx, toolUseId, { mode, decision: 'accept' });
export function planRecordFor(ctx, toolUseId) {
  if (!ctx || !ctx.dataDir || !toolUseId) return null;
  try {
    const r = ledger(ctx).plans[String(toolUseId)];
    return r ? { mode: r.m || '', decision: r.d || '', newSessionId: r.n || '' } : null;
  } catch { return null; }
}
export const planModeFor = (ctx, toolUseId) => planRecordFor(ctx, toolUseId)?.mode || '';

// 夹到这个身份能选的：不可选的 auto / bypass → 接受编辑（官方「Bypass permissions isn’t allowed here, so this session
// switched to Accept edits」），其余 → 手动。
// 权限模式的宽严（数字越小越严）。进程里切模式失败时据此判断：要的比眼下的严，就不能用眼下的模式凑合跑。
const MODE_RANK = { plan: 0, dontAsk: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };
export const stricterMode = (want, cur) => (MODE_RANK[want] ?? 1) < (MODE_RANK[cur] ?? 4);

export function clampMode(ctx, mode) {
  const modes = permissionModesFor(ctx);
  if (modes.includes(mode)) return mode;
  if ((mode === 'auto' || mode === 'bypassPermissions') && modes.includes('acceptEdits')) return 'acceptEdits';
  return modes.includes('default') ? 'default' : (modes[0] || 'default');
}

// 启动时带不带 allowDangerouslySkipPermissions（只让 bypass「可切」，不等于开启）：主机 admin 且主机开着「允许绕过权限」。
// 沙箱身份永不带——CLI 层 bypass_not_launched 是第二道闸。
export function allowSkipFor(ctx) {
  return !!ctx && ctx.kind === 'admin' && !ctx.sandbox && !ctx.snap && permissionModesFor(ctx).includes('bypassPermissions');
}

const validMode = (m) => typeof m === 'string' && PERMISSION_MODES.includes(m);

/**
 * 这一轮用什么权限模式。policy 'host' = 无人值守（管理台代聊等），固定 default + 宿主放行。
 * 返回 { mode, source }：source ∈ host | request | session | parent | folder | settings。
 */
export function resolveTurnMode(ctx, { sessionId, requested, policy, inheritFrom } = {}) {
  if (policy === 'host' || !ctx || ctx.snap) return { mode: 'default', source: 'host' };
  let want = null, source = '';
  if (validMode(requested)) { want = requested; source = 'request'; }
  if (!want && sessionId) { const p = chatPrefsFor(ctx, sessionId); if (p && validMode(p.permissionMode)) { want = p.permissionMode; source = 'session'; } }
  if (!want && inheritFrom) {
    // 派生的子会话继承父会话的模式；父会话正在计划模式就不跟（子会话是去干活的）
    const p = chatPrefsFor(ctx, inheritFrom);
    if (p && validMode(p.permissionMode) && p.permissionMode !== 'plan') { want = p.permissionMode; source = 'parent'; }
  }
  if (!want && ctx.dataDir) { const f = ledger(ctx).folders[folderKeyFor(ctx, ctx.cwd)]; if (validMode(f)) { want = f; source = 'folder'; } }
  if (!want) { want = defaultPermissionModeFor(ctx); source = 'settings'; }
  return { mode: clampMode(ctx, want), source };
}

// CLI 报来的模式（或这一轮按它 spawn 的模式）记进会话记忆。快照访客不记。
// ifUnset：只在这个会话还没记过模式时落（init 帧用——见 claude.mjs notePermMode：会话记忆同时承载「待生效的选择」，
// 后到的 init 只报实况，不许把用户刚选的冲掉）。
export function noteSessionMode(ctx, sessionId, mode, { ifUnset = false } = {}) {
  if (!ctx || ctx.snap || !sessionId || !validMode(mode)) return;
  if (ifUnset && validMode(chatPrefsFor(ctx, sessionId)?.permissionMode)) return;
  try { setChatPrefsPermissionMode(ctx, sessionId, mode); } catch {}
}

// 一轮定局、CLI 要停放时：会话记忆里的模式与进程眼下的不同 → 返回该切过去的模式（夹紧后），否则 null。
// 主要是干活时选的绕过权限（官方 kept pick「Claude 这一轮结束后开启」）：停放前就切，芯片当场变，不必等下一条消息。
export function deferredModeFor(ctx, sessionId, current) {
  if (!ctx || ctx.snap || !sessionId) return null;
  const p = chatPrefsFor(ctx, sessionId);
  const want = p && validMode(p.permissionMode) ? clampMode(ctx, p.permissionMode) : null;
  return want && want !== current ? want : null;
}
// 待生效的绕过权限（芯片上的小红点）：只有绕过权限是「这一轮结束后才开」，别的模式选了当场切。
// perm_mode 事件带上它——否则挂起后的续轮 init 帧会把前端的待生效点抹掉。
export function pendingModeFor(ctx, sessionId, current) {
  return deferredModeFor(ctx, sessionId, current) === 'bypassPermissions' ? 'bypassPermissions' : null;
}

// ---- 会话中切模式：活着的 CLI 的控制口 ----------------------------------------------------
// claude.mjs 在拿到会话 id 时登记（在跑 / 挂起 / 停放都是同一个进程、同一个口），进程退出时注销。
// ctl = { set(mode): Promise, busy(): bool（模型正在干活）, current(): mode, note(mode) }
const controls = new Map();
export function bindModeControl(key, sid, ctl) {
  if (!key || !sid || !ctl) return () => {};
  const k = key + '|' + sid;
  controls.set(k, ctl);
  return () => { if (controls.get(k) === ctl) controls.delete(k); };
}
const controlFor = (key, sid) => controls.get(key + '|' + sid) || null;

// ---- 逐次审批卡的内容 ---------------------------------------------------------------------
const PREVIEW = 6000;
// 卡片上要摆的入参（命令 / 文件改动 / 网址 / MCP 的「Claude 发送的内容」）。与工具行的安全子集不同：
// 审批要看全才批得了，所以给到 6000 字；MCP 入参按键值行给（值截 1500）。
export function permPreview(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const s = (v, n = PREVIEW) => (typeof v === 'string' ? clip(v, n) : '');
  switch (name) {
    case 'Bash': case 'PowerShell':
      return { kind: 'command', command: s(i.command), description: s(i.description, 300), background: !!i.run_in_background, unsandboxed: !!i.dangerouslyDisableSandbox };
    case 'Write':
      return { kind: 'write', path: s(i.file_path, 500), content: s(i.content), size: String(i.content || '').length };
    case 'Edit':
      return { kind: 'edit', path: s(i.file_path, 500), edits: [{ old: s(i.old_string), new: s(i.new_string) }], replaceAll: !!i.replace_all };
    case 'MultiEdit': {
      const list = Array.isArray(i.edits) ? i.edits : [];
      return { kind: 'edit', path: s(i.file_path, 500), edits: list.slice(0, 6).map((e) => ({ old: s(e && e.old_string, 2000), new: s(e && e.new_string, 2000) })), more: Math.max(0, list.length - 6) };
    }
    case 'NotebookEdit':
      return { kind: 'edit', path: s(i.notebook_path, 500), edits: [{ old: '', new: s(i.new_source) }] };
    case 'Read':
      return { kind: 'path', path: s(i.file_path, 500) };
    case 'Glob': case 'Grep':
      return { kind: 'search', pattern: s(i.pattern, 300), path: s(i.path, 500) };
    case 'WebFetch':
      return { kind: 'fetch', url: s(i.url, 1000), prompt: s(i.prompt, 1000) };
    case 'WebSearch':
      return { kind: 'websearch', query: s(i.query, 500) };
    case 'Skill':
      return { kind: 'skill', skill: s(i.skill || i.command, 200), args: s(i.args, 1000) };
    case 'Task': case 'Agent':
      return { kind: 'agent', description: s(i.description, 300), prompt: s(i.prompt, 1500) };
    case 'Workflow':
      return { kind: 'workflow', name: workflowNameFromInput(i) || '' };
    default:
      return {
        kind: 'fields',
        fields: Object.entries(i).slice(0, 20).map(([k, v]) => [clip(k, 80), typeof v === 'string' ? clip(v, 1500) : clip(JSON.stringify(v), 1500)]),
      };
  }
}

// 「始终允许」回传的 updatedPermissions：只取 CLI 给的 suggestions 的子集（自己造的 allow 规则会被 CLI
// stripUnvettedAllowRules 剥掉）。过滤口径照官方 bI：allow 规则保留（只留指向这个工具 / 这个 MCP 服务器的、内容为可打印
// ASCII、最多 5 条）；替换 / 删除规则丢弃；setMode 只留 default / acceptEdits / plan 且一律 session（绝不经「始终允许」
// 把会话切进 bypass / auto）；目录类强制 session。沙箱身份 settingSources:[]，写 *Settings 既不生效又留垃圾 → 一律 session，
// 加目录直接不给（围栏外的目录本来就进不去）。
const PRINTABLE = /^[\x20-\x7e]*$/;
export function filterSuggestions(name, list, { sandbox = false } = {}) {
  if (!Array.isArray(list)) return [];
  const mcpServer = typeof name === 'string' && name.startsWith('mcp__') ? name.split('__').slice(0, 2).join('__') : '';
  const toolOk = (t) => t === name || (!!mcpServer && (t === mcpServer || t.startsWith(mcpServer + '__')));
  const out = [];
  for (const u of list) {
    if (!u || typeof u !== 'object') continue;
    if (u.type === 'addRules') {
      if (u.behavior !== 'allow') continue;
      const rules = (Array.isArray(u.rules) ? u.rules : [])
        .filter((r) => r && typeof r.toolName === 'string' && toolOk(r.toolName) && (r.ruleContent == null || (typeof r.ruleContent === 'string' && PRINTABLE.test(r.ruleContent))))
        .slice(0, 5)
        .map((r) => (r.ruleContent == null ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent }));
      if (rules.length) out.push({ type: 'addRules', rules, behavior: 'allow', destination: sandbox ? 'session' : (u.destination || 'session') });
    } else if (u.type === 'setMode') {
      if (['default', 'acceptEdits', 'plan'].includes(u.mode)) out.push({ type: 'setMode', mode: u.mode, destination: 'session' });
    } else if (u.type === 'addDirectories') {
      if (sandbox) continue;
      const dirs = (Array.isArray(u.directories) ? u.directories : []).filter((d) => typeof d === 'string').slice(0, 5);
      if (dirs.length) out.push({ type: 'addDirectories', directories: dirs, destination: 'session' });
    }
  }
  return out.slice(0, 5);
}
// 卡片上「始终允许涵盖：」那张小表 + 按钮文案用的范围（全是 session = 「本会话都允许」，否则「始终允许」）。
function alwaysScope(list) {
  const items = [];
  for (const u of list) {
    if (u.type === 'addRules') for (const r of u.rules) items.push({ kind: 'rule', tool: r.toolName, content: r.ruleContent || '' });
    else if (u.type === 'setMode') items.push({ kind: 'mode', mode: u.mode });
    else if (u.type === 'addDirectories') items.push({ kind: 'dirs', dirs: u.directories });
  }
  return { items, persistent: list.some((u) => u.destination && u.destination !== 'session') };
}

// bridge 自带的进程内 MCP（source 'sdk'）里没有对外副作用、或自己另有确认的那几组：手动模式下不必每次都弹卡。
// 终端 / 远程 PC / 本机桌面 / 主机管理员的 Edge 这类对外动手的照常审批（对照官方 Chrome 工具「Claude wants to … in Chrome」）。
// pr（拉取请求状态 / 绑定 / 同步基线）与 visualize（纯展示；开着时另经 SDK allowedTools 直接放行）也在内——
// 但 pr 里开长期授权的那两样（needsUserApproval：开自动合并、开 Auto-fix）照官方要用户逐次批准，见 tool-approvals.mjs。
const OWN_MCP = new Set(['workspace', 'sessions', 'browser', 'media', 'phone', 'phoneControl', 'snapshot', 'pr', 'visualize']);
// 用户的电脑（mcp/device-tools.mjs）里只看不动的几样：列设备、看屏幕 / 读界面、设备自己那个独立分区的浏览器
// （与服务器上的 browser 同一取舍）。动鼠标键盘、跑命令、读写文件照常审批——设备端另有档位与授权弹窗，两道都在。
const OWN_DEVICE_TOOLS = new Set(['mcp__device__devices', 'mcp__device__inspect', 'mcp__device__browser']);
// bridge 本身的手册 + 操作（mcp/bridge-tools.mjs）：查手册与只读操作（操作表里 access='read'）免卡，会改东西的照常审批。
function bridgeReadOnly(name, input) {
  if (name === 'mcp__bridge__manual') return true;
  if (name !== 'mcp__bridge__call') return false;
  const op = getOp(String((input && input.op) || ''));
  return !!op && op.access === 'read';
}
function ownMcp(name, opts, input) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return false;
  if (opts && opts.mcpServer && opts.mcpServer.source !== 'sdk') return false;
  if (OWN_DEVICE_TOOLS.has(name)) return true;
  if (name.startsWith('mcp__bridge__')) return bridgeReadOnly(name, input);
  const server = (opts && opts.mcpServer && opts.mcpServer.name) || name.split('__')[1] || '';
  return OWN_MCP.has(server);
}
// 计划模式下被 CLI 改判成「要问」的写类请求（decisionReason {type:'mode', mode:'plan'}）
const planModeAsk = (opts) => !!opts && (opts.decisionReasonType === 'mode' || /plan mode/i.test(String(opts.decisionReason || '')));
// CLI 的 decision_reason 可能带 ANSI 转义（SDK 文档：sanitize before rendering）；description 末尾有时拼着同一句原因
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
function reasonAndDesc(opts) {
  const reason = stripAnsi(opts && opts.decisionReason).trim();
  let desc = stripAnsi(opts && opts.description).trim();
  if (reason && desc.endsWith(reason)) desc = desc.slice(0, -reason.length).trim();
  return { reason, desc };
}

// 官方拒绝措辞（Desktop ToolPermissionBroker / CLI 同一句前缀）
export const REJECT_PREFIX = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
const PLAN_NOBODY = 'No one can answer that prompt from plan mode in this session — keep planning in the plan file and raise it with the user in chat; do not retry while plan mode is on.';

/**
 * 每个 runClaudeChat 一个闸门（AskUserQuestion 仍由 claude.mjs 自己拦，之后的工具交给 gate.canUseTool）。
 * opts:
 *   ctx, policy ('interactive' | 'host')
 *   send(ev)          当前这一轮的事件出口（按当前 gen 路由）
 *   sid()             当前会话 id
 *   currentMode()     这个 CLI 眼下的权限模式
 *   guard(name, input) 沙箱复检：返回拒绝文案或 null
 *   onInterrupt()     返回 deny+interrupt 之前调：这一轮按「停下」收，不报错（claude.mjs 置 softStopping）
 *   onActivity()      卡片作答 / 作废时调：算一次活动，claude.mjs 据此刷新挂起看门狗的静默计时
 *   turnOrigin()      眼下这一轮的发起方（family.origin.kind：'ci' = Auto-fix 叫醒、'spawn' / 'peer' / 'inbox' …；真人 = ''）
 *   unattended()      眼下这一轮没有真人在发起（服务端替别的会话 / Auto-fix 开的、额度重置后的自动续跑）：卡片等 30 分钟没人答
 *                     就按超时收掉这一轮——不然 CLI 进程常驻、保持唤醒一直数着它，这个会话也接不了后续的自动唤醒
 *   limitReplay       这一轮的请求身份（清空上下文后执行要在服务端另开会话）；可以是取值函数——
 *                     停放复用 / 预热接管 / 挂起接力时一个进程换了请求方，要取「眼下这一轮」的
 */
const UNATTENDED_WAIT_MS = 30 * 60_000;
export function makePermissionGate({ ctx, policy = 'interactive', send, sid, currentMode, guard, onInterrupt, onActivity, limitReplay, turnOrigin, unattended }) {
  const replay = () => (typeof limitReplay === 'function' ? limitReplay() : limitReplay) || null;
  const pend = new Map();   // qid -> { ev, entry, sid, kind }
  const hostPolicy = policy === 'host' || !!ctx.snap;
  const announce = (s, kind) => { if (s) busPublish(ctx.key, { type: 'question', sessionId: s, pending: pendingFor(s, ctx.key), kind }); };
  const hold = (qid, ev, header, question, kind) => {
    const s = sid();
    const entry = { qid, kind, ownerKey: ctx.key, questions: [{ header, question }], ts: Date.now() };
    pend.set(qid, { ev, entry, sid: s, kind });
    send(ev);
    if (s) sessionQuestions.set(s, entry);
    announce(s, kind);
  };
  const release = (qid) => {
    const p = pend.get(qid);
    pend.delete(qid);
    if (p && p.sid) { sessionQuestions.delete(p.sid, qid); announce(p.sid, p.kind); }
    // 作答算一次活动：等审批时 CLI 一帧不发，批准后到工具跑完之前子 agent 也不发（子 agent 的工具不起心跳、
    // 转录没变时进度摘要也跳过）——不刷新的话，挂起看门狗会把等审批那段静默整段算进去，把刚批准的子 agent 收掉
    if (onActivity) { try { onActivity(); } catch {} }
  };
  // 交互轮不设超时（停止 / 顶掉的 abort 收场）；无人值守的轮 30 分钟
  const wait = (qid, signal) => waitForAnswer(qid, signal, unattended && unattended() ? UNATTENDED_WAIT_MS : 0, ctx.key);
  // 超时 = 没人管的轮：拒掉并停下这一轮（不停的话模型换个工具再要一次，又挂 30 分钟）
  const timedOut = (msg) => { if (onInterrupt) onInterrupt(); return { behavior: 'deny', message: msg, interrupt: true }; };

  async function planGate(input, opts) {
    // 子 agent 的计划（Plan 型子 agent 收尾）是它自己的事，CLI 给它的结果就是「主 agent 已批准」——不打扰人。
    if (opts && opts.agentID) return { behavior: 'allow', updatedInput: input };
    if (hostPolicy) return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] };
    const qid = (opts && opts.toolUseID) || ('plan-' + randomBytes(6).toString('hex'));
    const modes = permissionModesFor(ctx);
    // 官方 HL()：可选的目标模式 = 接受编辑 / 自动 / 绕过权限里这个身份能用的；主按钮 = 自动 > 接受编辑 > 手动；
    // suppressAlwaysAllowRule（这次批准会给出超出它本身的授权）→ 只给「接受」（回手动）。
    const suppress = !!(opts && opts.suppressAlwaysAllowRule);
    const accept = suppress ? [] : ['acceptEdits', 'auto', 'bypassPermissions'].filter((m) => modes.includes(m));
    const trust = accept.includes('auto') ? 'auto' : accept.includes('acceptEdits') ? 'acceptEdits' : 'default';
    const canClear = !!claudeSetting(ctx, 'planClearContext') && !!replay()?.headers;
    const plan = typeof input?.plan === 'string' ? input.plan : '';
    const planFile = typeof input?.planFilePath === 'string' ? input.planFilePath : '';
    hold(qid, {
      type: 'plan_request', qid, sessionId: sid() || null, toolUseId: (opts && opts.toolUseID) || '',
      plan: clip(plan, 100_000), planFile: planFile ? path.basename(planFile) : '',
      accept, trust, canClear, at: Date.now(),
    }, 'Plan approval', 'Claude proposed a plan', 'plan');
    let ans = null, why = '';
    try { ans = await wait(qid, opts && opts.signal); } catch (e) { why = e && e.message === 'timeout' ? 'timeout' : 'abort'; }
    release(qid);
    const decision = ans && !ans.cancelled ? String(ans.decision || '') : '';
    const feedback = ans && typeof ans.feedback === 'string' ? ans.feedback.trim() : '';
    const pickMode = (m) => (m === 'default' || accept.includes(m) ? m : trust);
    // 结论同时记进台账（历史重建靠它与直播同口径，见 notePlan 头注）
    const done = (extra) => {
      notePlan(ctx, opts && opts.toolUseID, { mode: extra.mode, decision: extra.decision, newSessionId: extra.newSessionId });
      send({ type: 'plan_answer', qid, sessionId: sid() || null, at: Date.now(), ...extra });
    };
    if (decision === 'accept') {
      const mode = pickMode(String(ans.mode || ''));
      noteSessionMode(ctx, sid(), mode);
      done({ decision: 'accept', mode });
      return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }], decisionClassification: 'user_temporary' };
    }
    if (decision === 'clear' && canClear) {
      const mode = pickMode(String(ans.mode || ''));
      const r = await startClearedSession(ctx, sid(), { plan, mode, feedback, limitReplay: replay() });
      done({ decision: 'clear', mode, ...(r.ok ? { newSessionId: r.id } : { error: r.reason }) });
      if (onInterrupt) onInterrupt();
      return { behavior: 'deny', message: 'The user approved the plan and started a new session with cleared context to implement it. Stop here.', interrupt: true, decisionClassification: 'user_temporary' };
    }
    if ((decision === 'revise' || decision === 'reject') && feedback) {
      done({ decision: 'revise', feedback: clip(feedback, 4000) });
      return { behavior: 'deny', message: REJECT_PREFIX + feedback, interrupt: false, decisionClassification: 'user_reject' };
    }
    if (decision === 'reject' || decision === 'revise') {
      done({ decision: 'reject' });
      if (onInterrupt) onInterrupt();
      return { behavior: 'deny', message: 'User rejected the plan', interrupt: true, decisionClassification: 'user_reject' };
    }
    done({ decision: 'cancelled', by: why || 'user' });
    if (why === 'timeout') return timedOut('（计划审批没有完成：等了 30 分钟没人处理，这一轮先停下。）');
    return { behavior: 'deny', message: '（计划审批没有完成：已取消或连接中断。）', interrupt: false };
  }

  async function permCard(name, input, opts) {
    const qid = 'perm-' + randomBytes(6).toString('hex');
    // 要逐次批准的那几样（开自动合并 / 开 Auto-fix）不给「始终允许」：一条 allow 规则会让以后的调用绕过审批卡
    const perCall = needsUserApproval(name, input);
    const sugg = opts && !opts.suppressAlwaysAllowRule && !perCall ? filterSuggestions(name, opts.suggestions, { sandbox: !!ctx.sandbox }) : [];
    const scope = alwaysScope(sugg);
    const planMode = planModeAsk(opts);
    const mode = currentMode ? currentMode() : '';
    const canAuto = !planMode && !(opts && opts.defaultToNo) && mode !== 'auto' && permissionModesFor(ctx).includes('auto');
    const mcp = typeof name === 'string' && name.startsWith('mcp__')
      ? { server: (opts && opts.mcpServer && opts.mcpServer.name) || name.split('__')[1] || '', tool: name.split('__').slice(2).join('__'), own: !!(opts && opts.mcpServer && opts.mcpServer.source === 'sdk') }
      : null;
    const title = String((opts && opts.title) || '');
    const { reason, desc } = reasonAndDesc(opts);
    hold(qid, {
      type: 'perm_request', qid, sessionId: sid() || null, toolUseId: (opts && opts.toolUseID) || '',
      tool: String(name || ''), displayName: clip((opts && opts.displayName) || '', 120), title: clip(title, 400),
      description: clip(desc, 600),
      preview: permPreview(name, input), blockedPath: clip((opts && opts.blockedPath) || '', 500),
      reason: clip(reason, 600), reasonType: (opts && opts.decisionReasonType) || '',
      agentId: (opts && opts.agentID) || null, mcp,
      canAlways: sugg.length > 0, always: scope, defaultToNo: !!(opts && opts.defaultToNo),
      planMode, canAuto, at: Date.now(),
    }, String((opts && opts.displayName) || name || 'Permission request'), title || ('Claude wants to use ' + name), 'permission');
    let ans = null, why = '';
    try { ans = await wait(qid, opts && opts.signal); } catch (e) { why = e && e.message === 'timeout' ? 'timeout' : 'abort'; }
    release(qid);
    const decision = ans && !ans.cancelled ? String(ans.decision || '') : '';
    // toolUseId：前端据此把被拒的那条工具行标 Denied（历史重建按 tool_result 措辞标，见 sessions.mjs）
    const done = (d, extra) => send({ type: 'perm_answer', qid, sessionId: sid() || null, toolUseId: (opts && opts.toolUseID) || '', decision: d, at: Date.now(), ...extra });
    // 沙箱身份：批准之后再按最终入参判一次（客户端不能改入参，这里防的是 CLI 侧入参与弹卡时不一致）
    const recheck = () => (ctx.sandbox && guard ? guard(name, input) : null);
    if (decision === 'once' || decision === 'always' || decision === 'auto') {
      const v = recheck();
      if (v) { done('deny', { by: 'policy' }); return { behavior: 'deny', message: v }; }
      if (decision === 'always' && sugg.length) {
        done('always');
        return { behavior: 'allow', updatedInput: input, updatedPermissions: sugg, decisionClassification: 'user_permanent' };
      }
      if (perCall) noteToolApproval(opts && opts.toolUseID, name, ctx.key);   // 工具 handler 据此免掉兜底确认
      if (decision === 'auto' && canAuto) {
        // 卡片上先弹了自动模式首次确认框、用户点了「启用」：与模式芯片那条路一样记下（账号级，只问一次）
        if (ans && ans.ack === true && ctx.dataDir) { const l = ledger(ctx); if (!l.autoConsented) { l.autoConsented = true; saveLedger(ctx); } }
        noteSessionMode(ctx, sid(), 'auto');
        done('auto');
        return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }], decisionClassification: 'user_temporary' };
      }
      done('once');
      return { behavior: 'allow', updatedInput: input, decisionClassification: 'user_temporary' };
    }
    if (decision === 'deny') {
      const feedback = ans && typeof ans.feedback === 'string' ? ans.feedback.trim() : '';
      done('deny', feedback ? { feedback: clip(feedback, 2000) } : {});
      if (feedback) return { behavior: 'deny', message: REJECT_PREFIX + feedback, interrupt: false, decisionClassification: 'user_reject' };
      // 子 agent 的请求：只拒这一次调用，不去打断主线程（它可能早已停笔、在挂起等后台任务）
      if (opts && opts.agentID) return { behavior: 'deny', message: 'User rejected ' + name, interrupt: false, decisionClassification: 'user_reject' };
      // 官方：不带反馈的拒绝 = 拒绝并停下这一轮（interrupt），等人说下一步
      if (onInterrupt) onInterrupt();
      return { behavior: 'deny', message: 'User rejected ' + name, interrupt: true, decisionClassification: 'user_reject' };
    }
    done('cancelled', { by: why || 'user' });
    if (why === 'timeout') return timedOut('（权限审批没有完成：等了 30 分钟没人处理，这一轮先停下。）');
    return { behavior: 'deny', message: '（权限审批没有完成：已取消或连接中断。）', interrupt: false };
  }

  return {
    async canUseTool(name, input, opts) {
      if (name === 'ExitPlanMode') return planGate(input, opts);
      if (guard) { const v = guard(name, input); if (v) return { behavior: 'deny', message: v }; }
      if (hostPolicy) {
        // 无人值守：保持宿主放行；只有计划模式里的写请求没人能批（官方无头措辞）
        if (planModeAsk(opts)) return { behavior: 'deny', message: PLAN_NOBODY };
        // 要用户逐次批准的工具调用没人能批（官方 om() 同句）
        if (needsUserApproval(name, input)) return { behavior: 'deny', message: "This tool requires user approval, which isn't available in this context." };
        return { behavior: 'allow', updatedInput: input };
      }
      if (ownMcp(name, opts, input) && !planModeAsk(opts) && !needsUserApproval(name, input)) return { behavior: 'allow', updatedInput: input };
      // Auto-fix 叫醒的轮：输入里有第三方写的 GitHub 评论 / CI 日志，开长期授权不在这里问（多半没人在看，卡会一直挂着把这一轮卡死），
      // 直接拒——与 pr-tools 自己的 CI 轮拦截同一口径，让用户在 PR 卡上开
      if (needsUserApproval(name, input) && turnOrigin && turnOrigin() === 'ci') {
        return { behavior: 'deny', message: "This can't be turned on from a turn started by a <ci-monitor-event>. Ask the user to turn it on from the PR card." };
      }
      return permCard(name, input, opts);
    },
    // 还在等人批的卡数（后台挂起看门狗据此暂停静默判死：等审批的子 agent 本来就一声不吭）
    pending: () => pend.size,
    // 挂起接力换了 gen：还在等的卡重发进新一轮的缓冲（新设备 attach 才看得到），待回答点重新点亮
    rehome() {
      for (const [qid, p] of pend) {
        p.sid = sid() || p.sid;
        send(p.ev);
        if (p.sid) sessionQuestions.set(p.sid, p.entry);
        announce(p.sid, p.kind);
      }
      return pend.size;
    },
  };
}

// ---- 清空上下文后执行：服务端另开一个新会话把计划送进去 ------------------------------------
// 走与排队消息 / 会话派生同一个重放口（claude-queue replayChat）：同一身份、同一工作目录（worktree 会话就是同一个
// worktree）、模型 / effort 沿用原会话的记忆，权限模式 = 批准时选的。不登记成子会话（它不是派出去干活再汇报的）。
async function startClearedSession(ctx, fromSid, { plan, mode, feedback, limitReplay }) {
  if (!limitReplay || !limitReplay.headers) return { ok: false, reason: 'no identity to replay' };
  const id = randomUUID();
  // 原转录的路径：沙箱身份的转录在自己的 CLAUDE_CONFIG_DIR 里（围栏外），给了也读不了，不给
  const sp = !ctx.sandbox && fromSid ? sessionPaths(fromSid, ctx.cwd, ctx.configDir) : null;
  const message = 'Implement the following plan:\n\n' + plan
    + (sp ? '\n\nIf you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: ' + sp.file : '')
    + (feedback ? '\n\nUser feedback on this plan: ' + feedback : '');
  const p = (fromSid && chatPrefsFor(ctx, fromSid)) || {};
  const b0 = limitReplay.body || {};
  const body = {
    agent: 'claude', client: b0.client === 'apk' ? 'apk' : 'web', message, attachments: [], permissionMode: mode,
    ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}), ...(p.fast ? { fast: true } : {}),
    ...(b0.suggest === true ? { suggest: true } : {}), ...(typeof b0.compactFrac === 'number' ? { compactFrac: b0.compactFrac } : {}),
    autoRetry: true,
  };
  const family = { origin: { kind: 'plan', from: fromSid ? [fromSid] : [] }, newSessionId: id, cwd: ctx.cwd, ...(ctx.worktree && ctx.worktree.branch ? { worktree: { branch: ctx.worktree.branch } } : {}) };
  try {
    const r = await replayChat({ headers: limitReplay.headers, url: limitReplay.url, body, family });
    if (!r || !r.status || r.status >= 400) return { ok: false, reason: '状态 ' + (r && r.status || '未知') };
    return { ok: true, id };
  } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
}

// ---- 接口 ---------------------------------------------------------------------------------
// 会话 / 新会话草稿落在哪个目录（folderKey 与 bypass 确认框要用）
function cwdFor(ctx, { sessionId, projectId }) {
  try {
    if (sessionId) return claudeProjects.locateSessionProject(ctx.claudeProjects, ctx, sessionId)?.path || ctx.cwd;
    if (projectId) return claudeProjects.getProject(ctx.claudeProjects, ctx, projectId)?.path || ctx.cwd;
    return claudeProjects.listProjects(ctx.claudeProjects, ctx)[0]?.path || ctx.cwd;
  } catch { return ctx.cwd; }
}
function viewFor(ctx, { sessionId, projectId }) {
  const cwd = cwdFor(ctx, { sessionId, projectId });
  const fk = folderKeyFor(ctx, cwd);
  const scratch = fk === 'scratch:';
  const l = ctx.dataDir ? ledger(ctx) : { folders: {}, autoConsented: false, bypassAcks: [] };
  let mode, source;
  const ctl = sessionId ? controlFor(ctx.key, sessionId) : null;
  if (ctl && validMode(ctl.current())) { mode = ctl.current(); source = 'live'; }
  else ({ mode, source } = resolveTurnMode({ ...ctx, cwd }, { sessionId }));
  const pending = ctl ? pendingModeFor(ctx, sessionId, mode) : null;
  return {
    mode, source,
    // 绕过权限选了、但这一轮还在跑——这一轮定局后生效（官方 kept pick）
    ...(pending ? { pendingMode: pending } : {}),
    modes: permissionModesFor(ctx),
    folderDefault: l.folders[fk] || null,
    // 快照桶不记绕过权限的确认（官方：scratch 每次都问，确认框也不写「这个工作区以后不会再问」）
    consent: { auto: !!l.autoConsented, bypass: !scratch && l.bypassAcks.includes(fk) },
    // 绕过权限确认框用等宽字显示工作区路径——只有主机 admin 能选 bypass，路径不外泄给别的身份；快照桶不给
    ...(ctx.kind === 'admin' && !scratch ? { folder: cwd } : {}),
  };
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function registerPermissionRoutes(router, { identify }) {
  const ctxOf = (req, res) => {
    const id = identify(req);
    if (!id || id.kind === 'none' || id.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return null; }
    return contextFor(id);
  };
  // GET ?session=<id> | ?project=<id> → { mode, source, modes, folderDefault, consent, folder?, pendingMode? }
  router.on('GET', '/api/claude/permission-mode', (req, res, url) => {
    const ctx = ctxOf(req, res); if (!ctx) return;
    const sessionId = url.searchParams.get('session') || '';
    const projectId = url.searchParams.get('project') || '';
    if (sessionId && !ID_RE.test(sessionId)) return json(res, 400, { error: 'bad session' });
    json(res, 200, viewFor(ctx, { sessionId: sessionId || null, projectId: projectId || null }));
  });
  // POST { mode, sessionId? , projectId?, ack? } —— 会话里选：只改这个会话（活着的 CLI 当场 setPermissionMode）；
  // 新会话草稿里选：记成这个文件夹的默认。ack:true = 这次选择带着首次确认（auto 账号级、bypass 按文件夹记下）。
  router.on('POST', '/api/claude/permission-mode', async (req, res) => {
    const ctx = ctxOf(req, res); if (!ctx) return;
    if (ctx.snap || !ctx.dataDir) return json(res, 403, { error: 'not allowed' });
    let b; try { b = JSON.parse(await readBody(req, 16 * 1024)); } catch { return json(res, 400, { error: 'bad json' }); }
    const mode = String(b && b.mode || '');
    if (!validMode(mode) || mode === 'dontAsk') return json(res, 400, { error: 'bad mode' });
    if (!permissionModesFor(ctx).includes(mode)) return json(res, 403, { error: '这个权限模式在这里不可用', code: 'not_available' });
    const sessionId = b.sessionId ? String(b.sessionId) : null;
    if (sessionId && !ID_RE.test(sessionId)) return json(res, 400, { error: 'bad session' });
    const projectId = b.projectId ? String(b.projectId) : null;
    const l = ledger(ctx);
    if (b.ack === true) {
      const fk = folderKeyFor(ctx, cwdFor(ctx, { sessionId, projectId }));
      if (mode === 'auto') l.autoConsented = true;
      if (mode === 'bypassPermissions' && fk && fk !== 'scratch:' && !l.bypassAcks.includes(fk)) l.bypassAcks.push(fk);
      saveLedger(ctx);
    }
    if (!sessionId) {
      // 新会话草稿：按文件夹记（plan 不记——它是「这一次先出计划」，不是这个文件夹的习惯；快照桶不记绕过权限）
      const fk = folderKeyFor(ctx, cwdFor(ctx, { projectId }));
      if (mode !== 'plan' && !(fk === 'scratch:' && mode === 'bypassPermissions')) { l.folders[fk] = mode; saveLedger(ctx); }
      return json(res, 200, { ok: true, applied: 'draft', ...viewFor(ctx, { projectId }) });
    }
    const ctl = controlFor(ctx.key, sessionId);
    let applied = 'next';
    if (ctl) {
      if (mode === 'bypassPermissions' && ctl.busy()) {
        // 官方：Claude 干活时不开绕过权限，这一轮结束后再开（记进会话记忆，下一轮开跑时按它 setPermissionMode）
        noteSessionMode(ctx, sessionId, mode);
        busPublish(ctx.key, { type: 'perm_mode', sessionId, mode: ctl.current(), pendingMode: mode, trigger: 'user', at: Date.now() });
        return json(res, 200, { ok: true, applied: 'deferred', ...viewFor(ctx, { sessionId }) });
      }
      let failed = null;
      try { await ctl.set(mode); }
      catch (e) {
        const msg = String((e && e.message) || e);
        failed = { error: msg, code: /not launched|dangerously/i.test(msg) ? 'bypass_not_launched' : /auto/i.test(msg) ? 'auto_unavailable' : 'failed' };
      }
      // 停着的 CLI 是主机开「允许绕过权限」之前起的（没带启动旗）：记进会话，下一轮启动参数变了会冷起、带旗按它开
      if (failed && !(failed.code === 'bypass_not_launched' && !ctl.busy())) return json(res, 409, failed);
      if (!failed) { ctl.note(mode); applied = ctl.busy() ? 'live' : 'parked'; }
    }
    noteSessionMode(ctx, sessionId, mode);
    busPublish(ctx.key, { type: 'perm_mode', sessionId, mode, trigger: 'user', at: Date.now() });
    json(res, 200, { ok: true, applied, ...viewFor(ctx, { sessionId }) });
  });
}

// 测试用
export function _resetPermissions() { ledgerCache.clear(); controls.clear(); }

