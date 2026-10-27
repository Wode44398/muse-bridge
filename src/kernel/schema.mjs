// 插件配置的 schema：写法与 agent 接口的操作参数（agent-api/registry.mjs 的 params）同一套，
// 插件作者只学一种：
//
//   { 字段名: { type, label?, desc?, default?, enum?, min?, max?, required?, secret?, multiline? } }
//   type ∈ string | integer | number | boolean | array | object | map | user
//
// 设置页按它自动生成表单（插件不用写前端）；服务端按它校验、补默认值；secret 字段对外一律打码，
// 回传打码值 = 沿用旧值（同扩展中心连接器的口径）。
//
// 表单用的可选字段（服务端只透传）：section 分组标题、when 条件显示 { 字段: 值 | [值…] }、widget 控件形态
// （textarea / slider / chips / segmented / password）、options 动态选项（'claude.models' / 'claude.efforts' / 'users' /
// 'users:user' / 'users:service' / 'plugin'）。
//
// 结构化字段：
//   array  + items: { 字段 spec }               列表，每项按 items 校验；items.type 'object' + items.fields 时每行一个小表单。max = 最多几项
//   object + fields: { 子字段: spec }           固定结构的对象（不写 fields 就是任意 JSON 对象，同以前）
//   map    + key?: { label?, max?, pattern? }   按键编辑的表（如「按群设置」），键是字符串；
//          + value: spec 或 { 子字段: spec }     值按 value 校验（不带 type 的写法 = 一组子字段）。max = 最多几行
//   user   + grant?: 'chat' + allowHost?        选一个 bridge 账号（值 = 登录名 / 账号 id，'@host' = 服务器主机，要 allowHost）。
//          grant:'chat' = 选中即授权插件以这个账号跑 Claude（plugins/chat.mjs）

export const MASK = '••••••••';
const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array', 'object', 'map', 'user']);

export class ConfigError extends Error {
  constructor(field, message) { super(field ? `${field}：${message}` : message); this.field = field || ''; }
}

// 清单里写来的 schema 先过一遍：坏字段直接报错（装插件时就该知道，而不是用的时候才炸）。
export function normalizeSchema(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('', 'config 应为对象：{ 字段名: { type, default, … } }');
  const out = {};
  for (const [k, s] of Object.entries(raw)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new ConfigError(k, '字段名只能用字母、数字、下划线');
    out[k] = normalizeSpec(k, s, 0);
  }
  return out;
}

// 不带 type 的对象 = 一组子字段（map 的 value 简写）
const isFields = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.type !== 'string';

function normalizeFields(name, raw, depth) {
  const out = {};
  for (const [k, s] of Object.entries(raw || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new ConfigError(`${name}.${k}`, '字段名只能用字母、数字、下划线');
    out[k] = normalizeSpec(`${name}.${k}`, s, depth + 1);
  }
  return out;
}

function normalizeSpec(k, s, depth) {
  if (!s || typeof s !== 'object' || !TYPES.has(s.type)) throw new ConfigError(k, `type 只能是 ${[...TYPES].join(' / ')}`);
  if (s.enum != null && !Array.isArray(s.enum)) throw new ConfigError(k, 'enum 应为数组');
  if (depth > 2) throw new ConfigError(k, '嵌套太深（最多两层）');
  const spec = { ...s };
  if (s.type === 'array' && s.items != null) {
    if (!s.items || typeof s.items !== 'object' || s.items.type === 'array' || s.items.type === 'map') throw new ConfigError(k, 'items 应为一个非列表、非表的字段 spec');
    spec.items = normalizeSpec(k + '[]', s.items, depth + 1);
  }
  if (s.type === 'object' && s.fields != null) {
    if (!isFields(s.fields)) throw new ConfigError(k, 'fields 应为 { 子字段: spec }');
    spec.fields = normalizeFields(k, s.fields, depth);
  }
  if (s.type === 'map') {
    if (s.value == null || typeof s.value !== 'object') throw new ConfigError(k, 'map 要写 value（值的 spec，或一组子字段）');
    spec.value = isFields(s.value) ? { type: 'object', fields: normalizeFields(k, s.value, depth) } : normalizeSpec(k + '{}', s.value, depth + 1);
    if (spec.value.type === 'map' || spec.value.type === 'array') throw new ConfigError(k, 'map 的值不能再是列表或表');
    spec.key = s.key && typeof s.key === 'object' ? { ...s.key } : {};
    if (spec.key.pattern != null) { try { new RegExp(spec.key.pattern); } catch { throw new ConfigError(k, 'key.pattern 不是合法正则'); } }
  }
  if (s.type === 'user' && s.grant != null && s.grant !== 'chat') throw new ConfigError(k, "grant 只能是 'chat'");
  if (s.pattern != null) { try { new RegExp(s.pattern); } catch { throw new ConfigError(k, 'pattern 不是合法正则'); } }
  return spec;
}

function coerce(name, spec, v) {
  const bad = (msg) => { throw new ConfigError(name, msg); };
  switch (spec.type) {
    case 'string':
      if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
      if (typeof v !== 'string') bad('应为文字');
      if (spec.max != null && v.length > spec.max) bad(`太长（上限 ${spec.max} 字）`);
      if (spec.min != null && v.length < spec.min) bad(`太短（至少 ${spec.min} 字）`);
      if (spec.pattern && v !== '' && !new RegExp(spec.pattern).test(v)) bad(`「${v.slice(0, 20)}」格式不对`);
      break;
    case 'integer':
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) bad('应为数字');
      if (spec.type === 'integer' && !Number.isInteger(n)) bad('应为整数');
      if (spec.min != null && n < spec.min) bad(`不能小于 ${spec.min}`);
      if (spec.max != null && n > spec.max) bad(`不能大于 ${spec.max}`);
      v = n;
      break;
    }
    case 'boolean':
      if (v === 'true' || v === 1) v = true;
      else if (v === 'false' || v === 0) v = false;
      if (typeof v !== 'boolean') bad('应为开 / 关');
      break;
    case 'user':
      if (typeof v !== 'string') bad('应为账号名');
      v = v.trim();
      if (!v) bad('没选账号');
      if (v.length > 64) bad('账号名太长');
      if (v === '@host' && !spec.allowHost) bad('这里不能选服务器主机');
      break;
    case 'array':
      if (typeof v === 'string') v = v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (!Array.isArray(v)) bad('应为列表');
      if (spec.max != null && v.length > spec.max) bad(`最多 ${spec.max} 项`);
      if (spec.items) v = v.map((x, i) => coerce(`${name}[${i + 1}]`, spec.items, x));
      return v;   // enum 约束的是每一项（items.enum），不是整个列表
    case 'object':
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { bad('应为 JSON 对象'); } }
      if (!v || typeof v !== 'object' || Array.isArray(v)) bad('应为对象');
      if (spec.fields) v = coerceFields(name, spec.fields, v);
      break;
    case 'map': {
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { bad('应为 JSON 对象'); } }
      if (!v || typeof v !== 'object' || Array.isArray(v)) bad('应为对象');
      const keys = Object.keys(v);
      if (keys.length > (spec.max ?? 500)) bad(`最多 ${spec.max ?? 500} 行`);
      const re = spec.key?.pattern ? new RegExp(spec.key.pattern) : null;
      const out = {};
      for (const key of keys) {
        const kk = String(key).trim();
        if (!kk) bad('有一行没填键');
        if (kk.length > (spec.key?.max ?? 64)) bad(`键「${kk.slice(0, 20)}…」太长`);
        if (re && !re.test(kk)) bad(`键「${kk}」格式不对`);
        if (kk === '__proto__' || kk === 'constructor' || kk === 'prototype') bad(`键「${kk}」不能用`);
        out[kk] = coerce(`${name}.${kk}`, spec.value, v[key]);
      }
      return out;
    }
    default: break;
  }
  if (spec.enum && !spec.enum.some((e) => e === v || (e && typeof e === 'object' && e.value === v))) {
    bad('只能是 ' + spec.enum.map((e) => (e && typeof e === 'object' ? e.value : e)).join(' / ') + ' 之一');
  }
  return v;
}

// 固定结构的子对象：缺的子字段用默认值，不认识的丢掉。
function coerceFields(name, fields, v) {
  const out = {};
  for (const [k, spec] of Object.entries(fields)) {
    const x = v[k];
    if (x === undefined || x === null || (x === '' && spec.type !== 'string')) {
      if (spec.default !== undefined) out[k] = clone(spec.default);
      else if (spec.required) throw new ConfigError(`${name}.${k}`, '必填');
      continue;
    }
    out[k] = coerce(`${name}.${k}`, spec, x);
  }
  return out;
}

const enumValue = (e) => (e && typeof e === 'object' ? e.value : e);
const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

// 结构化字段没写默认值时的空值：map → {}、带 items 的列表 → []、带 fields 的对象 → 各子字段的默认值。
// 插件读 config.groups[id]、config.list.length 时不用先判空。
function emptyOf(spec) {
  if (spec.type === 'map') return {};
  if (spec.type === 'array' && spec.items) return [];
  if (spec.type === 'object' && spec.fields) { try { return coerceFields('', spec.fields, {}); } catch { return undefined; } }
  return undefined;
}

// 存着的配置 → 生效配置：补默认值；存着的值坏了（升级后 schema 变了之类）退回默认值并记一条问题，不让插件起不来。
export function resolveConfig(schema, stored) {
  const input = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const config = {};
  const problems = [];
  const fallback = (k, spec) => {
    if (spec.default !== undefined) config[k] = clone(spec.default);
    else { const e = emptyOf(spec); if (e !== undefined) config[k] = e; }
  };
  for (const [k, spec] of Object.entries(schema || {})) {
    const v = input[k];
    if (v === undefined || v === null || (v === '' && spec.type !== 'string')) {
      fallback(k, spec);
      if (config[k] === undefined && spec.enum && spec.enum.length && spec.required) config[k] = enumValue(spec.enum[0]);
      if (spec.required && config[k] === undefined) problems.push(new ConfigError(k, '必填，还没填').message);
      continue;
    }
    try { config[k] = coerce(k, spec, v); }
    catch (e) {
      problems.push(e.message);
      fallback(k, spec);
    }
  }
  return { config, problems };
}

// 设置页 / 接口提交来的配置：严格校验（错一项整体拒），打码的 secret 沿用旧值；不认识的字段丢掉。
export function validateConfig(schema, next, prev = {}) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new ConfigError('', '配置应为对象');
  const out = {};
  for (const [k, spec] of Object.entries(schema || {})) {
    let v = next[k];
    if (spec.secret && v === MASK) v = prev[k];
    if (v === undefined || v === null || (v === '' && spec.type !== 'string')) {
      if (spec.required && spec.default === undefined) throw new ConfigError(k, '必填');
      continue;   // 不存 = 用默认值
    }
    out[k] = coerce(k, spec, v);
  }
  return out;
}

// 对外展示用：secret 字段有值就换成打码串。
export function maskConfig(schema, config) {
  const out = { ...(config || {}) };
  for (const [k, spec] of Object.entries(schema || {})) {
    if (spec.secret && out[k] != null && out[k] !== '') out[k] = MASK;
  }
  return out;
}
