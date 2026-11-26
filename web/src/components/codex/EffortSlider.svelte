<script>
  // 强度滑杆（模型选择器上半截）。样子照官方 ChatGPT 那条（24px 轨道、4px 档点、28px 白色滑块、按下放大到 32），
  // 手感自己做：
  //   拖动——滑块和填充 1:1 跟手（指针捕获 + 每帧只写 transform，拖动中没有 CSS 过渡拖后腿）；
  //   越过两端——橡皮筋，越拉越紧，滑块顺着拉的方向轻轻拉长；
  //   松手——按松手速度往前投射选档，再用真弹簧（带着松手速度）落进去；
  //   点轨道——滑块用临界阻尼的弹簧追到手指下面，追上后接着 1:1 跟手；
  //   每过一档——触觉 tick + 标签滚一位，挨近的档点轻轻鼓起；
  //   任何时候按住滑块都从它此刻的位置接着走（弹簧可打断）。
  // 纯数学在 lib/codex/picker/slider-math.js（有单测）。
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { codex, findModel, selectModel, effortLabel } from '../../lib/codex/store.svelte.js';
  import { roll, reduced, anim, EASE } from '../../lib/codex/motion.js';
  import { haptic } from '../../lib/codex/feedback.js';
  import {
    THUMB, stopXs, pOf, fillRight, clampRubber, nearestStop, liveIndex, springStep, settled, velocity, dotSwell,
  } from '../../lib/codex/picker/slider-math.js';
  import Icon from './Icon.svelte';

  // 松手吸附：ζ≈0.8，落定前轻轻过冲一点（约 1.5%），像卡进槽里
  const SNAP = { k: 560, c: 38 };
  // 点轨道后追手指：临界阻尼，不过冲，追上就交给手指
  const CHASE = { k: 900, c: 60 };
  // 橡皮筋最多让滑块越出半个身位
  const RUBBER = 14;
  const VMAX = 2600;

  const model = $derived(findModel(codex.model));
  const efforts = $derived(model?.efforts || []);
  const n = $derived(efforts.length);
  const canFast = $derived(!!model?.fast);
  const fastOn = $derived(canFast && !!codex.fast);
  const selIdx = $derived(Math.max(0, efforts.indexOf(codex.effort)));

  let root = $state(null);
  let W = $state(0);
  const stops = $derived(n > 1 && W > 0 ? stopXs(n, W) : []);

  let thumbEl = $state(null);
  let stretchEl = $state(null);
  let rangeEl = $state(null);
  let sheenEl = $state(null);
  let labelEl = $state(null);
  // 档点元素表只给拖动时逐帧改样式用，不参与渲染：用动作登记，别做成响应式（拖动时每帧都在读）
  const dotEls = {};
  function regDot(node, key) {
    dotEls[key] = node;
    return {
      update(next) { if (dotEls[key] === node) delete dotEls[key]; key = next; dotEls[key] = node; },
      destroy() { if (dotEls[key] === node) delete dotEls[key]; },
    };
  }
  let pressed = $state(false);
  let ready = $state(false);
  let ariaIdx = $state(-1);

  // 物理状态不进响应式：每帧都在变，只由 paint() 直接写到 DOM
  const S = {
    x: NaN, v: 0, target: NaN, mode: 'idle', user: false,
    px: 0, grab: 0, pid: -1, left: 0, scale: 1, samples: [],
    raf: 0, last: 0, idx: -1, on: [], sw: [], w: 0, key: '',
  };

  const label = (i) => effortLabel(efforts[i]);
  function setLabel(text, dir, instant = false) {
    if (!labelEl || labelEl.__roll === text) return;
    roll(labelEl, text, { align: 'left', dir, instant });
  }

  /* ---------------- 绘制：只写 transform / class，不读布局 ---------------- */
  function paint() {
    if (!thumbEl || !rangeEl || !(W > 0) || stops.length < 2) return;
    const lo = stops[0], hi = stops[stops.length - 1], x = S.x;
    thumbEl.style.transform = `translate3d(${(x - THUMB / 2).toFixed(2)}px,-50%,0)`;
    if (stretchEl) {
      const over = x < lo ? lo - x : x > hi ? x - hi : 0;
      const k = over / RUBBER;
      stretchEl.style.transform = k > 0.002 ? `scale(${(1 + 0.12 * k).toFixed(4)},${(1 - 0.07 * k).toFixed(4)})` : '';
      stretchEl.style.transformOrigin = x < lo ? '100% 50%' : '0% 50%';
    }
    const p = Math.min(1, Math.max(0, pOf(x, W)));
    rangeEl.style.transform = `translate3d(${(fillRight(p, n, W) - W).toFixed(2)}px,0,0)`;
    for (let i = 0; i < n; i++) {
      const el = dotEls[efforts[i]];
      if (!el) continue;
      const sw = dotSwell(stops[i] - x);
      if (Math.abs((S.sw[i] ?? 1) - sw) > 0.004) { el.style.transform = sw > 1.001 ? `scale(${sw.toFixed(3)})` : ''; S.sw[i] = sw; }
      const on = stops[i] <= x + 0.5;
      if (S.on[i] !== on) { el.classList.toggle('on', on); S.on[i] = on; }
    }
    const idx = liveIndex(x, stops, S.idx);
    if (idx !== S.idx) {
      const prev = S.idx;
      S.idx = idx;
      if (S.user && prev >= 0) {
        haptic('tick');
        // 拖动中标签跟着手指走；松手后的弹簧已经把标签定在目标档，路过中间档只震不改字
        if (S.mode === 'drag' || S.mode === 'chase') {
          setLabel(label(idx), idx < prev ? 'down' : 'up');
          ariaIdx = idx;
        }
      }
    }
  }

  /* ---------------- 每帧推进 ---------------- */
  function kick() {
    if (S.raf) return;
    S.last = performance.now();
    S.raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    S.raf = 0;
    if (stops.length < 2) return;
    const dt = Math.min(0.064, Math.max(0, (now - S.last) / 1000));
    S.last = now;
    const lo = stops[0], hi = stops[stops.length - 1];
    if (S.mode === 'drag') {
      S.x = clampRubber(S.px - S.grab, lo, hi, RUBBER);
    } else if (S.mode === 'chase') {
      const aim = clampRubber(S.px, lo, hi, RUBBER);
      const s = springStep(S, aim, CHASE, dt);
      S.x = s.x; S.v = s.v;
      // 追上了：交给手指，之后 1:1
      if (Math.abs(S.x - aim) < 0.6) { S.mode = 'drag'; S.grab = 0; S.x = aim; }
    } else if (S.mode === 'spring') {
      const s = springStep(S, S.target, SNAP, dt);
      S.x = s.x; S.v = s.v;
      if (settled(S, S.target)) { S.x = S.target; S.v = 0; S.mode = 'idle'; S.user = false; }
    }
    paint();
    if (S.mode === 'chase' || S.mode === 'spring') S.raf = requestAnimationFrame(frame);
  }

  /** 落到第 idx 档（松手、键盘、点轨道都走这里）；commit = 写回选择。 */
  function settle(idx, commit) {
    if (idx < 0 || idx >= stops.length) return;
    S.target = stops[idx];
    S.user = true;
    ariaIdx = idx;
    setLabel(label(idx), idx < S.idx ? 'down' : 'up');
    if (reduced()) { S.x = S.target; S.v = 0; S.mode = 'idle'; paint(); S.user = false; }
    else { S.mode = 'spring'; kick(); }
    if (commit && efforts[idx] && efforts[idx] !== codex.effort) selectModel({ effort: efforts[idx] });
  }

  /* ---------------- 指针 ---------------- */
  const localX = (e) => (e.clientX - S.left) / S.scale;

  function onDown(e) {
    if (stops.length < 2 || S.pid >= 0) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 弹层进场时整体在缩放：按实际缩放比把屏幕坐标换回轨道坐标
    const r = root.getBoundingClientRect();
    S.left = r.left;
    S.scale = r.width / (root.offsetWidth || r.width) || 1;
    S.pid = e.pointerId;
    try { root.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    root.focus({ preventScroll: true });
    const lx = localX(e);
    S.px = lx;
    S.samples = [{ t: performance.now(), x: lx }];
    S.user = true;
    if (Number.isFinite(S.x) && Math.abs(lx - S.x) <= THUMB / 2 + 4) {
      // 抓住滑块：从它此刻的位置接着走（弹簧到一半也一样），手指和滑块的相对位置保持不变
      S.mode = 'drag';
      S.grab = lx - S.x;
      S.v = 0;
    } else {
      S.mode = reduced() ? 'drag' : 'chase';
      S.grab = 0;
      if (!Number.isFinite(S.v)) S.v = 0;
    }
    pressed = true;
    kick();
  }

  function onMove(e) {
    if (e.pointerId !== S.pid) return;
    const lx = localX(e);
    S.px = lx;
    const now = performance.now();
    S.samples.push({ t: now, x: lx });
    while (S.samples.length > 2 && now - S.samples[0].t > 120) S.samples.shift();
    kick();
  }

  function onUp(e, cancel = false) {
    if (S.pid < 0 || (e && e.pointerId !== S.pid)) return;
    const pid = S.pid;
    // 先清掉再放捕获：放捕获会同步派发 lostpointercapture，别让它再进来一次
    S.pid = -1;
    try { root?.releasePointerCapture(pid); } catch {}
    pressed = false;
    if (stops.length < 2) return;
    const lo = stops[0], hi = stops[stops.length - 1];
    const v = cancel ? 0 : Math.max(-VMAX, Math.min(VMAX, velocity(S.samples, performance.now())));
    let idx;
    if (S.mode === 'chase') idx = nearestStop(Math.min(hi, Math.max(lo, S.px)), v, stops);
    else {
      // 当前帧可能还没画：先把手指最后的位置落实
      S.x = clampRubber(S.px - S.grab, lo, hi, RUBBER);
      idx = nearestStop(S.x, v, stops);
      // 橡皮筋区里滑块比手指慢得多，带着手指的速度弹回去会过头
      S.v = S.x < lo || S.x > hi ? 0 : v;
    }
    settle(idx, true);
  }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    if (stops.length < 2) return;
    const cur = S.mode === 'spring' ? nearestStop(S.target, 0, stops) : selIdx;
    let i;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': i = cur + 1; break;
      case 'ArrowLeft': case 'ArrowDown': i = cur - 1; break;
      case 'PageUp': i = cur + 2; break;
      case 'PageDown': i = cur - 2; break;
      case 'Home': i = 0; break;
      case 'End': i = n - 1; break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
    const clamped = Math.max(0, Math.min(n - 1, i));
    if (clamped === cur) {
      // 到头了：朝墙轻轻撞一下再弹回，告诉你没有更多档
      if (!reduced() && i !== cur) {
        S.user = false;
        S.target = stops[cur];
        S.v = Math.sign(i - cur) * 420;
        S.mode = 'spring';
        kick();
      }
      return;
    }
    settle(clamped, true);
  }

  /* ---------------- 外部变化：换模型、别处改了强度、尺寸变了 ---------------- */
  $effect(() => {
    const list = stops;
    const i = selIdx;
    const key = efforts.join(',');
    if (list.length < 2) return;
    untrack(() => sync(list, i, key));
  });

  function sync(list, i, key) {
    const x = list[i];
    const resized = S.w !== W;
    const remodel = S.key !== key;
    S.w = W;
    if (remodel) { S.key = key; S.on = []; S.sw = []; }
    if (S.mode === 'drag' || S.mode === 'chase') { paint(); return; }
    ariaIdx = i;
    // 首次画、尺寸变了（转屏、弹层换宽）、减少动态效果：直接到位
    if (!Number.isFinite(S.x) || (resized && !remodel) || reduced()) {
      S.x = S.target = x; S.v = 0; S.mode = 'idle'; S.idx = i; S.user = false;
      paint();
      setLabel(label(i), 'up', true);
      if (!ready) requestAnimationFrame(() => { ready = true; });
      return;
    }
    // 换了模型：档点挪位（CSS 过渡），滑块用同一条弹簧滑到新位置；不算你拨的，不震
    if (remodel) { S.idx = liveIndex(S.x, list, -1); }
    if (S.mode === 'spring' && S.target === x) return;
    if (S.mode === 'idle' && Math.abs(S.x - x) < 0.01) { paint(); setLabel(label(i)); return; }
    S.target = x;
    S.user = false;
    S.mode = 'spring';
    setLabel(label(i), S.x > x ? 'down' : 'up');
    kick();
  }

  // 只有一档 / 没有模型时也要让标签显示当前值
  $effect(() => {
    const text = n ? effortLabel(codex.effort) : '';
    if (!labelEl || n > 1) return;
    untrack(() => setLabel(text, 'up', !labelEl.__roll));
  });

  $effect(() => {
    if (!root) return;
    W = root.offsetWidth;
    const ro = new ResizeObserver(() => { if (root) W = root.offsetWidth; });
    ro.observe(root);
    return () => { ro.disconnect(); if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; };
  });

  /* ---------------- Fast ---------------- */
  function toggleFast(e) {
    const on = !codex.fast;
    selectModel({ fast: on });
    haptic('tick');
    const ico = e.currentTarget.querySelector('svg');
    if (ico) anim(ico, [{ transform: 'scale(.6) rotate(-12deg)' }, { transform: 'scale(1.18) rotate(6deg)', offset: 0.55 }, { transform: 'none' }], { dur: 420, ease: EASE.out });
    // 打开那一下：一道亮光从填充的起点扫到滑块，只扫一次
    if (on && sheenEl && !reduced() && W > 0) {
      const fr = fillRight(Math.min(1, Math.max(0, pOf(S.x, W))), n, W);
      const from = W - fr - 40, to = W + 8;
      anim(sheenEl, [
        { transform: `translate3d(${from}px,0,0)`, opacity: 0 },
        { opacity: 1, offset: 0.25 },
        { transform: `translate3d(${to}px,0,0)`, opacity: 0 },
      ], { dur: 640, ease: EASE.io, fill: 'none' });
    }
  }

  /* ---------------- 档点进出（换模型时） ---------------- */
  function dotIn() {
    if (reduced()) return { duration: 0 };
    return { duration: 260, delay: 60, css: (k) => `opacity:${k};scale:${0.2 + 0.8 * k}` };
  }
  function dotOut() {
    if (reduced()) return { duration: 0 };
    return { duration: 140, css: (k) => `opacity:${k};scale:${0.4 + 0.6 * k}` };
  }
  function fastOut() {
    if (reduced()) return { duration: 0 };
    return { duration: 120, css: (k) => `opacity:${k};transform:scale(${0.92 + 0.08 * k})` };
  }
  function fastIn() {
    if (reduced()) return { duration: 0 };
    return { duration: 300, easing: (k) => 1 - Math.pow(1 - k, 3), css: (k) => `opacity:${k};transform:scale(${0.86 + 0.14 * k})` };
  }
</script>

<div class="pk-top">
  <b>{t('强度')}</b>
  <span class="sub roll" bind:this={labelEl} aria-hidden={n > 1 ? 'true' : undefined}></span>
  {#if canFast}
    <button
      type="button"
      class="pk-fast"
      aria-pressed={fastOn}
      title={t('Fast：同样的模型更快出结果，用量消耗更多')}
      onclick={toggleFast}
      in:fastIn
      out:fastOut
    ><Icon name="bolt" />Fast</button>
  {/if}
</div>

{#if n > 1}
  <div class="cxs-wrap">
    <div
      bind:this={root}
      class="cxs"
      class:ready
      data-press={pressed ? '' : undefined}
      data-fast={fastOn ? '' : undefined}
      role="slider"
      tabindex="0"
      aria-label={t('推理强度')}
      aria-orientation="horizontal"
      aria-valuemin="0"
      aria-valuemax={n - 1}
      aria-valuenow={ariaIdx < 0 ? selIdx : ariaIdx}
      aria-valuetext={label(ariaIdx < 0 ? selIdx : ariaIdx)}
      style="--cxs-spring:{EASE.snap};--cxs-press:{EASE.pop}"
      onpointerdown={onDown}
      onpointermove={onMove}
      onpointerup={(e) => onUp(e)}
      onpointercancel={(e) => onUp(e, true)}
      onlostpointercapture={(e) => onUp(e, true)}
      onkeydown={onKey}
    >
      <div class="cxs-track">
        <span class="cxs-range" bind:this={rangeEl}>
          <span class="cxs-flow" aria-hidden="true">
            <span class="cxs-path p1"><i></i></span>
            <span class="cxs-path p2"><i></i></span>
            <span class="cxs-path p3"><i></i></span>
          </span>
          <span class="cxs-sheen" bind:this={sheenEl} aria-hidden="true"></span>
        </span>
        {#each efforts as e, i (e)}
          <span class="cxs-tick" style="transform:translate3d({stops[i] ?? 0}px,0,0)" in:dotIn out:dotOut>
            <i class="cxs-dot" use:regDot={e}></i>
          </span>
        {/each}
      </div>
      <span class="cxs-thumb" bind:this={thumbEl} aria-hidden="true">
        <span class="cxs-stretch" bind:this={stretchEl}>
          <span class="cxs-spring">
            <span class="cxs-knob">
              {#if fastOn}<span class="cxs-bolt" in:fastIn><Icon name="bolt" size={12} /></span>{/if}
            </span>
          </span>
        </span>
      </span>
    </div>
  </div>
{:else}
  <p class="cxs-one">{n === 1 ? t('这个型号只有这一档') : t('先选一个型号')}</p>
{/if}

<style>
  /* 尺寸照官方：容器 32 高、左右内缩 6+8；轨道 24 高；滑块 28（按下 32） */
  .cxs-wrap { position: relative; height: 32px; margin: 0 6px; padding: 2px 8px; display: flex; flex-direction: column; justify-content: center; }
  .cxs {
    position: relative; width: 100%; height: 28px; display: flex; align-items: center;
    /* 拖动不让页面滚、不触发双击缩放；弹层里这一条本来就不需要竖向滚 */
    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent; cursor: pointer; outline: 0;
  }
  .cxs[data-press] { cursor: grabbing; }
  .cxs-track {
    position: relative; flex: 1; height: 24px; border-radius: 12px; overflow: hidden;
    background: #f3f3f3; box-shadow: inset 0 0 2px rgb(0 0 0 / .18);
  }
  :global(.cx[data-theme="dark"]) .cxs-track { background: rgb(255 255 255 / .1); }
  .cxs-range {
    position: absolute; inset: 0; border-radius: 12px 0 0 12px; overflow: hidden;
    background: var(--theme-entity-accent); transform: translate3d(-100%, 0, 0); will-change: transform;
  }
  .cxs-tick { position: absolute; left: 0; top: 50%; width: 4px; height: 4px; margin: -2px 0 0 -2px; pointer-events: none; }
  /* 换模型时档点挪到新位置；首次画好之前不过渡（不然会从左边飞进来） */
  .cxs.ready .cxs-tick { transition: transform calc(var(--k, 1) * 420ms) var(--cxs-spring); }
  .cxs-dot {
    display: block; width: 4px; height: 4px; border-radius: 50%;
    background: color-mix(in srgb, var(--text-tertiary) 50%, transparent);
    transition: background-color calc(var(--k, 1) * 120ms) ease;
  }
  /* 填充上的档点：官方是白 30%，暗色主题填充是白的，改用底色 30%，两种主题都看得见 */
  .cxs-dot:global(.on) { background: color-mix(in srgb, var(--bg-primary) 34%, transparent); }

  .cxs-thumb { position: absolute; z-index: 4; left: 0; top: 50%; width: 28px; height: 28px; transform: translate3d(0, -50%, 0); will-change: transform; pointer-events: none; }
  .cxs-stretch { position: absolute; inset: 0; }
  .cxs-spring { position: absolute; inset: 0; transition: transform calc(var(--k, 1) * 380ms) var(--cxs-press); }
  @media (hover: hover) { .cxs:hover .cxs-spring { transform: scale(1.04); } }
  .cxs[data-press] .cxs-spring { transform: scale(1.1429); }
  .cxs-knob {
    position: absolute; inset: 0; border-radius: 50%; display: grid; place-items: center;
    background: #fff; color: #000; border: .5px solid var(--border-heavy);
    box-shadow: 0 0 2px rgb(0 0 0 / .1);
    transition: box-shadow calc(var(--k, 1) * 200ms) ease;
  }
  .cxs[data-press] .cxs-knob { box-shadow: 0 0 2px rgb(0 0 0 / .1), 0 3px 10px -2px rgb(0 0 0 / .22); }
  .cxs:focus-visible .cxs-knob { box-shadow: 0 0 0 2px var(--focus), 0 0 2px rgb(0 0 0 / .1); }
  .cxs-bolt { display: grid; place-items: center; }
  .cxs-bolt :global(svg) { width: 12px; height: 12px; }

  /* Fast：几粒细光从滑块底下往回流过填充（填充里才看得见），开的那一下扫一道亮光。不发光晕、不换色 */
  .cxs-flow { position: absolute; inset: 0; opacity: 0; transition: opacity calc(var(--k, 1) * 220ms) ease; pointer-events: none; }
  .cxs[data-fast] .cxs-flow { opacity: 1; }
  .cxs-path { position: absolute; left: 0; right: 0; height: 0; animation: cxs-travel 1.6s linear infinite; animation-play-state: paused; will-change: transform; }
  .cxs[data-fast] .cxs-path { animation-play-state: running; }
  .cxs-path i { position: absolute; left: 0; top: 0; height: 1.5px; border-radius: 1px; background: color-mix(in srgb, var(--bg-primary) 72%, transparent); }
  .p1 { top: 8px; animation-duration: 1.45s; animation-delay: -.2s; }
  .p1 i { width: 9px; }
  .p2 { top: 12px; animation-duration: 1.9s; animation-delay: -1.1s; }
  .p2 i { width: 5px; opacity: .7; }
  .p3 { top: 15.5px; animation-duration: 1.65s; animation-delay: -.6s; }
  .p3 i { width: 12px; opacity: .85; }
  @keyframes cxs-travel {
    0% { transform: translate3d(100%, 0, 0); opacity: 0; }
    8% { opacity: 1; }
    92% { opacity: 1; }
    100% { transform: translate3d(0, 0, 0); opacity: 0; }
  }
  .cxs-sheen {
    position: absolute; left: 0; top: 0; bottom: 0; width: 40px; opacity: 0; pointer-events: none;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--bg-primary) 38%, transparent), transparent);
  }
  .cxs-one { margin: 2px 0 4px; color: var(--fg3); font-size: 12px; }

  @media (prefers-reduced-motion: reduce) {
    .cxs-path { display: none; }
    .cxs.ready .cxs-tick, .cxs-spring { transition: none; }
  }
</style>
