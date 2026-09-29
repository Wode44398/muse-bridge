<script lang="ts">
  // 计划条（TodoWrite 的清单，跟着 todo 事件出现）：收着 = 一行「计划 3/5 · 正在做：xxx」+ 一根尺寸线量着进度；
  // 点开 = 全部条目（展开状态跟着会话走，默认收着）。在做的那条在这一轮还在跑时微光。
  import { collapse, fade, rise } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import Measure from "../ui/Measure.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  const todos = $derived(pane.chat.todos);
  const done = $derived(todos.filter((td) => td.status === "completed").length);
  const cur = $derived(todos.find((td) => td.status === "in_progress"));
  const open = $derived(pane.chat.todosOpen);
  const live = $derived(pane.chat.running);
</script>

<div class="strip" in:rise|global={{ y: 6 }} out:fade|global={{ duration: 140 }}>
  <button class="head" aria-expanded={open} onclick={() => (pane.chat.todosOpen = !pane.chat.todosOpen)}>
    <span class="ic"><Icon name="todo" size={15} /></span>
    <span class="lbl">{t("计划")} <span class="num">{done}/{todos.length}</span></span>
    {#if !open && cur}
      <span class="sep" aria-hidden="true">·</span>
      <span class="cur" class:hx-shimmer={live}>{t("正在做：{task}", { task: cur.content })}</span>
    {:else}
      <span class="sp"></span>
    {/if}
    <span class="meas"><Measure value={todos.length ? done / todos.length : 0} label={t("计划进度")} /></span>
    <span class="chev" class:up={open}><Icon name="chevronD" size={14} /></span>
  </button>
  {#if open}
    <div class="listwrap" transition:collapse>
      <ul class="list">
        {#each todos as td, i (i)}
          <li class="it" class:done={td.status === "completed"} class:now={td.status === "in_progress"}>
            <span class="tick" aria-hidden="true">
              {#if td.status === "completed"}<Icon name="check" size={12} stroke={2.4} />{/if}
            </span>
            <span class="txt" class:hx-shimmer={live && td.status === "in_progress"}>{td.content}</span>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .strip {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    border-radius: 16px;
    background: var(--surface);
    box-shadow: var(--shadow-1);
  }
  :global(.hxroot[data-mode="dark"]) .strip {
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-1);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 40px;
    padding: 0 10px 0 14px;
    text-align: left;
    font-size: var(--fs-md);
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .head:hover {
      background: color-mix(in srgb, var(--text) 3%, transparent);
    }
  }
  .head:active {
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  /* 卡片裁了圆角：焦点框往里画，别被裁掉 */
  .head:focus-visible {
    outline-offset: -2px;
    border-radius: 16px;
  }
  .ic {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .lbl {
    flex: none;
    font-weight: 500;
    color: var(--text);
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: var(--text2);
  }
  .sep {
    flex: none;
    color: var(--text3);
  }
  .cur {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp {
    flex: 1;
  }
  .meas {
    flex: none;
    width: 56px;
  }
  .chev {
    display: inline-flex;
    flex: none;
    color: var(--text3);
    transition: transform var(--t-spring, 500ms) var(--spring, var(--ease-out));
  }
  .chev.up {
    transform: rotate(180deg);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 2px 14px 12px;
    max-height: 200px;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .it {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: var(--fs-md);
    line-height: var(--lh-ui);
    color: var(--text2);
  }
  .tick {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    margin-top: 1px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--border2);
    color: var(--ok);
    transition:
      box-shadow var(--t-med) var(--ease),
      background-color var(--t-med) var(--ease);
  }
  .now .tick {
    box-shadow: inset 0 0 0 1.5px var(--live);
    background: radial-gradient(circle, var(--live) 0 3px, transparent 3.5px);
  }
  .done .tick {
    box-shadow: none;
    background: color-mix(in srgb, var(--ok) 14%, transparent);
  }
  .txt {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .now .txt {
    font-weight: 500;
  }
  /* 微光靠 color: transparent + 背景裁字，这里再给字色会把它盖掉 */
  .now .txt:not(.hx-shimmer) {
    color: var(--text);
  }
  .done .txt {
    color: var(--text3);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--text3) 60%, transparent);
  }
  @media (max-width: 420px) {
    .meas {
      display: none;
    }
  }
</style>
