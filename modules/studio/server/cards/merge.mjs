// 内置卡 + 上游 schema 合并（方案 §9.3 参数解析链，2026-11-15 参数补全）。
//
// 背景：cardFor 先找内置卡后找 schema 卡，内置卡一命中，schema 里多出来的字段（安全检查、加速档、分镜、音频设置…）就再也不出现。
// 这里以内置卡为主：它的参数、标签、默认值、取值域、wire、inputs 上限、normalize 一律保留；schema 里有、内置卡没发的字段
// 追加到 advanced 组末尾（extra 之前），schema 里有、内置卡没有的素材角色 / 负面提示词也补上。
//
// 「内置卡发了哪些上游字段」：
//   · wire 是对象 / 没有（Replicate 式：参数键就是上游字段名）：参数键 + 拆开的尺寸字段 + wire 里的正文 / 负面词 / 素材字段；
//   · wire 是函数（fal 式：通用名 → 上游名）：拿一组探测值调一次 wire，看它实际吐出哪些字段（含嵌套对象的子字段 voice_setting.voice_id）。
//     探测值尽量避开默认值（有的 wire 等于默认就不发），所以「默认才不发」的字段也算发过。
// 追加的参数怎么进请求体：
//   · 对象 wire：Replicate 的 buildInput 原样透传参数（点路径键展开），追加的素材角色直接并进 wire；
//   · 函数 wire：合并卡带 wireExtra = { params: [追加键], images?, video?, audio?, negative? }，fal 适配器用 wireExtraBody 补进请求体。
// 已弃用的 schema 字段（描述里写 deprecated）不追加。

import { applySpecs } from './spec.mjs';

const DEPRECATED = /\bdeprecated\b/i;

// 一个参数探测用的值：尽量不等于默认值
function probeValue(s) {
  switch (s.type) {
    case 'enum': {
      const ops = (s.options || []).filter((o) => o.value !== '' && o.value !== s.default);
      return ops.length ? ops[0].value : s.default;
    }
    case 'bool': return s.default === true ? false : true;
    case 'number': case 'seed': {
      const lo = Number.isFinite(s.min) ? s.min : 0, hi = Number.isFinite(s.max) ? s.max : lo + 1;
      return lo !== s.default ? lo : hi;
    }
    case 'size': return s.default ?? (s.options || []).find((o) => o.value !== '')?.value;
    case 'json': return s.array ? [{}] : {};
    case 'text': case 'voice': return 'x';
    default: return undefined;
  }
}

/** 内置卡实际会发的上游字段（含一层嵌套的点路径）。 */
export function coveredFields(card) {
  const set = new Set();
  const add = (k) => { if (typeof k === 'string' && k) set.add(k); };
  if (typeof card?.wire === 'function') {
    const p = {};
    for (const s of card.params || []) if (s.key !== 'extra') { const v = probeValue(s); if (v !== undefined) p[s.key] = v; }
    const r = { prompt: 'x', negative: 'x', refs: ['x'], first: 'x', last: 'x', video: 'x', audio: 'x' };
    let out = {};
    try { out = card.wire(p, r) || {}; } catch { out = {}; }
    for (const [k, v] of Object.entries(out)) {
      add(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) for (const k2 of Object.keys(v)) add(`${k}.${k2}`);
    }
    return set;
  }
  const w = card?.wire || {};
  for (const s of card?.params || []) {
    if (s.key === 'extra') continue;
    if (s.type === 'size' && s.encode === 'split' && s.fields) { add(s.fields.width); add(s.fields.height); } else add(s.key);
  }
  add(w.text || 'prompt');
  if (card?.inputs?.negative) add(w.negative || 'negative_prompt');
  for (const slot of Object.values(w.images || {})) add(slot?.field);
  add(w.video?.field); add(w.audio?.field);
  return set;
}

// schema 参数对应的上游字段
const fieldsOf = (s) => (s.type === 'size' && s.encode === 'split' && s.fields ? [s.fields.width, s.fields.height] : [s.key]);

/**
 * 内置卡 + schema 卡主体（fromJsonSchema 的 { params, inputs, wire }）→ 合并卡（新对象，不改内置卡）。
 * 没有可追加的东西时原样返回内置卡（同一个对象）。
 * 合并卡多出：schemaMerged:true、schemaAdded:[追加的参数键]、函数 wire 的卡另有 wireExtra。
 */
export function mergeBuiltinWithSchema(builtin, schemaBody) {
  if (!builtin || !schemaBody || !Array.isArray(schemaBody.params)) return builtin;
  const covered = coveredFields(builtin);
  // 整个发出去的字段（没有子字段记录：json 参数、非对象值）——schema 拍平的它的子字段都算发过
  const whole = new Set([...covered].filter((k) => !k.includes('.') && ![...covered].some((c) => c.startsWith(k + '.'))));
  const isCovered = (f) => covered.has(f) || (f.includes('.') && whole.has(f.slice(0, f.indexOf('.'))));
  const ownKeys = new Set((builtin.params || []).map((s) => s.key));
  const isFn = typeof builtin.wire === 'function';
  const sIn = schemaBody.inputs || {};
  const sW = schemaBody.wire || {};

  // ① 参数：schema 有、内置卡没发的
  const added = [];
  for (const s of schemaBody.params) {
    if (s.key === 'extra' || ownKeys.has(s.key)) continue;
    if (typeof s.desc === 'string' && DEPRECATED.test(s.desc)) continue;
    // 已经映射过的上游字段不重复追加
    if (fieldsOf(s).every(isCovered)) continue;
    added.push({ ...s, group: 'advanced' });
  }

  // ② 素材角色 / 负面提示词：schema 有、内置卡没有的
  const inputs = { ...(builtin.inputs || {}) };
  const roles0 = builtin.inputs?.images?.roles || [];
  const addImages = {};
  for (const [role, slot] of Object.entries(sW.images || {})) {
    if (roles0.includes(role) || !slot?.field || covered.has(slot.field)) continue;
    addImages[role] = slot;
  }
  const newRoles = Object.keys(addImages);
  if (newRoles.length) {
    const had = builtin.inputs?.images;
    const sMax = sIn.images?.max ?? 1;
    // 上限以内置卡为准；内置卡原来只有首尾帧、补的是改图 / 参考图时才放宽到 schema 的
    const widen = newRoles.some((r) => r === 'edit' || r === 'ref') && !roles0.some((r) => r === 'edit' || r === 'ref');
    inputs.images = had ? { ...had, roles: [...roles0, ...newRoles], max: widen ? Math.max(had.max ?? 0, sMax) : had.max } : { max: sMax, roles: newRoles };
  }
  const addMedia = {};
  for (const r of ['video', 'audio']) {
    if (sIn[r] && sW[r]?.field && !builtin.inputs?.[r] && !covered.has(sW[r].field)) { inputs[r] = { ...sIn[r] }; addMedia[r] = sW[r]; }
  }
  let addNegative = null;
  if (sIn.negative && sW.negative && !builtin.inputs?.negative && !covered.has(sW.negative)) { inputs.negative = true; addNegative = sW.negative; }
  if (inputs.negative && sIn.negativeDefault && builtin.inputs?.negativeDefault === undefined) inputs.negativeDefault = sIn.negativeDefault;

  const changedInputs = newRoles.length || Object.keys(addMedia).length || addNegative || inputs.negativeDefault !== builtin.inputs?.negativeDefault;
  if (!added.length && !changedInputs) return builtin;

  // 追加参数排在 extra 之前
  const params = [...(builtin.params || [])];
  const at = params.findIndex((s) => s.key === 'extra' && s.type === 'json');
  params.splice(at >= 0 ? at : params.length, 0, ...added);

  const card = { ...builtin, params, inputs, schemaMerged: true, schemaAdded: added.map((s) => s.key) };
  if (isFn) {
    card.wireExtra = {
      params: added.map((s) => s.key),
      ...(newRoles.length ? { images: addImages } : {}),
      ...addMedia,
      ...(addNegative ? { negative: addNegative } : {}),
    };
  } else if (newRoles.length || Object.keys(addMedia).length || addNegative) {
    const w = builtin.wire || {};
    card.wire = {
      ...w,
      ...(newRoles.length ? { images: { ...(w.images || {}), ...addImages } } : {}),
      ...addMedia,
      ...(addNegative ? { negative: addNegative } : {}),
    };
  }
  // 内置卡自带 normalize（照抄旧路由的夹紧）：它管它的，追加的参数按 ParamSpec 规范化后并进去
  if (typeof builtin.normalize === 'function' && added.length) {
    const own = builtin.normalize;
    card.normalize = function (raw = {}, ctx = {}) { return { ...applySpecs(added, raw, ctx), ...own.call(this, raw, ctx) }; };
  }
  return card;
}
