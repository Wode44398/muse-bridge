// Claude 页·侧栏拖放：项目块排序、会话拖进正文区分屏 / 拖出窗口、会话引用到另一条会话（鼠标走 HTML5 拖拽，手指走长按拿起）。

import { api } from '../api.js';
import { uiAlert } from '../dialogs.js';
import { ui, session } from '../state.svelte.js';
import { untrack } from 'svelte';
import { openSession } from '../chat.svelte.js';
import { titleFor } from '../library.svelte.js';
import { pointer } from '../layout.svelte.js';
import { drag, beginDrag, makeHold, dropToast, scrollEdges } from '../dragdrop.svelte.js';
import { moveId } from '../claudeSplit.js';
import { soloUrl } from '../solo.js';
import { CHAT_REF, canQuote, quoteSession } from '../chatQuote.js';
import { IS_CSNAP } from '../csnap.js';
import { t, tc, tr } from '../i18n.js';

/** @param {any} pc 页面上下文：各区段经它互相取用（getter / setter，见 ClaudePage.svelte） */
export function createSideDnd(pc) {
  // ═══════════════════════ 侧栏拖放（claude.ai 同款）═══════════════════════
  // 三件事：① 项目块拖动换位置；② 会话拖进正文区左/右半边 = 分屏并排两个对话；
  // ③ 会话拖到 app 外面松手 = 新开一个只放这个对话的窗口（像把浏览器标签页拖出去，但侧栏那一条不动）。
  // 鼠标走浏览器原生 HTML5 拖拽——只有它能把拖拽带出窗口（系统级拖拽图跟着指针走到桌面上）；
  // 手指（手机抽屉 / 折叠屏）走全站那套「长按拿起」（lib/dragdrop.svelte.js），只做项目排序：
  // 分屏要宽屏、拖出窗口手机上不存在。
  const SIDE_DT = 'application/x-bridge-claude-side';
  const mouseDnd = $derived(pointer.fine && !IS_CSNAP);
  let sideDrag = $state(null);     // 正在拖的：{ kind:'session'|'project', id, title }（驱动落点显形）
  let dragRec = null;              // 同一份的非响应式副本：dragstart/dragend 同步读，别等 Svelte flush
  let dragOut = false;             // 指针出了窗口（贴着视口边缘、relatedTarget=null 的 dragleave）
  let dropDone = false;            // 本页某个落点接住了这次拖拽（dragend 据此绝不再判「拖出窗口」）
  let insAt = $state(-1);          // 项目排序的插入位（0..n，n = 放到最后）；-1 = 没在排
  const EDGE = 48, EDGE_MAX = 14;  // 项目排序边缘自动滚动：感应带高度、贴边时每 16ms 的最大位移

  // 拖拽图：浏览器默认把整行截图（半透明、带着悬停底色），换成一颗干净的卡片。元素须真在文档里
  // 渲染过才能被 setDragImage 采样——挂到屏幕外、下一拍就摘掉。样式在 app.css（.bridge-side-ghost）。
  function dragGhost(e, text, kind) {
    try {
      const g = document.createElement('div');
      g.className = 'bridge-side-ghost' + (kind === 'project' ? ' proj' : '');
      if (kind === 'project') {
        const ic = document.createElement('span');
        ic.className = 'ic';
        ic.textContent = '\ue0c9';
        g.append(ic);
      }
      const tx = document.createElement('span');
      tx.className = 't';
      tx.textContent = text;
      g.append(tx);
      document.body.appendChild(g);
      e.dataTransfer.setDragImage(g, 16, Math.round(g.offsetHeight / 2) || 16);
      setTimeout(() => g.remove(), 0);
    } catch {}
  }
  function startSide(e, rec) {
    e.stopPropagation();
    dragRec = rec;
    dragOut = false;
    dropDone = false;
    try {
      e.dataTransfer.setData(SIDE_DT, JSON.stringify({ kind: rec.kind, id: rec.id }));
      // 会话：分屏/打开/引用；项目：侧栏排序或拖入输入栏引用文件夹
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch {}
    dragGhost(e, rec.title, rec.kind);
    // dragstart 里同步改 DOM（落点层显形、项目组收起）会让 Chromium 当场取消这次拖拽——下一拍再动
    setTimeout(() => { if (dragRec === rec) sideDrag = rec; }, 0);
  }
  function onSessDragStart(e, s) {
    if (!mouseDnd) { e.preventDefault(); return; }
    startSide(e, { kind: 'session', id: s.id, title: tr(titleFor(s.id, s.title)) || t('（无标题）'), projectId: s.projectId || null });
  }
  function onProjDragStart(e, p) {
    if (!mouseDnd) { e.preventDefault(); return; }
    projList = e.currentTarget?.closest?.('.d-projs') || null;
    startSide(e, { kind: 'project', id: p.id, path: p.path || '', title: tr(p.name) });
  }
  // 会话拖到侧栏【另一条会话】上松手＝切到那条并引用拖着的这段（手指那套见 sessionDrop）。
  // 那一条正开在分屏另一格里就引用进那一格，不把它抢到本页来。
  let rowHover = $state(null);
  function onRowDragOver(e, s) {
    if (dragRec?.kind !== 'session' || !canQuote(dragRec.id, s.id)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    rowHover = s.id;
  }
  function onRowDragLeave(e, s) { if (rowHover === s.id && !e.currentTarget.contains(e.relatedTarget)) rowHover = null; }
  async function onRowDrop(e, s) {
    const rec = dragRec;
    if (!rec || rec.kind !== 'session' || !canQuote(rec.id, s.id)) return;
    e.preventDefault();
    rowHover = null;
    dropDone = true;
    if (pc.splitOn && s.id === pc.paneId) { pc.quoteInto('pane', rec); return; }
    if (s.id !== session.id) { pc.paneFocus = false; session.projectId = s.projectId || null; await openSession(s.id); }
    quoteSession({ id: rec.id, title: rec.title });
  }
  function onSideDragEnd(e) {
    const rec = dragRec;
    dragRec = null; sideDrag = null; insAt = -1; pc.splitHover = null; pc.quoteHover = null; rowHover = null;
    const out = dragOut, done = dropDone;
    dragOut = false; dropDone = false;
    if (!rec || rec.kind !== 'session' || done) return;
    let none = true;
    try { none = e.dataTransfer.dropEffect === 'none'; } catch {}
    if (!none) return;                 // 别的应用 / 别的窗口接住了
    if (isOutside(e, out)) popOut(rec, (e.screenX || e.screenY) ? { x: e.screenX, y: e.screenY } : null);
  }
  // 松手点在不在窗口外。坐标一律用视口坐标（clientX/Y）判——屏幕坐标要拿 window.outerWidth 去比，
  // 缩放 / 视口仿真下它和真实窗口对不上。
  //   · dragend 带了坐标：落在视口外＝外；离视口边缘超过 24px（明明白白在里面）＝里——拖回 app 里没
  //     落点的地方松手、或按 Esc 取消，都不该弹窗口（规范要求取消时先补一发 relatedTarget=null 的
  //     dragleave，单凭它会误判）；
  //   · 贴着边缘 / 没带坐标（有的平台 dragend 坐标全是 0）：看出窗口时记下的那一笔。
  function isOutside(e, leftWindow) {
    const x = e.clientX, y = e.clientY, W = window.innerWidth, H = window.innerHeight;
    const known = !!(x || y);
    if (known && (x < 0 || y < 0 || x > W || y > H)) return true;
    if (known && x > 24 && y > 24 && x < W - 24 && y < H - 24) return false;
    return leftWindow;
  }
  // 拖拽期间盯着「指针出没出窗口」：离开整个文档时 dragleave 的 relatedTarget 是 null、且坐标贴着
  // 视口边缘（取消拖拽那一发 dragleave 坐标在里面），回来就又有 dragover
  $effect(() => {
    if (!sideDrag) return;
    const leave = (e) => {
      if (e.relatedTarget) return;
      const x = e.clientX, y = e.clientY;
      if (x <= 2 || y <= 2 || x >= window.innerWidth - 2 || y >= window.innerHeight - 2) dragOut = true;
    };
    const over = () => { dragOut = false; };
    document.addEventListener('dragleave', leave);
    document.addEventListener('dragover', over);
    return () => { document.removeEventListener('dragleave', leave); document.removeEventListener('dragover', over); };
  });

  // —— ③ 拖出窗口：一个只放这个对话的新窗口（?solo=<id>，见 SoloPage）——
  // 桌面壳：主窗口的 window.open 一律交给系统浏览器，所以走壳的 IPC 开一个同会话、同登录态的窗口；
  // 老壳没有这条 IPC 就明说要更新。网页：浏览器弹窗（同名窗口复用——同一个对话拖两次是聚焦不是再开）。
  function popOut(rec, pt) {
    const url = soloUrl(rec.id);
    const width = 800;
    const height = Math.max(560, Math.min(920, (window.screen?.availHeight || 900) - 60));
    // 让指针落在新窗口标题栏靠左的位置——像拖出来的标签页被「拎」着
    const x = Math.round((pt ? pt.x : window.screenX + 120) - 140);
    const y = Math.round((pt ? pt.y : window.screenY + 80) - 18);
    const bd = typeof window !== 'undefined' ? window.BridgeDesktop : null;
    if (bd) {
      if (bd.window?.openChat) {
        let bg = '';
        try { bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); } catch {}
        Promise.resolve(bd.window.openChat({ url, key: rec.id, title: rec.title, x, y, width, height, bg }))
          .catch(() => dropToast(t('没能打开新窗口')));
      } else {
        dropToast(tc('claude', '桌面客户端更新后才能把对话拖成独立窗口'));
      }
      return;
    }
    let w = null;
    try { w = window.open(url, 'bridge-chat-' + rec.id, `popup=yes,width=${width},height=${height},left=${x},top=${y}`); } catch {}
    if (!w) dropToast(t('浏览器拦下了新窗口——允许本站弹出窗口后再拖一次'));
    else { try { w.focus(); } catch {} }
  }

  // —— ① 项目排序 ——
  // 插入位按指针纵坐标算：项目块（项目行 + 它的会话）上半截＝插到它前面、下半截＝插到它后面。
  // 拖项目时会话行整体收起（.reordering），列表只剩一行行项目，块就是行、一目了然。
  function insIndexAt(listEl, y) {
    if (!listEl) return -1;
    const blocks = listEl.querySelectorAll(':scope > .d-pblock');
    for (let i = 0; i < blocks.length; i++) {
      const r = blocks[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return blocks.length;
  }
  async function reorderProject(id, toIndex) {
    const ids = pc.realProjects.map((p) => p.id);
    const next = moveId(ids, id, toIndex);
    if (!next) return;
    const prev = pc.projOrder;
    pc.projOrder = next; pc.cacheOrder(next);
    pc.orderPending++;
    try {
      const r = await api.post('/api/claude/project/order', { ids: next });
      if (Array.isArray(r?.order)) { pc.projOrder = r.order; pc.cacheOrder(r.order); }
    } catch (e) {
      pc.projOrder = prev; pc.cacheOrder(prev);
      uiAlert(t('项目顺序没保存上，请重试'), { type: 'error', detail: tr(e?.body?.error || e?.message || '') });
    } finally { pc.orderPending--; }
  }
  function onProjDragOver(e) {
    if (dragRec?.kind !== 'project') return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    insAt = insIndexAt(e.currentTarget, e.clientY);
  }
  // 边缘自动滚动（鼠标）：项目一多侧栏就要滚，拖着项目块贴近侧栏滚动容器上 / 下缘时让它自己滚，
  // 越贴边越快（rAF 按帧时长折算，不是一下跳一大段）。HTML5 拖拽里指针不动就没有 dragover，
  // 所以滚动后用最后一次的指针坐标自己重算插入位。手指那条全站已有（dragdrop.svelte.js 的 armAutoScroll）。
  let projList = null;             // 正在排序的那份项目列表（常驻列与手机抽屉各渲染一份，按拖源找）
  let ptr = null, edgeRaf = 0, edgeT = 0;
  function scrollerOf(el) {
    for (let n = el?.parentElement; n && n !== document.body; n = n.parentElement) {
      let oy = '';
      try { oy = getComputedStyle(n).overflowY; } catch { continue; }
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight - n.clientHeight > 1) return n;
    }
    return null;
  }
  // 每 16ms 的位移：感应带 48px（矮容器收窄到高度的 1/4），按深入感应带的比例平方加速，贴边最快。
  // 边缘按「列表真正露出来的那一段」算（scrollEdges 扣掉底部 sticky 的账户卡），指针压在吸附条上＝最快。
  function edgeSpeed(sc, x, y) {
    const { left, right, top, bottom } = scrollEdges(sc);
    if (x < left || x > right) return 0;
    const band = Math.min(EDGE, (bottom - top) / 4);
    if (band <= 0) return 0;
    let f = 0;
    if (y < top + band) f = -Math.min(1, (top + band - y) / band);
    else if (y > bottom - band) f = Math.min(1, (y - (bottom - band)) / band);
    return Math.sign(f) * f * f * EDGE_MAX;
  }
  const overList = (x, y) => { try { return document.elementFromPoint(x, y)?.closest('.d-projs') === projList; } catch { return false; } };
  function edgeTick(now) {
    edgeRaf = 0;
    if (dragRec?.kind !== 'project' || !projList?.isConnected || !ptr) return;
    const sc = scrollerOf(projList);
    const v = sc ? edgeSpeed(sc, ptr.x, ptr.y) : 0;
    if (!v) { edgeT = 0; return; }     // 离开感应带就停；下一发 dragover 再接上
    const dt = edgeT ? Math.min(48, Math.max(1, now - edgeT)) : 16;
    edgeT = now;
    const before = sc.scrollTop;
    sc.scrollTop += v * dt / 16;
    if (sc.scrollTop !== before) insAt = overList(ptr.x, ptr.y) ? insIndexAt(projList, ptr.y) : -1;
    edgeRaf = requestAnimationFrame(edgeTick);
  }
  function stopEdge() { if (edgeRaf) cancelAnimationFrame(edgeRaf); edgeRaf = 0; edgeT = 0; ptr = null; }
  $effect(() => {
    if (sideDrag?.kind !== 'project') return;
    // 整页听：指针在侧栏顶部入口行 / 底部账户卡上（列表外）也要能滚
    const over = (e) => { ptr = { x: e.clientX, y: e.clientY }; if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeTick); };
    document.addEventListener('dragover', over);
    return () => { document.removeEventListener('dragover', over); stopEdge(); projList = null; };
  });
  function onProjDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) insAt = -1; }
  function onProjDrop(e) {
    const rec = dragRec;
    if (!rec || rec.kind !== 'project') return;
    e.preventDefault();
    const at = insIndexAt(e.currentTarget, e.clientY);
    insAt = -1;
    dropDone = true;
    reorderProject(rec.id, at);
  }
  // 手指：长按项目行拿起（全站同一套门槛与手感），整张项目列表是一个落点，插入位跟着手指的纵坐标走。
  // 原地按住再松手＝项目菜单，开在松手点（项目行没有 ⋮，这是触屏上唯一的入口，同 agy 侧栏文件夹）。
  let touchProj = $state(null);    // 手指拎着的项目 id
  const hold = makeHold();
  function projHoldDown(e, p) {
    if (e.pointerType === 'mouse' || IS_CSNAP) return;
    hold.arm(e, (f) => {
      const ok = beginDrag({ type: 'claude-project', id: p.id, name: p.name, path: p.path || '' }, {
        x: f.x, y: f.y, pointerId: f.pointerId, pointerType: f.pointerType, sourceEl: f.el,
        ghost: { name: tr(p.name), isDir: true },
        onStay: (pt) => pc.openMenu({ clientX: pt.clientX, clientY: pt.clientY }, 'project', p.id),
      });
      if (ok) touchProj = p.id;
    });
  }
  const projHoldMove = (e) => hold.track(e);
  const projHoldUp = () => hold.disarm();
  $effect(() => { if (!drag.on && touchProj) touchProj = null; });

  // 手指：长按会话行拿起＝准备「引用这段对话」——松在正文列（claudeDrop）或侧栏另一条会话上
  // （sessionDrop）就引用进那个对话的输入栏；原地按住再松手＝那一行的 ⋮ 菜单（iOS 长按菜单的位置）。
  // 窄屏抽屉盖着正文：拎着往右拖出抽屉边缘，抽屉自己收起，正文露出来接着放（见下方 $effect）。
  let touchSess = $state(null);    // 手指拎着的会话 id
  const sessHold = makeHold();
  const CHAT_GHOST_IC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.2c0 3.9-3.6 7-8 7-1.1 0-2.2-.2-3.1-.6L4.5 20l1.2-3.5C4.6 15.3 4 13.8 4 12.2c0-3.9 3.6-7 8-7s8 3.1 8 7z"/><path d="M8.6 11h6.8M8.6 14h4.2"/></svg>';
  function sessHoldDown(e, s) {
    if (e.pointerType === 'mouse' || IS_CSNAP) return;
    const row = e.currentTarget;
    sessHold.arm(e, (f) => {
      const title = tr(titleFor(s.id, s.title)) || t('（无标题）');
      const ok = beginDrag({ type: CHAT_REF, id: s.id, name: title }, {
        x: f.x, y: f.y, pointerId: f.pointerId, pointerType: f.pointerType, sourceEl: f.el,
        ghost: { name: title, iconHtml: CHAT_GHOST_IC },
        onStay: () => { const b = row.querySelector('.d-more'); if (b) pc.openMenu({ currentTarget: b, stopPropagation() {} }, 'session', s.id); },
      });
      if (ok) touchSess = s.id;
    });
  }
  const sessHoldMove = (e) => sessHold.track(e);
  const sessHoldUp = () => sessHold.disarm();
  $effect(() => { if (!drag.on && touchSess) touchSess = null; });
  let drawerEl = $state();
  $effect(() => {
    if (!(touchSess || touchProj) || pc.wide || !ui.drawerOpen || !drawerEl) return;
    const x = drag.x;
    const r = untrack(() => drawerEl.getBoundingClientRect());
    if (x > r.right + 6) untrack(pc.closeDrawer);
  });
  const listAt = (x, y) => { try { return document.elementFromPoint(x, y)?.closest('.d-projs') || null; } catch { return null; } };
  const projListZone = {
    key: 'claude-proj-order',
    label: t('放在这里'),
    effect: 'move',
    accept: (pl) => pl?.type === 'claude-project',
    // 用松手点（第二个参数）而不是 drag.x/y：落地动画开播时 drag.x/y 已被改成落点中心
    drop: (pl, pt) => reorderProject(pl.id, insIndexAt(listAt(pt.x, pt.y), pt.y)),
  };
  // 手指拖着时插入线跟着 drag.y 走（drag 是 $state，这里读 DOM 几何只为换算位置）
  // 全站自动滚动滚起来时手指可能没动（drag.y 不变），靠 scrollTick 让插入线跟着列表几何重算
  let scrollTick = $state(0);
  $effect(() => {
    if (!touchProj) return;
    const bump = () => { scrollTick++; };
    document.addEventListener('scroll', bump, true);
    return () => document.removeEventListener('scroll', bump, true);
  });
  const touchIns = $derived(touchProj && drag.overKey === 'claude-proj-order' && scrollTick >= 0 ? insIndexAt(listAt(drag.x, drag.y), drag.y) : -1);
  // 手指拎起项目后真挪了才收起会话行：长按现在也是开菜单的手势，原地按住时整列一收一放会闪一下
  const projDragging = $derived(sideDrag?.kind === 'project' || (!!touchProj && drag.moved));
  const insShown = $derived(touchProj ? touchIns : insAt);
  const liftedId = $derived(sideDrag?.id || touchProj || touchSess || null);

  return {
    get mouseDnd() { return mouseDnd; },
    get sideDrag() { return sideDrag; }, set sideDrag(v) { sideDrag = v; },
    get dragRec() { return dragRec; }, set dragRec(v) { dragRec = v; },
    get dropDone() { return dropDone; }, set dropDone(v) { dropDone = v; },
    onSessDragStart,
    onProjDragStart,
    get rowHover() { return rowHover; }, set rowHover(v) { rowHover = v; },
    onRowDragOver,
    onRowDragLeave,
    onRowDrop,
    onSideDragEnd,
    onProjDragOver,
    onProjDragLeave,
    onProjDrop,
    projHoldDown,
    get projHoldMove() { return projHoldMove; },
    get projHoldUp() { return projHoldUp; },
    sessHoldDown,
    get sessHoldMove() { return sessHoldMove; },
    get sessHoldUp() { return sessHoldUp; },
    get drawerEl() { return drawerEl; }, set drawerEl(v) { drawerEl = v; },
    get projListZone() { return projListZone; },
    get projDragging() { return projDragging; },
    get insShown() { return insShown; },
    get liftedId() { return liftedId; },
  };
}
