<script lang="ts">
  // U6（hermes N41）：出错 = 一句人话；这一轮已经执行过工具就提醒先核对；原始报错折起来；
  // 「接着做」只挂在时间线最后一条的失败上（更早的失败已经被后来的事情接过去了）；
  // Q13：出错的这一刻最需要现场——一键导出这个对话的诊断包。
  import { diagnosticsAvailable, exportDiagnostics, send, type Item } from "../../lib/state.svelte.ts";
  import { collapse } from "../../lib/motion.ts";
  import Button from "../ui/Button.svelte";
  import Icon from "../ui/Icon.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  type ErrorItem = Extract<Item, { kind: "error" }>;

  let { item, last = false }: { item: ErrorItem; last?: boolean } = $props();

  let rawOpen = $state(false);
  const canGo = $derived(last && !pane.chat.running && Boolean(pane.chat.id));
  const canDiag = $derived(diagnosticsAvailable() && Boolean(pane.chat.id));
</script>

<div class="err">
  <span class="ic"><Icon name="alert" size={16} stroke={1.8} /></span>
  <div class="body">
    <p class="msg" role="alert">{tr(item.text)}</p>
    {#if item.ran}<p class="ran">{t("这一轮已经执行过 {n} 次工具——接着做之前，先核对它们的结果", { n: item.ran })}</p>{/if}
    {#if item.detail}
      <div class="rawsec">
        <button class="rawbtn" aria-expanded={rawOpen} onclick={() => (rawOpen = !rawOpen)}>
          <span class="rchev" class:open={rawOpen}><Icon name="chevronR" size={12} stroke={2} /></span>
          {t("原始报错")}
        </button>
        {#if rawOpen}
          <div class="rawwrap" transition:collapse>
            <pre class="raw">{item.detail}</pre>
          </div>
        {/if}
      </div>
    {/if}
    {#if canGo || canDiag}
      <div class="acts">
        {#if canGo}<Button variant="secondary" size="sm" onclick={() => void send(t("继续"))}>{t("接着做")}</Button>{/if}
        {#if canDiag}<Button variant="ghost" size="sm" icon="download" onclick={() => void exportDiagnostics()}>{t("导出诊断包")}</Button>{/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .err {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 14px;
    background: color-mix(in srgb, var(--err) 8%, transparent);
  }
  .ic {
    display: inline-flex;
    flex: none;
    margin-top: 2px;
    color: var(--err);
  }
  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }
  .msg {
    margin: 0;
    font-size: var(--fs-base);
    line-height: 1.55;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .ran {
    margin: 0;
    font-size: var(--fs-md);
    line-height: 1.5;
    color: var(--text2);
  }
  .rawbtn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: -4px;
    padding: 2px 6px 2px 4px;
    border-radius: var(--r-xs);
    font-size: var(--fs-sm);
    color: var(--text3);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .rchev {
    display: inline-flex;
    transition: transform var(--t-med) var(--ease-out);
  }
  .rchev.open {
    transform: rotate(90deg);
  }
  /* 开关与报错正文包在一起：外层的 gap 不随收起消失；collapse 过渡的元素自己不带 margin（间距放在内边距里） */
  .rawsec {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    align-self: stretch;
  }
  .rawwrap {
    align-self: stretch;
    padding-top: 4px;
  }
  .raw {
    margin: 0;
    max-height: 180px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--err) 6%, transparent);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text2);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 4px;
  }
  @media (hover: hover) {
    .rawbtn:hover {
      background: color-mix(in srgb, var(--err) 8%, transparent);
      color: var(--text2);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .rchev {
      transition: none;
    }
  }
</style>
