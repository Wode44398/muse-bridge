// 触屏放大镜：拖柄、长按后接着拖时浮在指头上方。一枚 132×46 的胶囊，里面是 1.4 倍的正文，墨的边始终在正中，
// 那根杆也放大画在里面。
//
// 做法是把选区所在的那条消息克隆一份放进胶囊里再放大，而不是截图：克隆放在同一个滚动容器里，
// 祖先的配色变量和「.answer p」这类样式都还在，字体、行高、墨都和正文一模一样。
// 克隆里的墨用了混合模式：胶囊必须自成隔离组（ink.css 里 isolation），否则混合会把整片覆盖层变成隔离组，
// 同一层里的磨砂玻璃就采不到背后的页面。
const E_OUT = 'cubic-bezier(.165,.84,.44,1)';
const E_IN = 'cubic-bezier(.5,0,.85,.45)';
const W = 132, H = 46, M = 1.4;
const f2 = (n) => Math.round(n * 100) / 100;

function spring(x, v, t, w, z, h) {
  const a = -w * w * (x - t) - 2 * z * w * v;
  v += a * h;
  return [x + v * h, v];
}

export function createLoupe(doc) {
  const el = doc.createElement('div');
  el.className = 'sel-lp';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="sel-lp-in"></div><svg class="sel-ink-layer sel-lp-ink"><path class="ink-fill"/></svg><div class="sel-lp-stem"></div>';
  return { el, inner: el.children[0], ink: el.children[1], path: el.children[1].firstChild, stem: el.children[2], on: false, src: null, x: 0, y: 0, vx: 0, vy: 0, placed: false };
}

// 原消息从滚动容器和它之间那几层继承来的排版（字号、行高……）：克隆挂在胶囊里继承不到，照抄一份，否则换行位置对不上
const INHERITED = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'lineHeight', 'letterSpacing', 'wordSpacing', 'color',
  'textAlign', 'whiteSpace', 'wordBreak', 'overflowWrap', 'lineBreak', 'fontFeatureSettings', 'fontVariationSettings', 'fontVariantNumeric',
  'fontKerning', 'textRendering', 'tabSize', 'direction', 'hyphens', 'textTransform'];

// 克隆选区所在的那条消息（root）：去掉会动或很重的东西，id 去掉免得重名
function cloneRoot(root) {
  const cs = root.ownerDocument.defaultView.getComputedStyle(root);
  const c = root.cloneNode(true);
  for (const p of INHERITED) c.style[p] = cs[p];
  c.querySelectorAll('iframe, video, audio, canvas').forEach((n) => n.remove());
  c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  c.removeAttribute('id');
  c.querySelectorAll('[data-sel-composer]').forEach((n) => n.removeAttribute('data-sel-composer'));
  c.style.cssText += `;position:absolute;left:0;top:0;margin:0;width:${root.getBoundingClientRect().width}px;`;
  return c;
}

// 第一个字的位置：用来对齐克隆和原消息（见 stepLoupe）
function firstCharRect(el) {
  const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const i = n.data.search(/\S/);
    if (i < 0) continue;
    const r = el.ownerDocument.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + 1);
    const rc = r.getClientRects()[0];
    if (rc) return rc;
  }
  return null;
}

export function showLoupe(L, parent, layer, bg, reduce) {
  if (L.el.parentNode !== parent) parent.append(L.el);
  for (const k of ['skin', 'theme', 'flat']) L.ink.dataset[k] = layer.dataset[k] || '';
  L.el.dataset.skin = layer.dataset.skin || '';
  L.el.dataset.theme = layer.dataset.theme || '';
  L.el.style.background = bg;
  L.src = null;
  if (L.on) return;
  L.on = true;
  L.placed = false;
  L.el.classList.add('on');
  L.el.getAnimations().forEach((a) => a.cancel());
  if (!reduce) L.el.animate([{ scale: '.55', opacity: 0 }, { scale: '1', opacity: 1 }], { duration: 180, easing: E_OUT, fill: 'both' });
}

export function hideLoupe(L, reduce) {
  if (!L.on) return;
  L.on = false;
  if (reduce) { L.el.classList.remove('on'); return; }
  const cs = L.el.ownerDocument.defaultView.getComputedStyle(L.el);
  const from = { scale: cs.scale, opacity: cs.opacity };
  L.el.getAnimations().forEach((a) => a.cancel());
  L.el.animate([from, { scale: '.7', opacity: 0 }], { duration: 120, easing: E_IN, fill: 'forwards' }).finished.then(() => {
    if (!L.on) { L.el.classList.remove('on'); L.el.getAnimations().forEach((a) => a.cancel()); L.inner.replaceChildren(); L.src = null; }
  }, () => {});
}

// 每帧：edge = 被拖的那条边（层坐标）；finger = 手指的视口坐标；root = 那条边所在的消息；vis = 滚动容器可见区（层坐标）
export function stepLoupe(L, { edge, finger, root, layer, inks, dt, reduce, vis }) {
  if (!L.on) return false;
  const lr = layer.getBoundingClientRect();
  if (root && L.src !== root) { L.inner.replaceChildren(cloneRoot(root)); L.src = root; L.off = null; }
  const fx = edge.x, fy = edge.y + edge.h / 2;
  const fingerY = finger ? finger.y - lr.top : edge.y;
  const tx = Math.max(vis.l + W / 2 + 6, Math.min(vis.r - W / 2 - 6, fx));
  const ty = Math.max(vis.t + 6, Math.min(edge.y, fingerY - 34) - 12 - H);
  if (!L.placed || reduce) { L.x = tx; L.y = ty; L.vx = L.vy = 0; L.placed = true; }
  else {
    for (let rem = dt; rem > 0; rem -= 4) {
      const s = Math.min(4, rem) / 1000;
      [L.x, L.vx] = spring(L.x, L.vx, tx, 38, 0.9, s);   // 横向跟手、带一点滞后
      [L.y, L.vy] = spring(L.y, L.vy, ty, 60, 1, s);     // 纵向按行跳
    }
  }
  L.el.style.transform = `translate(${f2(L.x - W / 2)}px, ${f2(L.y)}px)`;
  // 克隆的左上角 = 原消息的左上角：边在原消息里的位置 × 倍数，挪到胶囊正中
  if (L.src) {
    const rr = L.src.getBoundingClientRect();
    if (!L.off) {
      // 原消息里第一块的上外边距会穿过消息落到它外面，绝对定位的克隆自成一块、外边距落在里面：两边不一定重合，量一次差
      L.inner.style.transform = `scale(${M})`;
      const a = firstCharRect(L.src), c = L.inner.firstElementChild && firstCharRect(L.inner.firstElementChild), ir = L.inner.getBoundingClientRect();
      L.off = a && c ? { x: (c.left - ir.left) / M - (a.left - rr.left), y: (c.top - ir.top) / M - (a.top - rr.top) } : { x: 0, y: 0 };
    }
    const px = lr.left + fx - rr.left + L.off.x, py = lr.top + fy - rr.top + L.off.y;
    L.inner.style.transform = `translate(${f2(W / 2 - px * M)}px, ${f2(H / 2 - py * M)}px) scale(${M})`;
  }
  L.ink.style.transform = `translate(${f2(W / 2 - fx * M)}px, ${f2(H / 2 - fy * M)}px) scale(${M})`;
  let d = '';
  let op = '1';
  for (const i of inks) { if (i.dead) continue; d += i.fill.getAttribute('d') || ''; if (!i.exiting) op = i.g.style.opacity || '1'; }
  L.path.setAttribute('d', d);
  L.path.style.opacity = op;
  L.stem.style.top = f2(H / 2 - (edge.h * M) / 2) + 'px';
  L.stem.style.height = f2(edge.h * M) + 'px';
  return Math.abs(L.x - tx) > 0.2 || Math.abs(L.y - ty) > 0.2;
}
