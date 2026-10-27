<script>
  // 浏览器面板：dimensio Agent 浏览器同款交互（screencast 画布 + 全量输入转发 +
  // 设备三档 + 自定义视口/横竖屏/触屏/配色 + 竖屏手机框 + agent 指针回显），Claude 分页配色皮肤。
  // 与 agent 的 mcp__browser__browser 工具共享同一 CDP 实例——agent 操作实时同屏。
  import { api } from '../../lib/api.js';
  import { dock, readDockSse } from '../../lib/dock.svelte.js';
  import { isNativeDesktop, serverOnThisMachine, mountNativeBrowser, unmountNativeBrowser, onNativeOverlayChange, nativeOverlayActive, pushNativeOverlay } from '../../lib/nativeDesktop.js';
  import { apiUrl } from '../../lib/server.js';
  import { authHeaders } from '../../lib/api.js';
  import { t, tr } from '../../lib/i18n.js';
  // readonly=聊天快照访客：只看直播，不给任何操作（地址栏/前进后退/标签/设备/输入转发全撤）。
  // 页面由 Claude 用 mcp__browser__browser 开；后端对 snap 身份也只放 state/stream 两个读接口。
  let { dockState = dock, readonly = false } = $props();
  // 原生视图只在服务端就在这台电脑上时成立（服务端的浏览器会话落在本壳里）；连远端服务端时它的浏览器在服务器上，走直播画面。
  // 服务端还会在 state 事件里说这份浏览器在不在壳里（desktop）：成员 / 快照访客的是无头浏览器，壳里没有它——
  // 在服务器本机的桌面客户端里登成员账号时也得走直播画面。老服务端不带这个字段，照原来的判断。
  const nativeCapable = $derived(isNativeDesktop() && serverOnThisMachine() && !readonly);
  let notInShell = $state(false);
  const nativeBrowser = $derived(nativeCapable && !notInShell);

  const enc = encodeURIComponent;
  // 与后端 VIEWPORT_PRESETS（单一真相）一致；仅凭帧尺寸即可点亮当前档。
  const DEVICES = [
    { key: 'desktop', w: 1280, h: 900, label: t('桌面') },
    { key: 'tablet', w: 768, h: 1024, label: t('平板') },
    { key: 'mobile', w: 375, h: 812, label: t('手机') },
  ];
  // 仿真旗标与页面实测（来自 stream 的 state/viewport 事件 = 后端 viewportReport()）：
  // 角标里把「期望 vs 实测」摆在一起，视口有没有真生效一眼看出。
  let emu = $state({ mobile: false, scheme: 'auto', dpr: 1 });
  let measured = $state(null);
  // 视口菜单（工具栏右端的设备键）：设备三档 / 自定义尺寸 / 横竖屏 / 触屏 / 配色 / 关闭浏览器。
  // 宽窄面板同一个菜单（以前宽栏一排五颗图标、窄栏另有一个 ⋮ 弹层，两套）。
  let menuOpen = $state(false);
  let customW = $state('');
  let customH = $state('');
  function takeReport(ev) {
    if (ev?.emu) emu = { ...ev.emu };
    if (ev && 'measured' in ev) measured = ev.measured || null;
  }

  let stageEl = $state();
  let canvasEl = $state();
  let urlEl = $state();
  let dead = $state(true);          // 无实例（409）→ 空态
  let tabs = $state([]);            // [{id,url,title,active}] 来自 stream 的 tabs 事件
  let connecting = $state(false);
  let frameW = $state(0);
  let frameH = $state(0);
  let url = $state('');
  let urlInput = $state('');
  let navBusy = $state(false);
  let stageW = $state(0);
  let stageH = $state(0);
  let agentPtr = $state(null);      // {x,y}
  let ripple = $state(null);        // {x,y,n}
  let rippleN = 0;
  let nativeRaf = 0;
  let nativeMounted = '';   // 本面板当前挂载的 targetId——卸载只卸自己的，不动别的面板

  function releaseNative() {
    if (!nativeBrowser) return;
    cancelAnimationFrame(nativeRaf);
    const id = nativeMounted || tabs.find((tab) => tab.active)?.id || '';
    nativeMounted = '';
    unmountNativeBrowser(id);
  }

  function syncNativeSurface() {
    if (!nativeBrowser) return;
    cancelAnimationFrame(nativeRaf);
    const active = tabs.find((tab) => tab.active);
    // 浮层（文件预览/灯箱）压着时让位：原生视图恒在 DOM 之上，挂着就糊住浮层。
    if (!active?.id || !stageEl || dead || nativeOverlayActive()) { releaseNative(); return; }
    // 逻辑视口交给壳：它按 contain 把画面缩放居中摆进面板，页面照完整视口排版后
    // 整体缩小，而不是被面板宽度裁掉（旧行为：右侧留黑 + 横向滚动条）。
    const vp = { width: frameW, height: frameH };
    nativeRaf = requestAnimationFrame(() => {
      mountNativeBrowser(active.id, stageEl, vp)
        .then((ok) => { if (ok) nativeMounted = active.id; })
        .catch(() => {});
    });
  }

  // 浮层开合：让位与回归。
  $effect(() => {
    if (!nativeBrowser) return;
    return onNativeOverlayChange(() => syncNativeSurface());
  });

  const portrait = $derived(frameH > frameW && frameW > 0);
  // 横竖都算同一档（与后端 presetKeyFor 一致）
  const curPreset = $derived(DEVICES.find((d) => (d.w === frameW && d.h === frameH) || (d.w === frameH && d.h === frameW))?.key || null);
  const landscape = $derived(frameW > frameH && frameH > 0);
  // 实测与期望差 2px 以上才算「没对上」（壳里 zoom 取整会带 ±1）
  const measuredOff = $derived(Boolean(measured && frameW && (Math.abs(measured.w - frameW) > 2 || Math.abs(measured.h - frameH) > 2)));
  const schemeLabel = $derived(emu.scheme === 'dark' ? t('深色') : emu.scheme === 'light' ? t('浅色') : t('跟随'));
  // 窄面板（手机 sheet / 桌面把 dock 拖窄）：地址栏优先——「前进」收进菜单，设备键只留图标
  // 粗指针（手机/平板触屏）：放大触控目标、唤键盘按钮
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const narrowNav = $derived(stageW > 0 && (stageW < 360 || (coarse && stageW < 520)));
  const showSize = $derived(stageW >= 480);
  const curDevice = $derived(DEVICES.find((d) => d.key === curPreset) || null);
  const fitDims = $derived.by(() => {
    if (!stageW || !stageH || !frameW || !frameH) return { w: 0, h: 0 };
    const pad = portrait ? (narrowNav ? 4 : 16) : 0;
    const s = Math.min((stageW - pad * 2) / frameW, (stageH - pad * 2) / frameH);
    return { w: Math.max(1, Math.floor(frameW * s)), h: Math.max(1, Math.floor(frameH * s)) };
  });

  // 帧流控：服务端每个观众最多 2 帧在路上，这边画完（或丢弃）一帧就回一次 ack 它才发下一帧
  // （stream 带 ack=1）。解码中又来了帧只留最新的——手机弱网下画面永远是「最近的」，不再排队落后。
  // 每一帧都要恰好回一次 ack：画完的、被更新帧顶掉的都算。
  let castSid = '';
  let decoding = false;
  let pendingB64 = null;
  const ackFrame = () => { if (castSid) api.post('/api/claude/browser/ack', { sid: castSid }).catch(() => {}); };
  function drawFrame(b64) {
    if (decoding) { if (pendingB64) ackFrame(); pendingB64 = b64; return; }
    if (!canvasEl) { ackFrame(); return; }
    decoding = true;
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    img.decode().then(() => {
      if (!canvasEl) return;
      if (canvasEl.width !== img.naturalWidth || canvasEl.height !== img.naturalHeight) {
        canvasEl.width = img.naturalWidth;
        canvasEl.height = img.naturalHeight;
      }
      canvasEl.getContext('2d').drawImage(img, 0, 0);
    }).catch(() => {}).finally(() => {
      decoding = false;
      ackFrame();
      if (pendingB64) { const next = pendingB64; pendingB64 = null; drawFrame(next); }
    });
  }

  function applyViewport(vp) {
    const w = Math.round(Number(vp?.width) || 0);
    const h = Math.round(Number(vp?.height) || 0);
    if (!(w > 0 && h > 0) || (frameW === w && frameH === h)) return;
    frameW = w; frameH = h;
    syncNativeSurface();
  }

  // —— 直播流：持续重连（409=没实例 → 空态慢轮询；断流快重试）——
  let stopSse = null, retryTimer = 0, gone = false, streamGen = 0;
  function stream() {
    if (gone || !dockState.ws) return;
    stopSse?.();
    const gen = ++streamGen;
    connecting = true;
    castSid = ''; decoding = false; pendingB64 = null;
    stopSse = readDockSse(`/api/claude/browser/stream?ws=${enc(dockState.ws)}${nativeBrowser ? '&native=1' : '&ack=1'}`, (ev) => {
      if (gen !== streamGen) return;   // 已换了新流（见下面 state 的模式切换）：旧流同一块里剩下的事件不要了
      // 这份浏览器在不在本壳里与当前模式对不上：原生 ↔ 帧流换过来重连（native=1 的流服务端不推帧）
      if (ev.type === 'state' && nativeCapable && typeof ev.desktop === 'boolean' && notInShell === ev.desktop) {
        releaseNative();
        notInShell = !ev.desktop;
        stream();
        return;
      }
      if (ev.type === 'hello') {
        castSid = ev.sid || '';
      } else if (ev.type === 'frame') {
        dead = false; connecting = false;
        frameW = ev.w || frameW; frameH = ev.h || frameH;
        if (ev.url && ev.url !== url) { url = ev.url; if (document.activeElement !== urlEl) urlInput = url; }
        drawFrame(ev.data);
      } else if (ev.type === 'state') {
        dead = false; connecting = false;
        if (ev.viewport) { frameW = ev.viewport.width; frameH = ev.viewport.height; }
        takeReport(ev);
        if (ev.url) { url = ev.url; if (document.activeElement !== urlEl) urlInput = url; }
        syncNativeSurface();
      } else if (ev.type === 'viewport') {
        // 原生模式没有帧：视口就是"画面尺寸"，档位高亮与原生缩放摆位都用它。
        // 帧流模式尺寸以真帧为准，别被这条带偏；仿真旗标与实测两种模式都收。
        takeReport(ev);
        if (nativeBrowser) applyViewport(ev.viewport);
      } else if (ev.type === 'tabs') {
        tabs = Array.isArray(ev.tabs) ? ev.tabs : [];
        const act = tabs.find((tab) => tab.active);
        if (act && act.url && act.url !== 'about:blank' && document.activeElement !== urlEl) { url = act.url; urlInput = act.url; }
        syncNativeSurface();
      } else if (ev.type === 'pointer') {
        if (ev.source === 'agent') {
          agentPtr = { x: ev.x, y: ev.y };
          if (ev.kind === 'click') ripple = { x: ev.x, y: ev.y, n: ++rippleN };
        }
      }
    }, {
      onDead: () => { dead = true; connecting = false; releaseNative(); schedule(2500); },
      onClose: () => { connecting = false; schedule(dead ? 2500 : 1200); },
    });
  }
  function schedule(ms) {
    if (gone) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(stream, ms);
  }

  $effect(() => {
    if (!dockState.ws) return;
    gone = false;
    stream();
    const ro = new ResizeObserver(() => {
      if (stageEl) { stageW = stageEl.clientWidth; stageH = stageEl.clientHeight; syncNativeSurface(); }
    });
    if (stageEl) ro.observe(stageEl);
    return () => {
      gone = true; stopSse?.(); stopSse = null; clearTimeout(retryTimer); ro.disconnect();
      releaseNative();
    };
  });
  // agent 侧刚打开浏览器（SSE browser 事件）→ 立刻重试挂流，别等慢轮询。
  $effect(() => { void dockState.browserLive; if (dead && dockState.ws) schedule(120); });

  // —— 导航 ——
  async function go() {
    const u = urlInput.trim();
    if (!u || navBusy) return;
    navBusy = true;
    try {
      // 在手机上从地址栏把浏览器拉起来：直接用手机档（同一台浏览器 agent 也在用，所以只在
      // 这一刻——浏览器还没开、是用户自己开的——才替他选，之后随他切）
      const r = await api.post('/api/claude/browser/navigate', { ws: dockState.ws, url: u, ...(dead && coarse && narrowNav ? { preset: 'mobile' } : {}) });
      if (r?.url) { url = r.url; urlInput = r.url; }
      dead = false;
      schedule(60);   // 实例刚拉起：立即挂流
    } catch (e) {
      const m = e?.body?.error || e?.body || t('打开失败');
      urlHint = tr(String(m)); setTimeout(() => (urlHint = ''), 2600);
    }
    navBusy = false;
    urlEl?.blur();
  }
  let urlHint = $state('');
  let urlFocus = $state(false);
  // 没在编辑地址时：主机名提亮、其余压暗；https 显示锁。about:/data:/file: 之类照原样显示。
  const urlParts = $derived.by(() => {
    if (urlFocus || !url || urlInput !== url) return null;
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) return null;
      return { host: u.host, rest: (u.pathname === '/' ? '' : u.pathname) + u.search + u.hash };
    } catch { return null; }
  });
  const urlSecure = $derived(/^https:/i.test(url || ''));
  // 后退/前进/刷新也走地址栏底边那根加载细线
  const nav = (dir) => {
    navBusy = true;
    return api.post('/api/claude/browser/navigate', { ws: dockState.ws, dir })
      .then((r) => { if (r?.url) { url = r.url; if (document.activeElement !== urlEl) urlInput = r.url; } })
      .catch(() => {})
      .finally(() => { navBusy = false; });
  };
  // 视口请求统一走 resize 路由（与 agent 的 browser(resize) 同一套参数）：
  // preset / width+height / landscape / mobile / scheme。响应 = viewportReport()。
  const vpApply = (body) => api.post('/api/claude/browser/resize', { ws: dockState.ws, ...body })
    .then((r) => { takeReport(r); if (nativeBrowser && r?.viewport) applyViewport(r.viewport); return r; })
    .catch(() => null);
  const setDevice = (key) => vpApply({ preset: key });
  const rotate = () => vpApply({ landscape: !landscape });
  const toggleTouch = () => vpApply({ mobile: !emu.mobile });
  // 配色三态轮转：跟随 → 深色 → 浅色 → 跟随
  const cycleScheme = () => vpApply({ scheme: emu.scheme === 'auto' ? 'dark' : emu.scheme === 'dark' ? 'light' : 'auto' });
  function toggleMenu() {
    if (menuOpen) { menuOpen = false; return; }
    customW = String(frameW || ''); customH = String(frameH || '');
    menuOpen = true;
    vpApply({});   // 空参数 = 现测一遍，菜单里的「实测」行才不是「尚未实测」
  }
  // 菜单开着时视口被别处改了（横竖屏钮、agent 的 resize、设备档）→ 输入框跟着对齐
  $effect(() => { if (menuOpen && frameW && frameH) { customW = String(frameW); customH = String(frameH); } });

  // —— 桌面壳：菜单被网页盖住 ——
  // 原生 WebContentsView 恒在 DOM 之上，菜单弹层画得再高也会被网页压在底下（维护者 10-21 截图）。
  // 菜单打开时先抓一张当前画面画进占位画布，再让原生视图让位（pushNativeOverlay），网页看起来
  // 只是「定格」在菜单底下；菜单关了视图挂回。抓图失败也照样让位，只是底下空着。
  let frozen = $state(false);
  $effect(() => {
    if (!nativeBrowser || !menuOpen || dead) return;
    let cancelled = false;
    let release = null;
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/claude/browser/snapshot?ws=${enc(dockState.ws)}`), { headers: authHeaders(), credentials: 'same-origin', signal: AbortSignal.timeout(1500) });
        if (r.ok && !cancelled) {
          const bmp = await createImageBitmap(await r.blob());
          if (!cancelled && canvasEl) {
            canvasEl.width = bmp.width; canvasEl.height = bmp.height;
            canvasEl.getContext('2d').drawImage(bmp, 0, 0);
          }
          bmp.close?.();
        }
      } catch { /* 抓不到就不定格 */ }
      if (cancelled) return;
      frozen = true;
      release = pushNativeOverlay();
    })();
    return () => { cancelled = true; frozen = false; release?.(); };
  });
  // 原生模式下菜单等定格好了再出现，免得先在网页底下闪一下
  const menuShown = $derived(menuOpen && (!nativeBrowser || frozen || dead));
  function applyCustom() {
    const w = Math.round(Number(customW)), h = Math.round(Number(customH));
    if (!(w > 0 && h > 0)) return;
    vpApply({ width: w, height: h });
  }
  async function powerOff() {
    await api.post('/api/claude/browser/close', { ws: dockState.ws }).catch(() => {});
    releaseNative();
    dead = true; frameW = 0; frameH = 0; agentPtr = null; url = ''; urlInput = ''; tabs = [];
  }

  // —— 标签条：点选切换 / × 关闭 / ＋ 新建（空白页并聚焦地址栏）——
  const tabOp = (body) => (readonly ? null : api.post('/api/claude/browser/tab', { ws: dockState.ws, ...body }).catch(() => {}));
  const selectTab = (tab) => { if (!tab.active) tabOp({ op: 'select', id: tab.id }); };
  const closeTabX = (e, tab) => { e.stopPropagation(); tabOp({ op: 'close', id: tab.id }); };
  async function newTab() {
    await tabOp({ op: 'new' });
    urlInput = '';
    urlEl?.focus();
  }
  const tabLabel = (tab) => {
    if (tab.title) return tab.title;
    if (!tab.url || tab.url === 'about:blank') return t('新标签页');
    try { return new URL(tab.url).host || tab.url; } catch { return tab.url; }
  };

  // —— 输入转发：显示盒 → 帧 CSS 像素（比例映射，DPR 无关）——
  function mapCoords(e) {
    const r = canvasEl.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * frameW),
      y: Math.round(((e.clientY - r.top) / r.height) * frameH),
    };
  }
  // 只读模式在这里统一断流——下面每个手势处理器就不必各自记得判 readonly。
  // 原生模式一并断流：真 WebContentsView 自己收鼠标/键盘，画布只是被盖住的占位——
  // 落在 letterbox 留白上的点击若按比例映射回页面，会打在完全不相干的位置。
  //
  // 输入按顺序一条条发（上一条回来再发下一条）：经隧道并发的 POST 到达顺序不保证，打字会
  // 乱序、点击会插到滚动中间。排队期间的滚轮合并成一条——手指拖得再快也只有一条在路上。
  const inputQ = [];
  let inputBusy = false;
  function fire(body) {
    if (readonly || nativeBrowser) return Promise.resolve(null);
    const last = inputQ[inputQ.length - 1];
    if (body.type === 'wheel' && last?.body.type === 'wheel') {
      last.body.deltaX += body.deltaX; last.body.deltaY += body.deltaY; last.body.x = body.x; last.body.y = body.y;
      return last.p;
    }
    let resolve;
    const p = new Promise((r) => (resolve = r));
    inputQ.push({ body, p, resolve });
    pumpInput();
    return p;
  }
  async function pumpInput() {
    if (inputBusy) return;
    inputBusy = true;
    while (inputQ.length) {
      const item = inputQ.shift();
      const r = await api.post('/api/claude/browser/input', { ws: dockState.ws, ...item.body }).catch(() => null);
      item.resolve(r);
    }
    inputBusy = false;
  }

  // 用户自己的点按也立刻画涟漪：请求还在路上时就知道「点上了」，不用干等画面变
  function userRipple(x, y) { ripple = { x, y, n: ++rippleN }; }

  // 触屏上浏览器在 pointerup 之后还会补发一次 click——以前这里也发一次点击，一次轻点 = 两次
  // 点击，开关类控件点开又立刻关上，看起来就是「点了没反应」。click 只认鼠标，触屏由 onPointerUp 处理。
  let lastPointerType = 'mouse';
  function onClick(e) {
    if (dead || !frameW || lastPointerType !== 'mouse') return;
    const { x, y } = mapCoords(e);
    userRipple(x, y);
    fire({ type: 'click', x, y });
    stageEl?.focus();
  }
  function onContext(e) {
    if (dead || !frameW) return;
    e.preventDefault();
    const { x, y } = mapCoords(e);
    fire({ type: 'click', x, y, button: 'right' });
  }
  // 滚轮 50ms 合并；hover 45ms 节流（dimensio 同款）。
  let wheelAcc = null, wheelTimer = 0;
  function onWheel(e) {
    if (dead || !frameW || readonly) return;
    e.preventDefault();
    const { x, y } = mapCoords(e);
    if (!wheelAcc) wheelAcc = { x, y, dy: 0, dx: 0 };
    wheelAcc.dy += e.deltaY; wheelAcc.dx += e.deltaX; wheelAcc.x = x; wheelAcc.y = y;
    if (!wheelTimer) wheelTimer = setTimeout(() => {
      const w = wheelAcc; wheelAcc = null; wheelTimer = 0;
      fire({ type: 'wheel', x: w.x, y: w.y, deltaY: Math.round(w.dy), deltaX: Math.round(w.dx) });
    }, 50);
  }
  let lastMove = 0;
  function onMove(e) {
    if (dead || !frameW || e.pointerType !== 'mouse') return;
    const now = Date.now();
    if (now - lastMove < 45) return;
    lastMove = now;
    const { x, y } = mapCoords(e);
    fire({ type: 'move', x, y });
  }
  // 触屏：拖动=滚动（手指位移反向映射成 wheel），轻点=点击，松手带速度=惯性续滚。
  // 位移按帧（rAF）攒成一条再交给 fire，fire 又会把排队中的滚轮合并——不再一个 pointermove
  // 一个请求。速度取松手前 ~100ms 的位移，惯性按 0.94/帧衰减，下一次按下立刻刹停。
  let touch = null;
  let dragAcc = { dx: 0, dy: 0 }, dragRaf = 0;
  let fling = null, flingRaf = 0;
  const pxScale = () => { const r = canvasEl.getBoundingClientRect(); return { sx: frameW / r.width, sy: frameH / r.height }; };
  function flushDrag() {
    dragRaf = 0;
    if (!touch || (!dragAcc.dx && !dragAcc.dy)) return;
    const { sx, sy } = pxScale();
    fire({ type: 'wheel', x: touch.x, y: touch.y, deltaY: Math.round(-dragAcc.dy * sy), deltaX: Math.round(-dragAcc.dx * sx) });
    dragAcc = { dx: 0, dy: 0 };
  }
  function stopFling() { cancelAnimationFrame(flingRaf); fling = null; }
  function stepFling() {
    if (!fling) return;
    fling.vx *= 0.94; fling.vy *= 0.94;
    const dx = fling.vx * 16, dy = fling.vy * 16;   // 速度单位 px/ms，按 16ms 一帧
    if (Math.hypot(dx, dy) < 0.6) { stopFling(); return; }
    const { sx, sy } = pxScale();
    fire({ type: 'wheel', x: fling.x, y: fling.y, deltaY: Math.round(-dy * sy), deltaX: Math.round(-dx * sx) });
    flingRaf = requestAnimationFrame(stepFling);
  }
  function onPointerDown(e) {
    lastPointerType = e.pointerType;
    if (e.pointerType === 'mouse' || dead || !frameW) return;
    stopFling();
    touch = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, drag: false, hist: [{ x: e.clientX, y: e.clientY, t: performance.now() }], ...mapCoords(e) };
  }
  function onPointerMove(e) {
    if (!touch || e.pointerType === 'mouse') return;
    const dx = e.clientX - touch.lx, dy = e.clientY - touch.ly;
    if (!touch.drag && Math.hypot(e.clientX - touch.sx, e.clientY - touch.sy) > 8) touch.drag = true;
    touch.hist.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (touch.hist.length > 8) touch.hist.shift();
    if (!touch.drag) return;
    dragAcc.dx += dx; dragAcc.dy += dy;
    touch.lx = e.clientX; touch.ly = e.clientY;
    if (!dragRaf) dragRaf = requestAnimationFrame(flushDrag);
  }
  function onPointerUp(e) {
    if (!touch || e.pointerType === 'mouse') { touch = null; return; }
    const t0 = touch;
    if (!t0.drag) {
      userRipple(t0.x, t0.y);
      // 顺带问一句「点进输入框没有」：点进了就把隐藏输入框聚焦，拉起手机软键盘
      fire({ type: 'click', x: t0.x, y: t0.y, wantFocus: true }).then((r) => {
        if (r?.editable) openIme(r.field);
        else if (imeOn) closeIme();   // 点到别处（页面里的焦点已离开输入框）就收起键盘
      });
      touch = null;
      return;
    }
    cancelAnimationFrame(dragRaf); flushDrag();
    const now = performance.now();
    const old = t0.hist.find((p) => now - p.t <= 100) || t0.hist[0];
    const dt = Math.max(16, now - old.t);
    const vx = (e.clientX - old.x) / dt, vy = (e.clientY - old.y) / dt;
    touch = null;
    if (Math.hypot(vx, vy) > 0.35) { fling = { vx, vy, x: t0.x, y: t0.y }; flingRaf = requestAnimationFrame(stepFling); }
  }

  // —— 手机软键盘：画布唤不出键盘，借一个隐藏 textarea 收字再转发 ——
  // 值里常驻一个零宽哨兵：退格删掉它 = 发 backspace（输入框为空时 Gboard 等不发退格事件）；
  // 拼音等输入法在 composition 结束后才把成字发出去，中途不转发。
  const IME_SENT = '​';
  let imeEl = $state();
  let imeOn = $state(false);
  let imeField = $state('');
  let composing = false;
  function openIme(field = '') {
    if (!imeEl || readonly || nativeBrowser) return;
    // 后端给的是「input[text]「搜索」 #q」这种工具用描述，给人看只留名字
    imeField = /「(.+?)」/.exec(field)?.[1] || '';
    imeEl.value = IME_SENT;
    imeEl.focus({ preventScroll: true });
    try { imeEl.setSelectionRange(1, 1); } catch {}
    imeOn = true;
  }
  function closeIme() { imeEl?.blur(); }
  function imeFlush() {
    if (!imeEl || composing) return;
    const v = imeEl.value;
    if (!v.startsWith(IME_SENT)) {
      // 哨兵被删 = 退格（框里平时只有哨兵，一次只可能删掉它这一个字）
      fire({ type: 'key', key: 'backspace' });
      if (v) sendImeText(v.replace(IME_SENT, ''));
    } else if (v.length > IME_SENT.length) {
      sendImeText(v.slice(IME_SENT.length));
    }
    imeEl.value = IME_SENT;
    try { imeEl.setSelectionRange(1, 1); } catch {}
  }
  function sendImeText(s) {
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (p) fire({ type: 'text', text: p });
      if (i < parts.length - 1) fire({ type: 'key', key: 'enter' });
    });
  }
  function imeKey(e) {
    // 键盘上的「前往/发送」键和真键盘的方向/退格（哨兵还在、浏览器不会给 input 事件时）
    if (e.isComposing || composing) return;
    if (e.key === 'Enter') { e.preventDefault(); fire({ type: 'key', key: 'enter' }); }
    else if (e.key === 'Backspace' && imeEl.value === IME_SENT) { e.preventDefault(); fire({ type: 'key', key: 'backspace' }); }
    else if (e.key === 'Tab') { e.preventDefault(); fire({ type: 'key', key: e.shiftKey ? 'shift+tab' : 'tab' }); }
  }
  // 键盘开着时在画布上点：默认会先让隐藏输入框失焦、键盘收起，点完若还是输入框再弹出来——一闪
  // 一闪。拦掉 touchstart 的默认行为保住焦点（指针事件照常发，轻点/拖动不受影响）；
  // 要非被动监听，所以不用模板属性。
  $effect(() => {
    const el = canvasEl;
    if (!el) return;
    const keep = (e) => { if (imeOn) e.preventDefault(); };
    el.addEventListener('touchstart', keep, { passive: false });
    return () => el.removeEventListener('touchstart', keep);
  });

  function onKey(e) {
    if (dead || !frameW || readonly) return;
    if (e.target === urlEl) return;
    e.preventDefault();
    const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.metaKey && 'meta', e.shiftKey && 'shift'].filter(Boolean);
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) { fire({ type: 'text', text: e.key }); return; }
    const named = { Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape', Delete: 'delete', ' ': 'space', ArrowUp: 'arrowup', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft', ArrowRight: 'arrowright', PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end' }[e.key];
    const base = named || (e.key.length === 1 ? e.key.toLowerCase() : null);
    if (!base) return;
    fire({ type: 'key', key: [...mods.filter((m) => m !== 'shift' || !named), base].join('+') });
  }
  function onPaste(e) {
    if (dead || !frameW || readonly || e.target === urlEl) return;
    const txt = e.clipboardData?.getData('text');
    if (txt) { e.preventDefault(); fire({ type: 'text', text: txt }); }
  }
</script>

<div class="bw" class:narrow={narrowNav} class:coarse>
  {#if !dead && tabs.length > 1}
    <!-- 标签条只在多标签时出现：单标签时它只是把标题再写一遍，白占一行 -->
    <div class="bw-tabs">
      {#each tabs as tab (tab.id)}
        {#if readonly}
          <div class="btab ro" class:on={tab.active} title={tab.url}><span class="btab-t">{tabLabel(tab)}</span></div>
        {:else}
          <div class="btab" class:on={tab.active} role="button" tabindex="0" title={tab.url}
            onclick={() => selectTab(tab)} onkeydown={(e) => { if (e.key === 'Enter') selectTab(tab); }}>
            <span class="btab-t">{tabLabel(tab)}</span>
            <button class="btab-x" aria-label={t('关闭标签')} onclick={(e) => closeTabX(e, tab)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 7l10 10M17 7L7 17"/></svg>
            </button>
          </div>
        {/if}
      {/each}
      {#if !readonly}
        <button class="btab-new" aria-label={t('新建标签')} onclick={newTab}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      {/if}
    </div>
  {/if}
  {#if readonly}
    <!-- 只读直播条：地址只读展示 + 明确告诉访客这是 Claude 的浏览器 -->
    <div class="bw-nav ro">
      <div class="urlbar" class:live={!dead}>
        <span class="dot"></span>
        <span class="urltext sel-text">{url || 'about:blank'}</span>
      </div>
      <span class="ro-tag">{t('只读直播')}</span>
    </div>
  {:else}
  <div class="navwrap">
    <div class="bw-nav">
      <button class="nbtn" aria-label={t('后退')} disabled={dead} onclick={() => nav('back')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.5L8.5 12l6.5 6.5"/></svg></button>
      {#if !narrowNav}
        <button class="nbtn" aria-label={t('前进')} disabled={dead} onclick={() => nav('forward')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5.5l6.5 6.5L9 18.5"/></svg></button>
      {/if}
      <button class="nbtn" aria-label={t('刷新')} disabled={dead} onclick={() => nav('reload')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg></button>
      <label class="urlbar" class:live={!dead} class:busy={navBusy} class:focus={urlFocus}>
        {#if urlSecure}
          <svg class="u-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>
        {:else}
          <svg class="u-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.2 2.2 3.3 4.9 3.3 8s-1.1 5.8-3.3 8M12 4C9.8 6.2 8.7 8.9 8.7 12s1.1 5.8 3.3 8"/></svg>
        {/if}
        <input bind:this={urlEl} bind:value={urlInput} placeholder={t('输入网址')} enterkeyhint="go" spellcheck="false" autocapitalize="off" autocomplete="off"
          class:dim={urlParts && !urlFocus}
          onkeydown={(e) => { if (e.key === 'Enter') go(); else if (e.key === 'Escape') { urlInput = url; urlEl?.blur(); } }}
          onfocus={() => { urlFocus = true; urlEl?.select(); }} onblur={() => (urlFocus = false)} />
        {#if urlParts && !urlFocus}
          <!-- 没在编辑时把主机名提亮、路径压暗（同 Chrome / Safari），一眼看清在哪个站 -->
          <span class="u-show" aria-hidden="true"><b>{urlParts.host}</b>{urlParts.rest}</span>
        {/if}
        {#if navBusy}<span class="u-bar"></span>{/if}
      </label>
      {#if coarse}
        <!-- 手机：手动唤键盘（页面里的输入框没被自动识别时用；先点一下页面里的输入框再按它） -->
        <button class="nbtn" class:on={imeOn} aria-label={imeOn ? t('收起键盘') : t('键盘')} disabled={dead}
          onpointerdown={(e) => e.preventDefault()} onclick={() => (imeOn ? closeIme() : openIme())}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6.5" width="18" height="11" rx="2.2"/><path d="M7 10.3h.01M10.3 10.3h.01M13.7 10.3h.01M17 10.3h.01M8.5 14h7"/></svg>
        </button>
      {/if}
      {#if tabs.length <= 1 && !narrowNav}
        <button class="nbtn" aria-label={t('新建标签')} disabled={dead} onclick={newTab}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg></button>
      {/if}
      <!-- 设备键：当前档图标 + 尺寸，点开视口菜单 -->
      <button class="devkey" class:on={menuOpen} class:warn={measuredOff} disabled={dead} aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label={t('视口选项')} title={t('视口选项：设备 / 尺寸 / 横竖屏 / 触屏 / 配色')} onclick={toggleMenu}>
        {@render devIcon(curDevice?.key || 'custom')}
        {#if showSize && frameW}<span class="dk-size">{frameW}×{frameH}</span>{/if}
        <svg class="dk-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>
      </button>
    </div>
    {#if menuShown && !readonly}
      <button class="menu-bd" aria-label={t('关闭视口选项')} onclick={() => (menuOpen = false)}></button>
      <div class="vmenu" role="menu">
        <div class="seg" role="group" aria-label={t('设备')}>
          {#each DEVICES as d (d.key)}
            <button class="seg-b" class:on={curPreset === d.key} onclick={() => { setDevice(d.key); menuOpen = false; }}>
              {@render devIcon(d.key)}<span>{d.label}</span>
            </button>
          {/each}
        </div>
        <div class="vm-row">
          <input class="vp-in" type="number" min="200" max="4000" inputmode="numeric" bind:value={customW} aria-label={t('视口宽')} onkeydown={(e) => { if (e.key === 'Enter') { applyCustom(); menuOpen = false; } }} />
          <span class="vp-x">×</span>
          <input class="vp-in" type="number" min="200" max="4000" inputmode="numeric" bind:value={customH} aria-label={t('视口高')} onkeydown={(e) => { if (e.key === 'Enter') { applyCustom(); menuOpen = false; } }} />
          <button class="vp-go" onclick={() => { applyCustom(); menuOpen = false; }}>{t('应用')}</button>
        </div>
        <div class="vm-row chips">
          <button class="chip" onclick={rotate} title={t('横竖屏对调')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>
            {landscape ? t('竖屏') : t('横屏')}
          </button>
          <button class="chip" class:on={emu.mobile} onclick={toggleTouch} title={t('触屏仿真：touch 事件 + 移动端 UA')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11V4.5a1.5 1.5 0 0 1 3 0V11M12 10.5a1.5 1.5 0 0 1 3 0V12M15 11.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1-6 6h-1.2a6 6 0 0 1-4.8-2.4L3.6 16a1.5 1.5 0 0 1 2.3-1.9L9 17V11"/></svg>
            {t('触屏')}
          </button>
          <button class="chip" class:on={emu.scheme !== 'auto'} onclick={cycleScheme} title={t('prefers-color-scheme：跟随 → 深色 → 浅色')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>
            {schemeLabel}
          </button>
        </div>
        <div class="vm-meta" class:warn={measuredOff}>
          {#if measured}{measuredOff ? t('实测 {w}×{h} · DPR {dpr} · 触点 {touch} · 与期望不符', { w: measured.w, h: measured.h, dpr: measured.dpr, touch: measured.touch }) : t('实测 {w}×{h} · DPR {dpr} · 触点 {touch}', { w: measured.w, h: measured.h, dpr: measured.dpr, touch: measured.touch })}{:else}{t('尚未实测')}{/if}
        </div>
        <div class="vm-sep"></div>
        {#if narrowNav}
          <button class="vm-item" onclick={() => { nav('forward'); menuOpen = false; }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5.5l6.5 6.5L9 18.5"/></svg>{t('前进')}
          </button>
          {#if tabs.length <= 1}
            <button class="vm-item" onclick={() => { menuOpen = false; newTab(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>{t('新建标签')}
            </button>
          {/if}
        {/if}
        <button class="vm-item crit" onclick={() => { menuOpen = false; powerOff(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5v8M6.6 6.6a7.5 7.5 0 1 0 10.8 0"/></svg>{t('关闭浏览器')}
        </button>
      </div>
    {/if}
    </div>
  {/if}
  {#if urlHint}<div class="bw-hint">{urlHint}</div>{/if}

  <div class="bw-stage" bind:this={stageEl} tabindex="0" role="application" aria-label={t('浏览器画面')}
    onkeydown={onKey} onpaste={onPaste}>
    {#if dead}
      <div class="bw-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5M12 3.5C9.6 5.8 8.4 8.6 8.4 12s1.2 6.2 3.6 8.5"/></svg>
        <div class="bw-t1">{readonly ? t('浏览器还没打开') : t('开始浏览')}</div>
        <div class="bw-t2">{connecting ? t('连接中…') : readonly ? t('Claude 打开网页时，画面会实时出现在这里') : t('在上方输入网址；Claude 使用浏览器时，画面也会出现在这里')}</div>
      </div>
    {:else}
      <div class="cwrap" class:portrait class:ro={readonly} class:nat={nativeBrowser} class:frozen style="width:{fitDims.w}px;height:{fitDims.h}px">
        <canvas bind:this={canvasEl}
          onclick={onClick} oncontextmenu={onContext} onwheel={onWheel} onpointermove={(e) => { onMove(e); onPointerMove(e); }}
          onpointerdown={onPointerDown} onpointerup={onPointerUp} onpointercancel={() => (touch = null)}></canvas>
        {#if agentPtr}
          <div class="aptr" style="left:{(agentPtr.x / frameW) * 100}%;top:{(agentPtr.y / frameH) * 100}%">
            <svg viewBox="0 0 24 24"><path d="M5.5 3.2l12.6 7.3-5.6 1.6 3.2 6.6-2.7 1.3-3.2-6.6-4.3 4z" fill="var(--coral)" stroke="#fff" stroke-width="1.1"/></svg>
          </div>
        {/if}
        {#key ripple?.n}
          {#if ripple}<span class="ripple" style="left:{(ripple.x / frameW) * 100}%;top:{(ripple.y / frameH) * 100}%"></span>{/if}
        {/key}
        {#if imeOn}
          <button class="ime-chip" onpointerdown={(e) => e.preventDefault()} onclick={closeIme}>
            <span class="ime-t">{imeField ? t('正在输入：{field}', { field: imeField }) : t('键盘已连到页面')}</span><span class="ime-x">{t('收起')}</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
  {#snippet devIcon(key)}
    {#if key === 'desktop'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M9 20h6M12 16.5V20"/></svg>
    {:else if key === 'tablet'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2.2"/><path d="M11 17.8h2"/></svg>
    {:else if key === 'mobile'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2.8" width="10" height="18.4" rx="2.4"/><path d="M11 18.3h2"/></svg>
    {:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/></svg>{/if}
  {/snippet}
  {#if !readonly && !nativeBrowser}
    <textarea bind:this={imeEl} class="ime" aria-hidden="true" tabindex="-1" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="enter"
      oninput={imeFlush} onkeydown={imeKey}
      oncompositionstart={() => (composing = true)} oncompositionend={() => { composing = false; imeFlush(); }}
      onblur={() => (imeOn = false)}></textarea>
  {/if}
</div>

<style>
  /* 2026-10-21 重做：一条工具栏（后退/前进/刷新 · 地址 · 设备键），标签条只在多标签时出现，
     设备三档/横竖屏/触屏/配色/关闭全收进设备键的菜单。手机（窄栏 + 粗指针）放大触控目标、
     前进与新标签进菜单、画面贴边。线条 1.6~1.7、控件 30px（触屏 36px），只在状态处用陶土色。 */
  .bw { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; --ctl: 30px; }
  .bw.coarse { --ctl: 36px; }

  /* —— 标签条（≥2 个标签时）—— */
  .bw-tabs { flex: none; display: flex; align-items: center; gap: 2px; padding: 6px 8px 0; overflow-x: auto; scrollbar-width: none; }
  .bw-tabs::-webkit-scrollbar { display: none; }
  .btab { flex: 0 1 180px; min-width: 76px; display: flex; align-items: center; gap: 4px; height: 30px;
    padding: 0 3px 0 10px; border-radius: 8px; color: var(--muted); font-size: 12.5px; cursor: pointer;
    transition: background-color .12s ease, color .12s ease; }
  .btab.on { background: var(--hover); color: var(--text); }
  @media (hover: hover) { .btab:not(.on):hover { background: color-mix(in srgb, var(--hover) 55%, transparent); color: var(--serif); } }
  .btab-t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .btab-x { width: 22px; height: 22px; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .btab-x svg { width: 10px; height: 10px; }
  .btab-x:active { background: var(--hover-strong); }
  @media (hover: hover) {
    .btab:not(.on):not(:hover) .btab-x { opacity: 0; }
    .btab-x:hover { background: var(--hover-strong); color: var(--text); }
  }
  .btab-new { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .btab-new svg { width: 14px; height: 14px; }
  .btab-new:active { background: var(--hover); }
  @media (hover: hover) { .btab-new:hover { background: var(--hover); color: var(--text); } }
  .btab.ro { cursor: default; padding-right: 10px; }

  /* —— 工具栏 —— */
  .navwrap { flex: none; position: relative; z-index: 9; }
  .bw-nav { display: flex; align-items: center; gap: 2px; padding: 6px 8px; }
  .nbtn { width: var(--ctl); height: var(--ctl); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--serif); flex: none; }
  .nbtn svg { width: 17px; height: 17px; }
  .nbtn:disabled { opacity: .32; }
  .nbtn:not(:disabled):active { background: var(--hover); }
  @media (hover: hover) { .nbtn:not(:disabled):hover { background: var(--hover); color: var(--text); } }
  .nbtn.on { color: var(--coral); }

  .urlbar { position: relative; flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; height: var(--ctl);
    margin: 0 4px; padding: 0 10px; border-radius: 9px; background: var(--hover); cursor: text;
    transition: background-color .15s ease, box-shadow .15s ease; overflow: hidden; }
  .urlbar.focus { background: transparent; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--coral) 55%, transparent); }
  .u-ic { width: 13px; height: 13px; flex: none; color: var(--muted); }
  .urlbar input { flex: 1; min-width: 0; height: 100%; background: none; border: none; outline: none; color: var(--text); font-size: 12.5px; }
  .urlbar input::placeholder { color: var(--muted); }
  .urlbar input.dim { color: transparent; }
  .u-show { position: absolute; left: 30px; right: 10px; top: 0; bottom: 0; display: flex; align-items: center; pointer-events: none;
    font-size: 12.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .u-show b { font-weight: 500; color: var(--text); }
  /* 加载中：地址栏底边一根来回走的细线 */
  .u-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; pointer-events: none; }
  .u-bar::after { content: ''; position: absolute; top: 0; bottom: 0; width: 34%; border-radius: 2px; background: var(--coral); animation: uBar 1.1s ease-in-out infinite; }
  @keyframes uBar { from { left: -34%; } to { left: 100%; } }

  .devkey { flex: none; display: flex; align-items: center; gap: 4px; height: var(--ctl); padding: 0 6px 0 7px; border-radius: 8px; color: var(--serif); }
  .devkey > svg:first-child { width: 17px; height: 17px; }
  .dk-size { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; letter-spacing: -.1px; }
  .dk-chev { width: 11px; height: 11px; color: var(--muted); transition: transform .15s ease; }
  .devkey.on { background: var(--hover); }
  .devkey.on .dk-chev { transform: rotate(180deg); }
  .devkey.warn, .devkey.warn .dk-size { color: var(--crit); }
  .devkey:disabled { opacity: .32; }
  .devkey:not(:disabled):active { background: var(--hover); }
  @media (hover: hover) { .devkey:not(:disabled):hover { background: var(--hover); color: var(--text); } }

  /* —— 只读直播（聊天快照访客）—— */
  .bw-nav.ro .urlbar { cursor: default; }
  .urlbar .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex: none; transition: background .2s ease; }
  .urlbar.live .dot { background: var(--ok); }
  .urltext { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); font-size: 12.5px; }
  .ro-tag { flex: none; margin-left: 2px; padding: 3px 8px; border-radius: 7px; background: var(--hover); color: var(--muted); font-size: 11.5px; }

  /* —— 视口菜单 —— */
  .menu-bd { position: fixed; inset: 0; z-index: 1; cursor: default; }
  .vmenu { position: absolute; top: calc(100% - 2px); right: 8px; z-index: 2; width: 288px; padding: 8px;
    display: flex; flex-direction: column; gap: 8px;
    background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow), 0 0 0 .5px var(--divider);
    transform-origin: top right; animation: vmIn .16s cubic-bezier(.2,.8,.2,1); }
  @keyframes vmIn { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
  .bw.narrow .vmenu { left: 8px; right: 8px; width: auto; }
  :global(html[lang="en"]) .vmenu { width: 316px; }

  .seg { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--hover); }
  .seg-b { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 32px; border-radius: 7px;
    color: var(--muted); font-size: 12.5px; transition: background-color .12s ease, color .12s ease; }
  .seg-b svg { width: 15px; height: 15px; flex: none; }
  .seg-b.on { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
  @media (hover: hover) { .seg-b:not(.on):hover { color: var(--text); } }

  .vm-row { display: flex; align-items: center; gap: 6px; }
  .vp-in { flex: 1; width: 0; min-width: 0; height: 32px; padding: 0 6px; border-radius: 8px; border: none; outline: none;
    background: var(--hover); color: var(--text); font-size: 13px; text-align: center; font-variant-numeric: tabular-nums;
    -moz-appearance: textfield; appearance: textfield; }
  .vp-in::-webkit-outer-spin-button, .vp-in::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .vp-in:focus { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--coral) 55%, transparent); }
  .vp-x { flex: none; color: var(--muted); font-size: 12px; }
  .vp-go { flex: none; height: 32px; padding: 0 12px; border-radius: 8px; background: var(--text); color: var(--bg); font-size: 12.5px; font-weight: 500; }
  .vp-go:active { opacity: .8; }
  .chips { gap: 4px; }
  .chip { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; height: 30px; padding: 0 6px; border-radius: 8px; white-space: nowrap;
    color: var(--serif); font-size: 12px; box-shadow: inset 0 0 0 1px var(--divider); }
  .chip svg { width: 14px; height: 14px; flex: none; }
  .chip:active { background: var(--hover); }
  @media (hover: hover) { .chip:hover { background: var(--hover); } }
  .chip.on { color: var(--coral); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--coral) 45%, transparent); }
  .vm-meta { padding: 0 2px; font-size: 11px; color: var(--muted); line-height: 1.4; font-variant-numeric: tabular-nums; }
  .vm-meta.warn { color: var(--crit); }
  .vm-sep { height: 1px; margin: 0 -8px; background: var(--divider); }
  .vm-item { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px; border-radius: 8px; color: var(--text); font-size: 13px; text-align: left; }
  .vm-item svg { width: 16px; height: 16px; flex: none; color: var(--serif); }
  .vm-item:active { background: var(--hover); }
  @media (hover: hover) { .vm-item:hover { background: var(--hover); } }
  .vm-item.crit, .vm-item.crit svg { color: var(--crit); }
  .vm-sep + .vm-item { margin-top: -2px; }

  .bw-hint { flex: none; color: var(--crit); font-size: 12px; padding: 0 14px 6px; }

  /* —— 画面 —— */
  .bw-stage { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; outline: none; overflow: hidden;
    margin: 0 8px 8px; border-radius: 10px; background: color-mix(in srgb, var(--bg) 70%, black); }
  :global(html[data-theme="light"]) .bw-stage { background: color-mix(in srgb, var(--bg) 88%, black); }
  .bw.narrow .bw-stage { margin: 0 4px 4px; border-radius: 8px; }

  .bw-empty { display: flex; flex-direction: column; align-items: center; gap: 4px; color: var(--muted); padding: 24px; text-align: center; max-width: 300px; }
  .bw-empty svg { width: 34px; height: 34px; margin-bottom: 10px; opacity: .7; }
  .bw-t1 { font-size: 14.5px; font-weight: 500; color: var(--serif); }
  .bw-t2 { font-size: 12.5px; line-height: 1.5; }

  .cwrap { position: relative; flex: none; }
  /* 原生模式：画布只是被真视图盖住的占位，连同竖屏手机框一起藏起来——
     缩放摆位后视图四周会露出留白，别让空画布/空边框从缝里探出头。
     菜单打开（frozen）时原生视图让位，占位画布换成定格画面现身。 */
  .cwrap.nat { visibility: hidden; }
  .cwrap.nat.frozen { visibility: visible; }
  .cwrap:not(.portrait) { border-radius: 4px; overflow: hidden; }
  .cwrap.portrait { border-radius: 18px; overflow: hidden; box-shadow: 0 0 0 1px var(--hover-strong), 0 10px 30px rgba(0,0,0,.28); }
  .cwrap.ro canvas { pointer-events: none; }
  canvas { width: 100%; height: 100%; display: block; cursor: default; touch-action: none; }
  .aptr { position: absolute; width: 18px; height: 18px; margin: -2px 0 0 -2px; pointer-events: none; z-index: 3; transition: left .12s ease, top .12s ease; }
  .aptr svg { width: 100%; height: 100%; filter: drop-shadow(0 1px 2px rgba(0,0,0,.5)); }
  /* 隐藏输入框：必须「看得见」才能聚焦唤键盘，所以用透明 + 1px 而不是 display:none；
     16px 字号防 iOS 聚焦时整页放大 */
  .ime { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; resize: none; font-size: 16px; pointer-events: none; }
  .ime-chip { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 3; max-width: calc(100% - 20px); display: flex; align-items: center; gap: 10px;
    padding: 6px 6px 6px 12px; border: 0; border-radius: 999px; background: color-mix(in srgb, var(--text) 84%, transparent); color: var(--bg); font: inherit; font-size: 12px; white-space: nowrap; }
  .ime-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .ime-x { flex-shrink: 0; padding: 2px 9px; border-radius: 999px; background: color-mix(in srgb, var(--bg) 22%, transparent); }
  .ripple { position: absolute; width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 2px solid var(--coral); border-radius: 50%; pointer-events: none; z-index: 2; animation: bwRipple .5s ease-out forwards; }
  @keyframes bwRipple { from { transform: scale(.25); opacity: .9; } to { transform: scale(1); opacity: 0; } }

  .bw.coarse .urlbar input, .bw.coarse .u-show { font-size: 14px; }
  .bw.coarse .nbtn svg, .bw.coarse .devkey > svg:first-child { width: 19px; height: 19px; }
  .bw.coarse .bw-nav { padding: 4px 6px; }
  .bw.coarse .vm-item { height: 42px; font-size: 14px; }
  .bw.coarse .seg-b { height: 36px; font-size: 13px; }
  .bw.coarse .vp-in, .bw.coarse .vp-go { height: 36px; }
  .bw.coarse .chip { height: 34px; }
</style>
