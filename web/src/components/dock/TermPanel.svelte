<script>
  // 终端面板：xterm.js 前端 + 后端 PTY（服务器工作空间，或经设备通道开在「我的电脑」上；SSE 快照重放 + 实时增量）。
  // 断开重连不丢现场（服务端滚回缓冲）；输入 16ms 微批合并省请求；行列变化才上行。
  //
  // 两套操作方式，按指针精度分（pointer.fine）：
  //  · 电脑（鼠标 + 实体键盘）：键盘直接打进终端。Ctrl+C 有选区时是复制、没有才是中断；Ctrl+V 粘贴；
  //    Ctrl +/−/0 与 Ctrl+滚轮调字号；右键菜单（复制 / 粘贴 / 全选 / 清屏）；Ctrl+点击网址打开
  //    （本机地址进工作台浏览器——它也在服务器上，localhost 才对得上）。
  //  · 触屏（2026-11-13 重做，维护者反馈「手机上大部分操作做不了、点下面的按键一直弹键盘」）：
  //    - 终端区盖一层手势层（lib/termTouch.js）：单指滚动带惯性、双指缩放字号、点网址弹菜单、长按进「选择文本」；
  //      点一下【不会】弹键盘——xterm 的隐藏输入框不再被手指聚焦。
  //    - 底下是原生输入行：输入法（中文、联想）、长按粘贴、光标编辑都是系统原生的，回车整行发出；
  //      Tab 补全时先把输入行的字送进终端再按 Tab。有本地历史（↑ 键或时钟按钮）。
  //    - 按键条：Esc / Tab / Ctrl / ^C / 方向键（按住连发），⋯ 展开 Alt、^D ^Z ^L ^R、Home / End / 翻页和难打的符号。
  //      Ctrl / Alt 是粘滞键：点一下对下一个键生效，双击锁住。按键【不抢焦点】：输入行开着键盘就继续开着，
  //      没开就不会因为点了按键弹出来。
  //    - 「直接键盘」模式（输入行左边的键盘钮）：按键直接进终端，给 vim / less / Claude Code 这类全屏程序用。
  //
  // xterm 按需加载（~250KB）：它此前是静态 import，被打进主 chunk，于是【每次启动】都要解析一遍——
  // 而终端是工作台 dock 里的功能，手机上绝大多数会话一次都不会打开。离线 apk 同样受益。
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
  import { untrack, tick, setContext } from 'svelte';
  import { api } from '../../lib/api.js';
  import { ui } from '../../lib/state.svelte.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { dock, readDockSse, dockToolOk, openDock, openCodexDock, browserSessionOf } from '../../lib/dock.svelte.js';
  import { devices, loadDevices } from '../../lib/devices.svelte.js';
  import { openExternalUrl } from '../../lib/pluginUi.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { guardSelection } from '../../lib/touchSelection.js';
  import { edgeAutoScroll } from '../../lib/touchAutoScroll.js';
  import { keySeq, applyMods, findUrls, isLocalUrl, pushHistory } from '../../lib/termKeys.js';
  import { termTouch, cellAt, logicalLine, bufferText } from '../../lib/termTouch.js';
  import MorphMenu from '../ios27/MorphMenu.svelte';
  import { t, tr } from '../../lib/i18n.js';
  let { dockState = dock } = $props();

  // 触屏上的菜单（终端开在哪 / 网址 / 历史）用 ios27 液态玻璃菜单（触屏浮层一律苹果材质；电脑端扁平）
  setContext('ios27', { get dark() { return ui.theme !== 'light'; } });

  const coarse = $derived(!pointer.fine);
  const MONO = "Consolas, 'Cascadia Mono', ui-monospace, Menlo, 'Roboto Mono', 'Noto Sans Mono', 'Droid Sans Mono', monospace";

  // —— 本机习惯（只是这个浏览器的偏好）——
  const ls = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set(k, v) { try { if (v == null || v === '') localStorage.removeItem(k); else localStorage.setItem(k, String(v)); } catch { /* 隐私模式：只是不记住 */ } },
  };

  let rootEl = $state(), holder = $state();
  let exited = $state(false);
  let connecting = $state(true);
  let greeted = $state(false);   // 这次连上过：之后断线重连不再盖遮罩（画面还在，左下角小点在等）
  let failMsg = $state('');
  let offline = $state(false);
  let ready = $state(false);     // xterm 建好了（手势层 / 按键条要用它）
  let term = null, fit = null, stop = null, ro = null;
  let sendBuf = '', sendTimer = 0, resizeTimer = 0;
  let lastCR = { cols: 0, rows: 0 };
  const enc = encodeURIComponent;

  // 终端开在哪：''= 服务器（工作空间，Claude 的 Bash 也在这里）| 设备 id = 我自己的电脑（经设备通道开 PTY，
  // 后端 routes/devices.mjs 的 /api/devices/term/*）。
  const TARGET_KEY = 'bridge.termTarget';
  let target = $state(ls.get(TARGET_KEY));
  let menuOpen = $state(false);
  let tgtBtn = $state();
  // 能开终端的设备：在线、客户端报了 pty 能力、且不是 bridge 所在的那台（那台选「服务器」就是它）
  const termDevices = $derived(devices.list.filter((d) => d.online && !d.sameMachine && (d.client?.caps || []).includes('pty')));
  const dev = $derived(target ? devices.list.find((d) => d.id === target) || null : null);
  const canPick = $derived(termDevices.length > 0 || !!target);
  $effect(() => { if (!devices.loaded) loadDevices(); });
  // 选中的设备没了（被删除 / 换了账号）：回到服务器并忘掉这个选择。
  // 设备接口整个不可用（401/403/404 → enabled=false、列表空）时只是这一次回到服务器，不动记住的选择（10-21 回归 R7）。
  $effect(() => {
    if (!target || !devices.loaded || devices.list.some((d) => d.id === target)) return;
    untrack(() => pick('', devices.enabled));
  });
  // 设备离线时开终端（服务端 409）只会走 onDead、不自动重试：设备重新上线就自己接回去（只认「离线 → 在线」这一下）。
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
    if (remember) ls.set(TARGET_KEY, id);
    if (sendTimer) { clearTimeout(sendTimer); sendTimer = 0; sendBuf = ''; }
    if (term) { term.reset(); lastCR = { cols: 0, rows: 0 }; replaying = false; greeted = false; connect(); focusTermIfDesk(); }
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

  // —— 上行：输入微批 / 行列同步 ——
  function flushSend() {
    const payload = sendBuf;
    sendBuf = ''; sendTimer = 0;
    if (payload) api.post(ep('input'), { ...who(), d: payload }).catch(() => {});
  }
  function queueSend(d) {
    if (!d) return;
    sendBuf += d;
    if (!sendTimer) sendTimer = setTimeout(flushSend, 16);
  }
  // 用户主动发的输入：顺手滚回底部（xterm 只对它自己收到的按键这么做）
  function sendKey(d) {
    if (!d) return;
    queueSend(d);
    term?.scrollToBottom();
  }
  function syncResize() {
    if (!term) return;
    const { cols, rows } = term;
    if (cols === lastCR.cols && rows === lastCR.rows) return;
    lastCR = { cols, rows };
    api.post(ep('resize'), { ...who(), cols, rows }).catch(() => {});
  }
  // 本地立刻重排，PTY 的 resize 稍后合并发（键盘弹起 / 收起会连着来好几帧尺寸变化，每帧都让 shell 重绘没必要）
  function refit(now = false) {
    if (!term || !fit || replaying) return;
    try { fit.fit(); } catch { /* 卡片被藏起来时量不到尺寸 */ }
    clearTimeout(resizeTimer);
    if (now) syncResize(); else resizeTimer = setTimeout(syncResize, 120);
  }

  // 断流后的 1.5 秒重连计时器放在组件作用域：restart / 重试 / 切目标都会再调 connect()，
  // 计时器若留在旧闭包里清不掉，会在新流建好后再触发一次 connect()，把刚接上的流掐掉重连（10-21 回归 R7）。
  let closeRetry = 0;
  // 快照按 PTY 当前的行列重放：快照是服务端屏幕镜像按 PTY 此刻行列序列化出来的（src/runtime/term-mirror.mjs；
  // 老服务端则是原始输出字节），按面板现在的尺寸直接写会错位、复行（键盘开合 / 换卡片后重连最常见）。
  // 所以先把终端临时调成 hello 报的行列，写完再适配回面板、把尺寸同步给 PTY。重放期间 ResizeObserver 的 refit 先忍着。
  let srvCR = null, replaying = false, helloFit = 0;
  function connect() {
    clearTimeout(closeRetry);
    stop?.();
    connecting = true; exited = false; failMsg = ''; offline = false; replaying = false;
    const mine = target;
    const url = mine
      ? `/api/devices/term/stream?id=${enc(mine)}&cols=${term.cols}&rows=${term.rows}`
      : `/api/claude/term/stream?ws=${enc(dockState.ws)}&cols=${term.cols}&rows=${term.rows}`;
    stop = readDockSse(url, (ev) => {
      if (mine !== target) return;   // 刚切了目标，旧流的尾巴不要
      if (ev.type === 'hello') {
        connecting = false; greeted = true; offline = ev.state === 'offline';
        srvCR = ev.cols > 0 && ev.rows > 0 ? { cols: ev.cols, rows: ev.rows } : null;
        // Windows 的 PTY 是 ConPTY：和服务端镜像用同一份兼容设置（改尺寸时不丢行，见 src/runtime/term-mirror.mjs）
        try { term.options.windowsPty = ev.pty && ev.pty.backend ? { backend: ev.pty.backend, buildNumber: +ev.pty.buildNumber || undefined } : {}; } catch { /* 老版本 xterm 不认 */ }
        lastCR = srvCR ? { ...srvCR } : { cols: 0, rows: 0 };   // PTY 眼下就是这个尺寸：一样就不必再发 resize
        // 没有快照（新开的壳）：直接按面板尺寸同步；有快照的等重放完再同步（服务端 hello 与快照同一拍发出）
        clearTimeout(helloFit);
        helloFit = setTimeout(() => refit(true), 60);
      } else if (ev.type === 'snapshot') {
        clearTimeout(helloFit);
        replaying = true;
        term.reset();
        if (srvCR && (srvCR.cols !== term.cols || srvCR.rows !== term.rows)) { try { term.resize(srvCR.cols, srvCR.rows); } catch { /* 尺寸越界：照面板尺寸重放 */ } }
        term.write(ev.d || '', () => {
          replaying = false;
          if (mine !== target || !term) return;
          refit(true);
          term.scrollToBottom();
        });
      }
      else if (ev.type === 'data') term.write(ev.d || '');
      else if (ev.type === 'offline') offline = true;
      else if (ev.type === 'online') offline = false;
      else if (ev.type === 'exit') { exited = true; offline = false; if (ev.error) failMsg = ev.error; }
    }, {
      onDead: (status, body) => {
        connecting = false;
        failMsg = (body && body.error) ? tr(String(body.error)) : (status === 403 ? t('终端仅对完整权限用户开放') : t('连接失败'));
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
    focusTermIfDesk();
  }

  const status = $derived(failMsg ? 'fail' : exited ? 'exit' : offline ? 'off' : connecting ? 'wait' : 'live');
  const statusText = $derived(
    status === 'fail' ? failMsg : status === 'exit' ? t('终端会话已结束') : status === 'off' ? t('离线') : status === 'wait' ? t('连接中…') : t('已连接'));

  // —— 字号（电脑 / 触屏各记一份）——
  const FONT_MIN = 9, FONT_MAX = 24, FONT_DEF = 12.5;
  const fontKey = () => (coarse ? 'bridge.termFont.touch' : 'bridge.termFont');
  const clampFont = (n) => Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n * 2) / 2));
  let fontSize = $state(FONT_DEF);
  $effect.pre(() => {
    const k = fontKey();
    untrack(() => { const n = parseFloat(ls.get(k)); fontSize = n >= FONT_MIN && n <= FONT_MAX ? n : FONT_DEF; });
  });
  function setFont(n) {
    const v = clampFont(n);
    if (v === fontSize) return;
    fontSize = v;
    ls.set(fontKey(), v === FONT_DEF ? '' : v);
    if (term) { term.options.fontSize = v; refit(); }
  }

  // —— 输入方式（触屏）——
  let direct = $state(ls.get('bridge.termDirect') === '1');
  let moreKeys = $state(ls.get('bridge.termMoreKeys') === '1');
  let typing = $state(false);           // 输入行有焦点
  // 软键盘真弹出来了（可视视口比屏幕矮一大截）：打字时工具行收起，给终端让地方。
  // 接了实体键盘的平板聚焦输入行不弹软键盘，就不收——收起会多改一次尺寸，ConPTY 每次改尺寸都要整屏重绘。
  let kbOpen = $state(false);
  $effect(() => {
    const vv = window.visualViewport;
    if (!vv || !coarse) return;
    const upd = () => { kbOpen = vv.height < (window.screen?.height || vv.height) * 0.72; };
    upd();
    vv.addEventListener('resize', upd);
    return () => vv.removeEventListener('resize', upd);
  });
  let inputEl = $state();
  let line = $state('');
  let prevLine = '';
  // xterm 的隐藏输入框：触屏的输入行模式下标 inputmode=none——万一被聚焦也不弹键盘
  function applyInputMode() {
    const ta = term?.textarea;
    if (!ta) return;
    if (coarse && !direct) ta.setAttribute('inputmode', 'none');
    else ta.removeAttribute('inputmode');
  }
  $effect(() => { void coarse; void direct; if (ready) untrack(applyInputMode); });
  function setDirect(on) {
    direct = on;
    ls.set('bridge.termDirect', on ? '1' : '');
    applyInputMode();
    if (on) term?.focus();
    else term?.blur();
  }
  function focusTermIfDesk() { if (!coarse || direct) term?.focus(); }

  // 粘滞修饰键：0 关 / 1 用一次（下一个键用完自动松开）/ 2 锁定（双击）
  let mods = $state({ ctrl: 0, alt: 0 });
  let modTap = { k: '', at: 0 };
  function toggleMod(k) {
    const now = Date.now();
    const dbl = modTap.k === k && now - modTap.at < 320;
    modTap = { k, at: now };
    mods[k] = mods[k] === 2 ? 0 : dbl ? 2 : mods[k] ? 0 : 1;
  }
  const modsOn = () => !!(mods.ctrl || mods.alt);
  function takeMods() {
    const m = { ctrl: !!mods.ctrl, alt: !!mods.alt };
    if (mods.ctrl === 1) mods.ctrl = 0;
    if (mods.alt === 1) mods.alt = 0;
    return m;
  }

  // 按键条：按下时记一笔——按键钮万一把焦点抢走了（个别 WebView 不认 pointerdown 上的 preventDefault），
  // 输入行 / xterm 的 blur 回调据此把焦点还回去，键盘不会因此收起又弹出。
  let keyDownAt = 0;
  const keepFocus = (e) => { keyDownAt = performance.now(); e.preventDefault(); };
  const MAIN_KEYS = [
    { id: 'esc', label: 'Esc', nav: 'esc' },
    { id: 'tab', label: 'Tab', tab: true },
    { id: 'ctrl', label: 'Ctrl', mod: 'ctrl' },
    { id: 'cc', label: '^C', raw: '\x03', aria: 'Ctrl+C' },
    { id: 'left', label: '←', nav: 'left', rep: true, aria: '←' },
    { id: 'up', label: '↑', nav: 'up', rep: true, aria: '↑' },
    { id: 'down', label: '↓', nav: 'down', rep: true, aria: '↓' },
    { id: 'right', label: '→', nav: 'right', rep: true, aria: '→' },
  ];
  const MORE_KEYS = [
    { id: 'alt', label: 'Alt', mod: 'alt' },
    { id: 'cd', label: '^D', raw: '\x04', aria: 'Ctrl+D' },
    { id: 'cz', label: '^Z', raw: '\x1a', aria: 'Ctrl+Z' },
    { id: 'cl', label: '^L', raw: '\x0c', aria: 'Ctrl+L' },
    { id: 'cr', label: '^R', raw: '\x12', aria: 'Ctrl+R' },
    { id: 'home', label: 'Home', nav: 'home' },
    { id: 'end', label: 'End', nav: 'end' },
    { id: 'pgup', label: 'PgUp', nav: 'pgup' },
    { id: 'pgdn', label: 'PgDn', nav: 'pgdn' },
    ...['|', '~', '/', '\\', '-', '_', '`', '$', '&', '>', '*', ':', '='].map((ch) => ({ id: 'ch' + ch, label: ch, ch })),
  ];
  function press(k) {
    if (k.mod) { toggleMod(k.mod); return; }
    if (k.raw) { sendKey(k.raw); return; }
    if (k.tab) { pressTab(); return; }
    if (k.nav) { const m = takeMods(); sendKey(keySeq(k.nav, { ...m, app: !!term?.modes?.applicationCursorKeysMode })); return; }
    if (k.ch) {
      // 输入行模式下符号键是「打字」：插进输入行光标处；带着 Ctrl / Alt 或直接键盘模式时才直发终端
      if (!direct && !modsOn()) { insertIntoLine(k.ch); return; }
      sendKey(applyMods(k.ch, takeMods()));
    }
  }
  // Tab 补全：输入行里有字就先把它送进终端（不回车），再按 Tab——补全由 shell 做，结果显示在终端里
  function pressTab() {
    const m = takeMods();
    if (!direct && line) { const s = line; setLine(''); queueSend(s.replace(/\r?\n/g, '\r')); }
    sendKey(keySeq('tab', m));
  }
  // 方向键按住连发
  let repT = 0, repI = 0;
  function repStart(e, k) {
    keepFocus(e);
    repStop();
    press(k);
    repT = setTimeout(() => { repI = setInterval(() => press(k), 55); }, 380);
  }
  function repStop() { clearTimeout(repT); clearInterval(repI); repT = repI = 0; }

  // —— 输入行 ——
  const HIST_KEY = 'bridge.termHist';
  let hist = $state((() => { try { const a = JSON.parse(ls.get(HIST_KEY) || '[]'); return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []; } catch { return []; } })());
  let histIdx = -1, histDraft = '';
  let histOpen = $state(false);
  let histBtn = $state();
  function autoGrow() {
    const el = inputEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, 116) + 'px';   // +2 = 上下边框（border-box）
  }
  function setLine(v, caret = -1) {
    line = v; prevLine = v;
    if (inputEl) inputEl.value = v;
    tick().then(() => {
      autoGrow();
      if (caret >= 0 && inputEl) { try { inputEl.setSelectionRange(caret, caret); } catch { /* 没焦点时有的内核会抛 */ } }
    });
  }
  function insertIntoLine(s) {
    const el = inputEl;
    const a = el?.selectionStart ?? line.length, b = el?.selectionEnd ?? line.length;
    setLine(line.slice(0, a) + s + line.slice(b), a + s.length);
  }
  function submit() {
    const text = line;
    if (text.trim()) { hist = pushHistory(hist, text); ls.set(HIST_KEY, JSON.stringify(hist)); }
    histIdx = -1;
    setLine('');
    sendKey(text.replace(/\r?\n/g, '\r') + '\r');
  }
  function histStep(d) {
    if (histIdx === -1) { if (d > 0) return; histDraft = line; histIdx = hist.length; }
    const n = histIdx + d;
    if (n < 0) return;
    if (n >= hist.length) { histIdx = -1; setLine(histDraft, histDraft.length); }
    else { histIdx = n; setLine(hist[n], hist[n].length); }
  }
  function useHist(s) {
    histIdx = -1;
    setLine(s, s.length);
    // 菜单收起时会把焦点带走：等它收完再聚焦输入行（手机上这一下就弹出键盘，接着改或直接回车）
    setTimeout(() => { inputEl?.focus(); try { inputEl?.setSelectionRange(s.length, s.length); } catch { /* 同上 */ } }, 60);
  }
  function onLineKey(e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (e.key === 'Tab') { e.preventDefault(); pressTab(); return; }
    if (e.key === 'Escape') { e.preventDefault(); sendKey('\x1b'); return; }
    // 实体键盘（平板接了键盘）：Ctrl+字母发给终端；复制（有选区）/ 粘贴 / 全选 / 剪切 / 撤销留给输入框
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const k = e.key.toLowerCase();
      const sel = inputEl.selectionStart !== inputEl.selectionEnd;
      if ('vaxzy'.includes(k) || (k === 'c' && sel)) return;
      e.preventDefault();
      sendKey(applyMods(k, { ctrl: true }));
      return;
    }
    // ↑ / ↓：光标在第一行 / 最后一行时翻输入行历史
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && hist.length) {
      const v = inputEl.value, pos = inputEl.selectionStart ?? 0;
      if (e.key === 'ArrowUp' && !v.slice(0, pos).includes('\n')) { e.preventDefault(); histStep(-1); }
      else if (e.key === 'ArrowDown' && !v.slice(pos).includes('\n') && histIdx !== -1) { e.preventDefault(); histStep(1); }
    }
  }
  function onLineInput(e) {
    const el = e.currentTarget;
    const v = el.value;
    const pos = el.selectionStart ?? v.length;
    // 粘滞 Ctrl / Alt 等着：这次打进来的那个字不进输入行，换成组合键发给终端（组字中的交给 compositionend）
    if (modsOn() && !e.isComposing && v.length > prevLine.length) {
      const added = v.length - prevLine.length;
      const ch = [...v.slice(Math.max(0, pos - added), pos)][0];
      if (ch) {
        el.value = prevLine;
        try { el.setSelectionRange(pos - added, pos - added); } catch { /* 同上 */ }
        sendKey(applyMods(ch, takeMods()));
        return;
      }
    }
    // 有的输入法回车不发 keydown（keyCode 229），只往框里插一个换行：当作发送
    const it = e.inputType || '';
    if ((it === 'insertLineBreak' || it === 'insertParagraph') && v[pos - 1] === '\n') {
      line = v.slice(0, pos - 1) + v.slice(pos);
      submit();
      return;
    }
    line = v; prevLine = v; histIdx = -1;
    autoGrow();
  }
  function onCompEnd(e) {
    if (!modsOn() || !e.data) return;
    const el = inputEl, v = el.value, pos = el.selectionStart ?? v.length, start = pos - e.data.length;
    if (start >= 0 && v.slice(start, pos) === e.data) { el.value = v.slice(0, start) + v.slice(pos); line = prevLine = el.value; }
    sendKey(applyMods([...e.data][0], takeMods()));
  }
  function onLineBlur() {
    // 被按键条抢走的焦点：还回来（键盘保持开着）
    if (performance.now() - keyDownAt < 400 && !direct) { requestAnimationFrame(() => inputEl?.focus({ preventScroll: true })); return; }
    typing = false;
  }

  // —— 复制 / 粘贴 / 清屏 ——
  async function copyText(s) {
    if (!s) return false;
    try { await navigator.clipboard.writeText(s); return true; } catch { /* WebView / 非安全源：退回 execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
  async function copySel() {
    const s = term?.getSelection() || '';
    if (!s) { showToast(t('先选中要复制的文字')); return; }
    if (await copyText(s)) { term.clearSelection(); showToast(t('已复制')); }
    else showToast(t('复制失败'), 'err');
    focusTermIfDesk();
  }
  async function paste() {
    let s = '';
    try { s = await navigator.clipboard.readText(); } catch { /* 安卓 WebView 不给读剪贴板 */ }
    if (s) {
      // 触屏输入行模式：贴进输入行，看一眼再回车（整段多行命令直接贴进终端会立刻执行）
      if (coarse && !direct) { insertIntoLine(s); inputEl?.focus(); }
      else { term?.paste(s); focusTermIfDesk(); }
      return;
    }
    if (coarse) {
      if (direct) setDirect(false);
      await tick();
      inputEl?.focus();
      showToast(t('读不到剪贴板：在输入行里长按，选「粘贴」'));
    } else showToast(t('读不到剪贴板，请按 Ctrl+V 粘贴'));
  }
  function clearScreen() {
    term?.clear();
    sendKey('\x0c');   // Ctrl+L：让 shell 自己清屏重画提示符（PSReadLine / bash 都认）
    focusTermIfDesk();
  }

  // —— 选择文本（触屏）：把缓冲区当纯文本铺出来，用系统自己的长按选择 / 复制 ——
  let selText = $state(null);
  let selFrac = 1;
  let selScroll = $state(), selPre = $state();
  function openSel() {
    if (!term) return;
    linkPop = null; histOpen = false; menuOpen = false;
    if (typing) inputEl?.blur();
    const b = term.buffer.active;
    selFrac = b.length ? Math.min(1, (b.viewportY + term.rows) / b.length) : 1;
    selText = bufferText(term);
  }
  $effect(() => {
    const sc = selScroll, pre = selPre;
    if (!sc || !pre) return;
    untrack(() => { sc.scrollTop = Math.max(0, selFrac * sc.scrollHeight - sc.clientHeight); });
    // 触屏长选区护栏（拖柄时固定端滚出可视区会被浏览器误命中到别处）+ 拖到边缘自动滚
    const offG = guardSelection(pre, { scroller: () => sc });
    const offS = edgeAutoScroll(pre, { scroller: () => sc });
    return () => { offG(); offS(); };
  });
  async function copyPicked() {
    const s = window.getSelection?.()?.toString() || '';
    if (!s) { showToast(t('先长按选中文字')); return; }
    if (await copyText(s)) { showToast(t('已复制')); window.getSelection()?.removeAllRanges(); }
    else showToast(t('复制失败'), 'err');
  }
  async function copyAll() {
    if (await copyText(selText || '')) showToast(t('已复制全部输出'));
    else showToast(t('复制失败'), 'err');
  }

  // —— 网址 ——
  const canDockBrowser = () => !target && !!dockState.ws && (dockState === dock ? dockToolOk('browser') : dockState.meta?.shell !== false);
  async function openInDock(url) {
    const u = url.replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1127.0.0.1');
    try {
      const narrow = coarse && window.innerWidth < 700;
      await api.post('/api/claude/browser/navigate', { ws: dockState.ws, session: browserSessionOf(dockState), url: u, ...(narrow ? { preset: 'mobile' } : {}) });
    } catch (e) { showToast(tr(String(e?.body?.error || '')) || t('打开失败'), 'err'); return; }
    if (dockState === dock) openDock('browser'); else openCodexDock('browser');
  }
  function openLink(url) {
    if (isLocalUrl(url) && canDockBrowser()) openInDock(url);
    else openExternalUrl(url);
  }
  // 触屏点网址：先问去哪
  let linkPop = $state(null);   // { url, pt }
  const linkItems = $derived.by(() => {
    const p = linkPop;
    if (!p) return [];
    const local = isLocalUrl(p.url);
    const out = [];
    if (canDockBrowser()) out.push({ label: t('在工作台浏览器打开'), symbol: 'globe', onclick: () => openInDock(p.url) });
    // 开在服务器的终端里打的本机地址，手机自己的浏览器够不着
    if (!(local && !target)) out.push({ label: t('用系统浏览器打开'), symbol: 'arrow.up.forward.app', onclick: () => openExternalUrl(p.url) });
    out.push({ label: t('复制链接'), symbol: 'link', onclick: async () => { if (await copyText(p.url)) showToast(t('已复制')); } });
    return out;
  });
  // 屏幕坐标上的网址（触屏命中放宽：上下各半行再试一次，手指没那么准）
  function linkAt(x, y) {
    if (!term) return null;
    const scr = term.element?.querySelector('.xterm-screen');
    const h = scr && term.rows ? scr.clientHeight / term.rows : 16;
    for (const dy of [0, -h * 0.55, h * 0.55]) {
      const c = cellAt(term, x, y + dy);
      if (!c) continue;
      const L = logicalLine(term, c.line);
      for (const u of findUrls(L.text)) {
        for (let i = u.start; i < u.end; i++) {
          const a = L.at[i];
          if (a && a[0] === c.line && Math.abs(a[1] - c.col) <= 1) return u.url;
        }
      }
    }
    return null;
  }
  // 电脑：xterm 链接识别（悬停下划线，Ctrl+点击打开）。按逻辑行找，折行的长网址整条都算。
  function linkProvider() {
    return {
      provideLinks(y, cb) {
        if (!term) return cb(undefined);
        const idx = y - 1;
        const L = logicalLine(term, idx);
        const links = [];
        for (const u of findUrls(L.text)) {
          const a = L.at[u.start], b = L.at[u.end - 1];
          if (!a || !b || b[0] < idx || a[0] > idx) continue;
          const w = term.buffer.active.getLine(b[0])?.getCell(b[1])?.getWidth() || 1;
          links.push({
            range: { start: { x: a[1] + 1, y: a[0] + 1 }, end: { x: b[1] + w, y: b[0] + 1 } },
            text: u.url,
            decorations: { pointerCursor: true, underline: true },
            activate: (ev, text) => { if (ev.ctrlKey || ev.metaKey) openLink(text); },
            hover: () => { if (holder) holder.title = t('按住 Ctrl 点击打开'); },
            leave: () => { if (holder) holder.title = ''; },
          });
        }
        cb(links.length ? links : undefined);
      },
    };
  }

  // —— 触屏手势 ——
  let pinchBase = FONT_DEF;
  function onTap(x, y) {
    histOpen = false; menuOpen = false; moreOpen = false;
    if (linkPop) { linkPop = null; return; }
    const url = linkAt(x, y);
    if (url) { linkPop = { url, pt: { x, y } }; return; }
    if (direct) { term?.focus(); return; }      // 直接键盘模式：点终端就是要打字
    if (typing) { keyDownAt = 0; inputEl?.blur(); }   // 输入行模式：点输出收起键盘（聊天 App 的习惯）
  }
  function onPinch(s, phase, mid) {
    const el = term?.element;
    if (!el) return;
    if (phase === 'start') {
      pinchBase = fontSize;
      const r = el.getBoundingClientRect();
      el.style.transformOrigin = mid ? `${mid.x - r.left}px ${mid.y - r.top}px` : '0 0';
      return;
    }
    const k = clampFont(pinchBase * s) / pinchBase;
    if (phase === 'move') { el.style.transform = `scale(${k})`; return; }
    el.style.transform = '';
    el.style.transformOrigin = '';
    setFont(pinchBase * k);
  }

  // —— 电脑：右键菜单 ——
  let ctx = $state(null);   // { x, y, sel }
  function onCtx(e) {
    if (coarse || !term || !holder?.contains(e.target)) return;
    e.preventDefault();
    const r = rootEl.getBoundingClientRect();
    ctx = { x: Math.min(e.clientX - r.left, r.width - 172), y: Math.min(e.clientY - r.top, r.height - 160), sel: term.hasSelection() };
  }
  function ctxDo(fn) { ctx = null; fn(); }

  // —— 回到底部 ——
  let scrolledUp = $state(false);
  let hasSel = $state(false);
  function updScroll() {
    const b = term?.buffer.active;
    const up = !!b && b.viewportY < b.baseY;
    if (up !== scrolledUp) scrolledUp = up;
  }

  // —— 建终端 ——
  $effect(() => {
    if (!holder || !dockState.ws) return;
    // xterm 是按需加载 → 建终端这一段必须异步；期间面板已卸载/换了工作空间时 dead 为真，直接放弃
    let dead = false;
    const el = holder;
    (async () => {
      try { await ensureXterm(); } catch { failMsg = t('终端组件加载失败'); connecting = false; return; }
      if (dead) return;
      term = new Terminal({
        fontSize: untrack(() => fontSize),
        fontFamily: MONO,
        theme: palette(),
        cursorBlink: true,
        scrollback: 5000,
        convertEol: false,
        rightClickSelectsWord: false,
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      lastCR = { cols: 0, rows: 0 };
      // 直接键盘模式 / 电脑上叠粘滞修饰键（输入法一次上屏一串时原样发）
      term.onData((d) => queueSend(modsOn() ? applyMods(d, takeMods()) : d));
      // 用户自己滚（滚轮 / 手势层的合成滚轮）时 xterm 的 onScroll 是静默的（suppressScrollEvent），要听视口的 DOM scroll
      term.onScroll(updScroll);
      term.onWriteParsed(updScroll);
      term.element?.querySelector('.xterm-viewport')?.addEventListener('scroll', updScroll, { passive: true });
      term.onSelectionChange(() => { hasSel = !!term?.hasSelection(); });
      term.registerLinkProvider(linkProvider());
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown' || e.altKey || !(e.ctrlKey || e.metaKey)) return true;
        const k = (e.key || '').toLowerCase();
        if (k === 'c' && (e.shiftKey || term.hasSelection())) { e.preventDefault(); copySel(); return false; }
        // 交给浏览器：它在 xterm 的输入框上派 paste 事件，xterm 自己处理（括号粘贴模式、换行）；别再发 ^V
        if (k === 'v') return false;
        if (k === '=' || k === '+') { e.preventDefault(); setFont(fontSize + 1); return false; }
        if (k === '-' && !e.shiftKey) { e.preventDefault(); setFont(fontSize - 1); return false; }
        if (k === '0' && !e.shiftKey) { e.preventDefault(); setFont(FONT_DEF); return false; }
        return true;
      });
      // Ctrl+滚轮 / 触控板捏合 = 字号（攒够一格才动，触控板一次捏合会来几十个事件）
      let zoomAcc = 0;
      term.attachCustomWheelEventHandler((e) => {
        if (!e.ctrlKey) return true;
        e.preventDefault();
        zoomAcc += e.deltaY;
        if (Math.abs(zoomAcc) >= 40) { setFont(fontSize + (zoomAcc < 0 ? 1 : -1)); zoomAcc = 0; }
        return false;
      });
      // 直接键盘模式下 xterm 的输入框被按键条抢了焦点：还回去
      term.textarea?.addEventListener('blur', () => {
        if (coarse && direct && performance.now() - keyDownAt < 400) requestAnimationFrame(() => term?.focus());
      });
      applyInputMode();
      try { fit.fit(); } catch { /* 量不到尺寸 */ }
      ready = true;
      connect();
      ro = new ResizeObserver(() => refit());
      ro.observe(el);
    })();
    return () => {
      dead = true;
      ready = false;
      clearTimeout(closeRetry); clearTimeout(resizeTimer); clearTimeout(helloFit); repStop();
      stop?.(); stop = null;
      ro?.disconnect(); ro = null;
      if (sendTimer) { clearTimeout(sendTimer); flushSend(); }   // 卸载时还没发出去的按键补发，不丢
      term?.dispose(); term = null; fit = null;
    };
  });

  // 明暗主题切换即时换 xterm 配色。
  $effect(() => { void ui.theme; if (term) term.options.theme = palette(); });

  // 工具行字形：和工作台图标同一套线稿（24 栅格、1.7 线宽、圆角端点；见 lib/dockIcons.js）
  const SV = (body, sw = 1.7) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const IC = {
    copy: SV('<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="3"/><path d="M15.5 8.5V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5.5a3 3 0 0 0 3 3h1.5"/>'),
    paste: SV('<path d="M9 5H7.6A2.6 2.6 0 0 0 5 7.6v9.8A2.6 2.6 0 0 0 7.6 20h8.8a2.6 2.6 0 0 0 2.6-2.6V7.6A2.6 2.6 0 0 0 16.4 5H15"/><rect x="9" y="3.5" width="6" height="3.5" rx="1.4"/>'),
    aSmall: SV('<path d="M8.3 17 12 8.2l3.7 8.8M9.6 14h4.8"/>', 2),
    aLarge: SV('<path d="M6.2 19 12 5l5.8 14M8.4 14h7.2"/>', 1.8),
    more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.8" cy="12" r="1.65"/><circle cx="12" cy="12" r="1.65"/><circle cx="18.2" cy="12" r="1.65"/></svg>',
    clear: SV('<path d="M4.5 6.5h15M4.5 11.5h9M4.5 16.5h6"/><path d="m15.5 14.5 4 4m0-4-4 4"/>'),
    restart: SV('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>'),
    keyboard: SV('<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M8.5 14.5h7"/><path d="M7 10.2h0M10.3 10.2h0M13.7 10.2h0M17 10.2h0" stroke-width="2.3"/>'),
    history: SV('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/><path d="M12 8.5V12l2.6 1.6"/>'),
    enter: SV('<path d="M9.5 9.5 5 14l4.5 4.5"/><path d="M19 5v5a4 4 0 0 1-4 4H5"/>', 1.9),
    chevron: SV('<path d="m7 10 5 5 5-5"/>', 1.9),
    down: SV('<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>', 1.9),
  };
  let moreOpen = $state(false);
  let moreBtn = $state();
  const moreItems = $derived([
    { label: t('清屏'), icon: IC.clear, onclick: clearScreen },
    { label: t('重启终端'), icon: IC.restart, onclick: restart },
  ]);

  // 触屏菜单
  const tgtItems = $derived([
    { label: t('服务器'), symbol: 'server.rack', detail: t('工作空间，Claude 的命令也在这里跑'), checked: !target, onclick: () => pick('') },
    ...termDevices.map((d) => ({ label: d.name, symbol: 'desktopcomputer', detail: t('我的电脑'), checked: target === d.id, onclick: () => pick(d.id) })),
    ...(dev && !termDevices.some((d) => d.id === dev.id) ? [{ label: dev.name, symbol: 'desktopcomputer', detail: t('离线'), checked: true, disabled: true }] : []),
  ]);
  const histItems = $derived(hist.length
    ? [...hist].reverse().slice(0, 12).map((s) => ({ label: s.length > 60 ? s.slice(0, 58) + '…' : s, onclick: () => useHist(s) }))
    : [{ label: t('还没有发过命令'), disabled: true }]);

  function onKeyWin(e) {
    if (e.key !== 'Escape') return;
    if (ctx) { ctx = null; e.stopPropagation(); }
    else if (selText != null) { selText = null; e.stopPropagation(); }
  }
</script>

<svelte:window onclick={(e) => {
  if (menuOpen && !coarse && !e.target.closest?.('.tm-target')) menuOpen = false;
  if (ctx && !e.target.closest?.('.tm-ctx')) ctx = null;
  if (moreOpen && !coarse && !e.target.closest?.('.tm-morewrap')) moreOpen = false;
}} onkeydown={onKeyWin} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tm" class:touch={coarse} class:typing class:kb={kbOpen} bind:this={rootEl} oncontextmenu={onCtx}>
  <div class="tm-screen" style:--tm-font="{fontSize}px">
    <div class="tm-body" bind:this={holder}></div>
    {#if coarse && ready}
      <!-- 手势层：滚动 / 缩放 / 点按 / 长按全归它，手指碰终端不再弹键盘；data-sheet-nodrag：下拉是滚动，不是收起工作台 -->
      <div class="tm-touch" data-sheet-nodrag use:termTouch={{ term: () => term, onTap, onLongPress: openSel, onPinch }}></div>
    {/if}
    {#if scrolledUp && selText == null}
      <button class="tm-tobottom" aria-label={t('回到底部')} title={t('回到底部')} onpointerdown={keepFocus} onclick={() => { term?.scrollToBottom(); focusTermIfDesk(); }}>
        {@html IC.down}
      </button>
    {/if}

    {#if selText != null}
      <div class="tm-sel" data-sheet-nodrag>
        <div class="tm-sel-bar">
          <span class="tm-sel-hint">{t('长按文字选择')}</span>
          <button onclick={copyPicked}>{t('复制所选')}</button>
          <button onclick={copyAll}>{t('复制全部')}</button>
          <button class="pri" onclick={() => (selText = null)}>{t('完成')}</button>
        </div>
        <div class="tm-sel-scroll" bind:this={selScroll}>
          {#if selText}<pre class="tm-sel-text sel-text" bind:this={selPre}>{selText}</pre>
          {:else}<div class="tm-sel-empty">{t('终端里还没有内容')}</div>{/if}
        </div>
      </div>
    {/if}

    {#if (connecting && !greeted && !failMsg) || failMsg || offline || exited}
      <div class="tm-veil">
        {#if failMsg}
          <div class="tm-msg">{failMsg}</div>
          {#if target}<button class="tm-restart" onclick={() => connect()}>{t('重试')}</button>{/if}
        {:else if offline}
          <div class="tm-wait"><span class="spin"></span>{t('「{name}」离线了，重新连上后自动接回', { name: dev?.name || '' })}</div>
        {:else if exited}
          <div>{t('终端会话已结束')}</div>
          <button class="tm-restart" onclick={restart}>{t('重启终端')}</button>
        {:else}
          <div class="tm-wait"><span class="spin"></span>{target ? t('正在连接「{name}」上的终端…', { name: dev?.name || '' }) : t('连接终端…')}</div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- 工具行：左边「终端开在哪」+ 连接状态，右边复制 / 粘贴 / 清屏 / 字号 / 重启 -->
  <div class="tm-tools">
    <div class="tm-target">
      <button class="tm-tgt" class:on={menuOpen} class:static={!canPick} bind:this={tgtBtn} aria-haspopup={canPick ? 'menu' : undefined} aria-expanded={canPick ? menuOpen : undefined}
        title={canPick ? t('终端开在哪台机器上') : statusText} onpointerdown={keepFocus} onclick={() => { if (canPick) menuOpen = !menuOpen; }}>
        <span class="tm-dot {status}" title={statusText}></span>
        <span class="lbl">{dev ? dev.name : t('服务器')}</span>
        {#if canPick}<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5 6 4.5l3 3"/></svg>{/if}
      </button>
      {#if menuOpen && !coarse}
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
    <div class="tm-acts">
      {#if coarse}
        <button class="tm-ib" aria-label={t('选择文本')} title={t('选择文本')} onclick={openSel}>{@html IC.copy}</button>
      {:else}
        <button class="tm-ib" aria-label={t('复制')} title={t('复制（Ctrl+C）')} disabled={!hasSel} onclick={copySel}>{@html IC.copy}</button>
      {/if}
      <button class="tm-ib" aria-label={t('粘贴')} title={coarse ? t('粘贴') : t('粘贴（Ctrl+V）')} onpointerdown={keepFocus} onclick={paste}>{@html IC.paste}</button>
      <!-- 字号：小 A / 大 A 一组（触屏上双指捏合也行） -->
      <div class="tm-fontset" role="group" aria-label={t('字号')}>
        <button class="tm-fs" aria-label={t('缩小字号')} title={coarse ? t('缩小字号') : t('缩小字号（Ctrl+−）')} disabled={fontSize <= FONT_MIN} onpointerdown={keepFocus} onclick={() => setFont(fontSize - 1)}>{@html IC.aSmall}</button>
        <span class="tm-fs-sep" aria-hidden="true"></span>
        <button class="tm-fs" aria-label={t('放大字号')} title={coarse ? t('放大字号') : t('放大字号（Ctrl+=）')} disabled={fontSize >= FONT_MAX} onpointerdown={keepFocus} onclick={() => setFont(fontSize + 1)}>{@html IC.aLarge}</button>
      </div>
      <!-- 清屏 / 重启收进「更多」：重启会结束正在跑的程序，不该一下就点到 -->
      <div class="tm-morewrap">
        <button class="tm-ib" class:on={moreOpen} bind:this={moreBtn} aria-label={t('更多')} aria-haspopup="menu" aria-expanded={moreOpen}
          onpointerdown={keepFocus} onclick={() => (moreOpen = !moreOpen)}>{@html IC.more}</button>
        {#if moreOpen && !coarse}
          <div class="tm-menu tm-moremenu" role="menu">
            <button role="menuitem" onclick={() => { moreOpen = false; clearScreen(); }}><span class="mi">{@html IC.clear}</span><span class="lbl">{t('清屏')}</span><kbd>Ctrl+L</kbd></button>
            <button role="menuitem" onclick={() => { moreOpen = false; restart(); }}><span class="mi">{@html IC.restart}</span><span class="lbl">{t('重启终端')}</span></button>
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if coarse}
    <!-- 按键条：pointerdown 上 preventDefault = 不抢焦点（输入行的键盘开着就继续开着，没开也不会弹） -->
    <div class="tm-keys main" role="toolbar" aria-label={t('终端按键')}>
      {#each MAIN_KEYS as k (k.id)}
        {#if k.rep}
          <button class="tm-k arrow" aria-label={k.aria || k.label} onmousedown={(e) => e.preventDefault()}
            onpointerdown={(e) => repStart(e, k)} onpointerup={repStop} onpointercancel={repStop} onpointerleave={repStop}
            oncontextmenu={(e) => e.preventDefault()}>{k.label}</button>
        {:else}
          <button class="tm-k" class:armed={k.mod && mods[k.mod] === 1} class:locked={k.mod && mods[k.mod] === 2}
            aria-label={k.aria || k.label} aria-pressed={k.mod ? !!mods[k.mod] : undefined}
            onmousedown={(e) => e.preventDefault()} onpointerdown={keepFocus} onclick={() => press(k)}>{k.label}</button>
        {/if}
      {/each}
      <button class="tm-k tm-more" class:on={moreKeys} aria-label={t('更多按键')} aria-expanded={moreKeys}
        onmousedown={(e) => e.preventDefault()} onpointerdown={keepFocus}
        onclick={() => { moreKeys = !moreKeys; ls.set('bridge.termMoreKeys', moreKeys ? '1' : ''); }}>
        {@html IC.chevron}
      </button>
    </div>
    {#if moreKeys}
      <div class="tm-keys more" role="toolbar" aria-label={t('更多按键')}>
        {#each MORE_KEYS as k (k.id)}
          <button class="tm-k" class:armed={k.mod && mods[k.mod] === 1} class:locked={k.mod && mods[k.mod] === 2} class:sym={!!k.ch}
            aria-label={k.aria || k.label} aria-pressed={k.mod ? !!mods[k.mod] : undefined}
            onmousedown={(e) => e.preventDefault()} onpointerdown={keepFocus} onclick={() => press(k)}>{k.label}</button>
        {/each}
      </div>
    {/if}

    <div class="tm-compose">
      <button class="tm-cb tm-kbd" class:on={direct} aria-pressed={direct} aria-label={direct ? t('切回输入行') : t('直接键盘：按键直接发给终端')}
        title={direct ? t('切回输入行') : t('直接键盘：按键直接发给终端')} onmousedown={(e) => e.preventDefault()} onpointerdown={keepFocus} onclick={() => setDirect(!direct)}>
        {@html IC.keyboard}
      </button>
      {#if direct}
        <button class="tm-direct" onmousedown={(e) => e.preventDefault()} onclick={() => term?.focus()}>
          <span class="t1">{t('直接键盘')}</span><span class="t2">{t('按键直接发给终端，适合 vim、Claude Code 这类全屏程序；点这里弹出键盘')}</span>
        </button>
      {:else}
        <textarea class="tm-line" bind:this={inputEl} rows="1" value={line}
          placeholder={t('输入命令，回车执行')} aria-label={t('输入命令')}
          enterkeyhint="send" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"
          onkeydown={onLineKey} oninput={onLineInput} oncompositionend={onCompEnd}
          onfocus={() => { typing = true; histOpen = false; }} onblur={onLineBlur}></textarea>
        <button class="tm-cb" bind:this={histBtn} class:on={histOpen} aria-label={t('最近的命令')} title={t('最近的命令')}
          onmousedown={(e) => e.preventDefault()} onpointerdown={keepFocus} onclick={() => (histOpen = !histOpen)}>
          {@html IC.history}
        </button>
        <button class="tm-cb tm-send" aria-label={line ? t('执行') : t('回车')} title={line ? t('执行') : t('回车')}
          onmousedown={(e) => e.preventDefault()} onpointerdown={keepFocus} onclick={submit}>
          {@html IC.enter}
        </button>
      {/if}
    </div>

    <MorphMenu open={menuOpen && canPick} anchor={tgtBtn} width={260} title={t('终端开在哪台机器上')} items={tgtItems} onclose={() => (menuOpen = false)} />
    <MorphMenu open={!!linkPop} point={linkPop?.pt || null} width={260} title={linkPop?.url || ''} items={linkItems} onclose={() => (linkPop = null)} />
    <MorphMenu open={histOpen} anchor={histBtn} width={280} title={t('最近的命令')} items={histItems} onclose={() => (histOpen = false)} />
    <MorphMenu open={moreOpen} anchor={moreBtn} width={230} items={moreItems} onclose={() => (moreOpen = false)} />
  {/if}

  {#if ctx}
    <div class="tm-menu tm-ctx" role="menu" style="left:{ctx.x}px;top:{ctx.y}px">
      <button role="menuitem" disabled={!ctx.sel} onclick={() => ctxDo(copySel)}><span class="lbl">{t('复制')}</span><kbd>Ctrl+C</kbd></button>
      <button role="menuitem" onclick={() => ctxDo(paste)}><span class="lbl">{t('粘贴')}</span><kbd>Ctrl+V</kbd></button>
      <button role="menuitem" onclick={() => ctxDo(() => { term?.selectAll(); term?.focus(); })}><span class="lbl">{t('全选')}</span></button>
      <div class="tm-sep"></div>
      <button role="menuitem" onclick={() => ctxDo(clearScreen)}><span class="lbl">{t('清屏')}</span></button>
    </div>
  {/if}
</div>

<style>
  .tm { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; padding: 6px 6px 0; background: var(--bg); }
  .tm-screen { flex: 1; min-height: 0; position: relative; border-radius: 10px; overflow: hidden; background: var(--bg); }
  /* 内边距用 inset 给：全站 border-box 下 FitAddon 量的是父元素的 border-box 高度，padding 会让最后一行被裁掉半截 */
  .tm-body { position: absolute; inset: 6px 2px 2px 8px; }
  .tm-body :global(.xterm) { height: 100%; }
  .tm-body :global(.xterm-viewport) { background: transparent !important; }
  .tm-touch { position: absolute; inset: 0; z-index: 2; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }

  .tm-tobottom { position: absolute; right: 12px; bottom: 12px; z-index: 4; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    background: var(--card, var(--bg)); color: var(--text); box-shadow: 0 0 0 1px var(--divider), 0 6px 18px rgba(0, 0, 0, .22); animation: tmFade .16s ease; }
  .tm-tobottom :global(svg) { width: 18px; height: 18px; }
  @keyframes tmFade { from { opacity: 0; transform: translateY(4px); } }

  .tm-veil { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(2px); color: var(--muted); font-size: 14px; }
  .tm-wait { display: flex; align-items: center; gap: 10px; padding: 0 24px; text-align: center; line-height: 1.5; }
  .tm-restart { padding: 7px 16px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 13.5px; font-weight: 600; }
  .tm-msg { max-width: 80%; text-align: center; line-height: 1.5; }

  /* —— 选择文本（触屏）—— */
  .tm-sel { position: absolute; inset: 0; z-index: 6; display: flex; flex-direction: column; background: var(--bg); animation: tmFade .14s ease; }
  .tm-sel-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 10px; border-bottom: 1px solid var(--divider); }
  .tm-sel-hint { flex: 1; min-width: 0; color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tm-sel-bar button { flex: none; height: 32px; padding: 0 11px; border-radius: 9px; background: var(--hover); color: var(--serif); font-size: 13px; }
  .tm-sel-bar button:active { background: var(--hover-strong); }
  .tm-sel-bar button.pri { background: var(--text); color: var(--bg); font-weight: 600; }
  .tm-sel-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 8px 10px 24px; }
  .tm-sel-text { margin: 0; font-family: Consolas, 'Cascadia Mono', ui-monospace, Menlo, 'Roboto Mono', 'Noto Sans Mono', 'Droid Sans Mono', monospace;
    font-size: var(--tm-font, 12.5px); line-height: 1.45; color: var(--text); white-space: pre-wrap; word-break: break-all; }
  .tm-sel-empty { padding: 40px 0; text-align: center; color: var(--muted); font-size: 13.5px; }

  /* —— 工具行 —— */
  .tm-tools { flex: none; display: flex; align-items: center; gap: 6px; padding: 5px 0 5px 0; min-width: 0; }
  .tm-target { position: relative; flex: 0 1 auto; min-width: 0; }
  .tm-tgt { display: flex; align-items: center; gap: 6px; padding: 5px 8px 5px 9px; border-radius: 8px; background: var(--hover); color: var(--serif);
    font-size: 12.5px; max-width: 170px; min-width: 0; transition: background-color .12s ease; }
  .tm-tgt .lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tm-tgt svg { width: 12px; height: 12px; flex: none; opacity: .7; }
  .tm-tgt.static { background: none; padding-left: 4px; cursor: default; }
  .tm-tgt:not(.static).on, .tm-tgt:not(.static):active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .tm-tgt:not(.static):hover { background: var(--hover-strong); color: var(--text); } }
  .tm-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ok); }
  .tm-dot.wait { background: var(--warn); animation: tmPulse 1.1s ease-in-out infinite; }
  .tm-dot.off { background: var(--warn); }
  .tm-dot.exit { background: var(--muted); }
  .tm-dot.fail { background: var(--crit); }
  @keyframes tmPulse { 50% { opacity: .3; } }

  .tm-menu { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 8; min-width: 220px; max-width: 280px; padding: 4px;
    border-radius: 12px; background: var(--card, var(--bg)); box-shadow: 0 0 0 1px var(--divider), 0 8px 24px rgba(0, 0, 0, .18); }
  .tm-menu button { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; border-radius: 8px;
    text-align: left; color: var(--text); font-size: 13px; }
  .tm-menu button small { color: var(--muted); font-size: 11.5px; }
  .tm-menu button[aria-checked="true"] { background: var(--hover); }
  .tm-menu button:disabled { opacity: .45; }
  @media (hover: hover) { .tm-menu button:not(:disabled):hover { background: var(--hover-strong); } }
  .tm-ctx { bottom: auto; min-width: 168px; }
  .tm-ctx button { flex-direction: row; align-items: center; justify-content: space-between; gap: 18px; }
  .tm-ctx kbd { font: 11.5px/1 Consolas, 'Cascadia Mono', Menlo, monospace; color: var(--muted); }
  .tm-sep { height: 1px; margin: 4px 6px; background: var(--divider); }

  .tm-acts { margin-left: auto; flex: none; display: flex; align-items: center; gap: 2px; }
  .tm-ib { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none;
    transition: background-color .12s ease, color .12s ease, opacity .12s ease; }
  .tm-ib :global(svg) { width: 17px; height: 17px; }
  .tm-ib:disabled { opacity: .32; }
  .tm-ib.on, .tm-ib:not(:disabled):active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .tm-ib:not(:disabled):hover { background: var(--hover); color: var(--text); } }
  /* 字号：一枚胶囊里小 A / 大 A，中间一根细分隔 */
  .tm-fontset { display: flex; align-items: center; height: 30px; margin: 0 2px; border-radius: 8px; background: var(--hover); }
  .tm-fs { width: 30px; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--serif); border-radius: 8px; transition: background-color .12s ease, opacity .12s ease; }
  .tm-fs :global(svg) { width: 18px; height: 18px; }
  .tm-fs:disabled { opacity: .3; }
  .tm-fs:not(:disabled):active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .tm-fs:not(:disabled):hover { background: var(--hover-strong); color: var(--text); } }
  .tm-fs-sep { width: 1px; height: 14px; background: var(--divider); flex: none; }
  .tm-morewrap { position: relative; }
  .tm-moremenu { left: auto; right: 0; min-width: 176px; }
  .tm-moremenu button { flex-direction: row; align-items: center; gap: 10px; }
  .tm-moremenu .lbl { flex: 1; }
  .tm-moremenu .mi { width: 16px; height: 16px; display: flex; color: var(--muted); }
  .tm-moremenu .mi :global(svg) { width: 100%; height: 100%; }
  .tm-moremenu kbd { font: 11.5px/1 Consolas, 'Cascadia Mono', Menlo, monospace; color: var(--muted); }

  /* —— 触屏：按键条 + 输入行 —— */
  .touch .tm-tools { padding: 4px 0 6px; }
  .touch .tm-ib { width: 38px; height: 36px; border-radius: 11px; }
  .touch .tm-ib :global(svg) { width: 19px; height: 19px; }
  .touch .tm-fontset { height: 36px; border-radius: 11px; margin: 0 3px; }
  .touch .tm-fs { width: 38px; border-radius: 11px; }
  .touch .tm-fs :global(svg) { width: 20px; height: 20px; }
  .touch .tm-tgt { padding: 7px 10px 7px 10px; font-size: 13px; border-radius: 10px; }
  .touch .tm-tgt.static { padding-left: 6px; }
  /* 打字时（软键盘开着）工具行让位：屏幕本来就被键盘吃掉一半 */
  .touch.typing.kb .tm-tools { display: none; }

  .tm-keys { flex: none; display: flex; gap: 4px; padding: 0 0 6px; }
  .tm-keys.main > .tm-k { flex: 1 1 0; min-width: 0; }
  .tm-keys.main > .tm-more { flex: 0 0 38px; }
  /* 右缘渐隐：被截住的键一看就知道还能横滑（同工作台 chip 条） */
  .tm-keys.more { overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain; padding-right: 14px;
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 22px), transparent); }
  .tm-keys.more::-webkit-scrollbar { display: none; }
  .tm-keys.more > .tm-k { flex: none; min-width: 44px; padding: 0 10px; }
  .tm-keys.more > .tm-k.sym { min-width: 38px; padding: 0 6px; font-size: 15px; }
  .tm-k { height: 38px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: var(--hover); color: var(--serif);
    font: 500 13px/1 Consolas, 'Cascadia Mono', ui-monospace, Menlo, 'Roboto Mono', monospace; white-space: nowrap;
    touch-action: manipulation; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; transition: background-color .1s ease, color .1s ease; }
  .tm-k.arrow { font: 400 18px/1 system-ui, sans-serif; }
  .tm-k:active { background: var(--hover-strong); color: var(--text); }
  .tm-k.armed { background: var(--text); color: var(--bg); }
  .tm-k.locked { background: var(--coral); color: #fff; box-shadow: inset 0 -2px 0 rgba(0, 0, 0, .18); }
  .tm-k.on { background: var(--hover-strong); color: var(--text); }
  .tm-more :global(svg) { width: 20px; height: 20px; transition: transform .18s ease; }
  .tm-more.on :global(svg) { transform: rotate(180deg); }

  .tm-compose { flex: none; display: flex; align-items: flex-end; gap: 6px; padding: 0 0 8px; }
  .tm-line { flex: 1; min-width: 0; height: 40px; min-height: 40px; max-height: 116px; resize: none; padding: 9px 12px; border-radius: 12px;
    border: 1px solid transparent; outline: none; background: var(--hover); color: var(--text);
    font: 15px/20px Consolas, 'Cascadia Mono', ui-monospace, Menlo, 'Roboto Mono', 'Noto Sans Mono', monospace; transition: border-color .12s ease, background-color .12s ease; }
  .tm-line::placeholder { color: var(--muted); font-family: system-ui, sans-serif; font-size: 14px; }
  .tm-line:focus { border-color: var(--divider); background: var(--card, var(--hover)); }
  .tm-cb { flex: none; width: 40px; height: 40px; border-radius: 12px; display: flex; align-items: center; justify-content: center;
    background: var(--hover); color: var(--serif); touch-action: manipulation; transition: background-color .12s ease, color .12s ease; }
  .tm-cb :global(svg) { width: 20px; height: 20px; }
  .tm-cb:active, .tm-cb.on { background: var(--hover-strong); color: var(--text); }
  .tm-kbd.on { background: var(--text); color: var(--bg); }
  .tm-send { background: var(--text); color: var(--bg); }
  .tm-send:active { opacity: .8; background: var(--text); color: var(--bg); }
  .tm-direct { flex: 1; min-width: 0; min-height: 40px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 1px;
    padding: 5px 12px; border-radius: 12px; background: var(--hover); text-align: left; }
  .tm-direct .t1 { font-size: 13px; color: var(--text); font-weight: 600; }
  .tm-direct .t2 { font-size: 11.5px; color: var(--muted); line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

  .spin { width: 14px; height: 14px; flex: none; border: 2px solid var(--divider); border-top-color: var(--coral); border-radius: 50%; animation: tmspin .8s linear infinite; }
  @keyframes tmspin { to { transform: rotate(360deg); } }
</style>
