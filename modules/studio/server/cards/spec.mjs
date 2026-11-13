// 模型卡的公共件：ParamSpec 构造、按卡规范化参数、通用卡（未知模型用）。
//
// 模型卡 = { id, kind, label?, desc?, async, inputs, params: [ParamSpec], priceHint?, normalize?(raw, job) }
//   params 给前端渲染（§3.2 契约，前端只按它渲染，不再按模型 id 硬编码）；
//   normalize 是服务端专用的规范化（Google 系照抄旧路由的夹紧逻辑，行为逐项一致）；没写就按 ParamSpec 通用规范化。
// ParamSpec { key, label, type: enum|number|bool|text|voice|seed|json, group: basic|advanced,
//   options?: [{ value, label, only?, note? }], min?, max?, step?, default?, when?: { <key>: 值或值数组 }, desc? }

export const P = {
  enum: (key, label, options, o = {}) => ({ key, label, type: 'enum', group: 'basic', options, ...o }),
  num: (key, label, min, max, o = {}) => ({ key, label, type: 'number', group: 'advanced', min, max, ...o }),
  bool: (key, label, o = {}) => ({ key, label, type: 'bool', group: 'advanced', ...o }),
  text: (key, label, o = {}) => ({ key, label, type: 'text', group: 'advanced', ...o }),
  voice: (key, label, o = {}) => ({ key, label, type: 'voice', group: 'basic', ...o }),
  seed: (o = {}) => ({ key: 'seed', label: '种子', type: 'seed', group: 'advanced', min: 0, max: 4294967295, ...o }),
  json: (key = 'extra', label = '额外参数', o = {}) => ({ key, label, type: 'json', group: 'advanced', desc: 'JSON 对象，原样合并进请求体', ...o }),
};
export const opts = (list) => list.map((x) => (typeof x === 'object' ? x : { value: x, label: String(x) }));

// when：{ key: 值 | [值…] }——所有条件都满足才算这一项生效
export function whenOk(spec, vals) {
  if (!spec.when) return true;
  return Object.entries(spec.when).every(([k, want]) => (Array.isArray(want) ? want.includes(vals[k]) : vals[k] === want));
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

export function applySpecs(specs, raw = {}) {
  raw = aliasParams(specs, raw && typeof raw === 'object' ? raw : {});
  const out = {};
  for (const s of specs) {
    let v = raw[s.key];
    if (v === undefined || v === null || v === '') v = s.default;
    if (v === undefined || v === null) continue;
    switch (s.type) {
      case 'enum': {
        const ops = s.options || [];
        let hit = ops.find((o) => o.value === v) || ops.find((o) => String(o.value) === String(v));
        // 全是数字的档位（时长 '5' / '10'、步数…）：给的数不在表里就取最近的一档（Claude 工具传 8 秒、这家只有 5 / 10）
        if (!hit && ops.length && Number.isFinite(Number(v)) && ops.every((o) => o.value !== '' && Number.isFinite(Number(o.value)))) {
          hit = ops.reduce((b, o) => (Math.abs(Number(o.value) - Number(v)) < Math.abs(Number(b.value) - Number(v)) ? o : b), ops[0]);
        }
        if (hit) v = hit.value;
        else { if (s.default === undefined) continue; v = s.default; }
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
  for (const s of specs) if (s.key in out && !whenOk(s, out)) delete out[s.key];
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
