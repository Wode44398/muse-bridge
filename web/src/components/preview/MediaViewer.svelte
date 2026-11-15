<script>
  // 统一查看器外框（ViewerShell；文件名沿用 MediaViewer.svelte，引用处不用动）。全局常驻（App 末尾 + 各宿主内嵌），
  // preview.open 且 host 相符时接管：顶栏 + 舞台 + 可选底栏 + 浮层槽（菜单 / 文件信息 / toast / 提示）。
  // 子查看器（图片 / 视频 / 音频 / PDF / Office / HTML / 文档）不再自画头部、菜单、转圈、toast，
  // 经 useViewer()（kit/context.js）向外框声明标题、副标题、主工具、溢出菜单、底栏与沉浸行为——契约全文见 kit/context.js 顶部注释。
  //
  // 外框已经做了、子查看器不要重复做的：关闭钮与 Esc / 系统返回（pushBackLayer）/ 关闭动画、焦点移入与 Tab 循环、
  // role=dialog、画廊 ←/→ 与左右箭头、滚动锁、桌面壳原生视图让位、ui.pageChrome 暗色、
  // 溢出菜单的通用项（下载 / 分享 / 打开方式 / 在文件夹中显示 / 复制路径 / 复制链接 / 文件信息 / 发送给 AI）、ios27 上下文。
  import { untrack, tick, setContext } from 'svelte';
  import { preview, closePreview, previewNext, previewPrev, previewGo, previewPop, previewLayers } from '../../lib/preview.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { pushNativeOverlay } from '../../lib/nativeDesktop.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { ui } from '../../lib/state.svelte.js';
  import { reduced } from '../../lib/motion.js';
  import { t } from '../../lib/i18n.js';
  import ImageGallery from './ImageGallery.svelte';
  import { firstSrc } from './ImageView.svelte';
  import VideoPlayer from './VideoPlayer.svelte';
  import AudioPlayer from './AudioPlayer.svelte';
  import DocViewer from './DocViewer.svelte';
  import PdfView from './PdfView.svelte';
  import OfficeView from './OfficeView.svelte';
  import HtmlView from './HtmlView.svelte';
  import ViewerBar from './kit/ViewerBar.svelte';
  import ViewerMenu from './kit/ViewerMenu.svelte';
  import ViewerToast from './kit/ViewerToast.svelte';
  import ViewerInfo from './kit/ViewerInfo.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { provideViewer, val, isEditable } from './kit/context.js';
  import { commonMenu, canDownload, download, probeMeta, infoRows, copyText } from './kit/actions.js';
  import { tip, resetTips } from './kit/tooltip.js';
  import './kit/viewer.css';
  import '../../lib/doctheme.css';
  import '../ios27/ink.css';

  // host：本实例服务的宿主——'app'（App 末尾的全屏实例）| 'dock' | 'memory' | 'hx-files' | 'codex-workspace'
  // （内嵌实例的 fixed 根被宿主的 transform 圈定在宿主里）。只认 preview.host 相符的打开请求；
  // 副作用（键盘 / 滚动锁 / 预载 / 返回层 / pageChrome）同样只在本实例接管时生效，避免多实例互踩。
  const { host = 'app' } = $props();
  const active = $derived(preview.open && (preview.host || 'app') === host);

  const cur = $derived(preview.items[preview.index] || null);
  const count = $derived(preview.items.length);
  const many = $derived(count > 1);
  const canPrev = $derived(preview.index > 0);
  const canNext = $derived(preview.index < count - 1);
  const isMedia = $derived(!!cur && ['image', 'video', 'audio'].includes(cur.kind));
  const skin = $derived(isMedia ? 'media' : 'doc');
  const fine = $derived(pointer.fine);

  // —— 声明（子查看器 viewer.declare）：按条目 key 归属，后声明的覆盖先声明的 ——
  const EMPTY = {};
  let decls = $state.raw([]);
  let declSeq = 0;
  // opts.key：这份声明归哪个条目（缺省 = 声明那一刻的当前条目）。
  // opts.follow：这份声明跟着「当前条目」走（同 kind 内换条目时仍然生效），同时告诉外框：同 kind 的条目之间切换
  //   不要重建这一页——页面自己跟着 viewer.item 换内容（图片三页滑轨、混排画廊、文档上一个 / 下一个不闪）。
  // opts.kinds（配 follow）：这一页同时管哪几种 kind（图片画廊连带混排里的视频页：['image', 'video']），缺省 = 声明那一刻的 kind。
  function declare(spec = {}, opts = {}) {
    const follow = !!opts.follow;
    const key = follow ? '' : (opts.key ?? spec.key ?? untrack(() => cur?.key));
    const kind = untrack(() => cur?.kind || '');
    const kinds = follow && Array.isArray(opts.kinds) && opts.kinds.length ? [...opts.kinds] : null;
    const id = ++declSeq;
    untrack(() => { decls = [...decls, { id, key, kind, kinds, follow, spec }]; });
    return () => untrack(() => { decls = decls.filter((d) => d.id !== id); });
  }
  const decl = $derived.by(() => {
    const k = cur?.key, kd = cur?.kind;
    for (let i = decls.length - 1; i >= 0; i--) {
      const d = decls[i];
      if (d.follow ? (d.kinds ? d.kinds.includes(kd) : d.kind === kd) : d.key === k) return d.spec;
    }
    return EMPTY;
  });
  // 宿主声明：混排画廊里的视频页，播放器（按 key）的声明盖在画廊（follow）之上整份生效——
  // 翻页键（←/→/Home/End）和缩略图条仍归画廊：取「被盖住的那份 follow 声明」，onKey 先问它、底栏把它的条叠在播放条下面
  const under = $derived.by(() => {
    if (!isMedia || decl === EMPTY) return null;
    const kd = cur?.kind;
    for (let i = decls.length - 1; i >= 0; i--) {
      const d = decls[i];
      if (d.follow && d.spec !== decl && (d.kinds ? d.kinds.includes(kd) : d.kind === kd)) return d.spec;
    }
    return null;
  });
  // 被盖住的那份画廊声明的底栏（缩略图条）：盖在上面的页声明了 soloBottom（视频）就不叠
  const underBottom = $derived(decl.soloBottom ? null : under?.bottom || null);
  // 页面挂载键：缺省 = 条目 key（换条目整页重建，各查看器按「一页一个条目」写就行）；
  // 当前页挂着 follow 声明时，换到同 kind 的条目保持原页不重建（item 照常经 props 换新）
  let pageMem = { key: '', kind: '' };
  const followKinds = $derived.by(() => { for (const d of decls) if (d.follow) return d.kinds || [d.kind]; return null; });
  const pageKey = $derived.by(() => {
    const c = cur;
    if (!c) return '';
    if (followKinds && pageMem.key && followKinds.includes(c.kind) && followKinds.includes(pageMem.kind)) return pageMem.key;
    pageMem = { key: c.key, kind: c.kind };
    return c.key;
  });
  const title = $derived(val(decl.title) || cur?.name || '');
  const subtitle = $derived(decl.subtitle !== undefined ? val(decl.subtitle) : many ? `${preview.index + 1} / ${count}` : '');
  const barMode = $derived(val(decl.bar) || 'auto');
  const overlayBar = $derived(isMedia ? barMode !== 'solid' : barMode === 'overlay');

  // —— 沉浸：顶栏 / 底栏 / 浮条一起显隐 ——
  let chromeOn = $state(true);
  let holdN = $state(0);
  let hideT = 0;
  const autoHide = $derived(!!val(decl.autoHide));
  function armHide() {
    untrack(() => {
      clearTimeout(hideT);
      if (!autoHide || holdN > 0 || menu.open || infoOpen) return;
      hideT = setTimeout(() => untrack(() => { if (autoHide && holdN === 0 && !menu.open && !infoOpen) chromeOn = false; }), val(decl.autoHideMs) || 2600);   // autoHideMs*：子查看器可改静止时长（视频电脑 2.5s / 触屏 3s）
    });
  }
  const chrome = {
    get visible() { return chromeOn; },
    show() { untrack(() => { chromeOn = true; armHide(); }); },
    hide() { untrack(() => { if (holdN === 0 && !menu.open && !infoOpen) { clearTimeout(hideT); chromeOn = false; } }); },
    toggle() { untrack(() => (chromeOn ? chrome.hide() : chrome.show())); },
    poke() { chrome.show(); },
    hold() {
      let done = false;
      untrack(() => { holdN++; chromeOn = true; clearTimeout(hideT); });
      return () => { if (done) return; done = true; untrack(() => { holdN = Math.max(0, holdN - 1); armHide(); }); };
    },
  };
  $effect(() => { autoHide; untrack(() => { if (!autoHide) { clearTimeout(hideT); chromeOn = true; } else armHide(); }); });

  // 鼠标一动：箭头淡入（静止 2.6s 淡出）；开了自动隐藏的条目同时唤出 chrome
  let mouseRecent = $state(false), mouseT = 0, lastMove = 0;
  function onRootMove(e) {
    if (e.pointerType !== 'mouse') return;
    const now = e.timeStamp;
    if (now - lastMove < 80) return;
    lastMove = now;
    if (!mouseRecent) mouseRecent = true;
    clearTimeout(mouseT); mouseT = setTimeout(() => (mouseRecent = false), 2600);
    if (autoHide) chrome.poke();
  }
  let barHold = null;
  function onBarHold(on) { barHold?.(); barHold = on ? chrome.hold('hover') : null; }
  // 键盘焦点（:focus-visible）落进顶栏 / 底栏 / 浮条 / 箭头：唤出 chrome，焦点停在那里就一直显示（YouTube、Windows 照片同理）；
  // 落到舞台里只唤一下。鼠标点按钮不出 focus-visible，不会把沉浸钉住
  let focusHold = null;
  function onRootFocusIn(e) {
    const el = e.target;
    if (!el || el === rootEl) return;
    let kb = false;
    try { kb = el.matches(':focus-visible'); } catch {}
    if (kb && el.closest?.('.vw-bar, .vw-bottom, .vw-float, .vw-arrow')) { focusHold ||= chrome.hold('focus'); return; }
    focusHold?.(); focusHold = null;
    if (kb && autoHide) chrome.poke();
  }
  function onRootFocusOut(e) { if (!rootEl?.contains(e.relatedTarget)) { focusHold?.(); focusHold = null; } }

  // —— 下滑关闭进度（子查看器上报）→ 调暗背景 + 舞台微缩 ——
  let dragP = $state(0);

  // —— 菜单（外框浮层槽，两端分流）——
  // openMenu 的 onclose：菜单不论怎么关（选完、点外面、Esc、系统返回、换条目、被另一个菜单顶掉）都回调一次，
  // 给底栏齿轮这类触发钮复位自己的「开着」态；place：'auto'（缺省，下方放不下就翻到上方）| 'top'（底栏里的钮）
  // point：{x,y} 视口坐标，没有锚点按钮的上下文菜单（右键 / 长按）按落点弹
  let menu = $state.raw({ open: false, anchor: null, point: null, items: null, title: '', place: 'auto', onclose: null });
  let moreEl = $state(null), closeEl = $state(null);
  function openMenu({ anchor = null, point = null, items = [], title = '', place = 'auto', onclose = null } = {}) {
    untrack(() => {
      const prev = menu.open ? menu.onclose : null;
      infoOpen = false;
      menu = { open: true, anchor: anchor || (point ? null : moreEl), point: anchor ? null : point, items, title, place, onclose };
      try { prev?.(); } catch {}
    });
  }
  function closeMenu() {
    untrack(() => {
      if (!menu.open) return;
      const cb = menu.onclose;
      menu = { ...menu, open: false, onclose: null };
      try { cb?.(); } catch {}
    });
  }
  const ctx = { toast: (text, o) => toast(text, o), openInfo: () => openInfo() };
  function mainMenuItems() {
    const own = (val(decl.menu) || []).filter(Boolean);
    const c = decl.common === false ? [] : commonMenu(cur, ctx, val(decl.common));
    return own.length && c.length ? [...own, { sep: true }, ...c] : [...own, ...c];
  }
  // —— 图片的上下文菜单（电脑右键 / 触屏长按）：和 ⋮ 同一份数据源（旋转、下载、分享、复制路径、在文件夹中显示、
  // 重命名、文件信息、删除……，快捷键标在右侧；Windows 照片的右键菜单也是这一整份）——
  // 浏览器自带的那份（安卓 WebView「下载图片」、桌面壳原生「复制图片」）各端长得不一样，还会把带 token 的
  // 原始地址漏给系统；图片条目一律换成查看器自己的。只拦图片：视频长按是 2 倍速，文档里长按是选字。
  // 子查看器自己识别长按（contextmenu 没派发的设备）时调 viewer.contextMenu({x,y})。
  function contextMenu(pt) {
    const c = untrack(() => cur);
    if (!c || c.kind !== 'image' || !pt) return false;
    const items = untrack(mainMenuItems);
    if (!items.length) return false;
    chrome.show();
    openMenu({ point: { x: Math.round(pt.x), y: Math.round(pt.y) }, items });
    return true;
  }
  function onStageContext(e) {
    if (untrack(() => cur)?.kind !== 'image' || isEditable(e.target)) return;
    if (contextMenu({ x: e.clientX, y: e.clientY })) e.preventDefault();
  }
  // ⋮ 再点一下收起；开着的是别的菜单（底栏齿轮等）就换成主菜单
  function onMore() { if (menu.open && menu.anchor === moreEl) closeMenu(); else openMenu({ anchor: moreEl, items: mainMenuItems }); }
  $effect(() => { if (!menu.open) return; return untrack(() => chrome.hold('menu')); });

  // —— 文件信息 ——
  let infoOpen = $state(false);
  let meta = $state.raw({});
  async function openInfo() {
    closeMenu();
    infoOpen = true;
    await probeInfo();
  }
  // 补充信息（大小 / 修改时间 / EXIF）：打开抽屉时探一次；抽屉开着翻到下一项时重探（Windows 照片、Quick Look 同样跟着换）
  async function probeInfo() {
    const c = untrack(() => cur);
    // 手机本地总要探：大小原生现查一次，图片 / 视频还有 EXIF（尺寸、拍摄时间、相机、地点）稍后经 onMore 补
    if (c && (c.size == null || !c.mtime || c.saveTarget?.origin === 'local')) {
      const mine = (m) => { if (m && untrack(() => cur?.key) === c.key) meta = m; };
      mine(await probeMeta(c, undefined, mine));
    }
  }
  const infoList = $derived(infoOpen && cur ? infoRows(cur, meta, val(decl.info) || []) : []);
  $effect(() => { if (!infoOpen) return; return untrack(() => chrome.hold('info')); });
  // 信息面板收起：焦点跟着面板一起卸载会掉到 body（键盘用户从此 Tab 不回查看器）——还给 ⋮，没有就给根
  $effect(() => {
    if (!infoOpen) return;
    return () => queueMicrotask(() => {
      const a = document.activeElement;
      if (!rootEl || (a && a !== document.body && rootEl.contains(a))) return;
      try { (moreEl?.isConnected ? moreEl : rootEl).focus({ preventScroll: true }); } catch {}
    });
  });

  // —— toast 出口 ——
  let toasts = $state.raw([]);
  let toastSeq = 0;
  function toast(text, { kind = 'ok', ms = 2200, action = null } = {}) {
    const id = ++toastSeq;
    const h = { close: () => dismissToast(id) };
    untrack(() => { toasts = [...toasts.filter((x) => !x.leaving).slice(-2), { id, text: String(text || ''), kind, action, close: h.close }]; });
    if (ms > 0) setTimeout(h.close, ms);
    return h;
  }
  function dismissToast(id) {
    untrack(() => {
      if (!toasts.some((x) => x.id === id && !x.leaving)) return;
      toasts = toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x));
      setTimeout(() => untrack(() => { toasts = toasts.filter((x) => x.id !== id); }), 220);
    });
  }

  // —— 关闭（onBack → 关闭动画 → closePreview）——
  // 子查看器可声明 closeAnim()：返回 Promise 时由它自己演关闭（图片缩回缩略图原位），外框只把背景 / 顶栏 / 底栏淡出，
  // 等它落定再 closePreview（900ms 兜底）；不返回 Promise 就走外框默认的整体淡出
  let closing = $state(false), closeT = 0, closingFor = null;
  let flipOut = $state(false);
  function requestClose() {
    if (untrack(() => closing)) return;
    const d = untrack(() => decl);
    if (d.onBack?.()) return;
    closeMenu(); infoOpen = false;
    // 层叠打开的（笔记里点的附件）：先回到上一层，栈空才真关
    if (previewLayers.depth > 0 && previewPop()) { dragP = 0; return; }
    if (reduced()) { closePreview(); return; }
    closing = true; closingFor = preview.items;
    clearTimeout(closeT);
    let p = null;
    try { p = d.closeAnim?.(); } catch { p = null; }
    if (p && typeof p.then === 'function') {
      flipOut = true;
      closeT = setTimeout(finishClose, 900);
      p.then(finishClose, finishClose);
    } else closeT = setTimeout(finishClose, 320);
  }
  function finishClose() {
    clearTimeout(closeT);
    if (!closing) return;
    closing = false; dragP = 0; flipOut = false;
    if (preview.items === closingFor) closePreview();   // 关闭动画途中又开了别的预览：不误关新的
    closingFor = null;
  }
  function onRootAnimEnd(e) { if (closing && e.target === rootEl && e.animationName === 'vw-out') finishClose(); }

  function go(dir) { untrack(() => { dragP = 0; if (dir > 0) previewNext(); else previewPrev(); }); }

  // 切条目：复位下滑进度、关菜单、清掉上一项的补充信息（信息面板开着就留着、重探新一项）；换了页（重建）才唤出 chrome——
  // 滑轨里同一页内翻张保持沉浸（系统相册：黑底全屏看图时左右滑不会把顶栏弹回来）
  let lastPage = '';
  $effect(() => {
    cur?.key;
    const pk = pageKey;
    untrack(() => {
      dragP = 0; closeMenu(); meta = {}; if (infoOpen) probeInfo();
      // 拿着焦点的箭头 / 格子随翻页卸载时不一定派发 focusout：焦点已不在外框控件里就把「焦点保持」放掉
      if (focusHold && !document.activeElement?.closest?.('.vw-bar, .vw-bottom, .vw-float, .vw-arrow')) { focusHold(); focusHold = null; }
      if (pk !== lastPage) { lastPage = pk; chromeOn = true; }
      armHide();
    });
  });
  // 打开时的 FLIP（子查看器 decl.flipIn 为真 = 正从缩略图放大）：外框不做整体淡入，只让背景与顶栏淡入。
  // 锁存到收起为止——中途摘掉类名会让根的淡入动画重播一遍
  let flipLatched = $state(false);
  $effect(() => { if (active && val(decl.flipIn)) untrack(() => { if (!flipLatched) flipLatched = true; }); });
  // 收起：清状态
  $effect(() => { if (active) return; untrack(() => { closing = false; clearTimeout(closeT); toasts = []; infoOpen = false; closeMenu(); holdN = 0; focusHold = null; flipLatched = false; flipOut = false; lastPage = ''; resetTips(); }); });

  // —— 对外契约 ——
  const api = {
    inShell: true,
    get item() { return cur; }, get index() { return preview.index; }, get count() { return count; },
    get items() { return preview.items; }, itemAt: (i) => preview.items[i] || null,   // 邻居条目（滑轨预渲染、缩略图条）
    get menuOpen() { return menu.open; }, get infoOpen() { return infoOpen; },
    get host() { return host; }, get active() { return active; }, get skin() { return skin; }, get touch() { return !fine; },
    get canPrev() { return canPrev; }, get canNext() { return canNext; }, get closing() { return closing; },
    declare, chrome, toast,
    close: () => requestClose(), requestClose: () => requestClose(),
    next: () => go(1), prev: () => go(-1), go: (i) => untrack(() => { dragP = 0; previewGo(i); }),
    dragProgress: (p) => { dragP = Math.max(0, Math.min(1, +p || 0)); },
    openMenu, closeMenu, contextMenu,
    openInfo: () => openInfo(), closeInfo: () => { infoOpen = false; },
    download: () => { const c = untrack(() => cur); if (!canDownload(c)) return false; download(c); return true; },
    canDownload: () => canDownload(untrack(() => cur)),
    root: () => rootEl,
  };
  provideViewer(api);
  // ios27 浮层（触屏菜单 / Sheet）：墨色模式；媒体场景恒暗，文档随主题
  const iosDark = $derived(isMedia || ui.theme !== 'light');
  setContext('ios27', { get dark() { return iosDark; }, ink: true });

  // —— 键盘（挂在 window 冒泡阶段，是最后一站）——
  // 里面的组件先处理过的键会带着 defaultPrevented 冒上来（md 编辑器、表格格子、播放器快捷键……），不再二次解释；
  // 组字中的 Esc 是取消输入法候选，也不算。焦点在可编辑元素里时只认 Esc。
  function onKey(e) {
    if (!active || closing || e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Tab') { trapTab(e); return; }
    if (menu.open) { if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } return; }
    // 信息抽屉开着：只拦 Esc（收抽屉），其余键照常交给查看器——开着信息也能翻页、空格播放（Windows 照片 / Quick Look）
    if (infoOpen && e.key === 'Escape') { e.preventDefault(); infoOpen = false; return; }
    const mod = e.ctrlKey || e.metaKey;
    // 混排画廊里盖在画廊之上的页：←/→/Home/End 仍是画廊翻页——除非那一页声明了 seekKeys（视频：←/→ 是 ±10 秒、
    // Home / End 是回开头 / 到结尾，换文件用 PgUp / PgDn）
    if (under && !decl.seekKeys && !mod && !e.altKey && !e.shiftKey && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)
      && !isEditable(e.target) && !e.target?.closest?.('[role="slider"], [role="menu"]')) {
      if (typeof under.keys === 'function' && under.keys(e)) { e.preventDefault(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); if (e.key === 'ArrowLeft' ? canPrev : canNext) go(e.key === 'ArrowLeft' ? -1 : 1); return; }
    }
    if (typeof decl.keys === 'function' && decl.keys(e)) { e.preventDefault(); return; }
    if (under && typeof under.keys === 'function' && under.keys(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
    if (isEditable(e.target)) return;
    if (e.altKey && e.key === 'Enter') { e.preventDefault(); openInfo(); return; }
    if (mod && e.shiftKey && e.code === 'KeyC') {
      const p = cur?.absPath || cur?.saveTarget?.rel;
      if (p) { e.preventDefault(); copyText(p).then((ok) => toast(ok ? t('已复制路径') : t('无法写入剪贴板'), { kind: ok ? 'ok' : 'err' })); }
      return;
    }
    if (e.key === 'F2' && typeof preview.actions?.rename === 'function') { e.preventDefault(); preview.actions.rename(cur, ctx); return; }
    if (e.key === 'Delete' && typeof preview.actions?.trash === 'function') { e.preventDefault(); preview.actions.trash(cur, ctx); return; }
    if (mod || e.altKey) return;
    // 媒体（图片 / 视频 / 音频）：PgUp / PgDn 一律是换文件，和视频页一致（文档里 PgUp / PgDn 留给翻屏）
    if (isMedia && many && (e.key === 'PageUp' || e.key === 'PageDown') && !e.shiftKey) {
      e.preventDefault();
      if (e.key === 'PageUp' ? canPrev : canNext) go(e.key === 'PageUp' ? -1 : 1);
      return;
    }
    if (val(decl.arrows) !== false) {
      if (e.key === 'ArrowLeft' && canPrev) { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight' && canNext) { e.preventDefault(); go(1); }
    }
  }
  // Tab 在查看器里循环，不跑到背后的页面；顺序按视觉区块排（DOM 里箭头、浮条挂在舞台和底栏后面）：
  // 顶栏 → 左右箭头 → 浮条 → 舞台 → 底栏（缩略图条是单个停靠点，条内 ←/→ 移动）→ 浮层（信息抽屉等）。同一区块内按 DOM 顺序
  const TAB_SEL = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, summary, [contenteditable]:not([contenteditable="false"]), [tabindex]';
  const TAB_ZONES = ['.vw-bar', '.vw-arrow', '.vw-float', '.vw-stage', '.vw-bottom'];
  const zoneOf = (el) => { const i = TAB_ZONES.findIndex((z) => el.closest(z)); return i < 0 ? TAB_ZONES.length : i; };
  function trapTab(e) {
    if (!rootEl) return;
    e.preventDefault();
    const all = [...rootEl.querySelectorAll(TAB_SEL)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert], [hidden], [aria-hidden="true"]'));
    const f = all.map((el, i) => ({ el, i, z: zoneOf(el) })).sort((x, y) => x.z - y.z || x.i - y.i).map((x) => x.el);
    if (!f.length) return;
    const a = document.activeElement;
    let i = f.indexOf(a);
    if (i < 0 && a && a !== rootEl && rootEl.contains(a)) {
      // 焦点在不进 Tab 序列的元素上（滑轨格子、tabindex=-1 的容器）：按它所在区块与 DOM 位置找前 / 后一个
      const za = zoneOf(a);
      const after = (el) => { const z = zoneOf(el); return z > za || (z === za && !!(a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)); };
      if (e.shiftKey) { let j = f.length - 1; while (j >= 0 && after(f[j])) j--; (j >= 0 ? f[j] : f[f.length - 1]).focus(); }
      else { const j = f.findIndex(after); (j >= 0 ? f[j] : f[0]).focus(); }
      return;
    }
    if (i < 0) { (e.shiftKey ? f[f.length - 1] : f[0]).focus(); return; }
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
  }

  let rootEl = $state(null), bottomEl = $state(null);

  // 焦点：打开时移进查看器（子查看器自己抢了焦点就不动），关闭时还给打开前的元素
  $effect(() => {
    if (!active) return;
    const prev = document.activeElement;
    tick().then(() => { if (rootEl && !rootEl.contains(document.activeElement)) try { rootEl.focus({ preventScroll: true }); } catch {} });
    return () => { if (prev && prev !== document.body && prev.isConnected) try { prev.focus({ preventScroll: true }); } catch {} };
  });

  // 系统返回（安卓返回键 / 浏览器后退）：走带动画的关闭；查看器里后开的层（菜单、笔记栈、信息面板）在它之上先关
  $effect(() => { if (!active) return; return pushBackLayer(() => requestClose()); });

  // 打开时锁住背景滚动
  $effect(() => {
    if (!active) return;
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => { html.style.overflow = prev; };
  });

  // 桌面壳：查看器接管期间让原生浏览器视图（真 WebContentsView，恒在 DOM 之上）先下去
  $effect(() => {
    if (!active) return;
    return pushNativeOverlay();
  });

  // 桌面壳窗控配色：媒体条目恒暗，亮色主题下窗控字形也要画成白的（不然压在近黑背景上看不见）。
  // 只有 app 级全屏实例盖住窗口右上角；退出或切到文档条目时还原成打开前的那份（dimensio 分页自己也报 pageChrome）。
  $effect(() => {
    if (!active || !isMedia || host !== 'app') return;
    // ui 是 $state 深代理：写进去的对象会被包一层代理，不能拿 === 比「还是不是我写的那份」（Svelte 会报
    // state_proxy_equality_mismatch），按字段认；prev 先摘成普通对象，免得还原时把旧代理再包一层
    const p0 = untrack(() => ui.pageChrome);
    const prev = p0 ? { ...p0 } : null;
    ui.pageChrome = { dark: true, bg: '#0a0a0c', by: 'viewer' };
    return () => { if (untrack(() => ui.pageChrome?.by) === 'viewer') ui.pageChrome = prev; };
  });

  // 底栏高度 → --vw-bottom（toast、浮条据此让位）
  $effect(() => {
    const el = bottomEl, r = rootEl;
    if (!el || !r) { r?.style.removeProperty('--vw-bottom'); return; }
    const ro = new ResizeObserver(() => r.style.setProperty('--vw-bottom', el.offsetHeight + 'px'));
    ro.observe(el);
    return () => { ro.disconnect(); r.style.removeProperty('--vw-bottom'); };
  });

  // 图片画廊：图片条目，以及混排（里面有图片）画廊里的视频条目——视频页在滑轨里先是海报占位，停稳才挂播放器
  const useGallery = $derived(!!cur && (cur.kind === 'image' || (cur.kind === 'video' && preview.items.some((x) => x.kind === 'image'))));
  // 当前项不归画廊管（PDF / 文档 / 音频…，序列里又夹着图片：聊天附件、产物）时，邻近的图片照样预载——
  // 后两张、前一张，一次只拉一张，等当前项先拿 300ms 带宽；画廊挂着时由它自己的 planPreload 管，这里不重复拉
  $effect(() => {
    if (!active || useGallery || !cur) return;
    const i0 = preview.index, items = preview.items, want = [];
    for (const d of [1, 2, -1]) {
      const it = items[i0 + d];
      const src = it && it.kind === 'image' && !it.dataUrl ? firstSrc(it) : '';
      if (src && !want.includes(src)) want.push(src);
    }
    if (!want.length) return;
    let stop = false, im = null;
    const next = () => {
      if (stop || !want.length) return;
      im = new Image(); im.decoding = 'async';
      im.onload = im.onerror = () => { im = null; next(); };
      im.src = want.shift();
    };
    const t0 = setTimeout(next, 300);
    return () => { stop = true; clearTimeout(t0); if (im) { im.onload = im.onerror = null; im.src = ''; im = null; } };
  });

  // 读屏：画廊翻页时播报「第 i / n 个：文件名」
  const announce = $derived(active && cur && many ? t('第 {i} / {n} 个：{name}', { i: preview.index + 1, n: count, name: cur.name }) : '');
</script>

<svelte:window onkeydown={onKey} />

{#if active && cur}
  <!-- mv-root 类名保留：lib/dockTouch.js（工作台侧栏拖动豁免）、lib/uiReport.js（桌面壳截预览区域）按它找根；
       data-pv-root 给 web/scripts/preview-qa 定位用 -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="vw-root mv-root vw-{skin}" data-pv-root={host} data-kind={cur.kind} class:vw-fine={fine} class:vw-touch={!fine} class:vw-closing={closing}
    class:vw-flip-in={flipLatched} class:vw-flip-out={flipOut} class:vw-info-open={infoOpen && fine}
    bind:this={rootEl} role="dialog" aria-modal="true" aria-label={title} tabindex="-1"
    onpointermove={onRootMove} onanimationend={onRootAnimEnd} onfocusin={onRootFocusIn} onfocusout={onRootFocusOut}>
    <div class="vw-backdrop" style:opacity={isMedia ? 1 - dragP * 0.85 : null}></div>

    <div class="vw-frame">
      {#if barMode !== 'none'}
        <ViewerBar item={val(decl.dragItem) || cur} {title} {subtitle} subtitleSnippet={decl.subtitleSnippet} barEnd={decl.barEnd}
          tools={val(decl.tools) || []} touch={!fine} overlay={overlayBar} hidden={!chromeOn || dragP > 0.02}
          nav={(!isMedia || val(decl.barNav)) && many ? { canPrev, canNext, onPrev: () => go(-1), onNext: () => go(1), kbd: val(decl.arrowKbd) } : null}
          menuOpen={menu.open && menu.anchor === moreEl} onMore={onMore} bind:moreEl bind:closeEl onClose={requestClose} stacked={previewLayers.depth > 0} onhold={onBarHold} />
      {/if}

      <!-- 舞台（据 kind 路由）。下滑时整体微缩 + 圆角，营造「卡片被拎起」的手感（子查看器自己演拎起的声明 dragLift: false）。
           图片（以及混排画廊里的视频页）走 ImageGallery 滑轨：同一页内翻张不重建、不淡入 -->
      <div class="vw-stage" oncontextmenu={onStageContext} role="presentation" style:transform={dragP > 0 && decl.dragLift !== false ? `scale(${1 - dragP * 0.06})` : null} style:border-radius={dragP > 0.01 && decl.dragLift !== false ? '18px' : null}>
        {#key pageKey}
          <div class="vw-page" class:vw-page-still={useGallery}>
            {#if useGallery}
              <ImageGallery item={cur} />
            {:else if cur.kind === 'video'}
              <VideoPlayer item={cur} />
            {:else if cur.kind === 'audio'}
              <AudioPlayer item={cur} />
            {:else if cur.kind === 'pdf'}
              <PdfView item={cur} />
            {:else if cur.kind === 'office' && !/^(csv|tsv)$/i.test(cur.ext || '')}
              <!-- csv/tsv 虽归 Office 类，走 DocViewer 的 TableView（自己解码 GBK、虚拟滚动、可看原文 / 编辑） -->
              <OfficeView item={cur} />
            {:else if cur.kind === 'html'}
              <HtmlView item={cur} />
            {:else}
              <DocViewer item={cur} />
            {/if}
          </div>
        {/key}
      </div>

      {#if decl.bottom || underBottom}
        <!-- 混排画廊里盖在画廊之上的页：自己的底栏在上、画廊缩略图条在下，叠成一份底栏；
             声明了 soloBottom 的（视频：进度条下面不再垫一排缩略图）只出自己的 -->
        <div class="vw-bottom" class:vw-hide={!chromeOn} bind:this={bottomEl} style:opacity={dragP > 0 ? 1 - dragP : null}
          onpointerenter={(e) => e.pointerType === 'mouse' && onBarHold(true)} onpointerleave={(e) => e.pointerType === 'mouse' && onBarHold(false)} role="presentation">
          {#if decl.bottom}{@render decl.bottom()}{/if}
          {#if underBottom}{@render underBottom()}{/if}
        </div>
      {/if}
    </div>

    {#if decl.float && fine}
      <div class="vw-float" class:vw-hide={!chromeOn || dragP > 0.02} role="toolbar" tabindex="-1">{@render decl.float()}</div>
    {/if}

    <!-- 电脑：画廊左右箭头（鼠标一动淡入；手机靠滑动） -->
    {#if isMedia && fine && many && val(decl.arrows) !== false}
      {#if canPrev}<button type="button" class="vw-arrow left" class:on={mouseRecent && chromeOn && !dragP} onclick={() => go(-1)} use:tip={{ label: t('上一个'), kbd: (val(decl.arrowKbd) || val(under?.arrowKbd) || ['←'])[0] }}><VIcon name="prev" /></button>{/if}
      {#if canNext}<button type="button" class="vw-arrow right" class:on={mouseRecent && chromeOn && !dragP} onclick={() => go(1)} use:tip={{ label: t('下一个'), kbd: (val(decl.arrowKbd) || val(under?.arrowKbd) || [0, '→'])[1] }}><VIcon name="next" /></button>{/if}
    {/if}

    <ViewerToast list={toasts} />
    <div class="vw-sr" aria-live="polite">{announce}</div>

    <!-- 浮层槽：菜单（触屏 MorphMenu 要平铺在根的层叠上下文里，这层包裹不建层叠上下文）与文件信息 -->
    <div class="i27ink" class:dark={iosDark}>
      <ViewerMenu open={menu.open} anchor={menu.anchor} point={menu.point} items={menu.items || []} title={menu.title} place={menu.place} onclose={closeMenu} />
      {#if infoOpen}<ViewerInfo rows={infoList} onclose={() => (infoOpen = false)} ontoast={(m) => toast(m)} />{/if}
    </div>
  </div>
{/if}
