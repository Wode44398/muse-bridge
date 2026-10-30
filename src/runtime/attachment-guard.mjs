// 附件路径守卫：/api/chat 收到的 attachments 只留「这个身份有权引用」的路径。
//
// 沙箱身份（user/pro/snap）：只收本人 uploads、本人工作空间（cwd）或已授权项目
// 目录内的路径——绝不能让软隔离用户把宿主机任意文件挂给 agent。
// admin（桌面壳/主机本人）：放行任意存在的绝对路径——桌面拖拽零拷贝引用的根基
// （从资源管理器拖 20GB 目录进聊天：不复制字节，agent 拿原路径按需读）。
// agent 自身的权限模型仍然管真正的读写，这里只是引用入口的门。
//
// 设备文件夹引用（device://<设备 id>/<路径>，见 device-refs.mjs）：路径在用户电脑上、服务端无从 stat，
// 只核对设备归属（deviceRefOk，由调用方按身份给）；不给 deviceRefOk 的入口（扩展 agent）一律不收。
import path from 'node:path';
import { existsSync } from 'node:fs';
import { parseDeviceRef, formatDeviceRef } from './device-refs.mjs';

const MAX_DEVICE_REFS = 20;

const inDir = (p, dir) => path.resolve(p).startsWith(path.resolve(dir) + path.sep);

export function filterAttachmentPaths(list, { allowAnywhere = false, roots = [], deviceRefOk = null } = {}) {
  let refs = 0;
  return (Array.isArray(list) ? list : []).map((p) => {
    const ref = parseDeviceRef(p);
    if (!ref) return typeof p === 'string' && p.startsWith('device://') ? null : p;   // 形似引用却解析不了：拒
    if (!deviceRefOk || refs >= MAX_DEVICE_REFS || !deviceRefOk(ref.deviceId)) return null;
    refs++;
    return formatDeviceRef(ref.deviceId, ref.path);   // 归一编码
  }).filter((p) => {
    if (typeof p !== 'string' || !p.trim()) return false;
    if (p.startsWith('device://')) return true;
    // 绝对路径才有资格谈引用；相对路径一律拒（防 cwd 歧义）。
    if (!path.isAbsolute(p)) return false;
    if (!allowAnywhere && !roots.some((dir) => dir && inDir(p, dir))) return false;
    return existsSync(p);
  });
}
