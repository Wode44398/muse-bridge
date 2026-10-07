<script module>
  // 新版 Claude Code（桌面端 2.26454 /code 页 TurnStatus 的 clay「WorkingMark」）运行标记——
  // 移植自官方 shared-frame（xA/_A 状态机）+ c8677db5f（雪碧图表）。素材是官方原始 48px 位图
  // 雪碧图（陶土色已烘焙），放在 public/logo-animations/clay/<body>.<in|loop|out>.png 与 grow.png。
  //
  // 机制：每个「身体」(default/think/search/read/code/write/compose/blocked，sphere=default 的别名)
  // 有 in → loop → out 三段；起步从一颗小圆点 grow 长出来。活动切换时：
  //   · think / code 的 loop 有 seams（衔接帧），等到下一个 seam 再出场，不硬切；
  //   · default / sphere / blocked 或要切到 blocked：剩余 >1.5s 就截取 loop 末 20 帧当 tail 收尾，
  //     并把当前帧做成快照层、新层 300ms 渐显（交叉淡化），否则播完这圈再出场；
  //   · 其余身体播完整圈再出场。
  // 播放与旧星标同一手法：Web Animations API 逐帧 translateY + steps(n, jump-none)。
  const BASE = import.meta.env.BASE_URL;
  const S = 33.3333;
  const SHEETS = {
    'blocked.in': { frames: 16 }, 'blocked.loop': { frames: 30, rest: 0 }, 'blocked.out': { frames: 16 },
    'code.in': { frames: 16 }, 'code.loop': { frames: 75, seams: [18, 37, 56], rest: 74 }, 'code.out': { frames: 9 },
    'default.in': { frames: 16 }, 'default.loop': { frames: 40, rest: 38 }, 'default.out': { frames: 14 },
    grow: { frames: 10 },
    'compose.in': { frames: 16 }, 'compose.loop': { frames: 62, rest: 49 }, 'compose.out': { frames: 12 },
    'read.in': { frames: 21 }, 'read.loop': { frames: 60, rest: 44 }, 'read.out': { frames: 19 },
    'search.in': { frames: 16 }, 'search.loop': { frames: 20, rest: 4 }, 'search.out': { frames: 14 },
    'think.in': { frames: 16 }, 'think.loop': { frames: 110, seams: [54], rest: 95 }, 'think.out': { frames: 15 },
    'write.in': { frames: 31 }, 'write.loop': { frames: 60, rest: 36 }, 'write.out': { frames: 14 },
  };
  for (const k of ['in', 'loop', 'out']) SHEETS[`sphere.${k}`] = SHEETS[`default.${k}`];
  const fileOf = (k) => (k.startsWith('sphere.') ? 'default.' + k.slice(7) : k);
  const urlOf = (k) => `${BASE}logo-animations/clay/${fileOf(k)}.png`;

  // —— 雪碧图解码（模块级共享）：先解码 grow + 常驻四身体，齐了即可开播；其余身体后台按组补 ——
  const PRIMARY = ['sphere', 'default', 'think', 'blocked'];
  const trio = (b) => [`${b}.in`, `${b}.loop`, `${b}.out`];
  const decoded = new Set();
  const listeners = new Set();
  let resident = false, loading = null;
  const notify = () => { for (const f of listeners) f(); };
  function decode(k) {
    if (typeof Image === 'undefined') return Promise.resolve();
    const img = new Image();
    img.src = urlOf(k);
    return img.decode().then(() => { decoded.add(k); });
  }
  function loadSheets() {
    if (resident) return Promise.resolve();
    return (loading ||= Promise.all(['grow', ...PRIMARY.flatMap(trio)].map(decode)).then(() => {
      resident = true;
      notify();
      for (const b of ['search', 'read', 'code', 'write', 'compose']) Promise.all(trio(b).map(decode)).then(notify, () => {});
    }).catch(() => { loading = null; }));
  }
  const ready = (b) => trio(b).every((k) => decoded.has(k));

  // —— 跨实例接续：上一颗标记卸载 ≤500ms 内新挂的一颗从它的进度续播（不再从圆点长出来）——
  const live = new Set();
  let lastLeft = null;
  function resumePoint(now) {
    let r = null;
    for (const x of live) r = x;
    if (!r && lastLeft && now - (lastLeft.leftAt ?? now) <= 500) r = lastLeft;
    if (!r) return undefined;
    return r.stage ? { kind: r.stage.kind, body: r.stage.body, ms: now - r.stage.since } : 'dot';
  }

  const keyOf = (st) => (st.kind === 'grow' ? 'grow' : `${st.body}.${st.kind === 'tail' ? 'loop' : st.kind}`);
  const TAIL = 20;
  const tailRange = (frames) => [Math.max(0, frames - TAIL), frames];
  function advance(st, want) {
    switch (st.kind) {
      case 'grow': return { kind: 'in', body: want };
      case 'tail': return st.body === want ? { kind: 'loop', body: st.body } : { kind: 'out', body: st.body };
      case 'in': return st.body === 'sphere' && want !== 'sphere' ? { kind: 'out', body: 'sphere' } : { kind: 'loop', body: st.body };
      case 'loop': return st.body === want ? st : { kind: 'out', body: st.body };
      case 'out': return { kind: 'in', body: want };
    }
  }
  const entryOf = (b) => (b === 'sphere' ? { kind: 'loop', body: 'sphere' } : { kind: 'in', body: b });
</script>

<script>
  import { onMount, untrack } from 'svelte';

  // activity: default|think|search|read|code|write|compose；state: working|blocked|tile
  let { activity = 'default', state: markState = 'working', paused = false, size = 20, box = size, standalone = false } = $props();

  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ver = $state(0);                 // 雪碧图解码进度变化 → 重算可用身体
  let sheetsOk = $state(resident);
  const resume = resumePoint(performance.now());
  const fromDot = resume === undefined || resume === 'dot';
  let playing = $state(false);
  let dotGone = $state(false);
  let stage = $state(null);
  let iter = $state(0);
  let snap = $state(null);             // 交叉淡化的快照层 { key, frame }
  let failed = $state(false);
  let keys = $state([]);
  let root = $state(null);
  let anim = null, stageAt = 0, firstFrame = 0;
  const rec = { stage: null, leftAt: null };

  const want = $derived.by(() => {
    ver;
    const a = activity === 'compose' && !ready('compose') ? 'write' : activity;
    const r = markState === 'blocked' ? 'blocked' : markState === 'tile' ? 'sphere' : a;
    return ready(r) ? r : ready('default') ? 'default' : 'sphere';
  });
  const still = $derived(reduce || failed);

  const raf2 = (f) => { let id = requestAnimationFrame(() => { id = requestAnimationFrame(f); }); return () => cancelAnimationFrame(id); };

  onMount(() => {
    const on = () => { sheetsOk = resident; ver++; };
    listeners.add(on);
    if (!resident) loadSheets();
    if (!standalone) { rec.leftAt = null; live.add(rec); }
    return () => {
      listeners.delete(on);
      if (!standalone) { rec.leftAt = performance.now(); live.delete(rec); lastLeft = rec; }
    };
  });

  // 解码齐 → 开播。从圆点起步时隔两帧再开（先让圆点落地一帧，官方同款）。
  $effect(() => {
    if (!sheetsOk || playing) return;
    const go = () => {
      let st = null;
      if (resume && resume !== 'dot') {
        const ms = Math.max(0, resume.ms);
        if (resume.kind === 'grow') st = { kind: 'grow' };
        else if (resume.body && ready(resume.body)) st = resume.kind === 'tail' ? { kind: 'out', body: resume.body } : { kind: resume.kind, body: resume.body };
        if (st && resume.kind !== 'tail') {
          const info = SHEETS[keyOf(st)];
          const n = Math.floor(ms / S);
          firstFrame = st.kind === 'loop' ? n % info.frames : Math.min(info.frames - 1, n);
        }
      }
      stage = st ?? (fromDot ? { kind: 'grow' } : entryOf(untrack(() => want)));
      playing = true;
    };
    if (fromDot && !reduce) return raf2(go);
    go();
  });
  $effect(() => { if (playing && !dotGone) return raf2(() => { dotGone = true; }); });

  // 要挂着的层：当前、下一段、want 的入场、sphere 出入、want 的 loop、快照——只增不减，
  // 图层常驻（不可见层 opacity .001）免得切段时现解码闪一下。
  $effect.pre(() => {
    if (!stage) return;
    const cur = still ? `${want}.loop` : keyOf(stage);
    const need = [cur, keyOf(advance(still ? { kind: 'loop', body: want } : stage, want)), keyOf(entryOf(want)), 'sphere.in', 'sphere.out'];
    if (want !== 'sphere') need.push(`${want}.loop`);
    if (snap) need.push(snap.key);
    const have = untrack(() => keys);
    const miss = [...new Set(need)].filter((k) => !have.includes(k));
    if (miss.length) keys = [...have, ...miss];
  });

  const curKey = $derived(stage ? (still ? `${want}.loop` : keyOf(stage)) : null);
  const curFrame = $derived.by(() => {
    if (!stage) return 0;
    const L = SHEETS[curKey].frames;
    if (still) return SHEETS[curKey].rest ?? Math.floor(L / 3);
    return stage.kind === 'tail' ? tailRange(L)[0] : 0;
  });

  // 播当前段：一段一个 one-shot 动画，播完按状态机推进（同段 loop 继续 = iter+1 重播）。
  $effect(() => {
    const st = stage;
    iter;
    if (!st || still || !root) return;
    const key = keyOf(st);
    const el = root.querySelector(`[data-k="${key}"] .strip`);
    if (!el || typeof el.animate !== 'function') return;
    const L = SHEETS[key].frames;
    const [a, b] = st.kind === 'tail' ? tailRange(L) : [0, L];
    const n = b - a;
    let an;
    try {
      an = el.animate(Array.from({ length: n }, (_, i) => ({ transform: `translateY(${-(a + i) * size}px)` })),
        { duration: S * n, iterations: 1, easing: n > 1 ? `steps(${n}, jump-none)` : 'linear', fill: 'forwards' });
    } catch { failed = true; return; }
    anim = an;
    if (stageAt === 0 || (st.kind !== 'loop' && st.kind !== 'out')) stageAt = performance.now();
    const skip = firstFrame * S;
    firstFrame = 0;
    if (skip > 0) an.currentTime = skip;
    rec.stage = { kind: st.kind, body: st.kind === 'grow' ? null : st.body, since: performance.now() - skip };
    if (untrack(() => paused)) an.pause();
    let alive = true;
    an.finished.then(() => {
      if (!alive) return;
      const nx = advance(st, untrack(() => want));
      if (nx === st) iter++; else stage = nx;
    }).catch(() => {});
    return () => { alive = false; if (anim === an) anim = null; an.cancel(); };
  });

  // 活动变了而当前在 loop：按身体选出场时机（见顶部注释）。
  $effect(() => {
    const st = stage, w = want;
    if (!st || st.kind !== 'loop' || st.body === w || still) return;
    const info = SHEETS[keyOf(st)];
    const quick = w === 'blocked' || st.body === 'blocked' || st.body === 'default' || st.body === 'sphere';
    const an = anim;
    if (!an || an.currentTime == null) return;
    const t = Number(an.currentTime);
    if (!quick) {
      const at = (info.seams || []).map((s) => s * S).find((x) => x > t + 50);
      if (at === undefined) return;
      const id = setTimeout(() => { if (untrack(() => want) !== st.body) stage = { kind: 'out', body: st.body }; }, at - t);
      return () => clearTimeout(id);
    }
    if (S * info.frames - t <= 1500) return;
    snap = { key: keyOf(st), frame: Math.min(info.frames - 1, Math.floor(t / S)) };
    stage = st.body === 'sphere' ? { kind: 'out', body: 'sphere' } : { kind: 'tail', body: st.body };
  });
  $effect(() => {
    if (!snap) return;
    const id = setTimeout(() => { snap = null; }, 360);
    const layer = root?.querySelector(`[data-k="${curKey}"]`);
    const f = still || !layer?.animate ? null : layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-in-out' });
    return () => { clearTimeout(id); f?.cancel(); };
  });
  $effect(() => {
    const p = paused;
    const an = anim;
    if (!an) return;
    if (p) an.pause(); else if (an.playState === 'paused') an.play();
  });

  const renderKeys = $derived(curKey && !keys.includes(curKey) ? [...keys, curKey] : keys);
  const off = $derived((box - size) / 2);
</script>

<span class="cwm" style="width:{box}px;height:{box}px" aria-hidden="true" data-cds="WorkingMark">
  {#if !playing || (fromDot && !dotGone && !reduce)}
    <span class="dot" style="width:{size * 0.35}px;height:{size * 0.35}px"></span>
  {/if}
  {#if playing}
    <span class="stage" bind:this={root} style="left:{off}px;top:{off}px;width:{size}px;height:{size}px">
      {#if snap && !still}
        <span class="layer"><span class="strip" style="width:{size}px;height:{SHEETS[snap.key].frames * size}px;background-image:url({urlOf(snap.key)});transform:translateY({-snap.frame * size}px)"></span></span>
      {/if}
      {#each renderKeys as k (k)}
        {@const on = k === curKey}
        <span class="layer" data-k={k} style="opacity:{on ? '' : 0.001};z-index:{on ? 1 : 'auto'}">
          <span class="strip" class:hot={on && !still} style="width:{size}px;height:{SHEETS[k].frames * size}px;background-image:url({urlOf(k)});transform:translateY({-(on ? curFrame : 0) * size}px)"></span>
        </span>
      {/each}
    </span>
  {/if}
</span>

<style>
  .cwm { position: relative; display: inline-block; flex: none; user-select: none; line-height: 0; }
  .dot { position: absolute; inset: 0; margin: auto; border-radius: 50%; background: #d97757; }
  .stage { position: absolute; display: block; }
  .layer { position: absolute; inset: 0; overflow: clip; display: block; }
  .strip { display: block; background-size: 100% 100%; background-repeat: no-repeat; }
  .strip.hot { will-change: transform; box-shadow: inset 0 0 0 1px transparent; }
</style>
