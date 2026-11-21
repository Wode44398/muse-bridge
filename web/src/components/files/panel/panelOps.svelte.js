// 工作空间（手机 FilesPanel）的文件操作：解压 / 打开方式 / 简介 / 分享 / 发送给 AI 的素材 / 重命名 / 删除 / 新建 / 压缩 /
// 移动与复制 / 上传 / 下载与传输。P 是外壳（FilesPanel.svelte）交出来的状态与动作视图，见那边的 P。
import { uiConfirm } from '../../../lib/dialogs.js';
import { isEn, t, tr } from '../../../lib/i18n.js';
import { api, authHeaders, getToken } from '../../../lib/api.js';
import { apiUrl, isOffline } from '../../../lib/server.js';
import { cancelDownload, hasNativeDownload, startDownload } from '../../../lib/downloads.svelte.js';
import { cancelUpload as cancelUp, hasNativeUpload, onUploaded, pickNativeUpload, startUpload } from '../../../lib/uploads.svelte.js';
import { cloudFileUrl } from '../../../lib/preview.svelte.js';
import { localCopy, localDelete, localFileUrl, localImgDataUrl, localList, localMove, localReadB64, localReadText, localRename, openWith, shareFile } from '../../../lib/localfs.js';
import { hasNativeCompressWizard, nativeCompressWizard, nativeWorkspaceCopy, nativeWorkspaceCreateFile, nativeWorkspaceImportDirectory, nativeWorkspaceImportFiles, nativeWorkspaceInspect, nativeWorkspaceList, nativeWorkspaceMkdir, nativeWorkspaceMove, nativeWorkspaceOpen, nativeWorkspaceOpenWith, nativeWorkspaceRename, nativeWorkspaceReveal, nativeWorkspaceSaveAs, nativeWorkspaceTrash } from '../../../lib/nativeDesktop.js';
import { pcLocalMaterial, pcLocalText } from '../../../lib/pcLocal.js';
import { compressDefaultName, formatShareExpiry, loadCompressFormats, runCompress, shareClipboardText, withMdExt } from '../../../lib/files-business.js';
import { fmtSize, kindOf, mintShareLink } from '../../../lib/files/common.js';
import { locLabel, winAbs } from './panelLook.js';

export function createPanelOps(P) {
  // 「解压」：服务端用电脑上的解压工具（WinRAR UnRAR / bsdtar）解到同目录同名文件夹。
  // 请求同步等解压完成（大包可能要等一会儿），完成后刷新列表定位到新文件夹。
  let extracting = $state(false);
  async function doExtract(item) {
    if (extracting) return;
    extracting = true;
    P.toast(t('解压中…'));
    try { const r = await api.extractFile(P.itemRel(item), P.cloudRoot); P.toast(t('已解压到「{name}」', { name: r.name })); await P.load(P.path); }
    catch (e) { P.toast(t('解压失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); }
    finally { extracting = false; }
  }
  // 「打开方式」：用其他安卓应用打开。云端=拼带鉴权绝对 URL 交原生 HTTP 拉取（admin ?token / user 靠 cookie，原生侧附）；本地=传 rel 原生直取。
  function doOpenWith(item) {
    const r = P.itemRel(item);
    if (P.desktopNative) { nativeWorkspaceOpenWith(r, P.desktopLocationId).catch((e) => P.toast(t('打开方式失败：{reason}', { reason: tr(e.message || '') }))); return; }
    if (P.isLocal) { openWith('', r, item.name, true); return; }
    const tok = getToken();
    const url = apiUrl(P.scoped('/api/file?path=' + encodeURIComponent(r)) + (tok ? '&token=' + encodeURIComponent(tok) : ''));
    openWith(url, r, item.name, false);
  }
  async function doDesktopOpen(item) {
    try { await nativeWorkspaceOpen(P.itemRel(item), P.desktopLocationId); }
    catch (e) { P.toast(t('打开失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function doDesktopReveal(item) {
    try { await nativeWorkspaceReveal(P.itemRel(item), P.desktopLocationId); }
    catch (e) { P.toast(t('定位失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function showInfo(item) {
    P.infoItem = { name: item.name, isDir: item.isDir, size: item.size, mtime: item.mtime, dir: item.parent ?? P.path, rel: P.itemRel(item), loading: P.desktopNative };
    if (!P.desktopNative) return;
    try {
      const detail = await nativeWorkspaceInspect(P.itemRel(item), P.desktopLocationId);
      if (P.infoItem?.rel === P.itemRel(item)) P.infoItem = { ...P.infoItem, ...detail, loading: false };
    } catch (e) {
      if (P.infoItem?.rel === P.itemRel(item)) P.infoItem = { ...P.infoItem, loading: false, inspectError: tr(e.message || '') || t('读取失败') };
    }
  }

  // 「分享链接」：学 qq-bot 铸公开链接（可选密码 + 过期时间）。文件和文件夹一律走
  // /api/share-space 拷成只读分享空间出 /w/<token>——单文件就是「只有一个文件的空间」，
  // 访客点开预览（md 渲染而非源码）、右键/长按下载，与文件夹分享同一套页面。/s/ 直链
  // （/api/share）只留给要裸下载地址的 API 调用方。仅云端，本地手机文件不出此项。
  async function doShareLink() {
    const d = P.shareDlg;
    await mintShareLink(api, d, d ? P.itemRel(d.item) : '', P.cloudRoot, P.toast);
  }
  async function copyShare() {
    const d = P.shareDlg; if (!d?.result) return;
    // 带密码时连密码一起拷，方便直接转发给对方。
    const text = shareClipboardText(d.result);
    try { await navigator.clipboard.writeText(text); P.toast(t('已复制链接')); }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        P.toast(t('已复制链接'));
      } catch { P.toast(t('复制失败，请长按链接手动复制')); }
    }
  }
  const fmtExpire = formatShareExpiry;

  // 「分享」：走系统 ACTION_SEND 转发文件（同 openWith 取文件，意图改分享）。
  function doShare(item) {
    if (item.isDir) { P.toast(t('暂不支持分享文件夹')); return; }
    if (!P.canShare) { P.toast(t('分享需在手机 App 内使用')); return; }
    const r = P.itemRel(item);
    if (P.isLocal) { shareFile('', r, item.name, true); return; }
    const tok = getToken();
    const url = apiUrl(P.scoped('/api/file?path=' + encodeURIComponent(r)) + (tok ? '&token=' + encodeURIComponent(tok) : ''));
    shareFile(url, r, item.name, false);
  }

  // 弄成可投递素材：云端 fileToUpload（Claude direct=零拷贝直给源绝对路径，agent 本机直读；
  // Media Studio 默认拷 uploads——媒体任务要读内容上传且有 ownUpload 守卫）；本地 SAF base64→upload。
  async function aiMaterial(item, direct = false) {
    const r = P.itemRel(item);
    const kind = item.isDir ? 'folder' : (kindOf(item.name) === 'img' ? 'image' : 'file');
    try {
      if (P.pcLocal) return await pcLocalMaterial({ rel: r, name: item.name, isDir: item.isDir, locationId: P.desktopLocationId, forClaude: direct });
      if (P.isLocal) {
        if (item.isDir) { P.toast(t('本地文件夹暂不支持发送')); return null; }
        // 优先原生流式（/__localfile → uploadBlob，大文件不受 20MB base64 限制、blob 走磁盘
        // 后备不爆内存）；原生流不可用（在线壳/dev）或失败 → 退回 base64 单发。
        let up;
        try {
          const resp = await fetch(localFileUrl(r));
          if (!resp.ok) throw new Error('本地流不可用');   // i18n-ignore 内部信号：下面 catch 吞掉，不上屏
          up = await api.uploadBlob(item.name, await resp.blob(), { timeout: 600000 });
        } catch {
          const b64 = localReadB64(r); if (!b64) throw new Error(t('读取失败'));
          up = await api.upload(item.name, b64);
        }
        return { path: up.path, name: up.name, kind, url: kind === 'image' ? localImgDataUrl(r, item.name) : null };
      }
      const up = await api.fileToUpload(r, !direct, P.cloudRoot);
      return { path: up.path, name: up.name, kind, url: kind === 'image' ? cloudFileUrl(r, { ws: P.cloudRoot }) : null };
    } catch (e) { P.toast(t('准备失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); return null; }
  }
  // 读文本素材内容（注入媒体面板提示词栏用），封顶 30000 字。
  async function aiTextContent(item) {
    const r = P.itemRel(item);
    try {
      if (P.pcLocal) return await pcLocalText(r, P.desktopLocationId);
      if (P.isLocal) { const txt = localReadText(r); return txt == null ? null : String(txt).slice(0, 30000); }
      const res = await fetch(apiUrl(P.scoped('/api/file?path=' + encodeURIComponent(r))), { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) return null;
      return (await res.text()).slice(0, 30000);
    } catch { return null; }
  }

  // —— 文件操作 ——
  async function doRename() {
    const { item, value } = P.renameTarget;
    P.renameTarget = null;
    await renameTo(item, value.trim());
  }
  // 返回是否改成了（失败已回滚并提示）
  async function renameTo(item, name) {
    if (!name || name === item.name) return false;
    const prev = P.items;
    P.items = P.items.map((x) => (x.name === item.name ? { ...x, name } : x));   // 乐观改名（即时），失败回滚
    if (P.isLocal) {
      const r = localRename(rel(item.name), name);
      if (r.error) { P.items = prev; P.toast(t('重命名失败：{reason}', { reason: tr(r.error) })); return false; }
      return true;
    }
    if (P.desktopNative) {
      try { await nativeWorkspaceRename(P.itemRel(item), name, P.desktopLocationId); return true; }
      catch (e) { P.items = prev; P.toast(t('重命名失败：{reason}', { reason: tr(e.message || '') })); return false; }
    }
    try { await api.renameFile(rel(item.name), name, P.cloudRoot); return true; }
    catch (e) { P.items = prev; P.toast(t('重命名失败：{reason}', { reason: tr(e.body?.error || '') })); return false; }
  }
  // 电脑位置（整机任意目录）里的删除＝送进电脑的回收站，可在电脑上还原（桌面版同款）；
  // 身份工作空间里维持原来的永久删除。确认框把完整路径摆出来——整机范围里同名的东西太多。
  const trashing = $derived(P.desktopNative || (P.atPcLoc && !P.isLocal));
  async function doDelete(item) {
    // 中文与原先逐字相同（动词 +「名」？+ 文件夹附注）；英文按整句各出一条。
    const ask = trashing ? t('移到回收站「{name}」？', { name: item.name })
      : item.isDir ? t('删除「{name}」？（含其中全部内容）', { name: item.name })
      : t('删除「{name}」？', { name: item.name });
    const detail = P.atPcLoc && !P.isLocal ? winAbs(P.cloudRoot, P.itemRel(item)) + '\n' + t('可以在电脑的回收站里还原。') : '';
    // 确认钮：英文复述动词（§1.6）；中文不传，仍是默认「确定」。danger：确认钮红色、默认焦点给「取消」
    const okLabel = isEn() ? (trashing ? t('移到回收站') : t('删除')) : undefined;
    if (!(await uiConfirm(ask, { detail, okLabel, danger: true }))) return false;
    const prev = P.items;
    P.items = P.items.filter((x) => x.name !== item.name);   // 乐观移除（即时），失败回滚
    if (P.isLocal) {
      const r = localDelete(rel(item.name));
      if (r.error) { P.items = prev; P.toast(t('删除失败：{reason}', { reason: tr(r.error) })); return false; }
      return true;
    }
    if (P.desktopNative) {
      try { await nativeWorkspaceTrash(P.itemRel(item), P.desktopLocationId); P.toast(t('已移到回收站')); return true; }
      catch (e) { P.items = prev; P.toast(t('删除失败：{reason}', { reason: tr(e.message || '') })); return false; }
    }
    if (P.atPcLoc) {
      try { await api.trashFiles([P.itemRel(item)], P.cloudRoot); P.toast(t('已移到回收站')); return true; }
      catch (e) { P.items = prev; P.toast(t('删除失败：{reason}', { reason: tr(e.body?.error || e.message || '') })); return false; }
    }
    try { await api.deleteFile(rel(item.name), P.cloudRoot); return true; }
    catch (e) { P.items = prev; P.toast(t('删除失败：{reason}', { reason: tr(e.body?.error || '') })); return false; }
  }
  async function multiDelete() {
    const names = [...P.selected];
    const ask = trashing ? t('把选中的 {n} 项移到回收站？', { n: names.length }) : t('删除选中的 {n} 项？', { n: names.length });
    const okLabel = isEn() ? (trashing ? t('移到回收站') : t('删除')) : undefined;   // 同上：只英文复述动词
    if (!names.length || !(await uiConfirm(ask, { detail: P.atPcLoc && !P.isLocal ? t('可以在电脑的回收站里还原。') : '', okLabel, danger: true }))) return;
    const sel = new Set(names), prev = P.items;
    P.items = P.items.filter((x) => !sel.has(x.name));   // 乐观移除（即时）
    P.exitSelect();
    let fail = 0, why = '';
    if (P.atPcLoc && !P.isLocal) {
      // 一次送完：每次回收都要在电脑上起一个 PowerShell，逐项发请求会慢到按秒数
      try {
        const r = await api.trashFiles(names.map((n) => rel(n)), P.cloudRoot);
        const bad = (r?.results || []).filter((x) => !x.ok);
        fail = bad.length; why = bad[0]?.error || '';
      } catch (e) { fail = names.length; why = e.body?.error || e.message || ''; }
      if (fail) { await P.load(P.path); P.toast(why ? t('{n} 项没能移到回收站：{reason}', { n: fail, reason: tr(why) }) : t('{n} 项没能移到回收站', { n: fail })); }
      else P.toast(t('已把 {n} 项移到回收站', { n: names.length }));
      return;
    }
    for (const n of names) {
      if (P.isLocal) { if (localDelete(rel(n)).error) fail++; }
      else if (P.desktopNative) { try { await nativeWorkspaceTrash(rel(n), P.desktopLocationId); } catch { fail++; } }
      else { try { await api.deleteFile(rel(n), P.cloudRoot); } catch { fail++; } }
    }
    if (fail) { await P.load(P.path); P.toast(t('{n} 项删除失败', { n: fail })); }   // 有失败才重拉准确状态
  }
  async function doMkdir() {
    const name = (P.mkOpen.value || '').trim();
    P.mkOpen = null;
    if (!name) return;
    try {
      if (P.desktopNative) await nativeWorkspaceMkdir(P.path, name, P.desktopLocationId);
      else await api.mkdir(P.path, name, P.cloudRoot);
      P.toast(t('已新建文件夹')); await P.load(P.path);
    }
    catch (e) { P.toast(t('新建失败：{reason}', { reason: tr(e.body?.error || '') })); }
  }
  const rel = (name) => (P.path ? P.path + '/' + name : name);

  // 新建 Markdown：起名（默认「未命名.md」，没写扩展名自动补 .md）→ 建空文件 → 直接打开编辑器开写
  async function doNewMd() {
    const raw = (P.mdOpen?.value || '').trim();
    P.mdOpen = null;
    if (!raw) return;
    const name = withMdExt(raw);
    try {
      if (P.desktopNative) await nativeWorkspaceCreateFile(P.path, name, '', P.desktopLocationId);
      else await api.newFile(P.path, name, P.cloudRoot);
    } catch (e) {
      const why = e.body?.error || e.body || e.message || '';
      P.toast(why === 'exists' || e.status === 409 ? t('已有同名文件「{name}」', { name }) : t('新建失败：{reason}', { reason: tr(why) }));
      return;
    }
    await P.load(P.path);
    P.openDocPreview({ name, rel: rel(name) }, 'md', { startMode: 'live' });
  }

  // —— 压缩 ——
  // 桌面壳（Windows，本机路径可得）：直接弹系统自带的「创建存档」向导，格式/级别/进度都是系统的；
  // 手机、网页、旧壳：内置选项 sheet → bridge 服务端压缩（/api/files/compress，后台任务 + 轮询）。
  const zipWizard = $derived(hasNativeCompressWizard() && (P.desktopNative || /^([A-Za-z]:|\\\\)/.test(P.cloudRoot)));
  const zipServer = $derived(!P.desktopNative || !P.desktopExtra);
  const canZip = $derived(!P.isLocal && !P.readonly && !P.guest && !P.wsPick && (zipWizard || zipServer));
  let wizardOpen = false;
  async function doCompress(item) {
    const r0 = P.itemRel(item);
    if (zipWizard) {
      if (wizardOpen) { P.toast(t('系统压缩窗口已经开着')); return; }
      wizardOpen = true;
      P.toast(t('正在打开系统压缩窗口…'));
      let r;
      try { r = await nativeCompressWizard(P.desktopNative ? { rels: [r0], locationId: P.desktopLocationId } : { root: P.cloudRoot, rels: [r0] }); }
      catch (e) { r = { ok: false, error: e?.message }; }
      finally { wizardOpen = false; }
      if (r?.busy) { P.toast(t('系统压缩窗口已经开着')); return; }
      if (r?.ok) {
        if (r.archive) { P.toast(t('已压缩为「{name}」', { name: r.archive.split(/[\\/]/).pop() })); await P.load(P.path); }
        return;
      }
      if (!zipServer) { P.toast(t('压缩失败：{reason}', { reason: tr(r?.error || '') })); return; }
    }
    const dirName = P.path.split('/').filter(Boolean).pop() || P.rootLabel;
    P.zipDlg = {
      rels: [r0], sub: item.name, isDir: item.isDir,
      name: compressDefaultName([item], dirName), format: 'zip', level: 'normal',
      formats: ['zip', '7z', 'tar.gz'], busy: false, note: '', gone: null,
    };
    loadCompressFormats(api).then((formats) => { if (P.zipDlg) P.zipDlg.formats = formats; });
  }
  async function runZipDlg() {
    const d = P.zipDlg;
    if (!d || d.busy || !d.name.trim()) return;
    d.busy = true; d.note = t('正在压缩…');
    const gone = { aborted: false };
    d.gone = gone;
    const dir = P.path;
    try {
      const r = await runCompress(api, d.rels, { format: d.format, level: d.level, name: d.name.trim() }, P.desktopNative ? '' : P.cloudRoot, {
        signal: gone,
        onTick: (st) => { if (P.zipDlg === d) d.note = st.bytes ? t('正在压缩… 已写入 {size}', { size: fmtSize(st.bytes) }) : t('正在压缩…'); },
      });
      if (r.state === 'detached') return;   // 中途关了 sheet：服务端照常压完，存档稍后出现在原文件夹
      if (P.zipDlg === d) P.zipDlg = null;
      P.toast(t('已压缩为「{name}」', { name: r.name }));
      if (P.path === dir) await P.load(P.path);
    } catch (e) {
      if (P.zipDlg === d) { d.busy = false; d.note = ''; }
      P.toast(t('压缩失败：{reason}', { reason: tr(e.body?.error || e.message || '') }));
    }
  }
  function closeZipDlg() {
    const d = P.zipDlg;
    if (!d) return;
    if (d.busy && d.gone) { d.gone.aborted = true; P.toast(t('压缩在后台继续，完成后出现在原文件夹')); }
    P.zipDlg = null;
  }

  // —— 移动到 / 复制到：目录选择器 sheet（浏览文件夹树选目标）。云端走 /api/files，
  //    本地走 localList（''=位置列表，进入某位置后才能确认投放；跨位置=原生复制+删源）——
  // root/rootLabel＝目标所在的根（云端才有意义）：缺省是当前位置；admin 在选择器根目录还能切到别的
  // 电脑位置——「把 D 盘下载里的东西挪进工作空间」就是在这儿选的，服务端按 fromWs 跨根搬（跨盘自动拷+删）。
  let picker = $state(null);   // { mode:'move'|'copy', names:[源名], srcDir, path, items, loading, root, rootLabel }
  async function openMovePicker(names, mode, sourceDir = P.path) {
    if (!names.length) return;
    picker = { mode, names: [...names], srcDir: sourceDir, path: '', items: [], loading: true, root: P.cloudRoot, rootLabel: P.rootLabel };
    await pickerLoad('');
  }
  async function pickerLoad(p) {
    if (!picker) return;
    picker.path = p; picker.loading = true; picker = { ...picker };
    const want = picker;
    let dirs = [];
    if (P.isLocal) { try { dirs = localList(p).filter((i) => i.isDir); } catch {} }
    else {
      try {
        const r = P.desktopNative ? await nativeWorkspaceList(p, P.desktopLocationId) : await api.files(p, want.root);
        dirs = (r.items || []).filter((i) => i.isDir && i.linkType !== 'external-link');
      } catch {}
    }
    if (!picker || picker.root !== want.root || picker.path !== p) return;   // 期间又换了位置/目录：旧结果作废
    picker.items = dirs; picker.loading = false; picker = { ...picker };
  }
  function pickerEnter(name) { pickerLoad(picker.path ? picker.path + '/' + name : name); }
  function pickerCrumb(i) { pickerLoad(picker.path.split('/').filter(Boolean).slice(0, i + 1).join('/')); }
  const locRoot = (l) => (l.id === 'ws' ? '' : l.path);
  function pickerSetLoc(l) {
    if (!picker || locRoot(l) === picker.root) return;
    picker = { ...picker, root: locRoot(l), rootLabel: l.id === 'ws' ? t('工作空间') : locLabel(l), items: [] };
    pickerLoad('');
  }
  async function pickerConfirm() {
    const { mode, names, srcDir, path: dest, root: destRoot } = picker;
    if (P.isLocal) {
      if (P.multiRoot && !dest) { P.toast(t('请先进入一个位置')); return; }   // 位置列表页不能当目标
      picker = null;
      P.toast(mode === 'move' ? t('移动中…') : t('复制中…'));
      await new Promise((r) => setTimeout(r, 30));   // 让 toast 先上屏——原生 move/copy 是同步桥调用会阻塞 JS
      let okN = 0, err = '';
      for (const n of names) {
        const r = (mode === 'move' ? localMove : localCopy)(srcDir ? srcDir + '/' + n : n, dest);
        if (r.error) err = r.error; else okN++;
      }
      if (P.selecting) P.exitSelect();
      P.toast(okN ? (mode === 'move' ? t('已移动 {n} 项', { n: okN }) : t('已复制 {n} 项', { n: okN })) : (tr(err) || t('操作失败')));
      await P.load(P.path);
      return;
    }
    picker = null;
    // 目标在另一个电脑位置：源按当前根、目标按它的根，服务端一次搬完（跨盘时自动拷贝+删源）
    const cross = !P.desktopNative && (destRoot ?? P.cloudRoot) !== P.cloudRoot;
    if (cross) P.toast(mode === 'move' ? t('移动中…') : t('复制中…'));
    let okN = 0, err = '';
    for (const n of names) {
      try {
        const source = srcDir ? srcDir + '/' + n : n;
        if (P.desktopNative) await (mode === 'move' ? nativeWorkspaceMove : nativeWorkspaceCopy)(source, dest, P.desktopLocationId);
        else if (cross) await (mode === 'move' ? api.moveFile : api.copyFile)(source, dest, destRoot, P.cloudRoot);
        else await (mode === 'move' ? api.moveFile : api.copyFile)(source, dest, P.cloudRoot);
        okN++;
      }
      catch (e) { err = e.body?.error || (typeof e.body === 'string' ? e.body : '') || err; }
    }
    if (P.selecting) P.exitSelect();
    P.toast(okN ? (mode === 'move' ? t('已移动 {n} 项', { n: okN }) : t('已复制 {n} 项', { n: okN })) : (tr(err) || t('操作失败')));
    await P.load(P.path);
  }
  const pickerDestName = $derived.by(() => {
    if (!picker) return '';
    const ps = picker.path.split('/').filter(Boolean);
    if (!ps.length) return P.isLocal ? t('本地') : (picker.rootLabel || t('工作空间'));
    const last = ps[ps.length - 1];
    return P.isLocal && P.multiRoot && ps.length === 1 ? (P.rootMap[last] || last) : last;   // 首段=根 id → 显示名
  });
  const pickerBtnLabel = $derived(!picker ? '' : P.isLocal && P.multiRoot && !picker.path ? t('请先进入一个位置')
    : picker.mode === 'move' ? t('移动到「{name}」', { name: pickerDestName }) : t('复制到「{name}」', { name: pickerDestName }));

  // —— 上传（进度入传输面板；执行在 lib/uploads.svelte.js：手机 App 走原生服务、其余走 XHR 分块）——
  async function pickUpload() {
    P.addOpen = false;
    if (!P.desktopNative) {
      // 手机 App：原生选文件 + 原生上传（退后台/锁屏照传）；没有原生桥才走网页 <input type=file>
      if (hasNativeUpload() && pickNativeUpload({ dir: P.path, ws: P.cloudRoot })) return;
      P.fileInput?.click();
      return;
    }
    try {
      const result = await nativeWorkspaceImportFiles(P.path, P.desktopLocationId);
      if (!result?.canceled) { P.toast(t('已导入 {n} 个文件', { n: result.items?.length || 0 })); await P.load(P.path); }
    } catch (e) { P.toast(t('导入失败：{reason}', { reason: tr(e.message || '') })); }
  }
  // 有文件传进了当前看着的目录 → 刷新列表（上传可能是在别的页面/别的目录时发起、现在才完成）
  $effect(() => onUploaded(({ ws: w, dirs }) => {
    if (!P.isLocal && (w || '') === (P.cloudRoot || '') && dirs.includes(P.path)) P.load(P.path);
  }));
  async function pickDirectoryImport() {
    P.addOpen = false;
    try {
      const result = await nativeWorkspaceImportDirectory(P.path, P.desktopLocationId);
      if (!result?.canceled) { P.toast(t('文件夹已导入')); await P.load(P.path); }
    } catch (e) { P.toast(t('导入失败：{reason}', { reason: tr(e.message || '') })); }
  }
  async function onPick(e) {
    const list = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of list) uploadOne(f);
  }
  let uid = 0;
  function uploadOne(file, intoDir) {
    startUpload(file, { dir: intoDir ?? P.path, ws: P.cloudRoot });   // 拖到某个文件夹上时传进那个文件夹，否则当前目录
  }
  // 取消在途任务：上传交给引擎（掐断在途请求 + 让服务端删半截文件）；下载按来源各自取消。
  function cancelTask(task) {
    if (task.status !== 'up') return;
    if (task.up) { cancelUp(task.id); P.toast(t('已取消上传 {name}', { name: task.name })); return; }
    if (task.native) { cancelDownload(task.id); P.toast(t('已取消下载 {name}', { name: task.name })); return; }
    task.status = 'cancelled';
    try { task.ctrl.abort(); } catch {}
    P.tasks = [...P.tasks];
    P.toast(t('已取消下载 {name}', { name: task.name }));
  }

  function nativeDownload(r) {
    const name = r.split('/').pop() || 'download';
    // &name=：APK 原生 DownloadListener 用它做精确文件名（含中文）；网页端浏览器按 Content-Disposition。
    let href = apiUrl(P.scoped('/api/file?path=' + encodeURIComponent(r)) + '&dl=1&name=' + encodeURIComponent(name));
    // 离线壳里下载走原生 DownloadManager（另一条 HTTP 请求，带不上 JS 的 Bearer 头）——admin 把
    // token 拼进 URL（/api/file 在 ?token 白名单内）；普通用户靠 WebView cookie（原生侧已附）兜底。
    const tok = getToken();
    if (isOffline() && tok) href += '&token=' + encodeURIComponent(tok);
    const a = document.createElement('a');
    a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  function download(r) {
    if (P.desktopNative) {
      nativeWorkspaceSaveAs(r, P.desktopLocationId).then((result) => { if (!result?.canceled) P.toast(t('已保存到电脑')); }).catch((e) => P.toast(t('保存失败：{reason}', { reason: tr(e.message || '') })));
      return;
    }
    if (hasNativeDownload()) { appDownload(r); return; }
    if (P.readonly) { downloadTracked(r); return; }
    nativeDownload(r);
  }
  // 手机 App：app 自己下到手机「下载」文件夹（原生下载器，带 Bearer 头），进度进本页「传输」面板；
  // 不再跳系统浏览器。原生桥拒收（极旧壳）才退回 <a download>。
  function appDownload(r) {
    const name = r.split('/').pop() || 'download';
    const url = apiUrl(P.scoped('/api/file?path=' + encodeURIComponent(r)) + '&dl=1&name=' + encodeURIComponent(name));
    if (startDownload({ url, name, quiet: true })) P.toast(t('开始下载 {name}', { name }));
    else nativeDownload(r);
  }
  // 分享页下载：fetch 流式读进度 → 顶栏环 + 传输面板有真实状态（访客在这页的核心动作就是
  // 下载，不能毫无反馈）。数据攒成 Blob 后触发保存；大文件 Blob 内存风险大，超阈值掐掉这条
  // 流退回浏览器原生下载（自带下载管理）；流式中途失败同样退回原生兜底。
  const TRACK_MAX = 300 * 1024 * 1024;
  async function downloadTracked(r) {
    const name = r.split('/').pop() || 'download';
    const id = 'd' + Date.now() + (uid++);
    P.tasks = [{ id, name, total: 0, sent: 0, status: 'up', kind: kindOf(name), bps: 0, lastT: 0, ctrl: new AbortController(), dl: true, at: Date.now() }, ...P.tasks];
    // 【Svelte5 深代理坑】必须拿数组元素的代理来改——push 进 $state 后改裸字面量，
    // 代理 signal 不更新，UI 永远 0%（同 webview 上传 0% 卡死的老病，先例判法照抄）。
    const tk = P.tasks[0];
    try {
      const res = await fetch(apiUrl(P.scoped('/api/file?path=' + encodeURIComponent(r))), { headers: authHeaders(), credentials: 'same-origin', signal: tk.ctrl.signal });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      tk.total = Number(res.headers.get('content-length')) || 0;
      if (tk.total > TRACK_MAX) {
        try { tk.ctrl.abort(); } catch {}
        P.tasks = P.tasks.filter((x) => x.id !== id);
        nativeDownload(r);
        P.toast(t('文件较大，已交给浏览器下载'));
        return;
      }
      const reader = res.body.getReader();
      const chunks = [];
      tk.lastT = performance.now();
      let uiSent = 0, lastUi = 0, sent = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        sent += value.byteLength;
        const now = performance.now();
        if (now - lastUi > 150) {   // 节流：chunk 很密，逐个驱动响应式会拖死列表
          const dt = (now - tk.lastT) / 1000;
          if (dt > 0) { const inst = (sent - uiSent) / dt; tk.bps = tk.bps ? tk.bps * 0.6 + inst * 0.4 : inst; }
          tk.lastT = now; uiSent = sent; lastUi = now;
          tk.sent = sent;
        }
      }
      tk.sent = sent;
      tk.total = Math.max(tk.total, sent) || 1;
      const blob = new Blob(chunks);
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      tk.sent = tk.total; tk.status = 'done';
      P.toast(t('已下载 {name}', { name }));
      setTimeout(() => { P.tasks = P.tasks.filter((x) => x.id !== id); }, 4000);
    } catch (e) {
      if (tk.status === 'cancelled' || e?.name === 'AbortError') {   // 用户取消：短暂显示后清行
        setTimeout(() => { P.tasks = P.tasks.filter((x) => x.id !== id); }, 2500);
        return;
      }
      P.tasks = P.tasks.filter((x) => x.id !== id);
      nativeDownload(r);   // 流式失败退回原生下载，至少能下到
    }
  }

  return {
    get aiMaterial() { return aiMaterial; },
    get aiTextContent() { return aiTextContent; },
    get canZip() { return canZip; },
    get cancelTask() { return cancelTask; },
    get closeZipDlg() { return closeZipDlg; },
    get copyShare() { return copyShare; },
    get doCompress() { return doCompress; },
    get doDelete() { return doDelete; },
    get doDesktopOpen() { return doDesktopOpen; },
    get doDesktopReveal() { return doDesktopReveal; },
    get doExtract() { return doExtract; },
    get doMkdir() { return doMkdir; },
    get doNewMd() { return doNewMd; },
    get doOpenWith() { return doOpenWith; },
    get doRename() { return doRename; },
    get doShare() { return doShare; },
    get doShareLink() { return doShareLink; },
    get download() { return download; },
    get extracting() { return extracting; }, set extracting(v) { extracting = v; },
    get fmtExpire() { return fmtExpire; },
    get locRoot() { return locRoot; },
    get multiDelete() { return multiDelete; },
    get onPick() { return onPick; },
    get openMovePicker() { return openMovePicker; },
    get pickDirectoryImport() { return pickDirectoryImport; },
    get pickUpload() { return pickUpload; },
    get picker() { return picker; }, set picker(v) { picker = v; },
    get pickerBtnLabel() { return pickerBtnLabel; },
    get pickerConfirm() { return pickerConfirm; },
    get pickerCrumb() { return pickerCrumb; },
    get pickerEnter() { return pickerEnter; },
    get pickerLoad() { return pickerLoad; },
    get pickerSetLoc() { return pickerSetLoc; },
    get rel() { return rel; },
    get renameTo() { return renameTo; },
    get runZipDlg() { return runZipDlg; },
    get showInfo() { return showInfo; },
    get trashing() { return trashing; },
    get uploadOne() { return uploadOne; },
  };
}
