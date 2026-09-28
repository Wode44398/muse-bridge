// Routines: scheduled, unattended Claude runs. Persistence + next-run math only;
// the scheduler loop + execution live in runtime/routines-runner.mjs.
//
// Multi-user: every function takes the OWNER's data dir (admin -> ROOT; user ->
// their .bridge), so each account has its own routines.json. Schedules use friendly
// presets (daily / weekdays / hourly) in the server's LOCAL timezone (China time).
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJson } from './jsonfile.mjs';

const TYPES = new Set(['daily', 'weekdays', 'weekly', 'hourly']);
const fileIn = (dir) => path.join(dir, 'routines.json');

function load(dir) {
  const f = fileIn(dir);
  if (!existsSync(f)) return [];
  try { const v = JSON.parse(readFileSync(f, 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}
function persist(dir, list) {
  writeJson(fileIn(dir), list, 2); // atomic; ensures dir; pretty-printed
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

function normSchedule(s) {
  const type = TYPES.has(s && s.type) ? s.type : 'daily';
  const minute = clampInt(s && s.minute, 0, 59, 0);
  if (type === 'hourly') return { type, minute };
  const hour = clampInt(s && s.hour, 0, 23, 9);
  // weekly: a specific weekday (0=Sun..6=Sat, JS getDay) at hour:minute.
  if (type === 'weekly') return { type, weekday: clampInt(s && s.weekday, 0, 6, 1), hour, minute };
  return { type, hour, minute };
}

// Next fire time (ms epoch) at or after `from`, in local time.
export function computeNextRun(schedule, from = Date.now()) {
  const s = normSchedule(schedule);
  if (s.type === 'hourly') {
    const n = new Date(from);
    n.setSeconds(0, 0);
    n.setMinutes(s.minute);
    if (n.getTime() <= from) n.setHours(n.getHours() + 1);
    return n.getTime();
  }
  const n = new Date(from);
  n.setHours(s.hour, s.minute, 0, 0);
  if (n.getTime() <= from) n.setDate(n.getDate() + 1);
  if (s.type === 'weekdays') {
    while (n.getDay() === 0 || n.getDay() === 6) n.setDate(n.getDate() + 1);
  }
  if (s.type === 'weekly') {
    while (n.getDay() !== s.weekday) n.setDate(n.getDate() + 1);
  }
  return n.getTime();
}

export function list(dir) { return load(dir); }
export function get(dir, id) { return load(dir).find((r) => r.id === id) || null; }

export function create(dir, { name, prompt, schedule, enabled = true, agent, model, effort, search } = {}) {
  const items = load(dir);
  const sched = normSchedule(schedule);
  const on = enabled !== false;
  const r = {
    id: randomUUID(),
    name: String(name || '').trim().slice(0, 120) || '未命名路由',
    prompt: String(prompt || ''),
    // Engine: which agent runs this routine + its model/effort. agent 'vertex' ->
    // Gemini via Vertex; anything else (incl. legacy routines with no agent) -> Claude.
    // model/effort are validated against the per-agent whitelists in the route; null
    // here means "use the server default".
    agent: agent === 'vertex' ? 'vertex' : 'claude',
    model: model ? String(model) : null,
    effort: effort ? String(effort) : null,
    search: !!search,
    schedule: sched,
    enabled: on,
    createdAt: Date.now(),
    lastRun: null,
    lastStatus: null,
    lastSessionId: null,
    lastPreview: null,
    nextRun: on ? computeNextRun(sched) : null,
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
  if (patch.agent != null) r.agent = patch.agent === 'vertex' ? 'vertex' : 'claude';
  if ('model' in patch) r.model = patch.model ? String(patch.model) : null;
  if ('effort' in patch) r.effort = patch.effort ? String(patch.effort) : null;
  if (patch.search != null) r.search = !!patch.search;
  for (const k of ['lastRun', 'lastStatus', 'lastSessionId', 'lastPreview', 'nextRun']) {
    if (k in patch) r[k] = patch[k];
  }
  if ((patch.schedule != null || patch.enabled != null) && !('nextRun' in patch)) {
    r.nextRun = r.enabled ? computeNextRun(r.schedule) : null;
  }
  persist(dir, items);
  return r;
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
