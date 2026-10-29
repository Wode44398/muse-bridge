<script>
  // Claude 聊天分页（从 App.svelte 抽出，原样保留已实测通过的流式/工具/历史/明暗主题/
  // AskUserQuestion/gen_media/动态工作流/侧边栏等）。顶层启动加载与路由现在归 App.svelte。
  import { fade, fly } from 'svelte/transition';
  import { sendComposer, receiveComposer, softDrop } from '../lib/transitions.js';
  import TopBar from './TopBar.svelte';
  import Composer from './Composer.svelte';
  import WorkspaceChips from './WorkspaceChips.svelte';
  import Thread from './Thread.svelte';
  import ClaudeLogo from './ClaudeLogo.svelte';
  import ClaudeCodeWordmark from './claude/ClaudeCodeWordmark.svelte';
  import RefusalBand from './claude/RefusalBand.svelte';
  import PermissionCard from './claude/PermissionCard.svelte';   // 逐次工具审批卡（输入框上方停靠）
  import QueueBar from './claude/QueueBar.svelte';
  import PeerHoldBand from './claude/PeerHoldBand.svelte';
  import McpAuthBand from './claude/McpAuthBand.svelte';
  import LandingTexture from './claude/LandingTexture.svelte';
  import SessionRail from './claude/SessionRail.svelte';
  import CodeStatsCard from './claude/CodeStatsCard.svelte';
  import RoutinesPage from './RoutinesPage.svelte';
  import { api } from '../lib/api.js';
  import { uiAlert, uiConfirm } from '../lib/dialogs.js';
  import { me, ui, session, settings, setTheme, singleMode, sessionWt, pluginOn } from '../lib/state.svelte.js';
  import UserMenu from './UserMenu.svelte';
  import { updateInfo } from '../lib/updateStore.svelte.js';
  import { swipeDismiss } from '../lib/motion.js';
  import { closePage, backPeek } from '../lib/pageMorph.js';
  import { mountDrag } from '../lib/capsule.js';
  import { untrack } from 'svelte';
  import { chat, newConversation, openSession, requestSync, prefetchSessions, onBusEvent } from '../lib/chat.svelte.js';
  import { setSessionSource } from '../lib/sessionFamily.svelte.js';
  import { busStart, busStop, busOn, busConnected } from '../lib/bus.js';
  import { placeTouched } from '../lib/sessionsOrder.js';
  import { isStarred, toggleStar, titleFor, renameSession, applyServerLibrary, resetLibrary, forgetSession } from '../lib/library.svelte.js';
  import { registerCloser } from '../lib/nav.js';
  import { marquee } from '../lib/marquee.js';
  import { cacheSessions, getCachedSessions, removeCachedMessages } from '../lib/cache.js';
  import { absorbLastPrefs } from '../lib/chatPrefs.js';
  import ClaudeDock from './dock/ClaudeDock.svelte';
  import ProjectPicker from './ProjectPicker.svelte';
  import { hasNativePickDirectory, nativePickDirectory } from '../lib/nativeDesktop.js';
  import { dock, openDock, closeDock, setDockWs } from '../lib/dock.svelte.js';
  import { layout, makeSideYield, pointer } from '../lib/layout.svelte.js';
  import { drag, dropZone, dragScrollGuard, beginDrag, makeHold, dropToast } from '../lib/dragdrop.svelte.js';
  import { applyProjectOrder, moveId, splitDropPlan, splitDropLabel, canSplitWidth, dockOverlayFor, MIN_PANE } from '../lib/claudeSplit.js';
  import { soloUrl, PANE_MSG, isPaneMsg } from '../lib/solo.js';
  import { openSettings } from '../lib/settingsNav.svelte.js';   // 分屏格托宿主页开设置（onPaneMsg 的 settings）
  import { wcoHeight, wcoRightInset } from '../desktop/chrome/wco.svelte.js';
  import { agentDropZone, attachToAgent, dtHasWsFiles, wsDescriptorFrom, attachDescriptorToAgent, WS_FILE } from '../lib/fileDrag.js';
  import { CHAT_REF, isChatRef, canQuote, quoteSession } from '../lib/chatQuote.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { t, tc, tr } from '../lib/i18n.js';
  // 归档 / 已归档视图 / 搜索会话（2026-10-20，对齐官方 Claude Desktop）
  import SessionSearch from './claude/SessionSearch.svelte';
  import ArchivedBand from './claude/ArchivedBand.svelte';
  import { arch, archClock, noteSessionList, noteArchiveRev, stickyArchived, setArchivedIds, archiveProject, loadArchived, openArchivedView, closeArchivedView, dropArchivedRow, resetArchive, isArchivedId, markArchivedSeen } from '../lib/sessionArchive.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { relTime } from '../lib/format.js';
  import { descendantsOf, mergeOlder, pagerFrom, serverRestOf } from '../lib/sessionArchiveView.js';
  import { reportUi } from '../lib/uiReport.js';
  // 新对话入口 + 临时对话（原「快照」）按时间回收（S1-6，2026-10-22）
  import TempChatBand from './claude/TempChatBand.svelte';
  import { cs as claudeCs } from '../lib/claudeSettings.svelte.js';
  import { daysLeft, expiryWarn, quickPolicy, newChatTarget, isNewChatKey, newChatKbd, landingFor } from '../lib/quickChat.js';

  // 从工作空间拎一份文件过来松手 = 挂进【当前这个会话】的输入栏（不移动文件本身）。
  // 公开快照页不给：那儿的输入栏本来就不属于访客。
  // 同一块正文列也接【侧栏拖过来的会话】（手指长按拿起，见 sessHoldDown）＝引用那段对话（lib/chatQuote.js）。
  // 一个节点只挂得下一个落点，所以两种载荷在这里合成一个：按载荷类型分派 label/accept/drop。
  const fileDrop = agentDropZone('claude', { label: tc('claude', '挂进这个对话'), disabled: IS_CSNAP });
  const quoteLabel = () => (session.id ? tc('claude', '引用到这个对话') : tc('claude', '引用到新对话'));
  const claudeDrop = {
    ...fileDrop,
    label: (p) => (isChatRef(p) ? quoteLabel() : fileDrop.label(p)),
    accept: (p) => (isChatRef(p) ? canQuote(p.id, session.id) : fileDrop.accept(p)),
    drop: (p) => (isChatRef(p) ? quoteSession({ id: p.id, title: p.name }) : fileDrop.drop(p)),
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
  let sessions = $state([]);
  // 会话协作（sessionFamily.svelte.js）：工具行 / 会话消息卡按这份列表把「标题 / name」解析成会话 id
  setSessionSource(() => sessions);
  // Claude 项目（路径制：项目=工作空间目录=会话 cwd，服务端 claude-projects.json，[0] 恒为
  // 默认项目）。显示名由服务端固定为工作空间文件夹名（不可改名）。列表小，本地缓存走
  // localStorage 即可（v3：v2 存过自定义名，弃掉避免旧名闪现）。
  let projects = $state([]);
  const PROJ_LS = 'bridge-claude-projects-v3';
  const loadCachedProjects = () => { try { return JSON.parse(localStorage.getItem(PROJ_LS)) || []; } catch { return []; } };
  const cacheProjects = (list) => { try { localStorage.setItem(PROJ_LS, JSON.stringify(list)); } catch {} };
  // 侧栏里拖出来的项目显示顺序（服务端 claude-projects.json 的 order，跨设备同一份）；本地镜像让冷启动不闪。
  // 显示顺序与 projects 数组本身分开：projects[0] 恒为默认工作空间，是工作台/芯片兜底的约定，不能被拖乱。
  const ORDER_LS = 'bridge-claude-proj-order';
  let projOrder = $state((() => { try { return JSON.parse(localStorage.getItem(ORDER_LS)) || []; } catch { return []; } })());
  const cacheOrder = (o) => { try { localStorage.setItem(ORDER_LS, JSON.stringify(o || [])); } catch {} };
  let orderPending = 0;   // 排序请求在途时不拿服务端旧顺序覆盖本地刚拖好的

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

  // 官方 /code 落地页问候（cc43287c9 nz，What’s up next, {name}?）
  const greetName = $derived(me.user ? t('{name}，接下来做什么？', { name: me.user }) : t('接下来做什么？'));

  // —— 三档形态（断点单源见 lib/layout.svelte.js）——
  //   expanded ≥1100：侧栏常驻左列 + 工作台右列，两根并存（原桌面行为）
  //   medium 700–1099（折叠屏展开 / 竖屏平板）：侧栏可【点汉堡常驻】，工作台也是侧列，
  //     但只塞得下一根——工作台一开侧栏自动让位，关掉自己回来（makeSideYield）
  //   compact <700：真手机，侧栏=抽屉、工作台=底部 sheet（原样不动）
  // 抽屉态只属于 compact：一进 side 档就强制关掉，汉堡语义随之从「拉抽屉」变成「切常驻」。
  const wide = $derived(layout.expanded);          // 侧栏【恒】常驻
  const sideMode = $derived(layout.side);          // 工作台走侧列（而非底部 sheet）
  const PIN_LS = 'bridge-claude-sidepin';
  let sidePinned = $state((() => { try { return localStorage.getItem(PIN_LS) === '1'; } catch { return false; } })());
  const setPinned = (v) => { sidePinned = v; try { localStorage.setItem(PIN_LS, v ? '1' : '0'); } catch {} };
  const yielder = makeSideYield(() => sidePinned, (v) => { sidePinned = v; });   // 让位不写盘：用户的偏好仍是「常驻」
  // 侧栏此刻是否真的钉在左边：expanded 恒是，medium 看用户开关，compact 永不。
  const pinned = $derived(layout.expanded || (layout.medium && sidePinned));
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
      sessions = []; projects = []; projOrder = [];
      cacheSessions([]); cacheProjects([]); cacheOrder([]); resetLibrary();
      resetArchive(); older = []; projCounts = {}; pager = {}; cutoff = 0; searchOpen = false;
      quickExp = {}; quickBin = 0; binOpen = false; binItems = []; shownQuick = 0;
      quickCount = 0; quickCut = 0; quickPager = null; quickOrph = []; chosenQuick = null;
      newConversation();
    });
  });

  // keep-alive 后本组件常驻挂载，刷新/镜像轮询都要看「确实在 claude 页」，
  // 否则在主页/vertex 页背后也白跑网络请求。
  // 进 claude 页即拉会话列表（宽屏常驻列 + 窄屏抽屉共用）：本地缓存先出、网络刷新殿后，
  // 抽屉一拉开就有内容，不再「拉出等一下才看见列表」。每轮结束（busy→false）再刷一次
  // （状态点/新会话跟手）。untrack：refreshSessions 内读 sessions，别让它成为依赖。
  // 读 who：登录 / 换人后重拉。
  $effect(() => { if (ui.screen === 'claude' && !session.busy && who) untrack(refreshSessions); });

  // —— 多端实时同步：订阅账号级事件总线（/api/stream）——
  // 别的设备（手机 / 电脑网页 / 桌面客户端）发起一轮、跑完一轮，或任何进程写了 transcript
  //（含不经 bridge 的 CLI / 桌面 Claude Code / routines），都会即时推到这里：
  // 列表就地增量更新，正文交给 chat 层去挂直播或静态跟随。
  // 总线按身份订阅（服务端 key = 账号）：换人时随 who 断开重连。
  $effect(() => {
    if (ui.screen !== 'claude' || !who) return;
    busStart();
    const off = busOn(onSync);
    return () => { off(); busStop(); };
  });

  // 兜底轮询：总线断着的时候（服务端旧版本、隧道抽风、鉴权过期）退回 4s 一次的
  // requestSync（内核幂等，探活+收敛一体），体验退化成"最多等 4s"而不是"完全不同步"。
  // 总线连着就不跑，不做重复网络请求。回前台/联网的对账由内核自己的 wake 钩子负责，
  // 页面层不再各挂各的。
  // 总线一直连不上（10-21）：间隔逐步拉长——头一分钟 4s，之后 8s、再之后 16s 封顶，每次带一点抖动，
  // 多台设备不会踩着同一拍一起打服务端；总线一恢复就归零。
  $effect(() => {
    if (ui.screen !== 'claude' || !who) return;
    if (!document.hidden && !busConnected()) requestSync('page');
    let tick = 0, miss = 0, skip = 0;
    const iv = setInterval(() => {
      if (document.hidden || busConnected()) { miss = 0; skip = 0; return; }
      if (skip > 0) { skip--; return; }
      requestSync('poll');
      // 列表刷新降频到 ~16s 起：/api/sessions 要扫一遍所有项目目录，
      // 跟着 4s 探活一起跑会把兜底路径变成持续的磁盘压力。
      if (++tick % 4 === 0) untrack(refreshSessions);
      miss++;
      skip = (1 << Math.min(2, Math.floor(miss / 15))) - 1 + (Math.random() < 0.3 ? 1 : 0);
    }, 4000);
    return () => clearInterval(iv);
  });

  // 总线事件 → 会话列表就地增量。整表重拉（/api/sessions 要遍历所有项目目录、逐文件读
  // 标题）太重，扛不住推送频率；这里只动受影响的那一行，只有"列表里根本没有这个 id"
  // （别处新建的会话）才补一次全量刷新。
  let _syncPending = null;
  function patchSession(id, patch) {
    const i = sessions.findIndex((s) => s.id === id);
    if (i < 0) return false;
    sessions[i] = { ...sessions[i], ...patch };
    return true;
  }
  function bumpToTop(id, mtime) {
    // 列表恒按 mtime 倒序（服务端同序）：touch 只把那一行【按 mtime 插回该在的位置】，
    // 不再一到就顶到最前——乱序/重复/迟到的总线事件（目录事件≠内容变化、断线补播）曾把
    // mtime 很旧的会话顶到列表最上面，看着像乱序（09-13）。mtime 没变大就原地不动。
    const next = placeTouched(sessions, id, mtime);
    if (next === null) return false;
    if (next !== sessions) sessions = next;
    return true;
  }
  // 列表里没有的 id = 别处刚新建的会话：只有这时才值得付一次全量扫盘。合并 800ms 内的
  // 多次触发，免得一轮开跑时 run.start + 连串 session.touch 各刷一遍。
  function refreshSoon() {
    if (_syncPending) return;
    _syncPending = setTimeout(() => { _syncPending = null; untrack(refreshSessions); }, 800);
  }
  function onSync(ev) {
    if (ev.type === 'library') { applyServerLibrary(ev.library); return; }   // 别的设备收藏/改名
    if (ev.type === 'hello') {
      if (ev.library) applyServerLibrary(ev.library);
      if (noteArchiveRev(ev.archiveRev)) refreshSoon();   // 断线期间别处归档 / 取消归档过：整表重拉
      const live = new Set((ev.runs || []).map((r) => r.sessionId).filter(Boolean));
      const pend = new Set(ev.pending || []);
      for (const s of sessions) {
        if (!!s.thinking !== live.has(s.id) || !!s.pending !== pend.has(s.id)) {
          patchSession(s.id, { thinking: live.has(s.id), pending: pend.has(s.id) });
        }
      }
    } else if (ev.type === 'run.start') {
      if (!patchSession(ev.sessionId, { thinking: true })) refreshSoon();
    } else if (ev.type === 'run.end') {
      patchSession(ev.sessionId, { thinking: false, pending: !!ev.pending });   // pending：同会话还扣着跨会话消息等你确认（服务端 pendingFor）
    } else if (ev.type === 'question') {
      patchSession(ev.sessionId, { pending: !!ev.pending });
    } else if (ev.type === 'session.touch') {
      // 手动归档的会话在 Desktop / CLI 里接着聊：它不会回到列表，不为它每轮整表重拉
      if (!bumpToTop(ev.sessionId, ev.mtime) && !stickyArchived(ev.sessionId)) refreshSoon();
    } else if (ev.type === 'family' && ev.child) {
      refreshSoon();   // 某个会话刚派生了子会话：侧栏重拉，让它挂到父会话下面
    } else if (ev.type === 'archive') {
      refreshSoon();   // 归档 / 取消归档（本机、别的设备或自动归档）：整表重拉——归档的让出名额，取消归档的回到列表
    } else if (ev.type === 'session.gone' && ev.sessionId) {
      // 别处删了一条会话：整表刷新只管最新 60 条，翻页拿回来的老行、已归档列表里的这一行得就地摘掉
      dropRows((s) => s.id === ev.sessionId); dropArchivedRow(ev.sessionId);
    }
    onBusEvent(ev);   // 正文侧：挂直播 / 静态跟随
  }
  $effect(() => () => { if (_syncPending) { clearTimeout(_syncPending); _syncPending = null; } });

  // 列表等值跳过：内容没变就不赋值——反复开抽屉/轮询刷新不再每次重建列表 DOM。
  const sameSessions = (a, b) => a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && x.title === y.title && !!x.thinking === !!y.thinking && !!x.pending === !!y.pending && (x.projectId || null) === (y.projectId || null) && (x.parentId || null) === (y.parentId || null);
  });
  function applySessions(list) { if (!sameSessions(sessions, list)) sessions = list; }
  // path 也要比：存好的临时对话工作空间会被服务端挪到固定位置（id、名字不变，只换 path），工作台得跟过去。
  // current 也要比：开新临时对话用的那只空桶换了，落点要跟上。
  const sameProjects = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id && x.name === b[i].name && x.path === b[i].path && !!x.current === !!b[i].current);

  let sessionsAt = 0;   // 上次整表拉成功的时刻（非响应式，抽屉开合据此决定要不要重拉）
  async function refreshSessions() {
    if (!sessions.length) { try { const c = await getCachedSessions(); if (c && c.length && !sessions.length) sessions = c; } catch {} }  // 先出缓存，再后台刷新
    if (!projects.length) { const c = loadCachedProjects(); if (c.length && !projects.length) projects = c; }
    // 缓存/预取都吃网络原样列表而非 sessions：等值跳过时 sessions 保留旧 mtime，
    // 预取器会看不见「桌面端刚聊过的会话」（id/title 没变、只有 mtime 变）。
    try {
      const since = archClock();   // 请求在路上时归档态有没有再变（lib/sessionArchive.svelte.js 的乐观隐藏收尾）
      const d = await api.sessions(older.slice(0, 150).map((s) => s.id)); const list = d.sessions || [];   // keep 走 URL：控制在 ~6KB
      // 翻页拿回来的老行对账：别处删了 / 归档了（含跟随 Desktop）的服务端回在 gone 里，摘掉，不留幽灵行
      if (Array.isArray(d.gone) && d.gone.length) { const g = new Set(d.gone); older = older.filter((s) => !g.has(s.id)); }
      noteSessionList(d, since); if (d.projectCounts) projCounts = d.projectCounts;   // 已归档总数 / 各项目活跃会话总数（组内翻页用）
      noteQuick(d);   // 临时对话的到期时刻 / 回收策略 / 回收站计数
      cutoff = Number(d.cutoff) || 0;
      applySessions(withOlder(list)); cacheSessions(list); prefetchSessions(list); if (d.prefsLast) absorbLastPrefs(d.prefsLast); if (d.library) applyServerLibrary(d.library);   // 跨设备：别的设备最近的选择也能当本机新对话默认
      sessionsAt = Date.now();
    }
    catch { if (!sessions.length) sessions = (await getCachedSessions()) || []; }   // 离线 → 读本地缓存的会话列表
    // 项目列表单独拉、单独兜底——项目接口失败不拖累会话列表本身。
    try {
      const pd = await api.claudeProjects(); const plist = pd.projects || []; if (!sameProjects(projects, plist)) projects = plist; cacheProjects(plist);
      if (Array.isArray(pd.order) && !orderPending && pd.order.join() !== projOrder.join()) { projOrder = pd.order; cacheOrder(pd.order); }
    } catch {}
  }

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
  function onScroll() { if (scrollEl) atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 120; }
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
    if (scrollEl && (newMsg || atBottom)) requestAnimationFrame(() => { toBottom(); if (newMsg) requestAnimationFrame(toBottom); });
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

  // 汉堡键：compact 拉抽屉；medium 切「侧栏常驻」（工作台开着时手动点＝我就要侧栏，
  // 让位记账作废、并把工作台收掉腾地方——一根侧列的档位里这是唯一讲得通的语义）。
  function onMenuKey() {
    if (!layout.medium) { openDrawer(); return; }
    const next = !sidePinned;
    setPinned(next);
    yielder.forget();
    if (next && dock.open) closeDock();
    if (next && !sessions.length) refreshSessions();
  }
  function openDrawer() {
    ui.drawerOpen = true;
    // 列表已有内容时：网络刷新错峰到滑入动画（260ms）之后——数据返回替换列表 DOM
    // 正撞动画帧是「开抽屉卡一下」的元凶。首次（空列表）立即拉，宁可边滑边出内容。
    // 总线连着、10 秒内刚拉过：列表有总线增量在跟，不再每开一次抽屉就整表重拉（10-21）。
    if (sessions.length && busConnected() && Date.now() - sessionsAt < 10_000) return;
    if (sessions.length) setTimeout(refreshSessions, 320);
    else refreshSessions();
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
  const single = $derived(singleMode());
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
    guard: () => !(single || wide || pinned || ui.drawerOpen || ui.routinesOpen || ui.morphing),
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
    if (splitOn) {
      if (s.id === paneId) { focusPane(); return; }
      if (s.id === session.id) { paneFocus = false; return; }
      if (paneFocus) { postPane({ t: 'open', id: s.id }); return; }
    }
    session.projectId = s.projectId || null; openSession(s.id);
  }
  // 项目行点击 = 在该项目里开新聊天（与 GPT 分页同构：项目即新会话的 cwd 上下文）。分屏时开在有焦点的那一格。
  function newInProject(p) {
    closeDrawer();
    if (splitOn && paneFocus) { postPane({ t: 'new', projectId: p.id }); return; }
    newConversation(p.id);
  }
  function openRoutines() { closeDrawer(); ui.routinesOpen = true; }

  // —— 新对话（S1-6，审查 G21）：侧栏第一行 + 手机顶栏 + 快捷键（网页 Ctrl/⌘+Shift+O，桌面壳另认 Ctrl/⌘+N）——
  // 落点（lib/quickChat.js 的 newChatTarget）：当前在真实项目里就在它里面开；在临时对话里（或还没有归属）
  // 就落到最近用过的真实项目，都没有落默认工作空间。分屏时开在有焦点的那一格，「当前项目」也认那一格的
  //（那一格的会话在侧栏列表里就按列表，空白对话按它报上来的 / 我们刚让它开的项目）。
  function openNew(pid) {
    if (splitOn && paneFocus) { paneProjId = pid || null; postPane({ t: 'new', projectId: pid || null }); return; }
    newConversation(pid || undefined);
  }
  function newChat() {
    closeDrawer();
    const cur = splitOn && paneFocus ? ((paneId && sessions.find((s) => s.id === paneId)?.projectId) || paneProjId) : sessionProjId;
    openNew(newChatTarget({ currentProjectId: cur, projects, sessions: listed }));
  }
  const IS_DESKTOP_SHELL = typeof window !== 'undefined' && !!window.BridgeDesktop;
  const NEW_KBD = newChatKbd({ desktop: IS_DESKTOP_SHELL, mac: typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') });

  // —— 临时对话（服务端 claude-quick.mjs，原「快照」）——
  // 每条临时对话一只一次性桶，桶伪装成项目（quick 标记）：不属于任何工作空间、不共用记忆。current = 开新临时
  // 对话时落进的那只空桶（它一用过，服务端就换一只新的）。全部临时对话在侧栏单独一区（不进项目区、不参与收藏 /
  // 分组 / 归档），最后活动超过 30 天才清理（先进回收站，再放 30 天），剩几天时侧栏角标 + 输入框上方横条提示，
  // 可「存为工作空间」或「继续保留」。天数一律按服务端给的到期时刻算（/api/sessions 的 quickExpires）。
  const quickIds = $derived(new Set(projects.filter((p) => p.quick).map((p) => p.id)));
  const quickProj = $derived(projects.find((p) => p.quick && p.current) || projects.find((p) => p.quick) || null);
  const realProjects = $derived(applyProjectOrder(projects.filter((p) => !p.quick), projOrder));
  let quickExp = $state({});                    // 桶 id → 到期时刻（ms）
  let quickPol = $state(quickPolicy(null));     // { ttlDays, warnDays, trashDays }
  let quickBin = $state(0);                     // 回收站里有几只
  // 首页只带最近 20 条临时对话（服务端 QUICK_HEAD）：总数、翻页截断点；更早的「显示更多」时向服务端要
  let quickCount = $state(0);
  let quickCut = $state(0);                     // 首页最旧那条临时对话的 mtime；0 = 首页就是全部
  let quickPager = $state(null);                // { hi, lo, done }（lib/sessionArchiveView.js 的 pagerFrom）
  let quickOlderBusy = $state(false);
  // 只有文件、没有对话的临时对话桶（删光了对话 / 老版本留下的）：[{ id, items, expiresAt }]
  let quickOrph = $state([]);
  function noteQuick(d) {
    if (!d) return;
    if (Array.isArray(d.quickOrphans)) quickOrph = d.quickOrphans.filter((o) => o && typeof o.id === 'string');
    // 合并而不是整个换掉：翻页拿回来的那些桶的到期时刻不在首页这份里（桶 id 不复用，留着旧键无妨）
    if (d.quickExpires && typeof d.quickExpires === 'object') {
      const orph = Array.isArray(d.quickOrphans) ? quickOrph.filter((o) => Number.isFinite(o.expiresAt)).map((o) => [o.id, o.expiresAt]) : [];
      quickExp = { ...quickExp, ...d.quickExpires, ...Object.fromEntries(orph) };
    }
    if (d.quickPolicy) quickPol = quickPolicy(d.quickPolicy);
    if (Number.isFinite(d.quickRecycled)) quickBin = d.quickRecycled;
    if (Number.isFinite(d.quickCount)) { quickCount = d.quickCount; quickCut = d.quickMore ? Number(d.quickCursor) || 0 : 0; }
  }
  // 快到期了才给天数（侧栏角标 / 横条），否则 null
  const quickWarnDays = (pid) => (expiryWarn(quickExp[pid], quickPol) ? daysLeft(quickExp[pid]) : null);

  let quickBusy = $state(false);
  const errDetail = (e) => tr(typeof e?.body === 'string' ? e.body : (e?.body?.error || e?.message || ''));
  // 「新建临时对话」= 服务端给一只没用过的空桶（新 cwd → 新自动记忆目录，前尘不带），随即开空对话。
  // 用过的旧桶照常列在「临时对话」区里，按时间回收（不再像以前那样从列表里消失、攒满 10 条就连产物删掉）。
  async function newQuick() {
    if (quickBusy) return;
    quickBusy = true;
    closeDrawer();
    try {
      const r = await api.newQuickChat();
      const p = r && r.project;
      if (!p || !p.id) throw new Error(t('服务器没有返回新的临时对话'));
      // 旧的当前桶摘掉 current 标记、留在列表里；新桶补在末尾（[0] 仍是默认工作空间）
      projects = [...projects.filter((x) => x.id !== p.id).map((x) => (x.quick && x.current ? { ...x, current: false } : x)), { ...p, current: true }];
      cacheProjects(projects);
      openNew(p.id);
      refreshSessions();
    } catch (e) {
      uiAlert(t('新建临时对话失败，请重试'), { type: 'error', detail: errDetail(e) });
    } finally { quickBusy = false; }
  }
  // 「存为工作空间」（临时对话那条会话的 ⋮ / 右键、输入框上方的芯片与横条）：服务端把它所在的桶登记成普通项目
  //（id 沿用桶 id、名字取这条对话的标题），随后挪到固定位置。会话的 projectId 不变、只是它的项目摘掉了 quick
  // 标记——那条对话自然从「临时对话」区落进项目列表，正开着的也不用重开；此后不再按时间回收。
  async function saveQuick(pid, s) {
    closeMenu();
    if (!pid || quickBusy) return;
    quickBusy = true;
    try {
      const title = s ? titleFor(s.id, s.title) : '';
      const label = title && title !== '（进行中…）' ? tr(title) : '';   // i18n-ignore 服务端给在跑的无标题会话的占位，不是界面文案
      const r = await api.saveQuickChat(pid, t('存下的对话'), label);
      const p = r && r.project;
      if (!p || !p.id) throw new Error(t('服务器未返回存好的工作空间'));
      const q = r.quick && r.quick.id ? { ...r.quick, current: true } : null;
      const rest = projects.filter((x) => x.id !== p.id && (!q || x.id !== q.id)).map((x) => (q && x.quick && x.current ? { ...x, current: false } : x));
      projects = [...rest, p, ...(q ? [q] : [])];   // [0] 仍是默认工作空间
      cacheProjects(projects);
      // 手上是一张还没发出的空白对话、落点原本是这只桶：它跟着临时对话走（落到当前空桶），不跟着被存走的那只。
      // 点名进的那只（只有文件的桶）除外：存的就是它，留在刚存好的工作空间里
      if (!session.id && session.projectId === p.id && q && p.id !== chosenQuick) session.projectId = q.id;
      if (collapsed[p.id]) { delete collapsed[p.id]; try { localStorage.setItem(COLL_LS, JSON.stringify(collapsed)); } catch {} }
      refreshSessions();
    } catch (e) {
      uiAlert(t('存为工作空间失败，请重试'), { type: 'error', detail: errDetail(e) });
      refreshSessions();
    } finally { quickBusy = false; }
  }
  // 「继续保留」：服务端给这只桶记一次活动，回收时钟从头算
  async function keepQuick(pid) {
    closeMenu();
    if (!pid || quickBusy) return;
    quickBusy = true;
    try {
      const r = await api.keepQuickChat(pid);
      if (r && Number.isFinite(r.expiresAt)) quickExp = { ...quickExp, [pid]: r.expiresAt };
    } catch (e) {
      uiAlert(t('操作失败，请重试'), { type: 'error', detail: errDetail(e) });
    } finally { quickBusy = false; }
  }
  // 「没进任何目录」时的默认落点（审查 D10 选 b，lib/quickChat.js 的 landingFor）：管理员默认落临时对话
  //（沿用一直以来的习惯），其他成员默认落自己的工作空间；设置里有「新对话落点」时照设置。只在【冷启动没有
  // 可恢复会话】那一次落点，之后由用户显式选目录 / 点临时对话决定——否则文件面板「新对话」这类
  // 程序化发起的新会话也会被拽进临时对话，而它们的上下文本来就是工作空间。
  let quickDefaulted = false;
  let landedQuick = null;   // 冷启动落点给的那只桶 id（非响应式；可能来自本地缓存，已经过时）
  let chosenQuick = $state(null);   // 用户点名要进的那只桶（只有文件的那种 / 刚从回收站恢复的）：空白对话就留在它里面，不跟到当前空桶
  $effect(() => {
    if (quickDefaulted || !quickProj) return;
    quickDefaulted = true;
    if (!session.id && !session.projectId && landingFor({ setting: claudeCs.values?.newChatLanding, kind: me.kind }) === 'temp') {
      session.projectId = quickProj.id;
      landedQuick = quickProj.id;
    }
  });
  // 空白的临时对话指着的桶已经不是当前空桶（它刚在别处开过对话、冷启动用的是缓存里的旧当前桶——服务端早换了，
  // 甚至已经不在列表里）：跟到当前空桶，免得第一条消息挤进别的临时对话的桶、或者发给一只不存在的桶。
  $effect(() => {
    const cur = quickProj;
    const pid = session.projectId;
    if (!cur || session.id || !pid || pid === cur.id || pid === chosenQuick) return;
    if (quickIds.has(pid) || pid === landedQuick) session.projectId = cur.id;
  });

  // —— 临时对话回收站：到期的临时对话整只挪在这里（对话记录不动），再放 trashDays 天才永久删除；能恢复 ——
  let binOpen = $state(false);
  let binItems = $state([]);
  let binLoading = $state(false);
  let binBusy = $state(false);
  async function openBin() {
    closeDrawer();
    binOpen = true;
    binLoading = true;
    try {
      const r = await api.recycledQuickChats();
      binItems = Array.isArray(r?.items) ? r.items : [];
      quickBin = binItems.length;
    } catch (e) {
      uiAlert(t('读取回收站失败'), { type: 'error', detail: errDetail(e) });
    } finally { binLoading = false; }
  }
  async function restoreBin(it) {
    if (binBusy || !it) return;
    binBusy = true;
    try {
      const r = await api.restoreQuickChat(it.id);
      binItems = binItems.filter((x) => x.id !== it.id);
      quickBin = binItems.length;
      const p = r && r.project;
      if (p && p.id && !projects.some((x) => x.id === p.id)) { projects = [...projects, p]; cacheProjects(projects); }
      await refreshSessions();
      // 恢复的就是想接着看的那条：直接打开它最新的一段对话；没有对话、只有文件的，就在那只桶里开空白对话（工作台里看得见文件）
      if (it.sessionId) { binOpen = false; pickSession({ id: it.sessionId, projectId: it.id }); }
      else { binOpen = false; openOrphan(it.id); }
    } catch (e) {
      uiAlert(t('恢复失败，请重试'), { type: 'error', detail: errDetail(e) });
    } finally { binBusy = false; }
  }
  $effect(() => {
    if (!binOpen) return;
    const offBack = pushBackLayer(() => { binOpen = false; });
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); binOpen = false; } };
    window.addEventListener('keydown', onKey, true);
    return () => { offBack(); window.removeEventListener('keydown', onKey, true); };
  });

  // —— 项目组折叠：chevron 切换收起该项目下的会话列表（行点击=开新聊天不变）。
  // 折叠集持久化 localStorage（对象 map，$state 深代理保证 collapsed[id] 赋值可响应）。 ——
  const COLL_LS = 'bridge-claude-proj-collapsed';
  let collapsed = $state((() => { try { return JSON.parse(localStorage.getItem(COLL_LS)) || {}; } catch { return {}; } })());
  function toggleFold(e, id) {
    e.stopPropagation();
    if (collapsed[id]) delete collapsed[id]; else collapsed[id] = true;
    try { localStorage.setItem(COLL_LS, JSON.stringify(collapsed)); } catch {}
  }

  // —— 分组派生：收藏优先（收藏的会话不再重复出现在项目组里）；其余按 projectId 归入
  // 项目组。项目制下会话必有归属；万一撞上过期缓存（旧 id 对不上号）就兜进默认工作空间组。 ——
  // 临时对话不参与收藏/分组——它们在侧栏单独一区，不附属任何目录。
  const isQuickSession = (s) => !!s && quickIds.has(s.projectId);
  // 刚归档、服务端列表还没反映的先藏起来（乐观，lib/sessionArchive.svelte.js 的 hidden）
  const listed = $derived(sessions.filter((s) => !arch.hidden[s.id]));
  const starred = $derived(listed.filter((s) => isStarred(s.id) && !isQuickSession(s)));
  // 「临时对话」区：服务端按最近活动倒序（与普通会话按 mtime 合成一列）。折着时只放最近的 1 条（10-23 维护者：其余全收进
  // 「显示更多」，只剩 1 条也不直接放出来；只有文件的那种也一并折起），「显示更多」每次再放 PAGE_STEP 条；
  // 当前打开的那条折在后面时单独补在末尾。当前这张空白对话落在临时对话里（还没发第一条）时，区首补一行占位，看得出人在哪。
  // 服务端首页只带最近 20 条：本地放完了还有没拿到的，「显示更多」接着向服务端要（loadOlderQuick）。
  const QUICK_PAGE = 1;
  let shownQuick = $state(0);
  const quickSessions = $derived(listed.filter(isQuickSession));
  // 服务端那头还有多少条临时对话没拿到（翻到底了、或首页就是全部 → 0）
  const quickSrvRest = $derived(pagerFrom(quickPager, quickCut).done ? 0 : Math.max(0, quickCount - quickSessions.length));
  const quickRows = $derived.by(() => {
    const n = shownQuick || QUICK_PAGE;
    // 只有文件、没有对话的那种：展开后才列；折着时只留正开着的那只
    const orph = shownQuick ? quickOrphRows : quickOrphRows.filter((o) => quickBlank && session.projectId === o.id);
    const orphRest = quickOrphRows.length - orph.length;
    if (!quickSrvRest && quickSessions.length <= n) return { rows: quickSessions, orph, rest: orphRest };
    const rows = quickSessions.slice(0, n);
    const cur = curId ? quickSessions.find((s, i) => i >= n && s.id === curId) : null;
    return { rows: cur ? [...rows, cur] : rows, orph, rest: quickSessions.length - rows.length - (cur ? 1 : 0) + quickSrvRest + orphRest };
  });
  function showMoreQuick() {
    shownQuick = (shownQuick || QUICK_PAGE) + PAGE_STEP;
    if (shownQuick >= quickSessions.length && quickSrvRest > 0) loadOlderQuick();
  }
  async function loadOlderQuick() {
    if (quickOlderBusy) return;
    quickOlderBusy = true;
    try {
      let p = pagerFrom(quickPager, quickCut);
      // 一页全是已经拿到的 / 没标题被滤掉的，就接着往下要，最多几页（同 loadOlder）
      for (let i = 0; i < 6 && !p.done; i++) {
        const d = await api.get(`/api/sessions?quick=2&project=${encodeURIComponent('@quick')}&before=${p.lo}&limit=${PAGE_STEP + 10}`);
        noteQuick({ quickExpires: d?.quickExpires });
        const have = new Set(sessions.map((s) => s.id));
        const add = (d?.sessions || []).filter((s) => !have.has(s.id));
        const lo = Number(d?.cursor) || 0;
        p = { hi: p.hi, lo: lo && lo < p.lo ? lo : p.lo, done: !d?.more || !lo || lo >= p.lo };
        if (add.length) { older = [...older, ...add]; sessions = [...sessions, ...add]; break; }
      }
      quickPager = p;
    } catch {} finally { quickOlderBusy = false; }
  }
  const quickBlank = $derived(!session.id && !!session.projectId && quickIds.has(session.projectId));
  // 只有文件、没有对话的临时对话：单独列在区尾，点开 = 在那只桶里开空白对话（工作台里看得见文件），也能存为工作空间
  const quickOrphRows = $derived(quickOrph.filter((o) => quickIds.has(o.id) && !quickSessions.some((s) => s.projectId === o.id)));
  const orphanBlank = $derived(quickBlank && (session.projectId === chosenQuick || quickOrphRows.some((o) => o.id === session.projectId)));
  function openOrphan(id) {
    closeDrawer();
    chosenQuick = id;
    openNew(id);
  }
  const grouped = $derived.by(() => {
    const map = new Map(realProjects.map((p) => [p.id, []]));
    // 默认工作空间认 def 标记（服务端保证 projects[0] 是它，但侧栏顺序可以被拖乱）
    const defId = (realProjects.find((p) => p.def) || realProjects[0])?.id ?? null;
    for (const s of listed) {
      if (isStarred(s.id) || isQuickSession(s)) continue;
      const key = (s.projectId && map.has(s.projectId)) ? s.projectId : defId;
      if (key != null) map.get(key).push(s);
    }
    for (const [k, list] of map) map.set(k, nestFamilies(list));
    return map;
  });
  // 官方 Desktop 同款子会话树：服务端给子会话带 parentId（顶层祖先，见 src/runtime/desktop-lineage.mjs），
  // 同组里根在场就把子行紧贴在根下面缩进一级；一家子的位置＝其中最新那条的位置（列表本就按 mtime 倒序，
  // 第一次碰到哪个成员就在哪落座）。根不在本组（被收藏走了 / 不在列表里）时子会话照常平铺。
  const childIds = $derived.by(() => {
    const out = new Set();
    for (const list of grouped.values()) for (const s of list) if (s.parentId && list.some((x) => x.id === s.parentId)) out.add(s.id);
    return out;
  });
  function nestFamilies(list) {
    if (!list.some((s) => s.parentId)) return list;
    const ids = new Set(list.map((s) => s.id));
    const kids = new Map();
    for (const s of list) {
      if (!s.parentId || !ids.has(s.parentId)) continue;
      if (!kids.has(s.parentId)) kids.set(s.parentId, []);
      kids.get(s.parentId).push(s);
    }
    const out = [];
    const placed = new Set();
    for (const s of list) {
      const rootId = s.parentId && ids.has(s.parentId) ? s.parentId : s.id;
      if (placed.has(rootId)) continue;
      placed.add(rootId);
      out.push(rootId === s.id ? s : list.find((x) => x.id === rootId));
      for (const k of kids.get(rootId) || []) out.push(k);
    }
    return out;
  }

  // —— 组内懒加载：一个项目会话一多整条侧栏就被它撑满，每组先只渲染最新 PAGE 条，
  // 末尾「显示更多」每次再放 PAGE_STEP 条，全放完换成「收起」。展开数只活在本次页面里（不持久化）。
  // 截断点落在一家子中间时顺延到这家的子行放完；当前打开的会话若被折在后面，单独补在可见段末尾，
  // 免得切过去的那条在侧栏里「消失」。 ——
  const PAGE = 10, PAGE_STEP = 20;
  let shown = $state({});
  const paged = $derived.by(() => {
    const out = new Map();
    for (const [id, list] of grouped) {
      let n = shown[id] || PAGE;
      while (n < list.length && childIds.has(list[n].id)) n++;
      // 只剩 1 条就直接放出来：「显示更多（1）」自己也占一行，折着不省地方，还多点一下
      if (n >= list.length - 1) { out.set(id, { rows: list, rest: 0 }); continue; }
      const rows = list.slice(0, n);
      const cur = curId ? list.find((s, i) => i >= n && s.id === curId) : null;
      out.set(id, { rows: cur ? [...rows, cur] : rows, rest: list.length - rows.length });
    }
    return out;
  });
  function showMore(id) {
    shown[id] = (shown[id] || PAGE) + PAGE_STEP;
    // 本地这组放完了、服务端还有更早的：接着向服务端要一页
    if (shown[id] >= (grouped.get(id) || []).length && serverRest(id) > 0) loadOlder(id);
  }
  function showLess(id) { delete shown[id]; }
  // 服务端那头同理：组里本地一条都没有（整组会话都比首页截断点老），或本地放完了、服务端只剩 1 条，
  // 别让组下孤零零挂一行「显示更多」——直接替用户要回来。每个项目只自动要一次，要不回来就退回按钮。
  // 10-21：服务端首页已经顺带「整组都比截断点老」的项目的最新几条，这里多半不再触发；真要补也一次只补一个组、
  // 放到空闲时再发（以前进页同一时刻并发 5 个 ?project= 翻页，每个都让服务端全量扫一遍盘，整台服务冻住一两秒）。
  const autoOlder = new Set();
  let autoBusy = false;               // 非响应式：一次只跑一个
  let autoTick = $state(0);           // 跑完一个就拨一下，让下面的 effect 接着看下一个组
  const whenIdle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 300));
  $effect(() => {
    void autoTick;
    if (autoBusy) return;
    for (const p of projects) {
      if (collapsed[p.id] || olderBusy[p.id] || autoOlder.has(p.id)) continue;
      const pg = paged.get(p.id);
      if (pg?.rest) continue;
      const rest = serverRest(p.id);
      if (rest > 0 && (!pg?.rows.length || rest <= 1)) {
        const pid = p.id;
        autoOlder.add(pid);
        autoBusy = true;
        whenIdle(() => { loadOlder(pid).finally(() => { autoBusy = false; autoTick++; }); });
        break;
      }
    }
  });

  // —— 组内翻页找回老会话（2026-10-20）：/api/sessions 只回最新 60 条活跃会话（已归档的不占名额），
  // 各项目的活跃会话总数在 projectCounts 里。本地这组放完了而服务端还有，「显示更多」就向服务端要
  // 更早的一页（?project=&before=）；拿回来的行记在 older 里，整表刷新时并回列表，不然下一次刷新就把它们冲掉了。
  // 游标不能取「本组最旧那行」：收藏、一家子补进来的老行比首页截断点早得多，拿它当 before 会把中间整段跳过。
  // 所以从服务端给的截断点 cutoff 起翻、每页接着服务端回的 cursor（lib/sessionArchiveView.js 的 pagerFrom）。 ——
  let projCounts = $state({});
  let cutoff = $state(0);           // 首页（最新 60 条）里最旧那条的 mtime；0 = 首页就是全部
  let older = [];                   // 翻页拿回来的老会话行（非响应式；并进 sessions 才上屏）
  let olderBusy = $state({});
  let pager = $state({});           // 项目 id → { hi, lo, done }：[lo, hi) 这段翻过了；done = 服务端说更早的没了
  function withOlder(list) {
    // 已归档的、所属项目已经不在了的（别处删了项目）不再并回来
    const pids = projects.length ? new Set(projects.map((p) => p.id)) : null;
    older = older.filter((s) => !isArchivedId(s.id) && (!pids || pids.has(s.projectId)));
    return mergeOlder(list, older);
  }
  // 会话被删（别的设备删的，总线 session.gone）/ 项目被删：列表与翻页拿回来的老行一起摘掉
  function dropRows(pred) {
    older = older.filter((s) => !pred(s));
    if (sessions.some(pred)) sessions = sessions.filter((s) => !pred(s));
  }
  // 这个项目在服务端还有多少条没拿到（收藏的也算在已拿到里）；翻到底了、且与首页接得上就是 0
  const serverRest = (pid) => (pagerFrom(pager[pid], cutoff).done ? 0 : serverRestOf(sessions, projCounts, pid));
  async function loadOlder(pid) {
    if (olderBusy[pid]) return;
    olderBusy[pid] = true;
    try {
      let p = pagerFrom(pager[pid], cutoff);
      // 一页全是已经拿到的（断档重翻、或整页都是没标题被滤掉的文件）就接着往下要，最多几页
      for (let i = 0; i < 6 && !p.done; i++) {
        const d = await api.get(`/api/sessions?project=${encodeURIComponent(pid)}&before=${p.lo}&limit=${PAGE_STEP + 10}`);
        const have = new Set(sessions.map((s) => s.id));
        const add = (d?.sessions || []).filter((s) => s.projectId === pid && !have.has(s.id));
        const lo = Number(d?.cursor) || 0;
        p = { hi: p.hi, lo: lo && lo < p.lo ? lo : p.lo, done: !d?.more || !lo || lo >= p.lo };
        if (add.length) { older = [...older, ...add]; sessions = [...sessions, ...add]; break; }
      }
      pager[pid] = p;
    } catch {} finally { delete olderBusy[pid]; }
  }

  // —— 归档 / 取消归档（2026-10-20，对齐官方 Claude Desktop 的 Archive）——
  // 归档 = 从侧栏收起（不停会话、不删转录、不动 worktree）；在工作 / 在等回答的不归档。
  // 有子会话时问一句：只归档这一条（子会话移到顶层：不再缩进挂在它下面，它以后取消归档也不挂回来）
  // 还是一家子全部归档（官方同款二选一）。
  // 已归档的会话在侧栏底部「已归档」里找，能取消归档；取消过归档的以后不再被自动归档（服务端记着）。
  let archAsk = $state(null);       // { id, title, kids:[id], working }
  const focusBtn = (el) => { requestAnimationFrame(() => el.focus()); };   // 默认焦点在「仅归档此会话」（官方同款）
  // 弹窗开着：系统返回键 / Esc 先关它（不然返回键被下层抽屉吃掉、弹窗还盖在正文上）
  $effect(() => {
    if (!archAsk) return;
    const offBack = pushBackLayer(() => { archAsk = null; });
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); archAsk = null; } };
    window.addEventListener('keydown', onKey, true);
    return () => { offBack(); window.removeEventListener('keydown', onKey, true); };
  });
  function doArchive(s) {
    closeMenu();
    if (!s) return;
    const kids = descendantsOf(sessions, s.id).filter((k) => !arch.hidden[k.id]);
    if (kids.length) { archAsk = { id: s.id, title: titleFor(s.id, s.title) || '', kids: kids.map((k) => k.id), working: kids.filter((k) => k.thinking || k.pending).length }; return; }
    runArchive([s.id]);
  }
  async function runArchive(ids, opts) {
    archAsk = null;
    older = older.filter((s) => !ids.includes(s.id));
    try {
      const r = await setArchivedIds(ids, true, opts);
      if (r.skipped.length && r.skipped.length === ids.length) uiAlert(t('正在工作的会话不能归档'));
    } catch (e) { libFail(t('归档失败，请重试'))(e); }
  }
  // 项目 ⋮「归档全部会话」（官方 Archive all sessions in "{group}"?）：收藏的不动、在工作的跳过；列表随 archive 事件重拉
  async function doArchiveProject(p) {
    closeMenu();
    if (!p) return;
    const ok = await uiConfirm(t('归档「{name}」里的全部会话？', { name: tr(p.name || '') }), {
      detail: t('收藏的会话和正在工作的会话不受影响。归档的会话可以在侧栏底部的「已归档」里找回。'), okLabel: t('全部归档'),
    });
    if (!ok) return;
    try {
      const r = await archiveProject(p.id);
      dropRows((s) => s.projectId === p.id && !isStarred(s.id) && !s.thinking && !s.pending); delete pager[p.id];
      if (!r.count && r.skipped.length) uiAlert(t('正在工作的会话不能归档'));
    } catch (e) { libFail(t('归档失败，请重试'))(e); }
  }
  async function doUnarchive(id) {
    closeMenu();
    try { await setArchivedIds([id], false); } catch (e) { libFail(t('无法取消归档，请重试'))(e); }
  }
  // 已归档视图里点一条 = 打开它看（输入框上方有「此会话已归档」横条）
  function openArchived(s) { markArchivedSeen(s.id); pickSession(s); }
  const projName = (id) => tr(projects.find((p) => p.id === id)?.name || '');
  // 已归档视图看得见时（常驻侧栏，或窄屏抽屉拉开着）：系统返回先回到会话列表；抽屉收着时不拦
  $effect(() => { if (arch.view && (pinned || ui.drawerOpen)) return pushBackLayer(closeArchivedView); });

  // 开着的会话报给服务端（视图上报 /api/ui/state 的 claudeOpen）：自动归档跳过有人正开着的会话（官方 on_screen）
  $effect(() => {
    if (!who || IS_CSNAP) return;
    const open = ui.screen === 'claude' ? [session.id, splitOn ? paneId : null].filter(Boolean) : [];
    untrack(() => reportUi({ claudeOpen: open }));
  });

  // —— 搜索会话（Ctrl+K / 侧栏「搜索」）：宽屏是居中面板，手机是全屏页（claude/SessionSearch.svelte）——
  let searchOpen = $state(false);
  function openSearch() { searchOpen = true; }
  function openHit(h) {
    searchOpen = false;
    if (h.archived) markArchivedSeen(h.sessionId);
    pickSession({ id: h.sessionId, projectId: h.projectId });
  }
  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  function onSearchKey(e) {
    // defaultPrevented：工作台里的编辑器（md 编辑器 Ctrl+K 插链接）已经接住了，不抢
    if (e.defaultPrevented || ui.screen !== 'claude' || ui.settingsOpen || IS_CSNAP || !who) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      searchOpen = !searchOpen;
      return;
    }
    // 新对话（官方同款）：网页 Ctrl/⌘+Shift+O；桌面壳另认 Ctrl/⌘+N（lib/quickChat.js 的 isNewChatKey）
    if (isNewChatKey(e, { desktop: IS_DESKTOP_SHELL })) {
      e.preventDefault();
      searchOpen = false;
      newChat();
    }
  }

  // 行尾 ⋮ 菜单：会话（收藏/重命名/删除）与项目（重命名/删除）共用一套。
  // menuFor = { kind: 'session'|'project', id }。
  let menuFor = $state(null);
  let menuPos = $state({ top: null, bottom: null, right: 0 });
  let delConfirm = $state(false);
  function openMenu(e, kind, id) {
    e.stopPropagation();
    // 右键（鼠标）：菜单开在指针处，再右键别处直接换过去；⋮ 照旧锚在按钮下沿、再点一下收起
    const ctx = e.type === 'contextmenu';
    if (ctx) e.preventDefault();
    if (!ctx && menuFor && menuFor.kind === kind && menuFor.id === id) { closeMenu(); return; }
    const r = ctx ? { top: e.clientY, bottom: e.clientY, right: Math.min(e.clientX + 176, window.innerWidth - 8) } : e.currentTarget.getBoundingClientRect();
    // 下方放不下就锚到按钮上方（bottom 定位，向上生长不出屏）。
    const up = (window.innerHeight - r.bottom) < 180;
    menuPos = up
      ? { top: null, bottom: window.innerHeight - r.top + 4, right: window.innerWidth - r.right }
      : { top: r.bottom + 4, bottom: null, right: window.innerWidth - r.right };
    menuFor = { kind, id }; delConfirm = false;
  }
  function closeMenu() { menuFor = null; delConfirm = false; }
  // 行上右键 = 同一个 ⋮ 菜单。只认鼠标：触屏长按在安卓上也会发 contextmenu，那是「拿起拖动」的手势，不抢。
  function rowCtx(e, kind, id) { if (!pointer.fine || IS_CSNAP) return; openMenu(e, kind, id); }
  const menuProject = () => projects.find((x) => x.id === (menuFor && menuFor.id)) || null;
  const menuStyle = $derived(menuFor
    ? (menuPos.top != null ? `top:${menuPos.top}px;` : `bottom:${menuPos.bottom}px;`) + `right:${menuPos.right}px;`
    : '');
  const menuSession = () => sessions.find((x) => x.id === (menuFor && menuFor.id)) || null;

  // 收藏 / 改名存服务端（跨设备）：乐观上屏，失败由 library 退回原状，这里只提示。
  const libFail = (msg) => (e) => {
    const detail = typeof e?.body === 'string' ? e.body : (e?.body?.error || e?.message || '');
    uiAlert(msg, { type: 'error', detail: tr(detail) });
  };
  function doStar(id) { toggleStar(id).catch(libFail(t('收藏失败，请重试'))); closeMenu(); }
  // 重命名：应用内小对话框。原来用 window.prompt——Electron 压根不实现 prompt()，
  // 桌面壳里点「重命名」毫无反应；网页端也是浏览器原生弹窗，一并换掉。
  // 同一个对话框也给项目（工作空间）改名用：renameFor.kind 区分。
  let renameFor = $state(null);   // { kind: 'session'|'project', id, name }
  function doRename(s) { closeMenu(); if (s) renameFor = { kind: 'session', id: s.id, name: titleFor(s.id, s.title) || '' }; }
  function doRenameProject(p) { closeMenu(); if (p) renameFor = { kind: 'project', id: p.id, name: p.name || '' }; }
  function commitRename() {
    const r = renameFor; renameFor = null;
    if (!r) return;
    if (r.kind === 'project') commitProjectRename(r.id, r.name.trim());
    else renameSession(r.id, r.name.trim()).catch(libFail(t('重命名失败，请重试')));
  }
  // 工作空间改名：只改显示名（服务端存 label），目录与会话都不动；留空 = 恢复成文件夹名。乐观上屏，失败退回。
  async function commitProjectRename(id, name) {
    const prev = projects;
    const cur = prev.find((p) => p.id === id);
    if (!cur || cur.quick || name === cur.name) return;
    if (name) { projects = prev.map((p) => (p.id === id ? { ...p, name } : p)); cacheProjects(projects); }
    try {
      const r = await api.renameClaudeProject(id, name);
      if (r && r.project) { projects = projects.map((p) => (p.id === id ? { ...p, name: r.project.name } : p)); cacheProjects(projects); }
    } catch (e) {
      projects = prev; cacheProjects(prev);
      const detail = typeof e?.body === 'string' ? e.body : (e?.body?.error || e?.message || '');
      uiAlert(t('重命名失败，请重试'), { type: 'error', detail: tr(detail) });
    }
  }
  const renameKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } else if (e.key === 'Escape') { e.preventDefault(); renameFor = null; } };
  const renameFocus = (el) => { el.focus(); el.select(); };
  async function doDelete(id) {
    // 乐观更新：先关菜单 + 从列表移除（即时反应，不等删除请求经隧道往返的 ~1.5s），
    // 删除请求后台跑；失败再把条目放回去（不留"删不掉的幽灵"）。
    closeMenu();
    const prev = sessions;
    const wasQuick = isQuickSession(prev.find((x) => x.id === id));
    sessions = sessions.filter((x) => x.id !== id);
    try {
      const r = await api.deleteSession(id);
      if (r && r.ok === false) throw new Error(t('服务器未删除该会话'));
      await Promise.all([cacheSessions(sessions), removeCachedMessages(id)]);
      forgetSession(id);   // 服务端删除接口已顺手清掉它的收藏/改名，本地同步摘掉
      dropArchivedRow(id); older = older.filter((x) => x.id !== id);   // 已归档列表 / 翻页拿回来的老会话同步摘掉（服务端归档记录也清了）
      // 删掉的是正开着的临时对话 → 落到当前那只空桶开一张空白的临时对话
      if (session.id === id) newConversation(wasQuick && quickProj ? quickProj.id : undefined);
      if (splitOn && paneId === id) closePane();   // 分屏那一格正开着它：那一格也收掉
    } catch (e) {
      sessions = prev;
      const detail = typeof e?.body === 'string' ? e.body : (e?.body?.error || e?.body?.message || e?.message || '');
      uiAlert(t('删除失败，请重试'), { type: 'error', detail: tr(detail) });
    }
  }

  // 项目名默认 = 文件夹名（服务端派生），可在 ⋮ 里改名（见 commitProjectRename）。
  // 删项目 = 不再列出该目录的会话（transcript 留在磁盘不删）；默认工作空间项目不可删（服务端也拦）。
  async function doDeleteProject(id) {
    closeMenu();
    const prev = projects;
    projects = projects.filter((p) => p.id !== id);
    cacheProjects(projects);
    try { const r = await api.deleteClaudeProject(id); if (r && r.ok === false) throw 0; }
    catch { projects = prev; cacheProjects(prev); return; }
    dropRows((s) => s.projectId === id); delete pager[id];   // 翻页拿回来的老会话别被兜进默认工作空间组
    refreshSessions();   // 拿回服务端真值（该项目目录的会话不再出现）
  }

  // —— 当前会话归属哪个项目 ——
  // session.projectId 只在【显式发起】的路径上写得进去（抽屉点会话 pickSession / 新建对话
  // newConversation）。冷启动恢复与挂直播续看走的是 chat 内核的 loadSession，那条路只认
  // session.id——它虽已把服务端返回的归属回写进 session.projectId，但离线读缓存那一支拿不到，
  // 所以这里再用会话列表回查一次：有 id 就以列表里的归属为准，列表还没有它（刚拿到 id 的
  // 新会话）才回落 session.projectId。少了这一步，临时对话在冷启动后会被当成"没选目录"。
  const sessionProjId = $derived(session.id
    ? (sessions.find((s) => s.id === session.id)?.projectId || session.projectId || null)
    : (session.projectId || null));

  // —— 右侧工作台（审阅/终端/浏览器/文件）：作用域=当前会话的工作空间路径 ——
  // 会话切换/项目变化自动跟随（setDockWs 内部有等值跳过；面板经 {#key} 随 ws 重建）。
  const dockProject = $derived(projects.find((x) => x.id === sessionProjId) || projects[0] || null);
  // worktree 会话（输入栏 worktree 勾选框开出来的）跑在 <仓库>/.claude/worktrees/<名> 里：
  // 工作台与芯片要看它，不看项目主检出。列表条目自带 wt 优先，首轮/重开时 sessionWt 兜底。
  const sessionWtCwd = $derived(session.id
    ? (sessions.find((s) => s.id === session.id)?.wt?.cwd || sessionWt[session.id]?.cwd || '')
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
    ? (projects.find((x) => x.id === sessionProjId) || null)
    : (session.id ? null : (projects[0] || null)));
  // 芯片标签取【项目名】而不是路径末段：真实项目里两者本就相同（项目名固定=文件夹名），
  // 但临时对话的桶目录名是个 UUID，只有项目名读得懂。
  const dockName = $derived(tr(chipProject?.name || ''));
  // 临时对话整条状态栏都不摆：它的工作空间是个一次性空桶（仓库外、无 git、名字是 UUID），
  // 「归属」对它没有意义——换成「临时对话」芯片（claude/TempChatBand），说清它什么时候清理、能存为工作空间。
  // 解析不出项目时同样不摆。
  const showChips = $derived(!!chipProject && !chipProject.quick);
  const curQuick = $derived(!!chipProject && !!chipProject.quick && !IS_CSNAP);
  // 天数只对「有东西的」临时对话有意义：有对话的，或只有文件的那种（orphanBlank）；全新的空白临时对话不倒计时
  const curQuickLive = $derived(curQuick && (!!session.id || orphanBlank));
  const curQuickDays = $derived(curQuickLive ? daysLeft(quickExp[chipProject.id]) : null);
  const curQuickWarn = $derived(curQuickLive && expiryWarn(quickExp[chipProject.id], quickPol));
  const saveCurQuick = () => { if (curQuick) saveQuick(chipProject.id, sessions.find((s) => s.id === session.id)); };
  const keepCurQuick = () => { if (curQuick) keepQuick(chipProject.id); };
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
    closeMenu();
    if (hasNativePickDirectory()) {
      const dir = await nativePickDirectory(pickFrom);
      if (dir) await createProjectAt(dir);
      return;
    }
    pickOpen = true;
  }
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
      // 会话：落在正文区＝move（分屏/换格）；项目：只在侧栏里换位置
      e.dataTransfer.effectAllowed = rec.kind === 'project' ? 'move' : 'copyMove';
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
    startSide(e, { kind: 'project', id: p.id, title: tr(p.name) });
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
    if (splitOn && s.id === paneId) { quoteInto('pane', rec); return; }
    if (s.id !== session.id) { paneFocus = false; session.projectId = s.projectId || null; await openSession(s.id); }
    quoteSession({ id: rec.id, title: rec.title });
  }
  function onSideDragEnd(e) {
    const rec = dragRec;
    dragRec = null; sideDrag = null; insAt = -1; splitHover = null; quoteHover = null; rowHover = null;
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
    const ids = realProjects.map((p) => p.id);
    const next = moveId(ids, id, toIndex);
    if (!next) return;
    const prev = projOrder;
    projOrder = next; cacheOrder(next);
    orderPending++;
    try {
      const r = await api.post('/api/claude/project/order', { ids: next });
      if (Array.isArray(r?.order)) { projOrder = r.order; cacheOrder(r.order); }
    } catch (e) {
      projOrder = prev; cacheOrder(prev);
      uiAlert(t('项目顺序没保存上，请重试'), { type: 'error', detail: tr(e?.body?.error || e?.message || '') });
    } finally { orderPending--; }
  }
  function onProjDragOver(e) {
    if (dragRec?.kind !== 'project') return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    insAt = insIndexAt(e.currentTarget, e.clientY);
  }
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
  let touchProj = $state(null);    // 手指拎着的项目 id
  const hold = makeHold();
  function projHoldDown(e, p) {
    if (e.pointerType === 'mouse' || IS_CSNAP) return;
    hold.arm(e, (f) => {
      const ok = beginDrag({ type: 'claude-project', id: p.id, name: p.name }, {
        x: f.x, y: f.y, pointerId: f.pointerId, pointerType: f.pointerType, sourceEl: f.el,
        ghost: { name: tr(p.name), isDir: true },
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
        onStay: () => { const b = row.querySelector('.d-more'); if (b) openMenu({ currentTarget: b, stopPropagation() {} }, 'session', s.id); },
      });
      if (ok) touchSess = s.id;
    });
  }
  const sessHoldMove = (e) => sessHold.track(e);
  const sessHoldUp = () => sessHold.disarm();
  $effect(() => { if (!drag.on && touchSess) touchSess = null; });
  let drawerEl = $state();
  $effect(() => {
    if (!touchSess || wide || !ui.drawerOpen || !drawerEl) return;
    const x = drag.x;
    const r = untrack(() => drawerEl.getBoundingClientRect());
    if (x > r.right + 6) untrack(closeDrawer);
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
  const touchIns = $derived(touchProj && drag.overKey === 'claude-proj-order' ? insIndexAt(listAt(drag.x, drag.y), drag.y) : -1);
  const projDragging = $derived(sideDrag?.kind === 'project' || !!touchProj);
  const insShown = $derived(touchProj ? touchIns : insAt);
  const liftedId = $derived(sideDrag?.id || touchProj || touchSess || null);

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
  const splitAllowed = $derived(wide && canSplitWidth(panesW));
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
    if (id) { session.projectId = sessions.find((s) => s.id === id)?.projectId || null; openSession(id); }
  }
  $effect(() => { dock.noAuto = splitOn; });
  function onPaneMsg(e) {
    if (!paneFrame || e.source !== paneFrame.contentWindow || !isPaneMsg(e)) return;
    const d = e.data;
    if (d.t === 'ready') paneReady = true;
    else if (d.t === 'focus') { paneFocus = true; window.dispatchEvent(new Event('bridge-pane-away')); }
    else if (d.t === 'session') { paneId = d.id || null; paneProjId = typeof d.projectId === 'string' ? d.projectId : null; if (d.id && !sessions.some((s) => s.id === d.id)) refreshSoon(); }
    else if (d.t === 'close') closePane();
    else if (d.t === 'settings') openSettings(typeof d.sec === 'string' ? d.sec : null);   // 格里的「打开设置」（如回退横条）：设置外壳只挂在宿主页
    else if (d.t === 'search') searchOpen = true;   // 焦点在分屏那一格里按 Ctrl+K：搜索面板开在整页上（SoloPage 转来）
    else if (d.t === 'newchat') { paneFocus = true; searchOpen = false; newChat(); }   // 那一格里按了新对话快捷键（SoloPage 转来）：开在那一格
  }
  $effect(() => {
    window.addEventListener('message', onPaneMsg);
    return () => window.removeEventListener('message', onPaneMsg);
  });
  // 桌面壳全局快捷键「新会话」（App.svelte 转来）：和侧栏「新对话」走同一套落点规则；接住了就 preventDefault，
  // 本页没挂着时 App 自己回落到默认工作空间
  $effect(() => {
    const onNew = (e) => { e.preventDefault(); searchOpen = false; newChat(); };
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
    const id = sideDrag?.id || dragRec?.id;
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
    if (sideDrag?.kind === 'session' && splitDropEl) untrack(measureQuoteRects);
    else { quoteRects = []; quoteHover = null; }
  });
  const quoteTargetId = (target) => (target === 'pane' ? paneId : session.id);
  // 本页那一格还要查「已经引用过」（compose 就是它的）；那一格的去重在它自己的 quoteSession 里
  const quoteOk = (target) => {
    const id = sideDrag?.id || dragRec?.id;
    return target === 'pane' ? !!id && id !== paneId : canQuote(id, session.id);
  };
  function quoteLabelFor(target) {
    const id = sideDrag?.id || dragRec?.id;
    if (id && id === quoteTargetId(target)) return tc('claude', '不能引用对话自己');
    if (!quoteOk(target)) return t('这个对话已经引用过了');
    return target === 'main' ? quoteLabel() : tc('claude', '引用到这个对话');
  }
  function quoteInto(target, rec) {
    if (target === 'pane') { postPane({ t: 'quote', id: rec.id, title: rec.title }); focusPane(); }
    else { paneFocus = false; quoteSession({ id: rec.id, title: rec.title }); }
  }

  function onSplitOver(e) {
    if (dragRec?.kind !== 'session') return;
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
    const rec = dragRec;
    if (!rec || rec.kind !== 'session') return;
    e.preventDefault();
    if (quoteHover) {
      const target = quoteHover;
      quoteHover = null; splitHover = null;
      dropDone = true;
      if (quoteOk(target)) quoteInto(target, rec);
      return;
    }
    const side = splitHover || 'left';
    const plan = planFor(side);
    splitHover = null;
    dropDone = true;
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

  async function createProjectAt(dir) {
    const r = await api.createClaudeProject('', dir);   // 名称留空 → 服务端取文件夹名
    const p = r.project;
    if (p && !projects.some((x) => x.id === p.id)) { projects = [...projects, p]; cacheProjects(projects); }
    pickOpen = false;
    if (p) newInProject(p);   // 建完直接在新项目里开聊（与 GPT 分页一致）
    refreshSessions();
  }
</script>

<!-- transform / clip-path 只在左缘右滑跟手期间有值（预测式返回：缩小 + 圆角）；平时为空，
     入场 / 返回的动画都在转场快照上做，本页 DOM 不动。 -->
<div class="claude-slide" class:sliding bind:this={slideEl} style:transform={peek.transform}
     style:clip-path={peek.clip} use:edgeSwipe>
<!-- .wide 管的是【横向分栏】本身（侧栏/工作台都靠它成为左右列），不等于「侧栏常驻」：
     medium 档侧栏让位给工作台时 pinned=false，但仍必须是 row，否则工作台会掉到正文下面。 -->
<div class="claude-root" class:wide={pinned || sideMode}>

{#if pinned}
  <aside class="drawer pinned" style:width={sbW + 'px'} use:dragScrollGuard>{@render drawerBody()}</aside>
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
<div class="panes" class:split={splitOn} class:side-dnd={!!sideDrag} class:resizing={splitDragging}
  use:measureW={(measureTick, (w) => { panesW = w; })}>
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="pane main" class:focused={splitOn && !paneFocus} style={splitOn ? paneStyle(mainSide) + (mainSide === 'left' ? '--pane-wco-r:0px;' : '') : ''}
  use:measureW={(measureTick, (w) => { mainPaneW = w; })}
  onpointerdowncapture={() => { paneFocus = false; }} onfocusincapture={() => { paneFocus = false; }}>
<!-- 顶栏挂在【这一格】上而不是对话列里：侧列形态的工具开关组要坐在这一格右上角——工作台展开时正好在
     卡片上方那条带里（桌面壳下＝标题栏带、与最小化/关闭同一排），盖在正文上的工作台也压不住它。
     汉堡在 expanded 档才彻底隐藏；medium 档留着当「侧栏常驻」开关（on=已常驻）。
     分屏时每一格各有一组（工具开关 · ⋮ · 关掉这一格）；贴窗口右缘的那一格才让系统窗控（--pane-wco-r）。 -->
<TopBar onMenu={onMenuKey} onDock={toggleDock} onNew={IS_CSNAP ? null : newChat} hideMenu={wide} menuOn={pinned} tools={sideMode} split={splitOn} onClose={splitOn ? closeMain : null} />
<div class="main-col" bind:this={mainColEl} class:dnd-on={drag.overKey === 'chat:claude' || wsDragOver} role="presentation" use:dropZone={claudeDrop}
  ondragover={onWsDragOver} ondragleave={onWsDragLeave} ondrop={onWsDrop}>

<div class="stage">
{#if ui.view === 'greeting'}
  <!-- 空态 = Claude 桌面端 /code 落地页：左上问候 + 用量卡（claude/CodeStatsCard），输入框沉到底部——
       位置、外边距与聊天态 .composer-wrap/.composer-inner 完全一致（只挪位置、样式不动），
       发出第一条时 crossfade 两端几何相同，输入框原地不跳。 -->
  <main class="hero">
    <!-- 官方 Code 空态的字符风背景（LandingTextureLayer 移植）：只在空会话里，离开空态随 .hero 一起卸载 -->
    {#if !IS_CSNAP}<LandingTexture />{/if}
    <div class="hero-scroll">
      <div class="hero-col">
        <div class="greeting">
          <span class="logo-fly" use:mountDrag={{ config: () => ({ kind: 'new', model: settings.model, effort: settings.effort }) }} in:fade={{ duration: 420, delay: 80 }} out:fly={{ x: -80, y: -22, duration: 320, easing: softDrop }}><ClaudeLogo anim="static" size={24} interactive /></span>
          <h1 in:fly={{ y: 22, duration: 480, delay: 130 }} out:fade={{ duration: 150 }}>{greetName}</h1>
        </div>
        {#if !IS_CSNAP}
          <div class="hero-stats" in:fly={{ y: 24, duration: 520, delay: 170 }} out:fade={{ duration: 120 }}><CodeStatsCard /></div>
        {/if}
      </div>
    </div>
    <div class="hero-foot">
      <!-- 归属状态栏（目录/分支/worktree）：刻意放在 crossfade 元素【外面】——
           .hero-composer 与 .composer-inner 是同一 key 的形变两端，塞进去会让两端盒子
           内容不等、形变歪掉。故两处都做成输入框的前置兄弟。 -->
      {#if showChips}
        <div class="hero-chips" in:fly={{ y: 30, duration: 540, delay: 190 }} out:fade={{ duration: 120 }}><WorkspaceChips name={dockName} armable={!session.id} /></div>
      {:else if curQuick}
        <!-- 只有文件的那种（orphanBlank）已经在倒计时，也能直接存为工作空间；全新的空白临时对话只说规矩 -->
        <div class="hero-chips" in:fly={{ y: 30, duration: 540, delay: 190 }} out:fade={{ duration: 120 }}><TempChatBand days={curQuickDays} ttlDays={quickPol.ttlDays} canSave={orphanBlank} busy={quickBusy} onSave={saveCurQuick} /></div>
      {/if}
      <div class="hero-composer" in:fly={{ y: 30, duration: 540, delay: 210 }} out:sendComposer={{ key: 'composer' }}><Composer /></div>
    </div>
  </main>
{:else}
  <!-- 首尾两条渐隐带 = claude.ai /code 转录滚动区原件（app.css .scroll-fade-strip-*）：sticky + 负 margin
       不占位，不改 scrollHeight，onScroll/atBottom 的粘底判定不受影响；尺寸与底带钉位见下方 .scroll 规则。 -->
  <div class="scroll" bind:this={scrollEl} onscroll={onScroll}>
    <div class="scroll-fade-strip-top" aria-hidden="true"></div>
    <Thread />
    <div class="scroll-fade-strip-bottom" aria-hidden="true"></div>
  </div>
  <div class="composer-wrap" bind:this={composerWrapEl}>
    {#if showChips}
      <!-- foot = 滚到底才显形。直接复用 atBottom（粘底判定）作单一真相：它同时决定「新内容
           要不要跟着滚」，两件事本就是同一个「人在不在底部」。另立紧阈值反而会在正文
           延后加载撑高后卡在离底几十像素、芯片打不开。class: 指令写法编译器认得，样式不会被剪。 -->
      <div class="chips-slot" class:foot={atBottom}><WorkspaceChips name={dockName} /></div>
    {:else if curQuick}
      <div class="chips-slot" class:foot={atBottom}><TempChatBand days={curQuickDays} ttlDays={quickPol.ttlDays} canSave={!!session.id && !curQuickWarn} busy={quickBusy} onSave={saveCurQuick} /></div>
    {/if}
    <!-- 临时对话快到清理的时候（S1-6）：同 aux band 槽位，不受「滚到底才显形」约束 -->
    {#if curQuickWarn}<div class="band-slot"><TempChatBand mode="warn" days={curQuickDays} canSave busy={quickBusy} onSave={saveCurQuick} onKeep={keepCurQuick} /></div>{/if}
    <!-- 安全栅门回退横条（官方 /code 输入框上方 aux band：Switched to X · Why? · Edit prompt and retry）：
         与归属芯片同层、同宽同轴，同样放在 crossfade 元素（.composer-inner）【外面】（理由同上：
         形变两端盒子内容必须相等）。芯片规矩一并适用——底必须不透明 + 上缘渐隐罩（正文从悬浮
         输入栏底下穿过）；但它不受「滚到底才显形」约束：这是一条要人处理的通知，不是装饰。
         高度随内容进 .composer-wrap 的 ResizeObserver 量进 --composer-h，滚动区底衬自动加高。 -->
    <div class="band-slot"><RefusalBand sessionId={session.id} /></div>
    <!-- 逐次工具审批卡（官方 dock 形态）：同槽位规矩，没卡时整槽收起 -->
    {#if !IS_CSNAP}<div class="band-slot"><PermissionCard sessionId={session.id} /></div>{/if}
    <!-- 排队消息栏（官方 QueuedMessageBar：输入框正上方，与提示条同层）：同样放在 crossfade 元素外面 -->
    {#if !IS_CSNAP}<div class="band-slot"><QueueBar /></div>{/if}
    <!-- 「此会话已归档」横条（官方同款）：同层、同理放在 crossfade 元素外面 -->
    {#if !IS_CSNAP}<div class="band-slot"><ArchivedBand sessionId={session.id} /></div>{/if}
    <!-- 其它 Claude 会话（Desktop / 终端）发来、等你确认的消息（session-peers.mjs，设置「暂存等我确认」） -->
    {#if !IS_CSNAP}<div class="band-slot"><PeerHoldBand /></div>{/if}
    <!-- 这一轮报了 needs-auth 的远程连接器：一键授权（lib/mcpAuth.svelte.js） -->
    {#if !IS_CSNAP}<div class="band-slot"><McpAuthBand sessionId={session.id} /></div>{/if}
    <div class="composer-inner" bind:this={composerInnerEl} in:receiveComposer={{ key: 'composer' }} out:sendComposer={{ key: 'composer' }}><Composer placeholder={tc('claude', '发消息…')} /></div>
  </div>
  <!-- 会话信息面板（官方 Session rail）：停靠在舞台右侧 / 窄时弹层，开关在右上角工具条第一颗 -->
  {#if !IS_CSNAP}<SessionRail name={dockName} path={dockWs} />{/if}
{/if}
</div>
</div>

<!-- 工作台归这一格：分屏且这一格不够宽时盖在正文上（不挤），够宽照旧挤开正文。
     多张卡同时开只给不分屏的整页（medium 档只塞得下一根侧列、分屏两格都窄，一次一张）。 -->
<ClaudeDock wide={sideMode} overlay={splitOn && dockOverlayFor(mainPaneW)} multi={layout.expanded && !splitOn} toolsClose={splitOn ? closeMain : null} />
</div>

{#if splitOn}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="split-grip" role="separator" aria-orientation="vertical" aria-label={t('拖动调整两格宽度（双击恢复一半一半）')}
    onpointerdown={splitGripDown} ondblclick={splitGripReset}><span></span></div>
  <div class="pane frame" class:focused={paneFocus} style={paneStyle(split.side)}>
    <iframe class="bridge-pane" bind:this={paneFrame} src={paneSrc} title={tc('claude', '分屏：另一个对话')}
      allow="clipboard-read; clipboard-write; fullscreen"></iframe>
  </div>
{/if}

{#if sideDrag?.kind === 'session' && (pinned || !ui.drawerOpen)}
  <!-- 会话拖进正文区的落点层：高亮手在的那一半、写明松手会怎样（窄屏抽屉盖着正文时不出，免得盖到抽屉上） -->
  <div class="split-drop" role="presentation" bind:this={splitDropEl} ondragover={onSplitOver} ondragleave={onSplitLeave} ondrop={onSplitDrop}>
    {#each dropZones as z (z.side + dropZones.length)}
      <div class="sd-zone" class:on={splitHover === z.side} class:nope={splitHover === z.side && hoverPlan?.kind === 'none'}
        style="left:{z.l}px;width:{z.w}px">
        {#if splitHover === z.side}<span class="sd-label">{hoverLabel}</span>{/if}
      </div>
    {/each}
    <!-- 输入栏上的「引用」区：拖进来的这段对话当背景材料挂进那一格的输入栏 -->
    {#each quoteRects as q (q.target)}
      <div class="sd-quote" class:on={quoteHover === q.target} class:nope={quoteHover === q.target && !quoteOk(q.target)}
        style="left:{q.l}px;top:{q.t}px;width:{q.w}px;height:{q.h}px">
        <span class="sd-label">{quoteHover === q.target ? quoteLabelFor(q.target) : tc('claude', '放到输入框＝引用这段对话')}</span>
      </div>
    {/each}
  </div>
{/if}
</div>

{#snippet convRow(s, indent)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="d-row" class:cur={s.id === curId} class:alt={!!altId && s.id === altId} class:indent class:child={indent && childIds.has(s.id)} class:dnd-on={drag.overKey === 'chat:claude:' + s.id || rowHover === s.id}
      class:lifted={liftedId === s.id} draggable={mouseDnd ? 'true' : 'false'} ondragstart={(e) => onSessDragStart(e, s)} ondragend={onSideDragEnd}
      ondragover={(e) => onRowDragOver(e, s)} ondragleave={(e) => onRowDragLeave(e, s)} ondrop={(e) => onRowDrop(e, s)}
      onpointerdown={(e) => sessHoldDown(e, s)} onpointermove={sessHoldMove} onpointerup={sessHoldUp} onpointercancel={sessHoldUp}
      oncontextmenu={(e) => rowCtx(e, 'session', s.id)}>
      <!-- 落点挂在按钮上而不是外层 div：它本来就是可交互元素，省掉一条 a11y 例外 -->
      <button class="d-recent" use:dropZone={sessionDrop(s)} onclick={() => pickSession(s)}>
        <!-- 待回答（提问 / 审批卡）压过「在跑」：等人的那一轮本来就还在跑，不压过去这个点永远亮不出来（官方 Needs your input） -->
        {#if s.thinking || s.pending}<span class="d-dot {s.pending ? 'ask' : 'work'}"></span>{/if}
        <span class="d-title" use:marquee><span class="d-scroll">{tr(titleFor(s.id, s.title)) || t('（无标题）')}</span></span>
        <!-- 临时对话快到清理时：行尾一枚「剩 n 天」——话写全，别让人读成「n 天前」（触屏没有悬停提示；悬停时让位给 ⋮） -->
        {#if isQuickSession(s)}
          {@const qd = quickWarnDays(s.projectId)}
          {#if qd != null}<span class="d-exp" title={t('{n} 天后清理', { n: qd })}>{qd ? t('剩 {n} 天', { n: qd }) : t('今天清理')}</span>{/if}
        {/if}
      </button>
      <button class="d-more" aria-label={t('更多')} onclick={(e) => openMenu(e, 'session', s.id)}><span class="ic">&#xe062;</span></button>
    </div>
  {/snippet}

  {#snippet archRow(s)}
    <!-- 已归档视图的一行：标题 + 所在项目 · 归档时间（跨项目平铺，得看得出是哪个项目的） -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="d-row arch" class:cur={s.id === curId} oncontextmenu={(e) => rowCtx(e, 'archived', s.id)}>
      <button class="d-recent" onclick={() => openArchived(s)}>
        <span class="d-two">
          <span class="d-title">{tr(titleFor(s.id, s.title)) || t('（无标题）')}</span>
          <span class="d-sub">{#if projName(s.projectId)}{projName(s.projectId)}{' · '}{/if}{relTime(s.archivedAt || s.mtime)}</span>
        </span>
      </button>
      <button class="d-more" aria-label={t('更多')} onclick={(e) => openMenu(e, 'archived', s.id)}><span class="ic">&#xe062;</span></button>
    </div>
  {/snippet}

  {#snippet projRow(p, i)}
    <div class="d-pblock" class:ins={insShown === i}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="d-row proj" title={p.path || ''} class:lifted={liftedId === p.id}
      draggable={mouseDnd ? 'true' : 'false'} ondragstart={(e) => onProjDragStart(e, p)} ondragend={onSideDragEnd}
      onpointerdown={(e) => projHoldDown(e, p)} onpointermove={projHoldMove} onpointerup={projHoldUp} onpointercancel={projHoldUp}
      oncontextmenu={(e) => rowCtx(e, 'project', p.id)}>
      <button class="d-recent" onclick={() => newInProject(p)}>
        <span class="d-bub"><span class="ic pj">&#xe0c9;</span></span>
        <span class="d-title">{tr(p.name)}</span>
      </button>
      {#if (grouped.get(p.id) || []).length}
        <button class="d-more d-fold" class:closed={!!collapsed[p.id]} aria-label={collapsed[p.id] ? t('展开会话') : t('收起会话')} onclick={(e) => toggleFold(e, p.id)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      {/if}
      <button class="d-more" aria-label={t('项目选项')} onclick={(e) => openMenu(e, 'project', p.id)}><span class="ic">&#xe062;</span></button>
    </div>
    {#if !collapsed[p.id] && !projDragging}
      {@const pg = paged.get(p.id)}
      {@const more = (pg?.rest || 0) + serverRest(p.id)}
      {#each pg?.rows || [] as s (s.id)}{@render convRow(s, true)}{/each}
      {#if more}
        <!-- 剩余数 = 本地还没放出来的 + 服务端还没拿到的（老会话翻页，见 loadOlder） -->
        <button class="d-pager" disabled={!!olderBusy[p.id]} onclick={() => showMore(p.id)}>{olderBusy[p.id] ? t('加载中…') : t('显示更多（{n}）', { n: more })}</button>
      {:else if shown[p.id]}
        <button class="d-pager" onclick={() => showLess(p.id)}>{t('收起')}</button>
      {/if}
    {/if}
    </div>
  {/snippet}

{#snippet drawerBody()}
  <!-- 左上角标题 = claude.ai /code 原件「Claude Code」SVG 字标（14px 高、text-primary），不是文字 -->
  <div class="brand"><ClaudeCodeWordmark /></div>
  {#if !single}<button class="d-item" onclick={slideOut}><span class="ic d-lead w7">&#xe08a;</span>{t('主页')}</button>{/if}
  <!-- 新对话（官方侧栏第一行 New session；S1-6）：落在当前项目，在临时对话里就落到最近用过的真实项目。
       图标是自绘的「方框 + 笔」，不走图标字体 -->
  {#if !IS_CSNAP}
    <button class="d-item" onclick={newChat}>
      <span class="d-lead svg" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M7.25 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V8.75"/><path d="M11.75 2.6a1.25 1.25 0 0 1 1.77 1.77L8.6 9.3l-2.35.6.6-2.35z"/></svg>
      </span>{tc('claude', '新对话')}{#if pointer.fine}<span class="d-kbd" aria-hidden="true">{NEW_KBD}</span>{/if}</button>
  {/if}
  <!-- 搜索会话（官方侧栏顶部的 Search，Ctrl+K）：标题 / 曾用名 / 全文，覆盖所有项目、临时对话与已归档会话 -->
  {#if !IS_CSNAP && who}
    <button class="d-item" onclick={openSearch}><span class="ic d-lead">&#xe0d3;</span>{t('搜索')}{#if pointer.fine}<span class="d-kbd" aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</span>{/if}</button>
  {/if}
  <button class="d-item" onclick={openProjectModal}><span class="ic d-lead w7">&#xe001;</span>{t('新建项目')}</button>
  <!-- 新建临时对话（原「新建快照」）：虚线气泡＝不进任何项目、放久了会清理 -->
  <button class="d-item" disabled={!quickProj || quickBusy} onclick={newQuick}>
    <span class="d-lead svg" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3h7A2.5 2.5 0 0 1 14 5.5v3.5a2.5 2.5 0 0 1-2.5 2.5H8l-3 2.25V11.5h-.5A2.5 2.5 0 0 1 2 9V5.5A2.5 2.5 0 0 1 4.5 3Z" stroke-dasharray="2 1.7"/></svg>
    </span>{t('新建临时对话')}</button>
  {#if pluginOn('routines')}<button class="d-item" onclick={openRoutines}>
    <span class="d-lead ck" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="5.5"/><line class="hh" x1="8" y1="8" x2="10" y2="9"/><line class="mh" x1="8" y1="8" x2="8" y2="5.5"/>
      </svg>
    </span>{t('定时触发')}</button>{/if}
  {#if arch.view}
    <!-- 已归档视图（官方 Sessions 页的 Archived 标签 / 侧栏 Status=Archived）：抽屉内整页切换，平铺、按归档时间倒序，
         每行能打开看、取消归档、删除；底部「显示更多」走服务端分页。宽屏常驻侧栏与手机抽屉同一份。 -->
    <div class="d-arch-head">
      <button class="d-back" aria-label={t('返回')} onclick={closeArchivedView}><span class="ic">&#xe00c;</span></button>
      <span class="d-arch-t">{t('已归档')}</span>
      {#if arch.total}<span class="d-count">{arch.total}</span>{/if}
    </div>
    <div class="d-list">
      {#each arch.rows as s (s.id)}{@render archRow(s)}{/each}
      {#if !arch.rows.length}<div class="d-empty">{arch.loading ? t('加载中…') : t('还没有归档的会话。')}</div>{/if}
      {#if arch.more}
        <button class="d-pager flat" disabled={arch.loading} onclick={() => loadArchived(true)}>{arch.loading ? t('加载中…') : t('显示更多')}</button>
      {/if}
    </div>
  {:else}
  <!-- 临时对话区（原「快照」，S1-6）：全部还留着的临时对话，最近的在上；30 天没动才清理，先进回收站 -->
  {#if quickProj && (quickSessions.length || quickBlank || quickBin || quickOrphRows.length)}
    <div class="d-sec">{tc('临时对话区', '临时对话')}</div>
    <div class="d-list">
      {#if quickBlank && !quickOrphRows.some((o) => o.id === session.projectId)}
        <div class="d-row cur"><button class="d-recent" onclick={closeDrawer}><span class="d-title">{t('新的临时对话')}</span></button></div>
      {/if}
      {#each quickRows.rows as s (s.id)}{@render convRow(s, false)}{/each}
      <!-- 只有文件、没有对话的临时对话（删光了对话 / 老版本留下的）：点开在那只桶里开空白对话，工作台里看得见文件 -->
      {#each quickRows.orph as o (o.id)}
        {@const od = quickWarnDays(o.id)}
        <div class="d-row" class:cur={quickBlank && session.projectId === o.id}>
          <button class="d-recent" onclick={() => openOrphan(o.id)}>
            <span class="d-title">{t('{n} 个文件，还没有对话', { n: o.items || 0 })}</span>
            {#if od != null}<span class="d-exp" title={t('{n} 天后清理', { n: od })}>{od ? t('剩 {n} 天', { n: od }) : t('今天清理')}</span>{/if}
          </button>
        </div>
      {/each}
      {#if quickRows.rest}
        <button class="d-pager flat" disabled={quickOlderBusy} onclick={showMoreQuick}>{quickOlderBusy ? t('加载中…') : t('显示更多（{n}）', { n: quickRows.rest })}</button>
      {:else if shownQuick}
        <button class="d-pager flat" onclick={() => (shownQuick = 0)}>{t('收起')}</button>
      {/if}
      {#if quickBin}
        <button class="d-pager flat" onclick={openBin}>{t('回收站（{n}）', { n: quickBin })}</button>
      {/if}
    </div>
  {/if}
  {#if starred.length}
    <div class="d-sec">{tc('名词', '收藏')}</div>
    <div class="d-list">{#each starred as s (s.id)}{@render convRow(s, false)}{/each}</div>
  {/if}
  <div class="d-sec">{tc('claude', '项目')}</div>
  <!-- 项目列表整张是排序落点：鼠标走 HTML5 dragover/drop，手指走长按拿起（use:dropZone） -->
  <div class="d-list d-projs" class:reordering={projDragging} class:ins-end={insShown >= 0 && insShown === realProjects.length}
    role="list" use:dropZone={projListZone} ondragover={onProjDragOver} ondragleave={onProjDragLeave} ondrop={onProjDrop}>
    {#each realProjects as p, i (p.id)}{@render projRow(p, i)}{/each}
    {#if !realProjects.length}<div class="d-empty">{who ? t('加载中…') : t('登录后显示')}</div>{/if}
  </div>
  <!-- 「已归档（n）」入口：项目列表最底下一行，点进去是已归档视图（没有归档过的会话就不出现） -->
  {#if arch.count && !IS_CSNAP}
    <button class="d-item d-arch-ent" onclick={openArchivedView}><span class="ic d-lead">&#xe008;</span>{t('已归档')}<span class="d-count">{arch.count}</span></button>
  {/if}
  {/if}
  <div class="d-spacer"></div>
  <!-- 账户卡：贴底不随列表滚走（sticky）。单 agent 模式下设置 / 账户 / 关于与更新都从这里进；
       常规模式菜单里多一项「主页」 -->
  <div class="d-foot">
    <button class="d-me" class:open={!!umAnchor} onclick={toggleUserMenu} aria-haspopup="menu" aria-expanded={!!umAnchor}
      title={t('设置与账户')}>
      <span class="av">{meInitial}</span>
      <span class="d-me-n">{meName}{#if meRole}<span class="d-me-r">{` · ${meRole}`}</span>{/if}</span>
      {#if single && updateInfo.available}<span class="d-me-dot" title={t('有新版本')}></span>{/if}
      <span class="d-me-chev" aria-hidden="true">&#xe027;</span>
    </button>
  </div>

  {#if menuFor}
    <button class="rowmenu-bd" aria-label={t('关闭')} onclick={closeMenu}></button>
    <div class="rowmenu" style={menuStyle}>
      {#if menuFor.kind === 'session'}
        {@const mq = menuSession()}
        {#if isQuickSession(mq)}
          <!-- 临时对话：收藏 / 归档对它没意义（不进收藏区、不归档），换成「存为工作空间」；快到清理时多一项「继续保留」 -->
          <button disabled={quickBusy} onclick={() => saveQuick(mq.projectId, mq)}><span class="ic mi">&#xe0c9;</span>{t('存为工作空间')}</button>
          {#if quickWarnDays(mq.projectId) != null}
            <button disabled={quickBusy} onclick={() => keepQuick(mq.projectId)}><span class="ic mi">&#xe03b;</span>{t('继续保留')}</button>
          {/if}
        {:else}
          <button onclick={() => doStar(menuFor.id)}><span class="ic mi">&#xe0bd;</span>{isStarred(menuFor.id) ? t('取消收藏') : t('收藏')}</button>
        {/if}
        <button onclick={() => doRename(menuSession())}><span class="ic mi">&#xe064;</span>{t('重命名')}</button>
        {#if !isQuickSession(mq)}
          <!-- 归档（官方 remove 组）：在工作 / 在等回答的会话不能归档（官方同款） -->
          {@const ms = menuSession()}
          <button disabled={!!(ms && (ms.thinking || ms.pending))} title={ms && (ms.thinking || ms.pending) ? t('正在工作的会话不能归档') : undefined}
            onclick={() => doArchive(ms)}><span class="ic mi">&#xe008;</span>{t('归档')}</button>
        {/if}
        <button class="danger" onclick={() => (delConfirm ? doDelete(menuFor.id) : (delConfirm = true))}><span class="ic mi">&#xe101;</span>{delConfirm ? tc('claude', '确认删除') : t('删除')}</button>
      {:else if menuFor.kind === 'archived'}
        <button onclick={() => doUnarchive(menuFor.id)}><span class="ic mi">&#xe008;</span>{t('取消归档')}</button>
        <button class="danger" onclick={() => (delConfirm ? doDelete(menuFor.id) : (delConfirm = true))}><span class="ic mi">&#xe101;</span>{delConfirm ? tc('claude', '确认删除') : t('删除')}</button>
      {:else}
        <button onclick={() => doRenameProject(menuProject())}><span class="ic mi">&#xe064;</span>{t('重命名')}</button>
        <!-- 归档全部会话（官方分组菜单的 Archive all）：组里有会话才出 -->
        {#if (grouped.get(menuFor.id) || []).length || projCounts[menuFor.id]}
          <button onclick={() => doArchiveProject(menuProject())}><span class="ic mi">&#xe008;</span>{t('归档全部会话')}</button>
        {/if}
        <!-- 默认工作空间只能改名，不能删（服务端也拦） -->
        {#if !menuProject()?.def}
          <button class="danger" onclick={() => (delConfirm ? doDeleteProject(menuFor.id) : (delConfirm = true))}><span class="ic mi">&#xe101;</span>{delConfirm ? tc('claude', '确认删除') : t('删除项目')}</button>
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

<!-- 窄屏：侧拉抽屉 + scrim（宽屏时常驻列已渲染在上方，这里不再出现） -->
{#if !wide}
  <button class="scrim {ui.drawerOpen ? 'open' : ''}" aria-label={t('关闭侧栏')} onclick={closeDrawer}></button>
  <aside class="drawer {ui.drawerOpen ? 'open' : ''}" bind:this={drawerEl} use:dragScrollGuard>{@render drawerBody()}</aside>
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

<!-- 重命名对话（替代 window.prompt——Electron 不实现 prompt，桌面壳里原来点了没反应） -->
{#if renameFor}
  <button class="pm-bd" aria-label={t('关闭')} onclick={() => (renameFor = null)}></button>
  <div class="pmodal rnmodal" role="dialog" aria-modal="true">
    {#if renameFor.kind === 'project'}
      <div class="pm-head"><span class="ic pm-ic">&#xe064;</span>{tc('claude', '重命名工作空间')}</div>
      <input class="rn-input" bind:value={renameFor.name} onkeydown={renameKey} use:renameFocus placeholder={tc('claude', '留空恢复为文件夹名')} maxlength="80" />
    {:else}
      <div class="pm-head"><span class="ic pm-ic">&#xe064;</span>{tc('claude', '重命名对话')}</div>
      <input class="rn-input" bind:value={renameFor.name} onkeydown={renameKey} use:renameFocus placeholder={tc('claude', '对话名称')} maxlength="120" />
    {/if}
    <div class="pm-actions">
      <button class="pm-cancel" onclick={() => (renameFor = null)}>{t('取消')}</button>
      <button class="pm-create" onclick={commitRename}>{t('保存')}</button>
    </div>
  </div>
{/if}

<!-- 归档父会话时有子会话：只归档这一条，还是一家子全部归档（官方 Archive session? 对话框） -->
{#if archAsk}
  <button class="pm-bd" aria-label={t('关闭')} onclick={() => (archAsk = null)}></button>
  <div class="pmodal archmodal" role="dialog" aria-modal="true">
    <div class="pm-head"><span class="ic pm-ic">&#xe008;</span>{t('归档会话？')}</div>
    <p class="am-body">
      {archAsk.title ? t('「{title}」有 {n} 个子会话。只归档此会话的话，它们会移到顶层。', { title: tr(archAsk.title), n: archAsk.kids.length }) : t('此会话有 {n} 个子会话。只归档此会话的话，它们会移到顶层。', { n: archAsk.kids.length })}
      {#if archAsk.working}{t('其中 {n} 个仍在工作，全部归档时会跳过它们。', { n: archAsk.working })}{/if}
    </p>
    <div class="pm-actions am-actions">
      <button class="pm-cancel" onclick={() => (archAsk = null)}>{t('取消')}</button>
      <button class="pm-cancel am-all" onclick={() => runArchive([archAsk.id, ...archAsk.kids])}>{t('全部归档（{n} 个会话）', { n: archAsk.kids.length + 1 })}</button>
      <!-- 仅归档此会话：子会话移到顶层（服务端记下，之后它取消归档也不再挂回来——官方 detach 同款） -->
      <button class="pm-create" use:focusBtn onclick={() => runArchive([archAsk.id], { detach: true })}>{t('仅归档此会话')}</button>
    </div>
  </div>
{/if}

<!-- 临时对话回收站（S1-6）：30 天没动的临时对话整只挪在这里，再放 trashDays 天才永久删除；点「恢复」原样回到列表 -->
{#if binOpen}
  <button class="pm-bd" aria-label={t('关闭')} onclick={() => (binOpen = false)}></button>
  <div class="pmodal binmodal" role="dialog" aria-modal="true" aria-label={t('临时对话回收站')}>
    <div class="pm-head"><span class="ic pm-ic">&#xe101;</span>{t('临时对话回收站')}</div>
    <p class="am-body">{t('超过 {n} 天没动的临时对话会移到这里，再过 {m} 天永久删除。恢复后对话和产物原样接上。', { n: quickPol.ttlDays, m: quickPol.trashDays })}</p>
    <div class="bin-list">
      {#each binItems as it (it.id)}
        {@const left = daysLeft(it.purgeAt)}
        <div class="d-row bin-row">
          <span class="d-two">
            <span class="d-title">{tr(it.sessionId ? titleFor(it.sessionId, it.title) : it.title) || t('（无标题）')}</span>
            <span class="d-sub">{t('{when}移入', { when: relTime(it.recycledAt) })}{#if left != null}{' · '}{t('{n} 天后永久删除', { n: left })}{/if}{#if it.sessions > 1}{' · '}{t('{n} 段对话', { n: it.sessions })}{/if}{#if it.items}{' · '}{t('有 {n} 个文件', { n: it.items })}{/if}</span>
          </span>
          <button class="pm-cancel bin-restore" disabled={binBusy} onclick={() => restoreBin(it)}>{t('恢复')}</button>
        </div>
      {/each}
      {#if !binItems.length}<div class="d-empty">{binLoading ? t('加载中…') : t('回收站是空的。')}</div>{/if}
    </div>
    <div class="pm-actions"><button class="pm-cancel" onclick={() => (binOpen = false)}>{t('关闭')}</button></div>
  </div>
{/if}

<!-- 搜索会话：宽屏居中面板 / 手机全屏页 -->
{#if searchOpen}
  <SessionSearch sessions={listed} {projects} full={layout.compact} onOpen={openHit} onClose={() => (searchOpen = false)} />
{/if}

<RoutinesPage />
</div>
</div>
<svelte:window onkeydown={onSearchKey} />

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
  }
  /* 侧栏拉动把手（官方同款）：12px 隐形条骑缝右缘（left = 宽-6），全高 col-resize；
     3×48 指示条悬停 200ms 延迟浮现、拖拽中常显、键盘聚焦转珊瑚色 */
  .sb-handle { position: absolute; top: 0; bottom: 0; width: 12px; z-index: 45; cursor: col-resize; outline: none; }
  .sb-pill { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 3px; height: 48px;
    border-radius: 999px; background: var(--muted); opacity: 0;
    transition: opacity .2s ease .2s, background-color .2s ease; }
  .sb-handle:hover .sb-pill, .sb-handle.drag .sb-pill { opacity: 1; }
  .sb-handle:focus-visible .sb-pill { opacity: 1; background: var(--coral); transition-delay: 0s; }
  .stage { flex: 1; position: relative; min-height: 0; display: flex; flex-direction: column; }
  /* 空态（官方 /code 落地页）：上半区可滚（问候 + 用量卡），底部是输入框。
     edge-to-edge 后页面顶到物理屏顶，顶距要再加状态栏高度（--sat）。 */
  .hero { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .hero > .hero-scroll, .hero > .hero-foot { position: relative; z-index: 1; }
  .hero-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch;
    padding: calc(clamp(60px, 11vh, 112px) + var(--sat)) 16px 24px; }
  /* 与输入框卡片同一根轴（760 列、左缘对齐）：问候和卡片贴列左缘，官方同款 */
  .hero-col { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; align-items: flex-start; gap: 24px; }
  /* 官方问候（cc43287c9 nz）：22px 星芒 + text-title 22/28、常规字重（wght 360）、主文字色 */
  .greeting { display: flex; align-items: center; gap: 8px; }
  .logo-fly { display: inline-flex; flex: none; }
  .greeting h1 { font-family: var(--sans); font-weight: 400; font-size: 22px; line-height: 28px; color: var(--text); margin: 0; }
  .hero-stats { width: 100%; max-width: 480px; background: var(--bg); border-radius: 8px; }   /* 卡片自身是 5% 半透明底：垫一层页面底色，背后的字符风不透上来（观感与原来一样） */
  /* 底部输入区 = 聊天态 .composer-wrap 的几何（6/8/安全区 内边距、760 居中），只是放在文档流里不悬浮 */
  .hero-foot { flex: none; padding: 6px 8px max(10px, var(--sab)); }
  .hero-composer { max-width: 760px; margin: 0 auto; }
  /* 归属状态栏两处的对齐槽：与输入框卡片同宽同轴（.composer-wrap 整层 pointer-events:none，
     故聊天态这一槽要自己把事件收回来，否则芯片点不动）。 */
  .hero-chips { max-width: 760px; margin: 0 auto; }
  /* 聊天态的归属芯片只在【滚到底】时显形：不动布局，只淡入 + 6px 上浮。
     高度恒占着（--composer-h 不变），所以显隐不会改滚动区内边距、不会在底部抖一下。
     transform 常驻（收起态也写 translateY(0) 而非 none）——保证 .chips-slot 始终是层叠
     上下文，::before 那层渐隐罩的绘制顺序不会在过渡中途翻。
     双向过渡：位移走 --ea-std，透明度走 --ea-fade（运动令牌见 app.css）。 */
  .chips-slot {
    position: relative; max-width: 760px; margin: 0 auto;
    opacity: 0; transform: translateY(6px); pointer-events: none;
    transition: opacity var(--mo-quick) var(--ea-fade), transform var(--mo-quick) var(--ea-std);
  }
  .chips-slot.foot { opacity: 1; transform: translateY(0); pointer-events: auto; }
  /* 芯片是几条窄胶囊，挡不住整行正文——正文从悬浮输入栏下方穿过时，会有残字从芯片旁边
     露出来。补一层向上渐隐到页底色的薄罩把正文先化掉（官方在芯片行与输入框之间也垫了
     一层同作用的 pointer-events:none 元素）。z-index:-1 只退到 .composer-wrap 这个
     层叠上下文的底，仍盖在滚动区之上。 */
  .chips-slot::before {
    content: ''; position: absolute; left: -8px; right: -8px; top: -26px; bottom: -4px;
    /* 渐隐段用绝对长度收在芯片【上方】：到芯片顶边（距罩顶 26px）就已经是纯 --bg，
       芯片那一带整条实心，正文残字不会再从胶囊缝里冒出来。 */
    background: linear-gradient(to bottom, transparent 0, var(--bg) 26px);
    pointer-events: none; z-index: -1;
  }
  /* 回退横条的槽：RefusalBand 没东西可显时自己什么都不渲染 → 槽随之 display:none（不占那 6px
     堆叠间距、::before 罩也不留在输入卡上方）。底必须不透明——横条本身只有 4% 的底色（官方 --t1），
     不垫页底色就会透出从输入栏底下穿过的残字；同芯片再补一层向上渐隐的薄罩，最下 6px 实心，
     正好盖住与归属芯片之间的堆叠间距。z-index:-1 退到 .composer-wrap 这个层叠上下文的底、仍盖着滚动区。 */
  .band-slot { position: relative; max-width: 760px; margin: 0 auto; pointer-events: auto;
    background: var(--bg); border-radius: 10px; }
  .band-slot:not(:has(:global(*))) { display: none; }
  .chips-slot + .band-slot { margin-top: 6px; }
  .band-slot::before { content: ''; position: absolute; left: -8px; right: -8px; top: -26px; bottom: 0;
    background: linear-gradient(to bottom, transparent 0, var(--bg) 20px); pointer-events: none; z-index: -1; }

  /* 滚动区吃满整个 stage；底部留出卡片高度（+8px 呼吸），最后一条消息能滚到卡片上方 */
  /* overflow-x 必须显式 hidden：只写 overflow-y:auto 时 CSS 会把另一根轴算成 auto，
     于是任何一处超宽内容（宽表格、长公式、宽卡片）都能把【整条会话】变成可左右拖的画布。
     超宽内容各自在自己身上横滚（见 Thread 里 pre / table 的规则），这里只做兜底闸。 */
  .scroll { flex: 1; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; padding-bottom: calc(var(--composer-h, 84px) + 8px); }
  /* 官方 /code 转录渐隐尺寸：顶带 32px、底带 48px（桌面原值）。底带要钉在输入卡片上沿——官方是
     scroller 高 100%+On、strip bottom:On；这里等价物是 .scroll 的 padding-bottom（= 卡片高 + 8），而
     Chromium 的 sticky 约束框已经扣掉滚动容器自身的 padding（实测 bottom 写成卡片高会离卡片再高一个
     卡片高，2026-09-11 无头 Edge 量出 244 = 2×122），所以底带 bottom:0 就正好落在卡片上沿；滚到底时
     带子的静态位置也在这条线上，钉住与不钉住无缝衔接。
     手机端官方那两档占屏太宽（32/48 在 6 寸屏上吃掉近一行正文），收到 18/28；断点与 layout.svelte.js 的
     compact(<700) 同源。 */
  /* 顶带桌面端加长并下移（维护者 09-23）：32 → 52px，头上先垫 --sf-lead 12px 实色再开始官方那段梯度，
     渐隐起点等于整体下移 12px、渐隐段本身 40px（原 32）。不用 top 偏移去「挪」——那样带子上方会漏出一条
     正文。实色头正好把标题栏带（WCO 40px 拖拽区）的上半截衬成一块干净底，拖拽区看得出来。 */
  .scroll { --sf-top: 52px; --sf-lead: 12px; --sf-bottom: 48px; --scroll-fade-color: var(--bg); }
  .scroll > .scroll-fade-strip-top { --scroll-fade-size: var(--sf-top);
    background: linear-gradient(to bottom,
      var(--scroll-fade-color) var(--sf-lead),
      color-mix(in srgb, var(--scroll-fade-color) 85%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .13),
      color-mix(in srgb, var(--scroll-fade-color) 50%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .40),
      color-mix(in srgb, var(--scroll-fade-color) 15%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .70),
      transparent); }
  /* 底带钉到【卡片】上沿而不是底衬边缘：底衬 = 整个 wrap 高（含透明的芯片槽），卡片顶到 wrap 底只有
     --composer-card-top，差值用负 bottom 补回去（sticky 负偏移合法）。没量到时两者相等 → bottom:0。 */
  /* 再减 10px：底衬比卡片高出的 8px「呼吸」留白本来落在带子和卡片之间，那一条正文完全没被盖——
     手机上（带子只 28px）就是一道亮缝（维护者 09-11 第三张截图）。带子下沿压到卡片上沿下方 2px，
     被卡片（z-index 更高）盖住，实底与卡片无缝相接。 */
  .scroll > .scroll-fade-strip-bottom { --scroll-fade-size: var(--sf-bottom); bottom: calc(var(--composer-card-top, var(--composer-h, 84px)) - var(--composer-h, 84px) - 10px); }
  @media (max-width: 699px) { .scroll { --sf-top: 18px; --sf-lead: 0px; --sf-bottom: 28px; } }
  :global(html[data-wco="1"]) .scroll::-webkit-scrollbar-thumb { border-style: solid; border-color: transparent; border-width: 0 7px 0 1px; background-clip: padding-box; }
  /* 输入栏卡片：绝对定位悬浮在正文之上，无实心背景/隔层——正文向上滚时从卡片下方穿过 */
  .composer-wrap { position: absolute; left: 0; right: var(--sb-w, 0px); bottom: 0; z-index: 5;
    padding: 6px 8px max(10px, var(--sab)); background: transparent; pointer-events: none; }
  /* 卡片【下方】那段底部留白（手机手势条安全区可达 30–40px）是透明的：正文从卡片底边和屏幕底之间
     透出来（维护者 09-11 截图第二处）。垫一层页底色，再往上盖住卡片下半段（卡片圆角外的缝也一并封住）；
     z-index:-1 退到 .composer-wrap 这个层叠上下文的底，仍在滚动区之上。 */
  .composer-wrap::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0;
    height: calc(max(10px, var(--sab)) + 28px); background: var(--bg); pointer-events: none; z-index: -1; }
  .composer-inner { max-width: 760px; margin: 0 auto; pointer-events: auto; }

  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); opacity: 0; visibility: hidden; transition: opacity .25s ease, visibility .25s; z-index: 40; }
  .scrim.open { opacity: 1; visibility: visible; }
  .drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 80vw; max-width: 320px; background: var(--bg); border-right: 1px solid var(--divider); transform: translateX(-100%); visibility: hidden; transition: transform .26s cubic-bezier(.22,1,.36,1), background-color .25s ease, visibility 0s linear .26s; z-index: 50; display: flex; flex-direction: column; padding: 10px 8px; padding-top: max(10px, var(--sat)); overflow-y: auto; }
  /* 关闭态 visibility:hidden —— 侧滑返回时 .claude-slide 的 transform 会把屏外的 drawer 推进屏内，
     隐藏掉就不会"先展开侧边栏"；visibility 用 .26s 延迟，保证关闭滑出动画本身可见、滑完才隐藏。 */
  .drawer.open { transform: none; visibility: visible; transition: transform .26s cubic-bezier(.22,1,.36,1), background-color .25s ease, visibility 0s linear 0s; box-shadow: 0 0 40px rgba(0,0,0,.3); }
  /* 字标行：官方标题栏里字标垂直居中、高 14px；这里给 44px 行高（与原 21px 衬线文字的占位持平），
     下留 2px 让字标视觉上略高于几何中线。颜色 = 官方 text-primary。 */
  .brand { display: flex; align-items: center; flex: none; height: 44px; padding: 0 10px 2px; color: var(--text); }
  /* 桌面壳 WCO：字标行整行划进窗口拖拽区（维护者 09-23：顶部可拖范围太窄、不明显）。DesktopChrome 那条
     全局 `html[data-wco] .brand{no-drag}` 是给主页可点的 BrandTitle 打的洞，这里的字标只是一枚 img，
     不可点——作用域类多一级优先级压过它。字标行（drawer 顶 10 + 44 = 54px）比 40px 标题栏带更深，
     左上角那一块从窗口顶到「主页」上沿都能拖。 */
  :global(html[data-wco="1"]) .brand { -webkit-app-region: drag; user-select: none; }
  /* flex:none 必须写：.drawer 是溢出的 flex 列，min-height:auto 会把这行压到内容高（实测 16px），字标贴到「主页」上 */
  /* —— claude.ai 同款侧栏（实测规格：行高 32/圆角 8/字号 14/悬停 rgba .06、
     图标 Anthropicons 可变字重：导航 20px/430、New·主页 16px/700、⋮ 16px/530、气泡 e037）—— */
  .d-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 14px; color: var(--serif); text-align: left; transition: background-color .12s ease, color .12s ease; }
  .d-item:active { background: var(--hover); color: var(--text); }
  .d-item:disabled { color: var(--muted); }
  .d-lead { width: 22px; text-align: center; font-size: 20px; font-weight: 430; color: var(--serif); flex: none; }
  .d-lead.w7 { font-size: 16px; font-weight: 700; }
  /* 定时触发 = claude.ai 侧栏 Scheduled 同款钟（连悬停动效一并取回，2026-08-14 实测源码规格）：
     16 视口 / 1px 描边 / 圆头圆角，表盘 r5.5，时针 (8,8)→(10,9)、分针 (8,8)→(8,5.5)；
     悬停两针以 8 8 为轴转动 —— 时针 +30°（走一格），分针 +390°（整圈再 30°，与时针同步落位），
     0.6s cubic-bezier(.3,.9,.4,1)；表盘不动。触屏无 hover，:active 走同一套。 */
  .d-lead.ck { display: flex; align-items: center; justify-content: center; }
  .d-lead.ck svg { width: 16px; height: 16px; }
  /* 新对话 / 新建临时对话：自绘 16px 描边图标（与定时触发的钟同一套尺寸） */
  .d-lead.svg { display: flex; align-items: center; justify-content: center; }
  .d-lead.svg svg { width: 16px; height: 16px; }
  /* 临时对话快到清理：行尾一枚「n 天」，悬停时让位给 ⋮ */
  .d-exp { flex: none; margin-left: auto; padding: 0 4px 0 6px; font-size: 12px; color: var(--warn); font-variant-numeric: tabular-nums; transition: opacity .12s ease; }
  @media (hover: hover) { .d-row:hover .d-exp, .d-row:focus-within .d-exp { opacity: 0; } }
  /* 临时对话回收站弹窗 */
  .binmodal { max-height: min(560px, calc(100vh - 80px)); }
  .bin-list { flex: 1; min-height: 0; overflow-y: auto; margin: 6px -6px 0; }
  .bin-row { gap: 8px; padding: 6px 6px 6px 10px; }
  .bin-restore { flex: none; border: 1px solid var(--divider); padding: 5px 12px; }
  @media (hover: hover) { .bin-restore:hover { background: var(--hover); color: var(--text); } }
  .d-lead.ck line { transform-box: view-box; transform-origin: 8px 8px;
    transition: rotate .6s cubic-bezier(.3, .9, .4, 1); }
  .d-item:active .ck .hh { rotate: 30deg; }
  .d-item:active .ck .mh { rotate: 390deg; }
  .d-sec { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 12px; padding: 14px 4px 4px 10px; }
  .d-list { display: flex; flex-direction: column; }
  .d-row { position: relative; display: flex; align-items: center; border-radius: 8px; margin-bottom: .5px; transition: background-color .12s ease; }
  /* 拎着文件悬在某条会话上：这条亮起来，松手＝切过去并挂进它的输入栏 */
  .d-row.dnd-on { background: color-mix(in srgb, var(--coral) 22%, transparent); box-shadow: inset 0 0 0 1.5px var(--coral); }
  .d-row.cur { background: var(--hover-strong); }
  .d-row.cur .d-title { color: var(--text); }
  /* 分屏里另一格正开着的会话：浅一档的底 + 左侧一道细线，看得出「它也在屏上」 */
  .d-row.alt { background: var(--hover); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--coral) 55%, transparent); }
  .d-row.alt .d-title { color: var(--text); }
  /* 被拎起来的那一行留在原处淡着（拖拽图/幽灵才是「手里那份」） */
  .d-row.lifted { opacity: .38; }
  .d-row[draggable="true"] { -webkit-user-drag: element; }
  /* 项目排序：拖项目时会话行整体收起（只剩一行行项目），插入线画在目标块上沿 / 列表末尾 */
  .d-pblock { position: relative; }
  .d-projs { position: relative; }
  .d-projs.reordering { padding-bottom: 18px; }
  .d-pblock.ins::before, .d-projs.ins-end::after { content: ''; position: absolute; left: 6px; right: 6px; height: 2px; border-radius: 2px;
    background: var(--coral); pointer-events: none; z-index: 2; }
  .d-pblock.ins::before { top: -1px; }
  .d-projs.ins-end::after { bottom: 16px; }
  /* 会话缩进到项目标题文字正下方（项目行 8 padding + 20 图标 + 8 gap = 36 − 本行 8 padding） */
  .d-row.indent { margin-left: 28px; }
  /* 子会话（官方 Desktop 子会话树）：再缩 18px，左侧一根细竖线对齐父行标题起点（28+8=36px）；
     相邻子行的竖线首尾相接成一条（行间 .5px 缝用 -1px 盖住）。 */
  .d-row.indent.child { margin-left: 46px; }
  .d-row.child::before { content: ''; position: absolute; left: -10px; top: -1px; bottom: -1px; width: 1px; background: var(--divider); pointer-events: none; }
  .d-recent { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 8px 2px 8px 8px; border-radius: 8px; text-align: left; color: var(--serif); font-size: 14px; }
  .d-recent:active { background: var(--hover); }
  .d-bub { position: relative; width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center; }
  /* 项目图标 = claude.ai 同款动态字形：Anthropicons 的 ANIM 变体轴（0→100 盒盖展开），
     悬停/按下经已注册的 --ca-anim（app.css @property）过渡驱动，回弹曲线与官网一致。 */
  .d-bub .pj { font-size: 18px; color: var(--serif);
    font-variation-settings: "ANIM" var(--ca-anim, 0), "ANM2" 0, "opsz" 20, "wght" 433;
    transition: --ca-anim .3s cubic-bezier(.34, 1.3, .64, 1); }
  .d-row.proj:active .pj { --ca-anim: 100; }
  .d-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* —— 会话标题跑马灯（官方实测规格，配 lib/marquee.js；data-* 运行时属性须 :global 保住
     scoped 规则不被编译器剪掉）——
     溢出（data-ov）：右缘渐隐 85%→99% 替代省略号；
     悬停行：两端渐隐，右侧 44→20px 为 ⋮ 留位，左侧 12px 只在开滚（data-run）后出现；
     开滚：内层 translateX(-溢出-44) 匀速 50px/s（--mq-x/--mq-dur 由 action 算好），
     离开行 data-run 摘除 → transition 失效瞬时弹回（官方无回程动画）。 */
  .d-scroll { display: inline-block; white-space: nowrap; vertical-align: top; }
  .d-title:global([data-ov]) { text-overflow: clip;
    mask-image: linear-gradient(to right, #000 85%, transparent 99%);
    -webkit-mask-image: linear-gradient(to right, #000 85%, transparent 99%); }
  .d-title:global([data-run]) .d-scroll { transform: translateX(calc(-1 * var(--mq-x, 0px)));
    transition: transform var(--mq-dur, 0s) linear; }
  .d-more { width: 28px; height: 28px; margin-right: 2px; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; transition: color .12s ease, opacity .12s ease; }
  .d-more:active { background: var(--hover-strong); }
  .d-more .ic { font-size: 16px; font-weight: 530; }
  /* 项目折叠 chevron：展开=▾ 收起=▸（旋转过渡）；桌面沿用「悬停才浮现」，但收起态常显（不然看不出折了） */
  .d-fold svg { width: 15px; height: 15px; transition: transform .16s ease; }
  .d-fold.closed svg { transform: rotate(-90deg); }
  /* 指针环境（桌面）：行悬停浮出底色，⋮ 平时隐身、行悬停/键盘聚焦才浮现，悬停 ⋮ 文字提亮，
     项目图标盒盖展开（ANIM 轴 0→100）——与 claude.ai 同款 */
  @media (hover: hover) {
    .d-item:hover { background: var(--hover); color: var(--text); }
    .d-item:hover .ck .hh { rotate: 30deg; }
    .d-item:hover .ck .mh { rotate: 390deg; }
    .d-row:hover, .d-row:focus-within { background: var(--hover); }
    .d-row:hover .d-title, .d-row:focus-within .d-title { color: var(--text); }
    .d-row.proj:hover .pj { --ca-anim: 100; }
    .d-more { opacity: 0; pointer-events: none; }
    .d-row:hover .d-more, .d-row:focus-within .d-more { opacity: 1; pointer-events: auto; }
    .d-more:hover { color: var(--text); }
    .d-fold.closed { opacity: 1; pointer-events: auto; }   /* 折叠着的组：chevron 常显，不然看不出折了 */
    /* 官方同款：会话行 ⋮ 改绝对定位悬浮在行尾（不占排版位）——标题非悬停时吃满整行，
       悬停时由跑马灯的 mask 在右侧 44→20px 挖出渐隐区给按钮让位。项目行有两枚尾按钮，维持原排版。 */
    .d-row:not(.proj) .d-more { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); margin-right: 0; }
    .d-row:hover .d-title:global([data-ov]), .d-row:focus-within .d-title:global([data-ov]) {
      mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - 44px), transparent calc(100% - 20px));
      -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - 44px), transparent calc(100% - 20px));
    }
    .d-title:global([data-run]) { --mq-lf: 12px; }   /* 左缘渐隐只在开滚后出现（官方行为） */
  }
  .rowmenu-bd { position: fixed; inset: 0; z-index: 55; }
  .rowmenu { position: fixed; z-index: 56; min-width: 176px; max-width: 260px; max-height: 292px; overflow-y: auto; padding: 5px; background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow); animation: rmPop .14s ease; }
  @keyframes rmPop { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
  .rowmenu button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; font-size: 14px; color: var(--text); text-align: left; transition: background-color .12s ease; }
  .rowmenu button:active { background: var(--hover); }
  @media (hover: hover) { .rowmenu button:hover { background: var(--hover); } }
  .rowmenu button.danger { color: var(--crit); }
  .rowmenu button:disabled { opacity: .45; pointer-events: none; }
  .mi { width: 20px; text-align: center; font-size: 18px; font-weight: 450; flex: none; }
  /* 会话行不再有图标 → 状态点占「左侧空位」：项目行有 20px 图标、会话行那一列是空的。
     缩进的会话行把点绝对定位进 28px 缩进带里（正对项目图标列中心），既不吃标题宽度、
     也不会在开跑/跑完时把标题推来推去；收藏区的会话行没有缩进带，就内联在标题前。 */
  .d-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
  .d-row.indent .d-dot { position: absolute; left: -14px; top: 50%; transform: translateY(-50%); }
  .d-row.indent.child .d-dot { left: -32px; }   /* 子行多缩了 18px，点仍落在项目图标那一列 */
  .d-dot.work { background: var(--coral); animation: pulse 1.2s ease-in-out infinite; }
  .d-dot.ask { background: var(--warn); animation: blink 1s steps(2) infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  @keyframes blink { 50% { opacity: 0; } }

  /* —— 弹窗（重命名对话用；新建项目的目录浏览已退役，改走 ProjectPicker） —— */
  .pm-bd { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, .45); }
  .pmodal { position: fixed; z-index: 71; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(420px, calc(100vw - 40px)); max-height: min(560px, calc(100vh - 80px));
    display: flex; flex-direction: column; background: var(--q-card); border-radius: 16px;
    box-shadow: var(--q-shadow); padding: 16px; animation: rmPop .16s ease; }
  .pm-head { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
  .pm-ic { font-size: 18px; color: var(--serif); font-variation-settings: "opsz" 20, "wght" 433; }
  .pm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .pm-cancel { padding: 8px 14px; border-radius: 10px; color: var(--serif); }
  .pm-cancel:active { background: var(--hover); }
  .pm-create { padding: 8px 14px; border-radius: 10px; background: var(--text); color: var(--bg); font-weight: 600; }
  .pm-create:disabled { opacity: .5; }
  .rnmodal { max-height: none; }
  .archmodal { max-height: none; }
  .rn-input { width: 100%; padding: 9px 11px; border: 1px solid var(--divider); border-radius: 10px;
    background: var(--bg); color: var(--text); font-size: 14px; }
  .rn-input:focus { outline: none; border-color: var(--serif); }
  .d-empty { color: var(--muted); font-size: 13px; padding: 10px 11px; }
  /* 组内「显示更多 / 收起」：与会话行同缩进、同行高，次级色小一号，看得出不是一条会话 */
  .d-pager { display: block; width: calc(100% - 28px); margin-left: 28px; padding: 7px 8px; border-radius: 8px; text-align: left;
    color: var(--muted); font-size: 13px; transition: background-color .12s ease, color .12s ease; }
  .d-pager:active { background: var(--hover); }
  @media (hover: hover) { .d-pager:hover { background: var(--hover); color: var(--text); } }
  .d-spacer { flex: 1; min-height: 10px; }
  .d-pager:disabled { opacity: .6; pointer-events: none; }
  /* 搜索行右侧的快捷键提示（官方 df-search-field-keys：平时隐身、悬停才出） */
  .d-kbd { margin-left: auto; padding-left: 8px; font-size: 11.5px; color: var(--muted); font-family: Consolas, 'Cascadia Mono', Menlo, monospace; opacity: 0; transition: opacity .12s ease; }
  @media (hover: hover) { .d-item:hover .d-kbd, .d-item:focus-visible .d-kbd { opacity: 1; } }
  /* 已归档：入口行（项目列表最底下）与视图头（← 已归档 n） */
  .d-count { margin-left: auto; padding-left: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .d-arch-ent { margin-top: 6px; }
  .d-arch-head { display: flex; align-items: center; gap: 4px; padding: 12px 4px 6px 2px; color: var(--text); font-size: 14px; font-weight: 560; }
  .d-arch-head .d-count { font-weight: 400; padding-right: 8px; }
  .d-back { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: var(--serif); flex: none; }
  .d-back .ic { font-size: 18px; }
  .d-back:active { background: var(--hover-strong); }
  @media (hover: hover) { .d-back:hover { background: var(--hover); color: var(--text); } }
  .d-two { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .d-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: var(--muted); }
  .d-pager.flat { width: 100%; margin-left: 0; }
  /* 归档父会话的二选一对话框：三颗按钮，窄屏换行 */
  .am-body { margin: 0 0 4px; font-size: 14px; line-height: 21px; color: var(--serif); text-wrap: pretty; overflow-wrap: anywhere; }
  .am-actions { flex-wrap: wrap; }
  .am-all { border: 1px solid var(--divider); }
  /* —— 底部账户卡（claude.ai 左下角用户行实测：按钮 32px 圆角 8、头像 24px 圆、
     名字 14px 次级色、名字后一枚 ⌄；手机上加高到 44px 好按）。贴底：列表长了也不被滚走 —— */
  .d-foot { position: sticky; bottom: -10px; z-index: 2; flex: none; margin: 0 -8px -10px; padding: 8px 8px max(10px, var(--sab));
    background: var(--bg); transition: background-color .25s ease; }
  .d-me { width: 100%; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 4px; border: 0; border-radius: 8px;
    background: none; color: var(--serif); font: inherit; font-size: 14px; text-align: left; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
  .d-me.open { background: var(--hover-strong); color: var(--text); }
  .d-me:active { background: var(--hover); }
  @media (hover: hover) { .d-me:hover { background: var(--hover); color: var(--text); } }
  .d-me .av { width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    background: var(--avatar-bg); color: var(--text); font-size: 12px; font-weight: 560; }
  .d-me-n { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .d-me-r { color: var(--muted); }
  .d-me-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--st-accent); }
  .d-me-chev { flex: none; font-family: var(--icons); font-size: 16px; line-height: 1; color: var(--muted); transition: transform .15s ease; }
  .d-me.open .d-me-chev { transform: rotate(180deg); }
  @media (pointer: coarse) { .d-me { height: 44px; } .d-me .av { width: 30px; height: 30px; font-size: 13px; } }
</style>
