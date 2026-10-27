<script lang="ts">
  // 本机模型（llama.cpp）状态胶囊：只在这个会话 / 全局的服务是「本机」时出现。圆点：就绪 = 绿（面板里写着「就绪后圆点变绿」）、
  // 加载中 = 青色呼吸、没跑 = 空心圈。点开是 LocalAiMenu（由 Composer 渲染在输入框卡片外面）。
  // 轮询：平时 20 秒一拍保持圆点鲜活；面板开着或正在加载收紧到 2 秒。compact = 窄屏只留圆点。
  import { app } from "../../lib/state.svelte.ts";
  import { lai, localAiState, localAiStateText, refreshLocalAi, setLocalEngine } from "../../lib/localai.svelte.ts";
  import { engineOfModel } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import Chip from "../ui/Chip.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    onclick,
    open = false,
    compact = false,
  }: { onclick: (e: MouseEvent) => void; open?: boolean; compact?: boolean } = $props();

  const provider = $derived(pane.chat.cfg?.provider ?? app.config?.provider);
  // 两台引擎：圆点报的是当前型号那一台（Strata 125B 或 Qwen 27B）；面板开着时用户可能切去看另一台，不抢
  const engine = $derived(engineOfModel(pane.chat.cfg?.model ?? app.config?.model));
  const phase = $derived(localAiState());
  const text = $derived(localAiStateText());

  $effect(() => {
    if (provider === "local" && !lai.open) setLocalEngine(engine);
  });

  $effect(() => {
    if (provider !== "local") return;
    void refreshLocalAi();
    const iv = setInterval(() => void refreshLocalAi(), lai.open || phase === "starting" ? 2000 : 20000);
    return () => clearInterval(iv);
  });
</script>

{#snippet dot()}
  <span class="dot" class:on={phase === "on"} class:starting={phase === "starting"} aria-hidden="true"></span>
{/snippet}
{#snippet label()}
  <span class:hx-shimmer={phase === "starting"}>{text}</span>
{/snippet}

{#if provider === "local"}
  <Chip
    leading={dot}
    children={compact ? undefined : label}
    chevron
    {open}
    label={t("本机模型：{status}", { status: text })}
    title={t("本机模型服务状态（点开展开控制面板）")}
    onclick={(e) => {
      haptic("light");
      onclick(e);
    }}
  />
{/if}

<style>
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    margin: 0 1px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--text3);
    transition:
      background-color var(--t-med) var(--ease),
      box-shadow var(--t-med) var(--ease);
  }
  .dot.on {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent);
  }
  .dot.starting {
    background: var(--live);
    box-shadow: none;
    animation: lai-breathe 1.4s var(--ease-in-out) infinite;
  }
  @keyframes lai-breathe {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.starting {
      animation: none;
    }
  }
</style>
