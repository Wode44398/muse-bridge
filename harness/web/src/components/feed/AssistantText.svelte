<script lang="ts">
  // 助手正文：不加底、不加框，直接排在画布上（产物卡在正文上方）。流式走 MdStream（U7：稳定块只渲一次，尾块渐入）。
  // 复制钮只跟最终回答（中途叙述不再各挂一排按钮，降噪）：一颗小图标按钮 + 本轮用时；电脑悬停才浮现（透明度，占位不变不跳），
  // 触屏常显。
  import { toast, type ArtifactItem, type Item } from "../../lib/state.svelte.ts";
  import { elapsedLabel } from "../../lib/timeline-reducer.ts";
  import { foldTiming } from "../../lib/feed-units.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import ArtifactList from "./ArtifactList.svelte";
  import MdStream from "./MdStream.svelte";
  import { t } from "../../lib/i18n.ts";

  type TextItem = Extract<Item, { kind: "text" }>;

  let {
    item,
    final = false,
    artifacts = true,
    onOpenArtifact = null,
  }: {
    item: TextItem;
    final?: boolean;
    artifacts?: boolean;
    onOpenArtifact?: ((artifact: ArtifactItem, sessionId: string) => void) | null;
  } = $props();

  // 本轮用时：扣掉等人处理卡片的时间才是真在干活的时间（悬停看明细）
  const took = $derived(item.run ? elapsedLabel(Math.max(0, item.run.durationMs - item.run.waitedMs)) : "");

  function copy() {
    navigator.clipboard?.writeText(item.text).then(() => toast(t("已复制")));
  }
</script>

<div class="turn">
  {#if artifacts && item.artifacts?.length}
    <ArtifactList items={item.artifacts} {onOpenArtifact} />
  {/if}
  {#if item.text}
    <MdStream text={item.text} live={item.live} />
  {/if}
  {#if final}
    <div class="acts">
      <button class="act" aria-label={t("复制")} title={t("复制")} onclick={copy} use:press={{ scale: 0.9 }}>
        <Icon name="copy" size={15} />
      </button>
      {#if took}<span class="took" title={foldTiming(item.run)}>{took}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .turn {
    min-width: 0;
  }
  .turn > :global(.arts + .md) {
    margin-top: 10px;
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0 0 -7px;
    transition: opacity var(--t-fast) var(--ease);
  }
  .act {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    color: var(--text3);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .act:active {
    background: var(--surface3);
    color: var(--text);
  }
  .took {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
  }
  @media (hover: hover) and (pointer: fine) {
    .acts {
      opacity: 0;
    }
    .turn:hover .acts,
    .acts:focus-within {
      opacity: 1;
    }
    .act:hover {
      background: var(--surface2);
      color: var(--text);
    }
  }
  @media (pointer: coarse) {
    .act {
      width: 40px;
      height: 40px;
      border-radius: 12px;
    }
  }
</style>
