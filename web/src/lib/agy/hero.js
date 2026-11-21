// agy 页面级「共享元素」接力（11-19）：欢迎页中央那颗 Antigravity 标记，在发出第一条消息时不消失、
// 不重建，而是整颗（同一个引擎实例、同一段 SVG）飞到这一轮底部状态栏的位置、边飞边缩、边变成思考形态；
// 反过来「新建对话」时，底部那颗（还在视口里的话）飞回中央长大。输入框同理：记下切换前的位置，
// 新位置的输入框从旧位置滑过来（FLIP）。
//
// 时序：AgyPage 用 $effect.pre 在 DOM 换掉之前调 capture() —— 此刻旧标记还在原位，量好矩形、
// 把引擎的盒子搬进页面根上的飞行层（Svelte 随后删旧分支时它已经不在那棵子树里了），并通知旧组件
// 「实例已交出去，卸载时别销毁」。新位置的标记组件挂载时 take() 认领，自己驱动飞行、落地后把盒子
// 收进自己的占位里接着用。没人认领（比如对方不在视口里）就淡出销毁。
import { emphasized, emphDecel, lerp, reducedMotion, span } from './motion.js';

const marks = new Set();     // 已登记的标记：{ role, outer(), box(), ctl(), release() }
let pending = null;          // 飞行中待认领：{ to, box, ctl, fly, from, at }
let composerFrom = null;     // { rect, at }

export function registerHeroMark(entry) {
  marks.add(entry);
  return () => marks.delete(entry);
}

function visibleRect(el) {
  if (!el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return null;
  // 在滚动区里被裁掉的也不算（对话区上下有羽化与顶栏 / 输入框遮挡）
  const sc = el.closest('.agy-thread');
  if (sc) {
    const s = sc.getBoundingClientRect();
    if (r.top < s.top + 4 || r.bottom > s.bottom - 4) return null;
  }
  return r;
}

function dropPending() {
  const p = pending;
  pending = null;
  if (!p) return;
  const fly = p.fly;
  try {
    fly.animate([{ opacity: 1 }, { opacity: 0, transform: 'scale(0.6)' }], { duration: 180, easing: 'cubic-bezier(0.3, 0, 0.8, 0.15)', fill: 'forwards' })
      .finished.finally(() => { try { p.ctl?.destroy(); } catch {} fly.remove(); });
  } catch { try { p.ctl?.destroy(); } catch {} fly.remove(); }
}

/**
 * 切换前调用（DOM 还是旧的）。dir：'toChat'（欢迎页 → 对话）| 'toWelcome'（对话 → 欢迎页）
 * layer：页面根元素（飞行层挂在它下面，这样主题变量照样生效）
 */
export function captureHeroTransition(dir, layer) {
  if (pending) dropPending();
  composerFrom = null;
  if (!layer || reducedMotion()) return;
  const cbox = layer.querySelector('.agy-cbox');
  if (cbox) {
    const r = cbox.getBoundingClientRect();
    if (r.width && r.height) {
      // 连流光环的转角与饱和度一起记下，新输入框接着转（不从 0° 重起、不一帧换色）
      let spinTime = null, ringA = null;
      try {
        const a = cbox.getAnimations?.().find((x) => /agy-conic-spin$/.test(x.animationName));
        if (a && a.currentTime != null) spinTime = a.currentTime;
        const v = parseFloat(getComputedStyle(cbox).getPropertyValue('--agy-ring-a'));
        if (Number.isFinite(v) && cbox.classList.contains('glow')) ringA = v;
      } catch {}
      composerFrom = { rect: r, at: performance.now(), spinTime, ringA };
    }
  }
  const fromRole = dir === 'toChat' ? 'welcome' : 'foot';
  const toRole = dir === 'toChat' ? 'foot' : 'welcome';
  let src = null;
  for (const m of marks) if (m.role === fromRole && m.ctl()) src = m;
  if (!src) return;
  const rect = visibleRect(src.outer());
  const box = src.box();
  if (!rect || !box) return;
  const ctl = src.ctl();
  src.release();             // 旧组件不再驱动、卸载时不销毁
  const fly = document.createElement('div');
  fly.className = 'agy-hero-fly';
  Object.assign(fly.style, {
    position: 'fixed', left: '0px', top: '0px', width: rect.width + 'px', height: rect.height + 'px',
    transform: `translate(${rect.left}px, ${rect.top}px)`, zIndex: '60', pointerEvents: 'none',
    lineHeight: '0', willChange: 'transform, width, height',
  });
  box.style.width = box.style.height = '100%';
  fly.appendChild(box);
  layer.appendChild(fly);
  pending = { to: toRole, box, ctl, fly, from: rect, at: performance.now() };
  // 800ms 内没人认领（目标不在视口 / 被别的状态打断）就收场
  const mine = pending;
  setTimeout(() => { if (pending === mine) dropPending(); }, 800);
}

// 新位置的输入框挂载时取：{ rect, spinTime, ringA } | null
export function takeComposerFrom() {
  const c = composerFrom;
  composerFrom = null;
  if (!c || performance.now() - c.at > 800) return null;
  return c;
}

/**
 * 新位置的标记挂载时认领。target()：每帧取落点矩形（落点可能还在动——比如思考行插进来把状态栏往下推）。
 * onLand(box, ctl)：落地回调，把盒子收进自己的占位。返回取消函数；没有可认领的返回 null。
 */
export function takeHero(role, { target, onFlight, onLand }) {
  const p = pending;
  if (!p || p.to !== role || performance.now() - p.at > 800) return null;
  pending = null;
  const { fly, box, ctl, from } = p;
  // 距离越远飞得越久（420–720ms），弧线：横向走 emphasized、纵向走 emphasized decelerate → 先升后横移的弧
  const t0 = target() || from;
  const dist = Math.hypot(t0.left - from.left, t0.top - from.top);
  const dur = Math.max(420, Math.min(720, 380 + dist * 0.75));
  const start = performance.now();
  let raf = 0, done = false;
  onFlight?.(ctl);
  const finish = () => {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    box.style.width = box.style.height = '100%';
    onLand(box, ctl);
    fly.remove();
  };
  const frame = (now) => {
    raf = 0;
    const t = Math.min(1, (now - start) / dur);
    const to = target() || t0;
    const ex = emphasized(t), ey = emphDecel(span(t, 0, 0.92)), es = emphasized(t);
    const w = lerp(from.width, to.width, es), h = lerp(from.height, to.height, es);
    // 按中心点插值，尺寸单独插值 → 缩放时不会先往一个角漂
    const cx = lerp(from.left + from.width / 2, to.left + to.width / 2, ex);
    const cy = lerp(from.top + from.height / 2, to.top + to.height / 2, ey);
    fly.style.width = w + 'px';
    fly.style.height = h + 'px';
    fly.style.transform = `translate(${cx - w / 2}px, ${cy - h / 2}px)`;
    if (t >= 1) { finish(); return; }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return finish;
}
