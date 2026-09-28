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

test("U7 尾块先压住没收尾的结构：只到表头的表格按原文等宽显示；落单的 ** 与行内反引号不露出来；未闭合的代码块照常显示成代码", () => {
  const header = renderTail("| 列 | 值 |");
  assert.match(header, /class="md-hold"/);
  assert.doesNotMatch(header, /<table>|<p>/, "不先渲成一段文字");
  assert.match(renderTail("| 列 | 值 |\n|---|---|"), /<table>/, "分隔行到了就成表");
  const bold = renderTail("这一步很 **重");
  assert.doesNotMatch(bold, /\*\*/);
  assert.match(bold, /这一步很 重/, "字照常显示");
  assert.match(renderTail("这一步很 **重要**，"), /<strong>重要<\/strong>/);
  assert.doesNotMatch(renderTail("跑一下 `npm"), /`/);
  const fence = renderTail("看代码：\n\n```js\nconst x = **1");
  assert.match(fence, /<pre><code>const x = \*\*1<\/code><\/pre>/, "围栏里原样、不上色");
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
