<script lang="ts">
  // P10（E1）：交互态的卡停在输入框上方（只渲染那一份，见 components/cards/CardDock.svelte），时间线原位留这一行；
  // 落定之后照旧显示只读回执。停着的那张 = 「需要你」的 warn 淡底；排队中的只是一行安静的字。
  import { type AskItem, type PermissionItem, type PlanItem } from "../../lib/state.svelte.ts";
  import { slotText } from "../../lib/card-dock.ts";
  import Icon from "../ui/Icon.svelte";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { item }: { item: AskItem | PermissionItem | PlanItem } = $props();

  const here = $derived(pane.chat.dockedCardId === item.id);
</script>

<div class="slot" class:here role="note">
  <span class="ic"><Icon name={item.kind === "permission" ? "shield" : item.kind === "ask" ? "question" : "todo"} size={14} /></span>
  <span class="t">{slotText(item, here, !pane.chat.dockedCardId)}</span>
</div>

<style>
  .slot {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 7px 12px;
    border-radius: var(--r-md);
    font-size: var(--fs-md);
    line-height: 1.45;
    color: var(--text3);
    background: var(--surface2);
    transition:
      background-color var(--t-med) var(--ease),
      color var(--t-med) var(--ease);
  }
  .ic {
    display: inline-flex;
    flex: none;
  }
  .t {
    min-width: 0;
  }
  .here {
    color: var(--text2);
    background: color-mix(in srgb, var(--warn) 10%, transparent);
  }
  .here .ic {
    color: var(--warn);
  }
</style>
