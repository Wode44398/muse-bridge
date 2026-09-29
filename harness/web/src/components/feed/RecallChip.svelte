<script lang="ts">
  // N45：召回对人可见——这一轮开跑时自动找来给模型参考的记忆与项目知识，只露标题、类别与为什么命中（不含正文）。
  // 用户气泡下一行小字「召回 N 条」（与「运行中插话」同一套写法，不抢气泡；触屏上点按区透明扩到 40px）；
  // 点开列出来，有记忆条目时底下可以直接去项目记忆面板。
  import { app } from "../../lib/state.svelte.ts";
  import type { RecallRef } from "../../lib/timeline-types.ts";
  import { haptic } from "../../lib/touch.ts";
  import Icon from "../ui/Icon.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import MenuLabel from "../ui/MenuLabel.svelte";
  import MenuSep from "../ui/MenuSep.svelte";
  import Popover from "../ui/Popover.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { items }: { items: RecallRef[] } = $props();

  let btn: HTMLButtonElement | undefined = $state();
  let open = $state(false);

  const KIND: Record<string, string> = {
    memory: t("记忆"),
    profile: t("项目概况"),
    command: t("命令"),
    module: t("模块"),
    test: t("测试"),
    route: tc("dimensio", "路由"),
    config: t("配置"),
    data: t("数据"),
    ci: "CI",
    deploy: t("部署"),
    guide: t("指南"),
    verification: t("验证记录"),
  };
  const kindLabel = (k: string) => KIND[k] ?? t("项目知识");
  const memoryWs = $derived(pane.chat.cfg?.workspace ?? app.config?.workspace ?? "");
  // 只有真有记忆条目时才给「打开项目记忆」（项目概况、模块、路由这些是项目知识，不在记忆面板里）
  const canOpenMemory = $derived(Boolean(app.compat?.caps?.includes("memory")) && Boolean(memoryWs) && items.some((r) => r.kind === "memory"));

  function toggle() {
    haptic("light");
    open = !open;
  }
  function openMemory() {
    open = false;
    const ws = memoryWs;
    app.memoryFor = { path: ws, name: ws.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || ws };
    app.memoryFromSettings = false;
    app.sheet = "memory";
  }
</script>

<button
  bind:this={btn}
  class="recall"
  class:open
  aria-expanded={open}
  aria-label={t("这一轮自动召回了 {n} 条记忆与项目知识", { n: items.length })}
  onclick={toggle}
>
  <Icon name="memory" size={12} />
  <span>{t("召回 {n} 条", { n: items.length })}</span>
</button>

{#if open}
  <Popover anchor={btn} onclose={() => (open = false)} prefer="down" align="end" role="dialog" label={t("这一轮的自动召回")} minWidth={240} maxWidth={340}>
    <MenuLabel text={t("开跑时自动找来给模型参考的")} aside={t("只露标题")} />
    <ul class="rl">
      {#each items as r (r.id)}
        <li class="ri">
          <span class="rt">{r.title}</span>
          <span class="rm">{kindLabel(r.kind)}{r.why ? ` · ${tr(r.why)}` : ""}</span>
        </li>
      {/each}
    </ul>
    {#if canOpenMemory}
      <MenuSep />
      <MenuItem icon="memory" label={t("打开项目记忆")} onclick={openMemory} />
    {/if}
  </Popover>
{/if}

<style>
  .recall {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 5px 2px 0 0;
    padding: 1px 5px;
    border-radius: var(--r-xs);
    font-size: var(--fs-xs);
    line-height: 1.3;
    color: var(--text3);
    transition:
      color var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease);
  }
  .recall.open {
    color: var(--text);
    background: var(--surface2);
  }
  .recall:active {
    background: var(--surface3);
  }
  @media (hover: hover) {
    .recall:hover {
      color: var(--text2);
      background: var(--surface2);
    }
  }
  /* 触控目标不小于 40（DESIGN §6）：点按区透明地扩出去，版面不变 */
  @media (pointer: coarse) {
    .recall::after {
      content: "";
      position: absolute;
      inset: -12px -8px;
    }
  }
  .rl {
    margin: 0;
    padding: 0 4px 6px;
    list-style: none;
    max-height: min(50vh, 360px);
    overflow-y: auto;
  }
  .ri {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 7px 8px;
    border-radius: 10px;
  }
  .rt {
    font-size: var(--fs-md);
    line-height: var(--lh-ui);
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .rm {
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
</style>
