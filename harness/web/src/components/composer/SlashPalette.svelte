<script lang="ts">
  // E3（G7）：斜杠面板——输入框聚焦、以 / 开头还没敲空格时，从输入框上沿浮出（宽度与输入框一致）：
  // 内置命令、技能包、技能（扩展中心勾给 dimensio 的）。键盘在输入框里处理（↑↓ 选、Enter / Tab 执行），这里只管画和点按：
  //  · 行在 pointerdown 时不抢焦点——面板靠输入框聚焦才显示，抢了焦点，点击还没落下面板就没了（G32）
  //  · 指针移过即选中；选中项滚进视野；灰掉的内置命令照样能点（点了会提示为什么用不了）
  //  · 登记进浮层栈：Esc / 返回键先关它（关 = 这一截草稿不再弹）；它不压到桌面壳的原生浏览器视图，不让那个视图让位
  // 不用 Popover：Popover 在桌面上会把焦点拿走（输入框一失焦面板就关）。
  import { onMount } from "svelte";
  import type { PaletteItem } from "../../lib/slash.ts";
  import { pushLayer } from "../../lib/layers.ts";
  import { fade, pop } from "../../lib/motion.ts";
  import { t } from "../../lib/i18n.ts";

  let {
    items,
    selected,
    id,
    onpick,
    onhover,
    onclose,
  }: {
    items: PaletteItem[];
    selected: number;
    id: string;
    onpick: (item: PaletteItem) => void;
    onhover: (index: number) => void;
    onclose: () => void;
  } = $props();

  let list: HTMLDivElement | undefined = $state();

  onMount(() => pushLayer(() => onclose(), { native: false }));

  // 键盘选中项滚进视野——只滚面板自己（scrollIntoView 会连带滚动 overflow:hidden 的外壳，把整页顶上去）
  $effect(() => {
    void items;
    const el = list?.querySelector<HTMLElement>(`[data-i="${selected}"]`);
    if (!el || !list) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 6;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 6;
  });

  function tagOf(item: PaletteItem): string {
    if (item.kind === "builtin") return item.disabled ?? t("内置");
    if (item.kind === "pkg") return t("{n} 个技能", { n: item.count });
    if (item.userOnly) return t("命令");
    return item.pkg ?? "";
  }
  const isOff = (item: PaletteItem) => item.kind === "builtin" && Boolean(item.disabled);
  // 不同技能包里可能有同名技能：key 带上包名，免得 keyed each 撞 key
  const keyOf = (item: PaletteItem) => `${item.kind}:${item.kind === "skill" ? `${item.pkg ?? ""}/` : ""}${item.name}`;
</script>

<div class="pal" {id} role="listbox" aria-label={t("斜杠命令")} bind:this={list} in:pop|global={{ from: 0.97 }} out:fade|global={{ duration: 120 }}>
  {#if !items.length}
    <p class="empty">{t("没有对得上的命令或技能——照普通消息发出")}</p>
  {/if}
  {#each items as item, i (keyOf(item))}
    <button
      class="row"
      class:on={i === selected}
      class:off={isOff(item)}
      id="{id}-{i}"
      role="option"
      aria-selected={i === selected}
      aria-disabled={isOff(item) || undefined}
      data-i={i}
      tabindex="-1"
      onpointerdown={(e) => e.preventDefault()}
      onpointermove={() => i !== selected && onhover(i)}
      onclick={() => onpick(item)}
    >
      <span class="head">
        <span class="name">/{item.name}</span>
        {#if item.kind !== "pkg" && item.hint}<span class="hint">{item.hint}</span>{/if}
        {#if tagOf(item)}<span class="tag">{tagOf(item)}</span>{/if}
      </span>
      <span class="desc">{item.description}</span>
    </button>
  {/each}
</div>

<style>
  .pal {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 8px);
    z-index: 20;
    max-height: min(360px, 46vh);
    max-height: min(360px, 46dvh);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: 16px;
    background: var(--surface);
    color: var(--text);
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-2);
    transform-origin: 50% 100%;
  }
  .empty {
    margin: 0;
    padding: 10px 12px;
    font-size: var(--fs-md);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
  .row {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    width: 100%;
    min-height: 44px;
    padding: 7px 10px;
    border-radius: 10px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .row.on {
    background: var(--surface2);
  }
  .row:active {
    background: var(--surface3);
  }
  .row.off {
    opacity: 0.5;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .name {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    font-weight: 500;
    white-space: nowrap;
    transition: color var(--t-fast) var(--ease);
  }
  .row.on .name {
    color: var(--accent);
  }
  .hint {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .tag {
    flex: none;
    max-width: 45%;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .desc {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text2);
  }
</style>
