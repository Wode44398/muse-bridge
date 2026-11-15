// 模型卡的公共件：ParamSpec 构造、按卡规范化参数、通用卡（未知模型用）。
//
// 模型卡 = { id, kind, label?, desc?, async, inputs, params: [ParamSpec], priceHint?, normalize?(raw, job) }
//   params 给前端渲染（§3.2 契约，前端只按它渲染，不再按模型 id 硬编码）；
//   normalize 是服务端专用的规范化（Google 系照抄旧路由的夹紧逻辑，行为逐项一致）；没写就按 ParamSpec 通用规范化。
// ParamSpec { key, label, type: enum|number|bool|text|voice|seed|json|size, group: basic|advanced,
//   options?: [{ value, label, only?, note? }], min?, max?, step?, default?, when?: { <key>: 值或值数组 }, desc? }
// type:'size'（方案 §10）：值是字符串档或自由宽高 { width, height }；custom / encode / editDefault 见 cards/size.mjs。

import { normalizeSizeValue } from './size.mjs';

export const P = {
  enum: (key, label, options, o = {}) => ({ key, label, type: 'enum', group: 'basic', options, ...o }),
  num: (key, label, min, max, o = {}) => ({ key, label, type: 'number', group: 'advanced', min, max, ...o }),
  bool: (key, label, o = {}) => ({ key, label, type: 'bool', group: 'advanced', ...o }),
  text: (key, label, o = {}) => ({ key, label, type: 'text', group: 'advanced', ...o }),
  voice: (key, label, o = {}) => ({ key, label, type: 'voice', group: 'basic', ...o }),
  seed: (o = {}) => ({ key: 'seed', label: '种子', type: 'seed', group: 'advanced', min: 0, max: 4294967295, ...o }),
  json: (key = 'extra', label = '额外参数', o = {}) => ({ key, label, type: 'json', group: 'advanced', desc: 'JSON 对象，原样合并进请求体', ...o }),
  // 尺寸：options = 字符串档；custom = 自由宽高规则（没有就只有档位）
  size: (key, label, options, o = {}) => ({ key, label, type: 'size', group: 'basic', format: 'size', options, ...o }),
};
export const opts = (list) => list.map((x) => (typeof x === 'object' ? x : { value: x, label: String(x) }));

// 素材条件（方案 §10）：手里有没有要改的图 / 首帧 / 尾帧 / 参考图。选项的 only 条件表、参数的 when 都能写 $edit / $first / $last / $ref，
// 前端 resolveValues 同一套（没给就全是 false，所以写了 { $ref: false } 的选项在不知道素材时照常可选）。
export const INPUT_FLAGS = Object.freeze({ $edit: false, $first: false, $last: false, $ref: false });
export const inputFlags = (ctx = {}) => ({ ...INPUT_FLAGS, ...Object.fromEntries(Object.entries(ctx || {}).filter(([k]) => k in INPUT_FLAGS).map(([k, v]) => [k, !!v])) });

/** 选项此刻成立吗：only 是条件表（同 when）才查；模型 id 数组那种写法后端不认（不知道模型 id），当成立 */
export function optionOk(o, vals) {
  const only = o?.only;
  if (!only || Array.isArray(only) || typeof only !== 'object') return true;
  return whenOk({ when: only }, vals);
}

// when：{ key: 值 | [值…] }——所有条件都满足才算这一项生效
export function whenOk(spec, vals) {
  if (!spec.when) return true;
  // 没出现在结果里的参数按 ''（「默认，不传」）算，同前端 resolveValues（它把 '' 档也当一个值）
  return Object.entries(spec.when).every(([k, want]) => { const v = vals[k] ?? ''; return Array.isArray(want) ? want.includes(v) : v === want; });
}

const MAX_JSON = 8000;
/** 解析 json 类参数：对象原样、字符串按 JSON 解析；坏值抛 400。 */
export function parseJsonParam(v, label = '额外参数') {
  if (v === undefined || v === null || v === '') return undefined;
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch (e) { throw Object.assign(new Error(`${label}不是合法 JSON：${(e && e.message) || ''}`), { status: 400 }); } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw Object.assign(new Error(`${label}要是 JSON 对象（{…}）`), { status: 400 });
  if (JSON.stringify(o).length > MAX_JSON) throw Object.assign(new Error(`${label}太长（上限 ${MAX_JSON} 字符）`), { status: 400 });
  for (const k of Object.keys(o)) if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw Object.assign(new Error(`${label}里有不允许的键 ${k}`), { status: 400 });
  return o;
}

/**
 * 按 ParamSpec 通用规范化：不认的键丢掉；enum 不在选项里回落默认（没默认就不传）；数字夹紧；
 * bool 只认布尔；text 截长；seed 取整；json 解析；when 不满足的丢掉。
 */
// 通用参数名 → 各家卡上的字段名（Claude 的媒体工具、旧接口、通用卡都用左边这套）：卡上没有左边的键、有右边的，就搬过去
const ALIASES = {
  aspectRatio: ['aspect_ratio', 'ratio'],
  durationSeconds: ['duration', 'seconds', 'duration_seconds'],
  voice: ['voice_id', 'voiceId'],
  imageSize: ['image_size', 'size'],
};
export function aliasParams(specs, raw) {
  const keys = new Set(specs.map((s) => s.key));
  const out = { ...raw };
  for (const [from, tos] of Object.entries(ALIASES)) {
    if (!(from in out) || keys.has(from)) continue;
    const to = tos.find((k) => keys.has(k));
    if (to && !(to in out)) out[to] = out[from];
  }
  return out;
}

export function applySpecs(specs, raw = {}, ctx = {}) {
  raw = aliasParams(specs, raw && typeof raw === 'object' ? raw : {});
  const flags = inputFlags(ctx);
  const out = {};
  const vals = () => ({ ...flags, ...out });
  const bad = new Map();   // size：坏的自由宽高先记下，when 结算后它还在才报 400（被隐藏的参数不该挡住请求）
  for (const s of specs) {
    let v = raw[s.key];
    if (v === undefined || v === null || v === '') v = s.default;
    if (v === undefined || v === null) continue;
    switch (s.type) {
      case 'size': {
        let r = null;
        try { r = normalizeSizeValue(s, v); } catch (e) { bad.set(s.key, e); r = null; }
        if (r?.drop) continue;
        if (r) { v = r.value; break; }
        if (bad.has(s.key)) { out[s.key] = v; continue; }   // 先占位，when 结算后还在就报错
        const d = s.default === undefined || s.default === v ? null : normalizeSizeValue(s, s.default);
        if (!d || d.drop) continue;
        v = d.value;
        break;
      }
      case 'enum': {
        // 只看此刻成立的选项（only 条件表：看前面已结算的参数和素材条件——海螺 1080P 没有 10 秒、Veo 有参考图只能 8 秒）
        const cur = vals();
        const ops = (s.options || []).filter((o) => optionOk(o, cur));
        let hit = ops.find((o) => o.value === v) || ops.find((o) => String(o.value) === String(v));
        // 全是数字的档位（时长 '5' / '10'、步数…）：给的数不在表里就取最近的一档（Claude 工具传 8 秒、这家只有 5 / 10）
        if (!hit && ops.length && Number.isFinite(Number(v)) && ops.every((o) => o.value !== '' && Number.isFinite(Number(o.value)))) {
          hit = ops.reduce((b, o) => (Math.abs(Number(o.value) - Number(v)) < Math.abs(Number(b.value) - Number(v)) ? o : b), ops[0]);
        }
        if (hit) v = hit.value;
        else if (s.default === undefined) continue;
        // 默认值被 only 条件挡掉了：取第一个成立的；默认值本来就不在选项里（'' = 不传）照旧
        else if (ops.some((o) => o.value === s.default) || !(s.options || []).some((o) => o.value === s.default)) v = s.default;
        else if (ops.length) v = ops[0].value;
        else continue;
        break;
      }
      case 'number': case 'seed': {
        const n = Number(v);
        if (!Number.isFinite(n)) continue;
        v = Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, s.type === 'seed' || s.integer ? Math.round(n) : n));
        break;
      }
      case 'bool': if (typeof v !== 'boolean') continue; break;
      case 'text': case 'voice': v = String(v).slice(0, s.max || 4000); break;
      case 'json': v = parseJsonParam(v, s.label); if (!v) continue; break;
      default: continue;
    }
    if (v === '' && s.type === 'enum') continue;   // '' = 「默认」档：不传
    out[s.key] = v;
  }
  for (const s of specs) if (s.key in out && !whenOk(s, vals())) delete out[s.key];
  for (const [k, e] of bad) if (k in out) throw e;
  return out;
}

// —— 通用卡：拉取来的、手填的未知模型（方言 × 种类）——前端照这些参数渲染，extra 原样透传进请求体 ——
const ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
export function genericCard(dialect, kind, { async = kind === 'video' || kind === 'music', extraParams = [] } = {}) {
  const params = [];
  if (kind === 'image') params.push(P.enum('aspectRatio', '比例', opts(['auto', ...ASPECTS].map((v) => ({ value: v, label: v === 'auto' ? '自动' : v }))), { default: 'auto' }));
  if (kind === 'video') {
    params.push(P.enum('aspectRatio', '比例', opts([{ value: 'auto', label: '自动' }, { value: '16:9', label: '16:9 横' }, { value: '9:16', label: '9:16 竖' }]), { default: 'auto' }));
    params.push(P.num('durationSeconds', '时长（秒）', 1, 60, { group: 'basic', step: 1, integer: true }));
  }
  if (kind === 'speech') params.push(P.voice('voice', '音色'));
  if (kind === 'music') params.push(P.num('durationSeconds', '时长（秒）', 5, 600, { step: 1, integer: true }));
  params.push(...extraParams, P.json());
  return {
    id: `generic:${dialect}:${kind}`, kind, async, generic: true,
    inputs: { text: true, ...(kind === 'image' || kind === 'video' ? { images: { max: kind === 'image' ? 4 : 1, roles: kind === 'image' ? ['edit', 'ref'] : ['first'] } } : {}) },
    params,
  };
}
