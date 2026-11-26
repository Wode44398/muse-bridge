<script>
  // 打开一件（图像 / 视频，方案 §12.2「打开一件 Focus」）：看 studio.focus。墙上那张原地放大成焦点（FLIP），底下纸色盖住墙；
  // 下面：图像续改链的版本条（当前版墨圈；链上有一轮在跑时末格墨在晕、大图上盖一层墨，新一版从墨里显出来）、
  // 提示词、mono 元信息（模型 · 宽×高 · 用时 · 时间）、操作（重画 / 下载 / 接着做 / 更多）。
  // 点大图 = 核心查看器（能缩放）；视频就地播（简单控件，全屏走查看器）。返回 / Esc / 点空白关闭并飞回墙上原处。
  // 系统返回键由外壳接（浮层 → 焦点 → 挑选态 → 抽屉 → 主页）；Esc 在这里接（上面有浮层时让外壳先关浮层）。
  import { tick, untrack, onDestroy } from 'svelte';
  import { t, tc } from '../../../lib/i18n.js';
  import { layout } from '../../../lib/layout.svelte.js';
  import { openPreview, previewIsOpen, vertexAssetItem as vxItem } from '../../../lib/preview.svelte.js';
  import { studio, mediaSrc, closeFocus, rerun, retryJob, continueActions, modelLabelOf } from '../../../modules/studio/media.svelte.js';
  import { layerCount } from '../../../modules/studio/layers.js';
  import { showToast } from '../../../lib/toast.svelte.js';
  import { edgeFade } from '../../../modules/studio/edge.js';
  import { heal } from '../../../modules/studio/heal.js';
  import { create as inkCreate } from '../../../modules/studio/ink.js';
  import { icon } from '../../../modules/studio/icons.js';
  import { RATIO_GUESS, ratioOf } from '../../../modules/studio/masonry.js';
  import Img from '../ui/Img.svelte';
  import ErrCard from '../ui/ErrCard.svelte';
  import { anim, quiet, ease, EIN, EOUT, SPRING, SPRING_SOFT, glyph, inkTarget, seedOf } from './fx.js';
  import { mmss, stamp, tookOf } from './when.js';

  let { page, scroller = null, onlift = null, onmenu = null } = $props();

  const compact = $derived(layout.compact);
  let open = $state(null);        // 正在显示的焦点（关闭动画期间 studio.focus 已经清了，它还在）
  let shown = $state(null);       // 大图上现在是哪一版（续改显影完才换过去）
  let root = $state(), bgEl = $state(), mediaEl = $state(), infoEl = $state(), colW = $state(0), stageH = $state(0);
  let closing = null, opening = null;
  let natural = $state({});       // 作品 id → 高 / 宽（缺宽高时大图加载出来再定）
  let tileSrc = $state('');       // 墙上那张已经加载好的地址：飞起来那一下先用它，preview 到了再盖上

  const isVideo = $derived(shown?.kind === 'video');
  const ratio = $derived(ratioOf(shown?.w, shown?.h) ?? natural[shown?.id] ?? RATIO_GUESS);
  // 输入栏浮在底部（CreateFrame 在 .cf 上写 --cf-dock-h）：大图按「输入栏以上」的高度定，下面的提示词和操作一屏看得到
  let dockH = $state(160);
  // 输入栏长高（焦点里多了「接着改」那一块）时 CreateFrame 改写 .cf 上的变量：盯着它的 style 重量
  $effect(() => {
    if (!root) return;
    const read = () => { const v = parseFloat(getComputedStyle(root).getPropertyValue('--cf-dock-h')); if (v > 0 && Math.abs(v - dockH) > 1) dockH = v; };
    untrack(read);
    const cf = root.closest('.cf');
    if (!cf) return;
    const mo = new MutationObserver(read);
    mo.observe(cf, { attributes: true, attributeFilter: ['style'] });
    return () => mo.disconnect();
  });
  const box = $derived.by(() => {
    const maxW = Math.max(120, Math.min(colW || 0, 920));
    const H = stageH || 600;
    const maxH = Math.max(160, Math.min(H * (compact ? 0.52 : 0.62), H - dockH - (compact ? 150 : 170)));
    let w = maxW, h = w * ratio;
    if (h > maxH) { h = maxH; w = h / ratio; }
    return { w: Math.round(w), h: Math.round(h) };
  });

  const tileOf = (id) => (id && scroller ? scroller.querySelector(`.sw-tile[data-asset="${CSS.escape(id)}"]`) : null);
  function onScreen(r) {
    const s = scroller?.getBoundingClientRect();
    return !!(r && r.width && s && r.bottom > s.top + 8 && r.top < s.bottom - 8);
  }

  // —— 开 / 关 ——
  $effect(() => {
    const f = studio.focus?.page === page && studio.focus.asset ? studio.focus : null;
    const a = f?.asset;
    untrack(() => {
      if (f && !open) begin(f);
      else if (f && open && a && a.id !== shown?.id) toAsset(a);
      else if (!f && open && !closing) end();
    });
  });

  async function begin(f) {
    closing?.cancel?.(); closing = null;
    const tile = tileOf(f.asset.id);
    const img = tile?.querySelector('img');
    tileSrc = img?.complete && img.naturalWidth ? img.currentSrc || img.src : '';
    if (img?.naturalWidth && !ratioOf(f.asset.w, f.asset.h)) natural = { ...natural, [f.asset.id]: img.naturalHeight / img.naturalWidth };
    const from = tile?.getBoundingClientRect();
    open = f; shown = f.asset;
    await tick();
    if (!mediaEl || open !== f) return;
    const still = quiet(root);
    if (from && onScreen(from)) onlift?.(f.asset.id);
    anim(bgEl, [{ opacity: 0 }, { opacity: 1 }], { d: still ? 120 : 220, e: EOUT });
    if (!still && from && onScreen(from)) {
      const to = mediaEl.getBoundingClientRect();
      const sx = from.width / to.width, sy = from.height / to.height;
      opening = anim(mediaEl, [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})` }, { transform: 'none' }], { d: SPRING.ms, e: ease(SPRING) });
    } else if (!still) {
      opening = anim(mediaEl, [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { d: SPRING_SOFT.ms, e: ease(SPRING_SOFT) });
    }
    if (!still && infoEl) [...infoEl.children].forEach((c, i) => anim(c, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { d: SPRING_SOFT.ms, e: ease(SPRING_SOFT), delay: 90 + i * 45, fill: 'backwards' }));
    if (isVideo) setTimeout(() => { if (open === f) vid?.play().catch(() => {}); }, still ? 0 : SPRING.ms * 0.6);
  }

  function end() {
    const f = open;
    vid?.pause();
    stopInk();
    opening?.cancel(); opening = null;
    const done = () => { if (open === f) { open = null; shown = null; tileSrc = ''; closing = null; onlift?.(''); } };
    if (!mediaEl || quiet(root)) { done(); return; }
    const tile = tileOf(shown?.id);
    const to = tile?.getBoundingClientRect();
    anim(infoEl, [{ opacity: 1 }, { opacity: 0 }], { d: 110, e: EIN, fill: 'forwards' });
    anim(bgEl, [{ opacity: 1 }, { opacity: 0 }], { d: 260, e: EIN, delay: 60, fill: 'forwards' });
    let a;
    if (to && onScreen(to)) {
      onlift?.(shown.id);
      const from = mediaEl.getBoundingClientRect();
      const sx = to.width / from.width, sy = to.height / from.height;
      a = anim(mediaEl, [{ transform: 'none' }, { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${sx}, ${sy})` }], { d: SPRING_SOFT.ms, e: ease(SPRING_SOFT), fill: 'forwards' });
    } else {
      onlift?.('');
      a = anim(mediaEl, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { d: 180, e: EIN, fill: 'forwards' });
    }
    closing = a;
    if (!a) { done(); return; }
    a.finished.then(done).catch(() => {});
  }
  onDestroy(() => { stopInk(); if (open) onlift?.(''); });
  // Esc 关焦点（系统返回键由外壳接：浮层 → 焦点 → …）。上面还有浮层时让外壳先关浮层；正在输入框里打字时不抢
  function onKey(e) {
    // 核心查看器开在上面（点大图 / 视频全屏）时 Esc 是它的
    if (e.key !== 'Escape' || e.defaultPrevented || !open || closing || layerCount() || previewIsOpen()) return;
    if (studio.focus?.page !== page) return;
    const tg = e.target;
    if (tg?.isContentEditable || tg?.closest?.('input, textarea')) return;
    e.preventDefault();
    closeFocus();
  }

  // —— 版本条（图像续改链） ——
  const turns = $derived(page === 'image' ? studio.views?.image?.turns || [] : []);
  const versions = $derived.by(() => {
    const out = [];
    for (const tn of turns) {
      if (tn.assets?.length) for (const a of tn.assets) out.push({ id: a.id, asset: a });
      else if (tn.state === 'queued' || tn.state === 'running') out.push({ id: 'j:' + (tn.jobId || out.length), dev: true, jobId: tn.jobId });
    }
    return out;
  });
  const chain = $derived(versions.filter((x) => x.asset).map((x) => x.asset));
  const inChain = $derived(!!shown && chain.some((a) => a.id === shown.id));
  const devTurn = $derived(inChain ? [...turns].reverse().find((x) => x.state === 'queued' || x.state === 'running') || null : null);
  const devJob = $derived(devTurn?.jobId ? studio.jobs.find((j) => j.id === devTurn.jobId) || null : null);
  const errTurn = $derived(inChain && turns.at(-1)?.state === 'error' ? turns.at(-1) : null);
  const errJob = $derived(errTurn?.jobId ? studio.jobs.find((j) => j.id === errTurn.jobId) || null : null);
  const vIndex = $derived(chain.findIndex((a) => a.id === shown?.id));

  function pick(a) {
    if (!a || a.id === shown?.id || reveal) return;
    studio.focus = { page, asset: a };
  }

  // 换一版：新的从版本条那一侧轻轻推进来，旧的留在底下淡出（同一个取景框里换片）
  let layers = $state([]);        // [{ key, src, dir }]：大图的图层（最上面是当前版）
  let lseq = 0;
  $effect(() => {
    const a = shown;
    untrack(() => {
      if (!a || isVideo) { layers = []; return; }
      const src = mediaSrc(a, 'preview');
      if (layers.at(-1)?.src === src) return;
      const prevIdx = layers.at(-1)?.idx ?? -1, idx = chain.findIndex((x) => x.id === a.id);
      const dir = prevIdx >= 0 && idx >= 0 ? Math.sign(idx - prevIdx) : 0;
      layers = [...layers.slice(-1), { key: ++lseq, src, idx, dir, fresh: layers.length > 0 }];
    });
  });
  function layerIn(node, l) {
    if (!l.fresh || quiet(node)) { settleLayers(l.key); return; }
    const a = anim(node, [{ opacity: 0, transform: `translateX(${l.dir * 18}px) scale(1.01)` }, { opacity: 1, transform: 'none' }], { d: SPRING_SOFT.ms, e: ease(SPRING_SOFT) });
    if (a) a.finished.then(() => settleLayers(l.key)).catch(() => {}); else settleLayers(l.key);
  }
  function settleLayers(key) { const i = layers.findIndex((x) => x.key === key); if (i > 0) layers = layers.slice(i); }

  // 大图尺寸跟着换版变（比例不同）：从旧尺寸弹过去（scale 补，只动 transform）
  let lastBox = null, lastRatio = 0;
  $effect.pre(() => { box; if (mediaEl) lastBox = mediaEl.getBoundingClientRect(); });
  $effect(() => {
    const b = box, r = ratio;
    untrack(() => {
      const was = lastBox, rc = lastRatio && Math.abs(r - lastRatio) > 0.01;
      lastRatio = r;
      if (!rc || !was?.width || !mediaEl || quiet(root) || opening?.playState === 'running') return;
      const now = mediaEl.getBoundingClientRect();
      if (!now.width) return;
      anim(mediaEl, [{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px) scale(${was.width / now.width}, ${was.height / now.height})` }, { transform: 'none' }], { d: SPRING_SOFT.ms, e: ease(SPRING_SOFT) });
    });
  });

  // —— 续改在跑：大图上盖一层墨，版本条末格墨在晕；出了新一版就从墨里显出来，显完才把大图换过去 ——
  let inkCv = $state(), miniCv = $state();
  let ink = null, mini = null, raf = 0, last = 0, prog = 0, seed = 7;
  let reveal = $state(null);      // { asset, img, r0 }
  let devId = '';
  function startInk() { if (!raf && !quiet(root) && !document.hidden) raf = requestAnimationFrame(drawInk); }
  function dropInk() { ink?.dispose(); mini?.dispose(); ink = null; mini = null; }
  function stopInk() { if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
  function drawInk(now) {
    raf = 0;
    if (!open || !inkCv || !mediaEl) return;
    if (compact && now - last < 31) { startInk(); return; }
    const dt = last ? Math.min(100, now - last) : 16; last = now;
    const w = mediaEl.offsetWidth, h = mediaEl.offsetHeight;
    if (!ink || Math.abs(ink.w - w) > 1 || Math.abs(ink.h - h) > 1) { ink?.dispose(); ink = inkCreate(inkCv, { w, h, seed, grid: compact ? 64 : 96 }); }
    if (miniCv && !mini) mini = inkCreate(miniCv, { w: 52, h: 36, seed, grid: 32 });
    if (devJob) prog += (inkTarget(devJob) * 1.04 - prog) * (1 - Math.exp(-dt / 500));
    const r = reveal?.r0 ? Math.min(1, (now - reveal.r0) / 1600) : 0;
    const dark = !!root?.closest('.studio-root')?.classList.contains('dark');
    ink.draw({ t: now, progress: prog, reveal: r, img: reveal?.img, dark });
    mini?.draw({ t: now, progress: prog, reveal: r, img: reveal?.img, dark });
    if (reveal?.r0 && r >= 1) { finishReveal(); return; }
    startInk();
  }
  $effect(() => {
    const id = devTurn?.jobId || '';
    untrack(() => {
      if (id && id !== devId) { devId = id; seed = seedOf(id); prog = 0; dropInk(); tick().then(startInk); }
    });
  });
  // 新的一版到了（D 把焦点跟到最新一版）：在跑的那一轮出的就走显影，别的（点版本条）直接换
  function toAsset(a) {
    const fromDev = devId && turns.some((x) => x.jobId === devId && x.assets?.some((y) => y.id === a.id));
    if (!fromDev || quiet(root) || !raf && !inkCv) { devId = ''; stopInk(); reveal = null; shown = a; return; }
    if (reveal) return;
    const img = new Image();
    img.decoding = 'async';
    img.src = mediaSrc(a, 'preview');
    reveal = { asset: a, img, r0: 0 };
    img.decode().catch(() => {}).then(() => {
      if (!reveal || reveal.img !== img) return;
      if (!img.naturalWidth || document.hidden) { finishReveal(); return; }
      reveal.r0 = performance.now();
      startInk();
    });
  }
  function finishReveal() {
    const a = reveal?.asset;
    stopInk(); reveal = null; devId = ''; dropInk();
    if (a) { layers = [{ key: ++lseq, src: mediaSrc(a, 'preview'), idx: chain.findIndex((x) => x.id === a.id), dir: 0, fresh: false }]; shown = a; }
    if (studio.focus?.page === page && studio.focus.asset && studio.focus.asset.id !== shown?.id) toAsset(studio.focus.asset);
  }

  // —— 视频 ——
  let vid = $state(), vPlaying = $state(false), vMuted = $state(true), vCur = $state(0), vDur = $state(0);
  $effect(() => { shown; untrack(() => { vCur = 0; vDur = Number(shown?.duration) || 0; vPlaying = false; }); });
  function vToggle() { if (!vid) return; vid.paused ? vid.play().catch(() => {}) : vid.pause(); }
  function vSeek(e) {
    const bar = e.currentTarget;
    const go = (ev) => { const r = bar.getBoundingClientRect(); if (vid && vDur) vid.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * vDur; };
    go(e);
    bar.setPointerCapture?.(e.pointerId);
    const mv = (ev) => go(ev), up = () => { bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up); };
    bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  }
  function vFull() { vid?.pause(); openPreview([vxItem(shown, shown.prompt, tc('名词', '生成视频'), 'video')], 0); }

  // —— 点击 ——
  function mediaClick(e) {
    if (e.target.closest('.sf-vc')) return;
    if (isVideo) { vToggle(); return; }
    const list = inChain ? chain : [shown];
    openPreview(list.map((a) => vxItem(a, a.prompt, tc('名词', '生成图像'), 'image')), Math.max(0, list.findIndex((a) => a.id === shown.id)));
  }
  function blank(e) { if (e.target === e.currentTarget || e.target.classList?.contains('sf-col')) closeFocus(); }

  // —— 信息与操作 ——
  const job = $derived(shown?.jobId ? studio.jobs.find((j) => j.id === shown.jobId) : null);
  // 提示词先截几行（长提示词会把元信息和操作挤到输入栏底下，一屏看不到），点一下展开全文；换一件收回去
  let promptOpen = $state(false);
  $effect(() => { shown?.id; untrack(() => { promptOpen = false; }); });
  const bits = $derived(shown ? [
    modelLabelOf(shown),
    shown.w && shown.h ? `${shown.w}×${shown.h}` : '',
    isVideo && (shown.duration || vDur) ? mmss(shown.duration || vDur) : '',
    tookOf(job),
    stamp(shown.createdAt),
  ].filter(Boolean) : []);
  const conts = $derived(shown ? continueActions(shown) : []);
  function download() {
    const el = document.createElement('a');
    el.href = mediaSrc(shown); el.download = String(shown.prompt || 'studio').slice(0, 40);
    document.body.appendChild(el); el.click(); el.remove();
  }
  // 重画是另起一张：关掉焦点，墙最前面开一个新的取景框；模型不在了 rerun 会把参数放回输入栏，说一声
  async function redo() {
    const a = shown;
    closeFocus();
    const r = await rerun(a);
    if (!r?.ok && r?.error) showToast(r.error, r.reused ? undefined : 'err');
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open && shown}
  <div class="sf" class:compact bind:this={root} bind:clientHeight={stageH}>
    <div class="sf-bg" bind:this={bgEl}></div>
    <div class="sf-scroll" use:edgeFade={{ top: 18, bot: 0 }} onclick={blank} role="presentation">
      <div class="sf-col" bind:clientWidth={colW}>
        <div class="sf-media" class:video={isVideo} bind:this={mediaEl} style:width="{box.w}px" style:height="{box.h}px"
          role="button" tabindex="0" aria-label={isVideo ? (vPlaying ? t('暂停') : t('播放')) : t('放大查看')}
          onclick={mediaClick} onkeydown={(e) => { if (e.key === 'Enter') mediaClick(e); }}>
          {#if isVideo}
            <img class="sf-poster" src={tileSrc || mediaSrc(shown, 'preview')} alt="" aria-hidden="true" />
            {#key shown.id}
              <video bind:this={vid} src={mediaSrc(shown)} poster={mediaSrc(shown, 'preview')} playsinline loop muted={vMuted} preload="auto"
                use:heal={{ src: mediaSrc(shown) }}
                onplay={() => (vPlaying = true)} onpause={() => (vPlaying = false)}
                ontimeupdate={() => { if (vid) vCur = vid.currentTime || 0; }}
                onloadedmetadata={() => { if (vid && isFinite(vid.duration)) vDur = vid.duration; if (vid?.videoWidth && !ratioOf(shown.w, shown.h)) natural = { ...natural, [shown.id]: vid.videoHeight / vid.videoWidth }; }}></video>
            {/key}
            <div class="sf-vc" role="group" aria-label={t('播放控制')}>
              <button class="sf-vb" type="button" aria-label={vPlaying ? t('暂停') : t('播放')} onclick={vToggle}>{@html icon(vPlaying ? 'pause' : 'play')}</button>
              <div class="sf-bar" role="slider" tabindex="0" aria-label={t('进度')} aria-valuemin="0" aria-valuemax={Math.round(vDur)} aria-valuenow={Math.round(vCur)}
                onpointerdown={vSeek} style="--p:{vDur ? (vCur / vDur) * 100 : 0}%"><i></i></div>
              <span class="mono sf-vtime">{mmss(vCur)} / {mmss(vDur)}</span>
              <button class="sf-vb" type="button" aria-label={vMuted ? t('打开声音') : t('静音')} onclick={() => (vMuted = !vMuted)}>{@html glyph(vMuted ? 'mute' : 'volume')}</button>
              <button class="sf-vb" type="button" aria-label={t('全屏')} onclick={vFull}>{@html glyph('expand')}</button>
            </div>
          {:else}
            {#if tileSrc}<img class="sf-under" src={tileSrc} alt="" aria-hidden="true" />{/if}
            {#each layers as l (l.key)}
              <div class="sf-layer" use:layerIn={l}>
                <Img src={l.src} alt={String(shown.prompt || '').slice(0, 80)} label decoding="async" draggable="false"
                  onload={(e) => { const im = e.currentTarget; if (im?.naturalWidth && !ratioOf(shown.w, shown.h) && !natural[shown.id]) natural = { ...natural, [shown.id]: im.naturalHeight / im.naturalWidth }; }} />
              </div>
            {/each}
            {#if devTurn || reveal}<canvas class="sf-ink" bind:this={inkCv} aria-hidden="true"></canvas>{/if}
          {/if}
        </div>

        <div class="sf-info" bind:this={infoEl}>
          {#if inChain && (versions.length > 1 || devTurn)}
            <div class="sf-strip" role="tablist" aria-label={t('版本')}>
              {#each versions as v (v.id)}
                {#if v.asset}
                  <button class="sf-vt" class:on={v.asset.id === shown.id} role="tab" aria-selected={v.asset.id === shown.id}
                    aria-label={t('第 {n} 版', { n: chain.indexOf(v.asset) + 1 })} onclick={() => pick(v.asset)}>
                    <Img src={mediaSrc(v.asset, 'thumb')} alt="" passive draggable="false" />
                  </button>
                {:else}
                  <span class="sf-vt dev" aria-label={t('显影中')}><canvas bind:this={miniCv} aria-hidden="true"></canvas></span>
                {/if}
              {/each}
              <span class="sf-vn">{devTurn ? t('第 {n} 版 · 显影中', { n: versions.length }) : t('第 {n} 版 · 共 {m} 版', { n: vIndex + 1, m: chain.length })}</span>
            </div>
          {/if}
          {#if errTurn && !devTurn}
            <ErrCard error={errTurn.error || errJob?.error || ''} page="image" prompt={errTurn.prompt || ''} onretry={errJob ? () => retryJob(errJob) : null} />
          {/if}
          {#if shown.prompt}<div class="sf-prompt sel-text" class:open={promptOpen} role="button" tabindex="0" aria-expanded={promptOpen}
            onclick={() => (promptOpen = !promptOpen)} onkeydown={(e) => { if (e.key === 'Enter') promptOpen = !promptOpen; }}>{shown.prompt}</div>{/if}
          <div class="sf-meta mono">{#each bits as b, i (i)}<span>{b}</span>{/each}</div>
          <div class="sf-acts">
            <button class="sf-b" type="button" onclick={redo}>{@html icon('reuse')}<span>{t('重画')}</span></button>
            <button class="sf-b" type="button" onclick={download}>{@html icon('download')}<span>{t('下载')}</span></button>
            {#if conts.length}
              <button class="sf-b" type="button" aria-haspopup="menu" onclick={(e) => onmenu?.({ asset: shown, anchor: e.currentTarget, only: 'continue', align: 'start' })}>{@html icon('next')}<span>{t('接着做')}</span></button>
            {/if}
            <button class="sf-b icon" type="button" aria-label={t('更多')} title={t('更多')} aria-haspopup="menu" onclick={(e) => onmenu?.({ asset: shown, anchor: e.currentTarget, align: 'start' })}>{@html icon('more')}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
{/if}
