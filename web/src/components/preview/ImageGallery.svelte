<script module>
  // 同一次打开（同一个 items 数组）只演一次 FLIP 打开：混排里翻到 pdf 再翻回图片时画廊会重挂，不该再从缩略图飞一遍
  let flippedFor = null;
</script>

<script>
  // 图片画廊（滑轨）：系统相册 / Windows 照片的手感。
  //   · 五槽滑轨（index±2）：相邻页常驻并已解码，翻页只平移滑轨——不重建、不淡入、不转圈
  //   · 触屏：1:1 跟手，松手按速度投影 + 弹簧吸附；捏合以双指中点为锚（越界阻尼、松手弹回）；放大后平移带惯性与橡皮筋，
  //     顶到边缘继续横滑就交给翻页；双击按触点智能放大 / 还原；下拉关闭（x/y 跟手并缩小，按速度判定）；单击切沉浸（纯黑底）
  //   · 电脑：滚轮 / Ctrl+滚轮 / 触控板捏合都以光标为锚缩放（挡掉整页缩放）；放大后左键拖动平移（抓手、惯性，1x 时拖动不做事）；
  //     底部居中浮条 + 缩略图条；+ - 0 1 R Shift+R ← → Home End F 快捷键；双击 / F 全屏；翻页瞬切（Windows 照片）
  //   · FLIP：描述符带 originRect 时从缩略图放大打开、缩回原位关闭；缩略图不在屏上就缩小淡出
  //   · 预载器：当前页出图后才开拉，并发 2，向后 3 张、向前 2 张；挤出窗口的取消并忘掉（decode() 只发不等）
  //   · 混排里的视频页：滑轨里是海报 + 播放钮占位，停稳在该页才挂 VideoPlayer，切走即卸载
  // 坐标：视图 { s, x, y } 以舞台中心为原点——s=1 即适应框，x/y 是适应框中心的位移（CSS 像素）。
  import { untrack, onMount, tick } from 'svelte';
  import ImageView, { firstSrc } from './ImageView.svelte';
  import VideoPlayer from './VideoPlayer.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { useViewer, isEditable } from './kit/context.js';
  import { tip } from './kit/tooltip.js';
  import { spring, SPRING, velocityTracker, project, reduced, animate, DUR, EASE } from '../../lib/motion.js';
  import { imageMeta, fmtExifDate, fmtCamera, fmtExposure } from '../../lib/imageMeta.js';
  import { registerCapture } from '../../lib/uiReport.js';
  import { previewViewAs } from '../../lib/preview.svelte.js';
  import { t, tc } from '../../lib/i18n.js';

  let { item } = $props();
  const viewer = useViewer();
  const fine = $derived(!viewer.touch);
  const index = $derived(viewer.index);
  const count = $derived(viewer.count);
  const isImg = $derived(item?.kind === 'image');

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // 橡皮筋：越界 o 像素只走一部分，d 是「最多走多远」的尺度（同 iOS UIScrollView 的阻尼曲线）
  const rb = (o, d) => (1 - 1 / ((o * 0.55) / d + 1)) * d;

  // —— 舞台尺寸（ResizeObserver：转屏 / 折叠屏展开 / 窗口拖动都跟着重排）——
  let rootEl = $state(null), blackEl = $state(null);
  let W = $state(0), H = $state(0);
  const GAP = 20;
  const P = $derived(Math.round(W + GAP));   // 一页的步长取整：滑轨停稳时整像素对齐，图不发虚
  onMount(() => {
    W = rootEl.clientWidth; H = rootEl.clientHeight;
    const ro = new ResizeObserver(() => { W = rootEl.clientWidth; H = rootEl.clientHeight; });
    ro.observe(rootEl);
    return () => ro.disconnect();
  });

  // —— 五槽滑轨 ——
  const slots = $derived.by(() => {
    const out = [];
    for (let i = index - 2; i <= index + 2; i++) { const it = viewer.itemAt(i); if (it) out.push({ i, it }); }
    return out;
  });
  let pos = $state(untrack(() => viewer.index));   // 滑轨位置（单位：页）
  let railAnim = null, railTarget = -1;
  let live = $state(false);                        // 手势 / 动画进行中（当前页开 will-change）

  // —— 视图状态（只属于 vk 这个条目；翻走停稳后复位）——
  let cv = $state.raw({ s: 1, x: 0, y: 0 });
  let vk = $state(untrack(() => item?.key || ''));
  let dis = $state.raw(null);                       // 下拉关闭的跟手位移 { x, y, k }
  let dp = $state(0);                               // 下拉进度（调暗纯黑底）
  let rots = $state.raw(new Map());                 // 每个条目的显示旋转角（只改显示，不写回文件）
  let geoRec = $state.raw(null);                    // 当前页窗格报上来的几何 { key, g }
  const curGeo = $derived(geoRec && item && geoRec.key === item.key ? geoRec.g : null);
  let readyKey = $state('');                        // 当前页已落定（出图或失败）
  let playerKey = $state('');                       // 当前挂着 VideoPlayer 的视频条目
  let veil = $state(false), flipIn = $state(false);
  let dragging = $state(false);                     // 电脑端左键拖动中
  let isFs = $state(false);

  const setView = (v) => { cv = v; if (item && vk !== item.key) vk = item.key; };
  function bounds(s) {
    const g = curGeo;
    if (!g) return { mx: 0, my: 0 };
    return { mx: Math.max(0, (s * g.bw - W) / 2), my: Math.max(0, (s * g.bh - H) / 2) };
  }
  const clampView = (v) => { const b = bounds(v.s); return { s: v.s, x: clamp(v.x, -b.mx, b.mx), y: clamp(v.y, -b.my, b.my) }; };
  const zoomed = $derived(cv.s > 1.001);
  const pannable = $derived.by(() => { const g = curGeo; return !!g && isImg && (cv.s * g.bw > W + 0.5 || cv.s * g.bh > H + 0.5); });

  // 尺寸 / 几何变了（转屏、原图头部到了）：停着的视图钳回界内
  $effect(() => {
    curGeo; W; H;
    untrack(() => {
      if (gesture || viewAnim || flingRaf || wheelRaf) return;
      const c = clampView(cv);
      if (c.x !== cv.x || c.y !== cv.y) cv = c;
    });
  });

  // —— 翻页：index 变了 → 滑轨过去（触屏弹簧；电脑瞬切）——
  let lastIdx = untrack(() => viewer.index);
  $effect(() => {
    const i = index;
    untrack(() => {
      if (i === lastIdx) return;
      lastIdx = i;
      playerKey = '';
      if (railAnim && railTarget === i) return;   // 手势松手时已经在往那儿弹了
      if (!fine && !gesture && Math.abs(i - pos) <= 1.5 && !reduced()) springRail(i, 0);
      else { railAnim?.cancel(); railAnim = null; pos = i; onSettle(); }
    });
  });
  // 换了条目（删除 / 列表刷新后同下标换了人）且滑轨没在动：视图复位
  $effect(() => {
    const k = item?.key;
    untrack(() => { if (k && vk !== k && !railAnim && !gesture) { stopView(); cv = { s: 1, x: 0, y: 0 }; vk = k; dis = null; } });
  });
  function springRail(to, vx) {
    railAnim?.cancel();
    railTarget = to; live = true;
    const step = P || 1;
    railAnim = spring({
      from: pos, to, velocity: -vx / step, ...SPRING.crisp, restDist: 0.5 / step, restVel: 20 / step,
      onUpdate: (x) => { pos = x; },
      onDone: () => { railAnim = null; pos = to; onSettle(); calm(); },
    });
    if (!railAnim.alive) railAnim = null;   // 减弱动效时 spring 同步落定：onDone 先跑、返回值后到，别留个死句柄挡住点按
  }
  function onSettle() {
    const it = item;
    if (!it) return;
    if (vk !== it.key) { stopView(); cv = { s: 1, x: 0, y: 0 }; vk = it.key; }
    dis = null;
    if (it.kind === 'video') playerKey = it.key;
  }
  onMount(() => { untrack(onSettle); });
  const videoUp = () => item?.kind === 'video' && playerKey === item.key;

  // —— 手势公共 ——
  let gesture = null;            // 触屏：{ mode, id, sx, sy, t0, p0, v0, ... }
  let viewAnim = null, viewTarget = null, flingRaf = 0, disAnim = null;
  let wheelRaf = 0, wt = null, idleT = 0;
  const vtx = velocityTracker(100), vty = velocityTracker(100);
  let lastMv = null;              // 最近一次记进测速的点 { x, y, t }
  function track(x, y, ts) { vtx.add(x, ts); vty.add(y, ts); lastMv = { x, y, t: ts }; }
  function resetTrack(x, y, ts) { vtx.reset(); vty.reset(); track(x, y, ts); }
  // 抬手取速度：抬手点与最后一次移动同位置就不再记一笔——否则「最后一下移动后过 30ms 才抬手」会把速度摊薄三成，快甩被判成慢放；
  // 抬手前已停住超过 80ms 则按停住算（Android VelocityTracker 是 40ms，放宽一倍容忍掉帧时事件晚到），慢慢拖到位再松手不会被残留速度甩出去
  function upVel(x, y, ts) {
    const m = lastMv;
    if (m && ts - m.t > 80) return { vx: 0, vy: 0 };
    if (!m || x !== m.x || y !== m.y) track(x, y, ts);
    return { vx: vtx.get(), vy: vty.get() };
  }
  function stopView() {
    viewAnim?.cancel(); viewAnim = null; viewTarget = null;
    if (flingRaf) cancelAnimationFrame(flingRaf); flingRaf = 0;
    if (wheelRaf) cancelAnimationFrame(wheelRaf); wheelRaf = 0; wt = null;
  }
  function stopAll() {
    railAnim?.cancel(); railAnim = null;
    stopView();
    disAnim?.cancel(); disAnim = null;
    if (flipAnim) { try { flipAnim.finish(); } catch {} flipAnim = null; }
  }
  function calm() {
    if (!gesture && !railAnim && !viewAnim && !flingRaf && !disAnim && !wheelRaf && !dragging) live = false;
  }
  const calmSoon = () => { clearTimeout(idleT); idleT = setTimeout(calm, 160); };
  // 视图补间（双击、按钮、键盘、捏合回弹）：进度弹簧 0→1，s / x / y 线性插值；连续操作从目标值出发
  function animateView(to) {
    stopView();
    if (reduced()) { setView(to); calm(); return; }
    const a = cv;
    if (Math.abs(a.s - to.s) < 1e-4 && Math.abs(a.x - to.x) < 0.3 && Math.abs(a.y - to.y) < 0.3) { setView(to); return; }
    viewTarget = to; live = true;
    viewAnim = spring({
      from: 0, to: 1, ...SPRING.crisp, restDist: 0.002, restVel: 0.02,
      onUpdate: (k) => setView({ s: a.s + (to.s - a.s) * k, x: a.x + (to.x - a.x) * k, y: a.y + (to.y - a.y) * k }),
      onDone: () => { viewAnim = null; viewTarget = null; calm(); },
    });
    if (!viewAnim.alive) viewAnim = null;
  }
  // 惯性平移：界内指数衰减（时间常数 325ms，同 iOS 的 normal 减速），越界换成临界阻尼弹簧拉回；hard = 电脑端硬边界
  function fling(vx, vy, hard = false) {
    stopView();
    const cap = 6000;
    vx = clamp(vx, -cap, cap); vy = clamp(vy, -cap, cap);
    let { s, x, y } = cv;
    const b = bounds(s);
    if (Math.hypot(vx, vy) < 40 && Math.abs(x) <= b.mx + 0.5 && Math.abs(y) <= b.my + 0.5) { calm(); return; }
    live = true;
    let last = 0;
    const axis = (p, v, m, dt) => {
      const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
      for (let i = 0; i < n; i++) {
        if (p > m || p < -m) { const e = p > m ? m : -m; v += (-220 * (p - e) - 30 * v) * h; p += v * h; }
        else { v *= Math.exp(-h / 0.325); p += v * h; }
        if (hard && (p > m || p < -m)) { p = clamp(p, -m, m); v = 0; }
      }
      return [p, v];
    };
    const step = (now) => {
      if (!last) { last = now; flingRaf = requestAnimationFrame(step); return; }
      const dt = Math.min(0.064, (now - last) / 1000); last = now;
      [x, vx] = axis(x, vx, b.mx, dt); [y, vy] = axis(y, vy, b.my, dt);
      const inB = Math.abs(x) <= b.mx + 0.5 && Math.abs(y) <= b.my + 0.5;
      if (inB && Math.abs(vx) < 8 && Math.abs(vy) < 8) {
        setView({ s, x: clamp(x, -b.mx, b.mx), y: clamp(y, -b.my, b.my) });
        flingRaf = 0; calm(); return;
      }
      setView({ s, x, y });
      flingRaf = requestAnimationFrame(step);
    };
    flingRaf = requestAnimationFrame(step);
  }
  // 以 m（相对舞台中心）为锚缩放到 s1：x1 = m - (m - x0)·s1/s0
  function zoomAt(s1, m = { x: 0, y: 0 }, { anim = true } = {}) {
    const g = curGeo;
    if (!g) return;
    const base = wt || viewTarget || cv;
    s1 = clamp(s1, 1, g.maxS);
    const k = s1 / base.s;
    const to = s1 <= 1.0001 ? { s: 1, x: 0, y: 0 } : clampView({ s: s1, x: m.x - (m.x - base.x) * k, y: m.y - (m.y - base.y) * k });
    if (anim) animateView(to); else { stopView(); setView(to); }
  }
  const zoomStep = (d) => zoomAt((wt || viewTarget || cv).s * (d > 0 ? 1.25 : 0.8));
  const fitView = () => animateView({ s: 1, x: 0, y: 0 });
  const actualSize = () => { const f = curGeo?.f; if (f > 0) zoomAt(1 / f); };
  function rotate(d) {
    if (!isImg) return;
    const k = item.key;
    rots = new Map(rots).set(k, (rots.get(k) || 0) + d);
    stopView(); setView({ s: 1, x: 0, y: 0 });
  }
  // 百分比 = 视图倍率 × 适应框里每原图像素占的 CSS 像素（只知比例时未知，显示「—」）
  const pct = $derived(curGeo && curGeo.f > 0 ? Math.round(cv.s * curGeo.f * 100) : 0);
  const atActual = $derived(pct > 0 && Math.abs(cv.s * curGeo.f - 1) < 0.005);
  const togglePct = () => (atActual ? fitView() : actualSize());

  // —— 触屏手势 ——
  const pts = new Map();          // pointerId → { x, y }（相对舞台中心）
  let tapT = 0, lastTap = null, lastPtr = '';
  const SLOP = 8;                 // 起滑阈值（px）
  const railMoving = () => Math.abs(pos - index) > 0.002;
  function local(e) {
    const r = rootEl.getBoundingClientRect();
    return { x: e.clientX - r.left - W / 2, y: e.clientY - r.top - H / 2 };
  }
  function onDown(e) {
    lastPtr = e.pointerType;
    if (viewer.closing || !rootEl) return;
    if (e.pointerType === 'mouse') { mouseDown(e); return; }
    const p = local(e);
    pts.set(e.pointerId, p);
    if (!gesture) {
      const wasMoving = !!railAnim || !!viewAnim || !!flingRaf || !!disAnim;
      stopAll();
      gesture = { mode: 'pending', id: e.pointerId, sx: p.x, sy: p.y, t0: performance.now(), p0: pos, v0: cv,
        onBtn: !!e.target.closest?.('button'), vid: videoUp(), caught: wasMoving };
      resetTrack(p.x, p.y, e.timeStamp);
      live = true;
      return;
    }
    if (pts.size === 2 && (gesture.mode === 'pending' || gesture.mode === 'pan') && isImg && curGeo && !gesture.vid && !railMoving()) startPinch(e);
  }
  function decide(dx, dy, e) {
    const g = gesture, horiz = Math.abs(dx) > Math.abs(dy);
    if (railMoving()) g.mode = 'page';
    else if (g.vid) {
      // 视频页：只在「起手就横滑」且不在全屏时接管翻页；其余交给 VideoPlayer 自己（点按显隐 / 双击跳转 / 长按 2x / 下滑关闭）
      const fs = !!document.fullscreenElement || !!rootEl.querySelector('[data-vp-fs]');
      g.mode = horiz && performance.now() - g.t0 < 450 && !fs ? 'page' : 'none';
    } else if (zoomed && isImg) g.mode = 'pan';
    else if (horiz) g.mode = 'page';
    else g.mode = 'dismiss';
    if (g.mode === 'none') return;
    clearTimeout(tapT); lastTap = null;
    try { rootEl.setPointerCapture(e.pointerId); } catch {}
    // 起点只往手指方向挪 8px（扣掉起滑阈值，内容不跳）；第一下就移出很远（快划 / 事件合并）时其余位移照样算数
    const d = Math.hypot(dx, dy) || 1;
    g.sx += (dx * SLOP) / d; g.sy += (dy * SLOP) / d; g.p0 = pos; g.v0 = cv;
  }
  function onMove(e) {
    if (e.pointerType === 'mouse') { mouseMove(e); return; }
    const p = pts.get(e.pointerId), g = gesture;
    if (!p || !g) return;
    const q = local(e);
    p.x = q.x; p.y = q.y;
    if (g.mode === 'pinch') { pinchMove(); return; }
    if (e.pointerId !== g.id || g.mode === 'none') return;
    track(p.x, p.y, e.timeStamp);
    if (g.mode === 'pending') {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) < SLOP) return;
      decide(p.x - g.sx, p.y - g.sy, e);
      if (g.mode === 'none') return;
    }
    const dx = p.x - g.sx, dy = p.y - g.sy;
    if (g.mode === 'page') pageTo(g.p0 - dx / (P || 1));
    else if (g.mode === 'pan') panMove(dx, dy);
    else if (g.mode === 'dismiss') dismissMove(dx, dy);
  }
  // 滑轨跟手：首尾越界走橡皮筋
  function pageTo(x) {
    const lo = 0, hi = Math.max(0, count - 1), step = P || 1;
    if (x < lo) x = lo - rb((lo - x) * step, W) / step;
    else if (x > hi) x = hi + rb((x - hi) * step, W) / step;
    pos = clamp(x, index - 1, index + 1);
  }
  function panMove(dx, dy) {
    const g = gesture, s = cv.s, b = bounds(s);
    let x = g.v0.x + dx, y = g.v0.y + dy, over = 0;
    if (x > b.mx) { over = x - b.mx; x = b.mx; } else if (x < -b.mx) { over = x + b.mx; x = -b.mx; }
    if (over) {
      const canPage = over > 0 ? index > 0 : index < count - 1;
      if (canPage) pos = clamp(index - over / (P || 1), index - 1, index + 1);   // 顶到边缘：剩下的位移交给翻页
      else { x += Math.sign(over) * rb(Math.abs(over), W); pos = index; }
    } else pos = index;
    if (y > b.my) y = b.my + rb(y - b.my, H); else if (y < -b.my) y = -b.my - rb(-b.my - y, H);
    setView({ s, x, y });
  }
  function dismissMove(dx, dy) {
    if (dy >= 0) {
      dis = { x: dx, y: dy, k: Math.max(0.6, 1 - (dy / (H || 1)) * 0.4) };
      dp = Math.min(1, dy / ((H || 1) * 0.45));
    } else { dis = { x: dx * 0.5, y: -rb(-dy, H * 0.5), k: 1 }; dp = 0; }
    viewer.dragProgress(dp);
  }
  function startPinch(e) {
    const g = gesture, [a, b] = [...pts.values()];
    clearTimeout(tapT); lastTap = null;
    g.mode = 'pinch';
    g.d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    g.m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; g.m = g.m0;
    g.v0 = cv; pos = index;
    for (const id of pts.keys()) { try { rootEl.setPointerCapture(id); } catch {} }
    void e;
  }
  function pinchMove() {
    const g = gesture, geo = curGeo;
    if (!geo || pts.size < 2) return;
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    g.m = m;
    const raw = (g.v0.s * d) / g.d0;
    let s = raw;
    if (raw < 1) s = 1 - rb(1 - raw, 1);
    else if (raw > geo.maxS) s = geo.maxS * (1 + rb(raw / geo.maxS - 1, 1));
    const k = s / g.v0.s;
    setView({ s, x: m.x - (g.m0.x - g.v0.x) * k, y: m.y - (g.m0.y - g.v0.y) * k });
  }
  // 捏合松手：倍率钳回 [1, maxS]（以最后的中点为锚）、平移钳回界内
  function settlePinch(m) {
    const geo = curGeo;
    if (!geo) return;
    const s1 = clamp(cv.s, 1, geo.maxS), k = s1 / cv.s;
    const to = s1 <= 1.0001 ? { s: 1, x: 0, y: 0 } : clampView({ s: s1, x: m.x - (m.x - cv.x) * k, y: m.y - (m.y - cv.y) * k });
    animateView(to);
  }
  function onUp(e) {
    if (e.pointerType === 'mouse') { mouseUp(e); return; }
    const p = pts.get(e.pointerId), g = gesture;
    if (!p) return;
    pts.delete(e.pointerId);
    if (!g) return;
    const cancel = e.type === 'pointercancel';
    if (g.mode === 'pinch') {
      if (pts.size === 1) {
        const [id, q] = [...pts.entries()][0];
        const geo = curGeo;
        if (geo && cv.s >= 1 && cv.s <= geo.maxS) {
          gesture = { mode: 'pan', id, sx: q.x, sy: q.y, t0: performance.now(), p0: pos, v0: cv };
          resetTrack(q.x, q.y, e.timeStamp);
        } else { settlePinch(g.m); g.mode = 'none'; g.id = id; }
      } else if (pts.size === 0) { settlePinch(g.m); gesture = null; calm(); }
      return;
    }
    if (e.pointerId !== g.id) return;
    if (!cancel) { const q = local(e); p.x = q.x; p.y = q.y; }
    const { vx, vy } = cancel ? { vx: 0, vy: 0 } : upVel(p.x, p.y, e.timeStamp);
    const dx = p.x - g.sx, dy = p.y - g.sy;
    gesture = pts.size ? { mode: 'none', id: -1 } : null;
    if (g.mode === 'pending') {
      if (railMoving()) springRail(index, 0);
      else if (!cancel && !g.caught) onTap(p, g);
    } else if (g.mode === 'page') releasePage(vx, dx);
    else if (g.mode === 'pan') { if (railMoving()) releasePage(vx, dx); else fling(vx, vy); }
    else if (g.mode === 'dismiss') releaseDismiss(dy, vy);
    if (!pts.size) gesture = null;
    calm();
  }
  function releasePage(vx, dx) {
    const n = count;
    let to;
    // 甩：速度够、方向和位移一致就翻到那一侧（哪怕只拖了一点）；慢放：按惯性投影后的位置就近吸附
    if (vx < -300 && dx < -20) to = Math.floor(pos + 1e-3) + 1;
    else if (vx > 300 && dx > 20) to = Math.ceil(pos - 1e-3) - 1;
    else to = Math.round(pos - project(vx) / (P || 1));
    to = clamp(to, Math.max(0, index - 1), Math.min(n - 1, index + 1));
    springRail(to, vx);
    if (to !== index) viewer.go(to);
  }
  function releaseDismiss(dy, vy) {
    if (dy > 0 && (vy > 600 || (dy > H * 0.15 && vy > -100))) { viewer.close(); return; }
    const from = dis, p0 = dp;
    if (!from) { dp = 0; viewer.dragProgress(0); return; }
    live = true;
    disAnim = spring({
      from: 1, to: 0, ...SPRING.crisp, restDist: 0.002, restVel: 0.02,
      onUpdate: (k) => { dis = { x: from.x * k, y: from.y * k, k: 1 - (1 - from.k) * k }; dp = p0 * k; viewer.dragProgress(dp); },
      onDone: () => { disAnim = null; dis = null; dp = 0; viewer.dragProgress(0); calm(); },
    });
    if (!disAnim.alive) disAnim = null;
  }
  function onTap(p, g) {
    if (g.onBtn || g.vid || viewer.closing) return;
    const now = performance.now();
    if (now - g.t0 > 500) return;   // 按久了不算点按
    if (lastTap && now - lastTap.t < 280 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
      clearTimeout(tapT); lastTap = null;
      doubleTap(p);
      return;
    }
    lastTap = { t: now, x: p.x, y: p.y };
    clearTimeout(tapT);
    tapT = setTimeout(() => { lastTap = null; viewer.chrome.toggle(); }, 280);
  }
  // 双击：已放大 → 还原；否则按触点放大——图比屏扁 / 窄得多时放到铺满（最多 4 倍），否则 2.5 倍
  function doubleTap(p) {
    const geo = curGeo;
    if (!isImg || !geo) return;
    if (zoomed) { animateView({ s: 1, x: 0, y: 0 }); return; }
    const cover = Math.max(W / geo.bw, H / geo.bh);
    let s = cover >= 1.5 ? Math.min(cover, 4) : 2.5;
    s = Math.min(s, geo.maxS);
    if (s <= 1.01) return;
    animateView(clampView({ s, x: p.x * (1 - s), y: p.y * (1 - s) }));
  }

  // —— 电脑：左键拖动平移 ——
  let md = null;
  function mouseDown(e) {
    if (e.button !== 0 || !isImg || !pannable) return;
    if (e.target.closest?.('button, a, input')) return;
    stopAll();
    md = { id: e.pointerId, sx: e.clientX, sy: e.clientY, v0: cv };
    resetTrack(e.clientX, e.clientY, e.timeStamp);
    try { rootEl.setPointerCapture(e.pointerId); } catch {}
    dragging = true; live = true;
    e.preventDefault();
  }
  function mouseMove(e) {
    if (!md || e.pointerId !== md.id) return;
    track(e.clientX, e.clientY, e.timeStamp);
    setView(clampView({ s: cv.s, x: md.v0.x + e.clientX - md.sx, y: md.v0.y + e.clientY - md.sy }));
  }
  function mouseUp(e) {
    if (!md || e.pointerId !== md.id) return;
    md = null; dragging = false;
    const { vx, vy } = upVel(e.clientX, e.clientY, e.timeStamp);
    fling(vx, vy, true);
  }
  function onDbl(e) {
    if (!fine || lastPtr !== 'mouse' || !isImg || e.target.closest?.('button')) return;
    toggleFs();
  }

  // —— 电脑：滚轮 / Ctrl+滚轮 / 触控板捏合（挂在外框根上：顶栏上 Ctrl+滚轮也不许整页缩放）——
  let hAcc = 0, hAccT = 0, hLock = false, hLockT = 0;
  $effect(() => {
    const r = viewer.root();
    if (!r) return;
    r.addEventListener('wheel', onWheel, { passive: false });
    return () => r.removeEventListener('wheel', onWheel);
  });
  function onWheel(e) {
    if (e.ctrlKey) e.preventDefault();
    if (!rootEl || !rootEl.contains(e.target) || viewer.closing) return;
    if (!isImg || !curGeo) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    const m = local(e);
    if (e.ctrlKey) { wheelZoom(Math.exp(-clamp(dy, -25, 25) * 0.01), m, Math.abs(dy) >= 40); return; }
    if (Math.abs(dx) > Math.abs(dy)) {
      // 横向（触控板两指横扫）：放大时平移；1x 时攒够一段翻一页，惯性尾巴不连翻
      if (pannable) { stopView(); setView(clampView({ s: cv.s, x: cv.x - dx, y: cv.y - dy })); return; }
      if (hLock) { clearTimeout(hLockT); hLockT = setTimeout(() => (hLock = false), 250); return; }
      hAcc += dx; clearTimeout(hAccT); hAccT = setTimeout(() => (hAcc = 0), 200);
      if (Math.abs(hAcc) > 60) {
        const to = index + Math.sign(hAcc);
        hAcc = 0; hLock = true; clearTimeout(hLockT); hLockT = setTimeout(() => (hLock = false), 250);
        if (to >= 0 && to < count) viewer.go(to);
      }
      return;
    }
    wheelZoom(Math.exp(-clamp(dy, -150, 150) * 0.002), m, Math.abs(dy) >= 40);
  }
  // 滚轮一格是离散的跳变：按目标值累加、逐帧指数逼近（约 45ms 时间常数）；触控板捏合是连续小步，直接应用
  function wheelZoom(k, m, smooth) {
    const geo = curGeo;
    if (!geo) return;
    const base = wt || viewTarget || cv;
    const s1 = clamp(base.s * k, 1, geo.maxS), r = s1 / base.s;
    const to = s1 <= 1.0001 ? { s: 1, x: 0, y: 0 } : clampView({ s: s1, x: m.x - (m.x - base.x) * r, y: m.y - (m.y - base.y) * r });
    viewAnim?.cancel(); viewAnim = null; viewTarget = null;
    if (flingRaf) { cancelAnimationFrame(flingRaf); flingRaf = 0; }
    live = true;
    if (!smooth || reduced()) {
      if (wheelRaf) { cancelAnimationFrame(wheelRaf); wheelRaf = 0; }
      wt = null; setView(to); calmSoon(); return;
    }
    wt = to;
    if (!wheelRaf) { let last = 0; const step = (now) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016; last = now;
      const to2 = wt;
      if (!to2) { wheelRaf = 0; calm(); return; }
      const a = 1 - Math.exp(-dt / 0.045), c = cv;
      const s = Math.exp(Math.log(c.s) + (Math.log(to2.s) - Math.log(c.s)) * a);
      const x = c.x + (to2.x - c.x) * a, y = c.y + (to2.y - c.y) * a;
      if (Math.abs(to2.s - s) < 0.001 * to2.s && Math.abs(to2.x - x) < 0.3 && Math.abs(to2.y - y) < 0.3) { setView(to2); wt = null; wheelRaf = 0; calm(); return; }
      setView({ s, x, y });
      wheelRaf = requestAnimationFrame(step);
    }; wheelRaf = requestAnimationFrame(step); }
  }

  // —— 全屏（电脑：F / 双击；对外框根整体全屏，顶栏浮条照常）——
  let fsExitAt = 0;
  onMount(() => {
    const on = () => { const was = isFs; isFs = !!document.fullscreenElement; if (was && !isFs) fsExitAt = performance.now(); };
    document.addEventListener('fullscreenchange', on);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      if (document.fullscreenElement && document.fullscreenElement === viewer.root()) document.exitFullscreen?.().catch(() => {});
    };
  });
  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else viewer.root()?.requestFullscreen?.().catch(() => {});
  }

  // —— 键盘（外框先问这里；返回 true = 已处理）——
  function onKeys(e) {
    if (isEditable(document.activeElement) || isEditable(e.target)) return false;
    const k = e.key, c = e.code;
    if (k === 'Escape') {
      // 全屏里 Esc 先退全屏；浏览器自己吃掉 Esc 退全屏后紧跟的那一下也别连带关掉查看器
      if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); return true; }
      return performance.now() - fsExitAt < 300;
    }
    if (e.altKey || e.metaKey) return false;
    if (isImg && curGeo) {
      // + - 0 连 Ctrl 一起接：挡掉浏览器整页缩放
      if (k === '+' || k === '=' || c === 'NumpadAdd') { zoomStep(1); return true; }
      if (k === '-' || k === '_' || c === 'NumpadSubtract') { zoomStep(-1); return true; }
      if (k === '0' || c === 'Numpad0') { fitView(); return true; }
      if (e.ctrlKey) return false;
      if (k === '1' || c === 'Numpad1') { actualSize(); return true; }
      if (c === 'KeyR') { rotate(e.shiftKey ? -90 : 90); return true; }
      if (pannable && /^Arrow(Left|Right|Up|Down)$/.test(k)) {
        const d = e.shiftKey ? 300 : 100;
        const base = viewTarget || cv;
        animateView(clampView({ s: base.s, x: base.x + (k === 'ArrowLeft' ? d : k === 'ArrowRight' ? -d : 0), y: base.y + (k === 'ArrowUp' ? d : k === 'ArrowDown' ? -d : 0) }));
        return true;
      }
    }
    if (e.ctrlKey || e.shiftKey) return false;
    if (c === 'KeyF' && fine) { toggleFs(); return true; }
    if (k === 'Home' && count > 1) { if (index !== 0) viewer.go(0); return true; }
    if (k === 'End' && count > 1) { if (index !== count - 1) viewer.go(count - 1); return true; }
    return false;
  }

  // —— 原图头部（尺寸 / EXIF / 动图）：电脑当前页一律取（百分比与「实际大小」要真尺寸）；
  // 触屏只在可能是动图（webp / png）、打开文件信息或放大时取，不和预载器抢流量 ——
  let metaRec = $state.raw(null);
  const curMeta = $derived(metaRec && item && metaRec.key === item.key ? metaRec.m : null);
  const needMeta = $derived(!!item && isImg && item.ext !== 'svg' && readyKey === item.key
    && (fine || /^(webp|png|apng|avif)$/i.test(item.ext || '') || viewer.infoOpen || zoomed));
  $effect(() => {
    if (!needMeta) return;
    const it = item;
    if (untrack(() => metaRec?.key === it.key)) return;
    let dead = false;
    imageMeta(it).then((m) => { if (!dead) metaRec = { key: it.key, m }; }, () => {});
    return () => { dead = true; };
  });

  // —— 预载器 ——
  const pre = new Map();                     // url → Image（持有对象：同文档里 <img> 换上同一 URL 直接复用已解码的资源）
  let preDone = $state.raw(new Set()), preFail = $state.raw(new Set());
  let preQ = [], inflight = 0;
  const preGo = $derived(!!item && (item.kind !== 'image' || readyKey === item.key));
  $effect(() => {
    const i = index, its = viewer.items, go = preGo;
    untrack(() => planPreload(i, its, go));
  });
  function planPreload(i, its, go) {
    const keep = new Set(), want = [];
    const cs = firstSrc(its[i]);
    if (cs) keep.add(cs);
    for (const d of [1, 2, 3, -1, -2]) {
      const it = its[i + d];
      if (!it || it.kind !== 'image') continue;
      const u = firstSrc(it);
      if (!u || u.startsWith('data:')) continue;
      keep.add(u); want.push(u);
    }
    let done = null, fail = null;
    for (const [u, im] of pre) {
      if (keep.has(u)) continue;
      if (im.__busy) { im.__busy = false; inflight--; im.onload = im.onerror = null; im.src = ''; }
      pre.delete(u);
      if (preDone.has(u)) (done ||= new Set(preDone)).delete(u);
      if (preFail.has(u)) (fail ||= new Set(preFail)).delete(u);
    }
    if (done) preDone = done;
    if (fail) preFail = fail;
    preQ = go ? want : [];
    pump();
  }
  function pump() {
    while (inflight < 2 && preQ.length) {
      const u = preQ.shift();
      if (pre.has(u)) continue;
      const im = new Image();
      im.decoding = 'async';
      im.__busy = true; inflight++;
      const fin = (ok) => {
        if (!im.__busy) return;
        im.__busy = false; inflight--;
        if (pre.get(u) !== im) return;
        if (ok) { im.decode?.().catch(() => {}); preDone = new Set(preDone).add(u); }
        else preFail = new Set(preFail).add(u);
        pump();
      };
      im.onload = () => fin(true); im.onerror = () => fin(false);
      pre.set(u, im);
      im.src = u;
    }
  }
  onMount(() => () => {
    for (const im of pre.values()) { if (im.__busy) { im.onload = im.onerror = null; im.src = ''; } }
    pre.clear(); preQ = []; inflight = 0;
    stopAll(); clearTimeout(tapT); clearTimeout(idleT); clearTimeout(hAccT); clearTimeout(hLockT);
    floatRelease?.(); floatRelease = null;
  });

  // —— FLIP ——
  let flipAnim = null;
  function originOf(it) {
    let o = it?.originRect;
    if (typeof o === 'function') { try { o = o(); } catch { o = null; } }
    return o && o.w > 0 && o.h > 0 && Number.isFinite(o.x) && Number.isFinite(o.y) ? o : null;
  }
  const curBox = () => rootEl?.querySelector(`[data-pv-slot="${index}"] .iv-box`) || null;
  onMount(() => {
    const items0 = viewer.items;
    if (flippedFor === items0) return;
    flippedFor = items0;
    if (!item || item.kind !== 'image' || !originOf(item) || reduced()) return;
    flipIn = true; veil = true;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      const box = curBox();
      if (box && curGeo) { veil = false; playIn(box); return; }   // 同一帧里摘面纱并挂上动画：隔一帧再挂会先闪一帧全尺寸
      if (performance.now() - t0 > 150) { veil = false; fadeIn(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
  function layoutRect(box) {
    const pr = box.offsetParent?.getBoundingClientRect();
    if (!pr) return null;
    return { x: pr.left + box.offsetLeft, y: pr.top + box.offsetTop, w: box.offsetWidth, h: box.offsetHeight };
  }
  function playIn(box) {
    const o = originOf(item), L = layoutRect(box);
    if (!o || !L || !L.w || !L.h) { fadeIn(); return; }
    const k = Math.max(o.w / L.w, o.h / L.h);   // 盖满缩略图（宫格缩略图是居中裁切的方块）
    const dx = o.x + o.w / 2 - (L.x + L.w / 2), dy = o.y + o.h / 2 - (L.y + L.h / 2);
    // 用标准曲线（起步斜率为 0）而不是减速曲线：减速曲线起步斜率 14，首帧就窜出去两成，看不出是从缩略图长出来的
    flipAnim = animate(box, [{ transform: `translate(${dx}px,${dy}px) scale(${k})` }, { transform: 'none' }], { d: DUR.base + 40, e: EASE.std, fill: 'none' });
    flipAnim?.finished?.then(() => { flipAnim = null; }, () => { flipAnim = null; });
  }
  function fadeIn() {
    const slot = rootEl?.querySelector(`[data-pv-slot="${index}"]`);
    flipAnim = animate(slot, [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], { d: DUR.quick, e: EASE.decel, fill: 'none' });
  }
  // 关闭：图片自己缩回缩略图原位（原位不在屏上就缩小淡出）；外框只淡出背景与 chrome，等这里落定再收
  function closeAnim() {
    if (!isImg || reduced()) return null;
    const box = curBox();
    if (!box) return null;
    stopAll(); gesture = null; pts.clear();
    if (document.fullscreenElement && document.fullscreenElement === viewer.root()) document.exitFullscreen?.().catch(() => {});
    if (blackEl) animate(blackEl, [{ opacity: getComputedStyle(blackEl).opacity }, { opacity: 0 }], { d: DUR.quick, e: EASE.fade });
    const from = getComputedStyle(box).transform;
    const f0 = from && from !== 'none' ? from : 'translate(0px,0px)';
    const o = originOf(item), L = layoutRect(box);
    const vw = window.innerWidth, vh = window.innerHeight;
    const onScreen = o && L && L.w && L.h && o.x + o.w > 0 && o.y + o.h > 0 && o.x < vw && o.y < vh;
    let a;
    if (onScreen) {
      const k = Math.max(o.w / L.w, o.h / L.h);
      const to = `translate(${o.x + o.w / 2 - (L.x + L.w / 2)}px,${o.y + o.h / 2 - (L.y + L.h / 2)}px) scale(${k})`;
      a = animate(box, [{ transform: f0, opacity: 1 }, { transform: to, opacity: 1, offset: 0.8 }, { transform: to, opacity: 0 }], { d: fine ? 240 : 320, e: EASE.std });
    } else {
      a = animate(box, [{ transform: f0, opacity: 1 }, { transform: f0 + ' scale(.92)', opacity: 0 }], { d: DUR.quick, e: EASE.accel });
    }
    return a ? a.finished.then(() => {}, () => {}) : null;
  }

  // —— 浮条保持显示（指针在上面时不自动隐藏）——
  let floatRelease = null;
  const floatEnter = () => { floatRelease?.(); floatRelease = viewer.chrome.hold('float'); };
  const floatLeave = () => { floatRelease?.(); floatRelease = null; };

  // —— 声明给外框 ——
  const menuItems = () => {
    if (!isImg) return [];
    const out = [
      { id: 'rotateLeft', label: t('向左旋转'), icon: 'rotateLeft', kbd: fine ? 'Shift+R' : undefined, onSelect: () => rotate(-90) },
      { id: 'rotateRight', label: t('向右旋转'), icon: 'rotate', kbd: fine ? 'R' : undefined, onSelect: () => rotate(90) },
    ];
    if (fine) out.push({ id: 'fullscreen', label: isFs ? t('退出全屏') : t('全屏'), icon: isFs ? 'exitFullscreen' : 'fullscreen', kbd: 'F', onSelect: toggleFs });
    if (item.ext === 'svg') out.push({ id: 'source', label: t('查看源码'), icon: 'code', onSelect: () => previewViewAs('text') });
    return out;
  };
  const infoRows = () => {
    if (!isImg) return [];
    const m = curMeta, g = curGeo, rows = [];
    // 尺寸只报原图的：先上屏的是中档预览，拿它的 naturalWidth 会把 8000×6000 报成 1280×960
    const w = m?.w || (g?.exact ? g.nw : 0), h = m?.h || (g?.exact ? g.nh : 0);
    if (w > 0 && h > 0) rows.push({ label: tc('viewer', '尺寸'), value: `${w} × ${h}` });
    const ex = m?.exif;
    if (ex) {
      const d = fmtExifDate(ex.date);
      if (d) rows.push({ label: t('拍摄时间'), value: d });
      const cam = fmtCamera(ex);
      if (cam) rows.push({ label: t('相机'), value: cam });
      if (ex.lens) rows.push({ label: t('镜头'), value: ex.lens });
      const pz = fmtExposure(ex);
      if (pz) rows.push({ label: tc('exif', '参数'), value: pz });
    }
    return rows;
  };
  $effect(() => viewer.declare({
    dragLift: false,
    get flipIn() { return flipIn; },
    closeAnim,
    autoHide: () => fine && isImg,
    keys: onKeys,
    get float() { return isImg && fine ? floatBar : null; },
    get bottom() { return fine && count > 1 ? strip : null; },
    menu: menuItems,
    info: infoRows,
  }, { follow: true, kinds: ['image', 'video'] }));

  // —— 工作区协同·网页端截图兜底：画当前页正在显示的那张（原图叠层优先），长边压到 1600 ——
  $effect(() => registerCapture(() => {
    const slot = rootEl?.querySelector(`[data-pv-slot="${index}"]`);
    const img = slot && [...slot.querySelectorAll('img.iv-hi, img.iv-img')].find((im) => im.naturalWidth > 0 && getComputedStyle(im).opacity !== '0');
    if (!img) return null;
    try {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { image: c.toDataURL('image/jpeg', 0.85), note: '图片预览（' + (item?.name || '') + '）' };   // i18n-ignore 截图附注是给 agent 看的上下文，不上屏
    } catch { return null; }
  }));

  // —— 缩略图条（电脑；虚拟化：只渲染视口附近的格子）——
  // 当前项居中；滚轮 / 触控板横扫只挪条（stripOff，像素，正 = 往前看），不换项，换项后回中
  const CELL = 56, PITCH = 64;
  let stripOff = $state(0), stripEl = $state(null);
  $effect(() => { index; untrack(() => { if (stripOff) stripOff = 0; }); });
  const stripRange = $derived.by(() => {
    const n = Math.ceil((W || 1440) / PITCH / 2) + 2, c = Math.round(index - stripOff / PITCH), out = [];
    for (let i = Math.max(0, c - n); i <= Math.min(count - 1, c + n); i++) out.push(i);
    if (index >= 0 && index < count && !out.includes(index)) out.push(index);   // 当前格是条的 Tab 停靠点，滚远了也留着
    return out;
  });
  function stripWheel(node) {
    const on = (e) => {
      if (e.ctrlKey) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (W || 800) : 1;
      stripOff = clamp(stripOff - d * unit, (index - count + 1) * PITCH, index * PITCH);
    };
    node.addEventListener('wheel', on, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', on) };
  }
  // 条内键盘（单个 Tab 停靠点 + roving）：←/→ 上一张 / 下一张、Home / End 首尾，焦点跟着当前格走
  function stripKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const n = e.key === 'ArrowLeft' ? index - 1 : e.key === 'ArrowRight' ? index + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? count - 1 : null;
    if (n == null) return;
    e.preventDefault();
    if (n >= 0 && n < count && n !== index) viewer.go(n);
    tick().then(() => { try { stripEl?.querySelector('.ig-cell.on')?.focus({ preventScroll: true }); } catch {} });
  }
  const iconOf = (k) => (k === 'video' ? 'video' : k === 'audio' ? 'audio' : k === 'pdf' ? 'page' : k === 'office' ? 'table' : k === 'image' ? 'image' : 'file');
  const black = $derived(!fine && !viewer.chrome.visible ? 1 - dp * 0.85 : 0);
</script>

{#snippet floatBar()}
  <!-- 到头的缩放钮用 aria-disabled（不是 disabled）：悬停照常出提示、键盘还能停上去，点按在这里拦掉 -->
  {@const minZ = cv.s <= 1.001}
  {@const maxZ = !curGeo || cv.s >= curGeo.maxS - 0.001}
  <div class="ig-float" role="presentation" onpointerenter={floatEnter} onpointerleave={floatLeave}>
    <button type="button" class="vw-btn" class:vw-dis={minZ} aria-disabled={minZ ? 'true' : undefined} onclick={() => { if (!minZ) zoomStep(-1); }}
      use:tip={{ label: minZ ? t('缩小（已是最小）') : tc('zoom', '缩小'), kbd: '-' }}><VIcon name="zoomOut" /></button>
    <button type="button" class="vw-btn ig-pct" onclick={togglePct}
      use:tip={{ label: pct > 0 ? t('缩放 {pct}%：点按在适应窗口与 100% 间切换', { pct }) : t('缩放比例'), kbd: '0 / 1' }}>{pct > 0 ? pct + '%' : '—'}</button>
    <button type="button" class="vw-btn" class:vw-dis={maxZ} aria-disabled={maxZ ? 'true' : undefined} onclick={() => { if (!maxZ) zoomStep(1); }}
      use:tip={{ label: maxZ ? t('放大（已是最大）') : tc('zoom', '放大'), kbd: '+' }}><VIcon name="zoomIn" /></button>
    <span class="vw-float-sep"></span>
    <button type="button" class="vw-btn" class:on={!zoomed} onclick={fitView} use:tip={{ label: t('适应窗口'), kbd: '0' }}><VIcon name="fit" /></button>
    <button type="button" class="vw-btn" class:on={atActual} disabled={!(curGeo?.f > 0)} onclick={actualSize} use:tip={{ label: t('实际大小'), kbd: '1' }}><VIcon name="actual" /></button>
    <span class="vw-float-sep"></span>
    <button type="button" class="vw-btn" onclick={() => rotate(-90)} use:tip={{ label: t('向左旋转'), kbd: 'Shift+R' }}><VIcon name="rotateLeft" /></button>
    <button type="button" class="vw-btn" onclick={() => rotate(90)} use:tip={{ label: t('向右旋转'), kbd: 'R' }}><VIcon name="rotate" /></button>
  </div>
{/snippet}

{#snippet strip()}
  <!-- 条本身不进 Tab 序列：停靠点是当前格（roving tabindex），键盘在格子上按、冒泡到这里 -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="ig-strip" role="toolbar" aria-label={t('缩略图条')} bind:this={stripEl} use:stripWheel onkeydown={stripKey}>
    <div class="ig-track" style:transform={`translate3d(${Math.round(W / 2 - index * PITCH - CELL / 2 + stripOff)}px,0,0)`}>
      {#each stripRange as i (i + '|' + (viewer.itemAt(i)?.key || ''))}
        {@const it = viewer.itemAt(i)}
        {#if it}
          <button type="button" class="ig-cell" class:on={i === index} class:ig-noth={!it.thumbUrl} style:left={i * PITCH + 'px'} aria-label={it.name} aria-current={i === index ? 'true' : undefined}
            tabindex={i === index ? 0 : -1} onclick={() => { if (i !== index) viewer.go(i); }}>
            {#if it.thumbUrl}
              <img src={it.thumbUrl} alt="" loading="lazy" decoding="async" draggable="false" />
            {:else}
              <VIcon name={iconOf(it.kind)} />
            {/if}
            {#if it.kind === 'video'}<span class="ig-cell-play"><VIcon name="play" /></span>{/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ig" bind:this={rootEl} class:ig-grab={fine && pannable} class:ig-grabbing={dragging} class:ig-idle={fine && !viewer.chrome.visible && !dragging}
  onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} ondblclick={onDbl}
  ondragstart={(e) => e.preventDefault()} oncontextmenu={(e) => { if (!fine) e.preventDefault(); }}>
  <div class="ig-black" bind:this={blackEl} style:opacity={black}></div>
  <div class="ig-rail" style:transform={`translate3d(${-pos * P}px,0,0)`}>
    {#each slots as s (s.i + '|' + s.it.key)}
      {@const cur = s.i === index}
      <div class="ig-slot" data-pv-slot={s.i} style:transform={`translate3d(${s.i * P}px,0,0)`} aria-hidden={cur ? undefined : 'true'}>
        {#if s.it.kind === 'video' && cur && s.it.key === playerKey}
          <VideoPlayer item={s.it} />
        {:else}
          <ImageView item={s.it} {W} {H} current={cur} {fine}
            load={cur || !!s.it.dataUrl || preDone.has(firstSrc(s.it)) || preFail.has(firstSrc(s.it))}
            peek={cur || preGo}
            view={s.it.key === vk ? cv : null} rot={rots.get(s.it.key) || 0}
            dis={cur ? dis : null} live={cur && live} veil={cur && veil}
            meta={metaRec && metaRec.key === s.it.key ? metaRec.m : null}
            onmeta={(g) => { if (cur) geoRec = { key: s.it.key, g }; }}
            onready={(k) => { if (readyKey !== k) readyKey = k; }}
            onplay={() => { playerKey = s.it.key; }} />
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .ig { position: absolute; inset: 0; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .ig.ig-grab { cursor: grab; }
  .ig.ig-grabbing { cursor: grabbing; }
  .ig.ig-idle { cursor: none; }
  /* 沉浸（触屏单击隐藏 chrome）：纯黑底盖过外框的深灰底 */
  .ig-black { position: absolute; inset: 0; background: #000; pointer-events: none; transition: opacity var(--mo-base) var(--ea-fade); }
  .ig-rail { position: absolute; inset: 0; will-change: transform; }
  .ig-slot { position: absolute; inset: 0; }

  /* 浮条（电脑）：外框的 .vw-float 容器里放一排 .vw-btn */
  .ig-float { display: flex; align-items: center; gap: 2px; }
  .ig-pct { width: auto; min-width: 56px; padding: 0 6px; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--vw-fg-2); }

  /* 缩略图条（电脑底栏）：当前项居中、白色描边高亮；其余压暗 */
  .ig-strip { position: relative; height: 64px; margin: 0 -12px; overflow: hidden; }
  .ig-track { position: absolute; left: 0; top: 4px; height: 56px; transition: transform var(--mo-base) var(--ea-std); }
  .ig-cell { position: absolute; top: 0; width: 56px; height: 56px; padding: 0; border: 0; border-radius: 6px; overflow: hidden; cursor: pointer;
    background: rgba(255, 255, 255, .08); color: var(--vw-fg-2); display: grid; place-items: center; opacity: .55;
    transition: opacity var(--mo-micro) var(--ea-fade), box-shadow var(--mo-micro) var(--ea-fade); }
  .ig-cell img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
  .ig-cell.on { opacity: 1; box-shadow: 0 0 0 2px #fff; }
  /* 没有缩略图的格子（动图、文档、音频…）只有一枚图标：压暗少一点，深底上对比度 ≥ 4.5 */
  .ig-cell.ig-noth:not(.on) { opacity: .85; }
  .ig-cell:focus-visible { outline: 2px solid var(--vw-focus); outline-offset: 2px; }
  @media (hover: hover) { .ig-cell:hover { opacity: .85; } .ig-cell.on:hover { opacity: 1; } }
  .ig-cell-play { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; pointer-events: none; }
  .ig-cell-play :global(.vw-ic) { --s: 16px; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .6)); }
</style>
