<script>
  // 图像 / 视频页的画布：作品墙（方案 §12.2）。一面连续的瀑布格，最前面是这一页在跑 / 刚失败的任务，然后是作品；
  // 格子按真实宽高比排（缺宽高先按 4:3、图加载出来按真实比例重排一次），绝对定位 + transform，变化时 FLIP。
  // 墙自己管滚动（画布占满整页，输入栏浮在底部，底距留 --cf-dock-h），滚到底翻下一页。
  // 打开一件 → Focus（同一个画布里，原地放大）。
  import { onMount, untrack } from 'svelte';
  import { t } from '../../../lib/i18n.js';
  import { layout } from '../../../lib/layout.svelte.js';
  import { studio, wallJobs, loadWall, moreWall, ensureWall } from '../../../modules/studio/media.svelte.js';
  import { edgeFade } from '../../../modules/studio/edge.js';
  import { masonry, wallCols, wallGap, ratioOf, ratioFromParams, RATIO_GUESS } from '../../../modules/studio/masonry.js';
  import Empty from '../ui/Empty.svelte';
  import WorkMenu from '../WorkMenu.svelte';
  import Cell from './Cell.svelte';
  import Focus from './Focus.svelte';
  import '../wall.css';

  let { page, active = true } = $props();

  const compact = $derived(layout.compact);
  const wall = $derived(studio.walls?.[page] || { items: [], loading: false, loaded: false, done: true, err: '' });
  const jobs = $derived(wallJobs(page));
  const focusHere = $derived(studio.focus?.page === page);

  // 在墙上画过的任务（本组件生命周期内）：完成后它的第一张结果沿用那一格（同一个 key），原地显影，不重挂
  const tracked = new Map();     // jobId → { at, landed }
  // 取景框比例：任务在跑时这一格按发出时的比例排；显影到一半（DevFrame 的 onmid）才放开，弹到真比例
  const holds = new Map();       // key → 高 / 宽
  let relVer = $state(0);
  function release(key) { if (holds.delete(key)) relVer++; }

  // 缺宽高的作品：图加载出来报真实比例，攒一帧一起重排
  const dims = {};
  let dimVer = $state(0), dimRaf = 0;
  function onratio(id, r) {
    if (!(r > 0) || (dims[id] && Math.abs(dims[id] - r) < 0.01)) return;
    dims[id] = r;
    if (!dimRaf) dimRaf = requestAnimationFrame(() => { dimRaf = 0; dimVer++; });
  }
  const frameRatio = (job) => ratioFromParams(job?.params) ?? (page === 'video' ? 9 / 16 : 1);
  const assetRatio = (a) => ratioOf(a?.w, a?.h) ?? dims[a?.id] ?? RATIO_GUESS;

  const entries = $derived.by(() => {
    const out = [];
    for (const j of jobs) {
      const key = 'j:' + j.id;
      if (!tracked.has(j.id)) { tracked.set(j.id, { at: 0, landed: false }); holds.set(key, frameRatio(j)); }
      out.push({ key, job: j, asset: null });
    }
    const first = new Map();     // 结果作品 id → { job, tr }
    for (const [id, tr] of tracked) {
      if (jobs.some((x) => x.id === id)) continue;
      const j = studio.jobs.find((x) => x.id === id);
      const a = j?.state === 'done' ? j.result?.[0] : null;
      if (!a?.id) continue;
      if (!tr.at) tr.at = Date.now();
      first.set(a.id, { job: j, tr });
    }
    const items = wall.items || [];
    for (const a of items) { const f = first.get(a.id); if (f) f.tr.landed = true; }
    // 结果还没并进墙（完成事件和墙的合并有先后）：先在最前面占着这一格，别先消失再冒出来
    for (const [aid, { job, tr }] of first) {
      if (!tr.landed && Date.now() - tr.at < 10000) out.push({ key: 'j:' + job.id, job, asset: job.result.find((x) => x.id === aid) });
    }
    for (const a of items) {
      const f = first.get(a.id);
      out.push(f ? { key: 'j:' + f.job.id, job: f.job, asset: a } : { key: a.id, job: null, asset: a });
    }
    return out;
  });

  // —— 排版 ——
  let width = $state(0);
  let laidOut = false, prevW = 0, prevCols = 0;
  const initial = new Set();
  // 第一次排好之后才出现的格子 / 行才演进场（翻页、刷新拿到的不演）
  const isFresh = (k) => laidOut && !initial.has(k);     // 第一次排版时就在的格子：不演进场
  const lay = $derived.by(() => {
    relVer; dimVer;
    const cols = wallCols(width, compact), gap = wallGap(compact);
    const ratios = entries.map((e) => (holds.has(e.key) ? holds.get(e.key) : e.asset ? assetRatio(e.asset) : frameRatio(e.job)));
    const m = masonry(ratios, { width, cols, gap });
    // 只是中栏宽度在变（素材架 / 参数坞推拉）而列数没变：跟手瞬移；换了列数、增删格子、比例变了：弹簧挪过去
    const animate = laidOut && width > 0 && !(width !== prevW && cols === prevCols);
    if (width > 0 && !laidOut) { laidOut = true; for (const e of entries) initial.add(e.key); }
    prevW = width; prevCols = cols;
    const pos = {};
    entries.forEach((e, i) => { pos[e.key] = { ...m.boxes[i], anim: animate, k: i }; });
    return { pos, height: m.height };
  });

  // —— 滚动、翻页 ——
  let sc = $state(), sentinel = $state();
  onMount(() => {
    ensureWall(page);
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting) && !wall.done && !wall.loading && wall.loaded) moreWall(page);
    }, { root: sc, rootMargin: '0px 0px 900px 0px' });
    io.observe(sentinel);
    return () => io.disconnect();
  });
  // 自己刚发出去的一件插在最前面：墙不在顶上就滚回去看它
  let seenJobs = new Set();
  $effect(() => {
    const ids = jobs.map((j) => j.id);
    untrack(() => {
      const fresh = jobs.filter((j) => !seenJobs.has(j.id) && j.__mine);
      seenJobs = new Set(ids);
      if (fresh.length && sc && sc.scrollTop > 0 && !focusHere) sc.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // —— 焦点：墙上那张在飞 / 开着时藏起来（Focus 管） ——
  let lifted = $state('');
  // —— 作品菜单（右键 / 长按） ——
  let menu = $state(null);
  const onmenu = (m) => { menu = m; };

  const empty = $derived(wall.loaded && !entries.length && !wall.err);
</script>

<div class="sw-root">
  <div class="sw-scroll" bind:this={sc} use:edgeFade={{ top: 18, bot: 0 }} inert={focusHere}>
    <div class="sw-wall" class:compact bind:clientWidth={width} style:height="{lay.height}px">
      {#each entries as e (e.key)}
        <Cell entry={e} pos={lay.pos[e.key]} {page} {compact} paused={focusHere || !active} fresh={isFresh(e.key)}
          lifted={!!e.asset && lifted === e.asset.id} onrelease={release} {onratio} {onmenu} />
      {/each}
    </div>
    <div class="sw-more" bind:this={sentinel} aria-hidden="true"></div>
    {#if empty}<div class="sw-empty"><Empty {page} /></div>{/if}
    {#if wall.err && !entries.length}
      <div class="sw-loaderr"><span>{wall.err}</span><button class="sw-tb" type="button" onclick={() => loadWall(page)}>{t('重试')}</button></div>
    {/if}
  </div>
  <Focus {page} scroller={sc} onlift={(id) => (lifted = id)} {onmenu} />
</div>

{#if menu}
  <WorkMenu asset={menu.asset} anchor={menu.anchor || null} at={menu.at || null} only={menu.only || ''} align={menu.align || ''} onclose={() => (menu = null)} />
{/if}
