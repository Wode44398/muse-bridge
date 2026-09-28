<script lang="ts">
  // Agent 任务卡（bridge Claude 分页 AgentRow 形态 A = 官方 /code 页 Iy）：子 agent 刚起步——还没有任何工具活动、
  // 且不在工具组里——时代替工具行：agent 图标 + 标题（在做的微光）+ ›。第一步工具一出现 ToolRow 就换回工具行
  //（「模型 · 当前步骤 · 步数」实况）。点开 = 工作区「任务」视图里直接压上它的转录。量线上的节点由 ToolRow 画。
  import { openTaskDetail, type ToolItem } from "../../lib/state.svelte.ts";
  import { toolTaskTitle } from "../../lib/tasks.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";

  let { item }: { item: ToolItem } = $props();
  const title = $derived(toolTaskTitle(item));
</script>

<button class="card" onclick={() => openTaskDetail(item.id, item.agent?.id)} aria-label="查看子 agent：{title}" use:press={{ scale: 0.985 }}>
  <span class="ic"><Icon name="agent" size={15} /></span>
  <span class="title hx-shimmer">{title}</span>
  {#if item.agent?.tier === "coder"}<span class="tier">coder</span>{/if}
  <span class="go"><Icon name="chevronR" size={14} stroke={1.9} /></span>
</button>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 320px;
    max-width: 100%;
    min-height: 40px;
    padding: 0 10px 0 12px;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .ic {
    display: inline-flex;
    flex: none;
    color: var(--text2);
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 20px;
  }
  .tier {
    flex: none;
    padding: 1px 7px;
    border-radius: var(--r-pill);
    background: var(--accent-soft);
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 16px;
  }
  .go {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .card:active {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .card:hover {
      background: var(--surface2);
    }
  }
</style>
