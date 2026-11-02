<script>
  // 记忆卡的「导图」视图：宽卡片的主形态。
  // 版式照 MindNode 一路：根是中间一颗胶囊，主枝左右两边分（按枝的高矮配平），字坐在枝线上、没有框；
  // 每条主枝一个颜色、整枝沿用，越往外线越细。展开 / 收起有过渡，被点的那一枝在屏幕上不跳。
  // 交互：点字 = 打开这篇（索引篇也一样）；点线末端的圆钮 = 展开 / 收起；小节标题（## 分组）点字也是展开 / 收起。
  // 悬停一篇：虚线连出和它有 [[双链]] / 链接关系的几篇，左下角出一张简介卡。
  // 视口：拖动平移、滚轮平移（Ctrl / ⌘ + 滚轮缩放）、双指捏合缩放；右下角缩放钮。
  import { untrack } from 'svelte';
  import { nodeLabel, nodeSub, typeLabel, pathText } from '../../lib/memoryTree.js';
  import { relTime } from '../../lib/format.js';
  import { t, tc } from '../../lib/i18n.js';

  let { graph, index, files, rootName = '', storeKey = '', onopen, current = '' } = $props();
  const label = (n) => nodeLabel(n, files, index, rootName);

  // —— 展开状态（按记忆目录记在本机）——
  // 默认：根，以及根下的小节（分组节点只是把索引的 ## 摆出来，收着等于藏掉一层）
  const LS = 'bridge.memory.open2:';
  let open = $state(new Set());
  let openFor = '';
  $effect(() => {
    if (!graph || openFor === storeKey) return;
    openFor = storeKey;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS + storeKey) || 'null'); } catch {}
    untrack(() => { open = Array.isArray(saved) ? new Set(saved) : defaultOpen(); fitted = false; });
  });
  function defaultOpen() {
    const s = new Set([index.rootId]);
    for (const c of graph.tree.children) if (c.kind === 'group') s.add(c.id);
    return s;
  }
  const save = () => { try { localStorage.setItem(LS + storeKey, JSON.stringify([...open])); } catch {} };
  const isOpen = (id) => id === index.rootId || open.has(id);

  // —— 量字宽（canvas measureText，和页面同一套字体）——
  let ctx2d = null;
  // 字体（Bridge Sans）没加载完时量出来的是回退字体的宽度：加载完再量一遍
  let fontTick = $state(0);
  $effect(() => { document.fonts?.ready?.then(() => { fontTick++; }); });
  function textW(s, size, weight) {
    if (!ctx2d) {
      ctx2d = document.createElement('canvas').getContext('2d');
    }
    const fam = getComputedStyle(document.body).fontFamily || 'sans-serif';
    ctx2d.font = `${weight} ${size}px ${fam}`;
    return Math.ceil(ctx2d.measureText(s).width * 1.03) + 1;
  }
  const MAXW = 230;
  const styleOf = (n, d) => n.kind === 'group' || n.kind === 'unindexed'
    ? { size: 12, weight: 600, h: 24, stroke: 1.4 }
    : d === 1 ? { size: 14, weight: 600, h: 30, stroke: 2.6 }
    : d === 2 ? { size: 13.5, weight: 500, h: 27, stroke: 1.8 }
    : { size: 13, weight: 400, h: 25, stroke: 1.3 };

  let stage = $state();
  let sw = $state(0), sh = $state(0);
  // 窄（手机竖屏 / 窄卡片）：主枝全往右长、根贴左边，字不缩到看不清，往右拖着读
  const narrow = $derived(sw > 0 && sw < 520);

  // —— 布局：根在原点，主枝左右分，每边一棵横向整齐树 ——
  const GAPX = 30, GAPY = 6, GAPY1 = 14;
  const layout = $derived.by(() => {
    fontTick;
    if (!graph) return { boxes: [], at: new Map(), bounds: null };
    const at = new Map();
    const rootN = graph.tree;
    const rootLabel = label(rootN);
    const rootW = Math.min(280, textW(rootLabel, 15, 600)) + 40, rootH = 42;
    // 先量每个可见节点的盒子与子树高度
    const meas = new Map();
    const measure = (n, d) => {
      const st = styleOf(n, d);
      const lab = label(n);
      const tw = Math.min(MAXW, textW(lab, st.size, st.weight));
      const kids = n.children.length && isOpen(n.id) ? n.children : [];
      const w = tw + 8 + (n.children.length ? 12 : 0);   // 有下级的线多伸出一截，末端坐圆钮
      let sub = 0;
      kids.forEach((c, i) => { sub += measure(c, d + 1) + (i ? (d === 0 ? GAPY1 : GAPY) : 0); });
      const block = Math.max(st.h, sub);
      meas.set(n.id, { st, lab, tw, w, block, kids });
      return block;
    };
    const top = rootN.children.length && isOpen(rootN.id) ? rootN.children : [];
    top.forEach((c) => measure(c, 1));
    // 左右配平：按顺序先放右边，右边超过一半就换左边（≤3 枝全放右边，左右各一两枝反而难看）
    const total = top.reduce((s, c) => s + meas.get(c.id).block + GAPY1, 0);
    const right = [], left = [];
    let acc = 0;
    for (const c of top) {
      if (narrow || top.length <= 3 || acc < total / 2) { right.push(c); acc += meas.get(c.id).block + GAPY1; }
      else left.push(c);
    }
    const boxes = [];
    const rootBox = { n: rootN, d: 0, x: -rootW / 2, y: -rootH / 2, w: rootW, h: rootH, side: 0, lab: rootLabel, hue: null, st: { stroke: 3 } };
    boxes.push(rootBox); at.set(rootN.id, rootBox);
    // side: 1 右（x 是盒子左缘，枝从左端接入）/ -1 左（x 是盒子右缘往左长）
    const place = (n, d, topY, parent, side) => {
      const m = meas.get(n.id);
      const y = topY + m.block / 2 - m.st.h / 2;
      const x = side > 0 ? parent.x + parent.w + (d === 1 ? GAPX + 14 : GAPX) : parent.x - (d === 1 ? GAPX + 14 : GAPX) - m.w;
      const box = { n, d, x, y, w: m.w, h: m.st.h, side, lab: m.lab, tw: m.tw, st: m.st, hue: index.info.get(n.id)?.hue ?? null, parent };
      boxes.push(box); at.set(n.id, box);
      let yy = topY + (m.block - kidsH(m)) / 2;
      for (const c of m.kids) { place(c, d + 1, yy, box, side); yy += meas.get(c.id).block + GAPY; }
    };
    const kidsH = (m) => m.kids.reduce((s, c, i) => s + meas.get(c.id).block + (i ? GAPY : 0), 0);
    const stack = (list, side) => {
      const h = list.reduce((s, c, i) => s + meas.get(c.id).block + (i ? GAPY1 : 0), 0);
      let y = -h / 2;
      for (const c of list) { place(c, 1, y, rootBox, side); y += meas.get(c.id).block + GAPY1; }
    };
    stack(right, 1); stack(left, -1);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const b of boxes) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h); }
    return { boxes, at, bounds: { x0, x1, y0, y1 } };
  });

  // 每个节点一条路：从父节点的接口弯过来，再沿着自己的字底下划过去（MindNode 的「字坐在线上」）
  function pathOf(b) {
    const p = b.parent;
    const ly = b.y + b.h;              // 字的底线
    let px, py;
    if (p.d === 0) { px = b.side > 0 ? p.x + p.w - 6 : p.x + 6; py = p.y + p.h / 2; }
    else { px = b.side > 0 ? p.x + p.w : p.x; py = p.y + p.h; }
    const cx = b.side > 0 ? b.x : b.x + b.w;
    const ex = b.side > 0 ? b.x + b.w : b.x;
    const mx = (px + cx) / 2;
    return `M${px} ${py}C${mx} ${py},${mx} ${ly},${cx} ${ly}L${ex} ${ly}`;
  }
  const colorOf = (hue) => (hue == null ? 'var(--mm-neutral)' : `oklch(var(--mm-l) var(--mm-c) ${hue})`);

  // —— 关联（悬停的那篇 / 正在预览的那篇）——
  let hover = $state('');
  const focus = $derived(hover || current);
  const related = $derived.by(() => {
    const out = { ids: new Set(), paths: [] };
    if (!focus) return out;
    const a = layout.at.get(index.byRef.get(focus));
    for (const l of graph.links) {
      const other = l.from === focus ? l.to : l.to === focus ? l.from : '';
      if (!other) continue;
      const b = layout.at.get(index.byRef.get(other));
      if (!b) continue;
      out.ids.add(b.n.id);
      if (!a) continue;
      const ax = a.x + a.w / 2, ay = a.y + a.h, bx = b.x + b.w / 2, by = b.y + b.h;
      const lift = Math.min(160, 40 + Math.hypot(ax - bx, ay - by) / 4);
      out.paths.push({ key: l.from + '>' + l.to, wiki: l.kind === 'wiki', d: `M${ax} ${ay}C${ax} ${ay + lift},${bx} ${by + lift},${bx} ${by}` });
    }
    return out;
  });
  const hoverBox = $derived(hover ? layout.at.get(index.byRef.get(hover)) : null);

  // —— 视口 ——
  let tx = $state(0), ty = $state(0), k = $state(1);
  let fitted = false;
  let anim = $state(false);   // 缩放钮 / 适应：视口平滑过渡；拖动 / 滚轮：跟手不过渡
  $effect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(() => { sw = stage.clientWidth; sh = stage.clientHeight; });
    ro.observe(stage);
    sw = stage.clientWidth; sh = stage.clientHeight;
    return () => ro.disconnect();
  });
  const PAD = 28;
  function fit(smooth = true) {
    const bd = layout.bounds;
    if (!bd || !sw || !sh) return;
    const w = bd.x1 - bd.x0, h = bd.y1 - bd.y0;
    const s = Math.max(narrow ? 0.82 : 0.55, Math.min(1, (sw - PAD * 2) / w, (sh - PAD * 2) / h));
    anim = smooth;
    k = s;
    // 放得下就整张居中；放不下：宽卡片让根横向居中（看得到两边主枝的开头），窄的让整张图贴左边
    const fitsW = w * s <= sw - PAD * 2;
    tx = fitsW ? sw / 2 - (bd.x0 + w / 2) * s : narrow ? PAD - bd.x0 * s : sw / 2;
    ty = sh / 2 - ((h * s <= sh - PAD * 2) ? (bd.y0 + h / 2) : 0) * s;
  }
  $effect(() => { if (!fitted && layout.boxes.length && sw && sh) { fitted = true; untrack(() => fit(false)); } });
  const clampK = (v) => Math.min(2, Math.max(0.3, v));
  function zoomAt(f, cx, cy, smooth = false) {
    const nk = clampK(k * f);
    anim = smooth;
    tx = cx - (cx - tx) * (nk / k);
    ty = cy - (cy - ty) * (nk / k);
    k = nk;
  }
  const zoomBtn = (f) => zoomAt(f, sw / 2, sh / 2, true);
  function onWheel(e) {
    e.preventDefault();
    anim = false;
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
    else {
      const mul = e.deltaMode === 1 ? 16 : 1;
      tx -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * mul;
      ty -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * mul;
    }
  }
  // 指针：单指 / 鼠标拖 = 平移（从节点上起拖也行，挪过 6px 就不算点击）；双指 = 捏合缩放
  const ptrs = new Map();
  let drag = null, pinch = null, swallow = false;
  let grabbing = $state(false);
  function onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest?.('.mp-zoom')) return;
    if (!ptrs.size) swallow = false;   // 新手势：清掉上一次拖动留下的「吞点击」（触屏拖完浏览器不补 click）
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
    else if (ptrs.size === 2) {
      const [p, q] = [...ptrs.values()];
      pinch = { d: Math.hypot(p.x - q.x, p.y - q.y) || 1, k };
      drag = null; swallow = true;
    }
  }
  function onMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size >= 2) {
      const [p, q] = [...ptrs.values()];
      const r = stage.getBoundingClientRect();
      zoomAt((pinch.k * (Math.hypot(p.x - q.x, p.y - q.y) || 1) / pinch.d) / k, (p.x + q.x) / 2 - r.left, (p.y + q.y) / 2 - r.top);
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    if (!drag.moved) { drag.moved = true; swallow = true; grabbing = true; hover = ''; try { stage.setPointerCapture(e.pointerId); } catch {} }
    anim = false;
    tx = drag.tx + dx; ty = drag.ty + dy;
  }
  function onUp(e) {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) { drag = null; grabbing = false; }
  }
  function onClickCapture(e) { if (swallow) { e.stopPropagation(); e.preventDefault(); } swallow = false; }

  // —— 节点动作 ——
  // 展开 / 收起后让被点的那一枝停在屏幕上原处（整棵树重排，它在世界坐标里会挪）
  function toggle(n) {
    const before = layout.at.get(n.id);
    const bx = before ? (before.side < 0 ? before.x + before.w : before.x) : 0, by = before?.y ?? 0;
    const s = new Set(open);
    if (isOpen(n.id) && n.id !== index.rootId) { s.delete(n.id); for (const id of descendants(n)) s.delete(id); }
    else s.add(n.id);
    open = s;
    save();
    if (before) queueMicrotask(() => {
      const a = layout.at.get(n.id);
      if (!a) return;
      anim = true;
      tx -= ((a.side < 0 ? a.x + a.w : a.x) - bx) * k;
      ty -= (a.y - by) * k;
    });
  }
  function descendants(n, out = []) { for (const c of n.children) { out.push(c.id); descendants(c, out); } return out; }
  export function setAll(on) {
    const s = defaultOpen();
    if (on) for (const id of index.info.keys()) s.add(id);
    open = s;
    save();
    queueMicrotask(() => fit(true));
  }
  export function refit() { fit(true); }
  function onNode(b) {
    const n = b.n;
    if (n.kind === 'file') onopen(n);
    else if (n.id !== index.rootId) toggle(n);
  }
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const pct = $derived(Math.round(k * 100));
</script>

<div class="mp" class:grabbing>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="mp-stage" bind:this={stage} data-sheet-nodrag
    style="background-position:{tx}px {ty}px;background-size:{22 * k}px {22 * k}px"
    onwheel={onWheel} onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp} onclickcapture={onClickCapture}>
    <div class="mp-world" class:anim style="transform: translate({tx}px, {ty}px) scale({k})">
      <svg class="mp-svg" aria-hidden="true">
        {#each layout.boxes as b (b.n.id)}
          {#if b.parent}
            <path class="mp-edge" class:rel={related.ids.has(b.n.id)} d={pathOf(b)} stroke={colorOf(b.hue)} stroke-width={b.st.stroke}
              class:faint={b.n.kind === 'group' || b.n.kind === 'unindexed'} />
          {/if}
        {/each}
        {#each related.paths as p (p.key)}<path class="mp-rel" class:wiki={p.wiki} d={p.d} />{/each}
      </svg>
      {#each layout.boxes as b (b.n.id)}
        {@const n = b.n}
        {@const m = n.kind === 'file' ? files[n.ref] : null}
        {@const kids = n.children.length}
        {#if b.d === 0}
          <button class="mp-root" style="left:{b.x}px;top:{b.y}px;width:{b.w}px;height:{b.h}px" title={n.kind === 'file' ? n.ref : ''}
            onclick={() => onNode(b)}>{b.lab}</button>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="mp-node d{Math.min(b.d, 3)} k-{n.kind}" class:left={b.side < 0} class:rel={related.ids.has(n.id)} class:cur={m && n.ref === current}
            class:hov={m && n.ref === hover}
            style="left:{b.x}px;top:{b.y}px;width:{b.w}px;height:{b.h}px;--c:{colorOf(b.hue)};font-size:{b.st.size}px;font-weight:{b.st.weight}"
            onpointerenter={() => { if (m && !grabbing && !coarse) hover = n.ref; }} onpointerleave={() => { if (hover === n.ref) hover = ''; }}>
            <button class="mp-lab" style="max-width:{b.tw + 8}px" onclick={() => onNode(b)}
              aria-expanded={kids && !m ? isOpen(n.id) : undefined}>{b.lab}{#if m?.dead.length}<span class="mp-dead"></span>{/if}</button>
            {#if kids}
              <button class="mp-knob" class:shut={!isOpen(n.id)} aria-label={isOpen(n.id) ? t('收起') : t('展开')} onclick={() => toggle(n)}>
                {#if isOpen(n.id)}<svg viewBox="0 0 12 12"><path d="M3 6h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>{:else}{index.info.get(n.id)?.count || kids}{/if}
              </button>

            {/if}
          </div>
        {/if}
      {/each}
    </div>

    {#if hoverBox && files[hover]}
      {@const m = files[hover]}
      <div class="mp-card" style="--c:{colorOf(hoverBox.hue)}">
        <div class="mp-card-path">{pathText(index, hoverBox.n.id, files, rootName) || rootName}</div>
        <div class="mp-card-t">{m.label}</div>
        {#if nodeSub(hoverBox.n, files)}<div class="mp-card-s">{nodeSub(hoverBox.n, files)}</div>{/if}
        <div class="mp-card-m">
          {#if m.type}<span class="tag">{typeLabel(m.type)}</span>{/if}
          <span>{relTime(m.mtime)}</span>
          {#if m.in}<span>· {tc('claude', '被链接 {n}', { n: m.in })}</span>{/if}
          {#if related.paths.length}<span>· {tc('claude', '关联 {n}', { n: related.paths.length })}</span>{/if}
          {#if m.dead.length}<span class="bad">· {tc('claude', '死链 {n}', { n: m.dead.length })}</span>{/if}
        </div>
      </div>
    {/if}

    <div class="mp-zoom" role="group" aria-label={tc('claude', '缩放')}>
      <button aria-label={tc('memory', '缩小')} title={tc('memory', '缩小')} onclick={() => zoomBtn(1 / 1.25)}><svg viewBox="0 0 24 24"><path d="M6 12h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      <button class="pct" title={t('适应窗口')} onclick={() => fit(true)}>{pct}%</button>
      <button aria-label={tc('memory', '放大')} title={tc('memory', '放大')} onclick={() => zoomBtn(1.25)}><svg viewBox="0 0 24 24"><path d="M6 12h12M12 6v12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
    </div>
  </div>
</div>

<style>
  .mp { position: relative; flex: 1; min-height: 0; display: flex; }
  .mp-stage { position: relative; flex: 1; min-width: 0; overflow: hidden; touch-action: none; cursor: grab;
    background-image: radial-gradient(circle, color-mix(in srgb, var(--text) 9%, transparent) 1px, transparent 1.2px); }
  .mp.grabbing .mp-stage { cursor: grabbing; }
  .mp-world { position: absolute; left: 0; top: 0; transform-origin: 0 0; will-change: transform; }
  .mp-world.anim { transition: transform .32s cubic-bezier(.22, .8, .25, 1); }
  .mp-svg { position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible; pointer-events: none; }
  .mp-edge { fill: none; stroke-linecap: round; transition: d .32s cubic-bezier(.22, .8, .25, 1), opacity .2s; animation: mpIn .32s ease both; }
  .mp-edge.faint { opacity: .55; }
  .mp-rel { fill: none; stroke: var(--text); stroke-width: 1.2; opacity: .45; stroke-dasharray: 3 4; }
  .mp-rel:not(.wiki) { stroke-dasharray: none; opacity: .3; }
  @keyframes mpIn { from { opacity: 0; } }

  .mp-root { position: absolute; display: flex; align-items: center; justify-content: center; padding: 0 18px; border-radius: 999px;
    font-size: 15px; font-weight: 600; color: var(--bg); background: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: 0 6px 20px rgba(0, 0, 0, .18); transition: left .32s cubic-bezier(.22, .8, .25, 1), top .32s cubic-bezier(.22, .8, .25, 1); }
  .mp-root:active { transform: scale(.98); }

  .mp-node { position: absolute; display: flex; align-items: flex-end; gap: 2px; padding-bottom: 3px; color: var(--text);
    transition: left .32s cubic-bezier(.22, .8, .25, 1), top .32s cubic-bezier(.22, .8, .25, 1), opacity .2s; animation: mpIn .32s ease both; }
  .mp-node.left { flex-direction: row-reverse; }
  .mp-node.left .mp-knob { right: auto; left: -9px; }
  .mp-node.d3 { color: var(--serif); }
  .mp-node.k-group, .mp-node.k-unindexed { color: var(--muted); letter-spacing: .03em; }
  .mp-lab { flex: none; min-width: 0; padding: 0 4px; font: inherit; color: inherit; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.25; border-radius: 6px; }
  .mp-node.left .mp-lab { text-align: right; }
  @media (hover: hover) { .mp-lab:hover { color: var(--c); } }
  .mp-node.hov .mp-lab, .mp-node.cur .mp-lab { color: var(--c); }
  .mp-node.rel .mp-lab { background: color-mix(in srgb, var(--c) 14%, transparent); }
  .mp-node.cur .mp-lab { background: color-mix(in srgb, var(--c) 18%, transparent); }
  .mp-dead { display: inline-block; width: 6px; height: 6px; margin-left: 5px; border-radius: 50%; background: var(--crit); vertical-align: middle; }
  /* 末端圆钮：收着时实心带篇数，开着时空心一道横（悬停才显） */
  .mp-knob { position: absolute; bottom: -9px; right: -9px; min-width: 18px; height: 18px; padding: 0 4px; border-radius: 9px;
    font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 18px; color: var(--c);
    background: var(--bg); box-shadow: inset 0 0 0 1.4px var(--c); display: flex; align-items: center; justify-content: center; z-index: 1; }
  .mp-knob svg { width: 10px; height: 10px; }
  .mp-knob::after { content: ''; position: absolute; inset: -7px; border-radius: 50%; }
  .mp-knob.shut { color: var(--bg); background: var(--c); box-shadow: none; }
  .mp-knob:not(.shut) { opacity: 0; transition: opacity .15s; }
  .mp-node:hover .mp-knob:not(.shut), .mp-knob:focus-visible { opacity: 1; }
  @media (pointer: coarse) { .mp-knob:not(.shut) { opacity: .8; } }

  .mp-card { position: absolute; left: 12px; bottom: 12px; width: min(320px, calc(100% - 140px)); padding: 11px 13px 10px; border-radius: 12px;
    background: var(--q-card); box-shadow: 0 8px 26px rgba(0, 0, 0, .2), inset 3px 0 0 var(--c); pointer-events: none; animation: mpCard .14s ease; }
  @keyframes mpCard { from { opacity: 0; transform: translateY(4px); } }
  .mp-card-path { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mp-card-t { margin-top: 2px; font-size: 14px; font-weight: 600; color: var(--text); }
  .mp-card-s { margin-top: 3px; font-size: 12.5px; line-height: 1.5; color: var(--serif); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .mp-card-m { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 7px; font-size: 11.5px; color: var(--muted); }
  .mp-card-m .tag { color: var(--c); padding: 1px 6px; border-radius: 5px; background: color-mix(in srgb, var(--c) 14%, transparent); }
  .mp-card-m .bad { color: var(--crit); }

  .mp-zoom { position: absolute; right: 12px; bottom: 12px; display: flex; align-items: center; padding: 3px; border-radius: 11px;
    background: var(--q-card); box-shadow: 0 4px 16px rgba(0, 0, 0, .16), inset 0 0 0 1px var(--divider); }
  .mp-zoom button { height: 28px; min-width: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--serif); }
  .mp-zoom button svg { width: 16px; height: 16px; }
  .mp-zoom .pct { min-width: 46px; font-size: 12px; font-variant-numeric: tabular-nums; }
  .mp-zoom button:active { background: var(--hover-strong); }
  @media (hover: hover) { .mp-zoom button:hover { background: var(--hover); color: var(--text); } }
  @media (pointer: coarse) { .mp-zoom button { height: 34px; min-width: 34px; } }
</style>
