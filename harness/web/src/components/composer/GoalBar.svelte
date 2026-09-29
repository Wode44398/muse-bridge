<script lang="ts">
  // O7（K64）：目标续跑的状态条（输入框上方）——第几轮、验证命令、进行中 / 暂停（写明原因）/ 达成；暂停、继续、结束、收起。
  // 暂停不打断正在跑的这一轮（跑完不再续）；继续再给一份同样的预算。颜色只说状态：在做 = 青，停着等你 = warn，达成 = 一枚绿勾。
  import { goalControl } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import Button from "../ui/Button.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  const g = $derived(pane.chat.goal);
  const used = $derived(g ? Math.max(1, g.round - g.roundBase) : 0);
  let busy = $state(false);
  // 「目标 · 第 x/y 轮」整句一个键，x/y 仍渲染成等宽的 .num（按占位拆开）
  const roundParts = t("目标 · 第 {round} 轮").split("{round}");

  async function act(action: "pause" | "resume" | "clear") {
    if (busy) return;
    busy = true;
    haptic("light");
    try {
      await goalControl(action);
    } finally {
      busy = false;
    }
  }
</script>

{#if g}
  <div class="goal" class:paused={g.status === "paused"} class:done={g.status === "done"} role="status">
    <span class="ic">
      {#if g.status === "done"}<Icon name="check" size={15} stroke={2.2} />{:else}<Icon name="target" size={16} />{/if}
    </span>
    <div class="txt">
      <div class="line">
        <span class="state">
          {#if g.status === "done"}{t("目标已达成")}{:else if g.status === "paused"}{t("目标已暂停")}{:else}{roundParts[0]}<span class="num">{used}/{g.maxRounds}</span>{roundParts[1]}{/if}
        </span>
        {#if g.verify}<span class="ver">{t("验证")} <code>{g.verify}</code></span>{/if}
      </div>
      <div class="sub" title={g.objective}>{g.reason != null ? tr(g.reason) : g.objective}</div>
    </div>
    <div class="acts">
      {#if g.status === "active"}
        <Button size="sm" variant="secondary" disabled={busy} onclick={() => act("pause")}>{t("暂停")}</Button>
      {:else if g.status === "paused"}
        <Button size="sm" variant="ghost" disabled={busy} onclick={() => act("clear")}>{t("结束")}</Button>
        <Button size="sm" variant="accent" disabled={busy} onclick={() => act("resume")}>{t("继续")}</Button>
      {:else}
        <Button size="sm" variant="ghost" disabled={busy} onclick={() => act("clear")}>{tc("dimensio", "收起")}</Button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .goal {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    padding: 8px 8px 8px 14px;
    border-radius: 16px;
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  :global(.hxroot[data-mode="dark"]) .goal {
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-1);
  }
  .ic {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 9px;
    color: var(--accent);
    background: var(--accent-soft);
  }
  .paused .ic {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
  }
  .done .ic {
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 12%, transparent);
  }
  .txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .state {
    flex: none;
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--text);
  }
  .paused .state {
    color: var(--warn);
  }
  .num {
    font-family: var(--font-mono);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .ver {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .ver code {
    font-family: var(--font-mono);
    color: var(--text2);
  }
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
  .acts {
    flex: none;
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
