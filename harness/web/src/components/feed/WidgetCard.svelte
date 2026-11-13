<script module lang="ts">
  // 每张图最后的高度（按工具调用 id）：重开会话 / 历史重放时先按它占位，iframe 起来后不跳
  const HKEY = "dimensio-widget-h";
  const heights = new Map<string, number>();
  try {
    for (const [k, v] of JSON.parse(localStorage.getItem(HKEY) || "[]") as [string, number][]) heights.set(k, v);
  } catch {
    /* 没有存储 / 坏了：不占位 */
  }
  let saveT = 0;
  function rememberH(id: string, hh: number) {
    if (!id || !(hh > 0) || heights.get(id) === hh) return;
    heights.delete(id);
    heights.set(id, hh);
    while (heights.size > 200) heights.delete(heights.keys().next().value as string);
    clearTimeout(saveT);
    saveT = window.setTimeout(() => {
      try {
        localStorage.setItem(HKEY, JSON.stringify([...heights]));
      } catch {
        /* 存不下就算了 */
      }
    }, 800);
  }
</script>

<script lang="ts">
  // 对话内嵌交互图表（ShowWidget 工具）：工具行的参数里就是整份代码，直播与历史重放同一份数据。
  //
  // 两种渲染：
  //  · 网页 / 桌面壳：srcdoc iframe，sandbox 只给 allow-scripts——不透明源，碰不到 dimensio / bridge 的存储与同源接口；
  //    壳（CSP 白名单、高度上报、sendPrompt 转发）用 lib/widget-shell.ts。
  //  · 手机壳（dimensio 离线 apk 的 HarnessShell、bridge apk 的 AndroidStore）：原生桥注入进所有帧、不分源，图表脚本能直接调到
  //    ——一律不跑脚本：清洗成静态 SVG / HTML 放进 shadow root（变量从宿主继承，主题切换自动跟），卡下注明「手机上为静态预览」。
  //
  // sendPrompt：壳把 {type:'prompt'} 发上来，这里再核一遍——必须是 iframe 里真实的用户点击（用户激活 + 焦点在这个 iframe 上），
  // 1.5 秒内只认一次，然后当作用户在这一格发的消息（不带输入框里的附件 / 引用 / 目标）。这一轮还在跑：等它结束再发
  //（对齐 Claude 的「稍后发送」，不当插话）。没有用户点击的（定时器里调的）不直接发，卡下出一条「图表想替你发送」等用户点。
  import { onMount, untrack } from "svelte";
  import type { ToolItem } from "../../lib/timeline-types.ts";
  import { focusPane, send } from "../../lib/state.svelte.ts";
  import { usePane } from "../../lib/pane.ts";
  import { isShell } from "../../lib/api.ts";
  import { modeAt, shell, themeRefs, themeVars } from "../../lib/widget-shell.ts";
  import { widgetBroken, widgetOf, widgetTitle } from "../../lib/widget-tools.ts";
  import { t } from "../../lib/i18n.ts";
  import Mark from "../brand/Mark.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import Button from "../ui/Button.svelte";

  let { item }: { item: ToolItem } = $props();

  const pane = usePane();
  const w = $derived(widgetOf(item));
  const broken = $derived(widgetBroken(w));
  const title = $derived(widgetTitle(w));
  const kind = $derived(shell.isSvgCode(w.code) ? "SVG" : "HTML");

  const STATIC = isShell() || Boolean((window as unknown as Record<string, unknown>).AndroidStore);
  const MAX_H = 1800; // 再高就在框里滚
  const BLANK_MS = 20_000; // 这么久还什么都没画出来（脚本卡在 CDN 上）→ 按没画出来收尾
  const UNLOAD_MS = 30_000; // iframe 离视口很远待满这么久就卸掉

  let root: HTMLElement | undefined = $state();
  let frameEl: HTMLIFrameElement | undefined = $state();
  let hostEl: HTMLElement | undefined = $state();
  let moreBtn: HTMLButtonElement | undefined = $state();
  let mounted = $state(false); // 懒挂：进视口附近才起 iframe（长对话别一次起几十个）
  let ready = $state(false); // 壳脚本已就绪
  let h = $state(untrack(() => heights.get(item.id) ?? 0));
  let shown = $state(false); // 已经有看得见的内容
  let blank = $state(false); // 什么也没画出来（内容全靠脚本、脚本没跑起来；手机上要脚本才有内容）
  let scriptErr = $state("");
  let animH = $state(false); // 第一次量到高度之后才开高度过渡（回放占位别从 0 长出来）
  let hijacked = $state(false);
  let codeOpen = $state(false);
  let menuOpen = $state(false);
  let note = $state("");
  let askText = $state(""); // 没有用户点击的 sendPrompt：等用户在卡下确认
  let queued = $state(""); // 这一轮跑完再发的
  let notSent = $state("");
  let mode = $state<"light" | "dark">("light");
  let ldIdx = $state(0);

  const reserved = $derived(!shown && h > 0);
  const loadingMsgs = $derived(w.loading.length ? w.loading : [t("正在画图表…")]);
  const ldText = $derived(loadingMsgs[ldIdx % loadingMsgs.length]);
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let srcdoc = "";
  let sentCode: string | null = null;
  let loads = 0;

  // —— 懒挂 / 离屏卸载 ——
  onMount(() => {
    mode = modeAt(root ?? null);
    if (!("IntersectionObserver" in window) || !root) {
      mounted = true;
      return;
    }
    const near = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting) || hijacked) return;
        mounted = true;
        if (STATIC) near.disconnect(); // 静态预览不卸载
      },
      { rootMargin: "800px 0px" },
    );
    near.observe(root);
    let far: IntersectionObserver | null = null;
    let ut = 0;
    if (!STATIC) {
      far = new IntersectionObserver(
        (es) => {
          clearTimeout(ut);
          if (!es.some((e) => e.isIntersecting)) ut = window.setTimeout(unload, UNLOAD_MS);
        },
        { rootMargin: "2400px 0px" },
      );
      far.observe(root);
    }
    return () => {
      near.disconnect();
      far?.disconnect();
      clearTimeout(ut);
    };
  });
  function unload() {
    // 用户在看代码 / 等确认 / 开着菜单、或还没量到高度（占位会塌）时不卸
    if (!mounted || codeOpen || askText || menuOpen || !shown || !(h > 0)) return;
    mounted = false;
    ready = false;
    sentCode = null;
    loads = 0;
    for (const s of snapWait.values()) s.rej(new Error("unloaded"));
    snapWait.clear();
  }

  // 加载语轮播
  $effect(() => {
    if (shown || blank || loadingMsgs.length < 2) return;
    const id = setInterval(() => (ldIdx += 1), 2600);
    return () => clearInterval(id);
  });

  // 主题：所在处的 data-mode 一变就把新变量推进去（iframe 读不到父页的 CSS 变量）
  onMount(() => {
    const at = (root?.closest("[data-mode]") as HTMLElement | null) ?? document.documentElement;
    const mo = new MutationObserver(() => (mode = modeAt(root ?? null)));
    mo.observe(at, { attributes: true, attributeFilter: ["data-mode"] });
    return () => mo.disconnect();
  });

  // —— iframe 模式 ——
  function post(msg: Record<string, unknown>) {
    if (hijacked) return;
    try {
      frameEl?.contentWindow?.postMessage({ bw: "w1", ...msg }, "*");
    } catch {
      /* 帧已卸 */
    }
  }
  function pushCode() {
    if (!ready || sentCode === w.code) return;
    sentCode = w.code;
    post({ type: "code", code: w.code, final: true });
  }
  $effect(() => {
    if (STATIC || !ready) return;
    void w.code;
    pushCode();
  });
  $effect(() => {
    if (!STATIC && ready) post({ type: "theme", mode, vars: themeVars(root ?? null) });
  });
  // 迟迟没有看得见的内容：壳跑完脚本会报 done（那时高度仍为 0 就是没画出来）；脚本卡在加载上连 done 都没有时到点兜底
  $effect(() => {
    if (STATIC || !mounted || shown || blank || broken) return;
    const id = setTimeout(() => {
      if (!shown) blank = true;
    }, BLANK_MS);
    return () => clearTimeout(id);
  });
  $effect(() => {
    if (!STATIC && shown && h > 0) rememberH(item.id, h);
  });

  function frameDoc(): string {
    if (!srcdoc) srcdoc = shell.buildSrcdoc({ nonce, mode: modeAt(root ?? null), vars: themeVars(root ?? null), maxH: MAX_H });
    return srcdoc;
  }
  // 同一个 iframe 再 load 一次 = 图表脚本把这一帧导航走了（sandbox 管不到 navigate）：立刻卸掉、标成已拦截，不再挂回来
  function onFrameLoad() {
    loads += 1;
    if (loads > 1) {
      hijacked = true;
      ready = false;
      mounted = false;
      for (const s of snapWait.values()) s.rej(new Error("hijacked"));
      snapWait.clear();
      return;
    }
    if (!ready) post({ type: "ping" });
  }

  // —— 回调：sendPrompt / openLink / 下载 ——
  let lastPromptAt = 0;
  function userClickedFrame(): boolean {
    const act = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true;
    return act && document.activeElement === frameEl;
  }
  function onPrompt(text: unknown) {
    const s = String(text ?? "").trim().slice(0, 4000);
    if (!s) return;
    if (!userClickedFrame()) {
      askText = s;
      return;
    }
    const now = Date.now();
    if (now - lastPromptAt < 1500) return;
    lastPromptAt = now;
    askText = "";
    deliver(s);
  }
  function deliver(s: string) {
    notSent = "";
    if (pane.chat.running) queued = s;
    else void dispatch(s);
  }
  // 当作用户在这一格发的一条：焦点先落到这一格（send 作用于有焦点的那一格），输入框里攒着的附件 / 引用 / 目标不跟着走
  async function dispatch(s: string) {
    const chat = pane.chat;
    focusPane(chat);
    const keep = { attachments: chat.attachments, refs: chat.refs, goal: chat.goalDraft };
    chat.attachments = [];
    chat.refs = [];
    chat.goalDraft = null;
    let p: Promise<void>;
    try {
      p = send(s); // 草稿在 send 的同步段里就读完了
    } finally {
      chat.attachments = keep.attachments;
      chat.refs = keep.refs;
      chat.goalDraft = keep.goal;
    }
    try {
      await p;
    } catch {
      notSent = s;
    }
  }
  $effect(() => {
    if (!queued || pane.chat.running) return;
    const s = queued;
    queued = "";
    void dispatch(s);
  });
  function confirmAsk() {
    const s = askText;
    askText = "";
    if (s) deliver(s);
  }
  function openExternal(url: string) {
    if (!/^https?:\/\//i.test(url) || !userClickedFrame()) return;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  }
  function saveBlob(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  async function saveDataUrl(url: string, name: unknown) {
    if (!/^data:/i.test(url) || !userClickedFrame()) return;
    try {
      const blob = await (await fetch(url)).blob();
      saveBlob(blob, String(name || "download").replace(/[\\/:*?"<>|]+/g, "_"));
    } catch {
      /* 坏的 data URL */
    }
  }

  // —— 截图（复制为图片 / 下载为 PNG）：壳把画面画成 PNG data URL 回给这里 ——
  let snapSeq = 0;
  const snapWait = new Map<number, { res: (b: Blob) => void; rej: (e: Error) => void }>();
  function dataUrlBlob(u: unknown): Blob | null {
    const m = /^data:(image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(String(u ?? ""));
    if (!m) return null;
    const bin = atob(m[2]);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m[1] });
  }
  function requestPng(): Promise<Blob> {
    return new Promise((res, rej) => {
      if (!ready || !frameEl) return rej(new Error("not ready"));
      const req = ++snapSeq;
      const timer = setTimeout(() => {
        snapWait.delete(req);
        rej(new Error("timeout"));
      }, 15_000);
      snapWait.set(req, {
        res: (b) => (clearTimeout(timer), res(b)),
        rej: (e) => (clearTimeout(timer), rej(e)),
      });
      post({ type: "snap", req });
    });
  }
  let noteT = 0;
  function flash(s: string) {
    note = s;
    clearTimeout(noteT);
    noteT = window.setTimeout(() => (note = ""), 1800);
  }
  onMount(() => () => clearTimeout(noteT));
  function copyImage() {
    menuOpen = false;
    try {
      // ClipboardItem 收 Promise：点击的用户激活当场用掉，PNG 晚点到也能写进剪贴板
      const p = requestPng();
      p.catch(() => {});
      navigator.clipboard.write([new ClipboardItem({ "image/png": p })]).then(
        () => flash(t("已复制")),
        () => flash(t("无法复制图片，请重试。")),
      );
    } catch {
      flash(t("无法复制图片，请重试。"));
    }
  }
  function downloadPng() {
    menuOpen = false;
    requestPng().then(
      (b) => {
        saveBlob(b, shell.fileStem(w.title) + ".png");
        flash(t("已下载"));
      },
      () => flash(t("无法下载图片，请重试。")),
    );
  }
  function downloadSource() {
    menuOpen = false;
    const f = shell.standaloneFile(w.code, w.title);
    saveBlob(new Blob([f.text], { type: f.mime + ";charset=utf-8" }), f.name);
    flash(t("已下载"));
  }
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(w.code);
      flash(t("已复制"));
    } catch {
      /* 剪贴板不可用 */
    }
  }

  function onMessage(e: MessageEvent) {
    if (!frameEl || e.source !== frameEl.contentWindow) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || d.bw !== "w1" || d.n !== nonce) return;
    switch (d.type) {
      case "ready":
        ready = true;
        sentCode = null;
        post({ type: "theme", mode, vars: themeVars(root ?? null) });
        pushCode();
        break;
      case "size": {
        const nh = Math.max(0, Math.min(MAX_H, Math.ceil(Number(d.h) || 0)));
        if (nh > 0) {
          shown = true;
          blank = false;
        }
        if (nh !== h) {
          if (h > 0 || shown) animH = true;
          h = nh;
        }
        break;
      }
      case "done":
        if (!(h > 0)) blank = true; // 脚本都跑完了还是 0 高：没画出来
        break;
      case "prompt":
        onPrompt(d.text);
        break;
      case "link":
        openExternal(String(d.url ?? ""));
        break;
      case "download":
        void saveDataUrl(String(d.url ?? ""), d.name);
        break;
      case "snap": {
        const s = snapWait.get(Number(d.req));
        if (!s) break;
        snapWait.delete(Number(d.req));
        const b = dataUrlBlob(d.url);
        if (b) s.res(b);
        else s.rej(new Error(String(d.err || "snap failed")));
        break;
      }
      case "error":
        scriptErr = String(d.msg ?? "").slice(0, 300);
        console.warn("[widget]", w.title || item.id, scriptErr);
        break;
    }
  }
  onMount(() => {
    if (STATIC) return;
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  // —— 手机静态模式：shadow root ——
  let shadowVis: HTMLElement | null = null;
  let shadow: ShadowRoot | null = null;
  $effect(() => {
    if (!STATIC || !mounted || !hostEl || broken) return;
    if (!shadow) {
      shadow = hostEl.attachShadow({ mode: "open" });
      shadow.innerHTML =
        "<style>:host{display:block}" +
        shell.widgetCss({ root: ".wroot", dark: '.wroot[data-mode="dark"]', body: ".wroot" }) +
        ".wroot{position:relative;contain:layout paint;overflow:hidden}" +
        // 静态预览里控件点了没反应：别让它们看着能点
        ".wroot button,.wroot input,.wroot select,.wroot textarea,.wroot .node{pointer-events:none}.wroot button{opacity:.6}" +
        '</style><div class="wroot">' +
        shell.ARROW_DEFS +
        '<div class="vis"></div></div>';
      shadow.querySelector(".wroot")!.setAttribute("style", shell.styleText(themeRefs()));
      shadowVis = shadow.querySelector(".vis");
    }
    shadow.querySelector(".wroot")!.setAttribute("data-mode", mode);
    const clean = shell.sanitizeStatic(w.code);
    if (!shell.visibleMarkup(clean)) {
      blank = true; // 全靠脚本出内容的图：手机上看不了
      return;
    }
    if (shadowVis) shadowVis.innerHTML = clean;
    shown = true;
    blank = false;
  });
</script>

<figure class="wc" bind:this={root} aria-busy={!shown && !blank && !broken}>
  {#if broken}
    <div class="msg err">
      <span>{t("图表没有画出来")}</span>
      {#if w.code}<button class="link" onclick={() => (codeOpen = !codeOpen)}>{codeOpen ? t("收起代码") : t("查看代码")}</button>{/if}
    </div>
  {:else}
    {#if !shown && !reserved}
      {#if blank}
        <div class="msg" class:err={!STATIC} title={scriptErr || null}>
          <span>{STATIC ? t("这张图表要在电脑上查看") : t("图表没有画出来")}</span>
          <button class="link" onclick={() => (codeOpen = !codeOpen)}>{codeOpen ? t("收起代码") : t("查看代码")}</button>
        </div>
      {:else}
        <div class="msg" role="status"><Mark size={16} live /><span class="hx-shimmer">{ldText}</span></div>
      {/if}
    {/if}
    {#if hijacked}
      <div class="msg blocked" role="status">{t("图表试图跳转到别的网页，已拦截")}</div>
    {:else if mounted}
      {#if STATIC}
        <!-- .clip 是样式隔离边界：shadow 里的 :host / !important 够得着宿主，够不着这一层 -->
        <div class="clip" class:hidden={!shown && !reserved} style:min-height={reserved ? h + "px" : null}>
          <div bind:this={hostEl}></div>
        </div>
      {:else}
        <iframe
          bind:this={frameEl}
          class="frame"
          class:anim={animH}
          title={title || t("图表")}
          sandbox="allow-scripts"
          allow="clipboard-write"
          referrerpolicy="no-referrer"
          srcdoc={frameDoc()}
          onload={onFrameLoad}
          style:height={(shown || reserved ? h : 0) + "px"}
          style:color-scheme={mode}
        ></iframe>
      {/if}
    {:else if h > 0}
      <div style:height={h + "px"}></div>
    {/if}
    {#if shown}
      <figcaption class="cap">
        <span class="ttl" title={w.title}>{title || t("图表")}</span>
        {#if STATIC}<span class="aside">{t("手机上为静态预览")}</span>{/if}
        <span class="acts">
          {#if note}<span class="flash" role="status">{note}</span>{/if}
          {#if !STATIC}
            <IconButton icon="more" size={26} label={t("更多操作")} active={menuOpen} expanded={menuOpen} bind:el={moreBtn} onclick={() => (menuOpen = !menuOpen)} />
          {/if}
          <IconButton icon="code" size={26} label={codeOpen ? t("收起代码") : t("查看代码")} active={codeOpen} onclick={() => (codeOpen = !codeOpen)} />
        </span>
      </figcaption>
    {/if}
  {/if}
  {#if askText}
    <div class="ask" role="group" aria-label={t("图表想替你发送")}>
      <span class="ask-t">{t("图表想替你发送：")}<q>{askText}</q></span>
      <Button size="sm" variant="primary" onclick={confirmAsk}>{t("发送")}</Button>
      <Button size="sm" variant="ghost" onclick={() => (askText = "")}>{t("忽略")}</Button>
    </div>
  {/if}
  {#if queued}
    <div class="ask" role="status">
      <span class="ask-t">{t("这一轮结束后发送：")}<q>{queued}</q></span>
      <Button size="sm" variant="ghost" onclick={() => (queued = "")}>{t("取消")}</Button>
    </div>
  {/if}
  {#if notSent}
    <div class="ask" role="status">
      <span class="ask-t">{t("未发送：")}<q>{notSent}</q></span>
      <Button size="sm" variant="ghost" onclick={() => (notSent = "")}>{t("关闭")}</Button>
    </div>
  {/if}
  {#if codeOpen && w.code}
    <div class="code">
      <button class="copy" onclick={copyCode}>{t("复制")}</button>
      <pre>{w.code}</pre>
    </div>
  {/if}
</figure>

{#if menuOpen}
  <Popover anchor={moreBtn} onclose={() => (menuOpen = false)} align="end" minWidth={180}>
    <MenuItem icon="copy" label={t("复制为图片")} disabled={!ready} onclick={copyImage} />
    <MenuItem icon="image" label={t("下载为 PNG")} disabled={!ready} onclick={downloadPng} />
    <MenuItem icon="download" label={t("下载为 {kind}", { kind })} onclick={downloadSource} />
  </Popover>
{/if}

<style>
  /* 图表是回答的一部分：不加框、不加底，直接排在画布上；只有标题行与操作在下面一行小字 */
  .wc {
    margin: 2px 0 4px;
    padding: 0;
    min-width: 0;
  }
  /* color-scheme 与帧内一致：两边不一致时浏览器给 iframe 垫一层不透明底色 */
  .frame {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
  }
  .frame.anim {
    transition: height var(--t-med) var(--ease-out);
  }
  /* 静态预览的隔离边界：contain 让它成为 fixed 元素的包含块、按自身裁剪，isolation 不让 z-index 越出卡片 */
  .clip {
    position: relative;
    contain: layout paint;
    isolation: isolate;
    overflow: auto;
    max-height: 1800px;
  }
  .clip.hidden {
    display: none;
  }
  .msg {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    color: var(--text3);
    font-size: var(--fs-md);
  }
  .msg.err {
    color: var(--err);
  }
  .msg.blocked {
    padding: 10px 12px;
    border-radius: var(--r-sm);
    background: var(--surface2);
    color: var(--text2);
  }
  .link {
    color: var(--text3);
    text-decoration: underline;
    text-underline-offset: 2px;
    font-size: var(--fs-md);
  }
  .cap {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    margin-top: 4px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .ttl {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aside::before {
    content: "·";
    margin: 0 6px 0 2px;
  }
  .acts {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
    color: var(--text3);
  }
  .flash {
    margin-right: 6px;
  }
  .ask {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
    padding: 6px 6px 6px 12px;
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .ask-t {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ask-t q {
    color: var(--text);
  }
  .code {
    position: relative;
    margin-top: 6px;
    border-radius: var(--r-md);
    background: var(--code-bg);
    box-shadow: 0 0 0 1px var(--border);
  }
  .code pre {
    margin: 0;
    padding: 12px 14px;
    max-height: 360px;
    overflow: auto;
    font: var(--fs-sm) / 1.55 var(--font-mono);
    color: var(--text2);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .copy {
    position: absolute;
    top: 6px;
    right: 8px;
    padding: 2px 10px;
    border-radius: var(--r-pill);
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
    color: var(--text2);
    font-size: var(--fs-xs);
  }
  .copy:active {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .copy:hover {
      color: var(--text);
    }
  }
</style>
