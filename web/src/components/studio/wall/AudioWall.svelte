<script>
  // 配音 / 音乐页的画布：一行一件的音频墙（方案 §12.2）。按日期小标题分段；配音里同一段文字的几个音色并成一张卡
  // （AudioRow 里用音色名小分段切换）；最前面是这一页在跑 / 刚失败的任务。全页只有一个 <audio>（heal 自愈）。
  // 行的增删挪位走 animate（FLIP，只动 transform）。
  import { onMount, untrack } from 'svelte';
  import { t } from '../../../lib/i18n.js';
  import { layout } from '../../../lib/layout.svelte.js';
  import { studio, wallJobs, moreWall, loadWall, ensureWall, mediaSrc } from '../../../modules/studio/media.svelte.js';
  import { edgeFade } from '../../../modules/studio/edge.js';
  import { heal } from '../../../modules/studio/heal.js';
  import Empty from '../ui/Empty.svelte';
  import WorkMenu from '../WorkMenu.svelte';
  import AudioRow from './AudioRow.svelte';
  import { ease, quiet, SPRING_SOFT } from './fx.js';
  import { ts, dayKey, dayLabel } from './when.js';
  import '../wall.css';

  let { page, active = true } = $props();

  const compact = $derived(layout.compact);
  const wall = $derived(studio.walls?.[page] || { items: [], loading: false, loaded: false, done: true, err: '' });
  const jobs = $derived(wallJobs(page));

  // 在墙上画过的任务：完成后它的结果沿用那一行（同一个 key），原地立起波形
  const tracked = new Map();     // jobId → { at, landed }
  // 配音的卡按文字归并：卡的 key 第一次见到就定下（新文字的第一条结果沿用任务那一行的 key；已有的文字并进原来那张卡）
  const groupKey = new Map();    // 文字 → key
  const textOf = (a) => String(a?.prompt || '').trim();

  const rows = $derived.by(() => {
    const out = [];
    for (const j of jobs) {
      if (!tracked.has(j.id)) tracked.set(j.id, { at: 0, landed: false });
      out.push({ key: 'j:' + j.id, job: j, takes: [], created: ts(j.createdAt) });
    }
    const first = new Map();     // 结果作品 id → job
    for (const [id, tr] of tracked) {
      if (jobs.some((x) => x.id === id)) continue;
      const j = studio.jobs.find((x) => x.id === id);
      const a = j?.state === 'done' ? j.result?.[0] : null;
      if (!a?.id) continue;
      if (!tr.at) tr.at = Date.now();
      first.set(a.id, j);
    }
    const items = [...(wall.items || [])];
    for (const a of items) { const j = first.get(a.id); if (j) tracked.get(j.id).landed = true; }
    // 结果还没并进墙：先补在最前面（别先消失再冒出来）
    for (const [aid, j] of first) {
      const tr = tracked.get(j.id);
      if (!tr.landed && Date.now() - tr.at < 10000) { const a = j.result.find((x) => x.id === aid); if (a) items.unshift(a); }
    }
    if (page === 'voice') {
      const byKey = new Map();
      for (const a of items) {
        const txt = textOf(a);
        let key = groupKey.get(txt);
        if (!key) {
          const j = first.get(a.id);
          key = j ? 'j:' + j.id : 'g:' + a.id;
          if (txt) groupKey.set(txt, key);
        }
        let g = byKey.get(key);
        if (!g) {
          const j = key.startsWith('j:') ? studio.jobs.find((x) => 'j:' + x.id === key) || null : null;
          g = { key, job: j, takes: [], created: 0 };
          byKey.set(key, g);
          out.push(g);
        }
        g.takes.push(a);
        g.created = Math.max(g.created, ts(a.createdAt));
      }
      // 音色从旧到新排：新出的一条接在分段最后，已有的位置不动
      for (const g of byKey.values()) g.takes.sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
    } else {
      for (const a of items) {
        const j = first.get(a.id);
        out.push({ key: j ? 'j:' + j.id : a.id, job: j || null, takes: [a], created: ts(a.createdAt) });
      }
    }
    // 在跑的永远在最前；其余按最新一条的时间（配音同一段文字又出了一条：整张卡回到最前面）
    const dev = out.filter((g) => !g.takes.length), done = out.filter((g) => g.takes.length).sort((x, y) => y.created - x.created);
    return [...dev, ...done];
  });

  // 日期小标题 + 行，拍平成一个列表（animate 要求每一项都是 each 的直接子项）
  const list = $derived.by(() => {
    const out = [];
    let day = '';
    for (const g of rows) {
      const k = dayKey(g.created || Date.now());
      if (k !== day) { day = k; out.push({ key: 'd:' + k, day: dayLabel(g.created || Date.now()) }); }
      out.push(g);
    }
    return out;
  });

  // —— 全页一个播放器 ——
  let au = $state();
  const player = $state({ id: '', src: '', playing: false, cur: 0, dur: 0, failed: '' });
  let pendingSeek = -1, raf = 0;
  function loop() { raf = 0; if (!au || au.paused) return; player.cur = au.currentTime || 0; raf = requestAnimationFrame(loop); }
  function load(a) {
    player.id = a.id; player.src = mediaSrc(a); player.cur = 0; player.dur = Number(a.duration) || 0; player.failed = '';
  }
  const ctl = {
    toggle(a) {
      if (!au || !a) return;
      if (player.failed === a.id) { au.__healRetry?.(); return; }
      if (player.id === a.id) { au.paused ? au.play().catch(() => {}) : au.pause(); return; }
      load(a);
      queueMicrotask(() => au?.play().catch(() => {}));
    },
    seek(a, f) {
      if (!au || !a) return;
      if (player.id !== a.id) { load(a); pendingSeek = f; queueMicrotask(() => au?.play().catch(() => {})); return; }
      const d = au.duration || player.dur;
      if (d) { au.currentTime = f * d; player.cur = f * d; }
    },
    stop() { au?.pause(); player.id = ''; player.src = ''; player.cur = 0; },
  };
  function onMeta() {
    if (au && isFinite(au.duration)) player.dur = au.duration;
    if (pendingSeek >= 0 && au && player.dur) { au.currentTime = pendingSeek * player.dur; player.cur = au.currentTime; }
    pendingSeek = -1;
  }
  // 换页 / 失活时停下（别在看不见的页里接着放）
  $effect(() => { if (!active) untrack(() => au?.pause()); });

  // —— 翻页 ——
  let sc = $state(), sentinel = $state();
  onMount(() => {
    ensureWall(page);
    const io = new IntersectionObserver((es) => {
      if (es.some((x) => x.isIntersecting) && !wall.done && !wall.loading && wall.loaded) moreWall(page);
    }, { root: sc, rootMargin: '0px 0px 900px 0px' });
    io.observe(sentinel);
    return () => { io.disconnect(); if (raf) cancelAnimationFrame(raf); };
  });
  let seenJobs = new Set();
  $effect(() => {
    const ids = jobs.map((j) => j.id);
    untrack(() => {
      const fresh = jobs.filter((j) => !seenJobs.has(j.id) && j.__mine);
      seenJobs = new Set(ids);
      if (fresh.length && sc && sc.scrollTop > 0) sc.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
  let laidOut = false;
  const initial = new Set();
  // 第一次排好之后才出现的格子 / 行才演进场（翻页、刷新拿到的不演）
  const isFresh = (k) => laidOut && !initial.has(k);
  $effect(() => { list; untrack(() => { if (!laidOut) { laidOut = true; for (const x of list) initial.add(x.key); } }); });

  // 行的挪位：从旧位置弹簧挪过去（只动 transform；打断时 Svelte 从当前样子量起）
  function flipRow(node, { from, to }) {
    const dy = from.top - to.top;
    if (!dy || quiet(node)) return { duration: 0 };
    return { duration: SPRING_SOFT.ms, easing: SPRING_SOFT.ease, css: (_k, u) => `transform: translateY(${(u * dy).toFixed(2)}px)` };
  }
  function rowOut(node) {
    if (quiet(node)) return { duration: 0 };
    return { duration: 170, easing: (x) => x * x, css: (k) => `opacity:${k};transform:scale(${(0.97 + 0.03 * k).toFixed(4)})` };
  }

  let menu = $state(null);
  const onmenu = (m) => { menu = m; };
  const empty = $derived(wall.loaded && !rows.length && !wall.err);
</script>

<div class="sw-root">
  <div class="sw-scroll audio" bind:this={sc} use:edgeFade={{ top: 18, bot: 0 }}>
    <div class="sw-alist" class:compact>
      {#each list as x (x.key)}
        <div class="sw-aslot" class:day={!!x.day} animate:flipRow out:rowOut>
          {#if x.day}
            <div class="sw-day">{x.day}</div>
          {:else}
            <AudioRow entry={x} {page} {player} {ctl} {compact} paused={!active} fresh={isFresh(x.key)} {onmenu} />
          {/if}
        </div>
      {/each}
    </div>
    <div class="sw-more" bind:this={sentinel} aria-hidden="true"></div>
    {#if empty}<div class="sw-empty"><Empty {page} /></div>{/if}
    {#if wall.err && !rows.length}
      <div class="sw-loaderr"><span>{wall.err}</span><button class="sw-tb" type="button" onclick={() => loadWall(page)}>{t('重试')}</button></div>
    {/if}
  </div>
  <audio bind:this={au} src={player.src || undefined} preload="metadata"
    use:heal={{ src: player.src, onstate: (s) => { if (s === 'failed') { player.failed = player.id; player.playing = false; } else if (s === 'ok' && player.failed === player.id) player.failed = ''; } }}
    onplay={() => { player.playing = true; if (!raf) raf = requestAnimationFrame(loop); }}
    onpause={() => { player.playing = false; if (au) player.cur = au.currentTime || 0; }}
    onended={() => { player.playing = false; player.cur = 0; }}
    onloadedmetadata={onMeta} ondurationchange={() => { if (au && isFinite(au.duration)) player.dur = au.duration; }}></audio>
</div>

{#if menu}
  <WorkMenu asset={menu.asset} anchor={menu.anchor || null} at={menu.at || null} onclose={() => (menu = null)} />
{/if}
