<script>
  // 手机端「扫一扫」：全屏取景 → 解码 → 确认卡 → /api/pair/approve，网页那头即登录。
  // 解码优先原生 BarcodeDetector（Chromium 内建、零依赖；WebView 上不可用时 detect 会抛，
  // 抛一次就换 jsQR），否则懒加载 jsQR 逐帧扫 canvas。相册选图走同一条解码链。
  // ui.pairScan = { mode:'scan' } 打开相机；{ mode:'confirm', id, key } 是系统相机扫到网址
  // 打开网页时的直达（App.svelte 解 ?pair= 后置入），跳过取景直接进确认卡。
  //
  // 两种码同一个取景层（开源路线 S1-2）：
  //   · 登录码（?pair=，网页登录页出的）：手机已登录，替那台网页确认登录——上面这套。
  //   · 配对码（?connect=，电脑「连接与更新」、桌面客户端完成页、控制台、终端出的）：这台手机自己连上那台服务器，
  //     换到出示者身份的一张长期会话（lib/connectPair.js）。{ mode:'connect' } = 从 App 首屏、登录框、设置「扫码连接服务器」进来
  //     （标题写「扫码连接」）。没登录扫到就直接连；只要已登录（不论从哪进来）扫到配对码都先弹确认卡，因为会换掉现在的登录，
  //     确认后服务端顺手退出原来那张会话。
  //   · { mode:'landing', conn } = 手机浏览器经系统相机打开 ?connect= 网址（lib/connectPair.js 接住参数后置入）：不开相机，
  //     直接进确认卡——登录与否都要用户点「连接」，链接可能是别人转发来的。
  //
  // 外观＝iOS 27 语言（与设置页同一套 ios27 控件、「墨与象牙」配色）：整层像系统相机一样恒为暗色——kit 暗色液态玻璃
  // 圆钮 / 胶囊、象牙色取景角、一道柔光扫过；扫到码那一刻把当前帧定格（取景角收拢），结果卡（kit「Sheet」暗色材质）
  // 浮在这张定格的模糊底片上，而不是一块黑屏。结果卡不跟 ui.theme：亮色玻璃（#F6F6F6@73%）压在暗底上是一片脏灰。
  import { onMount, setContext } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { api, setToken } from '../lib/api.js';
  import { ui, me, applyMe } from '../lib/state.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { parsePairPayload } from '../lib/pair.js';
  import { parseConnectPayload, redeemConnect, applyConnect, connectErrorText } from '../lib/connectPair.js';
  import { isOffline } from '../lib/server.js';
  import { t, tr, locale, isEn } from '../lib/i18n.js';
  import { SI } from '../lib/settingsIcons.js';
  import { ovUrl } from '../lib/overlay.svelte.js';
  import GlassButton from './ios27/GlassButton.svelte';
  import './ios27/ink.css';
  import sheetD_pub from '../assets/ios27/sheet-dark.png';
  const sheetD = $derived(ovUrl('ios27/sheet-dark.png', sheetD_pub));
  import capD_pub from '../assets/ios27/cap44-dark.png';   // kit 暗色胶囊玻璃（镜头钮那条）
  const capD = $derived(ovUrl('ios27/cap44-dark.png', capD_pub));

  setContext('ios27', { dark: true, ink: true });
  // 透明 1×1 GIF 当 poster：安卓 WebView 给还没出帧的 <video> 画一张默认海报（灰底 + 巨大的播放键，被 object-fit
  // 放大铺满全屏），相机起流前那一瞬间就会闪出来。给一张透明海报它就不画了。
  const BLANK_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // 'camera' | 'checking' | 'confirm' | 'approving' | 'done' | 'error'
  // 配对码：'cconfirm'（已登录时先问）| 'connecting' | 'connected'
  let phase = $state('camera');
  let err = $state(''), hint = $state('');
  let info = $state(null);        // /api/pair/scan 的返回：device / ip / created
  let ticket = null;              // { id, key }
  let conn = $state(null);        // 扫到的配对码 { origin, id, secret, lan, sid }
  let connAs = $state(null);      // 兑换结果 { kind, user }
  let connVia = $state('');       // 正在试的地址（界面显示）
  const connectMode = $derived(ui.pairScan?.mode === 'connect');
  const landingMode = $derived(ui.pairScan?.mode === 'landing');
  const loggedIn = $derived(me.kind !== 'none');
  const connHost = $derived(conn ? conn.origin.replace(/^https?:\/\//, '') : '');
  let videoEl = $state(), fileEl = $state(), frameEl = $state();
  let stream = null, track = null, timer = 0, canvas = null, detector = null, jsqr = null, running = false, ticks = 0;
  let lastBadAt = 0;
  let live = $state(false);       // 相机真的出帧了（之前视频层透明，只见取景框）
  let still = $state('');         // 扫到码那一帧的定格（dataURL；结果卡垫在它的模糊版上）
  let lock = $state(false);       // 取景角收拢（扫到了）
  let torchOk = $state(false), torchOn = $state(false);
  // —— 镜头与变焦 ——
  // 变焦一律按「相对主摄的倍率」表示（.6 / 1 / 3，跟系统相机一样）。三种来源，按能力自动选：
  //   hw：当前相机轨道支持 zoom 约束（逻辑多摄的 CONTROL_ZOOM_RATIO，<1 就是超广角，拉到长焦焦段系统自己切镜头）；
  //   dev：超广角 / 长焦是另一颗单独的相机（enumerateDevices 里另一个 back 设备）——点镜头钮就换设备；
  //   digital：两样都没有时，CSS 放大画面 + 解码时裁同一块区域（取景是 2560×1440 高清流，2× 仍清楚）。
  // 哪颗是超广角 / 长焦靠 apk 原生给的等效焦距（AndroidStore.cameraLenses；旧 apk / 网页上没有就只用 hw / digital）。
  let lenses = $state([]);        // [{ z, dev, base }]：z＝相对主摄倍率，dev＝设备 id，base＝该设备 1× 相对主摄的倍率
  let curDev = '', devBase = 1, hw = null, mainDev = '';
  let curDevS = $state('');       // curDev 的响应式副本（镜头钮高亮用）
  let zoom = $state(1);           // 当前相对主摄倍率
  let dz = $state(1);             // 数字变焦（CSS 放大）倍数，hw 时恒 1
  let zoomUi = $state(false);     // 捏合中：镜头钮上显示实时倍率
  let shot = $state(''), shotOut = $state(false);   // 换镜头时垫的上一帧（模糊过渡）
  let canFocus = false, focusRing = $state(null);   // 点按对焦（设备支持 pointsOfInterest 时才有）
  const DMAX = 4;
  // apk 里走原生相机（window.BridgeScan，android ScanCamera）：WebView 的网页相机只给主摄、没有变焦能力，
  // 超广角 / 长焦根本够不着。原生那头开 Camera2 设 CONTROL_ZOOM_RATIO（系统自己换镜头）、ZXing 解码，
  // 画面垫在透明的 WebView 底下；这里只画界面、转发手势。旧 apk 没有这个桥就照旧走 getUserMedia。
  const natCam = typeof window !== 'undefined' && !!window.BridgeScan?.start;
  let nativeOn = $state(false);
  let natTarget = null;           // 换相机后要落到的那一档
  const ident = $derived(me.kind === 'admin' ? t('管理员') : (me.user || t('我')));
  const secure = typeof window !== 'undefined' && window.isSecureContext !== false;
  const sheet = $derived(phase !== 'camera' && phase !== 'checking');

  function haptic(kind) { try { window.AndroidStore?.haptic?.(kind); } catch {} }
  function close() { stopCam(); ui.pairScan = null; }
  $effect(() => pushBackLayer(close));

  onMount(() => {
    const p = ui.pairScan;
    if (p?.mode === 'confirm' && p.id && p.key) onPayload({ id: p.id, key: p.key });
    else if (p?.mode === 'landing' && p.conn) { conn = p.conn; phase = 'cconfirm'; }
    else startCam();
    return stopCam;
  });

  function camErr(e) {
    const n = e?.name || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') return t('相机权限被拒绝。请在系统设置里允许 The Bridge 使用相机，或从相册选择二维码截图。');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return t('没有找到可用的相机。');
    if (n === 'NotReadableError') return t('相机被其它应用占用，请关闭后重试。');
    return t('打不开相机：{reason}', { reason: e?.message || n || t('未知错误') });
  }

  // 开一路流：要 2560×1440（旧版 1280×720 竖屏铺满时实际只剩几百像素宽，糊）；顺带要 zoom 能力。
  // 带 zoom:true 被拒时分两种：apk 里相机权限其实已给（cameraGranted）＝只是变焦能力没给，去掉 zoom 再开一次；
  // 别的异常（约束不满足等）同样退一步；真没给相机就直接报，免得系统授权框弹两次。
  async function openStream(deviceId) {
    const base = { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } };
    const video = deviceId ? { ...base, deviceId: { exact: deviceId } } : { ...base, facingMode: { ideal: 'environment' } };
    const gum = (v) => navigator.mediaDevices.getUserMedia({ video: v, audio: false });
    try { return await gum({ ...video, zoom: true }); }
    catch (e) {
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      let granted = false;
      try { granted = !!window.AndroidStore?.cameraGranted?.(); } catch {}
      if (denied && !granted) throw e;
      return await gum(video);
    }
  }

  // 接上一路流：读能力（变焦 / 对焦 / 手电筒），开连续对焦
  async function attach(s) {
    stream = s;
    track = s.getVideoTracks?.()[0] || null;
    curDev = track?.getSettings?.().deviceId || '';
    curDevS = curDev;
    let caps = {};
    try { caps = track?.getCapabilities?.() || {}; } catch {}
    const z = caps.zoom;
    hw = z && z.max > z.min ? { min: z.min, max: Math.min(z.max, 10), step: z.step || 0.01 } : null;
    torchOk = !!caps.torch; torchOn = false;
    const fm = caps.focusMode || [];
    canFocus = fm.includes('single-shot') && 'pointsOfInterest' in (track?.getSettings?.() || {});
    if (fm.includes('continuous')) { try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {} }
    videoEl.srcObject = s;
    try { await videoEl.play(); } catch {}
  }

  async function startCam() {
    phase = 'camera'; err = ''; hint = ''; lock = false; live = false; still = '';
    if (natCam) { startNative(); return; }
    if (!secure) { phase = 'error'; err = t('当前页面不是安全上下文（https），浏览器不允许打开相机。可从相册选择二维码截图。'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { phase = 'error'; err = t('此设备不支持网页相机。可从相册选择二维码截图。'); return; }
    let s;
    try { s = await openStream(mainDev || ''); } catch (e) { phase = 'error'; err = camErr(e); return; }
    if (!videoEl) { s.getTracks().forEach((trk) => trk.stop()); return; }
    await attach(s);
    if (!mainDev) { mainDev = curDev; await buildLenses(); }
    devBase = 1; dz = 1; zoom = 1;
    if (hw) setZoom(1, true);
    running = true;
    await ensureDecoder();
    if (phase === 'camera') tick();
  }
  // —— 原生相机 ——
  function startNative() {
    window.__bridgeScan = onNative;
    nativeOn = true;
    document.documentElement.classList.add('ncam');
    try { window.BridgeScan.start(curDev || mainDev || ''); }
    catch (e) { stopNative(); phase = 'error'; err = camErr(e); }
  }
  function stopNative() {
    if (!nativeOn) return;
    nativeOn = false;
    try { window.BridgeScan.stop(); } catch {}
    document.documentElement.classList.remove('ncam');
    if (window.__bridgeScan === onNative) window.__bridgeScan = null;
  }
  function sendRoi() {
    const f = frameEl?.getBoundingClientRect();
    if (!f?.width || !nativeOn) return;
    try { window.BridgeScan.roi(f.left / innerWidth, f.top / innerHeight, f.right / innerWidth, f.bottom / innerHeight); } catch {}
  }
  function onNative(ev) {
    if (!ev || !nativeOn) return;
    if (ev.type === 'ready') {
      if (!mainDev) mainDev = ev.main || ev.cam;
      curDev = ev.cam; curDevS = ev.cam;
      hw = ev.zr && ev.zr[1] > ev.zr[0] ? { min: ev.zr[0], max: Math.min(ev.zr[1], 10), step: 0.01 } : null;
      torchOk = !!ev.torch; torchOn = false;
      canFocus = !!ev.focus;
      if (Array.isArray(ev.lenses) && ev.lenses.length) lenses = ev.lenses.map((l) => ({ z: +l.z, dev: String(l.cam), base: +l.base || 1 })).sort((a, b) => a.z - b.z);
      const tgt = natTarget; natTarget = null;
      const lens = lenses.find((l) => l.dev === curDev && (tgt ? l === tgt || (l.z === tgt.z && l.dev === tgt.dev) : true));
      devBase = tgt && tgt.dev === curDev ? tgt.base : (lens && lens.dev !== mainDev ? lens.base : 1);
      dz = 1;
      const want = tgt && tgt.dev === curDev ? tgt.z : (zoom >= zRange()[0] && zoom <= zRange()[1] ? zoom : devBase);
      zoom = devBase;
      setZoom(want, true);
      window.__scanDiag = ev;   // 排查镜头档用：控制台看 window.__scanDiag
      sendRoi();
      running = true;
    } else if (ev.type === 'frame') {
      live = true;
      if (shot && !shotOut) { shotOut = true; setTimeout(() => { shot = ''; shotOut = false; }, 320); }
    } else if (ev.type === 'shot') {
      shot = ev.jpeg || ''; shotOut = false;
    } else if (ev.type === 'result') {
      if (phase !== 'camera') return;
      if (route(String(ev.text || ''), () => { still = ev.jpeg || ''; lock = true; })) return;
      if (Date.now() - lastBadAt > 2500) { lastBadAt = Date.now(); hint = badHint(ev.text); haptic('error'); setTimeout(() => { if (hint) hint = ''; }, 1800); }
      setTimeout(() => { try { if (nativeOn) window.BridgeScan.again(); } catch {} }, 1200);
    } else if (ev.type === 'error') {
      stopNative();
      phase = 'error';
      err = ev.code === 'denied' ? camErr({ name: 'NotAllowedError' }) : ev.code === 'busy' ? camErr({ name: 'NotReadableError' }) : t('打不开相机，请重试，或从相册选择二维码截图。');
    }
  }
  $effect(() => { if (nativeOn && frameEl && live) sendRoi(); });

  function onFrames() {
    if (!videoEl?.videoWidth || !stream) return;
    live = true;
    if (shot && !shotOut) { shotOut = true; setTimeout(() => { shot = ''; shotOut = false; }, 320); }
  }

  // —— 镜头清单 ——
  const camId = (label) => (/camera2 (\S+?), facing/.exec(label || '') || [])[1];
  function nativeLenses() { try { return JSON.parse(window.AndroidStore?.cameraLenses?.() || '[]') || []; } catch { return []; } }
  const niceTele = (r) => { const h = Math.round(r * 2) / 2; return Math.abs(h - Math.round(h)) < 0.01 ? Math.round(h) : h; };
  async function buildLenses() {
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch {}
    const nat = nativeLenses();
    const natOf = (d) => nat.find((n) => n.id === camId(d?.label));
    const mainN = natOf(devs.find((d) => d.deviceId === mainDev));
    const mainEq = mainN?.eq || 0;
    const out = [{ z: 1, dev: mainDev, base: 1 }];
    if (hw) {
      if (hw.min < 0.95) out.push({ z: hw.min, dev: mainDev, base: 1 });     // 逻辑多摄：变焦比 <1 即超广角
      const tele = mainEq ? (mainN.physical || []).map((p) => (p.eq ? p.eq / mainEq : 0)).filter((r) => r >= 1.6 && r <= hw.max + 0.01) : [];
      if (tele.length) for (const r of tele) out.push({ z: niceTele(r), dev: mainDev, base: 1 });
      else if (hw.max >= 2) out.push({ z: 2, dev: mainDev, base: 1 });
    }
    // 单独暴露出来的超广角 / 长焦（不是同一颗逻辑相机里的）：等效焦距对得上才认，免得把微距、景深镜头当成一档
    if (mainEq) {
      for (const d of devs) {
        if (d.deviceId === mainDev) continue;
        const n = natOf(d);
        if (!n?.eq || n.facing !== 'back') continue;
        const r = n.eq / mainEq;
        if (r < 0.4 || (r > 0.92 && r < 1.6) || r > 12) continue;
        if (out.some((o) => Math.abs(o.z - r) / r < 0.15)) continue;
        out.push({ z: r >= 1 ? niceTele(r) : r, dev: d.deviceId, base: r });
      }
    }
    if (!hw && !out.some((o) => o.z >= 1.8)) out.push({ z: 2, dev: mainDev, base: 1 });   // 数字变焦兜底
    out.sort((a, b) => a.z - b.z);
    lenses = out.filter((o, i) => !i || Math.abs(o.z - out[i - 1].z) > 0.05);
  }
  // 当前设备上能变到的范围（相对主摄）
  const zRange = () => hw ? [devBase * hw.min, devBase * hw.max] : [devBase, devBase * DMAX];
  // 高亮哪颗镜头钮：同一设备里倍率不超过当前值的最大那档
  const activeLens = $derived.by(() => {
    let a = -1;
    lenses.forEach((l, i) => { if (l.dev === curDevS && l.z <= zoom * 1.02 + 0.01) a = i; });
    if (a < 0) a = lenses.findIndex((l) => l.dev === curDevS);
    return a;
  });
  const fmtZ = (z) => {
    if (z < 0.95) return '.' + Math.round(z * 10);
    const r = Math.round(z * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  };

  // 设倍率：hw 走 applyConstraints（合并排队：上一次没落定前只留最新值）；digital 改 CSS 放大
  let hwPending = null, hwBusy = false;
  async function pumpHw() {
    if (hwBusy) return; hwBusy = true;
    while (hwPending != null && track) {
      const v = hwPending; hwPending = null;
      try { await track.applyConstraints({ advanced: [{ zoom: v }] }); } catch {}
    }
    hwBusy = false;
  }
  function setZoom(z, quiet = false) {
    const [lo, hi] = zRange();
    z = Math.max(lo, Math.min(hi, z));
    const before = activeLens;
    zoom = z;
    const local = z / devBase;
    if (nativeOn) { try { window.BridgeScan.zoom(hw ? Math.max(hw.min, Math.min(hw.max, local)) : 1); } catch {} dz = hw ? 1 : local; }
    else if (hw) { hwPending = +Math.max(hw.min, Math.min(hw.max, Math.round(local / hw.step) * hw.step)).toFixed(3); pumpHw(); dz = 1; }
    else dz = local;
    if (!quiet && activeLens !== before) haptic('text');   // 跨过一档镜头给一下轻触感，跟系统相机一样
  }
  let zAnim = 0;
  function animateZoom(to) {
    cancelAnimationFrame(zAnim);
    const from = zoom, t0 = performance.now(), dur = 300;
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      setZoom(from + (to - from) * e, true);
      if (k < 1) zAnim = requestAnimationFrame(step);
    };
    zAnim = requestAnimationFrame(step);
  }
  // 点镜头钮：同一设备就平滑变过去；另一颗相机就换流（上一帧模糊垫着，新画面出来再淡掉）
  let switching = false;
  async function pickLens(l) {
    if (switching || phase !== 'camera') return;
    haptic('tick');
    if (l.dev === curDev) { animateZoom(l.z); return; }
    if (nativeOn) { cancelAnimationFrame(zAnim); natTarget = l; live = false; try { window.BridgeScan.useCam(l.dev); } catch {} return; }
    switching = true;
    try {
      const v = videoEl;
      if (v?.videoWidth) shot = snap(v, v.videoWidth, v.videoHeight, 720);
      shotOut = false; live = false;
      clearTimeout(timer); timer = 0; running = false;
      cancelAnimationFrame(zAnim);
      try { stream?.getTracks().forEach((trk) => trk.stop()); } catch {}
      let s;
      try { s = await openStream(l.dev); }
      catch { s = await openStream(mainDev); l = lenses.find((x) => x.dev === mainDev && x.z === 1) || l; }
      await attach(s);
      devBase = l.dev === curDev ? l.base : 1;
      dz = 1; zoom = devBase;
      setZoom(l.dev === curDev ? l.z : devBase, true);   // 落到那一档（比如超广角上点「2」＝回主摄再放大到 2）
      running = true;
      if (phase === 'camera') tick();
    } catch (e) { phase = 'error'; err = camErr(e); }
    switching = false;
  }

  // —— 手势：双指捏合变焦，单指轻点对焦（设备支持时），桌面滚轮也能变焦 ——
  const pts = new Map();
  let pinch = null, tap = null, zuiT = 0;
  function showZoomUi() { zoomUi = true; clearTimeout(zuiT); }
  function hideZoomUi() { clearTimeout(zuiT); zuiT = setTimeout(() => { zoomUi = false; }, 900); }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function pDown(e) {
    if (phase !== 'camera') return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d0: Math.max(1, dist(a, b)), z0: zoom }; tap = null;
      cancelAnimationFrame(zAnim); showZoomUi();
    } else if (pts.size === 1) tap = { x: e.clientX, y: e.clientY, t: performance.now() };
  }
  function pMove(e) {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      setZoom(pinch.z0 * dist(a, b) / pinch.d0);
    } else if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null;
  }
  function pUp(e) {
    pts.delete(e.pointerId);
    if (pinch && pts.size < 2) { pinch = null; hideZoomUi(); }
    if (tap && pts.size === 0 && performance.now() - tap.t < 350) focusAt(tap.x, tap.y);
    if (pts.size === 0) tap = null;
  }
  function onWheel(e) {
    if (phase !== 'camera') return;
    e.preventDefault();
    showZoomUi(); setZoom(zoom * Math.exp(-e.deltaY * 0.0025)); hideZoomUi();
  }

  // 屏幕坐标 → 视频帧坐标（object-fit:cover + 数字放大都以中心为原点）
  function toFrame(px, py) {
    const v = videoEl, vw = v.videoWidth, vh = v.videoHeight, W = innerWidth, H = innerHeight;
    const s = Math.max(W / vw, H / vh) * dz;
    return { x: vw / 2 + (px - W / 2) / s, y: vh / 2 + (py - H / 2) / s };
  }
  async function focusAt(px, py) {
    if (nativeOn) {
      if (!canFocus) return;
      focusRing = { x: px, y: py, k: Date.now() };
      const k = focusRing.k;
      haptic('text');
      try { window.BridgeScan.focus(px / innerWidth, py / innerHeight); } catch {}
      setTimeout(() => { if (focusRing?.k === k) focusRing = null; }, 1500);
      return;
    }
    if (!canFocus || !track || !videoEl?.videoWidth) return;
    const p = toFrame(px, py);
    const x = Math.max(0, Math.min(1, p.x / videoEl.videoWidth)), y = Math.max(0, Math.min(1, p.y / videoEl.videoHeight));
    const k = Date.now();
    focusRing = { x: px, y: py, k };
    haptic('text');
    try { await track.applyConstraints({ advanced: [{ focusMode: 'single-shot', pointsOfInterest: [{ x, y }] }] }); } catch {}
    setTimeout(() => {
      if (focusRing?.k === k) focusRing = null;
      try { track?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
    }, 2600);
  }

  async function ensureDecoder() {
    if (detector || jsqr) return;
    if ('BarcodeDetector' in window) {
      try {
        const fm = await window.BarcodeDetector.getSupportedFormats?.();
        if (!fm || fm.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { detector = null; }
    }
    if (!detector) await loadJsqr();
  }
  async function loadJsqr() {
    if (jsqr) return;
    try { jsqr = (await import('jsqr')).default; }
    catch { phase = 'error'; err = t('解码模块加载失败，请检查网络后重试。'); }
  }

  function stopCam() {
    stopNative();
    running = false;
    clearTimeout(timer); timer = 0;
    cancelAnimationFrame(zAnim);
    try { stream?.getTracks().forEach((trk) => trk.stop()); } catch {}
    stream = null; track = null; torchOk = false; torchOn = false; live = false;
    try { if (videoEl) videoEl.srcObject = null; } catch {}
  }

  async function toggleTorch() {
    if (nativeOn) { torchOn = !torchOn; try { window.BridgeScan.torch(torchOn); } catch {} haptic('tick'); return; }
    if (!track) return;
    const next = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: next }] }); torchOn = next; haptic('tick'); }
    catch { torchOk = false; torchOn = false; }
  }

  // 截一帧（跟屏幕上看到的一致：数字放大时只截放大后中间那块）
  function snap(src, w, h, maxSide) {
    try {
      let r = { x: 0, y: 0, w, h };
      if (src === videoEl && dz > 1.001) { const cw = w / dz, ch = h / dz; r = { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch }; }
      const s = Math.min(1, maxSide / Math.max(r.w, r.h, 1));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(r.w * s)); c.height = Math.max(1, Math.round(r.h * s));
      c.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.86);
    } catch { return ''; }
  }
  // 定格：扫到码那一刻的画面（停相机后画面不至于一下子变黑）
  function freeze(src, w, h) { still = snap(src, w, h, 1280); lock = true; }

  // 解码：从 src 里裁 r 这块画进画布（长边压到 maxSide），交给 BarcodeDetector 或 jsQR。返回文本或 ''。
  async function decodeFrom(src, r, maxSide) {
    const s = Math.min(1, maxSide / Math.max(r.w, r.h, 1));
    const cw = Math.max(1, Math.round(r.w * s)), ch = Math.max(1, Math.round(r.h * s));
    canvas ||= document.createElement('canvas');
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, cw, ch);
    if (detector) {
      try {
        const codes = await detector.detect(canvas);
        return codes?.[0]?.rawValue || '';
      } catch {
        detector = null;               // WebView 无 GMS：原生检测器不可用，换 jsQR
        await loadJsqr();
        if (!jsqr) return '';
      }
    }
    if (!jsqr) return '';
    const img = ctx.getImageData(0, 0, cw, ch);
    const q = jsqr(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
    return q?.data || '';
  }
  // 两种裁法轮流：取景框外扩 30%（按原分辨率、最多 960px——远处的小码也认得出）/ 屏幕上看得见的整块（压到 720px）
  function regionOf(v, full) {
    const vw = v.videoWidth, vh = v.videoHeight;
    let a, b;
    const f = !full && frameEl?.getBoundingClientRect();
    if (f && f.width) {
      const pad = f.width * 0.3;
      a = toFrame(f.left - pad, f.top - pad); b = toFrame(f.right + pad, f.bottom + pad);
    } else { a = toFrame(0, 0); b = toFrame(innerWidth, innerHeight); }
    const x = Math.max(0, a.x), y = Math.max(0, a.y);
    return { x, y, w: Math.min(vw, b.x) - x, h: Math.min(vh, b.y) - y };
  }

  async function tick() {
    if (!running || phase !== 'camera') return;
    const v = videoEl;
    if (v && v.readyState >= 2 && v.videoWidth && !switching) {
      if (!live) live = true;
      const full = (ticks++ % 2) === 1;
      let text = '';
      try { const r = regionOf(v, full); if (r.w > 8 && r.h > 8) text = await decodeFrom(v, r, full ? 720 : 960); } catch {}
      if (!running || phase !== 'camera') return;
      if (text) {
        if (route(text, () => freeze(v, v.videoWidth, v.videoHeight))) return;
        if (Date.now() - lastBadAt > 2500) { lastBadAt = Date.now(); hint = badHint(text); haptic('error'); setTimeout(() => { if (hint) hint = ''; }, 1800); }
      }
    }
    timer = setTimeout(tick, detector ? 140 : 90);
  }

  // 相册选图：同一条解码链（整张图，长边压到 1200）
  async function onFile(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    let bmp = null;
    try { bmp = await createImageBitmap(f); } catch { hint = t('读不出这张图片'); return; }
    await ensureDecoder();
    let text = '';
    try { text = await decodeFrom(bmp, { x: 0, y: 0, w: bmp.width, h: bmp.height }, 1200); } catch {}
    const hit = !!text && route(text, () => freeze(bmp, bmp.width, bmp.height));
    try { bmp.close?.(); } catch {}
    if (hit) return;
    hint = text ? badHint(text) : t('图片里没有识别到二维码'); haptic('error'); setTimeout(() => { hint = ''; }, 2200);
  }

  // 扫到的文字分流：配对码 → 连接这台手机；登录码 → 替网页登录（要已登录）。认得返回 true（先 snap 定格再停相机）。
  function route(text, snap) {
    const cp = parseConnectPayload(text);
    if (cp) { snap?.(); onConnect(cp); return true; }
    const p = parsePairPayload(text);
    if (p && me.kind !== 'none') { snap?.(); onPayload(p); return true; }
    return false;
  }
  function badHint(text) {
    // 没登录时扫到的是网页登录码：那是给已登录的手机替网页登录用的
    if (parsePairPayload(text)) return t('这是网页的登录二维码：先连上服务器并登录，再扫它');
    return connectMode ? t('这不是 The Bridge 的配对二维码') : t('这不是 The Bridge 的登录二维码');
  }

  // —— 配对码：这台手机连上那台服务器 ——
  function onConnect(cp) {
    stopCam();
    conn = cp; err = ''; hint = '';
    haptic('tick');
    // 已登录（账户卡「扫一扫」、设置「扫码连接服务器」）：会换掉这台手机现在的服务器 / 登录，先问一句；没登录（首屏、登录框）直接连
    if (me.kind !== 'none') { phase = 'cconfirm'; return; }
    doConnect();
  }
  async function doConnect() {
    if (!conn) return;
    phase = 'connecting'; err = '';
    // 网页（不是 App）只能兑换本站的码：别的服务器的码直接打开那个网址，由那边的网页接着登录（那边落地照样先弹确认卡）
    if (!isOffline() && conn.origin !== location.origin) {
      location.assign(conn.origin + '/?connect=' + conn.id + '.' + conn.secret);
      return;
    }
    try {
      // 网页：已登录时用户刚在确认卡上同意了替换，服务端兑换成功后顺手退出这个浏览器原来的登录（cookie 里带着的那张；
      // 没登录就没有可退的，照样传）。App 那边在 applyConnect 里退。
      const r = await redeemConnect(conn, { onStep: (o) => { connVia = o.replace(/^https?:\/\//, ''); }, replace: !isOffline() });
      connAs = { kind: r.res.kind, user: r.res.user || null };
      if (isOffline()) {
        applyConnect(r);
        phase = 'connected'; haptic('done');
        setTimeout(() => location.reload(), 900);   // 用新地址、新会话重新走启动流程
        return;
      }
      // 手机浏览器上的本站：会话令牌当 Bearer（Set-Cookie 也已种上），刷新身份即可
      setToken(r.res.token);
      try { applyMe(await api.auth()); } catch { applyMe({ kind: r.res.kind, user: r.res.user || null }); }
      ui.loginOpen = false;
      phase = 'connected'; haptic('done');
      setTimeout(close, 1400);
    } catch (e) {
      phase = 'error';
      err = connectErrorText(e);
    }
  }

  async function onPayload(p) {
    stopCam();
    ticket = p; phase = 'checking'; err = ''; hint = '';
    try {
      info = await api.post('/api/pair/scan', { id: p.id, key: p.key });
      phase = 'confirm';
      haptic('tick');
    } catch (e) {
      phase = 'error';
      err = tr(e?.body?.error) || (e?.status === 401 ? t('请先在手机上登录，再扫码') : t('二维码无效或已过期，请在网页上刷新后重扫'));
    }
  }
  async function approve() {
    if (!ticket || phase !== 'confirm') return;
    phase = 'approving';
    try { await api.post('/api/pair/approve', ticket); phase = 'done'; haptic('done'); setTimeout(close, 1500); }
    catch (e) { phase = 'error'; err = tr(e?.body?.error) || t('确认失败，请重扫'); }
  }
  async function reject() {
    const tk = ticket; ticket = null;
    if (tk) { try { await api.post('/api/pair/reject', tk); } catch {} }
    close();
  }
  function rescan() { info = null; ticket = null; conn = null; connAs = null; still = ''; lock = false; startCam(); }
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString(isEn() ? locale() : [], { hour: isEn() ? 'numeric' : '2-digit', minute: '2-digit' }); } catch { return ''; } };

  // 结果卡头上的线稿图标（同设置页 24 网格 1.6 描边）
  const GLYPH = {
    phone: SI.phone,
    web: SI.localpc,
    ok: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.4l2.5 2.5 4.9-5.3"/>',
    bad: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.9v4.9"/><path d="M12 16.1h.01" stroke-width="2.3"/>',
  };
  const svg = (k, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${GLYPH[k] || ''}</svg>`;
  const TORCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 3.5h9v3.2l-2.2 3.3v9.5a1.5 1.5 0 0 1-1.5 1.5h-1.6a1.5 1.5 0 0 1-1.5-1.5V10L7.5 6.7z"/><path d="M7.5 6.7h9M12 13.2v2"/></svg>';
</script>

<div class="ps i27ink dark" class:native={nativeOn} transition:fade={{ duration: 200 }}>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video class="cam" class:live bind:this={videoEl} poster={BLANK_POSTER} playsinline muted autoplay disablepictureinpicture
    style:transform={dz > 1.001 ? `scale(${dz})` : null}
    onplaying={onFrames} onloadeddata={onFrames}></video>
  {#if shot}<img class="shot" class:out={shotOut} src={shot} alt="" aria-hidden="true" />{/if}
  {#if still}
    <img class="still" src={still} alt="" aria-hidden="true" />
    <img class="still soft" class:on={sheet} src={still} alt="" aria-hidden="true" />
  {/if}

  <!-- 手势层：双指捏合变焦、轻点对焦（在画面之上、按钮之下） -->
  <div class="gest" class:off={sheet} aria-hidden="true"
    onpointerdown={pDown} onpointermove={pMove} onpointerup={pUp} onpointercancel={pUp} onwheel={onWheel}></div>

  <!-- 取景：四周压暗（巨型 box-shadow 挖出中间的圆角方），象牙色四角 + 一道柔光扫过；扫到码四角收拢 -->
  <div class="mask" class:off={sheet} aria-hidden="true">
    <div class="frame" class:live class:lock bind:this={frameEl}>
      <i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
      <span class="clip">
        {#if phase === 'camera' && live}<span class="sheen"></span>{/if}
        {#if phase === 'checking'}<span class="busy"></span>{/if}
      </span>
    </div>
  </div>
  {#if focusRing}
    {#key focusRing.k}<span class="focus" style:left="{focusRing.x}px" style:top="{focusRing.y}px" aria-hidden="true"></span>{/key}
  {/if}

  <div class="top" class:off={sheet}>
    <GlassButton symbol="xmark" weight={500} aria={t('关闭')} onclick={close} />
    <span class="title">{connectMode ? t('扫码连接') : t('扫一扫')}</span>
    {#if torchOk}
      {#if torchOn}
        <button class="torch-on" type="button" aria-label={t('关闭手电筒')} aria-pressed="true" onclick={toggleTorch}>{@html TORCH}</button>
      {:else}
        <GlassButton round aria={t('打开手电筒')} onclick={toggleTorch}><span class="tg">{@html TORCH}</span></GlassButton>
      {/if}
    {:else}
      <span class="sp" aria-hidden="true"></span>
    {/if}
  </div>

  <div class="bot" class:off={sheet}>
    {#if lenses.length > 1 && live}
      <div class="lens" style:--cap={`url("${capD}")`} role="group" aria-label={t('镜头')} in:fade={{ duration: 220 }}>
        {#each lenses as l, i (l.dev + ':' + l.z)}
          <button type="button" class="lb" class:on={i === activeLens} aria-pressed={i === activeLens}
            aria-label={fmtZ(l.z) + '×'} onclick={() => pickLens(l)}>
            {i === activeLens ? fmtZ(zoomUi || Math.abs(zoom - l.z) > 0.04 ? zoom : l.z) + '×' : fmtZ(l.z)}
          </button>
        {/each}
      </div>
    {/if}
    <p class="hint" class:warn={!!hint}>{phase === 'checking' ? t('正在校验…') : (hint || (!live && phase === 'camera' ? t('正在打开相机…') : (connectMode ? t('对准电脑上显示的配对二维码') : t('对准网页登录页或电脑上的二维码'))))}</p>
    <GlassButton symbol="photo.on.rectangle" weight={400} label={t('从相册选择')} onclick={() => fileEl?.click()} />
  </div>

  {#if sheet}
    <button class="bd" type="button" onclick={phase === 'done' ? close : undefined} aria-hidden="true" tabindex="-1"></button>
    <div class="sheet" role="dialog" aria-modal="true" style:--glass={`url("${sheetD}")`}
      in:fly={{ y: 80, duration: 460, easing: cubicOut }}>
      {#key phase === 'approving' ? 'confirm' : phase}
      <div class="sh-in" in:fade={{ duration: 180 }}>
      {#if phase === 'cconfirm'}
        <span class="glyph">{@html svg('phone')}</span>
        {#if landingMode}
          <!-- 手机浏览器经系统相机 / 链接打开 ?connect=：同一台服务器，换的是这个浏览器的登录 -->
          <h3>{t('用配对码登录')}</h3>
          <p class="sub">{loggedIn ? t('这个浏览器将改为以出示二维码的那个账号登录；现在的登录（{ident}）会被退出。', { ident }) : t('这个浏览器将以出示二维码的那个账号登录。')}</p>
        {:else}
          <h3>{t('连接这台手机')}</h3>
          <p class="sub">{loggedIn ? t('这台手机将连到下面这台服务器，并以出示二维码的那个账号登录；现在的登录会被替换。') : t('这台手机将连到下面这台服务器，并以出示二维码的那个账号登录。')}</p>
        {/if}
        <div class="rows">
          <div class="row"><span>{t('服务器')}</span><b>{connHost}</b></div>
        </div>
        <p class="foot">{landingMode ? t('只有你刚用这台设备扫了自己电脑上的二维码时才点「连接」；别人发来的链接请点「取消」。') : t('只扫你自己电脑上显示的二维码。')}</p>
        <div class="btns">
          <button class="btn default" type="button" onclick={doConnect}>{t('连接')}</button>
          <button class="btn" type="button" onclick={close}>{t('取消')}</button>
        </div>
      {:else if phase === 'connecting'}
        <span class="glyph"><span class="spin"></span></span>
        <h3>{t('正在连接…')}</h3>
        <p class="sub mono">{connVia || connHost}</p>
      {:else if phase === 'connected'}
        <span class="glyph ok">{@html svg('ok', 1.8)}</span>
        <h3>{t('已连接')}</h3>
        <p class="sub">{connAs?.kind === 'admin' ? t('以管理员身份登录了 {host}。', { host: connHost }) : t('以 {user} 的身份登录了 {host}。', { user: connAs?.user || '', host: connHost })}</p>
      {:else if phase === 'confirm' || phase === 'approving'}
        <span class="glyph">{@html svg('web')}</span>
        <h3>{t('登录网页版')}</h3>
        <p class="sub">{t('确认后，那台设备将以「{ident}」的身份登录 The Bridge。', { ident })}</p>
        <div class="rows">
          <div class="row"><span>{t('设备')}</span><b>{tr(info?.device) || t('未知设备')}</b></div>
          {#if info?.ip}<div class="row"><span>{t('来源')}</span><b>{info.ip}</b></div>{/if}
          {#if info?.created}<div class="row"><span>{t('时间')}</span><b>{fmtTime(info.created)}</b></div>{/if}
        </div>
        <p class="foot">{t('若这不是你正在操作的设备，请点「取消」。')}</p>
        <div class="btns">
          <button class="btn default" type="button" onclick={approve} disabled={phase === 'approving'}>{phase === 'approving' ? t('确认中…') : t('确认登录')}</button>
          <button class="btn" type="button" onclick={reject} disabled={phase === 'approving'}>{t('取消')}</button>
        </div>
      {:else if phase === 'done'}
        <span class="glyph ok">{@html svg('ok', 1.8)}</span>
        <h3>{t('已登录')}</h3>
        <p class="sub">{t('网页端已经登录成功，可以去电脑上继续了。')}</p>
        <div class="btns"><button class="btn" type="button" onclick={close}>{t('完成')}</button></div>
      {:else}
        <span class="glyph bad">{@html svg('bad', 1.8)}</span>
        <h3>{t('无法完成')}</h3>
        <p class="sub">{err}</p>
        <div class="btns">
          <button class="btn default" type="button" onclick={rescan}>{t('重新扫描')}</button>
          <button class="btn" type="button" onclick={() => fileEl?.click()}>{t('从相册选择')}</button>
          <button class="link" type="button" onclick={close}>{t('关闭')}</button>
        </div>
      {/if}
      </div>
      {/key}
    </div>
  {/if}
  <input class="file" type="file" accept="image/*" bind:this={fileEl} onchange={onFile} />
</div>

<style>
  /* 原生相机：画面在 WebView 底下，页面整层透明，只留扫码层（其余界面藏起来，不然透出来） */
  :global(html.ncam), :global(html.ncam body) { background: transparent !important; }
  :global(html.ncam body *) { visibility: hidden; }
  :global(html.ncam .ps), :global(html.ncam .ps *) { visibility: visible; }
  .ps.native { background: transparent; }
  .ps { position: fixed; inset: 0; z-index: 400; overflow: hidden; color: #fff;
    background: radial-gradient(120% 80% at 50% 38%, #1d1b18 0%, #0c0b0a 70%);
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; }
  /* 相机出帧前整层透明（只见取景框与暗底），出帧后淡入；poster 用透明像素压掉 WebView 默认海报 */
  .cam { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: transparent; opacity: 0; transition: opacity 320ms var(--ea-fade, ease); }
  .cam.live { opacity: 1; }
  .cam::-webkit-media-controls { display: none !important; }
  .cam { transform-origin: 50% 50%; }
  .still { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none; }
  /* 换镜头：上一帧先糊开、新画面出来后淡掉（系统相机切镜头的那种过渡） */
  .shot { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none;
    animation: ps-blur 220ms var(--ea-fade, ease) both; transition: opacity 300ms var(--ea-fade, ease); }
  .shot.out { opacity: 0; }
  @keyframes ps-blur { to { filter: blur(18px) brightness(.8); transform: scale(1.04); } }
  .gest { position: absolute; inset: 0; touch-action: none; }
  .gest.off { pointer-events: none; }
  /* 点按对焦：象牙色圆角方，先放大落定再淡出 */
  .focus { position: absolute; width: 76px; height: 76px; margin: -38px 0 0 -38px; border-radius: 18px; pointer-events: none;
    border: 1.5px solid #f3eee4; box-shadow: 0 0 0 .5px rgba(0, 0, 0, .25), 0 2px 12px rgba(0, 0, 0, .3);
    animation: ps-focus 1400ms cubic-bezier(.2, .9, .3, 1) both; }
  @keyframes ps-focus { 0% { transform: scale(1.35); opacity: 0; } 18% { opacity: 1; } 40% { transform: scale(1); } 75% { opacity: 1; } 100% { transform: scale(1); opacity: 0; } }
  /* 模糊底片：静态图只模糊一次，换场只动 opacity */
  .still.soft { filter: blur(26px) saturate(1.15) brightness(.62); transform: scale(1.12); opacity: 0; transition: opacity 420ms var(--ea-fade, ease); }
  .still.soft.on { opacity: 1; }

  .mask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; transition: opacity 260ms var(--ea-fade, ease); }
  .mask.off, .top.off, .bot.off { opacity: 0; pointer-events: none; }
  .frame { --fs: min(68vw, 280px); position: relative; width: var(--fs); height: var(--fs); border-radius: 28px;
    box-shadow: 0 0 0 200vmax rgba(8, 7, 6, .5); }
  .clip { position: absolute; inset: 0; border-radius: 28px; overflow: hidden; }
  /* 四角：象牙色 4px 圆头描边，圆角与取景框同心；没出帧时半透明、出帧后呼吸、扫到时向内收拢 */
  .c { position: absolute; width: 38px; height: 38px; border: 4px solid #f3eee4; opacity: .55;
    transition: transform 360ms cubic-bezier(.3, 1.4, .5, 1), opacity 240ms linear, border-color 240ms linear;
    filter: drop-shadow(0 1px 6px rgba(0, 0, 0, .35)); }
  .c.tl { left: 0; top: 0; border-right: 0; border-bottom: 0; border-top-left-radius: 28px; }
  .c.tr { right: 0; top: 0; border-left: 0; border-bottom: 0; border-top-right-radius: 28px; }
  .c.bl { left: 0; bottom: 0; border-right: 0; border-top: 0; border-bottom-left-radius: 28px; }
  .c.br { right: 0; bottom: 0; border-left: 0; border-top: 0; border-bottom-right-radius: 28px; }
  .frame.live .c { opacity: 1; animation: ps-breathe 2.6s ease-in-out infinite; }
  .frame.live .c.tr { --bx: -1; --by: 1; } .frame.live .c.tl { --bx: 1; --by: 1; }
  .frame.live .c.bl { --bx: 1; --by: -1; } .frame.live .c.br { --bx: -1; --by: -1; }
  @keyframes ps-breathe { 50% { transform: translate(calc(var(--bx, 0) * 3px), calc(var(--by, 0) * 3px)); } }
  .frame.lock .c { opacity: 1; animation: none; }
  .frame.lock .c.tl { transform: translate(14px, 14px); } .frame.lock .c.tr { transform: translate(-14px, 14px); }
  .frame.lock .c.bl { transform: translate(14px, -14px); } .frame.lock .c.br { transform: translate(-14px, -14px); }
  /* 柔光：一条带亮边的象牙色渐变带自上而下扫过（transform 位移，按自身高度百分比走，不依赖取景框尺寸） */
  .sheen { position: absolute; left: 0; right: 0; top: 0; height: 42%; pointer-events: none;
    background: linear-gradient(to bottom, rgba(243, 238, 228, 0) 0%, rgba(243, 238, 228, .06) 60%, rgba(243, 238, 228, .22) 96%, rgba(243, 238, 228, .55) 100%);
    animation: ps-sweep 2.6s cubic-bezier(.45, 0, .55, 1) infinite; }
  @keyframes ps-sweep {
    0% { transform: translateY(-100%); opacity: 0; }
    15% { opacity: 1; }
    80% { opacity: 1; }
    100% { transform: translateY(238%); opacity: 0; }
  }
  .busy { position: absolute; left: 50%; top: 50%; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%;
    border: 2.5px solid rgba(243, 238, 228, .25); border-top-color: #f3eee4; animation: ps-spin .8s linear infinite; }

  /* 顶栏：kit 44 暗色玻璃圆钮 + 居中标题（17/22 Semibold）+ 右侧手电筒（设备支持时） */
  .top { position: absolute; top: 0; left: 0; right: 0; padding: calc(var(--sat, 0px) + 8px) 16px 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; transition: opacity 260ms var(--ea-fade, ease); }
  .title { flex: 1; text-align: center; font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; text-shadow: 0 1px 6px rgba(0, 0, 0, .45); }
  .sp { width: 44px; height: 44px; flex: none; }
  .tg { display: flex; width: 20px; height: 20px; }
  .tg :global(svg), .torch-on :global(svg) { width: 20px; height: 20px; display: block; }
  .torch-on { width: 44px; height: 44px; flex: none; border-radius: 50%; border: 0; padding: 0; display: flex; align-items: center; justify-content: center;
    background: #f3eee4; color: #151412; box-shadow: 0 6px 20px rgba(0, 0, 0, .3); -webkit-tap-highlight-color: transparent; }
  .torch-on:active { transform: scale(1.08); }

  .bot { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 24px calc(var(--sab, 0px) + 40px); display: flex; flex-direction: column; align-items: center; gap: 20px; transition: opacity 260ms var(--ea-fade, ease); }
  /* 镜头钮：kit 暗色玻璃胶囊里一排小圆钮（.6 / 1× / 3）；当前那颗实心象牙、字大一号，捏合时显示实时倍率 */
  .lens { position: relative; isolation: isolate; height: 44px; display: flex; align-items: center; gap: 2px; padding: 0 5px; margin-bottom: -4px; }
  .lens::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--cap) 0 210 fill / 0 70px / 40px stretch; }
  .lb { min-width: 34px; height: 34px; padding: 0 4px; border: 0; border-radius: 17px; cursor: pointer; font: inherit;
    font-size: 12px; line-height: 1; font-weight: 600; letter-spacing: -.2px; font-variant-numeric: tabular-nums;
    color: rgba(243, 238, 228, .88); background: transparent; -webkit-tap-highlight-color: transparent;
    transform: scale(.84); transition: transform 260ms cubic-bezier(.3, 1.4, .5, 1), background-color 200ms linear, color 200ms linear; }
  .lb.on { transform: none; font-size: 13px; color: #151412; background: #f3eee4; padding: 0 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, .25); }
  .lb:active { transform: scale(.92); }
  .lb.on:active { transform: scale(1.06); }
  .hint { margin: 0; max-width: 300px; font-size: 15px; line-height: 20px; color: rgba(255, 255, 255, .88); text-align: center; text-shadow: 0 1px 6px rgba(0, 0, 0, .5); transition: color .2s; }
  .hint.warn { color: #ffc9bc; }
  .file { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }

  /* —— 结果卡：kit「Sheet - iPhone」暗色材质（四周内缩 6、圆角 38、9 宫玻璃图层 + frost 模糊 + 大投影） —— */
  .bd { position: absolute; inset: 0; border: 0; padding: 0; background: transparent; cursor: default; }
  .sheet { position: absolute; left: 6px; right: 6px; bottom: calc(var(--sab, 0px) + 6px); max-width: 460px; margin: 0 auto;
    max-height: calc(100% - var(--sat, 0px) - var(--sab, 0px) - 24px); display: flex; flex-direction: column;
    border-radius: 38px; isolation: isolate; color: var(--i-label);
    -webkit-backdrop-filter: blur(6.53px); backdrop-filter: blur(6.53px); box-shadow: 0 8px 40.6px rgba(0, 0, 0, .5); }
  .sheet::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--glass) 240 fill / 80px / 16px stretch; }
  .sh-in { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none;
    display: flex; flex-direction: column; align-items: center; text-align: center; padding: 28px 20px 20px; }
  .sh-in::-webkit-scrollbar { display: none; }
  .glyph { width: 60px; height: 60px; border-radius: 18px; display: flex; align-items: center; justify-content: center; margin-bottom: 16px;
    background: var(--i-tile); color: var(--i-tile-ink); box-shadow: inset 0 0 0 .5px var(--i-label4); }
  .glyph :global(svg) { width: 30px; height: 30px; display: block; }
  .glyph.ok { color: var(--i-ok); }
  .glyph.bad { color: var(--i-red); }
  .sh-in h3 { margin: 0; font-size: 22px; line-height: 28px; font-weight: 600; letter-spacing: -.3px; }
  .sub { margin: 8px 0 0; max-width: 340px; font-size: 15px; line-height: 21px; color: var(--i-label2); }
  .sub.mono { font-variant-numeric: tabular-nums; word-break: break-all; }
  .rows { align-self: stretch; display: flex; flex-direction: column; margin-top: 20px; border-radius: 20px; overflow: hidden;
    background: var(--i-list); box-shadow: inset 0 0 0 .5px var(--i-label4); text-align: left; }
  .row { position: relative; display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 48px; padding: 0 16px; font-size: 16px; line-height: 21px; }
  .row + .row::before { content: ''; position: absolute; top: 0; left: 16px; right: 0; height: .5px; background: var(--i-label4); }
  .row span { color: var(--i-label2); flex: none; }
  .row b { font-weight: 500; text-align: right; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { margin: 12px 0 0; font-size: 12.5px; line-height: 17px; color: var(--i-label2); }
  .btns { align-self: stretch; display: flex; flex-direction: column; gap: 8px; margin-top: 22px; }
  .btn {
    height: 50px; border-radius: 25px; border: 0; padding: 0 16px; cursor: pointer; font: inherit;
    font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; color: var(--i-label);
    background: var(--i-btn); display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent;
    transition: transform 160ms cubic-bezier(.2, 0, 0, 1), filter 160ms linear, opacity 160ms linear;
  }
  .btn.default { background: var(--i-accent); color: var(--i-on-accent); }
  .btn:active:not(:disabled) { transform: scale(.97); filter: brightness(.92); }
  .btn:disabled { opacity: .45; cursor: default; }
  .link { height: 40px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 15px; color: var(--i-label2); -webkit-tap-highlight-color: transparent; }
  .spin { width: 26px; height: 26px; border-radius: 50%; border: 2.5px solid var(--i-label4); border-top-color: var(--i-label); animation: ps-spin .8s linear infinite; }
  @keyframes ps-spin { to { transform: rotate(360deg); } }
</style>
