// Claude 页·分屏：宽屏两个对话并排（本页一格 + 同源 iframe 里的 SoloPage 一格）、分隔条、拖进正文区的落点与引用区。

import { ui, session, setTheme } from '../state.svelte.js';
import { untrack } from 'svelte';
import { openSession } from '../chat.svelte.js';
import { dock, closeDock } from '../dock.svelte.js';
import { splitDropPlan, splitDropLabel, canSplitWidth, MIN_PANE } from '../claudeSplit.js';
import { soloUrl, PANE_MSG, isPaneMsg } from '../solo.js';
import { openSettings } from '../settingsNav.svelte.js';   // 分屏格托宿主页开设置（onPaneMsg 的 settings）
import { wcoHeight, wcoRightInset } from '../../desktop/chrome/wco.svelte.js';
import { canQuote, quoteSession } from '../chatQuote.js';
import { t, tc } from '../i18n.js';

/** @param {any} pc 页面上下文：各区段经它互相取用（getter / setter，见 ClaudePage.svelte） */
export function createSplitPanes(pc) {
  // ═══════════════════════ 分屏（宽屏两个对话并排）═══════════════════════
  // 两格不对称：一格是本页（单例聊天内核），另一格是同源 iframe 里的一份 SoloPage（自带内核）。
  // split = { side, initId }：iframe 那一格在哪边、它最初开的会话（iframe 的 src——之后换会话走消息，不重载）。
  // 只做左右两格、分屏不跨刷新保留（与 dimensio 分屏同一取舍）；窗口窄到放不下两格就收掉分屏。
  let split = $state(null);
  let paneId = $state(null);       // iframe 那一格此刻开着的会话（它自己报上来的）
  let paneFocus = $state(false);   // 焦点在 iframe 那一格
  let paneReady = $state(false);
  let paneFrame = $state();
  let panesW = $state(0);          // 正文区（两格 + 分隔条）总宽
  let mainPaneW = $state(0);       // 本页这一格的宽（决定工作台盖着还是挤开）
  // 量宽度不用 bind:clientWidth：本页是 keep-alive 分页，挂载时在 display:none 里量到 0，露出来之后
  // bind 那条路不再回报（实测 DOM 已是 1310、绑定值一直是 0，分屏因此判成「放不下」）。自己挂
  // ResizeObserver，另在分页露出时补量一次。
  function measureW(node, set) {
    const read = () => set(node.clientWidth);
    const ro = new ResizeObserver(read);
    ro.observe(node);
    read();
    return { update(next) { set = next; read(); }, destroy() { ro.disconnect(); } };
  }
  let measureTick = $state(0);
  $effect(() => { if (ui.screen === 'claude') requestAnimationFrame(() => { measureTick++; }); });
  const SPLIT_LS = 'bridge-claude-split-r';
  let splitR = $state((() => { const v = +(localStorage.getItem(SPLIT_LS) || 0); return v > 0.1 && v < 0.9 ? v : 0.5; })());
  const splitAllowed = $derived(pc.wide && canSplitWidth(panesW));
  const splitOn = $derived(!!split && splitAllowed);
  // 窗口缩到放不下两格：分屏收掉（本页那一格留着）。panesW 为 0 是还没量到，不算。
  $effect(() => { if (split && panesW > 0 && !splitAllowed) untrack(closePane); });
  const paneSrc = $derived(split ? soloUrl(split.initId, { pane: true }) : '');
  const mainSide = $derived(split && split.side === 'left' ? 'right' : 'left');
  const leftBasis = $derived(`calc(${(splitR * 100).toFixed(3)}% - 3px)`);
  const paneStyle = (side) => (side === 'left' ? `order:0;flex:0 0 ${leftBasis};` : 'order:2;flex:1 1 0;');
  // 侧栏高亮：有焦点那一格的会话是「当前」，另一格的会话浅一档
  const curId = $derived(splitOn && paneFocus ? paneId : session.id);
  const altId = $derived(splitOn ? (paneFocus ? session.id : paneId) : null);

  let paneProjId = null;   // 非响应式：那一格当前会话（或空白对话）所在的项目（它的 session 消息报上来的）
  const postPane = (msg) => { try { paneFrame?.contentWindow?.postMessage({ [PANE_MSG]: 1, ...msg }, location.origin); } catch {} };
  function focusPane() { paneFocus = true; try { paneFrame?.contentWindow?.focus(); } catch {} }
  function enterSplit(id, side) {
    closeDock();                   // 分屏时工作台默认收着（两格各自右上角的工具开关再打开）
    paneId = id; paneReady = false; paneFocus = true;
    split = { side, initId: id };
  }
  function closePane() { split = null; paneId = null; paneProjId = null; paneFocus = false; paneReady = false; }
  // 关掉本页这一格：iframe 那一格的对话接到本页来，分屏结束
  function closeMain() {
    const id = paneId;
    closePane();
    if (id) { session.projectId = pc.sessions.find((s) => s.id === id)?.projectId || null; openSession(id); }
  }
  $effect(() => { dock.noAuto = splitOn; });
  function onPaneMsg(e) {
    if (!paneFrame || e.source !== paneFrame.contentWindow || !isPaneMsg(e)) return;
    const d = e.data;
    if (d.t === 'ready') paneReady = true;
    else if (d.t === 'focus') { paneFocus = true; window.dispatchEvent(new Event('bridge-pane-away')); }
    else if (d.t === 'session') { paneId = d.id || null; paneProjId = typeof d.projectId === 'string' ? d.projectId : null; if (d.id && !pc.sessions.some((s) => s.id === d.id)) pc.refreshSoon(); }
    else if (d.t === 'close') closePane();
    else if (d.t === 'settings') openSettings(typeof d.sec === 'string' ? d.sec : null);   // 格里的「打开设置」（如回退横条）：设置外壳只挂在宿主页
    else if (d.t === 'search') pc.searchOpen = true;   // 焦点在分屏那一格里按 Ctrl+K：搜索面板开在整页上（SoloPage 转来）
    else if (d.t === 'newchat') { paneFocus = true; pc.searchOpen = false; pc.newChat(); }   // 那一格里按了新对话快捷键（SoloPage 转来）：开在那一格
  }
  $effect(() => {
    window.addEventListener('message', onPaneMsg);
    return () => window.removeEventListener('message', onPaneMsg);
  });
  // 桌面壳全局快捷键「新会话」（App.svelte 转来）：和侧栏「新对话」走同一套落点规则；接住了就 preventDefault，
  // 本页没挂着时 App 自己回落到默认工作空间
  $effect(() => {
    const onNew = (e) => { e.preventDefault(); pc.searchOpen = false; pc.newChat(); };
    window.addEventListener('bridge:newchat', onNew);
    return () => window.removeEventListener('bridge:newchat', onNew);
  });
  // 分屏时在本页任何地方按下（侧栏 / 本格）：告诉那一格收起它开着的弹层（⋮ 菜单）——
  // 它是另一份文档，收不到本页的 pointerdown。反方向见 onPaneMsg 的 focus。
  $effect(() => {
    if (!splitOn) return;
    const down = () => postPane({ t: 'away' });
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  });
  // 桌面壳：iframe 那一格贴着窗口右缘时，告诉它右上被系统窗控占了多宽（它的工作台首行要让出来）
  $effect(() => {
    if (!splitOn || !paneReady) return;
    const right = split.side === 'right' ? wcoRightInset() : 0;
    const h = wcoHeight();
    untrack(() => postPane({ t: 'wco', h, right }));
  });
  // 主题跟着别的窗口（拖出去的对话窗 / 分屏格）走
  $effect(() => {
    const onStorage = (e) => { if (e.key === 'bridge-theme' && e.newValue && e.newValue !== ui.theme) setTheme(e.newValue); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });

  // 分隔条拖动调两格比例（两格都不窄于 MIN_PANE；双击回五五开）。拖动期间 iframe 不吃指针，
  // 否则指针一滑进 iframe 事件就进了它的文档、这边再也收不到 move。
  let splitDragging = $state(false);
  function splitGripDown(e) {
    const host = e.currentTarget.parentElement;
    if (!host) return;
    e.preventDefault();
    const r = host.getBoundingClientRect();
    const el = e.currentTarget;
    splitDragging = true;
    try { el.setPointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = 'none';
    const mv = (ev) => {
      const lo = MIN_PANE / r.width, hi = 1 - lo;
      splitR = Math.max(lo, Math.min(hi, (ev.clientX - r.left) / r.width));
    };
    const up = () => {
      splitDragging = false; document.body.style.userSelect = '';
      el.removeEventListener('pointermove', mv);
      try { localStorage.setItem(SPLIT_LS, String(splitR)); } catch {}
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  }
  function splitGripReset() { splitR = 0.5; try { localStorage.removeItem(SPLIT_LS); } catch {} }

  // —— ② 会话拖进正文区：落点层盖在两格之上（iframe 拖拽期间不吃指针，事件才到得了这一层）——
  let splitHover = $state(null);   // 'left' | 'right'
  const blankMain = $derived(!session.id && ui.view === 'greeting');
  const splitBoundary = $derived(splitOn ? panesW * splitR : panesW / 2);
  function planFor(side) {
    const id = pc.sideDrag?.id || pc.dragRec?.id;
    if (!splitOn && !splitAllowed) return id === session.id ? { kind: 'none' } : { kind: 'open' };
    return splitDropPlan({ split: splitOn, paneSide: split?.side || 'right', blank: blankMain, mainId: session.id, paneId, draggedId: id, side });
  }
  const hoverPlan = $derived(splitHover ? planFor(splitHover) : null);
  const hoverLabel = $derived(hoverPlan ? splitDropLabel(hoverPlan, splitHover) : '');
  // 高亮区：分屏中＝两格各自的范围；没分屏＝左右各半（当前是空白对话＝整块「打开」）；放不下分屏＝整块一个「打开」
  const dropZones = $derived((splitOn || splitAllowed) && !(blankMain && !splitOn)
    ? [{ side: 'left', l: 0, w: splitBoundary }, { side: 'right', l: splitBoundary, w: Math.max(0, panesW - splitBoundary) }]
    : [{ side: 'left', l: 0, w: panesW }]);
  // —— ④ 会话拖到某一格的【输入栏】上＝引用那段对话（不分屏、不切换）——
  // 落点层盖在两格之上，输入卡片在它底下收不到 dragover，所以起拖时量出每一格输入卡片的位置，
  // 在落点层里单独画一块「引用」区（虚线框，悬停才写明动作）。iframe 那一格同源，直接量它文档里的卡片。
  let splitDropEl = $state();
  let mainColEl = $state();
  let quoteRects = $state([]);     // [{ target:'main'|'pane', l, t, w, h }]，坐标相对落点层
  let quoteHover = $state(null);   // 'main' | 'pane'
  function measureQuoteRects() {
    if (!splitDropEl) return;
    const host = splitDropEl.getBoundingClientRect();
    const out = [];
    const add = (target, r, dx = 0, dy = 0) => {
      if (!r || r.width < 60 || r.height < 24) return;
      const pad = 6;
      out.push({ target, l: r.left + dx - host.left - pad, t: r.top + dy - host.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
    };
    try { add('main', mainColEl?.querySelector('.composer')?.getBoundingClientRect()); } catch {}
    if (splitOn && paneFrame) {
      try {
        const fr = paneFrame.getBoundingClientRect();
        add('pane', paneFrame.contentDocument?.querySelector('.composer')?.getBoundingClientRect(), fr.left, fr.top);
      } catch {}
    }
    quoteRects = out;
  }
  // 落点层随 sideDrag 显形（下一拍才挂上 DOM），挂上之后量一次；拖拽中窗口一般不变，不追踪
  $effect(() => {
    if (pc.sideDrag?.kind === 'session' && splitDropEl) untrack(measureQuoteRects);
    else { quoteRects = []; quoteHover = null; }
  });
  const quoteTargetId = (target) => (target === 'pane' ? paneId : session.id);
  // 本页那一格还要查「已经引用过」（compose 就是它的）；那一格的去重在它自己的 quoteSession 里
  const quoteOk = (target) => {
    const id = pc.sideDrag?.id || pc.dragRec?.id;
    return target === 'pane' ? !!id && id !== paneId : canQuote(id, session.id);
  };
  function quoteLabelFor(target) {
    const id = pc.sideDrag?.id || pc.dragRec?.id;
    if (id && id === quoteTargetId(target)) return tc('claude', '不能引用对话自己');
    if (!quoteOk(target)) return t('这个对话已经引用过了');
    return target === 'main' ? pc.quoteLabel() : tc('claude', '引用到这个对话');
  }
  function quoteInto(target, rec) {
    if (target === 'pane') { postPane({ t: 'quote', id: rec.id, title: rec.title }); focusPane(); }
    else { paneFocus = false; quoteSession({ id: rec.id, title: rec.title }); }
  }

  function onSplitOver(e) {
    if (pc.dragRec?.kind !== 'session') return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const qx = e.clientX - r.left, qy = e.clientY - r.top;
    const q = quoteRects.find((z) => qx >= z.l && qx <= z.l + z.w && qy >= z.t && qy <= z.t + z.h);
    if (q) {
      quoteHover = q.target; splitHover = null;
      try { e.dataTransfer.dropEffect = quoteOk(q.target) ? 'copy' : 'none'; } catch {}
      return;
    }
    quoteHover = null;
    const side = dropZones.length > 1 ? (e.clientX - r.left < splitBoundary ? 'left' : 'right') : 'left';
    splitHover = side;
    try { e.dataTransfer.dropEffect = planFor(side).kind === 'none' ? 'none' : 'move'; } catch {}
  }
  function onSplitLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) { splitHover = null; quoteHover = null; } }
  function onSplitDrop(e) {
    const rec = pc.dragRec;
    if (!rec || rec.kind !== 'session') return;
    e.preventDefault();
    if (quoteHover) {
      const target = quoteHover;
      quoteHover = null; splitHover = null;
      pc.dropDone = true;
      if (quoteOk(target)) quoteInto(target, rec);
      return;
    }
    const side = splitHover || 'left';
    const plan = planFor(side);
    splitHover = null;
    pc.dropDone = true;
    if (plan.kind === 'open' || (plan.kind === 'replace' && plan.target === 'main')) {
      paneFocus = false;
      session.projectId = rec.projectId || null;
      openSession(rec.id);
    } else if (plan.kind === 'split') {
      enterSplit(rec.id, plan.side);
    } else if (plan.kind === 'replace') {
      postPane({ t: 'open', id: rec.id });
      focusPane();
    } else if (plan.kind === 'swap') {
      split = { ...split, side: split.side === 'left' ? 'right' : 'left' };
    }
  }

  return {
    get split() { return split; }, set split(v) { split = v; },
    get paneId() { return paneId; }, set paneId(v) { paneId = v; },
    get paneFocus() { return paneFocus; }, set paneFocus(v) { paneFocus = v; },
    get paneFrame() { return paneFrame; }, set paneFrame(v) { paneFrame = v; },
    get panesW() { return panesW; }, set panesW(v) { panesW = v; },
    get mainPaneW() { return mainPaneW; }, set mainPaneW(v) { mainPaneW = v; },
    measureW,
    get measureTick() { return measureTick; }, set measureTick(v) { measureTick = v; },
    get splitOn() { return splitOn; },
    get paneSrc() { return paneSrc; },
    get mainSide() { return mainSide; },
    get paneStyle() { return paneStyle; },
    get curId() { return curId; },
    get altId() { return altId; },
    get paneProjId() { return paneProjId; }, set paneProjId(v) { paneProjId = v; },
    get postPane() { return postPane; },
    focusPane,
    closePane,
    closeMain,
    get splitDragging() { return splitDragging; }, set splitDragging(v) { splitDragging = v; },
    splitGripDown,
    splitGripReset,
    get splitHover() { return splitHover; }, set splitHover(v) { splitHover = v; },
    get hoverPlan() { return hoverPlan; },
    get hoverLabel() { return hoverLabel; },
    get dropZones() { return dropZones; },
    get splitDropEl() { return splitDropEl; }, set splitDropEl(v) { splitDropEl = v; },
    get mainColEl() { return mainColEl; }, set mainColEl(v) { mainColEl = v; },
    get quoteRects() { return quoteRects; }, set quoteRects(v) { quoteRects = v; },
    get quoteHover() { return quoteHover; }, set quoteHover(v) { quoteHover = v; },
    get quoteOk() { return quoteOk; },
    quoteLabelFor,
    quoteInto,
    onSplitOver,
    onSplitLeave,
    onSplitDrop,
  };
}
