<script lang="ts">
  // 输入框底行右侧、发送键左边的两颗小钮（会话管理）：
  //  · 运行中、有字：「稍后发送」——这句不插进正在跑的这一轮，等它结束后再发（桌面上就是 Ctrl / ⌘ + 回车）；
  //  · 空着、有输入建议：键帽「Tab」（触屏写「填入」）——点一下把灰字填进输入框。
  // 都没有时什么都不占（外层 span 是空的）。
  import { canQueue, fillSuggestion, laterFromDraft, suggestionFor } from "../../lib/sessmgmt.svelte.ts";
  import { fade } from "../../lib/motion.ts";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";
  import IconButton from "../ui/IconButton.svelte";

  let { hasText, coarse, onfilled }: { hasText: boolean; coarse: boolean; onfilled?: () => void } = $props();
  const pane = usePane();
  const later = $derived(pane.chat.running && hasText && canQueue());
  const sug = $derived(hasText ? "" : suggestionFor(pane.chat));
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
</script>

{#if later}
  <span class="x" in:fade={{ duration: 140 }}>
    <IconButton
      icon="clock"
      size={32}
      iconSize={17}
      label={t("稍后发送")}
      title={coarse ? t("稍后发送：等这一轮结束后再发") : mac ? t("稍后发送：等这一轮结束后再发（⌘+回车）") : t("稍后发送：等这一轮结束后再发（Ctrl+回车）")}
      onclick={() => void laterFromDraft(pane.chat)}
    />
  </span>
{:else if sug}
  <button
    class="key"
    in:fade={{ duration: 140 }}
    title={t("把建议填进输入框")}
    aria-label={t("填入建议：{text}", { text: sug })}
    onclick={() => {
      fillSuggestion(pane.chat);
      onfilled?.();
    }}>{coarse ? t("填入") : "Tab"}</button
  >
{/if}

<style>
  .x {
    display: inline-flex;
  }
  .key {
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 7px;
    margin-right: 4px;
    border: 1px solid var(--border2);
    border-bottom-width: 2px;
    border-radius: var(--r-xs);
    background: var(--surface);
    color: var(--text3);
    font: 500 var(--fs-xs) / 1 var(--font-mono);
    cursor: pointer;
  }
  .key:active {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .key:hover {
      color: var(--text2);
    }
  }
</style>
