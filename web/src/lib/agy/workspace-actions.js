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
import { agy, newAgyChat, refreshAgyProjects, refreshAgySessions, refreshHiddenSessions } from './store.svelte.js';

export async function selectProjectForNewChat(project) {
  if (!project) return;
  newAgyChat({ projectId: project.id, cwd: project.path });
  agy.projectSheetOpen = false;
  agy.drawerOpen = false;
}

export function selectDirectoryForNewChat(dirPath) {
  const target = String(dirPath || '').trim();
  if (!target) return;
  const hitProj = agy.projects.find((p) => p.path && p.path.toLowerCase() === target.toLowerCase());
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
  await refreshAgyProjects();
  if (res?.project) newAgyChat({ projectId: res.project.id, cwd: res.project.path });
  agy.pickerOpen = false;
  agy.projectSheetOpen = false;
  agy.drawerOpen = false;
  return res?.project;
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
  if (agy.draftAtts.some((x) => x.path === dirPath)) return true;
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

export async function restoreAgySession(sessionId) {
  await agyApi.restoreSession(sessionId);
  await Promise.all([refreshAgySessions(), refreshHiddenSessions()]);
}

export async function restoreAllHiddenAgySessions() {
  await agyApi.restoreAllSessions();
  await Promise.all([refreshAgySessions(), refreshHiddenSessions()]);
  agy.hiddenOpen = false;
}
