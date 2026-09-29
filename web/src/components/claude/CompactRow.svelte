<script>
  // 官方 /code 页的上下文压缩条目（桌面端 ion bundle：独立成行 Z$、并进循环分组 Q$，
  // 文案 c2fb08a02 的 M/N：「Compacting…」→「Compacted session · saved {n} tokens」/「Compaction failed」，
  // 由 toolVerbs.compactLabel 出）。Claude 干活途中压缩时它和工具行同组（官方 rolls-up），
  // 否则 ToolGroup 让它单独一行。
  //
  // bridge 加一层：行可点开，详情里放压缩之后注入给模型的那段摘要（CLI 的「This session is being
  // continued…」原文）——以前它被当成用户气泡、还把压缩前的对话全挡掉了；现在压缩前后的轮都在，
  // 摘要收在这里按需看。长文只在首次展开时才渲染 markdown，收起只切 hidden。
  import { compactLabel, fmtCompact, morphText } from '../../lib/toolVerbs.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import { tr } from '../../lib/i18n.js';

  let { tool, inGroup = false, live = false } = $props();

  const c = $derived(tool.compact || {});
  const running = $derived(!!live && tool.status === 'running');
  const failed = $derived(tool.status === 'error');
  const label = $derived(compactLabel(!live && tool.status === 'running' ? { ...tool, status: 'done' } : tool));
  const summary = $derived(String(c.summary || '').trim());
  const error = $derived(failed ? String(c.error || '').trim() : '');
  // 详情头一行：触发方式 + 压缩前后的上下文体量（官方行上只报省了多少，这里把两头都给出来）
  const meta = $derived.by(() => {
    const pre = Number(c.preTokens) || 0, post = Number(c.postTokens) || 0;
    const how = c.trigger === 'manual' ? 'Manual /compact' : 'Auto-compacted';
    return pre > 0 && post > 0 ? `${how} · ${fmtCompact(pre)} → ${fmtCompact(post)} tokens` : how;
  });
  const expandable = $derived(!!summary || !!error);

  let open = $state(false);
  let mounted = $state(false);   // 首次展开后保持挂载（官方 Ny）
  function toggle() { if (!expandable) return; open = !open; if (open) mounted = true; }
  function onKey(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }
</script>

<div class="wrap" class:ingroup={inGroup}>
  <div class="row" class:expandable role="button" tabindex="0" aria-expanded={expandable ? open : undefined} onclick={toggle} onkeydown={onKey}>
    <span class="lbl trunc" class:cl-shine={running} class:danger={failed} use:morphText={label}>{label}</span>
    {#if running}<span class="sr-only">running</span>{/if}
    {#if expandable}<span class="ic caret" aria-hidden="true">{glyph(open ? 'CaretDown' : 'CaretRight')}</span>{/if}
  </div>
  {#if mounted}
    <div class="body" class:card={!inGroup} hidden={!open}>
      {#if summary}
        <div class="meta">{meta}</div>
        <div class="sum sel-text">{@html renderMarkdown(summary)}</div>
      {:else if error}
        <div class="err sel-text">{tr(error)}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* 行形态与 ToolRow 同源（官方 OF 形态 B）：secondary 字色、hover 转 primary；流光 .cl-shine 在 ToolGroup 全局注入 */
  .wrap { display: flex; flex-direction: column; width: 100%; min-width: 0; margin: 4px 0; }
  .wrap.ingroup { margin: 0; }
  .row {
    position: relative; display: flex; align-self: flex-start; max-width: 100%; min-width: 0; align-items: center; gap: 3px;
    padding: 0; text-align: left; border-radius: 4px; outline: none; color: var(--serif); font-size: 14px; line-height: 20px;
    -webkit-tap-highlight-color: transparent; transition: color var(--mo-micro, 140ms);
  }
  .row.expandable { cursor: pointer; }
  .row:focus-visible { box-shadow: 0 0 0 1px var(--serif); }
  @media (hover: hover) { .row.expandable:hover { color: var(--text); } }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .danger { color: var(--crit); }
  .caret {
    flex: none; width: 1em; height: 1em; font-size: 14px; font-weight: 570;
    display: flex; align-items: center; justify-content: center; font-feature-settings: "liga" 0;
  }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

  /* 展开体：分组卡里只加 4px 上距；单独一行时自带描边小卡（同 ToolRow） */
  .body[hidden] { display: none; }
  .body.card { margin-top: 6px; padding: 8px 10px; border-radius: 8px; box-shadow: 0 0 0 1px var(--divider); overflow: hidden; }
  .body:not(.card) { padding-top: 4px; }
  .meta { font-size: 12.5px; line-height: 17px; color: var(--serif); opacity: .75; margin-bottom: 6px; }
  .err { font-size: 13px; line-height: 18px; color: var(--crit); white-space: pre-wrap; overflow-wrap: anywhere; }
  /* 摘要正文：动辄上万字，封顶高度在自己身上滚（别把整条时间线撑长）；小一号的 md 排版 */
  .sum {
    max-height: min(420px, 55vh); overflow-y: auto; overscroll-behavior: contain;
    padding: 8px 10px; border-radius: 6px; background: var(--hover);
    font-size: 13px; line-height: 1.6; color: var(--text); min-width: 0; overflow-wrap: break-word;
  }
  .sum :global(p) { margin: 0 0 8px; }
  .sum :global(p:last-child) { margin-bottom: 0; }
  .sum :global(h1), .sum :global(h2), .sum :global(h3), .sum :global(h4) { font-size: 13.5px; margin: 12px 0 6px; line-height: 1.35; }
  .sum :global(ul), .sum :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .sum :global(li) { margin: 2px 0; }
  .sum :global(pre) { background: var(--userbubble); border: 1px solid var(--divider); border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 0 0 8px; }
  .sum :global(code) { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: .92em; }
  .sum :global(:not(pre) > code) { background: var(--divider); padding: 1px 4px; border-radius: 4px; }
  .sum :global(a) { color: var(--coral); }
  .sum :global(table) { border-collapse: collapse; font-size: 12.5px; }
  .sum :global(th), .sum :global(td) { border: 1px solid var(--divider); padding: 4px 8px; }
</style>
