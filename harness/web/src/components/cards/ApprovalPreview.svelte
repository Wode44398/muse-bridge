<script lang="ts">
  // P11（ZCode C2）：执行事实——这次真正要执行的东西：命令、改前 / 改后、写入内容的开头、工作流脚本。
  // 权限卡等人批时展开摆着；落定后的回执里收起成一行（历史不被长 diff、长脚本撑开），点开能看。
  // 对话流里展开的 Edit / Write / Bash 工具行也用它（open 默认 true）。
  // 不加外边距：间距归外面的容器管。
  import type { ApprovalPreview as Preview } from "../../lib/timeline-types.ts";
  import { collapse } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import { t } from "../../lib/i18n.ts";

  let { preview, open = true }: { preview: Preview; open?: boolean } = $props();

  const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`);
  const summary = $derived(
    preview.kind === "command"
      ? t("要执行的命令")
      : preview.kind === "diff"
        ? t("改 {path}", { path: preview.path })
        : preview.kind === "write"
          ? t("写 {path}（{n} 行 · {size}）", { path: preview.path, n: preview.lines, size: kb(preview.bytes) })
          : preview.kind === "script"
            ? t("工作流「{name}」", { name: preview.name })
            : t("要执行的内容"),
  );
  // 收起时，命令本身在摘要后面露一截（不点开也知道是哪条）
  const peek = $derived(preview.kind === "command" ? (preview.command.trim().split("\n")[0] ?? "") : "");
  // 改前 / 改后按行摆（每行一条色阶底；空行留一个空格撑住行高）
  const lines = (s: string) => s.replace(/\n$/, "").split("\n");

  let expanded = $state(false);
  let scriptOpen = $state(false);
</script>

{#snippet body()}
  {#if preview.kind === "command"}
    <pre class="code">{preview.command}</pre>
    {#if preview.background}<div class="meta">{t("后台运行")}</div>{/if}
  {:else if preview.kind === "diff"}
    <div class="meta"><span class="mono">{preview.path}</span>{#if preview.replaceAll}<span> · {t("全部替换")}</span>{/if}</div>
    <div class="lbl">{t("改前")}</div>
    <pre class="code diff del">{#each lines(preview.old) as l, i (i)}<span class="ln">{l || " "}</span>{/each}</pre>
    <div class="lbl">{t("改后")}</div>
    <pre class="code diff add">{#each lines(preview.new) as l, i (i)}<span class="ln">{l || " "}</span>{/each}</pre>
  {:else if preview.kind === "write"}
    <div class="meta"><span class="mono">{preview.path}</span> · {t("{n} 行", { n: preview.lines })} · {kb(preview.bytes)}</div>
    <pre class="code">{preview.head}</pre>
  {:else if preview.kind === "script"}
    <div class="meta"><b>{preview.name}</b>{preview.description ? ` — ${preview.description}` : ""}</div>
    {#if preview.phases.length}<div class="phases">{preview.phases.join(" → ")}</div>{/if}
    <div>
      <button class="fold" aria-expanded={scriptOpen} onclick={() => (scriptOpen = !scriptOpen)}>
        <span class="chev"><Icon name="chevronR" size={13} stroke={1.8} /></span>
        <span class="sum">{t("脚本正文（{n} 行）", { n: preview.lines })}</span>
      </button>
      {#if scriptOpen}
        <div class="reveal" transition:collapse><div class="pad"><pre class="code">{preview.script}</pre></div></div>
      {/if}
    </div>
  {:else}
    <pre class="code">{(preview as { text?: string }).text ?? ""}</pre>
  {/if}
  {#if preview.truncated}<div class="cut">{t("太长，只摆了开头")}</div>{/if}
{/snippet}

{#if open}
  <div class="apv">{@render body()}</div>
{:else}
  <div class="apv folded">
    <button class="fold" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      <span class="chev"><Icon name="chevronR" size={13} stroke={1.8} /></span>
      <span class="sum">{summary}</span>
      {#if peek && !expanded}<span class="peek">{peek}</span>{/if}
    </button>
    {#if expanded}
      <div class="reveal" transition:collapse><div class="pad apv">{@render body()}</div></div>
    {/if}
  </div>
{/if}

<style>
  .apv {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .folded {
    gap: 0;
  }
  /* 回执里收起的那一行占满宽：摘要在前，命令摘录拿剩下的地方 */
  .folded > .fold {
    align-self: stretch;
    margin-right: -4px;
  }
  .meta,
  .phases {
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text2);
    overflow-wrap: anywhere;
  }
  .meta b {
    font-weight: 600;
    color: var(--text);
  }
  .phases {
    color: var(--text3);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .lbl {
    margin-top: 2px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .code {
    margin: 0;
    padding: 8px 12px;
    max-height: 192px;
    overflow: auto;
    overscroll-behavior: contain;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.6;
    font-variant-ligatures: none;
    color: var(--text);
    background: var(--code-bg);
    border-radius: 10px;
    user-select: text;
  }
  /* 改前 / 改后：逐行的色阶底 + 左侧 −/+ */
  .diff {
    padding: 6px 0;
  }
  .ln {
    position: relative;
    display: block;
    padding: 0 12px 0 28px;
  }
  .ln::before {
    position: absolute;
    left: 11px;
    width: 10px;
    text-align: center;
  }
  .del .ln {
    background: color-mix(in srgb, var(--err) 9%, transparent);
  }
  .del .ln::before {
    content: "−";
    color: var(--err);
  }
  .add .ln {
    background: color-mix(in srgb, var(--ok) 10%, transparent);
  }
  .add .ln::before {
    content: "+";
    color: var(--ok);
  }
  .cut {
    font-size: var(--fs-xs);
    color: var(--text3);
  }

  /* 收起的一行（回执、脚本正文） */
  .fold {
    display: inline-flex;
    align-self: flex-start;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    min-height: 30px;
    margin-left: -4px;
    padding: 0 8px 0 4px;
    border-radius: var(--r-sm);
    font-size: var(--fs-sm);
    color: var(--text2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .fold:active {
    background: var(--surface3);
  }
  @media (hover: hover) {
    .fold:hover {
      color: var(--text);
      background: color-mix(in srgb, var(--text) 5%, transparent);
    }
  }
  .chev {
    flex: none;
    display: inline-flex;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .fold[aria-expanded="true"] .chev {
    transform: rotate(90deg);
  }
  .sum {
    flex: 0 1 auto;
    min-width: 3em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .peek {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  /* collapse 过渡的元素本身不带外边距（motion.ts 的约定），间距放进里层 */
  .pad {
    padding-top: 6px;
  }
  @media (pointer: coarse) {
    .fold {
      min-height: 40px;
    }
  }
</style>
