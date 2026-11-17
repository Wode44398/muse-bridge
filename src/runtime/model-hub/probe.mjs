// 模型中心的「测试线路」「拉模型列表」与「探测能力」：钉在一条线路上直接打上游（不过网关、不动线路状态）。
import { lineFetch, scrubKey, netText, isBadHeader, BAD_HEADER_MSG } from './pool.mjs';
import { vendorText, parseLimit, parseEffortList, looksNotChat, RED_PNG } from '../../model-knowledge/diagnose.mjs';

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

// —— 探测一个文本模型的能力（2026-11-17）：型号表不认识的模型（上游 /models 列不出、手动添加的新型号）真打几次一两句话的请求 ——
// 读出来的：是不是对话模型、不发思考参数会不会想、输出上限（超大 max_tokens 的报错里读，不扣费；端点不校验就读不出）、
// 能不能看图（32×32 红图）、OpenAI 端点认哪些 reasoning_effort（乱填一个，从报错里读）。上下文窗口不探：
// 要发一段超长输入才读得出，端点不校验时那就是一次百万 token 的真请求。
const say = (rest, body) => ({ rest, body });
function probeReq(kind, model, what) {
  const q = what === 'vision' ? '这张图是什么颜色？只回答颜色。' : what === 'limit' ? 'hi' : '1+1 等于几？只回答数字。';
  const max = what === 'limit' ? 10_000_000 : 2048;
  if (kind === 'anthropic') {
    const content = what === 'vision' ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: RED_PNG } }, { type: 'text', text: q }] : q;
    return say('/v1/messages', { model, max_tokens: max, messages: [{ role: 'user', content }] });
  }
  if (kind === 'gemini') {
    const parts = what === 'vision' ? [{ inlineData: { mimeType: 'image/png', data: RED_PNG } }, { text: q }] : [{ text: q }];
    return say(`/models/${encodeURIComponent(model)}:generateContent`, { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: max } });
  }
  const content = what === 'vision' ? [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + RED_PNG } }, { type: 'text', text: q }] : q;
  return say('/chat/completions', { model, max_tokens: max, messages: [{ role: 'user', content }], ...(what === 'effort' ? { max_tokens: 16, reasoning_effort: 'zzz-bridge-probe' } : {}) });
}
// 回复 → { text, thought }（thought：这一次有没有想）
function readReply(kind, j) {
  if (kind === 'anthropic') {
    const blocks = Array.isArray(j?.content) ? j.content : [];
    return { text: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join(''), thought: blocks.some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking') };
  }
  if (kind === 'gemini') {
    const parts = j?.candidates?.[0]?.content?.parts || [];
    return { text: parts.filter((p) => !p?.thought).map((p) => p?.text || '').join(''), thought: parts.some((p) => p?.thought) || (j?.usageMetadata?.thoughtsTokenCount || 0) > 0 };
  }
  const msg = j?.choices?.[0]?.message || {};
  const r = msg.reasoning_content ?? msg.reasoning ?? '';
  return { text: String(msg.content || ''), thought: (typeof r === 'string' && r.trim().length > 0) || (j?.usage?.completion_tokens_details?.reasoning_tokens || 0) > 0 };
}
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** → { kind:'text'|'other', thinks?, maxOutput?, vision?, effortIds?, effortOff?, notes:[中文句子], error? }。只读不写。 */
export async function probeLineModel(service, line, key, model) {
  const once = async (what) => {
    const { rest, body } = probeReq(service.kind, model, what);
    try {
      const r = await lineFetch(service, line, key, rest, { method: 'POST', body, timeoutMs: 60_000 });
      const text = await r.text().catch(() => '');
      let json = null; try { json = JSON.parse(text); } catch {}
      return { ok: r.ok, status: r.status, text: scrubKey(text, key), json };
    } catch (e) { return { ok: false, status: 0, text: netErr(e, key), json: null }; }
  };
  const whats = ['plain', 'limit', 'vision', ...(service.kind === 'openai' ? ['effort'] : [])];
  const [plain, limit, vision, effort] = await Promise.all(whats.map(once));
  const out = { notes: [] };
  // 结论是成句的中文（界面用 tr() 按原文键的模板翻）
  const note = (k, params = {}) => out.notes.push(k.replace(/\{(\w+)\}/g, (m, x) => (x in params ? String(params[x]) : m)));
  const msgOf = (x) => (vendorText(x.text).msg || x.text).replace(/\s+/g, ' ').slice(0, 200);
  if (!plain.ok) {
    if (looksNotChat(plain.status, plain.text)) { out.kind = 'other'; note('普通对话被拒：{e}', { e: msgOf(plain).slice(0, 120) }); return out; }
    out.error = plain.status ? `HTTP ${plain.status}：${msgOf(plain)}` : plain.text;
    return out;
  }
  out.kind = 'text';
  out.thinks = readReply(service.kind, plain.json).thought;
  note(out.thinks ? '不发思考参数也会思考' : '不发思考参数时不思考');
  if (!limit.ok) { const n = parseLimit(limit.text); if (n) { out.maxOutput = n; note('输出上限 {n}', { n }); } else note('输出上限没读出来'); }
  else note('输出上限没读出来（端点没校验）');
  if (vision.ok) {
    const r = readReply(service.kind, vision.json).text;
    out.vision = /红|red/i.test(r);
    note(out.vision ? '能看图' : '看图答错了（{r}）', out.vision ? undefined : { r: r.slice(0, 20) });
  } else if (vision.status === 400) { out.vision = false; note('不收图片'); }
  if (effort && !effort.ok) {
    const ids = parseEffortList(effort.text);
    if (ids) {
      out.effortIds = EFFORT_ORDER.filter((x) => ids.includes(x));
      out.effortOff = ids.includes('none');
      if (out.effortIds.length) note('reasoning_effort 可选：{ids}', { ids: ids.join(' / ') });
      else delete out.effortIds;
    }
  }
  return out;
}
