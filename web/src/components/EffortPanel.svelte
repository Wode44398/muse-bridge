<script>
  // Effort 拉条面板：尺寸、明暗配色、动效节奏对齐 claude.ai/code 的 Effort 弹层（数值是对着官方界面量出来的，代码自写）：
  // - 卡片 220px / p10 / gap16 / r12，surface-popover + stroke-shadow 双模式；
  // - 标题行 Effort(t6) + 档名(t7, 换档 0.2s easeOut ±0.55em blur2px 方向交换) + ?(U+e088)
  //   悬停 200ms 出帮助浮层；Faster/Smarter 12px t6；
  // - 轨道 24 命中/20 视高 r6，fill 按 --slider-drag-pos/--slider-rest-pos 走；
  //   拖拽自由跟手（起拖 120ms 内从当前位置追上手指）、松手/点按按 CSS 过渡吸附，
  //   拖动中档名跟随高亮、松手才提交；
  // - 档位点 3px（末档 accent 紫）、35ms 步进错峰、顶档隐去；把手 16×19 r6 双模式色；
  // - 顶档（accent）= data-top-stop：点亮能量层。维护者的私有 overlay 提供原版 WebGL 能量场
  //   （ovModule('effortField')）；公开版是自写的 CSS 光带。prefers-reduced-motion 全静。
  import { cubicOut } from 'svelte/easing';
  import { caps, settings } from '../lib/state.svelte.js';
  import { claudeEffortFallback, claudeDefaultModel } from '../lib/caps.js';
  import { isCustomModel, effortChoices, defaultEffortFor } from '../lib/claudeProviders.svelte.js';   // 自定义模型按它自己的档位表
  import { rememberCurrentPrefs } from '../lib/chat.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { clampX } from '../lib/clampx.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { t as tt } from '../lib/i18n.js';   // 本文件动画代码里 t 是插值进度变量，翻译函数取别名
  import { cs } from '../lib/claudeSettings.svelte.js';
  import { ovModule } from '../lib/overlay.svelte.js';
  let { onClose, dir = 'up' } = $props();

  $effect(() => pushBackLayer(() => { onClose?.(); }));

  // 快照访客没有 Ultracode：服务端把它静默降到 xhigh 又不发 effort 实况，列出来只会让芯片恒显 Ultracode 却
  // 没有任何降档提示——直接不列（chat 内核发请求时也把残留的 ultracode 归成 xhigh）。
  // 自定义 API 的模型（custom:<服务>:<模型>）：档位是它自己的表（设置 › Claude › 模型服务，含「默认」= 什么都不发）
  const curModel = $derived(settings.model || claudeDefaultModel(caps.data));
  const custom = $derived(isCustomModel(curModel));
  const efforts = $derived(custom ? effortChoices(curModel, caps.data) : (caps.data?.claude?.efforts || []).filter((e) => !IS_CSNAP || e.id !== 'ultracode'));
  const N = $derived(efforts.length);
  const idx = $derived.by(() => {
    // 自定义模型：没选 = 默认档；默认档为空时列表头上那一项「默认」（id ''）就是它
    const want = custom ? (settings.effort && efforts.some((e) => e.id === settings.effort) ? settings.effort : defaultEffortFor(curModel)) : (settings.effort || claudeEffortFallback(caps.data, settings.model));
    const i = efforts.findIndex((e) => e.id === want);
    return i < 0 ? Math.min(2, Math.max(0, N - 1)) : i;
  });
  // Ultracode 档（capabilities.efforts 末尾 {id:'ultracode'}）= 官方唯一带 accent 的档位：紫档名 /
  // 紫点 / 能量场都跟着它走（官方 items.at(-1).accent）。只认 id——按模型的档位表里没有它时，
  // 最高档不能被渲染成 Ultracode（前端编译时自带同源 CAPABILITIES，旧后端兜底用不着「末档当 accent」的回落）。
  const ULTRA = 'ultracode';
  const accentIdx = $derived(efforts.findIndex((e) => e.id === ULTRA));
  const accent = $derived(accentIdx >= 0 && N > 1);
  // 设置 › Claude › 对话 › 动态工作流 关着：Ultracode（= xhigh + 工作流）这一档置灰——拖 / 点到它都落回上一档，
  // 能量场不点亮。已经选着 Ultracode 的会话不动（服务端对 ultracode 档仍强制开工作流）。
  const ultraOff = $derived(cs.values.enableWorkflows === false);
  const allowed = (i) => (ultraOff && (efforts[i] || {}).id === ULTRA ? Math.max(0, i - 1) : i);

  // 拖动中的高亮档（官方 onValueChange 只改高亮、onValueCommitted 才落值）
  let hlIdx = $state(null);
  const disp = $derived(hlIdx == null ? idx : hlIdx);
  const restPct = $derived(N > 1 ? (disp / (N - 1)) * 100 : 0);
  const topStop = $derived(accent && disp === accentIdx && !(ultraOff && (efforts[disp] || {}).id === ULTRA));
  const label = $derived((efforts[disp] || {}).name || '');

  let dragging = $state(false);
  let control = $state(), trackEl = $state(), fillEl = $state(), thumbEl = $state(), railEl = $state(), inputEl = $state(), canvasEl = $state();

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function commit(i) {
    i = allowed(i);
    const e = efforts[i];
    // 改即记，杀后台不丢；effortAt 让输入栏芯片知道「用户刚改过」——上一轮 Stop hook 回报的
    // 实际生效档位比这个时刻旧就不再盖住用户的新选择（下一轮跑完再更新）。
    // 自定义模型的「默认」项 id 为空 = 不选（null）
    const v = e ? (e.id || null) : undefined;
    if (e && settings.effort !== v) { settings.effort = v; settings.effortAt = Date.now(); rememberCurrentPrefs(); }
    hlIdx = null;
  }

  // —— 档名交换动画（官方 framer popLayout 逐行对位：0.2s easeOut、±0.55em、blur 2px）——
  let lbDir = $state(1);
  function setDisp(i) {
    if (i === disp) return;
    lbDir = i > disp ? 1 : -1;
    hlIdx = i;
  }
  const lbIn = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (t, u) => `opacity:${t};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(0.55 * u * d).toFixed(3)}em)` });
  const lbOut = (n, { d }) => ({ duration: 200, easing: cubicOut, css: (t, u) => `position:absolute;left:0;top:0;max-width:100%;opacity:${t};filter:blur(${(2 * u).toFixed(2)}px);transform:translateY(${(-0.55 * u * d).toFixed(3)}em)` });

  // —— 拖拽：按下先把最近一档高亮（rest-pos 一变，把手按 CSS 过渡滑过去）；移动超过 3px 进入跟手，
  //    起拖 120ms 内从当前位置缓动追上手指（免得跳一下）；松手落值，去掉 drag-pos 回到 rest-pos，同样按过渡吸附。
  //    过渡写在 CSS（.ef-slider:not(.dragging)），减少动态效果时没有。
  let drag = null;   // { rail, grab, x0, x, moved, from, t0, raf }
  const fracAt = (d) => Math.min(Math.max((d.x - d.grab - d.rail.left) / (d.rail.width || 1), 0), 1);
  const easeOut3 = (k) => 1 - (1 - k) ** 3;
  function down(e) {
    if (N < 2 || e.button !== 0) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    control.style.removeProperty('--slider-drag-pos');
    const tr = thumbEl.getBoundingClientRect();
    const grab = thumbEl.contains(e.target) ? e.clientX - (tr.left + tr.width / 2) : 0;
    drag = { rail: railEl.getBoundingClientRect(), grab, x0: e.clientX, x: e.clientX, moved: false, from: 0, t0: 0, raf: 0 };
    setDisp(Math.round(fracAt(drag) * (N - 1)));
  }
  function frame() {
    const d = drag;
    if (!d || !control || !railEl) return;
    d.raf = 0;
    d.rail = railEl.getBoundingClientRect();
    let f = fracAt(d);
    const k = (performance.now() - d.t0) / 120;
    if (k < 1) { f = d.from + (f - d.from) * easeOut3(Math.max(k, 0)); d.raf = requestAnimationFrame(frame); }
    control.style.setProperty('--slider-drag-pos', (100 * f) + '%');
    setDisp(Math.round(f * (N - 1)));
  }
  function move(e) {
    const d = drag;
    if (!d) return;
    d.x = e.clientX;
    if (e.buttons === 0) { up(); return; }
    if (!d.moved) {
      if (Math.abs(d.x - d.x0) < 3) return;
      d.moved = true; dragging = true;
      const w = control.getBoundingClientRect().width;
      d.from = w > 0 ? Math.min(Math.max(fillEl.getBoundingClientRect().width / w, 0), 1) : fracAt(d);
      d.t0 = reduced() ? -1e9 : performance.now();
    }
    if (!d.raf) d.raf = requestAnimationFrame(frame);
  }
  function up() {
    const d = drag;
    drag = null;
    if (!d || !control) { dragging = false; return; }
    if (d.raf) cancelAnimationFrame(d.raf);
    commit(d.moved ? Math.round(fracAt(d) * (N - 1)) : disp);
    dragging = false;
    control.style.removeProperty('--slider-drag-pos');
  }
  function dotTap(e, i) {
    e.stopPropagation();
    if (drag) { if (drag.raf) cancelAnimationFrame(drag.raf); drag = null; dragging = false; }
    control.style.removeProperty('--slider-drag-pos');
    i = allowed(i);
    setDisp(i); commit(i);
  }
  // 键盘（隐藏 input）：即时落值（把手照常按过渡滑过去）
  function onInput() { const i = allowed(+inputEl.value); setDisp(i); commit(i); }
  function onKeyEsc(e) { if (e.key === 'Escape') { e.preventDefault(); onClose?.(); } }

  // —— 顶档能量层 ——
  // 维护者的私有 overlay 带了原版 WebGL 能量场（modules/effort-field.js：mountEffortField(canvas) → { pressStart, pressEnd, destroy }）
  // → 挂在 canvas 上，顶档常按、离开顶档冷却；公开版（没有这个模块）→ 自写的 CSS 光带（.ef-charge，跟着 .topstop 亮灭）。
  let fieldMod = $state(undefined);   // undefined = 还在取；null = 没有
  $effect(() => {
    if (!accent || fieldMod !== undefined) return;
    let alive = true;
    ovModule('effortField').then((m) => { if (alive) fieldMod = m && typeof m.mountEffortField === 'function' ? m : null; });
    return () => { alive = false; };
  });
  let energyApi = $state.raw(null);   // { pressStart(k), pressEnd(k), destroy() }
  $effect(() => {
    const cnv = canvasEl, m = fieldMod;
    if (!cnv || !accent || !m) return;
    let api = null;
    try { api = m.mountEffortField(cnv); } catch (e) { console.warn('[overlay] effortField 挂载失败：', e?.message || e); }   // i18n-ignore 只进控制台
    if (!api) return;
    energyApi = api;
    return () => { energyApi = null; try { api.destroy?.(); } catch {} };
  });
  // 顶档进出 → 能量场常按 / 冷却
  $effect(() => { const api = energyApi; if (topStop && api) { api.pressStart(1); return () => api.pressEnd(1); } });

  // —— help 悬浮层：200ms 延迟出、离开即收（官方 tooltip Root delay 200）——
  let helpOpen = $state(false);
  let helpT = 0;
  const helpEnter = () => { clearTimeout(helpT); helpT = setTimeout(() => (helpOpen = true), 200); };
  const helpLeave = () => { clearTimeout(helpT); helpOpen = false; };
  // 文案按当前档位给（官方 Nv 读 item.help）：Ultracode 档专属 title/body（官方 ultracodeHelpBody 同款，
  // {effortLabel} 是官方目录里 xhigh 的名字「Extra high」），其余档位一律默认句。bridge 的 efforts 表把 xhigh
  // 缩成「Extra」只是为了输入栏芯片省宽，帮助浮层不受那个约束，整句必须是 "Ultracode is Extra high effort…"。
  const isUltraDisp = $derived((efforts[disp] || {}).id === ULTRA);
  const xhighLabel = 'Extra high';
  const helpTitle = $derived(isUltraDisp ? 'Ultracode' : 'Effort');
  const helpBody = $derived(isUltraDisp && ultraOff
    ? tt('Ultracode 要用动态工作流，它在 设置 › Claude 里关着。')
    : isUltraDisp
    ? `Ultracode is ${xhighLabel} effort plus workflows. Most thorough, slowest, and heaviest on your limits. Applies to this session only. New sessions start without it.`
    : 'Higher effort means more thorough responses, but takes longer and uses your limits faster.');
</script>

<button class="ef-backdrop" aria-label={tt('关闭')} onclick={() => onClose?.()}></button>
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="ef" class:down={dir === 'down'} role="dialog" aria-label="Effort" onkeydown={onKeyEsc} use:clampX>
  <div class="ef-head">
    <div class="ef-head-l">
      <h2 class="ef-title">Effort</h2>
      <span class="ef-valwrap">
        {#key disp}<span class="ef-val" class:accent={topStop} class:off={ultraOff && isUltraDisp} in:lbIn={{ d: lbDir }} out:lbOut={{ d: lbDir }}>{label}</span>{/key}
      </span>
    </div>
    <button type="button" class="ef-help" aria-label="About effort"
      onpointerenter={helpEnter} onpointerleave={helpLeave} onfocus={helpEnter} onblur={helpLeave}>
      <span class="ef-help-ic" aria-hidden="true">&#xe088;</span>
    </button>
    {#if helpOpen}
      <div class="ef-help-pop" role="tooltip">
        <span class="ef-help-t">{helpTitle}</span>
        <span class="ef-help-b">{helpBody}</span>
      </div>
    {/if}
  </div>
  <!-- 只有一档（自定义模型的档位表可能就一项）：只显示档名，不画拉条 -->
  {#if N > 1}
  <div class="ef-sec">
    <div class="ef-ends"><span>Faster</span><span>Smarter</span></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ef-slider" class:dragging class:topstop={topStop} bind:this={control}
      style:--slider-rest-pos={restPct + '%'}
      onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onlostpointercapture={up}>
      <div class="ef-track" bind:this={trackEl}>
        <span class="ef-fill" bind:this={fillEl}>
          {#if accent}
            <span class="ef-energy-wrap" aria-hidden="true">
              {#if fieldMod}<canvas class="ef-energy" bind:this={canvasEl}></canvas>{:else if fieldMod === null}<span class="ef-charge"></span>{/if}
            </span>
          {/if}
        </span>
      </div>
      <span class="ef-dots" aria-hidden="true">
        {#each efforts as e, i (e.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span class="ef-dot" class:last={accent && i === accentIdx} class:off={ultraOff && e.id === ULTRA} style:--ds={35 * (N - 1 - i) + 'ms'} title={e.name}
            onpointerdown={(ev) => dotTap(ev, i)}><span class="ef-dot-hit"></span></span>
        {/each}
      </span>
      <span class="ef-rail" bind:this={railEl}>
        <span class="ef-thumb" bind:this={thumbEl} aria-hidden="true"></span>
        <span class="ef-thumb ef-focusring" aria-hidden="true"></span>
        <input class="ef-input" bind:this={inputEl} type="range" min="0" max={N - 1} step="1" value={disp}
          aria-label="Effort" aria-valuetext={label} oninput={onInput} />
      </span>
    </div>
  </div>
  {/if}
</div>

<style>
  /* ===== 官方 token（claude.ai/code 实测）。bridge 暗=:root 默认，亮=html[data-theme=light] ===== */
  .ef {
    --ef-pop-bg: rgb(44, 44, 42);
    --ef-pop-shadow: inset 0 0 0 1px rgba(255, 255, 255, .08), 0 6px 16px rgba(11, 11, 11, .24);
    --ef-t5: rgba(255, 255, 255, .25);
    --ef-t6: rgba(255, 255, 255, .48);
    --ef-t7: rgba(255, 255, 255, .7);
    --ui-slider-background: rgb(26, 26, 25);
    --ui-slider-fill: rgba(255, 255, 255, .16);
    --ui-slider-handle: rgb(165, 164, 154);
    --ui-slider-handle-energized: rgb(241, 234, 255);
    --ef-thumb-shadow: 0 0 12px rgba(11, 11, 11, .24);
    --extended-purple: rgb(183, 150, 255);
    --extended-20-purple: rgba(183, 150, 255, .2);
    --ui-slider-energy-hot: rgb(183, 150, 255);
    --ui-slider-energy-cool: rgb(255, 255, 255);
    --ui-slider-fill-charged-start: rgb(158, 128, 235);
    --ui-slider-fill-charged-end: rgb(89, 64, 153);
    --ui-slider-energy-tint-blue: transparent;
    --ui-slider-energy-tint-pink: transparent;
    --ui-slider-energy-bed-fill: 0;
    --ui-slider-energy-charge-max: .85;
    --ui-slider-energy-charge-ramp: 1.1;
    --ui-slider-energy-ink-floor: .08;
    --ui-slider-energy-ink-ceil: .85;
    --ui-slider-energy-gain: 1;
    --ui-slider-energy-reveal: 60%;
    --ef-energy-op-k: .86;      /* 暗：opacity clamp 系数与上限（官方 dark 变体） */
    --ef-energy-op-max: 65%;
  }
  :global(html[data-theme="light"]) .ef {
    --ef-pop-bg: #fff;
    --ef-pop-shadow: 0 0 0 1px rgba(11, 11, 11, .06), 0 6px 16px rgba(11, 11, 11, .06);
    --ef-t5: rgba(11, 11, 11, .25);
    --ef-t6: rgba(11, 11, 11, .5);
    --ef-t7: rgba(11, 11, 11, .8);
    --ui-slider-background: rgb(237, 236, 232);
    --ui-slider-fill: rgba(11, 11, 11, .1);
    --ui-slider-handle: #fff;
    --ui-slider-handle-energized: #fff;
    --ef-thumb-shadow: 0 0 0 1px rgba(11, 11, 11, .04), 0 0 12px rgba(11, 11, 11, .06);
    --extended-purple: rgb(142, 107, 217);
    --extended-20-purple: rgba(142, 107, 217, .2);
    --ui-slider-energy-hot: rgb(251, 237, 241);
    --ui-slider-energy-cool: rgb(210, 196, 240);
    --ui-slider-fill-charged-start: rgb(151, 148, 218);
    --ui-slider-fill-charged-end: rgb(157, 107, 191);
    --ui-slider-energy-tint-blue: rgba(191, 215, 243, .28);
    --ui-slider-energy-tint-pink: rgba(240, 188, 204, .28);
    --ui-slider-energy-bed-fill: 1;
    --ui-slider-energy-charge-max: .92;
    --ui-slider-energy-charge-ramp: .5;
    --ui-slider-energy-ink-floor: .28;
    --ui-slider-energy-ink-ceil: 1;
    --ui-slider-energy-gain: 1.18;
    --ui-slider-energy-reveal: 45%;
    --ef-energy-op-k: 1.33;
    --ef-energy-op-max: 100%;
  }

  .ef { --ef-snap: 380ms cubic-bezier(.2, .9, .3, 1); }
  .ef-backdrop { position: fixed; inset: 0; z-index: 60; }
  /* 卡片：220 / p10 / gap16 / r12（官方 w-[220px] p-p7 gap-[16px] rounded-r8，click 即现无入场动画） */
  .ef {
    position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 61;
    width: 220px; padding: 10px; display: flex; flex-direction: column; gap: 16px;
    background: var(--ef-pop-bg); border-radius: 12px; box-shadow: var(--ef-pop-shadow);
    user-select: none; font-size: 13px; line-height: 18px; font-family: var(--sans);
  }
  .ef.down { bottom: auto; top: calc(100% + 8px); }

  /* 标题行：gap 4（g3）；Effort t6、档名 t7、? t5→hover t7 */
  .ef-head { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 4px; }
  .ef-head-l { display: flex; min-width: 0; align-items: center; gap: 4px; }
  .ef-title { flex: none; font-size: 13px; font-weight: 400; color: var(--ef-t6); }
  .ef-valwrap { position: relative; min-width: 0; display: flex; }
  .ef-val { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--ef-t7); }
  .ef-val.accent { color: var(--extended-purple); font-weight: 500; }
  .ef-help { flex: none; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 999px; color: var(--ef-t5); cursor: default; outline: none; }
  .ef-help:hover { color: var(--ef-t7); }
  .ef-help-ic { font-family: var(--icons); font-size: 16px; line-height: 1; font-variation-settings: "opsz" 16, "wght" 430; }
  /* 帮助浮层：220px、上方右对齐（官方 side top / align end / sideOffset 18 / alignOffset -10） */
  .ef-help-pop { position: absolute; bottom: calc(100% + 8px); right: -10px; width: 220px; z-index: 5;
    display: flex; flex-direction: column; gap: 2px; padding: 10px;
    background: var(--ef-pop-bg); border-radius: 12px; box-shadow: var(--ef-pop-shadow); }
  .ef-help-t { font-size: 12px; line-height: 15px; font-weight: 500; color: var(--ef-t7); padding-bottom: 2px; }
  .ef-help-b { font-size: 13px; line-height: 18px; color: var(--ef-t6); overflow-wrap: break-word; text-wrap: pretty; }

  /* 滑条区：gap 8（g6）；Faster/Smarter 12px t6 */
  .ef-sec { display: flex; width: 100%; flex-direction: column; gap: 8px; }
  .ef-ends { display: flex; align-items: center; justify-content: space-between; gap: 4px;
    font-size: 12px; line-height: 15px; color: var(--ef-t6); }

  /* control 24 高；track 20 高 r6 上下 margin 2 */
  .ef-slider { position: relative; display: flex; height: 24px; width: 100%; align-items: center; touch-action: none; }
  .ef-slider.dragging { cursor: ew-resize; }
  .ef-track { position: relative; width: 100%; margin: 2px 0; height: calc(100% - 4px); border-radius: 6px;
    overflow: hidden; container-type: inline-size; background: var(--ui-slider-background); }
  .ef-fill { position: absolute; inset: 0 auto 0 0; left: 0; overflow: hidden;
    width: var(--slider-drag-pos, var(--slider-rest-pos)); background: var(--ui-slider-fill); }
  /* 能量层：官方 opacity clamp((pos-25%)*k) + mask 软渐入（reveal 45%/60%）+ mask-size 跟填充 */
  .ef-energy-wrap { pointer-events: none; position: absolute; inset: 0 auto 0 0; width: 100cqw;
    opacity: clamp(0%, calc((var(--slider-drag-pos, var(--slider-rest-pos)) - 25%) * var(--ef-energy-op-k)), var(--ef-energy-op-max));
    mask-image: linear-gradient(to right, transparent 0%, #000 var(--ui-slider-energy-reveal));
    -webkit-mask-image: linear-gradient(to right, transparent 0%, #000 var(--ui-slider-energy-reveal));
    mask-repeat: no-repeat; -webkit-mask-repeat: no-repeat;
    mask-size: max(calc(var(--slider-drag-pos, var(--slider-rest-pos)) - 8px), 0px) 100%;
    -webkit-mask-size: max(calc(var(--slider-drag-pos, var(--slider-rest-pos)) - 8px), 0px) 100%; }
  .ef { --ef-blend: normal; }
  :global(html:not([data-theme="light"])) .ef .ef-energy-wrap { mix-blend-mode: plus-lighter; }
  /* 公开版顶档光带（没有 overlay 的能量场时）：充能色渐变打底，一道高光从左往右扫；进出顶档 0.6s 淡入淡出 */
  .ef-charge { position: absolute; inset: 0; opacity: 0; transition: opacity .6s ease;
    background: linear-gradient(90deg, var(--ui-slider-fill-charged-end), var(--ui-slider-fill-charged-start)); }
  .ef-charge::after { content: ''; position: absolute; inset: 0; background-repeat: no-repeat; background-size: 55% 100%;
    background-image: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--ui-slider-energy-hot) 75%, transparent) 50%, transparent 80%);
    background-position: -150% 0; }
  .ef-slider.topstop .ef-charge { opacity: 1; }
  @media (prefers-reduced-motion: no-preference) {
    .ef-slider.topstop .ef-charge::after { animation: ef-sweep 2.4s cubic-bezier(.45, 0, .25, 1) infinite; }
  }
  @keyframes ef-sweep { from { background-position: -150% 0; } to { background-position: 250% 0; } }
  .ef-energy { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
    color: var(--ui-slider-energy-hot); outline-color: var(--ui-slider-energy-cool);
    border-top: 0 none var(--ui-slider-fill-charged-start); border-bottom: 0 none var(--ui-slider-fill-charged-end);
    text-decoration-color: var(--ui-slider-energy-tint-blue); column-rule-color: var(--ui-slider-energy-tint-pink); }

  /* 档位点：3px、px 10 两端、t5（末档紫）、35ms 步进错峰；顶档非拖动隐去；命中区 19×23 */
  .ef-dots { pointer-events: none; position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: space-between; padding: 0 10px; }
  .ef-dot { pointer-events: auto; position: relative; display: flex; width: 3px; height: 3px;
    align-items: center; justify-content: center; border-radius: 999px; background: var(--ef-t5); }
  .ef-dot.last { background: var(--extended-purple); }
  .ef-dot.off { background: var(--ef-t5); }
  .ef-val.off { color: var(--ef-t5); }
  .ef-dot-hit { position: absolute; inset: -10px -8px; }
  @media (prefers-reduced-motion: no-preference) {
    .ef-dot { transition: opacity .3s ease var(--ds, 0ms); }
  }
  .ef-slider.dragging .ef-dot { pointer-events: none; }
  .ef-slider.topstop .ef-dot { pointer-events: none; }
  .ef-slider.topstop:not(.dragging) .ef-dot { opacity: 0; }

  /* 轨内滑轨：两侧内缩半把手（8px）；把手 16×19 r6，背景色 300ms 过渡 */
  .ef-rail { pointer-events: none; position: absolute; top: 0; bottom: 0; left: 8px; right: 8px; }
  .ef-thumb { pointer-events: auto; position: absolute; width: 16px; height: 19px; border-radius: 6px;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); top: 50%; transform: translate(-50%, -50%);
    background: var(--ui-slider-handle); box-shadow: var(--ef-thumb-shadow); cursor: ew-resize; }
  @media (prefers-reduced-motion: no-preference) {
    .ef-thumb { transition: background-color .3s; }
    /* 吸附：不在拖动时，填充宽度与把手位置按过渡滑到档位上（快起慢收、无回弹） */
    .ef-slider:not(.dragging) .ef-fill { transition: width var(--ef-snap); }
    .ef-slider:not(.dragging) .ef-thumb { transition: left var(--ef-snap), background-color .3s; }
  }
  .ef-slider.topstop .ef-thumb { background: var(--ui-slider-handle-energized); }
  /* 键盘聚焦环：白 2px + 环 4px + 20% 辉光（官方 shadow-focus-slider；顶档换紫） */
  .ef-focusring { pointer-events: none; opacity: 0; background: transparent; cursor: default;
    box-shadow: 0 0 0 2px var(--ef-pop-bg), 0 0 0 4px var(--coral), 0 0 14px 4px color-mix(in srgb, var(--coral) 20%, transparent); }
  .ef-slider:focus-within .ef-focusring { opacity: 1; }
  .ef-slider.topstop .ef-focusring {
    box-shadow: 0 0 0 2px var(--ef-pop-bg), 0 0 0 4px var(--extended-purple), 0 0 14px 4px var(--extended-20-purple); }
  /* 真 input：藏在把手位置承载键盘/读屏（官方 clip 内藏 input 同构） */
  .ef-input { position: absolute; width: 16px; height: 19px; top: 50%;
    left: var(--slider-drag-pos, var(--slider-rest-pos)); transform: translate(-50%, -50%);
    opacity: 0; pointer-events: none; margin: 0; }
</style>
