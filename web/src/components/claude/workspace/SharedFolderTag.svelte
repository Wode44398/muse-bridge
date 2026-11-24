<script>
  // 输入框上方目录芯片里、项目名后面那一截：插件把这个文件夹标成和别的 agent 共用时，带一枚小方块和「与 Antigravity 共用」淡字。
  // worktree 会话的目录是 <仓库>/.claude/worktrees/<名>，按主仓库根再找一次（外观登记的是项目目录）。
  import AgentTile from './AgentTile.svelte';
  import { peerOf, agentName, tileMark } from './decor.js';
  import { decorFor } from '../../../lib/pluginUi.svelte.js';
  import { t } from '../../../lib/i18n.js';

  let { ws = '' } = $props();

  const root = $derived(String(ws || '').replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]*$/, ''));
  const item = $derived(ws ? decorFor('claude', ws) || (root !== ws ? decorFor('claude', root) : null) : null);
  const peer = $derived(peerOf(item));
</script>

{#if peer}
  <span class="sft"><AgentTile agent={peer} size={16} mark={tileMark(item)} /><span class="sft-t">{t('与 {agent} 共用', { agent: agentName(peer) })}</span></span>
{/if}

<style>
  .sft { display: inline-flex; align-items: center; gap: 6px; margin-left: 2px; min-width: 0; animation: sftIn 200ms cubic-bezier(.165, .84, .44, 1) both; }
  .sft-t { font-size: 12px; color: var(--muted); white-space: nowrap; }
  @keyframes sftIn { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .sft { animation: none; } }
</style>
