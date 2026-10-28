// agent 开关与状态：每个 agent「勾没勾 / 能不能跑 / 认证了没」的单一真相。
//
//   勾选 switch   —— 管理员在设置「Agent」页里的开关，存 config.json 的 agents 键
//                    （{ claude:true, codex:false, … }，没写的项 = 默认开）。
//   能跑 runnable —— 所属功能扩展装了且加载成功（modules/registry.mjs；Claude 是核心恒在），
//                    再由扩展自报这台机器上跑不跑得起来：codex 要 CLI、dimensio 要 harness 目录。
//                    探测不 spawn，结果缓存 20 秒。
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
import { CONFIG_PATH, config, VERTEX_PROJECT, GEMINI_API_KEY } from '../config/index.mjs';
import { AGENTS, AGENT_IDS, AGENT_BY_ID } from '../config/agents.mjs';
import { busPublishAll } from './bus.mjs';
import { agentModuleRunnable, getModule, moduleOfAgent, moduleOffered, moduleStatus } from '../modules/registry.mjs';

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
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch {}
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
// Claude 是核心（Agent SDK 自带引擎二进制）；其余 agent 交给所属扩展自报。
const runnableOf = (id) => agentModuleRunnable(id);

const fileHasKey = (file, re) => { try { return re.test(readFileSync(file, 'utf8')); } catch { return false; } };
const gcloudAdc = () => (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
  : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json'));

const AUTHED = {
  claude: () => {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) return true;
    let accounts = [];
    try { accounts = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '')).claudeAccounts || []; } catch {}
    if (accounts.some((a) => a && a.token)) return true;
    const cfgDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    // 只认 claude login 的凭据：这个文件里也可能只有 MCP 服务的 OAuth 状态（mcpOAuth）
    return fileHasKey(path.join(cfgDir, '.credentials.json'), /"claudeAiOauth"/);
  },
  gemini: () => {
    if (GEMINI_API_KEY) return true;
    if (!VERTEX_PROJECT) return false;
    const sa = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    return (!!sa && existsSync(sa)) || existsSync(gcloudAdc());
  },
  codex: () => !!process.env.OPENAI_API_KEY || existsSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json')),
  dimensio: () => {
    const KEY_RE = /^\s*(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY\s*=\s*\S+/m;
    if (Object.keys(process.env).some((k) => /^(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY$/.test(k) && process.env[k])) return true;
    const mod = getModule('dimensio');
    const dir = mod?.harnessDir?.();
    // 管理员实例实际加载的 .env：扩展说了算（数据根 ≠ 程序目录时默认在 <数据根>/dimensio/.env，见 harness-data.mjs）；
    // 老扩展没这个导出时回落到原来的 HARNESS_ENV_FILE > <harness 目录>/.env。
    const envFile = mod?.harnessEnvFile?.() || process.env.HARNESS_ENV_FILE || (dir && path.join(dir, '.env'));
    if (fileHasKey(envFile, KEY_RE)) return true;
    // 设置页填的厂商 key 加密存在自定义模型服务目录的 connector-secrets.json 里（harness paths.ts customProvidersDir）
    const cpEnv = String(process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR || '').trim();
    const home = mod?.harnessDataDir?.() || dir;
    const cpDir = cpEnv ? path.resolve(dir || '.', cpEnv) : (home && path.join(home, 'custom-providers'));
    return !!cpDir && existsSync(path.join(cpDir, 'connector-secrets.json'));
  },
};

const PROBE_TTL = 20_000;
let probeCache = null;   // { at, runnable:{}, authed:{} }
function invalidateProbes() { probeCache = null; }
function probes() {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL) return probeCache;
  const runnable = {}, authed = {};
  for (const id of AGENT_IDS) {
    try { runnable[id] = !!runnableOf(id); } catch { runnable[id] = false; }
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
  codex: '没找到 Codex CLI',
  dimensio: '程序目录里缺 harness',
};

// 不能跑的原因：先看扩展装没装、加载有没有出错，再落到扩展自己的探测说明。
function notRunnableNote(id) {
  const mod = moduleStatus(moduleOfAgent(id));
  if (mod && !mod.installed) return '未安装「' + mod.label + '」扩展';
  if (mod && mod.error) return '「' + mod.label + '」扩展' + mod.error;
  return NOT_RUNNABLE_NOTE[id] || '这台机器上不可用';
}

// 给设置「Agent」页（管理员）的完整视图。
export function agentStatusList() {
  const p = probes();
  // 这一版不提供其扩展的 agent（公开版的 Codex）不列
  return AGENTS.filter((a) => { const m = moduleOfAgent(a.id); return !m || moduleOffered(m); }).map((a) => ({
    id: a.id,
    label: a.label,
    multiUser: a.multiUser,
    switch: switches[a.id] !== false,
    runnable: !!p.runnable[a.id],
    authed: !!p.authed[a.id],
    enabled: agentEnabled(a.id),
    note: !p.runnable[a.id] ? notRunnableNote(a.id) : (!p.authed[a.id] ? '还没配认证' : ''),
    module: moduleStatus(moduleOfAgent(a.id)),
  }));
}
