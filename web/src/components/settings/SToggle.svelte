<script>
  // claude.ai 同款开关：36×20 胶囊、开 = #2a78d6、16px 白钮，回弹 .12s cubic-bezier(.34,1.3,.64,1)（官方实测）。
  // 窄屏（< 700，手机上这些编辑器整页铺开、是设置页的子页）换成设置页同款 iOS 27 液态玻璃开关（墨色，ios27/Toggle）；
  // compact：行尾的小号开关（Media Studio 模型列表，十几行连成一面墙的那种）在窄屏也保持扁平小号。
  import Toggle from '../ios27/Toggle.svelte';
  import { ui } from '../../lib/state.svelte.js';
  let { checked = false, onchange, disabled = false, label = '', compact = false } = $props();
  const NARROW = '(max-width: 699px)';
  let narrow = $state(typeof window !== 'undefined' && !!window.matchMedia?.(NARROW).matches);
  $effect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq) return;
    const on = () => { narrow = mq.matches; };
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  });
</script>

{#if narrow && !compact}
  <Toggle {checked} {disabled} {label} ink dark={ui.theme !== 'light'} onchange={() => onchange?.(!checked)} />
{:else}
  <button type="button" role="switch" aria-checked={checked} aria-label={label || undefined} class="tg" class:on={checked}
    {disabled} onclick={() => onchange?.(!checked)}><span class="knob"></span></button>
{/if}

<style>
  .tg { position: relative; flex: none; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; cursor: pointer;
    background: color-mix(in srgb, var(--text) 22%, transparent); transition: background-color .15s ease; }
  .tg.on { background: var(--st-accent); }
  .tg:disabled { opacity: .45; cursor: default; }
  .tg:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 2px; }
  .knob { display: block; width: 16px; height: 16px; border-radius: 50%; background: #fff;
    box-shadow: 0 1px 2px rgba(11, 11, 11, .06), 0 2px 8px rgba(11, 11, 11, .08);
    transition: transform .12s cubic-bezier(.34, 1.3, .64, 1); }
  /* 开着时钮的颜色读 --pm-knob-on：墨与象牙的暗色里轨道是浅米色（--st-accent），白钮压上去看不见，宿主把它定成墨色；没定义的宿主照旧白钮 */
  .tg.on .knob { transform: translateX(16px); background: var(--pm-knob-on, #fff); }
  /* 触屏：36×20 的小开关命中区扩到 44×36 左右（视觉不变） */
  @media (pointer: coarse) { .tg::after { content: ''; position: absolute; inset: -8px -4px; } }
</style>
