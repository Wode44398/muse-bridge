// 推理的加密内容代存。订阅通道必须 store:false，上一步的推理要靠请求里带回 reasoning 条目（encrypted_content）才接得上；
// 但 Claude、dimensio 说的是 Chat Completions，回放历史时没有地方放它。网关在回复流里收下推理条目，
// 按这一步的 tool call id（没有调用的就按回复正文）记住，下一轮请求里认出同一个调用 / 同一段正文再塞回去。
// 只在内存里（重启后老会话照样能跑，只是那一步的推理接不上）；按账号分开存——别的账号的密文发过去会被拒。
import { createHash } from 'node:crypto';

const MAX_ENTRIES = 6000;
const MAX_BYTES = 64 * 1024 * 1024;
const map = new Map();   // key → { items, bytes }
let bytes = 0;

const textKey = (scope, text) => `${scope}|t|${createHash('sha256').update(String(text).trim()).digest('hex').slice(0, 40)}`;
const callKey = (scope, id) => `${scope}|c|${id}`;
const sizeOf = (items) => items.reduce((n, x) => n + String(x.encrypted_content || '').length + JSON.stringify(x.summary || []).length + 64, 0);

function put(key, items, size) {
  const old = map.get(key);
  if (old) { bytes -= old.bytes; map.delete(key); }
  map.set(key, { items, bytes: size });
  bytes += size;
  while (map.size > MAX_ENTRIES || bytes > MAX_BYTES) {
    const [k0, v0] = map.entries().next().value;
    map.delete(k0); bytes -= v0.bytes;
  }
}
function get(key) {
  const v = map.get(key);
  if (!v) return null;
  map.delete(key); map.set(key, v);   // 最近用过的挪到最后
  return v.items.map((x) => ({ ...x }));
}

/** 记下一步回复里的推理条目。scope = 服务/线路；callIds = 这一步的工具调用；text = 这一步的回复正文（没有调用时用它认）。 */
export function rememberReasoning(scope, { items, callIds = [], text = '' }) {
  const list = (items || []).filter((x) => x && x.type === 'reasoning' && x.encrypted_content);
  if (!list.length) return;
  const size = sizeOf(list);
  if (size > MAX_BYTES / 8) return;
  if (callIds.length) put(callKey(scope, callIds[0]), list, size);
  else if (String(text).trim()) put(textKey(scope, text), list, size);
}
/** 回放：按这一步的第一个工具调用，或（没有调用时）按回复正文找回推理条目。 */
export function recallReasoning(scope, { callIds = [], text = '' }) {
  if (callIds.length) { for (const id of callIds) { const v = get(callKey(scope, id)); if (v) return v; } return null; }
  return String(text).trim() ? get(textKey(scope, text)) : null;
}
export function _resetReasoningForTests() { map.clear(); bytes = 0; }
