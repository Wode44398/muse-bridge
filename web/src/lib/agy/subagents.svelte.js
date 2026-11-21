// Antigravity 多代理状态仓库与纯辅助逻辑（Svelte 5 runes）：
// 管理当前会话的递归子代理树、按需轮询、对话内卡片到真实子代理节点的匹配，以及增量转录合并。

import { t, tc } from '../i18n.js';
import { agyApi } from './api.js';
import { parseAgyModelAndEffort } from './catalog.js';

const SUBAGENT_ID_RE = /\bconversationId['":\s=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const agySubagents = $state({
  sessionId: '',
  loading: false,
  syncing: false,
  error: '',
  tree: null,
});

let reqSeq = 0;
let inflightSid = '';

export function resetAgySubagents(sessionId = '') {
  reqSeq++;
  inflightSid = '';
  agySubagents.sessionId = sessionId || '';
  agySubagents.loading = false;
  agySubagents.syncing = false;
  agySubagents.error = '';
  agySubagents.tree = null;
}

export async function refreshAgySubagents(sessionId = agySubagents.sessionId, { silent = false } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) {
    resetAgySubagents('');
    return null;
  }
  if (inflightSid === sid && silent) return agySubagents.tree;
  const seq = ++reqSeq;
  inflightSid = sid;
  if (agySubagents.sessionId !== sid) {
    agySubagents.sessionId = sid;
    agySubagents.tree = null;
  }
  if (!silent) agySubagents.loading = true;
  agySubagents.error = '';
  try {
    const res = await agyApi.subagents(sid);
    if (seq !== reqSeq) return null;
    agySubagents.tree = res && typeof res === 'object' ? res : null;
    return agySubagents.tree;
  } catch (err) {
    if (seq !== reqSeq) return null;
    if (!silent) agySubagents.error = err?.body?.error || err?.message || t('读取子代理状态失败');
    return null;
  } finally {
    if (seq === reqSeq) {
      inflightSid = '';
      agySubagents.loading = false;
    }
  }
}

export async function syncAgySubagents(sessionId = agySubagents.sessionId, { wake = false } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid || agySubagents.syncing) return null;
  agySubagents.syncing = true;
  try {
    const res = await agyApi.syncSubagents(sid, wake);
    if (res?.tree && agySubagents.sessionId === sid) {
      agySubagents.tree = { ...res.tree, monitorActive: true };
    }
    return res;
  } catch {
    return null;
  } finally {
    agySubagents.syncing = false;
  }
}

export function findSubagentInStore(agentId) {
  const id = String(agentId || '').trim();
  if (!id || !agySubagents.tree) return null;
  return findInList(agySubagents.tree.agents, id);
}

/** 该工具调用是否属于 Native Swarm 协作操作（对话中将按整条消息聚合为一张 AgySwarmCard）。 */
export function isSwarmTool(tool) {
  if (!tool) return false;
  const name = String(tool.name || '').toLowerCase();
  return name === 'swarm' || name === 'post_message' || name === 'read_board' || name === 'swarm_wait';
}

/** 该工具调用是否应该在对话中直接渲染为独立子代理查看卡片（生图子代理已有 AgyMediaCard、Swarm 走 AgySwarmCard）。 */
export function isMultiAgentTool(tool) {
  if (!tool) return false;
  const name = String(tool.name || '').toLowerCase();
  if (name === 'invoke_subagent') {
    const type = String(tool.args?.TypeName || tool.args?.typeName || '');
    return !/image/i.test(type);
  }
  if (name === 'run_workflow') return true;
  return false;
}

/** 后续轮次里给已知子代理发消息（send_message）时，返回该目标子代理节点，以便原地插一张同款查看卡、不用往上翻多轮找。 */
export function matchSendMessageToSubagent(tool, tree = agySubagents.tree) {
  if (!tool || String(tool.name || '').toLowerCase() !== 'send_message') return null;
  const recipient = String(tool.args?.Recipient || tool.args?.recipient || '').trim();
  if (!recipient || !UUID_RE.test(recipient)) return null;
  const agents = Array.isArray(tree?.agents) ? tree.agents : [];
  return findInList(agents, recipient);
}

/** 把对话中的多代理工具调用匹配到实时子代理树里的对应节点（匹配不到时返回基于入参的占位视图）。 */
export function matchToolToSubagent(tool, msgTools = [], tree = agySubagents.tree) {
  if (!tool) return null;
  const name = String(tool.name || '').toLowerCase();
  const args = tool.args && typeof tool.args === 'object' ? tool.args : {};
  const agents = Array.isArray(tree?.agents) ? tree.agents : [];
  const flat = Array.isArray(tree?.flat) ? tree.flat : [];

  // 0) send_message 直接按 Recipient 匹配
  if (name === 'send_message') {
    const recipient = String(args.Recipient || args.recipient || '').trim();
    if (recipient) {
      const hit = findInList(agents, recipient);
      if (hit) return hit;
    }
    return null;
  }

  // 1) 优先从工具输出里直接抠 conversationId
  const idMatch = SUBAGENT_ID_RE.exec(String(tool.output || ''));
  if (idMatch) {
    const exact = findInList(agents, idMatch[1]);
    if (exact) return exact;
  }

  // 2) 按 Role + TypeName（以及同一条消息里的出现次序）匹配顶层子代理
  if (name === 'invoke_subagent') {
    const wantRole = String(args.Role || args.role || '').trim().toLowerCase();
    const wantType = String(args.TypeName || args.typeName || '').trim().toLowerCase();
    const sameOrder = (Array.isArray(msgTools) ? msgTools : []).filter((item) => {
      if (!item || String(item.name || '').toLowerCase() !== 'invoke_subagent') return false;
      const ia = item.args || {};
      const r = String(ia.Role || ia.role || '').trim().toLowerCase();
      const ty = String(ia.TypeName || ia.typeName || '').trim().toLowerCase();
      return (wantRole ? r === wantRole : true) && (wantType ? ty === wantType : true);
    });
    const occ = Math.max(0, sameOrder.indexOf(tool));
    const candidates = agents.filter((a) => {
      if (a.kind === 'image') return false;
      const r = String(a.role || '').trim().toLowerCase();
      const ty = String(a.typeName || '').trim().toLowerCase();
      if (wantRole && wantType) return r === wantRole && ty === wantType;
      if (wantRole) return r === wantRole;
      if (wantType) return ty === wantType;
      return true;
    });
    if (candidates[occ]) return candidates[occ];
    if (candidates.length) return candidates[candidates.length - 1];
    const deep = flat.find((a) => wantRole && String(a.role || '').trim().toLowerCase() === wantRole);
    if (deep) return findInList(agents, deep.id) || deep;
  }

  // 3) 尚未在盘上落完文件或老记录：根据工具入参拼一张临时视图卡
  return {
    id: '',
    placeholder: true,
    role: String(args.Role || args.role || args.Description || args.title || args.name || args.TypeName || t('子代理')),
    typeName: String(args.TypeName || args.typeName || (name === 'run_workflow' ? 'workflow' : name === 'swarm' ? 'swarm' : '')),
    kind: name === 'run_workflow' ? 'workflow' : (/teamwork|orchestrat|coordinat/i.test(`${args.TypeName || ''} ${args.Role || ''}`) ? 'teamwork' : 'subagent'),
    status: tool.status === 'failed' || tool.status === 'error'
      ? 'error'
      : (tool.status === 'cancelled' ? 'killed' : (tool.status === 'in_progress' || tool.status === 'pending' ? 'running' : 'done')),
    spawnedAt: tool.startedAt || 0,
    durationMs: tool.durationMs || 0,
    model: '',
    modelBase: '',
    effort: '',
    tokens: { total: 0 },
    subtreeTokens: 0,
    toolCallsCount: 0,
    lastTool: null,
    lastMessage: '',
    lastError: '',
    children: [],
    subtreeCounts: {
      total: 1,
      running: tool.status === 'in_progress' || tool.status === 'pending' ? 1 : 0,
      waiting: 0,
      done: tool.status === 'completed' ? 1 : 0,
      error: tool.status === 'failed' || tool.status === 'error' ? 1 : 0,
      killed: tool.status === 'cancelled' ? 1 : 0,
      active: tool.status === 'in_progress' || tool.status === 'pending' ? 1 : 0,
    },
  };
}

function findInList(list, id) {
  for (const node of (Array.isArray(list) ? list : [])) {
    if (node.id === id) return node;
    const hit = findInList(node.children, id);
    if (hit) return hit;
  }
  return null;
}

/** 收集节点及其全部后代，供点阵、模型分布与平面表使用。 */
export function flattenSubtree(node) {
  if (!node) return [];
  const out = [node];
  for (const ch of (Array.isArray(node.children) ? node.children : [])) {
    out.push(...flattenSubtree(ch));
  }
  return out;
}

/** 解析子代理的模型名与运行 effort（优先用服务端已拆字段，缺省再从原始 model ID 拆）。 */
export function agentModelInfo(node) {
  if (!node) return { modelName: '', effort: '' };
  const parsed = parseAgyModelAndEffort(node.model || node.modelBase || '', [], { short: true });
  return {
    modelName: parsed.modelName,
    effort: String(node.effort || parsed.effort || '').trim(),
  };
}

/** 汇总子树里各「模型 · effort」的使用分布（对齐 Claude WorkflowCard 的模型构成行）。 */
export function subtreeModelMix(node) {
  const list = flattenSubtree(node);
  const map = new Map();
  for (const a of list) {
    const { modelName, effort } = agentModelInfo(a);
    if (!modelName) continue;
    const key = `${modelName}::${effort}`;
    const prev = map.get(key);
    if (prev) prev.count += 1;
    else map.set(key, { modelName, effort, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.modelName.localeCompare(b.modelName));
}

export function formatModelMixLine(node) {
  return subtreeModelMix(node)
    .map((m) => {
      const base = m.effort ? `${m.modelName} · ${m.effort}` : m.modelName;
      return m.count > 1 ? `${base} ×${m.count}` : base;
    })
    .join(' / ');
}

export function fmtCompactTokens(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

export function subagentStatusLabel(status) {
  switch (status) {
    case 'running': return t('运行中');
    case 'waiting': return t('等待子代理');
    case 'done': return t('已完成');
    case 'error': return t('出错');
    case 'killed': return t('已停止');
    default: return t('已完成');
  }
}

export function subagentKindLabel(kind) {
  switch (kind) {
    case 'swarm': return t('多代理协作');
    case 'teamwork': return t('多代理团队');
    case 'workflow': return tc('agy', '工作流');
    case 'research': return t('调研代理');
    case 'image': return t('生图代理');
    default: return t('子代理');
  }
}

/** 增量转录合并：把下一拍才到达的 tool_result 挂回前面对应的工具调用上。 */
export function mergeSubagentEntries(prev = [], more = []) {
  if (!Array.isArray(more) || !more.length) return prev;
  const out = prev.map((e) => (e.kind === 'tools' ? { ...e, tools: e.tools.map((tl) => ({ ...tl })) } : { ...e }));
  for (const entry of more) {
    if (entry.kind === 'tool_result') {
      let matched = false;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].kind !== 'tools') continue;
        const slot = out[i].tools.find((tl) => tl.status === 'in_progress');
        if (slot) {
          slot.status = entry.status || 'completed';
          if (entry.output) slot.output = entry.output;
          if (entry.error) slot.error = entry.error;
          if (entry.childAgentId) slot.childAgentId = entry.childAgentId;
          matched = true;
          break;
        }
      }
      if (!matched) out.push(entry);
      continue;
    }
    out.push(entry);
  }
  return out;
}
