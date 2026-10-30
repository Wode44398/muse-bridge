// 设备文件夹引用：用户电脑上的文件夹「只引用、不上传」。
//
// 服务端不在用户这台电脑上时（VPS 等），桌面客户端选 / 拖进来的文件夹拿得到的是【电脑上】的绝对路径，
// 服务端认不得，以前只能整树上传。引用＝只把「哪台设备 + 电脑上的路径」交给 agent，内容一个字节都不搬，
// agent 经 mcp__device__files（glob / grep / read / pull）按需去读。
//
// 编码成附件列表里的一个字符串 device://<设备 id>/<encodeURIComponent(路径)>，跟着普通附件走完
// 发送 / 插话 / 排队 / 排队放回输入框整条链路；服务端在附件守卫里认出来、核对设备归属（前端 web/src/lib/deviceRefs.js 同构）。
// 写进提示词的是一行「- 路径  ← 用户电脑「名」上的文件夹（device=id）」，重开历史时 sessions.mjs 按这条标注还原成文件夹卡。

const REF_RE = /^device:\/\/([A-Za-z0-9_.-]{1,64})\/(.+)$/;
const MAX_PATH = 1024;

/** 'device://d-xx/<enc>' → { deviceId, path }；不是合法引用回 null。 */
export function parseDeviceRef(s) {
  if (typeof s !== 'string') return null;
  const m = REF_RE.exec(s);
  if (!m) return null;
  let p;
  try { p = decodeURIComponent(m[2]); } catch { return null; }
  if (!p || p.length > MAX_PATH || /[\0\r\n]/.test(p)) return null;
  // 电脑上的绝对路径：Windows 盘符 / UNC，或 POSIX
  if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('\\\\') && !p.startsWith('/')) return null;
  return { deviceId: m[1], path: p };
}

export const formatDeviceRef = (deviceId, p) => `device://${deviceId}/${encodeURIComponent(p)}`;
export const isDeviceRef = (s) => parseDeviceRef(s) !== null;

// 提示词行尾标注（sessions.mjs 的 splitAttachments 靠它认出设备引用）。设备名里的「」与换行先换掉，免得标注被截断。
export function deviceRefNote(deviceName, deviceId) {
  const name = String(deviceName || '').replace(/[「」\r\n]/g, ' ').trim() || deviceId;
  return `用户电脑「${name}」上的文件夹（device=${deviceId}）`;
}
const NOTE_RE = /^用户电脑「(.*)」上的文件夹（device=([A-Za-z0-9_.-]{1,64})）$/;
export function parseDeviceRefNote(note) {
  const m = NOTE_RE.exec(String(note || '').trim());
  return m ? { deviceName: m[1], deviceId: m[2] } : null;
}

/** 路径的最后一段（Windows / POSIX 都认），盘符根回「C:」。 */
export function basenameOf(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  return s.split(/[\\/]/).pop() || s;
}
