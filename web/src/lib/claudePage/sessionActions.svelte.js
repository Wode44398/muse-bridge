// Claude 页·会话与项目的操作：归档 / 取消归档、搜索、行尾 ⋮ 菜单、收藏、重命名、删除。

import { api } from '../api.js';
import { uiAlert, uiConfirm } from '../dialogs.js';
import { ui, session } from '../state.svelte.js';
import { untrack } from 'svelte';
import { newConversation } from '../chat.svelte.js';
import { isStarred, toggleStar, titleFor, renameSession, forgetSession } from '../library.svelte.js';
import { cacheSessions, removeCachedMessages } from '../cache.js';
import { pointer } from '../layout.svelte.js';
import { IS_CSNAP } from '../csnap.js';
import { t, tr } from '../i18n.js';
import { arch, setArchivedIds, archiveProject, closeArchivedView, dropArchivedRow, markArchivedSeen } from '../sessionArchive.svelte.js';
import { pushBackLayer } from '../nav.js';
import { descendantsOf } from '../sessionArchiveView.js';
import { reportUi } from '../uiReport.js';
import { runPluginUi } from '../pluginUi.svelte.js';   // 插件的会话动作（ctx.ui.sessionAction）
import { isNewChatKey } from '../quickChat.js';

/** @param {any} pc 页面上下文：各区段经它互相取用（getter / setter，见 ClaudePage.svelte） */
export function createSessionActions(pc) {
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
    const kids = descendantsOf(pc.sessions, s.id).filter((k) => !arch.hidden[k.id]);
    if (kids.length) { archAsk = { id: s.id, title: titleFor(s.id, s.title) || '', kids: kids.map((k) => k.id), working: kids.filter((k) => k.thinking || k.pending).length }; return; }
    runArchive([s.id]);
  }
  async function runArchive(ids, opts) {
    archAsk = null;
    pc.older = pc.older.filter((s) => !ids.includes(s.id));
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
      pc.dropRows((s) => s.projectId === p.id && !isStarred(s.id) && !s.thinking && !s.pending); delete pc.pager[p.id];
      if (!r.count && r.skipped.length) uiAlert(t('正在工作的会话不能归档'));
    } catch (e) { libFail(t('归档失败，请重试'))(e); }
  }
  async function doUnarchive(id) {
    closeMenu();
    try { await setArchivedIds([id], false); } catch (e) { libFail(t('无法取消归档，请重试'))(e); }
  }
  // 已归档视图里点一条 = 打开它看（输入框上方有「此会话已归档」横条）
  function openArchived(s) { markArchivedSeen(s.id); pc.pickSession(s); }
  const projName = (id) => tr(pc.projects.find((p) => p.id === id)?.name || '');
  // 已归档视图看得见时（常驻侧栏，或窄屏抽屉拉开着）：系统返回先回到会话列表；抽屉收着时不拦
  $effect(() => { if (arch.view && (pc.pinned || ui.drawerOpen)) return pushBackLayer(closeArchivedView); });

  // 开着的会话报给服务端（视图上报 /api/ui/state 的 claudeOpen）：自动归档跳过有人正开着的会话（官方 on_screen）
  $effect(() => {
    if (!pc.who || IS_CSNAP) return;
    const open = ui.screen === 'claude' ? [session.id, pc.splitOn ? pc.paneId : null].filter(Boolean) : [];
    untrack(() => reportUi({ claudeOpen: open }));
  });

  // —— 搜索会话（Ctrl+K / 侧栏「搜索」）：宽屏是居中面板，手机是全屏页（claude/SessionSearch.svelte）——
  let searchOpen = $state(false);
  function openSearch() { searchOpen = true; }
  function openHit(h) {
    searchOpen = false;
    if (h.archived) markArchivedSeen(h.sessionId);
    pc.pickSession({ id: h.sessionId, projectId: h.projectId });
  }
  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
  function onSearchKey(e) {
    // defaultPrevented：工作台里的编辑器（md 编辑器 Ctrl+K 插链接）已经接住了，不抢
    if (e.defaultPrevented || ui.screen !== 'claude' || ui.settingsOpen || IS_CSNAP || !pc.who) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      searchOpen = !searchOpen;
      return;
    }
    // 新对话（官方同款）：网页 Ctrl/⌘+Shift+O；桌面壳另认 Ctrl/⌘+N（lib/quickChat.js 的 isNewChatKey）
    if (isNewChatKey(e, { desktop: pc.IS_DESKTOP_SHELL })) {
      e.preventDefault();
      searchOpen = false;
      pc.newChat();
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
  const menuProject = () => pc.projects.find((x) => x.id === (menuFor && menuFor.id)) || null;
  const menuStyle = $derived(menuFor
    ? (menuPos.top != null ? `top:${menuPos.top}px;` : `bottom:${menuPos.bottom}px;`) + `right:${menuPos.right}px;`
    : '');
  const menuSession = () => pc.sessions.find((x) => x.id === (menuFor && menuFor.id)) || null;

  // 收藏 / 改名存服务端（跨设备）：乐观上屏，失败由 library 退回原状，这里只提示。
  const libFail = (msg) => (e) => {
    const detail = typeof e?.body === 'string' ? e.body : (e?.body?.error || e?.message || '');
    uiAlert(msg, { type: 'error', detail: tr(detail) });
  };
  function doStar(id) { toggleStar(id).catch(libFail(t('收藏失败，请重试'))); closeMenu(); }
  // 会话菜单里插件的动作（ctx.ui.sessionAction）
  function runSessionAction(pa, s) {
    closeMenu();
    if (!s) return;
    runPluginUi(pa, 'sessionAction', { sessionId: s.id, title: titleFor(s.id, s.title) || '' });
  }
  // 重命名：应用内小对话框。原来用 window.prompt——Electron 压根不实现 prompt()，
  // 桌面壳里点「重命名」毫无反应；网页端也是浏览器原生弹窗，一并换掉。
  // 同一个对话框也给项目（工作空间）改名用：renameFor.kind 区分。
  let renameFor = $state(null);   // { kind: 'session'|'project', id, name }
  function doRename(s) { closeMenu(); if (s) renameFor = { kind: 'session', id: s.id, name: titleFor(s.id, s.title) || '' }; }
  function doRenameProject(p) { closeMenu(); if (p) renameFor = { kind: 'project', id: p.id, name: p.name || '' }; }
  function commitRename() {
    const r = renameFor; renameFor = null;
    if (!r) return;
    if (r.kind === 'saveQuick') pc.commitSaveQuick(r.id, r.name.trim());
    else if (r.kind === 'project') commitProjectRename(r.id, r.name.trim());
    else renameSession(r.id, r.name.trim()).catch(libFail(t('重命名失败，请重试')));
  }
  // 工作空间改名：只改显示名（服务端存 label），目录与会话都不动；留空 = 恢复成文件夹名。乐观上屏，失败退回。
  async function commitProjectRename(id, name) {
    const prev = pc.projects;
    const cur = prev.find((p) => p.id === id);
    if (!cur || cur.quick || name === cur.name) return;
    if (name) { pc.projects = prev.map((p) => (p.id === id ? { ...p, name } : p)); pc.cacheProjects(pc.projects); }
    try {
      const r = await api.renameClaudeProject(id, name);
      if (r && r.project) { pc.projects = pc.projects.map((p) => (p.id === id ? { ...p, name: r.project.name } : p)); pc.cacheProjects(pc.projects); }
    } catch (e) {
      pc.projects = prev; pc.cacheProjects(prev);
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
    const prev = pc.sessions;
    const wasQuick = pc.isQuickSession(prev.find((x) => x.id === id));
    pc.sessions = pc.sessions.filter((x) => x.id !== id);
    try {
      const r = await api.deleteSession(id);
      if (r && r.ok === false) throw new Error(t('服务器未删除该会话'));
      await Promise.all([cacheSessions(pc.sessions), removeCachedMessages(id)]);
      forgetSession(id);   // 服务端删除接口已顺手清掉它的收藏/改名，本地同步摘掉
      dropArchivedRow(id); pc.older = pc.older.filter((x) => x.id !== id);   // 已归档列表 / 翻页拿回来的老会话同步摘掉（服务端归档记录也清了）
      // 删掉的是正开着的临时对话 → 落到当前那只空桶开一张空白的临时对话
      if (session.id === id) newConversation(wasQuick && pc.quickProj ? pc.quickProj.id : undefined);
      if (pc.splitOn && pc.paneId === id) pc.closePane();   // 分屏那一格正开着它：那一格也收掉
    } catch (e) {
      pc.sessions = prev;
      const detail = typeof e?.body === 'string' ? e.body : (e?.body?.error || e?.body?.message || e?.message || '');
      uiAlert(t('删除失败，请重试'), { type: 'error', detail: tr(detail) });
    }
  }

  // 项目名默认 = 文件夹名（服务端派生），可在 ⋮ 里改名（见 commitProjectRename）。
  // 删项目 = 不再列出该目录的会话（transcript 留在磁盘不删）；默认工作空间项目不可删（服务端也拦）。
  async function doDeleteProject(id) {
    closeMenu();
    const prev = pc.projects;
    pc.projects = pc.projects.filter((p) => p.id !== id);
    pc.cacheProjects(pc.projects);
    try { const r = await api.deleteClaudeProject(id); if (r && r.ok === false) throw 0; }
    catch { pc.projects = prev; pc.cacheProjects(prev); return; }
    pc.dropRows((s) => s.projectId === id); delete pc.pager[id];   // 翻页拿回来的老会话别被兜进默认工作空间组
    pc.refreshSessions();   // 拿回服务端真值（该项目目录的会话不再出现）
  }

  return {
    get archAsk() { return archAsk; }, set archAsk(v) { archAsk = v; },
    get focusBtn() { return focusBtn; },
    doArchive,
    runArchive,
    doArchiveProject,
    doUnarchive,
    openArchived,
    get projName() { return projName; },
    get searchOpen() { return searchOpen; }, set searchOpen(v) { searchOpen = v; },
    openSearch,
    openHit,
    get IS_MAC() { return IS_MAC; },
    onSearchKey,
    get menuFor() { return menuFor; }, set menuFor(v) { menuFor = v; },
    get delConfirm() { return delConfirm; }, set delConfirm(v) { delConfirm = v; },
    openMenu,
    closeMenu,
    rowCtx,
    get menuProject() { return menuProject; },
    get menuStyle() { return menuStyle; },
    get menuSession() { return menuSession; },
    doStar,
    runSessionAction,
    get renameFor() { return renameFor; }, set renameFor(v) { renameFor = v; },
    doRename,
    doRenameProject,
    commitRename,
    get renameKey() { return renameKey; },
    get renameFocus() { return renameFocus; },
    doDelete,
    doDeleteProject,
  };
}
