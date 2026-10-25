// 识别 / 探测 / 报错的纯解读（2026-10-21 抽出，Claude 外接与 dimensio 自定义服务共用；不联网——发请求的那一半由两边各自做，
// 因为各自的鉴权、代理和请求管线不同：bridge 走 upstreamFetch + applyParams，dimensio 走全局 fetch + 自己的适配器口径）。
//
//   vendorText        厂商报错正文 → 一句原文
//   classifyProbe     「检测连接」一次试探的结果分类：ok / model / auth / missing / error（网络错由调用方记 network）
//   pickDetect        一组试探结果 → 当前组合怎样、推荐改成哪个
//   parseLimit        从「max_tokens 超范围」的报错里读出输出上限（不扣费）
//   parseEffortList   从「reasoning_effort 只能是 …」的报错里读出可选档位
//   looksNotChat      这条 400 是不是「这个型号不是对话模型」（语音识别 / 合成、向量……）
//   looksNoAudio      这条 400 是不是「不收音频」（型号照样能对话，只是这家 / 这个型号不认 input_audio）
//   mentionsModel     报错原文是不是在说「型号」（404 时区分「型号不对」和「地址 / 协议不对」）
//   endpointHint      上游 404 / 非 JSON 时，「地址或协议不对」那句提示
import { protocolMismatch } from './knowledge.mjs';

/** 厂商报错正文 → { json, msg }（各家 JSON 形状不一：error.message / error 字符串 / message / msg；HTML 页去标签）。 */
export function vendorText(text) {
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!j || typeof j !== 'object') return { json: false, msg: String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
  const e = j.error;
  const msg = (e && (typeof e === 'string' ? e : e.message)) || j.message || j.msg || JSON.stringify(j);
  return { json: true, msg: String(msg).slice(0, 500) };
}

// 推荐顺序：通了的优先，其次「接口在」（只是模型名 / Key 的问题），再次其它报错；404 / 连不上垫底
export const PROBE_RANK = Object.freeze({ ok: 0, model: 1, auth: 2, error: 3, missing: 4, network: 5 });

/** 「检测连接」一次试探（最小请求，max_tokens=1）的结果分类。 */
export function classifyProbe(status, text) {
  if (status >= 200 && status < 300) return 'ok';
  const v = vendorText(text);
  if (status === 401 || status === 403) return 'auth';
  if (status === 404 && !(v.json && mentionsModel(v.msg))) return 'missing';
  if (status === 404 || (status === 400 && mentionsModel(v.msg))) return 'model';
  if (!v.json) return 'missing';   // HTML 404 页 / 网关错误页
  return 'error';
}

const trimBase = (s) => String(s || '').replace(/\/+$/, '');
/**
 * results：[{ protocol, baseUrl, authStyle, result, … }]；draft：{ protocol, baseUrl }。
 * 回 { current, suggest, ok }：current = 当前这组的结果；suggest = 推荐改成的组合（能用且不是当前这组，否则 null）。
 * 同等时：当前组合 > 同协议换地址（尊重原来选的协议，小米 anthropic + …/v1 → …/anthropic）> 换协议。
 */
export function pickDetect(results, draft) {
  const base = trimBase(draft && draft.baseUrl);
  const same = (r) => r.protocol === draft.protocol && trimBase(r.baseUrl) === base;
  const current = results.find(same) || null;
  const order = (r) => (PROBE_RANK[r.result] ?? 9) * 10 + (same(r) ? 0 : r.protocol === draft.protocol ? 1 : 2);
  const best = [...results].sort((a, b) => order(a) - order(b))[0];
  const usable = best && (PROBE_RANK[best.result] ?? 9) <= PROBE_RANK.auth ? best : null;
  return {
    current,
    suggest: usable && !same(usable) ? { protocol: usable.protocol, baseUrl: usable.baseUrl, authStyle: usable.authStyle, result: usable.result } : null,
    ok: !!(current && current.result === 'ok'),
  };
}

const LIMIT_RES = [/\(\s*0\s*,\s*(\d{3,8})\s*\]/, /at most\s+(\d{3,8})/i, /\[\s*1\s*[,，]\s*(\d{3,8})\s*\]/, /(?:maximum|max(?:imum)?_?(?:tokens)?|上限|不能超过|不超过)[^\d]{0,40}(\d{3,8})/i, /less than or equal to\s+(\d{3,8})/i];
/** 「max_tokens 超范围」报错里的上限（读不出回 null）。 */
export function parseLimit(text) {
  const s = String(text || '');
  for (const re of LIMIT_RES) { const m = re.exec(s); if (m) { const n = Number(m[1]); if (n >= 256 && n <= 4_000_000) return n; } }
  return null;
}
/** OpenAI 端点对乱填的 reasoning_effort 回「must be one of 'none', 'low' …」——从里面读可选档位。 */
export function parseEffortList(text) {
  const s = String(text || '');
  const m = /(?:one of|must be|expected|supported values?|allowed values?)[^'"`]{0,40}((?:['"`][a-z0-9_-]{1,24}['"`][\s,]*(?:or|and)?\s*)+)/i.exec(s);
  if (!m) return null;
  const ids = [...m[1].matchAll(/['"`]([a-z0-9_-]{1,24})['"`]/gi)].map((x) => x[1].toLowerCase());
  return ids.length ? [...new Set(ids)] : null;
}

// 只认「这个型号本身不是对话模型」的明确说法（语音识别 / 合成、向量、重排）。泛泛提到 audio / speech / voice 的不算——
// 那多半是「这个服务 / 型号不收音频附件」（中转不支持 input_audio），判成非对话会引导用户把正常的对话型号关掉。
const NOT_CHAT_RE = /\b(?:asr|tts)\b|requires?\b[^.\n]{0,80}\binput_audio\b|system role is not allowed|\bembeddings?\b|\brerank|not a chat model|does not support chat|not support(?:ed)? (?:for )?chat|不是对话模型|不支持(?:对话|聊天)/i;
/** 普通对话请求被 400、报文明说「这是语音 / 向量模型」→ true。 */
export function looksNotChat(status, text) {
  return status === 400 && NOT_CHAT_RE.test(vendorText(text).msg || String(text || ''));
}
const NO_AUDIO_RE = /(?:input_audio|\baudio\b|音频)[^.\n]{0,40}(?:not (?:be )?(?:supported|allowed|accepted)|unsupported|不支持|不被支持)|(?:does ?n[o']t|not|不)\s*(?:support|accept|支持)[^.\n]{0,30}(?:\baudio\b|input_audio|音频)/i;
/** 400、报文说「不收音频」（中转 / 型号不支持 input_audio）→ true。和 looksNotChat 分开：型号照样能对话，只是别带音频。 */
export function looksNoAudio(status, text) {
  return status === 400 && NO_AUDIO_RE.test(vendorText(text).msg || String(text || ''));
}
const MODEL_WORD_RE = /model|模型|型号/i;
/** 报错原文是不是在说「型号」（404 时据此区分「型号不对」和「地址 / 协议不对」）；带上型号 ID，原文里提到它也算。 */
export function mentionsModel(msg, model = '') {
  const s = String(msg || '');
  return MODEL_WORD_RE.test(s) || (!!model && model.length >= 3 && s.includes(model));
}

const PROTO_NAME = { openai: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages', gemini: 'Gemini generateContent' };
export const protocolName = (p) => PROTO_NAME[p] || PROTO_NAME.openai;
/** 404 / 非 JSON 时那句「换个地址或协议」的补充说明（看不出该怎么改回 ''）。 */
export function endpointHint(protocol, baseUrl) {
  const b = trimBase(baseUrl);
  // 只有实测过的站（小米：…/v1 只有 OpenAI 兼容接口）说得肯定；new-api / one-api 一类中转在 …/v1/messages 上本来就有 Anthropic 接口
  if (protocol === 'anthropic' && /\/v1$/.test(b)) {
    return protocolMismatch(protocol, b)?.sure
      ? '这个站的 …/v1 只有 OpenAI 兼容接口：把协议改成 OpenAI，或改用同站的 …/anthropic 地址。'
      : '有的服务 …/v1 下只有 OpenAI 兼容接口：可以把协议改成 OpenAI，或试试同站的 …/anthropic 地址。';
  }
  if (protocol === 'openai' && !/\/v\d+[a-z]*(?:\/openai)?$/.test(b)) return '很多 OpenAI 兼容地址要带 /v1。';
  return '';
}

// 8×8 纯红 PNG（探测视觉用）
export const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';
