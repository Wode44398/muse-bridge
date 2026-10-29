// Drive Google Gemini through Vertex AI from the bridge.
//
// Gemini via @google/genai is stateless per call: there's no session to resume. So we
// rebuild the whole conversation each turn by passing the saved sidecar history
// as the `contents` array. Auth is ADC (gcloud auth application-default login);
// the SDK picks it up from the environment, we only pass project + location.
import { vertexGenAI, vertexClientKey } from './google-clients.mjs';
import { VERTEX_NO_MINIMAL, VERTEX_CODE_SOLO } from '@bridge/core/config/capabilities.mjs';

// One client per project+location (the bridge is single-user). Lazily built.
const clients = new Map();
function client(project, location) {
  const key = vertexClientKey(project, location);
  let ai = clients.get(key);
  if (!ai) { ai = vertexGenAI({ project, location }); clients.set(key, ai); }
  return ai;
}

// Map our stored {role:'user'|'assistant'} turns to Gemini's {role:'user'|'model'}.
// files: 本轮用户附带的多模态附件 [{mime, data(base64)}]，作为 inlineData parts 排在
// 文本前（仅当轮生效；侧车历史只存文本，重放不回传二进制——见 agents/vertex.mjs 标注）。
function toContents(history, message, files) {
  const contents = [];
  for (const t of (history || [])) {
    const text = String(t.text || '');
    if (!text.trim()) continue;
    contents.push({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
  }
  const parts = (files || []).map((f) => ({ inlineData: { mimeType: f.mime, data: f.data } }));
  parts.push({ text: String(message) });
  contents.push({ role: 'user', parts });
  return contents;
}

// Translate a unified thinking level (minimal/low/medium/high) into the knob the
// model family actually accepts: Gemini 3 takes `thinkingLevel`; Gemini 2.5 only
// takes `thinkingBudget` (token count; 2.5-pro can't be 0). Values verified
// available on this project.
// Gemini 3 及以后（含 gemini-4-argon）都是 thinkingLevel 家族——只有 2.x 走 thinkingBudget。
// 旧写法 /gemini-3/ 会把 4 代当成 2.5 发 thinkingBudget，Vertex 直接 400（2026-10-13 实测）。
const LEVEL_FAMILY = /gemini-(?![12]\.)\d/;
function thinkingFor(model, level) {
  if (!level) return undefined;
  let lv = String(level).toLowerCase();
  // 有些模型拒 minimal（3.x Pro 与 3.7/3.8 Flash 400 `Thinking level is unsupported`；
  // 2.5 Pro 关不掉思考）。夹成 low，免得旧客户端/routines/MCP 传来的 minimal 炸掉整轮。
  // 名单读 capabilities 的 noMinimal（前端摘菜单用的是同一张表）——旧实现按 /pro/ 正则
  // 猜，2026-09-02 实测漏掉了 3.7/3.8 Flash（当时的默认模型，选 Minimal 必 400）。
  if (lv === 'minimal' && VERTEX_NO_MINIMAL.has(model)) lv = 'low';
  if (LEVEL_FAMILY.test(model)) return { thinkingLevel: lv.toUpperCase() }; // MINIMAL/LOW/MEDIUM/HIGH
  // Gemini 2.5: map level -> budget. -1 = automatic, 0 = off.
  const map = { minimal: 0, low: 512, medium: -1, high: 24576 };
  return { thinkingBudget: map[lv] != null ? map[lv] : -1 };
}

// Pull web sources out of a chunk's grounding metadata, deduped by URI.
function collectSources(chunk, seen, out) {
  const gm = chunk?.candidates?.[0]?.groundingMetadata;
  for (const g of (gm?.groundingChunks || [])) {
    const w = g && g.web;
    if (w && w.uri && !seen.has(w.uri)) { seen.add(w.uri); out.push({ uri: w.uri, title: w.title || w.uri }); }
  }
}

// 代码执行的三种 part → markdown：executableCode（代码）/ codeExecutionResult（输出）/ inlineData 图（图表）。
// 图表交给 onImage 落盘，拿回 /api/vertex/media 链接；没有 onImage（routines 等）就只留一句说明。
function codePartMd(p, onImage) {
  if (p.executableCode) {
    const lang = String(p.executableCode.language || 'python').toLowerCase().replace('language_unspecified', '');
    return '\n\n```' + lang + '\n' + String(p.executableCode.code || '').replace(/\n+$/, '') + '\n```\n';
  }
  if (p.codeExecutionResult) {
    const ok = p.codeExecutionResult.outcome === 'OUTCOME_OK';
    const out = String(p.codeExecutionResult.output || '').replace(/\n+$/, '');
    if (ok && !out.trim()) return '';   // 只画图、没有打印输出：不留一个空块
    return '\n\n' + (ok ? '**运行结果**' : '**运行出错**') + '\n```text\n' + (out || '（无输出）') + '\n```\n\n';
  }
  if (p.inlineData && /^image\//.test(p.inlineData.mimeType || '') && p.inlineData.data) {
    let url = null;
    try { url = onImage ? onImage(Buffer.from(p.inlineData.data, 'base64'), p.inlineData.mimeType) : null; } catch {}
    return url ? '\n\n![图表](' + url + ')\n\n' : '\n\n（代码生成了一张图表，这个入口不保存图片）\n\n';
  }
  return '';
}

/**
 * Run one Gemini turn. Streams text deltas through onText(delta) and resolves
 * with the full text plus any Google Search sources.
 * @returns {Promise<{ text: string, sources: Array<{uri,title}>, timedOut: boolean }>}
 */
const MEDIA_RES = { low: 'MEDIA_RESOLUTION_LOW', medium: 'MEDIA_RESOLUTION_MEDIUM', high: 'MEDIA_RESOLUTION_HIGH' };

export async function runTurn({ history, message, files, model, useSearch, useUrl, useCode, system, mediaRes, thinkLevel, fastVision = true, project, location, onText, onThink, onImage, signal }) {
  const ai = client(project, location);
  const config = {};
  // 工具：联网搜索 / URL 上下文 / 代码执行。2.5 Flash/Pro 的代码执行不能和搜索类工具同开（400），
  // 前端已互斥；这里兜底——保留搜索类，丢掉代码执行（见 capabilities 的 codeSolo）。
  const tools = [];
  if (useSearch) tools.push({ googleSearch: {} });
  if (useUrl) tools.push({ urlContext: {} });
  if (useCode && !(VERTEX_CODE_SOLO.has(model) && tools.length)) tools.push({ codeExecution: {} });
  if (tools.length) config.tools = tools;
  if (system) config.systemInstruction = system;
  const thinking = thinkingFor(model, thinkLevel);
  if (thinking) config.thinkingConfig = thinking;
  // 识图清晰度：选了档就照档（低/中/高，九款都认）；「自动」沿用快速识图——3.x 有图时用中档
  // （少视觉 token、prefill 更快，配合附件已降采样到 1600px，足够日常识图）。
  if (files && files.length) {
    if (MEDIA_RES[mediaRes]) config.mediaResolution = MEDIA_RES[mediaRes];
    else if (fastVision && LEVEL_FAMILY.test(model)) config.mediaResolution = 'MEDIA_RESOLUTION_MEDIUM';
  }
  if (signal) config.abortSignal = signal;

  const contents = toContents(history, message, files);
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model, contents, config });
  } catch (e) {
    // 个别模型可能不认 mediaResolution（400）→ 去掉该键重试一次，别让识图整轮失败。
    if (config.mediaResolution) { delete config.mediaResolution; stream = await ai.models.generateContentStream({ model, contents, config }); }
    else throw e;
  }

  let full = '';
  const seen = new Set();
  const sources = [];
  for await (const chunk of stream) {
    if (signal && signal.aborted) break;
    // 逐 part 分流：thought=true 是思考分片（走 onThink，让前端立刻有动静、消除"思考期死寂"），
    // 其余是可见正文（走 onText）。chunk.text 本就排除思考，这里手动遍历以同时拿到两者。
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (!p) continue;
        // 代码执行：模型写的代码与运行结果各成一个代码块进正文（流式可见、历史可回看）
        const md = codePartMd(p, onImage);
        if (md) { full += md; if (onText) onText(md); continue; }
        if (p.text == null) continue;
        if (p.thought) { if (onThink) onThink(p.text); }
        else { full += p.text; if (onText) onText(p.text); }
      }
    } else if (chunk.text) { full += chunk.text; if (onText) onText(chunk.text); }   // 兜底
    collectSources(chunk, seen, sources);
  }
  return { text: full, sources, timedOut: false };
}

// 预热：开机就建好 client + 用一次 countTokens 把 ADC token 取到（首条消息不再付
// 「加载 @google/genai + 换 token + 建连」的冷启动）；server 定期调以保活 token 不过期。
export async function warmup({ project, location, model }) {
  try {
    const ai = client(project, location);
    await ai.models.countTokens({ model, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    return true;
  } catch { return false; }   // 网络/ADC 未就绪不致命，首条消息再走正常路径
}
