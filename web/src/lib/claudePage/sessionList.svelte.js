// Claude 页·会话列表与项目列表：本地缓存先出、网络刷新殿后，账号级事件总线增量更新，总线断着时退回兜底轮询；新会话就地上榜。

import { api } from '../api.js';
import { ui, session } from '../state.svelte.js';
import { untrack } from 'svelte';
import { chat, requestSync, prefetchSessions, onBusEvent, pendingNew, dropPendingNew } from '../chat.svelte.js';
import { setSessionSource } from '../sessionFamily.svelte.js';
import { busStart, busStop, busOn, busConnected } from '../bus.js';
import { placeTouched, insertByMtime, provisionalTitle } from '../sessionsOrder.js';
import { applyServerLibrary } from '../library.svelte.js';
import { cacheSessions, getCachedSessions } from '../cache.js';
import { absorbLastPrefs } from '../chatPrefs.js';
import { IS_CSNAP } from '../csnap.js';
import { archClock, noteSessionList, noteArchiveRev, stickyArchived, dropArchivedRow, isArchivedId } from '../sessionArchive.svelte.js';
import { appTagKey } from './sessionAppTag.js';

/** @param {any} pc 页面上下文：各区段经它互相取用（getter / setter，见 ClaudePage.svelte） */
export function createSessionList(pc) {
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
  // keep-alive 后本组件常驻挂载，刷新/镜像轮询都要看「确实在 claude 页」，
  // 否则在主页/vertex 页背后也白跑网络请求。
  // 进 claude 页即拉会话列表（宽屏常驻列 + 窄屏抽屉共用）：本地缓存先出、网络刷新殿后，
  // 抽屉一拉开就有内容，不再「拉出等一下才看见列表」。每轮结束（busy→false）再刷一次
  // （状态点/新会话跟手）。untrack：refreshSessions 内读 sessions，别让它成为依赖。
  // 读 who：登录 / 换人后重拉。
  // 首拉不等 busy：冷启动直接落进一个在跑的会话（重启 / 换包 / 回前台重载）时，旧写法要等这轮跑完
  // 才拉第一次，侧栏一直停在「加载中…」、连本地缓存的项目都不出（11-08 维护者真机报）。
  $effect(() => { if (ui.screen === 'claude' && pc.who && (!session.busy || !sessionsAt)) untrack(refreshSessions); });

  // —— 多端实时同步：订阅账号级事件总线（/api/stream）——
  // 别的设备（手机 / 电脑网页 / 桌面客户端）发起一轮、跑完一轮，或任何进程写了 transcript
  //（含不经 bridge 的 CLI / 桌面 Claude Code / routines），都会即时推到这里：
  // 列表就地增量更新，正文交给 chat 层去挂直播或静态跟随。
  // 总线按身份订阅（服务端 key = 账号）：换人时随 who 断开重连。
  $effect(() => {
    if (ui.screen !== 'claude' || !pc.who) return;
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
    if (ui.screen !== 'claude' || !pc.who) return;
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
  // —— 新会话就地上榜 ——
  // /api/sessions 是按 transcript 文件扫出来的：新会话要等 CLI 把第一条写盘、再等一次整表重拉（800ms 合并 + 扫盘 +
  // 服务端 2s 列表缓存）才出现在侧栏，前后好几秒看不见它。这里在它的 id 一定下来（总线 run.start 的 fresh 帧 /
  // 本端 session 帧）就先插一行，标题用第一条消息；随后的整表刷新带回真标题与完整字段。
  // 整表刷新回来时服务端可能还没扫到它：还在保质期里的行并回去（withProv），不让它闪一下又消失。
  const provRows = new Map();   // id → 插入时刻
  const PROV_TTL = 90_000;
  let _provTimer = null;
  function addProv(row) {
    if (!row || !row.id || sessions.some((s) => s.id === row.id) || isArchivedId(row.id)) return false;
    provRows.set(row.id, Date.now());
    sessions = insertByMtime(sessions, { thinking: true, ...row, mtime: row.mtime || Date.now() });
    // 真标题 / 形态 / worktree 这些只有整表里有：稍后补拉一次（那时 transcript 多半已落盘）
    if (!_provTimer) _provTimer = setTimeout(() => { _provTimer = null; untrack(refreshSessions); }, 4000);
    return true;
  }
  function withProv(list) {
    if (!provRows.size) return list;
    const ids = new Set(list.map((s) => s.id));
    let out = list;
    for (const [id, at] of provRows) {
      // 服务端列表已经有它 / 过了保质期 / 本地已经摘掉（删除、归档）→ 不再管
      const cur = ids.has(id) || Date.now() - at > PROV_TTL ? null : sessions.find((s) => s.id === id);
      if (!cur) { provRows.delete(id); continue; }
      out = insertByMtime(out, cur);
    }
    return out;
  }
  // 本端刚发出第一条的新会话：session 帧一到（session.id 落定）就上榜，不依赖总线那一帧
  $effect.pre(() => {   // pre：和摘占位行同一帧落地，不闪
    const id = session.id;
    if (!id || !session.busy || IS_CSNAP) return;
    untrack(() => {
      if (sessions.some((s) => s.id === id)) return;
      const mine = chat.messages.filter((m) => m.role === 'user');
      if (mine.length !== 1) return;   // 只认新会话的第一轮（续聊一条不在首页里的老会话不算）
      addProv({ id, title: provisionalTitle(mine[0].text), projectId: session.projectId || null });
    });
  });
  // 占位行（新会话 id 还没回来）：按项目分到各组最上面；临时对话的进「临时对话」区
  const pendRows = $derived(pendingNew.list.map((p) => ({ ...p, title: provisionalTitle(p.text), quick: !!p.projectId && pc.quickIds.has(p.projectId) })));
  const pendQuick = $derived(pendRows.filter((p) => p.quick));
  const pendIn = (pid) => {
    if (!pendRows.length) return [];
    const ids = new Set(pc.realProjects.map((x) => x.id));
    const defId = (pc.realProjects.find((x) => x.def) || pc.realProjects[0])?.id ?? null;
    return pendRows.filter((p) => !p.quick && ((p.projectId && ids.has(p.projectId)) ? p.projectId : defId) === pid);
  };
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
      if (!patchSession(ev.sessionId, { thinking: true })) {
        // 新会话（服务端标 fresh）：当场插一行；子会话直接挂到父会话那一家下面、跟父会话同一个项目
        if (ev.fresh && ev.sessionId) {
          const parent = ev.parentId ? sessions.find((s) => s.id === ev.parentId) : null;
          const row = {
            id: ev.sessionId, title: provisionalTitle(ev.userText), mtime: Number(ev.startedAt) || 0,
            projectId: ev.projectId || parent?.projectId || null,
            ...(ev.parentId ? { parentId: parent?.parentId || ev.parentId, spawnedBy: ev.parentId } : {}),
          };
          // 本端发出、id 还没回来时画的占位行（lib/chat.svelte.js pendingNew）：按正文认领，换成这条真行。
          // 正看着的那条不在这里换：它自己的 session 帧紧跟着就到（内核摘占位 + 上面的 effect 插真行，同一帧落地、
          // 当前行高亮不断）；总线抢先几毫秒就换的话，会闪一下「没有当前行」。过一会儿还没等到（直播流丢了）再兜底换。
          const sent = String(ev.userText || '').trim();
          const pend = pendingNew.list.find((p) => p.text.trim() === sent);
          if (pend && pend.key === pendingNew.mine) {
            setTimeout(() => { if (pendingNew.list.some((p) => p.key === pend.key)) { dropPendingNew(pend.key); addProv(row); } }, 1500);
          } else {
            if (pend) dropPendingNew(pend.key);
            addProv(row);
          }
        }
        refreshSoon();
      }
    } else if (ev.type === 'run.end') {
      patchSession(ev.sessionId, { thinking: false, pending: !!ev.pending });   // pending：同会话还扣着跨会话消息等你确认（服务端 pendingFor）
    } else if (ev.type === 'question') {
      patchSession(ev.sessionId, { pending: !!ev.pending });
    } else if (ev.type === 'session.touch') {
      // 手动归档的会话在 Desktop / CLI 里接着聊：它不会回到列表，不为它每轮整表重拉
      if (!bumpToTop(ev.sessionId, ev.mtime) && !stickyArchived(ev.sessionId)) refreshSoon();
    } else if (ev.type === 'family' && ev.child) {
      if (ev.title && provRows.has(ev.child)) patchSession(ev.child, { title: ev.title });   // 刚插的那一行换成派生时起的标题
      refreshSoon();   // 某个会话刚派生了子会话：侧栏重拉，让它挂到父会话下面
    } else if (ev.type === 'archive' || ev.type === 'quick.pruned') {
      // quick.pruned：临时对话按设置回收了一轮（有的进了回收站，或清理方式刚改过）——重拉列表与回收策略
      refreshSoon();   // 归档 / 取消归档（本机、别的设备或自动归档）：整表重拉——归档的让出名额，取消归档的回到列表
    } else if (ev.type === 'session.gone' && ev.sessionId) {
      // 别处删了一条会话：整表刷新只管最新 60 条，翻页拿回来的老行、已归档列表里的这一行得就地摘掉
      pc.dropRows((s) => s.id === ev.sessionId); dropArchivedRow(ev.sessionId);
    }
    onBusEvent(ev);   // 正文侧：挂直播 / 静态跟随
  }
  $effect(() => () => { if (_syncPending) { clearTimeout(_syncPending); _syncPending = null; } if (_provTimer) { clearTimeout(_provTimer); _provTimer = null; } });

  // 列表等值跳过：内容没变就不赋值——反复开抽屉/轮询刷新不再每次重建列表 DOM。
  const sameSessions = (a, b) => a.length === b.length && a.every((x, i) => {
    const y = b[i];
    return x.id === y.id && x.title === y.title && !!x.thinking === !!y.thinking && !!x.pending === !!y.pending && (x.projectId || null) === (y.projectId || null) && (x.parentId || null) === (y.parentId || null) && (x.shape || null) === (y.shape || null) && appTagKey(x) === appTagKey(y);
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
      const d = await api.sessions(pc.older.slice(0, 150).map((s) => s.id)); const list = d.sessions || [];   // keep 走 URL：控制在 ~6KB
      // 翻页拿回来的老行对账：别处删了 / 归档了（含跟随 Desktop）的服务端回在 gone 里，摘掉，不留幽灵行
      if (Array.isArray(d.gone) && d.gone.length) { const g = new Set(d.gone); pc.older = pc.older.filter((s) => !g.has(s.id)); }
      noteSessionList(d, since); if (d.projectCounts) pc.projCounts = d.projectCounts;   // 已归档总数 / 各项目活跃会话总数（组内翻页用）
      pc.noteQuick(d);   // 临时对话的到期时刻 / 回收策略 / 回收站计数
      pc.cutoff = Number(d.cutoff) || 0;
      applySessions(withProv(pc.withOlder(list))); cacheSessions(list); prefetchSessions(list); if (d.prefsLast) absorbLastPrefs(d.prefsLast); if (d.library) applyServerLibrary(d.library);   // 跨设备：别的设备最近的选择也能当本机新对话默认
      sessionsAt = Date.now();
    }
    catch { if (!sessions.length) sessions = (await getCachedSessions()) || []; }   // 离线 → 读本地缓存的会话列表
    // 项目列表单独拉、单独兜底——项目接口失败不拖累会话列表本身。
    try {
      const pd = await api.claudeProjects(); const plist = pd.projects || []; if (!sameProjects(projects, plist)) projects = plist; cacheProjects(plist);
      if (Array.isArray(pd.order) && !orderPending && pd.order.join() !== projOrder.join()) { projOrder = pd.order; cacheOrder(pd.order); }
    } catch {}
  }

  return {
    get sessions() { return sessions; }, set sessions(v) { sessions = v; },
    get projects() { return projects; }, set projects(v) { projects = v; },
    get cacheProjects() { return cacheProjects; },
    get projOrder() { return projOrder; }, set projOrder(v) { projOrder = v; },
    get cacheOrder() { return cacheOrder; },
    get orderPending() { return orderPending; }, set orderPending(v) { orderPending = v; },
    refreshSoon,
    get provRows() { return provRows; },
    get pendQuick() { return pendQuick; },
    get pendIn() { return pendIn; },
    get sessionsAt() { return sessionsAt; }, set sessionsAt(v) { sessionsAt = v; },
    refreshSessions,
  };
}
