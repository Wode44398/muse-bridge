// 审计与用量事件：两份按天的 JSONL（开源路线 C12）。
//
//   <usersRoot>/_system/audit/audit-YYYY-MM-DD.jsonl
//       谁对谁做了什么：{ t, actor, action, target, scope, via?, meta? }
//       管理员代聊、代答审批、查看他人数据、改额度、改档位 / 角色、建删账号都必须写。
//   <usersRoot>/_system/usage-events/usage-YYYY-MM-DD.jsonl
//       每一轮用了多少：{ t, actor, scope, billedTo, workspace, accountId, model, tokens, cost, source }
//       现在的 usage.json 只按人、按天累计，管理员不记账；这份事件流是将来按组 / 按号 / 按模型分摊的底账。
//       billedTo = 这一轮记到谁的账上（owner 键，quota.billingUser 的结果；管理员自己的轮为空）。它和 scope 不总相同：
//       快照访客那一轮的 scope 是 'c:<令牌>'（数据和池归那个快照），账却记给铸快照的人。按人分摊一律按 billedTo 汇总。
//
// 放 _system：服务进程独占，不在任何人的工作空间里（agent 的工具围栏够不着）。
// 只记元数据：不记对话内容、令牌、密码、文件内容。meta 只收 SAFE_META 里的键，值截短。
// 写不进去不能拖垮业务：所有写函数永不抛（返回 Promise，调用方不用 await）。

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { SYSTEM_DIR } from '../config/index.mjs';
import { actorOf, scopeOf, ownerKey } from './principal.mjs';

export const AUDIT_DIR = path.join(SYSTEM_DIR, 'audit');
export const USAGE_EVENT_DIR = path.join(SYSTEM_DIR, 'usage-events');

// 建过的目录记一下，免得每条都 mkdir；建失败不记（下次再试）。运行中目录被删掉的情况见 appendLine。
const ready = new Map();
const ensureDir = (dir) => {
  if (!ready.has(dir)) ready.set(dir, mkdir(dir, { recursive: true }).catch(() => { ready.delete(dir); }));
  return ready.get(dir);
};

// 本地日期（与 device-audit.mjs 同一个写法）。
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const str = (v, max = 200) => String(v ?? '').slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// meta 白名单：只放判断「做了什么」需要的字段。token / password / label 这类一律不收。
//   multiUser = 「给别人用」总开关开还是关；hidden = 管理员这次只拿到了元数据（成员没允许看内容）。
//   额度策略（/api/admin/policy，S2-6）：maxParallelPerUser / maxRoutinesPerUser = 每人并发与定时任务数，
//   member = 成员的高消耗功能开关（{ fast, ultracode, … } 布尔），preset = 「改用推荐值」；days = 邀请码有效天数；
//   visibility = 会话可见性（预留，runtime/session-visibility.mjs）。都是数字 / 布尔 / 枚举，不涉密。
//   接口加了新的可改字段要同步进这里：白名单外的键会被静默丢掉，审计就只剩一个动作名。
const SAFE_META = new Set([
  'agent', 'sessionId', 'qid', 'what', 'tier', 'role', 'disabled', 'snapshot', 'service', 'purge',
  'quota', 'agents', 'id', 'all', 'register', 'maxUserTurns', 'timezone', 'enabled', 'returnToPrimary',
  'seamless', 'delta', 'kind', 'count', 'mode', 'ack', 'newName', 'multiUser', 'hidden',
  'maxParallelPerUser', 'maxRoutinesPerUser', 'member', 'preset', 'days', 'visibility',
]);
// 邀请码这类「本身就是凭据」的值不进文件，只留哈希前缀（codeHash）：发码与作废那两条对得上，看不出码是什么。
const hashHint = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 10);
function safeValue(v, depth = 0) {
  if (v == null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.slice(0, 120);
  if (depth > 1) return null;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => safeValue(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 20)) if (typeof k === 'string' && k.length <= 40) o[k] = safeValue(x, depth + 1);
    return o;
  }
  return null;
}
export function safeMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(meta)) if (SAFE_META.has(k) && v !== undefined) out[k] = safeValue(v);
  if (typeof meta.code === 'string' && meta.code) out.codeHash = hashHint(meta.code);
  return Object.keys(out).length ? out : undefined;
}

async function appendLine(dir, prefix, obj) {
  const file = path.join(dir, `${prefix}-${stamp()}.jsonl`);
  const line = JSON.stringify(obj) + '\n';
  try {
    await ensureDir(dir);
    try {
      await appendFile(file, line, 'utf8');
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
      // 目录在运行中被删了（管理员可以直接删 audit/ 或 usage-events/）：重建再写一次，不能从此静默停写
      ready.delete(dir);
      await ensureDir(dir);
      await appendFile(file, line, 'utf8');
    }
    return true;
  } catch { return false; }
}

// 落一条审计。actor / scope 是 owner 键（principal.mjs）；target 是被操作的对象（owner 键、会话、账号 id…）。
export function appendAudit({ actor, action, target = '', scope = '', via = '', meta } = {}) {
  if (!action) return Promise.resolve(false);
  const e = { t: new Date().toISOString(), actor: str(actor, 120), action: str(action, 64), target: str(target), scope: str(scope, 120) };
  if (via) e.via = str(via, 40);
  const m = safeMeta(meta);
  if (m) e.meta = m;
  return appendLine(AUDIT_DIR, 'audit', e);
}

// 落一条用量事件（每轮收尾一次）。tokens / cost 是这一轮的增量，不是会话累计值。
// billedTo：记到谁的账上（owner 键）。调用方按 quota.billingUser(ctx) 给：billTo ? ownerKey('user', billTo) : ''。
// 不要拿 scope 代替——快照轮的 scope 是快照令牌，计费人是铸造者。
export function appendUsageEvent({ actor, scope, billedTo = '', workspace = '', accountId = '', model = '', tokens = 0, cost = 0, source = '' } = {}) {
  const e = {
    t: new Date().toISOString(), actor: str(actor, 120), scope: str(scope || actor, 120), billedTo: str(billedTo, 120), workspace: str(workspace, 400),
    accountId: str(accountId, 64), model: str(model, 80), tokens: num(tokens), cost: num(cost), source: str(source, 32),
  };
  return appendLine(USAGE_EVENT_DIR, 'usage', e);
}

// 一轮收尾时的写法（agents/claude.mjs、runtime/routines-runner.mjs 在记 usage.json 的同一处调）：
// actor / scope 从 ctx 取，billTo 是 quota.billingUser(ctx) 的结果（账号 id；空 = 不记账的轮）。永不抛。
// 今天只在计费的轮上调（与 usage.json 同一口径）；管理员自己的轮要等能按轮取到准确的花费增量再补。
export function noteTurnUsage(ctx, { billTo = '', accountId = '', model = '', tokens = 0, cost = 0, source = '' } = {}) {
  try {
    return appendUsageEvent({
      actor: actorOf(ctx), scope: scopeOf(ctx), billedTo: billTo ? ownerKey('user', billTo) : '',
      workspace: (ctx && ctx.cwd) || '', accountId, model, tokens, cost, source,
    });
  } catch { return Promise.resolve(false); }
}

// 读最近的记录（新的在前），给控制台与测试用。filter(e) 返回 false 的跳过；最多翻最近 days 天的文件。
async function readRecent(dir, prefix, { limit = 200, days = 7, filter = null } = {}) {
  const out = [];
  let files = [];
  const re = new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.jsonl$`);
  try { files = (await readdir(dir)).filter((f) => re.test(f)).sort().reverse(); } catch { return out; }
  for (const f of files.slice(0, days)) {
    let text = '';
    try { text = await readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').filter(Boolean).reverse()) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (filter && !filter(e)) continue;
      out.push(e);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
export const readAudit = (opts) => readRecent(AUDIT_DIR, 'audit', opts);
export const readUsageEvents = (opts) => readRecent(USAGE_EVENT_DIR, 'usage', opts);
