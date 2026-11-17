<script lang="ts">
  // 工作区（右侧工作台）：任务 / 审阅 / 终端 / 浏览器 / 文件 / 记忆。
  //  · 宽屏（docked）：右侧一栏，里面是一叠圆角卡片，可以同时开好几张。顶部一条 --hx-band 带放工具开关组 + 收起钮；
  //    卡片的标题行就是拖拽把手（排顺序、跨列），双击或点放大钮铺满整栏，关掉最后一张 = 收起工作区。
  //    够宽（宿主给 twoOk）且两列都有卡时摆两列，否则全叠一列；卡与卡之间的缝可以拖，调这两张的高度比。
  //  · 手机：整屏的底部层（把手 + 标签带），一次一张，从底边滑入；从把手 / 标签带往下拖可关，遮罩点一下关，
  //    返回键经浮层栈先关它（登记了浮层就轮不到 App 返回链里那条「手机关工作区」，不会关两次）。
  // 任务 = 前台会话时间线上的子 agent / 工作流 + 后台命令，不按工作空间作用域；其余几个按工作空间 {#key ws} 重挂。
  // 快捷键由 App 的 keydown 调 handleDockShortcut（工作区关着时本组件不挂载，收不到事件）。
  //
  // 顶部让位只在根部让一次：手机 / 折叠屏让状态栏 --sat；桌面壳（WCO）整条第一行让给窗控当标题栏带。
  // 子树里的 --sat / --sab / --wco-right 归零（挂在子节点上：变量在自身声明里引用会拿到自己的值）。
  //
  // 卡片为什么绝对定位、按比例摆、平铺一个 keyed each：列数变化、换位、换列时卡片不换父节点、不重挂——
  // 终端和浏览器的连接、滚回缓冲都留着。
  // 桌面壳的原生浏览器视图按量出来的矩形落座、恒盖在 DOM 之上：卡片静止时祖先不带 transform；
  // 拖着排序期间整个让位（压一层原生浮层），落位动画走完再放它回来按新矩形重挂。
  // 拖动走指针事件 + 指针捕获（不是 HTML5 拖拽）：卡片要真跟手、别的卡实时让位；捕获后拖进 iframe 也收得到松手。
  import type { Snippet } from "svelte";
  import { onDestroy, tick, untrack } from "svelte";
  import * as api from "../../lib/api.ts";
  import {
    app,
    browserToolAvailable,
    closeDock,
    closeDockCard,
    dockCards,
    dockShowing,
    noteDockFocus,
    setDockCols,
    setDockTool,
    setDockWeights,
    toggleDockCard,
    toggleDockMax,
    type DockTool,
  } from "../../lib/state.svelte.ts";
  import { dragClose, haptic } from "../../lib/touch.ts";
  import { pushLayer } from "../../lib/layers.ts";
  import { fade, reducedMotion, rise, slide, springEasing, SPRING_SNAP, SPRING_SOFT } from "../../lib/motion.ts";
  import { t, tc } from "../../lib/i18n.ts";
  import { nativeShellBrowser, pushNativeOverlay } from "../../lib/nativeShell.ts";
  import { browserScope } from "../../lib/browser-mount.svelte.ts";
  import { collectTasks } from "../../lib/tasks.ts";
  import { currentJobs, jobMentions, refreshJobs } from "../../lib/jobs.svelte.ts";
  import { GAP, RENDER_ORDER, boxCss, columns, dividers, resizePair, sameCols, slots, target, weightOf, type Cols, type Divider } from "../../lib/dock-cards.ts";
  import type { IconName } from "../../lib/icons.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Mark from "../brand/Mark.svelte";
  import DockTabs from "./DockTabs.svelte";
  import DockToggles from "./DockToggles.svelte";
  import TasksPanel from "./TasksPanel.svelte";
  import ReviewPanel from "./ReviewPanel.svelte";
  import TermPanel from "./TermPanel.svelte";
  import BrowserPane from "./BrowserPane.svelte";
  import { collab, wsHost } from "../../lib/workspace-collab.svelte.ts";

  // filesView：宿主（bridge）注入的文件视图——嵌入态复用 bridge 的完整工作空间页，dimensio 不自带文件浏览。
  // 契约：只在「文件」工具、ws 非空时渲染，包在 {#key ws} 与 .fembed（transform 圈定 fixed 定位）里。
  // twoOk：宿主说这一栏放得下两列（宽屏且对话还剩够宽）；two：此刻是不是真摆成了两列（宿主据此给两列的宽度）。
  let {
    docked = false,
    filesView = null,
    twoOk = false,
    two = $bindable(false),
  }: {
    docked?: boolean;
    filesView?: Snippet<[{ ws: string; chatId: string; onExit: () => void; target: null | { seq: number; rel: string; open: string } }]> | null;
    twoOk?: boolean;
    two?: boolean;
  } = $props();

  const uid = $props.id();

  const ALL_TOOLS: readonly { key: DockTool; label: string; icon: IconName; kbd: string }[] = [
    { key: "tasks", label: tc("dimensio", "任务"), icon: "tasks", kbd: "" },
    { key: "review", label: t("审阅"), icon: "branch", kbd: "Ctrl+Shift+G" },
    { key: "term", label: t("终端"), icon: "terminal", kbd: "Ctrl+`" },
    { key: "browser", label: t("浏览器"), icon: "globe", kbd: "Ctrl+Shift+B" },
    { key: "files", label: tc("dimensio", "文件"), icon: "folder", kbd: "Ctrl+Shift+E" },
    { key: "memory", label: tc("dimensio", "记忆"), icon: "memory", kbd: "" },
  ];
  // 多用户服务端上没有命令行的账号（harness 租户实例报 tenant.shell=false）：不摆终端。
  // D5：服务端没有浏览器工具（这台机器没有可用的浏览器，app.info.tools 里没有 Browser）：不摆浏览器。
  const termOn = $derived(app.info?.tenant?.shell !== false);
  const browserOn = $derived(browserToolAvailable());
  // 记忆：宿主（bridge）注入了记忆卡才摆（独立运行用设置里的「记忆管理」）
  const memoryView = $derived(wsHost.h?.memoryView ?? null);
  const TOOLS = $derived(
    ALL_TOOLS.filter((x) => (x.key !== "term" || termOn) && (x.key !== "browser" || browserOn) && (x.key !== "memory" || !!memoryView)),
  );
  const avail = (v: DockTool) => TOOLS.some((x) => x.key === v);
  const metaOf = (v: DockTool) => ALL_TOOLS.find((x) => x.key === v)!;

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

  // 在跑：任务（子 agent / 工作流 / 后台命令在跑）、浏览器（agent 浏览器活着）。
  // 开关 / 标签上的小点只在没看着它的时候挂；卡片标题行上的小点只要在跑就亮。
  const tasksLive = $derived(jobsLive || collectTasks(app.chat.timeline).some((x) => x.status === "running"));
  const hot = (v: DockTool) => (v === "tasks" ? tasksLive : v === "browser" ? Boolean(app.browser) : false);
  const live = $derived<Partial<Record<DockTool, boolean>>>({
    tasks: tasksLive && !dockShowing("tasks"),
    browser: Boolean(app.browser) && !dockShowing("browser"), // 挂载状态：前台会话的浏览器里有标签才亮（lib/browser-mount.svelte.ts）
    term: collab.termLive && !dockShowing("term"), // agent 动过共享终端、还没去看
  });
  $effect(() => {
    if (collab.termLive && dockShowing("term")) collab.termLive = false;
  });

  // 浏览器小点要诚实（§17-3）：app.browser 只在浏览器面板开着时才看得到浏览器退出（alive:false / 409）。
  // 面板不在前面时，挂载时与每轮结束时各问一次服务端，浏览器已经退了就清掉（小点与「Agent 浏览器」胶囊一起熄）。
  // 问的期间它又被拉起来了（app.browser 换了新对象），就不动它。
  function probeBrowser() {
    const was = app.browser;
    if (!was || dockShowing("browser")) return;
    api
      .browserState(browserScope()) // 前台会话的那份（服务端按会话各开一份）
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

  // ── 宽屏：卡片 ────────────────────────────────────────────────────────────────────
  // 摆出来的卡 = 开着的、这台服务端给的那几张
  const shown = $derived(docked ? dockCards.open.filter(avail) : []);
  // 最近聚焦的那张必须在桌上（手机上切过工具再拉宽、服务端收回了某个工具）；一张都不剩就摆回一张
  $effect(() => {
    if (!docked) return;
    const tool = app.dockTool;
    const none = shown.length === 0;
    const first = TOOLS[0]?.key;
    untrack(() => {
      if (avail(tool) && !dockCards.open.includes(tool)) setDockTool(tool);
      else if (none && first) setDockTool(avail(tool) ? tool : first);
    });
  });
  function closeCard(v: DockTool) {
    haptic("light");
    closeDockCard(v);
    // 剩下的都是这台服务端不给的工具：等于全关了
    if (app.dockOpen && !dockCards.open.some(avail)) closeDock();
  }

  type Sort = { v: DockTool; start: Cols; cols: Cols; n: 1 | 2; n0: 1 | 2; split: boolean; tx: number; ty: number };
  let sort = $state<Sort | null>(null);
  const cols = $derived(sort ? sort.cols : dockCards.cols);
  const maxed = $derived<DockTool | "">(dockCards.max && shown.includes(dockCards.max) ? dockCards.max : "");
  const colsNow = $derived(columns(cols, shown, true));
  // 拖动中列数由预览定（拖空的那一列留作落点，不当场塌成一列，免得工作区宽度在指针底下跳）
  const twoNow = $derived(sort ? sort.n === 2 : twoOk && colsNow[0].length > 0 && colsNow[1].length > 0);
  $effect(() => {
    two = docked && twoNow;
  });
  const list = $derived(columns(cols, shown, twoNow));
  const at = $derived(slots(list, dockCards.weights));
  const FULL = "left:0;top:0;width:100%;height:100%";
  const cards = $derived(
    RENDER_ORDER.filter((v) => at[v]).map((v) => {
      let box = maxed ? (maxed === v ? FULL : "") : boxCss(at[v]!);
      if (sort && sort.v === v && box) box += `;transform:translate(${sort.tx}px,${sort.ty}px) scale(1.01)`;
      return { v, box };
    }),
  );
  // 拖着那张卡的落点（虚线框）= 它在预览排布里的格子；拖空了的那一列也描一圈，告诉你还能放回去
  const slotBox = $derived(sort && !maxed && at[sort.v] ? boxCss(at[sort.v]!) : "");
  const emptyBox = $derived.by(() => {
    if (!sort || maxed || !twoNow) return "";
    const empty = list.findIndex((c) => c.length === 0);
    if (empty < 0) return "";
    const other = list[1 - empty][0];
    const o = other ? at[other] : null;
    return o ? `left:${empty === 0 ? "0px" : `calc(${o.width} + ${GAP}px)`};width:${o.width};top:0;height:100%` : "";
  });
  const seams = $derived(sort || maxed ? [] : dividers(list, at));

  let dockEl: HTMLElement | undefined = $state();
  let cardsEl: HTMLElement | undefined = $state();
  const cardEls: Partial<Record<DockTool, HTMLElement>> = {};
  const ringEls: Partial<Record<DockTool, HTMLElement>> = {};
  function cardRef(node: HTMLElement, v: DockTool) {
    cardEls[v] = node;
    return {
      destroy() {
        if (cardEls[v] === node) delete cardEls[v];
      },
    };
  }
  function ringRef(node: HTMLElement, v: DockTool) {
    ringEls[v] = node;
    return {
      destroy() {
        if (ringEls[v] === node) delete ringEls[v];
      },
    };
  }

  // ── FLIP：排布一变，各卡从刚才的视觉位置滑到新格子 ──
  // 只动 transform；尺寸当场换（拉伸动画会让终端 / 浏览器跟着逐帧重排）。before 量的是含进行中动画的视觉位置，
  // 连续换位也接得上不跳。动画不留 fill：走完 transform 就摘掉，原生浏览器视图按静止矩形落座。
  type Rects = Partial<Record<DockTool, DOMRect>>;
  function rects(skip?: DockTool): Rects {
    const m: Rects = {};
    const keep = new Set(cards.map((c) => c.v));
    for (const k of Object.keys(cardEls) as DockTool[]) {
      const el = cardEls[k];
      if (k !== skip && el && keep.has(k) && el.offsetParent) m[k] = el.getBoundingClientRect();
    }
    return m;
  }
  // 拖动中让位用快弹簧（跟手、几乎不过冲）；落位与开关卡片用柔弹簧（卡片走得远，带回弹会冲出卡片区的边）
  function flip(before: Rects, spring = SPRING_SOFT) {
    if (reducedMotion()) return;
    const easing = springEasing(spring);
    for (const k of Object.keys(before) as DockTool[]) {
      const el = cardEls[k];
      const o = before[k];
      if (!el || !o || !el.offsetParent) continue;
      for (const a of el.getAnimations()) if (a.id === "dkflip") a.cancel();
      const b = el.getBoundingClientRect();
      const dx = o.left - b.left;
      const dy = o.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const an = el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: spring.ms, easing });
      an.id = "dkflip";
    }
  }
  // 拖动以外的排布变化（开 / 关一张、列数变化、放大还原、松手落位）：DOM 更新前量一次，更新后滑过去；
  // 放大还原时从隐藏里回来的卡只淡入
  const layoutKey = $derived(cards.map((c) => `${c.v}:${c.box}`).join("|"));
  let pre: { rects: Rects; hidden: DockTool[] } | null = null;
  $effect.pre(() => {
    void layoutKey;
    if (!docked || sort) return;
    untrack(() => {
      const hidden = (Object.keys(cardEls) as DockTool[]).filter((k) => cardEls[k] && !cardEls[k]!.offsetParent);
      pre = cardsEl ? { rects: rects(), hidden } : null;
    });
  });
  $effect(() => {
    void layoutKey;
    if (!docked || sort) return;
    untrack(() => {
      const p = pre;
      pre = null;
      if (!p) return;
      flip(p.rects);
      if (reducedMotion()) return;
      for (const k of p.hidden) {
        const el = cardEls[k];
        if (el?.offsetParent) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
      }
    });
  });

  // 被别处点名（已经开着）：卡片描一圈墨、退掉
  $effect(() => {
    const f = dockCards.focus;
    if (!f || !docked) return;
    untrack(() => {
      const ring = ringEls[f.tool];
      if (!ring || reducedMotion()) return;
      ring.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 900, easing: "ease-out" });
    });
  });

  // ── 拖标题行排顺序 ──
  type Press = { v: DockTool; x: number; y: number; pid: number; head: HTMLElement; dead?: boolean; fx: number; gy: number; px: number; py: number; bandAt: number; bandT: number };
  let press: Press | null = null;
  let releaseNative: (() => void) | null = null;
  let nativeTimer = 0;
  const fine = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
  // 一列时拖进右侧那一带要停一会儿才拆成两列：工作区贴着窗口右缘，往右一划而过不该让它先变宽再缩回去
  const SPLIT_DWELL = 240;

  function holdNative() {
    clearTimeout(nativeTimer);
    if (!releaseNative) releaseNative = pushNativeOverlay();
  }
  // 落位动画走完再放原生视图回来（它会按卡片的新矩形重挂）；飞回去的那张一路压在别的卡上面
  let landing = $state<DockTool | "">("");
  function freeNative(v: DockTool, after = 0) {
    clearTimeout(nativeTimer);
    landing = v;
    nativeTimer = window.setTimeout(() => {
      landing = "";
      releaseNative?.();
      releaseNative = null;
    }, after);
  }
  onDestroy(() => {
    clearTimeout(nativeTimer);
    clearTimeout(press?.bandT);
    releaseNative?.();
    releaseNative = null;
  });

  function headDown(e: PointerEvent, v: DockTool) {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    const head = e.currentTarget as HTMLElement;
    press = { v, x: e.clientX, y: e.clientY, pid: e.pointerId, head, fx: 0.5, gy: 0, px: e.clientX, py: e.clientY, bandAt: 0, bandT: 0 };
    try {
      head.setPointerCapture(e.pointerId);
    } catch {
      /* 指针已经没了 */
    }
  }
  function beginSort() {
    const p = press!;
    const el = cardEls[p.v];
    // 一张卡、或者放大铺满时：没什么可排的，按普通按下处理
    if (!el || maxed || shown.length < 2) {
      p.dead = true;
      return;
    }
    const r = el.getBoundingClientRect();
    p.fx = (p.x - r.left) / (r.width || 1);
    p.gy = p.y - r.top;
    const start = { a: [...dockCards.cols.a], b: [...dockCards.cols.b] };
    const n0 = twoNow ? 2 : 1;
    sort = { v: p.v, start, cols: start, n: n0, n0, split: false, tx: 0, ty: 0 };
    holdNative();
    haptic("light");
  }
  function follow() {
    const el = sort && cardEls[sort.v];
    if (!el || !cardsEl || !press || !sort) return;
    const cr = cardsEl.getBoundingClientRect();
    // 横向保持按下时的相对位置（换列后卡片宽度变了也不跑偏），纵向保持抓住的那一点
    const wantL = press.px - press.fx * el.offsetWidth;
    const wantT = press.py - press.gy;
    sort.tx = Math.round(wantL - (cr.left + el.offsetLeft));
    sort.ty = Math.round(wantT - (cr.top + el.offsetTop));
  }
  async function headMove(e: { pointerId: number; clientX: number; clientY: number }) {
    const p = press;
    if (!p || p.dead || e.pointerId !== p.pid) return;
    if (!sort) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
      beginSort();
      if (!sort) return;
    }
    p.px = e.clientX;
    p.py = e.clientY;
    const s = sort;
    const r = cardsEl!.getBoundingClientRect();
    const fx = (e.clientX - r.left) / (r.width || 1);
    const fy = (e.clientY - r.top) / (r.height || 1);
    const o = { start: s.start, v: s.v, n0: s.n0, split: s.split, canTwo: twoOk, shown };
    let tg = target(o, fx, fy);
    if (tg.split && !s.split) {
      // 刚进拆列带：先按不拆算，停够了（指针不动也算——定时器补一次）再拆
      if (!p.bandAt) {
        p.bandAt = performance.now();
        clearTimeout(p.bandT);
        p.bandT = window.setTimeout(() => {
          if (press === p && sort) void headMove({ pointerId: p.pid, clientX: p.px, clientY: p.py });
        }, SPLIT_DWELL + 10);
      }
      if (performance.now() - p.bandAt < SPLIT_DWELL) tg = target(o, fx, fy, false);
    } else if (!tg.split) {
      p.bandAt = 0;
      clearTimeout(p.bandT);
    }
    if (tg.n !== s.n || !sameCols(tg.cols, s.cols)) {
      const before = rects(s.v);
      s.n = tg.n;
      s.split = tg.split;
      s.cols = tg.cols;
      await tick();
      if (sort !== s) return;
      flip(before, SPRING_SNAP);
    }
    follow();
  }
  function endPress() {
    const p = press;
    press = null;
    if (!p) return null;
    clearTimeout(p.bandT);
    try {
      p.head.releasePointerCapture(p.pid);
    } catch {
      /* 已经释放 */
    }
    return p;
  }
  function headUp(e: PointerEvent) {
    if (!press || e.pointerId !== press.pid) return;
    endPress();
    const s = sort;
    if (!s) return; // 没过门槛 = 普通点击
    if (!sameCols(s.cols, s.start)) {
      const colOf = (c: Cols) => (c.a.includes(s.v) ? "a" : "b");
      // 换了列：它原先的高度比例是给那一列配的，回到等分
      if (colOf(s.cols) !== colOf(s.start) && dockCards.weights[s.v] != null) {
        const w = { ...dockCards.weights };
        delete w[s.v];
        setDockWeights(w);
      }
      setDockCols(s.cols);
    }
    sort = null;
    freeNative(s.v, SPRING_SOFT.ms + 60);
  }
  // 取消（pointercancel / 丢了捕获 / Esc）：原样复原
  function headCancel(e?: PointerEvent) {
    if (!press || (e && e.pointerId !== press.pid)) return;
    endPress();
    const s = sort;
    if (!s) return;
    sort = null;
    freeNative(s.v, SPRING_SOFT.ms + 60);
  }
  $effect(() => {
    if (!sort) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      headCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  // 双击标题行 = 放大 / 还原（同窗口标题栏的习惯）
  function headDbl(e: MouseEvent, v: DockTool) {
    if ((e.target as Element).closest("button")) return;
    toggleDockMax(v);
  }

  // ── 卡与卡之间的缝：拖了调上下两张的高度比，双击这一列回到等分 ──
  const MIN_CARD_H = 120;
  let resizing = $state("");
  function seamDown(e: PointerEvent, d: Divider) {
    if (e.button !== 0 || !cardsEl) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const col = list.find((c) => c.includes(d.up));
    if (!col) return;
    const w0 = { ...dockCards.weights };
    const total = col.reduce((s, v) => s + weightOf(w0, v), 0);
    const avail = cardsEl.clientHeight - GAP * (col.length - 1);
    const wu = weightOf(w0, d.up);
    const wd = weightOf(w0, d.down);
    const y0 = e.clientY;
    const pid = e.pointerId;
    try {
      el.setPointerCapture(pid);
    } catch {
      /* 指针已经没了 */
    }
    resizing = d.key;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pid) return;
      const [u, dn] = resizePair(wu, wd, total, avail, ev.clientY - y0, MIN_CARD_H);
      dockCards.weights = { ...w0, [d.up]: u, [d.down]: dn };
    };
    const up = () => {
      if (!resizing) return;
      resizing = "";
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("lostpointercapture", up);
      setDockWeights(dockCards.weights);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("lostpointercapture", up);
  }
  function seamReset(d: Divider) {
    const col = list.find((c) => c.includes(d.up)) ?? [];
    const w = { ...dockCards.weights };
    for (const v of col) delete w[v];
    setDockWeights(w);
  }

  // 卡片进退场：浮起 / 退隐；桌面壳里只淡（原生浏览器视图不能跟着一个在位移的祖先落座）
  function cardIn(node: Element) {
    if (nativeShellBrowser) return fade(node, { duration: 180 }, { direction: "in" });
    return rise(node, { y: 10, scale: 0.985 }, { direction: "in" });
  }
  function cardOut(node: Element) {
    if (nativeShellBrowser) return fade(node, { duration: 160 }, { direction: "out" });
    return rise(node, { y: 6, scale: 0.98, out: 160 }, { direction: "out" });
  }

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

{#snippet panel(tool: DockTool)}
  {#if tool === "tasks"}
    <!-- 任务视图的数据 = 前台会话时间线，工作空间还没就绪也照常给 -->
    <TasksPanel />
  {:else if !ws}
    <div class="wait">
      <Mark size={20} live />
      <p>{t("工作空间加载中…")}</p>
    </div>
  {:else}
    {#key ws}
      {#if tool === "review"}
        <ReviewPanel {ws} {chatId} />
      {:else if tool === "term" && termOn}
        <TermPanel {ws} {chatId} />
      {:else if tool === "browser" && browserOn}
        <BrowserPane />
      {:else if tool === "memory" && memoryView}
        <div class="fembed">{@render memoryView({ ws })}</div>
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

{#if docked}
  <aside class="dock" class:sorting={!!sort} class:resizing={!!resizing} bind:this={dockEl} aria-label={t("工作区")}>
    <div class="band">
      <DockToggles tools={TOOLS} on={shown} {live} ontoggle={(k) => (haptic("light"), toggleDockCard(k))} />
      <IconButton icon="panelR" label={t("收起工作区")} size={32} onclick={closeDock} />
    </div>
    <div class="cards" bind:this={cardsEl}>
      {#if emptyBox}<div class="slot empty" style={emptyBox}></div>{/if}
      {#if slotBox}<div class="slot" style={slotBox}></div>{/if}
      {#each cards as c (c.v)}
        {@const meta = metaOf(c.v)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section
          class="card"
          class:hid={!c.box}
          class:lifted={sort?.v === c.v}
          class:landing={landing === c.v}
          style={c.box}
          aria-label={meta.label}
          use:cardRef={c.v}
          onpointerdowncapture={() => noteDockFocus(c.v)}
          in:cardIn
          out:cardOut
        >
          <!-- 标题行 = 拖拽把手：拖动排顺序 / 换列；双击放大 / 还原 -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <header
            class="head"
            class:grab={fine && shown.length > 1 && !maxed}
            onpointerdown={(e) => headDown(e, c.v)}
            onpointermove={headMove}
            onpointerup={headUp}
            onpointercancel={headCancel}
            onlostpointercapture={headCancel}
            ondblclick={(e) => headDbl(e, c.v)}
          >
            <span class="h-ic"><Icon name={meta.icon} size={15} stroke={1.7} /></span>
            <span class="h-t">{meta.label}</span>
            {#if hot(c.v)}<span class="h-dot" title={t("正在进行")} aria-hidden="true"></span>{/if}
            <span class="h-sp"></span>
            <IconButton
              icon={maxed === c.v ? "minimize" : "maximize"}
              label={maxed === c.v ? t("还原") : t("放大")}
              title={maxed === c.v ? t("还原") : t("放大铺满工作区")}
              size={28}
              iconSize={14}
              onclick={() => (haptic("light"), toggleDockMax(c.v))}
            />
            <IconButton
              icon="close"
              label={t("关闭{name}", { name: meta.label })}
              title={t("关闭")}
              size={28}
              iconSize={15}
              onclick={() => closeCard(c.v)}
            />
          </header>
          <div class="cbody">{@render panel(c.v)}</div>
          <span class="ring" aria-hidden="true" use:ringRef={c.v}></span>
        </section>
      {/each}
      {#each seams as d (d.key)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="seam"
          class:on={resizing === d.key}
          style={d.css}
          title={t("拖拽调整上下两张的高度（双击等分）")}
          onpointerdown={(e) => seamDown(e, d)}
          ondblclick={() => seamReset(d)}
        ></div>
      {/each}
    </div>
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
      <div class="body" id="{uid}-panel" role="tabpanel" aria-labelledby="{uid}-tab-{app.dockTool}">
        {#key app.dockTool}
          <div class="pane">{@render panel(app.dockTool)}</div>
        {/key}
      </div>
    </div>
  </div>
{/if}

<style>
  /* ── 宽屏：右侧一栏，一叠卡片 ── */
  .dock {
    height: 100%;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    padding-top: var(--sat, 0px);
    padding-bottom: var(--sab, 0px);
  }
  :global(html[data-wco="1"]) .dock {
    padding-top: var(--wco-h, 40px);
  }
  .dock > .band,
  .dock > .cards {
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

  /* 卡片区：卡片绝对定位按比例摆（位置由脚本给成 calc 百分比），外沿与卡间缝都是 8px */
  .cards {
    --hx-pane-r: 0px;
    position: relative;
    flex: 1;
    min-height: 0;
    margin: 0 8px 8px;
    animation: dk-in 200ms var(--ease-out) both;
  }
  /* 卡片 = 浮起的面：更白的纸 + 一圈细线 + 上沿一道高光 + 暖墨投影。
     卡里这一层的纸就是卡片色：--bg 换成 --surface（面板里的吸顶条、渐隐带、小点描边都画在卡片上），
     「在这张纸上再浮起一层」的面（浏览器当前标签）退回页面底色 */
  .card {
    --bg: var(--surface);
    --dk-bg: var(--surface);
    --dk-card: var(--rail);
    position: absolute;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 14px;
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--border),
      inset 0 1px 0 var(--sheen),
      var(--shadow-1);
    transition: box-shadow var(--t-med) var(--ease);
  }
  .card.hid {
    display: none;
  }
  /* 拿起：浮在最上、投影加深、微微放大，跟着指针走（inline transform 每帧改，不加过渡） */
  .card.landing {
    z-index: 5;
  }
  .card.lifted {
    z-index: 6;
    box-shadow:
      0 0 0 1px var(--border2),
      inset 0 1px 0 var(--sheen),
      var(--shadow-3);
  }

  .head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 38px;
    padding: 0 5px 0 12px;
    color: var(--text2);
    touch-action: none;
    user-select: none;
    -webkit-app-region: no-drag;
  }
  .head.grab {
    cursor: grab;
  }
  .dock.sorting,
  .dock.sorting .head {
    cursor: grabbing;
  }
  .h-ic {
    flex: none;
    display: inline-flex;
    color: var(--text3);
  }
  .h-t {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-md);
    font-weight: 500;
    color: var(--text);
  }
  .h-dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--live);
    animation: hx-breathe 2s var(--ease-in-out) infinite;
  }
  .h-sp {
    flex: 1;
  }
  /* 标题行与面板之间一根细线：卡片头是卡片的，面板头是面板的 */
  .cbody {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border);
  }
  /* 被点名时描一圈墨（脚本只动它的透明度） */
  .ring {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1.5px var(--accent);
    opacity: 0;
    pointer-events: none;
  }

  /* 拖动中的落点：一圈虚线框，随排布滑到新格子；拖空的那一列描得更淡 */
  .slot {
    position: absolute;
    border-radius: 14px;
    pointer-events: none;
    border: 1.5px dashed color-mix(in srgb, var(--text) 22%, transparent);
    background: color-mix(in srgb, var(--text) 3%, transparent);
    animation: dk-in 160ms var(--ease-out) both;
  }
  .slot.empty {
    border-color: color-mix(in srgb, var(--text) 12%, transparent);
    background: none;
  }
  /* 拖动 / 调高度期间：iframe 不吃指针（捕获之外再兜一层），不选字 */
  .dock.sorting :global(iframe),
  .dock.resizing :global(iframe) {
    pointer-events: none;
  }
  .dock.sorting,
  .dock.resizing {
    user-select: none;
  }
  .dock.resizing {
    cursor: row-resize;
  }

  /* 卡间缝：8px 全是命中区，悬停 / 拖动时中间亮出一截短横线 */
  .seam {
    position: absolute;
    z-index: 3;
    cursor: row-resize;
    touch-action: none;
    -webkit-app-region: no-drag;
  }
  .seam::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 36px;
    height: 3px;
    margin: -1.5px 0 0 -18px;
    border-radius: 2px;
    background: var(--border2);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .seam:hover::after {
      opacity: 1;
    }
  }
  .seam.on::after {
    opacity: 1;
    background: var(--text3);
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
    box-shadow:
      0 0 0 1px var(--border),
      inset 0 1px 0 var(--sheen),
      var(--shadow-3);
    overflow: hidden;
    /* dragClose 松手回弹走这条过渡 */
    transition: transform var(--t-spring-soft, 420ms) var(--spring-soft, var(--ease-out));
  }
  .sheet > .grip-zone,
  .sheet > .body {
    --sat: 0px;
    --sab: 0px;
    --wco-right: 0px;
  }
  .grip-zone {
    flex: none;
    touch-action: none;
    padding-top: 7px;
    box-shadow: inset 0 -1px 0 var(--border);
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

  @media (prefers-reduced-motion: reduce) {
    .cards,
    .pane,
    .slot {
      animation-duration: 1ms;
    }
    .h-dot {
      animation: none;
    }
  }
</style>
