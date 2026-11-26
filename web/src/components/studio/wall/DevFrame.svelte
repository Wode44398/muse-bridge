<script>
  // 墙上正在生成的一件（方案 §12.2「生成中 DevFrame」）：取景框（四个角 + 一圈发丝线）+ ink.js 显影 + 角上小签（错拍标 · 计时 · 取消）。
  //   run    墨按进度晕开（job.progress 优先，没有就按已跑时长 / 预计时长估）
  //   reveal 结果图（preview 档）解码好后显影 1.6s：画面从墨浓处浮出来；中途 onmid（墙把这一格弹到真比例），显完 ondone（换成作品格子）
  //   err    墨淡下去，原地出 ErrCard
  // 离屏、页面隐藏、被焦点盖住（paused）时不画；手机 grid 64 + 30fps；减少动态效果时不画墨，只留静态框和计时。
  import { onMount, onDestroy, untrack } from 'svelte';
  import { t } from '../../../lib/i18n.js';
  import { jobElapsed, cancelJob, retryJob, dismissJob, mediaSrc } from '../../../modules/studio/media.svelte.js';
  import { create as inkCreate } from '../../../modules/studio/ink.js';
  import Mark from '../ui/Mark.svelte';
  import ErrCard from '../ui/ErrCard.svelte';
  import { anim, quiet, CORNER, EIN, EOUT, SPRING_SOFT, ease, inkTarget, seedOf } from './fx.js';
  import { icon } from '../../../modules/studio/icons.js';

  let { job, asset = null, phase = 'run', w = 0, h = 0, page, compact = false, paused = false, fresh = false, onmid = null, ondone = null } = $props();

  let root = $state(), cv = $state(), lineEl = $state(), metaEl = $state();
  let beat = $state(0);
  let visible = true, alive = true;
  let ink = null, inkW = 0, inkH = 0;
  let raf = 0, last = 0, shown = 0;          // shown：画面上墨的进度（追着目标走，别一跳一跳）
  let rv = { img: null, r0: 0, mid: false, state: '' };   // 显影
  const seed = untrack(() => seedOf(job?.id));
  const rx = $derived(compact ? 9.5 : 11.5);

  const still = () => quiet(root);
  function dark() { return !!root?.closest('.studio-root')?.classList.contains('dark'); }
  function frame(now) {
    raf = 0;
    if (!alive || !cv || !w || !h) return;
    if (compact && now - last < 31) { kick(); return; }
    const dt = last ? Math.min(100, now - last) : 16;
    last = now;
    if (!ink || Math.abs(inkW - w) > 1 || Math.abs(inkH - h) > 1) { ink?.dispose(); inkW = w; inkH = h; ink = inkCreate(cv, { w, h, seed, grid: compact ? 64 : 96 }); }
    const goal = rv.state === 'err' ? shown : inkTarget(job);
    shown += (goal - shown) * (1 - Math.exp(-dt / 500));
    let r = 0;
    if (rv.state === 'go') {
      r = Math.min(1, (now - rv.r0) / 1600);
      if (!rv.mid && now - rv.r0 >= 380) { rv.mid = true; onmid?.(); }
    }
    ink.draw({ t: now, progress: shown, reveal: r, img: rv.img, dark: dark() });
    if (rv.state === 'go' && r >= 1) { rv.state = 'done'; ondone?.(); return; }
    kick();
  }
  function canDraw() { return alive && visible && !paused && !document.hidden && !still() && (phase === 'run' || rv.state === 'go'); }
  function kick() { if (!raf && canDraw()) raf = requestAnimationFrame(frame); }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
  // 显影到一半看不见了（滚走、切到后台、被焦点盖住）：直接落成作品格子，别停在半截
  function settle() { stop(); if (rv.state === 'go') { rv.state = 'done'; if (!rv.mid) onmid?.(); ondone?.(); } }
  function onVis() { if (document.hidden) settle(); else kick(); }

  // 出图：先在后台解码好结果图，再显影；看不见的、减少动态效果的直接换成作品格子
  async function beginReveal() {
    if (rv.state) return;
    rv.state = 'load';
    const img = new Image();
    img.decoding = 'async';
    img.src = asset ? mediaSrc(asset, 'preview') : '';
    try { await img.decode(); } catch {}
    if (!alive) return;
    if (!img.naturalWidth || !visible || paused || document.hidden || still()) { rv.state = 'done'; onmid?.(); ondone?.(); return; }
    rv.img = img; rv.r0 = performance.now(); rv.state = 'go';
    beat++;
    // 角往外退、发丝线和小签收起（退场短、加速）；小签等错拍标合完那一拍再走
    for (const c of root.querySelectorAll('.sw-corner')) anim(c, [{ opacity: 1 }, { opacity: 0 }], { d: 260, e: EIN, fill: 'forwards' });
    anim(lineEl, [{ opacity: 1 }, { opacity: 0 }], { d: 300, fill: 'forwards' });
    anim(metaEl, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(3px)' }], { d: 160, e: EIN, delay: 620, fill: 'forwards' });
    kick();
  }
  // 失败：墨淡下去，框和小签收起，ErrCard 在原处浮上来（ErrCard 的进场在 CSS 里）
  function beginErr(animate) {
    rv.state = 'err';
    stop();
    if (!ink && cv && w && h && !still()) { inkW = w; inkH = h; ink = inkCreate(cv, { w, h, seed, grid: compact ? 64 : 96 }); shown = inkTarget(job); ink.draw({ t: performance.now(), progress: shown, reveal: 0, dark: dark() }); }
    if (!animate) return;
    anim(cv, [{ opacity: 1 }, { opacity: 0.16 }], { d: 500 });
    for (const c of root.querySelectorAll('.sw-corner, .sw-line, .sw-meta')) anim(c, [{ opacity: 1 }, { opacity: 0 }], { d: 180, e: EIN });
  }

  const mountedPhase = untrack(() => phase);
  $effect(() => {
    const ph = phase;
    untrack(() => {
      if (ph === 'reveal') beginReveal();
      else if (ph === 'err' && rv.state !== 'err') beginErr(mountedPhase !== 'err');
      else if (ph === 'run' && rv.state === 'err') { rv.state = ''; kick(); }
    });
  });
  $effect(() => { paused; w; h; untrack(() => { if (paused) settle(); else kick(); }); });

  onMount(() => {
    const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) kick(); else settle(); }, { rootMargin: '120px' });
    io.observe(root);
    document.addEventListener('visibilitychange', onVis);
    if (fresh && phase === 'run' && !still()) entrance();
    kick();
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', onVis); };
  });
  onDestroy(() => { alive = false; stop(); ink?.dispose(); ink = null; rv.img = null; });

  // 取景：四个角从框心往外撑开（先定框、再画边），框里的纸淡出来；计时和取消最后出来
  function entrance() {
    anim(root, [{ opacity: 0 }, { opacity: 1 }], { d: 200, delay: 40, fill: 'backwards' });
    const pull = { tl: [1, 1], tr: [-1, 1], bl: [1, -1], br: [-1, -1] };
    const base = { tl: '', tr: ' scaleX(-1)', bl: ' scaleY(-1)', br: ' scale(-1, -1)' };
    root.querySelectorAll('.sw-corner').forEach((c, i) => {
      const k = c.dataset.c, [sx, sy] = pull[k];
      const tx = sx * (w / 2 - 22) * 0.72, ty = sy * (h / 2 - 22) * 0.72;
      anim(c, [{ transform: `translate(${tx}px, ${ty}px)${base[k]} scale(.4)`, opacity: 0 }, { transform: `translate(0, 0)${base[k]}`, opacity: 1 }],
        { d: SPRING_SOFT.ms, e: ease(SPRING_SOFT), delay: 60 + i * 22, fill: 'backwards' });
    });
    const r = lineEl?.querySelector('rect');
    if (r) anim(r, [{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], { d: 520, delay: 160, e: 'cubic-bezier(.45,0,.2,1)', fill: 'backwards' });
    anim(metaEl, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { d: 260, delay: 300, e: EOUT, fill: 'backwards' });
  }
</script>

<div class="sw-dev" class:err={phase === 'err'} bind:this={root} role="img" aria-label={phase === 'err' ? t('生成失败') : t('生成中：{prompt}', { prompt: String(job?.prompt || '').slice(0, 40) })}>
  <canvas bind:this={cv} aria-hidden="true"></canvas>
  <svg class="sw-line" bind:this={lineEl} viewBox="0 0 {Math.max(1, w)} {Math.max(1, h)}" aria-hidden="true">
    <rect x=".5" y=".5" width={Math.max(0, w - 1)} height={Math.max(0, h - 1)} rx={rx} pathLength="100" />
  </svg>
  {#each ['tl', 'tr', 'bl', 'br'] as c (c)}<span class="sw-corner {c}" data-c={c} aria-hidden="true">{@html CORNER}</span>{/each}
  <span class="sw-meta" bind:this={metaEl}>
    <Mark state={phase === 'run' ? 'work' : 'idle'} {beat} size={18} />
    <span class="mono sw-tm">{job ? jobElapsed(job) : '0:00'}</span>
    {#if job && !job.uncancelable && phase === 'run'}
      <button class="sw-x" type="button" aria-label={t('取消')} title={t('取消')} onclick={() => cancelJob(job.id)}>{@html icon('close')}</button>
    {/if}
  </span>
  {#if phase === 'err'}
    <ErrCard frame error={job?.error || ''} {page} prompt={job?.prompt || ''} onretry={() => retryJob(job)} ondismiss={() => dismissJob(job.id)} />
  {/if}
</div>
