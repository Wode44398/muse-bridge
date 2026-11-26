<script>
  // 一轮的回答正文。在跑时只画宿主已经放出来的那截（turn.answer.slice(0, turn.shown)，按帧放字在 store/run），
  // 新字 260ms 从淡到实（lib/codex/thread/streamFade.js），旧字不随 markdown 重渲染再闪。
  // 末尾那颗小球（.md.streaming 的 ::after）领着字走；开始回答的那一刻，工作记录顶上那颗沿弧线飞过来交接。
  // 只有末块随每批字重渲染（streamBlocks 把前面稳定的块切出去），长回答不会每帧整段重排。
  import { untrack } from 'svelte';
  import { renderMarkdown, renderStreamingMarkdown, streamBlocks } from '../../lib/md.js';
  import { streamFade } from '../../lib/codex/thread/streamFade.js';
  import { handoff } from '../../lib/codex/thread/fx.js';
  import { codexMdClick } from '../../lib/codex/thread/links.js';

  let { turn, sid = '', ball = null } = $props();

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  const text = $derived(turn.live && turn.shown >= 0 ? turn.answer.slice(0, turn.shown) : turn.answer);
  // 计划模式只出计划时，收尾的 result 就是计划正文：计划卡已经画了，这里不再重复一遍
  const dup = $derived(!!turn.planText && norm(turn.answer) === norm(turn.planText));
  const memo = {};
  const blocks = $derived(turn.live ? streamBlocks(memo, text) : null);

  // 等字：在跑但这一会儿没有新字（Codex 又去跑工具、或网络一阵一阵）时，末尾那颗呼吸
  let idle = $state(false);
  $effect(() => {
    text.length;
    if (!turn.live) return;
    idle = false;
    const id = setTimeout(() => { idle = true; }, 450);
    return () => clearTimeout(id);
  });

  // 交接只在你眼前从「没有字」到「有字」那一下发生（切回一条正在回答的线程时不重播）
  const startedEmpty = untrack(() => !text);
  let hand = $state(false);
  function arrive(node) {
    if (!startedEmpty || !untrack(() => turn.live) || document.visibilityState !== 'visible') return;
    hand = true;
    handoff(ball, node, () => { hand = false; });
  }
</script>

{#if text && !dup}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="md answer" class:streaming={turn.live} class:wait={turn.live && (idle || turn.status !== 'write')} class:hand use:arrive use:streamFade={{ live: turn.live }} onclick={(e) => codexMdClick(e, sid)}>
    {#if blocks}{#each blocks as b, i (i)}{@html i === blocks.length - 1 ? renderStreamingMarkdown(b) : renderMarkdown(b)}{/each}{:else}{@html renderMarkdown(text)}{/if}
  </div>
{/if}

<style>
  .answer { margin-top: 2px; }
  .answer :global(a) { color: var(--link); text-decoration: none; }
  .answer :global(a:hover) { text-decoration: underline; text-underline-offset: 3px; }
  .answer :global(pre) { margin: 0 0 12px; padding: 10px 12px; border-radius: 12px; background: var(--term); border: 1px solid var(--line1); overflow-x: auto; font: 12.5px/1.6 var(--mono); }
  .answer :global(pre code) { padding: 0; background: none; font-size: inherit; }
  .answer :global(h1), .answer :global(h2), .answer :global(h3) { margin: 20px 0 8px; font-weight: 600; line-height: 1.35; }
  .answer :global(h1) { font-size: 19px; } .answer :global(h2) { font-size: 17px; } .answer :global(h3) { font-size: 15.5px; }
  .answer :global(blockquote) { margin: 0 0 12px; padding-left: 12px; border-left: 2px solid var(--line3); color: var(--fg2); }
  .answer :global(hr) { border: 0; height: 1px; background: var(--line2); margin: 16px 0; }
  .answer :global(table) { border-collapse: collapse; font-size: 13.5px; }
  .answer :global(th), .answer :global(td) { padding: 5px 10px; border-bottom: 1px solid var(--line2); text-align: left; }
  .answer :global(th) { font-weight: 500; color: var(--fg2); }
  .answer :global(img) { max-width: 100%; border-radius: 10px; }
</style>
