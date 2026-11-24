<script>
  // 插件给的图标名：'claude' / 'agy' 画该 agent 的单色标志（跟着文字色），其余走 pluginIcon()。
  // 菜单、对话框条目共用；尺寸由外层框定。
  import ClaudeSpark from './ClaudeSpark.svelte';
  import AgentTile from './AgentTile.svelte';
  import { uiIcon } from '../../../lib/pluginUi.svelte.js';

  let { name = '', size = 16 } = $props();
</script>

{#if name === 'claude'}
  <ClaudeSpark {size} />
{:else if name === 'agy'}
  <AgentTile agent="agy" {size} bare mono />
{:else}
  <span class="wi" style="width:{size + 1}px;height:{size + 1}px" aria-hidden="true">{@html uiIcon(name)}</span>
{/if}

<style>
  .wi { display: inline-flex; flex: none; }
  .wi :global(svg) { width: 100%; height: 100%; }
</style>
