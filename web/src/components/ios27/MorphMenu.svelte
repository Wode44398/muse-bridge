<script>
  // 液态玻璃菜单，两种出场：
  //   · 按钮菜单：点一下就从按钮长出来（iOS 26「下拉按钮」：Pull-Down Button / GlassMenu）；
  //   · 长按菜单：长按 / 右键时从按压点弹出（iOS 26 上下文菜单：GlassContextMenu 的动作盘）。
  // 长什么样 = kit「Menu」：Liquid Glass - Regular - Medium 圆角 34、上下内距 10；行与 kit Menu Items 同一套排版。
  //           材质对页面实时折射（lib/liquid/glass.js MorphGlass：形状按距离场逐帧重算）；WebKit / Firefox 退回 CSS 毛玻璃。
  // 怎么动（按钮）= sdegenaar/liquid_glass_widgets 1.17.0 GlassMenu（liquid_morph_physics.dart + glass_menu_internal.dart，样稿逐数核对）：
  //           单个不限范围的弹簧 v（展开 k120/c16 初速 0；收起 k200/c21 初速 −3.2），位置走 back-out J 曲线（幅度 2.5，漂移钳 ±8），
  //           尺寸 linearToEaseOut（收起 v^1.4），圆角 easeInExpo 收到 34；按钮幽灵在前 40% 缩没，两块用 SDF 二次平滑并集融合
  //           （融合量 |pathT−sizeT|·150，上限 28）；内容 v>0.25 起淡入、从 0.7 放大；收起越过 0 时交接回真按钮并「撞一下」；
  //           展开后按住菜单可滑动换高亮、松手选中，按住时整块 LiquidStretch（1.02 + 远离锚点方向的拉伸）。
  //           neighbors（按钮旁边的同排玻璃按钮）：终态菜单会盖到的那几个，菜单边缘扫到时并进同一块液滴（SDF 平滑并集），
  //           缩成水滴流进菜单；收起时从退回的菜单边缘滴出来、回到原位，交接回原按钮并弹一下（同 GlassMenu 的交接）。
  //           样稿 bridge前端设计/液态玻璃组件样稿/顶栏融合菜单demo.html。只在实时液滴材质下有；退路材质照旧盖在上面。
  // 怎么动（长按）= 同库 GlassContextMenu（glass_context_menu.dart）的提交段：190ms 线性时间轴，t>0.12 起动作盘从靠手指那条边、
  //           手指横坐标处 0.4→1 放大（easeOutCubic）、透明度 ×3 淡入，压暗层 easeOut 走前 25%；收起 170ms：前 25% 里淡出并缩到 0.88，
  //           压暗层线性退。按住滑选同上（没有 LiquidStretch）；按住时弹出的（鼠标长按、壁纸长按），同一根手指不松开直接滑进来也能选。
  //           没有原版「行先抬起」那一段：工作空间里长按是「拿起来拖」（lib/dragdrop），原地松手才出菜单。
  // 用法：按钮 <GlassButton bind:el={btn} onclick={() => (open = !open)} /> + <MorphMenu {open} anchor={btn} {items} onclose={() => (open = false)} />；
  //       长按 <MorphMenu {open} point={{ x: e.clientX, y: e.clientY }} ... />（anchor 为空就按 point）。
  //   菜单一直挂着（open 只管展开 / 收起，收起动画才放得完）；按钮 / 按压点在展开那一刻取定，收起途中照旧显示收起前那一份
  //   items / title（调用方关菜单时把状态清空也没关系）。items：{ label, symbol?, icon?, tint?, destructive?, disabled?, detail?, checked?, onclick } 或 { sep: true }。
  // 挂的位置：放在一个本身有不透明底色、包住页面内容的容器里（如 .ws-root），中间别隔会建层叠上下文的父级——
  //   玻璃（backdrop-filter）和装饰（mix-blend）平铺在同一层，玻璃才采得到底下的页面（Chromium 合成面规则，见 glass.js）。
  import { getContext, onMount, untrack } from 'svelte';
  import Sym from './Sym.svelte';
  import { Spring, flutterSpring, durSpring, register, wake, clamp, lerp, linearToEaseOut, easeInExpo, flutterEaseOut, easeOutCubic, reduceMotion, triggers } from '../../lib/liquid/core.js';
  import { KIT } from '../../lib/liquid/kit.js';
  import { LIQUID, MorphGlass, sdfOf, cssShadow } from '../../lib/liquid/glass.js';
  import { haptic } from '../../lib/dragdrop.svelte.js';

  let { open = false, anchor = null, point = null, neighbors = [], onfuse, items = [], title = '', width = 250, onclose, children } = $props();
  const ios = getContext('ios27');
  const dark = $derived(!!ios?.dark);

  const M = KIT.menu;
  let root = $state(), glassEl, shadowEl, clipEl, bodyEl, barrierEl;
  let rowEls = $state([]);
  let shown = $state(false);   // 挂着（展开、停着、收起中）
  let sel = $state(-1);        // 高亮的行

  // 收起途中显示收起前那一份（调用方关菜单时常把状态清成 null，items 随之变空）
  let keep = { items: [], title: '' };
  const view = $derived.by(() => {
    if (open || !shown) keep = { items, title };
    return keep;
  });

  const ctl = {
    v: flutterSpring(0, 120, 16),
    iscale: durSpring(1, .3, 0), stX: durSpring(0, .15, .15), stY: durSpring(0, .15, .15),
    ctx: false, ct: 0, anchor: null, ar: null,
    closing: false, handedOff: false, dragging: false,
    W: 250, H: 100, tw: 44, th: 44, align: { x: -1, y: -1 }, fdx: 0, fdy: 0, ext: null,
    L: 0, T: 0, ox: 0, oy: 0,
    morph: null, lastKey: '', clipKey: '', shQ: '', clipX: 0, clipY: 0,
    nb: [],   // 融进液滴的邻近按钮 { el, geo（容器坐标）, mode: 'rest' | 'fused', s（大小弹簧，1 = 原大）}
    step(dt) {
      if (!shown) return;
      for (const n of this.nb) n.s.step(dt);
      if (this.ctx) {
        this.ct = Math.min(1, this.ct + dt / (this.closing ? .17 : .19));
        if (this.closing && this.ct >= 1) finish();
        return;
      }
      const v = this.v;
      v.step(dt); this.iscale.step(dt); this.stX.step(dt); this.stY.step(dt);
      if (Math.abs(v.x - v.t) < .001 && Math.abs(v.v) < .05) { v.x = v.t; v.v = 0; }   // Tolerance(0.001, 0.05)，snapToEnd
      if (this.closing && !this.handedOff && v.x <= 0) this.handedOff = true;
      if (this.closing && v.x <= .001 && Math.abs(v.v) < .5 && this.nb.every((n) => n.mode === 'rest' && n.s.idle)) finish();
    },
    isIdle() {
      if (!shown) return true;
      if (this.ctx) return !this.closing && this.ct >= 1;
      return !this.closing && this.v.x === 1 && !this.dragging && this.iscale.idle && this.stX.idle && this.stY.idle && this.nb.every((n) => n.s.idle);
    },
    render() { if (shown) (this.ctx ? frameCtx() : frame()); },
  };

  // —— 材质（触屏 Chromium：实时折射；其余：CSS 毛玻璃）。头一次展开才建（一页挂着好几个菜单，没开过的不占滤镜）——
  function buildMorph() {
    ctl.morph?.destroy(); ctl.morph = null;
    if (!LIQUID || !root) return;
    ctl.morph = new MorphGlass({ layers: KIT.medium(dark, 238, 300), dark, fastDpr: .5 });
    ctl.morph.mount(root, clipEl);
    for (const d of ctl.morph.decor) d.el.style.zIndex = '96';
    ctl.morph.setDecorVisible(false);
    glassEl.style.backdropFilter = glassEl.style.webkitBackdropFilter = `url(#${ctl.morph.id})`;
    ctl.lastKey = '';
  }
  const kitShadow = $derived(KIT.medium(dark, 238, 300)[0].effects.find((e) => e.type === 'DROP_SHADOW' && e.blend === 'NORMAL'));

  onMount(() => {
    const off = register(ctl);
    const onWin = () => { if (shown) wake(ctl); };
    const onKey = (e) => { if (e.key === 'Escape' && shown && !ctl.closing) { e.stopPropagation(); requestClose(); } };
    addEventListener('scroll', onWin, { passive: true, capture: true });
    addEventListener('resize', onWin, { passive: true });
    addEventListener('keydown', onKey, true);
    return () => {
      off(); ctl.morph?.destroy(); glide(false);
      removeEventListener('scroll', onWin, { capture: true }); removeEventListener('resize', onWin); removeEventListener('keydown', onKey, true);
      if (ctl.anchor && shown) trig(ctl.anchor)?.fade(1);
      releaseNb();
    };
  });
  $effect(() => { dark; untrack(() => { if (root && ctl.morph) { buildMorph(); if (shown) ctl.morph?.setDecorVisible(true); } }); });
  $effect(() => { const o = open; untrack(() => { if (o) openNow(); else closeNow(); wake(ctl); }); });

  // 触发按钮：玻璃按钮登记过渐隐 / 撞一下接口；别的元素直接改样式
  const trig = (el) => triggers.get(el) || (el && {
    fade(a) { el.style.opacity = a >= .999 ? '' : a.toFixed(4); el.style.pointerEvents = a < .5 ? 'none' : ''; },
    impact(t) { el.style.transform = t || ''; },
  });
  // 邻近按钮的融合接口：玻璃按钮登记过 fuse（玻璃、符号分开淡）；别的元素整体淡 + 变换
  const nbFx = (el) => { const t = triggers.get(el); return t?.fuse ? t : { fuse(ga, ia, tf) { el.style.opacity = ia >= .999 ? '' : ia.toFixed(4); el.style.transform = tf || ''; } }; };
  // onfuse(true / false)：有按钮融着的整段（展开到收完）。调用方借它把那排按钮抬到菜单玻璃之上——
  //   融进去 / 滴回来的符号才看得见，不被液滴的磨砂盖住（抬起期间那排按钮不接点击，点到的是挡板）
  function releaseNb() { const had = ctl.nb.length; for (const n of ctl.nb) nbFx(n.el).fuse(1, 1, ''); ctl.nb = []; if (had) onfuse?.(false); }
  // 二次平滑并集（与按钮幽灵的融合同一式）
  const smin = (a, b, k) => { const m = Math.min(a, b); if (!(k > 0)) return m; const e = Math.max(k - Math.abs(a - b), 0); return m - e * e * .25 / k; };
  // 形状 f 与胶囊按钮 g 的间隙：中心处的距离减去按钮沿 f 梯度方向的支撑长度（< 0 = 已经搭上）
  function gapTo(f, g) {
    const cx = g.x + g.w / 2, cy = g.y + g.h / 2, d = f(cx, cy);
    let gx = f(cx + .5, cy) - f(cx - .5, cy), gy = f(cx, cy + .5) - f(cx, cy - .5);
    const gl = Math.hypot(gx, gy) || 1; gx /= gl; gy /= gl;
    const r = g.h / 2, sup = (g.w / 2 - r) * Math.abs(gx) + (g.h / 2 - r) * Math.abs(gy) + r;
    return { gap: d - sup, sup };
  }

  // 按钮的位置：收起途中按钮被移出页面（选了一项、列表跟着刷新）就停在它最后的位置，照样收回那儿
  function anchorRect() {
    const a = ctl.anchor;
    if (a?.isConnected) { const r = a.getBoundingClientRect(); if (r.width || r.height) ctl.ar = r; }
    return ctl.ar;
  }
  // 可用范围：菜单所在容器（内嵌在工作台里时不是整块视口）与视口的交集，再让开状态栏和手势条
  function bounds() {
    const cs = getComputedStyle(document.documentElement);
    const sat = parseFloat(cs.getPropertyValue('--sat')) || 0, sab = parseFloat(cs.getPropertyValue('--sab')) || 0;
    const c = (root.offsetParent || document.documentElement).getBoundingClientRect();
    return { l: Math.max(c.left, 0), r: Math.min(c.right, innerWidth), t: Math.max(c.top, sat), b: Math.min(c.bottom, innerHeight - sab) };
  }

  function openNow() {
    const a = anchor, p = point;
    if ((!a && !p) || !root) return;
    if (shown && !ctl.closing) return;
    // 收起途中换了触发源（「…」那份还没收完又长按了别的行）：先把上一个按钮还原
    if (shown && ctl.anchor && ctl.anchor !== a) { const t0 = trig(ctl.anchor); t0?.fade(1); t0?.impact(''); }
    releaseNb();
    if (LIQUID && !ctl.morph) buildMorph();
    ctl.anchor = a; ctl.ar = null; ctl.ctx = !a;
    const B = bounds();
    // 尺寸：至少调用方给的宽、内容更宽就撑开，不出容器；高度量排版后的真高，放不下就截短、停稳后自身滚动
    // （根节点收起时只是 visibility:hidden，照常排版，量得到）
    bodyEl.style.width = ''; bodyEl.style.height = '';
    // 自定义内容（传输列表这类）按调用方给的宽；菜单行按内容撑开
    ctl.W = Math.min(children ? width : Math.max(width, bodyEl.scrollWidth), B.r - B.l - 16);
    bodyEl.style.width = ctl.W + 'px';
    const natural = bodyEl.scrollHeight;
    ctl.closing = false; ctl.handedOff = false; ctl.dragging = false;
    ctl.lastKey = ''; ctl.clipKey = ''; ctl.shQ = '';
    glassEl.style.opacity = shadowEl.style.opacity = '';
    sel = -1;
    if (ctl.ctx) {
      // 手指下方 14 处展开，放不下放上方，再放不下就夹进屏内；横向以手指为中、夹进容器；从靠手指那条边、手指的横坐标处放大
      const top0 = B.t + 12, bot0 = B.b - 12, H = Math.max(40, Math.min(natural, bot0 - top0));
      let T, oy;
      if (p.y + 14 + H <= bot0) { T = p.y + 14; oy = 0; }
      else if (p.y - 14 - H >= top0) { T = p.y - 14 - H; oy = H; }
      else { T = clamp(p.y - H / 2, top0, bot0 - H); oy = clamp(p.y - T, 0, H); }
      const L = clamp(p.x - ctl.W / 2, B.l + 12, Math.max(B.l + 12, B.r - 12 - ctl.W));
      ctl.H = H; ctl.tall = H < natural - .5;
      ctl.L = L; ctl.T = T; ctl.ox = clamp(p.x - L, 0, ctl.W); ctl.oy = oy;
      ctl.ct = 0;
      // 压暗层当场就挡：长按松手后浏览器补发的那下 click 落在它上面，不会落回底下的行
      barrierEl.style.pointerEvents = 'auto';
    } else {
      const r = anchorRect() || a.getBoundingClientRect();
      ctl.tw = a.offsetWidth || r.width; ctl.th = a.offsetHeight || r.height;
      const acx = r.left + r.width / 2, acy = r.top + r.height / 2;
      ctl.align.x = acx > (B.l + B.r) / 2 ? 1 : -1;
      const below = B.b - 12 - (acy - ctl.th / 2), above = acy + ctl.th / 2 - B.t - 12;
      ctl.align.y = below < natural && above > below ? 1 : -1;
      ctl.H = Math.max(ctl.th, Math.min(natural, B.b - B.t - 24));
      ctl.tall = ctl.H < natural - .5;
      ctl.fdx = -ctl.align.x * (ctl.W - ctl.tw) / 2;
      // 竖向：贴着按钮的那条边展开（向下＝上缘对齐按钮上缘，向上＝下缘对齐按钮下缘）；两边都放不下（按钮在屏幕中段、
      // 条目又多）就整块挪进屏内、盖住按钮也行——不截短，免得最后一项（多半是「删除」）要滚才看得到
      const top = clamp(ctl.align.y < 0 ? acy - ctl.th / 2 : acy + ctl.th / 2 - ctl.H, B.t + 12, Math.max(B.t + 12, B.b - 12 - ctl.H));
      ctl.fdy = top + ctl.H / 2 - acy;
      // 横向夹进容器（终态左缘 ≥ 左界 + 8、右缘 ≤ 右界 − 8）
      const fl = acx + ctl.fdx - ctl.W / 2;
      if (fl < B.l + 8) ctl.fdx += B.l + 8 - fl; else if (fl + ctl.W > B.r - 8) ctl.fdx -= fl + ctl.W - (B.r - 8);
      const v = ctl.v, [k, c] = reduceMotion() ? [500, 32.4] : [120, 16];
      if (!shown) v.snap(0);
      v.k = k; v.z = c / (2 * Math.sqrt(k)); v.t = 1; v.v = 0;
      ctl.iscale.snap(1); ctl.stX.snap(0); ctl.stY.snap(0);
      barrierEl.style.background = '';
      // 整段形变的外包范围（容器坐标）：滤镜区域固定成它、整段只换图（改区域会重建整条滤镜，真机一次 15–20ms）
      const o = root.getBoundingClientRect();
      const tx = acx - ctl.tw / 2 - o.left, ty = acy - ctl.th / 2 - o.top;
      const fx = tx + ctl.tw / 2 + ctl.fdx - ctl.W / 2, fy = ty + ctl.th / 2 + ctl.fdy - ctl.H / 2;
      let x0 = Math.min(tx, fx), y0 = Math.min(ty, fy), x1 = Math.max(tx + ctl.tw, fx + ctl.W), y1 = Math.max(ty + ctl.th, fy + ctl.H);
      // 终态菜单盖到的邻近按钮才融（隔着缝的不动）；外包范围把它们也包进去
      if (ctl.morph && !reduceMotion()) {
        const fF = sdfOf({ x: fx, y: fy, w: ctl.W, h: ctl.H, r: M.r });
        for (const el of neighbors || []) {
          if (!el || el === a || !el.isConnected) continue;
          const nr = el.getBoundingClientRect();
          if (!nr.width || !nr.height) continue;
          const w = el.offsetWidth || nr.width, h = el.offsetHeight || nr.height;
          const geo = { x: nr.left + nr.width / 2 - w / 2 - o.left, y: nr.top + nr.height / 2 - h / 2 - o.top, w, h };
          if (gapTo(fF, geo).gap >= .5) continue;
          ctl.nb.push({ el, geo, mode: 'rest', s: new Spring(1, .62, 300) });
          x0 = Math.min(x0, geo.x); y0 = Math.min(y0, geo.y); x1 = Math.max(x1, geo.x + w); y1 = Math.max(y1, geo.y + h);
        }
      }
      if (ctl.nb.length) onfuse?.(true);
      const ex0 = Math.floor(x0 - 40), ey0 = Math.floor(y0 - 40);
      ctl.ext = [ex0, ey0, Math.ceil(x1 + 40) - ex0, Math.ceil(y1 + 40) - ey0];
    }
    shown = true;
    root.style.visibility = '';
    ctl.morph?.setDecorVisible(true);
    glide(true);
    wake(ctl);
  }
  function closeNow() {
    if (!shown || ctl.closing) return;
    ctl.closing = true; ctl.handedOff = false; ctl.dragging = false;
    sel = -1;
    if (ctl.ctx) { ctl.ct = 0; wake(ctl); return; }
    const v = ctl.v, [k, c] = reduceMotion() ? [500, 32.4] : [200, 21];
    v.k = k; v.z = c / (2 * Math.sqrt(k)); v.t = 0; v.v = -3.2;
    wake(ctl);
  }
  function finish() {
    shown = false; ctl.closing = false;
    root.style.visibility = 'hidden';
    barrierEl.style.visibility = ''; barrierEl.style.pointerEvents = 'none'; barrierEl.style.background = ''; clipEl.style.pointerEvents = 'none';
    ctl.morph?.setDecorVisible(false);
    glide(false);
    if (ctl.anchor) { const t = trig(ctl.anchor); t?.fade(1); t?.impact(''); }
    releaseNb();
  }
  function requestClose() { closeNow(); onclose?.(); }
  function pick(i) {
    const it = view.items[i];
    if (!it || it.sep || it.disabled || ctl.closing) return;
    requestClose();
    it.onclick?.();
  }

  // 内阴影、边缘高光之外的公共摆放：外投影（σ≈20 的柔影）尺寸按 16px 台阶取整、余下用缩放补齐（每帧改尺寸会整块重新光栅化）
  function placeShadow(bL, bT, W, H, R, tf, a) {
    const qw = Math.max(16, Math.ceil(W / 16) * 16), qh = Math.max(16, Math.ceil(H / 16) * 16), qr = Math.round(R / 4) * 4, s = shadowEl.style;
    const q = qw + 'x' + qh + 'x' + qr;
    if (ctl.shQ !== q) { ctl.shQ = q; s.width = qw + 'px'; s.height = qh + 'px'; s.borderRadius = qr + 'px'; }
    s.left = bL + 'px'; s.top = bT + 'px';
    s.transform = `${tf(bL, bT)} scale(${(W / qw).toFixed(5)}, ${(H / qh).toFixed(5)})`;
    s.opacity = a >= .9999 ? '' : a.toFixed(4);
  }
  // 内容：由本体裁出（圆角容器）
  function placeClip(bL, bT, W, H, R, tf) {
    const ck = [Math.round(bL), Math.round(bT), Math.round(W), Math.round(H), Math.round(R)];
    if (ck.join() !== ctl.clipKey) {
      ctl.clipKey = ck.join(); ctl.clipX = ck[0]; ctl.clipY = ck[1];
      const s = clipEl.style; s.left = ck[0] + 'px'; s.top = ck[1] + 'px'; s.width = ck[2] + 'px'; s.height = ck[3] + 'px'; s.borderRadius = ck[4] + 'px';
    }
    clipEl.style.transform = tf(ctl.clipX, ctl.clipY);
  }

  // —— 按钮菜单逐帧：LiquidMorphPhysics.compute → 液滴形状、玻璃、内容 ——
  function frame() {
    const ar = anchorRect();
    if (!ar || !root) return;
    const v = ctl.v, raw = v.x, c = clamp(raw, 0, 1), und = raw < 0 ? raw : 0, closing = ctl.closing;
    const o = root.getBoundingClientRect(), r = ar, tw = ctl.tw, th = ctl.th;
    const trigX = r.left + r.width / 2 - tw / 2 - o.left, trigY = r.top + r.height / 2 - th / 2 - o.top;
    const fdx = ctl.fdx, fdy = ctl.fdy;
    const adaptive = Math.abs(fdy) > 100;
    const amp = adaptive ? clamp(2.5 * 100 / Math.abs(fdy), .7, 2.5) : 2.5;
    const backOut = (t) => { const u = t - 1; return u * u * ((amp + 1) * u + amp) + 1; };
    const pathT = closing ? c + und : backOut(c) + und;
    const sizeT = (closing ? Math.pow(c, 1.4) : linearToEaseOut(c)) + und;
    let pushFactor = 1;
    if (adaptive) { const mg = Math.hypot(fdx, fdy); pushFactor = mg > 0 ? clamp(80 / mg, 0, 1) : 1; }
    const pushDx = raw < 0 ? fdx * raw * pushFactor : 0, pushDy = raw < 0 ? fdy * raw * pushFactor : 0;
    const anchorScale = closing ? clamp(1 - (c - .45) / .4, 0, 1) : clamp(1 - c / .4, 0, 1);
    const blend = closing ? clamp(flutterEaseOut(clamp(1 - c / .6, 0, 1)) * 28, 0, 28) : clamp(Math.abs(pathT - sizeT) * 150, 0, 28);
    // 菜单本体（Blob B）
    const W = sizeT < 0 ? Math.max(1, tw * (1 + sizeT * .25)) : Math.max(0, lerp(tw, ctl.W, sizeT));
    const H = sizeT < 0 ? Math.max(1, th * (1 + sizeT * .25)) : Math.max(0, lerp(th, ctl.H, sizeT));
    const maxR = Math.min(W, H) / 2;
    const R = closing ? maxR : lerp(maxR, M.r, easeInExpo(clamp(sizeT, 0, 1)));
    let dx, dy;
    if (closing) { dx = fdx * pathT; dy = fdy * pathT; }
    else { dx = fdx * sizeT + clamp(fdx * (pathT - sizeT), -8, 8); dy = fdy * sizeT + clamp(fdy * (pathT - sizeT), -8, 8); }
    const bL = trigX + tw / 2 + dx - W / 2, bT = trigY + th / 2 + dy - H / 2;
    // 形状：本体 ∪ 按钮幽灵（Blob A），SDF 二次平滑并集
    const sB = sdfOf({ x: bL, y: bT, w: W, h: H, r: R });
    const aS = anchorScale;
    const ax = trigX + tw / 2 + pushDx, ay = trigY + th / 2 + pushDy, ahw = tw / 2 * aS, ahh = th / 2 * aS;
    const sA = aS > 1e-3 ? sdfOf({ x: ax - ahw, y: ay - ahh, w: 2 * ahw, h: 2 * ahh, r: ahh }) : null;
    const k = blend;
    const bodyOn = !ctl.handedOff;
    // 邻近按钮：搭上就并进液滴（水滴），收起时滴回原位、交接回原按钮
    const drops = [], dkey = [];
    for (const n of ctl.nb) {
      const h = n.geo, hcx = h.x + h.w / 2, hcy = h.y + h.h / 2;
      const G0 = bodyOn ? gapTo(sB, h) : { gap: Infinity, sup: 1 };
      if (n.mode === 'rest') {
        if (!closing && bodyOn && G0.gap < 1) { n.mode = 'fused'; n.s.t = 0; }
      } else if (closing || !bodyOn) {
        // 菜单退到只盖住它不到一半：开始滴出来；长回原大、和菜单分开了：交接回原按钮（弹簧的余量就是「弹一下」）
        if (n.s.t === 0 && G0.gap > -.4 * G0.sup) n.s.t = 1;
        if (n.s.t === 1 && n.s.x > .96 && G0.gap > 3) n.mode = 'rest';
      }
      const nf = nbFx(n.el);
      if (n.mode === 'fused') {
        const sz = Math.max(0, n.s.x);
        let px = hcx, py = hcy;
        if (bodyOn) {   // 往菜单里流：目标点＝原中心夹进菜单本体（内缩半个按钮高）
          const ix = Math.min(h.h / 2, W / 2), iy = Math.min(h.h / 2, H / 2);
          px = clamp(hcx, bL + ix, bL + W - ix); py = clamp(hcy, bT + iy, bT + H - iy);
        }
        const cx = px + (hcx - px) * sz, cy = py + (hcy - py) * sz, w = h.w * sz, hh = h.h * sz;
        if (sz > .02) { drops.push(sdfOf({ x: cx - w / 2, y: cy - hh / 2, w, h: hh, r: hh / 2 })); dkey.push(cx.toFixed(1), cy.toFixed(1), sz.toFixed(3)); }
        const t = `translate(${(cx - hcx).toFixed(2)}px, ${(cy - hcy).toFixed(2)}px) scale(${sz.toFixed(4)})`;
        // 搭上的那一下：按钮自己的玻璃在前 20% 里交给液滴；符号跟着流进去、缩到 6 成就淡没，滴回来时晚一点才显出来
        nf.fuse(n.s.t === 0 ? clamp((sz - .8) / .2, 0, 1) : 0, n.s.t === 0 ? clamp((sz - .6) / .35, 0, 1) : clamp((sz - .5) / .4, 0, 1), t);
      } else {
        const sz = n.s.x;
        nf.fuse(1, 1, Math.abs(sz - 1) > 1e-3 ? `scale(${sz.toFixed(4)})` : '');
      }
    }
    const KD = 20;   // 水滴与菜单的融合半径
    const base = !bodyOn ? null : !sA ? sB : (x, y) => smin(sA(x, y), sB(x, y), k);
    const sdf = !drops.length ? base : (x, y) => { let d = base ? base(x, y) : Infinity; for (const f of drops) d = smin(d, f(x, y), KD); return d; };
    const anyGlass = bodyOn || drops.length > 0;
    // LiquidStretch（展开完成后按住才有）：绕本体中心
    const stx = ctl.stX.x, sty = ctl.stY.x, is = ctl.iscale.x;
    const rx = Math.abs(stx) / Math.max(W, 1), ry = Math.abs(sty) / Math.max(H, 1);
    const bx = 1 + rx, by = 1 + ry, corr = Math.sqrt((1 + Math.hypot(rx, ry) * .5) / (bx * by));
    const Sx = bx * corr * is, Sy = by * corr * is, Ox = bL + W / 2, Oy = bT + H / 2;
    const stretchAt = (ex, ey) => `translate(${(Ox - ex + stx).toFixed(3)}px, ${(Oy - ey + sty).toFixed(3)}px) scale(${Sx.toFixed(5)}, ${Sy.toFixed(5)}) translate(${(ex - Ox).toFixed(3)}px, ${(ey - Oy).toFixed(3)}px)`;
    const place = (n, x, y, w, h) => { const s = n.style; s.left = x + 'px'; s.top = y + 'px'; s.width = w + 'px'; s.height = h + 'px'; s.transform = stretchAt(x, y); };
    root.style.visibility = anyGlass ? '' : 'hidden';
    if (ctl.handedOff) barrierEl.style.visibility = 'visible';   // 交接后玻璃藏了，挡板照挡到收完
    shadowEl.style.visibility = clipEl.style.visibility = bodyOn ? '' : 'hidden';   // 交接后只剩滴回去的水滴
    // 玻璃
    if (ctl.morph) {
      const pad = 24 + k / 4;
      const x0 = Math.min(bL, sA ? ax - ahw : bL) - pad, y0 = Math.min(bT, sA ? ay - ahh : bT) - pad;
      const x1 = Math.max(bL + W, sA ? ax + ahw : 0) + pad, y1 = Math.max(bT + H, sA ? ay + ahh : 0) + pad;
      let box = [Math.floor(x0), Math.floor(y0), Math.ceil(x1 - Math.floor(x0)), Math.ceil(y1 - Math.floor(y0))];
      const E = ctl.ext;
      // 有邻近按钮融着就固定用外包范围（水滴在本体之外）
      if (E && (ctl.nb.length || (box[0] >= E[0] && box[1] >= E[1] && box[0] + box[2] <= E[0] + E[2] && box[1] + box[3] <= E[1] + E[3]))) box = E;
      else { box[2] = Math.ceil(box[2] / 24) * 24; box[3] = Math.ceil(box[3] / 24) * 24; }
      const key = box.join() + [W, H, R, k, ax, ay, aS].map((t) => t.toFixed(2)).join() + bodyOn + dkey.join();
      if (anyGlass && key !== ctl.lastKey) { ctl.lastKey = key; ctl.morph.frame(box, sdf, [Ox, Oy]); }
      place(glassEl, box[0], box[1], box[2], box[3]);
      // 内阴影、边缘高光只贴菜单本体：按钮残影消失、接近终态尺寸时才淡入（免得和液滴错位、省掉逐帧重画）
      const near = clamp((Math.min(W / ctl.W, H / ctl.H) - .85) / .15, 0, 1);
      ctl.morph.placeDecor(bL, bT, W, H, R, stretchAt, bodyOn ? (1 - aS) * (1 - aS) * near * near * (3 - 2 * near) : 0);
    } else {
      place(glassEl, bL, bT, W, H);
      glassEl.style.borderRadius = R + 'px';
    }
    placeShadow(bL, bT, W, H, R, stretchAt, 1);
    // 内容：锚在对齐角；0.25 起淡入、从 0.7 放大到 1（每行绕自己的中心）
    const cx0 = bL + (ctl.align.x > 0 ? W - ctl.W : 0), cy0 = bT + (ctl.align.y > 0 ? H - ctl.H : 0);
    const mounted = closing ? c > .85 : c > .25;
    const op = closing ? clamp((c - .85) / .15, 0, 1) : clamp((c - .25) / .45, 0, 1);
    const sc0 = lerp(.7, 1, flutterEaseOut(clamp((c - .25) / .75, 0, 1)));
    placeClip(bL, bT, W, H, R, stretchAt);
    const bs = bodyEl.style;
    bs.left = (cx0 - ctl.clipX).toFixed(2) + 'px'; bs.top = (cy0 - ctl.clipY).toFixed(2) + 'px'; bs.height = ctl.H + 'px';
    bs.visibility = mounted ? '' : 'hidden';
    bs.opacity = op.toFixed(4);
    bs.overflowY = ctl.tall && c > .98 && !closing ? 'auto' : 'hidden';
    for (let i = 0; i < rowEls.length; i++) {
      const n = rowEls[i]; if (!n) continue;
      const sc = ctl.dragging && sel === i ? sc0 * .98 : sc0;
      n.style.transform = sc > .9995 ? '' : `scale(${sc.toFixed(4)})`;
    }
    // 命中：展开到 0.8 之后菜单才接手势，0.3 之后点外面关；收起途中挡板一直挡着——
    // 点按钮本身收起时，抬手那下的 click 落在挡板上，不会又落回按钮把菜单重新打开
    clipEl.style.pointerEvents = c < .8 || closing ? 'none' : 'auto';
    barrierEl.style.pointerEvents = closing || c > .3 ? 'auto' : 'none';
    // 真按钮：展开前 20% 淡出；收起时隐藏到交接，交接后被「撞」一下
    const tb = trig(ctl.anchor);
    if (tb) {
      if (!closing) { tb.fade(1 - clamp(c / .2, 0, 1)); tb.impact(''); }
      else if (!ctl.handedOff) tb.fade(0);
      else { tb.fade(1); const pv = Math.min(raw, 0); tb.impact(`translate(${(fdx * pv).toFixed(3)}px, ${(fdy * pv).toFixed(3)}px) scale(${clamp(1 + pv * .35, .88, 1).toFixed(4)})`); }
    }
  }

  // —— 长按菜单逐帧：GlassContextMenu 动作盘（缩放 + 淡入淡出，形状不变）——
  function frameCtx() {
    const o = root.getBoundingClientRect(), closing = ctl.closing, t = ctl.ct;
    let a, s, dim;
    if (!closing) {
      const pt = clamp((t - .12) / .88, 0, 1);
      a = clamp(pt * 3, 0, 1); s = .4 + .6 * easeOutCubic(pt); dim = flutterEaseOut(clamp(t / .25, 0, 1));
    } else {
      const q = clamp(t / .25, 0, 1);
      a = 1 - q; s = 1 - .12 * q; dim = 1 - t;
    }
    if (reduceMotion()) s = 1;
    const W = ctl.W, H = ctl.H, R = M.r, bL = ctl.L - o.left, bT = ctl.T - o.top, Ox = bL + ctl.ox, Oy = bT + ctl.oy;
    const at = (ex, ey) => `translate(${(Ox - ex).toFixed(3)}px, ${(Oy - ey).toFixed(3)}px) scale(${s.toFixed(5)}) translate(${(ex - Ox).toFixed(3)}px, ${(ey - Oy).toFixed(3)}px)`;
    const place = (n, x, y, w, h) => { const st = n.style; st.left = x + 'px'; st.top = y + 'px'; st.width = w + 'px'; st.height = h + 'px'; st.transform = at(x, y); };
    root.style.visibility = '';
    barrierEl.style.background = `rgba(41, 41, 58, ${(.12 * dim).toFixed(4)})`;
    if (ctl.morph) {
      const box = [Math.floor(bL - 24), Math.floor(bT - 24), Math.ceil(W + 48), Math.ceil(H + 48)];
      const key = box.join() + 'c';
      if (key !== ctl.lastKey) { ctl.lastKey = key; ctl.morph.frame(box, sdfOf({ x: bL, y: bT, w: W, h: H, r: R }), [bL + W / 2, bT + H / 2]); }
      place(glassEl, box[0], box[1], box[2], box[3]);
      ctl.morph.placeDecor(bL, bT, W, H, R, at, a);
    } else {
      place(glassEl, bL, bT, W, H);
      glassEl.style.borderRadius = R + 'px';
    }
    glassEl.style.opacity = a >= .9999 ? '' : a.toFixed(4);
    placeShadow(bL, bT, W, H, R, at, a);
    placeClip(bL, bT, W, H, R, at);
    const bs = bodyEl.style;
    bs.left = '0px'; bs.top = '0px'; bs.height = H + 'px';
    bs.visibility = a > .002 ? '' : 'hidden';
    bs.opacity = a.toFixed(4);
    bs.overflowY = ctl.tall && t >= 1 && !closing ? 'auto' : 'hidden';
    for (const n of rowEls) if (n) n.style.transform = '';
    clipEl.style.pointerEvents = closing ? 'none' : 'auto';
    barrierEl.style.pointerEvents = 'auto';
  }

  // —— 按住滑选：按下即高亮手指下那一行，滑动换行，松手选中；按钮菜单按住时整块 LiquidStretch ——
  let press = null;
  const rowAt = (e) => {
    const br = bodyEl.getBoundingClientRect();
    const y = (e.clientY - br.top) * (bodyEl.offsetHeight / Math.max(1, br.height)) + bodyEl.scrollTop;
    if (e.clientX < br.left - 20 || e.clientX > br.right + 20) return -1;
    const list = view.items;
    for (let i = 0; i < rowEls.length; i++) {
      const n = rowEls[i]; if (!n) continue;
      if (y >= n.offsetTop && y < n.offsetTop + n.offsetHeight) return list[i] && !list[i].sep && !list[i].disabled ? i : -1;
    }
    return -1;
  };
  function setSel(i) { if (i === sel) return; if (i >= 0) haptic('tick'); sel = i; wake(ctl); }
  function pdown(e) {
    if (!shown || ctl.closing || (!ctl.ctx && ctl.v.x < .8) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, scroll: bodyEl.scrollTop };
    // 自定义内容里有自己的按钮：不抓指针（抓了 click 就落到容器上），只做 LiquidStretch
    if (!children && (e.pointerType !== 'touch' || !ctl.tall)) { try { clipEl.setPointerCapture(e.pointerId); } catch {} }
    ctl.dragging = true;
    if (!children) setSel(rowAt(e));
    if (!ctl.ctx) {
      ctl.iscale.t = 1.02;
      ctl.stX = durSpring(ctl.stX.x, .15, .15); ctl.stY = durSpring(ctl.stY.x, .15, .15);
    }
    wake(ctl);
  }
  function pmove(e) {
    if (!press || e.pointerId !== press.id) return;
    if (!children) setSel(rowAt(e));
    if (ctl.ctx) return;
    const dead = (m) => (Math.abs(m) <= 3 ? 0 : m * (1 - 3 / Math.abs(m)));
    const resist = (m) => Math.sign(m) * Math.abs(m) / (1 + Math.abs(m) * .08);
    let ox = resist(dead(e.clientX - press.x)), oy = resist(dead(e.clientY - press.y));
    ox = ctl.align.x < 0 ? Math.max(ox, 0) : Math.min(ox, 0);   // 只往远离锚点的方向拉
    oy = ctl.align.y < 0 ? Math.max(oy, 0) : Math.min(oy, 0);
    if (ctl.tall) oy = 0;
    ctl.stX.t = ox * .5; ctl.stY.t = oy * .5;
    wake(ctl);
  }
  function pup(e) {
    if (!press || e.pointerId !== press.id) return;
    const scrolled = Math.abs(bodyEl.scrollTop - press.scroll) > 4;
    press = null;
    ctl.dragging = false;
    if (!ctl.ctx) {
      ctl.iscale.t = 1;
      ctl.stX = durSpring(ctl.stX.x, .5, .45); ctl.stY = durSpring(ctl.stY.x, .5, .45);
      ctl.stX.t = ctl.stY.t = 0;
    }
    wake(ctl);
    const i = sel;
    if (e.type === 'pointerup' && i >= 0 && !scrolled) pick(i);
    else sel = -1;
  }
  // 长按菜单是按住时弹出来的（鼠标长按、壁纸长按）：那根手指 / 鼠标不松开直接滑进菜单也算滑选，松在哪行选哪行。
  // 只认弹出前就按着的那一根——弹出后新按下的都落在压暗层上、菜单随即收起；按钮菜单是松手后才展开的，用不上
  let carry = null, gliding = false;
  function wmove(e) {
    if (!shown || ctl.closing || press || children || !ctl.ctx) return;
    if (carry == null) { if (!e.buttons) return; carry = e.pointerId; }
    if (e.pointerId === carry) setSel(rowAt(e));
  }
  function wup(e) {
    if (carry == null || e.pointerId !== carry) return;
    carry = null;
    const i = sel;
    if (e.type === 'pointerup' && i >= 0) pick(i); else sel = -1;
  }
  function glide(on) {
    if (on === gliding) return;
    gliding = on; carry = null;
    const f = on ? addEventListener : removeEventListener;
    f('pointermove', wmove, true); f('pointerup', wup, true); f('pointercancel', wup, true);
  }
</script>

<div class="mm" class:dark class:liquid={LIQUID} bind:this={root} style="visibility:hidden">
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="mm-barrier" bind:this={barrierEl} onpointerdown={(e) => { e.preventDefault(); if (!ctl.closing) requestClose(); }} oncontextmenu={(e) => e.preventDefault()}></div>
  <div class="mm-shadow" bind:this={shadowEl} style:box-shadow={kitShadow ? cssShadow(kitShadow) : null}></div>
  <div class="mm-glass" bind:this={glassEl}></div>
  <div class="mm-clip" bind:this={clipEl} role="presentation" onpointerdown={pdown} onpointermove={pmove} onpointerup={pup} onpointercancel={pup}>
    <div class="mm-body" class:custom={!!children} bind:this={bodyEl} role={children ? 'dialog' : 'menu'} aria-label={view.title}>
      {#if children}
        {@render children()}
      {:else}
        {#if view.title}<div class="mm-title">{view.title}</div>{/if}
        {#each view.items as it, i (it.sep ? 'sep' + i : it.label + '\x1f' + i)}
          {#if it.sep}
            <div class="mm-sep" role="separator" bind:this={rowEls[i]}></div>
          {:else}
            <button type="button" role="menuitem" class="mm-it" class:danger={it.destructive} class:on={sel === i} disabled={it.disabled}
              bind:this={rowEls[i]} onclick={(e) => { if (e.detail === 0) pick(i); }}>
              <span class="mm-sym" style:color={it.tint || null}>{#if it.symbol}<Sym name={it.symbol} weight={400} size={17} />{:else if it.icon}{@html it.icon}{/if}</span>
              <span class="mm-lbl">{it.label}{#if it.detail}<small class="mm-detail">{it.detail}</small>{/if}</span>
              {#if it.checked}<span class="mm-check"><Sym name="checkmark" weight={600} size={15} /></span>{/if}
            </button>
          {/if}
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  /* 根节点不建层叠上下文：子元素各自带 z-index，平铺进外层容器的层叠上下文（玻璃要采得到底下的页面） */
  .mm { position: absolute; left: 0; top: 0; width: 0; height: 0; }
  .mm-barrier { position: fixed; inset: 0; z-index: 93; }
  .mm-shadow, .mm-glass, .mm-clip { position: absolute; left: 0; top: 0; transform-origin: 0 0; pointer-events: none; }
  .mm-shadow { z-index: 94; }
  .mm-glass { z-index: 95; }
  /* 退路（WebKit / Firefox）：CSS 毛玻璃，跟着本体的圆角矩形走 */
  .mm:not(.liquid) .mm-glass { background: rgba(250, 250, 250, .8); -webkit-backdrop-filter: blur(20px) saturate(1.7); backdrop-filter: blur(20px) saturate(1.7); }
  .mm.dark:not(.liquid) .mm-glass { background: rgba(32, 32, 32, .74); }
  .mm-clip { z-index: 97; overflow: hidden; touch-action: pan-y; }
  .mm-body { position: absolute; left: 0; top: 0; padding: 10px 0; box-sizing: border-box; color: #0c0c0e; overscroll-behavior: contain; scrollbar-width: none; user-select: none; -webkit-user-select: none; }
  .mm.dark .mm-body { color: #fff; }
  .mm-body.custom { padding: 0; color: var(--i-label, #0c0c0e); user-select: auto; -webkit-user-select: auto; }
  /* 标题、副标题不撑宽菜单（contain: inline-size）：长文件名标题按菜单宽折行，副标题（路径这类）超长省略；菜单宽只由行标签决定 */
  .mm-title { contain: inline-size; padding: 4px 24px 10px; font-size: 13px; line-height: 15px; font-weight: 500; letter-spacing: -.08px; color: #b1b1b3; overflow-wrap: anywhere; }
  .mm.dark .mm-title { color: #5a5a5a; }
  .mm-it {
    position: relative; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 10px 24px 10px 22px; box-sizing: border-box;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; white-space: nowrap; -webkit-tap-highlight-color: transparent;
  }
  /* 高亮（kit 没有菜单项按下态：借快捷操作按下底 Fills - Vibrant/Tertiary，左右内缩 10、圆角 20；
     LINEAR_BURN / DODGE 落在玻璃上的等效色） */
  .mm-it::before { content: ''; position: absolute; inset: 0 10px; border-radius: 20px; background: rgba(0, 0, 0, .075); opacity: 0; transition: opacity 120ms linear; pointer-events: none; }
  .mm.dark .mm-it::before { background: rgba(255, 255, 255, .085); }
  .mm-it.on::before { opacity: 1; transition: none; }
  .mm-it.danger { color: var(--i-red, #ff383c); }
  .mm-it:disabled { color: #b1b1b3; cursor: default; }
  .mm.dark .mm-it:disabled { color: #5a5a5a; }
  .mm-sym { width: 28px; flex: none; display: flex; justify-content: center; }
  .mm-sym :global(svg:not(.sym)) { width: 21px; height: 21px; }
  .mm-lbl { flex: 1; min-width: 0; font-size: 17px; line-height: 20px; letter-spacing: -.43px; }
  .mm-detail { contain: inline-size; display: block; margin-top: 1px; font-size: 15px; line-height: 18px; letter-spacing: -.23px; color: #8a8a8e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mm.dark .mm-detail { color: #98989d; }
  .mm-check { flex: none; display: flex; margin-left: 8px; }
  .mm-sep { height: 1px; margin: 6px 24px; background: #e3e3e5; }
  .mm.dark .mm-sep { background: #363638; }
  .mm-it:focus-visible { outline: none; }
  .mm-it:focus-visible::before { opacity: 1; }
</style>
