import assert from "node:assert/strict";
import test from "node:test";
import { setConfig } from "./config.ts";
import { Sandbox } from "./sandbox.ts";
import { webSearchTool, pickChain, webSearchAvailable } from "./tools/websearch.ts";
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
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    let backend = "?";
    if (u.includes("open.bigmodel.cn")) backend = "zhipu";
    else if (u.includes("generativelanguage")) backend = `gemini/${decodeURIComponent(u.split("/models/")[1]?.split(":")[0] ?? "?")}`;
    else if (u.includes("duckduckgo")) backend = "ddg";
    calls.push(backend);
    bodies.push(String(init?.body ?? ""));
    return handler(backend, n++);
  }) as typeof fetch;
  return { calls, bodies, restore: () => { globalThis.fetch = real; } };
}

test.before(() => {
  // key 不落盘的设计下用 overrideKeys 注入：两家都给 key，链才有得降级。
  setConfig({ provider: "zhipu", apiKey: "zhipu-test-key" });
  setConfig({ provider: "gemini", apiKey: "gemini-test-key" });
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
