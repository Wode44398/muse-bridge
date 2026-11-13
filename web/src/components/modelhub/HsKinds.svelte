<script>
  // 种类分栏：文本 / 图像 / 视频 / 配音 / 音乐。宽屏一条分段控件（滑块按实测段位滑动），窄屏一行横滑胶囊（两端渐隐）。
  // 数量为 0 的段置灰不可点；有已添加的显示「已添加 / 总数」，没有就只给总数。
  import { tick } from 'svelte';
  import HsSeg from './HsSeg.svelte';
  import { KIND_ICON } from './kindIcons.js';
  import { edgeFade } from './HsKit.js';
  import { KINDS, KIND_NAME } from '../../lib/modelHub.svelte.js';
  import { reduced } from '../../lib/motion.js';
  import { t, tr } from '../../lib/i18n.js';

  // counts: { text: { all, added }, … }；controls：分栏控制的列表 id（aria-controls）
  let { kind, counts = {}, onpick, narrow = false, controls = '' } = $props();

  const opts = $derived(KINDS.map((k) => ({ value: k, disabled: !(counts[k]?.all > 0) && k !== kind })));
  const nameOf = (k) => tr(KIND_NAME[k]);

  let pills = $state();
  // 窄屏胶囊的方向键：跳过置灰的，焦点跟着选中走；选中的那枚滚进视野
  async function pillKey(e, i) {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let k = 1; k <= KINDS.length; k++) {
      const j = (((i + dir * k) % KINDS.length) + KINDS.length) % KINDS.length;
      if (!opts[j].disabled) {
        onpick?.(KINDS[j]);
        await tick();
        pills?.querySelectorAll('button')[j]?.focus();
        return;
      }
    }
  }
  $effect(() => {
    kind;
    if (!narrow || !pills) return;
    // 选中的胶囊不在视野里（比如默认停在了音乐）就滚过去；只动这一条横滑容器，不牵动外层滚动
    const el = pills.querySelector('[aria-selected="true"]');
    if (!el) return;
    const l = el.offsetLeft - 16, r = el.offsetLeft + el.offsetWidth + 16 - pills.clientWidth;
    // 减弱动效时直接到位，不滑
    const behavior = reduced() ? 'auto' : 'smooth';
    if (pills.scrollLeft > l) pills.scrollTo({ left: l, behavior });
    else if (pills.scrollLeft < r) pills.scrollTo({ left: r, behavior });
  });
</script>

{#snippet seg(o, on)}
  <span class="kic" aria-hidden="true">{@html KIND_ICON[o.value]}</span>
  <span class="nm">{nameOf(o.value)}</span>
  {@render num(o.value, on)}
{/snippet}

{#snippet num(k, on)}
  {@const c = counts[k] || { all: 0, added: 0 }}
  <span class="ct" class:on>
    {#if c.added > 0}<b>{c.added}</b><i>/{c.all}</i>{:else}{c.all}{/if}
  </span>
{/snippet}

{#if narrow}
  <div class="pills" role="tablist" aria-label={t('模型种类')} bind:this={pills} use:edgeFade>
    {#each KINDS as k, i (k)}
      {@const on = k === kind}
      <button type="button" class="pill" class:on role="tab" aria-selected={on} aria-controls={controls || undefined}
        tabindex={on ? 0 : -1} disabled={opts[i].disabled} onclick={() => { if (!on) onpick?.(k); }} onkeydown={(e) => pillKey(e, i)}>
        <span class="kic" aria-hidden="true">{@html KIND_ICON[k]}</span>
        <span class="nm">{nameOf(k)}</span>
        {@render num(k, on)}
      </button>
    {/each}
  </div>
{:else}
  <HsSeg tabs size="big" label={t('模型种类')} options={opts} value={kind} onchange={(v) => onpick?.(v)} item={seg} {controls} />
{/if}

<style>
  /* 不叫 .ic：app.css 有全局 .ic（图标字体） */
  .kic { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; }
  .kic :global(svg) { width: 16px; height: 16px; }
  .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ct { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--st-muted); transition: color var(--mo-micro) var(--ea-fade); }
  .ct b { font-weight: 600; color: var(--st-text2); }
  .ct i { font-style: normal; }
  .ct.on { color: var(--st-text2); }
  .ct.on b { color: var(--text); }

  /* 窄屏：横滑胶囊，44 高（触屏命中区），两端渐隐只在那一侧还有内容时出现（edgeFade 写 --fl / --fr） */
  .pills { display: flex; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; margin: 0 -16px; padding: 0 16px;
    -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent);
    mask-image: linear-gradient(to right, transparent, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent); }
  .pills::-webkit-scrollbar { display: none; }
  .pill { flex: none; display: inline-flex; align-items: center; gap: 7px; height: 44px; padding: 0 16px; border: 0; border-radius: 22px;
    background: var(--st-surface); color: var(--st-text2); font: inherit; font-size: 15px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .pill:active:not(:disabled) { transform: scale(.96); }
  .pill.on { background: var(--st-primary); color: var(--st-primary-ink); }
  .pill.on .ct { color: color-mix(in srgb, var(--st-primary-ink) 62%, transparent); }
  .pill.on .ct b { color: var(--st-primary-ink); }
  .pill:disabled { opacity: .4; cursor: default; }
  .pill:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--pm-bg), 0 0 0 4px var(--text); }
  @media (prefers-reduced-motion: reduce) { .pill { transition: none; } .pill:active:not(:disabled) { transform: none; } }
</style>
