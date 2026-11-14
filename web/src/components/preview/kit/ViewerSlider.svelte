<script>
  // 通用滑轨（视频进度、音量、缩放）。全站只这一套：
  //   轨道 3px（悬停 / 拖动加粗到 5px，用 scaleY，不改 height）；旋钮 12 → 16（scale）；
  //   填充与缓冲都是 transform: scaleX（原点在左），位置变化不触发布局；旋钮 / 气泡用 translateX 走。
  //   媒体皮肤：填充白、缓冲白 .4、底轨白 .24；文档皮肤：填充 --md-accent。
  //   命中区：电脑 ≥20、触屏 ≥44（元素本身就这么高，轨道居中画）。
  //   拖动中出时间 / 数值气泡（format 给了才出）；电脑悬停出悬停位置的气泡（hoverFormat 给了才出）。
  // 值域 [min, max]；oninput 拖动中持续回调，onchange 松手回调一次（视频松手才 seek 就只接 onchange）。
  // 键盘：←/→/↑/↓ 按 step（缺省 1/20 量程），PageUp/PageDown ×5，Home/End 到两端——处理过就 preventDefault，外框不再翻页。
  // 可选：tip(v) 片段渲染在气泡文字上方（视频 storyboard 缩略帧 / 章节名）；marks=[0..1] 在轨道上画分段缝（章节）。
  // 气泡按实测宽度夹在轨道两端以内，靠边悬停不出画。
  import { useViewer } from './context.js';

  let {
    value = $bindable(0), min = 0, max = 1, step = 0, buffered = 0,
    label = '', format = null, hoverFormat = null, valueText = null,
    oninput = null, onchange = null, onstart = null, onend = null, onhover = null,
    disabled = false, tone = '', class: cls = '', tip = null, marks = null,
  } = $props();
  const viewer = useViewer();

  let el = $state();
  let dragging = $state(false), dragV = $state(0);
  let hoverP = $state(-1);
  let release = null;
  let W = $state(0), bubW = $state(0);   // 轨道宽 / 气泡宽（夹边用）

  const span = $derived(max - min || 1);
  const shown = $derived(dragging ? dragV : value);
  const p = $derived(Math.max(0, Math.min(1, (shown - min) / span)));
  const bp = $derived(Math.max(0, Math.min(1, (buffered - min) / span)));

  function at(clientX) {
    const r = el.getBoundingClientRect();
    W = r.width;
    const q = Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1)));
    let v = min + q * span;
    if (step > 0) v = Math.round((v - min) / step) * step + min;
    return Math.max(min, Math.min(max, v));
  }
  function down(e) {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.stopPropagation();
    try { el.setPointerCapture(e.pointerId); } catch {}
    dragging = true; dragV = at(e.clientX);
    release = viewer.chrome.hold('slider');
    onstart?.(dragV); oninput?.(dragV);
  }
  function move(e) {
    if (dragging) { dragV = at(e.clientX); oninput?.(dragV); return; }
    if (e.pointerType === 'mouse' && hoverFormat) {
      const r = el.getBoundingClientRect();
      W = r.width;
      hoverP = Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1)));
      onhover?.(min + hoverP * span);
    }
  }
  function up(e) {
    if (!dragging) return;
    dragging = false;
    const v = e.type === 'pointercancel' ? dragV : at(e.clientX);
    value = v;
    release?.(); release = null;
    onchange?.(v); onend?.(v);
  }
  // 气泡中心的 px 位置：夹在 [半宽-8, W-半宽+8]，轨道比气泡还窄时居中
  function bx(q) {
    if (!W) return null;
    const half = bubW / 2, x = q * W, lo = half - 8, hi = W - half + 8;
    return lo > hi ? W / 2 : Math.max(lo, Math.min(hi, x));
  }
  const bubPos = (q) => { const x = bx(q); return x == null ? `translateX(${q * 100}%)` : `translateX(${x}px)`; };
  function leave() { if (hoverP >= 0) { hoverP = -1; onhover?.(null); } }
  function key(e) {
    if (disabled) return;
    const st = step > 0 ? step : span / 20;
    let v = value;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v += st;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v -= st;
    else if (e.key === 'PageUp') v += st * 5;
    else if (e.key === 'PageDown') v -= st * 5;
    else if (e.key === 'Home') v = min;
    else if (e.key === 'End') v = max;
    else return;
    e.preventDefault();
    value = Math.max(min, Math.min(max, v));
    oninput?.(value); onchange?.(value);
  }
</script>

<div class="vw-track {cls}" class:live={dragging} class:off={disabled} bind:this={el} data-tone={tone || null}
  role="slider" tabindex={disabled ? -1 : 0} aria-label={label} aria-disabled={disabled}
  aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(shown * 100) / 100}
  aria-valuetext={valueText ? valueText(shown) : format ? format(shown) : null}
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onpointerleave={leave} onkeydown={key}>
  <div class="vw-track-rail">
    {#if buffered > min}<i class="vw-track-buf" style:transform="scaleX({bp})"></i>{/if}
    <i class="vw-track-fill" style:transform="scaleX({p})"></i>
    {#if marks}{#each marks as m, i (i)}{#if m > 0 && m < 1}<i class="vw-track-gap" style:left="{m * 100}%"></i>{/if}{/each}{/if}
  </div>
  <div class="vw-track-pos" style:transform="translateX({p * 100}%)"><i class="vw-track-knob"></i></div>
  {#if (dragging && format) || (!dragging && hoverP >= 0 && hoverFormat)}
    {@const q = dragging ? p : hoverP}
    {@const v = dragging ? shown : min + hoverP * span}
    <div class="vw-track-pos" style:transform={bubPos(q)}>
      {#if tip}
        <div class="vw-tipbox" bind:offsetWidth={bubW}>{@render tip(v)}<span class="vw-pill vw-tiptext">{(dragging ? format : hoverFormat)(v)}</span></div>
      {:else}
        <span class="vw-pill vw-bubble" bind:offsetWidth={bubW}>{(dragging ? format : hoverFormat)(v)}</span>
      {/if}
    </div>
  {/if}
</div>
