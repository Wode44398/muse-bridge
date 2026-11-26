<script>
  // 素材架（方案 §12.1）：替换 v3 的作品栏。所有种类混排的小格子（图 / 视频缩略图，音频画 9 根真波形）。
  //   宽屏（medium / expanded）：侧列。收着是 64 的一条小格子；展开 300 是三列小墙 + 头部「作品 / 文件」分段 + 搜索 + 按日期小标题。
  //     展开 / 收起时侧列宽度直接到位，每个格子从原位置 FLIP 到新位置（同一批格子在挪，不是换了一面墙）。
  //   手机（compact）：同一棵子树放进左缘抽屉，一直是展开的样子。
  // 点格子：图 / 视频 → 切页并打开焦点；音频 → 切页、那一行闪一下（都由 openAsset 做）。
  // 挑选态（studio.pick）：能当这个角色的变实、其余变淡；点一张就挂进那一页的输入栏并飞过去。拖：assetDrag。
  // 「文件」= 核心 WorkspaceEmbed，首次打开才挂、之后常驻（滚动、展开的文件夹都留着）。
  import { untrack, tick, onDestroy } from 'svelte';
  import { t, tc } from '../../lib/i18n.js';
  import { api } from '../../lib/api.js';
  import { dragScrollGuard } from '../../lib/dragdrop.svelte.js';
  import { reduced } from '../../lib/motion.js';
  import { studio, saveSide, loadAssets, openAsset, mediaSrc, addInput, endPick, roleName, onJobDone } from '../../modules/studio/media.svelte.js';
  import { visual } from '../../modules/studio/kinds.js';
  import { roleAccepts } from '../../modules/studio/drag.js';
  import { assetDrag } from '../../modules/studio/assetDrag.js';
  import { edgeFade } from '../../modules/studio/edge.js';
  import { icon, KIND } from '../../modules/studio/icons.js';
  import { SPRING_SOFT, SPRING_POP, springEasing } from '../../modules/studio/motion.js';
  import Img from './ui/Img.svelte';
  import Measure from './ui/Measure.svelte';
  import WorkMenu from './WorkMenu.svelte';
  import WorkspaceEmbed from '../dock/WorkspaceEmbed.svelte';

  // open：侧列展开 / 抽屉拉出；drawer：手机抽屉形态；onclose：抽屉里点了格子之后收起；ontoggle：栏头的展开 / 收起钮
  let { open = false, drawer = false, ontoggle, onclose } = $props();

  // 格子按「展开」排：侧列展开，或者在抽屉里
  const wide = $derived(drawer || open);
  const pick = $derived(studio.pick);
  // 收着的一条只有作品格子；挑选态也只看作品
  const tab = $derived(pick || !wide ? 'works' : studio.side.tab);
  const quiet = (node) => reduced() || !!node?.closest?.('.sd-noanim');

  // —— 文件 ——
  let filesMounted = $state(false), startDir = $state('');
  async function mountFiles() {
    if (filesMounted) return;
    const dir = studio.saveDir || '';
    let ok = false;
    if (dir) { try { await api.files(dir); ok = true; } catch {} }
    startDir = ok ? dir : '';
    filesMounted = true;
  }
  $effect(() => { if (tab === 'files' && wide) untrack(mountFiles); });
  const target = $derived(studio.filesTarget);
  function setTab(v) { if (studio.side.tab === v) return; studio.side.tab = v; saveSide(); }
  // 收着时底下的文件夹钮：展开并切到「文件」
  function toFiles() { setTab('files'); if (!open) ontoggle?.(); }
  const TABS = [{ value: 'works', label: t('作品') }, { value: 'files', label: tc('侧栏', '文件') }];

  // —— 搜索（服务端按提示词过滤，分页游标从头来）——
  let searching = $state(false), qEl = $state();
  let qT = 0;
  function onQ() { clearTimeout(qT); qT = setTimeout(() => loadAssets(true), 260); }
  function openSearch() { searching = true; requestAnimationFrame(() => qEl?.focus()); }
  function closeSearch() { searching = false; clearTimeout(qT); if (studio.q) { studio.q = ''; loadAssets(true); } }
  $effect(() => { if (!wide) untrack(() => { if (searching && !studio.q) searching = false; }); });

  // —— 按日期小标题（只在展开时露出来）——
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const ts = (x) => (typeof x === 'number' ? x : Date.parse(x) || 0);
  function dayLabel(ms) {
    const today = dayKey(Date.now()), y = dayKey(Date.now() - 86400e3), k = dayKey(ms);
    if (k === today) return t('今天');
    if (k === y) return t('昨天');
    const d = new Date(ms);
    return d.getFullYear() === new Date().getFullYear() ? t('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate() }) : t('{y}年{m}月{d}日', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
  }
  const rows = $derived.by(() => {
    const out = [];
    let last = null;
    for (const a of studio.assets) {
      const k = dayKey(ts(a.createdAt));
      if (k !== last) { out.push({ day: true, key: 'd' + k, label: dayLabel(ts(a.createdAt)) }); last = k; }
      out.push({ key: a.id, a });
    }
    return out;
  });

  // —— 音频格子：120 格真峰值抽 9 根（每段取中点；取段内最大值的话响一点的音频九根全顶满，看不出形状） ——
  function bars(peaks) {
    const n = 9, out = [];
    for (let i = 0; i < n; i++) {
      const v = Number(peaks[Math.min(peaks.length - 1, Math.floor(((i + 0.5) / n) * peaks.length))]) || 0;
      const h = Math.max(2, Math.min(1, v) * 18);
      out.push({ x: i * 3.2 + 0.6, y: (20 - h) / 2, h });
    }
    return out;
  }
  const kindOf = (a) => (a.kind === 'music' ? 'audio' : a.kind);
  const pickable = (a) => !pick || roleAccepts(pick.role) === kindOf(a);

  // —— 点格子 ——
  function clickTile(e, a) {
    if (pick) { if (pickable(a)) choose(a, e.currentTarget); return; }
    openAsset(a);
    if (drawer) onclose?.();
  }
  function choose(a, el) {
    const p = pick;
    const r0 = el.getBoundingClientRect();
    addInput(p.page, { role: p.role, asset: a.id, url: mediaSrc(a, 'thumb'), name: a.prompt, kind: a.kind, fromAsset: a.id });
    endPick();
    if (drawer) onclose?.();
    if (visual(a.kind) && !quiet(el)) requestAnimationFrame(() => requestAnimationFrame(() => fly(a, r0)));
  }
  // 挑中的那张飞进输入栏（落在刚挂上的素材块上；找不到素材块就不飞）
  function fly(a, r0) {
    const blocks = document.querySelectorAll('.studio-root .sd-page.on .cp-att');
    const dst = blocks[blocks.length - 1];
    const r1 = dst?.getBoundingClientRect();
    if (!r1?.width || !r0.width) return;
    const g = document.createElement('img');
    g.src = mediaSrc(a, 'thumb'); g.className = 'sd-fly'; g.alt = '';
    Object.assign(g.style, { left: r1.left + 'px', top: r1.top + 'px', width: r1.width + 'px', height: r1.height + 'px' });
    document.body.appendChild(g);
    dst.style.opacity = '0';
    const an = g.animate([
      { transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px) scale(${r0.width / r1.width}, ${r0.height / r1.height})`, borderRadius: '9px' },
      { transform: 'none', borderRadius: getComputedStyle(dst).borderRadius || '10px' },
    ], { duration: SPRING_SOFT.ms + 60, easing: springEasing(SPRING_SOFT) });
    an.onfinish = an.oncancel = () => { g.remove(); dst.style.opacity = ''; };
  }

  // —— 菜单（右键 / 长按）——
  let menu = $state(null);
  function openMenu(a, anchor, at = null) { menu = { asset: a, anchor, at }; }

  // —— 无限滚动：滚到底拉下一页；拉回来还不满一屏就接着拉 ——
  let body = $state(), grid = $state();
  function onScroll() {
    if (!body || studio.assetsDone || studio.assetsLoading) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 320) loadAssets(false);
  }
  $effect(() => {
    studio.assets.length; studio.assetsLoading; wide;
    untrack(() => requestAnimationFrame(() => { if (body && tab === 'works' && body.scrollHeight <= body.clientHeight + 40) onScroll(); }));
  });

  // —— 展开 / 收起：格子从原位置 FLIP 到新位置（先量旧位置，DOM 换完再从旧位置弹到新位置；不 commitStyles，§12.8）——
  let prevWide;
  $effect.pre(() => {
    const w = wide;
    untrack(() => {
      if (prevWide === undefined || w === prevWide || drawer || !grid) { prevWide = w; return; }
      prevWide = w;
      if (quiet(grid)) return;
      const vb = body.getBoundingClientRect();
      const before = new Map();
      for (const el of grid.querySelectorAll('.sd-tile')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > vb.top - 80 && r.top < vb.bottom + 80) before.set(el, r);
      }
      tick().then(() => {
        let i = 0;
        for (const [el, a] of before) {
          if (!el.isConnected) continue;
          el._flip?.cancel();
          const b = el.getBoundingClientRect();
          if (!a.width || !b.width) continue;
          el._flip = el.animate([
            { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width})`, transformOrigin: '0 0' },
            { transform: 'none', transformOrigin: '0 0' },
          ], { duration: SPRING_SOFT.ms, easing: springEasing(SPRING_SOFT), delay: Math.min(160, i++ * 6), fill: 'backwards' });
        }
        for (const d of grid.querySelectorAll('.sd-day')) {
          if (w) d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 120, fill: 'backwards' });
        }
      });
    });
  });

  // —— 新作品：格子弹进来（任务在墙上原地显影完就是结果，不再飞进侧栏）——
  const offDone = onJobDone((job) => {
    const ids = (job.result || []).map((a) => a?.id).filter(Boolean);
    if (!ids.length) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const id of ids) {
        const el = grid?.querySelector(`.sd-tile[data-id="${CSS.escape(id)}"]`);
        if (!el || quiet(el)) continue;
        el.animate([{ transform: 'scale(.55)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: SPRING_POP.ms, easing: springEasing(SPRING_POP) });
      }
    }));
  });
  onDestroy(() => { offDone(); clearTimeout(qT); });

  const focusId = $derived(studio.focus?.asset?.id || '');
</script>

<div class="sd-shelf-in" class:wide>
  <header class="sd-band sd-shelf-hd">
    {#if !drawer}
      <button class="sd-ib" aria-label={open ? t('收起素材架') : t('展开素材架')} aria-expanded={open} onclick={() => ontoggle?.()}>{@html icon('side')}</button>
    {/if}
    {#if wide}
      <!-- 「作品 / 文件」是换视图不是选参数：纸面滑块（同顶栏），不用参数面板那种墨块 -->
      <div class="sd-shelf-seg" role="tablist" aria-label={t('素材架')}>
        <span class="sd-ss-puck" class:right={tab === 'files'} aria-hidden="true"></span>
        {#each TABS as x (x.value)}
          <button role="tab" class:on={tab === x.value} aria-selected={tab === x.value} tabindex={tab === x.value ? 0 : -1} onclick={() => setTab(x.value)}>{x.label}</button>
        {/each}
      </div>
      <span class="sd-shelf-gap"></span>
      {#if tab === 'works' && !searching}
        <button class="sd-ib" aria-label={t('搜索作品')} onclick={openSearch}>{@html icon('search')}</button>
      {/if}
      {#if drawer}
        <button class="sd-ib" aria-label={t('关闭')} onclick={() => onclose?.()}>{@html icon('close')}</button>
      {/if}
    {/if}
  </header>

  {#if pick && wide}
    <div class="sd-pickbar" role="status">
      <span>{t('选一张当{role}', { role: roleName(pick.role) })}</span>
      <button class="sd-ib" aria-label={t('取消挑选')} onclick={endPick}>{@html icon('close')}</button>
    </div>
  {/if}

  <div class="sd-shelf-pane" hidden={tab !== 'works'}>
    {#if searching && wide}
      <label class="sd-shelf-q">
        {@html icon('search')}
        <input bind:this={qEl} bind:value={studio.q} oninput={onQ} placeholder={t('搜提示词')}
          onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSearch(); } }} />
        <button class="sd-ib" aria-label={t('关闭搜索')} onclick={closeSearch}>{@html icon('close')}</button>
      </label>
    {/if}
    <div class="sd-shelf-body" bind:this={body} onscroll={onScroll} use:dragScrollGuard use:edgeFade={{ top: 16, bot: 20 }}>
      {#if !studio.assets.length}
        <div class="sd-shelf-empty">
          {#if studio.assetsLoading}<Measure tone="live" />
          {:else if wide}
            {#if studio.assetsErr}<p>{studio.assetsErr}</p><button class="sd-shelf-retry" onclick={() => loadAssets(true)}>{t('重试')}</button>
            {:else if studio.q}<p>{t('没有结果')}</p>
            {:else}<p>{t('还没有作品')}</p>{/if}
          {/if}
        </div>
      {/if}
      <div class="sd-sgrid" class:picking={!!pick} bind:this={grid}>
        {#each rows as r (r.key)}
          {#if r.day}
            <div class="sd-day">{r.label}</div>
          {:else}
            {@const a = r.a}
            <div class="sd-tile" class:dim={!pickable(a)} class:ok={!!pick && pickable(a)} class:on={focusId === a.id} class:flash={studio.flash === a.id}
              data-id={a.id} data-work={a.id} data-kind={a.kind} role="button" tabindex={pickable(a) ? 0 : -1} aria-disabled={!pickable(a) || null}
              aria-label={a.prompt || t('作品')} title={wide ? null : a.prompt || null}
              use:assetDrag={{ asset: a, onStay: (el) => openMenu(a, el) }}
              oncontextmenu={(e) => { if (e.pointerType !== 'touch') { e.preventDefault(); openMenu(a, e.currentTarget, { x: e.clientX, y: e.clientY }); } }}
              onclick={(e) => clickTile(e, a)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickTile(e, a); } }}>
              {#if visual(a.kind)}
                <Img src={mediaSrc(a, 'thumb')} alt="" loading="lazy" decoding="async" draggable="false" />
                {#if a.kind === 'video'}<span class="sd-tile-pl" aria-hidden="true">{@html icon('play')}</span>{/if}
              {:else if Array.isArray(a.peaks) && a.peaks.length}
                <span class="sd-tile-wv" aria-hidden="true"><svg viewBox="0 0 29 20">{#each bars(a.peaks) as b, i (i)}<rect x={b.x} y={b.y} width="1.8" height={b.h} rx=".9" />{/each}</svg></span>
              {:else}
                <span class="sd-tile-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{@html a.kind === 'music' ? KIND.music : KIND.voice}</svg></span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
      {#if studio.assets.length && studio.assetsLoading}<div class="sd-shelf-load"><Measure tone="live" /></div>{/if}
    </div>
  </div>

  {#if filesMounted}
    <div class="sd-shelf-pane sd-shelf-files" hidden={tab !== 'files' || !wide}>
      <div class="sd-embed">
        {#key target?.seq || 0}
          <WorkspaceEmbed wide ws="" initialPath={target ? target.dir : startDir} initialOpen={target?.open || ''} previewHost="app" onExit={() => setTab('works')} />
        {/key}
      </div>
    </div>
  {/if}

  {#if !drawer && !open}
    <footer class="sd-shelf-ft">
      <button class="sd-ib" aria-label={t('工作空间')} onclick={toFiles}>{@html icon('folder')}</button>
    </footer>
  {/if}
</div>

{#if menu}
  <WorkMenu asset={menu.asset} anchor={menu.anchor} at={menu.at} align="start" onclose={() => (menu = null)} />
{/if}
