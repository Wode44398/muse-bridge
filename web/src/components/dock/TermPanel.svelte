<script>
  // 终端面板：xterm.js 前端 + 后端工作空间 PTY（SSE 快照重放 + 实时增量）。
  // 断开重连不丢现场（服务端滚回缓冲）；输入 16ms 微批合并省请求；resize 双向同步。
  // xterm 按需加载（~250KB）：它此前是静态 import，被打进主 chunk，于是【每次启动】
  // 都要解析一遍——而终端是工作台 dock 里的功能，手机上绝大多数会话一次都不会打开。
  let Terminal = null, FitAddon = null;
  async function ensureXterm() {
    if (Terminal) return;
    const [core, fitMod] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),   // Vite 会把它变成一次样式表注入
    ]);
    Terminal = core.Terminal;
    FitAddon = fitMod.FitAddon;
  }
  import { api } from '../../lib/api.js';
  import { ui } from '../../lib/state.svelte.js';
  import { dock, readDockSse } from '../../lib/dock.svelte.js';
  import { t } from '../../lib/i18n.js';
  let { dockState = dock } = $props();

  let holder = $state();
  let exited = $state(false);
  let connecting = $state(true);
  let failMsg = $state('');
  let term = null, fit = null, stop = null, ro = null;
  let sendBuf = '', sendTimer = 0;
  let lastCR = { cols: 0, rows: 0 };
  const enc = encodeURIComponent;

  // xterm 主题从 Claude 分页 CSS 变量现取（明暗切换时跟随）。从终端自己所在的元素取：
  // 工作台卡片把 --bg 换成了卡片色，终端底色要跟卡片一致，不能读根上的页面底色。
  function palette() {
    const cs = getComputedStyle(holder || document.documentElement);
    const v = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
    const dark = ui.theme !== 'light';
    return {
      background: v('--bg', dark ? '#262624' : '#faf9f5'),
      foreground: v('--text', dark ? '#eee' : '#1a1915'),
      cursor: v('--coral', '#d97757'),
      cursorAccent: v('--bg', '#262624'),
      selectionBackground: dark ? 'rgba(217,119,87,.35)' : 'rgba(217,119,87,.28)',
      black: dark ? '#3a3a37' : '#4a4a45',
      brightBlack: '#8a8a84',
      red: '#e06c5f', brightRed: '#f0857a',
      green: '#7fb069', brightGreen: '#98c983',
      yellow: '#d9a05b', brightYellow: '#eab97a',
      blue: '#7aa2f7', brightBlue: '#93b6ff',
      magenta: '#bb9af7', brightMagenta: '#cdb3ff',
      cyan: '#6cb5c9', brightCyan: '#85cde0',
      white: dark ? '#d9d9d4' : '#5c5c56',
      brightWhite: dark ? '#f5f5f0' : '#1a1915',
    };
  }

  function queueSend(d) {
    sendBuf += d;
    if (sendTimer) return;
    sendTimer = setTimeout(() => {
      const payload = sendBuf;
      sendBuf = ''; sendTimer = 0;
      api.post('/api/claude/term/input', { ws: dockState.ws, d: payload }).catch(() => {});
    }, 16);
  }

  function syncResize() {
    if (!term) return;
    const { cols, rows } = term;
    if (cols === lastCR.cols && rows === lastCR.rows) return;
    lastCR = { cols, rows };
    api.post('/api/claude/term/resize', { ws: dockState.ws, cols, rows }).catch(() => {});
  }

  function connect() {
    stop?.();
    connecting = true; exited = false; failMsg = '';
    stop = readDockSse(`/api/claude/term/stream?ws=${enc(dockState.ws)}&cols=${term.cols}&rows=${term.rows}`, (ev) => {
      if (ev.type === 'hello') { connecting = false; syncResize(); }
      else if (ev.type === 'snapshot') { term.reset(); if (ev.d) term.write(ev.d); }
      else if (ev.type === 'data') term.write(ev.d || '');
      else if (ev.type === 'exit') exited = true;
    }, {
      onDead: (status) => { connecting = false; failMsg = status === 403 ? t('终端仅对完整权限用户开放') : t('连接失败'); },
      onClose: () => { if (!exited) { connecting = true; setTimeout(() => { if (term) connect(); }, 1500); } },
    });
  }

  async function restart() {
    await api.post('/api/claude/term/kill', { ws: dockState.ws }).catch(() => {});
    connect();
    term?.focus();
  }

  // 手机没有 Ctrl/Esc/方向键——快捷键行直发控制序列。
  const QUICK = [
    { label: 'Ctrl+C', d: '\x03' }, { label: 'Tab', d: '\t' }, { label: 'Esc', d: '\x1b' },
    { label: '↑', d: '\x1b[A' }, { label: '↓', d: '\x1b[B' }, { label: '←', d: '\x1b[D' }, { label: '→', d: '\x1b[C' },
  ];
  function quick(d) { queueSend(d); term?.focus(); }

  $effect(() => {
    if (!holder || !dockState.ws) return;
    // xterm 现在是按需加载 → 建终端这一段必须异步；期间面板已卸载/换了工作空间时
    // dead 为真，直接放弃（否则会往已经拆掉的 holder 上 open 一个孤儿终端）。
    let dead = false;
    const el = holder;
    (async () => {
      try { await ensureXterm(); } catch { failMsg = t('终端组件加载失败'); connecting = false; return; }
      if (dead) return;
      term = new Terminal({
        fontSize: 12.5,
        fontFamily: "Consolas, 'Cascadia Mono', Menlo, monospace",
        theme: palette(),
        cursorBlink: true,
        scrollback: 5000,
        convertEol: false,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      lastCR = { cols: 0, rows: 0 };
      term.onData(queueSend);
      connect();
      ro = new ResizeObserver(() => { try { fit.fit(); syncResize(); } catch {} });
      ro.observe(el);
    })();
    return () => {
      dead = true;
      stop?.(); stop = null;
      ro?.disconnect(); ro = null;
      if (sendTimer) { clearTimeout(sendTimer); sendTimer = 0; sendBuf = ''; }
      term?.dispose(); term = null; fit = null;
    };
  });

  // 明暗主题切换即时换 xterm 配色。
  $effect(() => { void ui.theme; if (term) term.options.theme = palette(); });
</script>

<div class="tm">
  <div class="tm-body" bind:this={holder}></div>
  {#if connecting && !failMsg}
    <div class="tm-veil"><span class="spin"></span>{t('连接终端…')}</div>
  {:else if failMsg}
    <div class="tm-veil">{failMsg}</div>
  {:else if exited}
    <div class="tm-veil">
      <div>{t('终端会话已结束')}</div>
      <button class="tm-restart" onclick={restart}>{t('重启终端')}</button>
    </div>
  {/if}
  <div class="tm-quick">
    {#each QUICK as k (k.label)}
      <button onclick={() => quick(k.d)}>{k.label}</button>
    {/each}
    <button class="tm-kill" onclick={restart} title={t('重启终端')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5"/></svg></button>
  </div>
</div>

<style>
  .tm { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; padding: 6px 6px 0; }
  .tm-body { flex: 1; min-height: 0; border-radius: 10px; overflow: hidden; background: var(--bg); padding: 6px 0 0 8px; }
  .tm-body :global(.xterm) { height: 100%; }
  .tm-body :global(.xterm-viewport) { background: transparent !important; }
  .tm-body :global(.xterm-viewport)::-webkit-scrollbar { width: 6px; }
  .tm-body :global(.xterm-viewport)::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 999px; }

  .tm-veil { position: absolute; inset: 6px 6px 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(2px); color: var(--muted); font-size: 14px; border-radius: 10px; }
  .tm-restart { padding: 7px 16px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 13.5px; font-weight: 600; }

  /* 窄卡片里一排放不下时横向滑（不露滚动条：桌面的 10px 滚动条会把这一排撑高一截） */
  .tm-quick { flex: none; display: flex; align-items: center; gap: 5px; padding: 6px 2px; overflow-x: auto; scrollbar-width: none; }
  .tm-quick::-webkit-scrollbar { display: none; }
  .tm-quick button { flex: none; padding: 5px 11px; border-radius: 8px; background: var(--hover); color: var(--serif); font-size: 12.5px;
    font-family: Consolas, 'Cascadia Mono', Menlo, monospace; transition: background-color .12s ease; }
  .tm-quick button:active { background: var(--hover-strong); }
  @media (hover: hover) { .tm-quick button:hover { background: var(--hover-strong); color: var(--text); } }
  .tm-kill { margin-left: auto; display: flex; align-items: center; justify-content: center; }
  .tm-kill svg { width: 14px; height: 14px; }

  .spin { width: 14px; height: 14px; border: 2px solid var(--divider); border-top-color: var(--coral); border-radius: 50%; animation: tmspin .8s linear infinite; }
  @keyframes tmspin { to { transform: rotate(360deg); } }
</style>
