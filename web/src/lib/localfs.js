// 本地工作空间（手机本地文件，经 Android SAF 原生桥）。多根「本地位置」：可授权多个手机
// 文件夹（各自可移除/重选）＋可选「整机存储」。相对路径 rel 形如 "<rootId>/<根内路径>"，
// 由原生 resolveRel 选根（首段非根 id 时落首个根，兼容裸路径）。rel='' 列位置列表。
//
// 原生方法（MainActivity 的 NativeStore，window.AndroidStore.*）：
//   pickLocalRoot() 异步【追加】一个文件夹根（结果经 window.__onLocalRoot 回调）
//   localRoots() -> [{id,name,mode}]（新 apk）/ removeLocalRoot(id) / hasLocalRoot() / localRootName()
//   localList(rel) -> {items:[{name,isDir,size,mtime}]}（rel='' 时项带 {label,root:true,mode}）
//   localReadText(rel) / localReadB64(rel) / localWrite(rel,content,b64) / clearLocalRoot()（清全部）
//   新 apk（hasLocalPreview）：localStat / localExif / localSaveToGallery / localSetWallpaper / canReveal+localReveal /
//   hasPip+enterPip+setPipAuto / keepScreenOn；异步的经 window.__bridgeLocalDone(token, json) 回。
//
// 只在离线 apk WebView 内可用。dev / 在线壳 / 旧 apk 没有这些方法 → hasLocalFs()=false，
// 前端本地 tab 显示「需在手机 App 内使用」。dev 可注入 window.AndroidStore mock 测前端逻辑。

import { t } from './i18n.js';

const S = () => (typeof window !== 'undefined' ? window.AndroidStore : null);

export function hasLocalFs() { const s = S(); return !!(s && typeof s.localList === 'function'); }
export function hasLocalRoot() { try { return !!S().hasLocalRoot(); } catch { return false; } }
export function localRootName() { try { return S().localRootName() || t('本地'); } catch { return t('本地'); } }

// 路线B 全盘：是否支持「授权整个手机」（需 app 内 + 原生有 requestAllFiles）。
export function canAllFiles() { const s = S(); return !!(s && typeof s.requestAllFiles === 'function'); }
// 请求「所有文件访问」——已授直接进全盘、未授跳系统设置（回 app 经 __onLocalRoot 回调）。
export function requestAllFiles() {
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { delete window.__onLocalRoot; } catch {} res(hasLocalRoot()); };
    window.__onLocalRoot = finish;
    try { S().requestAllFiles(); } catch { done = true; res(false); return; }
    setTimeout(finish, 300000);   // 用户去系统设置可能很久，长兜底
  });
}

// 选本地工作空间根（SAF ACTION_OPEN_DOCUMENT_TREE，异步——经 window.__onLocalRoot 回调）。
export function pickLocalRoot() {
  return new Promise((res) => {
    let done = false;
    const finish = () => { if (done) return; done = true; try { delete window.__onLocalRoot; } catch {} res(hasLocalRoot()); };
    window.__onLocalRoot = finish;
    try { S().pickLocalRoot(); } catch { done = true; res(false); return; }
    setTimeout(finish, 180000);   // 兜底：用户长时间不选也别永远挂着
  });
}
export function clearLocalRoot() { try { S().clearLocalRoot(); } catch {} }

// —— 多根「本地位置」——
// 新 apk 暴露 localRoots()/removeLocalRoot()；旧 apk 只有单根接口 → 降级成单根伪列表 + 整体清。
export function hasMultiRoot() { const s = S(); return !!(s && typeof s.localRoots === 'function'); }
// 位置列表 [{id,name,mode}]（mode: 'saf'|'all'）。旧 apk 合成一个伪根（id=''，前端旧流程不依赖它）。
export function localRoots() {
  const s = S();
  if (s && typeof s.localRoots === 'function') {
    try { return JSON.parse(s.localRoots()) || []; } catch { return []; }
  }
  return hasLocalRoot() ? [{ id: '', name: localRootName(), mode: 'saf' }] : [];
}
// 追加一个手机文件夹为新位置（语义=add；原生 onActivityResult 已改为追加、去重）。返回 Promise<bool>。
export function addLocalRoot() { return pickLocalRoot(); }
// 移除一个位置（SAF 释放持久权限 / 整机移出列表）。旧 apk 无此接口 → 退化为整体清。
export function removeLocalRoot(id) {
  const s = S();
  try {
    if (s && typeof s.removeLocalRoot === 'function') s.removeLocalRoot(id || '');
    else clearLocalRoot();
  } catch {}
}

export function localList(rel) {
  try { const r = JSON.parse(S().localList(rel || '')); return r.items || []; } catch { return []; }
}
/** 原生 localReadText 只读文件前这么多字节（MainActivity.localReadText）：更大的文件读回来是截断的 */
export const LOCAL_TEXT_MAX = 2 * 1024 * 1024;
export function localReadText(rel) { try { return S().localReadText(rel) || ''; } catch { return ''; } }
export function localReadB64(rel) { try { return S().localReadB64(rel) || ''; } catch { return ''; } }
export function hasLocalWrite() { const s = S(); return !!(s && typeof s.localWrite === 'function'); }
// 写文本到本地工作空间根下（助手 save_file·phone_local 用）。返回 {ok,name} 或 {error}。
export function localWrite(rel, content) {
  const s = S();
  if (!s || typeof s.localWrite !== 'function') return { error: t('此设备不支持写入手机本地（需在新版 app 内）') };
  if (typeof s.hasLocalRoot === 'function' && !s.hasLocalRoot()) return { error: t('尚未授权本地工作空间文件夹——请在工作空间「本地」tab 选一个手机文件夹') };
  try { const r = JSON.parse(s.localWrite(rel, String(content ?? ''), false)) || {}; return r.ok ? { ok: true, name: r.name } : { error: r.error || t('写入失败') }; }
  catch (e) { return { error: String(e?.message ?? e) }; }
}
// 二进制写（md 编辑器插图等）：b64 不带 data: 前缀。目标目录必须已存在、同名会被覆盖——调用方自己避让。
export function localWriteB64(rel, b64) {
  const s = S();
  if (!s || typeof s.localWrite !== 'function') return { error: t('此设备不支持写入手机本地（需在新版 app 内）') };
  try { const r = JSON.parse(s.localWrite(rel, String(b64 || ''), true)) || {}; return r.ok ? { ok: true, name: r.name } : { error: r.error || t('写入失败') }; }
  catch (e) { return { error: String(e?.message ?? e) }; }
}

// —— 长按菜单写操作：删除 / 重命名 / 移动 / 复制。新 apk 才有这些原生接口，逐个
//    feature-detect（旧 apk 前端隐藏对应菜单项）。原生返回 {ok,name}/{ok:false,error}，
//    这里统一解析成 {ok,name}/{error}。注意：这些是同步 JS 桥调用，大文件夹 move/copy
//    会阻塞页面到完成（原生侧有 3000 条目上限兜底）。
function callJson(fn, ...args) {
  const s = S();
  if (!s || typeof s[fn] !== 'function') return { error: t('需更新 App 后使用') };
  try { const r = JSON.parse(s[fn](...args)) || {}; return r.ok ? { ok: true, name: r.name } : { error: r.error || t('操作失败') }; }
  catch (e) { return { error: String(e?.message ?? e) }; }
}
export function hasLocalDelete() { const s = S(); return !!(s && typeof s.localDelete === 'function'); }
export function hasLocalRename() { const s = S(); return !!(s && typeof s.localRename === 'function'); }
export function hasLocalMove() { const s = S(); return !!(s && typeof s.localMove === 'function'); }
export function hasLocalCopy() { const s = S(); return !!(s && typeof s.localCopy === 'function'); }
export function localDelete(rel) { return callJson('localDelete', rel); }
export function localRename(rel, newName) { return callJson('localRename', rel, newName); }
export function localMove(rel, destDirRel) { return callJson('localMove', rel, destDirRel); }
export function localCopy(rel, destDirRel) { return callJson('localCopy', rel, destDirRel); }

// 「打开方式」：用其他安卓应用打开文件（原生 ACTION_VIEW chooser）。仅离线 apk 壳内可用。
//   云端文件传 url（前端拼好的带鉴权 /api/file 绝对地址，原生 HTTP 拉到本地 cache 再打开）；
//   本地文件传 rel（原生 SAF/全盘直接取）。isLocal 区分两条路径。
export function hasShare() { const s = S(); return !!(s && typeof s.shareFile === 'function'); }
export function shareFile(url, rel, name, isLocal) {
  const s = S();
  if (!s || typeof s.shareFile !== 'function') return false;
  try { s.shareFile(url || '', rel || '', name || '', !!isLocal); return true; } catch { return false; }
}
export function hasOpenWith() { const s = S(); return !!(s && typeof s.openWith === 'function'); }
export function openWith(url, rel, name, isLocal) {
  const s = S();
  if (!s || typeof s.openWith !== 'function') return false;
  try { s.openWith(url || '', rel || '', name || '', !!isLocal); return true; } catch { return false; }
}

// 本地文件原生流式 URL（B6）：指向离线壳的 /__localfile?rel=...，由 MainActivity.serveLocalFile
// 以带 Range 的方式响应（视频可拖动、PDF.js/office 客户端 fetch 正常），不把整段读进 JS 内存（大视频会爆）。
// 仅离线 apk 壳内可用（同源 appassets）；dev/在线壳本地 tab 不可用、不会调到。
// v：可选版本串（建议 localVer(size, mtime)）。原生侧忽略它，只用来让 URL 随文件变——
// 原生对原图与各档都给 max-age=86400，而 WebResourceResponse 回不了 304，外部改图后只有换 URL 才能失效。
const vq = (v) => (v ? '&v=' + encodeURIComponent(String(v)) : '');
/** 版本串：列表项里现成的 size / mtime 拼成 "<size>-<mtime>"；两样都没有返回 ''（URL 不带 v）。 */
export function localVer(size, mtime) { return size == null && mtime == null ? '' : `${size ?? ''}-${mtime ?? ''}`; }
export function localFileUrl(rel, v) {
  return '/__localfile?rel=' + encodeURIComponent(rel || '') + vq(v);
}

// 本地媒体缩略图 URL（新 apk）：原生生成 320px JPEG（SAF getDocumentThumbnail 优先，兜底
// 自解码/视频抽帧，磁盘缓存），失败 404 由前端 onerror 兜底。探测 hasLocalThumb 再用。
export function hasLocalThumb() { const s = S(); return !!(s && typeof s.hasLocalThumb === 'function'); }
export function localThumbUrl(rel, v) { return localFileUrl(rel) + '&thumb=1' + vq(v); }

// —— 新 apk（hasLocalPreview）：衍生档、元数据、存相册 / 设壁纸 / 文件管理器、画中画 ——
// 旧 apk 没这些方法 → has* 全 false：查看器保持老逻辑（画廊直接拉原图）、菜单不出对应项。
/** 原生衍生档 + HEIC 转 JPEG + 缓存头 + rel→docId 解析缓存都在（MainActivity.hasLocalPreview）。 */
export function hasLocalPreview() { try { return S()?.hasLocalPreview?.() === true; } catch { return false; } }
/** 衍生档：'1' 320（列表图标 / blur 底）| 'grid' 512 | 'preview' 长边 1600（画廊主图）| 'poster' 1080（视频海报）
 *  | 'max' ≤16.7MP（「原图加载」关着时放大的第一级；只有显式要才出——原图 URL 本身一律回原字节，不静默降档） */
export function localTierUrl(rel, tier, v) { return localFileUrl(rel) + '&thumb=' + encodeURIComponent(tier || '1') + vq(v); }
/** HEIC/HEIF 原图：WebView 解不了，原生（Android 9+ ImageDecoder）按原分辨率转成 JPEG 再给（不封顶）。 */
export function localJpegUrl(rel, v) { return localFileUrl(rel) + '&as=jpeg' + vq(v); }
/** 原图区域块（新 apk，MainActivity.hasLocalRegion）：放大超过 max 档时按可见区拉原图块（BitmapRegionDecoder + 磁盘缓存）。
 *  URL = localFileUrl(rel) + '&region=x,y,w,h&w=目标宽'（显示方向 / EXIF 转正后的原图像素，目标宽 ≤w、≤2048，见 ImageView）。
 *  旧 apk 没这个方法 → false，查看器停在 max 档。 */
export function hasLocalRegion() { try { return S()?.hasLocalRegion?.() === true; } catch { return false; } }

// 异步原生调用：原生干完回 window.__bridgeLocalDone(token, json)（json 是对象）；超时按失败算
const waiting = new Map();
let seq = 0;
function onLocalDone(token, v) { const f = waiting.get(token); if (f) { waiting.delete(token); f(v); } }
function nativeAsync(fn, args, ms) {
  const s = S();
  if (!s || typeof s[fn] !== 'function') return Promise.resolve({ ok: false, error: t('需更新 App 后使用') });
  return new Promise((res) => {
    const token = fn + ':' + (++seq);
    const timer = setTimeout(() => { waiting.delete(token); res({ ok: false, error: t('操作超时') }); }, ms);
    waiting.set(token, (v) => { clearTimeout(timer); res(v && typeof v === 'object' ? v : { ok: false }); });
    window.__bridgeLocalDone = onLocalDone;
    try { s[fn](...args, token); }
    catch (e) { clearTimeout(timer); waiting.delete(token); res({ ok: false, error: String(e?.message ?? e) }); }
  });
}

/** 单文件元数据（同步，走原生解析缓存、一次 query）：{name,size,mtime,mime}；取不到 null。 */
export function hasLocalStat() { const s = S(); return !!(s && typeof s.localStat === 'function'); }
export function localStat(rel) {
  try { const r = JSON.parse(S().localStat(rel)); return r && r.ok ? r : null; } catch { return null; }
}
/** 媒体信息：{w,h,taken,camera,exposure,place,duration}（字段可缺；地点只到城市）。取不到 null。 */
export function hasLocalExif() { const s = S(); return !!(s && typeof s.localExif === 'function'); }
export async function localExif(rel) { const r = await nativeAsync('localExif', [rel], 8000); return r && r.ok ? r : null; }

// 分享 / 打开方式的本地便捷版（同名原生 shareFile / openWith 的 isLocal 路径）
const baseName = (rel) => String(rel || '').split('/').pop();
export function localShare(rel, name) { return shareFile('', rel, name || baseName(rel), true); }
export function localOpenWith(rel, name) { return openWith('', rel, name || baseName(rel), true); }

/** 存到相册（图片 → Pictures/Bridge，视频 → Movies/Bridge）：{ok,album} | {error}。Android 9 及以下会先弹存储权限。 */
export function hasSaveToGallery() { const s = S(); return !!(s && typeof s.localSaveToGallery === 'function'); }
export async function localSaveToGallery(rel) {
  const r = await nativeAsync('localSaveToGallery', [rel], 120000);
  return r.ok ? { ok: true, album: r.album || '' } : { error: r.error || t('操作失败') };
}
/** 设为壁纸：拉起系统壁纸裁剪页（失败原生自己 toast）。 */
export function hasSetWallpaper() { const s = S(); return !!(s && typeof s.localSetWallpaper === 'function'); }
export function localSetWallpaper(rel) { try { S().localSetWallpaper(rel); return true; } catch { return false; } }
/** 在文件管理器中显示：各家 ROM 支持不一，原生 canReveal 探一次（结果不会变，记住）。 */
let revealOk = null;
export function hasReveal() {
  if (revealOk == null) { try { const s = S(); revealOk = !!(s && typeof s.canReveal === 'function' && s.canReveal()); } catch { revealOk = false; } }
  return revealOk;
}
export function localReveal(rel) { try { return !!S().localReveal(rel); } catch { return false; } }

// 画中画 / 常亮：进出 PiP 原生派发 window 事件 bridge-pip {detail:{active, closed?}}（closed=小窗被关掉）。
// 这里顺手给 <html> 挂 .bridge-pip、记 window.__bridgePip，小窗里要藏的界面可直接按它判断。
export function hasPip() { try { return S()?.hasPip?.() === true; } catch { return false; } }
export function enterPip(w, h) { try { return !!S().enterPip(Math.round(w) || 16, Math.round(h) || 9); } catch { return false; } }
/** 播放中开、暂停 / 关查看器时关：开着时按 Home 离开自动进小窗 */
export function setPipAuto(on, w, h) { try { S()?.setPipAuto?.(!!on, Math.round(w) || 0, Math.round(h) || 0); } catch {} }
export function keepScreenOn(on) { try { S()?.keepScreenOn?.(!!on); } catch {} }
if (typeof window !== 'undefined' && !window.__bridgePipHook) {
  window.__bridgePipHook = true;
  window.addEventListener('bridge-pip', (e) => {
    const on = !!e?.detail?.active;
    window.__bridgePip = on;
    try { document.documentElement.classList.toggle('bridge-pip', on); } catch {}
  });
}

// 图片预览：把 base64 拼成 data URL（按扩展名给 mime）。
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic' };
export function localImgDataUrl(rel, name) {
  const b64 = localReadB64(rel);
  if (!b64) return null;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return 'data:' + (IMG_MIME[ext] || 'image/*') + ';base64,' + b64;
}
