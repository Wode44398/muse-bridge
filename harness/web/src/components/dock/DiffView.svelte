<script lang="ts">
  // 单文件 unified diff：等宽，增 / 删行淡色底，左侧两列行号（旧 / 新，--text3，横向滚动时钉在左边）。
  // 行分类同旧版（@@ = 段头、文件头 / 元信息 = 淡字、+ 增、- 删、其余上下文），但进了 @@ 段之后只认段内语法——
  // 以前一行内容恰好以「--」开头的删除行会被当成「---」文件头，行号也跟着错一位。
  // 行类用 class: 指令逐个写（模板插值拼的类配 scoped 规则会被剪掉）。
  // 文件头（diff --git / index / --- / +++ / new file mode）在有段的时候不显示——文件名和增删状态上面那一行已经写了；
  // 只有元信息（二进制、纯改名 / 改权限）时照旧显示，免得展开是空的。段内 +/- 号单独一列、不进选区，复制出来是干净的代码。
  import { t } from "../../lib/i18n.ts";

  let { text, truncated = false }: { text: string; truncated?: boolean } = $props();

  type Kind = "" | "h" | "a" | "d" | "m";
  interface Ln {
    k: Kind;
    s: string;
    l: string;
    a: number | null;
    b: number | null;
  }

  const META = ["+++", "---", "diff ", "index ", "new file", "deleted file", "rename ", "similarity ", "Binary files", "\\"];
  const NOISE = ["diff --git", "index ", "--- ", "+++ ", "new file mode", "deleted file mode"];

  function parse(src: string): { lines: Ln[]; digits: number } {
    const out: Ln[] = [];
    // 只削掉结尾的换行：段内空行是「一个空格」的上下文行，去掉前缀后是空串，不能再按空串从尾部削
    const all = String(src || "").replace(/\n+$/, "");
    const hasHunk = /^@@ /m.test(all);
    let a = 0;
    let b = 0;
    let hunk = false;
    let max = 0;
    for (const l of all.split("\n")) {
      if (l.startsWith("@@")) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
        if (m) {
          a = Number(m[1]);
          b = Number(m[2]);
          hunk = true;
        }
        out.push({ k: "h", s: "", l, a: null, b: null });
      } else if (hunk && l.startsWith("diff ")) {
        hunk = false;
        out.push({ k: "m", s: "", l, a: null, b: null });
      } else if (hunk ? l.startsWith("\\") : META.some((p) => l.startsWith(p))) {
        if (!hunk && hasHunk && NOISE.some((p) => l.startsWith(p))) continue;
        out.push({ k: "m", s: "", l, a: null, b: null });
      } else if (!hunk) {
        out.push({ k: "", s: "", l, a: null, b: null });
      } else if (l.startsWith("+")) {
        out.push({ k: "a", s: "+", l: l.slice(1), a: null, b: b++ });
      } else if (l.startsWith("-")) {
        out.push({ k: "d", s: "-", l: l.slice(1), a: a++, b: null });
      } else {
        out.push({ k: "", s: "", l: l.slice(1), a: a++, b: b++ });
      }
    }
    for (const x of out) max = Math.max(max, x.a ?? 0, x.b ?? 0);
    return { lines: out, digits: Math.max(2, String(max).length) };
  }

  const parsed = $derived(parse(text));
</script>

<div class="dv" style="--gw:{parsed.digits}ch">
  {#each parsed.lines as ln, i (i)}
    <div class="dl" class:h={ln.k === "h"} class:a={ln.k === "a"} class:d={ln.k === "d"} class:m={ln.k === "m"}>
      <span class="gut" aria-hidden="true"><span class="n">{ln.a ?? ""}</span><span class="n">{ln.b ?? ""}</span></span>
      <span class="sg" aria-hidden="true">{ln.s}</span>
      <span class="tx">{ln.l || " "}</span>
    </div>
  {/each}
  {#if truncated}
    <div class="dl m">
      <span class="gut" aria-hidden="true"><span class="n"></span><span class="n"></span></span>
      <span class="sg" aria-hidden="true"></span>
      <span class="tx">{t("…（diff 过长，已截断）")}</span>
    </div>
  {/if}
</div>

<style>
  .dv {
    overflow-x: auto;
    padding: 6px 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    font-variant-ligatures: none;
    user-select: text;
  }
  .dl {
    --tint: transparent;
    display: flex;
    min-width: max-content;
    background: var(--tint);
    color: var(--text2);
  }
  .dl.a {
    --tint: color-mix(in srgb, var(--ok) 12%, transparent);
    color: var(--text);
  }
  .dl.d {
    --tint: color-mix(in srgb, var(--err) 11%, transparent);
    color: var(--text);
  }
  .dl.h {
    --tint: var(--accent-soft);
    color: var(--accent);
  }
  .dl.m {
    color: var(--text3);
  }
  .gut {
    position: sticky;
    left: 0;
    flex: none;
    display: flex;
    gap: 8px;
    padding: 0 8px 0 10px;
    background:
      linear-gradient(var(--tint), var(--tint)),
      var(--code-bg);
    color: var(--text3);
    user-select: none;
  }
  .n {
    width: var(--gw);
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.85;
  }
  .sg {
    flex: none;
    width: 1ch;
    margin: 0 6px 0 2px;
    text-align: center;
    user-select: none;
  }
  .dl.a .sg {
    color: var(--ok);
  }
  .dl.d .sg {
    color: var(--err);
  }
  .tx {
    padding: 0 14px 0 0;
    white-space: pre;
  }
</style>
