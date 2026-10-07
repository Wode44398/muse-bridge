<script lang="ts">
  // 应用壳：侧栏 | 对话 | 工作区 三栏（≥700px），手机单栏 + 抽屉 + 底部工作区；浮层路由、灯箱、提示、返回键链。
  //
  // 布局门槛：700 = 分栏（折叠屏展开约 752px 也算宽）；1100 = 真宽，侧栏与工作区可以并存。
  // 700–1099 开着工作区时侧栏临时收起（不改用户的「侧栏展开」偏好），这时点侧栏钮 = 以抽屉形式临时拉出来。
  // 分屏（多会话）：把侧栏的会话块拖进正文区的左 / 右半边 = 两格并排（正文区够宽才行）；每一格见 ChatPane。
  import { onMount, untrack } from "svelte";
  import {
    app,
    boot,
    closeDock,
    closePane,
    handleDockShortcut,
    openInSplit,
    openSession,
    setHostPickWorkspace,
    suspendLiveStreams,
    type ArtifactItem,
  } from "./lib/state.svelte.ts";
  import { setThemeRoot } from "./lib/theme.ts";
  import { closeTopLayer, pushLayer } from "./lib/layers.ts";
  import { setArtifactHost } from "./lib/open-artifact.ts";
  import { fade, pop } from "./lib/motion.ts";
  import { edgeSwipe, haptic } from "./lib/touch.ts";
  import Icon from "./components/ui/Icon.svelte";
  import Sidebar from "./components/shell/Sidebar.svelte";
  import ChatPane from "./components/shell/ChatPane.svelte";
  import VendorSheet from "./components/shell/VendorSheet.svelte";
  import ProjectDialog from "./components/shell/ProjectDialog.svelte";
  import SetupSheet from "./components/shell/SetupSheet.svelte";
  import AttachSheet from "./components/composer/AttachSheet.svelte";
  import SettingsSheet from "./components/sheets/SettingsSheet.svelte";
  import CheckpointsSheet from "./components/sheets/CheckpointsSheet.svelte";
  import MemorySheet from "./components/sheets/MemorySheet.svelte";
  import Dock from "./components/dock/Dock.svelte";
  import DragLayer from "./components/shell/DragLayer.svelte";
  import { dnd, dropTarget, type DragPayload, type DropPoint } from "./lib/dnd.svelte.ts";
  import { splitDropLabel, splitDropPlan, type Side } from "./lib/split.ts";
  import { t, tr } from "./lib/i18n.ts";

  // ── 宿主契约（bridge 的 HarnessPage 传进来；独立运行时全是默认值）──────────────────────────
  // embedded：作为 bridge 分页运行（主题作用域在本组件根、连接 / 系统栏归宿主、侧栏里有「主页」）
  // filesView：宿主注入的工作区「文件」视图 snippet（透传给 Dock）
  // pickWorkspace：宿主接管「选一个文件夹当工作空间」（返回绝对路径，空串 = 取消）
  // chatDrop：宿主的「把工作空间里的文件投给这个对话」落点 action，只挂在正文列 .main 上——
  //           这个节点的 class 只许静态写 + class: 指令（宿主会往上加 hx-dnd-on，动态 class={…} 会把它冲掉）
  // sidebarFoot：宿主往侧栏底部（设置按钮上方，整宽、不加任何外框）放的内容；不给就什么都不多
  let {
    embedded = false,
    onExit = null,
    sidebarFoot = null,
    onOpenArtifact = null,
    filesView = null,
    pickWorkspace = null,
    chatDrop = null,
    openSettings = null,
  }: {
    embedded?: boolean;
    onExit?: (() => void) | null;
    sidebarFoot?: import("svelte").Snippet | null;
    onOpenArtifact?: ((artifact: ArtifactItem, sessionId: string) => void) | null;
    filesView?: import("svelte").Snippet<
      [{ ws: string; chatId: string; onExit: () => void; target: null | { seq: number; rel: string; open: string } }]
    > | null;
    pickWorkspace?: null | (() => Promise<string>);
    chatDrop?: null | ((node: HTMLElement) => { destroy?: () => void } | void);
    // 宿主接管「设置」：嵌进 Muse Bridge 时只有一个设置页（宿主的），dimensio 的设置是其中一节。
    // 给了它，任何地方把 app.sheet 置成 "settings"（侧栏、Hero 提示、记忆面板的「‹ 设置」）都转给宿主，自己的设置面板不出。
    openSettings?: null | (() => void);
  } = $props();
  $effect(() => {
    if (app.sheet !== "settings" || !openSettings) return;
    untrack(() => {
      app.sheet = null;
      openSettings?.();
    });
  });
  const chatDropAction = (node: HTMLElement) => chatDrop?.(node) ?? undefined;

  // Q13：宿主的「打开产物」回调登记成全局的（诊断包导出这类 Feed 之外的地方也要交给宿主查看器）
  $effect(() => setArtifactHost(onOpenArtifact));
  // 产物卡：有宿主文件视图就进右侧工作区读，没有（独立 8799）才回落查看器 / 新窗口
  $effect(() => {
    app.hasFilesView = !!filesView;
  });
  $effect(() => {
    setHostPickWorkspace(pickWorkspace);
    return () => setHostPickWorkspace(null);
  });

  // ── 布局 ────────────────────────────────────────────────────────────────────────────
  const mqWide = matchMedia("(min-width: 700px)");
  const mqRoomy = matchMedia("(min-width: 1100px)");
  let wide = $state(mqWide.matches);
  let roomy = $state(mqRoomy.matches);
  let railOpen = $state(localStorage.getItem("harness.rail") !== "0");
  let peek = $state(false); // 700–1099 + 工作区开着时，侧栏以抽屉形式临时拉出

  const dockCol = $derived(wide && app.dockOpen);
  // 侧栏真正摊开：偏好是开 + 放得下（真宽，或者工作区没开）
  const railShown = $derived(wide && railOpen && (roomy || !app.dockOpen));
  // 抽屉：手机的侧栏；或者宽屏里侧栏被工作区挤掉时的临时拉出
  const drawerOpen = $derived((!wide && app.drawer) || (wide && peek && !railShown));

  function toggleRail() {
    haptic("light");
    if (!wide) {
      app.drawer = !app.drawer;
      return;
    }
    if (railOpen && !railShown) {
      // 偏好是开，只是被工作区挤掉了：临时拉出，不改偏好
      peek = !peek;
      return;
    }
    railOpen = !railOpen;
    peek = false;
    localStorage.setItem("harness.rail", railOpen ? "1" : "0");
  }
  function closeDrawer() {
    app.drawer = false;
    peek = false;
  }
  // 选了会话 / 开了新对话，服务端动作会把 app.drawer 置 false；临时拉出的侧栏也跟着收
  $effect(() => {
    void app.chat;
    peek = false;
  });

  // ── 分栏占比：交界处拖拽调宽，双击复位；比例持久化（拖拽与恢复用同一套边界）─────────────────
  const RATIO_MIN = 0.26;
  const RATIO_MAX = 0.72;
  const clampRatio = (r: number) => Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
  let paneRatio = $state(clampRatio(Number(localStorage.getItem("harness.paneRatio")) || 0.44));
  let splitting = $state(false);
  function splitDown(e: PointerEvent) {
    const bar = e.currentTarget as HTMLElement;
    const shell = bar.parentElement as HTMLElement;
    const rect = shell.getBoundingClientRect();
    bar.setPointerCapture(e.pointerId);
    splitting = true;
    const move = (ev: PointerEvent) => {
      const px = Math.max(340, rect.right - ev.clientX);
      paneRatio = clampRatio(px / rect.width);
    };
    const up = () => {
      splitting = false;
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      localStorage.setItem("harness.paneRatio", String(paneRatio));
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  }
  function splitReset() {
    paneRatio = 0.44;
    localStorage.removeItem("harness.paneRatio");
  }

  // ── 抽屉：一个显式的位置状态机（x = 抽屉的 translateX，-宽 = 收起，0 = 摊开）──────────────
  // 左缘右滑跟手拉出、抽屉里左滑跟手收回；松手（或点遮罩 / 返回键）都从【当前位置】用弹簧走到终点，
  // 不回跳、不重播入场。收到底之后才卸载。
  const DRAWER_W = 300;
  let drawerEl: HTMLDivElement | undefined = $state();
  let drawerMounted = $state(false);
  let drawerX = $state(-DRAWER_W);
  let drawerMode = $state<"none" | "open" | "close">("none"); // 过渡曲线：跟手时无过渡
  let edgeDragging = $state(false);
  const drawerW = () => drawerEl?.offsetWidth || DRAWER_W;

  function showDrawer() {
    if (!drawerMounted) {
      drawerMounted = true;
      drawerMode = "none";
      drawerX = -DRAWER_W;
      // 先以收起位置挂上，下一帧再走（否则没有起点，直接出现）
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          drawerMode = "open";
          drawerX = 0;
        }),
      );
      return;
    }
    drawerMode = "open";
    drawerX = 0;
  }
  function hideDrawer() {
    if (!drawerMounted) return;
    drawerMode = "close";
    drawerX = -drawerW();
  }
  $effect(() => {
    const want = drawerOpen;
    untrack(() => (want ? showDrawer() : hideDrawer()));
  });
  function onDrawerEnd(e: TransitionEvent) {
    if (e.target !== drawerEl || e.propertyName !== "transform") return;
    if (!drawerOpen && !edgeDragging && drawerX <= -drawerW() + 1) drawerMounted = false;
  }
  const drawerScrim = $derived(Math.max(0, Math.min(1, 1 + drawerX / DRAWER_W)));

  // 抽屉里往左拖 = 跟手收回
  function drawerDrag(node: HTMLElement) {
    let pid = -1;
    let x0 = 0;
    let y0 = 0;
    let dx = 0;
    let decided = false;
    let active = false;
    let lastX = 0;
    let lastT = 0;
    let vel = 0;
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      pid = e.pointerId;
      x0 = lastX = e.clientX;
      y0 = e.clientY;
      lastT = e.timeStamp;
      dx = 0;
      decided = false;
      active = true;
    };
    const move = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (!decided) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        if (Math.abs(my) > Math.abs(mx) || mx > 0) {
          active = false;
          return;
        }
        decided = true;
        node.setPointerCapture?.(pid);
      }
      const dt = Math.max(1, e.timeStamp - lastT);
      vel = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = e.timeStamp;
      dx = Math.min(0, mx);
      drawerMode = "none";
      drawerX = dx;
      e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      active = false;
      if (!decided) return;
      if (-dx > drawerW() * 0.35 || vel < -0.45) {
        closeDrawer(); // 从当前位置接着往左走完
        if (!drawerOpen) hideDrawer();
      } else {
        drawerMode = "open";
        drawerX = 0;
      }
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    return {
      destroy() {
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
      },
    };
  }

  // 抽屉在就登记一层（返回键 / Esc 收它）
  $effect(() => {
    if (!drawerOpen) return;
    return pushLayer(closeDrawer, { native: true });
  });

  // ── 分屏（多会话）───────────────────────────────────────────────────────────────────
  // 正文区够宽（两格各 ≥ 380）才分屏；不够宽时（窗口拉窄、开着工作区）只显示有焦点的那一格，宽回来两格又并排。
  const SPLIT_MIN = 760;
  let mainEl: HTMLDivElement | undefined = $state();
  let mainW = $state(0);
  $effect(() => {
    const el = mainEl;
    if (!el) return;
    const ro = new ResizeObserver(() => (mainW = el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const splitRoom = $derived(wide && mainW >= SPLIT_MIN);
  const splitShown = $derived(splitRoom && app.panes.length === 2);
  const shownPanes = $derived(splitShown ? app.panes : [app.chat]);

  // 两格的占比：中缝拖拽调宽，双击复位；持久化
  const clampSplit = (r: number) => Math.min(0.7, Math.max(0.3, r));
  let splitRatio = $state(clampSplit(Number(localStorage.getItem("harness.splitRatio")) || 0.5));
  let seaming = $state(false);
  function seamDown(e: PointerEvent) {
    const bar = e.currentTarget as HTMLElement;
    const rect = mainEl?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault(); // 按住中缝拖的时候别顺手选中两格里的字
    bar.setPointerCapture(e.pointerId);
    seaming = true;
    const move = (ev: PointerEvent) => {
      splitRatio = clampSplit((ev.clientX - rect.left) / rect.width);
    };
    const up = () => {
      seaming = false;
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      localStorage.setItem("harness.splitRatio", String(splitRatio));
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  }
  function seamReset() {
    splitRatio = 0.5;
    localStorage.removeItem("harness.splitRatio");
  }

  // 把会话块拖进正文区：没分屏 = 放到左 / 右半边就与当前对话并排（当前是空白新对话 = 直接打开）；分屏中 = 换掉落点那一格
  // （拖的正是另一格的会话 = 两格对调）。落在输入框上归输入框（引用），那是更里层的落点。
  const blankNow = () => !app.chat.id && !app.chat.running && app.chat.timeline.length === 0;
  function sideAt(pt: DropPoint): Side {
    const r = mainEl?.getBoundingClientRect();
    if (!r) return 1;
    const cut = r.left + r.width * (splitShown ? splitRatio : 0.5);
    return pt.x < cut ? 0 : 1;
  }
  const planFor = (p: DragPayload, pt: DropPoint) =>
    splitDropPlan({
      split: splitShown,
      blank: blankNow(),
      currentId: app.chat.id,
      paneIds: app.panes.map((c) => c.id),
      draggedId: p.id,
      side: sideAt(pt),
    });
  let splitOver = $state<Side | "all" | null>(null);
  const splitDrop = $derived({
    key: (p: DragPayload, pt: DropPoint) => {
      const plan = planFor(p, pt);
      return "side" in plan ? `split:${plan.kind}:${plan.side}` : `split:${plan.kind}`;
    },
    // 「就是当前对话」「已经在这一格」不接：不高亮，松手飞回原位
    accept: (p: DragPayload, pt: DropPoint) => p.kind === "session" && splitRoom && planFor(p, pt).kind !== "none",
    label: (p: DragPayload, pt: DropPoint) => splitDropLabel(planFor(p, pt)),
    over: (p: DragPayload, pt: DropPoint) => {
      const plan = planFor(p, pt);
      splitOver = plan.kind === "open" ? "all" : "side" in plan ? plan.side : null;
    },
    leave: () => (splitOver = null),
    drop: (p: DragPayload, pt: DropPoint) => {
      splitOver = null;
      const plan = planFor(p, pt);
      if (plan.kind === "open") void openSession(p.id);
      else if (plan.kind === "swap") app.panes = [app.panes[1], app.panes[0]]; // 对调；焦点跟着那个会话走
      else if (plan.kind === "split" || plan.kind === "replace") void openInSplit(p.id, plan.side);
    },
  });
  // 落点高亮盖住哪一块（百分比，跟着中缝）
  const overBox = $derived.by(() => {
    if (splitOver === null || !dnd.on) return null;
    if (splitOver === "all") return { left: 0, width: 100 };
    const cut = (splitShown ? splitRatio : 0.5) * 100;
    return splitOver === 0 ? { left: 0, width: cut } : { left: cut, width: 100 - cut };
  });

  // ── 灯箱 ──────────────────────────────────────────────────────────────────────────────
  $effect(() => {
    if (!app.lightbox) return;
    return pushLayer(() => (app.lightbox = null));
  });

  // ── 启动：主题根就位后再 boot（每次进页都会重挂 App；模块状态跨访问保留）──────────────────
  let rootEl: HTMLElement | undefined = $state();
  let booted = false;
  $effect(() => {
    if (!rootEl || booted) return;
    booted = true;
    setThemeRoot(rootEl);
    boot();
  });

  onMount(() => {
    const onWide = (e: MediaQueryListEvent) => (wide = e.matches);
    const onRoomy = (e: MediaQueryListEvent) => (roomy = e.matches);
    mqWide.addEventListener("change", onWide);
    mqRoomy.addEventListener("change", onRoomy);
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented) handleDockShortcut(e);
    };
    window.addEventListener("keydown", onKey);

    // 安卓返回键 / bridge 返回链：先关最上面的浮层（菜单、sheet、灯箱、抽屉……都在浮层栈里），
    // 再关手机的工作区，最后嵌入态回 bridge 主页；全关完返回 false 让壳退后台。
    const back = () => {
      if (closeTopLayer()) return true;
      if (app.projectModal) {
        app.projectModal = false;
        return true;
      }
      if (app.sheet && app.sheet !== "setup") {
        app.sheet = null;
        return true;
      }
      if (app.vendorMenu) {
        app.vendorMenu = false;
        return true;
      }
      if (!wide && app.dockOpen) {
        closeDock();
        return true;
      }
      if (drawerOpen) {
        closeDrawer();
        return true;
      }
      if (embedded && onExit) {
        onExit();
        return true;
      }
      return false;
    };
    (window as any).__harnessBack = back;
    return () => {
      mqWide.removeEventListener("change", onWide);
      mqRoomy.removeEventListener("change", onRoomy);
      window.removeEventListener("keydown", onKey);
      if ((window as any).__harnessBack === back) delete (window as any).__harnessBack;
      // #93：离开 dimensio 页——运行流收掉（服务端照跑），下次进页 boot 时接回
      if (embedded) suspendLiveStreams();
    };
  });
</script>

<!-- hxroot：主题根（令牌 / data-mode 挂这里；display:contents 不产生盒子，但照常参与继承——
     渲染在 .shell 之外的浮层从这里拿字色与字体）。 -->
<div class="hxroot" bind:this={rootEl}>
  <div class="shell" class:wide class:embedded class:docked={dockCol} class:splitting>
    {#if wide}
      <aside class="rail" class:shown={railShown} aria-hidden={!railShown}>
        <div class="rail-in">
          <Sidebar docked onToggle={toggleRail} onHome={embedded ? onExit : null} {sidebarFoot} />
        </div>
      </aside>
    {/if}

    <div
      class="main"
      class:split={splitShown}
      class:seaming
      bind:this={mainEl}
      use:chatDropAction
      use:dropTarget={splitDrop}
      use:edgeSwipe={{
        width: DRAWER_W,
        onProgress: (px) => {
          if (wide || app.drawer) return;
          edgeDragging = true;
          drawerMounted = true;
          drawerMode = "none";
          drawerX = Math.min(0, px - DRAWER_W);
        },
        onEnd: (open) => {
          if (wide || !edgeDragging) return;
          edgeDragging = false;
          if (open) {
            app.drawer = true;
            showDrawer();
          } else hideDrawer();
        },
      }}
    >
      {#each shownPanes as chat, i (i)}
        {#if i === 1}
          <div
            class="seam"
            role="separator"
            aria-orientation="vertical"
            title={t("拖拽调整两格的宽度（双击复位）")}
            onpointerdown={seamDown}
            ondblclick={seamReset}
          ></div>
        {/if}
        <div class="pane-slot" class:lead={splitShown && i === 0} style={splitShown && i === 0 ? `flex:0 0 ${splitRatio * 100}%` : undefined}>
          <ChatPane
            {chat}
            index={i}
            split={splitShown}
            focused={chat === app.chat}
            {wide}
            onMenu={toggleRail}
            menuVisible={!railShown && i === 0}
            showDock={!splitShown || i === 1}
            onclose={splitShown ? () => closePane(chat) : null}
            {onOpenArtifact}
          />
        </div>
      {/each}
      {#if overBox}
        <div class="split-over" style="left:{overBox.left}%;width:{overBox.width}%" aria-hidden="true" transition:fade={{ duration: 120 }}></div>
      {/if}
    </div>

    {#if dockCol}
      <div
        class="splitter"
        role="separator"
        aria-orientation="vertical"
        title={t("拖拽调整左右占比（双击复位）")}
        onpointerdown={splitDown}
        ondblclick={splitReset}
      ></div>
      <div class="pv-col" style="width:{paneRatio * 100}%">
        <Dock docked {filesView} />
      </div>
    {/if}
  </div>

  <!-- 抽屉（手机侧栏 / 宽屏临时拉出）：位置由 drawerX 驱动，见上面的状态机 -->
  {#if drawerMounted}
    <div class="drawer-layer" class:peek={wide}>
      <button class="scrim {drawerMode}" aria-label={t("关闭侧栏")} tabindex="-1" style="opacity:{drawerScrim}" onclick={closeDrawer}></button>
      <div
        class="drawer {drawerMode}"
        bind:this={drawerEl}
        style="transform:translateX({drawerX}px)"
        use:drawerDrag
        ontransitionend={onDrawerEnd}
      >
        <Sidebar onClose={closeDrawer} onHome={embedded ? onExit : null} {sidebarFoot} />
      </div>
    </div>
  {/if}

  <!-- 手机：工作区是整屏的底部层 -->
  {#if !wide && app.dockOpen}
    <Dock {filesView} />
  {/if}

  {#if app.vendorMenu}
    <VendorSheet onclose={() => (app.vendorMenu = false)} />
  {/if}
  {#if app.projectModal}
    <ProjectDialog onclose={() => (app.projectModal = false)} />
  {/if}

  {#if app.sheet === "settings" && !openSettings}
    <SettingsSheet onclose={() => (app.sheet = null)} />
  {:else if app.sheet === "attach"}
    <AttachSheet onclose={() => (app.sheet = null)} />
  {:else if app.sheet === "checkpoints"}
    <CheckpointsSheet onclose={() => (app.sheet = null)} />
  {:else if app.sheet === "memory"}
    <MemorySheet onclose={() => (app.sheet = null)} />
  {:else if app.sheet === "setup"}
    <SetupSheet />
  {/if}

  <!-- 灯箱：点图或关闭钮关；Esc / 返回键经浮层栈 -->
  {#if app.lightbox}
    <div class="lightbox" role="dialog" aria-modal="true" aria-label={t("查看大图")} transition:fade={{ duration: 200 }}>
      <button class="lb-body" aria-label={t("关闭大图")} onclick={() => (app.lightbox = null)}>
        <img src={app.lightbox.src} alt={app.lightbox.caption ?? t("大图")} in:pop={{ from: 0.96 }} />
      </button>
      <button class="lb-close" aria-label={t("关闭")} onclick={() => (app.lightbox = null)}>
        <Icon name="close" size={20} />
      </button>
      {#if app.lightbox.caption}
        <div class="lb-cap">{app.lightbox.caption}</div>
      {/if}
    </div>
  {/if}

  <!-- 拿起 — 放下：跟手的那张卡（侧栏里拖项目块 / 会话） -->
  <DragLayer />

  <!-- 提示：顶部居中；带动作的停 8 秒。动作按钮先取出动作再收提示（收掉之后再读就是 null）。 -->
  {#if app.toast}
    {#key app.toast}
      <div class="toast" class:has-act={app.toastAction} role="status" in:pop={{ from: 0.9 }} out:fade={{ duration: 160 }}>
        <span class="toast-msg">{tr(app.toast)}</span>
        {#if app.toastAction}
          <button
            class="toast-act"
            onclick={() => {
              const act = app.toastAction;
              app.toast = "";
              app.toastAction = null;
              act?.run();
            }}>{tr(app.toastAction.label)}</button
          >
        {/if}
      </div>
    {/key}
  {/if}
</div>

<style>
  .hxroot {
    display: contents;
    color: var(--text);
    font-family: var(--font-ui);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    /* 顶栏带：侧栏头、对话顶栏、工作区面板头共用一个高度，控件中心落在同一条线上（对齐桌面壳窗控）。 */
    --hx-band: 44px;
  }
  .shell {
    /* 桌面壳（WCO）右上角被系统窗控占着：只有真贴着窗口右缘的那一栏让位。非桌面壳两者恒 0。 */
    --hx-hdr-r: var(--wco-right, 0px);
    --hx-pane-r: 0px;
    position: relative;
    display: flex;
    height: 100dvh;
    overflow: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: var(--fs-body);
    line-height: var(--lh-ui);
  }
  .shell.docked {
    --hx-hdr-r: 0px;
  }
  .shell.embedded {
    position: fixed;
    inset: 0;
    z-index: 30;
  }
  .shell.splitting {
    cursor: col-resize;
    user-select: none;
  }

  /* 侧栏：摊开 = 272px，收起 = 0（内层定宽，收展时是裁切滑出，不逐帧重排） */
  .rail {
    position: relative;
    z-index: 1;
    flex: none;
    width: 0;
    overflow: hidden;
    background: var(--rail);
    box-shadow: inset -1px 0 0 var(--border);
    transition: width 360ms var(--ease-out);
  }
  .rail.shown {
    width: 272px;
  }
  .rail-in {
    width: 272px;
    height: 100%;
    transform: translateX(-12px);
    opacity: 0;
    transition:
      transform 360ms var(--ease-out),
      opacity 240ms var(--ease);
  }
  .rail.shown .rail-in {
    transform: none;
    opacity: 1;
  }

  .main {
    position: relative;
    z-index: 1;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: row;
    height: 100%;
  }
  .main.seaming {
    cursor: col-resize;
    user-select: none;
  }
  .pane-slot {
    position: relative;
    flex: 1 1 0;
    min-width: 0;
    display: flex;
  }
  /* 左格不贴窗口右缘：桌面壳的窗控让位只归右格 */
  .pane-slot.lead {
    --hx-hdr-r: 0px;
  }
  /* 两格之间的中缝：一根细线；6px 透明热区可拖，悬停 / 拖动时线加粗成墨色（与工作区分栏手柄同一套） */
  .seam {
    position: relative;
    z-index: 3;
    flex: none;
    width: 6px;
    margin: 0 -3px;
    cursor: col-resize;
    touch-action: none;
    -webkit-app-region: no-drag;
  }
  .seam::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2.5px;
    width: 1px;
    background: var(--border);
    transition:
      background-color var(--t-fast) var(--ease),
      width var(--t-fast) var(--ease),
      left var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .seam:hover::after {
      left: 2px;
      width: 2px;
      background: var(--accent);
    }
  }
  .seaming .seam::after {
    left: 2px;
    width: 2px;
    background: var(--accent);
  }
  /* 把会话块拖进正文区：松手会落进的那一块，淡墨铺底 + 墨色细框（跟着左右挪） */
  .split-over {
    position: absolute;
    top: 6px;
    bottom: 6px;
    z-index: 4;
    pointer-events: none;
    border-radius: 16px;
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1.5px var(--accent);
    transition:
      left var(--t-med) var(--ease-out),
      width var(--t-med) var(--ease-out);
  }

  /* 分栏手柄：6px 透明热区，悬停 / 拖动时露出一根细线。
     桌面壳顶部 40px 是窗口拖拽区：div 不在宿主的免拖名单里，要自己打洞。 */
  .splitter {
    position: relative;
    z-index: 2;
    flex: none;
    width: 6px;
    margin: 0 -3px;
    cursor: col-resize;
    touch-action: none;
    -webkit-app-region: no-drag;
  }
  .splitter::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 2.5px;
    width: 1px;
    background: var(--border);
    transition:
      background-color var(--t-fast) var(--ease),
      width var(--t-fast) var(--ease),
      left var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .splitter:hover::after {
      left: 2px;
      width: 2px;
      background: var(--accent);
    }
  }
  .splitting .splitter::after {
    left: 2px;
    width: 2px;
    background: var(--accent);
  }
  .pv-col {
    position: relative;
    z-index: 1;
    flex: none;
    min-width: 0;
  }

  /* 抽屉 */
  .drawer-layer {
    position: fixed;
    inset: 0;
    z-index: 50;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    cursor: default;
  }
  .drawer {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 300px;
    max-width: 86vw;
    background: var(--rail);
    box-shadow: var(--shadow-3);
    touch-action: pan-y;
    will-change: transform;
  }
  .peek .drawer {
    width: 288px;
  }
  /* 拉开：柔弹簧；收回：短促 ease-in；跟手（none）：无过渡 */
  .drawer.open {
    transition: transform var(--t-spring-soft, 420ms) var(--spring-soft, var(--ease-out));
  }
  .drawer.close {
    transition: transform 240ms var(--ease-in);
  }
  .scrim.open {
    transition: opacity 320ms var(--ease-out);
  }
  .scrim.close {
    transition: opacity 240ms var(--ease);
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer.open,
    .drawer.close {
      transition-duration: 1ms;
    }
  }

  /* 灯箱 */
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    /* 不用 backdrop-filter：同屏多层时上层会静默失效（bridge 主页的玻璃层还在底下） */
    background: color-mix(in srgb, var(--bg) 95%, transparent);
  }
  .lb-body {
    display: flex;
    max-width: 94vw;
    max-height: 82vh;
    cursor: zoom-out;
  }
  .lb-body img {
    max-width: 100%;
    max-height: 82vh;
    object-fit: contain;
    border-radius: 12px;
    box-shadow: var(--shadow-3);
  }
  .lb-close {
    position: absolute;
    top: calc(14px + var(--sat, 0px));
    right: 16px;
    width: 40px;
    height: 40px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text);
    background: var(--surface2);
  }
  .lb-cap {
    max-width: 90vw;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* 提示 */
  .toast {
    position: fixed;
    top: calc(14px + var(--sat, 0px));
    left: 50%;
    z-index: 90;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(560px, 90vw);
    padding: 10px 16px;
    border-radius: 14px;
    background: var(--primary);
    color: var(--on-primary);
    font-size: var(--fs-md);
    font-weight: 500;
    line-height: 1.4;
    box-shadow: var(--shadow-2);
    /* 居中用独立的 translate 属性：进场动画动的是 transform，两者叠加不打架 */
    translate: -50% 0;
    transform-origin: top center;
  }
  .toast-msg {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 英文比中文长 1.5～2.5 倍：一行放不下就折行（最多三行），不截成省略号；中文外观不变 */
  .toast-msg:lang(en) {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    white-space: normal;
  }
  .toast.has-act {
    padding: 6px 6px 6px 16px;
  }
  .toast-act {
    flex: none;
    padding: 6px 12px;
    border-radius: 9px;
    font-weight: 600;
    color: var(--on-primary);
    background: color-mix(in srgb, var(--on-primary) 14%, transparent);
  }
  .toast-act:active {
    background: color-mix(in srgb, var(--on-primary) 22%, transparent);
  }
</style>
