// 查看器溢出菜单的通用项：只接现成能力，探测不到就不出这一项。
//   下载 / 另存为   有 downloadHref（或桌面壳原生位置）就有；桌面=原生另存为、手机 App=内置下载器、网页=<a download>
//   分享            手机 App 原生分享（AndroidStore.shareFile）
//   打开方式        手机 App 原生 chooser；桌面壳「打开方式」（服务端在本机或这台电脑的位置才有）
//   在文件夹中显示  桌面壳 reveal（同上条件）
//   存到相册 / 设为壁纸 / 在文件管理器中显示   手机本地文件 + 新 apk 原生能力（逐个探测；壁纸只给位图）
//   复制路径        有工作空间相对路径 / 本机绝对路径
//   复制链接        描述符带了可公开的 link（媒体 URL 带 ?token，绝不拿来当链接）
//   复制图片        图片条目 + 浏览器有 Clipboard API 写图（ClipboardItem）；统一转 PNG 写入，失败给 toast
//   文件信息        总有
//   发送给 AI / 重命名 / 删除   调用方经 openPreview(…, { actions }) 注入才有（只有调用方知道怎么投递、怎么刷新列表）
import { preview } from '../../../lib/preview.svelte.js';
import { saveToDisk, saveLabel } from '../../../lib/save.js';
import { hasShare, shareFile, hasOpenWith, openWith, hasSaveToGallery, localSaveToGallery, hasSetWallpaper, localSetWallpaper, hasReveal, localReveal, hasLocalStat, localStat, hasLocalExif, localExif } from '../../../lib/localfs.js';
import { isNativeDesktop, serverOnThisMachine, nativeWorkspaceSaveAs, nativeWorkspaceOpenWith, nativeWorkspaceReveal } from '../../../lib/nativeDesktop.js';
import { showToast } from '../../../lib/toast.svelte.js';
import { iconKindOf } from '../../../lib/fileKinds.js';
import { t, tc } from '../../../lib/i18n.js';

const D = () => (typeof window !== 'undefined' ? window.BridgeDesktop : null);
const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u || ''; } };
const isHttp = (u) => /^(https?:)?\/\//i.test(u || '') || /^\/(?!\/)/.test(u || '');

/** 桌面壳能直接摸到这个文件的原生位置 id（摸不到给 ''） */
function nativeLoc(item) {
  const st = item?.saveTarget;
  if (!isNativeDesktop() || !st || st.origin !== 'cloud' || st.ws) return '';
  if (item.nativeLocation) return item.nativeLocation;
  return serverOnThisMachine() ? 'primary' : '';
}

export function canDownload(item) {
  return !!item && (!!item.downloadHref || !!(item.nativeLocation && item.saveTarget?.rel));
}
export async function download(item) {
  if (!item) return false;
  try {
    if (item.nativeLocation && item.saveTarget?.rel && D()?.workspace?.saveAs) { await nativeWorkspaceSaveAs(item.saveTarget.rel, item.nativeLocation); return true; }
    if (!item.downloadHref) return false;
    await saveToDisk({ url: item.downloadHref, name: item.name, path: item.absPath || '' });
    return true;
  } catch { showToast(t('下载失败'), 'err'); return false; }
}

export async function copyText(text) {
  const s = String(text || '');
  if (!s) return false;
  try { await navigator.clipboard.writeText(s); return true; } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = s; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function pathOf(item) { return item?.absPath || item?.saveTarget?.rel || ''; }

// —— 复制图片：取原图 → 解码 → 画到 canvas → PNG 写进剪贴板 ——
// 剪贴板只认 image/png（Chromium 的 ClipboardItem 白名单），jpg / webp / gif 一律转一道；svg 走 <img> 解码。
// ClipboardItem 直接收 Promise：写剪贴板的那一下仍在点击的用户激活里（Safari 要求），取图解码放到后面慢慢做。
export function canCopyImage(item) {
  return !!item && item.kind === 'image' && !!(item.url || item.previewUrl)
    && typeof window !== 'undefined' && typeof window.ClipboardItem === 'function' && !!navigator.clipboard?.write;
}
async function decodeImage(blob) {
  try { if (!/svg/i.test(blob.type)) return await createImageBitmap(blob); } catch {}
  const u = URL.createObjectURL(blob);
  const img = new Image();
  img.src = u;
  try { await img.decode(); } finally { setTimeout(() => URL.revokeObjectURL(u), 0); }
  return img;
}
async function pngBlobOf(src) {
  const r = await fetch(src, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('http ' + r.status);
  const b = await r.blob();
  if (b.type === 'image/png') return b;
  const im = await decodeImage(b);
  const w = im.width || im.naturalWidth, h = im.height || im.naturalHeight;
  if (!w || !h) throw new Error('decode');
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(im, 0, 0);
  try { im.close?.(); } catch {}
  return await new Promise((ok, no) => c.toBlob((x) => (x ? ok(x) : no(new Error('encode'))), 'image/png'));
}
export async function copyImage(item) {
  if (!canCopyImage(item)) return false;
  try {
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': pngBlobOf(item.url || item.previewUrl) })]);
    return true;
  } catch { return false; }
}

/**
 * 通用菜单项（ViewerMenu 条目格式）。ctx：{ toast(text, opts), openInfo() }；exclude：要去掉的 id。
 * 返回已按组插好分隔线的数组，外框拼在子查看器自己的菜单项之后。
 */
export function commonMenu(item, ctx, exclude = []) {
  if (!item) return [];
  const no = new Set(Array.isArray(exclude) ? exclude : []);
  const acts = preview.actions || {};
  const g1 = [], g2 = [], g4 = [];
  const loc = nativeLoc(item);

  if (!no.has('download') && canDownload(item)) {
    g1.push({ id: 'download', label: item.nativeLocation && item.saveTarget?.rel ? t('另存为…') : saveLabel(t('下载')), icon: 'download', onSelect: () => download(item) });
  }
  if (!no.has('share') && hasShare()) {
    const local = item.saveTarget?.origin === 'local';
    if (local || isHttp(item.url)) g1.push({ id: 'share', label: t('分享'), icon: 'share', onSelect: () => shareFile(local ? '' : abs(item.url), item.saveTarget?.rel || '', item.name, local) });
  }
  if (!no.has('openWith')) {
    if (hasOpenWith()) {
      const local = item.saveTarget?.origin === 'local';
      if (local || isHttp(item.url)) g1.push({ id: 'openWith', label: t('打开方式…'), icon: 'openWith', onSelect: () => openWith(local ? '' : abs(item.url), item.saveTarget?.rel || '', item.name, local) });
    } else if (loc && D()?.workspace?.openWith) {
      g1.push({ id: 'openWith', label: t('打开方式…'), icon: 'openWith', onSelect: () => nativeWorkspaceOpenWith(item.saveTarget.rel, loc) });
    }
  }
  if (!no.has('reveal') && loc && D()?.workspace?.reveal) {
    g1.push({ id: 'reveal', label: t('在文件夹中显示'), icon: 'folder', onSelect: () => nativeWorkspaceReveal(item.saveTarget.rel, loc) });
  }
  // 手机本地（新 apk）：存到相册（Pictures|Movies/Bridge）、设为壁纸（系统裁剪页）、在系统文件管理里打开所在文件夹
  const lrel = item.saveTarget?.origin === 'local' ? item.saveTarget.rel : '';
  if (lrel) {
    const bitmap = item.kind === 'image' && item.ext !== 'svg';
    if (!no.has('saveGallery') && (bitmap || item.kind === 'video') && hasSaveToGallery()) {
      g1.push({ id: 'saveGallery', label: t('存到相册'), icon: 'saveGallery', onSelect: async () => {
        const wait = ctx.toast(t('正在存到相册…'), { ms: 0 });
        const r = await localSaveToGallery(lrel);
        wait?.close?.();
        // 原生回的是相对路径（Pictures/Bridge）；相册 App 里按文件夹名列相册，提示只报最后一段，免得窄提示条折行
        const album = String(r.album || '').split('/').filter(Boolean).pop();
        ctx.toast(r.ok ? (album ? t('已存到相册「{album}」', { album }) : t('已存到相册')) : r.error, { kind: r.ok ? 'ok' : 'err' });
      } });
    }
    if (!no.has('wallpaper') && bitmap && item.ext !== 'gif' && hasSetWallpaper()) {
      g1.push({ id: 'wallpaper', label: t('设为壁纸…'), icon: 'wallpaper', onSelect: () => { if (!localSetWallpaper(lrel)) ctx.toast(t('设置壁纸失败'), { kind: 'err' }); } });
    }
    if (!no.has('reveal') && hasReveal()) {
      g1.push({ id: 'reveal', label: t('在文件管理器中显示'), icon: 'folder', onSelect: () => { if (!localReveal(lrel)) ctx.toast(t('打不开文件管理器'), { kind: 'err' }); } });
    }
  }

  const p = pathOf(item);
  if (!no.has('copyPath') && p) {
    g2.push({ id: 'copyPath', label: t('复制路径'), icon: 'copy', kbd: 'Ctrl+Shift+C', onSelect: async () => { const ok = await copyText(p); ctx.toast(ok ? t('已复制路径') : t('无法写入剪贴板'), { kind: ok ? 'ok' : 'err' }); } });
  }
  if (!no.has('copyImage') && canCopyImage(item)) {
    g2.push({ id: 'copyImage', label: t('复制图片'), icon: 'image', onSelect: async () => { const ok = await copyImage(item); ctx.toast(ok ? t('已复制图片') : t('无法复制图片'), { kind: ok ? 'ok' : 'err' }); } });
  }
  if (!no.has('copyLink') && item.link) {
    g2.push({ id: 'copyLink', label: t('复制链接'), icon: 'link', onSelect: async () => { const ok = await copyText(item.link); ctx.toast(ok ? t('已复制链接') : t('无法写入剪贴板'), { kind: ok ? 'ok' : 'err' }); } });
  }

  // 复制类、发送、重命名、信息并成一组（Windows 照片 / 访达的 … 菜单同样只分「打开与导出 / 其余 / 删除」三段，
  // 一项一段的话菜单碎成一条条横线）
  if (!no.has('sendAi') && typeof acts.sendAi === 'function') g2.push({ id: 'sendAi', label: t('发送给 AI…'), icon: 'sendAi', onSelect: () => acts.sendAi(item) });
  if (!no.has('rename') && typeof acts.rename === 'function') g2.push({ id: 'rename', label: t('重命名…'), icon: 'rename', kbd: 'F2', onSelect: () => acts.rename(item, ctx) });
  if (!no.has('info')) g2.push({ id: 'info', label: t('文件信息'), icon: 'info', kbd: 'Alt+Enter', onSelect: () => ctx.openInfo() });

  if (!no.has('trash') && typeof acts.trash === 'function') g4.push({ id: 'trash', label: t('删除'), icon: 'trash', kbd: 'Del', danger: true, onSelect: () => acts.trash(item, ctx) });

  const out = [];
  for (const g of [g1, g2, g4]) { if (!g.length) continue; if (out.length) out.push({ sep: true }); out.push(...g); }
  return out;
}

// —— 文件信息 ——
// 「类型」按列表图标分类（fileKinds.iconKindOf）说人话：Office 分文档 / 表格 / 演示，代码与纯文本分开，压缩包单列
const KIND_LABEL = () => ({
  image: t('图片'), video: t('视频'), audio: t('音频'), pdf: 'PDF', md: 'Markdown', doc: t('文档'), sheet: tc('files', '表格'),
  slide: t('演示文稿'), html: t('网页'), zip: tc('files', '压缩包'), code: t('代码'), text: t('文本'),
});
const ORIGIN_LABEL = () => ({
  cloud: t('工作空间'), local: t('手机本地'), vertex: t('生成作品'), claude: t('Claude 产物'), codex: t('Codex 产物'), harness: t('dimensio 产物'), upload: t('聊天附件'),
});

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + u[i];
}

/** 用一次 Range 0-0 请求补大小 / 修改时间 / 类型（调用方没带时）。只读响应头，不下正文。 */
export async function probeMeta(item, signal, onMore) {
  if (item?.saveTarget?.origin === 'local' && hasLocalStat()) return probeLocal(item, onMore);
  const u = item?.url;
  if (!u || /^(blob:|data:)/i.test(u)) return null;
  try {
    const r = await fetch(u, { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin', signal });
    const cr = r.headers.get('content-range');
    const len = cr && /\/(\d+)\s*$/.test(cr) ? +cr.match(/\/(\d+)\s*$/)[1] : (r.status === 200 ? +r.headers.get('content-length') || null : null);
    const lm = r.headers.get('last-modified');
    const out = { size: Number.isFinite(len) ? len : null, mtime: lm ? Date.parse(lm) || null : null, mime: (r.headers.get('content-type') || '').split(';')[0] };
    try { r.body?.cancel(); } catch {}
    return out;
  } catch { return null; }
}

// 手机本地：大小 / 时间 / 类型原生一次 query 同步拿；图片视频再异步读 EXIF / 容器元数据（尺寸、拍摄时间、相机、参数、
// 城市级地点、时长），到了经 onMore(meta) 补上——反地理编码可能要一两秒，先出的行不等它
function probeLocal(item, onMore) {
  const rel = item.saveTarget.rel;
  const st = localStat(rel);
  const base = st ? { size: Number.isFinite(st.size) && st.size >= 0 ? st.size : null, mtime: st.mtime > 0 ? st.mtime : null, mime: st.mime || '' } : {};
  if ((item.kind === 'image' || item.kind === 'video') && hasLocalExif() && typeof onMore === 'function') {
    // 下一拍再发：保证先出的那份（同步）一定先落到面板上，补的这份不会被它盖掉
    setTimeout(() => localExif(rel).then((x) => { if (x) onMore({ ...base, extra: exifRows(x, item.kind) }); }), 0);
  }
  return base;
}
function fmtDur(ms) {
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
}
function exifRows(x, kind) {
  const rows = [];
  // 标签跟子查看器自报的一致（图片「尺寸」、视频「分辨率」），合并时同名去重，不会出两行
  if (x.w > 0 && x.h > 0) rows.push({ label: kind === 'video' ? t('分辨率') : tc('viewer', '尺寸'), value: `${x.w} × ${x.h}` });
  if (x.duration > 0) rows.push({ label: t('时长'), value: fmtDur(x.duration) });
  if (x.taken) rows.push({ label: t('拍摄时间'), value: x.taken });
  if (x.camera) rows.push({ label: t('相机'), value: x.camera });
  if (x.exposure) rows.push({ label: t('拍摄参数'), value: x.exposure });
  if (x.place) rows.push({ label: t('拍摄地点'), value: x.place });
  return rows;
}

/** 信息面板的行：[{ label, value }] */
export function infoRows(item, meta = {}, extra = []) {
  if (!item) return [];
  const rows = [];
  const ext = item.ext ? item.ext.toUpperCase() : '';
  rows.push({ label: t('名称'), value: item.name });
  if (item.prompt) rows.push({ label: t('提示词'), value: item.prompt });   // 生成媒体：文件名只截了前 40 字，完整提示词在这
  const mime = meta.mime || item.mime || '';
  const kl = KIND_LABEL()[iconKindOf(item.name, { mime })] || t('文件');
  // 有扩展名就够认了；MIME 只在没扩展名时补（Office 的 application/vnd.openxmlformats-… 一长串读不了）
  rows.push({ label: t('类型'), value: [kl, ext !== kl ? ext : ''].filter(Boolean).join(' · ') + (!ext && mime ? ' (' + mime + ')' : '') });
  const size = item.size ?? meta.size;
  if (Number.isFinite(size)) rows.push({ label: t('大小'), value: fmtBytes(size) + (size >= 1024 ? ' (' + size.toLocaleString() + ' B)' : '') });
  const mt = item.mtime || meta.mtime;
  if (mt) { try { rows.push({ label: t('修改时间'), value: new Date(mt).toLocaleString() }); } catch {} }
  // 原生读到的媒体信息在前（本地 HEIC / 超大图上屏的是转换 / 降采样后的，子查看器报的尺寸不是原图的），同名行只留一条
  const more = [...(meta.extra || [])];
  for (const r of extra || []) if (r && !more.some((x) => x.label === r.label)) more.push(r);
  for (const r of more) if (r && r.label && r.value != null && r.value !== '') rows.push(r);
  const p = pathOf(item);
  if (p) rows.push({ label: t('位置'), value: p, mono: true });
  const o = ORIGIN_LABEL()[item.origin];
  if (o) rows.push({ label: t('来源'), value: o });
  return rows;
}
