<script>
  // Claude 分页右侧工作台：六件套——任务 / 审阅 / 终端 / 浏览器 / 文件 / 记忆。
  // 宽屏（侧列形态）= Claude 桌面版同款【圆角卡片】：这一格右上角标题栏带里的工具开关（TopBar tools）
  //   一颗管一张卡，开几张摆几张（终端 / 审阅 / 任务叠在一列，浏览器 / 文件另起一列；放不下两列就
  //   全叠一列）；卡片自带标题行（放大铺满 / 关闭）；工作台顶上留一条和工具组同高的带，左缘拖拽调宽。
  //   宿主不许多卡时（分屏格 / 独立窗口 / 折叠屏）一次只放一张，开关就是切换。
  // 窄屏 = 移动端专属方案（dimensio 手机端同款）：底部 sheet（把手下拉/scrim 点击可关）
  //        + 常驻工具切换条（chip 直切五件套）。
  import { ui, session } from '../../lib/state.svelte.js';
  import { dock, closeDock, closeDockView, toggleDockView, toggleDockMax, setDockMulti, openDock, ensureDockMeta, dockToolOk, dockSnapMode, dockCols, setDockCols, dockToolLabel, dockToolIcon, browserMountedNow, browserSessionOf } from '../../lib/dock.svelte.js';
  import { isPluginView, workbenchByKey, workbenchKeys } from '../../lib/pluginUi.svelte.js';
  import PluginWorkbench from './PluginWorkbench.svelte';   // 插件的工作台标签（ctx.ui.workbench）
  import { layout, pointer } from '../../lib/layout.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { dragSheet } from '../../lib/dockTouch.js';
  import ReviewPanel from './ReviewPanel.svelte';
  import TermPanel from './TermPanel.svelte';
  import BrowserPanel from './BrowserPanel.svelte';
  import WorkspaceEmbed from './WorkspaceEmbed.svelte';
  import TasksPanel from './TasksPanel.svelte';
  import MemoryPanel from './MemoryPanel.svelte';
  import DockToolBar from './DockToolBar.svelte';
  import { dockIcon } from '../../lib/dockIcons.js';
  import { bgHoldNow } from '../../lib/chat.svelte.js';
  import MediaViewer from '../preview/MediaViewer.svelte';
  import { preview, closePreview } from '../../lib/preview.svelte.js';
  import { reportUi } from '../../lib/uiReport.js';
  import { untrack, tick } from 'svelte';
  import { t, tc } from '../../lib/i18n.js';
  import { cardUrl, DOCK_CHANNEL, IS_SOLO } from '../../lib/solo.js';
  import { dropToast } from '../../lib/dragdrop.svelte.js';

  // wide = 以【侧列】形态摆（宿主按 layout.side 传入：expanded 与 medium 都是侧列）；
  // false = 手机底部 sheet。medium 档另给一套更窄的宽度区间（见 .dock.wide.mid）。
  // overlay = 侧列【盖】在正文上而不是挤开它（分屏时每一格都窄，挤一下正文就只剩一条缝；
  // 宿主按这一格的宽度决定，够宽时仍是原来的挤开式）。宿主须是 position:relative 的容器。
  // multi = 允许几张卡同时开（宿主定：主窗口单格、够宽才给；理由见 dock.svelte.js 的 multi 注释）。
  // toolsClose = 分屏格的「关掉这一格」：工作台展开时工具开关组挂在本组件顶上的带里，✕ 跟着过来。
  // card = 卡片窗口（工作台的一张卡被拖出 app，solo.html?card=…）：整扇窗只放这一张，没有工具组 / 多卡 / 拖排。
  let { wide = false, overlay = false, multi = false, toolsClose = null, card = '' } = $props();
  const mid = $derived(layout.medium);
  $effect(() => { const on = wide && multi; untrack(() => setDockMulti(on)); });

  const TITLES = { tasks: tc('claude', '任务'), review: t('审阅'), term: t('终端'), browser: t('浏览器'), files: tc('claude', '文件'), memory: tc('claude', '记忆') };
  // 卡片标题行的 ✕：整句一键（英文 “Close terminal” 要小写名词，不能拿标题拼）
  const CLOSE_LABEL = { tasks: tc('claude', '关闭任务'), review: t('关闭审阅'), term: t('关闭终端'), browser: t('关闭浏览器'), files: tc('claude', '关闭文件'), memory: tc('claude', '关闭记忆') };
  const snapMode = $derived(dockSnapMode());

  // 手机 sheet 的 chip 条：六件套按这个顺序（门禁藏掉的不出）
  // 插件标签（'plg:<插件>:<id>'）没有固定表：标题用插件给的，关闭钮说「关闭「标题」」
  const titleOf = (v) => (isPluginView(v) ? dockToolLabel(v) : TITLES[v]);
  const closeLabelOf = (v) => (isPluginView(v) ? t('关闭「{name}」', { name: dockToolLabel(v) }) : CLOSE_LABEL[v]);
  const PLG = $derived(workbenchKeys());
  // 手机 sheet 的 chip 条：六件套（门禁藏掉的不出），插件标签跟在最后
  const MENU = $derived([...['tasks', 'review', 'term', 'browser', 'files', 'memory'], ...PLG].filter(dockToolOk)
    .map((key) => ({ key, label: titleOf(key) })));
  // 插件撤掉了它的标签（或插件被关）：开着的那张卡跟着收掉，别留一块空工作台
  $effect(() => {
    for (const v of dock.views) if (isPluginView(v) && !workbenchByKey(v)) untrack(() => closeDockView(v));
  });
  // 窄屏没有卡片：dock.view 被门禁藏掉（无 shell 用户的终端/浏览器）就回落审阅。
  const mView = $derived(MENU.some((m) => m.key === dock.view) ? dock.view : 'review');
  function pickTool(key) { openDock(key); }

  // 此刻真正摆出来的卡：宽屏 = 开着的全部（门禁过滤），窄屏 = chip 选中的那一张。
  const shown = $derived(card ? [card] : !dock.open ? [] : wide ? dock.views.filter(dockToolOk) : [mView]);

  // —— 工作区协同：dock 状态上报（agent 的 workspace.view 知道工作台开没开、开着哪几张）；
  // 终端卡摆出来就摘掉 termLive 提示点。卡片窗口不报：它不是「这个人正看着的那一页」。——
  $effect(() => { if (shown.includes('term')) dock.termLive = false; });
  $effect(() => { if (!card) reportUi({ dock: { open: dock.open, view: dock.open ? shown.join('+') : '' } }); });

  // —— 卡片排布 ——
  // 两列（dockCols.a / .b，用户拖卡片标题行排出来的，默认 终端/审阅/任务 一列、浏览器/文件/记忆 一列）。
  // 两列都有卡且这一格够宽才分两列，否则按 a 再 b 全叠进一列。卡片用绝对定位按比例摆，而不是分两个
  // flex 列：列数变化、拖动换位时（拉窗口、开关一张卡、排顺序）卡片不换父节点、不重挂——终端和
  // 浏览器的连接、滚回缓冲都留着。
  const RENDER_ORDER = ['term', 'review', 'tasks', 'browser', 'files', 'memory'];
  const TWO_COL_HOST = 1020;       // 这一格至少这么宽才摆两列（两列各 ≥300、对话还剩 ≥360）
  let hostW = $state(0);
  // 拖动中：{ v, start, cols, n, split, out, tx, ty }——cols / n 是此刻按指针算出的预览排布（松手才落盘）
  let sort = $state(null);
  const cols = $derived(sort ? sort.cols : dockCols);
  // 拖出窗口外那一刻起，这张卡就不占格子了（别的卡合拢补位，像把标签页拖出标签栏）
  const inGrid = (v) => shown.includes(v) && !(sort && sort.out && sort.v === v);
  const colA = $derived(cols.a.filter(inGrid));
  const colB = $derived([...cols.b, ...PLG].filter(inGrid));   // 插件标签（页面要宽）固定挂在第二列末尾，不进拖动排序
  const canTwo = $derived(wide && hostW >= TWO_COL_HOST && !overlay);
  // 拖动中列数由预览定（拖空的那一列留作落点，不当场塌成一列，免得工作台宽度在指针底下跳）
  const two = $derived(sort ? sort.n === 2 : canTwo && !!colA.length && !!colB.length);
  const maxed = $derived(wide && dock.max && shown.includes(dock.max) ? dock.max : '');
  const G = 8;
  const span = (i, n) => `calc((100% - ${G * (n - 1)}px) * ${i / n} + ${G * i}px)`;
  const size = (n) => `calc((100% - ${G * (n - 1)}px) / ${n})`;
  const slots = $derived.by(() => {
    const list = two ? [colA, colB] : [[...colA, ...colB]];
    const at = {};
    list.forEach((col, ci) => col.forEach((v, ri) => {
      at[v] = `left:${span(ci, list.length)};width:${size(list.length)};top:${span(ri, col.length)};height:${size(col.length)}`;
    }));
    return at;
  });
  const cards = $derived.by(() => {
    const at = slots;
    // 渲染顺序固定（keyed each 不因列数 / 排序变化而重排出新节点）
    const torn = sort && sort.out ? sort.v : '';
    return [...RENDER_ORDER, ...PLG].filter((v) => at[v] || v === torn).map((v) => {
      let box = v === torn ? `left:0;top:0;width:${sort.w}px;height:${sort.h}px`
        : maxed ? (maxed === v ? 'left:0;top:0;width:100%;height:100%' : '') : at[v];
      if (sort && sort.v === v && box) box += `;transform:translate(${sort.tx}px,${sort.ty}px)`;
      return { v, box };
    });
  });
  // 拖着那张卡的落点（虚线框）：就是它在预览排布里的格子；拖空了的那一列也描一圈，告诉你还能放回去
  const slotBox = $derived(sort && !sort.out && !maxed ? slots[sort.v] || '' : '');
  const emptyBox = $derived(sort && !sort.out && !maxed && two && (!colA.length || !colB.length)
    ? `left:${span(colA.length ? 1 : 0, 2)};width:${size(2)};top:0;height:100%` : '');

  // —— 分栏拖拽：左缘把手调工作台宽度（px 持久化；CSS min/max 兜底钳制）——
  // 一列、两列各记各的：两列时默认更宽，拖出来的宽度也不该回灌给一列。
  const DOCKW_LS = 'bridge-claude-dock-w';
  const DOCKW2_LS = 'bridge-claude-dock-w2';
  const readW = (k, lo) => { try { const n = +localStorage.getItem(k); return n >= lo ? n : null; } catch { return null; } };
  let dockW = $state(readW(DOCKW_LS, 300));
  let dockW2 = $state(readW(DOCKW2_LS, 560));
  const curW = $derived(maxed ? null : (two ? dockW2 : dockW));
  let dockEl = $state();
  let gripping = $state(false);
  $effect(() => {
    const host = dockEl?.parentElement;
    if (!host) return;
    const read = () => { hostW = host.clientWidth; };
    const ro = new ResizeObserver(read);
    ro.observe(host);
    read();
    return () => ro.disconnect();
  });
  function gripDown(e) {
    if (!wide || !dockEl || maxed) return;
    e.preventDefault();
    const rightEdge = dockEl.getBoundingClientRect().right;
    const isTwo = two;
    // 指针捕获：拖进卡片里的 iframe（文件卡的 HTML 预览）时，pointermove / pointerup 会被那份文档吞掉，
    // 本页收不到松手，宽度就一直黏在指针上。捕获后事件恒发给把手；.gripping 期间 iframe 再关掉命中兜一层。
    const grip = e.currentTarget, pid = e.pointerId;
    try { grip.setPointerCapture(pid); } catch {}
    gripping = true;
    document.body.style.userSelect = 'none';
    const move = (ev) => {
      // medium（折叠屏展开）横向本就紧张：下限放到 300、上限留 300px 给正文，
      // 免得一拖就把对话挤成一条缝。
      // 上限按【宿主容器】宽度算：分屏时工作台只属于那一格，别拿整窗宽度去钳。
      const hW = dockEl.parentElement?.clientWidth || window.innerWidth;
      const lo = isTwo ? 560 : mid && !overlay ? 300 : 360;
      const hi = overlay ? Math.max(lo, hW - 48) : mid ? Math.max(lo, hW - 300) : isTwo ? Math.max(lo, hW - 360) : hW * 0.78;
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
        if (isTwo && dockW2) localStorage.setItem(DOCKW2_LS, String(dockW2));
        if (!isTwo && dockW) localStorage.setItem(DOCKW_LS, String(dockW));
      } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    grip.addEventListener('lostpointercapture', up);
  }
  // 双击把手 = 恢复默认宽度
  function gripReset() {
    if (two) { dockW2 = null; try { localStorage.removeItem(DOCKW2_LS); } catch {} }
    else { dockW = null; try { localStorage.removeItem(DOCKW_LS); } catch {} }
  }

  // —— 拖卡片标题行：排顺序 / 拖出 app 成独立的卡片窗口 ——
  // 走指针事件 + 指针捕获而不是 HTML5 拖拽：卡片得实打实跟着指针走、别的卡实时让位（FLIP 滑过去），
  // HTML5 拖拽只给一张半透明截图。按住鼠标拖出窗口时 Chromium 仍把 pointermove / pointerup 发给捕获者
  // （坐标落在视口外），据此判「拖出 app」：这张卡离开格子、别的卡合拢；松手就开一扇只放它的窗口
  // （lib/solo.js cardUrl → SoloPage 卡片形态），工作台里这张随之关掉。
  let cardsEl = $state();
  const cardEls = {};
  function cardRef(node, v) {
    cardEls[v] = node;
    return { destroy() { if (cardEls[v] === node) delete cardEls[v]; } };
  }
  let press = null;   // 按下了标题行：{ v, x, y, pid, head, pop, fx, gy, px, py }；sort 非空 = 过了门槛、真在拖
  const bdOf = () => { try { return window.BridgeDesktop || (window.parent !== window && window.parent.BridgeDesktop) || null; } catch { return null; } };
  // 这一下能不能拖成窗口：桌面壳走 openChat IPC（'old' = 老壳没有，松手提示更新）；网页走弹窗；
  // 壳里没挂 preload 的窗口（拖出来的对话窗）window.open 会被转给系统浏览器、那边没有登录态——不给拖。
  function popMode() {
    if (card || snapMode || !wide) return '';
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
  const sameCols = (p, q) => p.a.join() === q.a.join() && p.b.join() === q.b.join();
  // v 插进 col 列、排在这一列第 idx 张【看得见的】卡前面（没开的卡留在原处，下次开出来还在老位置附近）
  function place(st, v, col, idx) {
    const a = st.a.filter((k) => k !== v), b = st.b.filter((k) => k !== v);
    const arr = col === 'a' ? a : b;
    const vis = arr.filter((k) => shown.includes(k));
    const at = idx < vis.length ? arr.indexOf(vis[idx]) : vis.length ? arr.indexOf(vis[vis.length - 1]) + 1 : arr.length;
    arr.splice(at, 0, v);
    return { a, b };
  }
  // 按指针算预览排布。一律从起手时的排布推（不在上一帧预览上叠加），指针回到原处就原样复原。
  //   · 起手两列：左半 / 右半定列，纵向按「这一列放进它之后每格多高」定第几格。拖空的那一列留着当落点。
  //   · 起手一列：按纵向定第几格；这一格够宽、还有别的卡时拖到右侧三成【停一下】= 拆成两列、它单独占右列
  //     （拆开后工作台变宽，退回门槛放宽到右半边，免得在门槛上来回抖；要停一下是因为工作台贴着窗口
  //     右缘，往右拖出窗口必经这一带，一划而过不该让工作台先变宽再缩回去）。
  const SPLIT_DWELL = 240;
  function target(px, py, allowSplit = true) {
    const r = cardsEl.getBoundingClientRect();
    const v = sort.v, st = sort.start;
    const vis = (arr) => arr.filter((k) => k !== v && shown.includes(k));
    const ra = vis(st.a), rb = vis(st.b);
    const slot = (count) => Math.max(0, Math.min(count, Math.floor((py - r.top) / (r.height / (count + 1)))));
    if (sort.n0 === 2) {
      const col = px < r.left + r.width / 2 ? 'a' : 'b';
      return { n: 2, split: false, cols: place(st, v, col, slot(col === 'a' ? ra.length : rb.length)) };
    }
    const others = ra.length + rb.length;
    if (allowSplit && canTwo && others > 0 && px > r.left + r.width * (sort.split ? 0.5 : 0.7)) {
      const a = [...st.a.filter((k) => k !== v), ...st.b.filter((k) => k !== v && shown.includes(k))];
      const b = [v, ...st.b.filter((k) => k !== v && !shown.includes(k))];
      return { n: 2, split: true, cols: { a, b } };
    }
    const i = slot(others);
    const toA = i < ra.length || (i === ra.length && (st.a.includes(v) || !rb.length));
    return { n: 1, split: false, cols: toA ? place(st, v, 'a', i) : place(st, v, 'b', i - ra.length) };
  }
  function rects(skip) {
    const m = {};
    for (const k in cardEls) if (k !== skip && cardEls[k].offsetParent) m[k] = cardEls[k].getBoundingClientRect();
    return m;
  }
  // FLIP：排布一变，各卡从刚才的视觉位置滑到新格子（只动 transform；尺寸当场换——拉伸动画会让终端 /
  // 浏览器跟着逐帧重排）。before 量的是含进行中动画的视觉位置，连续换位也接得上不跳。
  function flip(before) {
    for (const k in before) {
      const el = cardEls[k];
      if (!el) continue;
      for (const a of el.getAnimations?.() || []) if (a.id === 'dkflip') a.cancel();
      const b = el.getBoundingClientRect(), o = before[k];
      const dx = o.left - b.left, dy = o.top - b.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      try {
        const an = el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0,0)' }],
          { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
        an.id = 'dkflip';
      } catch {}
    }
  }
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
    if (!wide || card || e.button !== 0 || e.target.closest?.('button') || isPluginView(v)) return;
    press = { v, x: e.clientX, y: e.clientY, pid: e.pointerId, head: e.currentTarget, pop: e.pointerType === 'mouse' ? popMode() : '' };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }
  function beginSort() {
    const el = cardEls[press.v];
    // 一张卡、又拖不出窗口（或放大铺满时）：没什么可排的，按普通按下处理
    if (!el || (!press.pop && (maxed || shown.length < 2))) { press.dead = true; return; }
    const r = el.getBoundingClientRect();
    press.fx = (press.x - r.left) / (r.width || 1);
    press.gy = press.y - r.top;
    const start = { a: [...dockCols.a], b: [...dockCols.b] };
    const n0 = two ? 2 : 1;
    sort = { v: press.v, start, cols: start, n: n0, n0, split: false, out: false, tx: 0, ty: 0, w: el.offsetWidth, h: el.offsetHeight };
    document.body.style.userSelect = 'none';
  }
  async function headMove(e) {
    if (!press || press.dead || e.pointerId !== press.pid) return;
    if (!sort) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 5) return;
      beginSort();
      if (!sort) return;
    }
    press.px = e.clientX; press.py = e.clientY;
    const out = !!press.pop && outsideApp(e.clientX, e.clientY);
    let next = null;
    if (out) {
      // 拖出去了：排布回到起手（不带刚才的换位），这张让出格子；剩下的卡两列都还有才保持两列
      const st = sort.start, v = sort.v;
      const hasA = st.a.some((k) => k !== v && shown.includes(k)), hasB = st.b.some((k) => k !== v && shown.includes(k));
      next = { out, n: canTwo && hasA && hasB ? 2 : 1, split: false, cols: st };
    } else if (!maxed) {
      let tg = target(e.clientX, e.clientY);
      if (tg.split && !sort.split) {
        // 刚进拆列带：先按不拆算，停够了（指针不动也算——定时器补一次）再拆
        if (!press.bandAt) {
          press.bandAt = performance.now();
          clearTimeout(press.bandT);
          press.bandT = setTimeout(() => { if (press && sort) headMove({ pointerId: press.pid, clientX: press.px, clientY: press.py }); }, SPLIT_DWELL + 10);
        }
        if (performance.now() - press.bandAt < SPLIT_DWELL) tg = target(e.clientX, e.clientY, false);
      } else if (!tg.split) { press.bandAt = 0; clearTimeout(press.bandT); }
      next = { out, ...tg };
    } else next = { out, n: sort.n, split: sort.split, cols: sort.cols };
    if (out) { press.bandAt = 0; clearTimeout(press.bandT); }
    if (next.out !== sort.out || next.n !== sort.n || !sameCols(next.cols, sort.cols)) {
      if (next.out && !sort.out) { const el = cardEls[sort.v]; if (el) { sort.w = el.offsetWidth; sort.h = el.offsetHeight; } }
      const before = rects(sort.v);
      sort.out = next.out; sort.n = next.n; sort.split = next.split; sort.cols = next.cols;
      await tick();
      if (!sort) return;
      flip(before);
    }
    follow();
  }
  function headUp(e) {
    if (!press || e.pointerId !== press.pid) return;
    const p = press;
    press = null;
    clearTimeout(p.bandT);
    try { p.head.releasePointerCapture(p.pid); } catch {}
    const s = sort;
    if (!s) return;   // 没过门槛 = 普通点击
    document.body.style.userSelect = '';
    if (s.out) { sort = null; popOut(s.v, e, p, s); return; }
    // 落位：记下各卡（含拖着那张）此刻的视觉位置，落盘后一起滑进格子
    const before = rects();
    if (!sameCols(s.cols, s.start)) setDockCols(s.cols);
    sort = null;
    tick().then(() => flip(before));
  }
  // 取消（pointercancel / 丢了捕获 / Esc）：原样复原
  function headCancel(e) {
    if (!press || (e && e.pointerId != null && e.pointerId !== press.pid)) return;
    const p = press;
    press = null;
    clearTimeout(p.bandT);
    try { p.head.releasePointerCapture(p.pid); } catch {}
    if (!sort) return;
    document.body.style.userSelect = '';
    const before = rects();
    sort = null;
    tick().then(() => flip(before));
  }
  $effect(() => {
    if (!sort) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); headCancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // 双击标题行 = 放大 / 还原（同窗口标题栏的习惯）
  function headDbl(e, v) {
    if (card || !wide || e.target.closest?.('button')) return;
    toggleDockMax(v);
  }

  // —— 拖出窗口：一扇只放这张卡的窗口（像把浏览器标签页拖出来）——
  // 桌面壳：主窗口的 window.open 一律交给系统浏览器，走壳的 openChat IPC（同登录态；同一张卡、同一个
  // 工作空间再拖一次 = 聚焦已开的那扇）；网页：浏览器弹窗（同名窗口复用）。窗口大小取这张卡在工作台里
  // 的大小，开在松手处、指针落在新窗口标题栏上。
  const wsName = (ws) => String(ws || '').split(/[\\/]/).filter(Boolean).pop() || '';
  function popOut(v, e, p, s) {
    if (p.pop === 'old') { dropToast(tc('claude', '桌面客户端更新后才能把卡片拖成独立窗口')); return; }
    const url = cardUrl(v, { id: session.id || '', ws: dock.ws });
    const width = Math.round(Math.max(480, Math.min(1400, s.w || 560)));
    const height = Math.round(Math.max(420, Math.min(1200, (s.h || 640) + 32)));
    const x = Math.round(e.screenX - (p.fx ?? 0.5) * width);
    const y = Math.round(e.screenY - 16);
    const name = wsName(dock.ws);
    const title = titleOf(v) + (name ? ' · ' + name : '');
    // 工作台里这张先关掉（窗口要一会儿才出来，别让它弹回格子里闪一下）；没开成再摆回来
    closeDockView(v);
    const fail = (msg) => { dropToast(msg); if (dockToolOk(v)) openDock(v); };
    if (p.pop === 'shell') {
      let bg = '';
      try { bg = getComputedStyle(dockEl || document.documentElement).getPropertyValue('--dk-card').trim(); } catch {}
      Promise.resolve(bdOf().window.openChat({ url, key: `card:${v}:${dock.ws}`, title, x, y, width, height, bg }))
        .then((r) => { if (r && r.ok === false) fail(t('没能打开新窗口')); })
        .catch(() => fail(t('没能打开新窗口')));
      return;
    }
    let w = null;
    try { w = window.open(url, 'bridge-card-' + v, `popup=yes,width=${width},height=${height},left=${x},top=${y}`); } catch {}
    if (!w) fail(t('浏览器拦下了新窗口——允许本站弹出窗口后再拖一次'));
    else { try { w.focus(); } catch {} }
  }

  // 卡片窗口点「放回工作台」：主窗口（不是分屏格、不是别的独立窗）把这张卡摆回来
  $effect(() => {
    if (card || IS_SOLO || typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel(DOCK_CHANNEL);
    ch.onmessage = (e) => {
      const d = e.data;
      if (d?.t === 'back' && d.view && dockToolOk(d.view)) { openDock(d.view); try { window.focus(); } catch {} }
    };
    return () => ch.close();
  });
  // 无边框卡片窗口的窗控（桌面壳 card-window-preload.cjs 注入；网页弹窗 / 老壳没有 → 不摆这三颗，用系统标题栏）
  const winCtl = card && typeof window !== 'undefined' ? window.BridgeCardWindow || null : null;
  let winMax = $state(false);
  $effect(() => winCtl?.onMaximize?.((on) => { winMax = on; }));
  function dockBack() {
    try { const ch = new BroadcastChannel(DOCK_CHANNEL); ch.postMessage({ t: 'back', view: card, ws: dock.ws }); ch.close(); } catch {}
    setTimeout(() => window.close(), 40);
  }

  // meta 由 ensureDockMeta 统一拉（归属状态栏芯片 / 标题栏工具组在工作台没展开时就已经拉过，这里直接复用）
  $effect(() => { if (dock.open && dock.ws && !dock.meta) ensureDockMeta(); });

  // 安卓返回：收起工作台（预览层在 nav.js 里优先级更高、先被收掉）。
  // 侧列形态也注册——折叠屏展开仍是安卓、返回键该先收工作台；只有 expanded（桌面浏览器/
  // 大平板，通常没有系统返回键）不占这一层。
  $effect(() => { if (dock.open && !layout.expanded && !card) return pushBackLayer(closeDock); });

  // 桌面快捷键（浏览器可拦截的组合；Ctrl+T/W 这类浏览器保留键拦不了，不用）：开关对应那张卡。
  const KEYS = [
    { view: 'review', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyG' },
    { view: 'term', match: (e) => e.ctrlKey && !e.shiftKey && e.code === 'Backquote' },
    { view: 'browser', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyB' },
    { view: 'files', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyE' },
  ];
  $effect(() => {
    if (ui.screen !== 'claude' || card) return;
    const onKey = (e) => {
      for (const k of KEYS) {
        if (k.match(e)) {
          e.preventDefault();
          if (dockToolOk(k.view)) toggleDockView(k.view);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 本轮挂起等后台任务 → 「任务」chip 亮提示点（与 browserLive / termLive 同一语言）
  const bgLive = $derived(!!bgHoldNow());

  // —— 文件卡：把真·工作空间页原封不动挂进来（电脑走 Explorer 级 FilesDesktop、
  // 手机走 iOS 风 FilesPanel，二选一收在 WorkspaceEmbed 里）——
  // 缺省：挂载前先把 ui.filesPath 预置成工作空间目录（FilesPanel onMount 一次性消费），
  // 用 filesMount 门控挂载时序：effect 里先备好路径、下一轮渲染才 mount，读到的必是它。
  // 有定位目标（点了产物文件夹卡）：把 rel/ws 直接当 props 传下去，key 变化即重挂，
  // 同一次打开里连点不同文件夹也每次都落到对的目录。
  // .dk-embed 的 transform 让 FilesPanel 的 fixed 布局（根/浮层/菜单/弹层）全部圈进容器。
  let filesMount = $state(null);   // { key, ws, rel }（rel=null → 走 ui.filesPath 老路）
  const filesShown = $derived(shown.includes('files'));
  $effect(() => {
    if (!(filesShown && dock.meta)) { filesMount = null; return; }
    const ft = dock.filesTarget;
    if (ft) { filesMount = { key: 't' + ft.seq, ws: ft.ws || '', rel: ft.rel || '', open: ft.open || '' }; return; }
    // 工作空间在身份文件根之外（admin 常见：项目不在 vault 里）：以工作空间本身为根挂载，
    // 别再摆一句「打不开」——附件卡走的就是这条 ws 作用域，两边得一致。
    // （两种形态都把 ws 当起点：落进含它的位置——FilesDesktop 左侧全盘位置栏、FilesPanel 根部「位置」行。
    // key 带上 ws：换到另一个库外会话要重挂，起点只在挂载时落一次。）
    // 无 shell 的身份拿不到 ws 作用域（/api/files?ws= 一律 403），维持原来的说明文案。
    if (dock.meta.rel == null) {
      filesMount = dock.ws && !snapMode && dock.meta.shell !== false ? { key: 'wsroot:' + dock.ws, ws: dock.ws, rel: '' } : null;
      return;
    }
    ui.filesPath = dock.meta.rel;
    filesMount = { key: 'ws', ws: '', rel: null };
  });
  // ws 作用域下的根名（面包屑首段）：就用那个目录的名字。
  const filesRootName = $derived(filesMount?.ws ? (filesMount.ws.split(/[\\/]/).filter(Boolean).pop() || '') : '');
  // 内嵌区卸载（关卡片/切视图/切工作空间）时，若侧栏实例正开着预览，一并收掉——
  // 否则 preview.host='dock' 却没有实例在渲染，返回层还压着一层幽灵预览。
  $effect(() => {
    if (!filesMount) return;
    return () => { if (preview.open && preview.host === 'dock') closePreview(); };
  });
  // 文件卡和其它卡一样恒带标题行（放大 / 关闭）：从前工作空间页挂上后标题行让位、收起靠页面自己的 ‹，
  // 只有这一张卡长得不一样、不好上手。现在页面的 ‹ / ↑ 只管上一级（WorkspaceEmbed 传 hostChrome）。
  const exitFiles = () => (wide ? closeDockView('files') : closeDock());

  let sheetHandle = $state();
  let sheetScrim = $state();
  // 选中的 chip 恒在可视区里（窄屏「文件」排在最末，会落进右缘渐隐带）：横向滚到刚好露全
  // （转屏 / 折叠屏开合改了条宽也重算一次）
  let chipsEl = $state();
  function chipIntoView() {
    const box = chipsEl, on = box?.querySelector('.chip.on');
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
  // 手机 sheet 里正开着文件预览：进「阅读形态」——sheet 升到顶（只让出状态栏）、chip 条收起、
  // 预览头收成 44px。这时要的是看文件，工具切换点返回退出预览就回来了。
  const sheetPv = $derived(!wide && preview.open && (preview.host === 'dock' || preview.host === 'memory'));
</script>

{#snippet panelBody(view)}
  {#if isPluginView(view)}
    {@const w = workbenchByKey(view)}
    {#if w}<PluginWorkbench {w} />{:else}<div class="dk-wait">{t('这个插件页面不在了（插件被关掉或卸载了）')}</div>{/if}
  {:else if view === 'tasks'}
    <!-- 任务视图读的是本会话的对话状态，不按工作空间作用域、也不用等 meta -->
    <TasksPanel {wide} />
  {:else if view === 'memory' && dock.ws}
    <!-- 记忆：按工作目录找到 Claude 的记忆目录（服务端同 Claude Code 的找法），不用等 meta -->
    {#key dock.ws}<MemoryPanel ws={dock.ws} />{/key}
  {:else if !dock.ws}
    <div class="dk-wait">{t('工作空间加载中…')}</div>
  {:else}
    {#key dock.ws}
      {#if view === 'review'}<ReviewPanel />
      {:else if view === 'term'}<TermPanel />
      {:else if view === 'browser'}{#key browserSessionOf(dock)}<BrowserPanel readonly={snapMode} />{/key}
      {:else if view === 'files'}
        {#if filesMount}
          {#key filesMount.key}
            <div class="dk-embed">
              <WorkspaceEmbed {wide} guest={snapMode} ws={filesMount.ws} home={dock.ws} rootName={filesRootName} initialPath={filesMount.rel}
                initialOpen={filesMount.open || ''} onExit={exitFiles} />
              <MediaViewer host="dock" />
            </div>
          {/key}
        {:else if dock.meta?.gone}
          <div class="dk-wait">{t('该工作空间的文件夹已不存在（可能被移动或删除）')}</div>
        {:else if dock.meta && dock.meta.rel == null}
          <div class="dk-wait">{t('该工作空间在云端文件区之外，无法在侧栏打开工作空间页')}</div>
        {:else}
          <div class="dk-wait">{t('工作空间加载中…')}</div>
        {/if}
      {/if}
    {/key}
  {/if}
{/snippet}

{#if card}
<!-- 卡片窗口：整扇窗就是这一张卡。顶上是卡片原本那条标题行（标题 + 工作空间名 + 卡片同款圆钮），其余全给面板。
     桌面壳里窗口无边框（frameless）：标题行就是窗口拖拽带（双击放大 / 还原），右侧圆钮管这扇窗本身。 -->
<div class="dock cardwin" class:frameless={!!winCtl} bind:this={dockEl} aria-label={titleOf(card)}>
  <header class="dk-card-head dk-win-head">
    <span class="dk-card-t">{titleOf(card)}</span>
    {#if wsName(dock.ws)}<span class="dk-win-ws" title={dock.ws}>{wsName(dock.ws)}</span>{/if}
    <button class="dk-cbtn" aria-label={tc('claude', '放回工作台')} title={tc('claude', '放回工作台')} onclick={dockBack}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/><path d="M11.5 12H6.5m2.5-2.5L6.5 12 9 14.5"/></svg>
    </button>
    {#if winCtl}
      <button class="dk-cbtn" aria-label={t('最小化')} title={t('最小化')} onclick={() => winCtl.minimize()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6.5 12h11"/></svg>
      </button>
      <button class="dk-cbtn" aria-label={winMax ? t('还原') : t('放大')} title={winMax ? t('还原') : t('放大铺满')} onclick={() => winCtl.toggleMaximize()}>{@html dockIcon(winMax ? 'shrink' : 'expand')}</button>
      <button class="dk-cbtn" aria-label={t('关闭')} title={t('关闭')} onclick={() => winCtl.close()}>{@html dockIcon('close')}</button>
    {/if}
  </header>
  {@render panelBody(card)}
</div>
{:else if dock.open}
{#if wide}
<aside class="dock wide" class:mid class:overlay class:gripping class:two class:full={!!maxed} class:sorting={!!sort} bind:this={dockEl}
  style={curW ? `width:${curW}px` : ''} aria-label={t('工作台')}>
  <!-- 工具开关组：工作台展开时就坐在卡片正上方这条带里（收起时由 TopBar 挂在这一格右上角） -->
  <DockToolBar docked onClose={toolsClose} />
  {#if !maxed}<div class="dk-grip" role="separator" aria-label={t('拖拽调整宽度')} onpointerdown={gripDown} ondblclick={gripReset}></div>{/if}
  <div class="dk-cards" bind:this={cardsEl}>
    {#if emptyBox}<div class="dk-slot empty" style={emptyBox}></div>{/if}
    {#if slotBox}<div class="dk-slot" style={slotBox}></div>{/if}
    {#each cards as c (c.v)}
      <section class="dk-card" class:hid={!c.box} class:lifted={sort?.v === c.v} class:tearing={sort?.v === c.v && sort.out}
        style={c.box} aria-label={titleOf(c.v)} use:cardRef={c.v}>
        <!-- 标题行 = 拖拽把手：拖动排顺序，拖出 app 成独立窗口；双击放大 / 还原 -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <header class="dk-card-head" class:grab={pointer.fine}
          onpointerdown={(e) => headDown(e, c.v)} onpointermove={headMove} onpointerup={headUp}
          onpointercancel={headCancel} onlostpointercapture={headCancel} ondblclick={(e) => headDbl(e, c.v)}>
          <span class="dk-card-t">{titleOf(c.v)}</span>
          <button class="dk-cbtn" aria-label={maxed === c.v ? t('还原') : t('放大')} title={maxed === c.v ? t('还原') : t('放大铺满')} onclick={() => toggleDockMax(c.v)}>{@html dockIcon(maxed === c.v ? 'shrink' : 'expand')}</button>
          <button class="dk-cbtn" aria-label={closeLabelOf(c.v)} title={t('关闭')} onclick={() => closeDockView(c.v)}>{@html dockIcon('close')}</button>
        </header>
        {@render panelBody(c.v)}
      </section>
    {/each}
  </div>
</aside>
{:else}
<!-- 移动端：底部 sheet（dimensio 手机端同款交互）——scrim 点击关、把手下拉关、chip 直切工具 -->
<div class="sheetwrap">
  <button class="sheet-scrim" bind:this={sheetScrim} aria-label={t('关闭工作台')} onclick={closeDock}></button>
  <div class="dock sheet" class:pv={sheetPv} use:dragSheet={{ onClose: closeDock, handle: () => sheetHandle ?? null, scrim: () => sheetScrim ?? null }}>
    <div class="grip-zone" bind:this={sheetHandle}>
      <span class="grip"></span>
      <!-- 收起钮钉在右上角、不随 chip 横滑：窄屏五个 chip 放不下时它曾被挤出屏外，
           哪个工具（包括文件）的收起都在同一个固定位置 -->
      <div class="dk-chiprow">
        <div class="dk-chips" bind:this={chipsEl}>
          {#each MENU as m (m.key)}
            <button class="chip" class:on={mView === m.key} onclick={() => pickTool(m.key)}>
              <span class="chip-ic">{@html dockToolIcon(m.key)}</span>
              {m.label}
              {#if (m.key === 'browser' && browserMountedNow()) || (m.key === 'term' && dock.termLive && mView !== 'term') || (m.key === 'tasks' && bgLive && mView !== 'tasks')}<span class="dk-live"></span>{/if}
            </button>
          {/each}
        </div>
        <button class="chip-fold" aria-label={t('收起工作台')} onclick={closeDock}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg>
        </button>
      </div>
    </div>
    {@render panelBody(mView)}
  </div>
</div>
{/if}
{/if}

<style>
  .dock { display: flex; flex-direction: column; background: var(--bg); }

  /* —— 宽屏：常驻右列，与对话分栏 ——
     顶上留一条带：这一格的工具开关组（TopBar tools，宿主挂在这一格右上角）就坐在里面，卡片从带下开始。
     · 网页 / 平板：带高 = 工具组（top 10 + 36）+ 8px 缝。
     · 桌面壳 WCO：带 = 窗控标题栏带（--wco-h），工具组收成 32px 和最小化/关闭同一排，其余是窗口拖拽区；
       分屏的 iframe 那一格由宿主告知带高、挂 data-wco-band，同一条线。
     子树里 --sat / --wco-right 归零：根部已经吃掉了顶部的「别人的地盘」，里面的面板头、内嵌文件页、
     查看器头不必再各自避让（归零必须挂在子节点上——同一元素上引用自己刚声明的变量拿的是新值）。
     卡片色：比页面底略亮一档 + 一圈细线 + 12px 圆角 + 8px 缝（官方实测：底 #141414、卡 #191919）。 */
  .dock.wide {
    --dk-card: #262625; --dk-line: rgba(255, 255, 255, .085);
    position: relative; flex: none; width: clamp(400px, 44%, 760px); min-width: 360px; max-width: 78%;
    padding: calc(var(--sat) + 54px) 8px 8px 6px;
    /* 带里的工具开关组要读这一格的安全区 / 窗控宽度，而子树里这两个变量归零了——先在本元素上存一份
       （var 在声明处解析，子节点继承的是算好的值）。窗控宽度封个顶，免得几何读数异常把它推出工作台。 */
    --dk-sat: var(--sat, 0px); --dk-wco-r: min(var(--pane-wco-r, var(--wco-right, 0px)), 240px);
  }
  /* 入场动画只给卡片：工具开关组从这一格右上角交接到带里，位置不变，不该跟着滑一下 */
  .dock.wide > .dk-cards { animation: dockInW .22s ease; }
  @media (pointer: coarse) { .dock.wide { padding-top: calc(var(--sat) + 58px); } }
  :global(html[data-theme="light"]) .dock.wide { --dk-card: #ffffff; --dk-line: rgba(0, 0, 0, .09); }
  :global(html[data-wco="1"]) .dock.wide, :global(html[data-wco-band="1"]) .dock.wide { padding-top: var(--wco-h, 40px); }
  .dock.wide > * { --sat: 0px; --wco-right: 0px; }
  /* 两列：默认更宽（两列各自够用），给对话留 ≥360 */
  .dock.wide.two { width: clamp(640px, 62%, 1180px); min-width: 560px; max-width: calc(100% - 360px); }
  /* medium（折叠屏展开 ~750px / 竖屏平板）：默认占一半多一点，给正文留住 300px 下限。
     min-width 一并降到 300，否则 max-width 钳不动、面板会顶破视口。 */
  .dock.wide.mid { width: clamp(320px, 52%, 560px); min-width: 300px; max-width: calc(100% - 300px); }
  /* 盖在正文上（分屏的窄格）：贴这一格的右缘整高浮起，正文不让位；留 48px 给正文露个边，
     一眼看得出下面还是对话。宽度照旧吃拖拽持久值，钳到这一格之内。 */
  .dock.wide.overlay { position: absolute; top: 0; right: 0; bottom: 0; z-index: 32;
    width: clamp(360px, 62%, 640px); min-width: min(360px, calc(100% - 48px)); max-width: calc(100% - 48px);
    box-shadow: -14px 0 44px rgba(0, 0, 0, .28); animation: dockInOver .22s ease; }
  /* 放大：一张卡铺满这一格（对话暂时让出来），顶上的带和工具组照旧 */
  .dock.wide.full { position: absolute; inset: 0; z-index: 33; width: auto; min-width: 0; max-width: none; padding-left: 8px; box-shadow: none; animation: none; }
  @keyframes dockInOver { from { opacity: .4; transform: translateX(28px); } to { opacity: 1; transform: none; } }
  .dock.wide.gripping { animation: none; }
  .dock.gripping :global(iframe) { pointer-events: none; }
  @keyframes dockInW { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
  /* 左缘拖拽把手：7px 命中区，悬停/拖动时亮出 2px 指示线；双击复位默认宽。
     命中区整条落在工作台这一侧（左 6px 内边距 + 卡片 1px 边框），一点不伸进正文列：正文列的滚动条槽
     （10px）就贴在这条接缝左边，以前 left:-4px 骑缝会盖住拇指右侧、点滑块变成拖宽度（11-08 维护者报）。 */
  /* no-drag：WCO 下工作台顶上那条标题栏带是窗口拖拽区，把手是 div 不在全局免拖名单里，不打洞的话顶端 40px 拖不动宽度 */
  .dk-grip { position: absolute; left: 0; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 5; touch-action: none; -webkit-app-region: no-drag; }
  .dk-grip::after { content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 2px; background: transparent; transition: background-color .15s ease; }
  @media (hover: hover) { .dk-grip:hover::after { background: color-mix(in srgb, var(--muted) 45%, transparent); } }
  .dock.gripping .dk-grip::after { background: var(--coral); }

  .dk-cards { position: relative; flex: 1; min-height: 0; }
  /* 卡片里 --bg 换成卡片色：终端（xterm 底色从所在元素现取）、面板里的吸顶条 / 渐隐带都画在卡片上 */
  .dk-card {
    position: absolute; display: flex; flex-direction: column; overflow: hidden;
    border-radius: 12px; border: 1px solid var(--dk-line); background: var(--dk-card); --bg: var(--dk-card);
    animation: dkCardIn .2s ease;
  }
  .dk-card.hid { display: none; }
  @keyframes dkCardIn { from { opacity: 0; transform: translateY(6px); } }
  .dk-card-head { flex: none; display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 5px 0 13px; touch-action: none; user-select: none; }
  .dk-card-head.grab { cursor: grab; }
  /* 拖动排序：拿起的那张浮在最上、投影加深，跟着指针走（inline transform 每帧改，不加过渡）；
     落点是一圈虚线框，随排布滑到新格子；拖出窗口时半透明，示意「松手就成独立窗口」 */
  .dk-card.lifted { z-index: 6; animation: none; box-shadow: 0 22px 54px rgba(0, 0, 0, .42), 0 4px 14px rgba(0, 0, 0, .22);
    transition: opacity .16s ease, box-shadow .16s ease; }
  .dk-card.tearing { opacity: .6; }
  .dock.sorting, .dock.sorting .dk-card-head { cursor: grabbing; }
  .dock.sorting :global(iframe) { pointer-events: none; }
  .dk-slot { position: absolute; border-radius: 12px; pointer-events: none;
    border: 1.5px dashed color-mix(in srgb, var(--muted) 42%, transparent);
    background: color-mix(in srgb, var(--muted) 7%, transparent);
    transition: left .26s cubic-bezier(.2, .8, .2, 1), top .26s cubic-bezier(.2, .8, .2, 1), width .26s cubic-bezier(.2, .8, .2, 1), height .26s cubic-bezier(.2, .8, .2, 1);
    animation: dkSlotIn .16s ease; }
  .dk-slot.empty { border-color: color-mix(in srgb, var(--muted) 22%, transparent); background: none; transition: none; }
  @keyframes dkSlotIn { from { opacity: 0; } }

  /* —— 卡片窗口（拖出 app 的那一张）：整扇窗就是卡片底色，顶上一条细标题行 —— */
  .dock.cardwin { --dk-card: #262625; --dk-line: rgba(255, 255, 255, .085);
    flex: 1; min-height: 0; background: var(--dk-card); --bg: var(--dk-card); }
  :global(html[data-theme="light"]) .dock.cardwin { --dk-card: #ffffff; --dk-line: rgba(0, 0, 0, .09); }
  /* 标题行就是卡片那条（.dk-card-head：38px、标题 13.5px、28px 圆钮），只多一个工作空间名；
     无边框窗口里整条是窗口拖拽带，圆钮打洞 */
  .dk-win-head { cursor: default; }
  .dock.cardwin.frameless .dk-win-head { -webkit-app-region: drag; }
  .dock.cardwin.frameless .dk-win-head .dk-cbtn { -webkit-app-region: no-drag; }
  .dk-cbtn svg { width: 15px; height: 15px; }
  .dk-win-ws { min-width: 0; margin-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--muted); }
  .dk-card-t { font-size: 13.5px; color: var(--serif); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .dk-cbtn { width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .dk-cbtn:first-of-type { margin-left: auto; }
  .dk-cbtn :global(svg) { width: 15px; height: 15px; }
  .dk-cbtn:active { background: var(--hover-strong); }
  @media (hover: hover) { .dk-cbtn:hover { background: var(--hover); color: var(--text); } }

  .dk-live { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: dkPulse 1.2s ease-in-out infinite; flex: none; }
  @keyframes dkPulse { 50% { opacity: .35; } }
  .dk-wait { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; padding: 0 24px; text-align: center; line-height: 1.7; }
  /* 内嵌真·工作空间页：transform 造 containing block，FilesPanel 的 fixed 根/浮层全被圈进本容器 */
  .dk-embed { flex: 1; min-height: 0; position: relative; overflow: hidden; transform: translateZ(0); }

  /* —— 移动端底部 sheet（dimensio psheet 同款规格，Claude 皮）—— */
  .sheetwrap { position: fixed; inset: 0; z-index: 58; display: flex; align-items: flex-end; }
  .sheet-scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, .45); animation: scrimIn .24s ease; }
  @keyframes scrimIn { from { opacity: 0; } }
  .dock.sheet { position: relative; width: 100%; height: calc(100dvh - 52px - var(--sat)); border-radius: 20px 20px 0 0;
    padding-bottom: max(var(--sab), var(--kb, 0px));
    box-shadow: 0 -10px 44px rgba(0, 0, 0, .35); overflow: hidden;
    animation: sheetUp .36s cubic-bezier(.32, .9, .35, 1) both;
    transition: transform .3s cubic-bezier(.32, .9, .35, 1), height .3s cubic-bezier(.32, .9, .35, 1); }
  @keyframes sheetUp { from { transform: translateY(52%); opacity: .7; } }
  /* sheet 顶边本就在状态栏之下、底边已吃掉 sab/键盘：子树里安全区归零。否则内嵌工作空间页与
     预览头会在 sheet 里再让一遍状态栏，chip 条下凭空多出一条 ~40px 的空带。（同 .dock.wide > *） */
  .dock.sheet > * { --sat: 0px; --sab: 0px; }
  /* 阅读形态（sheet 内开着预览）：升到顶、chip 条收起、预览头压扁（变量由各查看器头读） */
  .dock.sheet.pv { height: calc(100dvh - var(--sat) - 6px); --pv-pad-y: 4px; --pv-bar-h: 44px; }
  .dock.sheet.pv .dk-chiprow { display: none; }
  .grip-zone { flex: none; touch-action: none; }
  .grip { display: block; width: 38px; height: 4.5px; border-radius: 3px; background: var(--divider); margin: 8px auto 2px; }
  .dock.sheet.pv .grip { margin: 6px auto 5px; }

  /* 工具切换条：chip 直切（移动端没有菜单层级） */
  .dk-chiprow { display: flex; align-items: center; padding: 6px 8px 8px 0; }
  /* 右缘渐隐：被截住的 chip 一看就知道还能横滑 */
  .dk-chips { flex: 1; min-width: 0; display: flex; align-items: center; gap: 5px; padding: 0 14px 0 10px; overflow-x: auto; scrollbar-width: none;
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 18px), transparent); }
  .dk-chips::-webkit-scrollbar { display: none; }
  .chip { flex: none; display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px; border-radius: 11px;
    color: var(--muted); font-size: 13px; transition: background-color .14s ease, color .14s ease; }
  .chip:active { transform: scale(.97); }
  .chip.on { background: var(--card); color: var(--text); box-shadow: var(--card-shadow); }
  .chip-ic { width: 16px; height: 16px; display: flex; flex: none; }
  .chip-ic :global(svg) { width: 100%; height: 100%; }
  .chip-fold { margin-left: 2px; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; }
  .chip-fold svg { width: 17px; height: 17px; }
  .chip-fold:active { background: var(--hover); }
</style>
