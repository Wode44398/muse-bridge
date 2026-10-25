// 模型服务编辑器的界面无关逻辑（2026-10-21 抽出）：bridge 的 Claude 外接编辑器（web/src/components/claude/providers/*）
// 与 dimensio 的「模型服务」表单（harness/web/src/components/shell/vendor/*）走同一个流程——两边 UI 套件不同，组件不能互用，
// 只共用这里的规则、数据形状和措辞键。文案一律以「中文原文键 + 参数」返回，由各自的 t() 翻译。
import { TIER_ID_RE, MAX_TIERS, LEVEL_NAMES } from './knowledge.mjs';

export const THINK_MODES = Object.freeze(['none', 'budget', 'adaptive', 'effort']);
const FIELD_RE = /^[A-Za-z_][\w-]{0,40}(\.[A-Za-z_][\w-]{0,40}){0,4}$/;

/** 档位表的毛病（编辑器据此拦保存；服务端同规则）：回 { key, params }，没毛病回 null。 */
export function tierProblem(m) {
  if (!m || m.thinking === 'none') return null;
  const seen = new Set();
  for (const x of m.efforts || []) {
    if (!TIER_ID_RE.test(x.id || '')) return { key: '档位 ID「{id}」不合法（小写字母数字与 _ -，最长 24）', params: { id: x.id || '' } };
    if (seen.has(x.id)) return { key: '档位「{id}」重复了', params: { id: x.id } };
    seen.add(x.id);
  }
  if ((m.efforts || []).length > MAX_TIERS) return { key: '档位最多 {n} 个', params: { n: MAX_TIERS } };
  if (m.thinking === 'effort' && m.effortField && !FIELD_RE.test(m.effortField)) return { key: '写入字段「{f}」不合法（点分路径，如 reasoning_effort）', params: { f: m.effortField } };
  return null;
}

const tier = (id, name, value = null) => ({ id, name, value });
const lv = (ids, mk = (x) => x) => ids.map((x) => tier(x, LEVEL_NAMES[x] || x, mk(x)));
/**
 * 一键填入的常见写法。label 是措辞键（或不用翻译的字段名）；protocols：哪些协议下给（不写 = 都给）。
 * 档名「关闭 / 开启」是数据：界面显示时按开关的值翻译。
 */
export const TIER_PRESETS = Object.freeze([
  { k: 'oai3', label: 'OpenAI 三档', protocols: ['openai'], set: { thinking: 'effort', effortField: 'reasoning_effort', efforts: lv(['low', 'medium', 'high']) } },
  { k: 'anth5', label: 'Anthropic 五档', protocols: ['anthropic'], set: { thinking: 'adaptive', effortField: '', efforts: lv(['low', 'medium', 'high', 'xhigh', 'max']) } },
  { k: 'toggle', label: '开 / 关', protocols: ['anthropic', 'openai'], set: { thinking: 'effort', effortField: '', efforts: [tier('off', '关闭', { thinking: { type: 'disabled' } }), tier('on', '开启', { thinking: { type: 'enabled' } })] } },
  { k: 'enable', label: 'enable_thinking', protocols: ['openai'], set: { thinking: 'effort', effortField: 'enable_thinking', efforts: [tier('off', '关闭', false), tier('on', '开启', true)] } },
  { k: 'or', label: 'OpenRouter reasoning', protocols: ['openai'], set: { thinking: 'effort', effortField: 'reasoning.effort', efforts: lv(['low', 'medium', 'high']) } },
  { k: 'gem3', label: 'Gemini thinkingLevel', protocols: ['gemini'], set: { thinking: 'effort', effortField: 'generationConfig.thinkingConfig.thinkingLevel', efforts: lv(['low', 'medium', 'high'], (x) => x.toUpperCase()) } },
]);
export const presetsFor = (protocol) => TIER_PRESETS.filter((p) => !p.protocols || p.protocols.includes(protocol));
/** 这个协议下能选的思考方式（budget / adaptive 是 Anthropic Messages 的写法）。 */
export const modesFor = (protocol) => (protocol === 'anthropic' ? THINK_MODES : THINK_MODES.filter((m) => m === 'none' || m === 'effort'));

/** 档位值和思考方式对不对得上（预算要数字、自适应要 effort 文字）。 */
export function fitsMode(val, mode) {
  return val === null || val === undefined || (mode === 'budget' ? typeof val === 'number' : mode === 'adaptive' ? typeof val === 'string' : true);
}
/** 换思考方式时的起步档位表（原表对不上新方式就重起一张）。 */
export function startTiers(mode, protocol, current = []) {
  if (current.length && current.every((x) => fitsMode(x.value, mode))) return current;
  if (mode === 'budget') return lv(['low', 'medium', 'high'], () => null);
  if (mode === 'adaptive') return [tier('adaptive', '自适应')];
  if (mode === 'effort') {
    const p = presetsFor(protocol)[0];
    return p ? JSON.parse(JSON.stringify(p.set.efforts)) : [];
  }
  return [];
}

/** 发送值：显示成文字；文字能当 JSON 解析（对象 / 数字 / true·false）就按 JSON 存，否则存原文；空 = 不发。 */
export function fmtTierValue(v) { return v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v); }
export function parseTierValue(s) {
  const x = String(s ?? '').trim();
  if (!x) return null;
  if (/^[{\[]|^(true|false)$|^-?\d+(\.\d+)?$/.test(x)) { try { const v = JSON.parse(x); if (!Array.isArray(v)) return v; } catch {} }
  return x;
}

/** 1000000 → 1M、131072 → 131K（徽章上用）。 */
export function fmtTokens(n) {
  if (!n) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

// 值的来源：api / probe / user 是实打实的；table（内置型号表）/ guess（按名字猜）/ default（兜底）前面加「≈」
export const APPROX_SOURCES = Object.freeze(['table', 'guess', 'default']);
export const SOURCE_TEXT = Object.freeze({ api: '端点返回的', probe: '探测出来的', user: '手动填的', table: '内置型号表里的（未经这个端点证实）', guess: '按型号名猜的', default: '不知道，用的默认值' });
export const isApprox = (m, k) => APPROX_SOURCES.includes(m && m.source && m.source[k]);
// 换协议后能按名字重算档位的来源（手动设的、探测或端点元数据给的没法凭名字重算）
export const AUTO_THINK_SOURCES = Object.freeze(['table', 'guess', 'default']);

/** 默认模型只认启用的对话模型。 */
export function firstChat(models) {
  return ((models || []).find((m) => m.enabled !== false && m.kind !== 'other') || {}).id || '';
}
/** 拉回来的候选：对话模型默认勾上，语音识别 / 合成、向量这类不勾。 */
export function pickCandidates(list) {
  return Object.fromEntries((list || []).filter((m) => m.kind !== 'other').map((m) => [m.id, true]));
}
/** 徽章用的能力摘要：{ ctx, vision, think, other }。 */
export function capsBadges(m) {
  const efforts = (m && m.efforts) || [];
  return {
    other: m && m.kind === 'other',
    ctx: m && m.contextWindow ? fmtTokens(m.contextWindow) : '',
    ctxApprox: isApprox(m, 'contextWindow'),
    vision: !!(m && m.vision),
    visionApprox: isApprox(m, 'vision'),
    think: efforts.length ? 'tiers' : m && m.alwaysThinks ? 'always' : '',
  };
}

/**
 * 探测结论 → 应用到模型上（不改原对象，回新模型）。
 * probe：{ kind?, maxOutput?, vision?, thinksByDefault?, effortIds?, tiers?:[{id, ok}] }。
 * effortIds：OpenAI 端点报出了它认的 reasoning_effort——没配档位、或档位就是写 reasoning_effort 的，按它重排；
 * tiers：端点不认的档拿掉。
 */
export function applyProbe(model, probe) {
  if (!probe || probe.error) return model;
  const m = { ...model, source: { ...(model.source || {}) }, efforts: [...(model.efforts || [])] };
  if (probe.kind) m.kind = probe.kind;
  if (probe.maxOutput) { m.maxOutput = probe.maxOutput; m.source.maxOutput = 'probe'; }
  if (typeof probe.vision === 'boolean') { m.vision = probe.vision; m.source.vision = 'probe'; }
  if (probe.thinksByDefault) m.alwaysThinks = true;
  const plainField = !m.effortField || m.effortField === 'reasoning_effort';
  if (probe.effortIds && probe.effortIds.length && (m.thinking === 'none' || (m.thinking === 'effort' && plainField && m.efforts.every((x) => typeof x.value === 'string' || x.value === null)))) {
    m.thinking = 'effort'; m.effortField = 'reasoning_effort';
    m.efforts = probe.effortIds.slice(0, MAX_TIERS).map((id) => tier(id, LEVEL_NAMES[id] || id, id));
    if (!m.efforts.some((x) => x.id === m.effortDefault)) m.effortDefault = '';
    m.source.thinking = 'probe';
  } else if (Array.isArray(probe.tiers) && probe.tiers.some((x) => !x.ok)) {
    const bad = new Set(probe.tiers.filter((x) => !x.ok).map((x) => x.id));
    m.efforts = m.efforts.filter((x) => !bad.has(x.id));
    if (bad.has(m.effortDefault)) m.effortDefault = '';
    if (!m.efforts.length) { m.thinking = 'none'; m.effortField = ''; }
    m.source.thinking = 'probe';
  }
  return m;
}

/** 有思考方式却一档都没有 = 什么都不发：按「不思考」存（服务端把「有方式没档位」当老版编辑器，会按老规则补档位）。 */
export function wireModel(m) {
  return m.thinking !== 'none' && !(m.efforts || []).length ? { ...m, thinking: 'none', effortDefault: '' } : m;
}

/** 「检测连接」每种结果的措辞键。 */
export const DETECT_RESULT_TEXT = Object.freeze({ ok: '通了', model: '接口在，模型名不对', auth: '接口在，Key 被拒', missing: '这里没有接口', error: '报错', network: '连不上' });
/** 开关式档位（关闭 / 开启）认得出来：界面按开关的值翻译。 */
export const isToggleName = (name) => name === '关闭' || name === '开启';
