// 零依赖安全 markdown 渲染：先转义再上格式，模型输出的任何原始 HTML 都到不了 DOM。
// 覆盖 agent 回复的常用面：标题 / 粗斜体 / 行内码 / 围栏代码(带语言标签+复制钮) /
// 无序有序列表 / 链接(仅 http(s)) / 表格 / 引用 / 分隔线。
import { t } from "./i18n.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 行内格式（输入已转义）
function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '<code class="ic">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(（>])\*([^*\s][^*]*?)\*(?=[\s).,;:!?，。；：）]|$)/g, "$1<em>$2</em>")
    // [文字](https://…) — 仅放行 http(s)，转义后 & 已成 &amp; 无注入面
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function table(lines: string[]): string {
  const cells = (l: string) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => inline(c.trim()));
  let html = '<div class="tbl-wrap"><table>';
  html += "<thead><tr>" + cells(lines[0]).map((c) => `<th>${c}</th>`).join("") + "</tr></thead>";
  if (lines.length > 2) {
    html += "<tbody>";
    for (let i = 2; i < lines.length; i++) {
      html += "<tr>" + cells(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>";
    }
    html += "</tbody>";
  }
  return html + "</table></div>";
}

// 块级解析（输入已转义、不含围栏代码）
function blocks(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>` + list.items.map((i) => `<li>${i}</li>`).join("") + `</${tag}>`);
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const ul = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/.exec(line);
    const bq = /^\s{0,3}&gt;\s?(.*)$/.exec(line);
    const hr = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line);
    // 表格：表头行 + 分隔行
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const tl = [line, lines[i + 1]];
      let k = i + 2;
      while (k < lines.length && lines[k].includes("|") && lines[k].trim() !== "") tl.push(lines[k++]);
      out.push(table(tl));
      i = k - 1;
      continue;
    }
    if (h) {
      flushPara(); flushList();
      const lvl = Math.min(h[1].length + 2, 6); // 模型的 # 在聊天里降两级渲染，别喧宾夺主
      out.push(`<h${lvl} class="md-h">${inline(h[2])}</h${lvl}>`);
    } else if (hr) {
      flushPara(); flushList();
      out.push("<hr>");
    } else if (bq) {
      flushPara(); flushList();
      const acc = [bq[1]];
      while (i + 1 < lines.length) {
        const m = /^\s{0,3}&gt;\s?(.*)$/.exec(lines[i + 1]);
        if (!m) break;
        acc.push(m[1]);
        i++;
      }
      out.push(`<blockquote>${inline(acc.join("\n")).replace(/\n/g, "<br>")}</blockquote>`);
    } else if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      const item = ordered ? ol![2] : ul![1];
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(inline(item));
    } else if (line.trim() === "") {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join("");
}

// highlight：围栏代码上色（U7：只在稳定块与最终渲染上做；流式的尾块不做，免得 90ms 一次的落地变成重活）
export function renderMarkdown(src: string, opts: { highlight?: boolean } = {}): string {
  const highlight = opts.highlight !== false;
  const parts = src.split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // 围栏代码
      let code = parts[i];
      let lang = "";
      const nl = code.indexOf("\n");
      if (nl !== -1) {
        const first = code.slice(0, nl).trim();
        if (/^[a-z0-9+#.\-]*$/i.test(first)) {
          lang = first;
          code = code.slice(nl + 1);
        }
      }
      code = code.replace(/\n$/, "");
      html +=
        `<div class="cb"><div class="cb-bar"><span class="cb-lang">${esc(lang) || "code"}</span>` +
        `<button class="cb-copy" data-copy>${t("复制")}</button></div>` +
        `<pre><code>${highlight ? highlightCode(code, lang) : esc(code)}</code></pre></div>`;
    } else if (parts[i]) {
      html += blocks(esc(parts[i]));
    }
  }
  return html;
}

// ── U7（Codex X37 / X03）：流式正文两段式渲染 ─────────────────────────────────────
// 以前流式期间每 90ms 把整段 markdown 重新解析、{@html} 整棵子树重建，渐入还要逐帧走全文——38K 字的回答累计解析上百 MB 的
// HTML，后半段在手机上发卡；表格与粗体在流式期间翻版式。现在切成「稳定块（渲染一次就不再变）+ 尾块（唯一重渲染的部分）」。

// 稳定切点：围栏代码之外、空行之后（落在下一块的开头）。块在空行处本来就断开、围栏按「```」出现次数配对，所以切开的
// 两段分别渲染再拼起来，与整段一次渲染一字不差（server/md-stream.test.ts 逐字符钉住）。
export function stableCuts(src: string): number[] {
  const cuts: number[] = [];
  let fences = 0;
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("```", i)) {
      fences++;
      i += 3;
      continue;
    }
    if (src[i] === "\n" && src[i + 1] === "\n" && fences % 2 === 0) {
      let j = i + 2;
      while (src[j] === "\n") j++;
      if (j < src.length) cuts.push(j);
      i = j;
      continue;
    }
    i++;
  }
  return cuts;
}

export interface StreamParts {
  // 稳定块：start = 在全文里的起点（文字只追加，起点不变——渲染缓存按它认）
  chunks: { start: number; src: string }[];
  tail: string;
}

export function streamParts(src: string): StreamParts {
  const chunks: StreamParts["chunks"] = [];
  let prev = 0;
  for (const cut of stableCuts(src)) {
    chunks.push({ start: prev, src: src.slice(prev, cut) });
    prev = cut;
  }
  return { chunks, tail: src.slice(prev) };
}

const TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

// 尾块：没收尾的结构先压住，不先渲成别的样子再翻过来——
//   · 表格只到了表头（分隔行还没来）：这一行按原文等宽显示，分隔行到了再成表
//   · 最后一段里落单的 `**`、行内反引号：先把标记本身藏起来（字照常显示），配上对了再加粗 / 成行内码
// 在围栏代码里（尾块里「```」是奇数个）不压：未闭合的代码块本来就按代码显示。
export function renderTail(tail: string): string {
  if ((tail.split("```").length - 1) % 2 === 1) return renderMarkdown(tail, { highlight: false });
  const lines = tail.split("\n");
  const last = lines[lines.length - 1];
  let held = "";
  if (last.includes("|") && !TABLE_SEP.test(last) && !lines.some((l) => TABLE_SEP.test(l))) {
    held = `<pre class="md-hold">${esc(last)}</pre>`;
    lines.pop();
  }
  let body = lines.join("\n");
  const lastPara = body.slice(body.lastIndexOf("\n\n") + 1);
  const cut = body.length - lastPara.length;
  let para = lastPara;
  if ((para.match(/\*\*/g)?.length ?? 0) % 2 === 1) {
    const k = para.lastIndexOf("**");
    para = para.slice(0, k) + para.slice(k + 2);
  }
  if ((para.replace(/\*\*/g, "").match(/`/g)?.length ?? 0) % 2 === 1) {
    const k = para.lastIndexOf("`");
    para = para.slice(0, k) + para.slice(k + 1);
  }
  body = body.slice(0, cut) + para;
  return renderMarkdown(body, { highlight: false }) + held;
}

// ── 代码上色（零依赖）：先按语言切词，每一段都先转义再包 span——模型给的任何字符都到不了标记里 ─────────────
type Lang = "js" | "py" | "sh" | "ps" | "go" | "rust" | "java" | "c" | "sql" | "css" | "json" | "yaml" | "html";
const LANGS: Record<string, Lang> = {
  js: "js", javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", mjs: "js", cjs: "js",
  py: "py", python: "py", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh",
  ps1: "ps", powershell: "ps", pwsh: "ps", go: "go", rs: "rust", rust: "rust", java: "java", kotlin: "java",
  cs: "java", csharp: "java", c: "c", cpp: "c", "c++": "c", h: "c", hpp: "c", sql: "sql", css: "css", scss: "css",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "yaml", html: "html", xml: "html", svelte: "html", vue: "html",
};
const words = (s: string) => new Set(s.split(" "));
const KEYWORDS: Partial<Record<Lang, Set<string>>> = {
  js: words("const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of this super null undefined true false void yield interface type enum implements readonly as satisfies"),
  py: words("def class return if elif else for while in not and or is import from as with try except finally raise lambda yield pass break continue None True False global nonlocal async await self"),
  sh: words("if then else elif fi for in do done while until case esac function return export local readonly exit set unset source shift"),
  ps: words("function param if else elseif foreach for while do switch return try catch finally throw begin process end $true $false $null"),
  go: words("func package import return if else for range switch case default break continue go defer select chan map struct interface type var const nil true false"),
  rust: words("fn let mut pub use mod struct enum impl trait for in if else match loop while return break continue move ref self Self crate super as where async await dyn true false None Some Ok Err"),
  java: words("public private protected static final class interface extends implements new return if else for while do switch case break continue try catch finally throw throws import package void int long double float boolean char byte short null true false this super var val fun override"),
  c: words("int long short char float double void unsigned signed const static struct enum union typedef return if else for while do switch case break continue sizeof include define ifdef ifndef endif nullptr true false auto class public private template namespace using"),
  sql: words("select from where and or not insert into values update set delete create table drop alter add index on join left right inner outer group by order having limit as distinct null is in like between case when then else end primary key"),
  json: words("true false null"),
  yaml: words("true false null yes no"),
};
const HASH_COMMENT = "(?<![\\w$])#[^\\n]*";
const SLASH_COMMENT = "//[^\\n]*|/\\*[\\s\\S]*?\\*/";
const COMMENTS: Record<Lang, string> = {
  js: SLASH_COMMENT, go: SLASH_COMMENT, rust: SLASH_COMMENT, java: SLASH_COMMENT, c: SLASH_COMMENT, css: "/\\*[\\s\\S]*?\\*/",
  py: HASH_COMMENT, sh: HASH_COMMENT, ps: HASH_COMMENT, yaml: HASH_COMMENT, sql: "--[^\\n]*", html: "<!--[\\s\\S]*?-->", json: "(?!)",
};
const STRINGS = "\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`";
const TOKENIZERS = new Map<Lang, RegExp>();

function tokenizer(lang: Lang): RegExp {
  let re = TOKENIZERS.get(lang);
  if (!re) {
    re = new RegExp(`(${COMMENTS[lang]})|(${STRINGS})|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_$][\\w$]*)`, "g");
    TOKENIZERS.set(lang, re);
  }
  re.lastIndex = 0;
  return re;
}

export function highlightCode(code: string, lang: string): string {
  const l = LANGS[lang.toLowerCase()];
  if (!l || code.length > 200_000) return esc(code);
  const kw = KEYWORDS[l];
  const ci = l === "sql";
  const re = tokenizer(l);
  let out = "";
  let at = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    out += esc(code.slice(at, m.index));
    const tok = esc(m[0]);
    if (m[1]) out += `<span class="hl-c">${tok}</span>`;
    else if (m[2]) out += `<span class="hl-s">${tok}</span>`;
    else if (m[3]) out += `<span class="hl-n">${tok}</span>`;
    else if (kw && kw.has(ci ? m[0].toLowerCase() : m[0])) out += `<span class="hl-k">${tok}</span>`;
    else out += tok;
    at = m.index + m[0].length;
  }
  return out + esc(code.slice(at));
}

