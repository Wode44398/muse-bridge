<script lang="ts">
  // 侧栏底部的「已归档」（会话管理）：归档的对话不在项目列表与搜索里出现，都收在这里——默认收着，点开才拉清单。
  // 侧栏在搜索时这里也跟着按标题过滤，并自动展开（标题对得上的已归档对话不至于找不到）。点一条打开它（在它里面发消息会自动取消归档），
  // 行尾「取消归档」放回项目列表；右键出同一个会话菜单。
  import { onMount } from "svelte";
  import { app, type SessionMeta } from "../../lib/state.svelte.ts";
  import { canArchive, loadArchived, setArchived, sm } from "../../lib/sessmgmt.svelte.ts";
  import { collapse, rise } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import SessionMenu from "./SessionMenu.svelte";

  let { q = "", onpick }: { q?: string; onpick: (id: string) => void } = $props();

  let open = $state(false);
  const on = $derived(canArchive());
  onMount(() => {
    if (on) void loadArchived();
  });
  $effect(() => {
    if (on && sm.archivedCount < 0 && !sm.archivedLoading) void loadArchived();
  });

  const titleOf = (s: { title?: string }) => tr(s.title?.trim() ?? "") || t("（空会话）");
  const rows = $derived(q ? sm.archived.filter((s) => titleOf(s).toLowerCase().includes(q)) : sm.archived);
  const shown = $derived(open || (Boolean(q) && rows.length > 0));
  const count = $derived(q ? rows.length : Math.max(sm.archivedCount, sm.archived.length));

  let menu = $state<{ s: SessionMeta; anchor: HTMLElement } | null>(null);
  function ctx(s: SessionMeta, e: MouseEvent) {
    if ((e as PointerEvent).pointerType && (e as PointerEvent).pointerType !== "mouse") return;
    e.preventDefault();
    menu = { s, anchor: e.currentTarget as HTMLElement };
  }
  async function restore(s: SessionMeta, e: Event) {
    e.stopPropagation();
    haptic("light");
    await setArchived(s.id, false);
  }
</script>

{#if on && count > 0}
  <div class="arch">
    <button class="head" onclick={() => (open = !open)} aria-expanded={shown}>
      <Icon name="archive" size={15} />
      <span>{t("已归档")}</span>
      <span class="n">{count}</span>
      <span class="chev" class:open={shown}><Icon name="chevronD" size={13} /></span>
    </button>
    {#if shown}
      <div transition:collapse>
        {#each rows as s (s.id)}
          <div class="row" class:active={s.id === app.chat.id} in:rise={{ y: 4 }} oncontextmenu={(e) => ctx(s, e)} role="presentation">
            <button class="main" onclick={() => onpick(s.id)} title={titleOf(s)}>
              <span class="v"><VendorLogo skin={s.provider} size={12} mono /></span>
              <span class="tt">{titleOf(s)}</span>
            </button>
            <button class="un" onclick={(e) => restore(s, e)} title={t("取消归档，放回项目列表")}>{t("取消归档")}</button>
          </div>
        {:else}
          <p class="empty">{sm.archivedLoading ? t("加载中…") : t("没有匹配的已归档对话")}</p>
        {/each}
      </div>
    {/if}
  </div>
{/if}

{#if menu}
  <SessionMenu session={menu.s} archived anchor={menu.anchor} onclose={() => (menu = null)} />
{/if}

<style>
  .arch {
    margin-top: 10px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border: 0;
    border-radius: 10px;
    background: none;
    color: var(--text2);
    font: inherit;
    font-size: var(--fs-md);
    cursor: pointer;
  }
  .head:active {
    background: var(--surface3);
  }
  .n {
    color: var(--text3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .chev {
    display: inline-flex;
    margin-left: auto;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease);
  }
  .chev.open {
    transform: rotate(180deg);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: 10px;
    padding-right: 4px;
  }
  .row.active {
    background: var(--surface2);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 10px 0 28px;
    border: 0;
    background: none;
    color: var(--text2);
    font: inherit;
    font-size: var(--fs-md);
    text-align: left;
    cursor: pointer;
  }
  .v {
    display: inline-flex;
    opacity: 0.6;
  }
  .tt {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .un {
    flex: none;
    height: 26px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--r-pill);
    background: none;
    color: var(--text3);
    font: inherit;
    font-size: var(--fs-xs);
    cursor: pointer;
  }
  .un:active {
    background: var(--surface3);
  }
  .empty {
    margin: 4px 10px 4px 28px;
    color: var(--text3);
    font-size: var(--fs-sm);
  }
  @media (hover: hover) {
    .head:hover,
    .row:hover {
      background: var(--surface2);
    }
    .un:hover {
      color: var(--text);
      background: var(--surface3);
    }
  }
</style>
