// Claude 页·侧栏分组：项目组折叠、收藏优先、子会话树、组内懒加载与向服务端翻页找回老会话、临时对话区的分页。

import { api } from '../api.js';
import { session } from '../state.svelte.js';
import { isStarred } from '../library.svelte.js';
import { arch, isArchivedId } from '../sessionArchive.svelte.js';
import { mergeOlder, pagerFrom, serverRestOf } from '../sessionArchiveView.js';

/** @param {any} pc 页面上下文：各区段经它互相取用（getter / setter，见 ClaudePage.svelte） */
export function createSessionTree(pc) {
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
  const isQuickSession = (s) => !!s && pc.quickIds.has(s.projectId);
  // 刚归档、服务端列表还没反映的先藏起来（乐观，lib/sessionArchive.svelte.js 的 hidden）
  const listed = $derived(pc.sessions.filter((s) => !arch.hidden[s.id]));
  const starred = $derived(listed.filter((s) => isStarred(s.id) && !isQuickSession(s)));
  // 「临时对话」区：服务端按最近活动倒序（与普通会话按 mtime 合成一列）。折着时只放最近的 1 条（10-23 维护者：其余全收进
  // 「显示更多」，只剩 1 条也不直接放出来；只有文件的那种也一并折起），「显示更多」每次再放 PAGE_STEP 条；
  // 当前打开的那条折在后面时单独补在末尾。当前这张空白对话落在临时对话里（还没发第一条）时，区首补一行占位，看得出人在哪。
  // 服务端首页只带最近 20 条：本地放完了还有没拿到的，「显示更多」接着向服务端要（loadOlderQuick）。
  const QUICK_PAGE = 1;
  let shownQuick = $state(0);
  const quickSessions = $derived(listed.filter(isQuickSession));
  // 服务端那头还有多少条临时对话没拿到（翻到底了、或首页就是全部 → 0）
  const quickSrvRest = $derived(pagerFrom(pc.quickPager, pc.quickCut).done ? 0 : Math.max(0, pc.quickCount - quickSessions.length));
  const quickRows = $derived.by(() => {
    const n = shownQuick || QUICK_PAGE;
    // 只有文件、没有对话的那种：展开后才列；折着时只留正开着的那只
    const orph = shownQuick ? quickOrphRows : quickOrphRows.filter((o) => quickBlank && session.projectId === o.id);
    const orphRest = quickOrphRows.length - orph.length;
    if (!quickSrvRest && quickSessions.length <= n) return { rows: quickSessions, orph, rest: orphRest };
    const rows = quickSessions.slice(0, n);
    const cur = pc.curId ? quickSessions.find((s, i) => i >= n && s.id === pc.curId) : null;
    return { rows: cur ? [...rows, cur] : rows, orph, rest: quickSessions.length - rows.length - (cur ? 1 : 0) + quickSrvRest + orphRest };
  });
  function showMoreQuick() {
    shownQuick = (shownQuick || QUICK_PAGE) + PAGE_STEP;
    if (shownQuick >= quickSessions.length && quickSrvRest > 0) loadOlderQuick();
  }
  async function loadOlderQuick() {
    if (pc.quickOlderBusy) return;
    pc.quickOlderBusy = true;
    try {
      let p = pagerFrom(pc.quickPager, pc.quickCut);
      // 一页全是已经拿到的 / 没标题被滤掉的，就接着往下要，最多几页（同 loadOlder）
      for (let i = 0; i < 6 && !p.done; i++) {
        const d = await api.get(`/api/sessions?quick=2&project=${encodeURIComponent('@quick')}&before=${p.lo}&limit=${PAGE_STEP + 10}`);
        pc.noteQuick({ quickExpires: d?.quickExpires });
        const have = new Set(pc.sessions.map((s) => s.id));
        const add = (d?.sessions || []).filter((s) => !have.has(s.id));
        const lo = Number(d?.cursor) || 0;
        p = { hi: p.hi, lo: lo && lo < p.lo ? lo : p.lo, done: !d?.more || !lo || lo >= p.lo };
        if (add.length) { older = [...older, ...add]; pc.sessions = [...pc.sessions, ...add]; break; }
      }
      pc.quickPager = p;
    } catch {} finally { pc.quickOlderBusy = false; }
  }
  const quickBlank = $derived(!session.id && !!session.projectId && pc.quickIds.has(session.projectId));
  // 只有文件、没有对话的临时对话：单独列在区尾，点开 = 在那只桶里开空白对话（工作台里看得见文件），也能存为工作空间
  const quickOrphRows = $derived(pc.quickOrph.filter((o) => pc.quickIds.has(o.id) && !quickSessions.some((s) => s.projectId === o.id)));
  const orphanBlank = $derived(quickBlank && (session.projectId === pc.chosenQuick || quickOrphRows.some((o) => o.id === session.projectId)));
  function openOrphan(id) {
    pc.closeDrawer();
    pc.chosenQuick = id;
    pc.openNew(id);
  }
  const grouped = $derived.by(() => {
    const map = new Map(pc.realProjects.map((p) => [p.id, []]));
    // 默认工作空间认 def 标记（服务端保证 projects[0] 是它，但侧栏顺序可以被拖乱）
    const defId = (pc.realProjects.find((p) => p.def) || pc.realProjects[0])?.id ?? null;
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
  // 项目对话（运行档位 › 项目）：它的讨论串有在等你的（审批卡 / 提问），项目行行尾亮一个红点——讨论串行滚出视野也看得见
  const projectWaiting = $derived.by(() => {
    const out = new Set();
    const proj = new Set(pc.sessions.filter((s) => s.shape === 'project').map((s) => s.id));
    if (proj.size) for (const s of pc.sessions) if (s.pending && s.spawnedBy && proj.has(s.spawnedBy)) out.add(s.spawnedBy);
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
      const cur = pc.curId ? list.find((s, i) => i >= n && s.id === pc.curId) : null;
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
    for (const p of pc.projects) {
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
    const pids = pc.projects.length ? new Set(pc.projects.map((p) => p.id)) : null;
    older = older.filter((s) => !isArchivedId(s.id) && (!pids || pids.has(s.projectId)));
    return mergeOlder(list, older);
  }
  // 会话被删（别的设备删的，总线 session.gone）/ 项目被删：列表与翻页拿回来的老行一起摘掉
  function dropRows(pred) {
    older = older.filter((s) => !pred(s));
    if (pc.sessions.some(pred)) pc.sessions = pc.sessions.filter((s) => !pred(s));
  }
  // 这个项目在服务端还有多少条没拿到（收藏的也算在已拿到里）；翻到底了、且与首页接得上就是 0
  const serverRest = (pid) => (pagerFrom(pager[pid], cutoff).done ? 0 : serverRestOf(pc.sessions, projCounts, pid));
  async function loadOlder(pid) {
    if (olderBusy[pid]) return;
    olderBusy[pid] = true;
    try {
      let p = pagerFrom(pager[pid], cutoff);
      // 一页全是已经拿到的（断档重翻、或整页都是没标题被滤掉的文件）就接着往下要，最多几页
      for (let i = 0; i < 6 && !p.done; i++) {
        const d = await api.get(`/api/sessions?project=${encodeURIComponent(pid)}&before=${p.lo}&limit=${PAGE_STEP + 10}`);
        const have = new Set(pc.sessions.map((s) => s.id));
        const add = (d?.sessions || []).filter((s) => s.projectId === pid && !have.has(s.id));
        const lo = Number(d?.cursor) || 0;
        p = { hi: p.hi, lo: lo && lo < p.lo ? lo : p.lo, done: !d?.more || !lo || lo >= p.lo };
        if (add.length) { older = [...older, ...add]; pc.sessions = [...pc.sessions, ...add]; break; }
      }
      pager[pid] = p;
    } catch {} finally { delete olderBusy[pid]; }
  }

  return {
    get COLL_LS() { return COLL_LS; },
    get collapsed() { return collapsed; }, set collapsed(v) { collapsed = v; },
    toggleFold,
    get isQuickSession() { return isQuickSession; },
    get listed() { return listed; },
    get starred() { return starred; },
    get shownQuick() { return shownQuick; }, set shownQuick(v) { shownQuick = v; },
    get quickSessions() { return quickSessions; },
    get quickRows() { return quickRows; },
    showMoreQuick,
    get quickBlank() { return quickBlank; },
    get quickOrphRows() { return quickOrphRows; },
    get orphanBlank() { return orphanBlank; },
    openOrphan,
    get grouped() { return grouped; },
    get childIds() { return childIds; },
    get projectWaiting() { return projectWaiting; },
    get shown() { return shown; }, set shown(v) { shown = v; },
    get paged() { return paged; },
    showMore,
    showLess,
    get projCounts() { return projCounts; }, set projCounts(v) { projCounts = v; },
    get cutoff() { return cutoff; }, set cutoff(v) { cutoff = v; },
    get older() { return older; }, set older(v) { older = v; },
    get olderBusy() { return olderBusy; }, set olderBusy(v) { olderBusy = v; },
    get pager() { return pager; }, set pager(v) { pager = v; },
    withOlder,
    dropRows,
    get serverRest() { return serverRest; },
  };
}
