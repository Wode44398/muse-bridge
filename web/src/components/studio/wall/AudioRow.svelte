<script>
  // 音频墙的一行（一张纸卡）：播放键、文字（配音 2 行、音乐 1 行，点开全文）、真波形（可点可拖跳播，播放头一条墨线）、元信息。
  // 配音里同一段文字的几个音色并成这一张卡：音色名小分段切换（旧波形压扁退场、新波形从左到右立起来）。
  // 在跑：播放键里是错拍标，波形位置一条墨线上走着一小段波；完成：真波形一根根立起来，错拍标合拍后变回播放键。
  import { onMount, onDestroy, untrack } from 'svelte';
  import { t } from '../../../lib/i18n.js';
  import { studio, modelLabelOf, jobElapsed, cancelJob, retryJob, dismissJob } from '../../../modules/studio/media.svelte.js';
  import { assetDrag } from '../../../modules/studio/assetDrag.js';
  import { icon } from '../../../modules/studio/icons.js';
  import Mark from '../ui/Mark.svelte';
  import ErrCard from '../ui/ErrCard.svelte';
  import Wave from './Wave.svelte';
  import { peaksFor } from './peaks.js';
  import { anim, quiet, ease, EIN, SPRING_SOFT, SPRING_POP, SPRING_SNAP } from './fx.js';
  import { mmss, ts } from './when.js';

  let { entry, page, player, ctl, compact = false, paused = false, fresh = false, onmenu = null } = $props();

  let root = $state();
  const takes = $derived(entry.takes || []);
  const job = $derived(entry.job || null);
  const startedDev = untrack(() => !entry.takes?.length);
  const mountedAt = Date.now();

  // 选中的音色（按作品 id 记，新的一条到了就跳到它）
  let selId = $state(untrack(() => entry.takes?.at(-1)?.id || ''));
  let growId = $state('');                  // 这一条的波形要「立起来」
  let known = new Set(untrack(() => (entry.takes || []).map((a) => a.id)));
  $effect(() => {
    const ids = takes.map((a) => a.id);
    untrack(() => {
      const added = takes.filter((a) => !known.has(a.id));
      known = new Set(ids);
      if (!ids.includes(selId)) selId = ids.at(-1) || '';
      // 刚生成出来的一条（本页面里看着它出来的）：切过去、波形立起来
      const nu = added.filter((a) => ts(a.createdAt) >= mountedAt - 60000).at(-1);
      if (nu) { selId = nu.id; growId = nu.id; }
    });
  });
  const take = $derived(takes.find((a) => a.id === selId) || takes.at(-1) || null);

  // —— 阶段 ——
  let revealDone = $state(false);
  const phase = $derived(!take ? (job?.state === 'error' ? 'err' : 'run') : startedDev && job && !revealDone ? 'reveal' : 'done');
  let beat = $state(0);
  $effect(() => {
    if (phase !== 'reveal') return;
    let tm = 0;
    untrack(() => {
      growId = take?.id || '';
      beat++;
      // 合拍之后（错拍标接成整圆再松开那一下）播放键才回来
      tm = setTimeout(() => { revealDone = true; }, quiet(root) ? 0 : 700);
    });
    return () => clearTimeout(tm);
  });
  let playEl = $state();
  $effect(() => { if (phase === 'done' && startedDev && playEl) untrack(() => { if (!quiet(root)) anim(playEl.firstElementChild, [{ transform: 'scale(.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { d: SPRING_POP.ms, e: ease(SPRING_POP) }); }); });

  // —— 波形数据 ——
  let peaks = $state({});                    // 作品 id → number[] | null（null = 拿不到，画平线）
  let durs = $state({});
  let visible = false;
  function want(a) {
    if (!a || !visible || a.id in peaks || (Array.isArray(a.peaks) && a.peaks.length)) return;
    peaks = { ...peaks, [a.id]: undefined };
    peaksFor(a).then((r) => { peaks = { ...peaks, [a.id]: r?.peaks || null }; if (r?.duration) durs = { ...durs, [a.id]: r.duration }; });
  }
  $effect(() => { const a = take; untrack(() => want(a)); });
  const wave = $derived(take ? (Array.isArray(take.peaks) && take.peaks.length ? take.peaks : peaks[take.id]) : undefined);
  const total = $derived(take ? (player.id === take.id && player.dur) || Number(take.duration) || durs[take.id] || 0 : 0);
  const mine = $derived(!!take && player.id === take.id);
  const p = $derived(mine && total ? Math.min(1, player.cur / total) : 0);

  // —— 在跑：一条墨线上走着一小段波 ——
  let cv = $state(), raf = 0, alive = true;
  function drawRun(now) {
    raf = 0;
    if (!alive || !cv || phase !== 'run') return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const col = getComputedStyle(cv).color || '#171614';
    const f = (now % 1700) / 1700, cx = -40 + f * (W + 80);
    const still = quiet(root);
    ctx.beginPath();
    for (let x = 0; x <= W; x += 1.5) {
      const g = still ? 0 : Math.exp(-Math.pow((x - cx) / 34, 2));
      const y = H / 2 - Math.sin((x - cx) / 7.5) * 10 * g;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = col; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke(); ctx.globalAlpha = 1;
    if (!still) kick();
  }
  function kick() { if (!raf && alive && visible && !paused && !document.hidden && phase === 'run') raf = requestAnimationFrame(drawRun); }
  $effect(() => { phase; paused; cv; untrack(() => { if (phase === 'run') kick(); }); });

  // —— 闪一下（素材架点了这一件 / 打开它）——
  $effect(() => {
    const id = studio.flash;
    untrack(() => {
      if (!id || !takes.some((a) => a.id === id)) return;
      selId = id;
      root?.scrollIntoView({ block: 'center', behavior: quiet(root) ? 'auto' : 'smooth' });
      if (!quiet(root)) anim(root, [{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 2px var(--sd-text)', offset: 0.25 }, { boxShadow: '0 0 0 0 transparent' }], { d: 1200 });
    });
  });

  onMount(() => {
    const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) { want(take); kick(); } }, { rootMargin: '300px' });
    io.observe(root);
    if (fresh && !quiet(root)) anim(root, [{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { d: SPRING_SOFT.ms, e: ease(SPRING_SOFT) });
    const vis = () => { if (!document.hidden) kick(); };
    document.addEventListener('visibilitychange', vis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  });
  onDestroy(() => { alive = false; if (raf) cancelAnimationFrame(raf); });

  // —— 交互 ——
  let open = $state(false);
  function switchTake(a) {
    if (!a || a.id === selId) return;
    const was = mine && player.playing;
    if (mine) ctl.stop();
    selId = a.id; growId = a.id;
    if (was) ctl.toggle(a);
  }
  function seekStart(e) {
    if (!take || phase !== 'done' && phase !== 'reveal') return;
    const el = e.currentTarget;
    const go = (ev) => { const r = el.getBoundingClientRect(); ctl.seek(take, Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))); };
    go(e);
    el.setPointerCapture?.(e.pointerId);
    const mv = (ev) => go(ev), up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }
  function waveKey(e) {
    if (!take || !total) return;
    const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
    if (!step) return;
    e.preventDefault();
    const now = mine ? player.cur : 0;
    ctl.seek(take, Math.max(0, Math.min(1, (now + step) / total)));
  }
  function ctx(e) { if (!take) return; e.preventDefault(); onmenu?.({ asset: take, at: { x: e.clientX, y: e.clientY } }); }

  // 音色名（分段里写的字）：配音参数里的 voice；多人对话的「主持人=…」只留音色
  const voiceOf = (a) => String(a?.params?.voice || a?.params?.voiceName || '').replace(/[^,，;；]*=/g, '').trim();
  const text = $derived(take?.prompt || job?.prompt || '');
  const devVoice = $derived(page === 'voice' && !take ? voiceOf({ params: job?.params }) : '');

  // 分段滑块：跟着选中的那一段走（从当前位置接着滑）
  let segEl = $state(), puck = $state(), puckAt = null, puckRun = null;
  $effect(() => {
    selId; takes.length;
    untrack(() => requestAnimationFrame(() => {
      const b = segEl?.querySelector('.sw-take.on');
      if (!b || !puck) return;
      const to = { x: b.offsetLeft, w: b.offsetWidth };
      let from = puckAt;
      if (puckRun?.playState === 'running') { const m = new DOMMatrixReadOnly(getComputedStyle(puck).transform); from = { x: m.m41, w: parseFloat(getComputedStyle(puck).width) }; }
      puckRun?.cancel(); puckRun = null;
      puck.style.transform = `translateX(${to.x}px)`; puck.style.width = to.w + 'px';
      if (from && (from.x !== to.x || from.w !== to.w) && !quiet(puck)) {
        puckRun = anim(puck, [{ transform: `translateX(${from.x}px) scaleX(${(from.w / to.w).toFixed(4)})` }, { transform: `translateX(${to.x}px)` }], { d: SPRING_SNAP.ms, e: ease(SPRING_SNAP) });
      }
      puckAt = to;
    }));
  });
</script>

<div class="sw-arow" class:music={page === 'music'} class:dev={phase === 'run' || phase === 'err'} class:playing={mine && player.playing} bind:this={root}
  role="group" aria-label={text.slice(0, 60) || (page === 'music' ? t('音乐') : t('配音'))} oncontextmenu={ctx} use:assetDrag={{ asset: take, onStay: (node) => take && onmenu?.({ asset: take, anchor: node }) }}>
  <button class="sw-aplay" bind:this={playEl} type="button" data-nodrag
    disabled={phase === 'run' || phase === 'err' || phase === 'reveal'}
    aria-label={player.failed && mine ? t('重新加载') : mine && player.playing ? t('暂停') : t('播放')}
    onclick={() => ctl.toggle(take)}>
    {#if phase !== 'done'}<Mark state={phase === 'run' ? 'work' : 'idle'} {beat} size={24} />
    {:else}{@html icon(player.failed && mine ? 'reload' : mine && player.playing ? 'pause' : 'play')}{/if}
  </button>
  <div class="sw-amain">
    {#if text}
      <!-- 点的是外面这一层：文字本身要 overflow:hidden 截行，命中区伸不出去；外层在触屏上上下各多 5px（不占版面） -->
      <div class="sw-ahit" role="button" tabindex="0" aria-expanded={open}
        onclick={() => (open = !open)} onkeydown={(e) => { if (e.key === 'Enter') open = !open; }}><div class="sw-atext sel-text" class:open>{text}</div></div>
    {/if}
    {#if phase === 'err'}
      <ErrCard frame error={job?.error || ''} {page} prompt={job?.prompt || ''} onretry={() => retryJob(job)} ondismiss={() => dismissJob(job.id)} />
    {:else}
      <div class="sw-awave" role="slider" tabindex="0" data-nodrag aria-label={t('进度')} aria-valuemin="0" aria-valuemax={Math.round(total)} aria-valuenow={Math.round(p * total)}
        onpointerdown={seekStart} onkeydown={waveKey}>
        {#if phase === 'run'}
          <canvas bind:this={cv} aria-hidden="true"></canvas>
        {:else if take}
          {#key take.id}
            <Wave peaks={wave} {p} head={mine && player.playing} grow={growId === take.id} ongrown={() => { if (growId === take.id) growId = ''; }} />
          {/key}
        {/if}
      </div>
    {/if}
    <div class="sw-ameta">
      {#if page === 'voice' && takes.length > 1}
        <span class="sw-takes" role="tablist" aria-label={t('音色')} bind:this={segEl} data-nodrag data-hscroll>
          <span class="sw-pk" bind:this={puck}></span>
          {#each takes as a (a.id)}
            <button class="sw-take" class:on={a.id === take?.id} type="button" role="tab" aria-selected={a.id === take?.id} onclick={() => switchTake(a)}>{voiceOf(a) || t('音色')}</button>
          {/each}
        </span>
      {:else if page === 'voice' && (voiceOf(take) || devVoice)}
        <span class="sw-vtag">{voiceOf(take) || devVoice}</span>
      {/if}
      {#if take && !(compact && page === 'voice' && takes.length > 1)}<span class="sw-am">{modelLabelOf(take)}</span>{/if}
      <span class="sw-sp"></span>
      {#if phase === 'run' && job}
        <span class="mono sw-at">{jobElapsed(job)}</span>
        {#if !job.uncancelable}<button class="sw-x" type="button" data-nodrag aria-label={t('取消')} title={t('取消')} onclick={() => cancelJob(job.id)}>{@html icon('close')}</button>{/if}
      {:else if take}
        {#if player.failed && mine}
          <button class="sw-afail" type="button" data-nodrag onclick={() => ctl.toggle(take)}>{t('加载失败')}<i aria-hidden="true">·</i>{t('重试')}</button>
        {:else}
          <span class="mono sw-at"><span class="sw-cur">{mmss(mine ? player.cur : 0)}</span> / {total ? mmss(total) : '–:––'}</span>
        {/if}
      {/if}
    </div>
  </div>
</div>
