<script lang="ts">
  // 子 agent 的「此刻」一行（对话流里的子 agent 卡 / 叠卡各行、任务面板里的子 agent 行共用）：
  //   在跑 = 第 N 步 · 动词 + 参数（等宽，单行省略）；还没动手 = 启动中；久无动静 / 限流挂起 = warn 色提示；
  //   做完 = N 次调用 · tok；失败 = 失败 · 原因（err）；被打断 = 已停止。
  // 换步有节流（650ms 内最多换一次，同工具组头行）：连珠炮的快工具不让这一行一直闪；新的一步从下面浮上来。
  // 恒占一行（跑着和跑完一样高，DESIGN §7）。
  import { untrack } from "svelte";
  import { toolMeta } from "../../lib/icons.ts";
  import { fmtTokens, type AgentView } from "../../lib/tasks.ts";
  import { rise } from "../../lib/motion.ts";
  import { t, tr } from "../../lib/i18n.ts";

  let { view }: { view: AgentView } = $props();

  type Step = NonNullable<AgentView["step"]>;
  let shown = $state.raw<Step | null>(untrack(() => view.step));
  let swappedAt = 0;
  $effect(() => {
    const next = view.step;
    if ((next?.id ?? "") === (untrack(() => shown)?.id ?? "")) return;
    const wait = Math.max(0, 650 - (performance.now() - swappedAt));
    const timer = setTimeout(() => {
      shown = next;
      swappedAt = performance.now();
    }, wait);
    return () => clearTimeout(timer);
  });

  const running = $derived(view.status === "running");
  const settled = $derived.by(() => {
    if (running) return "";
    const parts: string[] = [];
    if (view.status === "failed") parts.push(t("失败"));
    else if (view.status === "stopped") parts.push(t("已停止"));
    if (view.error) parts.push(tr(view.error));
    else {
      if (view.calls) parts.push(t("{n} 次调用", { n: view.calls }));
      const tk = fmtTokens(view.tokens);
      if (tk) parts.push(`${tk} tok`);
    }
    return parts.join(" · ") || t("已完成");
  });
</script>

<span class="act" class:bad={view.status === "failed"} class:warn={running && (view.stalled || view.suspended)}>
  {#if !running}
    <span class="txt">{settled}</span>
  {:else if view.suspended}
    <span class="txt">{t("限流挂起，稍后接着跑")}</span>
  {:else if shown}
    {#key shown.id}
      <span class="step" in:rise={{ y: 4 }}>
        <span class="verb">{view.stalled ? t("久无动静") : t("第 {n} 步 · {x}", { n: view.calls, x: toolMeta(shown.name).verb })}</span>
        {#if shown.arg}<span class="arg">{shown.arg}</span>{/if}
      </span>
    {/key}
  {:else}
    <span class="txt">{view.stalled ? t("久无动静") : t("启动中…")}</span>
  {/if}
</span>

<style>
  .act {
    display: flex;
    min-width: 0;
    height: 18px;
    overflow: hidden;
    font-size: var(--fs-sm);
    line-height: 18px;
    color: var(--text3);
  }
  .act.bad {
    color: var(--err);
  }
  .act.warn {
    color: var(--warn);
  }
  .txt {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .step {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .verb {
    flex: none;
    color: var(--text2);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .act.warn .verb {
    color: inherit;
  }
  .arg {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
</style>
