<script lang="ts" module>
  // 服务端给的路径可能带 Windows 反斜杠：只削掉末尾的分隔符再接 "/"（服务端两种都认）
  export const joinPath = (base: string, name: string) => base.replace(/[\\/]+$/, "") + "/" + name;
</script>

<script lang="ts">
  // 整盘目录导航（只列文件夹名）：盘符 · 上一级 + 当前路径 · 子文件夹。设置页「工作空间」与独立运行的
  // 「新建项目」共用。放在分组面（--surface2）上用，自己不画底。
  //  · 挂载时只加载一次；失败就停下给「重试」（旧的目录对话框在接口一直失败时会无限重试）
  //  · 导航时旧列表留着、顶栏亮一枚在权衡的标志（只有手里什么都没有时才占整块显示加载中）；连点只认最后一次
  //  · 长路径先露尾巴（真正区分目录的那一截）
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { fsDirs } from "../../lib/api.ts";
  import { fade } from "../../lib/motion.ts";
  import Button from "../ui/Button.svelte";
  import Chip from "../ui/Chip.svelte";
  import Row from "../ui/Row.svelte";
  import Mark from "../brand/Mark.svelte";
  import { t, tr } from "../../lib/i18n.ts";

  let {
    start = "",
    path = $bindable(""),
    loading = $bindable(false),
    emptyText,
    listHeight = "220px",
    fixed = false,
    footer,
  }: {
    start?: string;
    path?: string;
    loading?: boolean;
    emptyText: string;
    listHeight?: string; // 列表区最大高度；fixed = 固定就这么高（对话框换目录时不忽大忽小）
    fixed?: boolean;
    footer?: Snippet<[{ path: string; go: (next: string) => Promise<void> }]>;
  } = $props();

  // 触屏上行内小按钮放大一档（点按目标别太小）
  const btn: "sm" | "md" = matchMedia("(pointer: coarse)").matches ? "md" : "sm";

  let parent = $state<string | null>(null);
  let dirs = $state<string[]>([]);
  let drives = $state<string[]>([]);
  let loaded = $state(false);
  let error = $state("");
  let lastTarget = "";
  let seq = 0;

  async function go(next: string) {
    const my = ++seq;
    lastTarget = next;
    loading = true;
    error = "";
    try {
      const r = await fsDirs(next);
      if (my !== seq) return;
      path = r.path;
      parent = r.parent;
      dirs = r.dirs ?? [];
      drives = r.drives ?? [];
      loaded = true;
    } catch (e: any) {
      if (my === seq) error = String(e?.message ?? e);
    } finally {
      if (my === seq) loading = false;
    }
  }

  onMount(() => void go(start));
</script>

<div class="db">
  {#if drives.length > 1}
    <div class="drives" role="group" aria-label={t("盘符")}>
      {#each drives as d (d)}
        <Chip tone={path.toLowerCase().startsWith(d.toLowerCase()) ? "accent" : "soft"} mono title={d} onclick={() => go(d)}>
          {d.replace(/[\\/]+$/, "")}
        </Chip>
      {/each}
    </div>
  {/if}

  <div class="bar">
    <Button size={btn} variant="ghost" icon="arrowU" disabled={!parent || loading} onclick={() => parent && go(parent)}>{t("上一级")}</Button>
    <span class="path" title={path}><bdi>{path}</bdi></span>
    {#if loading && loaded}
      <span class="busy" in:fade={{ duration: 120 }}><Mark size={14} live /></span>
    {/if}
  </div>

  {#key path}
    <div class="list" class:fixed style="--list-h:{listHeight}" in:fade={{ duration: 160 }}>
      {#if !loaded}
        {#if error}
          <div class="state err" role="alert">
            <span>{tr(error)}</span>
            <Button size={btn} variant="ghost" icon="reload" onclick={() => go(lastTarget)}>{t("重试")}</Button>
          </div>
        {:else}
          <p class="state"><Mark size={16} live /><span>{t("加载中…")}</span></p>
        {/if}
      {:else}
        {#each dirs as d (d)}
          <Row icon="folder" title={d} chevron onclick={() => go(joinPath(path, d))} />
        {:else}
          {#if !error}<p class="state">{emptyText}</p>{/if}
        {/each}
      {/if}
    </div>
  {/key}

  {#if loaded && error}
    <div class="errline" role="alert">
      <span>{tr(error)}</span>
      <Button size={btn} variant="ghost" icon="reload" onclick={() => go(lastTarget)}>{t("重试")}</Button>
    </div>
  {/if}

  {#if footer}{@render footer({ path, go })}{/if}
</div>

<style>
  .db {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .drives {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 12px 2px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 6px 12px 6px 6px;
    border-bottom: 1px solid var(--border);
  }
  .path {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* 长路径先露尾巴：整段放进 bdi 里按从左到右排，溢出从左边省略 */
    direction: rtl;
    text-align: left;
  }
  .busy {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }

  .list {
    max-height: var(--list-h);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .list.fixed {
    height: var(--list-h);
  }
  /* 子文件夹是一排 ui/Row：行间细线与分组列表同一个口径 */
  .list > :global(* + *) {
    box-shadow: 0 -1px 0 var(--border);
  }

  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 72px;
    margin: 0;
    padding: 16px;
    font-size: var(--fs-md);
    color: var(--text3);
    text-align: center;
  }
  .fixed .state {
    height: 100%;
  }
  .state.err {
    flex-direction: column;
    color: var(--warn);
    overflow-wrap: anywhere;
  }
  .errline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 6px 6px 12px;
    border-top: 1px solid var(--border);
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--warn);
    overflow-wrap: anywhere;
  }
</style>
