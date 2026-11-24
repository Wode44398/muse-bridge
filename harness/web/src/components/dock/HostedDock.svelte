<script lang="ts" module>
  import type { Snippet } from "svelte";
  import type { Cols, Weights } from "../../lib/dock-cards.ts";

  // 交给宿主外壳的工具：own = 内容由这边的 panel 片段给，其余是宿主的共用面板（终端 / 浏览器 / 文件 / 记忆）
  export interface DockToolSpec {
    key: string;
    label: string;
    closeLabel: string;
    kbd: string;
    col: "a" | "b";
    own: boolean;
    live: boolean; // 开关上的提示点：有动静而没在看
    lamp: boolean; // 状态灯：看着也亮
    hot: boolean; // 卡片标题行上的在跑点
    fixed?: boolean; // 不进拖动排序、固定挂在第二列末尾（宿主注入的插件卡片）
    plugin?: boolean;
  }
  // 宿主注入的额外卡片（bridge 插件的工作区卡片，ctx.ui.workbench 的 hosts 含 dimensio）：内容与图标都由宿主画
  export interface ExtraDockTool {
    key: string;
    label: string;
    closeLabel: string;
    icon: string; // 宿主给的 SVG 串
  }
  // 宿主外壳读写工作区状态的唯一口子：状态仍只有 dimensio 自己这一份（app / dockCards），外壳不另存。
  export interface DockBridge {
    readonly docked: boolean;
    readonly twoOk: boolean;
    setTwo(two: boolean): void;
    readonly open: boolean;
    readonly view: string;
    readonly views: string[];
    readonly max: string;
    readonly cols: Cols;
    readonly weights: Weights;
    readonly focus: null | { tool: string; seq: number };
    readonly ws: string;
    readonly chatId: string;
    readonly filesTarget: null | { seq: number; rel: string; open: string };
    readonly termLive: boolean;
    readonly browserUrl: string;
    readonly tools: DockToolSpec[];
    readonly sharedTerm: boolean;
    readonly sharedBrowser: boolean;
    openTool(tool?: string): void;
    close(): void;
    closeCard(tool: string): void;
    toggleCard(tool: string): void;
    toggleMax(tool: string): void;
    setCols(cols: Cols): void;
    setWeights(w: Weights, live: boolean): void;
    clearTermLive(): void;
    noteFocus(tool: string): void;
    pushLayer(close: () => void): () => void;
    // 共用浏览器面板把标签与地址写回来：输入框上方的「Agent 浏览器」胶囊、状态灯都读 app.browser
    noteBrowser(tabs: { id: string; url: string; title?: string; active?: boolean }[], alive: boolean): void;
    setExtraTools(list: ExtraDockTool[]): void;
  }
  export type DockView = Snippet<[{ dk: DockBridge; panel: Snippet<[string]>; icon: Snippet<[string]> }]>;
</script>

<script lang="ts">
  // 工作区：外壳由宿主（bridge）给——和 Claude / Codex / Antigravity 分页同一份（卡片、拖动排序、两列、调高度、手机抽屉）。
  // 这里只做三件事：把 dimensio 的工作区状态原样接给外壳；给出专属卡的内容（任务、带会话范围的审阅，
  // 以及终端 / 浏览器没并到宿主那套运行时的时候用自己的面板）；跑工作区开着才需要的几件后台事。
  // 没有宿主（脱离 bridge 独立运行）就没有工作区：独立运行只是开发脚手架。
  import { onDestroy, untrack } from "svelte";
  import * as api from "../../lib/api.ts";
  import {
    app,
    browserToolAvailable,
    closeDock,
    closeDockCard,
    dockCards,
    dockShowing,
    noteDockFocus,
    openDock,
    setDockCols,
    setDockTool,
    setDockWeights,
    toggleDockCard,
    toggleDockMax,
    type DockTool,
  } from "../../lib/state.svelte.ts";
  import { pushLayer } from "../../lib/layers.ts";
  import { t, tc } from "../../lib/i18n.ts";
  import { browserScope } from "../../lib/browser-mount.svelte.ts";
  import { collectTasks } from "../../lib/tasks.ts";
  import { currentJobs, jobMentions, refreshJobs } from "../../lib/jobs.svelte.ts";
  import { collab } from "../../lib/workspace-collab.svelte.ts";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "../ui/Icon.svelte";
  import TasksPanel from "./TasksPanel.svelte";
  import ReviewPanel from "./ReviewPanel.svelte";
  import TermPanel from "./TermPanel.svelte";
  import BrowserPane from "./BrowserPane.svelte";

  // twoOk：这一栏放得下两列（宽屏且对话还剩够宽）；two：此刻是不是真摆成了两列（App 据此给两列的宽度）
  let {
    view,
    docked = false,
    twoOk = false,
    two = $bindable(false),
  }: { view: DockView; docked?: boolean; twoOk?: boolean; two?: boolean } = $props();

  const caps = $derived(app.compat?.caps ?? []);
  // 多用户服务端上没有命令行的账号不摆终端；这台机器没有可用的浏览器就不摆浏览器
  const termOn = $derived(app.info?.tenant?.shell !== false);
  const browserOn = $derived(browserToolAvailable());
  // 终端 / 浏览器并到了宿主那套运行时（agent 的工具也落在那边）：面板用宿主的共用面板，看到的就是 agent 手里那个
  const sharedTerm = $derived(caps.includes("shared-terminal"));
  const sharedBrowser = $derived(caps.includes("shared-browser"));

  const ws = $derived(app.config?.workspace ?? "");
  const chatId = $derived(app.chat.id ?? "");

  // ── 后台命令按需拉——换了会话 / 时间线上提到新的 job id / 某行跑完，就拉一次；
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
  const tasksLive = $derived(jobsLive || collectTasks(app.chat.timeline).some((x) => x.status === "running"));

  // 浏览器小点要诚实：app.browser 只在浏览器面板开着时才看得到浏览器退出。面板不在前面时，挂载时与每轮结束时
  // 各问一次服务端，浏览器已经退了就清掉。问的期间它又被拉起来了（app.browser 换了新对象），就不动它。
  function probeBrowser() {
    const was = app.browser;
    if (!was || dockShowing("browser")) return;
    api
      .browserState(browserScope())
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

  // 顶栏的工作区开关只翻开关、不清定位；真关了（不是宽窄切换换了个实例）就在这里补清：下次打开是干净的工作空间视图
  onDestroy(() => {
    if (app.dockOpen) return;
    app.tasksFocus = null;
    app.tasksAgent = null;
    app.filesTarget = null;
  });

  const META: { key: DockTool; label: string; icon: IconName; kbd: string; col: "a" | "b" }[] = [
    { key: "tasks", label: tc("dimensio", "任务"), icon: "tasks", kbd: "", col: "a" },
    { key: "review", label: t("审阅"), icon: "branch", kbd: "Ctrl+Shift+G", col: "a" },
    { key: "term", label: t("终端"), icon: "terminal", kbd: "Ctrl+`", col: "a" },
    { key: "browser", label: t("浏览器"), icon: "globe", kbd: "Ctrl+Shift+B", col: "b" },
    { key: "files", label: tc("dimensio", "文件"), icon: "folder", kbd: "Ctrl+Shift+E", col: "b" },
    { key: "memory", label: tc("dimensio", "记忆"), icon: "memory", kbd: "", col: "b" },
  ];
  const iconOf = (key: string) => META.find((x) => x.key === key)?.icon ?? "folder";
  let extra = $state<ExtraDockTool[]>([]);
  const extraIcon = (key: string) => extra.find((x) => x.key === key)?.icon ?? "";
  const tools = $derived<DockToolSpec[]>([
    ...META.filter((x) => (x.key !== "term" || termOn) && (x.key !== "browser" || browserOn)).map((x) => ({
      key: x.key,
      label: x.label,
      closeLabel: t("关闭{name}", { name: x.label }),
      kbd: x.kbd,
      col: x.col,
      own: x.key === "tasks" || x.key === "review" || (x.key === "term" && !sharedTerm) || (x.key === "browser" && !sharedBrowser),
      live: x.key === "tasks" ? tasksLive : x.key === "term" ? collab.termLive : false,
      lamp: x.key === "browser" && Boolean(app.browser), // 前台会话的浏览器里有标签才亮
      hot: x.key === "tasks" ? tasksLive : x.key === "browser" ? Boolean(app.browser) : false,
    })),
    ...extra.map((x) => ({
      key: x.key, label: x.label, closeLabel: x.closeLabel, kbd: "", col: "b" as const,
      own: false, live: false, lamp: false, hot: false, fixed: true, plugin: true,
    })),
  ]);
  const avail = (v: string) => tools.some((x) => x.key === v);

  // 宽屏：最近聚焦的那张必须在桌上（手机上切过工具再拉宽、服务端收回了某个工具）；一张都不剩就摆回一张
  $effect(() => {
    if (!docked) return;
    const tool = app.dockTool;
    const none = !dockCards.open.some(avail);
    const first = tools[0]?.key as DockTool | undefined;
    untrack(() => {
      if (avail(tool) && !dockCards.open.includes(tool)) setDockTool(tool);
      else if (none && first) setDockTool(avail(tool) ? tool : first);
    });
  });

  const dk: DockBridge = {
    get docked() { return docked; },
    get twoOk() { return twoOk; },
    setTwo(v) { two = v; },
    get open() { return app.dockOpen; },
    get view() { return app.dockTool; },
    get views() { return dockCards.open; },
    get max() { return dockCards.max; },
    get cols() { return dockCards.cols; },
    get weights() { return dockCards.weights; },
    get focus() { return dockCards.focus; },
    get ws() { return ws; },
    get chatId() { return chatId; },
    get filesTarget() { return app.filesTarget; },
    get termLive() { return collab.termLive; },
    get browserUrl() { return app.browser?.url ?? ""; },
    get tools() { return tools; },
    get sharedTerm() { return sharedTerm; },
    get sharedBrowser() { return sharedBrowser; },
    openTool(tool) { openDock(tool as DockTool | undefined); },
    close() { closeDock(); },
    closeCard(tool) {
      closeDockCard(tool as DockTool);
      // 剩下的都是这台服务端不给的工具：等于全关了
      if (app.dockOpen && docked && !dockCards.open.some(avail)) closeDock();
    },
    toggleCard(tool) { toggleDockCard(tool as DockTool); },
    toggleMax(tool) { toggleDockMax(tool as DockTool); },
    setCols(cols) { setDockCols(cols); },
    setWeights(w, live) {
      if (live) dockCards.weights = w;
      else setDockWeights(w);
    },
    clearTermLive() { collab.termLive = false; },
    noteFocus(tool) { noteDockFocus(tool as DockTool); },
    // 返回键先关工作区；Esc 不关（终端 / 浏览器要收 Esc）；它自己装着浏览器视图，不让位
    pushLayer(close) { return pushLayer(close, { escape: false, native: false }); },
    setExtraTools(list) {
      const next = Array.isArray(list) ? list.filter((x) => x && typeof x.key === "string" && /^plg:/.test(x.key)) : [];
      if (JSON.stringify(next) !== JSON.stringify(extra)) extra = next;
    },
    noteBrowser(tabs, alive) {
      const list = alive ? tabs : [];
      app.browserTabs = list as typeof app.browserTabs;
      const url = list.find((x) => x.active)?.url ?? list[0]?.url ?? "";
      if (!list.length) app.browser = null;
      else if (app.browser?.url !== url) app.browser = { url };
    },
  };
</script>

{#snippet icon(key: string)}
  {#if extraIcon(key)}<span class="hx-plg-ic" aria-hidden="true">{@html extraIcon(key)}</span>
  {:else}<Icon name={iconOf(key)} size={16} stroke={1.7} />{/if}
{/snippet}

{#snippet panel(tool: string)}
  {#if tool === "tasks"}
    <!-- 任务的数据 = 前台会话时间线，工作空间还没就绪也照常给 -->
    <TasksPanel />
  {:else if ws}
    {#key ws}
      {#if tool === "review"}<ReviewPanel {ws} {chatId} />
      {:else if tool === "term"}<TermPanel {ws} {chatId} />
      {:else if tool === "browser"}<BrowserPane />
      {/if}
    {/key}
  {/if}
{/snippet}

{@render view({ dk, panel, icon })}

<style>
  /* 宿主注入的插件卡片图标（SVG 串）：和内置图标同样 16px、线条跟随文字色 */
  .hx-plg-ic { display: inline-flex; width: 16px; height: 16px; }
  .hx-plg-ic :global(svg) { width: 100%; height: 100%; }
</style>
