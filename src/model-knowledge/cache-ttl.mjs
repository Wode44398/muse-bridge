// 提示缓存多久变冷（2026-11-14）：空闲多久之后，下一次请求就不再命中前缀缓存，单位分钟。
// Claude 分页与 dimensio 共用，管两件事：缓存冷了的提示（Claude 的用量环右上角一颗点 / dimensio 输入框上方一条），
// 和赶在过期前把长对话压缩一次（两边的「空闲压缩」）。模型中心按它给每个文本模型预填，用户可以在那里改。
//
// 取值顺序（cacheTtl）：
//   user   用户在模型中心给这个模型填的（0 = 不缓存 / 不提示）
//   request 我们这次请求自己要的时长：Anthropic 官方端点的主会话发 ttl:"1h"（订阅号 CLI 默认也是 1 小时）
//   host   按上游主机认出的厂商（官方直连）
//   family 按型号认出的厂商（经 OpenRouter 之类的聚合站、或认不出的中转站）
//   default 认不出厂商：不知道（不提示）
// minutes 为 null = 不知道（厂商文档没写）或不会按时过期（本机模型）：不提示、不赶着压缩——用户知道的话在模型中心填。
//
// 每家的数字都以官方文档为准（CACHE_VENDORS 里写着出处与查证日期）；文档只给范围的取下限——提示早一点只是多一句话，
// 压缩赶不上就白压了。
import { vendorOf, providerOf } from './brands.mjs';
import { bareModelId } from './knowledge.mjs';

export const CACHE_TTL_MAX = 1440;   // 分钟（OpenAI 的延长保留最长 24 小时）

// 厂商 → { min：分钟（null = 文档没写 / 不会很快过期 → 不提示），note：给界面的一句说明（措辞键），src：出处，
// models：同一家里按型号另算的（先匹配先用）}。2026-11-14 逐家查现行官方文档；只给范围的取下限，没写的不编。
// 我们自己不发延长参数（OpenAI 的 prompt_cache_options / prompt_cache_retention、Kimi 的 prompt_cache_options），所以都按默认档。
export const CACHE_VENDORS = Object.freeze({
  // 「By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used.」
  // 发 ttl:"1h" 时是 1 小时（requestMinutes）。Bedrock / Vertex / OpenRouter 上同样，且不带 cache_control 就不缓存
  anthropic: { min: 5, note: '默认 5 分钟，命中续期', src: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching' },
  // GPT-5.6 起默认至少 30 分钟（读取后再续 30 分钟）；更早的型号「typically 5 to 10 minutes of inactivity」，取下限
  openai: {
    min: 5, note: '空闲约 5～10 分钟清除', src: 'https://developers.openai.com/api/docs/guides/prompt-caching',
    models: [{ re: /^(?:gpt-5[.-](?:[6-9]|\d{2,})|gpt-(?:[6-9]|\d{2,})(?:$|[.-]))/, min: 30, note: '默认至少 30 分钟，命中续期' }],
  },
  // 隐式缓存官方没给时长（Vertex 只写了 24 小时上限、多数更早淘汰）；OpenRouter 文档写平均 3～5 分钟，按 5 分钟估
  google: { min: 5, note: '隐式缓存时长未公布，按平均约 5 分钟估', src: 'https://openrouter.ai/docs/guides/best-practices/prompt-caching' },
  // 「usually within a few hours to a few days」：取「几小时」的下限，按 2 小时
  deepseek: { min: 120, note: '硬盘缓存，通常几小时到几天才清除', src: 'https://api-docs.deepseek.com/guides/kv_cache' },
  // 「不传 prompt_cache_options 时，系统默认使用 5m TTL」「缓存在有效期内被命中会自动按原 TTL 免费续期」
  moonshot: { min: 5, note: '默认 5 分钟，命中续期', src: 'https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api' },
  zhipu: { min: null, note: '官方未公布缓存时长', src: 'https://docs.bigmodel.cn/cn/guide/capabilities/cache' },
  qwen: { min: null, note: '官方未公布隐式缓存时长', src: 'https://help.aliyun.com/zh/model-studio/context-cache' },
  alibaba: { min: null, note: '官方未公布隐式缓存时长', src: 'https://help.aliyun.com/zh/model-studio/context-cache' },
  bytedance: { min: null, note: '官方未公布隐式缓存时长', src: 'https://docs.volcengine.com/docs/ark/context-cache?lang=zh' },
  minimax: { min: null, note: '官方未公布缓存时长', src: 'https://platform.minimaxi.com/docs/api-reference/text-prompt-caching' },
  xiaomi: { min: null, note: '官方未公布缓存时长', src: 'https://mimo.mi.com/llms-full.txt' },
  xai: { min: null, note: '官方未公布缓存时长', src: 'https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices' },
  mistral: { min: null, note: '官方未公布缓存时长', src: 'https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching' },
  tencent: { min: null, note: '官方未公布缓存时长', src: 'https://cloud.tencent.com/document/product/1823/135874' },
  baidu: { min: null, note: '官方未公布缓存时长', src: 'https://cloud.baidu.com/doc/qianfan-docs/s/Lmhuc7c2o' },
});

// 官方直连的服务商（brands.mjs providerOf 的键）→ 厂商。不在表里的服务商（聚合站、中转、云托管）按型号认厂商。
const PROVIDER_VENDOR = Object.freeze({
  anthropic: 'anthropic', openai: 'openai', azure: 'openai', gemini: 'google', vertex: 'google', deepseek: 'deepseek',
  moonshot: 'moonshot', 'kimi-code': 'moonshot', zhipu: 'zhipu', zai: 'zhipu', dashscope: 'qwen', ark: 'bytedance',
  minimax: 'minimax', mimo: 'xiaomi', xai: 'xai', mistral: 'mistral', hunyuan: 'tencent', tencentcloud: 'tencent', qianfan: 'baidu',
});
// 本机推理服务：前缀缓存在显存 / 内存里，没有过期时间（被挤掉才没），不提示
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'vllm', 'xinference']);

/** 主机名是不是本机 / 局域网（这类自己部署的推理服务不提示）。 */
export function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/:\d+$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/** 用户填的值规范化：0 = 不缓存 / 不提示；1–1440 分钟；其余（含 null / undefined）= 没填（自动）。 */
export function normalizeCacheTtl(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(CACHE_TTL_MAX, Math.round(n));
}

/**
 * 这个模型的提示缓存多久变冷 → { minutes: number|null, source: 'user'|'request'|'host'|'family'|'default'|'local', vendor: string }。
 *   id      型号 ID（带不带 vendor/ 前缀都行）
 *   host    请求实际发到的上游主机（模型中心发布的服务给 upstream，别传本机网关的 127.0.0.1）；也可以给完整地址
 *   user    用户在模型中心填的（见 normalizeCacheTtl）
 *   requestMinutes  这次请求自己要的时长（Anthropic 官方端点发 ttl:"1h" 时给 60）
 */
export function cacheTtl(id, { host = '', user, requestMinutes } = {}) {
  const u = normalizeCacheTtl(user);
  const vendor = vendorOf(id) || '';
  if (u !== undefined) return { minutes: u === 0 ? null : u, source: 'user', vendor };
  if (Number.isFinite(requestMinutes) && requestMinutes > 0) return { minutes: Math.round(requestMinutes), source: 'request', vendor };
  const raw = String(host || '').trim();
  const url = raw ? (/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`) : '';
  let hostname = '';
  try { hostname = url ? new URL(url).hostname : ''; } catch { hostname = ''; }
  const prov = url ? providerOf(url) : null;
  if (isLocalHost(hostname) || (prov && LOCAL_PROVIDERS.has(prov.key))) return { minutes: null, source: 'local', vendor };
  const hv = prov ? PROVIDER_VENDOR[prov.key] : '';
  if (hv && CACHE_VENDORS[hv]) return { minutes: vendorMinutes(hv, id), source: 'host', vendor: hv };
  if (vendor && CACHE_VENDORS[vendor]) return { minutes: vendorMinutes(vendor, id), source: 'family', vendor };
  return { minutes: null, source: 'default', vendor };
}

/** 一家厂商里这个型号的分钟数（按型号另算的先匹配）。 */
function vendorMinutes(vendor, id) {
  const v = CACHE_VENDORS[vendor];
  const bare = bareModelId(id);
  const hit = (v.models || []).find((m) => m.re.test(bare));
  return hit ? hit.min : v.min;
}

/** 界面用的一句说明（措辞键）：这个模型的缓存时长从哪来。认不出厂商回 ''。 */
export function cacheTtlNote(id, opts = {}) {
  const r = cacheTtl(id, opts);
  if (r.source === 'user') return '';
  if (r.source === 'request') return '这次请求要了 1 小时缓存';
  if (r.source === 'local') return '本机模型，缓存不会按时过期';
  const v = CACHE_VENDORS[r.vendor];
  if (!v) return '认不出厂商，不知道缓存多久过期';
  const bare = bareModelId(id);
  const hit = (v.models || []).find((m) => m.re.test(bare));
  return (hit && hit.note) || v.note;
}

/** 毫秒版（null → 0，「没有缓存 / 不知道」）。 */
export function cacheTtlMs(id, opts) {
  const r = cacheTtl(id, opts);
  return r.minutes ? r.minutes * 60_000 : 0;
}
