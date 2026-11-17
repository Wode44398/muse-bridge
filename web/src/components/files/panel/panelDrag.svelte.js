// 工作空间（手机 FilesPanel）的长按 / 拖拽：按住＝拿起（全域拖拽的拖源）、桌面壳里的原生拖出、picker 形态的拖进底栏选定、
// 从系统拖文件进来上传。P 是外壳（FilesPanel.svelte）交出来的状态与动作视图，见那边的 P。
import { canDragOut, joinAbs, startDragOut } from '../../../lib/dragOut.js';
import { t, tr } from '../../../lib/i18n.js';
import { api } from '../../../lib/api.js';
import { startTreeUpload } from '../../../lib/uploads.svelte.js';
import { cloudFileUrl } from '../../../lib/preview.svelte.js';
import { entriesFromDrop, groupByRoot, skipNote, walkEntries } from '../../../lib/dirDrop.js';
import { localFileUrl, localImgDataUrl, localMove, localReadB64 } from '../../../lib/localfs.js';
import { nativeLocLocalOnly, nativeWorkspaceMove } from '../../../lib/nativeDesktop.js';
import { pcLocalMaterial } from '../../../lib/pcLocal.js';
import { HOLD_MS, MOVE_TOL, addToDrag, beginDrag, drag, isDragging } from '../../../lib/dragdrop.svelte.js';
import { folderDropZone, wsFilePayload } from '../../../lib/fileDrag.js';
import { dtHasFiles, kindOf } from '../../../lib/files/common.js';
import { fileIcon } from './panelLook.js';

export function createPanelDrag(P) {
  let pkTimer = null, pkFrom = null, pkPid = -1;
  // —— 长按 ——（picker 形态下同一个长按改成「起拖」，见 pkDown）
  //
  // 触屏语义（2026-08-30 起）：按住＝把这一份【拿起来】，不再当场弹菜单；
  //   · 原地按住再松手 → 补出长按菜单（onStay 回调，与从前一样的入口）
  //   · 按住后挪动     → 就是拖拽，落在哪儿由那个落点决定（本页文件夹＝移动、对话页＝挂进输入栏）
  // 鼠标不改：长按恒出菜单（PC 上还有右键，硬套「按住＝拿起」只会挡住既有习惯）。
  let pressTimer = null, pressXY = null;
  const holdMouse = 450;
  // 这一次按压是不是手指——决定要不要吞掉浏览器自己那发长按 contextmenu（见 onCtxMenu）。
  let pressTouch = false;
  // 正被按住、还没到起拖门槛的那一份：像 iOS 一样先轻轻「压」下去，让人知道再按一会儿就拿起来了
  let armRel = $state('');
  function pressDown(e, item) {
    pressTouch = false;
    if (P.wsPick) { pkDown(e, item.name, P.itemRel(item), item.isDir); return; }
    if (P.selecting || P.atHome) return;   // 「本地位置」主页是根列表（有专属管理菜单），不出长按菜单
    if (isDragging()) return;          // 已经拎着一份了：这根手指是来翻页/加叠的，别再拿起第二份
    pressTouch = e.pointerType !== 'mouse';
    pressXY = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, pointerType: e.pointerType, el: e.currentTarget };
    const lift = pressTouch && canLift;
    if (lift) armRel = P.itemRel(item);
    pressTimer = setTimeout(() => { pressTimer = null; armRel = ''; if (lift) liftItem(item); else P.openMenu({ clientX: pressXY.x, clientY: pressXY.y }, item); }, lift ? HOLD_MS : holdMouse);
  }
  function pressMove(e) {
    if (P.wsPick) { pkMoveArm(e); return; }
    if (!pressTimer || !pressXY || e.pointerId !== pressXY.pointerId) return;
    // 起拖前挪超过 MOVE_TOL＝在滚列表，作罢。门槛必须低于浏览器自己的 touch slop（8px）：
    // 一过 slop 它就把这根手指判给滚动，再拎起来也拦不住列表跟着跑。
    if (Math.hypot(e.clientX - pressXY.x, e.clientY - pressXY.y) > MOVE_TOL) { clearTimeout(pressTimer); pressTimer = null; armRel = ''; }
  }
  function pressUp() {
    pressTouch = false;
    if (P.wsPick) { pkCancelArm(); return; }
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    armRel = '';
  }

  // —— 桌面壳：鼠标拖行/卡/文件夹＝Windows 原生文件拖拽（可拖进 Explorer/微信输入框/聊天输入栏）——
  // 手机端仍是「按住＝拿起」那套；这里只在壳里、非手机本地盘、非选择器形态时挂 draggable。
  // 多选态拖其中一个已选项＝整组一起拖。拖回本页文件夹＝内部移动（nativeDragRels 在场时
  // dragover/drop 不走上传分支）。Windows DoDragDrop 是模态——promise resolve 即这场拖拽结束，
  // 在此清态并对账刷新（外部 Shift 移动会把源文件搬走）。
  const dragOutOn = $derived(canDragOut() && !P.isLocal && !P.wsPick && !P.readonly && !P.guest);
  let nativeDragRels = null;
  function dragOutSrc(rels) {
    if (P.desktopNative) return { rels, locationId: P.desktopLocationId };
    if (P.cloudRoot) return { paths: rels.map((r) => joinAbs(P.cloudRoot, r)) };
    return { rels, locationId: 'primary' };   // 身份文件根＝桌面壳 primary 位置（server 形态同一处 vaultPath）
  }
  function rowDragStart(e, item) {
    if (!dragOutOn) return;
    e.preventDefault(); e.stopPropagation();
    pressUp();
    const rels = P.selecting && P.selected.has(item.name) ? [...P.selected].map((n) => joinPath(P.path, n)) : [P.itemRel(item)];
    nativeDragRels = rels;
    startDragOut(dragOutSrc(rels)).catch(() => {}).finally(() => {
      if (nativeDragRels === rels) { nativeDragRels = null; dropOn = null; if (alive) P.load(P.path); }
    });
  }
  async function moveNativeDragged(rels, destRel) {
    const root = P.cloudRoot || '', nativeLoc = P.desktopNative ? P.desktopLocationId : '';
    let ok = 0, fail = 0;
    for (const rel of rels) {
      if (rel === destRel || destRel.startsWith(rel + '/')) continue;
      const r = await moveSnapInto({ rel, local: false, root, nativeLoc }, destRel);
      if (r.ok) ok++; else fail++;
    }
    if (fail) P.toast(t('移动失败 {n} 项', { n: fail })); else if (ok) P.toast(ok > 1 ? t('已移动 {n} 项', { n: ok }) : t('已移动'));
    if (P.selecting) P.exitSelect();
    if (alive) await P.load(P.path);
  }

  // 长按到 ~500ms 时，安卓/iOS 浏览器会自己补一发 contextmenu。手指这条路我们已经有自己的
  // 语义（按住＝拿起、原地松手＝出菜单），所以必须吞掉它——否则菜单会盖在刚拎起来的那一份
  // 上面，连背景都点不动（v4.65 上机后的现象）。preventDefault 照旧无条件调：那是拦系统
  // 自带的长按菜单/取词，本来就该拦。鼠标右键（pressTouch=false）仍照常出菜单。
  function onCtxMenu(e, item) {
    e.preventDefault();
    if (pressTouch || isDragging()) return;
    P.openMenu(e, item);
  }

  // —— 全域拖拽：拖源侧 ——
  // 只读分享空间不给拖（那儿本来就没有写操作），多选态也不给（多选有自己的批量工具条）。
  const canLift = $derived(!P.readonly && !P.wsPick && !P.selecting && !P.atHome);
  // 正被拎着的那一叠（原位淡出，像 iOS 那样"被拿走了"）；幽灵落地/飞回后 drag.on 归零才恢复
  let liftRels = $state(new Set());
  $effect(() => { if (!drag.on && liftRels.size) liftRels = new Set(); });

  // 作用域指纹：云端(可带 ws 根) / 手机本地 SAF / 桌面原生位置——只有同作用域才谈得上「移动」
  const dragCtx = $derived({ origin: P.isLocal ? 'local' : P.desktopNative ? 'native' : 'cloud', ws: P.desktopNative ? '' : P.cloudRoot || '', locationId: P.desktopNative ? P.desktopLocationId : '' });

  // 本页的三类落点：当前目录（列表空白处）/ 某个文件夹格子 / 面包屑上的某一级。
  // 只读分享空间与选择器形态整体关掉（那儿没有写操作）。
  // 文件夹格子与面包屑都带 spring：拎着东西在上面悬停一会儿就自动进去/退到那一级（iOS 的
  // spring-loaded folders），单指也能一路钻到目标目录再松手。
  // onDone：本页是【目标】时搬完刷新——跨作用域拖放的源面板在别处（工作台里那个），它的 afterMove 刷不到这里。
  const zoneDone = () => { if (alive) P.load(P.path); };
  const hereZone = $derived(folderDropZone({ key: 'ws-here', name: P.title, ctx: dragCtx, rel: P.path, disabled: P.readonly || P.wsPick, onDone: zoneDone }));
  const folderZone = (f) => folderDropZone({ key: 'ws-dir:' + P.itemRel(f), name: f.name, ctx: dragCtx, rel: P.itemRel(f), disabled: P.readonly || P.wsPick, spring: () => P.enterDir(f), onDone: zoneDone });
  const crumbZone = (i) => folderDropZone({ key: 'ws-crumb:' + i, name: i < 0 ? P.rootLabel : P.segLabel(P.segs[i], i), ctx: dragCtx, rel: i < 0 ? '' : P.segs.slice(0, i + 1).join('/'), disabled: P.readonly || P.wsPick, spring: () => (i < 0 ? P.goRoot() : P.goSeg(i)), onDone: zoneDone });

  // 拖拽会【活过本页的卸载】——另一根手指收起工作台、切走分页，源面板就没了。所以起拖那一刻
  // 必须把「这一份是谁、在哪个作用域」整个拍成快照：
  //   · rel 用当时的目录算（拖到一半用户已翻去别的目录，再 itemRel 会拼出不存在的路径 → 404）；
  //   · 作用域字段更要命——workspaceRoot 是 props，卸载后它的 getter 会一路读到宿主已清空的
  //     filesMount，直接抛 "Cannot read properties of null (reading 'ws')"（实测）。
  //     root 取的是 cloudRoot（含电脑位置），拎着它切到别的位置再放下＝跨根搬运。
  // 快照之后，落地这两件事只吃纯数据，与组件生死无关。
  const liftSnap = (item) => ({
    rel: P.itemRel(item), name: item.name, isDir: !!item.isDir,
    local: P.isLocal, root: P.desktopNative ? '' : P.cloudRoot || '', nativeLoc: P.desktopNative ? P.desktopLocationId : '',
  });
  let alive = true;
  $effect(() => () => { alive = false; });

  // destCtx 非空＝跨作用域（云端 ↔ 云端，两个根都在服务端）：源按快照里的 root、目标按落点的 ws，
  // /api/files/move 带 fromWs 一次搬完（跨卷服务端自己回落 copy+rm）。
  async function moveSnapInto(snap, destRel, destCtx = null) {
    try {
      if (snap.local) { const r = localMove(snap.rel, destRel); if (r?.error) return { ok: false, error: r.error }; }
      else if (snap.nativeLoc) await nativeWorkspaceMove(snap.rel, destRel, snap.nativeLoc);
      else if (destCtx && destCtx.origin === 'cloud' && (destCtx.ws || '') !== (snap.root || '')) await api.moveFile(snap.rel, destRel, destCtx.ws || '', snap.root || '');
      else await api.moveFile(snap.rel, destRel, snap.root);
    } catch (e) { return { ok: false, error: e.body?.error || e.message || '' }; }
    return { ok: true };
  }
  // 整叠搬完统一对账：面板还在才刷新（不在就没人看了）
  async function afterMove() { if (alive) await P.load(P.path); }
  // 与 aiMaterial 同一条服务端链路，但只吃快照——源面板卸载后照样能把素材备出来。
  async function materialOf(snap, direct = false) {
    const kind = snap.isDir ? 'folder' : (kindOf(snap.name) === 'img' ? 'image' : 'file');
    try {
      if (nativeLocLocalOnly(snap.nativeLoc)) return await pcLocalMaterial({ rel: snap.rel, name: snap.name, isDir: snap.isDir, locationId: snap.nativeLoc, forClaude: direct });
      if (snap.local) {
        if (snap.isDir) return null;      // 手机本地文件夹没有可发送的形态
        let up;
        try {
          const resp = await fetch(localFileUrl(snap.rel));
          if (!resp.ok) throw new Error('本地流不可用');   // i18n-ignore 内部信号：下面 catch 吞掉，不上屏
          up = await api.uploadBlob(snap.name, await resp.blob(), { timeout: 600000 });
        } catch {
          const b64 = localReadB64(snap.rel);
          if (!b64) throw new Error('读取失败');   // i18n-ignore 外层 catch 只回 null，不上屏
          up = await api.upload(snap.name, b64);
        }
        return { path: up.path, name: up.name, kind, url: kind === 'image' ? localImgDataUrl(snap.rel, snap.name) : null };
      }
      const up = await api.fileToUpload(snap.rel, !direct, snap.root);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(snap.rel, { ws: snap.root }) : null };
    } catch { return null; }
  }

  const ghostOf = (item) => ({ name: item.name, isDir: !!item.isDir, iconHtml: item.isDir ? '' : fileIcon(item.name), thumb: P.thumbable(item) ? P.thumbSrc(item) : '' });
  function liftItem(item) {
    const el = pressXY?.el || null;
    const pid = pressXY?.pointerId ?? -1;
    const x = pressXY?.x ?? 0, y = pressXY?.y ?? 0;
    const snap = liftSnap(item);
    liftRels = new Set([snap.rel]);
    const payload = wsFilePayload({
      items: [snap], ctx: dragCtx,
      moveOne: (s, destRel, destCtx) => moveSnapInto(s, destRel, destCtx),
      materialOne: (s, direct) => materialOf(s, direct),
      afterMove,
    });
    const ok = beginDrag(payload, {
      x, y, pointerId: pid, pointerType: pressXY?.pointerType || 'touch', sourceEl: el,
      ghost: ghostOf(item),
      onStay: () => P.openMenu({ clientX: x, clientY: y }, item),
    });
    if (!ok) liftRels = new Set();
  }
  // 拎着一份时另一根手指点到别的文件＝加进这一叠（iOS 同款），而不是把它点开。
  // 文件夹不加叠：点文件夹恒等于「进去」——那是另一根手指认路的方式（场景：一手拎着、一手翻目录）。
  function stackToDrag(item) {
    const snap = liftSnap(item);
    if (addToDrag(snap, ghostOf(item))) liftRels = new Set([...liftRels, snap.rel]);
  }

  // —— picker 形态：长按起拖 → 拖进底栏 → 松手即选定 ——
  // 只有文件夹能拖（文件不是工作空间）。鼠标走的是同一套 Pointer Events，所以按住拖同样成立。
  function pkDown(e, name, rel, isDir) {
    if (!isDir || P.pkDrag) return;
    pkCancelArm();
    pkPid = e.pointerId;
    pkFrom = { x: e.clientX, y: e.clientY, name, rel };
    pkTimer = setTimeout(() => pkStart(), 420);
  }
  function pkMoveArm(e) {
    if (!pkTimer || !pkFrom) return;
    // 起拖前手指挪超过 9px＝用户在滚列表，取消这次长按（与长按菜单同一阈值）
    if (Math.hypot(e.clientX - pkFrom.x, e.clientY - pkFrom.y) > 9) pkCancelArm();
  }
  function pkCancelArm() { if (pkTimer) { clearTimeout(pkTimer); pkTimer = null; } pkFrom = null; }
  // 拖起来之后列表不能再跟着滚：touchmove 必须 passive:false + preventDefault 才拦得住
  // WebView 的滚动。监听器在 picker 挂载期间【常驻】而不是起拖时才挂：合成器在 touchstart
  // 那一刻就定下这根手指的 touchmove 能否被拦——手势中途才挂的阻塞监听收到的是
  // cancelable=false 的事件。常驻之后文件夹格子就不必 touch-action:none（那会让铺满
  // 格子的列表在手机/折叠屏上几乎滑不动，只剩格缝能滑）。
  const pkBlockTouch = (e) => { if (P.pkDrag && e.cancelable) e.preventDefault(); };
  $effect(() => {
    if (!P.wsPick) return;
    window.addEventListener('touchmove', pkBlockTouch, { passive: false });
    return () => window.removeEventListener('touchmove', pkBlockTouch);
  });
  function pkStart() {
    if (!pkFrom) return;
    const { name, rel, x, y } = pkFrom;
    pkTimer = null;
    try { navigator.vibrate?.(12); } catch {}
    P.pkDrag = { name, abs: P.pkAbs(rel), ...pkLocal(x, y), over: false };
    window.addEventListener('pointermove', pkMove, { passive: false });
    window.addEventListener('pointerup', pkUp);
    window.addEventListener('pointercancel', pkUp);
  }
  function pkLocal(cx, cy) {
    const box = P.rootEl?.getBoundingClientRect();
    return { x: cx - (box?.left || 0), y: cy - (box?.top || 0) };
  }
  function pkOverDock(cx, cy) {
    const r = P.pkDockEl?.getBoundingClientRect();
    return !!r && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }
  function pkMove(e) {
    if (!P.pkDrag || (pkPid >= 0 && e.pointerId !== pkPid)) return;   // 多指：只认起拖的那根
    if (e.cancelable) e.preventDefault();
    P.pkDrag = { ...P.pkDrag, ...pkLocal(e.clientX, e.clientY), over: pkOverDock(e.clientX, e.clientY) };
  }
  function pkUp(e) {
    if (pkPid >= 0 && e.pointerId !== pkPid) return;
    const drag = P.pkDrag;
    pkEnd();
    if (!drag) return;
    if (pkOverDock(e.clientX, e.clientY)) {
      try { navigator.vibrate?.(18); } catch {}
      P.onPickWs?.(drag.abs);
    }
  }
  function pkEnd() {
    P.pkDrag = null; pkPid = -1;
    pkCancelArm();
    window.removeEventListener('pointermove', pkMove);
    window.removeEventListener('pointerup', pkUp);
    window.removeEventListener('pointercancel', pkUp);
  }
  // —— 桌面拖拽上传（网盘式：拖在某个文件夹上就传进那个文件夹，拖在空白处传进当前目录）——
  // 只在云端工作空间生效：手机本地(SAF)那侧没有这条通路，只读分享空间更不该能写。
  // dropOn：null=没在拖 / ''=当前目录 / '<文件夹名>'=某个文件夹（用来点亮目标）。
  let dropOn = $state(null);
  const canDrop = $derived(!P.readonly && !P.isLocal && !P.desktopNative);
  const joinPath = (a, b) => [a, b].filter(Boolean).join('/');

  function dragOverRoot(e) {
    if (nativeDragRels) return;   // 自己拖出去的项悬在空白处＝原地，不算落点
    if (!canDrop || !dtHasFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    dropOn = '';
  }
  function dragLeaveRoot(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropOn = null; }
  // 文件夹格子自己拦下 dragover（stopPropagation），根的处理器就不会把目标又抹回当前目录。
  function dragOverFolder(e, name) {
    if (nativeDragRels) {   // 自己拖出去的项拖回文件夹＝内部移动（不能进自己/自己的子目录）
      const dest = joinPath(P.path, name);
      if (nativeDragRels.some((r) => r === dest || dest.startsWith(r + '/'))) return;
      e.preventDefault(); e.stopPropagation();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      dropOn = name;
      return;
    }
    if (!canDrop || !dtHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    dropOn = name;
  }

  async function onDropUpload(e) {
    if (nativeDragRels) {
      e.preventDefault(); e.stopPropagation();
      const target = dropOn, rels = nativeDragRels;
      dropOn = null; nativeDragRels = null;
      if (target) await moveNativeDragged(rels, joinPath(P.path, target));
      return;
    }
    if (!canDrop || !dtHasFiles(e)) { dropOn = null; return; }
    e.preventDefault(); e.stopPropagation();
    const target = dropOn;                       // 先取：dropOn 马上要清
    dropOn = null;
    const baseDir = target ? joinPath(P.path, target) : P.path;
    const entries = entriesFromDrop(e);          // 同步取，await 之后 dataTransfer 就废了
    const loose = [...(e.dataTransfer.files || [])];
    if (!entries.length) { for (const f of loose) P.uploadOne(f, baseDir); return; }  // 老浏览器兜底
    // 整树上传不设 Composer 那种小上限——这是网盘，用户拖多少传多少。
    const { items, stat } = await walkEntries(entries, { maxFiles: 5000, maxBytes: 8e9, maxFileBytes: 2e9 });
    if (!items.length) return;
    const note = skipNote(stat);
    if (note) P.toast(tr(note));   // 文案出自 dirDrop.js（别的模块）：显示点兜一层 tr()
    for (const g of groupByRoot(items)) {
      if (g.isDir) await uploadTree(g.name, g.items, baseDir);
      else for (const it of g.items) await P.uploadOne(it.file, baseDir);
    }
  }

  // 整个文件夹作为【一条】传输任务（几百个文件铺成几百行没法看）：进度按累计字节算。
  function uploadTree(rootName, items, baseDir) {
    const list = items.map((it) => ({ file: it.file, dir: joinPath(baseDir, it.rel.split('/').slice(0, -1).join('/')) }));   // rel 含顶层文件夹名
    startTreeUpload(rootName, list, { ws: P.cloudRoot, baseDir });
  }


  return {
    get armRel() { return armRel; }, set armRel(v) { armRel = v; },
    get crumbZone() { return crumbZone; },
    get dragLeaveRoot() { return dragLeaveRoot; },
    get dragOutOn() { return dragOutOn; },
    get dragOverFolder() { return dragOverFolder; },
    get dragOverRoot() { return dragOverRoot; },
    get dropOn() { return dropOn; }, set dropOn(v) { dropOn = v; },
    get folderZone() { return folderZone; },
    get hereZone() { return hereZone; },
    get liftRels() { return liftRels; }, set liftRels(v) { liftRels = v; },
    get onCtxMenu() { return onCtxMenu; },
    get onDropUpload() { return onDropUpload; },
    get pkDown() { return pkDown; },
    get pressDown() { return pressDown; },
    get pressMove() { return pressMove; },
    get pressTimer() { return pressTimer; }, set pressTimer(v) { pressTimer = v; },
    get pressUp() { return pressUp; },
    get rowDragStart() { return rowDragStart; },
    get stackToDrag() { return stackToDrag; },
  };
}
