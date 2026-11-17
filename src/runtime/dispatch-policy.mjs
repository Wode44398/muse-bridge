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
//
// 作用域（2026-11-14）：同一套读写与校验按作用域各存一份，导出的函数都多一个 { scope }（缺省 'claude'，行为与之前完全一样）：
//   claude    <dataDir>/dispatch-policy.json            Claude 的子 agent（上面说的那份）
//   dimensio  <dataDir>/dispatch-policy.dimensio.json   dimensio 的子 agent（设置 › dimensio › 子 agent 调用策略）。多一个 follow：
//             false（默认，11-15 起；之前默认 true）= 用自己 strategies 里的；true = 生效的那一套策略（判定线 / 档位自定义 / 口述备注）
//             跟随 Claude 那份的 activeId 那套。总开关、生效范围永远是 dimensio 自己的。没有 allowThirdParty（11-15 去掉：dimensio 本来就是
//             多厂商，候选恒为它能用的全部模型；patch 带它 400，旧文件里留着的读的时候丢掉）。生效范围的三项对 dimensio：workflow = Workflow 工具脚本里的
//             agent()，subagent = Agent 工具，session = StartSession 的 model 写 auto:<档>。档位自定义的 model 写 dimensio 的
//             「厂商 id:型号」（zhipu:glm-5.3-flash、custom-1a2b3c4d:qwen3:32b）。没权限的身份读到的只读默认是 enabled:true、follow:false
//             （默认那一套 = 默认线，即改造前 dimensio 的默认：按默认阶梯派）。旧的 dimensio 偏好（按难度选型阶梯开关、子 agent 调度偏好文本）经
//             migrateDimensioLegacy 迁进来：文件还不存在、而旧偏好不是默认值时落盘一份（备注进自己那套，follow:false，原样保住改造前的行为）。
//   dimensio 实际用哪一套由 runtime/dispatch-dimensio.mjs 解析（Claude 写法的档位自定义映射成 dimensio 认得的写法）。

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
/** 策略文件的作用域：claude = Claude 的子 agent；dimensio = dimensio 的子 agent。 */
export const POLICY_SCOPES = Object.freeze(['claude', 'dimensio']);
const FILES = Object.freeze({ claude: 'dispatch-policy.json', dimensio: 'dispatch-policy.dimensio.json' });
const LEGACY_FILE = 'claude-settings.json';
const DEFAULT_ID = 's-00000000';   // 迁移出来的那套固定 id：没落盘时每次现造也是同一个 id，界面按 id 改得上
const DEFAULT_NAME = '默认';
const ID_RE = /^s-[0-9a-f]{8}$/;
const CLAUDE_ALIASES = Object.freeze(['opus', 'sonnet', 'haiku', 'fable']);
const CUSTOM_MODEL_RE = /^custom:p-[0-9a-f]{6,12}:\S.*$/;
// dimensio 的「厂商 id:型号」：自带厂商是 2–20 个小写字母（含本机 local），自定义服务是 custom-<8 位>；型号 id 自己可以带冒号
const DIM_MODEL_RE = /^(?:[a-z]{2,20}|custom-[a-f0-9]{8}):[^\s\u0000-\u001f]+$/;
const MODEL_MAX = 300;
const POLICY_KEYS = ['enabled', 'scope', 'allowThirdParty', 'activeId'];
const DIM_POLICY_KEYS = ['enabled', 'follow', 'scope', 'activeId'];   // dimensio 那份没有 allowThirdParty

/** 作用域参数 → 'claude' | 'dimensio'；不给 = claude，给了别的抛 400。 */
export function policyScope(v) {
  if (v === undefined || v === null || v === '') return 'claude';
  if (typeof v === 'string' && POLICY_SCOPES.includes(v)) return v;
  throw Object.assign(new Error(`没有「${String(v).slice(0, 20)}」这个作用域（只有 claude / dimensio）`), { status: 400 });
}
const modelOk = (model, scope) => (scope === 'dimensio' ? DIM_MODEL_RE.test(model) : CLAUDE_ALIASES.includes(model) || CUSTOM_MODEL_RE.test(model));

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

const fileOf = (ctx, scope = 'claude') => path.resolve(ctx.dataDir, FILES[scope]);
const nullTiers = () => Object.fromEntries(TIER_KEYS.map((k) => [k, null]));

function blankStrategy(id, name, note, now) {
  return { id, name, floors: nullTiers(), overrides: nullTiers(), note, createdAt: now, updatedAt: now };
}

// dimensio 那份多一个 follow（放在 enabled 后面，给人看的时候和总开关挨着）、没有 allowThirdParty
function defaultPolicy(note = '', now = Date.now(), scope = 'claude') {
  return {
    v: 1, enabled: true, ...(scope === 'dimensio' ? { follow: false } : {}), scope: { ...DEFAULT_SCOPE },
    ...(scope === 'dimensio' ? {} : { allowThirdParty: true }), activeId: DEFAULT_ID,
    strategies: [blankStrategy(DEFAULT_ID, DEFAULT_NAME, note, now)], rev: 0,
  };
}

// 没权限的身份拿到的只读默认：Claude 那份总开关关着（调度完全走 Claude Code 原生）；
// dimensio 那份开着、用自己默认那一套（= 改造前 dimensio 的默认：按默认阶梯派，这些身份本来就改不了它）
function readOnlyPolicy(scope = 'claude') {
  return scope === 'dimensio' ? defaultPolicy('', 0, 'dimensio') : { ...defaultPolicy('', 0), enabled: false };
}

// 旧设置「子 agent 调度偏好」（subagentDispatch）的原值：直接读盘，不经设置注册表（那个键已经删了）
function legacyNote(ctx) {
  const j = readJson(path.join(ctx.dataDir, LEGACY_FILE), null);
  const v = j && isObj(j.values) ? j.values.subagentDispatch : '';
  return typeof v === 'string' ? clip(cleanText(v).trim(), NOTE_MAX) : '';
}

// —— 规范化 ——
// 存盘内容：宽松（坏的字段回默认，不抛）；写入的补丁：严格（不合规抛 400，见下面的 parse*）

function looseFloor(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? round1(v) : null; }
function looseOverride(v, scope = 'claude') {
  if (!isObj(v) || typeof v.model !== 'string') return null;
  const model = v.model.trim();
  if (!model || model.length > MODEL_MAX || !modelOk(model, scope)) return null;
  const effort = typeof v.effort === 'string' ? v.effort.trim() : '';
  return { model, effort: effort === '' || TIER_ID_RE.test(effort) ? effort : '' };
}

/** 一套策略的宽松规范化（坏字段回默认、不抛）：存盘内容和不落盘的实时预览用。id 缺了 / 不合规 → 'draft'。scope 定档位自定义认哪种写法。 */
export function sanitizeStrategy(s, { scope = 'claude' } = {}) {
  const x = isObj(s) ? s : {};
  const floors = nullTiers(), overrides = nullTiers();
  for (const k of TIER_KEYS) {
    floors[k] = looseFloor(isObj(x.floors) ? x.floors[k] : null);
    overrides[k] = looseOverride(isObj(x.overrides) ? x.overrides[k] : null, scope);
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

function normalizePolicy(j, scope = 'claude') {
  if (!isObj(j) || !Array.isArray(j.strategies)) return null;
  const strategies = [], seen = new Set();
  for (const raw of j.strategies) {
    if (!isObj(raw) || typeof raw.id !== 'string' || !ID_RE.test(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    strategies.push(sanitizeStrategy(raw, { scope }));
    if (strategies.length >= MAX_STRATEGIES) break;
  }
  if (!strategies.length) return null;
  const sc = isObj(j.scope) ? j.scope : {};
  const sc2 = {};
  for (const k of Object.keys(DEFAULT_SCOPE)) sc2[k] = typeof sc[k] === 'boolean' ? sc[k] : DEFAULT_SCOPE[k];
  return {
    v: 1, enabled: j.enabled !== false, ...(scope === 'dimensio' ? { follow: j.follow === true } : {}), scope: sc2,
    ...(scope === 'dimensio' ? {} : { allowThirdParty: j.allowThirdParty !== false }),
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

function load(ctx, scope = 'claude') {
  const file = fileOf(ctx, scope);
  const mt = mtimeOf(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === mt) return hit.policy;
  let policy = mt >= 0 ? normalizePolicy(readJson(file, null), scope) : null;
  if (!policy) {
    if (mt >= 0) console.error('[dispatch-policy] 策略文件读不出来，先用默认（下次保存会覆盖它）：', file);
    // 旧设置的迁移只有 Claude 那份从盘上读；dimensio 的旧偏好在 harness 手里，由 migrateDimensioLegacy 送进来
    policy = defaultPolicy(scope === 'claude' ? legacyNote(ctx) : '', Date.now(), scope);
    if (mt < 0 && policy.strategies[0].note) {
      try { persist(file, policy); return policy; }
      catch (e) { console.error('[dispatch-policy] 旧的子 agent 调度偏好迁不进策略文件：', e?.message || e); }
    }
  }
  cache.set(file, { mtime: mt, policy });
  return policy;
}

/**
 * 规范化后的策略文件（含迁移）；没权限的 / 快照访客 / 没有 dataDir → 只读默认（Claude 那份 enabled:false，dimensio 那份见 readOnlyPolicy）。
 * 回副本，随便改。scope 缺省 = claude。
 */
export function policyFor(ctx, { scope = 'claude' } = {}) {
  const sc = policyScope(scope);
  return structuredClone(canEditPolicy(ctx) ? load(ctx, sc) : readOnlyPolicy(sc));
}

/** 这个身份的 dimensio 那份有没有落过盘（没落过 = 现造的默认，旧偏好还能迁进来）。 */
export function dimensioPolicyStored(ctx) {
  return !!(ctx && ctx.dataDir) && mtimeOf(fileOf(ctx, 'dimensio')) >= 0;
}

/**
 * 把 harness 送来的旧 dimensio 偏好迁进 dimensio 那份（只在文件还不存在、这个身份能改策略时做一次）：
 *   legacy = { ladder: 按难度选型阶梯开关, note: 子 agent 调度偏好文本 }
 *   ladder:false → enabled:false；note 非空 → 默认那套的备注（follow 本来就是 false：改造前 dimensio 用的就是默认线 + 自己这段话）。
 * 两样都是默认值就什么都不写（现造的默认就是它）。回 true = 落了盘。写盘失败只记日志（下次再迁）。
 */
export function migrateDimensioLegacy(ctx, legacy) {
  if (!canEditPolicy(ctx) || !isObj(legacy) || dimensioPolicyStored(ctx)) return false;
  const note = typeof legacy.note === 'string' ? clip(cleanText(legacy.note).trim(), NOTE_MAX) : '';
  const off = legacy.ladder === false;
  if (!note && !off) return false;
  const p = defaultPolicy(note, Date.now(), 'dimensio');
  if (off) p.enabled = false;
  p.rev = 1;
  try { persist(fileOf(ctx, 'dimensio'), p); }
  catch (e) { console.error('[dispatch-policy] 旧的 dimensio 调度偏好迁不进策略文件：', e?.message || e); return false; }
  emit(ctx, p, 'dimensio');
  return true;
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
/** 写成功后调 fn(ctx, policy, scope)（路由用它往总线推 claude.dispatch）。返回取消订阅的函数。 */
export function onPolicyChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ctx, policy, scope = 'claude') {
  for (const fn of listeners) {
    try { fn(ctx, structuredClone(policy), scope); } catch (e) { console.error('[dispatch-policy] listener:', e?.message || e); }
  }
}

function requireEdit(ctx) {
  if (!canEditPolicy(ctx)) throw fail('这个身份不能修改子 agent 调用策略', 403);
}
// 在当前文件的副本上改，mutate 回 false = 没变化（不写、不加 rev）
function commit(ctx, mutate, scope = 'claude') {
  requireEdit(ctx);
  const file = fileOf(ctx, scope);
  const next = structuredClone(load(ctx, scope));
  const r = mutate(next);
  if (r === false) return { policy: structuredClone(load(ctx, scope)), changed: false, extra: undefined };
  next.rev += 1;
  persist(file, next);
  emit(ctx, next, scope);
  return { policy: structuredClone(next), changed: true, extra: r };
}

// —— 严格解析（写入用）——
function parseFloor(k, v) {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) throw fail(`「${k}」档的判定线要是 0–100 之间的数（或 null = 默认线）`);
  return round1(v);
}
function parseOverride(k, v, scope = 'claude') {
  if (v === null) return null;
  if (!isObj(v)) throw fail(`「${k}」档的自定义要是 { model, effort } 或 null`);
  const model = typeof v.model === 'string' ? v.model.trim() : '';
  if (!model) return null;
  if (model.length > MODEL_MAX || !modelOk(model, scope)) {
    throw fail(scope === 'dimensio'
      ? `「${k}」档指定的模型「${clip(model, 60)}」写法不对：dimensio 写 <厂商 id>:<型号>，如 zhipu:glm-5.3-flash`
      : `「${k}」档指定的模型「${clip(model, 60)}」写法不对：Claude 写 opus / sonnet / haiku / fable，第三方写 custom:<服务 id>:<型号>`);
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
export function updatePolicy(ctx, patch, { scope = 'claude' } = {}) {
  const sc = policyScope(scope);
  requireEdit(ctx);
  if (!isObj(patch)) throw fail('patch 要是对象');
  const keys = sc === 'dimensio' ? DIM_POLICY_KEYS : POLICY_KEYS;
  for (const k of Object.keys(patch)) if (!keys.includes(k)) throw fail(`不认识的字段「${clip(k, 30)}」（只能改 ${keys.join(' / ')}）`);
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw fail('enabled 要是 true / false');
  if (patch.follow !== undefined && typeof patch.follow !== 'boolean') throw fail('follow 要是 true / false');
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
    if (patch.follow !== undefined) p.follow = patch.follow;
    if (patch.allowThirdParty !== undefined) p.allowThirdParty = patch.allowThirdParty;
    if (patch.scope) for (const k of Object.keys(DEFAULT_SCOPE)) if (Object.hasOwn(patch.scope, k)) p.scope[k] = patch.scope[k];
    if (patch.activeId !== undefined) {
      if (!p.strategies.some((s) => s.id === patch.activeId)) throw fail('没有这套策略（可能已经删了）', 404);
      p.activeId = patch.activeId;
    }
    return JSON.stringify(p) !== before;
  }, sc).policy;
}

/**
 * 新建或修改一套策略 → { policy, strategy }。
 *   s.id 有 = 改那一套（只改给了的字段：name / floors / overrides / note；floors、overrides 按档合并，null = 回默认）；
 *   没有 = 新建：以 copyOf（第三个参数或 s.copyOf）那套为底复制，没给就从空白开始；名字没给 → 「<原名> 副本」/「新策略」。
 * 判定线合并后要满足 top ≥ hard ≥ normal ≥ light，不满足抛 400。
 */
export function saveStrategy(ctx, s, { copyOf, scope = 'claude' } = {}) {
  const sc = policyScope(scope);
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
      overrides: mergeTiers(cur.overrides, s.overrides, '档位自定义 overrides', (k, v) => parseOverride(k, v, sc)),
      note: s.note !== undefined ? parseNote(s.note) : cur.note,
    };
    checkFloors(next.floors);
    const strip = ({ updatedAt, ...rest }) => rest;
    if (!created && sameJson(strip(next), strip(cur))) return false;   // 什么都没改：不写、不加 rev
    next.updatedAt = now;
    if (created) p.strategies.push(next);
    else p.strategies[p.strategies.indexOf(cur)] = next;
    return { id: next.id };
  }, sc);
  const id = r.extra ? r.extra.id : s.id;
  return { policy: r.policy, strategy: r.policy.strategies.find((x) => x.id === id) || null };
}

/** 删一套（生效中的不能删，先切换）→ 新策略文件。 */
export function deleteStrategy(ctx, id, { scope = 'claude' } = {}) {
  const sc = policyScope(scope);
  requireEdit(ctx);
  if (typeof id !== 'string' || !id) throw fail('要删的策略 id 没给');
  return commit(ctx, (p) => {
    const i = p.strategies.findIndex((x) => x.id === id);
    if (i < 0) throw fail('没有这套策略（可能已经删了）', 404);
    if (p.activeId === id) throw fail('生效中的策略不能删，先切换到别的那套');
    if (p.strategies.length <= 1) throw fail('至少要留一套策略');
    p.strategies.splice(i, 1);
    return true;
  }, sc).policy;
}

export function _resetPolicyForTests() { cache.clear(); owners.clear(); }
