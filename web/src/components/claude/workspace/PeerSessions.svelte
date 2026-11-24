<script>
  // 共用项目块里「对方的会话」那一组（peerSessions）：细分隔线 + 淡字标题「Antigravity」+ 计数，下面一行一个会话；
  // 在跑的行尾写「在跑」并带一枚对方的小标志。点一行 = 在本页右侧的预览栏里看（AgyPeek）；要跳过去用预览栏头部的「在 Antigravity 打开」。
  // 行的几何对齐 Claude 自己的会话行（缩进 28、文字起点 36），字小一号、颜色淡一档：看得出是别人的。
  import AgentTile from './AgentTile.svelte';
  import { agentName } from './decor.js';
  import { openTarget } from '../../../lib/pluginUi.svelte.js';
  import { openAgyPeek, agyPeek } from '../../../lib/claudePage/agyPeek.svelte.js';
  import { t, tr } from '../../../lib/i18n.js';

  let { item, path = '', onopen = null } = $props();

  const groups = $derived((item?.peerSessions || []).filter((g) => g.agent !== 'claude' && (g.items || []).length));

  async function open(g, s) {
    onopen?.();
    // 预览栏只看 Antigravity 的会话；以后别的 agent 也列进来时先照旧跳过去
    if (g.agent === 'agy') openAgyPeek({ id: s.id, title: s.title, path, plugin: item.plugin });
    else await openTarget({ session: { agent: g.agent, id: s.id } }, { plugin: item.plugin, path, agent: 'claude' });
  }
</script>

{#each groups as g (g.agent)}
  <div class="ps-sec" role="presentation"><span>{agentName(g.agent)}</span><span class="ps-ct">{g.items.length}</span></div>
  {#each g.items as s (s.id)}
    <button class="ps-row" class:cur={agyPeek.open && agyPeek.sid === s.id} type="button" title={t('查看对话')} onclick={() => open(g, s)}>
      <span class="ps-t">{tr(s.title) || t('（无标题）')}</span>
      {#if s.live}
        <span class="ps-m live"><AgentTile agent={g.agent} size={12} mark="writing" bare />{t('在跑')}</span>
      {:else if s.meta}
        <span class="ps-m">{tr(s.meta)}</span>
      {/if}
    </button>
  {/each}
{/each}

<style>
  .ps-sec { position: relative; display: flex; align-items: center; gap: 6px; height: 28px; margin: 4px 0 0 28px; padding: 0 10px 0 8px;
    color: var(--muted); font-size: 12px; }
  .ps-sec::before { content: ''; position: absolute; left: 8px; right: 10px; top: 0; height: 1px; background: var(--divider); }
  .ps-ct { margin-left: auto; font-variant-numeric: tabular-nums; }
  .ps-row { width: calc(100% - 28px); margin: 0 0 .5px 28px; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px 0 8px;
    border-radius: 8px; color: var(--serif); font-size: 13px; text-align: left; transition: background-color 60ms cubic-bezier(.165, .84, .44, 1), color 60ms cubic-bezier(.165, .84, .44, 1); }
  .ps-row:active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .ps-row:hover { background: var(--hover); color: var(--text); } }
  .ps-row.cur, .ps-row.cur:hover { background: var(--hover-strong); color: var(--text); }
  .ps-row:focus-visible { outline: none; background: var(--hover); color: var(--text); }
  .ps-t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ps-m { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  @media (pointer: coarse) { .ps-row { height: 36px; } }
</style>
