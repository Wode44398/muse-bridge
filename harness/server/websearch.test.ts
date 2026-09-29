import assert from "node:assert/strict";
import test from "node:test";
import { setConfig } from "./config.ts";
import { Sandbox } from "./sandbox.ts";
import { webSearchTool, pickChain, webSearchAvailable } from "./tools/websearch.ts";
import { resetNativeSearchState } from "./tools/websearch-backends.ts";
import type { ToolContext } from "./tools/types.ts";

// WebSearch 的可用性靠「多后端 + 按 key 探测 + 逐档降级」兜住任一家的抖动。这里用
// 假 fetch 钉住那条控制流：谁先上、什么错该重试、什么错该直接换后端、成功后必须
// 立刻收手、以及缓存不再打网络。
//
// 后端排序的实测依据见 tools/websearch-backends.ts 顶部注释。

function ctx(): ToolContext {
  return {
    sandbox: new Sandbox(process.cwd(), "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 120_000, bashMaxTimeoutMs: 600_000 },
    agentSeesImages: false,
  } as ToolContext;
}

let q = 0;
/** 每个用例用不同的 query，免得模块级 15 分钟缓存跨用例串味。 */
const uniq = (name: string) => `${name}-${++q}`;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const zhipuOk = (title = "Z 结果") =>
  json(200, { search_result: [{ title, link: "https://z.example/a", content: "智谱摘要正文" }] });

const geminiOk = (text: string) =>
  json(200, {
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason: "STOP",
        groundingMetadata: { webSearchQueries: ["q"], groundingChunks: [{ web: { uri: "https://g.example/a", title: "G" } }] },
      },
    ],
  });

const ddgOk = () =>
  new Response(
    `<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fd.example%2Fa">DDG 标题</a>` +
      `<a class="result__snippet" href="#">DDG 摘要</a></div>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );

/** 按 host 分发的假 fetch；记录每次调用落到哪个后端（gemini 记到模型名）。 */
function stubFetch(handler: (backend: string, n: number) => Response | Promise<Response>) {
  const calls: string[] = [];
  const bodies: string[] = [];
  const urls: string[] = [];
  const auths: string[] = [];
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    let backend = "?";
    if (u.includes("open.bigmodel.cn")) backend = "zhipu";
    else if (u.includes("api.kimi.com")) backend = "kimi";
    else if (u.includes("api.deepseek.com")) backend = "deepseek";
    else if (u.includes("dashscope")) backend = "qwen";
    else if (u.includes("xiaomimimo")) backend = "mimo";
    else if (u.includes("api.anthropic.com")) backend = "anthropic";
    else if (u.includes("generativelanguage")) backend = `gemini/${decodeURIComponent(u.split("/models/")[1]?.split(":")[0] ?? "?")}`;
    else if (u.includes("duckduckgo")) backend = "ddg";
    calls.push(backend);
    bodies.push(String(init?.body ?? ""));
    urls.push(u);
    auths.push(String(new Headers(init?.headers).get("authorization") ?? ""));
    return handler(backend, n++);
  }) as typeof fetch;
  return { calls, bodies, urls, auths, restore: () => { globalThis.fetch = real; } };
}

test.before(() => {
  // key 不落盘的设计下用 overrideKeys 注入：两家都给 key，链才有得降级。当前会话落在 zhipu
  // （原生搜索优先：会话用哪家就先用哪家的搜索，所以最后一次 setConfig 决定排第一的是谁）。
  setConfig({ provider: "gemini", apiKey: "gemini-test-key" });
  setConfig({ provider: "zhipu", apiKey: "zhipu-test-key" });
  // 默认关掉免 key 兜底，让用例只面对 zhipu → gemini 两档；需要时逐个打开。
  process.env.WEBSEARCH_DISABLE_DDG = "1";
  delete process.env.WEBSEARCH_BACKENDS;
});

test("默认链：国内直连的 zhipu 排第一，gemini 次之", () => {
  assert.deepEqual(pickChain().map((b) => b.id), ["zhipu", "gemini"]);
  assert.equal(webSearchAvailable(), true);
});

test("zhipu 命中即收手，不碰 gemini；结果标明后端", async () => {
  const stub = stubFetch(() => zhipuOk());
  try {
    const r = await webSearchTool.run({ query: uniq("首选") }, ctx());
    assert.equal(r.ok, true);
    const text = (r.content[0] as any).text as string;
    assert.match(text, /\[via 智谱 web_search/);
    assert.match(text, /https:\/\/z\.example\/a/);
    assert.deepEqual(stub.calls, ["zhipu"]);
  } finally {
    stub.restore();
  }
});

test("zhipu 5xx：先原地重试，再降级到 gemini", async () => {
  const stub = stubFetch((backend) => {
    if (backend === "zhipu") return json(503, { error: "busy" });
    return geminiOk("Gemini 的答案");
  });
  try {
    const r = await webSearchTool.run({ query: uniq("降级") }, ctx());
    assert.equal(r.ok, true);
    assert.match((r.content[0] as any).text, /Gemini 的答案/);
    // zhipu 首发 + 1 次重试，然后才轮到 gemini 主力模型
    assert.deepEqual(stub.calls, ["zhipu", "zhipu", "gemini/gemini-3.5-flash-lite"]);
  } finally {
    stub.restore();
  }
});

test("zhipu 4xx（key/参数错）不重试，直接换后端", async () => {
  const stub = stubFetch((backend) =>
    backend === "zhipu" ? json(401, { error: "bad key" }) : geminiOk("换家了"),
  );
  try {
    const r = await webSearchTool.run({ query: uniq("不重试") }, ctx());
    assert.equal(r.ok, true);
    assert.deepEqual(stub.calls, ["zhipu", "gemini/gemini-3.5-flash-lite"]);
  } finally {
    stub.restore();
  }
});

test("gemini 内部模型链：503 换下一档，成功即收手", async () => {
  const stub = stubFetch((backend) => {
    if (backend === "zhipu") return json(500, { error: "down" });
    if (backend === "gemini/gemini-3.5-flash-lite") return json(503, { error: "high demand" });
    return geminiOk("备胎答的");
  });
  try {
    const r = await webSearchTool.run({ query: uniq("模型链") }, ctx());
    assert.equal(r.ok, true);
    assert.match((r.content[0] as any).text, /备胎答的/);
    assert.deepEqual(stub.calls.filter((c) => c.startsWith("gemini")), [
      "gemini/gemini-3.5-flash-lite",
      "gemini/gemini-3.5-flash",
    ]);
  } finally {
    stub.restore();
  }
});

test("gemini 模型链跑完就不让外层重试整家（每档只打一次）", async () => {
  const stub = stubFetch(() => json(503, { error: "high demand" }));
  try {
    const r = await webSearchTool.run({ query: uniq("不重复撞") }, ctx());
    assert.equal(r.ok, false);
    const gemini = stub.calls.filter((c) => c.startsWith("gemini"));
    // 三档模型各一次，不会因为外层重试而翻倍
    assert.deepEqual(gemini, [
      "gemini/gemini-3.5-flash-lite",
      "gemini/gemini-3.5-flash",
      "gemini/gemini-3.1-flash-lite",
    ]);
  } finally {
    stub.restore();
  }
});

test("thinkingLevel 不被支持时同模型去掉该字段重发", async () => {
  let geminiCalls = 0;
  const stub = stubFetch((backend) => {
    if (backend === "zhipu") return json(401, { error: "bad key" });
    return geminiCalls++ === 0
      ? json(400, { error: { message: "Thinking level is not supported for this model." } })
      : geminiOk("去掉 thinking 就好了");
  });
  try {
    const r = await webSearchTool.run({ query: uniq("thinking") }, ctx());
    assert.equal(r.ok, true);
    const geminiBodies = stub.bodies.filter((b) => b.includes("google_search"));
    assert.match(geminiBodies[0], /thinkingConfig/);
    assert.doesNotMatch(geminiBodies[1], /thinkingConfig/);
  } finally {
    stub.restore();
  }
});

test("网络抖动（fetch throw）算可重试", async () => {
  const stub = stubFetch((_b, n) => {
    if (n === 0) throw new TypeError("fetch failed");
    return zhipuOk("恢复了");
  });
  try {
    const r = await webSearchTool.run({ query: uniq("抖动") }, ctx());
    assert.equal(r.ok, true);
    assert.match((r.content[0] as any).text, /恢复了/);
  } finally {
    stub.restore();
  }
});

test("免 key 兜底：两家 key 都不可用时走 DuckDuckGo", async () => {
  delete process.env.WEBSEARCH_DISABLE_DDG;
  process.env.WEBSEARCH_BACKENDS = "ddg";
  const stub = stubFetch(() => ddgOk());
  try {
    assert.deepEqual(pickChain().map((b) => b.id), ["ddg"]);
    const r = await webSearchTool.run({ query: uniq("兜底") }, ctx());
    assert.equal(r.ok, true);
    const text = (r.content[0] as any).text as string;
    assert.match(text, /\[via DuckDuckGo\]/);
    // uddg 重定向壳必须被解开成真实 URL
    assert.match(text, /https:\/\/d\.example\/a/);
    assert.match(text, /DDG 摘要/);
  } finally {
    stub.restore();
    delete process.env.WEBSEARCH_BACKENDS;
    process.env.WEBSEARCH_DISABLE_DDG = "1";
  }
});

test("同一 query 15 分钟内命中缓存，不再打网络", async () => {
  const query = uniq("缓存");
  const stub = stubFetch(() => zhipuOk());
  try {
    await webSearchTool.run({ query }, ctx());
    const before = stub.calls.length;
    const r = await webSearchTool.run({ query }, ctx());
    assert.equal(r.ok, true);
    assert.equal(stub.calls.length, before, "第二次不应产生任何请求");
    assert.match((r.content[0] as any).text, /缓存结果/);
  } finally {
    stub.restore();
  }
});

test("全链失败：报出试过哪些后端 + 出海诊断", async () => {
  const stub = stubFetch(() => json(503, { error: "busy" }));
  try {
    const r = await webSearchTool.run({ query: uniq("全挂") }, ctx());
    assert.equal(r.ok, false);
    const text = (r.content[0] as any).text as string;
    assert.match(text, /zhipu/);
    assert.match(text, /gemini/);
    // zhipu 可用（不需出海）时不该甩「都要出海」那句诊断
    assert.doesNotMatch(text, /都需要出海/);
  } finally {
    stub.restore();
  }
});

test("只剩需出海的后端时，失败文案点出真因", async () => {
  process.env.WEBSEARCH_BACKENDS = "gemini";
  const stub = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const r = await webSearchTool.run({ query: uniq("出海") }, ctx());
    assert.equal(r.ok, false);
    assert.match((r.content[0] as any).text, /都需要出海/);
  } finally {
    stub.restore();
    delete process.env.WEBSEARCH_BACKENDS;
  }
});

test("用户中止不重试也不降级", async () => {
  const ac = new AbortController();
  const stub = stubFetch(() => {
    ac.abort();
    throw new DOMException("aborted", "AbortError");
  });
  try {
    const c = ctx();
    c.signal = ac.signal;
    const r = await webSearchTool.run({ query: uniq("中止") }, c);
    assert.equal(r.ok, false);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

// ── 各家原生搜索（2026-09-29）──────────────────────────────────────────────────
// 会话用哪家就先用哪家自己的搜索（同 key、同接口域名）；这些用例临时给那家一把 key、切过去，结束时切回 zhipu。
async function withProvider<T>(provider: any, key: string, fn: () => Promise<T>): Promise<T> {
  setConfig({ provider, apiKey: key });
  try {
    return await fn();
  } finally {
    setConfig({ provider: "zhipu" });
  }
}

test("会话在哪家，就先用哪家的原生搜索", async () => {
  for (const [provider, id] of [["kimi", "kimi"], ["openai", "deepseek"], ["qwen", "qwen"], ["mimo", "mimo"], ["anthropic", "anthropic"]] as const) {
    await withProvider(provider, `${provider}-test-key`, async () => {
      assert.equal(pickChain()[0]?.id, id, `${provider} 会话的第一顺位`);
    });
  }
  assert.equal(pickChain()[0]?.id, "zhipu");
});

test("按会话在用的那家排第一，不看全局配置：全局是智谱，小米会话照样先用小米", async () => {
  setConfig({ provider: "mimo", apiKey: "tp-test-key" });
  setConfig({ provider: "zhipu" });
  resetNativeSearchState();
  assert.equal(pickChain()[0]?.id, "zhipu", "没有会话信息时回落全局");
  const stub = stubFetch((backend) =>
    backend === "mimo"
      ? json(200, { choices: [{ message: { role: "assistant", content: "小米答", annotations: [{ url: "https://mi.example/s", title: "MI" }] } }] })
      : zhipuOk(),
  );
  try {
    const r = await webSearchTool.run({ query: uniq("会话优先") }, { ...ctx(), provider: "mimo" } as ToolContext);
    assert.equal(r.ok, true);
    assert.match((r.content[0] as any).text as string, /小米答/);
    assert.deepEqual(stub.calls, ["mimo"], "小米会话不该先去打智谱");
  } finally {
    stub.restore();
  }
});

test("智谱余额不足（HTTP 429 + code 1113）不原地重试，直接换下一家并提醒", async () => {
  const stub = stubFetch((backend) =>
    backend === "zhipu" ? json(429, { error: { code: "1113", message: "余额不足或无可用资源包,请充值。" } }) : geminiOk("G 答"),
  );
  try {
    const r = await webSearchTool.run({ query: uniq("1113") }, ctx());
    assert.equal(r.ok, true);
    assert.deepEqual(stub.calls.filter((c) => c === "zhipu").length, 1, "余额不足只打一次");
    assert.match((r.content[0] as any).text as string, /余额不足/);
  } finally {
    stub.restore();
  }
});

test("DeepSeek：走 Anthropic 兼容接口的 web_search，来源与最后一段正文都取到", async () => {
  await withProvider("openai", "ds-test-key", async () => {
    const stub = stubFetch(() =>
      json(200, {
        content: [
          { type: "text", text: "我去搜一下。" },
          { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
          { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://ds.example/a", title: "DS 标题", page_age: "2 days ago" }] },
          { type: "text", text: "答案：9 月 22 日发布。" },
        ],
      }),
    );
    try {
      const r = await webSearchTool.run({ query: uniq("ds") }, ctx());
      assert.equal(r.ok, true);
      const text = (r.content[0] as any).text as string;
      assert.match(text, /\[via DeepSeek 联网搜索/);
      assert.match(text, /答案：9 月 22 日发布/);
      assert.doesNotMatch(text, /我去搜一下/);
      assert.match(text, /https:\/\/ds\.example\/a/);
      assert.deepEqual(stub.calls, ["deepseek"]);
      const body = JSON.parse(stub.bodies[0]);
      assert.equal(body.tools[0].type, "web_search_20250305");
    } finally {
      stub.restore();
    }
  });
});

test("通义：DashScope 原生接口带 enable_search + enable_source，search_info 转成来源", async () => {
  await withProvider("qwen", "qw-test-key", async () => {
    const stub = stubFetch(() =>
      json(200, {
        output: {
          choices: [{ message: { role: "assistant", content: "通义的答案" } }],
          search_info: { search_results: [{ url: "https://qw.example/a", title: "QW 标题", site_name: "某站" }] },
        },
      }),
    );
    try {
      const r = await webSearchTool.run({ query: uniq("qw") }, ctx());
      assert.equal(r.ok, true);
      const text = (r.content[0] as any).text as string;
      assert.match(text, /通义的答案/);
      assert.match(text, /https:\/\/qw\.example\/a/);
      const body = JSON.parse(stub.bodies[0]);
      assert.equal(body.parameters.enable_search, true);
      assert.equal(body.parameters.search_options.enable_source, true);
    } finally {
      stub.restore();
    }
  });
});

test("Kimi：订阅的 /search 接口，结构化结果", async () => {
  await withProvider("kimi", "sk-kimi-test", async () => {
    const stub = stubFetch(() => json(200, { search_results: [{ title: "K 标题", url: "https://k.example/a", snippet: "K 摘要", date: "2026-09-22" }] }));
    try {
      const r = await webSearchTool.run({ query: uniq("kimi") }, ctx());
      assert.equal(r.ok, true);
      const text = (r.content[0] as any).text as string;
      assert.match(text, /\[via Kimi 搜索\]/);
      assert.match(text, /2026-09-22 · K 摘要/);
      assert.deepEqual(stub.calls, ["kimi"]);
    } finally {
      stub.restore();
    }
  });
});

test("小米：插件没开时秒失败、换下一家，结果里提醒去开插件；之后半小时不再白撞", async () => {
  resetNativeSearchState();
  await withProvider("mimo", "tp-test-key", async () => {
    const stub = stubFetch((backend) =>
      backend === "mimo"
        ? json(400, { error: { code: "400", message: "Param Incorrect", param: "web search tool found in the request body, but webSearchEnabled is false" } })
        : zhipuOk("智谱顶上"),
    );
    try {
      const r = await webSearchTool.run({ query: uniq("mimo-off") }, ctx());
      assert.equal(r.ok, true);
      const text = (r.content[0] as any).text as string;
      assert.match(text, /智谱顶上/);
      // tp- 是 Token Plan：它那个接口一律不开插件，提示要说真原因（去配按量 key），别叫用户去开早就开着的插件
      assert.match(text, /Token Plan/);
      assert.match(text, /MIMO_SEARCH_API_KEY/);
      assert.deepEqual(stub.calls, ["mimo", "zhipu"]);
      // 第二次：不再打小米
      const r2 = await webSearchTool.run({ query: uniq("mimo-off2") }, ctx());
      assert.equal(r2.ok, true);
      assert.deepEqual(stub.calls, ["mimo", "zhipu", "zhipu"]);
    } finally {
      stub.restore();
      resetNativeSearchState();
    }
  });
});

test("小米：插件开了，annotations 转成来源", async () => {
  resetNativeSearchState();
  await withProvider("mimo", "tp-test-key", async () => {
    const stub = stubFetch(() =>
      json(200, {
        choices: [{ message: { role: "assistant", content: "小米的答案", annotations: [{ type: "url_citation", url: "https://mi.example/a", title: "MI 标题", summary: "MI 摘要" }] } }],
      }),
    );
    try {
      const r = await webSearchTool.run({ query: uniq("mimo-on") }, ctx());
      assert.equal(r.ok, true);
      const text = (r.content[0] as any).text as string;
      assert.match(text, /小米的答案/);
      assert.match(text, /https:\/\/mi\.example\/a/);
      assert.match(stub.bodies[0], /"type":"web_search"/);
      assert.match(stub.calls[0], /mimo/);
    } finally {
      stub.restore();
    }
  });
});

test("小米：单独配了按量付费的搜索 key，搜索走它和按量地址，聊天的 Token Plan key 不动", async () => {
  resetNativeSearchState();
  process.env.MIMO_SEARCH_API_KEY = "sk-search-test";
  try {
    await withProvider("mimo", "tp-test-key", async () => {
      const stub = stubFetch(() =>
        json(200, { choices: [{ message: { role: "assistant", content: "按量搜到了", annotations: [{ url: "https://mi.example/p", title: "P" }] } }] }),
      );
      try {
        const r = await webSearchTool.run({ query: uniq("mimo-sk") }, ctx());
        assert.equal(r.ok, true);
        assert.match((r.content[0] as any).text as string, /按量搜到了/);
        assert.match(stub.urls[0], /^https:\/\/api\.xiaomimimo\.com\/v1\/chat\/completions$/);
        assert.equal(stub.auths[0], "Bearer sk-search-test");
      } finally {
        stub.restore();
      }
    });
  } finally {
    delete process.env.MIMO_SEARCH_API_KEY;
    resetNativeSearchState();
  }
});

test("小米：按量 key 本身没开插件时，提示去开插件（不是 Token Plan 那句）", async () => {
  resetNativeSearchState();
  await withProvider("mimo", "sk-plain-key", async () => {
    const stub = stubFetch((backend) =>
      backend === "mimo"
        ? json(400, { error: { code: "400", message: "Param Incorrect", param: "web search tool found in the request body, but webSearchEnabled is false" } })
        : zhipuOk("智谱顶上"),
    );
    try {
      const r = await webSearchTool.run({ query: uniq("mimo-sk-off") }, ctx());
      const text = (r.content[0] as any).text as string;
      assert.match(text, /插件管理/);
      assert.doesNotMatch(text, /Token Plan/);
    } finally {
      stub.restore();
      resetNativeSearchState();
    }
  });
});
