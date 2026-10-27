<script>
  // 终端面板：xterm.js 前端 + 后端工作空间 PTY（SSE 快照重放 + 实时增量）。
  // 断开重连不丢现场（服务端滚回缓冲）；输入 16ms 微批合并省请求；resize 双向同步。
  // xterm 按需加载（~250KB）：它此前是静态 import，被打进主 chunk，于是【每次启动】
  // 都要解析一遍——而终端是工作台 dock 里的功能，手机上绝大多数会话一次都不会打开。
  // 离线 apk 同样受益：那是本地 parse/compile 成本，不是网络成本。
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
  import { untrack } from 'svelte';
  import { api } from '../../lib/api.js';
  import { ui } from '../../lib/state.svelte.js';
  import { dock, readDockSse } from '../../lib/dock.svelte.js';
  import { devices, loadDevices } from '../../lib/devices.svelte.js';
  import { t } from '../../lib/i18n.js';
  let { dockState = dock } = $props();

  let holder = $state();
  let exited = $state(false);
  let connecting = $state(true);
  let failMsg = $state('');
  let offline = $state(false);
  let term = null, fit = null, stop = null, ro = null;
  let sendBuf = '', sendTimer = 0;
  let lastCR = { cols: 0, rows: 0 };
  const enc = encodeURIComponent;

  // 终端开在哪：''= 服务器（工作空间，Claude 的 Bash 也在这里）| 设备 id = 我自己的电脑（经设备通道开 PTY，
  // 后端 routes/devices.mjs 的 /api/devices/term/*）。选哪台记在本机（只是这个浏览器的习惯）。
  const TARGET_KEY = 'bridge.termTarget';
  let target = $state((() => { try { return localStorage.getItem(TARGET_KEY) || ''; } catch { return ''; } })());
  let menuOpen = $state(false);
  // 能开终端的设备：在线、客户端报了 pty 能力、且不是 bridge 所在的那台（那台选「服务器」就是它）
  const termDevices = $derived(devices.list.filter((d) => d.online && !d.sameMachine && (d.client?.caps || []).includes('pty')));
  const dev = $derived(target ? devices.list.find((d) => d.id === target) || null : null);
  $effect(() => { if (!devices.loaded) loadDevices(); });
  // 选中的设备没了（被删除 / 换了账号）：回到服务器并忘掉这个选择。
  // 设备接口整个不可用（401/403/404 → enabled=false、列表空）时只是这一次回到服务器，不动记住的选择——
  // 那是登录态 / 服务端形态的问题，不是设备没了（10-21 回归 R7）。
  $effect(() => {
    if (!target || !devices.loaded || devices.list.some((d) => d.id === target)) return;
    untrack(() => pick('', devices.enabled));
  });
  // 设备离线时开终端（服务端 409）只会走 onDead、不自动重试：设备重新上线（总线把 online 翻成 true）就自己接回去。
  // 只认「离线 → 在线」这一下，否则在线状态下的其它失败（如无权限）会被这里无限重连。
  let devWasOnline = false;
  $effect(() => {
    const on = !!dev?.online;
    const was = devWasOnline;
    devWasOnline = on;
    if (on && !was && target) untrack(() => { if (term && failMsg) connect(); });
  });

  const ep = (k) => (target ? `/api/devices/term/${k}` : `/api/claude/term/${k}`);
  const who = () => (target ? { id: target } : { ws: dockState.ws });

  // remember=false：只换这一次的目标，localStorage 里记住的选择不动
  function pick(id, remember = true) {
    menuOpen = false;
    if (id === target) return;
    target = id;
    if (remember) { try { if (id) localStorage.setItem(TARGET_KEY, id); else localStorage.removeItem(TARGET_KEY); } catch { /* 隐私模式：只是不记住 */ } }
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = 0; sendBuf = ''; }
    if (term) { term.reset(); lastCR = { cols: 0, rows: 0 }; connect(); term.focus(); }
  }

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
      api.post(ep('input'), { ...who(), d: payload }).catch(() => {});
    }, 16);
  }

  function syncResize() {
    if (!term) return;
    const { cols, rows } = term;
    if (cols === lastCR.cols && rows === lastCR.rows) return;
    lastCR = { cols, rows };
    api.post(ep('resize'), { ...who(), cols, rows }).catch(() => {});
  }

  // 断流后的 1.5 秒重连计时器放在组件作用域：restart / 重试 / 切目标都会再调 connect()，
  // 计时器若留在旧闭包里清不掉，会在新流建好后再触发一次 connect()，把刚接上的流掐掉重连（10-21 回归 R7）。
  let closeRetry = 0;
  function connect() {
    clearTimeout(closeRetry);
    stop?.();
    connecting = true; exited = false; failMsg = ''; offline = false;
    const mine = target;
    const url = mine
      ? `/api/devices/term/stream?id=${enc(mine)}&cols=${term.cols}&rows=${term.rows}`
      : `/api/claude/term/stream?ws=${enc(dockState.ws)}&cols=${term.cols}&rows=${term.rows}`;
    stop = readDockSse(url, (ev) => {
      if (mine !== target) return;   // 刚切了目标，旧流的尾巴不要
      if (ev.type === 'hello') { connecting = false; offline = ev.state === 'offline'; syncResize(); }
      else if (ev.type === 'snapshot') { term.reset(); if (ev.d) term.write(ev.d); }
      else if (ev.type === 'data') term.write(ev.d || '');
      else if (ev.type === 'offline') offline = true;
      else if (ev.type === 'online') offline = false;
      else if (ev.type === 'exit') { exited = true; offline = false; if (ev.error) failMsg = ev.error; }
    }, {
      onDead: (status, body) => {
        connecting = false;
        failMsg = (body && body.error) || (status === 403 ? t('终端仅对完整权限用户开放') : t('连接失败'));
      },
      onClose: () => {
        if (exited || mine !== target) return;
        connecting = true;
        clearTimeout(closeRetry);
        closeRetry = setTimeout(() => { if (term && mine === target) connect(); }, 1500);
      },
    });
  }

  async function restart() {
    await api.post(ep('kill'), who()).catch(() => {});
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
      clearTimeout(closeRetry);
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
    <div class="tm-veil"><span class="spin"></span>{target ? t('正在连接「{name}」上的终端…', { name: dev?.name || '' }) : t('连接终端…')}</div>
  {:else if failMsg}
    <div class="tm-veil">
      <div class="tm-msg">{failMsg}</div>
      {#if target}<button class="tm-restart" onclick={() => connect()}>{t('重试')}</button>{/if}
    </div>
  {:else if offline}
    <div class="tm-veil"><span class="spin"></span>{t('「{name}」离线了，重新连上后自动接回', { name: dev?.name || '' })}</div>
  {:else if exited}
    <div class="tm-veil">
      <div>{t('终端会话已结束')}</div>
      <button class="tm-restart" onclick={restart}>{t('重启终端')}</button>
    </div>
  {/if}
  <div class="tm-bar">
    {#if termDevices.length || target}
      <div class="tm-target">
        <button class="tm-tgt" class:on={menuOpen} aria-haspopup="menu" aria-expanded={menuOpen} title={t('终端开在哪台机器上')} onclick={() => (menuOpen = !menuOpen)}>
          <span class="lbl">{dev ? dev.name : t('服务器')}</span>
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 6 4.5l3 3"/></svg>
        </button>
        {#if menuOpen}
          <div class="tm-menu" role="menu">
            <button role="menuitemradio" aria-checked={!target} onclick={() => pick('')}>
              <span class="lbl">{t('服务器')}</span><small>{t('工作空间，Claude 的命令也在这里跑')}</small>
            </button>
            {#each termDevices as d (d.id)}
              <button role="menuitemradio" aria-checked={target === d.id} onclick={() => pick(d.id)}>
                <span class="lbl">{d.name}</span><small>{t('我的电脑')}</small>
              </button>
            {/each}
            {#if dev && !termDevices.some((d) => d.id === dev.id)}
              <button role="menuitemradio" aria-checked="true" disabled>
                <span class="lbl">{dev.name}</span><small>{t('离线')}</small>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <div class="tm-quick">
      {#each QUICK as k (k.label)}
        <button onclick={() => quick(k.d)}>{k.label}</button>
      {/each}
      <button class="tm-kill" onclick={restart} title={t('重启终端')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5"/></svg></button>
    </div>
  </div>
</div>
<svelte:window onclick={(e) => { if (menuOpen && !e.target.closest?.('.tm-target')) menuOpen = false; }} />

<style>
  .tm { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; padding: 6px 6px 0; }
  .tm-body { flex: 1; min-height: 0; border-radius: 10px; overflow: hidden; background: var(--bg); padding: 6px 0 0 8px; }
  .tm-body :global(.xterm) { height: 100%; }
  .tm-body :global(.xterm-viewport) { background: transparent !important; }

  .tm-veil { position: absolute; inset: 6px 6px 44px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(2px); color: var(--muted); font-size: 14px; border-radius: 10px; }
  .tm-restart { padding: 7px 16px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 13.5px; font-weight: 600; }
  .tm-msg { max-width: 80%; text-align: center; line-height: 1.5; }

  /* 底栏：左边「终端开在哪」（不跟着按键行滑动，弹出菜单不被裁），右边按键行 */
  .tm-bar { flex: none; display: flex; align-items: center; gap: 5px; padding: 6px 2px; min-width: 0; }
  .tm-target { position: relative; flex: none; }
  .tm-tgt { display: flex; align-items: center; gap: 4px; padding: 5px 8px 5px 10px; border-radius: 8px; background: var(--hover); color: var(--serif);
    font-size: 12.5px; max-width: 150px; transition: background-color .12s ease; }
  .tm-tgt .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tm-tgt svg { width: 12px; height: 12px; flex: none; opacity: .7; }
  .tm-tgt.on, .tm-tgt:active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .tm-tgt:hover { background: var(--hover-strong); color: var(--text); } }
  .tm-menu { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 5; min-width: 220px; max-width: 280px; padding: 4px;
    border-radius: 12px; background: var(--card, var(--bg)); box-shadow: 0 0 0 1px var(--divider), 0 8px 24px rgba(0, 0, 0, .18); }
  .tm-menu button { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; border-radius: 8px;
    text-align: left; color: var(--text); font-size: 13px; }
  .tm-menu button small { color: var(--muted); font-size: 11.5px; }
  .tm-menu button[aria-checked="true"] { background: var(--hover); }
  .tm-menu button:disabled { opacity: .55; }
  @media (hover: hover) { .tm-menu button:not(:disabled):hover { background: var(--hover-strong); } }

  /* 窄卡片里一排放不下时横向滑（不露滚动条：桌面的 10px 滚动条会把这一排撑高一截） */
  .tm-quick { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; overflow-x: auto; scrollbar-width: none; }
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
