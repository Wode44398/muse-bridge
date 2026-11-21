<script>
  // 侧边工作区的统一外壳：Claude / Codex / Antigravity / dimensio 四个分页共用这一份。
  // 各分页只交三样东西——宿主状态（lib/dock/host.svelte.js）、工具表（lib/dock/tools.js 的共用工具 + 自己的专属卡）、
  // 一套配色令牌（skin）；卡片怎么摆、怎么拖、怎么放大、手机上长什么样，全在这里。
  //
  // 侧列（wide）= 一叠圆角卡片：一颗开关管一张卡，开几张摆几张。够宽且两列都有卡时摆两列，否则全叠一列；
  //   卡片标题行是拖拽把手（排顺序、换列，宿主支持时拖出 app 成独立窗口），双击或点放大钮铺满；
  //   卡与卡之间的缝可以拖，调上下两张的高度比；左缘把手调整个工作区的宽度。
  //   宿主不许多卡时（分屏格 / 独立窗口 / 折叠屏）一次只放一张，开关就是切换。
  // 手机两种形态（mobile）：'sheet' = 底部抽屉（把手下拉 / 点遮罩可关）+ 工具直切条；
  //   'page' = 整屏页（左上返回 + 自适应标签）。一次一张。
  //
  // 卡片为什么绝对定位、按比例摆、平铺一个 keyed each：列数变化、换位、换列时卡片不换父节点、不重挂——
  // 终端和浏览器的连接、滚回缓冲都留着。
  // 拖动走指针事件 + 指针捕获而不是 HTML5 拖拽：卡片要真跟手、别的卡实时让位；捕获后拖进 iframe 也收得到松手，
  // 指针出了视口仍收得到 move / up（坐标落在视口外），据此判「拖出 app」。
  // 桌面壳的原生浏览器视图按量出来的矩形落座、恒盖在 DOM 之上：卡片在位移动画里时它跟不住，
  // 所以拖动与排布滑动期间让它整个让位，落定再按新矩形重挂。
  import { untrack, tick } from 'svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { layout, pointer } from '../../lib/layout.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { dragSheet } from '../../lib/dockTouch.js';
  import { dockIcon } from '../../lib/dockIcons.js';
  import { preview, closePreview } from '../../lib/preview.svelte.js';
  import { pushNativeOverlay } from '../../lib/nativeDesktop.js';
  import { dropToast } from '../../lib/dragdrop.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { GAP, columns, slots, boxCss, emptyColCss, dividers, resizePair, sameCols, target as dropTarget, weightOf } from '../../lib/dock/cards.js';
  import { toolForKey } from '../../lib/dock/tools.js';
  import { tabMode } from '../../lib/dock/tabs.js';
  import SharedPanel from './SharedPanel.svelte';
  import './workbench-skins.css';

  // host   = 宿主状态与动作（createDockHost 的产物，或同形状的适配对象）
  // tools  = 此刻可用的工具（已过门禁），[{ key, label, closeLabel, icon, kbd, match, own, fixed, live, hot, badge }]
  //          own = 内容由宿主的 panel 片段给；fixed = 不进拖动排序、固定挂在第二列末尾
  //          live = 开关上的提示点（有动静而没在看）；lamp = 状态灯（看着也亮）；hot = 卡片标题行上的在跑点；badge = 计数
  // wide   = 以侧列形态摆（false = 手机）；overlay = 侧列盖在正文上而不是挤开它（分屏的窄格）
  // multi  = 允许几张卡同时开；card = 卡片窗口（整扇窗只放这一张，没有开关 / 多卡 / 拖排）
  // sizing = 'self' 外壳自己管宽度（左缘把手 + 本机记忆）；'host' = 宿主管，外壳铺满容器并用 two 回报此刻是不是两列
  // reserve = 这一行里必须留给别人的宽度（对话下限 + 侧栏）；null = 按比例钳
  // filesFloat = 文件卡的标题行浮在工作空间页上：'touch' 只在触屏那套文件页时浮，'always' 恒浮
  // band / panel / icon / empty = 宿主片段：顶带、专属卡内容、工具图标、没有工作空间时的空态
  // popOut = { url(view), key(view) }：给了就能把卡拖出 app 成独立窗口；onCardBack = 卡片窗口的「放回工作台」
  // keysOn = 桌面快捷键此刻归这个工作区（人在这一页上）；backLayer = 登记返回键 / 侧滑先收工作区的那一层
  // onShown(keys) = 此刻摆出来的是哪几张（宿主拿去上报给 agent）
  let {
    host, tools = [], wide = false, overlay = false, multi = false, card = '',
    skin = 'claude', mobile = 'sheet', sizing = 'self', twoOk = null, two = $bindable(false),
    reserve = null, widthKey = '', twoColHost = 1020, filesFloat = 'touch',
    snap = false, theme = '', label = t('工作台'),
    band = null, panel = null, icon = null, empty = null,
    popOut = null, onCardBack = null, keysOn = true, backLayer = pushBackLayer, onShown = null,
  } = $props();

  const st = $derived(host.state);
  const mid = $derived(layout.medium);
  const keys = $derived(tools.map((x) => x.key));
  const toolOf = (k) => tools.find((x) => x.key === k);
  const fixedKeys = $derived(tools.filter((x) => x.fixed).map((x) => x.key));

  $effect(() => { const on = wide && multi; untrack(() => host.setMulti(on)); });
  // 门禁藏掉的工具（没有命令行的身份没有终端 / 浏览器、插件撤掉了它的卡）：开着的那张跟着收掉
  $effect(() => { const ok = keys; if (st.open && !card) untrack(() => host.prune(ok)); });

  // 手机一次只看一张：最近那张被门禁藏掉就回落宿主的默认卡，再回落第一张
  const mView = $derived(keys.includes(st.view) ? st.view : keys.includes(host.initialView) ? host.initialView : keys[0] || '');
  // 此刻真正摆出来的卡：卡片窗口 = 那一张；侧列 = 开着的全部；手机 = 选中的那一张
  const shown = $derived(card ? [card] : !st.open ? [] : wide ? st.views.filter((k) => keys.includes(k)) : mView ? [mView] : []);
  $effect(() => { if (shown.includes('term') && st.termLive) st.termLive = false; });
  $effect(() => { const list = shown; untrack(() => onShown?.(list)); });

  // meta 由宿主统一拉（工具开关在工作区没展开时可能已经拉过，这里直接复用）
  $effect(() => { if (st.open && st.ws && !st.meta) host.ensureMeta(); });

  // —— 卡片排布 ——
  let hostW = $state(0);
  // 拖动中：{ v, start, cols, n, n0, split, out, tx, ty, w, h }——cols / n 是此刻按指针算出的预览排布（松手才落盘）
  let sort = $state(null);
  const baseCols = $derived(sort ? sort.cols : host.cols);
  // 不进排序的卡（插件页要宽）和宿主刚冒出来、还没进过排序的卡，都挂在第二列末尾
  const cols = $derived.by(() => {
    const c = baseCols;
    const loose = keys.filter((k) => !fixedKeys.includes(k) && !c.a.includes(k) && !c.b.includes(k));
    return { a: c.a, b: [...c.b, ...loose, ...fixedKeys] };
  });
  // 拖出窗口外那一刻起，这张卡就不占格子了（别的卡合拢补位，像把标签页拖出标签栏）
  const inGrid = $derived(shown.filter((v) => !(sort && sort.out && sort.v === v)));
  const canTwo = $derived(sizing === 'host' ? !!twoOk : wide && hostW >= twoColHost && !overlay);
  const split = $derived(columns(cols, inGrid, true));
  // 拖动中列数由预览定（拖空的那一列留作落点，不当场塌成一列，免得工作区宽度在指针底下跳）
  const twoNow = $derived(!wide || card ? false : sort ? sort.n === 2 : canTwo && split[0].length > 0 && split[1].length > 0);
  $effect(() => { two = twoNow; });
  const maxed = $derived(wide && st.max && shown.includes(st.max) ? st.max : '');
  const list = $derived(columns(cols, inGrid, twoNow));
  const at = $derived(slots(list, host.weights.w));
  const FULL = 'left:0;top:0;width:100%;height:100%';
  const cards = $derived.by(() => {
    // 渲染顺序固定（keyed each 不因列数 / 排序变化而重排出新节点）
    const torn = sort && sort.out ? sort.v : '';
    return keys.filter((v) => at[v] || v === torn).map((v) => {
      let box = v === torn ? `left:0;top:0;width:${sort.w}px;height:${sort.h}px` : maxed ? (maxed === v ? FULL : '') : boxCss(at[v]);
      if (sort && sort.v === v && box) box += `;transform:translate(${sort.tx}px,${sort.ty}px)`;
      return { v, box, tool: toolOf(v) };
    });
  });
  // 拖着那张卡的落点（虚线框）= 它在预览排布里的格子；拖空了的那一列也描一圈，告诉你还能放回去
  const slotBox = $derived(sort && !sort.out && !maxed && at[sort.v] ? boxCss(at[sort.v]) : '');
  const emptyBox = $derived(sort && !sort.out && !maxed && twoNow ? emptyColCss(list) : '');
  const seams = $derived(sort || maxed || !wide || card ? [] : dividers(list, at));

  // —— 宽度：左缘把手（px 持久化；CSS min / max 兜底钳制）。一列、两列各记各的：两列时默认更宽，
  // 拖出来的宽度也不该回灌给一列。——
  const W_LS = $derived(widthKey || `bridge-${host.id}-dock-w`);
  const readW = (k, lo) => { try { const n = +localStorage.getItem(k); return n >= lo ? n : null; } catch { return null; } };
  let dockW = $state(untrack(() => readW(W_LS, 300)));
  let dockW2 = $state(untrack(() => readW(W_LS + '2', 560)));
  const curW = $derived(sizing !== 'self' || maxed ? null : (twoNow ? dockW2 : dockW));
  let dockEl = $state();
  let gripping = $state(false);
  // 这一栏所在的那一行：宿主可能在外面包了只为拿 DOM 的无盒容器（display: contents），量宽度要跳过它
  function hostBox() {
    let el = dockEl?.parentElement || null;
    try { while (el && getComputedStyle(el).display === 'contents') el = el.parentElement; } catch {}
    return el;
  }
  $effect(() => {
    const el = dockEl && hostBox();
    if (!el) return;
    const read = () => { hostW = el.clientWidth; };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  });
  function gripDown(e) {
    if (!wide || !dockEl || maxed) return;
    e.preventDefault();
    const rightEdge = dockEl.getBoundingClientRect().right;
    const isTwo = twoNow;
    // 指针捕获：拖进卡片里的 iframe（文件卡的 HTML 预览）时，pointermove / pointerup 会被那份文档吞掉，
    // 本页收不到松手，宽度就一直黏在指针上。捕获后事件恒发给把手；.gripping 期间 iframe 再关掉命中兜一层。
    const grip = e.currentTarget, pid = e.pointerId;
    try { grip.setPointerCapture(pid); } catch {}
    gripping = true;
    document.body.style.userSelect = 'none';
    const move = (ev) => {
      // 上限按【宿主容器】宽度算：分屏时工作区只属于那一格，别拿整窗宽度去钳。
      // medium（折叠屏展开）横向本就紧张：下限放到 300、给正文留 300。
      const hW = hostBox()?.clientWidth || window.innerWidth;
      const lo = isTwo ? 560 : mid && !overlay ? 300 : 360;
      const hi = overlay ? Math.max(lo, hW - 48)
        : reserve != null ? Math.max(lo, hW - reserve)
        : mid ? Math.max(lo, hW - 300) : isTwo ? Math.max(lo, hW - 360) : hW * 0.78;
      const w = Math.round(Math.min(Math.max(rightEdge - ev.clientX, lo), hi));
      if (isTwo) dockW2 = w; else dockW = w;
    };
    const up = () => {
      if (!gripping) return;
      gripping = false;
      document.body.style.userSelect = '';
      try { grip.releasePointerCapture(pid); } catch {}
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      grip.removeEventListener('lostpointercapture', up);
      try {
        if (isTwo && dockW2) localStorage.setItem(W_LS + '2', String(dockW2));
        if (!isTwo && dockW) localStorage.setItem(W_LS, String(dockW));
      } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    grip.addEventListener('lostpointercapture', up);
  }
  // 双击把手 = 恢复默认宽度
  function gripReset() {
    if (twoNow) { dockW2 = null; try { localStorage.removeItem(W_LS + '2'); } catch {} }
    else { dockW = null; try { localStorage.removeItem(W_LS); } catch {} }
  }

  // —— 卡片元素表、FLIP ——
  let cardsEl = $state();
  const cardEls = {};
  const ringEls = {};
  const refInto = (map) => (node, v) => {
    map[v] = node;
    return { destroy() { if (map[v] === node) delete map[v]; } };
  };
  const cardRef = refInto(cardEls);
  const ringRef = refInto(ringEls);
  function rects(skip) {
    const m = {};
    for (const k in cardEls) if (k !== skip && cardEls[k].offsetParent) m[k] = cardEls[k].getBoundingClientRect();
    return m;
  }
  // 排布一变，各卡从刚才的视觉位置滑到新格子（只动 transform；尺寸当场换——拉伸动画会让终端 /
  // 浏览器跟着逐帧重排）。before 量的是含进行中动画的视觉位置，连续换位也接得上不跳。
  const FLIP_MS = 260;
  function flip(before) {
    const moved = [];
    for (const k in before) {
      const el = cardEls[k];
      if (!el) continue;
      for (const a of el.getAnimations?.() || []) if (a.id === 'wbflip') a.cancel();
      const b = el.getBoundingClientRect(), o = before[k];
      const dx = o.left - b.left, dy = o.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      try {
        const an = el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' }],
          { duration: FLIP_MS, easing: 'cubic-bezier(.2,.8,.2,1)' });
        an.id = 'wbflip';
        moved.push(k);
      } catch {}
    }
    return moved;
  }
  // 原生浏览器视图让位：拖动期间按住；滑动落定后放回（它会按卡片的新矩形重挂）
  let releaseNative = null;
  let nativeTimer = 0;
  function holdNative() {
    clearTimeout(nativeTimer);
    if (!releaseNative && shown.includes('browser')) releaseNative = pushNativeOverlay();
  }
  function freeNative(after = 0) {
    clearTimeout(nativeTimer);
    if (!releaseNative) return;
    nativeTimer = setTimeout(() => { releaseNative?.(); releaseNative = null; }, after);
  }
  $effect(() => () => { clearTimeout(nativeTimer); releaseNative?.(); releaseNative = null; });

  // 拖动以外的排布变化（开 / 关一张、列数变化、放大还原）：DOM 更新前量一次，更新后滑过去
  const layoutKey = $derived(cards.map((c) => `${c.v}:${c.box}`).join('|'));
  let pre = null;
  $effect.pre(() => {
    void layoutKey;
    if (!wide || card || sort) return;
    untrack(() => { pre = cardsEl ? rects() : null; });
  });
  $effect(() => {
    void layoutKey;
    if (!wide || card || sort) return;
    untrack(() => {
      const p = pre;
      pre = null;
      if (!p) return;
      if (flip(p).includes('browser')) { holdNative(); freeNative(FLIP_MS + 40); }
    });
  });

  // 被点名的卡已经开着：描一圈、退掉
  $effect(() => {
    const f = st.focus;
    if (!f || !wide) return;
    untrack(() => {
      try { ringEls[f.view]?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], { duration: 900, easing: 'ease-out' }); } catch {}
    });
  });

  // —— 拖卡片标题行：排顺序 / 换列 / 拖出 app 成独立的卡片窗口 ——
  let press = null;   // 按下了标题行：{ v, x, y, pid, head, pop, fx, gy, px, py, bandAt, bandT, dead }；sort 非空 = 过了门槛、真在拖
  const bdOf = () => { try { return window.BridgeDesktop || (window.parent !== window && window.parent.BridgeDesktop) || null; } catch { return null; } };
  // 这一下能不能拖成窗口：桌面壳走 openChat IPC（'old' = 老壳没有，松手提示更新）；网页走弹窗；
  // 壳里没挂 preload 的窗口（拖出来的对话窗）window.open 会被转给系统浏览器、那边没有登录态——不给拖。
  function popMode() {
    if (!popOut || card || snap || !wide) return '';
    const bd = bdOf();
    if (bd) return bd.window?.openChat ? 'shell' : 'old';
    return /\bElectron\//.test(navigator.userAgent) ? '' : 'web';
  }
  // 指针出没出 app：分屏那一格是 iframe，按顶层窗口的视口算（拖出这一格进了旁边那格不算）
  function outsideApp(x, y) {
    let ox = 0, oy = 0, W = window.innerWidth, H = window.innerHeight;
    try {
      if (window.frameElement && window.top !== window) {
        const r = window.frameElement.getBoundingClientRect();
        ox = r.left; oy = r.top; W = window.top.innerWidth; H = window.top.innerHeight;
      }
    } catch {}
    const X = x + ox, Y = y + oy;
    return X < 0 || Y < 0 || X >= W || Y >= H;
  }
  // 一列时拖进右侧那一带要停一会儿才拆成两列：工作区贴着窗口右缘，往右拖出窗口必经这一带，
  // 一划而过不该让工作区先变宽再缩回去
  const SPLIT_DWELL = 240;
  const sortable = (v) => !toolOf(v)?.fixed;
  // 拖着的卡钉在指针底下：横向保持按下时的相对位置（换列后卡片宽度变了也不跑偏），纵向保持抓住的那一点
  function follow() {
    const el = sort && cardEls[sort.v];
    if (!el || !cardsEl || !press) return;
    const cr = cardsEl.getBoundingClientRect();
    let wantL = press.px - press.fx * el.offsetWidth, wantT = press.py - press.gy;
    // 拖出窗口时卡片在窗口边上留一截（指针已经在外面了，不留的话 app 里看不出手上还拎着它）
    if (sort.out) {
      const keep = 56;
      wantL = Math.min(Math.max(wantL, keep - el.offsetWidth), window.innerWidth - keep);
      wantT = Math.min(Math.max(wantT, keep - el.offsetHeight), window.innerHeight - keep);
    }
    sort.tx = Math.round(wantL - (cr.left + el.offsetLeft));
    sort.ty = Math.round(wantT - (cr.top + el.offsetTop));
  }
  function headDown(e, v) {
    if (!wide || card || e.button !== 0 || e.target.closest?.('button') || !sortable(v)) return;
    press = { v, x: e.clientX, y: e.clientY, pid: e.pointerId, head: e.currentTarget, pop: e.pointerType === 'mouse' ? popMode() : '', bandAt: 0, bandT: 0 };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }
  function beginSort() {
    const el = cardEls[press.v];
    // 一张卡、又拖不出窗口（或放大铺满时）：没什么可排的，按普通按下处理
    if (!el || (!press.pop && (maxed || shown.length < 2))) { press.dead = true; return; }
    const r = el.getBoundingClientRect();
    press.fx = (press.x - r.left) / (r.width || 1);
    press.gy = press.y - r.top;
    const start = { a: [...host.cols.a], b: [...host.cols.b] };
    const n0 = twoNow ? 2 : 1;
    sort = { v: press.v, start, cols: start, n: n0, n0, split: false, out: false, tx: 0, ty: 0, w: el.offsetWidth, h: el.offsetHeight };
    document.body.style.userSelect = 'none';
    holdNative();
  }
  async function headMove(e) {
    const p = press;
    if (!p || p.dead || e.pointerId !== p.pid) return;
    if (!sort) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return;
      beginSort();
      if (!sort) return;
    }
    p.px = e.clientX; p.py = e.clientY;
    const s = sort;
    const out = !!p.pop && outsideApp(e.clientX, e.clientY);
    let next;
    if (out) {
      // 拖出去了：排布回到起手（不带刚才的换位），这张让出格子；剩下的卡两列都还有才保持两列
      const stc = s.start, v = s.v;
      const hasA = stc.a.some((k) => k !== v && shown.includes(k)), hasB = stc.b.some((k) => k !== v && shown.includes(k));
      next = { n: canTwo && hasA && hasB ? 2 : 1, split: false, cols: stc };
      p.bandAt = 0; clearTimeout(p.bandT);
    } else if (!maxed) {
      const r = cardsEl.getBoundingClientRect();
      const fx = (e.clientX - r.left) / (r.width || 1), fy = (e.clientY - r.top) / (r.height || 1);
      const o = { start: s.start, v: s.v, n0: s.n0, split: s.split, canTwo, shown };
      next = dropTarget(o, fx, fy);
      if (next.split && !s.split) {
        // 刚进拆列带：先按不拆算，停够了（指针不动也算——定时器补一次）再拆
        if (!p.bandAt) {
          p.bandAt = performance.now();
          clearTimeout(p.bandT);
          p.bandT = setTimeout(() => { if (press === p && sort) headMove({ pointerId: p.pid, clientX: p.px, clientY: p.py }); }, SPLIT_DWELL + 10);
        }
        if (performance.now() - p.bandAt < SPLIT_DWELL) next = dropTarget(o, fx, fy, false);
      } else if (!next.split) { p.bandAt = 0; clearTimeout(p.bandT); }
    } else next = { n: s.n, split: s.split, cols: s.cols };
    if (out !== s.out || next.n !== s.n || !sameCols(next.cols, s.cols)) {
      if (out && !s.out) { const el = cardEls[s.v]; if (el) { s.w = el.offsetWidth; s.h = el.offsetHeight; } }
      const before = rects(s.v);
      s.out = out; s.n = next.n; s.split = next.split; s.cols = next.cols;
      await tick();
      if (sort !== s) return;
      flip(before);
    }
    follow();
  }
  function endPress() {
    const p = press;
    press = null;
    if (!p) return null;
    clearTimeout(p.bandT);
    try { p.head.releasePointerCapture(p.pid); } catch {}
    return p;
  }
  function settle(before) {
    document.body.style.userSelect = '';
    sort = null;
    tick().then(() => { flip(before); freeNative(FLIP_MS + 40); });
  }
  function headUp(e) {
    if (!press || e.pointerId !== press.pid) return;
    const p = endPress();
    const s = sort;
    if (!s) return;   // 没过门槛 = 普通点击
    if (s.out) { document.body.style.userSelect = ''; sort = null; freeNative(); tearOut(s.v, e, p, s); return; }
    // 落位：记下各卡（含拖着那张）此刻的视觉位置，落盘后一起滑进格子
    const before = rects();
    if (!sameCols(s.cols, s.start)) {
      const colOf = (c) => (c.a.includes(s.v) ? 'a' : 'b');
      // 换了列：它原先的高度比例是给那一列配的，回到等分
      if (colOf(s.cols) !== colOf(s.start) && host.weights.w[s.v] != null) {
        const w = { ...host.weights.w };
        delete w[s.v];
        host.setWeights(w);
      }
      host.setCols(s.cols);
    }
    settle(before);
  }
  // 取消（pointercancel / 丢了捕获 / Esc）：原样复原
  function headCancel(e) {
    if (!press || (e && e.pointerId != null && e.pointerId !== press.pid)) return;
    endPress();
    if (!sort) return;
    settle(rects());
  }
  $effect(() => {
    if (!sort) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); headCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // 双击标题行 = 放大 / 还原（同窗口标题栏的习惯）
  function headDbl(e, v) {
    if (card || !wide || e.target.closest?.('button')) return;
    host.toggleMax(v);
  }

  // —— 卡与卡之间的缝：拖了调上下两张的高度比，双击这一列回到等分 ——
  const MIN_CARD_H = 120;
  let resizing = $state('');
  function seamDown(e, d) {
    if (e.button !== 0 || !cardsEl) return;
    e.preventDefault();
    const el = e.currentTarget;
    const col = list.find((c) => c.includes(d.up));
    if (!col) return;
    const w0 = { ...host.weights.w };
    const total = col.reduce((s, v) => s + weightOf(w0, v), 0);
    const avail = cardsEl.clientHeight - GAP * (col.length - 1);
    const wu = weightOf(w0, d.up), wd = weightOf(w0, d.down);
    const y0 = e.clientY, pid = e.pointerId;
    try { el.setPointerCapture(pid); } catch {}
    resizing = d.key;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const [u, dn] = resizePair(wu, wd, total, avail, ev.clientY - y0, MIN_CARD_H);
      host.setWeights({ ...w0, [d.up]: u, [d.down]: dn }, { live: true });
    };
    const up = () => {
      if (!resizing) return;
      resizing = '';
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      host.setWeights(host.weights.w);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
  function seamReset(d) {
    const col = list.find((c) => c.includes(d.up)) || [];
    const w = { ...host.weights.w };
    for (const v of col) delete w[v];
    host.setWeights(w);
  }

  // —— 拖出窗口：一扇只放这张卡的窗口（像把浏览器标签页拖出来）——
  // 桌面壳：主窗口的 window.open 一律交给系统浏览器，走壳的 openChat IPC（同登录态；同一张卡、同一个
  // 工作空间再拖一次 = 聚焦已开的那扇）；网页：浏览器弹窗（同名窗口复用）。窗口大小取这张卡在工作区里
  // 的大小，开在松手处、指针落在新窗口标题栏上。
  const wsName = (ws) => String(ws || '').split(/[\\/]/).filter(Boolean).pop() || '';
  function tearOut(v, e, p, s) {
    if (p.pop === 'old') { dropToast(t('桌面客户端更新后才能把卡片拖成独立窗口')); return; }
    const url = popOut.url(v);
    const width = Math.round(Math.max(480, Math.min(1400, s.w || 560)));
    const height = Math.round(Math.max(420, Math.min(1200, (s.h || 640) + 32)));
    const x = Math.round(e.screenX - (p.fx ?? 0.5) * width);
    const y = Math.round(e.screenY - 16);
    const name = wsName(st.ws);
    const winTitle = (toolOf(v)?.label || '') + (name ? ' · ' + name : '');
    // 工作区里这张先关掉（窗口要一会儿才出来，别让它弹回格子里闪一下）；没开成再摆回来
    host.closeView(v);
    const fail = (msg) => { dropToast(msg); if (keys.includes(v)) host.open(v); };
    if (p.pop === 'shell') {
      let bg = '';
      try { bg = getComputedStyle(dockEl || document.documentElement).getPropertyValue('--wb-card').trim(); } catch {}
      Promise.resolve(bdOf().window.openChat({ url, key: popOut.key(v), title: winTitle, x, y, width, height, bg }))
        .then((r) => { if (r && r.ok === false) fail(t('没能打开新窗口')); })
        .catch(() => fail(t('没能打开新窗口')));
      return;
    }
    let w = null;
    try { w = window.open(url, 'bridge-card-' + v, `popup=yes,width=${width},height=${height},left=${x},top=${y}`); } catch {}
    if (!w) fail(t('浏览器拦下了新窗口——允许本站弹出窗口后再拖一次'));
    else { try { w.focus(); } catch {} }
  }
  // 无边框卡片窗口的窗控（桌面壳注入；网页弹窗 / 老壳没有 → 不摆这三颗，用系统标题栏）
  const winCtl = untrack(() => card) && typeof window !== 'undefined' ? window.BridgeCardWindow || null : null;
  let winMax = $state(false);
  $effect(() => winCtl?.onMaximize?.((on) => { winMax = on; }));

  // 返回键 / 侧滑：先收工作区（预览层优先级更高、先被收掉）。折叠屏展开仍是安卓，也要占这一层；
  // 只有 expanded（桌面浏览器 / 大平板，通常没有系统返回键）不占。
  $effect(() => { if (st.open && !layout.expanded && !card) return backLayer(() => host.close()); });

  // 桌面快捷键：开关对应那张卡
  $effect(() => {
    if (!keysOn || card) return;
    const onKey = (e) => {
      const v = toolForKey(tools, e);
      if (!v) return;
      e.preventDefault();
      host.toggleView(v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // —— 文件卡：把真·工作空间页原封不动挂进来 ——
  // 定位目标（点了产物卡、agent 让界面跳过去）每次换 key 重挂：初始路径是工作空间页挂载时一次性消费的。
  // filesRoot='identity'（Claude：没有命令行的身份只能走身份文件根）时先把 ui.filesPath 预置成工作空间目录，
  // 下一轮渲染才挂（文件页 onMount 读到的必是它）；工作空间在身份文件根之外就以它自己为根。
  let files = $state(null);   // { key, ws, rel, open, home }；rel=null → 走 ui.filesPath
  const filesShown = $derived(shown.includes('files') && !toolOf('files')?.own);
  $effect(() => {
    if (!filesShown) { files = null; return; }
    const ft = st.filesTarget, meta = st.meta, ws = st.ws;
    if (host.filesRoot !== 'identity') {
      const root = ft?.ws || ws;
      if (!root || (ws && (meta?.gone || meta?.shell === false))) { files = null; return; }
      files = { key: ft ? 't' + ft.seq : 'ws:' + ws, ws: root, rel: ft ? ft.rel || '' : '', open: ft?.open || '', home: ws };
      return;
    }
    if (!meta) { files = null; return; }
    if (ft) { files = { key: 't' + ft.seq, ws: ft.ws || '', rel: ft.rel || '', open: ft.open || '', home: ws }; return; }
    if (meta.rel == null) {
      files = ws && !snap && meta.shell !== false ? { key: 'wsroot:' + ws, ws, rel: '', open: '', home: ws } : null;
      return;
    }
    ui.filesPath = meta.rel;
    files = { key: 'ws', ws: '', rel: null, open: '', home: ws };
  });
  // 文件卡卸载（关卡片 / 切工具 / 换工作空间）时，若它的查看器实例正开着预览，一并收掉——
  // 否则没有实例在渲染，返回层却还压着一层幽灵预览
  $effect(() => {
    if (!files) return;
    return () => { if (preview.open && preview.host === host.previewHost) closePreview(); };
  });
  const exitFiles = () => (wide ? host.closeView('files') : host.close());
  // 文件卡的标题行浮到页面上：整张卡是同一块底，标题行透明，页面拿它当「状态栏」让位
  const filesFlt = $derived(!!files && (filesFloat === 'always' || !pointer.fine || snap));

  // —— 手机 ——
  let sheetHandle = $state();
  let sheetScrim = $state();
  // 选中的 chip 恒在可视区里（排在最末的会落进右缘渐隐带）：横向滚到刚好露全
  let chipsEl = $state();
  function chipIntoView() {
    const box = chipsEl, on = box?.querySelector('.wb-chip.on');
    if (!box || !on) return;
    const pad = 22, l = on.offsetLeft - box.offsetLeft, r = l + on.offsetWidth;
    if (r > box.scrollLeft + box.clientWidth - pad) box.scrollLeft = r - box.clientWidth + pad;
    else if (l < box.scrollLeft + 6) box.scrollLeft = Math.max(0, l - 10);
  }
  $effect(() => { mView; untrack(chipIntoView); });
  $effect(() => {
    const box = chipsEl;
    if (!box) return;
    const ro = new ResizeObserver(() => chipIntoView());
    ro.observe(box);
    return () => ro.disconnect();
  });
  // 抽屉里正开着文件预览：进「阅读形态」——升到顶（只让出状态栏）、chip 条收起、预览头压扁
  const sheetPv = $derived(!wide && preview.open && (preview.host === host.previewHost || preview.host === 'memory'));
  // 手机上挂着工作空间页：把手带 / 顶栏浮到页面上，页面拿它的实高当状态栏（--sat）
  const mobileFlt = $derived(!wide && mView === 'files' && !!files);
  let gripH = $state(0);
  // 整页形态：顶栏标签按扣掉返回钮后的净宽三档自适应
  let pageHeadW = $state(0);
  const pageTabs = $derived(tabMode(Math.max(0, pageHeadW - 78), tools.length));
  // 整页形态从左缘 / 顶栏右滑 = 返回对话
  let swipe = null;
  function pageTouchStart(e) {
    if (e.touches.length !== 1) { swipe = null; return; }
    const p = e.touches[0];
    swipe = p.clientX <= 28 || e.target?.closest?.('.wb-page-head') ? { x: p.clientX, y: p.clientY } : null;
  }
  function pageTouchEnd(e) {
    if (!swipe || e.changedTouches.length !== 1) return;
    const p = e.changedTouches[0];
    const dx = p.clientX - swipe.x, dy = Math.abs(p.clientY - swipe.y);
    swipe = null;
    if (dx > 68 && dy < 48) host.close();
  }
  // 整页形态打开时收起软键盘：输入框还握着焦点的话键盘会顶在整页上
  $effect(() => { if (st.open && !wide && mobile === 'page') { try { document.activeElement?.blur?.(); } catch {} } });

  const liveOf = (x, on) => !!x.lamp || (!!x.live && !on);
</script>

{#snippet glyph(x)}
  {#if icon}{@render icon(x.key)}{:else}{@html x.icon || ''}{/if}
{/snippet}

{#snippet body(view)}
  {@const x = toolOf(view)}
  {#if x?.own && panel}
    {@render panel(view)}
  {:else if !st.ws && !(view === 'files' && st.filesTarget?.ws)}
    <!-- 文件卡带着定位目标时照样能开，不要求这个对话已经绑了工作空间 -->
    {#if empty}{@render empty(view)}{:else}<div class="wb-wait">{t('工作空间加载中…')}</div>{/if}
  {:else}
    <SharedPanel {host} {view} {wide} {snap} {theme} {files} onExitFiles={exitFiles} />
  {/if}
{/snippet}

{#if card}
<!-- 卡片窗口：整扇窗就是这一张卡。顶上是卡片原本那条标题行（标题 + 工作空间名 + 卡片同款圆钮），其余全给面板。
     桌面壳里窗口无边框：标题行就是窗口拖拽带（双击放大 / 还原），右侧圆钮管这扇窗本身。 -->
<div class="wb wb-cardwin skin-{skin}" class:frameless={!!winCtl} bind:this={dockEl} aria-label={toolOf(card)?.label}>
  <header class="wb-card-head wb-win-head">
    <span class="wb-card-t">{toolOf(card)?.label}</span>
    {#if wsName(st.ws)}<span class="wb-win-ws" title={st.ws}>{wsName(st.ws)}</span>{/if}
    {#if onCardBack}
      <button class="wb-cbtn" aria-label={t('放回工作台')} title={t('放回工作台')} onclick={onCardBack}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/><path d="M11.5 12H6.5m2.5-2.5L6.5 12 9 14.5"/></svg>
      </button>
    {/if}
    {#if winCtl}
      <button class="wb-cbtn" aria-label={t('最小化')} title={t('最小化')} onclick={() => winCtl.minimize()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 12h11"/></svg>
      </button>
      <button class="wb-cbtn" aria-label={winMax ? t('还原') : t('放大')} title={winMax ? t('还原') : t('放大铺满')} onclick={() => winCtl.toggleMaximize()}>{@html dockIcon(winMax ? 'shrink' : 'expand')}</button>
      <button class="wb-cbtn" aria-label={t('关闭')} title={t('关闭')} onclick={() => winCtl.close()}>{@html dockIcon('close')}</button>
    {/if}
  </header>
  {@render body(card)}
</div>
{:else if st.open}
{#if wide}
<aside class="wb wb-wide skin-{skin}" class:mid class:overlay class:gripping class:two={twoNow} class:full={!!maxed} class:sorting={!!sort} class:resizing={!!resizing}
  class:fill={sizing !== 'self'} class:hostband={!!band} bind:this={dockEl}
  style:width={curW ? `${curW}px` : null} style:--wb-reserve={reserve != null ? `${reserve}px` : null} aria-label={label}>
  {#if sizing === 'self' && !maxed}<div class="wb-grip" role="separator" aria-label={t('拖拽调整宽度')} onpointerdown={gripDown} ondblclick={gripReset}></div>{/if}
  {#if band}
    <!-- 宿主自己的顶带（Claude 的工具开关组：工作区收着时它挂在这一格右上角，展开后坐进这条带） -->
    {@render band()}
  {:else}
    <!-- 顶带：左 = 收起整个工作区，右 = 每张卡一颗开关 -->
    <header class="wb-band">
      <button type="button" class="wb-fold" onclick={() => host.close()} title={t('收起工作区')} aria-label={t('收起工作区')}>{@html dockIcon('fold')}</button>
      <div class="wb-toggles" role="group" aria-label={t('工作区工具')}>
        {#each tools as x (x.key)}
          {@const on = shown.includes(x.key)}
          <button type="button" class="wb-tog" class:on aria-pressed={on} aria-label={x.label}
            title={x.kbd ? t('{label}（{kbd}）', { label: x.label, kbd: x.kbd }) : x.label} onclick={() => host.toggleView(x.key)}>
            <span class="wb-ic">{@render glyph(x)}</span>
            {#if liveOf(x, on)}<i class="wb-dot"></i>{/if}
          </button>
        {/each}
      </div>
    </header>
  {/if}
  <div class="wb-cards" bind:this={cardsEl}>
    {#if emptyBox}<div class="wb-slot empty" style={emptyBox}></div>{/if}
    {#if slotBox}<div class="wb-slot" style={slotBox}></div>{/if}
    {#each cards as c (c.v)}
      <section class="wb-card" class:hid={!c.box} class:flt={c.v === 'files' && filesFlt} class:lifted={sort?.v === c.v} class:tearing={sort?.v === c.v && sort.out}
        style={c.box} aria-label={c.tool?.label} use:cardRef={c.v} onpointerdowncapture={() => host.noteFocus?.(c.v)}>
        <!-- 标题行 = 拖拽把手：拖动排顺序 / 换列，拖出 app 成独立窗口；双击放大 / 还原 -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <header class="wb-card-head" class:grab={pointer.fine && sortable(c.v)}
          onpointerdown={(e) => headDown(e, c.v)} onpointermove={headMove} onpointerup={headUp}
          onpointercancel={headCancel} onlostpointercapture={headCancel} ondblclick={(e) => headDbl(e, c.v)}>
          <span class="wb-card-ic">{@render glyph(c.tool)}</span>
          <span class="wb-card-t">{c.tool?.label}</span>
          {#if c.tool?.badge}<span class="wb-card-n">{c.tool.badge}</span>{/if}
          {#if c.tool?.hot}<i class="wb-hot" aria-hidden="true"></i>{/if}
          <button class="wb-cbtn" aria-label={maxed === c.v ? t('还原') : t('放大')} title={maxed === c.v ? t('还原') : t('放大铺满')} onclick={() => host.toggleMax(c.v)}>{@html dockIcon(maxed === c.v ? 'shrink' : 'expand')}</button>
          <button class="wb-cbtn" aria-label={c.tool?.closeLabel || t('关闭')} title={t('关闭')} onclick={() => host.closeView(c.v)}>{@html dockIcon('close')}</button>
        </header>
        <div class="wb-card-body">{@render body(c.v)}</div>
        <span class="wb-ring" aria-hidden="true" use:ringRef={c.v}></span>
      </section>
    {/each}
    {#each seams as d (d.key)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="wb-seam" class:on={resizing === d.key} style={d.css} title={t('拖拽调整上下两张的高度（双击等分）')}
        onpointerdown={(e) => seamDown(e, d)} ondblclick={() => seamReset(d)}></div>
    {/each}
  </div>
</aside>
{:else if mobile === 'page'}
<!-- 手机整屏页：不压缩、不叠盖对话，左上返回，标签直切工具 -->
<aside class="wb wb-page skin-{skin}" class:flt={mobileFlt} aria-label={label} ontouchstart={pageTouchStart} ontouchend={pageTouchEnd}>
  <header class="wb-page-head" bind:clientWidth={pageHeadW}>
    <button type="button" class="wb-back" onclick={() => host.close()} aria-label={t('返回对话')}>
      {@html dockIcon('back')}<span>{t('对话')}</span>
    </button>
    <div class="wb-tabs" role="tablist" aria-label={t('工作区工具')}>
      {#each tools as x (x.key)}
        {@const on = mView === x.key}
        {@const text = pageTabs === 'all' || (pageTabs === 'active' && on)}
        <button type="button" role="tab" class="wb-tab" class:on class:bare={!text} aria-selected={on} aria-label={x.label} title={x.label} onclick={() => host.open(x.key)}>
          <span class="wb-ic">{@render glyph(x)}</span>
          {#if text}<span class="wb-tab-t">{x.label}{#if x.badge}<em>·{x.badge}</em>{/if}</span>{/if}
          {#if liveOf(x, on)}<i class="wb-dot"></i>{/if}
        </button>
      {/each}
    </div>
  </header>
  <div class="wb-page-body">{@render body(mView)}</div>
</aside>
{:else}
<!-- 手机底部抽屉：点遮罩关、把手下拉关、chip 直切工具 -->
<div class="wb-sheetwrap skin-{skin}">
  <button class="wb-scrim" bind:this={sheetScrim} aria-label={t('关闭工作台')} onclick={() => host.close()}></button>
  <div class="wb wb-sheet" class:pv={sheetPv} class:flt={mobileFlt} style:--wb-grip-h={gripH ? `${gripH}px` : null}
    use:dragSheet={{ onClose: () => host.close(), handle: () => sheetHandle ?? null, scrim: () => sheetScrim ?? null }}>
    <div class="wb-gripzone" bind:this={sheetHandle} bind:clientHeight={gripH}>
      <span class="wb-gripbar"></span>
      <!-- 收起钮钉在右上角、不随 chip 横滑：窄屏放不下时哪个工具的收起都在同一个固定位置 -->
      <div class="wb-chiprow">
        <div class="wb-chips" bind:this={chipsEl}>
          {#each tools as x (x.key)}
            {@const on = mView === x.key}
            <button class="wb-chip" class:on onclick={() => host.open(x.key)}>
              <span class="wb-chip-ic">{@render glyph(x)}</span>
              {x.label}
              {#if liveOf(x, on)}<span class="wb-live"></span>{/if}
            </button>
          {/each}
        </div>
        <button class="wb-chipfold" aria-label={t('收起工作台')} onclick={() => host.close()}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>
        </button>
      </div>
    </div>
    <div class="wb-sheet-body">{@render body(mView)}</div>
  </div>
</div>
{/if}
{/if}

<style>
  /* 配色令牌（--wb-*）与面板用的通用令牌（--bg / --text / --muted…）由各分页的 skin 给，见 workbench-skins.css。
     这里只管结构。 */
  .wb { display: flex; flex-direction: column; background: var(--wb-bg, var(--bg)); color: var(--text); min-width: 0; min-height: 0; }

  /* —— 侧列：常驻右列，与对话分栏 ——
     顶上一条带放工具开关；卡片从带下开始。子树里 --sat / --wco-right 归零：根部已经吃掉了顶部的
     「别人的地盘」，里面的面板头、内嵌文件页、查看器头不必再各自避让（归零必须挂在子节点上——
     同一元素上引用自己刚声明的变量拿的是新值）。带里的开关要读这一格的安全区 / 窗控宽度，先在本元素上
     存一份（var 在声明处解析，子节点继承的是算好的值）；窗控宽度封个顶，免得几何读数异常把开关推出工作区。 */
  .wb-wide {
    position: relative; flex: none;
    width: clamp(400px, 44%, 760px); min-width: 360px; max-width: var(--wb-max, 78%);
    padding: var(--sat, 0px) 8px 8px 6px;
    --wb-sat: var(--sat, 0px); --wb-wco-r: min(var(--pane-wco-r, var(--wco-right, 0px)), 240px);
    --wb-max: calc(100% - var(--wb-reserve, 22%));
  }
  .wb-wide > * { --sat: 0px; --wco-right: 0px; }
  /* 宿主自带顶带（绝对定位坐在这一格右上角）：根部给它留出带高。
     网页 / 平板：开关组（top 10 + 36）+ 8px 缝；桌面壳：带 = 窗控标题栏带，其余是窗口拖拽区；
     分屏的 iframe 那一格由宿主告知带高、挂 data-wco-band，同一条线。 */
  .wb-wide.hostband { padding-top: calc(var(--sat, 0px) + 54px); }
  @media (pointer: coarse) { .wb-wide.hostband { padding-top: calc(var(--sat, 0px) + 58px); } }
  :global(html[data-wco="1"]) .wb-wide.hostband, :global(html[data-wco-band="1"]) .wb-wide.hostband { padding-top: var(--wco-h, 40px); }
  /* 两列：默认更宽（两列各自够用），给对话留 ≥360 */
  .wb-wide.two { width: clamp(640px, 62%, 1180px); min-width: 560px; --wb-max: calc(100% - var(--wb-reserve, 360px)); }
  /* medium（折叠屏展开 / 竖屏平板）：默认占一半多一点，给正文留住 300px 下限。
     min-width 一并降到 300，否则 max-width 钳不动、面板会顶破视口。 */
  .wb-wide.mid { width: clamp(320px, 52%, 560px); min-width: 300px; --wb-max: calc(100% - var(--wb-reserve, 300px)); }
  /* 宽度归宿主管：铺满它给的那一栏 */
  .wb-wide.fill { box-sizing: border-box; width: 100%; height: 100%; min-width: 0; max-width: none; }
  /* 盖在正文上（分屏的窄格）：贴这一格的右缘整高浮起，正文不让位；留 48px 给正文露个边 */
  .wb-wide.overlay { position: absolute; top: 0; right: 0; bottom: 0; z-index: 32;
    width: clamp(360px, 62%, 640px); min-width: min(360px, calc(100% - 48px)); max-width: calc(100% - 48px);
    box-shadow: -14px 0 44px rgba(0, 0, 0, .28); animation: wbInOver .22s ease; }
  /* 放大：一张卡铺满这一格（对话暂时让出来），顶上的带照旧 */
  .wb-wide.full { position: absolute; inset: 0; z-index: 33; height: auto; width: auto; min-width: 0; max-width: none; padding-left: 8px; box-shadow: none; animation: none; }
  @keyframes wbInOver { from { opacity: .4; transform: translateX(28px); } to { opacity: 1; transform: none; } }
  .wb-wide.gripping { animation: none; }
  .wb.gripping :global(iframe), .wb.sorting :global(iframe), .wb.resizing :global(iframe) { pointer-events: none; }
  .wb.sorting, .wb.resizing { user-select: none; }
  .wb.resizing { cursor: row-resize; }
  /* 左缘把手：7px 命中区整条落在工作区这一侧（左 6px 内边距 + 卡片 1px 边框），一点不伸进正文列——
     正文列的滚动条槽就贴在这条接缝左边，骑缝会盖住滚动条、点滑块变成拖宽度。
     no-drag：桌面壳下顶上那条标题栏带是窗口拖拽区，把手不打洞的话顶端拖不动宽度。 */
  .wb-grip { position: absolute; left: 0; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 5; touch-action: none; -webkit-app-region: no-drag; }
  .wb-grip::after { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 2px; background: transparent; transition: background-color .15s ease; }
  @media (hover: hover) { .wb-grip:hover::after { background: color-mix(in srgb, var(--muted) 45%, transparent); } }
  .wb.gripping .wb-grip::after { background: var(--wb-accent, var(--coral)); }

  /* 默认顶带：与对话列顶栏同高；桌面壳无边框窗口下右侧让出系统窗控 */
  .wb-band { flex: none; box-sizing: border-box; height: var(--wb-band-h, 44px); display: flex; align-items: center; gap: 6px; padding: 0 2px; }
  :global(html[data-wco="1"]) .wb-band { padding-right: calc(2px + var(--wb-wco-r)); }
  .wb-toggles { margin-left: auto; display: flex; align-items: center; gap: 2px; min-width: 0; -webkit-app-region: no-drag; }
  .wb-tog, .wb-fold { position: relative; flex: none; width: 30px; height: 30px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
    color: var(--muted); -webkit-app-region: no-drag; transition: background-color .12s ease, color .12s ease; }
  .wb-ic { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; font-size: 18px; line-height: 1; }
  .wb-ic :global(svg), .wb-fold :global(svg) { width: 18px; height: 18px; }
  @media (hover: hover) { .wb-tog:hover, .wb-fold:hover { color: var(--text); background: var(--hover); } }
  .wb-tog.on { color: var(--text); background: var(--hover-strong); }
  .wb-tog.on .wb-ic { color: var(--wb-on, currentColor); }
  @media (pointer: coarse) { .wb-tog, .wb-fold { width: 34px; height: 34px; border-radius: 9px; } }
  .wb-dot { position: absolute; top: 4px; right: 4px; width: 5.5px; height: 5.5px; border-radius: 50%; background: var(--wb-live, var(--ok)); }

  /* 卡片区：卡片绝对定位按比例摆（位置由脚本给成 calc 百分比），外沿与卡间缝都是 8px。
     入场动画只给卡片区：宿主顶带从这一格右上角交接到带里，位置不变，不该跟着滑一下。 */
  .wb-cards { position: relative; flex: 1; min-height: 0; animation: wbIn .22s ease; }
  @keyframes wbIn { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
  /* 卡片里 --bg 换成卡片色：终端（底色从所在元素现取）、面板里的吸顶条 / 渐隐带都画在卡片上 */
  .wb-card {
    position: absolute; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box;
    border-radius: var(--wb-radius, 12px); border: 1px solid var(--wb-line); background: var(--wb-card); --bg: var(--wb-card);
    box-shadow: var(--wb-card-shadow, none); animation: wbCardIn .2s ease;
  }
  .wb-card.hid { display: none; }
  @keyframes wbCardIn { from { opacity: 0; transform: translateY(6px); } }
  .wb-card-head { flex: none; display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 5px 0 13px; touch-action: none; user-select: none; -webkit-app-region: no-drag; }
  .wb-card-head.grab { cursor: grab; }
  .wb-card-ic { display: var(--wb-head-ic, none); align-items: center; justify-content: center; flex: none; width: 16px; height: 16px; margin-right: 5px; font-size: 16px; line-height: 1; color: var(--muted); }
  .wb-card-ic :global(svg) { width: 16px; height: 16px; }
  .wb-card-t { font-size: 13.5px; font-weight: var(--wb-title-w, 400); color: var(--wb-title, var(--serif)); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .wb-card-n { flex: none; margin-left: 5px; font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .wb-hot { flex: none; margin-left: 6px; width: 6px; height: 6px; border-radius: 50%; background: var(--wb-live, var(--ok)); animation: wbPulse 1.4s ease-in-out infinite; }
  .wb-cbtn { width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; -webkit-app-region: no-drag; }
  .wb-cbtn:first-of-type { margin-left: auto; }
  .wb-cbtn :global(svg), .wb-cbtn svg { width: 15px; height: 15px; }
  .wb-cbtn:active { background: var(--hover-strong); }
  @media (hover: hover) { .wb-cbtn:hover { background: var(--hover); color: var(--text); } }
  .wb-card-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  /* 浮动标题行（见 filesFlt）：叠在内嵌页之上、不占流；内嵌页拿它当「状态栏」——--sat 设成标题行高，
     工作空间页的顶栏钮 / 滚动边缘 / 菜单锚点 / 工具栏、预览头都按 --sat 让位，滚动内容从标题行底下穿过 */
  .wb-card.flt > .wb-card-head { position: absolute; top: 0; left: 0; right: 0; z-index: 3; }
  .wb-card.flt :global(.wb-embed) { --sat: 38px; }
  /* 被点名时描一圈（脚本只动它的透明度） */
  .wb-ring { position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 1.5px var(--wb-accent, var(--coral)); opacity: 0; pointer-events: none; }
  /* 拖动排序：拿起的那张浮在最上、投影加深，跟着指针走（inline transform 每帧改，不加过渡）；
     落点是一圈虚线框，随排布滑到新格子；拖出窗口时半透明，示意「松手就成独立窗口」 */
  .wb-card.lifted { z-index: 6; animation: none; box-shadow: 0 22px 54px rgba(0, 0, 0, .42), 0 4px 14px rgba(0, 0, 0, .22);
    transition: opacity .16s ease, box-shadow .16s ease; }
  .wb-card.tearing { opacity: .6; }
  .wb.sorting, .wb.sorting .wb-card-head { cursor: grabbing; }
  .wb-slot { position: absolute; border-radius: var(--wb-radius, 12px); pointer-events: none;
    border: 1.5px dashed color-mix(in srgb, var(--muted) 42%, transparent);
    background: color-mix(in srgb, var(--muted) 7%, transparent);
    transition: left .26s cubic-bezier(.2, .8, .2, 1), top .26s cubic-bezier(.2, .8, .2, 1), width .26s cubic-bezier(.2, .8, .2, 1), height .26s cubic-bezier(.2, .8, .2, 1);
    animation: wbFade .16s ease; }
  .wb-slot.empty { border-color: color-mix(in srgb, var(--muted) 22%, transparent); background: none; transition: none; }
  @keyframes wbFade { from { opacity: 0; } }
  /* 卡间缝：8px 全是命中区，悬停 / 拖动时中间亮出一截短横线 */
  .wb-seam { position: absolute; z-index: 3; cursor: row-resize; touch-action: none; -webkit-app-region: no-drag; }
  .wb-seam::after { content: ''; position: absolute; left: 50%; top: 50%; width: 36px; height: 3px; margin: -1.5px 0 0 -18px; border-radius: 2px;
    background: color-mix(in srgb, var(--muted) 55%, transparent); opacity: 0; transition: opacity .12s ease; }
  @media (hover: hover) { .wb-seam:hover::after { opacity: 1; } }
  .wb-seam.on::after { opacity: 1; background: var(--muted); }

  /* —— 卡片窗口（拖出 app 的那一张）：整扇窗就是卡片底色，顶上一条细标题行 —— */
  .wb-cardwin { flex: 1; min-height: 0; background: var(--wb-card); --bg: var(--wb-card); }
  .wb-win-head { cursor: default; }
  .wb-cardwin.frameless .wb-win-head { -webkit-app-region: drag; }
  .wb-win-ws { min-width: 0; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--muted); }

  .wb-live { width: 7px; height: 7px; border-radius: 50%; background: var(--wb-live, var(--ok)); animation: wbPulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes wbPulse { 50% { opacity: .35; } }
  .wb-wait { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; padding: 0 24px; text-align: center; line-height: 1.7; }

  /* —— 手机底部抽屉 —— */
  .wb-sheetwrap { position: fixed; inset: 0; z-index: var(--wb-mobile-z, 58); display: flex; align-items: flex-end; }
  .wb-scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, .45); animation: wbFade .24s ease; }
  .wb-sheet { position: relative; width: 100%; height: calc(100dvh - 52px - var(--sat, 0px)); border-radius: 20px 20px 0 0;
    background: var(--wb-sheet, var(--bg));
    padding-bottom: max(var(--sab, 0px), var(--kb, 0px));
    box-shadow: 0 -10px 44px rgba(0, 0, 0, .35); overflow: hidden;
    animation: wbSheetUp .36s cubic-bezier(.32, .9, .35, 1) both;
    transition: transform .3s cubic-bezier(.32, .9, .35, 1), height .3s cubic-bezier(.32, .9, .35, 1); }
  @keyframes wbSheetUp { from { transform: translateY(52%); opacity: .7; } }
  /* 抽屉顶边本就在状态栏之下、底边已吃掉手势条 / 键盘：子树里安全区归零，否则内嵌工作空间页与
     预览头会在抽屉里再让一遍状态栏，chip 条下凭空多出一条空带 */
  .wb-sheet > * { --sat: 0px; --sab: 0px; }
  /* 阅读形态（抽屉里开着预览）：升到顶、chip 条收起、预览头压扁（变量由各查看器头读） */
  .wb-sheet.pv { height: calc(100dvh - var(--sat, 0px) - 6px); --pv-pad-y: 4px; --pv-bar-h: 44px; }
  .wb-sheet.pv .wb-chiprow { display: none; }
  .wb-gripzone { flex: none; touch-action: none; }
  .wb-sheet-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  /* 浮动把手带（见 mobileFlt）：叠在内嵌页之上、不占流；内嵌页的 --sat = 这条带的实高
     （阅读形态 chip 条收起、带变矮，--sat 跟着变）。量到之前先按常态高度兜底。 */
  .wb-sheet.flt > .wb-gripzone { position: absolute; top: 0; left: 0; right: 0; z-index: 3; }
  .wb-sheet.flt :global(.wb-embed) { --sat: var(--wb-grip-h, 62px); }
  .wb-gripbar { display: block; width: 38px; height: 4.5px; border-radius: 3px; background: var(--divider); margin: 8px auto 2px; }
  .wb-sheet.pv .wb-gripbar { margin: 6px auto 5px; }
  .wb-chiprow { display: flex; align-items: center; padding: 6px 8px 8px 0; }
  /* 右缘渐隐：被截住的 chip 一看就知道还能横滑 */
  .wb-chips { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; padding: 0 14px 0 10px; overflow-x: auto; scrollbar-width: none;
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent); }
  .wb-chips::-webkit-scrollbar { display: none; }
  .wb-chip { flex: none; display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px; border-radius: 11px;
    color: var(--muted); font-size: 13px; transition: background-color .14s ease, color .14s ease; }
  .wb-chip:active { transform: scale(.97); }
  .wb-chip.on { background: var(--card); color: var(--text); box-shadow: var(--card-shadow); }
  .wb-chip-ic { width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; flex: none; font-size: 16px; line-height: 1; }
  .wb-chip-ic :global(svg) { width: 100%; height: 100%; }
  .wb-chipfold { margin-left: 2px; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .wb-chipfold svg { width: 17px; height: 17px; }
  .wb-chipfold:active { background: var(--hover); }

  /* —— 手机整屏页 —— */
  .wb-page { --wb-sat0: var(--sat, 0px); position: fixed; inset: 0; z-index: var(--wb-mobile-z, 58); box-sizing: border-box;
    padding-top: var(--sat, 0px); padding-bottom: var(--sab, 0px); animation: wbPageIn .26s cubic-bezier(.05, .7, .1, 1) both; }
  @keyframes wbPageIn { from { transform: translateX(100%); } }
  .wb-page-head { flex: none; box-sizing: border-box; height: 46px; display: flex; align-items: center; justify-content: space-between; gap: 6px;
    padding: 0 8px 0 6px; border-bottom: 1px solid var(--divider); overflow: hidden; }
  .wb-page-body { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; --sat: 0px; --sab: 0px; --wco-right: 0px; }
  /* 文件视图：顶栏浮在工作空间页上（不画分割线、不占流），页面一直铺到状态栏顶上，
     页面的 --sat = 状态栏 + 顶栏高，玻璃钮、滚动边缘、菜单锚点都让到顶栏下面 */
  .wb-page.flt { padding-top: 0; }
  .wb-page.flt > .wb-page-head { position: absolute; top: var(--wb-sat0); left: 0; right: 0; z-index: 3; border-bottom: 0; }
  .wb-page.flt :global(.wb-embed) { --sat: calc(var(--wb-sat0) + 46px); }
  .wb-back { flex: none; display: inline-flex; align-items: center; gap: 3px; height: 32px; padding: 0 8px 0 4px; border-radius: 8px; font-size: 13px; font-weight: 540; color: var(--text); }
  .wb-back :global(svg) { width: 20px; height: 20px; }
  .wb-back:active { background: var(--hover); }
  .wb-tabs { display: flex; align-items: center; gap: 2px; min-width: 0; flex: 0 1 auto; margin-left: auto; }
  .wb-tab { position: relative; flex: none; height: 32px; padding: 0 8px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    font-size: 12.5px; color: var(--muted); white-space: nowrap; transition: background-color .12s ease, color .12s ease; }
  .wb-tab.bare { width: 32px; padding: 0; }
  .wb-tab.on { background: var(--hover-strong); color: var(--text); font-weight: 520; }
  .wb-tab.on .wb-ic { color: var(--wb-on, currentColor); }
  .wb-tab .wb-ic, .wb-tab .wb-ic :global(svg) { width: 16px; height: 16px; font-size: 16px; }
  .wb-tab-t { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wb-tab-t em { font-style: normal; font-size: 10.5px; margin-left: 1px; opacity: .8; }

  @media (prefers-reduced-motion: reduce) {
    .wb-cards, .wb-card, .wb-slot, .wb-sheet, .wb-page { animation-duration: 1ms; }
    .wb-hot, .wb-live { animation: none; }
  }
</style>
