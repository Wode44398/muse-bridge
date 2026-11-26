<script>
  // 对话这一栏（.cx-scroll 里面）：正在看的线程的一轮轮。宿主不用传东西，线程从 store 的 current() 读。
  //
  // 滚动（照 demo 的 nearBottom / toBottom）：你在底部附近时跟着往下走（吐字、记录长出来、输入栏变高都算）；
  // 你往上翻了就不拽你。翻到顶上自动接着读更早的轮，读进来后画面停在原处不跳。
  // 长线程：每一轮是自己的组件，只读自己那份 turn——放字时只有在跑的那一轮在动。
  import { tick, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import Turn from './Turn.svelte';
  import { t } from '../../lib/i18n.js';
  import { current, loadOlder, loadThread } from '../../lib/codex/store.svelte.js';

  let { scrollEl = $bindable(null) } = $props();

  const thread = $derived(current());
  const turns = $derived(thread.turns);
  const lastT = $derived(turns.length ? turns[turns.length - 1] : null);
  const live = $derived(!!lastT?.live);
  const hasTurns = $derived(turns.length > 0);

  let section = $state(null);
  let col = $state(null);

  const NEAR = 140;
  let follow = true;
  let autoUntil = 0;        // 自己发起的平滑滚动期间，滚动事件不算你在翻
  let settleUntil = 0;      // 刚打开线程的一小会儿（图片、图表撑高）也贴着底
  let loadingOlder = false;

  const el = () => scrollEl || section?.closest('.cx-scroll') || null;
  const nearBottom = (s) => s.scrollHeight - s.scrollTop - s.clientHeight < NEAR;

  function toBottom(smooth = false) {
    const s = el();
    if (!s) return;
    const top = s.scrollHeight - s.clientHeight;
    if (smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      autoUntil = performance.now() + 700;
      s.scrollTo({ top, behavior: 'smooth' });
    } else s.scrollTop = top;
  }

  async function older() {
    const s = el();
    const th = thread;
    if (!s || !th.id || !th.cursor || th.loading || loadingOlder) return;
    loadingOlder = true;
    const fromBottom = s.scrollHeight - s.scrollTop;
    try {
      await loadOlder(th.id);
      await tick();
      if (current() === th) s.scrollTop = s.scrollHeight - fromBottom;
    } finally { loadingOlder = false; }
  }

  // 找到滚动容器、听滚动；容器或这一栏变高时，跟着底部走
  $effect(() => {
    if (!section) return;
    const s = el();
    if (!s) return;
    if (!scrollEl) scrollEl = s;
    const onScroll = () => {
      if (performance.now() < autoUntil) return;
      follow = nearBottom(s);
      if (s.scrollTop < 240 && untrack(() => thread.cursor)) older();
    };
    // 你主动往上拨（滚轮、拖）：立刻松开跟随，不等滚动事件算距离
    const onWheel = (e) => { if (e.deltaY < 0) { follow = false; autoUntil = 0; } };
    s.addEventListener('scroll', onScroll, { passive: true });
    s.addEventListener('wheel', onWheel, { passive: true });
    const ro = new ResizeObserver(() => {
      if (!follow) return;
      if (untrack(() => live) || performance.now() < settleUntil) s.scrollTop = s.scrollHeight;
    });
    ro.observe(s);
    if (col) ro.observe(col);
    return () => {
      s.removeEventListener('scroll', onScroll);
      s.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  });

  // 换线程 / 线程读进来：直接到底，贴住一会儿；内容不满一屏又还有更早的，就先接着读
  $effect(() => {
    thread.id;
    if (!hasTurns) return;
    untrack(async () => {
      follow = true;
      settleUntil = performance.now() + 900;
      await tick();
      toBottom(false);
      const s = el();
      if (s && thread.cursor && s.scrollHeight <= s.clientHeight + 40) older();
    });
  });

  // 你刚发出的那一轮：滚到底，之后跟着它走
  let lastKey = untrack(() => lastT?.key || '');
  let lastId = untrack(() => thread.id);
  $effect(() => {
    const k = lastT?.key || '';
    const id = thread.id;
    const prevKey = lastKey, prevId = lastId;
    lastKey = k;
    lastId = id;
    if (!k || k === prevKey) return;
    // 新线程第一轮拿到真 id 时 thread 换了对象，但还是同一轮：不算换线程
    if (id !== prevId && prevKey && prevId) return;
    if (lastT?.live) {
      follow = true;
      tick().then(() => toBottom(true));
    }
  });
</script>

<section class="thread" bind:this={section}>
  <div class="cx-col" bind:this={col}>
    {#if turns.length && thread.cursor}
      <div class="older">
        {#if thread.loading}
          <svg class="spin" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.2" /></svg><span>{t('正在读更早的记录')}</span>
        {:else}
          <button class="lnk" onclick={older}>{t('读更早的记录')}</button>
        {/if}
      </div>
    {/if}

    {#if !turns.length}
      {#if thread.loading}
        <div class="state"><svg class="spin" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.2" /></svg><span>{t('正在打开线程')}</span></div>
      {:else if thread.error && thread.id}
        <div class="note sq">
          <span class="n-ico"><Icon name="warn" /></span>
          <div class="n-txt"><b>{t('没能打开这条线程')}</b><div class="n-sub">{thread.error}</div></div>
          <div class="n-act"><button class="tbtn" onclick={() => loadThread(thread.id)}>{t('重试')}</button></div>
        </div>
      {:else if thread.loaded}
        <div class="state">{t('这条线程还没有内容')}</div>
      {/if}
    {:else}
      {#each turns as turn, i (turn.key)}
        <Turn {turn} sid={thread.id} last={i === turns.length - 1} running={thread.running} ask={i === turns.length - 1 ? thread.ask : null} />
      {/each}
      {#if thread.error}
        <div class="note sq tail">
          <span class="n-ico"><Icon name="warn" /></span>
          <div class="n-txt">{thread.error}</div>
          {#if !thread.loaded && thread.id}<div class="n-act"><button class="tbtn" onclick={() => loadThread(thread.id)}>{t('重试')}</button></div>{/if}
        </div>
      {/if}
    {/if}
  </div>
</section>

<style>
  .older { display: flex; align-items: center; justify-content: center; gap: 8px; height: 32px; margin-bottom: 12px; color: var(--fg3); font-size: 12px; }
  .state { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px; color: var(--fg3); font-size: 13px; }
  .tail { margin-bottom: 20px; }
</style>
