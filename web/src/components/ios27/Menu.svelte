<script>
  // iOS 27 上下文菜单（kit「Menu」「Menu Items」）：「Liquid Glass - Regular - Medium」圆角 34 面板，
  // 上下内距 10；每项左右 16、行高 20 的 17pt 正文 + 左侧 28 宽符号列；破坏性项红色（Accents/Red）；
  // 可带 13pt 分组标题（Labels - Vibrant/Tertiary）。玻璃层复用警告框的烘焙（同材质同圆角，底同为压暗页面）。
  // items：{ label, symbol?, icon?（没有对应 SF 字形时的线稿 SVG 字串）, tint?, destructive?, disabled?, detail?（副标题）, checked?（行尾对勾）, onclick }
  //        或 { sep: true }（kit「Menu Separator」：左右内缩 24 的 1pt 细线，上下各 6）。
  // origin：从哪儿缩放出现（CSS transform-origin，默认顶部居中）；长按菜单传按压点，菜单就从手指下长出来。
  import { ovUrl } from '../../lib/overlay.svelte.js';
  import { getContext } from 'svelte';
  import Sym from './Sym.svelte';
  import glassL_pub from '../../assets/ios27/alert-light.png';
  const glassL = $derived(ovUrl('ios27/alert-light.png', glassL_pub));
  import glassD_pub from '../../assets/ios27/alert-dark.png';
  const glassD = $derived(ovUrl('ios27/alert-dark.png', glassD_pub));

  let { x = 0, y = 0, width = 250, title = '', items = [], origin = '', onclose } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);
  let armed = false;
  $effect(() => { const t = setTimeout(() => { armed = true; }, 280); return () => clearTimeout(t); });
  function dismiss() { if (armed) onclose?.(); }
</script>

<div class="mn-root" role="presentation">
  <button class="mn-dim" type="button" tabindex="-1" aria-label={title} onclick={dismiss} oncontextmenu={(e) => { e.preventDefault(); dismiss(); }}></button>
  <div class="mn" class:dark role="menu" aria-label={title} style:left="{x}px" style:top="{y}px" style:width="{width}px"
    style:transform-origin={origin || null} style:--glass={`url("${dark ? glassD : glassL}")`}>
    {#if title}<div class="mn-title">{title}</div>{/if}
    {#each items as it, i (it.sep ? 'sep' + i : it.label + '\x1f' + i)}
      {#if it.sep}
        <div class="mn-sep" role="separator"></div>
      {:else}
        <button type="button" role="menuitem" class="mn-it" class:danger={it.destructive} disabled={it.disabled}
          onclick={() => { if (armed) it.onclick?.(); }}>
          <span class="mn-sym" style:color={it.tint || null}>{#if it.symbol}<Sym name={it.symbol} weight={400} size={17} />{:else if it.icon}{@html it.icon}{/if}</span>
          <span class="mn-lbl">{it.label}{#if it.detail}<small class="mn-detail">{it.detail}</small>{/if}</span>
          {#if it.checked}<span class="mn-check"><Sym name="checkmark" weight={600} size={15} /></span>{/if}
        </button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .mn-root { position: fixed; inset: 0; z-index: 95; }
  .mn-dim { position: absolute; inset: 0; border: 0; padding: 0; background: rgba(41, 41, 58, .12); cursor: default; animation: mn-fade 200ms linear both; }
  .mn {
    position: absolute; padding: 10px 0; border-radius: 34px; isolation: isolate; color: #0c0c0e; transform-origin: top center;
    -webkit-backdrop-filter: blur(6.53px); backdrop-filter: blur(6.53px);
    box-shadow: 0 8px 40.6px rgba(0, 0, 0, .25);
    animation: mn-in 360ms cubic-bezier(.25, 1.25, .4, 1) both;
  }
  .mn.dark { color: #fff; box-shadow: 0 8px 40.6px rgba(0, 0, 0, .45); }
  .mn::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--glass) 228 fill / 76px / 16px stretch; }
  @keyframes mn-fade { from { opacity: 0; } }
  @keyframes mn-in { from { opacity: 0; transform: scale(.6); } }
  .mn-title { padding: 4px 24px 10px; font-size: 13px; line-height: 15px; font-weight: 500; letter-spacing: -.08px; color: #b1b1b3; }
  .mn.dark .mn-title { color: #5a5a5a; }
  .mn-it {
    display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 10px 24px 10px 22px;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  .mn-it:active:not(:disabled) { background: rgba(120, 120, 128, .16); }
  .mn-it.danger { color: var(--i-red, #ff383c); }
  /* 禁用项（kit State=Disabled）：标签与符号一起退到三级色 */
  .mn-it:disabled { color: #b1b1b3; cursor: default; }
  .mn.dark .mn-it:disabled { color: #5a5a5a; }
  .mn-sym { width: 28px; flex: none; display: flex; justify-content: center; }
  .mn-sym :global(svg:not(.sym)) { width: 21px; height: 21px; }
  .mn-lbl { flex: 1; min-width: 0; font-size: 17px; line-height: 20px; letter-spacing: -.43px; }
  /* 副标题（kit Menu Item「Subtitle」）：15pt 次级色，长了省略 */
  .mn-detail { display: block; margin-top: 1px; font-size: 15px; line-height: 18px; letter-spacing: -.23px; color: #8a8a8e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mn.dark .mn-detail { color: #98989d; }
  /* 选中项（单选菜单）：行尾对勾 */
  .mn-check { flex: none; display: flex; margin-left: 8px; }
  /* 分隔线（kit Menu Separator）：左右内缩 24；亮 #E6E6E6 / 暗 #363638 是 Separators/Vibrant 落在玻璃上的等效色 */
  .mn-sep { height: 1px; margin: 6px 24px; background: #e3e3e5; }
  .mn.dark .mn-sep { background: #363638; }
</style>
