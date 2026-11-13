// 子 agent 调用策略（2026-11-11）：设置 › Claude › 对话 › 子 agent 调用策略的数据层。按身份一份，存在 <dataDir>/dispatch-policy.json
//（管理员的 dataDir = 数据根）：
//   { v:1, enabled, scope:{ workflow, subagent, session }, allowThirdParty, activeId, strategies:[…], rev }
//   enabled          总开关；关 = 完全走 Claude Code 原生（不拼调度提示、不挂上游路由、start_session 不解析 auto 档）
//   scope            生效范围：workflow = 工作流 / Ultracode 的 agent()；subagent = Agent 工具派的子 agent；session = start_session 的 auto:<档>
//   allowThirdParty  候选里要不要非 Claude 模型（关 = 只剩 Claude，第三方的档位自定义回落图谱）
//   strategies       可命名的多套策略，只有 activeId 那套生效：
//                    { id:'s-<8 位>', name, floors:{ top, hard, normal, light }, overrides:{ … }, note, createdAt, updatedAt }
//                    floors[k]   这一档的智力分判定线（0–100，一位小数）；null = 默认线（runtime/model-ratings.mjs 的 defaultFloors）
//                    overrides[k] null | { model, effort }：手动指定这一档，压过图谱。model 写别名 opus / sonnet / haiku / fable
//                                或 custom:<服务 id>:<型号>；effort '' = 不指定（用模型默认）
//                    note        口述备注，原样进系统提示，优先级最高
//   rev              每次写 +1（同账号其它设备据此重新取）
//
// 权限：管理员或有命令行（shell）的身份才能写，其余写操作抛 403；没权限的、快照访客、没有 dataDir 的读到一份 enabled:false 的只读默认。
// 迁移：文件不存在时现造一份默认（一套「默认」，备注取这个身份旧设置 subagentDispatch 的值——直接读盘上的 claude-settings.json，
// 那个键已从设置注册表里删掉，下一次写设置就没了）。旧备注非空时第一次读就落盘，免得被设置写回冲掉；为空的只在内存里造，第一次写才落盘。
// resolveAuto（model-ratings.mjs）只拿得到 owner 键（customOwner(ctx)），所以 claude.mjs 每轮用 notePolicyOwner 登记 owner → 身份。

import { statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from '../jsonfile.mjs';
import { ROOT } from '../config/index.mjs';
import { HOST_OWNER } from './principal.mjs';
import { TIER_ID_RE } from '../model-knowledge/knowledge.mjs';

export const TIER_KEYS = Object.freeze(['top', 'hard', 'normal', 'light']);
export const MAX_STRATEGIES = 12;
export const NAME_MAX = 24;
export const NOTE_MAX = 2000;
export const DEFAULT_SCOPE = Object.freeze({ workflow: true, subagent: true, session: false });
const FILE = 'dispatch-policy.json';
const LEGACY_FILE = 'claude-settings.json';
const DEFAULT_ID = 's-00000000';   // 迁移出来的那套固定 id：没落盘时每次现造也是同一个 id，界面按 id 改得上
const DEFAULT_NAME = '默认';
const ID_RE = /^s-[0-9a-f]{8}$/;
const CLAUDE_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable']);
const CUSTOM_MODEL_RE = /^custom:p-[0-9a-f]{6,12}:\S.*$/;
const MODEL_MAX = 300;
const POLICY_KEYS = ['enabled', 'scope', 'allowThirdParty', 'activeId'];

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => [...s].slice(0, n).join('');
const charLen = (s) => [...s].length;
const round1 = (x) => Math.round(x * 10) / 10;
const cleanText = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const cleanName = (v) => cleanText(v).replace(/[\r\n\t]+/g, ' ').trim();

/** 能不能改调用策略：管理员，或有命令行的身份（快照 / 分享 / 没有 dataDir 的一律不能）。 */
export function canEditPolicy(ctx) {
  return !!(ctx && ctx.dataDir && !ctx.snap && ctx.kind !== 'share' && (ctx.kind === 'admin' || ctx.shell === true));
}

const fileOf = (ctx) => path.resolve(ctx.dataDir, FILE);
const nullTiers = () => Object.fromEntries(TIER_KEYS.map((k) => [k, null]));

function blankStrategy(id, name, note, now) {
  return { id, name, floors: nullTiers(), overrides: nullTiers(), note, createdAt: now, updatedAt: now };
}

function defaultPolicy(note = '', now = Date.now()) {
  return {
    v: 1, enabled: true, scope: { ...DEFAULT_SCOPE }, allowThirdParty: true, activeId: DEFAULT_ID,
    strategies: [blankStrategy(DEFAULT_ID, DEFAULT_NAME, note, now)], rev: 0,
  };
}

// 没权限的身份拿到的只读默认：总开关关着（调度完全走 Claude Code 原生）
function readOnlyPolicy() { return { ...defaultPolicy('', 0), enabled: false }; }

// 旧设置「子 agent 调度偏好」（subagentDispatch）的原值：直接读盘，不经设置注册表（那个键已经删了）
function legacyNote(ctx) {
  const j = readJson(path.join(ctx.dataDir, LEGACY_FILE), null);
  const v = j && isObj(j.values) ? j.values.subagentDispatch : '';
  return typeof v === 'string' ? clip(cleanText(v).trim(), NOTE_MAX) : '';
}

// —— 规范化 ——
// 存盘内容：宽松（坏的字段回默认，不抛）；写入的补丁：严格（不合规抛 400，见下面的 parse*）

function looseFloor(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? round1(v) : null; }
function looseOverride(v) {
  if (!isObj(v) || typeof v.model !== 'string') return null;
  const model = v.model.trim();
  if (!model || model.length > MODEL_MAX || !(CLAUDE_ALIASES.includes(model) || CUSTOM_MODEL_RE.test(model))) return null;
  const effort = typeof v.effort === 'string' ? v.effort.trim() : '';
  return { model, effort: effort === '' || TIER_ID_RE.test(effort) ? effort : '' };
}

/** 一套策略的宽松规范化（坏字段回默认、不抛）：存盘内容和不落盘的实时预览用。id 缺了 / 不合规 → 'draft'。 */
export function sanitizeStrategy(s) {
  const x = isObj(s) ? s : {};
  const floors = nullTiers(), overrides = nullTiers();
  for (const k of TIER_KEYS) {
    floors[k] = looseFloor(isObj(x.floors) ? x.floors[k] : null);
    overrides[k] = looseOverride(isObj(x.overrides) ? x.overrides[k] : null);
  }
  const name = clip(cleanName(x.name), NAME_MAX);
  return {
    id: typeof x.id === 'string' && ID_RE.test(x.id) ? x.id : 'draft',
    name: name || DEFAULT_NAME, floors, overrides,
    note: typeof x.note === 'string' ? clip(cleanText(x.note), NOTE_MAX) : '',
    createdAt: Number.isFinite(x.createdAt) ? x.createdAt : 0,
    updatedAt: Number.isFinite(x.updatedAt) ? x.updatedAt : 0,
  };
}

function normalizePolicy(j) {
  if (!isObj(j) || !Array.isArray(j.strategies)) return null;
  const strategies = [], seen = new Set();
  for (const raw of j.strategies) {
    if (!isObj(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    strategies.push(sanitizeStrategy(raw));
    if (strategies.length >= MAX_STRATEGIES) break;
  }
  if (!strategies.length) return null;
  const sc = isObj(j.scope) ? j.scope : {};
  const scope = {};
  for (const k of Object.keys(DEFAULT_SCOPE)) scope[k] = typeof sc[k] === 'boolean' ? sc[k] : DEFAULT_SCOPE[k];
  return {
    v: 1, enabled: j.enabled !== false, scope, allowThirdParty: j.allowThirdParty !== false,
    activeId: strategies.some((s) => s.id === j.activeId) ? j.activeId : strategies[0].id,
    strategies, rev: Number.isInteger(j.rev) && j.rev >= 0 ? j.rev : 0,
  };
}

// —— 读写（内存缓存按文件路径，文件被外部改了按 mtime 重读）——
const cache = new Map();   // 文件 → { mtime, policy }
const mtimeOf = (file) => { try { return statSync(file).mtimeMs; } catch { return -1; } };

// 写盘 + 读回核对：jsonfile 的 writeJson 失败只记日志，这里读回来对不上 rev 就当写失败抛出去
function persist(file, policy) {
  writeJson(file, policy, 2);
  const back = readJson(file, null);
  if (!back || back.rev !== policy.rev || !Array.isArray(back.strategies) || back.strategies.length !== policy.strategies.length) {
    throw fail('子 agent 调用策略没能写进磁盘（看服务端日志里的 [jsonfile] 那行）', 500);
  }
  cache.set(file, { mtime: mtimeOf(file), policy });
}

function load(ctx) {
  const file = fileOf(ctx);
  const mt = mtimeOf(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === mt) return hit.policy;
  let policy = mt >= 0 ? normalizePolicy(readJson(file, null)) : null;
  if (!policy) {
    if (mt >= 0) console.error('[dispatch-policy] 策略文件读不出来，先用默认（下次保存会覆盖它）：', file);
    policy = defaultPolicy(legacyNote(ctx));
    if (mt < 0 && policy.strategies[0].note) {
      try { persist(file, policy); return policy; }
      catch (e) { console.error('[dispatch-policy] 旧的子 agent 调度偏好迁不进策略文件：', e?.message || e); }
    }
  }
  cache.set(file, { mtime: mt, policy });
  return policy;
}

/** 规范化后的策略文件（含迁移）；没权限的 / 快照访客 / 没有 dataDir → 一份 enabled:false 的只读默认。回副本，随便改。 */
export function policyFor(ctx) {
  return structuredClone(canEditPolicy(ctx) ? load(ctx) : readOnlyPolicy());
}

/** 生效的那套（activeId 对不上时取第一套）；没有 → null。 */
export function activeStrategy(policy) {
  const list = policy && Array.isArray(policy.strategies) ? policy.strategies : [];
  return list.find((s) => s.id === policy.activeId) || list[0] || null;
}

// —— owner → 身份（resolveAuto 只拿得到 owner）——
const owners = new Map();   // owner → { kind, shell, dataDir, snap }
/** claude.mjs 每轮调：登记这个 owner（customOwner(ctx) 的值）对应的身份，resolveAuto 按它找策略文件。 */
export function notePolicyOwner(owner, ctx) {
  if (!owner || typeof owner !== 'string' || !ctx || !ctx.dataDir) return;
  owners.set(owner, { kind: ctx.kind, shell: ctx.shell === true, dataDir: ctx.dataDir, snap: ctx.snap ? { ...ctx.snap } : undefined });
}
/** owner → 它最近登记的身份的策略；主机（HOST_OWNER）没登记过时直接读数据根的文件；别的没登记过 → null（按默认阶梯）。 */
export function policyOfOwner(owner) {
  if (!owner) return null;
  const reg = owners.get(owner) || (owner === HOST_OWNER ? { kind: 'admin', shell: true, dataDir: ROOT } : null);
  return reg ? policyFor(reg) : null;
}

// —— 变更通知 ——
const listeners = new Set();
/** 写成功后调 fn(ctx, policy)（路由用它往总线推 claude.dispatch）。返回取消订阅的函数。 */
export function onPolicyChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ctx, policy) {
  for (const fn of listeners) {
    try { fn(ctx, structuredClone(policy)); } catch (e) { console.error('[dispatch-policy] listener:', e?.message || e); }
  }
}

function requireEdit(ctx) {
  if (!canEditPolicy(ctx)) throw fail('这个身份不能修改子 agent 调用策略', 403);
}
// 在当前文件的副本上改，mutate 回 false = 没变化（不写、不加 rev）
function commit(ctx, mutate) {
  requireEdit(ctx);
  const file = fileOf(ctx);
  const next = structuredClone(load(ctx));
  const r = mutate(next);
  if (r === false) return { policy: structuredClone(load(ctx)), changed: false, extra: undefined };
  next.rev += 1;
  persist(file, next);
  emit(ctx, next);
  return { policy: structuredClone(next), changed: true, extra: r };
}

// —— 严格解析（写入用）——
function parseFloor(k, v) {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw fail(`「${k}」档的判定线要是 0–100 之间的数（或 null = 默认线）`);
  return round1(v);
}
function parseOverride(k, v) {
  if (v === null) return null;
  if (!isObj(v)) throw fail(`「${k}」档的自定义要是 { model, effort } 或 null`);
  const model = typeof v.model === 'string' ? v.model.trim() : '';
  if (!model) return null;
  if (model.length > MODEL_MAX || !(CLAUDE_ALIASES.includes(model) || CUSTOM_MODEL_RE.test(model))) {
    throw fail(`「${k}」档指定的模型「${clip(model, 60)}」写法不对：Claude 写 opus / sonnet / haiku / fable，第三方写 custom:<服务 id>:<型号>`);
  }
  if (v.effort != null && typeof v.effort !== 'string') throw fail(`「${k}」档的推理强度要是字符串（'' = 不指定）`);
  const effort = typeof v.effort === 'string' ? v.effort.trim() : '';
  if (effort && !TIER_ID_RE.test(effort)) throw fail(`「${k}」档的推理强度「${clip(effort, 30)}」不合规`);
  return { model, effort };
}
function mergeTiers(cur, patch, what, parse) {
  if (patch === undefined) return cur;
  if (!isObj(patch)) throw fail(`${what}要是 { top, hard, normal, light } 形状的对象`);
  const out = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (!TIER_KEYS.includes(k)) throw fail(`${what}里没有「${clip(k, 20)}」这一档（只有 top / hard / normal / light）`);
    out[k] = parse(k, v);
  }
  return out;
}
// 判定线从高到低：top ≥ hard ≥ normal ≥ light（只比有值的，null 的跳过）
function checkFloors(floors) {
  let prev = null;
  for (const k of TIER_KEYS) {
    const v = floors[k];
    if (v == null) continue;
    if (prev && v > prev.v) throw fail(`判定线要从高到低：「${prev.k}」${prev.v} 不能低于「${k}」${v}`);
    prev = { k, v };
  }
}
function parseName(v) {
  if (typeof v !== 'string') throw fail('策略名要是字符串');
  const name = cleanName(v);
  if (!name) throw fail('策略名不能为空');
  if (charLen(name) > NAME_MAX) throw fail(`策略名最多 ${NAME_MAX} 个字`);
  return name;
}
function parseNote(v) {
  if (typeof v !== 'string') throw fail('备注要是字符串');
  const note = cleanText(v);
  if (charLen(note) > NOTE_MAX) throw fail(`备注最多 ${NOTE_MAX} 字`);
  return note;
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 改总开关 / 范围 / 是否用非 Claude / 切换生效策略：patch = { enabled?, scope?:{…部分}, allowThirdParty?, activeId? } → 新策略文件。 */
export function updatePolicy(ctx, patch) {
  requireEdit(ctx);
  if (!isObj(patch)) throw fail('patch 要是对象');
  for (const k of Object.keys(patch)) if (!POLICY_KEYS.includes(k)) throw fail(`不认识的字段「${clip(k, 30)}」（只能改 enabled / scope / allowThirdParty / activeId）`);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw fail('enabled 要是 true / false');
  if (patch.allowThirdParty !== undefined && typeof patch.allowThirdParty !== 'boolean') throw fail('allowThirdParty 要是 true / false');
  if (patch.scope !== undefined) {
    if (!isObj(patch.scope)) throw fail('scope 要是对象：{ workflow?, subagent?, session? }');
    for (const [k, v] of Object.entries(patch.scope)) {
      // 按自有键认：`in` 会放过 constructor / toString 这些原型上的名字
      if (!Object.hasOwn(DEFAULT_SCOPE, k)) throw fail(`生效范围里没有「${clip(k, 30)}」（只有 workflow / subagent / session）`);
      if (typeof v !== 'boolean') throw fail(`生效范围「${k}」要是 true / false`);
    }
  }
  if (patch.activeId !== undefined && typeof patch.activeId !== 'string') throw fail('activeId 要是策略 id');
  return commit(ctx, (p) => {
    const before = JSON.stringify(p);
    if (patch.enabled !== undefined) p.enabled = patch.enabled;
    if (patch.allowThirdParty !== undefined) p.allowThirdParty = patch.allowThirdParty;
    if (patch.scope) for (const k of Object.keys(DEFAULT_SCOPE)) if (Object.hasOwn(patch.scope, k)) p.scope[k] = patch.scope[k];
    if (patch.activeId !== undefined) {
      if (!p.strategies.some((s) => s.id === patch.activeId)) throw fail('没有这套策略（可能已经删了）', 404);
      p.activeId = patch.activeId;
    }
    return JSON.stringify(p) !== before;
  }).policy;
}

/**
 * 新建或修改一套策略 → { policy, strategy }。
 *   s.id 有 = 改那一套（只改给了的字段：name / floors / overrides / note；floors、overrides 按档合并，null = 回默认）；
 *   没有 = 新建：以 copyOf（第三个参数或 s.copyOf）那套为底复制，没给就从空白开始；名字没给 → 「<原名> 副本」/「新策略」。
 * 判定线合并后要满足 top ≥ hard ≥ normal ≥ light，不满足抛 400。
 */
export function saveStrategy(ctx, s, { copyOf } = {}) {
  requireEdit(ctx);
  if (!isObj(s)) throw fail('strategy 要是对象');
  const src = copyOf ?? s.copyOf;
  if (s.id != null && typeof s.id !== 'string') throw fail('策略 id 要是字符串');
  if (src != null && typeof src !== 'string') throw fail('copyOf 要是策略 id');
  const r = commit(ctx, (p) => {
    const now = Date.now();
    let cur, created = false;
    if (s.id) {
      cur = p.strategies.find((x) => x.id === s.id);
      if (!cur) throw fail('没有这套策略（可能已经删了）', 404);
    } else {
      if (p.strategies.length >= MAX_STRATEGIES) throw fail(`最多 ${MAX_STRATEGIES} 套策略，先删掉不用的`);
      let base = null;
      if (src) {
        base = p.strategies.find((x) => x.id === src);
        if (!base) throw fail('要复制的那套策略不存在（可能已经删了）', 404);
      }
      const taken = new Set(p.strategies.map((x) => x.id));
      let id;
      do id = 's-' + randomBytes(4).toString('hex'); while (taken.has(id));
      cur = base
        ? { ...structuredClone(base), id, name: clip(`${base.name} 副本`, NAME_MAX), createdAt: now, updatedAt: now }
        : blankStrategy(id, '新策略', '', now);
      created = true;
    }
    const next = {
      ...cur,
      name: s.name !== undefined ? parseName(s.name) : cur.name,
      floors: mergeTiers(cur.floors, s.floors, '判定线 floors', parseFloor),
      overrides: mergeTiers(cur.overrides, s.overrides, '档位自定义 overrides', parseOverride),
      note: s.note !== undefined ? parseNote(s.note) : cur.note,
    };
    checkFloors(next.floors);
    const strip = ({ updatedAt, ...rest }) => rest;
    if (!created && sameJson(strip(next), strip(cur))) return false;   // 什么都没改：不写、不加 rev
    next.updatedAt = now;
    if (created) p.strategies.push(next);
    else p.strategies[p.strategies.indexOf(cur)] = next;
    return { id: next.id };
  });
  const id = r.extra ? r.extra.id : s.id;
  return { policy: r.policy, strategy: r.policy.strategies.find((x) => x.id === id) || null };
}

/** 删一套（生效中的不能删，先切换）→ 新策略文件。 */
export function deleteStrategy(ctx, id) {
  requireEdit(ctx);
  if (typeof id !== 'string' || !id) throw fail('要删的策略 id 没给');
  return commit(ctx, (p) => {
    const i = p.strategies.findIndex((x) => x.id === id);
    if (i < 0) throw fail('没有这套策略（可能已经删了）', 404);
    if (p.activeId === id) throw fail('生效中的策略不能删，先切换到别的那套');
    if (p.strategies.length <= 1) throw fail('至少要留一套策略');
    p.strategies.splice(i, 1);
    return true;
  }).policy;
}

export function _resetPolicyForTests() { cache.clear(); owners.clear(); }
