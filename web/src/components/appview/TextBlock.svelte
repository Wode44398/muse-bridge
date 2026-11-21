<script>
  // text 积木：{ text, tone?: muted|ok|warn|error, size?: sm|md|lg }。纯文本（不解析 markdown），保留换行；
  // 左右与卡片里的文字对齐（缩进 --av-px），像设置页组外的说明文字。lg 当小标题用。
  // 字号类名带 sz- 前缀：全局 .lg 是液态玻璃（app.css，淡底 + 边光 + 高光），撞名会在字后面铺一块玻璃板。
  let { block } = $props();
  const size = $derived(['sm', 'lg'].includes(block.size) ? block.size : 'md');
  const tone = $derived(['muted', 'ok', 'warn', 'error'].includes(block.tone) ? block.tone : '');
</script>

<p class="tx sz-{size} {tone ? 'av-tone-' + tone : ''}">{block.text}</p>

<style>
  .tx {
    padding: 0 var(--av-px); white-space: pre-wrap; overflow-wrap: anywhere;
    font-size: var(--av-fs); line-height: var(--av-lh); color: var(--av-ink);
  }
  .tx.sz-sm { font-size: var(--av-fs-sm); line-height: var(--av-lh-sm); color: var(--av-ink2); }
  .tx.sz-lg { font-size: var(--av-fs-lg); line-height: var(--av-lh-lg); font-weight: 650; letter-spacing: -.2px; }
  /* tone 盖过 size 的默认字色（sm 默认灰，标了 ok / warn 就用语义色） */
  .tx.av-tone-muted { color: var(--av-ink2); }
  .tx.av-tone-ok { color: var(--av-ok); }
  .tx.av-tone-warn { color: var(--av-warn); }
  .tx.av-tone-error { color: var(--av-err); }
</style>
