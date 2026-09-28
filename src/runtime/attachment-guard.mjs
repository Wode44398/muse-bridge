// 附件路径守卫：/api/chat 收到的 attachments 只留「这个身份有权引用」的路径。
//
// 沙箱身份（user/pro/snap）：只收本人 uploads、本人工作空间（cwd）或已授权项目
// 目录内的路径——绝不能让软隔离用户把宿主机任意文件挂给 agent。
// admin（桌面壳/主机本人）：放行任意存在的绝对路径——桌面拖拽零拷贝引用的根基
// （从资源管理器拖 20GB 目录进聊天：不复制字节，agent 拿原路径按需读）。
// agent 自身的权限模型仍然管真正的读写，这里只是引用入口的门。
import path from 'node:path';
import { existsSync } from 'node:fs';

const inDir = (p, dir) => path.resolve(p).startsWith(path.resolve(dir) + path.sep);

export function filterAttachmentPaths(list, { allowAnywhere = false, roots = [] } = {}) {
  return (Array.isArray(list) ? list : []).filter((p) => {
    if (typeof p !== 'string' || !p.trim()) return false;
    // 绝对路径才有资格谈引用；相对路径一律拒（防 cwd 歧义）。
    if (!path.isAbsolute(p)) return false;
    if (!allowAnywhere && !roots.some((dir) => dir && inDir(p, dir))) return false;
    return existsSync(p);
  });
}
