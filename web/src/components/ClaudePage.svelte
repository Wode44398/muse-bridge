<script>
  // Claude 聊天分页（从 App.svelte 抽出，原样保留已实测通过的流式/工具/历史/明暗主题/
  // AskUserQuestion/gen_media/动态工作流/侧边栏等）。顶层启动加载与路由现在归 App.svelte。
  import '../lib/claudePage/load-order.js';
  import TopBar from './TopBar.svelte';
  import SidebarToggle from './claude/SidebarToggle.svelte';
  import RoutinesPage from './RoutinesPage.svelte';
  import SidebarAppHost from './apps/SidebarAppHost.svelte';   // 侧栏「应用」组点开的插件应用（pin: 'sidebar'）
  import { api } from '../lib/api.js';
  import { me, ui, session, singleMode, sessionWt } from '../lib/state.svelte.js';
  import { isPageWindow } from '../lib/windowPage.svelte.js';
  import UserMenu from './UserMenu.svelte';
  import { swipeDismiss } from '../lib/motion.js';
  import { closePage, backPeek } from '../lib/pageMorph.js';
  import { untrack } from 'svelte';
  import { chat, newConversation, openSession } from '../lib/chat.svelte.js';
  import { busConnected } from '../lib/bus.js';
  import { titleFor, resetLibrary } from '../lib/library.svelte.js';
  import { registerCloser } from '../lib/nav.js';
  import { cacheSessions } from '../lib/cache.js';
  import ClaudeDock from './dock/ClaudeDock.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import { hasNativePickDirectory, nativePickDirectory } from '../lib/nativeDesktop.js';
  import { dock, openDock, closeDock, setDockWs } from '../lib/dock.svelte.js';
  import { layout, makeSideYield } from '../lib/layout.svelte.js';
  import { drag, dropZone, dragScrollGuard } from '../lib/dragdrop.svelte.js';
  import { dockOverlayFor } from '../lib/claudeSplit.js';
  import { agentDropZone, attachToAgent, dtHasWsFiles, wsDescriptorFrom, attachDescriptorToAgent, WS_FILE } from '../lib/fileDrag.js';
  import { isChatRef, isProjRef, canQuote, quoteSession, canRefFolder, refClaudeFolder } from '../lib/chatQuote.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { t, tc, tr } from '../lib/i18n.js';
  // 归档 / 已归档视图 / 搜索会话（2026-10-20，对齐官方 Claude Desktop）
  import SessionSearch from './claude/SessionSearch.svelte';
  import { resetArchive } from '../lib/sessionArchive.svelte.js';
  import { daysLeft, expiryWarn, newChatTarget, newChatKbd } from '../lib/quickChat.js';
  import ClaudeStage from './claude/page/ClaudeStage.svelte';
  import ClaudeSidebar from './claude/page/ClaudeSidebar.svelte';
  import ClaudeDialogs from './claude/page/ClaudeDialogs.svelte';
  import AgyPeek from './claude/workspace/AgyPeek.svelte';   // 右侧的 Antigravity 对话预览栏（共用项目里点 Antigravity 的会话）
  import { expose, providePage } from '../lib/claudePage/context.js';
  import { createSessionList } from '../lib/claudePage/sessionList.svelte.js';
  import { createQuickChats } from '../lib/claudePage/quickChats.svelte.js';
  import { createSessionTree } from '../lib/claudePage/sessionTree.svelte.js';
  import { createSessionActions } from '../lib/claudePage/sessionActions.svelte.js';
  import { createSideDnd } from '../lib/claudePage/sideDnd.svelte.js';
  import { createSplitPanes } from '../lib/claudePage/splitPanes.svelte.js';
  import { createSideApps } from '../lib/claudePage/sideApps.svelte.js';
  import { sameDir } from '../lib/pluginUi/workspace.svelte.js';

  // 页面上下文：外壳与各区段工厂、子组件经它互相取用（getter / setter 直通各自的局部状态，响应式不丢）。
  // 各区段工厂按原来在本文件里的位置依次调用——$effect 的创建顺序因此与拆分前一致。
  /** @type {any} */
  const pc = providePage({});
  expose(pc, {
    get quoteLabel() { return quoteLabel; },
    get sessionDrop() { return sessionDrop; },
    get scrollEl() { return scrollEl; }, set scrollEl(v) { scrollEl = v; },
    get composerWrapEl() { return composerWrapEl; }, set composerWrapEl(v) { composerWrapEl = v; },
    get composerInnerEl() { return composerInnerEl; }, set composerInnerEl(v) { composerInnerEl = v; },
    get wide() { return wide; },
    get pinned() { return pinned; },
    get who() { return who; },
    get atBottom() { return atBottom; }, set atBottom(v) { atBottom = v; },
    onScroll, onWheel, onTouchStart, onTouchEnd,
    closeDrawer,
    slideOut,
    get single() { return single; },
    get umAnchor() { return umAnchor; }, set umAnchor(v) { umAnchor = v; },
    toggleUserMenu,
    get meName() { return meName; },
    get meRole() { return meRole; },
    get meInitial() { return meInitial; },
    pickSession,
    newInProject,
    openRoutines,
    openNew,
    newChat,
    get IS_DESKTOP_SHELL() { return IS_DESKTOP_SHELL; },
    get NEW_KBD() { return NEW_KBD; },
    get dockWs() { return dockWs; },
    get dockName() { return dockName; },
    get showChips() { return showChips; },
    get curQuick() { return curQuick; },
    get curQuickDays() { return curQuickDays; },
    get curQuickWarn() { return curQuickWarn; },
    get saveCurQuick() { return saveCurQuick; },
    get keepCurQuick() { return keepCurQuick; },
    openProjectModal,
  });

  // 从工作空间拎一份文件过来松手 = 挂进【当前这个会话】的输入栏（不移动文件本身）。
  // 公开快照页不给：那儿的输入栏本来就不属于访客。
  // 同一块正文列也接【侧栏拖过来的会话】（手指长按拿起，见 sessHoldDown）＝引用那段对话（lib/chatQuote.js）。
  // 一个节点只挂得下一个落点，所以两种载荷在这里合成一个：按载荷类型分派 label/accept/drop。
  const fileDrop = agentDropZone('claude', { label: tc('claude', '挂进这个对话'), disabled: IS_CSNAP });
  const quoteLabel = () => (session.id ? tc('claude', '引用到这个对话') : tc('claude', '引用到新对话'));
  const claudeDrop = {
    ...fileDrop,
    label: (p) => (isChatRef(p)
      ? quoteLabel()
      : isProjRef(p)
        ? t('引用文件夹「{name}」', { name: tr(p.name) })
        : fileDrop.label(p)),
    accept: (p) => (isChatRef(p)
      ? canQuote(p.id, session.id)
      : isProjRef(p)
        ? canRefFolder(p.path)
        : fileDrop.accept(p)),
    drop: (p) => (isChatRef(p)
      ? quoteSession({ id: p.id, title: p.name })
      : isProjRef(p)
        ? refClaudeFolder({ path: p.path, name: tr(p.name) })
        : fileDrop.drop(p)),
  };
  // 电脑上（鼠标）从工作空间拖过来走的是浏览器原生 HTML5 拖拽，不是上面那套手指拖拽——
  // 语义一致：落在正文列＝挂进当前会话的输入栏。
  let wsDragOver = $state(false);
  function onWsDragOver(e) {
    if (IS_CSNAP || !dtHasWsFiles(e)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    wsDragOver = true;
  }
  function onWsDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) wsDragOver = false; }
  function onWsDrop(e) {
    if (IS_CSNAP || !dtHasWsFiles(e)) return;
    e.preventDefault();
    wsDragOver = false;
    const desc = wsDescriptorFrom(e.dataTransfer);
    if (desc) attachDescriptorToAgent(desc, 'claude');
  }
  // 侧栏里的每一条会话本身也是落点：拎着文件直接摁到那条上松手 = 切过去并挂进它的输入栏。
  // （场景「把文件发给某一个特定会话」用另一根手指点开会话再松手也成立；这条是更短的一步。）
  // 拎着的是另一条会话＝切过去并把它引用进这条的输入栏（自己拖到自己身上不接）。
  const sessionDrop = (s) => {
    const tt = titleFor(s.id, s.title);
    return {
      ...agentDropZone('claude', { key: 'chat:claude:' + s.id, disabled: IS_CSNAP }),
      label: (p) => (isChatRef(p)
        ? (tt ? t('引用到「{title}」', { title: tr(tt) }) : tc('claude', '引用到这个对话'))
        : (tt ? t('发给「{title}」', { title: tr(tt) }) : tc('claude', '发给「这个对话」'))),
      accept: (p) => (isChatRef(p) ? canQuote(p.id, s.id) : p?.type === WS_FILE && !!p.materials),
      drop: async (p) => {
        if (s.id !== session.id) { closeDrawer(); session.projectId = s.projectId || null; await openSession(s.id); }
        if (isChatRef(p)) await quoteSession({ id: p.id, title: p.name });
        else await attachToAgent(p, 'claude');
      },
    };
  };

  let scrollEl = $state();
  let composerWrapEl = $state();
  let composerInnerEl = $state();   // 输入卡片本体（.composer-inner），量卡片上沿用

  // 输入栏卡片改为悬浮在正文上（不再是底部实心隔层）：量出卡片实时高度，
  // 作为滚动区底部内边距 —— 最后一条消息仍能滚到卡片上方、不被挡住。
  // --composer-card-top = 输入【卡片】上沿到 wrap 底的距离（卡片高 + wrap 底 padding）。wrap 里在卡片
  // 上方还有归属芯片槽（滚到底才显形、高度恒占）和回退横条槽，滚动区底衬按整个 wrap 算，底部渐隐带
  // 若钉在底衬边缘就会悬在透明的芯片槽上方、正文从带子和卡片之间透出来（2026-09-11 维护者截图）——
  // 带子要按这个值钉到卡片上沿，见 .scroll-fade-strip-bottom 的 bottom。
  $effect(() => {
    if (!composerWrapEl || !scrollEl) return;
    const measure = () => {
      const wrapH = composerWrapEl.offsetHeight;
      scrollEl?.style.setProperty('--composer-h', wrapH + 'px');
      scrollEl?.parentElement?.style.setProperty('--composer-h', wrapH + 'px');   // 会话信息面板（停靠形态）据此让出输入栏
      const cardTop = composerInnerEl ? wrapH - composerInnerEl.offsetTop : wrapH;
      scrollEl?.style.setProperty('--composer-card-top', cardTop + 'px');
      // 滚动条那一列让出来：wrap 的遮罩（芯片上缘渐隐罩、卡片下方垫底色）若横跨整宽，
      // 滚到底时拇指下半截被盖住、只剩卡片旁边一截——看起来被渐变截成两半。
      composerWrapEl.style.setProperty('--sb-w', Math.max(0, scrollEl.offsetWidth - scrollEl.clientWidth) + 'px');
    };
    // border-box：wrap 的底部 padding（安全区 --sab / 键盘）变了也要回调，默认 content-box 对 padding 变化无感
    const ro = new ResizeObserver(measure);
    ro.observe(composerWrapEl, { box: 'border-box' });
    if (composerInnerEl) ro.observe(composerInnerEl, { box: 'border-box' });
    ro.observe(scrollEl);   // 滚动条出现/消失会改 content-box 宽度 → 重量 --sb-w
    measure();
    return () => ro.disconnect();
  });

  // —— 三档形态（断点单源见 lib/layout.svelte.js）——
  //   expanded ≥1100：侧栏常驻左列 + 工作台右列，两根并存（原桌面行为）；侧栏默认展开、可收起
  //   medium 700–1099（折叠屏展开 / 竖屏平板）：侧栏可【点开关常驻】，工作台也是侧列，
  //     但只塞得下一根——工作台一开侧栏自动让位，关掉自己回来（makeSideYield）
  //   compact <700：真手机，侧栏=抽屉、工作台=底部 sheet（原样不动）
  // 抽屉态只属于 compact：一进 side 档就强制关掉，汉堡语义随之从「拉抽屉」变成「切常驻」。
  // 侧列两档的开关是 claude/SidebarToggle：展开时坐在侧栏标题行右端，收起时才露到正文左上角。
  const wide = $derived(layout.expanded);          // 侧栏走常驻列（可收起，但从不变抽屉）
  const sideMode = $derived(layout.side);          // 工作台走侧列（而非底部 sheet）
  const PIN_LS = 'bridge-claude-sidepin';
  let sidePinned = $state((() => { try { return localStorage.getItem(PIN_LS) === '1'; } catch { return false; } })());
  const setPinned = (v) => { sidePinned = v; try { localStorage.setItem(PIN_LS, v ? '1' : '0'); } catch {} };
  const yielder = makeSideYield(() => sidePinned, (v) => { sidePinned = v; });   // 让位不写盘：用户的偏好仍是「常驻」
  // expanded 档的「收起侧栏」单独记：默认展开，与 medium 的常驻开关（默认收起）互不串味。
  const HIDE_LS = 'bridge-claude-sbhide';
  let sbHidden = $state((() => { try { return localStorage.getItem(HIDE_LS) === '1'; } catch { return false; } })());
  const setHidden = (v) => { sbHidden = v; try { localStorage.setItem(HIDE_LS, v ? '1' : '0'); } catch {} };
  // 侧栏此刻是否真的钉在左边：expanded 看「收起」开关（默认是），medium 看常驻开关，compact 永不。
  const pinned = $derived((layout.expanded && !sbHidden) || (layout.medium && sidePinned));
  // 收起要先播完滑出再卸载：pinned 落 false 后侧栏还留在 DOM 里（期间 inert），等外层宽度过渡真的
  // 走完（transitionend）才摘；途中又点开就直接接着用这一份（宽度过渡从当前值折返）。计时器只是兜底——
  // 分页休眠 / 过渡被取消时 transitionend 不来；那时外层宽度早已是 0、侧栏整块被裁掉，多留一会儿看不见。
  let sbLive = $state(untrack(() => pinned));
  let sbWrapEl = $state();
  $effect(() => {
    if (pinned) { sbLive = true; return; }
    const wrap = sbWrapEl;
    const done = () => { sbLive = false; };
    const onEnd = (e) => { if (e.target === wrap && e.propertyName === 'width') done(); };
    wrap?.addEventListener('transitionend', onEnd);
    const tm = setTimeout(done, 2000);
    return () => { clearTimeout(tm); wrap?.removeEventListener('transitionend', onEnd); };
  });
  // 常驻侧栏此刻的滚动条宽（列表溢出才有；触屏是覆盖式恒 0）：开关在缘内时要往里再让这么多
  let sbEl = $state();
  let sbGutter = $state(0);
  $effect(() => {
    const el = sbEl;
    if (!el) return;
    const read = () => { sbGutter = Math.max(0, el.offsetWidth - el.clientWidth - 1); };   // 1 = 右边框
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  });
  $effect(() => { if (layout.side) ui.drawerOpen = false; });
  // 工作台开合 → medium 档让位/还原（expanded 不受影响，见 makeSideYield 内的档位判断）。
  // untrack：apply 内部要读写 sidePinned，不隔离的话这个 effect 会把自己的写入当依赖再跑一轮，
  // 「工作台开着时手动点常驻」那条路径的时序就得靠 closeDock 的同步性撑着，太脆。
  $effect(() => { const open = dock.open; untrack(() => yielder.apply(open)); });
  // —— 桌面侧栏拉动（官方 claude.ai/code 同款实测规格）：宽度 200–420 钳制（官方
  // aria-valuemin/max 同值）、拖拽跟手无过渡、键盘可调（role=separator + 方向键）、
  // localStorage 持久；把手 12px 隐形条骑缝在侧栏右缘，悬停 200ms 延迟浮现 3×48 指示条。 ——
  const SB_MIN = 200, SB_MAX = 420, SB_LS = 'bridge-claude-sbw';
  const sbClamp = (v) => Math.max(SB_MIN, Math.min(SB_MAX, Math.round(v)));
  let sbW = $state((() => { const v = +(localStorage.getItem(SB_LS) || 0); return v ? sbClamp(v) : 290; })());
  let sbDrag = $state(false);
  const sbSave = () => { try { localStorage.setItem(SB_LS, String(sbW)); } catch {} };
  function sbDown(e) {
    e.preventDefault();
    const el = e.currentTarget, sx = e.clientX, sw = sbW;
    sbDrag = true;
    try { el.setPointerCapture(e.pointerId); } catch {}
    document.body.style.userSelect = 'none';   // 拖拽期间禁选字（官方 sidebar 本身 user-select:none）
    const mv = (ev) => { sbW = sbClamp(sw + ev.clientX - sx); };
    const up = () => { sbDrag = false; document.body.style.userSelect = ''; el.removeEventListener('pointermove', mv); sbSave(); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  }
  function sbKey(e) {
    if (e.key === 'ArrowLeft') sbW = sbClamp(sbW - 16);
    else if (e.key === 'ArrowRight') sbW = sbClamp(sbW + 16);
    else if (e.key === 'Home') sbW = SB_MIN;
    else if (e.key === 'End') sbW = SB_MAX;
    else return;
    e.preventDefault(); sbSave();
  }

  // —— 身份 ——
  // 没登录时不发要鉴权的请求：单 agent 模式下这一页就是根页、登录框压在它上面，此前这里会一路 401，
  // 总线也因 401 退出、登录后不再重连。换了人（退出 / 过期 / 另一个账号登录）就把上一个人的会话
  // 列表、项目列表（含本地缓存）和打开着的对话清掉——同一台设备上的下一个人不该看到这些。
  const who = $derived(me.kind === 'none' ? '' : me.kind + ':' + (me.user || ''));
  let lastWho = untrack(() => who);
  $effect(() => {
    const w = who;
    if (w === lastWho) return;
    const prev = lastWho;
    lastWho = w;
    if (!prev) return;   // 没登录 → 登录：上一个人退出时已经清过
    untrack(() => {
      pc.sessions = []; pc.projects = []; pc.projOrder = []; pc.provRows.clear();
      cacheSessions([]); pc.cacheProjects([]); pc.cacheOrder([]); resetLibrary();
      resetArchive(); pc.older = []; pc.projCounts = {}; pc.pager = {}; pc.cutoff = 0; pc.searchOpen = false;
      pc.quickExp = {}; pc.quickBin = 0; pc.binOpen = false; pc.binItems = []; pc.shownQuick = 0;
      pc.quickCount = 0; pc.quickCut = 0; pc.quickPager = null; pc.quickOrph = []; pc.chosenQuick = null;
      newConversation();
    });
  });
  expose(pc, createSessionList(pc));
  // Stick to bottom while content grows — but only if the user is already near the
  // bottom. New messages (a send or a new turn) always scroll into view.
  // 切会话（消息数组整体替换）也强制滚底——否则沿用上个会话的 atBottom=false，
  // 视口会停在半中间（「切进会话不落底」的老毛病）。
  let atBottom = $state(true);
  let lastCount = 0;
  let lastArrRef = chat.messages;
  // keep-alive 的分页在 display:none 里恢复会话时，这一脚滚底是空打的——隐藏元素
  // scrollHeight/clientHeight 恒 0，等分页露出来又没人再滚一次，视口就停在会话【顶部】
  // （入场转场的菊花也因此吸附到屏幕外的那朵星标上）。量不出高度就记账，等露出来补上。
  let pendingBottom = false;
  function toBottom() {
    if (!scrollEl) return;
    if (!scrollEl.clientHeight) { pendingBottom = true; return; }   // 还在 display:none 里
    scrollEl.scrollTop = scrollEl.scrollHeight;
    pendingBottom = false;
  }
  // —— 流式增长时平滑跟底 ——
  // 正文是逐字淡入的（lib/claudeFade.js），视口却每批「咔」地跳一行很出戏：内容增长（不是新消息）时
  // 改成每帧把视口往底部缓动（τ≈90ms，一行高的增长约 0.2s 滑到位；落差特别大直接到底）。
  // 用户一往上滚（scrollTop 变小、且不是内容变短被夹的）立刻放手；跟底途中自己造成的滚动事件
  // 不重算 atBottom——大段内容一次到达时落差可能瞬间超过 120px，重算会把跟底误判成「用户离开了底部」。
  // 手机「上滑被吸回底部」的两个根因（11-18）：① 这个循环每帧改写 lastTop，手指上拖的位移先被 rAF
  // 读到、拽回一截、再记成「上一位置」，onScroll 永远看不出用户在往上滚，atBottom 一直为真、每帧和手指
  // 抢；② 高 DPR 下 scrollTop 是小数、scrollHeight 取整，最大位置可能永远差 1px 以上够不到底，
  // += 被夹住毫无进展，循环在会话早已结束后仍空转——于是「有时候」一上滑就被吸住。
  // 对策：手指按着时不跟底；每帧先查有没有被别人往上挪过（有就放手）；写了没进展就停。
  let followRaf = 0, followT = 0, lastTop = 0, touching = false;
  const calmScroll = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stopFollow() { if (followRaf) { cancelAnimationFrame(followRaf); followRaf = 0; } }
  function followBottom() {
    if (followRaf || !scrollEl || touching) return;
    followT = performance.now();
    lastTop = scrollEl.scrollTop;
    followRaf = requestAnimationFrame(stepFollow);
  }
  function stepFollow(now) {
    followRaf = 0;
    const el = scrollEl;
    if (!el || !atBottom || touching || !el.clientHeight) return;
    const top = el.scrollTop;
    const gap = el.scrollHeight - el.clientHeight - top;
    if (top < lastTop - 0.5 && gap > 2) { atBottom = false; lastTop = top; return; }   // 用户（滚轮/拖条/惯性）往上挪了
    if (gap <= 1) return;
    const dt = Math.min(64, Math.max(1, now - followT));
    followT = now;
    let d = gap > 1600 || calmScroll() ? gap : gap * (1 - Math.exp(-dt / 90));
    if (d < 1) d = Math.min(gap, 1);
    el.scrollTop = top + d;
    lastTop = el.scrollTop;
    if (lastTop <= top + 0.1) return;                   // 被夹住没进展 = 已经是能到的最底，别空转
    followRaf = requestAnimationFrame(stepFollow);
  }
  // 手指按住期间滚动归手指：停掉跟底，松手后若仍在底部再接着跟（惯性上甩由 onScroll / stepFollow 识别放手）。
  function onTouchStart() { touching = true; stopFollow(); }
  function onTouchEnd() {
    touching = false;
    if (scrollEl) lastTop = scrollEl.scrollTop;
    if (atBottom) followBottom();
  }
  // 电脑滚轮（11-20「往上滚都滚不动、底部像磁铁」）：Chromium 平滑滚动的起步与收尾每帧只挪一两像素，
  // 旧判定要「上移 > 2px」才算用户在滚——起步那帧没认出来，跟底循环紧接着写 scrollTop，直接把这次
  // 滚轮动画打断吃掉；侥幸滚上去了，收尾那几帧又走「离底 < 120px 就重新粘底」，下一批内容一到又被吸回去。
  // 对策：① 滚轮往上 = 明确意图，wheel 事件当场放手，不等 scroll 事件猜；② 上移阈值降到 0.5px；
  // ③ 放手后只有【往下】滚回底部附近（或真到底）才重新粘底，往上的任何残余位移都不再重新吸住。
  function onWheel(e) {
    if (e.deltaY >= 0 || !scrollEl || scrollEl.scrollTop <= 0) return;
    atBottom = false;
    stopFollow();
    lastTop = scrollEl.scrollTop;
  }
  function onScroll() {
    if (!scrollEl) return;
    const top = scrollEl.scrollTop, gap = scrollEl.scrollHeight - scrollEl.clientHeight - top;
    if (top < lastTop - 0.5 && gap > 2) {               // 用户往上滚：立刻放手
      atBottom = false;
      stopFollow();
    } else if (gap <= 2) atBottom = true;               // 真到底了（含新消息落底、内容变短被夹到底）
    else if (top > lastTop + 0.5 && !followRaf && gap < 120) atBottom = true;   // 用户往下滚回底部附近
    lastTop = top;
  }
  $effect(() => {
    const arr = chat.messages;
    const n = arr.length;
    const m = arr[n - 1];
    let _ = 0;
    if (m && m.role === 'assistant') { _ = m.thinking.length + m.segments.length; const last = m.segments[m.segments.length - 1]; if (last && last.kind === 'text') _ = last.md.length; }
    const swapped = arr !== lastArrRef; lastArrRef = arr;
    if (swapped) atBottom = true;
    const newMsg = n > lastCount || swapped; lastCount = n;
    // 新消息落地那一帧布局还可能再动一下（Thread 给上一轮加 skip、图片/字体补量）；
    // 只滚一次会按半成品高度落底。补第二帧，与下面「露出后补两帧」同理。
    if (scrollEl && newMsg) requestAnimationFrame(() => { toBottom(); requestAnimationFrame(toBottom); });
    else if (scrollEl && atBottom) followBottom();     // 同一条消息在长：缓动跟底
  });
  // 分页露出（首次进 claude / 转场揭幕）→ 把隐藏期欠下的那脚滚底补上。只补欠账，
  // 用户自己滚过再回来的位置不动。**必须同步落地**：入场转场揭幕后紧接着就要量
  // 会话尾部那朵星标的位置来贴合，它排的 rAF 比这里早一帧，慢一步就量到没滚之前的位置。
  $effect(() => {
    if (ui.screen !== 'claude' || !pendingBottom) return;
    toBottom();
    // 露出后内容还会再长一点（输入卡的 ResizeObserver 补 --composer-h、图片/淡入），
    // 只滚一次会差出一张输入卡的高度；补两帧。转场层量星标排在第 3 帧，都在这之后。
    requestAnimationFrame(() => { toBottom(); requestAnimationFrame(toBottom); });
  });

  // 汉堡 / 侧栏开关：compact 拉抽屉；expanded 切「收起侧栏」；medium 切「侧栏常驻」（工作台开着时
  // 手动点＝我就要侧栏，让位记账作废、并把工作台收掉腾地方——一根侧列的档位里这是唯一讲得通的语义）。
  function onMenuKey() {
    if (layout.compact) { openDrawer(); return; }
    if (layout.expanded) {
      setHidden(!sbHidden);
      if (!sbHidden && !pc.sessions.length) pc.refreshSessions();
      return;
    }
    const next = !sidePinned;
    setPinned(next);
    yielder.forget();
    if (next && dock.open) closeDock();
    if (next && !pc.sessions.length) pc.refreshSessions();
  }
  function openDrawer() {
    ui.drawerOpen = true;
    // 列表已有内容时：网络刷新错峰到滑入动画（260ms）之后——数据返回替换列表 DOM
    // 正撞动画帧是「开抽屉卡一下」的元凶。首次（空列表）立即拉，宁可边滑边出内容。
    // 总线连着、10 秒内刚拉过：列表有总线增量在跟，不再每开一次抽屉就整表重拉（10-21）。
    if (pc.sessions.length && busConnected() && Date.now() - pc.sessionsAt < 10_000) return;
    if (pc.sessions.length) setTimeout(pc.refreshSessions, 320);
    else pc.refreshSessions();
  }
  function closeDrawer() { ui.drawerOpen = false; }
  // 返回主页：这一页收回它自己的入口，主页从后面回到前面（lib/pageMorph.js 的 closePage）。
  //
  // 【2026-09-26 重做】旧版是整页往右滑出（translateX + SPRING.glide 长尾）：打开时是方块长大、
  // 关上时却像翻页，空间关系自相矛盾；且「每两次点开必有一次进不去」「点分页图标闪退」两个
  // 老毛病的根子都是那条长尾——画面 300ms 就滑完了，数值要 ~800ms 才落地，落地回调再去改
  // ui.screen，就把人从刚进的新页里踢回主页。新版切 screen 发生在转场第一拍（快照后面），
  // 动画只在快照上跑，不存在「落地时改导航状态」的回调，这一类竞态从结构上没了。
  //
  // 左缘右滑（浏览器 / iOS；apk 里系统返回手势走 __bridgeBack）＝预测式返回：页面随手指缩小、
  // 长圆角、身后露出主页（backPeek）；松手判定完成就把此刻的形态交给 closePage 续走，
  // 判定取消则弹簧回到 0。dragX = 手指已拖的距离（0..innerWidth）。
  let dragX = $state(0);
  let sliding = $state(false);   // 手势 / 回弹驱动期间（主页被唤醒垫在身后）
  let slideEl = $state();
  const peek = $derived(backPeek(dragX));
  // 收回入口的同一拍里要归零的本地状态（在转场的更新回调里执行：旧快照已经拍下，改了看不见）
  function resetSlide() { ui.drawerOpen = false; dragX = 0; sliding = false; ui.claudeSliding = false; }
  // 程序化返回（返回键 / 系统侧滑 / 抽屉里的「主页」）。可能被直接当 onclick 处理器用，参数一律不认。
  function slideOut() {
    if (ui.screen !== 'claude') return;
    closePage('claude', { onSwitch: resetSlide });
  }
  $effect(() => registerCloser('claudeSlide', () => slideOut()));
  // —— 单 agent 模式（lib/state 的 rootScreen）：这一页就是根——没有「主页」行、左缘右滑不退页。
  // 侧栏底部是账户卡（claude.ai 左下角用户行同款），点开是设置 / 账户 / 关于与更新菜单；常规模式
  // 同一张卡，菜单换成主页 / 设置 / 工作空间 / 退出。
  // 菜单在页面级只挂一份（中屏「常驻列 + 隐藏抽屉」会把侧栏内容渲染两遍），锚点取被点那颗按钮的位置。
  const single = $derived(singleMode() || isPageWindow());
  let umAnchor = $state(null);
  function toggleUserMenu(e) { umAnchor = umAnchor ? null : e.currentTarget.getBoundingClientRect(); }
  const meName = $derived(me.kind === 'none' ? t('未登录') : (me.user || (me.kind === 'admin' ? 'admin' : '')));
  const meRole = $derived(me.kind === 'admin' ? t('管理员') : me.kind === 'user' ? (me.tier === 'pro' || me.tier === 'full' ? t('完全信任用户') : t('用户')) : '');
  const meInitial = $derived(me.kind === 'none' ? '?' : (meName || '?').trim().charAt(0).toUpperCase());
  // 左缘右滑跟手返回。起手区 40px（安卓系统手势同量级；旧值 28px 偏窄，常"划不着"）。
  const edgeSwipe = (node) => swipeDismiss(node, {
    axis: 'x', dir: 1, edge: 40, threshold: 0.32,
    // 宽屏（鼠标）不启用；侧栏常驻时左缘归侧栏所有（那儿是会话列表，再挂整页右滑会打架）；转场中不接；
    // 单页模式身后没有主页可露。
    guard: () => !(single || wide || pinned || ui.drawerOpen || ui.routinesOpen || pc.sideApp || ui.morphing),
    base: () => dragX, cur: () => dragX,
    onStart: () => { sliding = true; ui.claudeSliding = true; },
    onMove: (x) => { dragX = x; },
    onSettle: (go) => { if (!go) { sliding = false; ui.claudeSliding = false; } },   // 回弹到底 → 主页重新 dormant
    onCommit: () => {
      const rect = () => { const r = slideEl?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; };
      closePage('claude', {
        fromRect: rect, fromRadius: peek.r, onSwitch: resetSlide,
      });
    },
  });
  // 分屏时侧栏点会话 = 在【有焦点的那一格】打开；它已经开在某一格里就只把焦点挪过去（同一个对话
  // 不在两格里各开一份——两份内核各挂一条直播，谁发消息都会把另一格晾成旧快照）。
  function pickSession(s) {
    closeDrawer();
    pc.sideApp = null;   // 点了会话就是要看那段对话：侧栏应用让开（点的是当前会话 session.id 不变，也要收）
    if (pc.splitOn) {
      if (s.id === pc.paneId) { pc.focusPane(); return; }
      if (s.id === session.id) { pc.paneFocus = false; return; }
      if (pc.paneFocus) { pc.postPane({ t: 'open', id: s.id }); return; }
    }
    // 点下即高亮（pc.pickId，见 splitPanes）：不等消息加载完；这次加载落定（成功 / 失败 / 被后一次点击作废）就交还给 session.id
    pc.pickId = s.id;
    session.projectId = s.projectId || null;
    Promise.resolve(openSession(s.id)).finally(() => { if (pc.pickId === s.id) pc.pickId = null; });
  }
  // 项目行点击 = 在该项目里开新聊天（与 GPT 分页同构：项目即新会话的 cwd 上下文）。分屏时开在有焦点的那一格。
  function newInProject(p) {
    closeDrawer();
    if (pc.splitOn && pc.paneFocus) { pc.postPane({ t: 'new', projectId: p.id }); return; }
    newConversation(p.id);
  }
  function openRoutines() { closeDrawer(); pc.sideApp = null; ui.routinesOpen = true; }
  expose(pc, createSideApps(pc));

  // —— 新对话（S1-6，审查 G21）：侧栏第一行 + 手机顶栏 + 快捷键（网页 Ctrl/⌘+Shift+O，桌面壳另认 Ctrl/⌘+N）——
  // 落点（lib/quickChat.js 的 newChatTarget）：当前在真实项目里就在它里面开；在临时对话里（或还没有归属）
  // 就落到最近用过的真实项目，都没有落默认工作空间。分屏时开在有焦点的那一格，「当前项目」也认那一格的
  //（那一格的会话在侧栏列表里就按列表，空白对话按它报上来的 / 我们刚让它开的项目）。
  function openNew(pid) {
    if (pc.splitOn && pc.paneFocus) { pc.paneProjId = pid || null; pc.postPane({ t: 'new', projectId: pid || null }); return; }
    newConversation(pid || undefined);
  }
  function newChat() {
    closeDrawer();
    pc.sideApp = null;   // 新对话 = 换了上下文，侧栏应用收起（同切会话）
    const cur = pc.splitOn && pc.paneFocus ? ((pc.paneId && pc.sessions.find((s) => s.id === pc.paneId)?.projectId) || pc.paneProjId) : sessionProjId;
    openNew(newChatTarget({ currentProjectId: cur, projects: pc.projects, sessions: pc.listed }));
  }
  const IS_DESKTOP_SHELL = typeof window !== 'undefined' && !!window.BridgeDesktop;
  const NEW_KBD = newChatKbd({ desktop: IS_DESKTOP_SHELL, mac: typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') });
  expose(pc, createQuickChats(pc));
  expose(pc, createSessionTree(pc));
  expose(pc, createSessionActions(pc));
  // —— 当前会话归属哪个项目 ——
  // session.projectId 只在【显式发起】的路径上写得进去（抽屉点会话 pickSession / 新建对话
  // newConversation）。冷启动恢复与挂直播续看走的是 chat 内核的 loadSession，那条路只认
  // session.id——它虽已把服务端返回的归属回写进 session.projectId，但离线读缓存那一支拿不到，
  // 所以这里再用会话列表回查一次：有 id 就以列表里的归属为准，列表还没有它（刚拿到 id 的
  // 新会话）才回落 session.projectId。少了这一步，临时对话在冷启动后会被当成"没选目录"。
  const sessionProjId = $derived(session.id
    ? (pc.sessions.find((s) => s.id === session.id)?.projectId || session.projectId || null)
    : (session.projectId || null));

  // 别的分页点了共用文件夹上 Claude 的标识（lib/pluginUi/workspace.svelte.js 的 gotoPeerFolder）：落到这个项目。
  // 已经停在这个项目就不动；否则它正在跑的会话 → 这个项目最近的会话 → 这个项目里开新对话。接住了就 preventDefault。
  $effect(() => {
    const onOpen = (e) => {
      const { path, session: sid } = e.detail || {};
      const p = pc.projects.find((x) => !x.temporary && sameDir(x.path, path));
      if (!p) return;
      e.preventDefault();
      pc.searchOpen = false;
      if (sessionProjId === p.id && !(sid && sid !== session.id)) return;
      const hit = (sid && pc.sessions.find((s) => s.id === sid)) || pc.listed.find((s) => s.projectId === p.id);
      if (hit) pickSession(hit); else newInProject(p);
    };
    window.addEventListener('bridge:openproject', onOpen);
    return () => window.removeEventListener('bridge:openproject', onOpen);
  });

  // —— 右侧工作台（审阅/终端/浏览器/文件）：作用域=当前会话的工作空间路径 ——
  // 会话切换/项目变化自动跟随（setDockWs 内部有等值跳过；面板经 {#key} 随 ws 重建）。
  const dockProject = $derived(pc.projects.find((x) => x.id === sessionProjId) || pc.projects[0] || null);
  // worktree 会话（输入栏 worktree 勾选框开出来的）跑在 <仓库>/.claude/worktrees/<名> 里：
  // 工作台与芯片要看它，不看项目主检出。列表条目自带 wt 优先，首轮/重开时 sessionWt 兜底。
  const sessionWtCwd = $derived(session.id
    ? (pc.sessions.find((s) => s.id === session.id)?.wt?.cwd || sessionWt[session.id]?.cwd || '')
    : '');
  const dockWs = $derived(sessionWtCwd || (dockProject ? dockProject.path : ''));
  // 归属芯片的标签取【项目名】而不是路径末段：真实项目里两者本就相同（项目名固定=文件夹名），
  // 但临时对话的桶目录名是个 UUID，只有项目名（「临时对话」）读得懂。
  // —— 归属芯片认的项目：和 dockProject 有一处关键不同 ——
  // dockProject 找不到会退回 projects[0]（工作台沿用已久的兜底，不动它）；芯片不能这么退：
  // 会话指着一个【还没加载完 / 已被删 / 快照桶刚轮转】的项目时，退回默认项目等于把一个跟
  // 本会话毫不相干的目录和分支写在脸上。解析不出来就干脆不显。
  // 【只有还没有会话的空态才允许退默认工作空间】——那是新对话真实的落点；已经有会话在手
  // 却查不出归属，一律不显（冷启动恢复临时对话时误摆「Claude / main」就是这么来的）。
  const chipProject = $derived(sessionProjId
    ? (pc.projects.find((x) => x.id === sessionProjId) || null)
    : (session.id ? null : (pc.projects[0] || null)));
  // 芯片标签取【项目名】而不是路径末段：真实项目里两者本就相同（项目名固定=文件夹名），
  // 但临时对话的桶目录名是个 UUID，只有项目名读得懂。
  const dockName = $derived(tr(chipProject?.name || ''));
  // 临时对话整条状态栏都不摆：它的工作空间是个一次性空桶（仓库外、无 git、名字是 UUID），
  // 「归属」对它没有意义——换成「临时对话」芯片（claude/TempChatBand），说清它什么时候清理、能存为工作空间。
  // 解析不出项目时同样不摆。
  const showChips = $derived(!!chipProject && !chipProject.quick);
  const curQuick = $derived(!!chipProject && !!chipProject.quick && !IS_CSNAP);
  // 天数只对「有东西的」临时对话有意义：有对话的，或只有文件的那种（orphanBlank）；全新的空白临时对话不倒计时
  const curQuickLive = $derived(curQuick && (!!session.id || pc.orphanBlank));
  const curQuickDays = $derived(curQuickLive ? daysLeft(pc.quickExp[chipProject.id]) : null);
  const curQuickWarn = $derived(curQuickLive && expiryWarn(pc.quickExp[chipProject.id], pc.quickPol));
  const saveCurQuick = () => { if (curQuick) pc.saveQuick(chipProject.id, pc.sessions.find((s) => s.id === session.id)); };
  const keepCurQuick = () => { if (curQuick) pc.keepQuick(chipProject.id); };
  $effect(() => setDockWs(dockWs));
  function toggleDock() { if (dock.open) closeDock(); else openDock(dock.view === 'menu' ? 'menu' : dock.view); }

  // —— 新建项目：选一个本地文件夹当工作空间（路径即会话 cwd）；项目名固定取文件夹名。——
  // 两条路按端分流，自建目录浏览弹窗已退役：
  //   · 本机桌面壳 → 直接唤起系统原生文件夹选择器（壳与 bridge 恒在同一台机器上，
  //     打的是 127.0.0.1，所以对话框回的绝对路径服务端一定认；老壳没这个 IPC 自动回落）；
  //   · 网页 / 手机 / 老壳 → ProjectPicker（工作空间文件管理器本体 + 底部拖入栏）。
  let pickOpen = $state(false);
  // 选择器/系统对话框的起始位置＝当前项目所在处。临时对话除外：它的「路径」是仓库外一只
  // 一次性 UUID 桶，从那儿起步只会把人扔到 C:\Users\<你> 底下，不是任何人想去的地方。
  const pickFrom = $derived(chipProject && !chipProject.quick ? chipProject.path || '' : '');
  async function openProjectModal() {
    pc.closeMenu();
    if (hasNativePickDirectory()) {
      const dir = await nativePickDirectory(pickFrom);
      if (dir) await createProjectAt(dir);
      return;
    }
    pickOpen = true;
  }
  expose(pc, createSideDnd(pc));
  expose(pc, createSplitPanes(pc));
  async function createProjectAt(dir) {
    const r = await api.createClaudeProject('', dir);   // 名称留空 → 服务端取文件夹名
    const p = r.project;
    if (p && !pc.projects.some((x) => x.id === p.id)) { pc.projects = [...pc.projects, p]; pc.cacheProjects(pc.projects); }
    pickOpen = false;
    if (p) newInProject(p);   // 建完直接在新项目里开聊（与 GPT 分页一致）
    pc.refreshSessions();
  }
  const { measureW } = pc;   // 模板指令名上用到的（use:）
</script>

<!-- transform / clip-path 只在左缘右滑跟手期间有值（预测式返回：缩小 + 圆角）；平时为空，
     入场 / 返回的动画都在转场快照上做，本页 DOM 不动。 -->
<div class="claude-slide cc-tone" class:sliding bind:this={slideEl} style:transform={peek.transform}
     style:clip-path={peek.clip} use:edgeSwipe>
<!-- .wide 管的是【横向分栏】本身（侧栏/工作台都靠它成为左右列），不等于「侧栏常驻」：
     medium 档侧栏让位给工作台时 pinned=false，但仍必须是 row，否则工作台会掉到正文下面。 -->
<div class="claude-root" class:wide={pinned || sideMode}>

<!-- 侧列两档的常驻侧栏：外层 .sb-wrap 过渡宽度（0 ↔ sbW），里面的侧栏本体恒宽、贴外层右缘——
     外层变窄时本体从左边被裁掉，看上去就是整块侧栏从左边滑进滑出、把正文推开；侧栏里的行自己不跟着
     逐帧重排。收起时本体多留一个动画时长（sbLive）才卸载。开关按钮（SidebarToggle）挂在 .panes 里，
     .panes 的左缘就是这里的右缘，跟着走。 -->
{#if sideMode}
  <div class="sb-wrap" class:open={pinned} class:drag={sbDrag} style:width={(pinned ? sbW : 0) + 'px'} inert={!pinned} bind:this={sbWrapEl}>
    {#if pinned || sbLive}
      <aside class="drawer pinned" style:width={sbW + 'px'} bind:this={sbEl} use:dragScrollGuard><ClaudeSidebar /></aside>
    {/if}
  </div>
{/if}
{#if pinned}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div class="sb-handle" class:drag={sbDrag} style:left={(sbW - 6) + 'px'} role="separator"
    aria-orientation="vertical" aria-label={t('调整侧栏宽度')} aria-valuenow={sbW} aria-valuemin={SB_MIN} aria-valuemax={SB_MAX}
    tabindex="0" onpointerdown={sbDown} onkeydown={sbKey}><span class="sb-pill"></span></div>
{/if}

<!-- 整条正文列是「把文件投给这个会话」的落点：从工作空间（整页 / 工作台侧栏）拎一份文件
     过来松手，就等于把它挂进当前会话的输入栏。工作台侧栏是本列的兄弟节点，所以在侧栏里
     松手命中的是侧栏自己的落点（＝移动文件），两件事不会打架。 -->
<!-- role=presentation 只为让 use:dropZone 不被 a11y 规则当成「给非交互元素挂事件」；
     div 本来就没有隐含语义，presentation 也不会传染给里面的可交互内容。 -->
<!-- 正文区：本页这一格（对话列 + 它自己的工作台）；分屏时旁边再挂一格 iframe（SoloPage），
     中间一根分隔条。拖会话进来时整块盖一层落点（左/右半边 = 分屏）。 -->
<div class="panes" class:split={pc.splitOn} class:side-dnd={!!pc.sideDrag} class:resizing={pc.splitDragging}
  use:measureW={(pc.measureTick, (w) => { pc.panesW = w; })}>
<!-- 侧列两档的侧栏开关：挂在 .panes 上而不是某一格里——.panes 左缘恒等于侧栏右缘（分屏时左边那格可能是
     iframe），开关贴着这条缘在「侧栏标题行右端」与「正文左上角」之间滑。手机档仍是 TopBar 里的汉堡。 -->
{#if sideMode}
  <SidebarToggle open={pinned} gutter={sbGutter} onToggle={onMenuKey} onNew={IS_CSNAP ? null : newChat} />
{/if}
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pane main" class:focused={pc.splitOn && !pc.paneFocus} style={pc.splitOn ? pc.paneStyle(pc.mainSide) + (pc.mainSide === 'left' ? '--pane-wco-r:0px;' : '') : ''}
  use:measureW={(pc.measureTick, (w) => { pc.mainPaneW = w; })}
  onpointerdowncapture={() => { pc.paneFocus = false; }} onfocusincapture={() => { pc.paneFocus = false; }}>
<!-- 顶栏挂在【这一格】上而不是对话列里：侧列形态的工具开关组要坐在这一格右上角——工作台展开时正好在
     卡片上方那条带里（桌面壳下＝标题栏带、与最小化/关闭同一排），盖在正文上的工作台也压不住它。
     汉堡只在手机档出；侧列两档换成上面 .panes 里的 SidebarToggle（展开时并进侧栏标题行）。
     分屏时每一格各有一组（工具开关 · ⋮ · 关掉这一格）；贴窗口右缘的那一格才让系统窗控（--pane-wco-r）。 -->
<TopBar onMenu={onMenuKey} onDock={toggleDock} onNew={IS_CSNAP ? null : newChat} hideMenu={sideMode} tools={sideMode} split={pc.splitOn} onClose={pc.splitOn ? pc.closeMain : null} />
<div class="main-col" bind:this={pc.mainColEl} class:dnd-on={drag.overKey === 'chat:claude' || wsDragOver} role="presentation" use:dropZone={claudeDrop}
  ondragover={onWsDragOver} ondragleave={onWsDragLeave} ondrop={onWsDrop}>

<ClaudeStage />
</div>
{#if !IS_CSNAP}<AgyPeek />{/if}

<!-- 工作台归这一格：分屏且这一格不够宽时盖在正文上（不挤），够宽照旧挤开正文。
     多张卡同时开：不分屏的整页都给（折叠屏展开也是，卡片在一列里上下叠；与另外三家同一条规则），分屏两格都窄、一次一张。 -->
<ClaudeDock wide={sideMode} overlay={pc.splitOn && dockOverlayFor(pc.mainPaneW)} multi={!pc.splitOn} toolsClose={pc.splitOn ? pc.closeMain : null} />
</div>

{#if pc.splitOn}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="split-grip" role="separator" aria-orientation="vertical" aria-label={t('拖动调整两格宽度（双击恢复一半一半）')}
    onpointerdown={pc.splitGripDown} ondblclick={pc.splitGripReset}><span></span></div>
  <div class="pane frame" class:focused={pc.paneFocus} style={pc.paneStyle(pc.split.side)}>
    <iframe class="bridge-pane" bind:this={pc.paneFrame} src={pc.paneSrc} title={tc('claude', '分屏：另一个对话')}
      allow="clipboard-read; clipboard-write; fullscreen"></iframe>
  </div>
{/if}

{#if (pc.sideDrag?.kind === 'session' || (pc.sideDrag?.kind === 'project' && pc.sideDrag?.path)) && (pinned || !ui.drawerOpen)}
  <!-- 会话或工作空间拖进正文区的落点层：拖会话时高亮左/右半区分屏并露出输入框引用区；拖工作空间时仅露出输入框引用文件夹区 -->
  <div class="split-drop" role="presentation" bind:this={pc.splitDropEl} ondragover={pc.onSplitOver} ondragleave={pc.onSplitLeave} ondrop={pc.onSplitDrop}>
    {#if pc.sideDrag?.kind === 'session'}
      {#each pc.dropZones as z (z.side + pc.dropZones.length)}
        <div class="sd-zone" class:on={pc.splitHover === z.side} class:nope={pc.splitHover === z.side && pc.hoverPlan?.kind === 'none'}
          style="left:{z.l}px;width:{z.w}px">
          {#if pc.splitHover === z.side}<span class="sd-label">{pc.hoverLabel}</span>{/if}
        </div>
      {/each}
    {/if}
    <!-- 输入栏上的「引用」区：会话拖进来引用对话，工作空间拖进来引用文件夹 -->
    {#each pc.quoteRects as q (q.target)}
      <div class="sd-quote" class:on={pc.quoteHover === q.target} class:nope={pc.quoteHover === q.target && !pc.quoteOk(q.target)}
        style="left:{q.l}px;top:{q.t}px;width:{q.w}px;height:{q.h}px">
        <span class="sd-label">{pc.quoteHover === q.target ? pc.quoteLabelFor(q.target) : pc.quoteIdleLabel()}</span>
      </div>
    {/each}
  </div>
{/if}
<!-- 定时任务：侧栏常驻（电脑）时铺在正文区、侧栏照旧可点；手机是下面那份全屏页 -->
{#if pinned}<RoutinesPage embedded />{/if}
{#if pinned && pc.sideApp}<SidebarAppHost appKey={pc.sideApp} embedded onClose={pc.closeSideApp} />{/if}
</div>


<!-- 窄屏：侧拉抽屉 + scrim（宽屏时常驻列已渲染在上方，这里不再出现） -->
{#if !wide}
  <button class="scrim {ui.drawerOpen ? 'open' : ''}" aria-label={t('关闭侧栏')} onclick={closeDrawer}></button>
  <aside class="drawer {ui.drawerOpen ? 'open' : ''}" bind:this={pc.drawerEl} use:dragScrollGuard><ClaudeSidebar /></aside>
{/if}

<!-- 账户卡菜单：页面级只挂一份（见 toggleUserMenu 注释） -->
{#if umAnchor}
  <UserMenu anchor={umAnchor} onclose={() => (umAnchor = null)} onpick={() => { umAnchor = null; closeDrawer(); }}
    onhome={single ? null : slideOut} />
{/if}

<!-- 新建项目：工作空间文件管理器当选择器，长按文件夹拖进底栏＝选它当项目工作空间 -->
{#if pickOpen}
  <ProjectPicker preferPath={pickFrom} onPick={createProjectAt} onClose={() => (pickOpen = false)} />
{/if}

<ClaudeDialogs />

<!-- 搜索会话：宽屏居中面板 / 手机全屏页 -->
{#if pc.searchOpen}
  <SessionSearch sessions={pc.listed} projects={pc.projects} full={layout.compact} onOpen={pc.openHit} onClose={() => (pc.searchOpen = false)} />
{/if}

{#if !pinned}<RoutinesPage />{/if}
{#if !pinned && pc.sideApp}<SidebarAppHost appKey={pc.sideApp} onClose={pc.closeSideApp} />{/if}
</div>
</div>
<svelte:window onkeydown={pc.onSearchKey} />

<style>
  /* 分页层：fixed 全屏盖在主页之上；左缘右滑时缩小露出身后主页（backPeek）。
     不挂 box-shadow：转场快照连同阴影一起拍（墨水溢出），会让快照比页面大一圈、落位对不齐。 */
  .claude-slide { position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column;
    padding-bottom: var(--kb, 0px);   /* 键盘高度兜底（同 vertex-slide），原生方案生效时恒 0 */
    background: var(--bg); will-change: transform; transform-origin: 50% 50%;
    /* transform 不再走 CSS 过渡：位移全程由手势 / 弹簧逐帧驱动（lib/motion.js），
       两套插值并存会在松手瞬间打架（弹簧改一次值、过渡又去追它＝一顿一顿的）。 */
    transition: background-color var(--mo-base) var(--ea-fade), color var(--mo-base) var(--ea-fade); }
  .claude-root { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  /* 宽屏（≥1024px，由 script 的 matchMedia 同步 .wide）：侧栏常驻左列 + 内容列 */
  .claude-root.wide { flex-direction: row; position: relative; }
  .main-col { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; position: relative; }
  /* 正文区宿主：本页这一格（对话列 + 工作台）[+ 分隔条 + iframe 那一格]。没分屏时它就是原来那条 row。 */
  .panes { flex: 1; min-width: 0; min-height: 0; display: flex; position: relative; }
  .pane { position: relative; min-width: 0; min-height: 0; display: flex; }
  .pane.main { flex: 1; }
  .pane.frame { background: var(--bg); }
  .pane.frame iframe { flex: 1; width: 100%; height: 100%; border: 0; display: block; background: var(--bg); }
  /* 拖会话 / 拖分隔条期间 iframe 不吃指针：拖拽事件才落得到本页的落点层，指针滑过去也不丢 move */
  .panes.side-dnd iframe, .panes.resizing iframe { pointer-events: none; }
  /* 分屏：有焦点的那一格顶上一道珊瑚线（dimensio 分屏同一语言） */
  .panes.split .pane.focused::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; z-index: 36;
    background: var(--coral); pointer-events: none; }
  .split-grip { order: 1; flex: none; width: 6px; position: relative; cursor: col-resize; touch-action: none; z-index: 34;
    background: var(--divider); -webkit-app-region: no-drag; }
  .split-grip span { position: absolute; left: 50%; top: 50%; width: 3px; height: 44px; transform: translate(-50%, -50%);
    border-radius: 999px; background: var(--muted); opacity: 0; transition: opacity .18s ease .12s; }
  .split-grip:hover span, .panes.resizing .split-grip span { opacity: .9; }
  .panes.resizing .split-grip { background: color-mix(in srgb, var(--coral) 55%, var(--divider)); }
  /* 会话拖进正文区的落点层：两块半透明区，手在哪块哪块亮、居中写明松手会怎样 */
  .split-drop { position: absolute; inset: 0; z-index: 60; }
  .sd-zone { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center;
    transition: background-color .14s ease, box-shadow .14s ease; }
  .sd-zone.on { background: color-mix(in srgb, var(--coral) 9%, transparent); box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--coral) 70%, transparent); border-radius: 14px; }
  .sd-zone.nope { background: color-mix(in srgb, var(--muted) 8%, transparent); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--muted) 45%, transparent); }
  .sd-label { padding: 7px 14px; border-radius: 999px; background: var(--q-card); color: var(--text); font-size: 13.5px;
    box-shadow: var(--q-shadow); pointer-events: none; animation: sdIn .16s cubic-bezier(.2, .9, .3, 1.1); }
  .sd-zone.nope .sd-label { color: var(--muted); }
  /* 输入栏上的「引用」区：平时一圈淡虚线 + 淡提示（告诉人这里能放），悬停才实线高亮、写明动作 */
  .sd-quote { position: absolute; display: flex; align-items: center; justify-content: center; border-radius: 24px;
    border: 1.5px dashed color-mix(in srgb, var(--coral) 45%, transparent); background: color-mix(in srgb, var(--bg) 55%, transparent);
    transition: background-color .15s, border-color .15s; }
  .sd-quote .sd-label { opacity: .8; }
  .sd-quote.on { border-style: solid; border-color: color-mix(in srgb, var(--coral) 80%, transparent); background: color-mix(in srgb, var(--coral) 12%, var(--bg)); }
  .sd-quote.on .sd-label { opacity: 1; }
  .sd-quote.nope { border-color: color-mix(in srgb, var(--muted) 45%, transparent); background: color-mix(in srgb, var(--muted) 8%, var(--bg)); }
  .sd-quote.nope .sd-label { color: var(--muted); }
  @keyframes sdIn { from { opacity: 0; transform: translateY(4px) scale(.97); } }
  /* 拖着文件悬在正文上：整列亮一圈，明确「松手就挂进这个会话」 */
  .main-col.dnd-on::after { content: ''; position: absolute; inset: 6px; border-radius: 16px; pointer-events: none;
    box-shadow: inset 0 0 0 2px var(--coral); background: color-mix(in srgb, var(--coral) 7%, transparent); z-index: 3; }
  .drawer.pinned {
    position: static; transform: none; visibility: visible; transition: none;
    max-width: none; flex: none; height: auto; box-shadow: none;   /* 宽度由 style:width（拉动持久值）下发 */
    /* 抽屉那份 z-index:50 不能带过来：它是弹性子项，带着 z-index 就自成层叠上下文、整块盖过 .panes 里
       z 30 的侧栏开关（开关展开时正叠在本栏标题行上）。常驻列本来就各占一列，不需要抬层。 */
    z-index: auto;
  }
  /* 常驻侧栏的外层：只过渡宽度，本体贴右缘（flex-end，溢出落在左边被裁）＝整块从左边滑进滑出。
     收起用 --mo-base、展开用 --mo-page（过渡取【变化后】那一侧的声明）；曲线与 SidebarToggle 的 left
     必须同时长同曲线——开关就是靠这一点贴着侧栏右缘走的，改这里要两边一起改。
     overflow 用 clip 不用 hidden：hidden 会变成可滚动容器，滑动途中焦点落进被裁掉的那截时浏览器
     会把它横向滚过去，整块侧栏错位。拖宽度时跟手、不过渡。 */
  .sb-wrap { flex: none; min-height: 0; display: flex; justify-content: flex-end; overflow: clip;
    transition: width var(--mo-base) var(--ea-std); }
  .sb-wrap.open { transition: width var(--mo-page) var(--ea-std); }
  .sb-wrap.drag { transition: none; }
  /* 侧栏拉动把手：全高 col-resize 隐形条，3×48 指示条悬停 200ms 延迟浮现、拖拽中常显、键盘聚焦转珊瑚色。
     照官方 12px 骑缝（left = 宽-6，接缝两侧各 6px）。骑进侧栏那半会盖住侧栏滚动条的槽——鼠标正落在拇指上时
     lib/scrollbars.js 让把手临时不吃指针（拇指优先），只让拇指本体那一块，别处照常能拖。
     指示条居中压在接缝线上，pointer-events:none。 */
  .sb-handle { position: absolute; top: 0; bottom: 0; width: 12px; z-index: 45; cursor: col-resize; outline: none;
    transition: left var(--mo-page) var(--ea-std); }   /* 键盘方向键调宽时随 .sb-wrap 一起过渡；拖拽跟手 */
  .sb-handle.drag { transition: none; }
  .sb-pill { position: absolute; left: 6px; top: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px;
    border-radius: 999px; background: var(--muted); opacity: 0; pointer-events: none;
    transition: opacity .2s ease .2s, background-color .2s ease; }
  .sb-handle:hover .sb-pill, .sb-handle.drag .sb-pill { opacity: 1; }
  .sb-handle:focus-visible .sb-pill { opacity: 1; background: var(--coral); transition-delay: 0s; }

  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); opacity: 0; visibility: hidden; transition: opacity .25s ease, visibility .25s; z-index: 40; }
  .scrim.open { opacity: 1; visibility: visible; }
  /* 侧栏比正文区高一档（官方 fizzy-lake）：栏内凡是垫 --bg 的（字标行、账户卡、渐隐）一起换成侧栏色 */
  .drawer { --bg: var(--side-bg); }
  .drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 80vw; max-width: 320px; background: var(--bg); border-right: 1px solid var(--divider); transform: translateX(-100%); visibility: hidden; transition: transform .26s cubic-bezier(.22,1,.36,1), background-color .25s ease, visibility 0s linear .26s; z-index: 50; display: flex; flex-direction: column; padding: 10px 8px; padding-top: max(10px, var(--sat)); overflow-y: auto; }
  /* 关闭态 visibility:hidden —— 侧滑返回时 .claude-slide 的 transform 会把屏外的 drawer 推进屏内，
     隐藏掉就不会"先展开侧边栏"；visibility 用 .26s 延迟，保证关闭滑出动画本身可见、滑完才隐藏。 */
  .drawer.open { transform: none; visibility: visible; transition: transform .26s cubic-bezier(.22,1,.36,1), background-color .25s ease, visibility 0s linear 0s; box-shadow: 0 0 40px rgba(0,0,0,.3); }


</style>
