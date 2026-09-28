<script lang="ts">
  // U7（Codex X37）：流式正文两段式渲染——稳定块渲染一次就不再变（按起点缓存），只有尾块随每批吐字重渲染；
  // 流结束后整段按最终版渲染一次（稳定块 + 尾块拼起来与它一字不差，只是尾块里的代码这时才上色）。
  //
  // 渐入挂在 .md 这一层（不是只挂尾块）：按「全文第几个字」记账，稳定块切出去的那一刻、换成最终版渲染的那一刻，
  // 还在淡入的字照样续完——只挂尾块的话，每到一个段落切点，正在淡入的字和新段落开头都会「啪」地一下变实。
  // .md 必须是内容的直接父级：app.css 的 `.md > .md-h:first-child` 这类规则按层级认。
  import { renderMarkdown, renderTail, streamParts } from "../../lib/markdown.ts";
  import { streamFade } from "../../lib/fade.ts";

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

<div class="md" use:streamFade={{ live }}>
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
