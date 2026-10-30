// 设备文件夹引用：服务端不在这台电脑上时（VPS 等），桌面客户端里选 / 拖进输入框的文件夹默认「只引用、不上传」——
// 只把「哪台设备 + 电脑上的路径」交给 Claude，它经 mcp__device__files 按需去读（glob / grep / read / pull）。
// 服务端就在这台电脑上时不走这里：本机路径服务端直接认（Composer 的 pushLocalFolder 零拷贝）。
//
// 附件 path 编码成 device://<设备 id>/<encodeURIComponent(路径)>，跟着普通附件走完发送 / 插话 / 排队整条链路；
// 服务端 src/runtime/device-refs.mjs 同构解析，并在附件守卫里核对设备归属。
import { isNativeDesktop, serverOnThisMachine } from './nativeDesktop.js';
import { devices, thisDeviceId } from './devices.svelte.js';

const REF_RE = /^device:\/\/([A-Za-z0-9_.-]{1,64})\/(.+)$/;

export const formatDeviceRef = (deviceId, p) => `device://${deviceId}/${encodeURIComponent(p)}`;
export function parseDeviceRef(s) {
  const m = typeof s === 'string' ? REF_RE.exec(s) : null;
  if (!m) return null;
  try { return { deviceId: m[1], path: decodeURIComponent(m[2]) }; } catch { return null; }
}
export const isDeviceRef = (s) => parseDeviceRef(s) !== null;

/** 现在能不能「引用」这台电脑上的文件夹：桌面客户端 + 连的是别处的服务端 + 这台已登记成设备。 */
export const canRefDeviceFolder = () => isNativeDesktop() && !serverOnThisMachine() && !!thisDeviceId();

/** 这台电脑在设备列表里的名字（没加载到时回空串，卡片上就只写「这台电脑」）。 */
export function thisDeviceName() {
  const id = thisDeviceId();
  return (id && devices.list.find((d) => d.id === id)?.name) || '';
}

/** File → 这台电脑上的绝对路径。不看服务端在哪（nativePathForFile 连远端时回空，这里要的正是远端情形）。 */
export function localPathOf(file) {
  try { return (typeof window !== 'undefined' && window.BridgeDesktop?.workspace?.pathForFile?.(file)) || ''; } catch { return ''; }
}

/** 一个引用附件（compose.attachments 里的一项）。 */
export function deviceFolderAttachment(localPath, name) {
  const id = thisDeviceId();
  return { path: formatDeviceRef(id, localPath), name, kind: 'folder', url: null, count: null, note: '', pending: false, device: { id, name: thisDeviceName() } };
}
