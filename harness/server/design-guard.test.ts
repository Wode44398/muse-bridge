// U10（ZCode E6 + kimi K39）：前端设计规格的机器守卫——harness/DESIGN.md 里「机器守着」的那几条。
// 规格没有守卫就会慢慢腐烂（界面基本由 AI 写）。与 Q9 守卫同一套燃尽基线：
//   - 某文件的命中数比基线（web/design-baseline.json）多 → 红，报错里写着改用什么；
//   - 比基线少 → 只提示「顺手把基线下调」——存量只减不增；别为了过守卫一次性清历史（视觉细节要逐个在真机上看）；
//   - 单行豁免：`// guard: <规则> ok — <理由>` 或 `/* guard: <规则> ok — <理由> */`（写在该行行尾或上一行），理由不许空。
// 只读源码、不 import 被扫的模块。
//
//   REPORT=1 node --import ./server/test-setup.ts --test server/design-guard.test.ts   打印当前各规则各文件的命中数（定基线用）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";

const WEB = path.join(path.dirname(import.meta.dirname), "web");
const SRC = path.join(WEB, "src");
const BASELINE_FILE = path.join(WEB, "design-baseline.json");
const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) as { rules: Record<string, Record<string, number>> };

interface SourceFile {
  rel: string; // 相对 web/src，正斜杠
  raw: string[]; // 原文逐行（认豁免用）
  code: string[]; // 去掉注释之后逐行（行号不变；判定用）
  styles: { text: string; line: number }[]; // CSS 段（.css 整个文件；.svelte 的 <style>）与它在文件里的起始行（0 起）
}

// 注释换成等长空白（保留换行，行号不变）：/* */、<!-- -->、行首 //
function stripComments(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^\s*\/\/.*$/gm, blank);
}

function sourceFiles(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.(svelte|ts|css)$/.test(entry.name)) {
        const text = fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
        const code = stripComments(text);
        const styles: SourceFile["styles"] = [];
        if (entry.name.endsWith(".css")) styles.push({ text: code, line: 0 });
        else if (entry.name.endsWith(".svelte")) {
          for (const m of code.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
            const start = m.index! + m[0].indexOf(">") + 1;
            styles.push({ text: m[1], line: code.slice(0, start).split("\n").length - 1 });
          }
        }
        out.push({ rel: path.relative(SRC, abs).replace(/\\/g, "/"), raw: text.split("\n"), code: code.split("\n"), styles });
      }
    }
  };
  walk(SRC);
  return out;
}

interface Hit {
  rel: string;
  line: number; // 1 起
  text: string;
}

interface Rule {
  id: string;
  why: string; // 报错时告诉人（和 agent）改用什么
  scan: (f: SourceFile) => number[]; // 命中的行号（0 起）
}

// 逐行正则：命中的是去掉注释之后的行
const lineRule = (re: RegExp, skip?: (line: string) => boolean, only?: (rel: string) => boolean) => (f: SourceFile): number[] => {
  if (only && !only(f.rel)) return [];
  const hits: number[] = [];
  f.code.forEach((line, i) => {
    if (re.test(line) && !skip?.(line)) hits.push(i);
  });
  return hits;
};

// CSS 里 `:hover` 的规则，外面没有 `@media (hover: hover)` 包着 → 命中（触屏上 hover 态会「粘」在点过的元素上）
function unguardedHover(f: SourceFile): number[] {
  const hits: number[] = [];
  for (const block of f.styles) {
    const stack: string[] = [];
    let prelude = "";
    let preludeLine = block.line;
    let line = block.line;
    for (const ch of block.text) {
      if (ch === "{") {
        const head = prelude.trim();
        if (/:hover\b/.test(head) && !head.startsWith("@") && !stack.some((h) => /@media[^{]*\(\s*(any-)?hover\s*:\s*hover\s*\)/.test(h))) {
          hits.push(preludeLine);
        }
        stack.push(head);
        prelude = "";
      } else if (ch === "}") {
        stack.pop();
        prelude = "";
      } else if (ch === ";" && !stack.length) {
        prelude = ""; // @import …; 这类顶层语句
      } else {
        if (!prelude.trim() && ch.trim()) preludeLine = line;
        prelude += ch;
      }
      if (ch === "\n") line++;
    }
  }
  return hits;
}

// 请求头：对象字面量 headers: { … } 里只许 content-type / authorization（和 CORS 本来就放行的 accept 类）；
// 另起 new Headers / setRequestHeader / headers.set 一律算
const HEADER_OK = new Set(["content-type", "authorization", "accept", "accept-language", "content-language"]);
function requestHeaders(f: SourceFile): number[] {
  if (!/\.(ts|svelte)$/.test(f.rel)) return [];
  const code = f.code.join("\n");
  const lineOf = (at: number) => code.slice(0, at).split("\n").length - 1;
  const hits: number[] = [];
  for (const m of code.matchAll(/\bheaders\s*:\s*\{/g)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      else if (code[end] === "}" && --depth === 0) break;
    }
    const body = code.slice(m.index! + m[0].length, end);
    for (const k of body.matchAll(/(?:^|[,{\s])(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$-]*))\s*:/g)) {
      const key = (k[1] ?? k[2] ?? k[3] ?? "").toLowerCase();
      if (!HEADER_OK.has(key)) hits.push(lineOf(m.index! + m[0].length + k.index!));
    }
  }
  for (const m of code.matchAll(/new Headers\(|setRequestHeader\(|\bheaders\.(?:set|append)\(/g)) hits.push(lineOf(m.index!));
  return hits;
}

const RULES: Rule[] = [
  {
    id: "bare-root",
    why: "不写裸 :root——harness 的样式随 @hx 打进 bridge 的全局包，裸 :root 与宿主 :root 同特异性、按源顺序覆盖宿主令牌（apk218 把 bridge 暗色令牌全局改浅就是这么来的）；令牌挂在 .hxroot / html[data-hx-standalone] 上（见 app.css、lib/theme.ts）",
    scan: lineRule(/(^|[\s,{}>+~(])(:root)(?![\w-])/),
  },
  {
    id: "bare-color",
    why: "组件里别写裸色值（#hex / rgb() / hsl() 字面量）：主题令牌在 lib/theme.ts（--text / --accent / --ok / --warn / --err / --surface2 …），深浅两套主题才都对；要调透明度用 color-mix(in srgb, var(--x) 12%, transparent)。定义令牌（--名字: 值;）不算",
    scan: lineRule(
      /(?<![\w&#/.-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(\s*\d/,
      (line) => /^\s*--[\w-]+\s*:/.test(line),
      (rel) => rel !== "lib/theme.ts",
    ),
  },
  {
    id: "unguarded-hover",
    why: "hover 样式包进 @media (hover: hover) { … }：触屏上点过的元素会一直停在 hover 态（整个前端都是这么写的）",
    scan: unguardedHover,
  },
  {
    id: "request-header",
    why: "请求别加自定义头（只许 content-type / authorization）：离线 apk 跨源访问 bridge，bridge 的 CORS 只放行这两个，多一个头预检就失败、所有请求一起挂（M10 的坑）；要带信息走查询串",
    scan: requestHeaders,
  },
  {
    id: "window-open",
    why: "别直接 window.open：在 bridge 的内置浏览器 / 桌面壳里它会把整个页面导走；打开产物走 lib/open-artifact.ts 的宿主回调，没有宿主时的兜底才用它（Q13）",
    scan: lineRule(/\bwindow\.open\s*\(/),
  },
];

const EXEMPT_RE = /(?:\/\/|\/\*)\s*guard: ([a-z-]+) ok\b(.*)$/;

function scan(rule: Rule, files: SourceFile[]): { hits: Hit[]; badExemptions: Hit[] } {
  const hits: Hit[] = [];
  const badExemptions: Hit[] = [];
  for (const f of files) {
    for (const i of rule.scan(f)) {
      const exempt = [f.raw[i] ?? "", f.raw[i - 1] ?? ""].map((l) => EXEMPT_RE.exec(l)).find((m) => m?.[1] === rule.id);
      if (exempt) {
        // 豁免必须写理由：`— <理由>`，理由至少两个字
        if (!/^\s*[—-]+\s*\S.{1,}/.test(exempt[2].replace(/\*\/\s*$/, ""))) badExemptions.push({ rel: f.rel, line: i + 1, text: (f.raw[i] ?? "").trim() });
        continue;
      }
      hits.push({ rel: f.rel, line: i + 1, text: (f.raw[i] ?? "").trim().slice(0, 120) });
    }
  }
  return { hits, badExemptions };
}

function countBy(hits: Hit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hits) out[h.rel] = (out[h.rel] ?? 0) + 1;
  return out;
}

const files = sourceFiles();

if (process.env.REPORT) {
  const rules: Record<string, Record<string, number>> = {};
  for (const rule of RULES) rules[rule.id] = Object.fromEntries(Object.entries(countBy(scan(rule, files).hits)).sort());
  console.log(JSON.stringify({ rules }, null, 2));
}

for (const rule of RULES) {
  test(`K39 设计守卫 ${rule.id}：不许新增（存量只减不增）`, (t: TestContext) => {
    const { hits, badExemptions } = scan(rule, files);
    assert.deepEqual(badExemptions, [], `这些豁免没写理由（格式：// guard: ${rule.id} ok — <理由>）`);
    const now = countBy(hits);
    const base = baseline.rules[rule.id] ?? {};
    const grown = Object.keys(now).filter((rel) => now[rel] > (base[rel] ?? 0));
    const detail = grown
      .map((rel) => `  ${rel}：${now[rel]} 处（基线 ${base[rel] ?? 0}）\n${hits.filter((h) => h.rel === rel).map((h) => `    :${h.line}  ${h.text}`).join("\n")}`)
      .join("\n");
    assert.deepEqual(grown, [], `「${rule.id}」有新增违规——${rule.why}\n${detail}`);
    for (const rel of Object.keys(base)) {
      if ((now[rel] ?? 0) < base[rel]) t.diagnostic(`「${rule.id}」${rel} 从 ${base[rel]} 降到 ${now[rel] ?? 0}：请顺手把 web/design-baseline.json 里的基线下调`);
    }
  });
}

// 守卫自己的判定：拿样例钉住，免得规则写宽 / 写窄了还不知道
test("K39 设计守卫的判定样例：该中的中、不该中的不中、豁免要理由", () => {
  const mk = (rel: string, text: string): SourceFile => {
    const code = stripComments(text);
    const styles: SourceFile["styles"] = [];
    if (rel.endsWith(".css")) styles.push({ text: code, line: 0 });
    for (const m of code.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      const start = m.index! + m[0].indexOf(">") + 1;
      styles.push({ text: m[1], line: code.slice(0, start).split("\n").length - 1 });
    }
    return { rel, raw: text.split("\n"), code: code.split("\n"), styles };
  };
  const rule = (id: string) => RULES.find((r) => r.id === id)!;
  const lines = (id: string, f: SourceFile) => scan(rule(id), [f]).hits.map((h) => h.line);

  const svelte = mk("components/X.svelte", [
    "<script>",
    "  const url = '#dimensio-token=' + t; // 不是颜色",
    "</script>",
    '<div style="color: #fff">x</div>',
    "<style>",
    "  /* 注释里的 #fff 与 :root 不算 */",
    "  .a {",
    "    --mine: #123456;",
    "    color: var(--mine);",
    "  }",
    "  .b { background: rgba(0, 0, 0, 0.3); --tint: #0f0; }",
    "  .c:hover { color: var(--text); }",
    "  @media (hover: hover) {",
    "    .d:hover { color: var(--text); }",
    "  }",
    "  .e { color: #abc; } /* guard: bare-color ok — 品牌色，两套主题同色 */",
    "  :root { --x: 1; }",
    "</style>",
  ].join("\n"));
  assert.deepEqual(lines("bare-color", svelte), [4, 11], "内联 #fff、rgba 字面量、规则里顺手定义的局部色都算；单独一行的令牌定义、注释、带理由的豁免不算");
  assert.deepEqual(lines("unguarded-hover", svelte), [12], "没包在 @media (hover: hover) 里的才算");
  assert.deepEqual(lines("bare-root", svelte), [17]);

  const api = mk("lib/x.ts", [
    "fetch(u, { headers: { \"content-type\": \"application/json\", ...auth() } });",
    "fetch(u, {",
    "  headers: {",
    "    Authorization: `Bearer ${t}`,",
    "    \"X-Client-Id\": id,",
    "  },",
    "});",
    "xhr.setRequestHeader(\"x-a\", \"1\");",
    "window.open(u);",
  ].join("\n"));
  assert.deepEqual(lines("request-header", api), [5, 8]);
  assert.deepEqual(lines("window-open", api), [9]);

  const lazy = mk("lib/y.ts", "window.open(u); // guard: window-open ok");
  assert.equal(scan(rule("window-open"), [lazy]).badExemptions.length, 1, "豁免没写理由本身判红");
});
