// Antigravity 工作区联动与附件动作：文件路径跳「文件」面板定位、活动时间线跳对话卡片闪烁、以及输入栏附件上传。

import { api } from '../api.js';
import { openAgyDockFiles } from '../dock.svelte.js';
import { showToast } from '../toast.svelte.js';
import { t, tr } from '../i18n.js';
import { computeWorkspaceFileTarget } from './workspace-logic.js';
import { attLook } from './attach-look.js';
import { walkEntries, groupByRoot, skipNote, pool } from '../dirDrop.js';
import { nativePathForFile } from '../nativeDesktop.js';
import { agyApi } from './api.js';
import { agyPrefs } from './settings.svelte.js';
import { askRename } from '../renamePrompt.js';
import { agy, newAgyChat, refreshAgyProjects, refreshAgySessions, refreshHiddenSessions, cacheAgyProjectOrder, bumpAgyOrderPending } from './store.svelte.js';

function sameDirPath(a = '', b = '') {
  const na = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!na || !nb) return false;
  return /^[A-Za-z]:/.test(na) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function sortProjectsLocal(list) {
  return [...list].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (ap && bp) {
      const dt = (b.pinnedAt || b.updated || b.created || 0) - (a.pinnedAt || a.updated || a.created || 0);
      if (dt !== 0) return dt;
    }
    return (b.updated || b.created || 0) - (a.updated || a.created || 0);
  });
}

export async function selectProjectForNewChat(project) {
  if (!project) return;
  newAgyChat({ projectId: project.id, cwd: project.path });
  agy.projectSheetOpen = false;
  agy.drawerOpen = false;
}

export function selectDirectoryForNewChat(dirPath) {
  const target = String(dirPath || '').trim();
  if (!target) return;
  const hitProj = agy.projects.find((p) => p.path && sameDirPath(p.path, target));
  if (hitProj) {
    selectProjectForNewChat(hitProj);
    return;
  }
  newAgyChat({ projectId: '', cwd: target });
  agy.projectSheetOpen = false;
  agy.drawerOpen = false;
}

export async function createAgyProjectAt(absPath) {
  const res = await agyApi.createProject(absPath);
  await refreshAgyProjects({ preserveDefault: true });
  if (res?.project) newAgyChat({ projectId: res.project.id, cwd: res.project.path });
  agy.pickerOpen = false;
  agy.projectSheetOpen = false;
  agy.drawerOpen = false;
  return res?.project;
}

export async function pinAgyProject({ id = '', path = '', name = '', pinned = true } = {}) {
  if (!id && !path) return false;
  const prevProjects = agy.projects;
  const prevRecent = agy.recentDirs;
  const now = Date.now();
  const hit = prevProjects.find((p) => (id && p.id === id) || (path && sameDirPath(p.path, path)));
  if (hit) {
    const nextList = sortProjectsLocal(prevProjects.map((p) => {
      if (p.id !== hit.id) return p;
      const next = { ...p, pinned: !!pinned };
      if (pinned) next.pinnedAt = now;
      else delete next.pinnedAt;
      return next;
    }));
    agy.projects = nextList;
    agyPrefs.projects = nextList;
  } else if (pinned && path) {
    const label = name || String(path).split(/[\\/]/).filter(Boolean).pop() || path;
    const optimistic = { id: 'tmp-pin-' + now, name: label, path, created: now, updated: now, pinned: true, pinnedAt: now };
    const nextList = sortProjectsLocal([optimistic, ...prevProjects]);
    agy.projects = nextList;
    agyPrefs.projects = nextList;
    agy.recentDirs = prevRecent.filter((d) => !sameDirPath(d.path, path));
  }
  try {
    const res = await agyApi.pinProject({ id: hit?.id || id, path: hit?.path || path, pinned });
    if (Array.isArray(res?.projects)) {
      agy.projects = res.projects;
      agyPrefs.projects = res.projects;
    } else {
      await refreshAgyProjects({ preserveDefault: true });
    }
    if (Array.isArray(res?.order)) {
      agy.projectOrder = res.order;
      cacheAgyProjectOrder(res.order);
    }
    if (pinned && (hit?.path || path)) {
      const target = hit?.path || path;
      agy.recentDirs = agy.recentDirs.filter((d) => !sameDirPath(d.path, target));
    }
    return true;
  } catch (err) {
    agy.projects = prevProjects;
    agyPrefs.projects = prevProjects;
    agy.recentDirs = prevRecent;
    showToast(tr(err?.body?.error || err?.message) || (pinned ? t('置顶工作空间失败') : t('取消置顶失败')), 'err');
    return false;
  }
}

export async function deleteAgyProject({ id = '', path = '', name = '' } = {}) {
  if (!id && !path) return false;
  const prevProjects = agy.projects;
  const prevRecent = agy.recentDirs;
  const hit = prevProjects.find((p) => (id && p.id === id) || (path && sameDirPath(p.path, path)));
  const targetId = hit?.id || id;
  const targetPath = hit?.path || path;
  const label = name || hit?.name || String(targetPath || '').split(/[\\/]/).filter(Boolean).pop() || '';

  const nextList = prevProjects.filter((p) => !((targetId && p.id === targetId) || (targetPath && sameDirPath(p.path, targetPath))));
  agy.projects = nextList;
  agyPrefs.projects = nextList;
  if (targetPath) {
    agy.recentDirs = prevRecent.filter((d) => !sameDirPath(d.path, targetPath));
  }
  const wasCurrentNewChat = !agy.sessionId && (
    (targetId && agy.projectId === targetId)
    || (targetPath && sameDirPath(agy.cwd, targetPath))
  );
  if (wasCurrentNewChat) {
    newAgyChat({ projectId: '', cwd: '' });
  }
  try {
    const res = await agyApi.deleteProject({ id: targetId, path: targetPath });
    if (Array.isArray(res?.projects)) {
      agy.projects = res.projects;
      agyPrefs.projects = res.projects;
    }
    if (Array.isArray(res?.order)) {
      agy.projectOrder = res.order;
      cacheAgyProjectOrder(res.order);
    }
    if (targetId && agyPrefs.settings.defaultProjectId === targetId) {
      agyPrefs.settings.defaultProjectId = '';
    }
    if (label) showToast(t('已移除工作空间「{name}」', { name: label }));
    return true;
  } catch (err) {
    agy.projects = prevProjects;
    agyPrefs.projects = prevProjects;
    agy.recentDirs = prevRecent;
    showToast(tr(err?.body?.error || err?.message) || t('移除工作空间失败'), 'err');
    return false;
  }
}

// 侧栏工作空间改显示名：只改名字、不动磁盘上的文件夹（会话按绝对路径绑定，改文件夹会断）。
// 「最近用过」和只来自历史会话的分组也能改：服务端先登记成项目再记名字。
export async function renameAgyProject({ id = '', path = '', name = '' } = {}) {
  if (!id && !path) return false;
  const hit = agy.projects.find((p) => (id && p.id === id) || (path && sameDirPath(p.path, path)));
  const targetPath = hit?.path || path;
  const folder = hit?.folderName || String(targetPath || '').split(/[\\/]/).filter(Boolean).pop() || '';
  const current = hit?.name || name || folder;
  const next = await askRename(current, {
    title: t('重命名工作空间'),
    hint: t('只改侧栏里显示的名字，磁盘上的文件夹「{folder}」不会改名。改回文件夹名即恢复默认。', { folder }),
    isDir: true,
  });
  if (next == null) return false;
  try {
    const res = await agyApi.renameProject({ id: hit?.id || id, path: targetPath, name: next });
    if (Array.isArray(res?.projects)) {
      agy.projects = res.projects;
      agyPrefs.projects = res.projects;
    } else {
      await refreshAgyProjects({ preserveDefault: true });
    }
    if (Array.isArray(res?.order)) {
      agy.projectOrder = res.order;
      cacheAgyProjectOrder(res.order);
    }
    if (targetPath) agy.recentDirs = agy.recentDirs.filter((d) => !sameDirPath(d.path, targetPath));
    return true;
  } catch (err) {
    showToast(tr(err?.body?.error || err?.message) || t('重命名工作空间失败'), 'err');
    return false;
  }
}

export async function reorderAgyProjects(nextPaths) {
  if (!Array.isArray(nextPaths) || !nextPaths.length) return false;
  const prev = agy.projectOrder;
  agy.projectOrder = nextPaths;
  cacheAgyProjectOrder(nextPaths);
  bumpAgyOrderPending(1);
  try {
    const res = await agyApi.setProjectOrder(nextPaths);
    if (Array.isArray(res?.order)) {
      agy.projectOrder = res.order;
      cacheAgyProjectOrder(res.order);
    }
    return true;
  } catch (err) {
    agy.projectOrder = prev;
    cacheAgyProjectOrder(prev);
    showToast(tr(err?.body?.error || err?.message) || t('工作空间顺序没保存上，请重试'), 'err');
    return false;
  } finally {
    bumpAgyOrderPending(-1);
  }
}

export function locateAgyFileInWorkspace(filePath, { openFile = false } = {}) {
  const target = computeWorkspaceFileTarget(filePath, agy.cwd, { openFile });
  if (!target) return false;
  agy.highlightedFileName = target.fileName || '';
  agy.highlightSeq = (agy.highlightSeq || 0) + 1;
  openAgyDockFiles({
    ws: target.ws,
    rel: target.rel,
    open: target.open,
  });
  return true;
}

export function scrollToAgyCard(entryType, targetId) {
  if (typeof document === 'undefined' || !targetId) return false;
  const attr = entryType === 'permission' ? 'data-agy-perm' : 'data-agy-tool';
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(targetId)) : String(targetId);
  const find = () => document.querySelector(`.agy-thread [${attr}="${escaped}"]`);
  const flash = (el) => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('agy-card-flash');
    void el.offsetWidth;
    el.classList.add('agy-card-flash');
    setTimeout(() => { el.classList.remove('agy-card-flash'); }, 1600);
  };
  // 工具行可能折在 StepGroup 的汇总头里（明细没挂载或 hidden）：先叫组展开，等两帧再定位
  if (entryType !== 'permission') {
    const grp = document.querySelector(`.agy-thread [data-agy-group-tools~="${escaped}"]`);
    if (grp && grp.dataset.open !== '1') {
      grp.dispatchEvent(new CustomEvent('agy-group-open'));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = find();
        if (el) flash(el);
      }));
      return true;
    }
  }
  const el = find();
  if (!el) return false;
  flash(el);
  return true;
}

export async function uploadAgyFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    showToast(t('{name}：超过 20MB 上传上限', { name: file.name }), 'err');
    return;
  }
  const media = attLook({ name: file.name, mime: file.type }).media;
  const isImg = media === 'image' || String(file.type || '').startsWith('image/');
  // 视频也留一个本地地址：上传完之前附件条靠它定格第一帧，点击亦可直接播放预览
  const isVid = media === 'video' || String(file.type || '').startsWith('video/');
  const previewUrl = isImg || isVid ? URL.createObjectURL(file) : '';
  agy.draftAtts.push({
    path: '',
    name: file.name,
    kind: isImg ? 'image' : 'file',
    url: previewUrl,
    size: file.size,
    pending: true,
  });
  // 注意 Svelte 5 深代理：必须通过数组下标取回代理对象再修改属性，不能改推入前的字面量
  const liveAtt = agy.draftAtts[agy.draftAtts.length - 1];
  try {
    const res = await api.uploadBlob(file.name, file);
    liveAtt.path = res.path;
    liveAtt.name = res.name || file.name;
    liveAtt.pending = false;
  } catch {
    if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch {} }
    agy.draftAtts = agy.draftAtts.filter((item) => item !== liveAtt);
    showToast(t('上传失败：{name}', { name: file.name }), 'err');
  }
}

// —— 文件夹附件 ——
// 拖 / 粘贴进来的文件夹在浏览器里是个读不出字节的目录 File，丢给 uploadAgyFile 必然「上传失败：<文件夹名>」。
// 服务端只把附件路径写进提示词、由 Antigravity 自己的文件工具去读，所以文件夹只要给出一个服务端看得见的路径即可：
// 服务端在本机（桌面壳拿得到原路径）→ 零拷贝引用原目录；否则整树传到 uploads/<文件夹>/ 再引用那份副本。
export function pushAgyFolder(dirPath, name) {
  if (!dirPath) return false;
  if (agy.draftAtts.some((x) => x.path && sameDirPath(x.path, dirPath))) return true;
  agy.draftAtts.push({ path: dirPath, name: name || String(dirPath).split(/[\\/]/).filter(Boolean).pop() || 'folder', kind: 'folder', url: '', pending: false });
  return true;
}

async function uploadAgyFolder(name, items, stat) {
  agy.draftAtts.push({ path: '', name, kind: 'folder', url: '', pending: true, note: '' });
  const live = agy.draftAtts[agy.draftAtts.length - 1];
  try {
    const root = await api.uploadFolderInit(name);
    // rel 带顶层文件夹名，而挂载根本身就是这个文件夹：剥掉首段，免得套两层
    await pool(items, 5, async (it) => {
      const frel = it.rel.split('/').slice(1).join('/') || it.file.name;
      await api.uploadBlob(it.file.name || 'file', it.file, { fdir: root.dirName, frel });
    });
    live.path = root.path;
    live.pending = false;
    live.note = stat ? skipNote(stat) : '';
  } catch {
    agy.draftAtts = agy.draftAtts.filter((x) => x !== live);
    showToast(t('文件夹上传失败：{name}', { name }), 'err');
  }
}

// 处理一次拖放 / 粘贴的 DataTransfer。必须在事件【同步段】调用（之后 dataTransfer 就失效了）。
// 返回 true 表示里面有文件夹、已接管（散文件也一并处理）；false 表示纯文件，调用方照旧逐个上传。
export function attachAgyTransfer(dt) {
  const items = [...(dt?.items || [])].filter((it) => it.kind === 'file');
  const entries = [];
  const dirs = [];
  const files = [];
  for (const it of items) {
    const entry = it.webkitGetAsEntry?.();
    const f = it.getAsFile?.();
    if (entry) entries.push(entry);
    if (entry?.isDirectory) dirs.push({ path: f ? nativePathForFile(f) : '', name: (f && f.name) || entry.name });
    else if (f) files.push(f);
  }
  if (!dirs.length) return false;
  if (dirs.every((d) => d.path)) {
    for (const d of dirs) pushAgyFolder(d.path, d.name);
    for (const f of files) uploadAgyFile(f);
    return true;
  }
  (async () => {
    const { items: flat, stat } = await walkEntries(entries);
    if (!flat.length) { showToast(t('文件夹是空的'), 'err'); return; }
    for (const g of groupByRoot(flat)) {
      if (g.isDir) await uploadAgyFolder(g.name, g.items, stat);
      else for (const x of g.items) uploadAgyFile(x.file);
    }
  })();
  return true;
}

export function removeAgyDraftAtt(att) {
  if (att?.url && String(att.url).startsWith('blob:')) {
    try { URL.revokeObjectURL(att.url); } catch {}
  }
  agy.draftAtts = agy.draftAtts.filter((x) => x !== att);
}

export function pushAgyDraftAtt(att) {
  if (!att || !att.path) return false;
  if (agy.draftAtts.some((x) => x.path === att.path)) return true;
  agy.draftAtts.push({
    path: att.path,
    name: att.name || String(att.path).split(/[\\/]/).pop() || 'file',
    kind: att.kind === 'image' || att.kind === 'folder' ? att.kind : 'file',
    url: att.url || '',
    pending: false,
  });
  return true;
}

export async function renameAgySession(sessionId, newTitle) {
  const clean = String(newTitle ?? '').trim();
  const res = await agyApi.renameSession(sessionId, clean);
  if (agy.sessionId === sessionId && res?.title !== undefined) {
    agy.title = res.title || agy.title;
  }
  await refreshAgySessions();
}

export async function hideAgySession(sessionId) {
  const prev = [...agy.sessions];
  agy.sessions = agy.sessions.filter((s) => s.sessionId !== sessionId);
  try {
    await agyApi.hideSession(sessionId);
    if (agy.sessionId === sessionId) newAgyChat();
    await refreshAgySessions();
  } catch (err) {
    agy.sessions = prev;
    showToast(tr(err?.body?.error || err?.message) || t('隐藏对话失败'), 'err');
  }
}

export async function hideAgyWorkspaceSessions(sessionIds, workspaceName = '') {
  const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (!ids.length) return false;
  const idSet = new Set(ids);
  const prevSessions = agy.sessions;
  const prevHiddenCount = agy.hiddenCount;
  const leavingCurrent = Boolean(agy.sessionId && idSet.has(agy.sessionId));
  agy.sessions = prevSessions.filter((s) => !idSet.has(s.sessionId));
  agy.hiddenCount = prevHiddenCount + ids.length;
  if (leavingCurrent) newAgyChat();
  try {
    await agyApi.hideSessions(ids);
    await Promise.all([refreshAgySessions(), agy.hiddenOpen ? refreshHiddenSessions() : null]);
    showToast(
      workspaceName
        ? t('已隐藏「{name}」的 {n} 条对话', { name: workspaceName, n: ids.length })
        : t('已隐藏 {n} 条对话', { n: ids.length })
    );
    return true;
  } catch (err) {
    agy.sessions = prevSessions;
    agy.hiddenCount = prevHiddenCount;
    showToast(tr(err?.body?.error || err?.message) || t('隐藏对话失败'), 'err');
    return false;
  }
}

export async function restoreAgySession(sessionId) {
  await agyApi.restoreSession(sessionId);
  await Promise.all([refreshAgySessions(), refreshHiddenSessions()]);
}

export async function restoreAllHiddenAgySessions() {
  await agyApi.restoreAllSessions();
  await Promise.all([refreshAgySessions(), refreshHiddenSessions()]);
  agy.hiddenOpen = false;
}
