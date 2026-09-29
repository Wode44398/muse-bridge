<script lang="ts">
  // 工作区（右侧工作台）：任务 / 审阅 / 终端 / 浏览器 / 文件。
  //  · 宽屏（docked）：右侧一栏，与对话同一张纸（--bg），左缘细线由 App 的分栏手柄给；顶部一条 --hx-band 标签带 + 收起钮。
  //  · 手机：整屏的底部层（把手 + 标签带），从底边滑入；从把手 / 标签带往下拖可关，遮罩点一下关，
  //    返回键经浮层栈先关它（登记了浮层就轮不到 App 返回链里那条「手机关工作区」，不会关两次）。
  // 任务 = 前台会话时间线上的子 agent / 工作流 + 后台命令，不按工作空间作用域；其余四个按工作空间 {#key ws} 重挂。
  // 快捷键由 App 的 keydown 调 handleDockShortcut（工作区关着时本组件不挂载，收不到事件）。
  //
  // 顶部让位只在根部让一次：手机 / 折叠屏让状态栏 --sat；桌面壳（WCO）整条第一行让给窗控当标题栏带。
  // 子树里的 --sat / --sab / --wco-right 归零（挂在子节点上：变量在自身声明里引用会拿到自己的值）。
  //
  // 宽度与位置永远不做动画、切工具只淡入不位移：桌面壳的原生浏览器视图按量出来的矩形落座，
  // 祖先一带 transform 它就落在半路（规格 §1.8）。所以宽屏进场只淡入；手机层在桌面壳里也只淡入。
  import type { Snippet } from "svelte";
  import { onDestroy, untrack } from "svelte";
  import * as api from "../../lib/api.ts";
  import { app, browserToolAvailable, closeDock, setDockTool, type DockTool } from "../../lib/state.svelte.ts";
  import { dragClose, haptic } from "../../lib/touch.ts";
  import { pushLayer } from "../../lib/layers.ts";
  import { fade, slide } from "../../lib/motion.ts";
  import { t, tc } from "../../lib/i18n.ts";
  import { nativeShellBrowser } from "../../lib/nativeShell.ts";
  import { collectTasks } from "../../lib/tasks.ts";
  import { currentJobs, jobMentions, refreshJobs } from "../../lib/jobs.svelte.ts";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Mark from "../brand/Mark.svelte";
  import DockTabs from "./DockTabs.svelte";
  import TasksPanel from "./TasksPanel.svelte";
  import ReviewPanel from "./ReviewPanel.svelte";
  import TermPanel from "./TermPanel.svelte";
  import BrowserPane from "./BrowserPane.svelte";

  // filesView：宿主（bridge）注入的文件视图——嵌入态复用 bridge 的完整工作空间页，dimensio 不自带文件浏览。
  // 契约：只在「文件」工具、ws 非空时渲染，包在 {#key ws} 与 .fembed（transform 圈定 fixed 定位）里。
  let {
    docked = false,
    filesView = null,
  }: {
    docked?: boolean;
    filesView?: Snippet<[{ ws: string; chatId: string; onExit: () => void; target: null | { seq: number; rel: string; open: string } }]> | null;
  } = $props();

  const uid = $props.id();

  const ALL_TOOLS: readonly { key: DockTool; label: string; icon: IconName; kbd: string }[] = [
    { key: "tasks", label: tc("dimensio", "任务"), icon: "tasks", kbd: "" },
    { key: "review", label: t("审阅"), icon: "branch", kbd: "Ctrl+Shift+G" },
    { key: "term", label: t("终端"), icon: "terminal", kbd: "Ctrl+`" },
    { key: "browser", label: t("浏览器"), icon: "globe", kbd: "Ctrl+Shift+B" },
    { key: "files", label: tc("dimensio", "文件"), icon: "folder", kbd: "Ctrl+Shift+E" },
  ];
  // 多用户服务端上没有命令行的账号（harness 租户实例报 tenant.shell=false）：不摆终端。
  // 服务端没有浏览器工具（这台机器没装 Chromium 系浏览器，app.info.tools 里没有 Browser）：不摆浏览器。
  const termOn = $derived(app.info?.tenant?.shell !== false);
  const browserOn = $derived(browserToolAvailable());
  const TOOLS = $derived(ALL_TOOLS.filter((x) => (x.key !== "term" || termOn) && (x.key !== "browser" || browserOn)));

  // 面板作用域 = 当前工作空间（顶栏同一个字段）；chatId 给 API 层兜底
  const ws = $derived(app.config?.workspace ?? "");
  const chatId = $derived(app.chat.id ?? "");

  function pick(tool: DockTool) {
    haptic("light");
    setDockTool(tool);
  }

  // ── U11：后台命令按需拉（lib/jobs.svelte.ts）——换了会话 / 时间线上提到新的 job id / 某行跑完，就拉一次；
  // 有在跑的每 3 秒拉一次，页面藏起来不拉。工作区关着时本组件不挂载，也就不拉。
  const jobKey = $derived(`${app.chat.id ?? ""}|${jobMentions(app.chat.timeline)}`);
  $effect(() => {
    void jobKey;
    untrack(() => void refreshJobs());
  });
  const jobsLive = $derived(currentJobs().some((j) => j.state === "running"));
  $effect(() => {
    if (!jobsLive) return;
    const timer = setInterval(() => {
      if (!document.hidden) void refreshJobs();
    }, 3000);
    return () => clearInterval(timer);
  });

  // 标签上的在跑小点：只在没看着它的时候挂
  const tasksLive = $derived(jobsLive || collectTasks(app.chat.timeline).some((x) => x.status === "running"));
  const live = $derived<Partial<Record<DockTool, boolean>>>({
    tasks: tasksLive && app.dockTool !== "tasks",
    browser: Boolean(app.browser) && app.dockTool !== "browser",
  });

  // 浏览器小点要诚实（§17-3）：app.browser 只在浏览器面板开着时才看得到浏览器退出（alive:false / 409）。
  // 面板不在前面时，挂载时与每轮结束时各问一次服务端，浏览器已经退了就清掉（小点与「Agent 浏览器」胶囊一起熄）。
  // 问的期间它又被拉起来了（app.browser 换了新对象），就不动它。
  function probeBrowser() {
    const was = app.browser;
    if (!was || app.dockTool === "browser") return;
    api
      .browserState()
      .then((s) => {
        if (s.alive || app.browser !== was) return;
        app.browser = null;
        app.browserTabs = [];
      })
      .catch(() => {});
  }
  $effect(() => untrack(probeBrowser));
  let wasRunning = untrack(() => app.chat.running);
  $effect(() => {
    const r = app.chat.running;
    if (wasRunning && !r) untrack(probeBrowser);
    wasRunning = r;
  });

  // §17-1：顶栏的工作区开关走 toggleDock（只翻开关、不清定位），其余关法都走 closeDock。
  // 真关了（不是宽窄切换换了个实例）就在这里补清定位目标：下次打开是干净的工作空间视图。
  onDestroy(() => {
    if (app.dockOpen) return;
    app.tasksFocus = null;
    app.tasksAgent = null;
    app.filesTarget = null;
  });

  // ── 手机层 ───────────────────────────────────────────────────────────────────────
  let handle: HTMLElement | undefined = $state();
  let dragged = false; // 拖着关掉的：滑出已经由手势做完，退场别再跳回原位重播一遍
  // 返回键先关它；Esc 不关（终端 / 浏览器要收 Esc）；它自己装着原生浏览器视图，不让位（native: false）
  $effect(() => {
    if (docked) return;
    return pushLayer(() => closeDock(), { escape: false, native: false });
  });
  function grab(node: HTMLElement) {
    return dragClose(node, {
      onClose: () => {
        dragged = true;
        closeDock();
      },
      handle: () => handle ?? null,
    });
  }
  function sheetIn(node: Element) {
    if (nativeShellBrowser) return fade(node, { duration: 200 }, { direction: "in" });
    return slide(node, { from: "bottom" }, { direction: "in" });
  }
  function sheetOut(node: Element) {
    if (dragged) return { duration: 0 };
    if (nativeShellBrowser) return fade(node, { duration: 200 }, { direction: "out" });
    return slide(node, { from: "bottom", out: 220 }, { direction: "out" });
  }
</script>

{#snippet panels()}
  {#if app.dockTool === "tasks"}
    <!-- 任务视图的数据 = 前台会话时间线，工作空间还没就绪也照常给 -->
    <TasksPanel />
  {:else if !ws}
    <div class="wait">
      <Mark size={20} live />
      <p>{t("工作空间加载中…")}</p>
    </div>
  {:else}
    {#key ws}
      {#if app.dockTool === "review"}
        <ReviewPanel {ws} {chatId} />
      {:else if app.dockTool === "term" && termOn}
        <TermPanel {ws} {chatId} />
      {:else if app.dockTool === "browser" && browserOn}
        <BrowserPane />
      {:else if filesView}
        <!-- transform 把宿主视图里的 fixed（根 / 浮层 / 菜单）圈在面板区 -->
        <div class="fembed">{@render filesView({ ws, chatId, onExit: closeDock, target: app.filesTarget })}</div>
      {:else}
        <div class="wait">
          <span class="wait-ic"><Icon name="folder" size={24} stroke={1.4} /></span>
          <p>{t("文件视图由 bridge 宿主提供；独立运行模式请直接用系统文件管理器打开工作空间")}</p>
        </div>
      {/if}
    {/key}
  {/if}
{/snippet}

{#snippet body()}
  <div class="body" id="{uid}-panel" role="tabpanel" aria-labelledby="{uid}-tab-{app.dockTool}">
    {#key app.dockTool}
      <div class="pane">{@render panels()}</div>
    {/key}
  </div>
{/snippet}

{#if docked}
  <aside class="dock" aria-label={t("工作区")}>
    <div class="band">
      <DockTabs tools={TOOLS} value={app.dockTool} {live} idBase={uid} onpick={pick} />
      <IconButton icon="close" label={t("收起工作区")} size={32} onclick={closeDock} />
    </div>
    {@render body()}
  </aside>
{:else}
  <div class="layer">
    <button class="scrim" aria-label={t("收起工作区")} tabindex="-1" onclick={closeDock} in:fade|global={{ duration: 220 }} out:fade|global={{ duration: 200 }}
    ></button>
    <div class="sheet" role="dialog" aria-modal="true" aria-label={t("工作区")} use:grab in:sheetIn|global out:sheetOut|global>
      <div class="grip-zone" bind:this={handle}>
        <span class="grip" aria-hidden="true"></span>
        <div class="band">
          <DockTabs tools={TOOLS} value={app.dockTool} {live} idBase={uid} onpick={pick} />
          <IconButton icon="chevronD" label={t("收起工作区")} size={40} iconSize={20} onclick={closeDock} />
        </div>
      </div>
      {@render body()}
    </div>
  </div>
{/if}

<style>
  /* ── 宽屏：右侧一栏 ── */
  /* --dk-bg = 本层的纸（小点描边、挖空用）；--dk-card = 在这张纸上「浮起一层」的面（浏览器当前标签） */
  .dock {
    --dk-bg: var(--bg);
    --dk-card: var(--surface);
    height: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    padding-top: var(--sat, 0px);
    padding-bottom: var(--sab, 0px);
    animation: dk-in 200ms var(--ease-out) both;
  }
  :global(html[data-wco="1"]) .dock {
    padding-top: var(--wco-h, 40px);
  }
  .dock > .band,
  .dock > :global(.body) {
    --sat: 0px;
    --sab: 0px;
    --wco-right: 0px;
  }
  @keyframes dk-in {
    from {
      opacity: 0;
    }
  }

  .band {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: var(--hx-band, 44px);
    padding: 0 calc(6px + var(--hx-pane-r, 0px)) 0 8px;
  }

  .body {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* 切工具：新面板淡入（只动透明度） */
  .pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    animation: dk-in 180ms var(--ease-out) both;
  }

  .wait {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px 28px;
    color: var(--text3);
    text-align: center;
  }
  .wait p {
    margin: 0;
    max-width: 300px;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text2);
  }
  .wait-ic {
    display: inline-flex;
    opacity: 0.8;
  }

  /* 宿主注入的文件视图：transform 让它的 fixed 布局以面板为包含块 */
  .fembed {
    flex: 1;
    min-width: 0;
    min-height: 0;
    position: relative;
    overflow: hidden;
    transform: translateZ(0);
    display: flex;
    flex-direction: column;
  }

  /* ── 手机：整屏底部层 ── */
  .layer {
    position: fixed;
    inset: 0;
    z-index: 55;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    cursor: default;
  }
  .sheet {
    --dk-bg: var(--surface);
    --dk-card: var(--bg);
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: calc(100dvh - 52px - var(--sat, 0px));
    padding-bottom: var(--sab, 0px);
    border-radius: 22px 22px 0 0;
    background: var(--surface);
    color: var(--text);
    box-shadow: var(--shadow-3);
    overflow: hidden;
    /* dragClose 松手回弹走这条过渡 */
    transition: transform var(--t-spring-soft, 420ms) var(--spring-soft, var(--ease-out));
  }
  .sheet > .grip-zone,
  .sheet > :global(.body) {
    --sat: 0px;
    --sab: 0px;
    --wco-right: 0px;
  }
  .grip-zone {
    flex: none;
    touch-action: none;
    padding-top: 7px;
  }
  .grip {
    display: block;
    width: 36px;
    height: 4px;
    margin: 0 auto 2px;
    border-radius: 2px;
    background: var(--border2);
  }
  .sheet .band {
    padding: 0 6px 0 8px;
  }

  @media (prefers-reduced-motion: reduce) {
    .dock,
    .pane {
      animation-duration: 1ms;
    }
  }
</style>
