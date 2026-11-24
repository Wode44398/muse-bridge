// 这一轮附件所在的上传目录，并进 agy 会话的 additionalDirectories。
// 送不进 prompt 的附件（见 prompt-blocks.mjs）要靠模型自己 read_file；上传目录不在工作区里时，
// agy 现在虽然读工作区外的文件也不问（guard/policy.mjs 顶部），但这是它没设围栏的副作用，不能指望一直如此。
// 只认 bridge 替这个人收下的上传（ctx.uploads 之内）：工作区 / 项目里的附件 agy 本来就能读，
// 管理员可以附任意路径的文件，不能因此把那些文件所在的目录也一并挂成工作区。

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isPathInside } from '@bridge/core/runtime/http-file.mjs';
import { authorizeProjectPath } from '../../projects.mjs';
import { foldAgyPath } from '../../paths.mjs';

export function uploadDirsForAttachments(ctx, files = [], coveredDirs = []) {
  if (!ctx?.uploads) return [];
  const out = [];
  for (const file of (Array.isArray(files) ? files : [])) {
    if (typeof file !== 'string' || file.startsWith('device://')) continue;
    let real;
    try {
      real = realpathSync(file);
      if (!statSync(real).isFile()) continue;
    } catch {
      continue;
    }
    if (!isPathInside(real, ctx.uploads)) continue;
    const dir = path.dirname(real);
    if ([...coveredDirs, ...out].some((d) => d && isPathInside(dir, d))) continue;
    // 再过一遍这个身份的工作区边界：成员的上传目录在他自己的文件夹里（cwd/.bridge/uploads），越界的一律不加
    let authed;
    try { authed = authorizeProjectPath(ctx, dir); } catch { continue; }
    if (out.some((d) => foldAgyPath(d) === foldAgyPath(authed))) continue;
    out.push(authed);
  }
  return out;
}
