// 模型中心 · 高级调用配置（2026-11-15）：每个文本模型可以改的能力 / 思考写法 / 调用参数，以及服务级的兼容项。
//
// 都是「覆盖」：不填 = 自动（能力按识别结果与型号知识层，兼容项按上游——官方 Anthropic 一套、其余一套）。存在 services.json 里：
//   模型 m.over   = { contextWindow?, maxOutput?, vision?, alwaysThinks?, think?: { thinking, efforts, effortField, effortDefault } }
//                   think 是整块覆盖思考写法（方式 + 档位表 + 写入字段 + 默认档）：要么全按知识层，要么全按用户的
//   模型 m.params = { maxTokens?, temperature?, topP?, topK?, thinking?: 'on' | 'off', thinkingBudget?, stop?: [], extraBody?: 'JSON 原文' }
//                   形状同 Claude 外接服务的 normalizeParams（claude-providers.mjs）；只存设了的键，'auto' / null / 空 = 不存
//   服务 s.compat = { promptCaching?, stripBetas?, slimBody?, stripThinkingHistory?, replayReasoning?, maxTokensField? }
//   服务 s.retries（0–5；不填 = 1）
// 发布时（registry.desiredSpecs / modelSpec）覆盖压在自动值上；Claude 与 dimensio 两边各认自己用得上的那几项（界面上标着）。
// 规则与 Claude 外接编辑器同源（档位 ID、写入字段、范围），这里不 import claude-providers（它反过来依赖注册表，会成环）。
import { TIER_ID_RE, MAX_TIERS } from '../../model-knowledge/knowledge.mjs';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const FIELD_RE = /^[A-Za-z_][\w-]{0,40}(?:\.[A-Za-z_][\w-]{0,40}){0,4}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const THINK_KINDS = Object.freeze(['none', 'budget', 'adaptive', 'effort']);
export const PARAM_THINK = Object.freeze(['on', 'off']);   // 'auto' = 跟随输入框，不存
export const MAX_TOKENS_FIELDS = Object.freeze(['max_tokens', 'max_completion_tokens']);
export const COMPAT_BOOLS = Object.freeze(['promptCaching', 'stripBetas', 'slimBody', 'stripThinkingHistory', 'replayReasoning']);
export const CTX_MIN = 1024, CTX_MAX = 4_000_000, OUT_MIN = 256, OUT_MAX = 1_000_000;

// strict（用户这次提交的）= 坏值报 400；否则（读盘）坏值静默丢掉
function intIn(v, lo, hi, what, strict) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (Number.isInteger(n) && n >= lo && n <= hi) return n;
  if (strict) throw bad(`${what}要是 ${lo}–${hi} 之间的整数`);
  return undefined;
}
function numIn(v, lo, hi, what, strict) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= lo && n <= hi) return Math.round(n * 1000) / 1000;
  if (strict) throw bad(`${what}要在 ${lo}–${hi} 之间`);
  return undefined;
}
const boolOr = (v) => (typeof v === 'boolean' ? v : undefined);

function tierValue(v, where, strict) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  if (isObj(v)) {
    const s = JSON.stringify(v);
    if (s.length <= 2000) return JSON.parse(s);
    if (strict) throw bad(`${where}的发送值太长（上限 2000 字符）`);
    return null;
  }
  if (strict) throw bad(`${where}的发送值要是文字、数字、true / false 或 JSON 对象`);
  return null;
}
function cleanTiers(list, strict) {
  const out = [], seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const id = String(t?.id ?? '').trim().toLowerCase();
    if (!TIER_ID_RE.test(id)) { if (strict) throw bad(`档位 ID「${id.slice(0, 30)}」不合法（小写字母数字与 _ -，最长 24）`); continue; }
    if (seen.has(id)) { if (strict) throw bad(`档位「${id}」重复了`); continue; }
    if (out.length >= MAX_TIERS) { if (strict) throw bad(`档位最多 ${MAX_TIERS} 个`); break; }
    seen.add(id);
    const name = String(t?.name ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 24) || id;
    out.push({ id, name, value: tierValue(t?.value, `档位「${id}」`, strict) });
  }
  return out;
}
function cleanField(v, strict) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (FIELD_RE.test(s) && !s.split('.').some((k) => BAD_KEYS.has(k))) return s;
  if (strict) throw bad(`写入字段「${s.slice(0, 60)}」不合法（点分路径，如 reasoning_effort、output_config.effort）`);
  return '';
}

/** 思考写法的整块覆盖 → { thinking, efforts, effortField, effortDefault } 或 undefined（= 按知识层）。 */
export function cleanThink(v, { strict = false } = {}) {
  if (!isObj(v)) return undefined;
  if (!THINK_KINDS.includes(v.thinking)) { if (strict) throw bad('思考方式只能是 不思考 / 预算 / 自适应 / 档位'); return undefined; }
  const thinking = v.thinking;
  if (thinking === 'none') return { thinking, efforts: [], effortField: '', effortDefault: '' };
  const efforts = cleanTiers(v.efforts, strict);
  if (!efforts.length) { if (strict) throw bad('至少要有一个档位（不想发思考参数就选「不思考」）'); return undefined; }
  const effortField = thinking === 'effort' ? cleanField(v.effortField, strict) : '';
  const effortDefault = efforts.some((t) => t.id === v.effortDefault) ? v.effortDefault : '';
  return { thinking, efforts, effortField, effortDefault };
}

/** 模型能力的覆盖 → 只含设了的键，一个都没有回 undefined。 */
export function cleanOver(v, { strict = false } = {}) {
  if (!isObj(v)) return undefined;
  const out = {};
  const ctx = intIn(v.contextWindow, CTX_MIN, CTX_MAX, '上下文窗口', strict);
  const max = intIn(v.maxOutput, OUT_MIN, OUT_MAX, '输出上限', strict);
  if (ctx !== undefined) out.contextWindow = ctx;
  if (max !== undefined) out.maxOutput = max;
  if (ctx !== undefined && max !== undefined && max > ctx) { if (strict) throw bad('输出上限不能大于上下文窗口'); delete out.maxOutput; }
  const vision = boolOr(v.vision), always = boolOr(v.alwaysThinks);
  if (vision !== undefined) out.vision = vision;
  if (always !== undefined) out.alwaysThinks = always;
  const think = cleanThink(v.think, { strict });
  if (think) out.think = think;
  return Object.keys(out).length ? out : undefined;
}

/** 额外请求体：JSON 对象原文（≤ 8000 字符）→ 原文；空回 ''。 */
export function cleanExtraBody(v, { strict = false } = {}) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const fail = (msg) => { if (strict) throw bad(msg); return ''; };
  if (s.length > 8000) return fail('额外请求体太长（上限 8000 字符）');
  let o;
  try { o = JSON.parse(s); } catch (e) { return fail('额外请求体不是合法 JSON：' + ((e && e.message) || '')); }
  if (!isObj(o)) return fail('额外请求体要是 JSON 对象（{…}）');
  return s;
}

/** 调用参数 → 只含设了的键，一个都没有回 undefined。 */
export function cleanParams(v, { strict = false } = {}) {
  if (!isObj(v)) return undefined;
  const out = {};
  const set = (k, x) => { if (x !== undefined) out[k] = x; };
  set('maxTokens', intIn(v.maxTokens, 1, OUT_MAX, '最大输出', strict));
  set('temperature', numIn(v.temperature, 0, 2, 'temperature ', strict));
  set('topP', numIn(v.topP, 0, 1, 'top_p ', strict));
  set('topK', intIn(v.topK, 1, 1000, 'top_k ', strict));
  if (PARAM_THINK.includes(v.thinking)) out.thinking = v.thinking;
  else if (strict && v.thinking != null && v.thinking !== 'auto' && v.thinking !== '') throw bad('思考策略只能是 跟随输入框 / 始终开 / 始终关');
  set('thinkingBudget', intIn(v.thinkingBudget, 1024, 200_000, '思考预算', strict));
  const stop = Array.isArray(v.stop) ? [...new Set(v.stop.map((x) => String(x ?? '').slice(0, 64)).filter(Boolean))] : [];
  if (strict && stop.length > 8) throw bad('停止序列最多 8 个');
  if (stop.length) out.stop = stop.slice(0, 8);
  const extra = cleanExtraBody(v.extraBody, { strict });
  if (extra) out.extraBody = extra;
  return Object.keys(out).length ? out : undefined;
}

/** 服务级兼容项的覆盖 → 只含设了的键，一个都没有回 undefined。 */
export function cleanCompat(v, { strict = false } = {}) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const k of COMPAT_BOOLS) { const b = boolOr(v[k]); if (b !== undefined) out[k] = b; }
  if (MAX_TOKENS_FIELDS.includes(v.maxTokensField)) out.maxTokensField = v.maxTokensField;
  else if (strict && v.maxTokensField != null && v.maxTokensField !== '') throw bad('输出上限字段只能是 max_tokens / max_completion_tokens');
  return Object.keys(out).length ? out : undefined;
}

/** 兼容项的自动值（不覆盖时两边实际按什么跑）：Claude 外接的默认 + 上游是官方 Anthropic 时那一套。 */
export function autoCompat({ official = false } = {}) {
  return official
    ? { promptCaching: true, stripBetas: false, slimBody: false, stripThinkingHistory: false, replayReasoning: false, maxTokensField: 'max_tokens' }
    : { promptCaching: false, stripBetas: true, slimBody: true, stripThinkingHistory: false, replayReasoning: false, maxTokensField: 'max_tokens' };
}

/** 这个模型有没有改过任何调用配置（列表里打标记用）：能力 / 思考写法 / 调用参数，缓存时长单独算。 */
export const isCustomized = (m) => !!(m && (m.over || m.params));
