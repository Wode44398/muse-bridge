// 「这台电脑」的文件交给 AI（桌面客户端连远端服务端时，工作空间「本地」分页 / 侧栏「这台电脑」位置）。
// 服务端看不到这台电脑的盘，同手机「本地」分页的做法：文件现读现传（本地协议 bridge-workspace:// → uploads）；
// 文件夹没法整个传，交给 Claude 时走设备引用（device://，它经设备工具按需读，见 deviceRefs.js），其余目标不收。
import { api } from './api.js';
import { nativeWorkspaceFileUrl, nativeWorkspaceInspect } from './nativeDesktop.js';
import { canRefDeviceFolder, deviceFolderAttachment } from './deviceRefs.js';
import { t } from './i18n.js';

/**
 * 素材：{ path, name, kind, url } —— 与云端 fileToUpload 那条的返回同形，投递链路不用分辨来源。
 * forClaude：目标是 Claude 对话（文件夹只有它收得下引用）。失败抛错，文案可直接上屏。
 */
export async function pcLocalMaterial({ rel, name, isDir, locationId, forClaude = false }) {
  if (isDir) {
    if (!forClaude || !canRefDeviceFolder()) throw new Error(t('这台电脑上的文件夹只能引用给 Claude'));
    const abs = (await nativeWorkspaceInspect(rel, locationId))?.absolutePath || '';
    if (!abs) throw new Error(t('读取失败'));
    return deviceFolderAttachment(abs, name);
  }
  const url = nativeWorkspaceFileUrl(rel, locationId);
  if (!url) throw new Error(t('读取失败'));
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(t('读取失败'));
  const up = await api.uploadBlob(name, await resp.blob(), { timeout: 600000 });
  const image = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(name);
  return { path: up.path, name: up.name || name, kind: image ? 'image' : 'file', url: image ? url : null };
}

/** 文本素材（注入媒体面板提示词栏用），封顶 30000 字；读不到回 null。 */
export async function pcLocalText(rel, locationId) {
  try {
    const url = nativeWorkspaceFileUrl(rel, locationId);
    if (!url) return null;
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? (await r.text()).slice(0, 30000) : null;
  } catch { return null; }
}
