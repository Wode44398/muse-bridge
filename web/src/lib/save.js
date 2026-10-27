// 统一「保存到本地」入口（去 web 化）。
// 桌面壳：原生「另存为」对话框——有本机绝对路径就主进程直拷（20GB 也秒起、不绕 loopback
// HTTP），否则主进程 downloadURL（will-download 同样弹系统对话框，默认落「下载」目录）。
// 手机 App：交给内置下载器（app 自己下到手机「下载」文件夹，进度在工作空间「传输」面板），
// 不再跳系统浏览器；blob:/data: 这类原生取不到的地址才退回 <a download>。
// 网页：保持 <a download> 原行为（服务端 Content-Disposition 驱动浏览器下载）。
import { hasNativeSaveAs, nativeSaveAs } from './nativeDesktop.js';
import { hasNativeDownload, startDownload } from './downloads.svelte.js';
import { t } from './i18n.js';

export { hasNativeSaveAs };

// 下载入口按端出词：桌面=「另存为…」，网页/手机=调用方原词（下载/Download）。
export const saveLabel = (webLabel = t('下载')) => (hasNativeSaveAs() ? t('另存为…') : webLabel);

export async function saveToDisk({ url = '', name = '', path = '' } = {}) {
  if (hasNativeSaveAs()) {
    // 主进程 downloadURL 不解析相对地址，这里绝对化（apiUrl 在线同源时返回相对路径）。
    const abs = url ? new URL(url, location.href).href : '';
    return nativeSaveAs({ url: abs, name, path });
  }
  if (!url) return { ok: false };
  if (hasNativeDownload() && startDownload({ url, name })) return { ok: true };
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { ok: true };
}

// <a download> 的点击拦截助手：桌面壳截下来走原生另存为，手机 App 走内置下载器，网页放行原语义。
// 用法：<a href={url} download={name} onclick={(e) => interceptSave(e, { url, name, path })}>
export function interceptSave(e, payload) {
  if (interceptAppDownload(e, payload)) return;
  if (!hasNativeSaveAs()) return;   // 网页：让 <a> 原样走浏览器下载
  e.preventDefault();
  saveToDisk(payload).catch(() => {});
}

// 只管手机 App 的那一半：<a download> 在 apk 里是跨源导航，不拦就被当外链扔给系统浏览器。
// 桌面壳 / 网页原样放行。返回 true = 已接管。
export function interceptAppDownload(e, { url = '', name = '' } = {}) {
  if (!hasNativeDownload() || !url) return false;
  if (!startDownload({ url, name })) return false;
  e.preventDefault();
  return true;
}
