<script>
  // 开关：两套设置外壳各用各的控件——桌面壳 = kit 的 DSwitch，手机 / 网页壳 = ios27 的 Toggle（都读外壳自己的令牌）。
  // onchange(v) 可以返回 Promise。桌面的 DSwitch 点下去自己先翻面：提交完了它显示的和调用方给的值对不上
  // （提交失败、调用方又没做过乐观更新）时重挂一次把它翻回来；ios27 的 Toggle 本来就是受控的，没跟上会自己滑回。
  import { tick } from 'svelte';
  import DSwitch from '../../../desktop/kit/DSwitch.svelte';
  import Toggle from '../../ios27/Toggle.svelte';

  let { shell = 'desk', checked = false, disabled = false, label = '', onchange } = $props();
  let nonce = $state(0);
  let host = $state();

  async function fromDesk(v) {
    try { await onchange?.(v); } catch {}
    await tick();
    const shown = host?.querySelector('[role="switch"]')?.getAttribute('aria-checked');
    if (shown != null && shown !== String(!!checked)) nonce++;
  }
  // DSwitch 没有 aria-label 参数：给里面那颗 role=switch 补上，读屏才知道是哪个开关
  function swLabel(node, text) {
    const set = (s) => node.querySelector('[role="switch"]')?.setAttribute('aria-label', s || '');
    set(text);
    return { update: set };
  }
</script>

{#if shell === 'desk'}
  <span class="dps" bind:this={host}>
    {#key nonce}<span class="dps-in" use:swLabel={label}><DSwitch {checked} {disabled} onchange={fromDesk} /></span>{/key}
  </span>
{:else}
  <span class="dps"><Toggle {checked} {disabled} {label} onchange={() => onchange?.(!checked)} /></span>
{/if}

<style>
  .dps, .dps-in { flex: none; display: inline-flex; align-items: center; }
</style>
