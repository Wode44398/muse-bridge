// 工作空间 · 桌面版（FilesDesktop）的文件操作：删除 / 重命名 / 新建 / 剪贴板与粘贴 / 拖放搬运 / 解压 / 压缩 / 导入与上传 / 位置增删 / 简介 / 分享链接 / 发送给 AI 的素材。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { uiConfirm } from '../../../lib/dialogs.js';
import { api, authHeaders } from '../../../lib/api.js';
import { apiUrl } from '../../../lib/server.js';
import { sendFile } from '../../../lib/uploads.svelte.js';
import { cloudFileUrl } from '../../../lib/preview.svelte.js';
import { compressDefaultName, formatShareExpiry, loadCompressFormats, runCompress, untitledMdName } from '../../../lib/files-business.js';
import { hasNativeCompressWizard, hasNativeFileClipboard, nativeClipboardClearOwn, nativeClipboardPasteWorkspace, nativeClipboardWriteFiles, nativeCompressWizard, nativeWorkspaceAddLocation, nativeWorkspaceImportDirectory, nativeWorkspaceImportFiles, nativeWorkspaceInspect, nativeWorkspaceRemoveLocation } from '../../../lib/nativeDesktop.js';
import { pcLocalMaterial, pcLocalText } from '../../../lib/pcLocal.js';
import { isEn, t, tr } from '../../../lib/i18n.js';
import { fmtSize, kindOf, mintShareLink, newShareDialog } from '../../../lib/files/common.js';
import { baseName, foldAbs, joinPath } from './fdLook.js';

export function createFdOps(P) {
  // —— 文件操作 ——
  async function doTrash() {
    const list = [...P.selected];
    if (!list.length) return;
    // 原生通道走系统回收站（可撤销），云端通道是真删——所以措辞与确认都不一样。
    // 英文按 GLOSSARY §1.6 让确认钮复述动词（Delete）；中文不传 okLabel，仍是原来的「确定」
    if (!P.nativeFs) {
      const ret = document.activeElement;
      const ok = await uiConfirm(t('删除选中的 {n} 项？', { n: list.length }), { detail: t('云端工作空间的删除不可撤销。'), okLabel: isEn() ? t('删除') : undefined, danger: true });
      P.refocusAfterDialog(ret);
      if (!ok) return;
    }
    P.busyLabel = P.nativeFs ? t('移到回收站…') : t('删除中…');
    let fail = 0;
    for (const rel of list) { try { await P.fsRemove(rel); } catch { fail++; } }
    P.busyLabel = '';
    P.sizesTouched(list);
    P.selected = new Set(); P.anchorRel = '';
    P.toast(fail ? t('{n} 项删除失败', { n: fail }) : (P.nativeFs ? t('已把 {n} 项移到回收站', { n: list.length }) : t('已删除 {n} 项', { n: list.length })));
    await P.refresh();
    // 删掉的行连同焦点一起没了：焦点留在列表上，方向键 / 快捷键接着能用（内嵌态靠焦点判作用域）
    if (!document.activeElement || document.activeElement === document.body) try { P.rowsEl?.focus({ preventScroll: true }); } catch {}
  }
  function startRename(it) {
    P.selected = new Set([it.rel]); P.anchorRel = it.rel;
    P.renaming = { rel: it.rel, value: it.name };
  }
  async function commitRename() {
    const r = P.renaming; P.renaming = null;
    if (!r) return;
    const name = r.value.trim();
    const oldName = r.rel.split('/').pop();
    if (!name || name === oldName) return;
    try {
      await P.fsRename(r.rel, name);
      const parent = P.parentOf(r.rel);
      const newRel = (parent ? parent + '/' : '') + name;
      P.selected = new Set([newRel]); P.anchorRel = newRel;
      await P.refresh();
    } catch (e) { P.toast(t('重命名失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function newFolder() {
    if (!P.inBrowse) return;
    const names = new Set(P.items.map((x) => x.name));
    // 新文件夹的默认名跟界面语言走（英文 Windows 同款「New folder (2)」）
    let name = t('新建文件夹'), i = 2;
    while (names.has(name)) name = t('新建文件夹 {n}', { n: i++ });
    try {
      await P.fsMkdir(P.path, name);
      await P.load(P.path);
      const rel = (P.path ? P.path + '/' : '') + name;
      P.focusRel(rel);
      P.renaming = { rel, value: name };
    } catch (e) { P.toast(t('新建失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // 新建 Markdown：同资源管理器「新建文本文档」——先按默认名（未命名.md）建好，再原地进入重命名
  //（只选中主文件名，回车即定；不改名直接回车也行）。
  async function newMarkdown() {
    if (!P.inBrowse) return;
    const name = untitledMdName(P.items.map((x) => x.name));
    try {
      await P.fsNewFile(P.path, name);
      await P.load(P.path);
      const rel = (P.path ? P.path + '/' : '') + name;
      P.focusRel(rel);
      P.renaming = { rel, value: name };
    } catch (e) { P.toast(t('新建失败：{reason}', { reason: tr(e.body?.error || e.body || e.message || '') })); }
  }
  // 剪贴板两层：面板内部记一份 rel 清单（同位置粘贴直接按 rel 复制/移动，快且保留剪切语义），
  // 同时把真实文件写进 Windows 剪贴板（CF_HDROP）——资源管理器/微信/Word 里 Ctrl+V 都能粘。
  // 云端作用域同样可写：壳与 bridge 服务端在同一台机器，工作空间根 + rel 就是本机路径（与拖出同口径）。
  const canSysClipboard = $derived(hasNativeFileClipboard() && (P.nativeFs || P.wsRootLocal));
  let clipSeq = 0;
  function setClipboard(mode2) {
    if (!P.selected.size) return;
    const rels = [...P.selected], id = ++clipSeq, cut = mode2 === 'cut', n = rels.length;
    P.clipboard = { mode: mode2, locationId: P.locationId, rels, id, sys: false };
    P.toast(cut ? t('已剪切 {n} 项', { n }) : t('已复制 {n} 项', { n }));
    if (!canSysClipboard) return;
    const payload = P.nativeFs ? { rels, locationId: P.locationId, cut } : { root: P.wsRoot, rels, cut };
    const fail = (msg) => {
      if (P.clipboard?.id !== id) return;
      const reason = msg ? tr(msg) : t('未知错误');
      P.toast(cut ? t('已剪切 {n} 项，但没能写进系统剪贴板：{reason}', { n, reason }) : t('已复制 {n} 项，但没能写进系统剪贴板：{reason}', { n, reason }));
    };
    nativeClipboardWriteFiles(payload).then((r) => {
      if (r?.ok) { if (P.clipboard?.id === id) P.clipboard.sys = true; }
      else if (!r?.superseded) fail(r?.error);
    }).catch((e) => fail(e?.message));
  }
  // 「已移动 / 已复制 n 项（，f 项失败）」——粘贴与拖放共用；英文语序不同，整句一个键
  const doneMsg = (moved, n, f = 0) => (f
    ? (moved ? t('已移动 {n} 项，{f} 项失败', { n, f }) : t('已复制 {n} 项，{f} 项失败', { n, f }))
    : (moved ? t('已移动 {n} 项', { n }) : t('已复制 {n} 项', { n })));
  async function doPaste() {
    if (!P.inBrowse) return;
    // 先看系统剪贴板：资源管理器里复制/剪切的文件、别的面板或别的位置复制的文件都从这里进来。
    // 剪贴板仍是本面板刚写的那份、且内部清单能直接处理（同位置）时，主进程只回报 ours，交给下面。
    if (P.nativeFs && hasNativeFileClipboard()) {
      P.busyLabel = t('粘贴中…');
      let r;
      try { r = await nativeClipboardPasteWorkspace({ rel: P.path, locationId: P.locationId, skipOurs: P.canPaste }); }
      catch (e) { r = { handled: false, reason: 'error', error: e?.message }; }
      P.busyLabel = '';
      if (r?.handled) {
        if (r.cut) P.clipboard = null;
        const n = r.items?.length || 0;
        P.toast(n ? doneMsg(r.cut, n, r.errors?.length || 0) : (r.errors?.[0] ? tr(r.errors[0]) : t('粘贴失败')));
        await P.refresh();
        return;
      }
      if (r?.reason === 'empty') {
        // 内部清单同步进过系统剪贴板、如今那里已经没有文件：被别处的复制顶掉了，或剪切已在资源管理器里粘走。
        if (P.clipboard?.sys) P.clipboard = null;
        if (!P.canPaste) { P.toast(t('剪贴板里没有文件')); return; }
      }
    }
    if (!P.canPaste) return;
    const { mode: m, rels } = P.clipboard;
    P.busyLabel = m === 'cut' ? t('移动中…') : t('复制中…');
    let ok = 0, err = '';
    for (const rel of rels) {
      if (m === 'cut' && P.parentOf(rel) === P.path) { ok++; continue; }   // 原地剪切=无操作
      if (P.path === rel || P.path.startsWith(rel + '/')) { err = t('不能把文件夹放进它自身'); continue; }
      try { await (m === 'cut' ? P.fsMove : P.fsCopy)(rel, P.path); ok++; }
      catch (e) { err = e.body?.error || e.message || err; }
    }
    P.busyLabel = '';
    if (m === 'cut') {
      const wasSys = P.clipboard?.sys;
      P.clipboard = null;
      if (wasSys) nativeClipboardClearOwn().catch(() => {});   // 源文件已搬走，别让资源管理器再粘一次
    }
    P.sizesTouched(m === 'cut' ? rels : [], [P.path]);
    P.toast(ok ? doneMsg(m === 'cut', ok) : (err ? tr(err) : t('操作失败')));
    await P.refresh();
  }
  async function doTransferInto(destRel, rels, copy) {
    const list = rels.filter((rel) => copy || P.parentOf(rel) !== destRel);
    if (!list.length) return;
    P.busyLabel = copy ? t('复制中…') : t('移动中…');
    let ok = 0, err = '';
    for (const rel of list) {
      if (destRel === rel || destRel.startsWith(rel + '/')) { err = t('不能把文件夹放进它自身'); continue; }
      try { await (copy ? P.fsCopy : P.fsMove)(rel, destRel); ok++; }
      catch (e) { err = e.body?.error || e.message || err; }
    }
    P.busyLabel = '';
    P.sizesTouched(copy ? [] : list, [destRel]);
    P.toast(ok ? doneMsg(!copy, ok) : (err ? tr(err) : t('操作失败')));
    await P.refresh();
  }

  let extracting = false;
  async function doExtract(it) {
    if (extracting) return;
    extracting = true;
    P.toast(t('解压中…'));
    try { const r = await api.extractFile(it.rel, P.srvRoot); P.toast(t('已解压到「{name}」', { name: r.name })); await P.refresh(); }
    catch (e) { P.toast(t('解压失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); }
    finally { extracting = false; }
  }

  // —— 压缩 ——
  // 桌面壳（Windows）：直接弹系统自带的「创建存档」向导（资源管理器 压缩为 → 其他选项 同一个窗口），
  // 格式/方法/级别都在那里选，压缩进度也是系统的。壳与 bridge 服务端同机，云端作用域的根就是本机路径。
  // 其余情形（浏览器里的电脑版、旧壳）：内置选项对话框 → bridge 服务端压缩（/api/files/compress）。
  const wizardOk = $derived(hasNativeCompressWizard() && (P.nativeFs || P.wsRootLocal));
  const canCompress = $derived(wizardOk || P.serverOps);
  let wizardOpen = false;
  async function doCompress() {
    const rels = [...P.selected];
    if (!rels.length) return;
    if (wizardOk) {
      if (wizardOpen) { P.toast(t('系统压缩窗口已经开着')); return; }
      wizardOpen = true;
      P.toast(t('正在打开系统压缩窗口…'));
      let r;
      try { r = await nativeCompressWizard(P.nativeFs ? { rels, locationId: P.locationId } : { root: P.wsRoot, rels }); }
      catch (e) { r = { ok: false, error: e?.message }; }
      finally { wizardOpen = false; }
      if (r?.busy) { P.toast(t('系统压缩窗口已经开着')); return; }
      if (r?.ok) {
        if (!r.archive) return;   // 用户点了取消
        const name = baseName(r.archive);
        P.toast(t('已压缩为「{name}」', { name }));
        await P.refresh();
        // 存档落在当前目录（默认如此）就选中它；用户在向导里另选了位置则只提示
        if (P.curAbs && foldAbs(joinPath(P.curAbs, name)) === foldAbs(r.archive) && P.inBrowse) P.focusRel((P.path ? P.path + '/' : '') + name);
        return;
      }
      // 向导起不来（系统太旧没有这个窗口等）：有服务端通道就退回内置选项
      if (!P.serverOps) { P.toast(t('压缩失败：{reason}', { reason: tr(r?.error || '') })); return; }
    }
    if (!P.serverOps) return;
    const picked = rels.map((rel) => P.items.find((x) => x.rel === rel) || P.searchItems.find((x) => x.rel === rel) || { name: rel.split('/').pop(), isDir: false });
    const dirName = P.segs.length ? P.segs[P.segs.length - 1] : P.rootLabel;
    P.zipDlg = {
      rels, sub: rels.length === 1 ? picked[0].name : t('{n} 项', { n: rels.length }),
      name: compressDefaultName(picked, dirName), format: 'zip', level: 'normal',
      formats: ['zip', '7z', 'tar.gz'], busy: false, note: '',
    };
    loadCompressFormats(api).then((formats) => { if (P.zipDlg) P.zipDlg.formats = formats; });
  }
  async function runZipDlg() {
    const d = P.zipDlg;
    if (!d || d.busy || !d.name.trim()) return;
    d.busy = true; d.note = t('正在压缩…');
    const dir = P.path;
    try {
      const r = await runCompress(api, d.rels, { format: d.format, level: d.level, name: d.name.trim() }, P.srvRoot, {
        onTick: (st) => { if (P.zipDlg === d) d.note = st.bytes ? t('正在压缩… 已写入 {size}', { size: fmtSize(st.bytes) }) : t('正在压缩…'); },
      });
      if (P.zipDlg === d) P.zipDlg = null;
      P.toast(t('已压缩为「{name}」', { name: r.name }));
      await P.refresh();
      if (P.path === dir && P.inBrowse) P.focusRel((dir ? dir + '/' : '') + r.name);
    } catch (e) {
      if (P.zipDlg === d) { d.busy = false; d.note = ''; }
      P.toast(t('压缩失败：{reason}', { reason: tr(e.body?.error || e.message || '') }));
    }
  }

  async function importFiles(directory = false) {
    P.addOpen = false;
    if (!P.inBrowse) return;
    // 云端通道没有「系统文件对话框直接导入」这条路，改成浏览器选文件 → 分块上传。
    if (!P.nativeFs) { (directory ? dirUploadInput : fileUploadInput)?.click(); return; }
    try {
      const r = await (directory ? nativeWorkspaceImportDirectory(P.path, P.locationId) : nativeWorkspaceImportFiles(P.path, P.locationId));
      if (!r?.canceled) { P.toast(t('已导入 {n} 项', { n: r.items?.length || 0 })); await P.load(P.path, { keepSel: true }); }
    } catch (e) { P.toast(t('导入失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // —— 云端上传（与手机版工作空间同一个上传引擎 lib/uploads.svelte.js：分块并行、卡住/断线自动重发）——
  // webkitRelativePath 存在＝选的是整个文件夹，按相对路径原样铺进目标目录（mk=1 让服务端建子目录）。
  let fileUploadInput = $state(), dirUploadInput = $state();
  async function onUploadPick(e) {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    await uploadFiles(list, P.path);
  }
  async function uploadFiles(list, destDir) {
    if (!list.length) return;
    let ok = 0;
    for (const f of list) {
      const rel = (f.webkitRelativePath || '').split('/').slice(0, -1).join('/');
      const dir = [destDir, rel].filter(Boolean).join('/');
      P.busyLabel = t('上传 {name}…', { name: f.name });
      try {
        await sendFile(f, {
          dir, ws: P.wsRoot, mk: !!rel,
          onProgress: (sent, total) => { P.busyLabel = t('上传 {name}…', { name: f.name }) + (total > 0 ? ' ' + Math.floor((sent / total) * 100) + '%' : ''); },
        });
        ok++;
      } catch (err) {
        const m = typeof err.body === 'string' ? err.body : err.body?.error;
        P.toast(t('上传失败：{reason}', { reason: m ? tr(m) : f.name }));
      }
    }
    P.busyLabel = '';
    P.sizesTouched([], [destDir]);
    if (ok) P.toast(t('已上传 {n} 项', { n: ok }));
    await P.refresh();
  }
  async function addLocation() {
    P.addOpen = false;
    try {
      const r = await nativeWorkspaceAddLocation();
      await P.refreshLocations();
      if (!r?.canceled && r?.location?.id) P.selectLocation(r.location.id);
    } catch (e) { P.toast(t('添加位置失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function removeLocation(loc) {
    if (!loc?.removable) return;
    if (!(await uiConfirm(t('从 The Bridge 移除「{name}」？', { name: tr(loc.name) }), { detail: t('不会删除电脑上的文件。'), okLabel: isEn() ? t('移除') : undefined }))) return;
    try {
      await nativeWorkspaceRemoveLocation(loc.id);
      if (P.locationId === loc.id) { P.locationId = 'primary'; await P.load(''); }
      await P.refreshLocations();
    } catch (e) { P.toast(t('移除位置失败：{reason}', { reason: tr(e.message || '') })); }
  }

  // —— 简介 ——
  async function showInfo(it) {
    P.infoDlg = { name: it.name, isDir: it.isDir, size: it.size, mtime: it.mtime, rel: it.rel, dir: it.parent ?? P.parentOf(it.rel), loading: P.nativeFs };
    if (!P.nativeFs) return;   // 云端没有 inspect（磁盘占用/属主之类是本机概念），列表里那几项就是全部
    try {
      const d = await nativeWorkspaceInspect(it.rel, P.locationId);
      if (P.infoDlg?.rel === it.rel) P.infoDlg = { ...P.infoDlg, ...d, loading: false };
    } catch (e) {
      if (P.infoDlg?.rel === it.rel) P.infoDlg = { ...P.infoDlg, loading: false, inspectError: e.message || t('读取失败') };
    }
  }
  async function copyText(text, note = t('已复制')) {
    try { await navigator.clipboard.writeText(text); P.toast(note); } catch { P.toast(t('复制失败')); }
  }

  // —— 分享链接（仅 primary：由 bridge 服务端铸造）。文件也铸成只含它的分享空间（/w/），同 FilesPanel ——
  function openShare(it) { P.shareDlg = newShareDialog(it); }
  async function doShareLink() {
    const d = P.shareDlg;
    await mintShareLink(api, d, d?.item.rel, P.srvRoot, P.toast);
  }
  const fmtExpire = formatShareExpiry;

  async function aiMaterial(it, direct = false) {
    const kind = it.isDir ? 'folder' : (kindOf(it.name) === 'img' ? 'image' : 'file');
    try {
      // 这台电脑的文件：服务端摸不到，现读现传（文件夹给 Claude 走设备引用）
      if (P.pcFs) return await pcLocalMaterial({ rel: it.rel, name: it.name, isDir: it.isDir, locationId: P.locationId, forClaude: direct });
      const up = await api.fileToUpload(it.rel, !direct, P.srvRoot);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(it.rel, { ws: P.srvRoot }) : null };
    } catch (e) { P.toast(t('准备失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); return null; }
  }
  async function aiTextContent(it) {
    if (P.pcFs) return pcLocalText(it.rel, P.locationId);
    try {
      const res = await fetch(apiUrl(P.scopedTo('/api/file?path=' + encodeURIComponent(it.rel), P.srvRoot)), { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) return null;
      return (await res.text()).slice(0, 30000);
    } catch { return null; }
  }

  return {
    get addLocation() { return addLocation; },
    get aiMaterial() { return aiMaterial; },
    get aiTextContent() { return aiTextContent; },
    get canCompress() { return canCompress; },
    get commitRename() { return commitRename; },
    get copyText() { return copyText; },
    get dirUploadInput() { return dirUploadInput; }, set dirUploadInput(v) { dirUploadInput = v; },
    get doCompress() { return doCompress; },
    get doExtract() { return doExtract; },
    get doPaste() { return doPaste; },
    get doShareLink() { return doShareLink; },
    get doTransferInto() { return doTransferInto; },
    get doTrash() { return doTrash; },
    get fileUploadInput() { return fileUploadInput; }, set fileUploadInput(v) { fileUploadInput = v; },
    get fmtExpire() { return fmtExpire; },
    get importFiles() { return importFiles; },
    get newFolder() { return newFolder; },
    get newMarkdown() { return newMarkdown; },
    get onUploadPick() { return onUploadPick; },
    get openShare() { return openShare; },
    get removeLocation() { return removeLocation; },
    get runZipDlg() { return runZipDlg; },
    get setClipboard() { return setClipboard; },
    get showInfo() { return showInfo; },
    get startRename() { return startRename; },
    get uploadFiles() { return uploadFiles; },
  };
}
