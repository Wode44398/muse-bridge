<script lang="ts">
  // U2（X36 第二步、hermes N18 / N17a）：待送达的插话——运行中插的话还没被模型读到之前停在这里，不进时间线（以前一发出就进时间线，
  // 十分钟的工作流跑着，看上去像已经读到了）。上面一行写明什么时候送到（模型只在两步之间读插话：正在跑长命令、工作流时要等它跑完）。
  // 长得像还没送出的用户气泡：靠右、淡一档。服务端有 steer-withdraw 能力时每条可以「撤回」（放回输入框改）或
  // 「立即中断并发送」（只停这一轮、后台的 dev server 与命令留着，以这句重新开始）。真被读到时才挪进时间线。
  import { interruptWithPendingSteer, steerTrayActions, withdrawPendingSteer } from "../../lib/state.svelte.ts";
  import { steerDeliveryHint, type PendingSteer } from "../../lib/timeline-reducer.ts";
  import { collapse } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import Button from "../ui/Button.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  const hint = $derived(steerDeliveryHint(pane.chat.timeline));
  const actions = $derived(steerTrayActions());
  let busy = $state<string | null>(null);

  async function act(s: PendingSteer, kind: "withdraw" | "interrupt") {
    if (busy) return;
    busy = s.id;
    try {
      await (kind === "withdraw" ? withdrawPendingSteer(s) : interruptWithPendingSteer(s));
    } finally {
      busy = null;
    }
  }
</script>

<div class="tray" role="status" aria-label={t("待送达的插话")}>
  <p class="hint"><Icon name="clock" size={13} /><span>{hint}</span></p>
  {#each pane.chat.pendingSteers as s (s.id)}
    <div class="row" transition:collapse>
      <div class="rowin" class:busy={busy === s.id}>
        <p class="bubble">{s.text}</p>
        {#if actions}
          <div class="acts">
            <Button size="sm" variant="ghost" disabled={Boolean(busy)} title={t("撤回，放回输入框改")} onclick={() => act(s, "withdraw")}>{t("撤回")}</Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy)}
              title={t("停下这一轮，按这句重新开始（后台的 dev server 与命令留着）")}
              onclick={() => act(s, "interrupt")}>{t("立即中断并发送")}</Button
            >
          </div>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .tray {
    display: flex;
    flex-direction: column;
    align-items: stretch;
  }
  .hint {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
    margin: 0 4px 2px;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--text3);
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
    background: color-mix(in srgb, var(--user-bubble) 62%, transparent);
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
  /* 触屏：小号按钮看着 28，点得到 40 */
  @media (pointer: coarse) {
    .acts > :global(button)::after {
      content: "";
      position: absolute;
      inset: -6px -2px;
    }
  }
</style>
