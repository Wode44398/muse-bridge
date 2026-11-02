// 插件给 Claude 的贡献：工具、系统提示段、现成 MCP server。
//
// 插件经 ctx.claude.tool / prompt / mcp 登记到扩展槽 CLAUDE_SLOT；Claude 每轮开跑（claude.mjs 主聊天、定时任务）时调
// pluginClaudeTurn(turn) 现算这一轮该挂什么：
//   · 同一个插件的工具合成一个进程内 MCP server，键名 = 插件 id（撞了内置保留名就改成 plugin-<id>），
//     模型看到的工具名是 mcp__<键名>__<工具名>；
//   · 参数写法与 agent 接口操作同一套简写，这里转成 SDK 要的 zod schema——插件作者不用碰 zod / MCP SDK；
//   · access:'read' 的工具进 allowedTools（同内嵌图表：纯读不弹审批卡）；其余照会话的权限模式审批；
//   · sig 进常驻 CLI 的签名（工具集在 CLI 起来时就定了）：插件开关 / 重载 / 改了工具后，停放的 CLI 不会被错用。
//
// turn：{ kind: 'chat' | 'routine' | 'plugin', ctx（身份上下文）, snap, getGen?, fromPhone?, source?, message?, sessionId? }
// ctx.chat.run({ tools }) 只在那一轮可用的工具经 pluginClaudeTurn 的第二个参数并进来（无头执行器传）。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { kernel } from './state.mjs';

export const CLAUDE_SLOT = 'claude.tools';

// 内置 MCP 的键名（claude.mjs 与扩展中心连接器在用），插件 id 撞上就加前缀。
const RESERVED = new Set(['snapshot', 'media', 'phone', 'phoneControl', 'browser', 'terminal', 'workspace', 'bridge', 'sessions',
  'pr', 'visualize', 'device', 'edge', 'claude-in-chrome', 'antigravity']);
// 接管内置功能的插件（清单 replaces，四期）：工具服务用被接管那项的键名（mcp__browser__* 照旧），老会话、提示词不用改
const BUILTIN_KEYS = { browser: 'browser', terminal: 'terminal', 'workspace-tools': 'workspace', 'session-tools': 'sessions', pr: 'pr',
  visualize: 'visualize', devices: 'device', 'phone-control': 'phoneControl', 'phone-files': 'phone', 'agent-api': 'bridge', edge: 'claude-in-chrome' };
export const serverKeyOf = (id) => {
  const rep = kernel.started ? kernel.rawRecord(id)?.replaces || [] : [];
  for (const t of rep) if (BUILTIN_KEYS[t] && kernel.isActive(id) && !kernel.isActive(t)) return BUILTIN_KEYS[t];
  return RESERVED.has(id) ? 'plugin-' + id : id;
};

const TOOL_NAME = /^[A-Za-z0-9_-]{1,48}$/;

function zodOf(spec) {
  let t;
  switch (spec.type) {
    case 'string':
      if (Array.isArray(spec.enum) && spec.enum.length && spec.enum.every((e) => typeof e === 'string')) t = z.enum(spec.enum);
      else { t = z.string(); if (spec.max != null) t = t.max(spec.max); }
      break;
    case 'integer': t = z.number().int(); if (spec.min != null) t = t.min(spec.min); if (spec.max != null) t = t.max(spec.max); break;
    case 'number': t = z.number(); if (spec.min != null) t = t.min(spec.min); if (spec.max != null) t = t.max(spec.max); break;
    case 'boolean': t = z.boolean(); break;
    case 'array': t = z.array(z.any()); break;
    case 'object': t = z.record(z.string(), z.any()); break;
    default: t = z.any();
  }
  const desc = [spec.desc || '', spec.default !== undefined ? `（默认 ${JSON.stringify(spec.default)}）` : ''].join('');
  if (desc) t = t.describe(desc);
  return spec.required ? t : t.optional();
}

export function shapeOf(params) {
  const shape = {};
  for (const [k, s] of Object.entries(params || {})) shape[k] = zodOf(s || {});
  return shape;
}

export function withDefaults(params, args) {
  const out = { ...(args || {}) };
  for (const [k, s] of Object.entries(params || {})) if (out[k] === undefined && s && s.default !== undefined) out[k] = s.default;
  return out;
}

// 工具结果卡片（四期，工具 spec 写 render:'card'）：handler 回 { card: { title, subtitle?, fields?, image?, link?, markdown? }, text? }。
// 模型看到 text（没给就是卡片的文字摘要）；卡片 JSON 放在第二段、以 CARD_MARK 开头，前端认出来就画成卡片、不显示这段原文。
import { CARD_MARK } from './tool-card.mjs';
export { CARD_MARK };
function cardSummary(c) {
  const lines = [c.title, c.subtitle, ...(Array.isArray(c.fields) ? c.fields.map((f) => `${f?.label ?? ''}：${f?.value ?? ''}`) : []), c.markdown, c.link?.url || c.link].filter((x) => x != null && String(x).trim());
  return lines.join('\n').slice(0, 4000) || '完成';
}
export function cleanCard(c) {
  if (!c || typeof c !== 'object') return null;
  const str = (v, n) => (v == null ? '' : String(v).slice(0, n));
  const url = (v) => (typeof v === 'string' && /^(https?:\/\/|\/)/i.test(v) ? v.slice(0, 2000) : '');
  return {
    title: str(c.title, 200), subtitle: str(c.subtitle, 300),
    fields: (Array.isArray(c.fields) ? c.fields : []).slice(0, 20).map((f) => ({ label: str(f?.label, 60), value: str(f?.value, 400) })),
    image: url(c.image), markdown: str(c.markdown, 4000),
    link: c.link ? { url: url(typeof c.link === 'string' ? c.link : c.link.url), label: str(typeof c.link === 'string' ? '' : c.link.label, 60) } : null,
    tone: ['ok', 'warn', 'error', 'info'].includes(c.tone) ? c.tone : '',
  };
}

export function toResult(v) {
  if (v && typeof v === 'object' && Array.isArray(v.content)) return v;
  if (v && typeof v === 'object' && v.card && typeof v.card === 'object') {
    const card = cleanCard(v.card);
    const text = typeof v.text === 'string' && v.text ? v.text : cardSummary(card);
    return { content: [{ type: 'text', text }, { type: 'text', text: CARD_MARK + JSON.stringify(card) }] };
  }
  const text = typeof v === 'string' ? v : v === undefined ? '完成' : JSON.stringify(v, null, 2);
  return { content: [{ type: 'text', text }] };
}

// 这一轮给不给：who 'host' = 服务器主机本人非沙箱会话；'members' = 再加登录成员；
// 'all' = 再加插件沙箱（ctx.sandbox 跑的轮，四期起）；快照访客、分享页一律不给。
const isPluginSandbox = (c) => c.kind === 'snap' && String(c.snap?.token || '').startsWith('plugin-');
export function audienceOk(who, turn) {
  const c = turn.ctx || {};
  if (who === 'all' && !turn.snap && isPluginSandbox(c)) return true;
  if (turn.snap || c.kind === 'snap' || c.kind === 'share') return false;
  if (who === 'members' || who === 'all') return c.kind === 'admin' || c.kind === 'user';
  return c.kind === 'admin' && !c.sandbox;
}

export function checkTool(spec) {
  if (!spec || !TOOL_NAME.test(spec.name || '')) throw new Error('工具名只能用字母、数字、下划线、连字符（≤48 字）：' + (spec && spec.name));
  if (typeof spec.handler !== 'function') throw new Error('工具 ' + spec.name + ' 缺 handler(args, turn)');
}
const check = checkTool;

// runTools：ctx.chat.run({ tools }) 带来的「只在这一轮可用」的工具 { owner, tools }——不看 who / when（插件自己发起的这一轮，
// 沙箱身份也给），与该插件的常驻工具合进同一个 server（模型看到的都是 mcp__<插件 id>__<名字>），同名时这一轮的优先。
export function pluginClaudeTurn(turn, runTools = null) {
  const empty = { mcpServers: {}, prompt: '', allowedTools: [], sig: [] };
  const extra = runTools && Array.isArray(runTools.tools) && runTools.tools.length ? runTools : null;
  if (!kernel.started && !extra) return empty;
  const entries = kernel.started ? kernel.slot(CLAUDE_SLOT).entries() : [];
  if (!entries.length && !extra) return empty;
  const byOwner = new Map();   // 插件 id → { tools: [], mcp: {} }
  const prompts = [];
  const allowed = [];
  if (extra) byOwner.set(extra.owner, { tools: extra.tools.slice(), mcp: {} });
  const hookEvents = new Map();   // 事件 → [[插件, rev, matcher]]（只为签名：分发钩子调用时现查）
  for (const { item, owner } of entries) {
    try {
      if (item.kind === 'hook') {
        if (!audienceOk(item.who, turn)) continue;
        if (!hookEvents.has(item.event)) hookEvents.set(item.event, []);
        hookEvents.get(item.event).push([owner, kernel.rawRecord(owner)?.rev || 0, String(item.matcher || '')]);
        continue;
      }
      if (item.kind === 'tool') {
        const spec = item.spec;
        if (Array.isArray(spec.agents) && !spec.agents.includes('claude')) continue;   // 只给 dimensio 的工具
        check(spec);
        if (!audienceOk(spec.who || 'host', turn)) continue;
        if (typeof spec.when === 'function' && !spec.when(turn)) continue;
        if (!byOwner.has(owner)) byOwner.set(owner, { tools: [], mcp: {} });
        const own = byOwner.get(owner).tools;
        if (!own.some((t) => t.name === spec.name)) own.push(spec);
      } else if (item.kind === 'prompt') {
        if (Array.isArray(item.agents) && !item.agents.includes('claude')) continue;
        if (!audienceOk(item.who, turn)) continue;
        const t = typeof item.text === 'function' ? item.text(turn) : item.text;
        if (t && String(t).trim()) prompts.push(String(t).trim());
      } else if (item.kind === 'mcp') {
        if (!audienceOk(item.who, turn)) continue;
        const cfg = item.make(turn);
        if (cfg) {
          if (!byOwner.has(owner)) byOwner.set(owner, { tools: [], mcp: {} });
          byOwner.get(owner).mcp[item.name] = cfg;
        }
      }
    } catch (e) {
      console.error('[plugins] ' + owner + ' 给 Claude 的贡献出错（本轮跳过）：', e?.message || e);
    }
  }
  const mcpServers = {};
  const sig = [];
  for (const [owner, { tools, mcp }] of byOwner) {
    const key = serverKeyOf(owner);
    if (tools.length) {
      mcpServers[key] = createSdkMcpServer({
        name: key,
        version: '1.0.0',
        tools: tools.map((spec) => tool(spec.name, spec.description || spec.name, shapeOf(spec.params), async (args) => {
          try { return toResult(await spec.handler(withDefaults(spec.params, args), turn)); }
          catch (e) { return { content: [{ type: 'text', text: '出错：' + String(e?.message || e) }], isError: true }; }
        })),
      });
      for (const spec of tools) if (spec.access === 'read') allowed.push(`mcp__${key}__${spec.name}`);
    }
    for (const [name, cfg] of Object.entries(mcp)) mcpServers[name] = cfg;
    const rev = kernel.rawRecord(owner)?.rev || 0;
    sig.push([owner, rev, tools.map((t) => t.name + ':' + (t.access || 'write')).sort(), Object.keys(mcp).sort()]);
  }
  const hooks = {};
  for (const [event, list] of hookEvents) {
    hooks[event] = [{ hooks: [makeHookDispatcher(event, turn)] }];
    sig.push(['hook', event, list.map((x) => x.join(':')).sort()]);
  }
  return {
    mcpServers,
    prompt: prompts.length ? '\n\n' + prompts.join('\n\n') : '',
    allowedTools: allowed,
    hooks,
    sig,
  };
}

// ── 钩子、审批策略、消息改写、每轮参数（插件接口四期）─────────────────────────
// 都登记在 CLAUDE_SLOT 里（kind: hook / permission / input / options），停用时随插件撤掉。插件回调一律隔离：
// 抛错或超时 = 当它没表态（记插件日志），绝不打断这一轮。

export const HOOK_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'SessionStart',
  'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Notification']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
const CONTEXT_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'SessionStart', 'Stop', 'SubagentStart']);
const BLOCK_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'SubagentStop', 'PostToolUse']);
const WHO = new Set(['host', 'members', 'all']);

function warnOwner(owner, msg) {
  const c = kernel.contextOf(owner);
  if (c) c.warn(msg); else console.error('[plugins] ' + owner + ' ' + msg);
}

// 带时限地跑插件回调：超时 / 抛错回 undefined（= 没表态）。signal 中止时也立刻回 undefined。
async function guarded(owner, what, fn, ms, signal) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => {
        timer = setTimeout(() => { warnOwner(owner, `${what} 超过 ${Math.round(ms / 1000)} 秒没回，当它没表态`); resolve(undefined); }, ms);
        timer.unref?.();
        signal?.addEventListener?.('abort', () => resolve(undefined), { once: true });
      }),
    ]);
  } catch (e) {
    warnOwner(owner, `${what} 出错（当它没表态）：${String(e?.message || e).slice(0, 300)}`);
    return undefined;
  } finally { clearTimeout(timer); }
}

const msOf = (v, dflt, max) => (Number.isFinite(v) && v > 0 ? Math.min(v, max) : dflt);

/** 插件看到的这一轮：在 turn 上加 agent / owner / cwd（ctx 原样保留，和工具 handler 拿到的一致）。 */
export function publicTurn(turn) {
  const c = turn.ctx || {};
  const tok = String(c.snap?.token || '');
  const owner = tok.startsWith('plugin-') ? { kind: 'sandbox', token: tok }
    : c.kind === 'admin' ? { kind: 'admin', login: 'host' }
    : { kind: c.kind || 'user', login: c.name || String(c.user || ''), id: String(c.user || '') };
  return { ...turn, agent: 'claude', owner, cwd: c.cwd || '' };
}

function entriesOf(kind, turn, extra) {
  if (!kernel.started) return [];
  return kernel.slot(CLAUDE_SLOT).entries().filter(({ item }) => item.kind === kind && audienceOk(item.who, turn) && (!extra || extra(item)));
}

// matcher：工具名，'A|B' 任一，结尾 * 前缀匹配（mcp__github__*），或正则
function matcherOk(m, toolName) {
  if (!m) return true;
  if (m instanceof RegExp) return m.test(toolName || '');
  return String(m).split('|').some((x) => x === toolName || (x.endsWith('*') && String(toolName || '').startsWith(x.slice(0, -1))));
}

// 一个事件一个 SDK 钩子：调用时现查登记表，依次问各插件，结果合成一份 SDK 输出。
function makeHookDispatcher(event, turn) {
  return async (input, toolUseID, opts) => {
    const list = entriesOf('hook', turn, (it) => it.event === event && (!TOOL_EVENTS.has(event) || matcherOk(it.matcher, input?.tool_name)));
    if (!list.length) return {};
    const pt = publicTurn({ ...turn, sessionId: input?.session_id || turn.sessionId });
    let toolInput = input?.tool_input;
    const contexts = [];
    let deny = null, ask = null, allow = null, block = null;
    for (const { item, owner } of list) {
      const view = { ...input, ...(TOOL_EVENTS.has(event) ? { tool_input: toolInput } : {}), toolUseId: toolUseID || '' };
      const r = await guarded(owner, `钩子 ${event}`, () => item.fn(view, pt), msOf(item.timeout, 30_000, 10 * 60_000), opts?.signal);
      if (!r || typeof r !== 'object') continue;
      if (typeof r.context === 'string' && r.context.trim() && CONTEXT_EVENTS.has(event)) contexts.push(r.context.trim().slice(0, 8000));
      if (event === 'PreToolUse') {
        if (r.decision === 'deny' && deny == null) deny = String(r.reason || `插件「${owner}」拦下了这次调用`).slice(0, 2000);
        else if (r.decision === 'ask' && ask == null) ask = String(r.reason || '').slice(0, 2000);
        else if (r.decision === 'allow' && allow == null) allow = String(r.reason || '').slice(0, 2000);
        if (r.input && typeof r.input === 'object' && !Array.isArray(r.input)) toolInput = r.input;
      }
      if (r.block === true && BLOCK_EVENTS.has(event) && block == null) block = String(r.reason || `插件「${owner}」拦下了`).slice(0, 2000);
    }
    const out = {};
    if (block != null) { out.decision = 'block'; out.reason = block; }
    const hso = { hookEventName: event };
    if (event === 'PreToolUse') {
      if (deny != null) Object.assign(hso, { permissionDecision: 'deny', permissionDecisionReason: deny });
      else if (ask != null) Object.assign(hso, { permissionDecision: 'ask', ...(ask ? { permissionDecisionReason: ask } : {}) });
      else if (allow != null) Object.assign(hso, { permissionDecision: 'allow', ...(allow ? { permissionDecisionReason: allow } : {}) });
      if (deny == null && toolInput !== input?.tool_input) hso.updatedInput = toolInput;
    }
    if (contexts.length) hso.additionalContext = contexts.join('\n\n');
    if (Object.keys(hso).length > 1) out.hookSpecificOutput = hso;
    return out;
  };
}

/** 把插件钩子并进 SDK 的 hooks（bridge 自己的排前面：沙箱围栏先说了算）。 */
export function mergeHooks(base, extra) {
  if (!extra || !Object.keys(extra).length) return base;
  const out = { ...(base || {}) };
  for (const [ev, list] of Object.entries(extra)) out[ev] = [...(out[ev] || []), ...list];
  return out;
}

/**
 * 审批策略（ctx.claude.permission）：permissions.mjs 在沙箱复检之后、无人值守放行与审批卡之前问。
 * 依次问各插件，第一个表态的说了算。回 null = 都没表态（照常走审批卡）；否则 SDK 的 { behavior, … }（多一个 by = 哪个插件）。
 */
export async function pluginPermission(turn, { tool, input, mode, agentID, signal }) {
  const list = entriesOf('permission', turn);
  if (!list.length) return null;
  const pt = publicTurn(turn);
  for (const { item, owner } of list) {
    const r = await guarded(owner, '审批策略', () => item.fn({ tool, input, mode: mode || '', agentID: agentID || '', sessionId: turn.sessionId || null }, pt),
      msOf(item.timeout, 10 * 60_000, 30 * 60_000), signal);
    if (r === 'allow' || r?.allow === true || r?.behavior === 'allow') {
      const ui = r && typeof r === 'object' && r.input && typeof r.input === 'object' ? r.input : input;
      return { behavior: 'allow', updatedInput: ui, by: owner };
    }
    if (r === 'deny' || r?.deny === true || r?.behavior === 'deny') {
      const msg = (r && typeof r === 'object' && (r.message || r.reason)) || `插件「${owner}」的审批策略拒绝了这次调用`;
      return { behavior: 'deny', message: String(msg).slice(0, 2000), by: owner };
    }
  }
  return null;
}

/**
 * 消息改写（ctx.claude.input）：发给 Claude 之前依次过各插件。回 { message, attachments, changed }（界面上显示的仍是用户原话）。
 * 插件回 { message?, prepend?, append?, attachments?: [绝对路径]（追加） }。
 */
export async function pluginInput(turn, { message, attachments }) {
  const list = entriesOf('input', turn);
  let msg = typeof message === 'string' ? message : '';
  const atts = Array.isArray(attachments) ? attachments.slice() : [];
  if (!list.length) return { message: msg, attachments: atts, changed: false };
  const pt = publicTurn(turn);
  let changed = false;
  for (const { item, owner } of list) {
    const r = await guarded(owner, '消息改写', () => item.fn({ message: msg, attachments: atts.slice() }, pt), msOf(item.timeout, 20_000, 120_000));
    if (!r || typeof r !== 'object') continue;
    if (typeof r.message === 'string') { msg = r.message; changed = true; }
    if (typeof r.prepend === 'string' && r.prepend) { msg = r.prepend + '\n\n' + msg; changed = true; }
    if (typeof r.append === 'string' && r.append) { msg = msg + '\n\n' + r.append; changed = true; }
    if (Array.isArray(r.attachments)) for (const a of r.attachments) if (typeof a === 'string' && a && !atts.includes(a)) { atts.push(a); changed = true; }
  }
  return { message: msg, attachments: atts, changed };
}

// 每轮参数里插件不许碰的环境变量：鉴权、代理地址、bridge 自己的通道
const ENV_DENY = /(TOKEN|SECRET|API_KEY|AUTH|PASSWORD|^ANTHROPIC_|^CLAUDE_CODE_OAUTH|^CLAUDE_CONFIG_DIR$|^BRIDGE_|PROXY)/i;

/**
 * 每轮参数（ctx.claude.options）：依次合并各插件给的 { model, effort, env, settings, agents, additionalDirectories, append }。
 * 后登记的覆盖先登记的（model / effort）；env / settings / agents 浅合并；目录与 append 累加。模型、档位合不合法由调用方校验。
 */
export async function pluginOptions(turn) {
  const list = entriesOf('options', turn);
  if (!list.length) return null;
  const pt = publicTurn(turn);
  const out = { env: {}, settings: {}, agents: {}, additionalDirectories: [], append: [], by: [] };
  for (const { item, owner } of list) {
    const r = await guarded(owner, '每轮参数', () => item.fn(pt), msOf(item.timeout, 10_000, 60_000));
    if (!r || typeof r !== 'object') continue;
    out.by.push(owner);
    if (typeof r.model === 'string' && r.model) out.model = r.model;
    if (typeof r.effort === 'string' && r.effort) out.effort = r.effort;
    if (r.env && typeof r.env === 'object') {
      for (const [k, v] of Object.entries(r.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(k) || ENV_DENY.test(k)) { warnOwner(owner, `每轮参数：环境变量 ${k} 不许插件改，跳过`); continue; }
        out.env[k] = String(v ?? '').slice(0, 4000);
      }
    }
    if (r.settings && typeof r.settings === 'object' && !Array.isArray(r.settings)) Object.assign(out.settings, r.settings);
    if (r.agents && typeof r.agents === 'object') {
      for (const [name, a] of Object.entries(r.agents)) {
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(name) || !a || typeof a.prompt !== 'string' || typeof a.description !== 'string') { warnOwner(owner, `每轮参数：子 agent「${name}」要有 description 与 prompt，名字小写字母开头`); continue; }
        out.agents[name] = {
          description: a.description.slice(0, 1000), prompt: a.prompt.slice(0, 40_000),
          ...(Array.isArray(a.tools) ? { tools: a.tools.filter((t) => typeof t === 'string') } : {}),
          ...(typeof a.model === 'string' ? { model: a.model } : {}),
        };
      }
    }
    if (Array.isArray(r.additionalDirectories)) for (const d of r.additionalDirectories) if (typeof d === 'string' && d) out.additionalDirectories.push(d);
    if (typeof r.append === 'string' && r.append.trim()) out.append.push(r.append.trim().slice(0, 20_000));
  }
  return out.by.length ? out : null;
}

/** 登记校验（host.mjs 调）。 */
export function checkHook(event, fn, opts) {
  if (!HOOK_EVENTS.includes(event)) throw new Error(`钩子事件「${event}」不认识（可用：${HOOK_EVENTS.join(' / ')}）`);
  if (typeof fn !== 'function') throw new Error('ctx.claude.hook 要一个函数 (input, turn) => …');
  checkWho(opts?.who);
}
export function checkWho(who) { if (who && !WHO.has(who)) throw new Error("who 只能是 'host' / 'members' / 'all'"); }
