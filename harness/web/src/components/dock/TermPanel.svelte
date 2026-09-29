<script lang="ts">
  // 工作区「终端」：xterm.js 前端 + 后端工作空间 PTY（SSE：先重放快照，再实时增量）。
  //  · 断开 1.5 秒自动重连、不丢现场（服务端有滚回缓冲）；HTTP 明确拒绝（旧后端 404 / 403）落死态、不无脑重连；
  //  · 输入 16ms 微批合并成一次请求；行列变化才上行（去重）；
  //  · 配色从 .hxroot 的 CSS 变量现取（term-palette.ts），盯住主题根的 data-mode / style 变化即时换肤；
  //  · {#key ws} 会重建面板：终端、观察器、定时器、连接全部收干净（卸载时还没发出去的按键补发一次，不丢）。
  // 顶条：工作空间名（完整路径挂悬停）+ 连接小点 + 重启（常驻入口）。
  import { untrack } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import * as api from "../../lib/api.ts";
  import { handleDockShortcut } from "../../lib/state.svelte.ts";
  import { t } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Button from "../ui/Button.svelte";
  import Mark from "../brand/Mark.svelte";
  import { termTheme } from "./term-palette.ts";

  let { ws = "", chatId = "" }: { ws?: string; chatId?: string } = $props();
  const coarse = matchMedia("(pointer: coarse)").matches; // 触屏：顶条按钮放大到 40

  const wsName = $derived((ws || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");

  let holder: HTMLElement | undefined = $state();
  let connecting = $state(true);
  let greeted = $state(false); // 这次挂载里收到过 hello：之后的重连不再盖遮罩（画面还在，只是小点在等）
  let exited = $state(false);
  let failMsg = $state("");
  const live = $derived(!connecting && !exited && !failMsg);

  // ── 非响应式运行时（xterm 实例 / 连接 / 定时器不进 $state，免得深代理）──
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let abortCtl: AbortController | null = null;
  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;
  let reconnectTimer = 0;
  let sendBuf = "";
  let sendTimer = 0;
  let lastCR = { cols: 0, rows: 0 };
  let exitedFlag = false; // exited 的闭包镜像（Promise 回调里读最新值）
  let dead = false; // 已卸载：所有回调静默丢弃

  const scope = () => ({ ws, chatId });

  function themeRoot(): HTMLElement {
    return (holder?.closest(".hxroot") as HTMLElement | null) ?? document.documentElement;
  }
  function readVar(name: string): string {
    return getComputedStyle(themeRoot()).getPropertyValue(name).trim();
  }
  function applyTheme() {
    const theme = termTheme(readVar);
    if (term && theme) term.options.theme = theme;
  }

  // 输入 16ms 微批：连击合成一次 POST
  function queueSend(d: string) {
    sendBuf += d;
    if (sendTimer) return;
    sendTimer = window.setTimeout(flushSend, 16);
  }
  function flushSend() {
    const payload = sendBuf;
    sendBuf = "";
    sendTimer = 0;
    if (payload) api.dockTermInput(scope(), payload).catch(() => {});
  }

  // 行列变化才上行（初连 hello 已带一份，重复的不发）
  function syncResize() {
    if (!term) return;
    const { cols, rows } = term;
    if (cols === lastCR.cols && rows === lastCR.rows) return;
    lastCR = { cols, rows };
    api.dockTermResize(scope(), cols, rows).catch(() => {});
  }

  function markExited() {
    exitedFlag = true;
    exited = true;
    connecting = false;
  }

  function onStreamEvent(ev: any) {
    if (ev.e === "hello") {
      connecting = false;
      greeted = true;
      if (ev.exited) markExited(); // 重连上的是一个已退出的会话
      else syncResize();
    } else if (ev.e === "snapshot") {
      term?.reset();
      if (ev.d) term?.write(ev.d);
    } else if (ev.e === "data") {
      term?.write(ev.d || "");
    } else if (ev.e === "exit") {
      markExited();
    }
  }

  function connect() {
    abortCtl?.abort();
    const ctl = new AbortController();
    abortCtl = ctl;
    connecting = true;
    failMsg = "";
    api
      .dockTermStream(scope(), term?.cols ?? 80, term?.rows ?? 24, onStreamEvent, ctl.signal)
      .then(() => {
        if (dead || ctl.signal.aborted) return;
        if (!exitedFlag) scheduleReconnect(); // EOF 不是退出 → 1.5 秒重连（快照重放不丢现场）
      })
      .catch((e: any) => {
        if (dead || ctl.signal.aborted) return;
        // HTTP 明确拒绝：报原因落死态，不无脑重连（「重试」兜底）
        if (e?.status) {
          connecting = false;
          failMsg = e.status === 403 ? t("终端不可用（403）") : t("终端连接失败（HTTP {status}）", { status: e.status });
          return;
        }
        if (!exitedFlag) scheduleReconnect(); // 断流 ≠ 结束
        else connecting = false;
      });
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    connecting = true;
    reconnectTimer = window.setTimeout(() => {
      if (!dead && !exitedFlag) connect();
    }, 1500);
  }

  // 重启 = 杀掉 PTY 再连（下一条流起一个新 PTY）。清屏：新 PTY 没有滚回缓冲就不会来快照，旧输出会留在新提示符上面（§17-9）
  async function restart() {
    clearTimeout(reconnectTimer);
    exitedFlag = false;
    exited = false;
    failMsg = "";
    greeted = false;
    try {
      await api.dockTermKill(scope());
    } catch {
      /* 旧后端 / 会话刚没 */
    }
    if (dead) return;
    term?.reset();
    connect();
    term?.focus();
  }
  // 连接被拒之后的「重试」只重连、不杀 PTY——里面可能还跑着东西（§17-9）
  function retry() {
    clearTimeout(reconnectTimer);
    connect();
  }

  // 手机快捷键条：手机没有 Esc / Tab / Ctrl / 方向键——直发控制序列
  const QUICK = [
    { label: "Esc", d: "\x1b" },
    { label: "Tab", d: "\t" },
    { label: "Ctrl+C", d: "\x03" },
    { label: "↑", d: "\x1b[A" },
    { label: "↓", d: "\x1b[B" },
    { label: "←", d: "\x1b[D" },
    { label: "→", d: "\x1b[C" },
  ];
  function quick(d: string) {
    queueSend(d);
    term?.focus();
  }

  // 只随 holder 挂载 / 卸载：里面读到的 ws、chatId 不能成为依赖——换会话（同一工作空间）会把终端整个拆了重建
  $effect(() => {
    const el = holder;
    if (!el) return;
    return untrack(() => setup(el));
  });

  function setup(el: HTMLElement): () => void {
    dead = false;
    const fontSize = parseFloat(readVar("--fs-md")) || 13;
    const fontFamily = readVar("--font-mono") || "monospace";
    term = new Terminal({
      fontSize,
      fontFamily,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
    });
    applyTheme();
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* 隐藏态 fit 会抛 */
    }
    lastCR = { cols: 0, rows: 0 };
    term.onData(queueSend);
    // 工作区快捷键（Ctrl+` 等）在终端里照样管用：先交给它，认领了就不进 PTY（同 VS Code：Ctrl+` 在终端里也是收起）
    term.attachCustomKeyEventHandler((e) => !(e.type === "keydown" && handleDockShortcut(e)));
    connect();
    // 等宽字体（Dimensio Mono）没用过就还没下载：到了之后让 xterm 重量字宽（换一个等价的字体串才会触发），否则光标与字错位
    document.fonts
      ?.load(`${fontSize}px ${fontFamily}`)
      .then((faces) => {
        if (dead || !term || !faces.length) return;
        term.options.fontFamily = `${fontFamily}, monospace`;
        try {
          fit?.fit();
          syncResize();
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});
    ro = new ResizeObserver(() => {
      try {
        fit?.fit();
        syncResize();
      } catch {
        /* 隐藏态 fit 会抛 */
      }
    });
    ro.observe(el);
    // 明暗切换：主题根的 data-mode / style 一变就换肤
    mo = new MutationObserver(() => applyTheme());
    mo.observe(themeRoot(), { attributes: true, attributeFilter: ["data-mode", "style"] });
    return () => {
      dead = true;
      clearTimeout(reconnectTimer);
      abortCtl?.abort();
      abortCtl = null;
      ro?.disconnect();
      ro = null;
      mo?.disconnect();
      mo = null;
      // 还在 16ms 窗口里的按键补发出去（以前直接丢，§17-9）
      if (sendTimer) {
        clearTimeout(sendTimer);
        flushSend();
      }
      term?.dispose();
      term = null;
      fit = null;
    };
  }
</script>

<div class="tm">
  <div class="bar">
    <span class="ic"><Icon name="terminal" size={15} /></span>
    <span class="name" title={ws}>{wsName || t("终端")}</span>
    <span
      class="dot"
      class:on={live}
      class:wait={connecting && !failMsg}
      class:warn={exited}
      class:bad={!!failMsg}
      title={failMsg || (exited ? t("终端已退出") : connecting ? t("连接终端…") : undefined)}
    ></span>
    <span class="sp"></span>
    <IconButton icon="reload" label={t("重启终端")} size={coarse ? 40 : 30} iconSize={16} onclick={restart} />
  </div>
  <div class="stage">
    <div class="holder" bind:this={holder}></div>
    {#if failMsg}
      <div class="veil">
        <p>{failMsg}</p>
        <Button size="sm" variant="secondary" icon="reload" onclick={retry}>{t("重试")}</Button>
      </div>
    {:else if exited}
      <div class="veil">
        <span class="veil-ic"><Icon name="terminal" size={22} stroke={1.5} /></span>
        <p>{t("终端已退出")}</p>
        <Button size="sm" variant="primary" onclick={restart}>{t("重启终端")}</Button>
      </div>
    {:else if connecting && !greeted}
      <div class="veil">
        <Mark size={18} live />
        <p>{t("连接终端…")}</p>
      </div>
    {/if}
  </div>
  <div class="keys" role="toolbar" aria-label={t("终端快捷键")}>
    {#each QUICK as k (k.label)}
      <!-- 按下不抢焦点：软键盘不收起，按键直接进终端 -->
      <button class="key" onpointerdown={(e) => e.preventDefault()} onclick={() => quick(k.d)}>{k.label}</button>
    {/each}
  </div>
</div>

<style>
  .tm {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 calc(6px + var(--hx-pane-r, 0px)) 0 14px;
    color: var(--text3);
  }
  .ic {
    display: inline-flex;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text2);
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border2);
    transition: background-color var(--t-med) var(--ease);
  }
  .dot.on {
    background: var(--live);
  }
  .dot.wait {
    background: var(--text3);
    animation: hx-breathe 1.4s var(--ease-in-out) infinite;
  }
  .dot.warn {
    background: var(--warn);
  }
  .dot.bad {
    background: var(--err);
  }
  .sp {
    flex: 1;
  }

  /* xterm 占满：边到边，--code-bg 一块凹面 */
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--code-bg);
  }
  .holder {
    flex: 1;
    min-height: 0;
    padding: 8px 4px 2px 12px;
  }
  .holder :global(.xterm) {
    height: 100%;
  }
  .holder :global(.xterm-viewport) {
    background: transparent !important;
  }
  @media (pointer: fine) {
    .holder :global(.xterm-viewport)::-webkit-scrollbar {
      width: 6px;
    }
    .holder :global(.xterm-viewport)::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--text3) 38%, transparent);
      border-radius: 999px;
    }
  }
  .veil {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    background: color-mix(in srgb, var(--code-bg) 86%, transparent);
    color: var(--text3);
    text-align: center;
  }
  .veil p {
    margin: 0;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .veil-ic {
    display: inline-flex;
  }

  /* 手机快捷键条（精确指针的设备上不显示） */
  .keys {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .keys::-webkit-scrollbar {
    display: none;
  }
  .key {
    flex: none;
    min-width: 44px;
    height: 40px;
    padding: 0 12px;
    border-radius: var(--r-sm);
    background: var(--surface2);
    color: var(--text2);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .key:active {
    background: var(--surface3);
    color: var(--text);
  }
  @media (pointer: fine) {
    .keys {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.wait {
      animation: none;
    }
  }
</style>
