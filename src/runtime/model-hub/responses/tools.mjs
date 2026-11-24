// Codex 的 Responses 工具表 → Chat Completions / Anthropic 都认的「函数」清单，外加回程用的名字表。
//
//   function   原样（名字、说明、参数、strict）
//   namespace  里面的每个工具展平成 <命名空间>__<名字>；回程按名字表还原，并带上 namespace 字段
//   custom     （apply_patch 这类自由文本工具）→ 只有一个字符串参数 input 的函数，语法写进说明；回程变回 custom_tool_call
//   其余       托管工具（web_search、image_generation、file_search…）上游跑不了；tool_search 要回 Codex 专有的调用项，也不转
import { createHash } from 'node:crypto';

// 两边的函数名都只收这些字符、最多 64 个
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMPTY_PARAMS = Object.freeze({ type: 'object', properties: {} });
const CUSTOM_PARAMS = Object.freeze({
  type: 'object',
  properties: { input: { type: 'string', description: 'The raw tool input, exactly as the tool description specifies (not JSON-encoded).' } },
  required: ['input'],
  additionalProperties: false,
});

/** 展平后的函数名：不合规则的字符换成 _，超长的截短后补一段哈希（同一个原名每次得到同一个结果）。 */
export function flatName(name, namespace = '') {
  const raw = namespace ? `${namespace}__${name}` : String(name || '');
  if (NAME_RE.test(raw)) return raw;
  // 改过的名字都补哈希：a.b 与 a_b 不会撞成同一个
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 55) || 'tool';
  return `${clean}_${createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
}

function customDescription(t) {
  const parts = [String(t.description || '').trim()];
  parts.push('Put the entire raw input in the `input` string argument.');
  const f = t.format;
  if (f && f.type === 'grammar' && typeof f.definition === 'string') {
    parts.push(`The input must follow this ${f.syntax ? f.syntax + ' ' : ''}grammar:\n${f.definition}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * tools（请求的 tools）+ extra（输入里 additional_tools 项带的工具）→
 * { list: [{ name, description, parameters, strict? }], names: Map(展平名 → { kind: 'function' | 'custom', name, namespace? }) }
 */
export function convertTools(tools, extra = []) {
  const list = [], names = new Map();
  const add = (t, namespace = '') => {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.name) return;
    if (t.type !== 'function' && t.type !== 'custom') return;
    const name = flatName(t.name, namespace);
    if (names.has(name)) return;
    names.set(name, { kind: t.type, name: t.name, ...(namespace ? { namespace } : {}) });
    if (t.type === 'custom') {
      list.push({ name, description: customDescription(t), parameters: CUSTOM_PARAMS });
      return;
    }
    list.push({
      name, description: typeof t.description === 'string' ? t.description : '',
      parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : EMPTY_PARAMS,
      ...(typeof t.strict === 'boolean' ? { strict: t.strict } : {}),
    });
  };
  for (const t of [...(Array.isArray(tools) ? tools : []), ...(Array.isArray(extra) ? extra : [])]) {
    if (t?.type === 'namespace' && Array.isArray(t.tools) && typeof t.name === 'string') {
      for (const x of t.tools) add(x, t.name);
    } else add(t);
  }
  return { list, names };
}

/** 历史里的一次调用（function_call / custom_tool_call）→ 发给上游的函数名与参数文本。 */
export function callForUpstream(item) {
  if (item.type === 'custom_tool_call') {
    return { name: flatName(item.name, item.namespace || ''), args: JSON.stringify({ input: typeof item.input === 'string' ? item.input : String(item.input ?? '') }) };
  }
  return { name: flatName(item.name, item.namespace || ''), args: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) };
}

/**
 * 上游回来的一次调用（展平名 + 参数文本）→ 回给 Codex 的输出项（不含 id / status）。
 * 名字表里没有的（模型编出来的名字）按普通函数原样回，Codex 自己会回「没有这个工具」。
 */
export function callForCodex(names, flat, args, callId) {
  const hit = names.get(flat);
  if (hit && hit.kind === 'custom') {
    let input = args;
    try { const j = JSON.parse(args); if (j && typeof j.input === 'string') input = j.input; else if (typeof j === 'string') input = j; } catch {}
    return { type: 'custom_tool_call', call_id: callId, name: hit.name, input, ...(hit.namespace ? { namespace: hit.namespace } : {}) };
  }
  return {
    type: 'function_call', call_id: callId, name: hit ? hit.name : flat, arguments: args || '{}',
    ...(hit?.namespace ? { namespace: hit.namespace } : {}),
  };
}
