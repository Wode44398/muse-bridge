<script>
  // 「几选一」的唯一样子（方案 §12.4）：浅墨底上一排 / 一格 / 几行选项，选中的是一块墨（暗色是象牙），
  // 换选项时这块墨从它此刻的位置沿弹簧滑过去——换行时斜着走，连点几下也是接着滑，不跳、不换样子。
  // 枚举分段、小块排（wrap）、比例格（grid + 每格一个比例小框）、清晰度档位、张数都用它。
  //   layout：row（一排；full 时等分、放不下按字宽撑开并告诉调用方 onoverflow）· wrap（折行的小块）· grid（cols 列的格）
  //   options[]：{ value, label, glyph?（格子上方的小图 HTML）, hint?（行尾 mono 小字）, rejected?, disabled?, title?, dot? }
  //   dim：整排淡下去但照样能点（尺寸「自动」时的档位排）· clearable：再点一下选中项就清掉
  //   tone：ink（参数的「几选一」）· paper（模型选择器行尾「走哪家」：白纸滑块，选中那家的标恢复彩色）
  // 墨块用 WAAPI：先读它此刻的样子、撤掉旧动画、把终值写进 style，再从此刻的样子动画过去；不 commitStyles（会把旧终值写回来）。
  import { untrack } from 'svelte';
  import { SPRING_SNAP, springEasing, reducedMotion } from '../../../modules/studio/motion.js';

  let {
    options = [], value, onchange, size = 'md', full = false, mono = false, label = '',
    layout = 'row', cols = 0, dim = false, clearable = false, tone = 'ink',
    item = null, overKey = '', keyOf = (v) => v, onkeydown = null, onoverflow = null,
  } = $props();

  let track = $state();
  let puck = $state();
  let pressed = $state(null);
  const target = $derived(pressed ?? value);

  let at = null;        // 墨块现在停在哪 { x, y, w, h }
  let anim = null;
  const quiet = () => reducedMotion() || !!track?.closest('.sd-noanim');

  // 放不下（系统字号放大、英文长词）就告诉调用方换成小块排。坞拉开、浮层弹出的那一会儿宽度是过渡中的值，
  // 量到「放不下」先等它停下来再量一次，两次都放不下才算
  const cutNow = () => !!track && track.clientWidth >= 8 && (track.scrollWidth > track.clientWidth + 1 || [...track.querySelectorAll('.sg-o > .sg-t')].some((s) => s.scrollWidth > s.clientWidth + 1));
  let recheck = 0;
  function overflowCheck() {
    if (!onoverflow || layout !== 'row' || recheck || !cutNow()) return;
    recheck = setTimeout(() => { recheck = 0; if (cutNow()) onoverflow?.(); }, 450);
  }

  function place(animate) {
    if (!track || !puck) return;
    const key = untrack(() => target);
    const btn = track.querySelector(`[data-v="${CSS.escape(String(key))}"]`);
    if (!btn) {
      anim?.cancel(); anim = null; at = null;
      puck.style.opacity = '0';
      return;
    }
    const to = { x: btn.offsetLeft, y: btn.offsetTop, w: btn.offsetWidth, h: btn.offsetHeight };
    if (!to.w) return;
    if (at && at.x === to.x && at.y === to.y && at.w === to.w && at.h === to.h) return;
    const kf = { transform: `translate(${to.x}px, ${to.y}px)`, width: to.w + 'px', height: to.h + 'px' };
    let from = null;
    if (anim && anim.playState === 'running') {
      const cs = getComputedStyle(puck);
      from = { transform: cs.transform, width: cs.width, height: cs.height };
    } else if (at) from = { transform: `translate(${at.x}px, ${at.y}px)`, width: at.w + 'px', height: at.h + 'px' };
    anim?.cancel(); anim = null;
    Object.assign(puck.style, kf);
    const fresh = puck.style.opacity !== '1';
    puck.style.opacity = '1';
    at = to;
    if (!animate || quiet()) return;
    if (fresh || !from) {
      // 从没选中到选中（自动 → 某一档）：墨块在原地长出来，不从别处飞来
      anim = puck.animate([{ ...kf, opacity: 0, scale: '.86' }, { ...kf, opacity: 1, scale: '1' }], { duration: SPRING_SNAP.ms, easing: springEasing(SPRING_SNAP) });
      return;
    }
    anim = puck.animate([from, kf], { duration: SPRING_SNAP.ms + 60, easing: springEasing(SPRING_SNAP) });
  }

  // 选中值 / 选项文字变了：滑过去（换模型时常是同样几项、同一个选中值，文字变了宽度也变，要重量）
  let mounted = false;
  $effect(() => {
    void target; void options.map((o) => String(o.value) + '\u0002' + o.label).join('\u0001'); void layout; void cols;
    untrack(() => { overflowCheck(); place(mounted); mounted = true; });
  });
  // 尺寸变了（浮层弹开、坞拉宽、折行）：直接落位，不滑
  $effect(() => {
    if (!track) return;
    const ro = new ResizeObserver(() => { at = null; anim?.cancel(); anim = null; overflowCheck(); place(false); });
    ro.observe(track);
    return () => { ro.disconnect(); anim?.cancel(); clearTimeout(recheck); };
  });

  function down(v, dis) { if (!dis) pressed = v; }
  // 松手：点击紧跟着到（同一轮），先让它落定再清「按着的」——否则墨块先弹回旧值再滑过去
  function up() { if (pressed != null) setTimeout(() => { pressed = null; }, 0); }
  // clearable：再点一下选中的那项 = 清掉（候选词这类，可以一个都不选）
  function pick(v) { pressed = null; if (v !== value) onchange?.(v); else if (clearable) onchange?.(null); }
  function act(node, v) { return item ? item(node, v) : {}; }
  // 方向键在选项间移动（跳过不可用的），Home / End 到头尾
  function keys(e) {
    onkeydown?.(e);
    if (e.defaultPrevented) return;
    const list = options.filter((o) => !o.disabled);
    const i = list.findIndex((o) => o.value === value);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = Math.min(list.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    if (j < 0 || j === i || !list[j]) return;
    e.preventDefault();
    pick(list[j].value);
    queueMicrotask(() => track?.querySelector(`[data-v="${CSS.escape(String(list[j].value))}"]`)?.focus());
  }
</script>

<svelte:window onpointerup={up} onpointercancel={up} />

<div class="sg {size} {layout}" class:full class:mono class:dim class:paper={tone === 'paper'} bind:this={track} role="radiogroup" aria-label={label || null} tabindex="-1"
  style={layout === 'grid' ? `--cols:${cols || Math.min(6, options.length || 1)}` : null} onkeydown={keys}>
  <span class="sg-pk" bind:this={puck} aria-hidden="true"></span>
  {#each options as o (String(o.value))}
    {@const on = o.value === target}
    <button type="button" class="sg-o" class:on class:rej={o.rejected} class:dnd-on={!!overKey && overKey === keyOf(o.value)} role="radio" aria-checked={o.value === value}
      tabindex={o.value === value || (value == null && o === options[0]) ? 0 : -1} data-v={String(o.value)} disabled={o.disabled} title={o.title || null}
      onpointerdown={() => down(o.value, o.disabled)} onclick={() => pick(o.value)} use:act={o.value}>
      {#if o.glyph}<span class="sg-g" aria-hidden="true">{@html o.glyph}</span>{/if}
      <span class="sg-t">{o.label}</span>{#if o.hint}<small class="sg-h">{o.hint}</small>{/if}{#if o.dot}<span class="sd-dot" class:live={o.dot === 'live'} aria-hidden="true"></span>{/if}
    </button>
  {/each}
</div>
