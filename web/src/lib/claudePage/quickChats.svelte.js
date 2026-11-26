// Claude 页·临时对话：新建 / 存为工作空间 / 继续保留、冷启动落点、回收站。

import { api } from '../api.js';
import { uiAlert } from '../dialogs.js';
import { me, session } from '../state.svelte.js';
import { titleFor } from '../library.svelte.js';
import { applyProjectOrder } from '../claudeSplit.js';
import { t, tr } from '../i18n.js';
import { pushBackLayer } from '../nav.js';
import { cs as claudeCs } from '../claudeSettings.svelte.js';
import { daysLeft, expiryWarn, quickPolicy, landingFor } from '../quickChat.js';
import { recall, remember } from '../lastKnown.js';

/** @param {any} pc 页面上下文：各区段经它互相取用（getter / setter，见 ClaudePage.svelte） */
export function createQuickChats(pc) {
  // —— 临时对话（服务端 claude-quick.mjs，原「快照」）——
  // 每条临时对话一只一次性桶，桶伪装成项目（quick 标记）：不属于任何工作空间、不共用记忆。current = 开新临时
  // 对话时落进的那只空桶（它一用过，服务端就换一只新的）。全部临时对话在侧栏单独一区（不进项目区、不参与收藏 /
  // 分组 / 归档），最后活动超过 30 天才清理（先进回收站，再放 30 天），剩几天时侧栏角标 + 输入框上方横条提示，
  // 可「存为工作空间」或「继续保留」。天数一律按服务端给的到期时刻算（/api/sessions 的 quickExpires）。
  const quickIds = $derived(new Set(pc.projects.filter((p) => p.quick).map((p) => p.id)));
  const quickProj = $derived(pc.projects.find((p) => p.quick && p.current) || pc.projects.find((p) => p.quick) || null);
  const realProjects = $derived(applyProjectOrder(pc.projects.filter((p) => !p.quick), pc.projOrder));
  let quickExp = $state({});                    // 桶 id → 到期时刻（ms）
  // 回收规矩从上次服务端给的那份起步（lib/lastKnown）：落地页输入框上方那句「只留最近 20 条」第一帧就是对的，
  // 不先按默认写「30 天没动会自动清理」、会话列表一回来再改写
  let quickPol = $state(quickPolicy(recall('claude.quickPolicy') || null));     // { ttlDays, warnDays, trashDays }
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
    if (d.quickPolicy) { quickPol = quickPolicy(d.quickPolicy); remember('claude.quickPolicy', d.quickPolicy); }
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
    pc.closeDrawer();
    try {
      const r = await api.newQuickChat();
      const p = r && r.project;
      if (!p || !p.id) throw new Error(t('服务器没有返回新的临时对话'));
      // 旧的当前桶摘掉 current 标记、留在列表里；新桶补在末尾（[0] 仍是默认工作空间）
      pc.projects = [...pc.projects.filter((x) => x.id !== p.id).map((x) => (x.quick && x.current ? { ...x, current: false } : x)), { ...p, current: true }];
      pc.cacheProjects(pc.projects);
      pc.openNew(p.id);
      pc.refreshSessions();
    } catch (e) {
      uiAlert(t('新建临时对话失败，请重试'), { type: 'error', detail: errDetail(e) });
    } finally { quickBusy = false; }
  }
  // 「存为工作空间」（临时对话那条会话的 ⋮ / 右键、输入框上方的芯片与横条）：服务端把它所在的桶登记成普通项目
  //（id 沿用桶 id、名字取这条对话的标题），随后挪到固定位置。会话的 projectId 不变、只是它的项目摘掉了 quick
  // 标记——那条对话自然从「临时对话」区落进项目列表，正开着的也不用重开；此后不再按时间回收。
  // 存之前先弹小对话框让用户给工作空间取名（与重命名共用一个对话框，renameFor.kind = 'saveQuick'）：
  // 预填这条对话的标题，可改；清空 = 服务端按「存下的对话 N」编号。取消 = 不存。
  function saveQuick(pid, s) {
    pc.closeMenu();
    if (!pid || quickBusy) return;
    const title = s ? titleFor(s.id, s.title) : '';
    const name = title && title !== '（进行中…）' ? tr(title) : '';   // i18n-ignore 服务端给在跑的无标题会话的占位，不是界面文案
    pc.renameFor = { kind: 'saveQuick', id: pid, name: name.slice(0, 80) };
  }
  async function commitSaveQuick(pid, label) {
    if (!pid || quickBusy) return;
    quickBusy = true;
    try {
      const r = await api.saveQuickChat(pid, t('存下的对话'), label);
      const p = r && r.project;
      if (!p || !p.id) throw new Error(t('服务器未返回存好的工作空间'));
      const q = r.quick && r.quick.id ? { ...r.quick, current: true } : null;
      const rest = pc.projects.filter((x) => x.id !== p.id && (!q || x.id !== q.id)).map((x) => (q && x.quick && x.current ? { ...x, current: false } : x));
      pc.projects = [...rest, p, ...(q ? [q] : [])];   // [0] 仍是默认工作空间
      pc.cacheProjects(pc.projects);
      // 手上是一张还没发出的空白对话、落点原本是这只桶：它跟着临时对话走（落到当前空桶），不跟着被存走的那只。
      // 点名进的那只（只有文件的桶）除外：存的就是它，留在刚存好的工作空间里
      if (!session.id && session.projectId === p.id && q && p.id !== chosenQuick) session.projectId = q.id;
      if (pc.collapsed[p.id]) { delete pc.collapsed[p.id]; try { localStorage.setItem(pc.COLL_LS, JSON.stringify(pc.collapsed)); } catch {} }
      pc.refreshSessions();
    } catch (e) {
      uiAlert(t('存为工作空间失败，请重试'), { type: 'error', detail: errDetail(e) });
      pc.refreshSessions();
    } finally { quickBusy = false; }
  }
  // 「继续保留」：服务端给这只桶记一次活动，回收时钟从头算
  async function keepQuick(pid) {
    pc.closeMenu();
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
    pc.closeDrawer();
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
      if (p && p.id && !pc.projects.some((x) => x.id === p.id)) { pc.projects = [...pc.projects, p]; pc.cacheProjects(pc.projects); }
      await pc.refreshSessions();
      // 恢复的就是想接着看的那条：直接打开它最新的一段对话；没有对话、只有文件的，就在那只桶里开空白对话（工作台里看得见文件）
      if (it.sessionId) { binOpen = false; pc.pickSession({ id: it.sessionId, projectId: it.id }); }
      else { binOpen = false; pc.openOrphan(it.id); }
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

  return {
    get quickIds() { return quickIds; },
    get quickProj() { return quickProj; },
    get realProjects() { return realProjects; },
    get quickExp() { return quickExp; }, set quickExp(v) { quickExp = v; },
    get quickPol() { return quickPol; }, set quickPol(v) { quickPol = v; },
    get quickBin() { return quickBin; }, set quickBin(v) { quickBin = v; },
    get quickCount() { return quickCount; }, set quickCount(v) { quickCount = v; },
    get quickCut() { return quickCut; }, set quickCut(v) { quickCut = v; },
    get quickPager() { return quickPager; }, set quickPager(v) { quickPager = v; },
    get quickOlderBusy() { return quickOlderBusy; }, set quickOlderBusy(v) { quickOlderBusy = v; },
    get quickOrph() { return quickOrph; }, set quickOrph(v) { quickOrph = v; },
    noteQuick,
    get quickWarnDays() { return quickWarnDays; },
    get quickBusy() { return quickBusy; }, set quickBusy(v) { quickBusy = v; },
    newQuick,
    saveQuick,
    commitSaveQuick,
    keepQuick,
    get chosenQuick() { return chosenQuick; }, set chosenQuick(v) { chosenQuick = v; },
    get binOpen() { return binOpen; }, set binOpen(v) { binOpen = v; },
    get binItems() { return binItems; }, set binItems(v) { binItems = v; },
    get binLoading() { return binLoading; }, set binLoading(v) { binLoading = v; },
    get binBusy() { return binBusy; }, set binBusy(v) { binBusy = v; },
    openBin,
    restoreBin,
  };
}
