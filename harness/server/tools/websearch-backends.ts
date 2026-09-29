// WebSearch 的可插拔后端层。
//
// 为什么要有这一层（2026-08-24 定案）：
// 旧实现是「单后端 + 同一家的三档模型」——主力/备胎/兜底全是 Gemini，同一个 key、
// 同一条必须出海的网络路径。降级链再长也是一荣俱荣一损俱损。实测（同日）：
//   · Gemini grounding 经代理 3/3 成功，2.9~5.9s —— 模型侧其实是健康的；
//   · 同一路径「直连」必死：fetch failed，而且要等 10.6s 才失败；
//   · 而 server.out.git 里 net-proxy 的出口状态在「代理 ↔ 直连」之间反复翻转。
// 于是只要撞进直连窗口，三档模型全部去打 googleapis，每档 10s 超时，直接吃满总
// 预算再整体判死。agent 眼里就是「这工具又慢又挂」。真凶是出口，不是 503。
//
// 业界（Hermes 8 家 provider / pi-websearch 三级路由 / opencode 走 Exa 托管端点）
// 的共识是：**多后端 + 统一信封 + 按 key 自动探测**。这里照抄该结构。
//
// 后端排序的依据是实测，不是偏好：
//   zhipu  国内直连 0.54~2.2s，纯搜索 API（不经 LLM），故此没有 503 / 思考吃满
//          token / 空答案这些故障模式。→ 首选
//   gemini 需出海 2.9~5.9s，但会给一段合成答案，英文官方站命中更准。→ 次选
//   ddg    免 key，需出海 1.3s，但会被限流且摘要质量差。→ 无 key 时的兜底
//
// 2026-09-29 补「各家自带的原生搜索」（用同一把 key、同一个接口域名——Muse 这类按网站审批出站的环境里，
// 批过模型接口就等于批过了搜索，不再为搜索另弹审核）。逐家实测（同日，本机经代理）：
//   deepseek  Anthropic 兼容接口 /anthropic/v1/messages + web_search_20250305 服务端工具：2.8s，带来源 → 可用
//             （OpenAI 兼容的 chat 接口与 Responses 接口都不支持搜索，文档写明 Ignored）
//   qwen      DashScope 原生接口 enable_search + search_options.enable_source：6.3s，search_info 带来源 → 可用
//             （OpenAI 兼容模式能搜但不回来源，所以走原生接口）
//   kimi      Kimi for Coding 订阅的独立搜索接口 /coding/v1/search（kimi-cli 用的就是它）：6.4s，结构化结果 → 可用
//             $web_search builtin_function 第一轮能搜，第二轮回传 arguments 恒报 "tokenization failed"（6 种写法都试过）
//   mimo      chat/completions 的 tools 里放 {type:"web_search"}：服务端一轮搜完，annotations 带来源；
//             前提是控制台「插件管理」开了联网搜索插件（没开回 400 "webSearchEnabled is false"），¥16/千次
//   anthropic Claude 的 web_search_20250305 服务端工具（官方正式功能；同协议已在 deepseek 上跑通）
//   智谱 / Gemini 保持原样（纯搜索 API / Google grounding）。

import { defaultBaseUrl, resolveKey } from "../config.ts";

export type BackendId = "zhipu" | "kimi" | "deepseek" | "qwen" | "gemini" | "anthropic" | "mimo" | "ddg";

/** 统一信封（照 Hermes 的 {title,url,description} 收敛成三字段）。 */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOk {
  ok: true;
  hits: SearchHit[];
  /** 后端自带的合成答案（只有 gemini 这类经 LLM 的后端有）。 */
  answer?: string;
  /** 附加提醒，会原样透传给 agent（如「本次没有真实搜索」）。 */
  note?: string;
  /** 展示用的后端细节，例如 "search_std" / "gemini-3.5-flash-lite"。 */
  detail?: string;
}

export interface SearchFail {
  ok: false;
  /** 换个时间重试有意义吗（429/5xx/超时/网络抖动 = 有）。 */
  retryable: boolean;
  error: string;
  /** 要用户动手才能好的配置问题（例如「控制台没开联网搜索插件」）：别的后端顶上时也会附在结果里提醒一句。 */
  hint?: string;
  /** 用户/上层中止 ≠ 上游故障：既不重试也不降级。 */
  aborted?: boolean;
}

export type SearchOutcome = SearchOk | SearchFail;

export interface SearchBackend {
  id: BackendId;
  label: string;
  /** 是否需要能出海。诊断用：全部可用后端都 needsOutbound 时值得提醒用户。 */
  needsOutbound: boolean;
  /** 单次尝试的超时上限。 */
  timeoutMs: number;
  available(): boolean;
  search(query: string, signal: AbortSignal | undefined, budgetMs: number): Promise<SearchOutcome>;
}

const MAX_HITS = 8;
const MAX_SNIPPET = 240;

function timeoutSignal(ms: number, outer: AbortSignal | undefined, cap: number): AbortSignal {
  const signals: AbortSignal[] = [AbortSignal.timeout(Math.max(1_000, Math.min(ms, cap)))];
  if (outer) signals.push(outer);
  return AbortSignal.any(signals);
}

function netFail(e: unknown, aborted: boolean): SearchFail {
  if (aborted) return { ok: false, retryable: false, aborted: true, error: "aborted" };
  const err = e as Error;
  // 超时与网络抖动（fetch failed / 代理翻转）都是典型可重试。
  return { ok: false, retryable: true, error: `${err.name}: ${err.message}` };
}

function clip(s: string, n = MAX_SNIPPET): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// ── 智谱 web_search ─────────────────────────────────────────────────────────
// 纯搜索 API，不经 LLM。open.bigmodel.cn 国内直连可达，因此完全不吃出口代理的
// 抖动——这正是把它排第一的全部理由。
// 实测坑：`count` 参数不生效（请求 5 实回 31 条），必须自己截断，否则 30 条 ×680
// 字摘要直接把上下文顶爆。返回字段：{title, link, content, refer, publish_date,
// icon, media}，顶层还有个 search_intent。
const ZHIPU_ENGINE = process.env.WEBSEARCH_ZHIPU_ENGINE?.trim() || "search_std";

export const zhipuBackend: SearchBackend = {
  id: "zhipu",
  label: "智谱 web_search",
  needsOutbound: false,
  timeoutMs: 8_000,
  available: () => Boolean(resolveKey("zhipu")),
  async search(query, signal, budgetMs) {
    const key = resolveKey("zhipu");
    if (!key) return { ok: false, retryable: false, error: "no zhipu key" };
    let res: Response;
    try {
      res = await fetch("https://open.bigmodel.cn/api/paas/v4/web_search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ search_engine: ZHIPU_ENGINE, search_query: query, count: MAX_HITS }),
        signal: timeoutSignal(this.timeoutMs, signal, budgetMs),
      });
    } catch (e) {
      return netFail(e, Boolean(signal?.aborted));
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      // 1113 = 余额不足 / 没有资源包：HTTP 也是 429，但重试不会好，直接换下一家并提醒一句
      const broke = /"code"\s*:\s*"?1113/.test(raw);
      return {
        ok: false,
        retryable: !broke && (res.status === 429 || res.status >= 500),
        error: `HTTP ${res.status}: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
        hint: broke ? "智谱搜索没用上：这把智谱 key 余额不足或没有资源包（充值后就会恢复）" : undefined,
      };
    }
    let data: any;
    try {
      data = await res.json();
    } catch {
      return { ok: false, retryable: true, error: "unparseable JSON" };
    }
    const raw = (data?.search_result ?? []) as any[];
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const url = String(r?.link ?? "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      hits.push({ title: String(r?.title ?? "").trim() || url, url, snippet: clip(String(r?.content ?? "")) });
      if (hits.length >= MAX_HITS) break;
    }
    if (!hits.length) return { ok: false, retryable: true, error: "no results" };
    return { ok: true, hits, detail: ZHIPU_ENGINE };
  },
};

// ── Gemini grounding ────────────────────────────────────────────────────────
// 借 Gemini 的 Google Search grounding（Gemini CLI 官方就是这么做的）。优势是给
// 一段合成答案 + 英文官方站命中更准；代价是必须出海。
//
// 2026-08-16 实测保留（模型选型的原因，仍然成立）：
//   · gemini-3.5-flash（旧默认）5 次 → 3 成 1 个 503 1 个 30s 超时，成功也要 20~27s；
//     gemini-3.7-flash 4 次里 2 个 503。**越新的旗舰 flash 越挤**，503 是常态。
//   · gemini-3.5-flash-lite 4/4 成功、2.6~4.2s —— 搜索这种「找线索」的活 lite 够用。
// 模型链留在后端内部：对外它就是「一个后端」，链跑完即 retryable:false，外层直接
// 换下一家，不再拿同一条网络路径反复撞。
//
// 坑：groundingChunks 里的 uri 是 vertexaisearch 重定向壳（会过期、且同样要出海），
// 真实域名在 title 里。所以这个后端的价值主要在 answer，url 只当线索。
const GEMINI_MODELS: string[] = process.env.WEBSEARCH_MODEL?.trim()
  ? [process.env.WEBSEARCH_MODEL.trim()]
  : ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.1-flash-lite"];
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(
  /\/$/,
  "",
);
const GEMINI_ATTEMPT_MS = 12_000;

const GEMINI_SYSTEM =
  "You are a web search assistant. Search the web and answer the query with current, " +
  "specific facts — concrete names, versions, dates, URLs. Be concise (a short paragraph " +
  "or tight bullet list). If the search results don't answer the query, say so plainly.";

interface GeminiAttempt {
  ok: boolean;
  retryable: boolean;
  dropThinking?: boolean;
  aborted?: boolean;
  error?: string;
  hits?: SearchHit[];
  answer?: string;
  note?: string;
  detail?: string;
}

async function geminiAttempt(
  model: string,
  query: string,
  key: string,
  signal: AbortSignal | undefined,
  withThinking: boolean,
  budgetMs: number,
): Promise<GeminiAttempt> {
  let res: Response;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
        systemInstruction: { parts: [{ text: GEMINI_SYSTEM }] },
        generationConfig: {
          maxOutputTokens: 2048,
          ...(withThinking ? { thinkingConfig: { thinkingLevel: "LOW" } } : {}),
        },
      }),
      signal: timeoutSignal(GEMINI_ATTEMPT_MS, signal, budgetMs),
    });
  } catch (e) {
    const f = netFail(e, Boolean(signal?.aborted));
    return { ok: false, retryable: f.retryable, aborted: f.aborted, error: f.error };
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // 旧模型不认 thinkingLevel：同模型去掉该字段再来一次，别浪费一档备胎。
    if (res.status === 400 && /thinking level is not supported/i.test(raw)) {
      return { ok: false, retryable: false, dropThinking: true, error: "HTTP 400 (thinkingLevel unsupported)" };
    }
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      error: `HTTP ${res.status}: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    };
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    return { ok: false, retryable: true, error: "unparseable JSON" };
  }

  const cand = data?.candidates?.[0];
  const answer = ((cand?.content?.parts ?? []) as any[])
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text)
    .join("")
    .trim();
  // 空答案（思考吃满 maxOutputTokens、安全拦截等）也当可重试：换一档往往就有。
  if (!answer) return { ok: false, retryable: true, error: `empty answer (finishReason=${cand?.finishReason ?? "?"})` };

  const gm = cand?.groundingMetadata;
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const ch of (gm?.groundingChunks ?? []) as any[]) {
    const uri = ch?.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    hits.push({ title: String(ch.web.title ?? uri), url: uri, snippet: "" });
    if (hits.length >= MAX_HITS) break;
  }
  const grounded = Boolean(gm?.webSearchQueries?.length || hits.length);
  return {
    ok: true,
    retryable: false,
    hits,
    answer,
    detail: model,
    note: grounded
      ? undefined
      : "本次没有执行真实搜索，以上可能来自模型自身知识；时效性事实请用 WebFetch 到官方页面复核。",
  };
}

export const geminiBackend: SearchBackend = {
  id: "gemini",
  label: "Gemini grounding",
  needsOutbound: true,
  timeoutMs: GEMINI_ATTEMPT_MS,
  available: () => Boolean(resolveKey("gemini")),
  async search(query, signal, budgetMs) {
    const key = resolveKey("gemini");
    if (!key) return { ok: false, retryable: false, error: "no gemini key" };
    const deadline = Date.now() + budgetMs;
    let last: GeminiAttempt | null = null;
    const tried: string[] = [];

    for (const model of GEMINI_MODELS) {
      let withThinking = true;
      // 同模型最多两形状（带/不带 thinkingConfig），不额外重试——重试交给外层。
      for (let shape = 0; shape < 2; shape++) {
        const left = deadline - Date.now();
        if (left <= 1_000) break;
        const r = await geminiAttempt(model, query, key, signal, withThinking, left);
        last = r;
        if (r.ok) {
          if (tried.length) console.log(`[websearch] gemini/${model} 成功（已越过：${tried.join(", ")}）`);
          return { ok: true, hits: r.hits!, answer: r.answer, note: r.note, detail: r.detail };
        }
        if (r.aborted) return { ok: false, retryable: false, aborted: true, error: "aborted" };
        console.warn(`[websearch] gemini/${model} 失败：${r.error}`);
        if (r.dropThinking && withThinking) {
          withThinking = false;
          continue; // 换个请求形状重发，不算一档
        }
        break;
      }
      tried.push(model);
      if (Date.now() >= deadline - 1_000) break;
    }
    // 整条模型链都跑过了：外层再重试同一家没有意义，直接让它换后端。
    return { ok: false, retryable: false, error: `all gemini models failed (last: ${last?.error ?? "unknown"})` };
  },
};

// ── 通用：HTTP 调用 + 错误分类 ───────────────────────────────────────────────
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ms: number,
  signal: AbortSignal | undefined,
  budgetMs: number,
): Promise<{ ok: true; data: any } | SearchFail> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: timeoutSignal(ms, signal, budgetMs),
    });
  } catch (e) {
    return netFail(e, Boolean(signal?.aborted));
  }
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    return {
      ok: false,
      retryable: res.status === 429 || res.status >= 500,
      error: `HTTP ${res.status}: ${raw.slice(0, 200).replace(/\s+/g, " ")}`,
    };
  }
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, retryable: true, error: "unparseable JSON" };
  }
}

function pushHit(hits: SearchHit[], seen: Set<string>, url: unknown, title: unknown, snippet: unknown): void {
  const u = String(url ?? "").trim();
  if (!u || seen.has(u) || hits.length >= MAX_HITS) return;
  seen.add(u);
  hits.push({ title: String(title ?? "").trim() || u, url: u, snippet: clip(String(snippet ?? "")) });
}

const SEARCH_SYSTEM = GEMINI_SYSTEM;
const MODEL_SEARCH_MS = 25_000; // 经 LLM 的后端（先搜再写答案）比纯搜索 API 慢

// ── Anthropic Messages 协议的 web_search 服务端工具（Claude 本家 + DeepSeek 的兼容接口）──
function anthropicSearch(
  id: "anthropic" | "deepseek",
  label: string,
  endpoint: () => string | undefined,
  model: () => string,
): SearchBackend {
  return {
    id,
    label,
    needsOutbound: id === "anthropic",
    timeoutMs: MODEL_SEARCH_MS,
    available: () => Boolean(resolveKey(id === "anthropic" ? "anthropic" : "openai") && endpoint()),
    async search(query, signal, budgetMs) {
      const key = resolveKey(id === "anthropic" ? "anthropic" : "openai");
      const url = endpoint();
      if (!key || !url) return { ok: false, retryable: false, error: `no ${id} key` };
      const r = await postJson(
        url,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        {
          model: model(),
          max_tokens: 1024,
          system: SEARCH_SYSTEM,
          messages: [{ role: "user", content: query }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
        },
        this.timeoutMs,
        signal,
        budgetMs,
      );
      if (!r.ok) return r;
      const blocks = (r.data?.content ?? []) as any[];
      const hits: SearchHit[] = [];
      const seen = new Set<string>();
      for (const b of blocks) {
        if (b?.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
        for (const x of b.content) pushHit(hits, seen, x?.url, x?.title, x?.page_age ? `（${x.page_age}）` : "");
      }
      // 答案取最后一个 search 之后的正文（前面那句往往是「我去搜一下」）
      let lastSearch = -1;
      blocks.forEach((b, i) => { if (b?.type === "web_search_tool_result") lastSearch = i; });
      const answer = blocks
        .slice(lastSearch + 1)
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!hits.length && !answer) return { ok: false, retryable: true, error: "empty result" };
      return {
        ok: true,
        hits,
        answer: answer || undefined,
        detail: model(),
        note: hits.length ? undefined : "本次没有执行真实搜索，以上可能来自模型自身知识；时效性事实请用 WebFetch 到官方页面复核。",
      };
    },
  };
}

// DeepSeek：dimensio 里它是 provider "openai"（地址 api.deepseek.com）。只在地址确实是 DeepSeek 官方时启用。
function deepseekEndpoint(): string | undefined {
  const base = defaultBaseUrl("openai") ?? "";
  try {
    const u = new URL(base);
    return u.hostname === "api.deepseek.com" ? `${u.origin}/anthropic/v1/messages` : undefined;
  } catch {
    return undefined;
  }
}
export const deepseekBackend = anthropicSearch(
  "deepseek",
  "DeepSeek 联网搜索",
  deepseekEndpoint,
  () => process.env.WEBSEARCH_DEEPSEEK_MODEL?.trim() || "deepseek-chat",
);
export const anthropicBackend = anthropicSearch(
  "anthropic",
  "Claude web_search",
  () => `${(process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
  () => process.env.WEBSEARCH_ANTHROPIC_MODEL?.trim() || "claude-haiku-4-5-20251001",
);

// ── 通义：DashScope 原生接口的 enable_search ─────────────────────────────────
// 兼容模式（/compatible-mode/v1）也能 enable_search，但不回来源；原生接口加 enable_source 才有 search_info。
function dashscopeOrigin(): string | undefined {
  const base = defaultBaseUrl("qwen") ?? "";
  try {
    const u = new URL(base);
    return /dashscope/.test(u.hostname) ? u.origin : undefined;
  } catch {
    return undefined;
  }
}
export const qwenBackend: SearchBackend = {
  id: "qwen",
  label: "通义联网搜索",
  needsOutbound: false,
  timeoutMs: MODEL_SEARCH_MS,
  available: () => Boolean(resolveKey("qwen") && dashscopeOrigin()),
  async search(query, signal, budgetMs) {
    const key = resolveKey("qwen");
    const origin = dashscopeOrigin();
    if (!key || !origin) return { ok: false, retryable: false, error: "no qwen key" };
    const model = process.env.WEBSEARCH_QWEN_MODEL?.trim() || "qwen-plus";
    const r = await postJson(
      `${origin}/api/v1/services/aigc/text-generation/generation`,
      { authorization: `Bearer ${key}` },
      {
        model,
        input: { messages: [{ role: "system", content: SEARCH_SYSTEM }, { role: "user", content: query }] },
        parameters: {
          result_format: "message",
          enable_search: true,
          search_options: { forced_search: true, enable_source: true, search_strategy: "turbo" },
        },
      },
      this.timeoutMs,
      signal,
      budgetMs,
    );
    if (!r.ok) return r;
    const out = r.data?.output ?? {};
    const answer = String(out?.choices?.[0]?.message?.content ?? "").trim();
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const x of (out?.search_info?.search_results ?? []) as any[]) pushHit(hits, seen, x?.url, x?.title, x?.site_name);
    if (!hits.length && !answer) return { ok: false, retryable: true, error: "empty result" };
    return { ok: true, hits, answer: answer || undefined, detail: model };
  },
};

// ── Kimi for Coding：订阅自带的搜索接口 ──────────────────────────────────────
// 只有订阅端点（api.kimi.com/coding）有；开放平台（api.moonshot.cn）的 key 没有这个接口。
function kimiSearchUrl(): string | undefined {
  const base = (defaultBaseUrl("kimi") ?? "").replace(/\/$/, "");
  return /api\.kimi\.com\/coding/.test(base) ? `${base}/search` : undefined;
}
export const kimiBackend: SearchBackend = {
  id: "kimi",
  label: "Kimi 搜索",
  needsOutbound: false,
  timeoutMs: 15_000,
  available: () => Boolean(resolveKey("kimi") && kimiSearchUrl()),
  async search(query, signal, budgetMs) {
    const key = resolveKey("kimi");
    const url = kimiSearchUrl();
    if (!key || !url) return { ok: false, retryable: false, error: "no kimi key" };
    const r = await postJson(
      url,
      { authorization: `Bearer ${key}` },
      { text_query: query, limit: MAX_HITS, enable_page_crawling: false, timeout_seconds: 12 },
      this.timeoutMs,
      signal,
      budgetMs,
    );
    if (!r.ok) return r;
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const x of (r.data?.search_results ?? []) as any[]) {
      const when = x?.date ? `${x.date} · ` : "";
      pushHit(hits, seen, x?.url, x?.title, `${when}${x?.snippet ?? ""}`);
    }
    if (!hits.length) return { ok: false, retryable: true, error: "no results" };
    return { ok: true, hits };
  },
};

// ── 小米 MiMo：chat 接口的 web_search 工具（服务端一轮搜完）──────────────────
// 插件没开时每次都是秒回 400：记下来一段时间内不再打，免得每次搜索都白白先撞一下。
const MIMO_OFF_MS = 30 * 60_000;
let mimoOffUntil = 0;
const MIMO_HINT = "小米原生搜索没用上：MiMo 控制台「插件管理」里还没开通联网搜索插件（开通后就会优先用它）";
// 09-29 实测：Token Plan 的 tp- key 只认 token-plan-cn 那个地址，那边一律 webSearchEnabled=false（控制台开了插件也一样）；
// 拿它打按量地址直接 401。插件只在按量付费接口上开放，所以搜索可以单独配一把按量的 key（MIMO_SEARCH_API_KEY）。
const MIMO_TP_HINT =
  "小米原生搜索没用上：Token Plan（tp- 开头）的 key 用不了联网搜索插件，小米只在按量付费接口上开放它。" +
  "想用的话，在 MiMo 控制台建一把按量付费的 API key 填到 MIMO_SEARCH_API_KEY（聊天照旧用 Token Plan；搜索按次计费，从账户余额扣）";
/** 搜索用的 key 与地址：单独配了按量 key 就用它（固定走按量地址），否则跟聊天同一把。 */
function mimoSearchAuth(): { key?: string; base: string; hint: string } {
  const own = process.env.MIMO_SEARCH_API_KEY?.trim();
  if (own) {
    const base = process.env.MIMO_SEARCH_BASE_URL?.trim() || "https://api.xiaomimimo.com/v1";
    return { key: own, base, hint: MIMO_HINT };
  }
  const key = resolveKey("mimo");
  const base = defaultBaseUrl("mimo") ?? "https://api.xiaomimimo.com/v1";
  return { key, base, hint: key?.startsWith("tp-") ? MIMO_TP_HINT : MIMO_HINT };
}
export const mimoBackend: SearchBackend = {
  id: "mimo",
  label: "小米 MiMo 联网搜索",
  needsOutbound: false,
  timeoutMs: MODEL_SEARCH_MS,
  available: () => Boolean(mimoSearchAuth().key),
  async search(query, signal, budgetMs) {
    const { key, base: rawBase, hint } = mimoSearchAuth();
    if (!key) return { ok: false, retryable: false, error: "no mimo key" };
    if (Date.now() < mimoOffUntil) return { ok: false, retryable: false, error: "web search plugin disabled", hint };
    const base = rawBase.replace(/\/$/, "");
    const model = process.env.WEBSEARCH_MIMO_MODEL?.trim() || "mimo-v2.6-flash";
    const r = await postJson(
      `${base}/chat/completions`,
      { authorization: `Bearer ${key}` },
      {
        model,
        messages: [{ role: "system", content: SEARCH_SYSTEM }, { role: "user", content: query }],
        max_completion_tokens: 1024,
        tools: [{ type: "web_search", force_search: true, max_keyword: 3, limit: MAX_HITS }],
        tool_choice: "auto",
      },
      this.timeoutMs,
      signal,
      budgetMs,
    );
    if (!r.ok) {
      if (/webSearchEnabled is false/i.test(r.error)) {
        mimoOffUntil = Date.now() + MIMO_OFF_MS;
        return { ok: false, retryable: false, error: "web search plugin disabled", hint };
      }
      return r;
    }
    mimoOffUntil = 0;
    const msg = r.data?.choices?.[0]?.message ?? {};
    const answer = String(msg?.content ?? "").trim();
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (const a of (msg?.annotations ?? []) as any[]) {
      const c = a?.url_citation ?? a;
      pushHit(hits, seen, c?.url, c?.title, c?.summary ?? c?.site_name);
    }
    if (!hits.length && !answer) return { ok: false, retryable: true, error: "empty result" };
    return { ok: true, hits, answer: answer || undefined, detail: model };
  },
};

/** 测试用：清掉「小米插件没开」的记忆。 */
export function resetNativeSearchState(): void {
  mimoOffUntil = 0;
}

// ── DuckDuckGo HTML（免 key 兜底）───────────────────────────────────────────
// pi-websearch 的零配置兜底档，抄过来。没有 key 也能搜，但：会被限流、摘要质量
// 一般，而且实测本机直连必死（10.7s fetch failed）、经代理才 1.3s 命中 10 条——
// 所以它跟 gemini 一样属于「需要出海」档，只是不要 key。
const DDG_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ""));
}

/** DDG 的 href 是 //duckduckgo.com/l/?uddg=<真实URL 编码>&rut=… ，要解出来。 */
function ddgUrl(href: string): string {
  const raw = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(raw);
    return u.searchParams.get("uddg") || raw;
  } catch {
    return raw;
  }
}

export const ddgBackend: SearchBackend = {
  id: "ddg",
  label: "DuckDuckGo",
  needsOutbound: true,
  timeoutMs: 8_000,
  available: () => (process.env.WEBSEARCH_DISABLE_DDG?.trim() === "1" ? false : true),
  async search(query, signal, budgetMs) {
    let res: Response;
    try {
      res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "user-agent": DDG_UA, accept: "text/html" },
        signal: timeoutSignal(this.timeoutMs, signal, budgetMs),
      });
    } catch (e) {
      return netFail(e, Boolean(signal?.aborted));
    }
    if (!res.ok) {
      return { ok: false, retryable: res.status === 429 || res.status >= 500, error: `HTTP ${res.status}` };
    }
    const html = await res.text();
    const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
    const snips = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gs)].map((m) => stripTags(m[1]));
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < links.length && hits.length < MAX_HITS; i++) {
      const url = ddgUrl(links[i][1]);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      hits.push({ title: stripTags(links[i][2]) || url, url, snippet: clip(snips[i] ?? "") });
    }
    // DDG 限流时会回 200 但正文没有结果块——当可重试，让外层换后端。
    if (!hits.length) return { ok: false, retryable: true, error: "no results (可能被限流)" };
    return { ok: true, hits };
  },
};

export const ALL_BACKENDS: SearchBackend[] = [
  zhipuBackend,
  kimiBackend,
  deepseekBackend,
  qwenBackend,
  geminiBackend,
  anthropicBackend,
  mimoBackend,
  ddgBackend,
];

export function backendById(id: string): SearchBackend | undefined {
  return ALL_BACKENDS.find((b) => b.id === id);
}
