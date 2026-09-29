<script lang="ts">
  // 页面截图：图点开进应用灯箱（App 里：关闭钮 / 点图 / 返回键都能关）；下面一行地址 + 验证结论。
  // R12：事件里只带会话资产 id，src 按 URL 取（令牌镜像进查询串）；老事件才是 dataUri。
  import { app, type Item } from "../../lib/state.svelte.ts";
  import * as api from "../../lib/api.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  type ShotItem = Extract<Item, { kind: "screenshot" }>;

  let { item }: { item: ShotItem } = $props();

  const src = $derived(item.dataUri || (item.asset && pane.chat.id ? api.sessionAssetUrl(pane.chat.id, item.asset) : ""));
</script>

<div class="shot">
  <button class="img" onclick={() => (app.lightbox = { src, caption: item.url })} use:press={{ scale: 0.995 }}>
    <img {src} alt={t("页面截图 {url}", { url: item.url })} loading="lazy" />
  </button>
  <div class="meta">
    <span class="url"><Icon name="camera" size={13} /><span class="u">{item.url}</span></span>
    {#if item.verdict}<p class="verdict">{tr(item.verdict)}</p>{/if}
  </div>
</div>

<style>
  .shot {
    overflow: hidden;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
  }
  .img {
    display: block;
    width: 100%;
    cursor: zoom-in;
  }
  .img img {
    display: block;
    width: 100%;
    max-height: 400px;
    object-fit: contain;
    background: var(--code-bg);
  }
  .meta {
    padding: 10px 14px 12px;
  }
  .url {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    color: var(--text3);
  }
  .url :global(svg) {
    margin-top: 2px;
  }
  .u {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.55;
    word-break: break-all;
  }
  .verdict {
    margin: 6px 0 0;
    font-size: var(--fs-md);
    line-height: 1.55;
    white-space: pre-wrap;
    color: var(--text2);
  }
</style>
