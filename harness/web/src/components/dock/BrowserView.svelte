<script lang="ts">
  // Agent 浏览器直播：服务端那一个共享 headless Chrome 的画面 + 输入回传。用户与 agent 看的是同一个浏览器——
  // agent 的操作实时可见，用户也能伸手进去点 / 滚 / 打字（坐标按画布显示比例映射回页面 CSS 像素）。
  //
  //  · 常驻直播循环：断了（服务重启、浏览器关掉）1.2 秒后自己重连；浏览器没在跑（409 / alive:false）2.5 秒一探。
  //    浏览器真退出了才让位、清掉旧画面与 app.browser（外面的小点 / 胶囊跟着熄，§17-3）；软重连期间画面留着、只是变淡。
  //  · 桌面壳：真 WebContentsView 盖在画面区上（?native=1，不拉帧、不转发输入，agent 经 CDP 操作的仍是同一个 target）。
  //    只挂 / 卸自己的 target（同页可能还有 bridge 保活页的视图）；浮层压着时让位，浮层变化时回来；
  //    画面区尺寸一变（ResizeObserver）就按新矩形重新落座——所以祖先不许做位移动画。
  //  · 输入：点击、右键、45ms 悬停、50ms 合并的滚轮、按键 / 文字映射、粘贴；触屏单指拖动 = 滚动（跟手 1:1，§17-7）。
  //    点在画面之外的留边上不转发（以前会把越界坐标打进页面）；Shift 组合的具名键照样带上（Shift+Tab 以前变成 Tab）；
  //    映射不了的键不吞（交还给外壳，F 键之类以前被 preventDefault 吃掉）。
  import { untrack } from "svelte";
  import { app, handleDockShortcut } from "../../lib/state.svelte.ts";
  import * as api from "../../lib/api.ts";
  import { nativeShellBrowser, mountShellBrowser, unmountShellBrowser, onNativeOverlayChange, nativeOverlayActive } from "../../lib/nativeShell.ts";
  import { press } from "../../lib/motion.ts";
  import { t } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Empty from "../ui/Empty.svelte";
  import Mark from "../brand/Mark.svelte";

  // 触屏：导航按钮放大（一行要放下后退 / 前进 / 地址 / 视口 / 预览，36 是这一行放得下的最大值）
  const coarse = matchMedia("(pointer: coarse)").matches;
  let canvas: HTMLCanvasElement | undefined = $state();
  let stage: HTMLElement | undefined = $state();
  let urlInput = $state("");
  let editing = $state(false); // 输入框聚焦期间不被帧 / 标签事件里的地址覆盖
  let live = $state(false); // 流通着（有过帧，或原生模式下有标签 / 状态）
  let dead = $state(false); // 后端浏览器没在跑
  let navBusy = $state(false);

  let frameW = $state(0);
  let frameH = $state(0);
  let stageW = $state(0);
  let stageH = $state(0);
  let abortCtl: AbortController | null = null;
  let destroyed = false;

  // ── 桌面壳原生视图 ─────────────────────────────────────────────────────────────
  const nativeBrowser = nativeShellBrowser;
  let nativeRaf = 0;
  let nativeMounted = ""; // 本面板挂上去的 targetId——只卸自己的，不动别的面板
  let nativeWant = ""; // 最近一次请求挂载的 targetId（请求还在路上时 nativeMounted 还是空）

  function releaseNative() {
    if (!nativeBrowser) return;
    cancelAnimationFrame(nativeRaf);
    const id = nativeMounted || nativeWant || app.browserTabs.find((x) => x.active)?.id || "";
    nativeMounted = "";
    nativeWant = "";
    // 手里没有 id = 从没挂过：不去 unmount("")——那会把别的面板的视图也藏掉
    if (id) unmountShellBrowser(id);
  }

  function syncNative() {
    if (!nativeBrowser) return;
    cancelAnimationFrame(nativeRaf);
    const active = app.browserTabs.find((x) => x.active);
    // 浮层压着一律让位（原生视图恒在 DOM 之上）；浮层关掉时 onNativeOverlayChange 会把这里再叫一遍
    if (!active?.id || !stage || dead || !live || nativeOverlayActive()) {
      releaseNative();
      return;
    }
    const el = stage;
    const id = active.id;
    const vp = { width: frameW, height: frameH };
    nativeWant = id;
    nativeRaf = requestAnimationFrame(() => {
      mountShellBrowser(id, el, vp)
        .then((ok) => {
          if (ok && nativeWant === id) nativeMounted = id;
        })
        .catch(() => {});
    });
  }

  // ── 视口档位（与后端 VIEWPORT_PRESETS 同步）：当前档由画面尺寸反推，agent 那边 resize 也会点亮 ─────────
  const DEVICES = [
    { key: "desktop", icon: "monitor", w: 1280, h: 900, label: t("桌面") },
    { key: "tablet", icon: "tabletDev", w: 768, h: 1024, label: t("平板") },
    { key: "mobile", icon: "phoneDev", w: 375, h: 812, label: t("手机") },
  ] as const;
  let devBusy = $state(false);
  const curPreset = $derived(DEVICES.find((d) => d.w === frameW && d.h === frameH)?.key ?? "");
  const portrait = $derived(frameH > frameW);

  // contain 适配：画面完整可见、居中浮在画面区里（竖屏手机帧四周留 18px，横屏 12px——圆角与阴影露得出来）
  const fit = $derived.by(() => {
    if (!frameW || !frameH || !stageW || !stageH) return { w: 0, h: 0 };
    const pad = portrait ? 18 : 12;
    const availW = Math.max(40, stageW - pad * 2);
    const availH = Math.max(40, stageH - pad * 2);
    const s = Math.min(availW / frameW, availH / frameH);
    return { w: Math.round(frameW * s), h: Math.round(frameH * s) };
  });

  async function setDevice(preset: "mobile" | "tablet" | "desktop") {
    if (devBusy || !live) return;
    devBusy = true;
    try {
      const r = await api.browserResize({ preset });
      applyViewport(r.viewport);
    } catch {
      /* 浏览器刚关掉之类，画面流自会反映 */
    }
    devBusy = false;
  }

  // agent 光标：直播里看得到 agent 正指着哪、点了哪（只画 agent 的回声——你自己的光标本来就在）
  let agentPtr = $state({ x: 0, y: 0, on: false });
  let rippleN = $state(0);
  let ripplePos = $state({ x: 0, y: 0 });
  let ptrFade = 0;

  // 原生模式没有帧：视口尺寸就是「画面尺寸」（档位高亮、角标、原生缩放都用它）；帧流模式以真帧为准
  function applyViewport(vp: { width?: number; height?: number }) {
    const w = Math.round(Number(vp?.width) || 0);
    const h = Math.round(Number(vp?.height) || 0);
    if (!(w > 0 && h > 0)) return;
    if (!nativeBrowser) return;
    if (frameW === w && frameH === h) return;
    frameW = w;
    frameH = h;
    syncNative();
  }

  function drawFrame(data: string, w: number, h: number) {
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      if (!canvas || destroyed) return;
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${data}`;
    frameW = w;
    frameH = h;
  }

  // 浏览器真没了：旧画面不留（重新拉起后先显示「连接直播中…」，不拿上一个浏览器的帧冒充），全局记号一起清
  function markDead() {
    dead = true;
    live = false;
    frameW = 0;
    frameH = 0;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    if (app.browserTabs.length) app.browserTabs = [];
    if (app.browser) app.browser = null;
  }

  function setBrowserUrl(url: string) {
    // 地址没变就不换对象（以前每一帧都新建一次，外面读 app.browser 的全跟着重算）
    if (url && app.browser?.url !== url) app.browser = { url };
  }

  function onStreamEvent(ev: any) {
    if (ev.e === "frame") {
      if (nativeBrowser) return;
      drawFrame(ev.data, ev.w, ev.h);
      live = true;
      dead = false;
      if (ev.url && !editing) urlInput = ev.url;
      if (ev.url) setBrowserUrl(ev.url);
    } else if (ev.e === "tabs") {
      // 标签条对账：＋ / × / 切换 / 标题与地址变化都经这里广播（多端同步）
      app.browserTabs = ev.tabs ?? [];
      const act = app.browserTabs.find((x) => x.active);
      if (act && !editing) urlInput = act.url;
      if (act) setBrowserUrl(act.url);
      // 原生模式没有帧——流通着且有标签就是活的；标签变化同时驱动重挂（切标签 = 换 target）
      if (nativeBrowser && app.browserTabs.length) {
        live = true;
        dead = false;
      }
      syncNative();
    } else if (ev.e === "state" && ev.alive === false) {
      // 最后一个标签被关 → 浏览器整个退出。软断流进 2.5 秒一探；地址栏 / ＋ 拉起后下一轮连接自动复活
      releaseNative();
      markDead();
      softAbort = true;
      abortCtl?.abort();
    } else if (ev.e === "viewport" && ev.viewport) {
      applyViewport(ev.viewport);
    } else if (ev.e === "state" && ev.url !== undefined) {
      if (!editing && ev.url) urlInput = ev.url;
      if (ev.viewport) applyViewport(ev.viewport);
      if (nativeBrowser) {
        live = true;
        dead = false;
        syncNative();
      }
    } else if (ev.e === "pointer" && ev.source === "agent") {
      agentPtr = { x: ev.x, y: ev.y, on: true };
      if (ev.kind === "click") {
        ripplePos = { x: ev.x, y: ev.y };
        rippleN++;
      }
      clearTimeout(ptrFade);
      ptrFade = window.setTimeout(() => (agentPtr = { ...agentPtr, on: false }), 3000);
    }
    // { e: "error" }（订阅画面失败，服务端随后结束这条流）：不单独处理，循环 1.2 秒后重连（§17-8 保留）
  }

  // softAbort = 我们自己为「浏览器死了」主动断流，区别于卸载时的真 abort
  let softAbort = false;
  // 等下一轮重连的那段睡眠可以被叫醒：地址栏 / ＋ 刚把浏览器拉起来时立刻连，不用干等 2.5 秒
  let wake: (() => void) | null = null;
  function wakeLoop() {
    wake?.();
  }
  async function streamLoop() {
    while (!destroyed) {
      abortCtl = new AbortController();
      try {
        await api.browserStream(onStreamEvent, abortCtl.signal, nativeBrowser);
      } catch (e: any) {
        if (destroyed || (e?.name === "AbortError" && !softAbort)) break;
        if (e?.status === 409) {
          releaseNative();
          markDead();
        }
      }
      softAbort = false;
      live = false;
      // 只有浏览器真没了才让位；软重连（1.2 秒）期间视图留在原地不闪
      if (dead) releaseNative();
      if (destroyed) break;
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, dead ? 2500 : 1200);
      });
      wake = null;
    }
  }

  // 浏览器被 ＋ 拉起来了（标签列表从空变有）：不再是「没启动」，马上去连
  $effect(() => {
    const has = app.browserTabs.length > 0;
    if (!has) return;
    untrack(() => {
      if (!dead) return;
      dead = false;
      wakeLoop();
    });
  });

  $effect(() => {
    destroyed = false;
    untrack(() => void streamLoop());
    return () => {
      destroyed = true;
      abortCtl?.abort();
      releaseNative();
      clearTimeout(ptrFade);
      clearTimeout(moveTimer);
      clearTimeout(wheelTimer);
    };
  });

  // 浮层开合（文件预览、弹层、灯箱）：原生视图让位与回归
  $effect(() => {
    if (!nativeBrowser) return;
    return onNativeOverlayChange(() => syncNative());
  });

  // 画面区尺寸（contain 的分母；分栏拖宽、横竖屏都跟）。原生视图的位置也在这儿跟：面板藏起来（尺寸归零）时自动让位
  $effect(() => {
    if (!stage) return;
    const el = stage;
    const measure = () => {
      stageW = el.clientWidth;
      stageH = el.clientHeight;
      syncNative();
    };
    untrack(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // ── 输入回传 ────────────────────────────────────────────────────────────────────
  function mapCoords(e: MouseEvent): { x: number; y: number } | null {
    // 原生视图自己收鼠标（画布只是藏起来的占位）
    if (nativeBrowser || !canvas || !frameW || !frameH) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null; // 留边上：不在页面上
    return { x: Math.round(fx * frameW), y: Math.round(fy * frameH) };
  }

  const fire = (body: Record<string, unknown>) => api.browserInput(body).catch(() => {});

  let suppressClick = false; // 触屏拖动滚动完不再补一次点击
  function onClick(e: MouseEvent) {
    stage?.focus();
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const c = mapCoords(e);
    if (c) fire({ type: "click", ...c });
  }
  function onContext(e: MouseEvent) {
    e.preventDefault();
    const c = mapCoords(e);
    if (c) fire({ type: "click", ...c, button: "right" });
  }

  // 滚轮：50ms 合并一发，落在指针所在的滚动容器上
  let wheelAcc = { x: 0, y: 0 };
  let wheelAt: { x: number; y: number } | null = null;
  let wheelTimer = 0;
  function queueWheel(at: { x: number; y: number }, dx: number, dy: number) {
    wheelAcc.x += dx;
    wheelAcc.y += dy;
    wheelAt = at;
    if (wheelTimer) return;
    wheelTimer = window.setTimeout(() => {
      wheelTimer = 0;
      if (wheelAt) fire({ type: "wheel", ...wheelAt, deltaX: Math.round(wheelAcc.x), deltaY: Math.round(wheelAcc.y) });
      wheelAcc = { x: 0, y: 0 };
    }, 50);
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const c = mapCoords(e);
    if (c) queueWheel(c, e.deltaX, e.deltaY);
  }

  // 悬停：45ms 节流（首发 + 尾随），远端的悬停菜单 / tooltip / :hover 态都活着
  let moveLast = 0;
  let moveTimer = 0;
  let movePending: { x: number; y: number } | null = null;
  function hover(c: { x: number; y: number }) {
    const ms = Date.now();
    if (ms - moveLast >= 45) {
      moveLast = ms;
      fire({ type: "move", ...c });
      return;
    }
    movePending = c;
    if (moveTimer) return;
    moveTimer = window.setTimeout(() => {
      moveTimer = 0;
      if (movePending) {
        moveLast = Date.now();
        fire({ type: "move", ...movePending });
        movePending = null;
      }
    }, 45);
  }

  // 触屏单指拖动 = 滚动页面：手指往上推页面往下走，按画布缩放比换算成远端 CSS 像素（跟手 1:1）
  let touch: { id: number; x0: number; y0: number; x: number; y: number; moved: boolean } | null = null;
  function onPointerDown(e: PointerEvent) {
    suppressClick = false;
    if (e.pointerType !== "touch" || nativeBrowser) return;
    touch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false };
  }
  function onPointerMove(e: PointerEvent) {
    if (touch && e.pointerId === touch.id) {
      if (!touch.moved && Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) < 8) return;
      const dx = e.clientX - touch.x;
      const dy = e.clientY - touch.y;
      touch.moved = true;
      touch.x = e.clientX;
      touch.y = e.clientY;
      const c = mapCoords(e);
      const r = canvas?.getBoundingClientRect();
      if (c && r && r.width && r.height) queueWheel(c, (-dx * frameW) / r.width, (-dy * frameH) / r.height);
      return;
    }
    if (!live || e.pointerType === "touch") return; // 手指没有悬停
    const c = mapCoords(e);
    if (c) hover(c);
  }
  function onPointerEnd(e: PointerEvent) {
    if (!touch || e.pointerId !== touch.id) return;
    suppressClick = touch.moved;
    touch = null;
  }

  const NAMED_KEYS: Record<string, string> = {
    Enter: "enter",
    Backspace: "backspace",
    Tab: "tab",
    Escape: "escape",
    Delete: "delete",
    ArrowUp: "arrowup",
    ArrowDown: "arrowdown",
    ArrowLeft: "arrowleft",
    ArrowRight: "arrowright",
    PageUp: "pageup",
    PageDown: "pagedown",
    Home: "home",
    End: "end",
  };
  function onKey(e: KeyboardEvent) {
    if (nativeBrowser) return; // 原生视图自己收键盘，转发会双击穿
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    // 工作区快捷键（Ctrl+Shift+B 等）焦点在画面里也照样管用，不转发进远端页面
    if (handleDockShortcut(e)) return;
    const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.metaKey && "meta"].filter(Boolean) as string[];
    if (e.key.length === 1 && mods.length === 0) {
      e.preventDefault();
      fire({ type: "text", text: e.key });
      return;
    }
    const named = NAMED_KEYS[e.key] ?? (e.key.length === 1 ? e.key.toLowerCase() : "");
    if (!named) return;
    e.preventDefault();
    fire({ type: "key", key: [...mods, e.shiftKey ? "shift" : "", named].filter(Boolean).join("+") });
  }
  function onPaste(e: ClipboardEvent) {
    if (nativeBrowser) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text") ?? "";
    if (text) fire({ type: "text", text });
  }

  // ── 地址栏 / 前进后退 ──────────────────────────────────────────────────────────
  async function nav(body: { url: string } | { dir: "back" | "forward" }) {
    if (navBusy) return;
    navBusy = true;
    try {
      const r = await api.browserNavigate(body);
      if (r.url) {
        urlInput = r.url;
        setBrowserUrl(r.url);
        if (dead) {
          dead = false;
          wakeLoop(); // 地址栏把浏览器拉起来了：马上重连，不等 2.5 秒一探
        }
      }
    } catch {
      /* 地址无效等，保持原样 */
    }
    navBusy = false;
  }
  const go = (dir?: "back" | "forward") => nav(dir ? { dir } : { url: urlInput.trim() });

  // ── 应用预览：dev server 在跑时亮出「预览」，点一下把应用拉进这同一个浏览器（后端按需拉起浏览器，占位态也能一键出画面）
  const previewOrigin = $derived.by(() => {
    if (!app.chat.preview) return "";
    try {
      return new URL(app.chat.preview.url).origin;
    } catch {
      return "";
    }
  });
  const onPreview = $derived.by(() => {
    if (!previewOrigin) return false;
    try {
      return new URL(urlInput).origin === previewOrigin;
    } catch {
      return false;
    }
  });
  function openPreview() {
    if (app.chat.preview) void nav({ url: app.chat.preview.url });
  }
  // 公网地址（经隧道的 pv-<token> 子域）：手机 / 外部浏览器可直开；正在预览应用时带上当前路径（所见即所得）
  const publicHref = $derived.by(() => {
    const pub = app.chat.preview?.publicUrl;
    if (!pub) return "";
    if (!onPreview) return pub;
    try {
      const u = new URL(urlInput);
      return pub.replace(/\/$/, "") + u.pathname + u.search + u.hash;
    } catch {
      return pub;
    }
  });
</script>

<div class="bv">
  <div class="nav">
    <IconButton icon="arrowL" label={t("后退")} size={coarse ? 36 : 30} iconSize={16} onclick={() => go("back")} />
    <IconButton icon="arrowR" label={t("前进")} size={coarse ? 36 : 30} iconSize={16} onclick={() => go("forward")} />
    <label class="url">
      <span class="ldot" class:on={live}></span>
      <input
        type="text"
        spellcheck="false"
        autocomplete="off"
        autocapitalize="off"
        enterkeyhint="go"
        placeholder={t("输入地址，回车访问")}
        aria-label={t("输入地址，回车访问")}
        bind:value={urlInput}
        onfocus={() => (editing = true)}
        onblur={() => (editing = false)}
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.isComposing) {
            (e.currentTarget as HTMLInputElement).blur();
            go();
          }
        }}
      />
    </label>
    <div class="devs" class:off={!live}>
      {#each DEVICES as d (d.key)}
        <button
          class="dev"
          class:on={curPreset === d.key}
          title={t("{label}视口 {w}×{h}", { label: d.label, w: d.w, h: d.h })}
          aria-label={t("{label}视口 {w}×{h}", { label: d.label, w: d.w, h: d.h })}
          aria-pressed={curPreset === d.key}
          disabled={!live || devBusy}
          onclick={() => setDevice(d.key)}
        >
          <Icon name={d.icon} size={15} />
        </button>
      {/each}
    </div>
    {#if app.chat.preview}
      <button
        class="pv"
        class:on={onPreview}
        title={t("在浏览器中打开应用预览（{url}）", { url: app.chat.preview.url })}
        aria-label={t("预览")}
        use:press={{ scale: 0.95 }}
        onclick={openPreview}
      >
        <Icon name="layout" size={14} />
        <span class="pv-t">{t("预览")}</span>
      </button>
      {#if publicHref}
        <a
          class="ext"
          href={publicHref}
          target="_blank"
          rel="noopener noreferrer"
          title={t("公网地址打开（手机/外部浏览器可访问）")}
          aria-label={t("公网地址打开（手机/外部浏览器可访问）")}
        >
          <Icon name="external" size={15} />
        </a>
      {/if}
    {/if}
  </div>

  <!-- 画面区就是一个「应用」：要能聚焦、收键盘 / 鼠标 / 滚轮 / 粘贴并转发给远端页面（role=application 正是这个语义） -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="stage"
    class:screencast={!nativeBrowser}
    bind:this={stage}
    tabindex="0"
    role="application"
    aria-label={t("Agent 浏览器画面（可点击、滚动、输入）")}
    onclick={onClick}
    oncontextmenu={onContext}
    onwheel={onWheel}
    onkeydown={onKey}
    onpaste={onPaste}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerEnd}
    onpointercancel={onPointerEnd}
  >
    {#if dead && !live}
      <div class="over">
        <Empty
          icon="globe"
          title={t("浏览器还没有启动")}
          text={app.chat.preview ? t("应用正在运行 —— 点右上「预览」直接打开，或在上方输入地址浏览") : t("在上方输入地址开始浏览，或等 agent 使用浏览器时自动出现")}
        />
      </div>
    {:else if !live && !frameW}
      <div class="over">
        <Mark size={20} live />
        <p>{t("连接直播中…")}</p>
      </div>
    {/if}
    <div
      class="cwrap"
      class:hide={nativeBrowser || !frameW}
      class:stale={!live}
      style={fit.w > 0 ? `width:${fit.w}px;height:${fit.h}px` : ""}
    >
      <canvas bind:this={canvas}></canvas>
      {#if frameW > 0 && fit.w > 0}
        <div
          class="aptr"
          class:on={agentPtr.on}
          style="transform:translate({((agentPtr.x / frameW) * fit.w).toFixed(1)}px,{((agentPtr.y / frameH) * fit.h).toFixed(1)}px)"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M5.5 3.2 19 11.8l-6.2 1.3-2.5 6.3L5.5 3.2Z" />
          </svg>
          <span class="tag">agent</span>
        </div>
        {#key rippleN}
          {#if rippleN > 0}
            <span
              class="rip-at"
              style="transform:translate({((ripplePos.x / frameW) * fit.w).toFixed(1)}px,{((ripplePos.y / frameH) * fit.h).toFixed(1)}px)"
            >
              <span class="ripple"></span>
            </span>
          {/if}
        {/key}
      {/if}
    </div>
    {#if live && frameW > 0}
      <!-- 远端 CSS 视口可能是小数（661.3333740234375 这种），取整显示 -->
      <span class="vpsize">{Math.round(frameW)}×{Math.round(frameH)}</span>
    {/if}
  </div>
</div>

<style>
  .bv {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* 导航行：后退 / 前进 · 地址 · 视口 · 预览 · 公网 */
  .nav {
    flex: none;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px calc(8px + var(--hx-pane-r, 0px)) 8px 6px;
    container-type: inline-size;
  }
  .url {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    margin: 0 2px;
    padding: 0 12px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    cursor: text;
    transition:
      background-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
  }
  .url:focus-within {
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .url input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .url input::placeholder {
    color: var(--text3);
    font-family: var(--font-ui);
  }
  .url input:focus-visible {
    outline: none;
  }
  .ldot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--border2);
    transition: background-color var(--t-med) var(--ease);
  }
  .ldot.on {
    background: var(--live);
    animation: hx-breathe 2.4s var(--ease-in-out) infinite;
  }

  /* 视口档位：三枚图标，当前档浮起一块（agent resize 之后按画面尺寸自己点亮） */
  .devs {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 1px;
    padding: 2px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    transition: opacity var(--t-fast) var(--ease);
  }
  .devs.off {
    opacity: 0.45;
  }
  .dev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--r-pill);
    color: var(--text3);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
  }
  .dev.on {
    background: var(--surface);
    color: var(--text);
    box-shadow: 0 0 0 1px var(--border);
  }
  @media (hover: hover) {
    .dev:hover:not(:disabled):not(.on) {
      color: var(--text);
    }
  }

  .pv {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 32px;
    margin-left: 2px;
    padding: 0 11px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    color: var(--text2);
    font-size: var(--fs-sm);
    font-weight: 500;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .pv.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  @media (hover: hover) {
    .pv:not(.on):hover {
      background: var(--surface3);
      color: var(--text);
    }
  }
  .ext {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    color: var(--text2);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .ext:hover {
      background: var(--surface2);
      color: var(--text);
    }
  }
  @media (pointer: coarse) {
    .url,
    .pv {
      height: 36px;
    }
    .dev {
      width: 32px;
      height: 32px;
    }
    .ext {
      width: 36px;
      height: 36px;
    }
  }
  /* 窄：「预览」只留图标，地址栏多让出一截 */
  @container (max-width: 420px) {
    .pv {
      aspect-ratio: 1;
      padding: 0;
      justify-content: center;
    }
    .pv-t {
      display: none;
    }
  }

  /* 画面区：contain 适配，画面居中浮起（圆角 12、浮起阴影） */
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    background: var(--rail);
    outline: none;
  }
  .stage.screencast {
    touch-action: none;
  }
  .stage:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent);
  }
  .cwrap {
    position: relative;
    flex: none;
    overflow: hidden;
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: var(--shadow-1);
    transition:
      width 0.28s var(--ease),
      height 0.28s var(--ease),
      opacity var(--t-med) var(--ease);
  }
  :global(.hxroot[data-mode="dark"]) .cwrap {
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-1);
  }
  .cwrap.stale {
    opacity: 0.6;
  }
  .cwrap.hide {
    visibility: hidden;
    position: absolute;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: crosshair;
  }

  .over {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    color: var(--text3);
    text-align: center;
  }
  .over p {
    margin: 0;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .over > :global(*) {
    max-width: 340px;
  }

  /* 视口尺寸角标 */
  .vpsize {
    position: absolute;
    right: 10px;
    bottom: 8px;
    z-index: 4;
    padding: 2px 8px;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--surface) 86%, transparent);
    color: var(--text3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }

  /* agent 光标：按画布尺寸换算成像素位移（只动 transform / opacity） */
  .aptr {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 3;
    opacity: 0;
    pointer-events: none;
    filter: drop-shadow(0 1px 2px color-mix(in srgb, black 35%, transparent));
    transition:
      opacity 0.3s var(--ease),
      transform 0.12s linear;
  }
  .aptr.on {
    opacity: 1;
  }
  .aptr svg {
    display: block;
  }
  .aptr path {
    fill: var(--live);
    stroke: var(--surface);
    stroke-width: 1.4;
    stroke-linejoin: round;
  }
  .tag {
    position: absolute;
    top: 15px;
    left: 14px;
    padding: 3px 6px;
    border-radius: var(--r-pill);
    background: var(--live);
    color: var(--on-live);
    font-size: var(--fs-xs);
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }
  .rip-at {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 2;
    pointer-events: none;
  }
  .ripple {
    position: absolute;
    top: -18px;
    left: -18px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 2.5px var(--live);
    animation: bv-ripple 0.55s var(--ease-out) both;
  }
  @keyframes bv-ripple {
    from {
      transform: scale(0.25);
      opacity: 0.95;
    }
    to {
      transform: scale(1.15);
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ldot.on {
      animation: none;
    }
    .ripple {
      animation-duration: 1ms;
    }
    .aptr {
      transition: opacity 0.2s var(--ease);
    }
  }
</style>
