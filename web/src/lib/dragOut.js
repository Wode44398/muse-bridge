// 桌面壳「拖出到任意应用」统一入口（#8 的全覆盖版，2026-09-11）。
// 全站凡是代表一个文件/文件夹的东西——聊天产物卡、用户上传的图/文件、输入栏附件、工作空间
// 行/卡/文件夹、预览器标题、审阅面板改动文件、Vertex 生成的媒体——都挂 `use:dragOut`，
// 鼠标一拖就是 Windows 原生文件拖拽（Explorer/微信输入框/Word 都接得住）。
//
// 三种来源，按「零拷贝优先」排序：
//   { paths:[绝对路径] }             服务端/本机绝对路径（bridge 三形态都跑在本机，直接拖原文件）
//   { rels:[rel], locationId }      桌面壳授权的工作空间位置（主进程解析+越界校验）
//   { url, name }                   只有下载链接（Vertex 媒体、历史里只剩链接的图）→ 壳先下到临时目录再拖
// 非桌面壳（网页/安卓）：action 什么都不挂，原有点按/长按行为零变化。
import { hasNativeDragOut, hasNativeDragUrl, nativeDragPaths, nativeDragWorkspace, nativeDragUrl } from './nativeDesktop.js';
import { authHeaders } from './api.js';

export const canDragOut = () => hasNativeDragOut();

// 盘根 'E:\' 直接拼会变成 'E:\\x'；base 已带尾分隔符就不再补（与 FilesPanel 的 joinAbs 同款）。
export const joinAbs = (base, rel) => {
  const b = String(base || '');
  if (!rel) return b;
  return /[\\/]$/.test(b) ? b + rel : b + '/' + rel;
};

const isFetchable = (u) => !!u && !/^(blob|data):/i.test(String(u));

// 附件对象 → 拖拽来源：{ path, url, downloadUrl, name, pending }（Claude/Gemini/Codex 附件同构）。
// 上传中的不拖；绝对路径优先；只有链接就走下载通道（blob:/data: 拖不了）。
export function attDragSrc(a) {
  if (!a || a.pending || a.device) return null;   // 引用电脑上的文件夹：path 是 device:// 编码，不是能拖出去的文件
  if (a.path) return { paths: [a.path] };
  const u = a.downloadUrl || a.url;
  return isFetchable(u) ? { url: u, name: a.name || '' } : null;
}

// 预览器条目（preview.svelte.js 归一化后的 cur）→ 拖拽来源。
export function previewDragSrc(cur) {
  if (!cur) return null;
  if (cur.absPath) return { paths: [cur.absPath] };
  const st = cur.saveTarget;
  if (st?.origin === 'local') return null;   // 手机 SAF 文件，桌面壳不会出现
  if (st?.origin === 'cloud' && st.rel != null) {
    if (st.nativeLocation) return { rels: [st.rel], locationId: st.nativeLocation };
    if (st.ws) return { paths: [joinAbs(st.ws, st.rel)] };
    // 身份文件根（vault）＝桌面壳的 primary 位置（server 形态 vaultPath 同一处），零拷贝拖原文件
    return { rels: [st.rel], locationId: 'primary' };
  }
  const u = cur.downloadHref || cur.url;
  return isFetchable(u) ? { url: u, name: cur.name || '' } : null;
}

// 真正起拖。返回壳侧 promise：resolve＝这场拖拽结束（Windows DoDragDrop 模态）。
export function startDragOut(src) {
  if (!src || !canDragOut()) return Promise.resolve({ ok: false });
  if (src.paths?.length) return nativeDragPaths(src.paths);
  if (src.rels?.length) return nativeDragWorkspace(src.rels, src.locationId || 'primary');
  if (src.url && hasNativeDragUrl()) {
    let abs = src.url;
    try { abs = new URL(src.url, location.href).href; } catch {}
    return nativeDragUrl(abs, src.name || '', authHeaders());
  }
  return Promise.resolve({ ok: false });
}

// 这个来源此刻能不能拖：路径/工作区项恒可；纯 URL 要壳有 drag.url（老壳不接管，让默认拖拽自生自灭）。
export const dragOutReady = (src) => !!src && canDragOut() && (!!src.paths?.length || !!src.rels?.length || (!!src.url && hasNativeDragUrl()));

// 元素内部的操作控件（进度条/滑杆/输入框/按钮）上起拖：既不拖出也不让 HTML5 幽灵拖起来，
// 把事件掐掉让它们照常收到 mousemove（NeoPlayer 的拖动进度条、Composer 的移除钮）。
const CONTROL_SEL = 'input,textarea,select,[contenteditable=""],[contenteditable="true"],[role="slider"],.pl-track,.att-x,.v-c-att-x,.hist-x';

// Svelte action：`use:dragOut={() => src}`（也接受直接传 src）。挂载即 draggable，
// dragstart 拦下 HTML5 拖拽换成原生文件拖拽；getSrc 返回 null＝这次不拖（上传中等），
// 事件放行给原有逻辑。拖拽起止派发 dragoutstart / dragoutend（bubbles），宿主可据此清态。
export function dragOut(node, getSrc) {
  if (!canDragOut()) return {};
  let get = typeof getSrc === 'function' ? getSrc : () => getSrc;
  const safe = () => { try { return get(); } catch { return null; } };
  const onStart = (e) => {
    const ctl = e.target !== node && e.target?.closest?.(CONTROL_SEL);
    if (ctl && node.contains(ctl)) { e.preventDefault(); return; }
    const src = safe();
    if (!dragOutReady(src)) return;
    e.preventDefault();
    e.stopPropagation();
    node.dispatchEvent(new CustomEvent('dragoutstart', { bubbles: true, detail: src }));
    startDragOut(src).catch(() => {}).finally(() => node.dispatchEvent(new CustomEvent('dragoutend', { bubbles: true, detail: src })));
  };
  node.draggable = true;
  node.addEventListener('dragstart', onStart);
  return {
    update(v) { get = typeof v === 'function' ? v : () => v; },
    destroy() { node.removeEventListener('dragstart', onStart); },
  };
}
