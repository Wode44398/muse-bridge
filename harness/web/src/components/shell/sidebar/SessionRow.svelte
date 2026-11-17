<script lang="ts">
  // 侧栏的一行会话：标题、厂商标、等你 / 运行中 / 时间；桌面两步删除，手机左滑露出「更多」「删除」；长按拎起来拖。
  import { app, chatRunning, type SessionMeta } from "../../../lib/state.svelte.ts";
  import { dnd, dragSource } from "../../../lib/dnd.svelte.ts";
  import Icon from "../../ui/Icon.svelte";
  import Mark from "../../brand/Mark.svelte";
  import VendorLogo from "../../brand/VendorLogo.svelte";
  import { t, tc } from "../../../lib/i18n.ts";
  import { fmtTime } from "./time.ts";
  import { createSwipe, type SessionRows } from "./rows.ts";

  let { s, rows }: { s: SessionMeta; rows: SessionRows } = $props();
  // 手机左滑露出「更多」「删除」
  const swipe = (node: HTMLElement, id: string) => createSwipe(rows)(node, id);
  const running = $derived(chatRunning(s.id) || (s.running && !app.chats.some((c) => c.id === s.id)));
</script>

<div class="srow-wrap" class:revealing={rows.swiped === s.id} class:lifting={dnd.on && dnd.sourceKey === `s:${s.id}`} data-row={s.id}>
  <button class="srow-del" tabindex="-1" aria-label={t("删除会话")} onclick={(e) => rows.del(s.id, e)}>{t("删除")}</button>
  {#if rows.sessMenuOk}<button class="srow-more" tabindex="-1" aria-label={t("更多操作")} onclick={(e) => rows.openSessMenu(s, e, false)}>{t("更多")}</button>{/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    oncontextmenu={(e) => rows.openSessMenu(s, e, true)}
    class="srow"
    class:active={s.id === app.chat.id}
    class:inpane={s.id !== app.chat.id && app.panes.some((c) => c.id === s.id)}
    class:open={rows.swiped === s.id}
    use:swipe={s.id}
    use:dragSource={rows.sessionDrag(s)}
  >
    <button class="srow-main" onclick={() => rows.pick(s.id)} title={rows.titleOf(s)}>
      <span class="srow-v"><VendorLogo skin={s.provider} size={12} mono /></span>
      <span class="srow-title">{rows.titleOf(s)}</span>
      <span class="srow-meta">
        {#if s.waiting}
          <span class="waiting"><span class="wdot"></span>{tc("dimensio", "等你")}</span>
        {:else if running}
          <span class="running" title={t("运行中")}><Mark size={14} live /></span>
        {:else}
          <span class="time">{fmtTime(s.updatedAt)}</span>
        {/if}
      </span>
    </button>
    <button class="srow-x" class:armed={rows.armed === s.id} tabindex="-1" data-no-drag aria-label={rows.armed === s.id ? t("确认删除会话") : t("删除会话")} onclick={(e) => rows.arm(s.id, e)}>
      {#if rows.armed === s.id}<span>{t("删除")}</span>{:else}<Icon name="trash" size={14} />{/if}
    </button>
  </div>
</div>

<style>
  /* 会话行 */
  .srow-wrap {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
  }
  .srow-wrap.lifting {
    opacity: 0.35;
  }
  .srow-del {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 72px;
    border-radius: 0 10px 10px 0;
    background: var(--err);
    color: var(--on-accent);
    font-size: var(--fs-md);
    font-weight: 600;
    visibility: hidden;
  }
  .srow-wrap.revealing .srow-del {
    visibility: visible;
  }
  /* 会话管理：左滑露出的「更多」（在「删除」左边） */
  .srow-more {
    position: absolute;
    top: 0;
    right: 72px;
    bottom: 0;
    width: 72px;
    background: var(--surface3);
    color: var(--text);
    font-size: var(--fs-md);
    font-weight: 600;
    visibility: hidden;
  }
  .srow-wrap.revealing .srow-more {
    visibility: visible;
  }
  .srow {
    position: relative;
    display: flex;
    align-items: center;
    height: 34px;
    border-radius: 10px;
    background: var(--rail);
    transition:
      transform 300ms var(--ease-out),
      background-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
    touch-action: pan-y;
  }
  .srow.open {
    transform: translateX(-72px);
  }
  /* 当前会话：一张浮起的纸卡（与输入框、工作区卡片同一种材质：更白的纸 + 细线 + 上沿高光 + 贴身的暖墨影） */
  .srow.active {
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--border),
      inset 0 1px 0 var(--sheen),
      0 1px 2px color-mix(in srgb, var(--text) 5%, transparent),
      0 3px 8px -4px color-mix(in srgb, var(--text) 10%, transparent);
  }
  .srow-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 100%;
    padding: 0 8px 0 12px;
    text-align: left;
    color: var(--text2);
  }
  .srow.active .srow-main {
    color: var(--text);
  }
  /* 分屏里另一格正开着的会话：只描一圈细线（有焦点的那格才是整块纸色） */
  .srow.inpane {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .srow-v {
    display: inline-flex;
    color: var(--text3);
    opacity: 0.8;
  }
  .srow.active .srow-v {
    color: var(--accent);
    opacity: 1;
  }
  .srow-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
  }
  .srow-meta {
    flex: none;
    display: inline-flex;
    align-items: center;
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .running {
    display: inline-flex;
    color: var(--text2);
  }
  .waiting {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--warn);
    font-weight: 500;
  }
  .wdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
    animation: hx-breathe 1.8s var(--ease-in-out) infinite;
  }
  .srow-x {
    flex: none;
    display: none;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 26px;
    margin-right: 4px;
    padding: 0 6px;
    border-radius: 7px;
    color: var(--text3);
    font-size: var(--fs-sm);
    font-weight: 600;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .srow-x.armed {
    display: inline-flex;
    background: var(--err);
    color: var(--on-accent);
  }

  @media (hover: hover) and (pointer: fine) {
    .srow:not(.active):hover {
      background: color-mix(in srgb, var(--text) 5%, var(--rail));
    }
    .srow:hover .srow-x,
    .srow:focus-within .srow-x {
      display: inline-flex;
    }
    .srow:hover .srow-meta,
    .srow:focus-within .srow-meta {
      display: none;
    }
    .srow-x:hover {
      background: color-mix(in srgb, var(--err) 12%, transparent);
      color: var(--err);
    }
    .srow-x.armed:hover {
      background: var(--err);
      color: var(--on-accent);
    }
  }
</style>
