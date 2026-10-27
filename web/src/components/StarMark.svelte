<script>
  // 公开版的 Claude 运行标记：自绘的十二道光芒星标 + CSS 关键帧（不含任何官方动画素材）。
  // ClaudeLogo / ClaudeWorkingMark / ClaudeSpriteMark 在没有私有 overlay（原版动画帧）时都落到这里，
  // 设置里「运行标记」三选一的结构照旧，三种只是各自映射到下面几种动作：
  //   think  转着圈呼吸（思考、等首字）        work  光芒错落伸缩（写正文、干活）
  //   tool   一格一格地转（调工具：读 / 搜 / 跑命令） wait  整体轻轻明灭（等待、闪光）
  //   blocked 光芒收短、隔几秒轻抖一下（等你操作）  enter / exit 长出 / 收起    tickle 点一下扭一扭
  //   static 静止
  // 系统「减少动态效果」时一律静止。颜色跟 color（缺省陶土色），尺寸 = size，放在 box 见方的框里居中。
  let { mode = 'static', size = 20, box = size, color = 'var(--coral, #d97757)', paused = false, interactive = false, label = 'Claude' } = $props();

  const RAYS = Array.from({ length: 12 }, (_, i) => ({ a: i * 30, long: i % 2 === 0 }));
  let tickling = $state(false);
  const shown = $derived(tickling ? 'tickle' : mode);

  function tickle() {
    if (!interactive || tickling || (mode !== 'static' && mode !== 'enter')) return;
    tickling = true;
    setTimeout(() => { tickling = false; }, 620);
  }
</script>

{#snippet star()}
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
    <g class="spin">
      <g class="body">
        {#each RAYS as r, i (i)}
          <g transform="rotate({r.a} 12 12)"><line class="ray" style:--i={i} x1="12" y1="9.4" x2="12" y2={r.long ? 1.6 : 4.2} /></g>
        {/each}
        <circle cx="12" cy="12" r="2.6" />
      </g>
    </g>
  </svg>
{/snippet}

{#if interactive}
  <button type="button" class="sm" data-m={shown} class:paused style="width:{box}px;height:{box}px;color:{color}" onclick={tickle} aria-label={label}>
    {@render star()}
  </button>
{:else}
  <span class="sm" data-m={shown} class:paused style="width:{box}px;height:{box}px;color:{color}" aria-hidden="true">
    {@render star()}
  </span>
{/if}

<style>
  .sm { display: inline-flex; align-items: center; justify-content: center; flex: none; line-height: 0; padding: 0; border: none; background: none; color: inherit; user-select: none; }
  button.sm { cursor: pointer; }
  svg { display: block; overflow: visible; }
  .ray { stroke: currentColor; stroke-width: 2.3; stroke-linecap: round; transform-box: view-box; transform-origin: 12px 12px; }
  circle { fill: currentColor; }
  .spin, .body { transform-box: view-box; transform-origin: 12px 12px; }

  .sm[data-m="think"] .spin { animation: sm-rot 9s linear infinite; }
  .sm[data-m="think"] .ray { animation: sm-ray 2.4s ease-in-out infinite; animation-delay: calc(var(--i) * -.2s); }
  .sm[data-m="work"] .ray { animation: sm-ray 1.1s ease-in-out infinite; animation-delay: calc(var(--i) * -.092s); }
  .sm[data-m="tool"] .spin { animation: sm-rot 2.4s steps(12, end) infinite; }
  .sm[data-m="tool"] .body { animation: sm-breathe 1.2s ease-in-out infinite; }
  .sm[data-m="wait"] .body { animation: sm-glow 2.2s ease-in-out infinite; }
  .sm[data-m="blocked"] .ray { transform: scale(.62); }
  .sm[data-m="blocked"] .body { animation: sm-shake 6s ease-out 2s infinite; }
  .sm[data-m="enter"] .body { animation: sm-in .42s cubic-bezier(.34, 1.4, .5, 1) both; }
  .sm[data-m="exit"] .body { animation: sm-out .3s ease-in both; }
  .sm[data-m="tickle"] .body { animation: sm-tickle .6s ease-in-out; }
  .sm.paused :global(*) { animation-play-state: paused !important; }

  @keyframes sm-rot { to { transform: rotate(360deg); } }
  @keyframes sm-ray { 0%, 100% { transform: scale(1); } 50% { transform: scale(.55); } }
  @keyframes sm-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(.86); } }
  @keyframes sm-glow { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .55; transform: scale(.9); } }
  @keyframes sm-shake { 0%, 5.4% { transform: none; } 1.3% { transform: translateX(-1px); } 2.7% { transform: translateX(1px); } 4% { transform: translateX(-.5px); } }
  @keyframes sm-in { from { transform: scale(0) rotate(-60deg); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes sm-out { to { transform: scale(0) rotate(45deg); opacity: 0; } }
  @keyframes sm-tickle { 0%, 100% { transform: none; } 25% { transform: rotate(-18deg) scale(1.08); } 60% { transform: rotate(12deg) scale(.96); } }

  @media (prefers-reduced-motion: reduce) {
    .sm :global(*) { animation: none !important; }
  }
</style>
