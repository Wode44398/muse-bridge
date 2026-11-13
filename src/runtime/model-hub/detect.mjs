// 模型中心 v2 的「识别模型」（契约 §5.3）：给一个地址 + Key，定协议、修地址、拉全模型目录并按种类分好。
//
// 1. 规范化地址（没写 http(s):// 的补 https://；贴了完整请求地址 …/chat/completions、…/v1/messages、…/models 的截掉尾巴；
//    只填了主机名的，认得出的提供商先试它的推荐地址）；按 providerOf 认提供商（名字、logo、协议提示）。
// 2. 候选协议按提示 / 地址特征排，每个协议按 modelsUrlCandidates 逐个地址试，第一个拿到非空列表的胜出，记下用对的鉴权方式与修正后的地址。
//    全被拒（401 / 403）→「Key 无效」；一个应答都没有 → 连不上；有应答但列不出 → 不算失败，空目录 + 提示（可以手动加模型 ID）。
// 3. 每条按型号知识层定种类、模型厂、上下文 / 识图。
// 4. 提供商专属的补充目录：OpenRouter 默认列表只有出文本的，再按 output_modalities=image / video / audio 各拉一次；
//    硅基流动按 type=image / video / audio 各拉一次（未实测，失败就忽略）。
// 5. 有 Studio 桥时问 Studio 这个地址能列出的媒体模型（与第 4 步并行），并入目录（Studio 给的种类优先），同时得到 media。
// 6. 去重合并（Studio > 补充目录 > 主列表）。落盘由 registry 做。
//
// 出站：useProxy=false 直连，否则走全局出站代理（和服务以后真发请求同一条路）。单个请求 20 秒、整次识别 45 秒封顶。
// Key 绝不进返回值、日志与报错：上游 / Studio 的原文拼进人话前一律抹掉 Key（scrubKey）。
import {
  providerOf, providerInfo, classifyModality, vendorOf, guessModel, modelsUrlCandidates, parseModelList, modelIdOf, labelOf,
} from '../../model-knowledge/index.mjs';
import { directFetch, defaultAuthStyle, BAD_KEY_RE, BAD_KEY_MSG, BAD_HEADER_MSG, isBadHeader } from './pool.mjs';
import { detectStudio, studioDialectFor, scrubKey, MEDIA_KINDS } from './studio-link.mjs';
import { CATALOG_MAX } from './catalog.mjs';

export const REQ_MS = 20_000;
export const TOTAL_MS = 45_000;
const PROTOCOLS = ['openai', 'anthropic', 'gemini'];
const AUTH_STYLES = ['bearer', 'x-api-key', 'goog', 'none'];
const KIND_NAME = { image: '图像', video: '视频', audio: '音频' };

const fail = (msg, status) => Object.assign(new Error(msg), { status });
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

// 认提供商。测试里本机假上游的地址认不出任何提供商，OpenRouter / 硅基流动的补充目录分支只能经这个钩子打到
let brandOverride = null;
/** 测试用：fn(baseUrl) → providerOf 形状的对象 | undefined（undefined = 照常认）。传 null 恢复。 */
export function _setBrandOverrideForTests(fn) { brandOverride = typeof fn === 'function' ? fn : null; }
const brandOf = (u) => { const o = brandOverride?.(u); return o !== undefined ? o : providerOf(u); };

/**
 * 用户填的地址 → 规范的根地址（http(s)://主机[:端口]/路径，无尾斜杠、无查询串、无账号密码）。
 * 抛 400（人话）。贴进来的完整请求地址截到根：…/chat/completions、…/v1/messages、…/models、Gemini 的 …/models/<型号>:generateContent。
 */
export function cleanBaseUrl(v) {
  let s = String(v ?? '').trim();
  if (!s) throw fail('要填接口地址', 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw fail('接口地址不合法', 400); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw fail('接口地址要是 http(s) 地址', 400);
  let p = u.pathname.replace(/\/+$/, '');
  p = p.replace(/\/models\/[^/]+(:[a-zA-Z]+)?$/, '');   // Gemini：…/v1beta/models/gemini-x:generateContent
  // Anthropic 的根地址不带 /v1（请求时才拼 /v1/messages）：贴的是 …/v1/messages 就连 /v1 一起截掉；OpenAI 的根本来就含 /v1，下面只截接口名
  p = p.replace(/\/v1\/messages(\/count_tokens)?$/i, '');
  for (let i = 0; i < 2; i++) p = p.replace(/\/(chat\/completions|completions|messages|responses|models|embeddings|images\/generations)$/i, '');
  return (u.origin + p).replace(/\/+$/, '');
}

/** 贴进来的是完整请求地址时，接口名本身就说明了协议（契约 §5.3「地址特征」）：…/messages → anthropic、:generateContent → gemini、…/chat/completions → openai。 */
function pastedProtocol(v) {
  const s = String(v ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (/\/messages(\/count_tokens)?$/i.test(s)) return 'anthropic';
  if (/\/models\/[^/]+:[a-zA-Z]+$/.test(s)) return 'gemini';
  if (/\/chat\/completions$/i.test(s)) return 'openai';
  return '';
}

/** 候选的根地址：只填了主机名、提供商有推荐地址（同主机）时先试推荐的；Gemini 官方只填主机的补 /v1beta。 */
function baseCandidates(base, locked) {
  if (locked) return [base];
  const out = [];
  const u = new URL(base);
  if (u.pathname === '' || u.pathname === '/') {
    const b = brandOf(base);
    const rec = b ? providerInfo(b.key)?.baseUrl : '';
    if (rec && hostOf(rec) === u.host) out.push(rec.replace(/\/+$/, ''));
    if (/(^|\.)generativelanguage\.googleapis\.com$/i.test(u.hostname)) out.push(base + '/v1beta');
  }
  out.push(base);
  return [...new Set(out)];
}

/** 这个根地址上协议的试探顺序（契约：提示 > 地址特征 > 提供商协议 > openai > anthropic）。 */
function protocolOrder(base, hint, locked) {
  if (locked) return [locked];
  const out = [];
  const push = (p) => { if (PROTOCOLS.includes(p) && !out.includes(p)) out.push(p); };
  push(hint);
  const u = new URL(base);
  const path = u.pathname.toLowerCase();
  if (/\/anthropic$/.test(path) || u.hostname === 'api.anthropic.com') push('anthropic');
  if ((/(^|\.)generativelanguage\.googleapis\.com$/.test(u.hostname) && !/\/openai$/.test(path)) || /\/v1beta$/.test(path)) push('gemini');
  push(brandOf(base)?.protocol);
  push('openai');
  push('anthropic');
  return out;
}

/** 协议 → 依次试的鉴权方式。用户显式选了的只用它；Anthropic 兼容的中转站一半收 x-api-key、一半只认 Bearer，两种都试。 */
function authOrder(protocol, explicit, key) {
  if (!key) return ['none'];
  if (AUTH_STYLES.includes(explicit) && explicit !== 'none') return [explicit];
  if (protocol === 'anthropic') return ['x-api-key', 'bearer'];
  return [defaultAuthStyle(protocol)];
}
function headersFor(protocol, style, key, extra) {
  const h = { accept: 'application/json' };
  if (protocol === 'anthropic') h['anthropic-version'] = '2023-06-01';
  for (const x of extra || []) h[x.name.toLowerCase()] = x.value;
  if (key && style !== 'none') {
    if (style === 'bearer') h.authorization = 'Bearer ' + key;
    else if (style === 'goog') h['x-goog-api-key'] = key;
    else h['x-api-key'] = key;
  }
  return h;
}
/** 胜出的列表地址 → 这个协议的根地址。OpenAI 兼容：列表就挂在根下（…/v1/models → …/v1）；另两种的根就是候选根。 */
function baseFromWin(protocol, candBase, url) {
  if (protocol !== 'openai') return candBase;
  return url.replace(/\?.*$/, '').replace(/\/models$/, '');
}

// 不在这里截断：调用方先抹 Key 再截（请求头不合法时 undici 的原文里是整段 Key，截了以后整串匹配不上就抹不掉）
const netWhy = (e) => (e?.name === 'TimeoutError' || e?.name === 'AbortError' ? '超时' : String(e?.cause?.code || e?.cause?.message || e?.message || e));

/**
 * 识别 → { conn:{ kind, baseUrl, authStyle, name, brand }, models:[CatalogModel], media:{ dialect, kinds }|null, warnings }。
 * input：{ baseUrl, key, kind?（协议提示）, lockKind?（已存的服务：协议定了不改，只试它）, authStyle?, headers?:[{name,value}], useProxy? }
 */
export async function detectModels(input) {
  const key = typeof input?.key === 'string' ? input.key.trim() : '';
  // 中间夹换行 / 空白 / 控制字符的 Key 进了请求头必炸（报错原文里带着整段 Key）：发请求之前就挡
  if (key && BAD_KEY_RE.test(key)) throw fail(BAD_KEY_MSG, 400);
  const scrub = (s) => scrubKey(s, key);
  const deadline = Date.now() + TOTAL_MS;
  const left = () => deadline - Date.now();
  const useProxy = input?.useProxy !== false;
  const headers = Array.isArray(input?.headers) ? input.headers : [];
  const explicitAuth = AUTH_STYLES.includes(input?.authStyle) ? input.authStyle : '';
  const locked = input?.lockKind && PROTOCOLS.includes(input.kind) ? input.kind : '';
  // 已托管服务的 Studio 方言（只传给 Studio 的识别；空 = 让它按地址认）
  const mediaDialect = typeof input?.mediaDialect === 'string' && /^[a-z0-9-]{1,32}$/.test(input.mediaDialect) ? input.mediaDialect : '';
  const base0 = cleanBaseUrl(input?.baseUrl);
  // 协议提示：调用方给的优先，其次是贴进来的请求地址里的接口名（截成根地址以后就看不出来了，所以在这儿先记下）
  const hint = PROTOCOLS.includes(input?.kind) ? input.kind : pastedProtocol(input?.baseUrl);
  const host = hostOf(base0);
  const warnings = [];

  // —— 第 2 步：定协议、拉主列表 ——
  let win = null;           // { protocol, style, base, list }
  let soft = null;          // 有 2xx 但列不出：{ protocol, style, base }
  let sawAuth = false, sawHttp = false, lastNet = '';
  const deadOrigins = new Set();   // 连不上的源站：同站的其余地址不再试（一个个等 20 秒超时太久）
  outer:
  for (const cand of baseCandidates(base0, locked)) {
    for (const protocol of protocolOrder(cand, hint, locked)) {
      for (const url of modelsUrlCandidates(protocol, cand)) {
        let origin = '';
        try { origin = new URL(url).origin; } catch { continue; }
        if (deadOrigins.has(origin)) continue;
        for (const style of authOrder(protocol, explicitAuth, key)) {
          if (left() < 300) break outer;
          let r;
          try {
            r = await directFetch(url, { headers: headersFor(protocol, style, key, headers), useProxy, timeoutMs: Math.min(REQ_MS, left()) });
          } catch (e) {
            if (isBadHeader(e)) throw fail(BAD_HEADER_MSG, 400);   // 自定义请求头的值不合法：换地址也一样，不回显原文
            lastNet = scrub(netWhy(e)).slice(0, 120);
            deadOrigins.add(origin);
            break;
          }
          sawHttp = true;
          if (r.status === 401 || r.status === 403) { sawAuth = true; await r.body?.cancel?.().catch(() => {}); continue; }   // 换一种鉴权再试
          if (!r.ok) { await r.body?.cancel?.().catch(() => {}); break; }   // 404 / 405 / 跳转：这个地址不对，换下一个
          const j = await r.json().catch(() => null);
          const list = parseModelList(j);
          if (list && list.length) { win = { protocol, style, base: baseFromWin(protocol, cand, url), list }; break outer; }
          if (!soft) soft = { protocol, style, base: baseFromWin(protocol, cand, url) };
          break;
        }
      }
    }
  }

  const bridgeMedia = () => studioDialectFor(base0);
  const firstProto = locked || protocolOrder(base0, hint, '')[0];
  let conn;
  if (win || soft) {
    const w = win || soft;
    conn = { kind: w.protocol, baseUrl: w.base, authStyle: key ? w.style : explicitAuth || 'none' };
  } else {
    conn = { kind: firstProto, baseUrl: base0, authStyle: explicitAuth || (key ? (firstProto === 'anthropic' ? 'x-api-key' : defaultAuthStyle(firstProto)) : 'none') };
  }
  // 一个应答都没有：连不上（超时也算），不必再问 Studio——同一个站
  if (!sawHttp && !win && !soft) {
    if (left() < 300 && !lastNet) throw fail(`${host} 在 ${TOTAL_MS / 1000} 秒内没有回应`, 504);
    throw fail(`连不上 ${host}：${scrub(lastNet || '没有回应')}`, 502);
  }

  const brand = brandOf(conn.baseUrl) || brandOf(base0);
  const mediaOnly = !!brand?.mediaOnly;
  const entries = new Map();   // id → CatalogModel；后到的高优先级覆盖种类与出处
  const put = (m, prio) => {
    const old = entries.get(m.id);
    if (old && old._p > prio) return;
    const merged = { ...(old || {}), ...Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== '')), _p: prio };
    if (!merged.vendor) merged.vendor = '';
    entries.set(m.id, merged);
  };
  // 聚合站（OpenRouter 一类）的显示名是「厂商: 型号」，id 是「厂商/型号」：前缀和 id 的厂商段是同一家时去掉它——
  // 行首已经有厂标了，模型菜单里也按服务分组，不用每行再念一遍厂商。对不上的（冒号是型号名的一部分）原样保留。
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const cleanLabel = (label, id) => {
    const m = /^([^:]{2,40}):\s+(\S.*)$/.exec(String(label || ''));
    const seg = String(id).includes('/') ? norm(String(id).replace(/^~/, '').split('/')[0]) : '';
    if (!m || seg.length < 2) return label;
    const pre = norm(m[1]);
    return pre.length >= 2 && (pre.startsWith(seg) || seg.startsWith(pre)) ? m[2].trim() : label;
  };
  const fromRaw = (x, { hint, source, protocol }) => {
    const id = modelIdOf(x);
    if (!id) return null;
    const raw = x && typeof x === 'object' ? x : null;
    const kind = classifyModality(id, { raw, hint, mediaOnly });
    const out = { id, label: cleanLabel(labelOf(x, id), id), kind, vendor: vendorOf(id) || '', source };
    if (kind === 'text') {
      const g = guessModel(id, { protocol, api: raw });
      if (g.source.contextWindow !== 'default') out.contextWindow = g.contextWindow;
      if (g.source.maxOutput !== 'default') out.maxOutput = g.maxOutput;
      if (g.source.vision !== 'default') out.vision = g.vision;
    }
    return out;
  };

  // —— 第 3 步：主列表 ——
  if (win) for (const x of win.list) { const m = fromRaw(x, { source: 'api', protocol: win.protocol }); if (m) put(m, 1); }

  // —— 第 4、5 步：补充目录与 Studio 并行 ——
  const jobs = [];
  if (win && win.protocol === 'openai' && (brand?.key === 'openrouter' || brand?.key === 'siliconflow')) {
    const isOR = brand.key === 'openrouter';
    for (const mod of ['image', 'video', 'audio']) {
      const url = `${win.base}/models?${isOR ? 'output_modalities' : 'type'}=${mod}`;
      jobs.push((async () => {
        try {
          if (left() < 300) throw new Error('timeout');
          const r = await directFetch(url, { headers: headersFor('openai', win.style, key, headers), useProxy, timeoutMs: Math.min(REQ_MS, left()) });
          if (!r.ok) { await r.body?.cancel?.().catch(() => {}); throw new Error('HTTP ' + r.status); }
          const list = parseModelList(await r.json().catch(() => null)) || [];
          for (const x of list) { const m = fromRaw(x, { hint: mod, source: 'catalog', protocol: 'openai' }); if (m) put(m, 2); }
        } catch (e) {
          // 硅基流动的分类目录没实测过：拉不到就当没有，不打扰用户
          if (isOR) warnings.push(`OpenRouter 的${KIND_NAME[mod]}模型目录没拉到（${scrub(netWhy(e)).slice(0, 120)}），这一类可能不全`);
        }
      })());
    }
  }
  let studio = null, studioErr = null;
  jobs.push((async () => {
    try {
      studio = await detectStudio({ baseUrl: conn.baseUrl, apiKey: key, authStyle: explicitAuth || (win ? win.style : undefined), headers, dialect: mediaDialect, useProxy }, Math.max(1, left()));
    } catch (e) { studioErr = e; }
  })());
  await Promise.all(jobs);

  if (studio) {
    for (const x of studio.models) {
      put({ id: x.id, label: x.label ? String(x.label).slice(0, 80) : undefined, kind: x.kind, vendor: vendorOf(x.id) || '', source: 'catalog' }, 3);
    }
  } else if (studioErr) {
    // 只是媒体那一半没认出来：主列表照常用，报错原文可能带着 Key（上游回显），抹掉再给
    warnings.push(`Media Studio 识别媒体模型失败：${scrub(studioErr.message || studioErr).slice(0, 300) || '没有说明'}`);
  }

  // —— 结论 ——
  if (!win) {
    if (studio && studio.models.length) {
      warnings.unshift(sawAuth && !soft
        ? `${host} 的模型列表接口拒绝了这个 Key，只列出了 Media Studio 能用的媒体模型`
        : '这个地址列不出对话模型，只列出了 Media Studio 能用的媒体模型');
    } else if (sawAuth && !soft) {
      throw fail(`Key 无效：${host} 拒绝了这个 Key（401 / 403）`, 400);
    } else {
      warnings.unshift('列不出模型清单，可以手动添加模型 ID');
    }
  }

  const models = [...entries.values()].slice(0, CATALOG_MAX).map(({ _p, ...m }) => m);
  const media = studio ? { dialect: studio.dialect, kinds: studio.kinds } : bridgeMedia();
  return {
    conn: { ...conn, name: brand?.name || host, brand: brand ? { key: brand.key, name: brand.name, logo: brand.logo } : null },
    models,
    media: media ? { dialect: media.dialect, kinds: MEDIA_KINDS.filter((k) => media.kinds.includes(k)) } : null,
    warnings: warnings.map(scrub),
  };
}
