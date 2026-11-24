// Responses 请求 → Anthropic Messages 形状的请求体（Claude 外接服务那套改写 applyParams / toOpenAI 吃的就是这个形状，
// 输出上限、采样参数、思考档位、看图能力、各家回传思考的写法都不用再写一遍）。
//
//   toMessagesBody(req, { replayThinking })  → { body, names }    names = 展平工具名 → 原工具（回程还原用）
//   effortFor(req, spec)                     → 这一轮的档位 id（'' = 模型默认档）
//   jsonFormatOf(req)                        → text.format 要的 JSON Schema 输出（没有回 null）
import { toNeutral } from './input.mjs';
import { convertTools } from './tools.mjs';
import { tierForLevel } from '../../claude-providers-transform.mjs';
import { OFF_TIER_IDS } from '../../../model-knowledge/knowledge.mjs';

const OFF = new Set(OFF_TIER_IDS);

function imageBlock(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return /^https?:\/\//i.test(url) ? { type: 'image', source: { type: 'url', url } } : null;
}

function parseArgs(text) {
  if (!text) return {};
  try { const j = JSON.parse(text); return j && typeof j === 'object' && !Array.isArray(j) ? j : { value: j }; } catch { return { _raw: String(text) }; }
}

/**
 * replayThinking：历史里的思考摘要要不要作为 thinking 块带上。OpenAI 协议要（toOpenAI 按型号决定要不要转成 reasoning_content 回传）；
 * Anthropic 协议不要——没有签名的 thinking 块官方直接拒收，第三方的 Anthropic 兼容端点缺的由 applyParams 补空块。
 */
export function toMessagesBody(req, { replayThinking = true } = {}) {
  const { system, messages } = toNeutral(req);
  // 输入里的 additional_tools 项（某些型号把工具放在这里，不在 tools 里）
  const extra = (Array.isArray(req.input) ? req.input : []).filter((x) => x && x.type === 'additional_tools' && Array.isArray(x.tools)).flatMap((x) => x.tools);
  const { list, names } = convertTools(req.tools, extra);
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    // 连着几条同角色的（工具结果后面紧跟一条用户消息）并成一条：Anthropic 要求一问一答交替
    if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = m.parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : imageBlock(p.url))).filter(Boolean);
      if (blocks.length) push('user', blocks);
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (replayThinking && m.reasoning) blocks.push({ type: 'thinking', thinking: m.reasoning, signature: '' });
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const c of m.calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: parseArgs(c.args) });
      if (blocks.length) push('assistant', blocks);
    } else if (m.role === 'tool') {
      const content = [{ type: 'text', text: m.text || '(empty)' }, ...m.images.map(imageBlock).filter(Boolean)];
      push('user', [{ type: 'tool_result', tool_use_id: m.id, content }]);
    }
  }
  // 第一条必须是 user（历史被 Codex 压缩过、开头就是 assistant 时）
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: '(empty)' }] });

  const body = { model: String(req.model || ''), stream: true, messages: out };
  const fmt = jsonFormatOf(req);
  const sys = [system, fmt ? `Respond only with a JSON value that matches this JSON Schema:\n${JSON.stringify(fmt.schema)}` : ''].filter(Boolean).join('\n\n');
  if (sys) body.system = sys;
  if (list.length) {
    body.tools = list.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const tc = req.tool_choice;
    if (tc === 'required') body.tool_choice = { type: 'any' };
    else if (tc === 'none') body.tool_choice = { type: 'none' };
    else if (tc && typeof tc === 'object' && tc.type === 'function' && tc.name) {
      const flat = [...names].find(([, v]) => v.name === tc.name && !v.namespace)?.[0];
      if (flat) body.tool_choice = { type: 'tool', name: flat };
    }
  }
  if (Number.isFinite(req.max_output_tokens) && req.max_output_tokens > 0) body.max_tokens = Math.round(req.max_output_tokens);
  if (typeof req.temperature === 'number') body.temperature = req.temperature;
  if (typeof req.top_p === 'number') body.top_p = req.top_p;
  return { body, names };
}

/** Codex 的推理强度（none / minimal / low / medium / high / xhigh）→ 这个模型档位表里的一档。 */
export function effortFor(req, spec) {
  const lv = String(req?.reasoning?.effort || '').toLowerCase();
  const tiers = (spec && spec.efforts) || [];
  if (!lv || !tiers.length) return '';
  const same = tiers.find((t) => t.id.toLowerCase() === lv);
  if (same) return same.id;
  if (lv === 'none') return (tiers.find((t) => OFF.has(t.id)) || {}).id || '';
  return tierForLevel(spec, lv === 'minimal' ? 'low' : lv);
}

/** text.format = { type: 'json_schema', name, schema, strict } → { name, schema, strict }。 */
export function jsonFormatOf(req) {
  const f = req?.text?.format;
  if (!f || f.type !== 'json_schema' || !f.schema || typeof f.schema !== 'object') return null;
  return { name: String(f.name || 'output').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'output', schema: f.schema, strict: f.strict !== false };
}
