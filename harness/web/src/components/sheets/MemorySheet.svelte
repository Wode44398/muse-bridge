<script lang="ts">
  // 记忆面板（K4 → K11 可视化）：两级。
  //   总览（设置 → 记忆）：所有地方的记忆一屏看全（MemoryOverview）；
  //   一处（点总览里的一行 / 一粒，或从侧栏项目菜单、召回芯片直接进来）：这一处的全部记忆与时间线（MemoryBucket）。
  // 标题左边的「‹」与返回键：一处 → 总览 → 设置（从设置点进来时）；右上角 ×、遮罩、下拉整个关掉。
  // 数据一次取齐（GET /api/memory/overview）；任何动作做完重拉一次，四个数、点阵、时间线一起更新。
  // 旧服务端没有总览能力位：只有「一处」这一级，照旧按 listMemory 取（没有历史与召回，时间线只画当前版本）。
  import { onMount } from "svelte";
  import { app, globalMemoryAvailable, memoryOverviewAvailable, pathKey } from "../../lib/state.svelte.ts";
  import { GLOBAL_MEMORY_WS, listMemory, memoryOverview, type MemoryBucket as Bucket, type MemoryOverview } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { rise } from "../../lib/motion.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Button from "../ui/Button.svelte";
  import Mark from "../brand/Mark.svelte";
  import MemoryOverviewView from "./MemoryOverview.svelte";
  import MemoryBucketView from "./MemoryBucket.svelte";
  import { fmtShortDate } from "./memory-text.ts";

  let { onclose }: { onclose: () => void } = $props();

  const canOverview = memoryOverviewAvailable();
  const fromSettings = app.memoryFromSettings;
  const btn: "sm" | "md" = matchMedia("(pointer: coarse)").matches ? "md" : "sm";

  // 不是点名某个项目进来的、又没有总览（旧服务端）：看当前工作空间（快照桶的目录名是 UUID，名字取侧栏里的）
  function currentTarget() {
    const path = app.config?.workspace ?? "";
    const listed = path ? app.projects.find((p) => pathKey(p.path) === pathKey(path)) : undefined;
    return { path, name: listed?.name || path.split(/[\\/]/).filter(Boolean).pop() || t("当前项目") };
  }
  const target = app.memoryFor ?? (canOverview ? null : currentTarget());

  type Where = { ws: string; name: string; kind: Bucket["kind"] };
  let where = $state<Where | null>(target ? { ws: target.path, name: target.name, kind: "project" } : null);
  let openFirst = $state<string | null>(null);

  let overview = $state<MemoryOverview | null>(null);
  let legacy = $state<Bucket | null>(null);
  let loading = $state(true);
  let loadError = $state("");
  let seq = 0;

  const same = (a: string, b: string) => a === b || pathKey(a.replace(/[\\/]+$/, "")) === pathKey(b.replace(/[\\/]+$/, ""));
  const emptyBucket = (w: Where): Bucket => ({ kind: w.kind, ws: w.ws, name: w.name, items: [], promptChars: 0, history: [] });

  // 总览的行：全局层没有记忆时也占一行（它是每个项目都用的那一层，空着也该让人知道有这回事）
  const buckets = $derived.by<Bucket[]>(() => {
    if (!overview) return [];
    const list = overview.buckets;
    if (!globalMemoryAvailable() || list.some((b) => b.kind === "global")) return list;
    return [emptyBucket({ ws: GLOBAL_MEMORY_WS, name: t("全局"), kind: "global" }), ...list];
  });
  const bucket = $derived.by<Bucket | null>(() => {
    if (!where) return null;
    if (!canOverview) return legacy;
    if (!overview) return null;
    const w = where;
    return buckets.find((b) => same(b.ws, w.ws)) ?? emptyBucket(w);
  });

  async function load() {
    const my = ++seq;
    loadError = "";
    try {
      if (canOverview) {
        const ov = await memoryOverview();
        if (my === seq) overview = ov;
      } else if (where) {
        const w = where;
        const items = await listMemory(w.ws);
        if (my === seq) legacy = { ...emptyBucket(w), items: Array.isArray(items) ? items : [] };
      }
    } catch (e: any) {
      if (my === seq) loadError = String(e?.message ?? e);
    } finally {
      if (my === seq) loading = false;
    }
  }
  onMount(() => void load());

  let body: HTMLDivElement | undefined = $state();
  function toTop() {
    body?.closest(".content")?.scrollTo({ top: 0 });
  }

  function openBucket(b: Bucket, id?: string) {
    haptic("light");
    where = { ws: b.ws, name: b.name, kind: b.kind };
    openFirst = id ?? null;
    toTop();
  }

  // 旧服务端：「这个项目 | 全局」切换（总览里全局层就是一行，用不着它）
  function switchLegacy(next: "project" | "global") {
    if (!target) return;
    haptic("light");
    where = next === "global" ? { ws: GLOBAL_MEMORY_WS, name: t("全局"), kind: "global" } : { ws: target.path, name: target.name, kind: "project" };
    legacy = null;
    loading = true;
    void load();
  }

  const title = $derived.by(() => {
    if (!where) return t("记忆");
    if (where.kind === "global") return t("全局记忆");
    if (where.kind === "quick") {
      const b = bucket;
      return b?.createdAt ? t("快照对话 · {date}", { date: fmtShortDate(new Date(b.createdAt).toISOString()) }) : t("快照对话的记忆");
    }
    return t("「{name}」的记忆", { name: where.name });
  });
  const subtitle = $derived.by(() => {
    if (!where) return t("模型跨对话记住的事；只有生效的会进提示");
    if (where.kind === "global") return t("关于你和这台机器，每个项目都用");
    return where.ws;
  });

  // 退一级：一处 → 总览（有总览时）→ 设置（从设置进来时）；都没有就不给「‹」
  const back = $derived.by<(() => void) | undefined>(() => {
    if (where && canOverview) {
      return () => {
        where = null;
        openFirst = null;
        toTop();
      };
    }
    if (fromSettings) return () => (app.sheet = "settings");
    return undefined;
  });
  const backLabel = $derived(where && canOverview ? t("所有记忆") : t("设置"));
</script>

<Sheet {title} {subtitle} {onclose} onback={back} {backLabel} size="xl" tall>
  <div bind:this={body}>
    {#if !canOverview && target && globalMemoryAvailable()}
      <div class="layer">
        <Segmented
          size="sm"
          label={t("记忆范围")}
          value={where?.kind === "global" ? "global" : "project"}
          onchange={switchLegacy}
          options={[
            { value: "project", label: t("这个项目") },
            { value: "global", label: t("全局") },
          ]}
        />
      </div>
    {/if}

    {#if loading && !overview && !legacy}
      <p class="state"><Mark size={16} live /><span>{t("加载中…")}</span></p>
    {:else if loadError && !overview && !legacy}
      <div class="state err" role="alert">
        <span>{t("加载失败：{reason}", { reason: tr(loadError) })}</span>
        <Button size={btn} variant="ghost" icon="reload" onclick={() => load()}>{t("重试")}</Button>
      </div>
    {:else}
      {#if loadError}<p class="stale" role="alert">{t("刷新失败：{reason}", { reason: tr(loadError) })}</p>{/if}
      {#key where?.ws ?? ""}
        <div in:rise={{ y: 6 }}>
          {#if where && bucket}
            <MemoryBucketView {bucket} budget={overview?.budget ?? 0} {openFirst} onchanged={load} />
          {:else if overview}
            <MemoryOverviewView overview={{ ...overview, buckets }} onopen={openBucket} />
          {/if}
        </div>
      {/key}
    {/if}
  </div>
</Sheet>

<style>
  .layer {
    margin: 2px 0 18px;
  }
  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 0;
    padding: 36px 16px;
    font-size: var(--fs-md);
    color: var(--text3);
    text-align: center;
  }
  .state.err {
    flex-direction: column;
    color: var(--err);
    overflow-wrap: anywhere;
  }
  .stale {
    margin: 0 4px 14px;
    font-size: var(--fs-sm);
    color: var(--err);
  }
</style>
