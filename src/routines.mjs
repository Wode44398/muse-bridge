// Routines: scheduled, unattended Claude runs. Persistence + next-run math only;
// the scheduler loop + execution live in runtime/routines-runner.mjs.
//
// Multi-user: every function takes the OWNER's data dir (admin -> ROOT; user ->
// their .bridge), so each account has its own routines.json. Schedules use friendly
// presets in the server's LOCAL timezone (China time), plus a custom 5-field cron
// (cron.mjs, at most once per hour — same rule as the official desktop app).
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJson } from './jsonfile.mjs';
import { normSchedule, computeNextRun } from './routine-schedule.mjs';

export { normSchedule, computeNextRun };

const SESSION_MODES = new Set(['new', 'continue']);
export const RUNS_KEPT = 30;   // 每条任务留最近多少次运行记录
const fileIn = (dir) => path.join(dir, 'routines.json');

// Gemini 对话 2026-11-04 下线：残留的 Gemini 引擎任务（agent 'vertex'）读到时停用并写明原因，不删（维护者：数据别动）
export const GEMINI_ROUTINE_NOTE = 'Gemini 对话已下线，这条用 Gemini 跑的定时任务已停用；要接着用，请编辑它改用 Claude。';
function retireGemini(list) {
  let changed = false;
  for (const r of list) {
    if (!r || r.agent !== 'vertex' || r.retired === 'gemini') continue;
    Object.assign(r, { enabled: false, nextRun: null, retired: 'gemini', lastStatus: 'error', lastPreview: GEMINI_ROUTINE_NOTE });
    changed = true;
  }
  return changed;
}
function load(dir) {
  const f = fileIn(dir);
  if (!existsSync(f)) return [];
  let list;
  try { const v = JSON.parse(readFileSync(f, 'utf8')); list = Array.isArray(v) ? v : []; } catch { return []; }
  if (retireGemini(list)) { try { persist(dir, list); } catch {} }
  return list;
}
function persist(dir, list) {
  writeJson(fileIn(dir), list, 2); // atomic; ensures dir; pretty-printed
}

// 引擎之外的设置（Claude 才用得上的 Code 侧字段）。路由层已按身份校验过 cwd / 权限模式，这里只管形状。
function settingsFields(input, base = {}) {
  const out = {};
  if ('description' in input) out.description = String(input.description || '').trim().slice(0, 300);
  if ('cwd' in input) out.cwd = input.cwd ? String(input.cwd) : null;
  if ('worktree' in input) out.worktree = input.worktree === true;
  if ('branch' in input) out.branch = input.branch ? String(input.branch).slice(0, 200) : null;
  if ('permissionMode' in input) out.permissionMode = input.permissionMode ? String(input.permissionMode) : null;
  if ('fast' in input) out.fast = input.fast === true;
  if ('sessionMode' in input) out.sessionMode = SESSION_MODES.has(input.sessionMode) ? input.sessionMode : 'new';
  if ('notify' in input) out.notify = input.notify === true;
  if ('shape' in input) out.shape = input.shape === 'project' ? 'project' : null;   // 以项目对话运行（runtime/project-mode.mjs）
  // 换了工作文件夹 / worktree 开关 / 项目形态 / 改回每次新会话：接着用的那个会话作废，下次重新开
  if (('cwd' in out && out.cwd !== (base.cwd || null)) || out.sessionMode === 'new' || ('worktree' in out && out.worktree !== !!base.worktree) || ('shape' in out && out.shape !== (base.shape || null))) out.threadSessionId = null;
  return out;
}

export function list(dir) { return load(dir); }
export function get(dir, id) { return load(dir).find((r) => r.id === id) || null; }

export function create(dir, input = {}) {
  const { name, prompt, schedule, enabled = true, agent, model, effort, search } = input;
  const items = load(dir);
  const sched = normSchedule(schedule);
  const on = enabled !== false;
  const r = {
    id: randomUUID(),
    name: String(name || '').trim().slice(0, 120) || '未命名任务',
    description: '',
    prompt: String(prompt || ''),
    // Engine: 只剩 Claude（Gemini 引擎 2026-11-04 随 Gemini 对话下线）。model/effort are validated
    // against the whitelists in the route; null here means "use the server default".
    agent: 'claude',
    model: model ? String(model) : null,
    effort: effort ? String(effort) : null,
    search: !!search,
    // Code 侧：工作文件夹（null = 身份的默认工作空间）、每次开新 worktree（branch = 从哪个分支切，null = 按设置）、
    // 权限模式（null = 跟设置默认）、Fast、会话方式（new 每次新会话 / continue 接着上次那个会话）、跑完通知。
    cwd: null, worktree: false, branch: null, permissionMode: null, fast: false, sessionMode: 'new', notify: false, shape: null,
    schedule: sched,
    enabled: on,
    createdAt: Date.now(),
    lastRun: null,
    lastStatus: null,
    lastSessionId: null,
    lastPreview: null,
    runs: [],
    nextRun: on ? computeNextRun(sched) : null,
    ...settingsFields(input),
    threadSessionId: null,
  };
  items.push(r);
  persist(dir, items);
  return r;
}

export function update(dir, id, patch = {}) {
  const items = load(dir);
  const r = items.find((x) => x.id === id);
  if (!r) return null;
  if (patch.name != null) r.name = String(patch.name).trim().slice(0, 120) || r.name;
  if (patch.prompt != null) r.prompt = String(patch.prompt);
  if (patch.schedule != null) r.schedule = normSchedule(patch.schedule);
  if (patch.enabled != null) r.enabled = !!patch.enabled;
  // 引擎只剩 Claude：残留的 Gemini 任务被编辑时（改引擎 / 重新启用）一并转成 Claude，停用标记去掉
  if (patch.agent != null || (patch.enabled === true && r.agent === 'vertex')) { r.agent = 'claude'; delete r.retired; }
  if ('model' in patch) r.model = patch.model ? String(patch.model) : null;
  if ('effort' in patch) r.effort = patch.effort ? String(patch.effort) : null;
  if (patch.search != null) r.search = !!patch.search;
  Object.assign(r, settingsFields(patch, r));
  // missedAt：服务端停着 / 睡着时错过的那次的计划时刻（启动时 reconcile 记下；界面在它晚于 lastRun 时标「已错过」）
  for (const k of ['lastRun', 'lastStatus', 'lastSessionId', 'lastPreview', 'nextRun', 'missedAt', 'threadSessionId']) {
    if (k in patch) r[k] = patch[k];
  }
  if ((patch.schedule != null || patch.enabled != null) && !('nextRun' in patch)) {
    r.nextRun = r.enabled ? computeNextRun(r.schedule) : null;
  }
  persist(dir, items);
  return r;
}

// 复制一份（官方 Duplicate）：设置全带上、名字加「副本」，默认停用，历史与会话不带。
export function duplicate(dir, id) {
  const src = get(dir, id);
  if (!src) return null;
  const { id: _i, runs: _r, lastRun: _a, lastStatus: _b, lastSessionId: _c, lastPreview: _d, missedAt: _e, threadSessionId: _f, nextRun: _g, createdAt: _h, ...rest } = src;
  return create(dir, { ...rest, name: (src.name + ' 副本').slice(0, 120), enabled: false });
}

// ---- 运行记录 ----
// run = { id, at, trigger: 'schedule' | 'manual', status: 'running' | 'ok' | 'error' | 'stopped' | 'skipped',
//         sessionId?, preview?, endedAt?, cost? }。最新的在前，留 RUNS_KEPT 条。
export function startRun(dir, id, run) {
  const items = load(dir);
  const r = items.find((x) => x.id === id);
  if (!r) return null;
  const rec = { id: randomUUID().slice(0, 8), at: Date.now(), status: 'running', ...run };
  r.runs = [rec, ...(Array.isArray(r.runs) ? r.runs : [])].slice(0, RUNS_KEPT);
  // 老字段（agent 接口、管理台还在读）跟着最新一次走；跳过的那次不算「上次运行」
  if (rec.status !== 'skipped') { r.lastRun = rec.at; r.lastStatus = rec.status === 'stopped' ? 'error' : rec.status; if ('preview' in rec) r.lastPreview = rec.preview || ''; }
  persist(dir, items);
  return rec;
}

export function patchRun(dir, id, runId, patch) {
  const items = load(dir);
  const r = items.find((x) => x.id === id);
  if (!r) return null;
  const rec = (r.runs || []).find((x) => x.id === runId);
  if (!rec) return null;
  Object.assign(rec, patch);
  if (r.lastRun === rec.at) {
    if (patch.status) r.lastStatus = patch.status === 'stopped' ? 'error' : patch.status;
    if ('sessionId' in patch) r.lastSessionId = patch.sessionId || null;
    if ('preview' in patch) r.lastPreview = patch.preview || '';
  }
  persist(dir, items);
  return rec;
}

export function remove(dir, id) {
  const items = load(dir);
  const i = items.findIndex((x) => x.id === id);
  if (i < 0) return false;
  items.splice(i, 1);
  persist(dir, items);
  return true;
}

// Enabled routines whose next fire is due (within this owner's dir).
export function due(dir, now = Date.now()) {
  return load(dir).filter((r) => r.enabled && r.nextRun && r.nextRun <= now);
}
