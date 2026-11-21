<script>
  // 对话滚动区：贴底时自动跟随新内容，用户上翻阅读时绝不抢滚；
  // 上下边缘带轻量渐隐羽化，避免滚动时文字与顶栏/输入框生硬切边。
  import { onMount, tick, untrack } from 'svelte';
  import { agy, retryAgyFrom } from '../../lib/agy/store.svelte.js';
  import { t } from '../../lib/i18n.js';
  import Message from './Message.svelte';
  import AgyStateBanner from './AgyStateBanner.svelte';

  const INITIAL_MSG_WINDOW = 40;
  let scroller = $state(null);
  let inner = $state(null);
  let atTop = $state(true);
  let atBottom = $state(true);
  let visibleLimit = $state(INITIAL_MSG_WINDOW);
  let lastSessionKey = '';
  let lastCount = 0;

  const hiddenEarlierCount = $derived(Math.max(0, agy.messages.length - visibleLimit));
  const visibleMessages = $derived(
    hiddenEarlierCount > 0 ? agy.messages.slice(hiddenEarlierCount) : agy.messages
  );

  function showEarlierMessages() {
    const prevHeight = scroller?.scrollHeight || 0;
    visibleLimit += 40;
    tick().then(() => {
      if (scroller && prevHeight > 0) {
        scroller.scrollTop += Math.max(0, scroller.scrollHeight - prevHeight);
      }
    });
  }

  function syncScrollFlags() {
    if (!scroller) {
      atTop = true;
      atBottom = true;
      return;
    }
    atTop = scroller.scrollTop <= 8;
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 72;
  }

  // —— 流式增长时平滑跟底（11-19，照 Claude 分页 ClaudePage 的 stepFollow）——
  // 正文逐字凝现，视口却每长一行「咔」地跳一行很出戏：内容在长（不是新消息）时每帧把视口往底部缓动
  // （τ≈90ms，一行高约 0.2s 滑到位；落差 >1600px 或减弱动态效果直接到底）。用户一往上滚立刻放手；
  // 手指按着时不跟；跟底途中自己造成的滚动不重算 atBottom；写了没进展（已经到能到的最底）就停。
  let followRaf = 0, followT = 0, lastTop = 0, touching = false;
  // 只有「内容自己在长」才跟底：流式输出中，或刚切会话 / 刚来新消息的 1.5s 内（图片、公式补量）。
  // 跑完之后用户自己点开步骤明细、思考全文时视口不动——否则刚点开的那一组会被往上推出屏幕。
  let followUntil = 0;
  const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stopFollow() { if (followRaf) { cancelAnimationFrame(followRaf); followRaf = 0; } }
  function followBottom() {
    if (followRaf || !scroller || touching) return;
    followT = performance.now();
    lastTop = scroller.scrollTop;
    followRaf = requestAnimationFrame(stepFollow);
  }
  function stepFollow(now) {
    followRaf = 0;
    const el = scroller;
    if (!el || !atBottom || touching || !el.clientHeight) return;
    const top = el.scrollTop;
    const gap = el.scrollHeight - el.clientHeight - top;
    if (top < lastTop - 2 && gap > 2) { atBottom = false; lastTop = top; return; }
    if (gap <= 1) return;
    const dt = Math.min(64, Math.max(1, now - followT));
    followT = now;
    let d = gap > 1600 || calm() ? gap : gap * (1 - Math.exp(-dt / 90));
    if (d < 1) d = Math.min(gap, 1);
    el.scrollTop = top + d;
    lastTop = el.scrollTop;
    atTop = lastTop <= 8;
    if (lastTop <= top + 0.1) return;
    followRaf = requestAnimationFrame(stepFollow);
  }
  function onTouchStart() { touching = true; stopFollow(); }
  function onTouchEnd() {
    touching = false;
    if (scroller) lastTop = scroller.scrollTop;
    if (atBottom) followBottom();
  }

  function onScroll() {
    if (!scroller) return;
    const top = scroller.scrollTop;
    const gap = scroller.scrollHeight - scroller.clientHeight - top;
    atTop = top <= 8;
    if (top < lastTop - 2 && gap > 2) {          // 用户往上滚：立刻放手
      atBottom = gap <= 72;
      stopFollow();
    } else if (touching || !followRaf) atBottom = gap <= 72;
    lastTop = top;
  }

  export function scrollToBottom(smooth = false) {
    if (!scroller) return;
    stopFollow();
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });
    atBottom = true;
    atTop = scroller.scrollTop <= 8;
    lastTop = scroller.scrollTop;
  }

  // 视图代号：只在真的换了一段对话时才整段重建（{#key}）。新对话发出第一条消息后服务端回来的 session
  // 事件会把 sessionId 从空变成新 id——那还是同一段对话，旧写法按 sessionId 做 key，这一下把刚发出的
  // 气泡、logo 接力、正在长的思考行整段销毁重建、淡入闪一次（11-19 修）。
  let stageKey = $state(0);
  let keySid = untrack(() => agy.sessionId || '');
  $effect.pre(() => {
    const sid = agy.sessionId || '';
    untrack(() => {
      if (sid === keySid) return;
      const born = !keySid && sid && agy.messages.length > 0;
      keySid = sid;
      if (!born) stageKey++;
    });
  });

  $effect(() => {
    const sid = agy.sessionId || '__new__';
    const len = agy.messages.length;
    const lastRole = len > 0 ? agy.messages[len - 1]?.role : '';
    const switched = sid !== lastSessionKey;
    const addedMsg = len > lastCount;
    lastSessionKey = sid;
    lastCount = len;
    if (switched) {
      untrack(() => { visibleLimit = INITIAL_MSG_WINDOW; });
    }

    const wasAtBottom = untrack(() => atBottom);
    if (switched || addedMsg) followUntil = performance.now() + 1500;
    if (switched || (addedMsg && (lastRole === 'user' || wasAtBottom))) {
      tick().then(() => scrollToBottom(false));
    }
  });

  onMount(() => {
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottom && scroller && (agy.busy || performance.now() < followUntil)) followBottom();
      else syncScrollFlags();
    });
    ro.observe(inner);
    return () => { ro.disconnect(); stopFollow(); };
  });
</script>

<div class="agy-thread-wrap" class:fade-top={!atTop} class:fade-bot={!atBottom}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="agy-thread"
    bind:this={scroller}
    onscroll={onScroll}
    ontouchstart={onTouchStart}
    ontouchend={onTouchEnd}
    ontouchcancel={onTouchEnd}
  >
    <div class="agy-thread-inner" bind:this={inner}>
      {#if agy.loadingSession && agy.messages.length === 0}
        <div class="agy-skel-stack" aria-label={t('正在加载历史对话…')}>
          <div class="agy-skel-bubble"></div>
          <div class="agy-skel-line w80"></div>
          <div class="agy-skel-line w62"></div>
          <div class="agy-skel-card"></div>
        </div>
      {:else}
        <AgyStateBanner compact />

        {#if agy.reconnecting}
          <div class="agy-reconn-bar">
            <span class="agy-load-spin small"></span>
            <span>{t('连接已断开，正在重连恢复当前进度…')}</span>
          </div>
        {/if}

        {#key stageKey}
          <div class="agy-session-stage">
            {#if hiddenEarlierCount > 0}
              <button type="button" class="agy-load-earlier" onclick={showEarlierMessages}>
                <span class="msr">expand_less</span>
                <span>{t('显示更早的 {n} 条消息', { n: hiddenEarlierCount })}</span>
              </button>
            {/if}

            {#each visibleMessages as msg, vIdx (msg.id || (hiddenEarlierCount + vIdx))}
              {@const realIdx = hiddenEarlierCount + vIdx}
              <Message
                {msg}
                sessionId={agy.sessionId || ''}
                sessionCwd={agy.cwd || ''}
                isLast={realIdx === agy.messages.length - 1}
                reconnecting={agy.reconnecting}
                onRetry={() => retryAgyFrom(realIdx)}
              />
            {/each}
          </div>
        {/key}
      {/if}
    </div>
  </div>

  {#if !atBottom && agy.messages.length > 0}
    <button
      type="button"
      class="agy-to-bottom"
      onclick={() => scrollToBottom(true)}
      aria-label={t('回到底部')}
      title={t('回到底部')}
    >
      <span class="msr4">arrow_downward</span>
    </button>
  {/if}
</div>

<style>
  .agy-thread-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .agy-thread-wrap::before,
  .agy-thread-wrap::after {
    content: '';
    position: absolute;
    left: 0;
    right: 14px;
    height: 22px;
    pointer-events: none;
    opacity: 0;
    z-index: 2;
    transition: opacity var(--ag-dur-quick) var(--ag-ease-fade);
  }
  .agy-thread-wrap::before {
    top: 0;
    background: linear-gradient(180deg, var(--ag-bg) 0%, transparent 100%);
  }
  .agy-thread-wrap::after {
    bottom: 0;
    background: linear-gradient(0deg, var(--ag-bg) 0%, transparent 100%);
  }
  .agy-thread-wrap.fade-top::before { opacity: 1; }
  .agy-thread-wrap.fade-bot::after { opacity: 1; }

  .agy-thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior-y: contain;
    /* 预留滚动条槽位：内容第一次超出一屏、滚动条冒出来时整列不再向左跳 6px */
    scrollbar-gutter: stable;
    padding: 16px 16px 24px;
  }
  .agy-thread-inner {
    width: 100%;
    max-width: var(--ag-col);
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  }
  .agy-session-stage {
    display: flex;
    flex-direction: column;
    animation: agy-session-fade var(--ag-dur-quick, 200ms) var(--ag-ease-fade, cubic-bezier(0.4, 0, 0.6, 1)) both;
  }
  @keyframes agy-session-fade {
    from { opacity: 0; }
  }
  .agy-load-earlier {
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 2px 0 14px;
    padding: 5px 13px;
    border-radius: 999px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    color: var(--ag-on-sub);
    font-size: 12px;
    transition: background var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease),
      color var(--ag-dur-micro, 140ms) var(--ag-ease-fade, ease);
  }
  .agy-load-earlier:hover {
    background: var(--ag-hover);
    color: var(--ag-on);
  }
  .agy-load-earlier .msr { font-size: 16px; }
  .agy-skel-stack {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px 0;
  }
  .agy-skel-bubble {
    align-self: flex-end;
    width: min(58%, 320px);
    height: 42px;
    border-radius: 16px 16px 5px 16px;
    background: var(--ag-surface-2);
    animation: agy-shimmer 1.3s var(--ag-ease-fade, ease-in-out) infinite alternate;
  }
  .agy-skel-line,
  .agy-skel-card {
    border-radius: 9px;
    background: var(--ag-surface-1);
    animation: agy-shimmer 1.3s var(--ag-ease-fade, ease-in-out) infinite alternate;
  }
  .agy-skel-line { height: 15px; }
  .agy-skel-line.w80 { width: 80%; }
  .agy-skel-line.w62 { width: 62%; }
  .agy-skel-card { width: 100%; height: 40px; border-radius: 11px; margin-top: 4px; }
  @keyframes agy-shimmer {
    from { opacity: 0.48; }
    to { opacity: 0.92; }
  }
  .agy-reconn-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding: 7px 12px;
    border-radius: 10px;
    background: var(--ag-warn-bg);
    color: var(--ag-warn);
    font-size: 12.5px;
  }
  .agy-load-spin {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--ag-border-strong);
    border-top-color: var(--ag-accent);
    animation: agy-thread-spin 0.8s linear infinite;
    flex: none;
  }
  .agy-load-spin.small {
    width: 13px;
    height: 13px;
    border-top-color: var(--ag-warn);
  }
  @keyframes agy-thread-spin { to { transform: rotate(360deg); } }

  .agy-to-bottom {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    bottom: 10px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--ag-pop-bg);
    color: var(--ag-on);
    box-shadow: var(--ag-elev-shadow);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    z-index: 5;
    animation: agy-fab-in var(--ag-dur-micro) var(--ag-ease-decel) both;
  }
  .agy-to-bottom:hover {
    color: var(--ag-accent);
  }
  .agy-to-bottom .msr4 { font-size: 18px; }
  @keyframes agy-fab-in {
    from { opacity: 0; transform: translate(-50%, 6px) scale(0.92); }
  }
</style>
