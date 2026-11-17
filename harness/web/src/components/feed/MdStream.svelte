<script lang="ts">
  // U7（Codex X37）：流式正文两段式渲染——稳定块渲染一次就不再变（按起点缓存），只有尾块随每批吐字重渲染（先过写头修补，
  // 见 lib/markdown.ts 的 renderTail）；流结束后整段按最终版渲染一次（稳定块 + 尾块拼起来与它可见文字一致，只是尾块里的代码
  // 这时才上色、扣住的写头这时才放出来）。
  //
  // 吐字：与 bridge Claude 分页同一个引擎（仓库根 web/src/lib/claudeFade.js，「先排版后显形」）——到达的字立刻排进 DOM、
  // 没轮到的隐形占位（app.css 的 .c-wait），按重建的生成时间线逐字 0.4s 淡入；盒子（列表项、单元格、引用、代码卡、行内代码、
  // 分隔线）随它包住的第一个字一起淡入。挂在 .md 这一层：按「全文第几个可见字」记账，稳定块切出去、换成最终版渲染的那一刻，
  // 还在淡入的字照样续完。代码卡外壳 .cb 当盒子，标题栏 .cb-bar（语言标、复制钮）是界面零件、不逐字显形，随外壳出现。
  // .md 必须是内容的直接父级：app.css 的 `.md > .md-h:first-child` 这类规则按层级认。
  import { renderMarkdown, renderTail, streamParts } from "../../lib/markdown.ts";
  // @ts-ignore —— 纯 JS 模块、没有类型声明
  import { claudeFade } from "../../../../../web/src/lib/claudeFade.js";

  let { text, live = false }: { text: string; live?: boolean } = $props();

  // 稳定块的渲染缓存：起点 → 源码与 html（文字只追加，同一起点的源码不会变；变了——重流 / 撤回——就重渲）
  const cache = new Map<number, { src: string; html: string }>();
  function stableHtml(start: number, src: string): string {
    const hit = cache.get(start);
    if (hit && hit.src === src) return hit.html;
    const html = renderMarkdown(src);
    cache.set(start, { src, html });
    return html;
  }

  const parts = $derived(live ? streamParts(text) : null);
</script>

<div class="md sel-text" use:claudeFade={{ live, boxes: ["cb"], chrome: ["cb-bar"] }}>
  {#if parts}
    {#each parts.chunks as ch (ch.start)}<div class="mdblk">{@html stableHtml(ch.start, ch.src)}</div>{/each}
    <div class="mdtail">{@html renderTail(parts.tail)}</div>
  {:else}
    {@html renderMarkdown(text)}
  {/if}
</div>

<style>
  .md {
    min-width: 0;
    font-size: var(--fs-body);
    color: var(--text);
  }
</style>
