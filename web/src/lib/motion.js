// —— Bridge 运动系统（单一真相源）——
//
// 此前全站 15+ 种互不相干的 cubic-bezier 各写各的（.76,0,.18,1 / .34,1.4,.5,1 /
// .65,0,.3,1 / .3,.5,.25,1 …），时长从 .14s 到 2.9s 随手拍——这正是「观感粗糙、
// 没有大厂审美」的根因：审美一致性来自**同一套时间与曲线反复出现**，不是来自单个
// 动画多精致。本文件与 app.css 的 --mo-* / --ea-* 令牌一一对应，JS 与 CSS 共用。
//
// 三条纪律：
//  ① 时长按「移动距离 / 元素体量」分档，不按「这个动画重不重要」拍脑袋。
//  ② 入场用 decel（起步快、尾巴长＝东西"落"下来），出场用 accel（起步慢、末端快＝
//     被"抽"走），双向移动用 std。opacity 单独走 fade，不跟着位移曲线跑。
//  ③ 手势松手一律走 spring 并**继承松手瞬间的速度**——这是「跟手」的全部秘密：
//     动画不是"松手后另起一段"，而是手指运动的物理续写。

// —— 时长档位（ms）——
// 参照 Material 3 / iOS：跨屏容器变形 300–500ms，弹层 200–300ms，状态反馈 <100ms。
export const DUR = {
  tap: 90,     // 按下反馈：必须 <100ms，否则手感"糊"
  micro: 140,  // 悬停、开关、小图标状态
  quick: 200,  // 菜单、气泡、芯片、小 popover
  base: 280,   // 面板 / 弹层 / 罩层 —— 全站弹层的标准节拍
  page: 420,   // 整页容器变形（进分页、返回）
  hero: 560,   // 启动揭幕 / 主题切换这类整屏事件（罕用）
};

// —— 缓动（与 app.css 的 --ea-* 同值）——
export const EASE = {
  std: 'cubic-bezier(.2,0,0,1)',        // 强调-标准：双向移动的主力
  decel: 'cubic-bezier(.05,.7,.1,1)',   // 强调-减速：入场（起步就有速度，长尾落定）
  accel: 'cubic-bezier(.3,0,.8,.15)',   // 强调-加速：出场（被抽走）
  out: 'cubic-bezier(0,0,0,1)',         // 纯减速：跟随手势后的收尾
  settle: 'cubic-bezier(.34,1.26,.5,1)', // 轻微过冲：仅用于"松手回弹"，不用于按下
  fade: 'cubic-bezier(.4,0,.6,1)',      // 纯透明度
};

// prefers-reduced-motion：CSS 那条全局规则只压得住 CSS 动画，JS 弹簧得自己让路。
export const reduced = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// —— 弹簧积分器 ——
// 松手后的运动交给它：初速度 = 手指松开瞬间的真实速度，所以观感上「动画」与「手势」
// 是同一段连续运动，没有接缝。固定子步长积分（240Hz）保证掉帧时也不发散。
export function spring({
  from, to, velocity = 0,
  stiffness = 320, damping = 34, mass = 1,
  restDist = 0.3, restVel = 0.3,
  onUpdate, onDone,
}) {
  let x = from, v = velocity, raf = 0, last = 0, alive = true;
  const settle = () => { alive = false; onUpdate?.(to, 0); onDone?.(); };
  if (reduced()) { settle(); return { cancel() { alive = false; }, get alive() { return alive; } }; }
  const step = (now) => {
    if (!alive) return;
    if (!last) { last = now; raf = requestAnimationFrame(step); return; }
    const dt = Math.min(0.064, (now - last) / 1000);   // 掉帧封顶 64ms，防"跳一大格"
    last = now;
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = (-stiffness * (x - to) - damping * v) / mass;
      v += a * h; x += v * h;
    }
    if (Math.abs(x - to) < restDist && Math.abs(v) < restVel) { settle(); return; }
    onUpdate?.(x, v);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return {
    cancel() { alive = false; cancelAnimationFrame(raf); },
    get alive() { return alive; },
  };
}

// 常用弹簧手感预设（stiffness/damping 组合）。
// crisp：干脆利落、几乎不过冲——页面/弹层归位用（大面积过冲会晕）。
// bouncy：明显但克制的回弹——小元件（按钮、图标）松手用。
// glide：低刚度长滑行——被甩出去（fling）时的送出。
export const SPRING = {
  crisp: { stiffness: 420, damping: 40 },
  bouncy: { stiffness: 520, damping: 26 },
  glide: { stiffness: 200, damping: 30 },
};

// —— 弹簧 → CSS 缓动（linear()）——
// 同一条弹簧既能在 JS 里逐帧积分（上面的 spring()），也能离线积分一次、采样成 CSS
// linear() 缓动交给 WAAPI / 转场伪元素——后者跑在合成器上，主线程忙（切页那一帧要
// 渲染整个分页）也不掉帧。时长取「落到终点 0.2% 以内且几乎静止」的时刻，尾巴不拖。
// 不支持 linear() 的内核（Chrome <113）回落到一条近似的 cubic-bezier。
const _linearOK = (() => {
  try { return typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)'); } catch { return false; }
})();
const _curveCache = new Map();
export function springCurve({ stiffness = 300, damping = 30, mass = 1, velocity = 0 } = {}, fallback = 'cubic-bezier(.2,.9,.1,1)') {
  const key = `${stiffness}|${damping}|${mass}|${velocity}`;
  if (_curveCache.has(key)) return _curveCache.get(key);
  // 0 → 1 的归一化位移；velocity 以「每秒走完全程几倍」计（松手速度 / 全程距离）
  const h = 1 / 1200;
  let x = 0, v = velocity, t = 0;
  const pts = [0];
  let lastSample = 0;
  const SAMPLE = 1 / 120;           // 每 8.3ms 取一个点，linear() 在点间线性插值
  while (t < 3) {
    const a = (-stiffness * (x - 1) - damping * v) / mass;
    v += a * h; x += v * h; t += h;
    if (t - lastSample >= SAMPLE) { pts.push(x); lastSample = t; }
    if (Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.02) break;
  }
  pts.push(1);
  const duration = Math.round(t * 1000);
  const easing = _linearOK ? `linear(${pts.map((p) => +p.toFixed(4)).join(', ')})` : fallback;
  // reach(p)：进度第一次到达 p 的时刻（ms）——编排「波前扫到某处」这类跟随动作用
  const reach = (p) => {
    for (let i = 0; i < pts.length; i++) if (pts[i] >= p) return Math.round((i / (pts.length - 1)) * duration);
    return duration;
  };
  const out = { easing, duration, reach };
  _curveCache.set(key, out);
  return out;
}

// cubic-bezier 求值（给「某个位置什么时候被扫到」这类反查用：主题揭幕波前到达各图标的时刻）。
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {          // 牛顿迭代解 t，退化时二分兜底
      const e = sx(t) - x, d = dx(t);
      if (Math.abs(e) < 1e-5) break;
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-3) {
      let lo = 0, hi = 1; t = x;
      for (let i = 0; i < 30; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    }
    return sy(t);
  };
}

// 导航/转场用的几条弹簧（与 CSS 令牌同源：页面级转场一律从这里取，不就地拍数值）。
//   open：分页从入口长出来——临界偏下一点（ζ≈0.86），末端 ~1% 的过冲读作「落定」而不是「刹车」
//   close：收回入口——比 open 略快、略硬，读作「被收走」
//   theme：主题换场的揭幕半径——无过冲，长而匀
export const NAV_SPRING = {
  open: { stiffness: 230, damping: 26 },
  close: { stiffness: 280, damping: 29 },
  settle: { stiffness: 180, damping: 22 },
};

// —— 速度采样器 ——
// pointermove 的瞬时差分噪声极大（一帧抖动就能算出几千 px/s），大厂做法是对最近
// ~100ms 的采样做线性拟合。松手判定与弹簧初速度都吃它。
export function velocityTracker(window_ms = 100) {
  const pts = [];
  return {
    add(value, t = performance.now()) {
      pts.push({ value, t });
      while (pts.length > 2 && t - pts[0].t > window_ms) pts.shift();
    },
    // px/s
    get() {
      if (pts.length < 2) return 0;
      const a = pts[0], b = pts[pts.length - 1];
      const dt = (b.t - a.t) / 1000;
      return dt > 0.004 ? (b.value - a.value) / dt : 0;
    },
    reset() { pts.length = 0; },
  };
}

// 速度投影：iOS 的"松手后它还会滑多远"。用于判定该完成还是回弹——只看位移
// 会让"轻快一甩"被判成取消（"不跟手"的观感里很大一块是这个）。
export const project = (velocity, factor = 0.12) => velocity * factor;

// —— 按下反馈（Svelte action）——
// 纪律：按下要**干脆**（快、无过冲，90ms），松手才**回弹**（弹簧、轻微过冲）。
// 此前全站把弹性曲线用在"按下"上，所以按下去像踩进棉花——手感糊的元凶。
// 用法：<button use:pressable>…，CSS 侧写 transform: scale(var(--press-s,1))。
// 元素若还有别的 transform，自行写成 translateY(..) scale(var(--press-s,1)) 组合。
export function pressable(node, opts = {}) {
  let { scale = 0.96, disabled = false } = opts;
  let sp = null, downAt = 0, pressed = false;
  const set = (v) => node.style.setProperty('--press-s', String(v));
  const cur = () => parseFloat(getComputedStyle(node).getPropertyValue('--press-s')) || 1;

  function down(e) {
    if (disabled || e.button > 0) return;
    sp?.cancel(); sp = null;
    pressed = true; downAt = performance.now();
    // 按下必须用【纯减速】(EASE.out)：手指一碰，头几毫秒就走掉大半行程，视觉上"立刻
    // 有反应"。用 accel（慢起快收）会让 90ms 里前 45ms 只动 1%，观感等同于没响应——
    // 那正是旧版 .16s 弹性曲线做按下时的"糊"。松手才交给弹簧过冲。
    node.style.transition = `--press-s ${DUR.tap}ms ${EASE.out}`;
    set(scale);
  }
  function up() {
    if (!pressed) return;
    pressed = false;
    // 极快点击（<tap 时长）时按下动画还没走完就松手了：留够 tap 时长再回弹，
    // 否则视觉上等于"没按下去过"——点击反馈丢失比慢一点更伤手感。
    const wait = Math.max(0, DUR.tap - (performance.now() - downAt));
    setTimeout(() => {
      if (pressed) return;                     // 期间又按下了
      node.style.transition = '';              // 交给弹簧，避免 transition 与 rAF 打架
      const from = cur();
      sp = spring({ from, to: 1, ...SPRING.bouncy, restDist: 0.002, restVel: 0.01, onUpdate: set });
    }, wait);
  }
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener('pointerleave', up);
  return {
    update(o = {}) { scale = o.scale ?? scale; disabled = o.disabled ?? disabled; if (disabled) { sp?.cancel(); set(1); } },
    destroy() {
      sp?.cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      node.removeEventListener('pointerleave', up);
    },
  };
}

// —— 拖拽消解（Svelte action）——
// 整页侧滑返回、弹层下拉关闭共用一套：跟手期 1:1 位移，松手按【位置 + 投影速度】
// 双判据决定完成还是回弹，两条路都用弹簧续写松手速度。
//
// opts:
//   axis 'x'|'y'、dir 1|-1（正方向＝消解方向）、edge 起手区宽度(px，0=整面可起手)
//   size() 返回全程距离（默认视口对应边长）、threshold 完成比例（默认 .35）
//   guard() 返回 false 则本次不接管、onStart/onMove(px)/onEnd(dismissed)
//   onDismiss() 真正关闭；组件负责在其中切状态
export function swipeDismiss(node, opts = {}) {
  let o = { axis: 'x', dir: 1, edge: 0, threshold: 0.35, flingVel: 420, ...opts };
  let tracking = false, decided = false, sx = 0, sy = 0, base = 0, size = 0, sp = null, id = null;
  const vt = velocityTracker();
  const len = () => (o.size ? o.size() : (o.axis === 'x' ? innerWidth : innerHeight));
  const main = (e) => (o.axis === 'x' ? e.clientX : e.clientY);
  const cross = (e) => (o.axis === 'x' ? e.clientY : e.clientX);

  function down(e) {
    if (e.pointerType === 'mouse' && o.edge === 0 && !o.mouse) return;   // 鼠标默认不接管整面拖拽
    // 先做起手区判定再问 guard：guard 常被用来「顺手取消正在跑的归位动画」（可中断性），
    // 只有真的落在起手区的按下才该触发它，否则页面中间随便点一下都会掐掉动画。
    const from = o.axis === 'x' ? e.clientX : e.clientY;
    const fromEdge = o.dir > 0 ? from : (o.axis === 'x' ? innerWidth : innerHeight) - from;
    if (o.edge > 0 && fromEdge > o.edge) return;
    if (o.guard && o.guard(e) === false) return;
    sp?.cancel(); sp = null;
    tracking = true; decided = false; id = e.pointerId;
    sx = e.clientX; sy = e.clientY; size = len(); base = o.base ? o.base() : 0;
    vt.reset(); vt.add(0);
  }
  function move(e) {
    if (!tracking || e.pointerId !== id) return;
    const d = (main(e) - (o.axis === 'x' ? sx : sy)) * o.dir;
    const c = Math.abs(cross(e) - (o.axis === 'x' ? sy : sx));
    if (!decided) {
      if (Math.abs(d) < 8 && c < 8) return;
      // 主轴必须明显占优才接管，否则交还给滚动（斜着划时的"两边都动一点"最恶心）
      if (c > Math.abs(d)) { tracking = false; return; }
      decided = true;
      try { node.setPointerCapture?.(id); } catch {}
      o.onStart?.();
    }
    // 反向拖动做橡皮筋阻尼，而不是硬钳到 0——硬钳时手指还在动、画面纹丝不动＝"卡住了"
    const px = base + (d >= 0 ? d : d * 0.25);
    vt.add(px);
    o.onMove?.(Math.max(0, px));
  }
  function end(e) {
    if (!tracking || (e && id != null && e.pointerId !== id)) return;
    tracking = false;
    if (!decided) return;
    decided = false;
    try { node.releasePointerCapture?.(id); } catch {}
    const v = vt.get();
    const cur = Math.max(0, (o.cur ? o.cur() : 0));
    // 双判据：位置过阈值，或被"甩"出去（投影落点过阈值）。轻快一甩也能关，这是跟手感的一半。
    const go = cur + project(v) > size * o.threshold || v > o.flingVel;
    o.onEnd?.(go);
    // 完成路径由调用方自己接（例如交给页面转场从当前形态续走），就不再弹簧送出去
    if (go && o.onCommit) { o.onCommit(v); return; }
    sp = spring({
      from: cur, to: go ? size : 0, velocity: v,
      ...(go ? SPRING.glide : SPRING.crisp),
      restDist: 0.5, restVel: 2,
      onUpdate: (x) => o.onMove?.(x),
      onDone: () => { o.onSettle?.(go); if (go) o.onDismiss?.(); },
    });
  }
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  return {
    update(n = {}) { o = { ...o, ...n }; },
    destroy() {
      sp?.cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', end);
      node.removeEventListener('pointercancel', end);
    },
  };
}

// —— 编排小工具 ——
// 列表错峰：大厂的 stagger 是"总时长封顶"的（项目多时每项间隔自动压缩），
// 而不是 i*固定值——后者在 20 项列表上会拖出一秒多的尾巴。
export const stagger = (i, n, total = 180, step = 34) =>
  i * Math.min(step, n > 1 ? total / (n - 1) : step);

// 等一个还没挂上的元素出现（容器变形要拿到目标分页的根节点）。
// 刻意用 setTimeout 而非 rAF 轮询：分页在后台 / 低端机上 rAF 会被节流甚至完全不跑，
// 那时裁窗动画永远挂不上，页面就僵在"裁成零尺寸"的状态直到兜底计时器把它救回来
// （肉眼是黑屏几百毫秒）。setTimeout 再怎么节流也会执行。
export function whenEl(selector, cb, { tries = 8, gap = 16 } = {}) {
  let n = tries, timer = 0, cancelled = false;
  const look = () => {
    if (cancelled) return;
    const el = document.querySelector(selector);
    if (el) return cb(el);
    if (--n > 0) timer = setTimeout(look, gap);
  };
  const el = document.querySelector(selector);
  if (el) cb(el); else timer = setTimeout(look, 0);
  return () => { cancelled = true; clearTimeout(timer); };
}

// WAAPI 包装：统一 fill/easing 默认值，省掉各处重复的样板。
export function animate(el, frames, { d = DUR.base, e = EASE.std, delay = 0, fill = 'forwards' } = {}) {
  if (!el) return null;
  return el.animate(frames, { duration: reduced() ? 1 : d, easing: e, delay: reduced() ? 0 : delay, fill });
}
