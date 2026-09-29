<script lang="ts">
  // C8（K43）：缓存变冷提示——上次请求过去太久、前缀缓存大概冷了，而这段对话又不小：下一条会按全价重读整段。
  // 给两个动作（立即压缩 / 带摘要开新会话）和「知道了」（这个会话不再提；只记在本次挂载里，重开页面会再提）。
  // 30 秒对一次钟；服务端有 hygiene 能力位、这段对话 ≥ 3 万 token、厂商有缓存寿命时才出现（本机 / DeepSeek 不提示）。
  // 自带显隐与过渡（Above 里的一格）。
  import { cacheColdMinutes, compactNow, handoffWithSummary, hygieneAvailable } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import Button from "../ui/Button.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Slot from "./Slot.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  const COLD_MIN_TOKENS = 30_000;
  let now = $state(Date.now());
  $effect(() => {
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(tick);
  });
  let dismissed = $state<string[]>([]);
  let busy = $state<"" | "compact" | "handoff">("");

  const minutes = $derived(
    hygieneAvailable() && pane.chat.id && !dismissed.includes(pane.chat.id) && pane.chat.ctx.used >= COLD_MIN_TOKENS ? cacheColdMinutes(now, pane.chat) : null,
  );
  const kTok = $derived((pane.chat.ctx.used / 1000).toFixed(0));
  // 整句一个键（按分钟数取单复数）；{min} / {tokens} 两处数字仍渲染成等宽的 .num（按占位拆开）
  const msgParts = $derived(
    minutes === null
      ? []
      : t("距上次请求 {min} 分钟，缓存大概已经冷了：这段对话约 {tokens} token，下一条会按全价重读。", { count: minutes }).split(/\{(min|tokens)\}/),
  );

  async function act(kind: "compact" | "handoff") {
    if (busy) return;
    busy = kind;
    haptic("light");
    try {
      await (kind === "compact" ? compactNow() : handoffWithSummary());
    } finally {
      busy = "";
    }
  }
  function dismiss() {
    const id = pane.chat.id;
    if (id) dismissed = [...dismissed, id];
  }
</script>

{#if minutes !== null}
  <Slot>
    <div class="cold" role="status">
      <span class="ic"><Icon name="timer" size={16} /></span>
      <p class="msg">
        {#each msgParts as part, i (i)}{#if i % 2 === 0}{part}{:else}<span class="num">{part === "min" ? minutes : `${kTok}k`}</span>{/if}{/each}
      </p>
      <div class="acts">
        <Button size="sm" variant="secondary" loading={busy === "compact"} disabled={Boolean(busy)} onclick={() => act("compact")}>
          {busy === "compact" ? t("正在压缩…") : t("立即压缩")}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === "handoff"} disabled={Boolean(busy)} onclick={() => act("handoff")}>
          {busy === "handoff" ? t("正在写摘要…") : t("带摘要开新会话")}
        </Button>
        <IconButton icon="close" size={28} iconSize={14} label={t("知道了")} title={t("知道了（这个会话不再提）")} onclick={dismiss} />
      </div>
    </div>
  </Slot>
{/if}

<style>
  .cold {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 10px;
    padding: 9px 8px 9px 14px;
    border-radius: 16px;
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  :global(.hxroot[data-mode="dark"]) .cold {
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-1);
  }
  .ic {
    flex: none;
    display: inline-flex;
    align-self: flex-start;
    margin-top: 2px;
    color: var(--text3);
  }
  .msg {
    flex: 1 1 260px;
    min-width: 0;
    margin: 0;
    font-size: var(--fs-md);
    line-height: var(--lh-ui);
    color: var(--text2);
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-left: auto;
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
