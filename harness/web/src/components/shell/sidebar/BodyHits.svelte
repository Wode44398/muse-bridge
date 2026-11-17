<script lang="ts">
  // K10（D5）：搜索时的「正文里提到」——标题里没有、正文里提到过的对话，带一段前后文。搜索与去重在外面做，这里只画。
  import { app } from "../../../lib/state.svelte.ts";
  import type { SessionSearchHit } from "../../../lib/api.ts";
  import { dnd, dragSource } from "../../../lib/dnd.svelte.ts";
  import { rise } from "../../../lib/motion.ts";
  import Icon from "../../ui/Icon.svelte";
  import Mark from "../../brand/Mark.svelte";
  import VendorLogo from "../../brand/VendorLogo.svelte";
  import { t } from "../../../lib/i18n.ts";
  import { fmtTime } from "./time.ts";
  import type { SessionRows } from "./rows.ts";

  let {
    bodyHits,
    bodyOnly,
    bodyBusy,
    hitProject,
    rows,
  }: {
    bodyHits: SessionSearchHit[];
    bodyOnly: SessionSearchHit[];
    bodyBusy: boolean;
    hitProject: (ws?: string) => string;
    rows: SessionRows;
  } = $props();
</script>

<div class="sec">
  <span>{t("正文里提到")}</span>
  {#if bodyBusy && !bodyHits.length}<span class="sec-live"><Mark size={12} live /></span>{/if}
</div>
{#each bodyOnly as h (h.id)}
  <div in:rise={{ y: 4 }} class:lifting={dnd.on && dnd.sourceKey === `s:${h.id}`} use:dragSource={rows.sessionDrag(h)}>
    <button class="hit" class:active={h.id === app.chat.id} onclick={() => rows.pick(h.id)} title={rows.titleOf(h)}>
      <span class="hit-head">
        <span class="srow-v"><VendorLogo skin={h.provider} size={12} mono /></span>
        <span class="hit-title">{rows.titleOf(h)}</span>
        <span class="hit-time">{fmtTime(h.updatedAt)}</span>
      </span>
      <span class="hit-snip">{h.snippet.before}<mark>{h.snippet.match}</mark>{h.snippet.after}</span>
      {#if hitProject(h.workspace)}
        <span class="hit-proj"><Icon name="folder" size={11} />{hitProject(h.workspace)}</span>
      {/if}
    </button>
  </div>
{:else}
  {#if !bodyBusy}
    <p class="pempty">{bodyHits.length ? t("正文命中的对话都已经在上面了") : t("正文里也没有")}</p>
  {/if}
{/each}

<style>
  .sec {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 30px;
    margin-top: 10px;
    padding: 0 6px 0 10px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text3);
  }
  .lifting > .hit {
    opacity: 0.35;
  }
  .srow-v {
    display: inline-flex;
    color: var(--text3);
    opacity: 0.8;
  }
  .pempty {
    margin: 2px 0 4px;
    padding: 6px 10px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }

  /* K10：正文命中——两行：标题一行，前后文一行（命中处墨色淡底，不用朱：朱只给正在发生的东西） */
  .sec-live {
    display: inline-flex;
    margin-right: 5px;
  }
  .hit {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 7px 10px 8px 12px;
    border-radius: 10px;
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .hit.active {
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
  }
  .hit:active {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .hit-head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .hit-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .hit.active .hit-title {
    color: var(--text);
  }
  .hit-time {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  /* 前后文与标题的字对齐（厂商标 12 + 间距 9） */
  .hit-snip,
  .hit-proj {
    padding-left: 21px;
  }
  .hit-snip {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
    overflow-wrap: anywhere;
  }
  .hit-snip mark {
    padding: 0 1px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--text);
  }
  .hit-proj {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }

  @media (hover: hover) and (pointer: fine) {
    .hit:not(.active):hover {
      background: color-mix(in srgb, var(--text) 5%, transparent);
    }
  }
</style>
