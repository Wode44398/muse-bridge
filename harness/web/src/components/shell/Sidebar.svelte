<script lang="ts">
  // 侧栏：项目与会话。项目的身份是工作空间绝对路径（Windows 不分大小写），显示名 = 文件夹名。
  // 桌面（docked）常驻左栏；手机 / 宽屏临时拉出时住在抽屉里（选了会话就收）。
  //
  // 结构：字标 · 主页（嵌入时）· 新对话 · 搜索 · 快照对话 · 项目（可折叠，会话缩进挂下面）· 正文命中（搜索时，K10）·
  //       加载更多 · 已隐藏的项目（唯一的回收入口）· 设置。
  // 删会话是两步：桌面点一下垃圾桶 → 变成「删除」再点一次；手机左滑露出「删除」再点。服务端删除不可撤销。
  import { onMount, type Snippet } from "svelte";
  import {
    app,
    canRefSessions,
    canReorderProjects,
    chatRunning,
    hostPickWorkspace,
    importProject,
    loadMoreSessions,
    newChat,
    newChatInProject,
    newQuickChat,
    openSession,
    removeSession,
    reorderProjects,
    setProjectFlags,
    toast,
    type ProjectMeta,
    type SessionMeta,
  } from "../../lib/state.svelte.ts";
  import { dnd, dragScrollGuard, dragSource, dropTarget, isDragging, type DragPayload } from "../../lib/dnd.svelte.ts";
  import { insertionIndex, reorderZone } from "../../lib/reorder.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse, rise } from "../../lib/motion.ts";
  import { searchSessions, type SessionSearchHit } from "../../lib/api.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import MenuSep from "../ui/MenuSep.svelte";
  import Mark from "../brand/Mark.svelte";
  import Wordmark from "../brand/Wordmark.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import { isEn, locale, t, tc, tr } from "../../lib/i18n.ts";

  let {
    docked = false,
    onToggle,
    onClose,
    onHome = null,
    sidebarFoot = null,
  }: {
    docked?: boolean;
    onToggle?: () => void;
    onClose?: () => void;
    onHome?: (() => void) | null;
    // 宿主（App 的 sidebarFoot 透传）放在底栏设置按钮上方的内容：整宽、不加外框
    sidebarFoot?: Snippet | null;
  } = $props();

  let query = $state("");
  let searchEl: HTMLInputElement | undefined = $state();
  const COLLAPSED_KEY = "harness.collapsed";
  let collapsed = $state(new Set<string>(readCollapsed()));
  let rowMenu = $state<{ project: ProjectMeta; anchor: HTMLElement } | null>(null);
  let showHidden = $state(false);
  let quickBusy = $state(false);
  // 两步删除：armed = 已经点过一次、等第二次的那条（3 秒后自动撤销）；swiped = 手机上左滑开着的那条
  let armed = $state<string | null>(null);
  let swiped = $state<string | null>(null);
  let armTimer = 0;

  function readCollapsed(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  // ── 时间：今天 = 时刻；昨天；今年 = 月/日；更早 = 年/月/日 ──────────────────────────────
  function fmtTime(ts: number): string {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86_400_000);
    // 英文：3:04 PM · Yesterday · Sep 28 · Sep 28, 2025（中文照旧手拼数字）
    if (isEn() && diff !== 1) {
      if (diff <= 0) return d.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
      const sameYear = d.getFullYear() === now.getFullYear();
      return d.toLocaleDateString(locale(), sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
    }
    if (diff <= 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (diff === 1) return t("昨天");
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  // ── 项目模型 ─────────────────────────────────────────────────────────────────────────
  const pathKey = (p: string) => (app.info?.platform === "win32" ? (p || "").toLowerCase() : p || "");
  const samePath = (a: string, b: string) => pathKey(a) === pathKey(b);
  const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
  const q = $derived(query.trim().toLowerCase());

  // 快照对话（服务端 quick.ts）：一次性桶伪装成的项目——不属于任何项目、不共用记忆、只列最新一条
  // 它的名字是服务端给的「快照对话」：显示（和按显示名搜）都过一道 tr
  const quickProj = $derived(app.projects.find((p) => p.quick) ?? null);
  const quickName = $derived(quickProj ? tr(quickProj.name) : "");
  const quickSession = $derived(quickProj ? (app.sessions.find((s) => samePath(s.workspace, quickProj.path)) ?? null) : null);
  const quickVisible = $derived(
    Boolean(quickProj) &&
      (!q ||
        quickProj!.name.toLowerCase().includes(q) ||
        quickName.toLowerCase().includes(q) ||
        (quickSession?.title ?? "").toLowerCase().includes(q)),
  );

  // 全部项目：注册表 + 从会话与当前配置里补出来的隐式项目（旧后端 / 刚升级时历史不消失）；
  // 快照桶不算项目（否则会拼出一个 UUID 名的项目）；已隐藏的在注册表里带着标记，不会被补回来。
  const allProjects = $derived.by(() => {
    const rows = app.projects.filter((p) => !p.quick);
    const known = new Set(rows.map((p) => pathKey(p.path)));
    const paths = [app.config?.workspace, ...app.sessions.map((s) => s.workspace)].filter(Boolean) as string[];
    for (const path of paths) {
      if (known.has(pathKey(path))) continue;
      if (quickProj && samePath(path, quickProj.path)) continue;
      rows.push({ id: pathKey(path), name: baseName(path), path, createdAt: 0, exists: true });
      known.add(pathKey(path));
    }
    return rows.filter((p) => {
      if (!q) return true;
      if (p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)) return true;
      return app.sessions.some((s) => samePath(s.workspace, p.path) && (s.title || "").toLowerCase().includes(q));
    });
  });
  // 置顶的排最前；区内保持服务端次序（稳定排序）——服务端按「后置顶的更靠上」与侧栏里拖出来的位次排好了。
  // 旧服务端没有拖动排序：置顶区照旧按置顶时刻（后置顶的更靠上），刚置顶的不用等刷新就到最上面
  const projects = $derived.by(() => {
    const byServer = canReorderProjects();
    return allProjects
      .filter((p) => !p.hidden)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (byServer ? 0 : (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)));
  });
  const hiddenProjects = $derived(allProjects.filter((p) => p.hidden));

  function sessionsFor(project: ProjectMeta, filtered = true): SessionMeta[] {
    const rows = app.sessions.filter((s) => samePath(s.workspace, project.path));
    const f = filtered ? q : "";
    if (!f || project.name.toLowerCase().includes(f) || project.path.toLowerCase().includes(f)) return rows;
    return rows.filter((s) => (s.title || "").toLowerCase().includes(f));
  }

  const currentWs = $derived(app.config?.workspace ?? "");
  const currentName = $derived.by(() => {
    if (!currentWs) return "";
    if (quickProj && samePath(currentWs, quickProj.path)) return quickName;
    return baseName(currentWs);
  });
  // 只有第一次、手里什么都没有时才显示「加载中」（以前每轮收尾刷新列表，整个侧栏都闪一下）
  const firstLoad = $derived((app.sessionsLoading || app.projectsLoading) && !app.sessions.length && !app.projects.length);

  // ── K10（D5）：正文命中——标题与项目名之外，按会话正文再搜一遍（服务端扫看得见的正文；能力位 "session-search"）──────
  // 输入停 250ms 才发、只认最新一次；上面已经按标题列出来的不再重复；手里有上一次的结果就先留着（静默刷新）。
  const canSearchBody = $derived(Boolean(app.compat?.caps?.includes("session-search")));
  let bodyHits = $state<SessionSearchHit[]>([]);
  let bodyBusy = $state(false);
  $effect(() => {
    const text = q;
    if (!canSearchBody || text.length < 2) {
      bodyHits = [];
      bodyBusy = false;
      return;
    }
    const ctl = new AbortController();
    bodyBusy = true;
    const timer = window.setTimeout(() => {
      searchSessions(text, ctl.signal).then(
        (items) => {
          if (ctl.signal.aborted) return;
          bodyHits = items;
          bodyBusy = false;
        },
        () => {
          if (ctl.signal.aborted) return;
          bodyHits = [];
          bodyBusy = false;
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  });
  const shownIds = $derived.by(() => {
    const ids = new Set<string>();
    if (quickVisible && quickSession) ids.add(quickSession.id);
    for (const p of projects) for (const s of sessionsFor(p)) ids.add(s.id);
    return ids;
  });
  const bodyOnly = $derived(bodyHits.filter((h) => !shownIds.has(h.id)));
  // ── 项目块长按（鼠标按住拖）排序（能力位 "project-order"；搜索过滤时不排——列表不全）────────────────────────
  // 置顶区、非置顶区各排各的（lib/reorder.ts）；插入线画在项目块的上下沿（伪元素，不占位——占位会把列表挤动、落点来回跳）。
  const canReorder = $derived(canReorderProjects() && !q);
  let listEl: HTMLDivElement | undefined = $state();
  let dropAt = $state<number | null>(null);
  const zoneItems = () => projects.map((p) => ({ id: p.id, pinned: Boolean(p.pinned) }));
  function headRects(): { top: number; bottom: number }[] {
    if (!listEl) return [];
    return [...listEl.querySelectorAll<HTMLElement>("section.proj[data-pid] > .prow")].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
  }
  const projectPayload = (project: ProjectMeta): DragPayload => ({
    kind: "project",
    id: project.id,
    title: project.name,
    path: project.path,
    pinned: Boolean(project.pinned),
  });
  const projectDrop = $derived({
    key: "project-order",
    accept: (p: DragPayload) => p.kind === "project" && canReorder,
    label: t("移到这里"),
    over: (p: DragPayload, pt: { y: number }) => {
      const at = insertionIndex(headRects(), pt.y, zoneItems(), p.id);
      dropAt = reorderZone(zoneItems(), p.id, at) ? at : null;
    },
    leave: () => (dropAt = null),
    drop: (p: DragPayload) => {
      const at = dropAt;
      dropAt = null;
      if (at === null) return;
      const order = reorderZone(zoneItems(), p.id, at);
      if (!order) return;
      const pathOf = new Map(projects.map((x) => [x.id, x.path]));
      void reorderProjects(order.map((id) => pathOf.get(id) ?? "").filter(Boolean));
    },
  });

  // ── 会话块：长按（鼠标按住拖）拎起来——拖进输入框 = 引用那个对话（能力位 "session-refs"）；宽屏拖进正文区 = 分屏
  // 手机上抽屉挡着输入框：一拎起来就收抽屉（拖拽不因拖源卸载而断，见 lib/dnd）
  const wideMq = matchMedia("(min-width: 700px)");
  let wideNow = $state(wideMq.matches);
  onMount(() => {
    const on = (e: MediaQueryListEvent) => (wideNow = e.matches);
    wideMq.addEventListener("change", on);
    return () => wideMq.removeEventListener("change", on);
  });
  const canDragSessions = $derived(canRefSessions() || wideNow);
  // 显示用的会话标题：服务端会给坏档 / 回滚恢复 / 新版本只读的会话写中文标题（「[已从检查点恢复] …」等），过一道 tr；
  // 搜索照旧按原标题匹配
  const titleOf = (s: { title?: string }) => tr(s.title?.trim() ?? "") || t("（空会话）");
  const sessionPayload = (s: { id: string; title?: string; provider?: string; workspace?: string }): DragPayload => ({
    kind: "session",
    id: s.id,
    title: titleOf(s),
    ...(s.provider ? { provider: s.provider } : {}),
    ...(s.workspace ? { workspace: s.workspace } : {}),
  });
  function sessionDrag(s: { id: string; title?: string; provider?: string; workspace?: string }) {
    return {
      key: `s:${s.id}`,
      payload: () => sessionPayload(s),
      disabled: !canDragSessions || swiped === s.id,
      onStart: () => {
        swiped = null;
        armed = null;
        leave();
      },
    };
  }

  // 命中所在的项目名（快照桶显示它自己的名字）
  function hitProject(ws?: string): string {
    if (!ws) return "";
    if (quickProj && samePath(ws, quickProj.path)) return quickName;
    return allProjects.find((p) => samePath(p.path, ws))?.name ?? baseName(ws);
  }

  // ── 动作 ─────────────────────────────────────────────────────────────────────────────
  function leave() {
    if (!docked) onClose?.();
  }
  function toggleProject(id: string) {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }
  function pick(id: string) {
    if (swiped) {
      swiped = null;
      return;
    }
    haptic("light");
    void openSession(id);
    leave();
  }
  function fresh() {
    haptic("light");
    newChat();
    leave();
  }
  async function freshFor(project: ProjectMeta, e?: Event) {
    e?.stopPropagation();
    haptic("light");
    await newChatInProject(project);
    leave();
  }
  function openQuick() {
    if (!quickProj) return;
    if (quickSession) pick(quickSession.id);
    else void freshFor(quickProj);
  }
  async function newQuickSnap(e?: Event) {
    e?.stopPropagation();
    if (quickBusy) return;
    quickBusy = true;
    haptic("light");
    try {
      await newQuickChat();
      leave();
    } finally {
      quickBusy = false;
    }
  }
  function arm(id: string, e: Event) {
    e.stopPropagation();
    if (armed === id) {
      void del(id);
      return;
    }
    haptic("light");
    armed = id;
    clearTimeout(armTimer);
    armTimer = window.setTimeout(() => (armed = null), 3000);
  }
  async function del(id: string, e?: Event) {
    e?.stopPropagation();
    armed = null;
    swiped = null;
    clearTimeout(armTimer);
    haptic("medium");
    await removeSession(id);
  }
  function openRowMenu(project: ProjectMeta, e: MouseEvent) {
    e.stopPropagation();
    haptic("light");
    const anchor = e.currentTarget as HTMLElement;
    rowMenu = rowMenu?.project.id === project.id ? null : { project, anchor };
  }
  async function togglePin(project: ProjectMeta) {
    rowMenu = null;
    haptic("light");
    await setProjectFlags(project, { pinned: !project.pinned });
  }
  async function hideProject(project: ProjectMeta) {
    rowMenu = null;
    haptic("medium");
    if (await setProjectFlags(project, { hidden: true })) toast(t("已隐藏「{name}」，可在列表底部恢复", { name: project.name }));
  }
  function openMemory(project: ProjectMeta) {
    rowMenu = null;
    haptic("light");
    app.memoryFor = { path: project.path, name: project.name };
    app.memoryFromSettings = false;
    app.sheet = "memory";
    leave();
  }
  async function restoreProject(project: ProjectMeta) {
    haptic("light");
    await setProjectFlags(project, { hidden: false });
  }
  // 新建项目 = 选一个文件夹当工作空间（唯一的路）。bridge 在场由宿主接管选择器，独立运行用自带的目录对话框。
  async function addProject() {
    haptic("light");
    const pickDir = hostPickWorkspace();
    if (!pickDir) {
      app.projectModal = true;
      return;
    }
    let dir = "";
    try {
      dir = await pickDir();
    } catch {
      dir = "";
    }
    if (!dir) return;
    try {
      await importProject(dir);
      leave();
    } catch (e: any) {
      toast(t("创建失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    }
  }

  // ── 手机左滑露出「删除」：同一时刻只开一条；点别处 / 滚动就收 ─────────────────────────
  function swipe(node: HTMLElement, id: string) {
    let cur = id;
    let pid = -1;
    let x0 = 0;
    let y0 = 0;
    let decided = false;
    let active = false;
    let base = 0;
    let dx = 0;
    const W = 72;
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      pid = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
      decided = false;
      active = true;
      base = swiped === cur ? -W : 0;
      dx = base;
    };
    const move = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      // 长按已经把这一行拎起来了：左滑让路（拖拽接管这根手指）
      if (isDragging()) {
        active = false;
        return;
      }
      const mx = e.clientX - x0;
      const my = e.clientY - y0;
      if (!decided) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
        if (Math.abs(my) > Math.abs(mx)) {
          active = false;
          return;
        }
        decided = true;
        node.setPointerCapture?.(pid);
        node.parentElement?.classList.add("revealing");
      }
      let x = base + mx;
      if (x > 0) x = Math.pow(x, 0.6);
      if (x < -W) x = -W - Math.pow(-x - W, 0.6);
      dx = x;
      node.style.transition = "none";
      node.style.transform = `translateX(${x}px)`;
      e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      if (!active || e.pointerId !== pid) return;
      active = false;
      if (!decided) return;
      node.style.transition = "";
      node.style.transform = "";
      swiped = dx < -W * 0.45 ? cur : swiped === cur ? null : swiped;
      if (swiped !== cur) node.parentElement?.classList.remove("revealing");
    };
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
    return {
      update(next: string) {
        cur = next;
      },
      destroy() {
        node.removeEventListener("pointerdown", down);
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
      },
    };
  }

  onMount(() => {
    const onDown = (e: PointerEvent) => {
      if (!swiped) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest(`[data-row="${CSS.escape(swiped)}"]`)) return;
      swiped = null;
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      clearTimeout(armTimer);
    };
  });
</script>

{#snippet sessionRow(s: SessionMeta)}
  {@const running = chatRunning(s.id) || (s.running && !app.chats.some((c) => c.id === s.id))}
  <div class="srow-wrap" class:revealing={swiped === s.id} class:lifting={dnd.on && dnd.sourceKey === `s:${s.id}`} data-row={s.id}>
    <button class="srow-del" tabindex="-1" aria-label={t("删除会话")} onclick={(e) => del(s.id, e)}>{t("删除")}</button>
    <div
      class="srow"
      class:active={s.id === app.chat.id}
      class:inpane={s.id !== app.chat.id && app.panes.some((c) => c.id === s.id)}
      class:open={swiped === s.id}
      use:swipe={s.id}
      use:dragSource={sessionDrag(s)}
    >
      <button class="srow-main" onclick={() => pick(s.id)} title={titleOf(s)}>
        <span class="srow-v"><VendorLogo skin={s.provider} size={12} mono /></span>
        <span class="srow-title">{titleOf(s)}</span>
        <span class="srow-meta">
          {#if s.waiting}
            <span class="waiting"><span class="wdot"></span>{tc("dimensio", "等你")}</span>
          {:else if running}
            <span class="running" title={t("运行中")}><Mark size={14} live /></span>
          {:else}
            <span class="time">{fmtTime(s.updatedAt)}</span>
          {/if}
        </span>
      </button>
      <button class="srow-x" class:armed={armed === s.id} tabindex="-1" data-no-drag aria-label={armed === s.id ? t("确认删除会话") : t("删除会话")} onclick={(e) => arm(s.id, e)}>
        {#if armed === s.id}<span>{t("删除")}</span>{:else}<Icon name="trash" size={14} />{/if}
      </button>
    </div>
  </div>
{/snippet}

<nav class="sb" class:docked class:drawer={!docked} aria-label={t("项目与会话")}>
  <header class="band">
    <span class="brand"><Mark size={19} /><Wordmark height={17} /></span>
    {#if docked}
      <IconButton icon="panel" label={t("收起侧栏")} size={32} onclick={() => onToggle?.()} />
    {:else}
      <IconButton icon="close" label={t("关闭侧栏")} size={32} onclick={() => onClose?.()} />
    {/if}
  </header>

  <div class="top">
    {#if onHome}
      <button class="nav" onclick={onHome}>
        <Icon name="arrowL" size={17} />
        <span class="nav-t">{t("主页")}</span>
      </button>
    {/if}
    <button class="nav new" onclick={fresh}>
      <Icon name="edit" size={17} />
      <span class="nav-t">{t("新对话")}</span>
      {#if currentName}<span class="nav-h">{currentName}</span>{/if}
    </button>
    {#if app.features.sessions}
      <label class="search">
        <Icon name="search" size={15} />
        <input bind:this={searchEl} bind:value={query} placeholder={t("搜索项目或对话")} aria-label={t("搜索项目或对话")} enterkeyhint="search" />
        {#if query}
          <button class="clr" aria-label={t("清空")} onclick={() => (query = "")}><Icon name="close" size={13} stroke={2} /></button>
        {/if}
      </label>
    {/if}
  </div>

  <div class="scroll" bind:this={listEl} use:dragScrollGuard use:dropTarget={projectDrop}>
    {#if !app.features.sessions}
      <p class="hint">{app.connError ? t("连不上服务器，历史会话暂时看不到") : t("历史会话需要重启 harness 服务后可用")}</p>
    {:else if firstLoad}
      <p class="hint loading"><Mark size={14} live /> {t("加载中")}</p>
    {:else}
      {#if quickProj && quickVisible}
        <section class="proj quick" class:current={samePath(currentWs, quickProj.path)}>
          <div class="prow">
            <button class="prow-main" onclick={openQuick} title={t("快照对话：一次性空间，不属于任何项目，只保留最新一条")}>
              <span class="picon"><Icon name="bolt" size={16} /></span>
              <span class="pname">{quickName}</span>
            </button>
            <button class="pact" disabled={quickBusy} title={t("新建快照（换一个全新的一次性空间）")} aria-label={t("新建快照")} onclick={(e) => newQuickSnap(e)}>
              <Icon name="plus" size={16} />
            </button>
          </div>
          <div class="sessions">
            {#if quickSession}
              {@render sessionRow(quickSession)}
            {:else}
              <p class="pempty">{t("独立小任务的落点，点击开始")}</p>
            {/if}
          </div>
        </section>
      {/if}

      <div class="sec">
        <span>{tc("dimensio", "项目")}</span>
        <button class="sec-add" title={t("新建项目")} aria-label={t("新建项目")} disabled={!app.features.projects} onclick={addProject}>
          <Icon name="plus" size={15} />
        </button>
      </div>

      {#if projects.length === 0}
        <p class="hint">
          {hiddenProjects.length
            ? t("项目都被隐藏了，在下面的「已隐藏的项目」里恢复")
            : q
              ? canSearchBody && q.length >= 2
                ? t("项目名和对话标题里都没有")
                : t("没有匹配的项目或对话")
              : t("还没有项目，点“＋”选一个文件夹开始")}
        </p>
      {/if}

      {#each projects as project, i (project.id)}
        {@const open = !collapsed.has(project.id) || Boolean(q)}
        {@const all = sessionsFor(project, false)}
        <section
          class="proj"
          data-pid={project.id}
          class:current={samePath(currentWs, project.path)}
          class:missing={!project.exists}
          class:lifting={dnd.on && dnd.sourceKey === `p:${project.id}`}
          class:drop-before={dropAt === i}
          class:drop-after={dropAt === projects.length && i === projects.length - 1}
        >
          <div
            class="prow"
            use:dragSource={{ key: `p:${project.id}`, payload: () => projectPayload(project), disabled: !canReorder }}
          >
            <button class="prow-main" onclick={() => toggleProject(project.id)} title={project.path} aria-expanded={open}>
              <span class="picon"><Icon name={open ? "folderOpen" : "folder"} size={16} /></span>
              <span class="pname">{project.name}</span>
              {#if project.pinned}<span class="ppin" title={t("已置顶")}><Icon name="pin" size={12} /></span>{/if}
            </button>
            {#if all.length}<span class="pcount" aria-hidden="true">{all.length}</span>{/if}
            <div class="pacts" class:on={rowMenu?.project.id === project.id} data-no-drag>
              <button class="pact" disabled={!project.exists} title={t("在「{name}」中新建对话", { name: project.name })} aria-label={t("在 {name} 中新建对话", { name: project.name })} onclick={(e) => freshFor(project, e)}>
                <Icon name="edit" size={15} />
              </button>
              <button
                class="pact"
                class:on={rowMenu?.project.id === project.id}
                title={t("项目操作")}
                aria-label={t("{name} 的项目操作", { name: project.name })}
                aria-expanded={rowMenu?.project.id === project.id}
                onclick={(e) => openRowMenu(project, e)}
              >
                <Icon name="more" size={16} />
              </button>
            </div>
          </div>
          {#if open}
            <div class="sessions" transition:collapse>
              {#each sessionsFor(project) as s (s.id)}
                <div in:rise={{ y: 4 }}>{@render sessionRow(s)}</div>
              {:else}
                <p class="pempty">{q ? t("没有匹配的对话") : project.exists ? t("暂无对话") : t("文件夹已不存在")}</p>
              {/each}
            </div>
          {/if}
        </section>
      {/each}

      <!-- K10（D5）：正文命中（标题里没有、正文里提到过的对话），带一段前后文 -->
      {#if canSearchBody && q.length >= 2}
        <div class="sec">
          <span>{t("正文里提到")}</span>
          {#if bodyBusy && !bodyHits.length}<span class="sec-live"><Mark size={12} live /></span>{/if}
        </div>
        {#each bodyOnly as h (h.id)}
          <div in:rise={{ y: 4 }} class:lifting={dnd.on && dnd.sourceKey === `s:${h.id}`} use:dragSource={sessionDrag(h)}>
            <button class="hit" class:active={h.id === app.chat.id} onclick={() => pick(h.id)} title={titleOf(h)}>
              <span class="hit-head">
                <span class="srow-v"><VendorLogo skin={h.provider} size={12} mono /></span>
                <span class="hit-title">{titleOf(h)}</span>
                <span class="hit-time">{fmtTime(h.updatedAt)}</span>
              </span>
              <span class="hit-snip">{h.snippet.before}<mark>{h.snippet.match}</mark>{h.snippet.after}</span>
              {#if hitProject(h.workspace)}
                <span class="hit-proj"><Icon name="folder" size={11} />{hitProject(h.workspace)}</span>
              {/if}
            </button>
          </div>
        {:else}
          {#if !bodyBusy}
            <p class="pempty">{bodyHits.length ? t("正文命中的对话都已经在上面了") : t("正文里也没有")}</p>
          {/if}
        {/each}
      {/if}

      {#if app.sessionsMore}
        <button class="more" disabled={app.sessionsLoading} onclick={() => loadMoreSessions()}>
          {app.sessionsLoading
            ? t("加载中…")
            : app.sessionsTotal >= 0
              ? t("加载更早的会话（还有 {n} 个）", { n: app.sessionsTotal - app.sessions.length })
              : t("加载更早的会话")}
        </button>
      {/if}

      {#if hiddenProjects.length > 0}
        <div class="hidden">
          <button class="hidden-head" onclick={() => (showHidden = !showHidden)} aria-expanded={showHidden}>
            <Icon name="eyeOff" size={15} />
            <span>{t("已隐藏的项目")}</span>
            <span class="pcount">{hiddenProjects.length}</span>
            <span class="chev" class:open={showHidden}><Icon name="chevronD" size={13} /></span>
          </button>
          {#if showHidden}
            <div transition:collapse>
              {#each hiddenProjects as project (project.id)}
                <div class="hidden-row">
                  <span class="hidden-name" title={project.path}>{project.name}</span>
                  <button class="restore" onclick={() => restoreProject(project)}>{tc("dimensio", "恢复")}</button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  </div>

  <footer class="foot">
    {#if sidebarFoot}
      <div class="foot-slot">{@render sidebarFoot()}</div>
    {/if}
    <button class="nav" onclick={() => (app.sheet = "settings")}>
      <Icon name="gear" size={17} />
      <span class="nav-t">{t("设置")}</span>
      {#if app.config && !app.config.hasKey}<span class="warn-dot" title={t("还没填 API Key")}></span>{/if}
    </button>
  </footer>
</nav>

{#if rowMenu}
  {@const target = rowMenu.project}
  <Popover anchor={rowMenu.anchor} onclose={() => (rowMenu = null)} prefer="down" align="end" minWidth={216}>
    <MenuItem icon="edit" label={t("在这个项目里新建对话")} disabled={!target.exists} onclick={() => { rowMenu = null; void freshFor(target); }} />
    <MenuItem icon={target.pinned ? "pinOff" : "pin"} label={target.pinned ? t("取消置顶") : t("置顶项目")} onclick={() => togglePin(target)} />
    {#if app.compat?.caps?.includes("memory")}
      <MenuItem icon="memory" label={t("项目记忆")} onclick={() => openMemory(target)} />
    {/if}
    <MenuSep />
    <MenuItem icon="eyeOff" label={t("隐藏项目")} description={t("只是不在侧栏显示，文件夹和历史对话都不会删除")} onclick={() => hideProject(target)} />
  </Popover>
{/if}

<style>
  .sb {
    display: flex;
    flex-direction: column;
    height: 100%;
    color: var(--text);
    font-size: var(--fs-base);
    user-select: none;
  }
  .band {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: calc(var(--hx-band) + var(--sat, 0px));
    padding: var(--sat, 0px) 8px 0 18px;
  }
  /* 桌面壳：侧栏头在窗口拖拽区里，只有按钮可点——字标区域留给拖窗 */
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-left: -3px;
    color: var(--text);
    padding-top: 2px;
  }
  .drawer .band {
    height: calc(52px + var(--sat, 0px));
  }

  .top {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px 8px;
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 36px;
    padding: 0 10px;
    border-radius: 10px;
    color: var(--text);
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .nav :global(.hx-icon) {
    color: var(--text2);
  }
  .nav-t {
    flex: none;
  }
  .nav-h {
    flex: 1;
    min-width: 0;
    margin-left: 2px;
    font-size: var(--fs-sm);
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .nav:active {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    margin-top: 4px;
    padding: 0 10px;
    border-radius: 10px;
    color: var(--text3);
    background: color-mix(in srgb, var(--text) 4.5%, transparent);
    transition:
      background-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
    cursor: text;
  }
  .search:focus-within {
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border2);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font-size: var(--fs-md);
    user-select: text;
  }
  .search input::placeholder {
    color: var(--text3);
  }
  .clr {
    display: inline-flex;
    padding: 3px;
    border-radius: 6px;
    color: var(--text3);
  }

  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px 8px 16px;
    mask-image: linear-gradient(to bottom, transparent 0, black 10px, black calc(100% - 18px), transparent 100%);
  }
  .hint {
    margin: 8px 10px;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text3);
  }
  .hint.loading {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sec {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 30px;
    margin-top: 10px;
    padding: 0 6px 0 10px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text3);
  }
  .sec-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 8px;
    color: var(--text3);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .sec-add:disabled {
    opacity: 0.4;
  }

  /* 项目 */
  .proj {
    position: relative;
    margin-top: 2px;
    transition: opacity var(--t-fast) var(--ease);
  }
  /* 被拎起来的那一块留在原位淡着（幽灵跟着手走）；插入线是墨色细线，画在上下沿、不占位 */
  .proj.lifting,
  .srow-wrap.lifting,
  .lifting > .hit {
    opacity: 0.35;
  }
  .proj.drop-before::before,
  .proj.drop-after::after {
    content: "";
    position: absolute;
    left: 8px;
    right: 8px;
    height: 2px;
    border-radius: 2px;
    background: var(--accent);
    pointer-events: none;
  }
  .proj.drop-before::before {
    top: -2px;
  }
  .proj.drop-after::after {
    bottom: -3px;
  }
  .proj.quick {
    margin-top: 4px;
  }
  .prow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    height: 34px;
    border-radius: 10px;
    transition: background-color var(--t-fast) var(--ease);
  }
  /* 计数靠右；行内动作叠在同一个位置（桌面悬停时计数淡出、动作淡入；触屏常显动作） */
  .pacts {
    display: flex;
    align-items: center;
    gap: 1px;
    margin-left: auto;
    padding-right: 3px;
    transition: opacity var(--t-fast) var(--ease);
  }
  .prow-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 100%;
    padding: 0 6px 0 10px;
    text-align: left;
    color: var(--text);
  }
  .picon {
    display: inline-flex;
    color: var(--text3);
    transition: color var(--t-fast) var(--ease);
  }
  .current .picon {
    color: var(--accent);
  }
  .pname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .ppin {
    display: inline-flex;
    color: var(--text3);
  }
  .pcount {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
    transition: opacity var(--t-fast) var(--ease);
  }
  .prow .pcount {
    position: absolute;
    right: 12px;
    pointer-events: none;
  }
  @media not (hover: hover) {
    .prow .pcount {
      display: none;
    }
  }
  .hidden-head .pcount {
    margin-left: auto;
  }
  .pact {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    color: var(--text3);
    transition:
      opacity var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .pact.on {
    background: color-mix(in srgb, var(--text) 8%, transparent);
    color: var(--text);
  }
  .pact:disabled {
    opacity: 0.35;
  }
  .missing .prow-main {
    opacity: 0.55;
  }
  /* 会话缩进挂在项目下：小标对齐项目名的起点 */
  .sessions {
    padding: 1px 0 6px 25px;
  }
  .pempty {
    margin: 2px 0 4px;
    padding: 6px 10px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }

  /* 会话行 */
  .srow-wrap {
    position: relative;
    border-radius: 10px;
    overflow: hidden;
  }
  .srow-del {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 72px;
    border-radius: 0 10px 10px 0;
    background: var(--err);
    color: var(--on-accent);
    font-size: var(--fs-md);
    font-weight: 600;
    visibility: hidden;
  }
  .srow-wrap.revealing .srow-del {
    visibility: visible;
  }
  .srow {
    position: relative;
    display: flex;
    align-items: center;
    height: 34px;
    border-radius: 10px;
    background: var(--rail);
    transition:
      transform 300ms var(--ease-out),
      background-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
    touch-action: pan-y;
  }
  .srow.open {
    transform: translateX(-72px);
  }
  .srow.active {
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--border),
      0 1px 2px color-mix(in srgb, var(--text) 5%, transparent);
  }
  .srow-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 100%;
    padding: 0 8px 0 12px;
    text-align: left;
    color: var(--text2);
  }
  .srow.active .srow-main {
    color: var(--text);
  }
  /* 分屏里另一格正开着的会话：只描一圈细线（有焦点的那格才是整块纸色） */
  .srow.inpane {
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .srow-v {
    display: inline-flex;
    color: var(--text3);
    opacity: 0.8;
  }
  .srow.active .srow-v {
    color: var(--accent);
    opacity: 1;
  }
  .srow-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
  }
  .srow-meta {
    flex: none;
    display: inline-flex;
    align-items: center;
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .running {
    display: inline-flex;
    color: var(--text2);
  }
  .waiting {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--warn);
    font-weight: 500;
  }
  .wdot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--warn);
    animation: hx-breathe 1.8s var(--ease-in-out) infinite;
  }
  .srow-x {
    flex: none;
    display: none;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 26px;
    margin-right: 4px;
    padding: 0 6px;
    border-radius: 7px;
    color: var(--text3);
    font-size: var(--fs-sm);
    font-weight: 600;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .srow-x.armed {
    display: inline-flex;
    background: var(--err);
    color: var(--on-accent);
  }

  /* K10：正文命中——两行：标题一行，前后文一行（命中处墨色淡底，不用朱：朱只给正在发生的东西） */
  .sec-live {
    display: inline-flex;
    margin-right: 5px;
  }
  .hit {
    display: flex;
    flex-direction: column;
    gap: 3px;
    width: 100%;
    padding: 7px 10px 8px 12px;
    border-radius: 10px;
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .hit.active {
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
  }
  .hit:active {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .hit-head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .hit-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .hit.active .hit-title {
    color: var(--text);
  }
  .hit-time {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  /* 前后文与标题的字对齐（厂商标 12 + 间距 9） */
  .hit-snip,
  .hit-proj {
    padding-left: 21px;
  }
  .hit-snip {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
    overflow-wrap: anywhere;
  }
  .hit-snip mark {
    padding: 0 1px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--text);
  }
  .hit-proj {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }

  .more {
    width: 100%;
    margin-top: 8px;
    padding: 8px 10px;
    border-radius: 10px;
    font-size: var(--fs-sm);
    color: var(--text3);
    text-align: left;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .hidden {
    margin-top: 14px;
  }
  .hidden-head {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    border-radius: 10px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .chev {
    display: inline-flex;
    transform: rotate(-90deg);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev.open {
    transform: none;
  }
  .hidden-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 6px 0 35px;
  }
  .hidden-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .restore {
    flex: none;
    padding: 4px 10px;
    border-radius: var(--r-pill);
    font-size: var(--fs-sm);
    color: var(--accent);
    background: var(--accent-soft);
  }

  .foot {
    flex: none;
    padding: 6px 8px calc(10px + var(--sab, 0px));
  }
  /* 宿主内容：整宽一列，不加边框 / 底色 / 内边距 */
  .foot-slot {
    display: flex;
    flex-direction: column;
    min-width: 0;
    width: 100%;
  }
  .warn-dot {
    width: 7px;
    height: 7px;
    margin-left: auto;
    margin-right: 2px;
    border-radius: 50%;
    background: var(--warn);
  }

  /* 悬停：只给精确指针。行内动作桌面上悬停才浮现（占位不变，布局不跳）；触屏常显、删会话靠左滑。 */
  @media (hover: hover) and (pointer: fine) {
    .nav:hover,
    .prow:hover,
    .hit:not(.active):hover,
    .hidden-head:hover,
    .more:hover:not(:disabled) {
      background: color-mix(in srgb, var(--text) 5%, transparent);
    }
    .sec-add:hover:not(:disabled),
    .pact:hover:not(:disabled) {
      background: color-mix(in srgb, var(--text) 8%, transparent);
      color: var(--text);
    }
    .srow:not(.active):hover {
      background: color-mix(in srgb, var(--text) 5%, var(--rail));
    }
    .pacts {
      opacity: 0;
    }
    .prow:hover .pacts,
    .prow:focus-within .pacts,
    .pacts.on {
      opacity: 1;
    }
    .prow:hover .pcount,
    .prow:focus-within .pcount,
    .prow:has(.pacts.on) .pcount {
      opacity: 0;
    }
    .srow:hover .srow-x,
    .srow:focus-within .srow-x {
      display: inline-flex;
    }
    .srow:hover .srow-meta,
    .srow:focus-within .srow-meta {
      display: none;
    }
    .srow-x:hover {
      background: color-mix(in srgb, var(--err) 12%, transparent);
      color: var(--err);
    }
    .srow-x.armed:hover {
      background: var(--err);
      color: var(--on-accent);
    }
    .restore:hover {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
    }
  }
</style>
