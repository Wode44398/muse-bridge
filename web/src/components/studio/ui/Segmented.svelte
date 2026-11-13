<script>
  // 分段控件（方案 §9.2：四个创作页的切换、短枚举参数、作品｜文件）。做法照 dimensio 的 components/ui/Segmented.svelte：
  // 选中块是一块会滑动的白纸（快弹簧 spring-snap），不是逐个按钮变色；第一次落位不滑；按下就先滑向按着的那项。
  // 每一项可以带 trail（例如创作页有任务在跑时那粒朱点）。item(node, value) 给调用方挂落点之类的动作。
  import { untrack } from 'svelte';

  let { options = [], value, onchange, size = 'md', full = false, mono = false, label = '', item = null, overKey = '', keyOf = (v) => v, onkeydown = null, onoverflow = null } = $props();

  let track = $state();
  let ind = $state({ x: 0, w: 0, shown: false, animate: false });
  let pressed = $state(null);
  const target = $derived(pressed ?? value);
  let placedOnce = false;

  // 放不下（字被省略号切掉，系统字号放大时常见）就告诉调用方，参数行据此换成选择钮 + 菜单
  function checkFit() {
    if (!onoverflow || !track) return;
    const cut = [...track.querySelectorAll('button > span:first-child')].some((s) => s.scrollWidth > s.clientWidth + 1);
    if (cut) onoverflow();
  }
  function measure() {
    checkFit();
    const key = target;
    const btn = track?.querySelector(`[data-v="${CSS.escape(String(key))}"]`);
    const prev = untrack(() => ind);
    if (!btn) { if (prev.shown) ind = { ...prev, shown: false }; return; }
    const x = btn.offsetLeft, w = btn.offsetWidth;
    if (prev.shown && prev.x === x && prev.w === w) return;
    ind = { x, w, shown: true, animate: placedOnce };
    placedOnce = true;
  }
  // 选项文字变了也要重量（换模型时常是同样 3 项、同一个选中值、尺寸也不变，ResizeObserver 不会响）
  $effect(() => { void target; void options.map((o) => o.label).join(''); measure(); });
  $effect(() => {
    if (!track) return;
    const ro = new ResizeObserver(() => { const a = placedOnce; placedOnce = false; measure(); placedOnce = a || ind.shown; });
    ro.observe(track);
    return () => ro.disconnect();
  });
  function down(v, dis) { if (!dis) pressed = v; }
  // 松手：点击事件紧跟着到（同一轮），先让它落定再清「按着的」——否则选中块会先弹回旧值再滑过去
  function up() { if (pressed != null) setTimeout(() => { pressed = null; }, 0); }
  function pick(v) { pressed = null; if (v !== value) onchange?.(v); }
  // 调用方给的每项动作（落点之类）：没给就什么都不做
  function act(node, v) { return item ? item(node, v) : {}; }
</script>

<svelte:window onpointerup={up} onpointercancel={up} />

<div class="seg {size}" class:full class:mono bind:this={track} role="radiogroup" aria-label={label || null} tabindex="-1" {onkeydown}>
  <span class="seg-ind" class:shown={ind.shown} class:animate={ind.animate} style="transform:translateX({ind.x}px);width:{ind.w}px"></span>
  {#each options as o (String(o.value))}
    <button type="button" role="radio" aria-checked={o.value === value} tabindex={o.value === value ? 0 : -1}
      class:on={o.value === target} class:dnd-on={!!overKey && overKey === keyOf(o.value)}
      data-v={String(o.value)} disabled={o.disabled} title={o.title || null}
      onpointerdown={() => down(o.value, o.disabled)} onclick={() => pick(o.value)} use:act={o.value}>
      <span>{o.label}</span>{#if o.dot}<span class="sd-dot" class:live={o.dot === 'live'} aria-hidden="true"></span>{/if}
    </button>
  {/each}
</div>
