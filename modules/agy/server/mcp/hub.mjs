// Antigravity 的 bridge 原生工具中枢（服务端一侧）。
//
// agy 的 stdio MCP 子进程会跨会话复用，拿不到「这一轮是谁」，所以浏览器 / 终端 / 工作区 / bridge 操作 / 设备 / 图表
// 这些依赖会话上下文的工具不在子进程里实现：子进程只做薄代理，工具清单与执行都回调到这里。
// 这里直接复用 Claude 分页的同一套进程内 MCP（src/mcp/*-tools.mjs），按归属轮（agy 的 gen）现场实例化、经内存传输调用——
// 行为、参数表、与右侧工作台面板共用的池键，都和 Claude 那边一模一样，不另写一份。
//
// 对外的工具名（agy 再加 mcp_bridge_ 前缀）：
//   bridge 组 → manual / call；单工具组（browser、terminal、workspace）→ 组名本身；bare 组（会话协作、手机操控、拉取请求、
//   插件工具、远程连接器）→ 工具自己的名字（已带组前缀）；其余 → <组>_<工具>（device_inspect、project_memory_read…）。
//
// 组的写法（新组放 groups/ 下一组一个文件，这里只登记）：
//   key / setting（settings.bridgeTools.<setting>）/ available(ctx) / build({ ctx, getGen, cwd }) → 进程内 MCP（.instance）；
//   可选 bare（对外名 = 工具名）、owns(对外名)（判「调不了的原因」时认领）、sig(ctx)（清单会随它变：进 agy 的工具指纹）、
//   budgetMs（整次调用夹到这么久，到点回「还没好」）、capTokens（这一组精简后最多占多少清单预算，超出的不列）、
//   list(ctx) / call(ctx, gen, 名字, 参数, { cwd, signal })（不经进程内 MCP 的组，如远程连接器）。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pluginOn } from '@bridge/core/plugins/state.mjs';
import { scopeOf, poolRef } from '@bridge/core/runtime/principal.mjs';
import { devicesEnabled, ownDevices } from '@bridge/core/runtime/devices.mjs';
import { agentDeviceLink, setAgentDeviceLink } from '@bridge/core/runtime/agent-device-links.mjs';
import { makeBridgeMcp } from '@bridge/core/mcp/bridge-tools.mjs';
import { makeBrowserMcp } from '@bridge/core/mcp/browser-tools.mjs';
import { makeTerminalMcp } from '@bridge/core/mcp/terminal-tools.mjs';
import { makeWorkspaceMcp } from '@bridge/core/mcp/workspace-tools.mjs';
import { makeDeviceMcp } from '@bridge/core/mcp/device-tools.mjs';
import { makeVisualizeMcp } from '@bridge/core/mcp/visualize.mjs';
import { getSessionMeta } from '../sessions.mjs';
import { agyWording, rewordResult } from './wording.mjs';
import { SESSIONS_GROUP } from './groups/sessions.mjs';
import { PHONE_GROUP } from './groups/phone.mjs';
import { PR_GROUP } from './groups/pr.mjs';
import { PROJECT_GROUP } from './groups/project.mjs';
import { PLUGINS_GROUP } from './groups/plugins.mjs';
import { REMOTE_GROUP } from './groups/remote.mjs';

// 照 Claude 写的工具名与说法统一改口（wording.mjs）
export { agyWording } from './wording.mjs';

// Antigravity 对每次 MCP 工具调用有 3 分钟硬上限（11-19 探针实测：180 秒整报「timed out after 3m0s」，发进度通知也不续期）。
// 会等很久的那几样在这里夹到 150 秒以内：等到点正常返回「还没等到」，模型再调一次就行；不夹的话 agy 那头直接判失败。
export const AGY_CALL_BUDGET_SEC = 150;
const BUDGET_NOTE = {
  terminal: `
[Antigravity] One tool call may run for at most about 3 minutes here: waitSec is capped at ${AGY_CALL_BUDGET_SEC}. If a wait / run returns before the program is done, call wait again.`,
  device_shell: `
[Antigravity] 单次调用最长约 3 分钟：timeoutMs 上限按 ${AGY_CALL_BUDGET_SEC * 1000} 算；更久的命令放后台跑（Start-Process / nohup），再分次查结果。`,
};
export function fitAgyBudget(groupKey, toolName, args) {
  const a = args && typeof args === 'object' ? { ...args } : {};
  const cap = (k, max) => { const n = Number(a[k]); if (Number.isFinite(n) && n > max) a[k] = max; };
  if (groupKey === 'terminal') {
    cap('waitSec', AGY_CALL_BUDGET_SEC);
    cap('quietSec', AGY_CALL_BUDGET_SEC);
  } else if (groupKey === 'device' && toolName === 'shell') {
    cap('timeoutMs', AGY_CALL_BUDGET_SEC * 1000);
  }
  return a;
}

// 设置项（settings.bridgeTools.<key>）→ 组。available：这台服务器 / 这个身份此刻能不能给（插件开关、shell 能力、设备）。
export const HUB_GROUPS = Object.freeze([
  {
    key: 'bridge',
    setting: 'bridgeOps',
    available: (ctx) => pluginOn('agent-api') && (ctx?.kind === 'admin' || ctx?.kind === 'user'),
    build: ({ ctx, getGen }) => makeBridgeMcp({ ctx, getGen, instance: 'agy' }),
  },
  {
    key: 'browser',
    setting: 'browser',
    available: (ctx) => pluginOn('browser') && !!ctx?.shell,
    build: ({ ctx, getGen, cwd }) => makeBrowserMcp({
      getGen,
      ws: cwd,
      owner: scopeOf(ctx),
      getSession: () => getGen()?.sessionId || '',
      roots: ctx.sandbox ? [cwd, ctx.media, ctx.homeRoot].filter(Boolean) : null,
    }),
  },
  {
    key: 'terminal',
    setting: 'terminal',
    available: (ctx) => pluginOn('terminal') && !!ctx?.shell,
    build: ({ ctx, getGen, cwd }) => makeTerminalMcp({ getGen, ws: poolRef(ctx, cwd) }),
  },
  {
    key: 'workspace',
    setting: 'workspace',
    available: () => pluginOn('workspace-tools'),
    build: ({ ctx, getGen, cwd }) => makeWorkspaceMcp({ getGen, ws: cwd, ctxKey: ctx.key }),
  },
  {
    key: 'device',
    setting: 'device',
    available: (ctx) => devicesEnabled() && (ctx?.kind === 'admin' || ctx?.kind === 'user') && ownDevices(ctx).length > 0,
    build: ({ ctx, getGen, cwd }) => {
      const sid = () => getGen()?.sessionId || '';
      // 连接记在非 Claude 分页那张表里（agent-device-links.mjs）；还没落盘时用这一轮带来的选择（gen.deviceLink）
      return makeDeviceMcp({
        ctx: { ...ctx, cwd: cwd || ctx.cwd },
        by: 'agy',
        getLink: () => { const s = sid(); return (s && agentDeviceLink(ctx, 'agy', s)) || getGen()?.deviceLink || ''; },
        setLink: (v) => { const s = sid(); if (s) setAgentDeviceLink(ctx, 'agy', s, v); },
        getSession: sid,
        // 设备上「谁在操作」的提示、用户浏览器里的标签组名：用户改过的名字 → agy 生成的标题 → 这一轮的首句
        getTitle: () => { const s = sid(); const meta = s ? getSessionMeta(ctx.agyDir, s) : null; return String(meta?.customTitle || meta?.title || getGen()?.userText || '').slice(0, 60); },
        getOrigin: () => getGen()?.turnOrigin || null,
      });
    },
  },
  {
    key: 'visualize',
    setting: 'visualize',
    // 只看图表插件与 agy 自己的开关（settings.bridgeTools.visualize）；Claude 设置里的「对话内交互图表」管的是 Claude 分页
    available: () => pluginOn('visualize'),
    // 画图指南按这一轮的发起端给（手机 / 窄屏拿手机版：宽度不同，且手机 App 里不跑脚本）
    build: ({ getGen }) => makeVisualizeMcp({ platform: getGen?.()?.vizPlatform === 'mobile' ? 'mobile' : 'desktop' }),
  },
  SESSIONS_GROUP,
  PHONE_GROUP,
  PR_GROUP,
  PROJECT_GROUP,
  { ...PLUGINS_GROUP, capTokens: 2500 },
  { ...REMOTE_GROUP, capTokens: 3000 },
]);

const GROUP_BY_KEY = new Map(HUB_GROUPS.map((g) => [g.key, g]));

// 对外名 ↔（组, 原工具名）
export function exposedToolName(groupKey, toolName) {
  if (groupKey === 'bridge' || GROUP_BY_KEY.get(groupKey)?.bare) return toolName;
  if (toolName === groupKey) return groupKey;
  return `${groupKey}_${toolName}`;
}

export function hubGroupEnabled(group, ctx, settings = {}) {
  const bt = settings?.bridgeTools && typeof settings.bridgeTools === 'object' ? settings.bridgeTools : {};
  if (bt.enabled === false) return false;
  if (bt[group.setting] === false) return false;
  try { return !!group.available(ctx); } catch { return false; }
}

export function enabledHubGroups(ctx, settings = {}) {
  return HUB_GROUPS.filter((g) => hubGroupEnabled(g, ctx, settings));
}

async function withClient(sdkServer, fn) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await sdkServer.instance.connect(serverT);
  const client = new Client({ name: 'agy-hub', version: '1.0.0' });
  try {
    await client.connect(clientT);
    return await fn(client);
  } finally {
    try { await client.close(); } catch {}
    try { await sdkServer.instance.close(); } catch {}
  }
}

// 清单缓存：参数表是静态的；bridge 组的 call 描述里列了操作目录（插件开关会改），所以只缓存一分钟。
const LIST_TTL_MS = 60_000;
const listCache = new Map();   // `${ctx.key}|${group}` -> { at, tools }

// 组的指纹：清单内容会随它变（插件、远程连接器），缓存键带上它，变了就不用旧清单
export function groupSig(group, ctx) {
  try { return typeof group.sig === 'function' ? String(group.sig(ctx) || '') : ''; } catch { return ''; }
}

async function listGroupTools(group, ctx, cwd) {
  const ck = `${ctx.key}|${group.key}|${groupSig(group, ctx)}`;
  const hit = listCache.get(ck);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.tools;
  const tools = typeof group.list === 'function'
    ? await group.list(ctx)
    : await withClient(group.build({ ctx, getGen: () => null, cwd }), async (c) => (await c.listTools()).tools || []);
  for (const k of listCache.keys()) if (k.startsWith(`${ctx.key}|${group.key}|`)) listCache.delete(k);
  listCache.set(ck, { at: Date.now(), tools });
  return tools;
}

// ── 工具清单的体量预算 ─────────────────────────────────────────────────────────
// agy（ACP 模式）给一个会话里全部 MCP 工具的定义（说明 + 参数表）设了一个总 token 预算，超了就从体量最大的工具开始
// 整个丢掉，不报错，模型根本不知道有这个工具（-p 模式没有这个限制）。11-20 对照实测：20 个各 5000 字符的工具，纯英文留
// 11 个、中文只留 3 个，折算总预算约 1.4 万～1.5 万 token；bridge 原来的工具全量约 2.3 万，侧边浏览器（约 5600）和设备
// 浏览器（约 4400）最大，所以 agy 从来没拿到过这两个。名字、anyOf 都和这个无关（同样实测排除过）。
// 预算还和用户自己装的 MCP（如 context7）共用，所以这里按需展开：体量大的工具只给一句话说明 + 精简参数表，
// 完整说明经 tool_docs(name) 现取；系统提示里各组的用法提示照旧给。
export const AGY_DOCS_TOOL = 'tool_docs';
const COMPACT_OVER = 450;   // 估算 token 超过这个数的工具才精简
export function agyTokenEstimate(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  const wide = (s.match(/[^\x00-\x7f]/g) || []).length;
  return Math.round((s.length - wide) * 0.25 + wide * 0.9);
}
const firstPara = (text, max = 260) => {
  const p = String(text || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return p.length > max ? p.slice(0, max).replace(/[，,；;。.\s]*$/, '') + '…' : p;
};
// batch 单步的字段骨架：只留字段名与类型（不带说明、不带枚举，单步 action 的枚举另留）。
// agy 把对象的 properties 当成封闭表：没列的字段一律「additional properties not allowed」，在 agy 那头就拒了，
// 根本到不了 bridge（11-22 反馈：batch 里写 text / ref / x 全被拦，多步只能一轮一步）。所以字段名一个都不能省。
function fieldSkeleton(v) {
  if (!v || typeof v !== 'object') return {};
  if (Array.isArray(v.anyOf)) return { anyOf: v.anyOf.map(fieldSkeleton) };
  const out = {};
  if (v.type) out.type = v.type;
  if (v.type === 'array') out.items = fieldSkeleton(v.items);
  if (v.type === 'object' && v.properties) out.properties = Object.fromEntries(Object.entries(v.properties).map(([k, x]) => [k, fieldSkeleton(x)]));
  return out;
}
// 参数表精简：只留结构（类型、枚举、必填），参数说明只留 30 字以内的；batch 单步只留字段骨架（见上）
function compactSchema(schema) {
  const walk = (o, depth) => {
    if (Array.isArray(o)) return o.map((x) => walk(x, depth));
    if (!o || typeof o !== 'object') return o;
    const r = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'description') { if (depth > 0 && typeof v === 'string' && v.length <= 30) r[k] = v; continue; }
      r[k] = k === 'properties' ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, walk(pv, depth + 1)])) : walk(v, depth);
    }
    return r;
  };
  const out = walk(schema, 0);
  // 单步能用哪些动作要留着：设备的批内动作和单步不是同一张表（批里能截图、不能 launch），不留模型只能撞校验
  const steps = schema?.properties?.actions;
  if (steps?.items?.properties) {
    const props = steps.items.properties;
    const stepActions = props.action?.enum;
    const fields = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, fieldSkeleton(v)]));
    if (Array.isArray(stepActions)) fields.action = { type: 'string', enum: stepActions };
    out.properties.actions = {
      type: 'array',
      description: '多步：每步一个对象，字段同单步调用',
      items: { type: 'object', properties: fields, ...(steps.items.required ? { required: steps.items.required } : {}) },
      ...(steps.maxItems ? { maxItems: steps.maxItems } : {}),
    };
  }
  return out;
}
export function compactAgyTool(tool) {
  const cost = agyTokenEstimate(tool.description) + agyTokenEstimate(tool.inputSchema);
  if (cost <= COMPACT_OVER) return tool;
  return {
    ...tool,
    description: `${firstPara(tool.description)}\n（精简版说明：动作、参数含义与注意事项先调 ${AGY_DOCS_TOOL}(name:"${tool.name}") 看完整说明。）`,
    inputSchema: compactSchema(tool.inputSchema),
  };
}
const DOCS_TOOL_DEF = {
  name: AGY_DOCS_TOOL,
  description: '查看某个 bridge 工具的完整说明（动作列表、每个参数的含义、注意事项）。标着「精简版说明」的工具，第一次用或参数拿不准时先调这个。',
  inputSchema: { type: 'object', properties: { name: { type: 'string', description: '工具名，如 browser、device_act、terminal' } }, required: ['name'] },
};

async function fullHubTools(ctx, settings, cwd) {
  const out = [];
  for (const group of enabledHubGroups(ctx, settings)) {
    try {
      const tools = await listGroupTools(group, ctx, cwd || ctx.cwd || '');
      for (const t of tools) {
        const exposed = exposedToolName(group.key, t.name);
        out.push({
          name: exposed,
          description: agyWording(t.description || '') + (BUDGET_NOTE[exposed] || ''),
          inputSchema: t.inputSchema || { type: 'object', properties: {} },
          ...(t.annotations ? { annotations: t.annotations } : {}),
          _group: group.key,
        });
      }
    } catch (e) {
      console.error(`[agy-hub] 列出 ${group.key} 组工具失败：`, e?.message || e);
    }
  }
  return out;
}

// 完整说明的文字版：工具说明原文 + 每个参数一行（类型 / 可选值 / 说明）；batch 单步的字段同顶层，不重复列。
function schemaLines(schema, indent = '') {
  const lines = [];
  const req = new Set(schema?.required || []);
  for (const [k, v] of Object.entries(schema?.properties || {})) {
    const t = v?.enum ? v.enum.map((x) => JSON.stringify(x)).join(' | ')
      : v?.anyOf ? v.anyOf.map((x) => x.type || 'any').join(' | ')
      : (v?.type === 'array' ? `${v.items?.type || 'any'}[]` : (v?.type || 'any'));
    lines.push(`${indent}- ${k}${req.has(k) ? '（必填）' : ''}：${t}${v?.description ? ' —— ' + agyWording(v.description) : ''}`);
    if (k !== 'actions' && v?.type === 'object' && v.properties) lines.push(...schemaLines(v, indent + '  '));
    const stepActions = k === 'actions' ? v?.items?.properties?.action?.enum : null;
    if (Array.isArray(stepActions)) lines.push(`${indent}  每步的 action 可取：${stepActions.join(' | ')}（其余字段同单步调用）`);
  }
  return lines;
}
async function toolDocsResult(ctx, settings, cwd, name) {
  const want = String(name || '').trim().replace(/^mcp_bridge_/, '');
  if (cappedNames.has(want)) return { isError: true, content: [{ type: 'text', text: `${want} 没列进工具清单（插件 / 连接器的工具超出了 Antigravity 的工具清单预算），这一轮调不了。` }] };
  const all = await fullHubTools(ctx, settings, cwd);
  const t = all.find((x) => x.name === want);
  if (!t) {
    return { isError: true, content: [{ type: 'text', text: `没有叫 ${want || '(空)'} 的 bridge 工具。可查：${all.map((x) => x.name).join('、')}` }] };
  }
  const text = `# ${t.name}\n\n${t.description}\n\n## 参数\n${schemaLines(t.inputSchema).join('\n') || '（无）'}`;
  return { content: [{ type: 'text', text }] };
}

/** 这个身份在这份设置下应当暴露给 agy 的中枢工具（MCP tools/list 形状，名字已换成对外名；体量大的已精简，见上）。 */
export async function listHubTools(ctx, settings = {}, { cwd = '' } = {}) {
  // 时长上限说明（BUDGET_NOTE）关系到调用会不会被 agy 判超时，精简时也要留着
  const spent = new Map();   // 组 → 已用预算（capTokens 的组）
  cappedNames.clear();
  const tools = [];
  for (const t0 of await fullHubTools(ctx, settings, cwd)) {
    const { _group, ...t } = t0;
    const note = BUDGET_NOTE[t.name] || '';
    const bare = note && t.description.endsWith(note) ? { ...t, description: t.description.slice(0, -note.length) } : t;
    const c = compactAgyTool(bare);
    const item = c === bare ? t : { ...c, description: c.description + note };
    // 插件 / 远程连接器的工具数量不由 bridge 定：这一组超出自己那份预算的不列（agy 超了总预算会整个丢掉最大的工具、还不报错）
    const cap = GROUP_BY_KEY.get(_group)?.capTokens;
    if (cap) {
      const used = (spent.get(_group) || 0) + agyTokenEstimate(item.description) + agyTokenEstimate(item.inputSchema);
      if (used > cap) { cappedNames.add(item.name); continue; }
      spent.set(_group, used);
    }
    tools.push(item);
  }
  // 系统提示里只要挂了中枢组就会提 tool_docs（settings.mjs），所以这里也不看「有没有被精简的」：有工具就列
  if (tools.length) tools.push(DOCS_TOOL_DEF);
  return tools;
}

/** 对外名 → { group, toolName }；不认识返回 null（只认已启用的组）。 */
// 超出组预算、没列进清单的工具名（tool_docs 与调不了的原因据此说明）
const cappedNames = new Set();
export async function resolveHubTool(ctx, settings, exposed, { cwd = '' } = {}) {
  const name = String(exposed || '').trim();
  if (!name) return null;
  if (cappedNames.has(name)) return null;
  if (name === AGY_DOCS_TOOL && enabledHubGroups(ctx, settings).length) return { group: { key: 'docs' }, toolName: AGY_DOCS_TOOL, settings };
  for (const group of enabledHubGroups(ctx, settings)) {
    let tools;
    try { tools = await listGroupTools(group, ctx, cwd || ctx.cwd || ''); } catch { continue; }
    const hit = tools.find((t) => exposedToolName(group.key, t.name) === name);
    if (hit) return { group, toolName: hit.name };
  }
  return null;
}

/** 一个对外名现在调不了的原因（给模型看的一句话）：设置里关了 / 没有登记电脑 / 插件没开 / 根本没有这个工具。 */
export function hubToolUnavailableReason(ctx, settings, exposed) {
  const name = String(exposed || '').trim();
  if (cappedNames.has(name)) return `工具 ${name} 没列进工具清单：插件 / 连接器的工具太多，超出了 Antigravity 的工具清单预算。少开几个连接器或插件后再试`;
  const group = HUB_GROUPS.find((g) => (typeof g.owns === 'function' ? g.owns(name)
    : g.key === 'bridge' ? name === 'manual' || name === 'call' : name === g.key || name.startsWith(g.key + '_')));
  if (!group) return `没有叫 ${name || '(空)'} 的 bridge 工具`;
  const bt = settings?.bridgeTools && typeof settings.bridgeTools === 'object' ? settings.bridgeTools : {};
  if (bt.enabled === false || bt[group.setting] === false) return `工具 ${name} 未启用：在 设置 › Antigravity › Bridge 工具 里打开对应开关`;
  let ok = false;
  try { ok = !!group.available(ctx); } catch {}
  if (ok) return `${group.key} 组里没有叫 ${name} 的工具`;
  if (group.key === 'device') return `工具 ${name} 现在用不了：这个账号名下没有登记电脑（让用户在 设置 › 设备 里登记，或在那台电脑上打开 bridge 客户端）`;
  return `工具 ${name} 现在用不了：对应的插件没开（扩展中心），或这个身份没有这项能力`;
}

/** 已知的全部对外名（不看开关）——内部回调判归属时用来认 mcp_bridge_<名>。 */
export function hubGroupOf(key) { return GROUP_BY_KEY.get(key) || null; }

/**
 * 在归属轮 gen 上执行一次中枢工具。返回 MCP CallToolResult（content 原样：文本、图片都行）。
 * cwd：这一轮的授权工作目录（浏览器 / 终端池键与工作区相对路径都按它，和右侧面板同一把键）。
 */
export async function callHubTool(ctx, gen, { group, toolName, settings }, args = {}, { cwd = '', signal = null } = {}) {
  if (group.key === 'docs') return toolDocsResult(ctx, settings || {}, cwd || gen?.cwd || ctx.cwd || '', args?.name);
  const getGen = () => gen;
  const dir = cwd || gen?.cwd || ctx.cwd || '';
  const job = typeof group.call === 'function'
    ? group.call(ctx, gen, toolName, args, { cwd: dir, signal })
    : withClient(group.build({ ctx, getGen, cwd: dir }), (c) => c.callTool(
      { name: toolName, arguments: fitAgyBudget(group.key, toolName, args) },
      undefined,
      // 终端 wait 最长 600s、设备批量动作也慢：放宽到 20 分钟，真正的上限由各工具自己掐。
      // signal：这一轮被停止时取消（工具处理函数的 extra.signal 随之中断，终端 wait 立刻返回）
      { timeout: 20 * 60_000, resetTimeoutOnProgress: true, ...(signal ? { signal } : {}) },
    ));
  return rewordResult(group.budgetMs ? await withinBudget(job, group.budgetMs, toolName) : await job);
}

// 整次调用夹在 budgetMs 以内（agy 180 秒硬上限）：到点先回一句，动作本身可能还在跑完
export async function withinBudget(job, ms, toolName) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ isError: true, content: [{ type: 'text', text: `${toolName} 这次调用到了 ${Math.round(ms / 1000)} 秒上限还没结束（Antigravity 单次工具调用最长约 3 分钟），结果未知：先看一下现状再决定要不要重试。` }] }), ms);
    timer.unref?.();
  });
  try { return await Promise.race([job, late]); } finally { clearTimeout(timer); }
}

/** 这份设置下各组清单的指纹（进 buildAgySessionTooling 的 toolingSig：变了 agy 常驻进程空闲时重启、重新取清单）。 */
export function hubToolingSig(ctx, settings = {}) {
  return enabledHubGroups(ctx, settings).map((g) => { const x = groupSig(g, ctx); return x ? `${g.key}=${x}` : ''; }).filter(Boolean).join(';');
}

export function _clearHubCacheForTest() { listCache.clear(); cappedNames.clear(); }
