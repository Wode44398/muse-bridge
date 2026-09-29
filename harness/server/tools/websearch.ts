import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { getConfig } from "../config.ts";
import type { ProviderId } from "../providers/types.ts";
import { ALL_BACKENDS, backendById, type BackendId, type SearchBackend, type SearchHit } from "./websearch-backends.ts";
import { WEB_CONTENT_NOTE } from "./untrusted.ts";

// WebSearch —— 后端选择、缓存、结果成型。真正的搜索实现在 websearch-backends.ts，
// 那里也记着「为什么是多后端」的实测原因。
//
// 选择策略照 pi-websearch 的三级路由：
//   1. WEBSEARCH_BACKENDS 显式指定顺序（逗号分隔）——人工写死时只认它；
//   2. 当前会话 provider 自带原生搜索就把它排第一（provider-native 优先）；
//   3. 其余按默认优先级补齐，只保留 available() 为真的。
// 每次结果都标明「这次是谁搜的」（同样抄 pi 的 TUI 提示）：agent 和人都能一眼分清
// 「后端挂了」还是「确实没搜到」，而不是笼统地觉得这工具不可靠。

/** provider 自带原生搜索的映射：当前会话用哪家，就先用哪家自己的搜索（同 key、同域名）。
 *  "openai" 在目录里就是 DeepSeek（地址 api.deepseek.com；地址换成别家时 deepseek 后端自己不可用）。 */
const NATIVE_BY_PROVIDER: Partial<Record<ProviderId, BackendId>> = {
  zhipu: "zhipu",
  kimi: "kimi",
  openai: "deepseek",
  qwen: "qwen",
  gemini: "gemini",
  anthropic: "anthropic",
  mimo: "mimo",
};

/** 默认优先级（原生那家之后的备胎）：先纯搜索 API（快、结构化），再经 LLM 的国内几家，再出海的，
 *  小米排在按次计费的几家后面（要开插件、¥16/千次），最后免 key 兜底。 */
const DEFAULT_ORDER: BackendId[] = ["zhipu", "kimi", "deepseek", "qwen", "gemini", "anthropic", "mimo", "ddg"];

const TOTAL_BUDGET_MS = 45_000; // 整体预算：宁可少试一档也不拖死 agent loop
const RETRY_BACKOFF_MS = 800;
const CACHE_TTL_MS = 15 * 60_000; // 与 WebFetch 同档：重复搜索直接命中
const CACHE_MAX = 64;

interface Cached {
  at: number;
  text: string;
  label: string;
  count: number;
}
const cache = new Map<string, Cached>();

function cacheGet(q: string): Cached | undefined {
  const c = cache.get(q);
  if (!c) return undefined;
  if (Date.now() - c.at > CACHE_TTL_MS) {
    cache.delete(q);
    return undefined;
  }
  return c;
}

function cacheSet(q: string, v: Cached): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(q, v);
}

// ── 观测 ────────────────────────────────────────────────────────────────────
// 旧实现只有 console.warn，出事没有任何可查的证据（server.out.log 里一条都没有）。
// 计数留在内存里，由 /api/net 暴露。
interface BackendStat {
  ok: number;
  fail: number;
  totalMs: number;
  lastError?: string;
}
const stats = {
  calls: 0,
  cacheHits: 0,
  failed: 0,
  byBackend: {} as Record<string, BackendStat>,
};

function stat(id: string): BackendStat {
  return (stats.byBackend[id] ??= { ok: 0, fail: 0, totalMs: 0 });
}

export function webSearchStats(): typeof stats & { chain: string[] } {
  return { ...stats, chain: pickChain().map((b) => b.id) };
}

// ── 后端选择 ────────────────────────────────────────────────────────────────
// provider = 当前会话在用的那家（ToolContext.provider）；不给就看全局配置（/api/net 这类没有会话的场合）。
export function pickChain(provider: ProviderId = getConfig().provider): SearchBackend[] {
  const pinned = process.env.WEBSEARCH_BACKENDS?.trim();
  if (pinned) {
    const chain = pinned
      .split(",")
      .map((s) => backendById(s.trim()))
      .filter((b): b is SearchBackend => Boolean(b) && b!.available());
    if (chain.length) return chain;
    // 写死的名字一个都不可用时不静默回落——落回默认链，但要留痕。
    console.warn(`[websearch] WEBSEARCH_BACKENDS="${pinned}" 里没有可用后端，回落默认链`);
  }

  const order: BackendId[] = [];
  const native = NATIVE_BY_PROVIDER[provider];
  if (native) order.push(native);
  for (const id of DEFAULT_ORDER) if (!order.includes(id)) order.push(id);

  return order
    .map((id) => backendById(id))
    .filter((b): b is SearchBackend => Boolean(b) && b!.available());
}

export function webSearchAvailable(): boolean {
  return pickChain().length > 0;
}

// ── 结果成型 ────────────────────────────────────────────────────────────────
function render(label: string, hits: SearchHit[], answer?: string, note?: string, hints: string[] = []): string {
  const parts: string[] = [`[via ${label}]`];
  if (answer) parts.push(answer);
  if (hits.length) {
    parts.push(
      hits
        .map((h, i) => {
          const head = `${i + 1}. ${h.title}\n   ${h.url}`;
          return h.snippet ? `${head}\n   ${h.snippet}` : head;
        })
        .join("\n"),
    );
  } else if (!answer) {
    parts.push("（该后端没有返回任何结果）");
  }
  if (note) parts.push(`（${note}）`);
  for (const h of hints) parts.push(`（${h}）`);
  return parts.join("\n\n");
}

export const webSearchTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "WebSearch",
    description:
      "Search the live web and get back ranked results (title, URL, snippet), plus a grounded " +
      "answer when the backend provides one. Use for DISCOVERY — current model names, versions, " +
      "docs locations, error messages — when you don't know the exact URL; then use WebFetch to " +
      "read the best source in depth.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for — a question or keywords." },
      },
      required: ["query"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return fail("empty query", "Provide a query to search for.");

    const chain = pickChain(ctx.provider);
    if (!chain.length) {
      return fail(
        "unavailable",
        "WebSearch has no usable backend (no model-provider key with built-in search, and DuckDuckGo is disabled). " +
          "Use WebFetch with a known URL instead.",
      );
    }

    stats.calls++;
    const ckey = query.toLowerCase();
    const hit = cacheGet(ckey);
    if (hit) {
      stats.cacheHits++;
      return {
        ok: true,
        summary: `web search (${hit.label}, cached): ${clipQ(query)} → ${hit.count} results`,
        outcome: `${hit.count} 条结果（${hit.label} · 缓存）`, // U8（K36）
        content: [{ t: "text", text: `${WEB_CONTENT_NOTE}\n${hit.text}\n\n（15 分钟内的缓存结果）` }],
      };
    }

    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const tried: string[] = [];
    const hints: string[] = [];
    let lastError = "unknown";

    for (const backend of chain) {
      // 每个后端给「首发 + 1 次重试」；后端自称不可重试（例如 gemini 已经把自己的
      // 模型链跑完了）就直接换下一家，别拿同一条网络路径反复撞。
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = deadline - Date.now();
        if (left <= 1_000) break;

        const t0 = Date.now();
        const r = await backend.search(query, ctx.signal, left);
        const ms = Date.now() - t0;
        const s = stat(backend.id);
        s.totalMs += ms;

        if (r.ok) {
          s.ok++;
          const label = r.detail ? `${backend.label} · ${r.detail}` : backend.label;
          const text = render(label, r.hits, r.answer, r.note, hints);
          cacheSet(ckey, { at: Date.now(), text, label: backend.label, count: r.hits.length });
          if (tried.length) console.log(`[websearch] ${backend.id} 成功（已越过：${tried.join(", ")}），${ms}ms`);
          return {
            ok: true,
            summary: `web search (${backend.label}): ${clipQ(query)} → ${r.hits.length} results`,
            outcome: `${r.hits.length} 条结果（${backend.label}）`, // U8（K36）
            content: [{ t: "text", text: `${WEB_CONTENT_NOTE}\n${text}` }],
          };
        }

        s.fail++;
        s.lastError = r.error;
        if (r.hint && !hints.includes(r.hint)) hints.push(r.hint);
        lastError = `${backend.id}: ${r.error}`;
        if (r.aborted) return fail("aborted", "WebSearch aborted.");
        console.warn(`[websearch] ${backend.id} 失败（${ms}ms）：${r.error}`);
        if (!r.retryable) break;
        if (attempt === 0) await new Promise((s) => setTimeout(s, RETRY_BACKOFF_MS));
      }
      tried.push(backend.id);
      if (Date.now() >= deadline - 1_000) break;
    }

    stats.failed++;
    // 全链失败时把「所有可用后端都要出海」这条诊断说出来——这台机器上最常见的
    // 真因是出口代理在翻转，而不是查询本身有问题。
    const allNeedOutbound = chain.every((b) => b.needsOutbound);
    return fail(
      "search failed",
      `WebSearch failed on all backends (tried: ${tried.join(", ") || chain[0].id}). Last error — ${lastError}. ` +
        (allNeedOutbound
          ? "所有可用后端都需要出海，出口代理不通时会整批失败：检查代理，或配一家国内厂商的 key（智谱 / Kimi / DeepSeek / 通义 / 小米都自带搜索）。"
          : "This is usually a temporary upstream issue; retry once, or use WebFetch on a known URL.") +
        (hints.length ? ` ${hints.join("；")}` : ""),
    );
  },
};

function clipQ(q: string): string {
  return q.length > 50 ? `${q.slice(0, 50)}…` : q;
}
