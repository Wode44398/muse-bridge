<script lang="ts">
  // 侧栏一个项目里的会话列表，按会话协作的父子关系排：子会话紧跟在父会话下面、缩进一档（最多三档），
  // dimensio 会话开出去的 Claude 子会话补一行（点了交给 bridge 打开）。行本身仍由 Sidebar 的 sessionRow 片段画。
  import type { Snippet } from "svelte";
  import type { SessionMeta } from "../../lib/state.svelte.ts";
  import { rise } from "../../lib/motion.ts";
  import { nestSessions } from "../../lib/session-family.ts";
  import { family, openFamilySession } from "../../lib/session-family.svelte.ts";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import { t } from "../../lib/i18n.ts";

  let { rows, row, empty }: { rows: SessionMeta[]; row: Snippet<[SessionMeta]>; empty?: Snippet } = $props();

  const nested = $derived(nestSessions(rows, family));
</script>

{#each nested as n (n.key)}
  <div class="fam" class:child={n.depth > 0} style:--fam-depth={n.depth} in:rise={{ y: 4 }}>
    {#if n.s}
      {@render row(n.s)}
    {:else}
      <button class="foreign" title={t("在 bridge 的 Claude 页打开")} onclick={() => void openFamilySession(n.foreign.id, "claude")}>
        <span class="fv"><Icon name="branch" size={12} /></span>
        <span class="ft">{n.foreign.title || t("Claude 会话")}</span>
        <span class="fm">{#if n.foreign.working}<Mark size={14} live />{:else}Claude{/if}</span>
      </button>
    {/if}
  </div>
{:else}
  {@render empty?.()}
{/each}

<style>
  /* 子会话：整行往里收一档，左边一根细线连回父会话（尺寸线母题） */
  .fam.child {
    position: relative;
    padding-left: calc(var(--fam-depth) * 14px);
  }
  .fam.child::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 50%;
    left: calc(var(--fam-depth) * 14px - 6px);
    width: 6px;
    border-left: 1px solid var(--border2);
    border-bottom: 1px solid var(--border2);
    border-bottom-left-radius: 4px;
    pointer-events: none;
  }
  .foreign {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 36px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    font: inherit;
    font-size: var(--fs-base);
    color: var(--text2);
    text-align: left;
    cursor: pointer;
  }
  @media (hover: hover) {
    .foreign:hover {
      background: var(--surface2);
    }
  }
  .fv {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .ft {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fm {
    display: inline-flex;
    flex: none;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
</style>
