// FLIP 布局动画（First-Last-Invert-Play）——「找相同，别瞬移」。
//
// 用途：一块 UI 因为宽度分档 / 状态切换而整体重排（元素换行、收进菜单、图标从分段钮变单钮）时，
// 让【重排前后都在场】的同一个图形从旧位置平移/形变到新位置，消失的原地淡出，新出现的淡入，
// 而不是一帧切换。容器内凡是带 `data-flip="<key>"` 的元素都参与：同 key 视为同一个图形。
//
// 用法（Svelte 5）：
//   const flip = createFlip(() => rootEl);
//   $effect.pre(() => { tier; untrack(() => flip.snapshot()); });   // DOM 变之前拍旧位
//   $effect(()     => { tier; untrack(() => flip.play()); });       // DOM 变之后量新位、起动画
//
// 三类元素：
//   · 普通（钮/图标）：transform 平移 + 按中心等比缩放（尺寸略变的钮也顺滑）
//   · `data-flip-morph="x"` 的容器（搜索框/面包屑这类「框变长」的）：外层 scaleX（左缘为原点）
//     让边框从旧宽拉到新宽，内层 `[data-flip-inner]` 反向 scaleX 抵消——里面的图标/文字纹丝不动，
//     看起来就是「方框从一个点长成一条栏」。全程只动 transform，不碰布局，兄弟元素的位移互不干扰。
//   · 嵌在另一个 flip 元素里的子元素：位移按【相对父元素】算，父子动画各自叠加不重复计。
// 离场：从快照里的克隆造一枚幽灵，钉在旧位淡出（幽灵里仍在场的子 key 隐掉，别出重影）。
// 入场：淡入 + 由 .6 放大。容器自身高度变了（多出一行）也用 height 动画顺过去。
// 中途再来一次重排：以【当前视觉位置】（含在途 transform）为新的旧位，取消旧动画再起，不跳帧。
// prefers-reduced-motion：只做布局，不起任何动画。

const EASE = 'cubic-bezier(.2,0,0,1)';   // 与 app.css --ea-std 一致
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
// dev 慢放（?flipslow）：240ms 的动画肉眼/截图都对不上，×12 后逐帧看得清
const slow = () => { try { return import.meta.env.DEV && new URLSearchParams(location.search).has('flipslow'); } catch { return false; } };

const near = (a, b, eps = .5) => Math.abs(a - b) < eps;

export function createFlip(getRoot, { duration = 240, easing = EASE } = {}) {
  let prev = null;          // key → { el, rect, clone, parentKey }
  let prevRootRect = null;
  const running = new Set();
  const ghosts = new Set();

  const parentKeyOf = (el, root) => {
    const p = el.parentElement?.closest?.('[data-flip]');
    return p && root.contains(p) && p !== el ? p.dataset.flip : '';
  };
  function collect(root) {
    const m = new Map();
    for (const el of root.querySelectorAll('[data-flip]')) {
      const key = el.dataset.flip;
      if (!key || m.has(key)) continue;
      m.set(key, { el, rect: el.getBoundingClientRect(), parentKey: parentKeyOf(el, root) });
    }
    return m;
  }
  const dur = () => duration * (slow() ? 12 : 1);

  function snapshot() {
    const root = getRoot();
    if (!root || reduced()) { prev = null; return; }
    prev = collect(root);
    prevRootRect = root.getBoundingClientRect();
    for (const v of prev.values()) v.clone = v.el.cloneNode(true);
  }

  function clearRunning() {
    for (const a of running) { try { a.cancel(); } catch {} }
    running.clear();
    for (const g of ghosts) g.remove();
    ghosts.clear();
  }
  // 最后一段动画收尾时才摘 flip-anim（它带 overflow:hidden）。首版用 setTimeout(D+20) 摘，
  // 但入场动画有 .15D 的延迟、总长 1.15D，那一刻 running 还不空 → 类永远摘不掉，
  // 工具栏一直裁溢出，排序 / ＋ 下拉被裁在工具栏底边以下（看着像被文件挡住）。
  function track(anim, onDone) {
    running.add(anim);
    anim.finished.then(() => {
      running.delete(anim); onDone?.();
      if (!running.size) getRoot()?.classList.remove('flip-anim');
    }, () => {});
    return anim;
  }

  function play() {
    const root = getRoot();
    if (!root || !prev || reduced()) { prev = null; return; }
    const old = prev, oldRoot = prevRootRect;
    prev = null;
    // 先把在途动画掐掉（快照已经把它们的视觉位置拍进 old 了），再量【最终布局】
    clearRunning();
    root.classList.remove('flip-anim');
    const next = collect(root);
    const rootRect = root.getBoundingClientRect();
    const D = dur();
    const opts = { duration: D, easing, fill: 'none' };
    let any = false;

    // 相对坐标：有 flip 祖先的元素按祖先算，祖先自己的动画会把它一起带过去
    const rel = (rec, map) => {
      const p = rec.parentKey ? map.get(rec.parentKey) : null;
      return p ? { x: rec.rect.left - p.rect.left, y: rec.rect.top - p.rect.top } : { x: rec.rect.left, y: rec.rect.top };
    };

    // 正在做 scaleX 形变的父框：里面的子元素不再单独平移——外层缩放 + 内层反缩放已经让内容
    // 左对齐钉在最终位置，边框「长过去」把它们露出来才是干净的形变；子元素再各自飞一遍反而
    // 因为快照取自缩放中的父框（坐标系混了）而错位。querySelectorAll 是文档序，父先于子。
    const morphing = new Set();
    for (const [key, n] of next) {
      const o = old.get(key);
      if (!o) {   // 入场
        any = true;
        track(n.el.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { ...opts, delay: D * .15, fill: 'backwards' }));
        continue;
      }
      // 旧父与新父不同（如面包屑从第一行挪到第二行）：按绝对坐标算，父子叠加不成立时以绝对为准
      if (n.parentKey && morphing.has(n.parentKey)) continue;
      const sameParent = o.parentKey === n.parentKey && (!n.parentKey || next.has(n.parentKey));
      const po = sameParent ? rel(o, old) : { x: o.rect.left, y: o.rect.top };
      const pn = sameParent ? rel(n, next) : { x: n.rect.left, y: n.rect.top };
      const sx = n.rect.width ? o.rect.width / n.rect.width : 1;
      const sy = n.rect.height ? o.rect.height / n.rect.height : 1;
      const morphX = n.el.dataset.flipMorph === 'x';
      if (morphX) {
        // 左缘为锚：边框从旧宽拉到新宽；内层反向缩放，图标/文字不动
        const dx = po.x - pn.x, dy = po.y - pn.y;
        if (near(dx, 0) && near(dy, 0) && near(sx, 1, .005)) continue;
        any = true;
        if (!near(sx, 1, .005)) morphing.add(key);
        n.el.style.transformOrigin = 'left center';
        track(n.el.animate([{ transform: `translate(${dx}px, ${dy}px) scaleX(${sx})` }, { transform: 'none' }], opts));
        const inner = n.el.querySelector('[data-flip-inner]');
        if (inner && !near(sx, 1, .005)) {
          inner.style.transformOrigin = 'left center';
          track(inner.animate([{ transform: `scaleX(${1 / sx})` }, { transform: 'none' }], opts));
        }
      } else if (n.el.dataset.flipAnchor === 'left') {
        // 文字段（面包屑各段）：以左缘为锚只平移，不缩放——文字横向拉伸难看，
        // 中心缩放起步那几帧还会把左端撑出父框被裁掉
        const dx = po.x - pn.x, dy = (po.y + o.rect.height / 2) - (pn.y + n.rect.height / 2);
        if (near(dx, 0) && near(dy, 0)) continue;
        any = true;
        n.el.style.transformOrigin = 'left center';
        track(n.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], opts));
      } else {
        // 普通元素：中心对中心平移 + 等比缩放
        const dx = (po.x + o.rect.width / 2) - (pn.x + n.rect.width / 2);
        const dy = (po.y + o.rect.height / 2) - (pn.y + n.rect.height / 2);
        if (near(dx, 0) && near(dy, 0) && near(sx, 1, .01) && near(sy, 1, .01)) continue;
        any = true;
        n.el.style.transformOrigin = 'center';
        track(n.el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }], opts));
      }
    }

    // 离场：幽灵钉在旧位淡出。旧父仍在场的子元素不单独出幽灵（跟着父的幽灵走）
    for (const [key, o] of old) {
      if (next.has(key) || !o.clone) continue;
      if (o.parentKey && old.has(o.parentKey) && !next.has(o.parentKey)) continue;
      any = true;
      const g = o.clone;
      // 幽灵里仍在场的子 key 隐掉（它们正从这里飞到新位置，别出重影）
      for (const c of g.querySelectorAll('[data-flip]')) if (next.has(c.dataset.flip)) c.style.visibility = 'hidden';
      g.removeAttribute('data-flip');
      g.setAttribute('aria-hidden', 'true');
      Object.assign(g.style, {
        position: 'absolute', margin: '0', pointerEvents: 'none', boxSizing: 'border-box',
        left: (o.rect.left - rootRect.left) + 'px', top: (o.rect.top - rootRect.top) + 'px',
        width: o.rect.width + 'px', height: o.rect.height + 'px', transformOrigin: 'center',
      });
      root.appendChild(g);
      ghosts.add(g);
      track(g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.6)' }], { duration: D * .7, easing, fill: 'forwards' }), () => { g.remove(); ghosts.delete(g); });
    }

    // 容器自己长高/变矮（多出一行 / 少一行）：高度顺过去，期间裁掉溢出
    if (oldRoot && !near(oldRoot.height, rootRect.height)) {
      any = true;
      root.classList.add('flip-anim');
      track(root.animate([{ height: oldRoot.height + 'px' }, { height: rootRect.height + 'px' }], opts));
    } else if (any) {
      root.classList.add('flip-anim');
    }
  }

  function destroy() { clearRunning(); prev = null; getRoot()?.classList.remove('flip-anim'); }
  return { snapshot, play, destroy };
}
