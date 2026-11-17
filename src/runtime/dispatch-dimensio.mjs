// dimensio 的子 agent 调用策略（2026-11-14）：设置 › dimensio › 子 agent 调用策略 的「生效策略」与给 dimensio 的取法。
//
// 存储在 runtime/dispatch-policy.mjs 的 dimensio 作用域（<dataDir>/dispatch-policy.dimensio.json），这里只做解析：
//   · follow:false（默认）→ dimensio 自己 activeId 那套；follow:true → 生效的那一套 = Claude 那份 activeId 那套（判定线 / 档位自定义 / 口述备注）。
//     总开关、生效范围永远取 dimensio 自己的。allowThirdParty 恒为 true（dimensio 本来就是多厂商，11-15 去掉了这个开关；字段照给，harness 认它）。
//   · 档位自定义换成 dimensio 认得的「可携」写法 { model, effort, provider?, ref }：
//       dimensio 自己那套写的是「厂商 id:型号」→ provider + model 原样拆开；
//       Claude 那套的别名 opus / sonnet / haiku / fable → 别名此刻指向的型号 id（model-ratings.mjs 的 CLAUDE_SUBS），不指定厂商；
//       Claude 那套的 custom:p-<服务>:<型号> → 那个服务是模型中心 / 插件发布、而且同一个型号也发给了 dimensio 的，带上它在 dimensio 里的
//       厂商 id（custom-<同一哈希的 8 位>，modules/dimensio 的 plugin-providers.mjs 同一算法）；别的只给型号 id。
//     dimensio 那边按 provider + 型号找候选，指定的那家没有就找同型号的别家，再没有就忽略这一档的自定义、走判定线（overrideSkipped）。
//   · 同机接口 POST /api/internal/dispatch-policy（routes/dispatch.mjs）把这份给 dimensio 实例，顺带导入的性价比图数据（只在它手里那份
//     的版本对不上时才带全量），免得 dimensio 用随版本内置的快照算、和设置页上看到的点对不上。
import { policyFor, activeStrategy, canEditPolicy, TIER_KEYS } from './dispatch-policy.mjs';
import { CLAUDE_SUBS } from './model-ratings.mjs';
import { modelServices, serviceHash } from './model-services.mjs';
import { importedRatings } from './dispatch-chart.mjs';

const CUSTOM_RE = /^custom:(p-[0-9a-f]{6,12}):(.+)$/;
const DIM_RE = /^((?:[a-z]{2,20}|custom-[a-f0-9]{8})):(.+)$/;

// Claude 那边的服务 id（p-<10 位哈希>，插件 / 模型中心发布的）→ 同一个服务在 dimensio 里的厂商 id（custom-<8 位>）；
// 这个型号没发给 dimensio、或不是发布出来的服务（设置里自己加的 p-<8 位随机>）→ null
function dimensioProviderOf(pid, model) {
  for (const s of modelServices('claude')) {
    if ('p-' + serviceHash(s.plugin, s.sid, 10) !== pid) continue;
    const d = modelServices('dimensio').find((x) => x.plugin === s.plugin && x.sid === s.sid);
    return d && d.models.some((m) => m.id === model) ? 'custom-' + serviceHash(s.plugin, s.sid, 8) : null;
  }
  return null;
}

/** 一档的档位自定义 → 可携写法；from = 这套策略原本是哪个作用域的（'claude' | 'dimensio'）。写法认不出 → null。 */
export function portableOverride(ov, from) {
  if (!ov || typeof ov.model !== 'string' || !ov.model) return null;
  const effort = typeof ov.effort === 'string' ? ov.effort : '';
  if (from === 'dimensio') {
    const m = DIM_RE.exec(ov.model);
    return m ? { model: m[2], provider: m[1], effort, ref: ov.model } : null;
  }
  const sub = CLAUDE_SUBS.find((c) => c.alias === ov.model);
  if (sub) return { model: sub.id, effort, ref: ov.model };
  const m = CUSTOM_RE.exec(ov.model);
  if (!m) return null;
  let provider = null;
  try { provider = dimensioProviderOf(m[1], m[2]); } catch { provider = null; }
  return { model: m[2], ...(provider ? { provider } : {}), effort, ref: ov.model };
}

/** 一套策略 → 给 dimensio 的形状 { id, name, from, floors, overrides:{ 档: 可携 | null }, note }；没有 → null。 */
export function portableStrategy(st, from) {
  if (!st) return null;
  const overrides = {};
  for (const k of TIER_KEYS) overrides[k] = portableOverride(st.overrides && st.overrides[k], from);
  const floors = {};
  for (const k of TIER_KEYS) floors[k] = st.floors && typeof st.floors[k] === 'number' ? st.floors[k] : null;
  return { id: st.id, name: st.name, from, floors, overrides, note: typeof st.note === 'string' ? st.note : '' };
}

/** Claude 那份生效的那一套的摘要（跟随模式给人看「在跟随哪一套」，备注与档位自定义只读显示；都是这个身份自己的设置）。 */
export function claudeSummary(ctx) {
  const p = policyFor(ctx);
  const st = activeStrategy(p);
  return {
    activeId: st ? st.id : '', name: st ? st.name : '', enabled: p.enabled !== false, rev: p.rev,
    note: st && typeof st.note === 'string' ? st.note : '', overrides: st ? { ...st.overrides } : {},
  };
}

/**
 * 这个身份的 dimensio 此刻生效的调用策略：
 *   { enabled, follow, scope:{ workflow, subagent, session }, allowThirdParty, strategy（可携，见 portableStrategy）, rev, claudeRev, readOnly }
 * strategy 传了 = 按它算（设置页拖判定线、改档位时的实时预览；写法按 follow 认：跟随时是 Claude 写法，单独时是 dimensio 写法）。
 */
export function dimensioEffective(ctx, { strategy } = {}) {
  const dim = policyFor(ctx, { scope: 'dimensio' });
  const follow = dim.follow === true;
  const claude = follow ? policyFor(ctx) : null;
  const from = follow ? 'claude' : 'dimensio';
  const st = strategy !== undefined && strategy !== null ? strategy : follow ? activeStrategy(claude) : activeStrategy(dim);
  return {
    enabled: dim.enabled !== false, follow, scope: { ...dim.scope }, allowThirdParty: true,
    strategy: portableStrategy(st, from), rev: dim.rev, claudeRev: claude ? claude.rev : undefined, readOnly: !canEditPolicy(ctx),
  };
}

// 导入的性价比图的版本键：没导入 = builtin（dimensio 用它自己经 core-link 读的内置快照，同一份文件）
export function chartKey() {
  const r = importedRatings();
  if (!r) return 'builtin';
  const im = r.imported && typeof r.imported === 'object' ? r.imported : {};
  return `imported:${im.at ?? ''}:${r.generated ?? ''}`;
}

/** 给 dimensio 的图谱数据：{ key, ratings? }——只在对方手里的版本（have）对不上、而且是导入的那份时才带全量（不带 planPoints：dimensio 不按 plan 计价）。 */
export function chartFor(have) {
  const key = chartKey();
  if (key === have || key === 'builtin') return { key };
  const r = importedRatings();
  if (!r) return { key: 'builtin' };
  const { planPoints, imported, ...rest } = r;
  return { key, ratings: rest };
}
