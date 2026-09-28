<script lang="ts">
  // P10（E1）：等你处理的卡在时间线里的占位行——卡片本身只在输入框上方的停靠区渲染一份，这里原位留一行：
  // 图标 + 一句「在哪」（slotText）+ 一根带端点的尺寸线。停着的那张，线与图标亮成青色（从左往右量过去）。
  // 落定后时间线把这一行换成回执（<AskCard/PermissionCard/PlanCard {item}/>），回执从这一行的真实高度长出来
  // （slotTrack 记高度 → 回执的 settleIn；别的占位行组件不挂 slotTrack 也行，回执按一行的高度估）。
  // 用法：{#if isPendingCard(item, pane.chat.running)}<CardSlot {item} />{:else}<PermissionCard {item} />{/if}
  import { slotText, type CardItem } from "../../lib/card-dock.ts";
  import Icon from "../ui/Icon.svelte";
  import Measure from "../ui/Measure.svelte";
  import { slotTrack } from "./card-actions.ts";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { item }: { item: CardItem } = $props();

  const here = $derived(pane.chat.dockedCardId === item.id);
  const text = $derived(slotText(item, here, !pane.chat.dockedCardId));
  const icon = $derived(item.kind === "permission" ? "shield" : item.kind === "ask" ? "question" : "todo");
</script>

<div class="slot" class:here role="note" use:slotTrack={item.id}>
  <span class="ico"><Icon name={icon} size={14} stroke={1.8} /></span>
  <span class="txt">{text}</span>
  <span class="line" aria-hidden="true"><Measure value={here ? 1 : 0} tone="accent" /></span>
</div>

<style>
  .slot {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    min-width: 0;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
    transition: color var(--t-med) var(--ease);
  }
  .ico {
    flex: none;
    display: inline-flex;
    transition: color var(--t-med) var(--ease);
  }
  .txt {
    flex: 0 1 auto;
    min-width: 0;
  }
  .line {
    flex: 1 1 40px;
    min-width: 32px;
  }
  .here {
    color: var(--text2);
  }
  .here .ico {
    color: var(--accent);
  }
</style>
