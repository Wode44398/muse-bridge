<script>
  // vmx 通用浮层壳：移动=底部 sheet，桌面(≥1080)=居中弹窗（media-neo.css 控制）。
  // 挂进 neoSheet 关闭注册表——VertexPage 的系统返回 closer 会先关它；桌面 Esc 同效。
  import { onMount } from 'svelte';
  import { registerNeoSheet } from '../../lib/neoSheet.js';
  let { title = '', sub = '', tall = false, onclose, head, children } = $props();
  onMount(() => registerNeoSheet(() => onclose?.()));
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); onclose?.(); } }
</script>

<svelte:window onkeydown={onKey} />

<div class="sh-mask" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose?.(); }}>
  <div class="sh-card">
    <div class="sh-grab"></div>
    {#if title}<div class="sh-tt">{title}{#if sub}<small>{sub}</small>{/if}</div>{/if}
    {#if head}{@render head()}{/if}
    <div class="sh-body" style={tall ? 'min-height:46dvh' : ''}>{@render children?.()}</div>
  </div>
</div>
