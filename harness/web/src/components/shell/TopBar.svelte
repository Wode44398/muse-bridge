<script lang="ts">
  // 顶栏（减法）：左 = 当前项目 / 对话标题（手机上它就是侧栏抽屉的入口；桌面侧栏收起时前面多一颗展开钮）；
  // 右 = 后台在跑的对话数 · 上下文用量环 · 回滚 · 工作区开关。
  // 不放返回 / 新对话键（设计决定：返回在侧栏「主页」，新对话在侧栏）。
  // 这一带在桌面壳里是窗口拖拽区：只有按钮可点，其余留给拖窗；右侧按「是否贴着窗口右缘」让出窗控。
  // 分屏时每一格一条：标题、上下文环、回滚说的都是这一格的会话；右端多一颗 × 关掉这一格；工作区开关只放在最右那一格。
  import { app, backgroundRunning, cacheColdMinutes, pathKey, toggleDock } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { fade, pop } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Mark from "../brand/Mark.svelte";
  import ContextPanel from "../sheets/ContextPanel.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  let {
    onMenu,
    menuVisible = true,
    showDock = true,
    onclose = null,
  }: { onMenu: () => void; menuVisible?: boolean; showDock?: boolean; onclose?: (() => void) | null } = $props();
  const pane = usePane();

  const wideMq = matchMedia("(min-width: 700px)");
  let wide = $state(wideMq.matches);
  $effect(() => {
    const on = (e: MediaQueryListEvent) => (wide = e.matches);
    wideMq.addEventListener("change", on);
    return () => wideMq.removeEventListener("change", on);
  });

  const empty = $derived(pane.chat.timeline.length === 0);
  // 这一格的会话自己的工作空间（快照）；新对话还没有快照 = 全局配置（下一条新对话落在哪）
  const wsPath = $derived(pane.chat.cfg?.workspace ?? app.config?.workspace ?? "");
  const quickProj = $derived(app.projects.find((p) => p.quick) ?? null);
  const wsQuick = $derived(!!quickProj && !!wsPath && pathKey(wsPath) === pathKey(quickProj.path));
  // 快照桶目录名是 UUID，只有项目名读得懂（快照桶的名字是服务端给的「快照对话」，显示时过一道 tr）
  const wsName = $derived(wsQuick ? tr(quickProj!.name) : (wsPath.split(/[\\/]/).filter(Boolean).pop() ?? ""));
  // 标题可能是服务端写的中文（「[已从检查点恢复] …」等）：显示时过一道 tr
  const title = $derived(empty ? "" : tr(pane.chat.title?.trim() ?? "") || t("新对话"));

  // 后台在跑的对话数：分屏时只在左格报一次
  const bgCount = $derived(pane.index === 0 ? backgroundRunning().length : 0);

  // 上下文用量环：>82% 转警示色；前缀缓存大概冷了就褪成灰（30 秒对一次钟）
  const ctxPct = $derived(pane.chat.ctx.limit ? Math.min(100, (pane.chat.ctx.used / pane.chat.ctx.limit) * 100) : 0);
  let nowTick = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (nowTick = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  const ctxCold = $derived(cacheColdMinutes(nowTick, pane.chat) !== null);
  const k = (n: number) => `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  let ctxBtn: HTMLButtonElement | undefined = $state();
  let ctxOpen = $state(false);
  const R = 7.25;
  const C = 2 * Math.PI * R;

  const canRollback = $derived(app.features.sessions && Boolean(pane.chat.id) && !empty);

  function titleClick() {
    // 手机：开抽屉；桌面：侧栏收着时拉出来，摊开着就不动
    if (!wide || menuVisible) onMenu();
  }
</script>

<header class="tb" class:wide>
  <div class="left">
    {#if wide && menuVisible}
      <span in:fade={{ duration: 160 }}>
        <IconButton icon="panel" label={t("展开侧栏")} size={32} onclick={onMenu} />
      </span>
    {/if}
    <button class="where" class:static={wide && !menuVisible} onclick={titleClick} title={wsPath || undefined} aria-label={wide && !menuVisible ? undefined : t("打开项目与会话")}>
      {#if wsName}
        <span class="ws">
          <Icon name={wsQuick ? "bolt" : "folder"} size={15} />
          <span class="ws-name">{wsName}</span>
        </span>
      {/if}
      {#if title}
        {#if wsName}<span class="slash" aria-hidden="true">/</span>{/if}
        <span class="title">{title}</span>
      {/if}
      {#if pane.chat.running}
        <span class="live" title={t("正在进行")} in:pop={{ from: 0.6 }}><Mark size={15} live /></span>
      {/if}
    </button>
  </div>

  <div class="right">
    {#if bgCount > 0}
      <button class="bg" onclick={onMenu} title={t("{n} 个对话在后台运行", { n: bgCount })} aria-label={t("{n} 个对话在后台运行", { n: bgCount })} in:pop>
        <Mark size={14} live />
        <span>{bgCount}</span>
      </button>
    {/if}
    {#if ctxPct > 0}
      <button
        bind:this={ctxBtn}
        class="ctx"
        class:hot={ctxPct > 82}
        class:cold={ctxCold}
        class:open={ctxOpen}
        onclick={() => {
          haptic("light");
          ctxOpen = !ctxOpen;
        }}
        title={ctxCold
          ? t("上下文 {used} / {limit}（{pct}%），缓存大概已经冷了", { used: k(pane.chat.ctx.used), limit: k(pane.chat.ctx.limit), pct: Math.round(ctxPct) })
          : t("上下文 {used} / {limit}（{pct}%）", { used: k(pane.chat.ctx.used), limit: k(pane.chat.ctx.limit), pct: Math.round(ctxPct) })}
        aria-label={t("上下文用量 {pct}%", { pct: Math.round(ctxPct) })}
        aria-expanded={ctxOpen}
        in:pop
      >
        <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
          <circle class="trk" cx="9" cy="9" r={R} />
          <circle class="arc" cx="9" cy="9" r={R} stroke-dasharray="{(C * ctxPct) / 100} {C}" />
        </svg>
      </button>
    {/if}
    {#if canRollback}
      <IconButton icon="history" label={t("回滚到检查点")} size={32} onclick={() => (app.sheet = "checkpoints")} />
    {/if}
    {#if showDock}
    <IconButton
      icon="panelR"
      label={t("工作区")}
      title={t("工作区（任务 / 审阅 / 终端 / 浏览器 / 文件）")}
      size={32}
      active={app.dockOpen}
      onclick={() => {
        haptic("light");
        toggleDock();
      }}
    />
    {/if}
    {#if onclose}
      <IconButton icon="close" label={t("关闭这一格")} title={t("关闭这一格（对话照常保留，在跑的照跑）")} size={32} onclick={onclose} />
    {/if}
  </div>
</header>

{#if ctxOpen && ctxBtn}
  <ContextPanel anchor={ctxBtn} onclose={() => (ctxOpen = false)} />
{/if}

<style>
  .tb {
    position: relative;
    z-index: 2;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: calc(52px + var(--sat, 0px));
    padding: var(--sat, 0px) 8px 0 8px;
  }
  .tb.wide {
    height: calc(var(--hx-band) + var(--sat, 0px));
    padding: var(--sat, 0px) calc(10px + var(--hx-hdr-r, 0px)) 0 10px;
  }
  /* 查询容器：项目名的上限按左半栏的宽度算（cqw），不按 .where 算——.where 是随内容伸缩的，
     标题一短它就跟着窄，百分比上限会把本来放得下的项目名也截成「notes-a…」 */
  .left {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    flex: 1;
    container-type: inline-size;
  }
  .right {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }

  .where {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    height: 34px;
    padding: 0 10px;
    border-radius: 10px;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .where.static {
    cursor: default;
  }
  .ws {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: none;
    max-width: 44cqw;
    color: var(--text2);
  }
  .where:not(:has(.title)) .ws {
    max-width: 100%;
    color: var(--text);
  }
  .ws-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
  }
  .slash {
    flex: none;
    color: var(--text3);
    opacity: 0.6;
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
    font-weight: 500;
  }
  .live {
    display: inline-flex;
    flex: none;
    margin-left: 2px;
    color: var(--text2);
  }

  .bg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 28px;
    padding: 0 9px 0 7px;
    margin-right: 2px;
    border-radius: var(--r-pill);
    background: var(--live-soft);
    color: var(--live);
    font-size: var(--fs-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .ctx {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 10px;
    transition: background-color var(--t-fast) var(--ease);
  }
  .ctx.open {
    background: var(--surface2);
  }
  .ctx svg {
    transform: rotate(-90deg);
  }
  .trk {
    fill: none;
    stroke: var(--border2);
    stroke-width: 2;
  }
  .arc {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    transition:
      stroke-dasharray var(--t-slow) var(--ease-out),
      stroke var(--t-med) var(--ease);
  }
  .hot .arc {
    stroke: var(--warn);
  }
  .cold .arc {
    stroke: var(--text3);
  }

  @media (hover: hover) {
    .where:not(.static):hover,
    .ctx:hover {
      background: var(--surface2);
    }
  }
  .where:not(.static):active {
    background: var(--surface3);
  }
</style>
