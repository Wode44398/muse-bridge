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
import {
  AGY_DOCS_TOOL, agyTokenEstimate, compactAgyTool, mergeFamilies, familyOf, expandFamilyCall, fitBridgeShare,
} from './catalog.mjs';
import { localToolCatalog } from './agy-bridge-tools.mjs';
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

// ── 工具清单的体量 ─────────────────────────────────────────────────────────────
// agy 给一个会话里的全部工具声明设了总上限，超了从最大的工具开始整个丢掉、不报错（11-24 丢的是 device_browser）。
// 精简、合并、份额的口径都在 catalog.mjs（子进程本地工具也用同一套）；这里只是中枢这一侧怎么接。
export { AGY_DOCS_TOOL, agyTokenEstimate, compactAgyTool } from './catalog.mjs';
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
  // 拉取请求、项目记忆各合成一个按 action 分派的工具（catalog.mjs AGY_TOOL_FAMILIES）；_members 留着原工具给 tool_docs
  return mergeFamilies(out);
}

// 子进程本地工具（媒体 / 界面 / 手机文件）的完整定义：tool_docs 与总清单都要（按类别过滤，手机文件也合并成一个）
function localFullTools(categories = ['media', 'ui', 'phone']) {
  return mergeFamilies(localToolCatalog(categories));
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
const docOf = (t) => `${t.description}\n\n## 参数\n${schemaLines(t.inputSchema).join('\n') || '（无）'}`;
async function toolDocsResult(ctx, settings, cwd, name) {
  const want = String(name || '').trim().replace(/^mcp_bridge_/, '');
  if (cappedNames.has(want)) return { isError: true, content: [{ type: 'text', text: `${want} 这次没列进工具清单：bridge 的工具总量超出了 Antigravity 的工具清单上限，先让出了它，这一轮调不了。` }] };
  const all = [...localFullTools(), ...await fullHubTools(ctx, settings, cwd)];
  const t = all.find((x) => x.name === want);
  if (!t) {
    return { isError: true, content: [{ type: 'text', text: `没有叫 ${want || '(空)'} 的 bridge 工具。可查：${all.map((x) => x.name).join('、')}` }] };
  }
  // 合并工具：先给总说明，再按 action 逐个给原工具的完整说明与参数（调用时写 action + 那一节的参数）
  const fam = familyOf(t.name);
  const text = fam && Array.isArray(t._members)
    ? `# ${t.name}\n\n${agyWording(t.description)}\n\n调用：action 选下面一节的名字，其余参数照那一节写。\n\n`
      + t._members.map((m) => `## action: "${m.name.slice(fam.prefix.length)}"\n\n${docOf({ ...m, description: agyWording(m.description || '') })}`).join('\n\n')
    : `# ${t.name}\n\n${docOf(t)}`;
  return { content: [{ type: 'text', text }] };
}

/** 这个身份在这份设置下应当暴露给 agy 的中枢工具（MCP tools/list 形状，名字已换成对外名；体量大的已精简，见上）。 */
export async function listHubTools(ctx, settings = {}, { cwd = '' } = {}) {
  // 时长上限说明（BUDGET_NOTE）关系到调用会不会被 agy 判超时，精简时也要留着
  const spent = new Map();   // 组 → 已用预算（capTokens 的组）
  cappedNames.clear();
  const tools = [];
  for (const t0 of await fullHubTools(ctx, settings, cwd)) {
    const { _group, _members, ...t } = t0;
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

/**
 * 子进程 tools/list 要的整份清单：本地工具（媒体 / 界面 / 手机文件，按 categories）+ 中枢工具，精简、合并后
 * 整体夹进 bridge 的份额（catalog.mjs fitBridgeShare）。超了就按先后让出不常用的，并在 tool_docs 的说明里写明让出了谁——
 * 不夹的话 agy 会自己丢掉最大的那个（就是浏览器），还不告诉任何人。
 * 返回 { local, hub, withheld, total }：local / hub 都是 MCP tools/list 形状（对外名）。
 */
export async function listAgyBridgeCatalog(ctx, settings = {}, { categories = [], cwd = '' } = {}) {
  const cats = (Array.isArray(categories) ? categories : []).map((c) => String(c).toLowerCase());
  const localCats = cats.filter((c) => c === 'media' || c === 'ui' || c === 'phone');
  const local = localCats.length ? localFullTools(localCats).map(({ _members, ...t }) => compactAgyTool(t)) : [];
  const hub = cats.includes('hub') ? await listHubTools(ctx, settings, { cwd }) : [];   // 这里会重置 cappedNames
  const fit = fitBridgeShare([...local, ...hub]);
  for (const n of fit.withheld) cappedNames.add(n);
  const kept = new Set(fit.tools.map((t) => t.name));
  const keptHub = hub.filter((t) => kept.has(t.name)).map((t) => (t.name === AGY_DOCS_TOOL && fit.withheld.length
    ? { ...t, description: `${t.description}\n（bridge 的工具总量超出了 Antigravity 的工具清单上限，这次没有列出：${fit.withheld.join('、')}。）` }
    : t));
  if (fit.withheld.length) console.warn(`[agy-hub] 工具清单超出份额，这次让出：${fit.withheld.join('、')}（留下约 ${fit.total}）`);
  return { local: local.filter((t) => kept.has(t.name)), hub: keptHub, withheld: fit.withheld, total: fit.total };
}

/** 对外名 → { group, toolName }（合并工具另带 family，执行时按 action 换成原工具）；不认识返回 null（只认已启用的组）。 */
// 超出组预算 / 总份额、没列进清单的工具名（tool_docs 与调不了的原因据此说明）
const cappedNames = new Set();
export async function resolveHubTool(ctx, settings, exposed, { cwd = '' } = {}) {
  const name = String(exposed || '').trim();
  if (!name) return null;
  if (cappedNames.has(name)) return null;
  if (name === AGY_DOCS_TOOL && enabledHubGroups(ctx, settings).length) return { group: { key: 'docs' }, toolName: AGY_DOCS_TOOL, settings };
  const fam = familyOf(name);
  if (fam) {
    // 族里任一成员认得出来，就说明这个合并工具在（属于哪一组看成员）
    for (const m of fam.members) {
      const hit = await resolveHubTool(ctx, settings, m, { cwd });
      if (hit) return { group: hit.group, toolName: null, family: fam, settings };
    }
    return null;
  }
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
  if (cappedNames.has(name)) return `工具 ${name} 没列进工具清单：bridge 的工具总量超出了 Antigravity 的工具清单上限（插件、连接器开得多时更容易超），这次先让出了它。少开几个连接器或插件后再试`;
  // 合并工具按它的第一个成员认组（pr → pr_status、project_memory → project_memory_read）
  const probe = familyOf(name)?.members[0] || name;
  const group = HUB_GROUPS.find((g) => (typeof g.owns === 'function' ? g.owns(probe)
    : g.key === 'bridge' ? probe === 'manual' || probe === 'call' : probe === g.key || probe.startsWith(g.key + '_')));
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
export async function callHubTool(ctx, gen, { group, toolName, settings, family }, args = {}, { cwd = '', signal = null } = {}) {
  if (group.key === 'docs') return toolDocsResult(ctx, settings || {}, cwd || gen?.cwd || ctx.cwd || '', args?.name);
  if (family) {
    // 合并工具：按 action 换回原工具，参数去掉 action 原样交给它（必填项由原工具自己校验）
    const x = expandFamilyCall(family.name, args);
    const actions = family.members.map((m) => m.slice(family.prefix.length));
    if (!x?.member) return { isError: true, content: [{ type: 'text', text: `${family.name} 的 action 只能是 ${actions.join(' / ')}（收到：${String(args?.action ?? '') || '空'}）。` }] };
    const sub = await resolveHubTool(ctx, settings || {}, x.member, { cwd });
    if (!sub) return { isError: true, content: [{ type: 'text', text: hubToolUnavailableReason(ctx, settings || {}, x.member) }] };
    return callHubTool(ctx, gen, sub, x.args, { cwd, signal });
  }
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
