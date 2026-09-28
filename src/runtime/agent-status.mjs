// agent 开关与状态：每个 agent「勾没勾 / 能不能跑 / 认证了没」的单一真相。
//
//   勾选 switch   —— 管理员在设置「Agent」页里的开关，存 config.json 的 agents 键
//                    （{ claude:true, dimensio:false }，没写的项 = 默认开）。部署脚本按用户在
//                    「只要 Claude / 只要 dimensio / 都要」里的选择写这个键。
//   能跑 runnable —— 这台机器装了：dimensio 要 harness 目录且装好了依赖（只选 Claude 时部署脚本
//                    不装 harness 的依赖）。探测不 spawn，结果缓存 20 秒。
//   认证 authed   —— 凭据配没配（仅作提示）：token 过期这种临时态不该让整个分页消失，
//                    Claude 自己就有「未认证提示卡」，所以【不】参与 enabled 判定。
//
// enabled = runnable && switch !== false。身份层（identity.mjs contextFor）在此之上再与
// 「这个人被授权的名单」取交集，得出每个请求能用哪些 agent。
//
// 开关改动即时生效（下一个请求就按新值走），并经事件总线广播 agents.changed，
// 在线客户端据此刷新可用列表。落盘只改 agents 这一个键（同 claude-account.mjs 的做法）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, config } from '../config/index.mjs';
import { AGENTS, AGENT_IDS, AGENT_BY_ID } from '../config/agents.mjs';
import { busPublishAll } from './bus.mjs';

const HARNESS_DIR = fileURLToPath(new URL('../../harness', import.meta.url));

// ── 开关 ────────────────────────────────────────────────────────────────────
function normSwitches(raw) {
  const out = {};
  if (raw && typeof raw === 'object') for (const id of AGENT_IDS) if (typeof raw[id] === 'boolean') out[id] = raw[id];
  return out;
}
let switches = normSwitches(config.agents);

export function agentSwitches() { return { ...switches }; }

function persist() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  raw.agents = { ...switches };
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); } catch (e) { console.error('[agents] persist failed:', (e && e.message) || e); }
}

export function setAgentSwitch(id, on) {
  if (!AGENT_BY_ID[id]) return { error: '未知 agent：' + id };
  switches = { ...switches, [id]: !!on };
  persist();
  invalidateProbes();
  busPublishAll({ type: 'agents.changed' });
  return { ok: true, id, enabled: agentEnabled(id) };
}

// ── 探测 ────────────────────────────────────────────────────────────────────
const RUNNABLE = {
  claude: () => true,                    // Agent SDK 自带引擎二进制
  dimensio: () => existsSync(path.join(HARNESS_DIR, 'server', 'index.ts')) && existsSync(path.join(HARNESS_DIR, 'node_modules')),
};

const fileHasKey = (file, re) => { try { return re.test(readFileSync(file, 'utf8')); } catch { return false; } };

const AUTHED = {
  claude: () => {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
    let accounts = [];
    try { accounts = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).claudeAccounts || []; } catch {}
    if (accounts.some((a) => a && a.token)) return true;
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return existsSync(path.join(cfgDir, '.credentials.json'));
  },
  dimensio: () => {
    const KEY_RE = /^\s*(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY\s*=\s*\S+/m;
    if (Object.keys(process.env).some((k) => /^(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY$/.test(k) && process.env[k])) return true;
    return fileHasKey(process.env.HARNESS_ENV_FILE || path.join(HARNESS_DIR, '.env'), KEY_RE);
  },
};

const PROBE_TTL = 20_000;
let probeCache = null;   // { at, runnable:{}, authed:{} }
function invalidateProbes() { probeCache = null; }
function probes() {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL) return probeCache;
  const runnable = {}, authed = {};
  for (const id of AGENT_IDS) {
    try { runnable[id] = !!RUNNABLE[id](); } catch { runnable[id] = false; }
    try { authed[id] = runnable[id] && !!AUTHED[id](); } catch { authed[id] = false; }
  }
  probeCache = { at: Date.now(), runnable, authed };
  return probeCache;
}

export function agentRunnable(id) { return !!probes().runnable[id]; }
export function agentAuthed(id) { return !!probes().authed[id]; }
export function agentEnabled(id) { return !!AGENT_BY_ID[id] && agentRunnable(id) && switches[id] !== false; }
export function enabledAgents() { return AGENT_IDS.filter(agentEnabled); }

const NOT_RUNNABLE_NOTE = {
  dimensio: '部署时没装 dimensio（让部署助手重新选择要装的 agent）',
};

// 给设置「Agent」页（管理员）的完整视图。
export function agentStatusList() {
  const p = probes();
  return AGENTS.map((a) => ({
    id: a.id,
    label: a.label,
    multiUser: a.multiUser,
    switch: switches[a.id] !== false,
    runnable: !!p.runnable[a.id],
    authed: !!p.authed[a.id],
    enabled: agentEnabled(a.id),
    note: !p.runnable[a.id] ? (NOT_RUNNABLE_NOTE[a.id] || '这台机器上不可用') : (!p.authed[a.id] ? '还没配认证' : ''),
  }));
}
