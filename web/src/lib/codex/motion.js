// Codex 分页的动效小件：曲线、WAAPI 包装、逐位滚动的文字。
// 节奏照 OpenAI 自己的（官方 model-reasoning-effort-motion-easing + framer-motion 弹簧），
// 不借 bridge 通用的 lib/motion.js——两个分页的签名本来就不同，混用会让 Codex 页失去它自己的手感。

export const reduced = () => {
  try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

// framer-motion 的 duration/bounce 弹簧同口径（阻尼比 = 1 - bounce），采样成 CSS linear()，
// 这样 WAAPI 和 CSS 过渡都能直接用同一条弹簧。
export function spring(bounce = 0.15, dur = 0.55, n = 56) {
  const z = Math.min(0.999, 1 - bounce), w = 6.2 / (z * dur), wd = w * Math.sqrt(1 - z * z), out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * dur;
    out.push((1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t))).toFixed(4));
  }
  out[n] = '1';
  return `linear(${out.join(',')})`;
}

export const EASE = {
  out: 'cubic-bezier(.23,1,.32,1)',
  in: 'cubic-bezier(.5,0,.9,.4)',
  io: 'cubic-bezier(.45,0,.55,1)',
  logo: spring(0.15, 0.55),
  soft: spring(0.1, 0.42),
  pop: spring(0.32, 0.5),
  snap: spring(0.18, 0.34),
};

/** el.animate 的薄包装：默认填充 both、跑完提交样式再取消（不留一层压着后续样式的动画）。 */
export function anim(el, kf, o = {}) {
  if (!el?.animate) return null;
  const fill = o.fill ?? 'both';
  const a = el.animate(kf, { duration: o.dur ?? 220, easing: o.ease ?? EASE.out, delay: o.delay ?? 0, fill, iterations: o.iter ?? 1 });
  if (o.keep !== true && fill !== 'none') {
    a.finished.then(() => { try { if (o.commit) a.commitStyles(); a.cancel(); } catch {} }, () => {});
  }
  return a;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 文字只滚变了的那一位（数字右对齐比、文字左对齐比）。小格必须 flex:none——放进 flex 容器时
 * overflow:hidden 会把 min-width 归零、字被挤成半个（CSS 里 .roll .ch 已写）。
 * 用法：Svelte 里 use:rolled={text}。
 */
export function roll(el, text, o = {}) {
  if (!el) return;
  text = String(text ?? '');
  const prev = el.__roll ?? el.textContent;
  el.__roll = text;
  if (prev === text && el.querySelector('.ch')) return;
  if (o.instant || reduced() || !el.isConnected) {
    el.innerHTML = [...text].map((c) => `<span class="ch"><span>${esc(c)}</span></span>`).join('');
    return;
  }
  const a = [...prev], b = [...text], n = Math.max(a.length, b.length);
  const numeric = /^[+−\-]?\d/.test(text) && o.align !== 'left';
  const pa = numeric ? Array(n - a.length).fill('').concat(a) : a.concat(Array(n - a.length).fill(''));
  const pb = numeric ? Array(n - b.length).fill('').concat(b) : b.concat(Array(n - b.length).fill(''));
  el.innerHTML = '';
  let k = 0;
  for (let i = 0; i < n; i++) {
    const ca = pa[i], cb = pb[i];
    if (cb === '' && ca === '') continue;
    const slot = document.createElement('span');
    slot.className = 'ch';
    const inner = document.createElement('span');
    inner.textContent = cb;
    slot.appendChild(inner);
    el.appendChild(slot);
    if (ca === cb) continue;
    const d = (o.stagger ?? 0) * k++;
    if (ca) {
      const old = document.createElement('span');
      old.textContent = ca;
      old.style.cssText = 'position:absolute;left:0;top:0';
      slot.appendChild(old);
      anim(old, [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${o.dir === 'down' ? 100 : -100}%)`, opacity: 0 }], { dur: 200, ease: EASE.in, delay: d })
        ?.finished.then(() => old.remove(), () => {});
    }
    if (cb) anim(inner, [{ transform: `translateY(${o.dir === 'down' ? -100 : 100}%)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { dur: 300, ease: EASE.snap, delay: d + 40 });
  }
}

/** Svelte action：<span class="roll" use:rolled={text}>。首次挂载不滚，之后每次变化只滚变了的那一位。 */
export function rolled(el, text) {
  roll(el, text, { instant: true });
  return {
    update(next) { roll(el, next); },
  };
}

/** 从零高度长出来（工作记录新的一条、菜单项）：先撑开高度，再淡入。 */
export function growIn(el, { dur = 300, delay = 0 } = {}) {
  if (!el || reduced()) return null;
  const h = el.scrollHeight;
  return anim(el, [
    { height: '0px', opacity: 0, overflow: 'hidden' },
    { height: h + 'px', opacity: 1, overflow: 'hidden' },
  ], { dur, delay, ease: EASE.soft });
}
