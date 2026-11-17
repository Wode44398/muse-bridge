// U7（Codex X37 / X03，修 #50）：流式正文两段式渲染——稳定块只渲一次、尾块唯一可变；表格与未闭合的行内标记先压住；
// 代码上色只在稳定块与最终渲染上做。
//
// 修前：流式期间每 90ms 把整段 markdown 重新解析、{@html} 整棵子树重建，渐入逐帧走全文——38K 字的回答在流式期间累计解析
// 上百 MB 的 HTML，后半段在手机上发卡；表格只到表头时先渲成一段文字、分隔行一到再翻成表格，粗体先露出 ** 再变粗。
// 修后：按「围栏代码之外的空行」切成稳定块 + 尾块。关键不变量：切开的各块分别渲染再拼起来，与整段一次渲染一字不差（否则
// 流式中看到的和流结束后看到的不一样）；稳定块只增不改（渲染缓存按起点认）。
import assert from "node:assert/strict";
import test from "node:test";
import { highlightCode, renderMarkdown, renderTail, stableCuts, streamParts } from "../web/src/lib/markdown.ts";

const SAMPLES = [
  "第一段，有 **粗体** 和 `行内码`。\n\n第二段\n换行也在。\n\n- 列表一\n- 列表二\n\n1. 有序\n2. 第二项\n\n> 引用\n> 第二行\n\n### 标题\n\n---\n\n收尾。",
  "表格前一段\n\n| 列 | 值 |\n|---|---|\n| a | 1 |\n| b | 2 |\n\n表格后一段",
  "代码之前\n\n```ts\nconst a = 1;\n\n// 代码里的空行不是切点\nfunction f() {\n  return \"x\";\n}\n```\n\n代码之后\n\n```\n未标语言\n```",
  "紧贴围栏```js\nx```后面\n\n再一段",
  "四个反引号 ```` 的边缘\n\n还有一段\n\n```py\nprint('hi')\n```",
  "列表\n\n- a\n\n- b\n\n空行分开的列表项各成一组",
  "[链接](https://example.com) 与 *斜体*\n\n\n\n多个空行之后",
];

test("U7 逐字符流式：各稳定块分别渲染再拼上尾块，与整段一次渲染一字不差；稳定块只增不改", () => {
  for (const sample of SAMPLES) {
    let prev: { start: number; src: string }[] = [];
    for (let k = 0; k <= sample.length; k++) {
      const prefix = sample.slice(0, k);
      const parts = streamParts(prefix);
      const joined = parts.chunks.map((c) => renderMarkdown(c.src)).join("") + renderMarkdown(parts.tail);
      assert.equal(joined, renderMarkdown(prefix), `切开渲染与整段渲染不一致：${JSON.stringify(prefix.slice(-40))}`);
      assert.equal(parts.chunks.map((c) => c.src).join("") + parts.tail, prefix, "切开再拼回去就是原文");
      for (let i = 0; i < prev.length; i++) assert.deepEqual(parts.chunks[i], prev[i], "已有的稳定块不能变");
      prev = parts.chunks;
    }
  }
  // 围栏代码里的空行不是切点
  const code = "a\n\n```\nx\n\ny\n```\n\nb";
  for (const cut of stableCuts(code)) assert.equal((code.slice(0, cut).split("```").length - 1) % 2, 0, "切点前的围栏成对");
});

test("U7 尾块过写头修补（bridge 的 repairTail）：表格表头 + 首行到齐才出表、数据行整行到齐；未闭合的 ** 与反引号提前补齐；进行中的代码块照常显示成代码", () => {
  assert.equal(renderTail("前文\n| 列 | 值 |"), "<p>前文</p>", "表头还在打：整行扣住");
  assert.equal(renderTail("前文\n| 列 | 值 |\n|---|---|\n"), "<p>前文</p>", "首行没来：整张表先扣住");
  const row = renderTail("| 列 | 值 |\n|---|---|\n| a | 1 |\n| b |");
  assert.match(row, /<td>a<\/td><td>1<\/td>/);
  assert.doesNotMatch(row, /<td>b<\/td>/, "半截数据行不放");
  assert.match(renderTail("这一步很 **重"), /这一步很 <strong>重<\/strong>/, "正在写的粗体从第一个字起就是粗体");
  assert.match(renderTail("这一步很 **重要**，"), /<strong>重要<\/strong>/);
  assert.match(renderTail("跑一下 `npm"), /<code class="ic">npm<\/code>/);
  assert.equal(renderTail("列表\n- "), "<p>列表</p>", "只有列表标记的行扣住");
  const fence = renderTail("看代码：\n\n```js\nconst x = **1");
  assert.match(fence, /<pre><code>const x = \*\*1<\/code><\/pre>/, "围栏里原样、不上色");
  // 只放行 http(s) 链接：URL 还在打时文字按链接样式（无 href），别的地址按原文
  assert.match(renderTail("见 [文档](https://exa"), /见 <a>文档<\/a>/);
  assert.match(renderTail("见 [文档](./a.md"), /\[文档\]\(\.\/a\.md/);
  assert.doesNotMatch(renderTail("a _b"), /_b_/, "不认 _ 强调：不补闭合");
});

// 吐字引擎（bridge 的 claudeFade）眼里的可见文字：标签之间的文本段，去掉纯空白段与代码卡标题栏（界面零件，不计数），解实体
function visible(html: string): string {
  const out: string[] = [];
  for (const seg of html.replace(/<div class="cb-bar">.*?<\/button><\/div>/g, "").split(/<[^>]*>/)) {
    if (!/\S/.test(seg)) continue;
    out.push(seg.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  }
  return out.join("");
}
const streamed = (prefix: string) => {
  const parts = streamParts(prefix);
  return parts.chunks.map((c) => renderMarkdown(c.src)).join("") + renderTail(parts.tail);
};

test("U7 逐字前缀扫描：流式渲染每个前缀的可见文字都是下一个前缀的前缀（已显形的字不回跳），收轮按原文渲染也接得上", () => {
  const sample = [
    "先说结论：**改动已完成**，下面是 `npm test` 的结果与细节，见 [说明](https://example.com/a)。",
    "",
    "这是一段很长的中文正文，用来测试逐字淡入的匀速程度，里面有 *强调* 与 **粗体**，还有行内代码 `repairTail()` 与普通的标点符号。",
    "",
    "1. 第一步：读文件",
    "2. 第二步：改 **核心** 逻辑",
    "",
    "- 无序一",
    "- 无序二，带 `code`",
    "",
    "> 引用一行",
    "> 引用第二行",
    "",
    "```ts",
    "const a = 1;",
    "",
    "function f(x: number) { return x * 2; }",
    "```",
    "",
    "| 名称 | 数量 | 说明 |",
    "|---|---:|---|",
    "| 苹果 | 3 | 红的 |",
    "| 香蕉 | 12 | **黄的** |",
    "",
    "---",
    "",
    "### 小标题",
    "",
    "收尾一句。",
  ].join("\n");
  const bad: string[] = [];
  let prev = "";
  for (let k = 0; k <= sample.length; k++) {
    const v = visible(streamed(sample.slice(0, k)));
    if (!v.startsWith(prev)) bad.push(`${k}: ${JSON.stringify(prev.slice(-12))} → ${JSON.stringify(v.slice(-12))}`);
    prev = v;
  }
  const final = visible(renderMarkdown(sample));
  if (!final.startsWith(prev)) bad.push(`收轮: ${JSON.stringify(prev.slice(-12))} → ${JSON.stringify(final.slice(-12))}`);
  assert.deepEqual(bad, [], `回跳 ${bad.length} 处`);
});

const stripSpans = (html: string) => html.replace(/<span class="hl-[kcsn]">/g, "").replace(/<\/span>/g, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

test("U7 代码上色：只包 span、先转义——去掉 span 就是转义后的原文；认识的语言才上色", () => {
  const cases: [string, string][] = [
    ["js", 'const a = "<script>alert(1)</script>"; // 注释 <b>\nfunction f(x) { return x + 42; }'],
    ["python", "def f(x):  # 注释\n    return 'a#b' if x else None"],
    ["bash", "echo $# \"#不是注释\" # 是注释\nif [ -f a ]; then rm a; fi"],
    ["json", '{"a": 1, "b": [true, null, "x\\"y"]}'],
    ["sql", "SELECT * FROM t WHERE id = 3 -- 注释"],
    ["weird", "no <highlight> here"],
  ];
  for (const [lang, code] of cases) {
    const html = highlightCode(code, lang);
    assert.equal(stripSpans(html), esc(code), `${lang}：文字一字不改`);
    assert.doesNotMatch(html, /<script>|<b>/, `${lang}：原文里的标签都被转义`);
  }
  assert.match(highlightCode("const a = 1;", "ts"), /<span class="hl-k">const<\/span>/);
  assert.match(highlightCode("x = 'hi'", "py"), /<span class="hl-s">'hi'<\/span>/);
  assert.match(highlightCode("ls # 列出", "sh"), /<span class="hl-c"># 列出<\/span>/);
  assert.match(highlightCode("echo $#", "sh"), /\$#/, "$# 不是注释");
  assert.doesNotMatch(highlightCode("echo $#", "sh"), /hl-c/);
  assert.equal(highlightCode("SELECT 1", "unknown-lang"), "SELECT 1");
  // 流式尾块不上色，最终渲染上色
  assert.doesNotMatch(renderTail("```js\nconst a = 1;\n```"), /hl-k/);
  assert.match(renderMarkdown("```js\nconst a = 1;\n```"), /hl-k/);
});

test("U7 解析量：38K 字的回答按每批 150 字吐完——整段重渲是平方级，两段式是线性级", () => {
  const para = "这里在详细解释当前的实现与改动思路，包括为什么这么改、改完怎么验证。".repeat(6);
  const block = "```ts\nconst x = 1;\nexport function f() { return x; }\n```";
  const pieces: string[] = [];
  while (pieces.join("\n\n").length < 38_000) pieces.push(pieces.length % 5 === 4 ? block : para);
  const text = pieces.join("\n\n");
  let whole = 0;
  let twoStage = 0;
  const rendered = new Set<number>();
  for (let k = 150; k < text.length + 150; k += 150) {
    const prefix = text.slice(0, Math.min(k, text.length));
    whole += prefix.length; // 以前：每批整段重新解析
    const parts = streamParts(prefix);
    for (const c of parts.chunks) {
      if (!rendered.has(c.start)) {
        rendered.add(c.start);
        twoStage += c.src.length; // 稳定块：只渲一次
      }
    }
    twoStage += parts.tail.length; // 尾块：每批重渲
  }
  assert.ok(text.length >= 38_000);
  assert.ok(whole > 4_000_000, `整段重渲累计解析 ${whole} 字`);
  assert.ok(twoStage < text.length * 3, `两段式累计解析 ${twoStage} 字（原文 ${text.length} 字）`);
  assert.ok(whole / twoStage > 40, `少了 ${Math.round(whole / twoStage)} 倍`);
});
