<script>
  // button 积木：{ label, action, style?: primary|secondary|danger, confirm? }。手机上单独一颗占满列宽（像设置页底部的操作钮），
  // 桌面壳靠左一颗常规按钮。
  import ActButton from './ActButton.svelte';
  let { block, ctx } = $props();
</script>

<div class="bb" class:desk={ctx.variant === 'desktop'}>
  <ActButton label={block.label} act={block.action} confirm={block.confirm || ''} style={block.style} {ctx} full={ctx.variant !== 'desktop'} />
</div>

<style>
  .bb { display: flex; }
  .bb.desk { padding: 0 var(--av-px); }
</style>
