// 模型中心的「测试线路」与「拉模型列表」：钉在一条线路上直接打上游（不过网关、不动线路状态）。
import { lineFetch, scrubKey, netText, isBadHeader, BAD_HEADER_MSG } from './pool.mjs';

// 上游报错 / 连不上的原因：一律先抹 Key 再截断（上游可能回显 Key；请求头不合法时 undici 的原文里就是整段 Key）
const errText = async (r, key) => {
  const t = await r.text().catch(() => '');
  try { const j = JSON.parse(t); const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.detail; if (m) return scrubKey(typeof m === 'string' ? m : JSON.stringify(m), key).slice(0, 240); } catch {}
  return scrubKey(t.replace(/\s+/g, ' '), key).slice(0, 240);
};
const netErr = (e, key) => (e?.name === 'TimeoutError' ? '超时' : isBadHeader(e) ? BAD_HEADER_MSG : '连不上：' + netText(e, key, 120));

/** 拉这条线路上的模型列表 → [id]。 */
export async function fetchLineModels(service, line, key) {
  const rest = service.kind === 'anthropic' ? '/v1/models' : '/models';
  let r;
  try { r = await lineFetch(service, line, key, rest, { search: service.kind === 'gemini' ? '?pageSize=1000' : '' }); }
  catch (e) { throw Object.assign(new Error(netErr(e, key)), { status: isBadHeader(e) ? 400 : 502 }); }
  if (!r.ok) throw Object.assign(new Error(`拉不到模型列表（HTTP ${r.status}）：${await errText(r, key)}`), { status: 502 });
  const j = await r.json().catch(() => null);
  const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
  const ids = arr.map((m) => String(m?.id ?? m?.name ?? '').replace(/^models\//, '')).filter(Boolean);
  if (!ids.length) throw Object.assign(new Error('这个端点没有列出任何模型：手动填型号 ID'), { status: 502 });
  return [...new Set(ids)].slice(0, 500);
}

/** 用这条线路真打一次最小请求 → { ok, status, ms, error }。 */
export async function testLine(service, line, key, model) {
  const t0 = Date.now();
  const say = { role: 'user', content: 'hi' };
  let rest, body;
  if (service.kind === 'anthropic') { rest = '/v1/messages'; body = { model, max_tokens: 16, messages: [say] }; }
  else if (service.kind === 'gemini') { rest = `/models/${encodeURIComponent(model)}:generateContent`; body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }; }
  else { rest = '/chat/completions'; body = { model, max_tokens: 16, messages: [say] }; }
  let r;
  try { r = await lineFetch(service, line, key, rest, { method: 'POST', body, timeoutMs: 60_000 }); }
  catch (e) { return { ok: false, status: 0, ms: Date.now() - t0, error: netErr(e, key) }; }
  if (r.ok) { await r.body?.cancel?.().catch(() => {}); return { ok: true, status: r.status, ms: Date.now() - t0, error: '' }; }
  return { ok: false, status: r.status, ms: Date.now() - t0, error: await errText(r, key) };
}
