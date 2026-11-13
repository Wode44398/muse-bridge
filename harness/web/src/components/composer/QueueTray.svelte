<script lang="ts">
  // 稍后发送的队列（Ctrl+Enter 排进来的话，这一轮结束后合并成一条发出）。与插话托盘同一种样子：靠右、淡一档的待发气泡。
  // 一条：直接列出；多条：收成一行「N 条排队 · 下一条：…」，点开看全部。每条可以「立即发送」（改成插话，这一轮下一步就读到）、
  // 「编辑」（拿回输入框）、「移除」；多条时可「全部清除」。数据在服务端（重启不丢、各设备同步），这里只显示与发动作。
  import { clearQueued, editQueued, promoteQueued, queueOf, removeQueued, type QueueItem } from "../../lib/sessmgmt.svelte.ts";
  import { collapse } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import Button from "../ui/Button.svelte";

  const pane = usePane();
  const items = $derived(queueOf(pane.chat));
  let open = $state(false);
  let busy = $state<string | null>(null);
  const expanded = $derived(items.length <= 1 || open);

  async function act(item: QueueItem | null, kind: "promote" | "edit" | "remove" | "clear") {
    if (busy) return;
    busy = item?.id ?? "*";
    haptic("light");
    try {
      if (kind === "clear") await clearQueued(pane.chat);
      else if (kind === "promote") await promoteQueued(pane.chat, item!);
      else if (kind === "edit") await editQueued(pane.chat, item!);
      else await removeQueued(pane.chat, item!);
    } finally {
      busy = null;
    }
  }
</script>

<div class="tray" role="status" aria-label={t("稍后发送")}>
  <div class="head">
    <Icon name="clock" size={13} />
    {#if items.length > 1}
      <button class="sum" onclick={() => (open = !open)} aria-expanded={open}>
        <span>{t("{n} 条排队，这一轮结束后合并发出", { n: items.length })}</span>
        <span class="chev" class:open><Icon name="chevronD" size={12} /></span>
      </button>
      <Button size="sm" variant="ghost" disabled={Boolean(busy)} onclick={() => act(null, "clear")}>{t("全部清除")}</Button>
    {:else}
      <span>{t("这一轮结束后发出")}</span>
    {/if}
  </div>
  {#if !expanded && items[0]}
    <p class="next">{t("下一条：{text}", { text: items[0].text })}</p>
  {/if}
  {#if expanded}
    <div transition:collapse>
      {#each items as item (item.id)}
        <div class="row" transition:collapse>
          <div class="rowin" class:busy={busy === item.id}>
            <p class="bubble">{item.text}</p>
            <div class="acts">
              <Button size="sm" variant="ghost" disabled={Boolean(busy)} title={t("移除这条")} onclick={() => act(item, "remove")}>{t("移除")}</Button>
              <Button size="sm" variant="ghost" disabled={Boolean(busy)} title={t("拿回输入框改")} onclick={() => act(item, "edit")}>{t("编辑")}</Button>
              <Button size="sm" variant="outline" disabled={Boolean(busy)} title={t("现在就作为插话发出，它会在下一步读到")} onclick={() => act(item, "promote")}
                >{t("立即发送")}</Button
              >
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tray {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
    margin: 0 4px 2px;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
  .sum {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .chev {
    display: inline-flex;
    transition: transform var(--t-med) var(--ease);
  }
  .chev.open {
    transform: rotate(180deg);
  }
  .next {
    margin: 0 4px;
    text-align: right;
    font-size: var(--fs-sm);
    color: var(--text2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rowin {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    padding-top: 6px;
    transition: opacity var(--t-med) var(--ease);
  }
  .rowin.busy {
    opacity: 0.5;
  }
  .bubble {
    max-width: min(86%, 560px);
    margin: 0;
    padding: 8px 14px;
    border-radius: 18px;
    border: 1px dashed var(--border2);
    background: color-mix(in srgb, var(--user-bubble) 40%, transparent);
    color: var(--text2);
    font-size: var(--fs-base);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  @media (pointer: coarse) {
    .acts > :global(button)::after {
      content: "";
      position: absolute;
      inset: -6px -2px;
    }
  }
</style>
